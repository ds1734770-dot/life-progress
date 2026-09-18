/**
 * Life Progress push backend — Cloudflare Workers adapter (V1.6.4).
 *
 * Architecture (§3): the Worker is stateless (API + cron entry). ALL
 * notification state lives in ONE SQLite-backed Durable Object, which is
 * single-threaded — so occurrence claims and scheduling decisions are
 * serialized by construction (§11 concurrency requirement). The scheduler
 * tick runs INSIDE the DO: one DO request per cron minute, no polling loops,
 * comfortably inside Workers Free limits (§25).
 *
 * Why ONE global DO for a personal single-user app (§25): state is tiny
 * (a handful of subscriptions + occurrence claims), and a single instance
 * gives strictly serialized claims — the strongest possible dedup guarantee.
 * Sharding per device would only add request fan-out for zero benefit at
 * this scale. Documented reasoning rather than a silent choice.
 *
 * SCHEDULING TRIGGER (V1.6.4): a self-rescheduling Durable Object alarm on
 * this single instance (~1/min). Cloudflare Cron dispatch was empirically
 * non-functional in this deployment; see the alarm block below. There is
 * exactly ONE alarm for the ONE global instance — never one per device.
 *
 * STORAGE: Durable Object SQLite (via the `new_sqlite_classes` migration).
 * The Node backend's .push-data.json / .vapid-keys.json files are Node-host
 * deployment artifacts and are NEVER used here (§3). Schema init is
 * idempotent and safe on an already-populated database (§4).
 *
 * PRIVACY (§4): stored columns are strictly delivery metadata — endpoint,
 * crypto keys, IANA timezone, reminder times, quiet hours, enabled flags,
 * occurrence claims. No journal text, no activity history, no photos, no
 * notification copy (the service worker derives copy on-device).
 */
import { computeNextOccurrences, decideOccurrence, buildPushPayload, ROUTES } from '../server/push/domain.js';
import { dispatchNotification, OUTCOME } from '../server/push/dispatch.js';
import { sendPushMessage } from '../server/push/webpush.js';

/**
 * Alarm cadence (V1.6.4). Production scheduling is driven by a
 * SELF-RESCHEDULING Durable Object alarm, not the Cron Trigger: Cloudflare
 * Cron dispatch was empirically non-functional in this deployment (schedule
 * registered, valid `scheduled()` handler, yet ZERO scheduled invocations
 * over hours per Cloudflare's own `workersInvocationsScheduled` analytics —
 * 2026-09-16 investigation). The scheduling DOMAIN below (occurrences,
 * eligibility, quiet hours, atomic claims, dedup) is unchanged — only the
 * trigger mechanism differs.
 */
const TICK_MS = 60 * 1000; // target: ~one tick per minute
const ALARM_SAFETY_MS = 5 * 1000; // land a few seconds after the minute boundary

/** SQL schema — idempotent, safe on a non-empty database (§4). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduler_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_key TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  platform   TEXT NOT NULL DEFAULT 'web',
  token      TEXT,
  timezone   TEXT NOT NULL,
  times      TEXT NOT NULL,
  categories TEXT NOT NULL,
  quiet_start TEXT NOT NULL,
  quiet_end   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  disabled    INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  last_delivered_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_enabled ON push_subscriptions(enabled, disabled);

CREATE TABLE IF NOT EXISTS notification_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  device_key    TEXT NOT NULL,
  category      TEXT NOT NULL,
  date_key      TEXT NOT NULL,
  status        TEXT NOT NULL,
  claimed_at    INTEGER NOT NULL,
  scheduled_for INTEGER NOT NULL,
  sent_at       INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_occ_device ON notification_occurrences(device_key, category);
`;

/**
 * V2.0 Phase 2 — additive migration for tables created BEFORE platform/token
 * existed. `CREATE TABLE IF NOT EXISTS` does NOT add columns to a table that
 * already exists (the production DO predates this change), so the columns are
 * added here exactly once, guarded by `PRAGMA table_info`. Existing rows get
 * platform = 'web' (the column DEFAULT) and token = NULL — no re-registration
 * required (§7). Never destructive: no DROP, no table recreation, no resets.
 */
