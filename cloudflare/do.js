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
import { sendPushMessage } from '../server/push/webpush.js';

/** SQL schema — idempotent, safe on a non-empty database (§4). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  device_key TEXT PRIMARY KEY,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
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
    this.sql = adaptWorkerSql(state.storage.sql);
    this.sql.exec(SCHEMA_SQL); // idempotent (IF NOT EXISTS)
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
    this.sql.exec(
      `INSERT INTO push_subscriptions
         (device_key, endpoint, p256dh, auth, timezone, times, categories,
          quiet_start, quiet_end, enabled, disabled, failure_count, last_error,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)
       ON CONFLICT(device_key) DO UPDATE SET
         endpoint = excluded.endpoint,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
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
      v.deviceKey, v.endpoint, v.keys.p256dh, v.keys.auth, v.timezone,
      JSON.stringify(v.times), JSON.stringify(v.categories),
      v.quietStart, v.quietEnd, v.enabled ? 1 : 0, now, now
    );
    return { ok: true, deviceKey: v.deviceKey, serverTime: now };
  }

  async unregister({ deviceKey } = {}) {
    if (typeof deviceKey === 'string' && deviceKey) {
      this.sql.exec('DELETE FROM push_subscriptions WHERE device_key = ?', deviceKey);
    }
    return { ok: true };
  }

  async status() {
    const subs = this.#listSubs();
    const counts = {};
    for (const row of this.sql.exec(
      'SELECT status, COUNT(*) AS n FROM notification_occurrences GROUP BY status'
    ).rows) counts[row.status] = row.n;
    return {
      ok: true,
      devices: subs.length,
      active: subs.filter((s) => s.enabled !== 0 && !s.disabled).length,
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
    const vapid = this.#vapid();
    if (!vapid) return { ok: false, error: 'VAPID not configured' };
    const occurrenceId = `${row.device_key}:test:${Date.now()}`;
    const payload = buildPushPayload({ kind: 'test', category: 'test', occurrenceId, dateKey: '', route: ROUTES.test });
    const result = await this.sendPushMessage(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, vapid
    );
    if (result.ok) {
      this.#markOutcome(row.device_key, true);
      return { ok: true };
    }
    const gone = result.status === 404 || result.status === 410;
    this.#markOutcome(row.device_key, false, result.error || `status ${result.status}`, gone);
    return { ok: false, error: result.error || `push service returned ${result.status}`, transient: !!result.transient };
  }

  // -------------------------------------------------------------------------
  // Scheduler tick — invoked by the Cron Trigger via the stateless Worker.
  // `nowMs` is injectable so tests run the REAL tick logic on a fixed clock.
  // -------------------------------------------------------------------------

  async tick(nowMs = Date.now()) {
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
        const result = await this.sendPushMessage(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, vapid
        );
        if (result.ok) {
          this.#setOccurrence(occ.occurrenceId, { status: 'delivered', sent_at: Date.now() });
          this.#markOutcome(sub.device_key, true);
          deliveries++;
        } else {
          const gone = result.status === 404 || result.status === 410;
          this.#setOccurrence(occ.occurrenceId, { status: gone ? 'gone' : 'failed' });
          this.#markOutcome(sub.device_key, false, result.error || `status ${result.status}`, gone);
          if (gone) {
            // Push service definitively reports the subscription expired (§11).
            this.sql.exec('DELETE FROM push_subscriptions WHERE device_key = ?', sub.device_key);
          }
          skips++;
        }
      }
    }
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