export const MIGRATE_SQL = [
  "ALTER TABLE push_subscriptions ADD COLUMN platform TEXT NOT NULL DEFAULT 'web'",
  'ALTER TABLE push_subscriptions ADD COLUMN token TEXT',
];

/**
 * Idempotent column migration. Detection first (`PRAGMA table_info` — already
 * modeled by both SQLite test harnesses); if PRAGMA is ever unavailable on a
 * runtime, it falls back to probing the ALTERs where a "duplicate column"
 * error means another run already migrated: success, not failure. Returns the
 * list of columns actually added (empty on already-migrated databases).
 */
export function migrateSchema(sql) {
  let columns = null;
  try {
    columns = sql.exec('PRAGMA table_info(push_subscriptions)').rows.map((r) => r.name);
  } catch {
    columns = null; // PRAGMA unsupported → probe mode below
  }
  const added = [];
  for (const stmt of MIGRATE_SQL) {
    const name = /ADD COLUMN (\w+)/.exec(stmt)[1];
    if (columns !== null) {
      if (columns.includes(name)) continue; // already migrated
    }
    try {
      sql.exec(stmt);
      added.push(name);
    } catch (err) {
      if (!/duplicate column/i.test(String(err?.message || err))) throw err;
      // duplicate column = a concurrent/earlier migration won the race: fine.
    }
  }
  return added;
}

/**
 * Uniform SQL interface used by LPPushDO:
 *   exec(sql, ...params) → { rows: object[], one(): object|undefined }
 *
 * adaptWorkerSql wraps workerd's DurableObjectStorage.sql (SqlStorageCursor);
 * the TEST suite provides the equivalent wrapper over node:sqlite so the
 * whole DO is exercised against a real SQLite engine locally.
 */
export function adaptWorkerSql(raw) {
  return {
    exec(sql, ...params) {
      const rows = params.length === 0 && !/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)
        ? raw.exec(sql).toArray()
        : params.length === 0
          ? (raw.exec(sql), [])
          : raw.exec(sql, ...params).toArray();
      return { rows, one: () => rows[0] };
    },
  };
}

export class LPPushDO {
  /**
   * `deps` is test-only dependency injection (§27: mocked push sender,
   * deterministic tests). The Workers runtime calls with (state, env) and
   * gets the real sender.
   */
  constructor(state, env, deps = {}) {
    this.state = state;
    this.env = env;
    this.sendPushMessage = deps.sendPushMessage || sendPushMessage;
    // V2.0 Phase 3 — APNs test/override seam, mirroring the sendPushMessage
    // injection: `apns` replaces the provider wholesale, `apnsTransport`
    // replaces only its HTTP layer ( Workers default = global fetch, which
    // negotiates HTTP/2). Undefined in production → dispatcher defaults.
    this.apns = deps.apns;
    this.apnsTransport = deps.apnsTransport;
    // V2.0 Phase 5 — FCM test/override seams, same convention. Undefined in
    // production → dispatcher defaults (env-configured real provider).
    this.fcm = deps.fcm;
    this.fcmTransport = deps.fcmTransport;
    // Test-only injected clock (§27): production uses the real instant at
    // every wake; tests pin `now` so nothing depends on wall-clock time.
    this.now = deps.now || (() => Date.now());
    this.sql = adaptWorkerSql(state.storage.sql);
    this.sql.exec(SCHEMA_SQL); // idempotent (IF NOT EXISTS) — complete for FRESH databases
    // V2.0 Phase 2 — bring PRE-EXISTING tables up to the platform-aware
    // schema. Idempotent: no-ops when the columns already exist (§6).
    migrateSchema(this.sql);
    // Startup recovery (§6): after a deploy, eviction or crash the DO may
    // be re-constructed with devices registered but NO alarm booked. Arm it
    // here so existing subscriptions are scheduled again without waiting
    // for a fresh register() call. Idempotent: #ensureAlarm keeps any
    // earlier-or-equal existing alarm.
    try { this.#ensureAlarm(); } catch { /* never block construction */ }
  }

  // -------------------------------------------------------------------------
  // Public entry points (called by the stateless Worker via stub.fetch)
  // -------------------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/register') {
        return Response.json(await this.register(await request.json()));
      }
      if (request.method === 'POST' && url.pathname === '/unregister') {
        return Response.json(await this.unregister(await request.json()));
      }
      if (request.method === 'POST' && url.pathname === '/test') {
        return Response.json(await this.testPush(await request.json()));
      }
      if (request.method === 'GET' && url.pathname === '/status') {
        return Response.json(await this.status());
      }
      if (request.method === 'POST' && url.pathname === '/tick') {
        return Response.json(await this.tick());
      }
      return Response.json({ ok: false, error: 'not found' }, { status: 404 });
    } catch (err) {
      // Never leak stack traces or storage internals to clients (§23/§24).
      console.error('[lp-push-do] error:', err?.message || err);
      return Response.json({ ok: false, error: 'internal error' }, { status: 500 });
    }
  }

  // -------------------------------------------------------------------------
  // Registration — upsert by device_key, never uncontrolled duplicates (§5)
  // -------------------------------------------------------------------------

  async register(v) {
    const now = Date.now();
    // V2.0 Phase 2 — platform-aware upsert (§4/§8). Same deviceKey upsert
    // semantics as before; platform/token ride along. Web-only fields are
    // '' for native rows (the columns are NOT NULL in the existing table and
    // must not be rebuilt); dispatch never reads them for ios/android.
    // A re-register fully replaces platform/token, so a device can move
    // between transports (e.g. token rotation) without a second identity.
    const platform = v.platform || 'web';
    const endpoint = v.endpoint ?? '';
    const p256dh = v.keys?.p256dh ?? '';
    const auth = v.keys?.auth ?? '';
    const token = v.token ?? null;
    this.sql.exec(
      `INSERT INTO push_subscriptions
         (device_key, endpoint, p256dh, auth, platform, token, timezone, times, categories,
          quiet_start, quiet_end, enabled, disabled, failure_count, last_error,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)
       ON CONFLICT(device_key) DO UPDATE SET
         endpoint = excluded.endpoint,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         platform = excluded.platform,
         token = excluded.token,
         timezone = excluded.timezone,
         times = excluded.times,
         categories = excluded.categories,
         quiet_start = excluded.quiet_start,
         quiet_end = excluded.quiet_end,
         enabled = excluded.enabled,
         disabled = 0,
         failure_count = 0,
         last_error = NULL,
         updated_at = excluded.updated_at`,
      v.deviceKey, endpoint, p256dh, auth, platform, token, v.timezone,
      JSON.stringify(v.times), JSON.stringify(v.categories),
      v.quietStart, v.quietEnd, v.enabled ? 1 : 0, now, now
    );
    // Bootstrap (§6): a registration is proof that scheduling matters.
    // If no alarm exists (fresh deploy, previously idle DO), arm one.
    this.#ensureAlarm(now);
    return { ok: true, deviceKey: v.deviceKey, serverTime: now };
  }

  async unregister({ deviceKey } = {}) {
    if (typeof deviceKey === 'string' && deviceKey) {
      this.sql.exec('DELETE FROM push_subscriptions WHERE device_key = ?', deviceKey);
    }
    // Idle shutdown: with zero devices there is nothing to schedule — stop
    // burning alarm cycles. A later register() re-arms (see register).
    this.#idleAlarmIfEmpty();
    return { ok: true };
  }

  async status() {
    const subs = this.#listSubs();
    const counts = {};
    for (const row of this.sql.exec(
      'SELECT status, COUNT(*) AS n FROM notification_occurrences GROUP BY status'
    ).rows) counts[row.status] = row.n;
    const storage = this.state && this.state.storage;
    const nextAlarmAt = storage && typeof storage.getAlarm === 'function'
      ? storage.getAlarm()
      : null;
    const stateRow = (k) => this.sql.exec('SELECT value FROM scheduler_state WHERE key = ?', k).one();
    return {
      ok: true,
      devices: subs.length,
      active: subs.filter((s) => s.enabled !== 0 && !s.disabled).length,
      // Alarm-scheduler observability (§11): timestamps only — no secrets,
      // no endpoints, no device identifiers beyond the existing deviceKey.
      scheduler: {
        trigger: 'durable-object-alarm',
        nextAlarmAt,
        lastTickAt: (stateRow('lastTickAt') || {}).value || null,
        lastTickResult: (() => { try { return JSON.parse((stateRow('lastTickResult') || {}).value || 'null'); } catch { return null; } })(),
      },
      occurrences: counts,
      nextDeliveries: subs.slice(0, 20).map((s) => ({
        deviceKey: s.device_key,
        disabled: !!s.disabled,
        lastDeliveredAt: s.last_delivered_at || null,
        ledger: this.#ledgerFor(s.device_key),
      })),
    };
  }

  async testPush({ deviceKey } = {}) {
    const row = typeof deviceKey === 'string' && deviceKey
      ? this.sql.exec('SELECT * FROM push_subscriptions WHERE device_key = ?', deviceKey).one()
      : null;
    if (!row || row.disabled) {
      return { ok: false, error: 'subscription not found — enable notifications first' };
    }
    // V2.0 Phase 2 — delivery goes through the platform dispatcher (§2/§10).
    // The row is handed over verbatim; the dispatcher normalizes platform
    // (legacy rows without one are web) and picks the provider.
    const occurrenceId = `${row.device_key}:test:${Date.now()}`;
    const payload = buildPushPayload({ kind: 'test', category: 'test', occurrenceId, dateKey: '', route: ROUTES.test });
    const result = await dispatchNotification(
      { platform: row.platform, endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth }, token: row.token },
      payload,
      { vapid: this.#vapid(), sendPushMessage: this.sendPushMessage, env: this.env, now: this.now, apns: this.apns, apnsTransport: this.apnsTransport, fcm: this.fcm, fcmTransport: this.fcmTransport }
    );
    if (result.outcome === OUTCOME.DELIVERED) {
      this.#markOutcome(row.device_key, true);
      return { ok: true };
    }
    if (result.outcome === OUTCOME.NOT_CONFIGURED) {
      return { ok: false, error: result.reason || 'provider not configured' };
    }
    const gone = result.outcome === OUTCOME.GONE;
    this.#markOutcome(row.device_key, false, result.error || result.reason || 'delivery failed', gone);
    return { ok: false, error: result.error || result.reason || 'delivery failed', transient: result.outcome === OUTCOME.TRANSIENT };
  }

  // -------------------------------------------------------------------------
  // Alarm — the production scheduler trigger (V1.6.4). At-least-once by
  // platform contract: idempotency comes from the occurrence-id PRIMARY KEY
  // claim inside tick(), so retries can never double-send (§14).
  // -------------------------------------------------------------------------

  /** Storage facade for alarms; null-safe so pure-SQLite test harnesses
   * that model only `storage.sql` simply never arm an alarm. */
  #alarmStore() {
    const s = this.state && this.state.storage;
    return s && typeof s.setAlarm === 'function' ? s : null;
  }

  #nextTickFrom(nowMs) {
    // Absolute UTC timestamp (§3) — never the isolate's local timezone.
    // Base: just after the NEXT minute boundary. If that instant is already
    // in the past (delayed wake, clock drift), push one further minute out —
    // never book a wake that would fire immediately in a tight loop.
    const floor = Math.floor(nowMs / TICK_MS) * TICK_MS;
    let candidate = floor + TICK_MS + ALARM_SAFETY_MS;
    if (candidate <= nowMs) candidate += TICK_MS;
    return candidate;
  }

  /** Arm the next alarm unless an earlier one is already booked. */
  #armAlarm(atMs, { force = false } = {}) {
    const store = this.#alarmStore();
    if (!store) return null;
    if (!force) {
      const current = typeof store.getAlarm === 'function' ? store.getAlarm() : null;
      if (current !== null && current <= atMs) return current; // earlier wake wins
    }
    store.setAlarm(atMs);
    return atMs;
  }

  /** Bootstrap: guarantee an alarm while any device is registered (§6). */
  #ensureAlarm(nowMs = this.now()) {
    return this.#armAlarm(this.#nextTickFrom(nowMs));
  }

  /** With no devices left, cancel the alarm (nothing to schedule). */
  #idleAlarmIfEmpty(nowMs = this.now()) {
    const row = this.sql.exec('SELECT COUNT(*) AS n FROM push_subscriptions').one();
    if (row && row.n) return false;
    const store = this.#alarmStore();
    if (store && typeof store.deleteAlarm === 'function') store.deleteAlarm();
    return true;
  }

  async alarm() {
    // The ACTUAL instant of this wake (§3) — alarms can run late, so every
    // downstream wall-clock calculation derives from `now`, never from the
    // intended alarm time.
    const now = this.now();
    const idle = this.#idleAlarmIfEmpty(now);
    // Re-arm BEFORE ticking (§5): even if tick() throws, the next cycle is
    // already booked — a transient failure can never permanently stop
    // scheduling. Duplicate/early wakes remain harmless because the
    // occurrence-id claim is the single delivery authority (§14).
    const next = idle ? null : this.#nextTickFrom(now);
    if (next !== null) this.#armAlarm(next, { force: true });
    const result = await this.tick(now);
    // Safe diagnostics (§11): UTC instants and counters only.
    console.log(`[lp-push-do] alarm: utc=${new Date(now).toISOString()} devices=${result.devices ?? '-'} deliveries=${result.deliveries ?? '-'} skips=${result.skips ?? '-'} next=${next ? new Date(next).toISOString() : 'idle'}`);
    return result;
  }

  // -------------------------------------------------------------------------
  // Scheduler tick — shared by the alarm AND (historically) the Cron Trigger
  // via the stateless Worker. `nowMs` is injectable so tests run the REAL
  // tick logic on a fixed clock. The delivery policy below is UNCHANGED.
  // -------------------------------------------------------------------------

  async tick(nowMs = this.now()) {
    const vapid = this.#vapid();
    if (!vapid) return { ok: false, error: 'VAPID not configured' };
    const subs = this.#listSubs().filter((s) => s.enabled !== 0 && !s.disabled);
    let deliveries = 0;
    let skips = 0;
    for (const sub of subs) {
      const record = this.#toSubRecord(sub);
      for (const occ of computeNextOccurrences(record, nowMs)) {
        const decision = decideOccurrence(record, occ, nowMs);
        if (decision.action === 'reschedule') continue;
        // Atomic claim: the occurrence_id PRIMARY KEY is the serialization
        // point. Two executions can never both claim the same occurrence,
        // regardless of timing (§11/§14).
        if (!this.#claim(occ, sub.device_key)) { skips++; continue; }
        if (decision.action === 'skip') {
          this.#setOccurrence(occ.occurrenceId, { status: decision.reason });
          skips++;
          continue;
        }
        const payload = buildPushPayload({
          category: occ.category, occurrenceId: occ.occurrenceId, dateKey: occ.dateKey, route: ROUTES[occ.category],
        });
        // V2.0 Phase 2 — dispatch through the platform seam (§10): same
        // payload, same claim, same outcome bookkeeping; only the transport
        // invocation was replaced. Native rows resolve to their (still
        // unconfigured) providers — never to Web Push (§2).
        const result = await dispatchNotification(
          { platform: sub.platform, endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth }, token: sub.token },
          payload,
          { vapid, sendPushMessage: this.sendPushMessage, env: this.env, now: this.now, apns: this.apns, apnsTransport: this.apnsTransport, fcm: this.fcm, fcmTransport: this.fcmTransport }
        );
        if (result.outcome === OUTCOME.DELIVERED) {
          this.#setOccurrence(occ.occurrenceId, { status: 'delivered', sent_at: Date.now() });
          this.#markOutcome(sub.device_key, true);
          deliveries++;
        } else if (result.outcome === OUTCOME.NOT_CONFIGURED) {
          // Honest, recorded state: nothing to send with (e.g. VAPID missing
          // for web, or a native provider before its phase). The occurrence
          // stays claimed — no retry loop, no silent success.
          this.#setOccurrence(occ.occurrenceId, { status: 'not-configured' });
          this.#markOutcome(sub.device_key, false, result.reason || 'provider not configured', false);
          skips++;
        } else {
          const gone = result.outcome === OUTCOME.GONE;
          this.#setOccurrence(occ.occurrenceId, { status: gone ? 'gone' : 'failed' });
          this.#markOutcome(sub.device_key, false, result.error || result.reason || `delivery failed`, gone);
          if (gone) {
            // Provider definitively reports the subscription/token expired (§11).
            this.sql.exec('DELETE FROM push_subscriptions WHERE device_key = ?', sub.device_key);
          }
          skips++;
        }
      }
    }
    // Heartbeat (§11): lets /status distinguish "cron/alarm never fired"
    // from "fired but found nothing due" — the exact blind spot of the
    // 2026-09-16 cron investigation.
    this.sql.exec(
      `INSERT INTO scheduler_state (key, value) VALUES ('lastTickAt', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      String(nowMs)
    );
    this.sql.exec(
      `INSERT INTO scheduler_state (key, value) VALUES ('lastTickResult', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify({ devices: subs.length, deliveries, skips })
    );
    return { ok: true, devices: subs.length, deliveries, skips };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #vapid() {
    const publicKey = this.env.VAPID_PUBLIC_KEY;
    const privateKey = this.env.VAPID_PRIVATE_KEY;
    if (!publicKey || !privateKey) return null;
    return { publicKey, privateKey, subject: this.env.VAPID_SUBJECT || 'mailto:life-progress@example.com' };
  }

  #listSubs() {
    return this.sql.exec('SELECT * FROM push_subscriptions').rows;
  }

  /** Mirror the Node record shape consumed by the shared domain logic. */
  #toSubRecord(sub) {
    return {
      deviceKey: sub.device_key,
      enabled: sub.enabled !== 0,
      disabled: !!sub.disabled,
      timezone: sub.timezone,
      categories: JSON.parse(sub.categories || '{}'),
      times: JSON.parse(sub.times || '{}'),
      quietStart: sub.quiet_start,
      quietEnd: sub.quiet_end,
      // Restart safety (§10/§19): the per-category ledger position derives
      // from claimed occurrences, so a fresh DO instance never re-delivers.
      ledger: this.#ledgerFor(sub.device_key),
    };
  }

  #ledgerFor(deviceKey) {
    const ledger = {};
    for (const row of this.sql.exec(
      `SELECT category, MAX(scheduled_for) AS last
         FROM notification_occurrences WHERE device_key = ? GROUP BY category`,
      deviceKey
    ).rows) ledger[row.category] = row.last;
    return ledger;
  }

  #claim(occ, deviceKey) {
    try {
      this.sql.exec(
        `INSERT INTO notification_occurrences
           (occurrence_id, device_key, category, date_key, status, claimed_at, scheduled_for, created_at)
         VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?)`,
        occ.occurrenceId, deviceKey, occ.category, occ.dateKey, Date.now(), occ.epochMs, Date.now()
      );
      return true;
    } catch {
      return false; // PK conflict — already claimed by an earlier run
    }
  }

  #setOccurrence(occurrenceId, patch) {
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); vals.push(v); }
    if (!sets.length) return;
    this.sql.exec(`UPDATE notification_occurrences SET ${sets.join(', ')} WHERE occurrence_id = ?`, ...vals, occurrenceId);
  }

  #markOutcome(deviceKey, ok, error = null, permanent = false) {
    if (ok) {
      this.sql.exec(
        'UPDATE push_subscriptions SET last_delivered_at = ?, failure_count = 0, last_error = NULL WHERE device_key = ?',
        Date.now(), deviceKey
      );
    } else {
      this.sql.exec(
        `UPDATE push_subscriptions
         SET failure_count = failure_count + 1, last_error = ?,
             disabled = CASE WHEN ? THEN 1 ELSE disabled END
         WHERE device_key = ?`,
        String(error || 'unknown'), permanent ? 1 : 0, deviceKey
      );
    }
  }
}
