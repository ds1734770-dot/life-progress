/**
 * V2.0 Phase 2 — Durable Object platform/token migration + integration tests
 * (cloudflare/do.js against a REAL SQLite engine via node:sqlite, §6/§7/§15.10–12).
 *
 * The production DO was created before platform/token existed. The hard
 * requirements proven here:
 *  · the migration adds the columns idempotently (PRAGMA-guarded),
 *  · pre-existing rows survive and read as platform='web', token=NULL,
 *  · such legacy rows keep scheduling + delivering WITHOUT re-registration,
 *  · native (ios/android) rows store tokens and are never sent via Web Push,
 *  · a deviceKey can move between platforms (token replacement model, §8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LPPushDO, adaptWorkerSql, migrateSchema, MIGRATE_SQL } from '../cloudflare/do.js';

// ---------------------------------------------------------------------------
// Harness — same shape as test/push-cloudflare.test.js, with the raw database
// exposed so migrations can be applied to PRE-EXISTING (old-schema) tables.
// ---------------------------------------------------------------------------

function makeState() {
  const db = new DatabaseSync(':memory:');
  const raw = {
    exec(sql, ...params) {
      if (params.length === 0) {
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
          const rows = db.prepare(sql).all();
          return { toArray: () => rows };
        }
        db.exec(sql); // DDL / multi-statement schema
        return { toArray: () => [] };
      }
      if (/^\s*SELECT/i.test(sql)) {
        const rows = db.prepare(sql).all(...params);
        return { toArray: () => rows };
      }
      db.prepare(sql).run(...params);
      return { toArray: () => [] };
    },
  };
  let alarmAt = null;
  const storage = {
    sql: raw,
    getAlarm: () => alarmAt,
    setAlarm: (t) => { alarmAt = t; },
    deleteAlarm: () => { alarmAt = null; },
  };
  storage.alarmAt = () => alarmAt;
  return { storage, db };
}

const VAPID_ENV = {
  VAPID_PUBLIC_KEY: 'BPk2nTestPublicKey_placeholder_for_tests_0000000000',
  VAPID_PRIVATE_KEY: 'TestPrivateKey_placeholder_for_tests_only_000000000000',
  VAPID_SUBJECT: 'mailto:test@example.com',
};

function sender() {
  const calls = [];
  const fn = async (sub, payload, vapid) => {
    calls.push({ sub, payload: JSON.parse(payload), vapid });
    if (fn.next) { const r = fn.next; fn.next = null; return r; }
    return { ok: true, status: 201 };
  };
  fn.calls = calls;
  fn.fails = (status) => { fn.next = { ok: false, status, transient: status >= 500 || status === 429 }; };
  fn.next = null;
  return fn;
}

function makeDO(env = VAPID_ENV, send = sender(), deps = {}) {
  const state = makeState();
  const doInstance = new LPPushDO(state, env, { sendPushMessage: send, ...deps });
  return { doInstance, send, state, db: state.db };
}

/** EXACT pre-Phase-2 schema — what production has before this migration. */
const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduler_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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

/** Insert a row exactly the way the OLD production code did (no platform/token). */
function insertLegacyRow(db, { deviceKey = 'legacydevice001', times = JSON.stringify({ water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' }) } = {}) {
  db.prepare(
    `INSERT INTO push_subscriptions
       (device_key, endpoint, p256dh, auth, timezone, times, categories,
        quiet_start, quiet_end, enabled, disabled, failure_count, last_delivered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, NULL, ?, ?)`
  ).run(
    deviceKey,
    'https://fcm.googleapis.com/fcm/send/legacy-endpoint',
    'BLegacyP256dhKey_LegacyP256dhKey_LegacyP256dhKey_Leg',
    'LegacyAuthSecret_LegacyAuthSecret',
    'Asia/Kolkata',
    times,
    JSON.stringify({ water: true, gym: true, goals: true, journal: true }),
    '22:30', '07:00',
    Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1)
  );
}

function columns(db) {
  return db.prepare('PRAGMA table_info(push_subscriptions)').all().map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Migration mechanics (§6)
// ---------------------------------------------------------------------------

test('fresh DO schema includes platform + token with web defaults', () => {
  const { db } = makeDO();
  const cols = columns(db);
  assert.ok(cols.includes('platform'), 'platform column exists');
  assert.ok(cols.includes('token'), 'token column exists');
  const info = db.prepare('PRAGMA table_info(push_subscriptions)').all()
    .find((c) => c.name === 'platform');
  assert.equal(info.dflt_value, "'web'", 'platform DEFAULT is web');
});

test('migration adds both columns to a pre-existing old-schema table (§15.10)', () => {
  const state = makeState();
  state.db.exec(OLD_SCHEMA);
  insertLegacyRow(state.db);
  const before = columns(state.db);
  assert.ok(!before.includes('platform') && !before.includes('token'));
  const added = migrateSchema(adaptWorkerSql(state.storage.sql));
  assert.deepEqual(added.sort(), ['platform', 'token']);
  assert.ok(columns(state.db).includes('platform'));
  assert.ok(columns(state.db).includes('token'));
});

test('migration is idempotent — second run adds nothing, never throws (§15.11)', () => {
  const state = makeState();
  state.db.exec(OLD_SCHEMA);
  const sql = adaptWorkerSql(state.storage.sql);
  migrateSchema(sql);
  const added2 = migrateSchema(sql);
  assert.deepEqual(added2, [], 'already-migrated database: no columns added');
  const added3 = migrateSchema(sql);
  assert.deepEqual(added3, []);
  // And constructing a DO on the same storage still works (constructor runs it again):
  new LPPushDO(state, VAPID_ENV, { sendPushMessage: sender() });
});

test('migration preserves every value of existing rows (§7)', () => {
  const state = makeState();
  state.db.exec(OLD_SCHEMA);
  insertLegacyRow(state.db);
  migrateSchema(adaptWorkerSql(state.storage.sql));
  const row = state.db.prepare('SELECT * FROM push_subscriptions WHERE device_key = ?').get('legacydevice001');
  assert.equal(row.endpoint, 'https://fcm.googleapis.com/fcm/send/legacy-endpoint');
  assert.equal(row.p256dh, 'BLegacyP256dhKey_LegacyP256dhKey_LegacyP256dhKey_Leg');
  assert.equal(row.auth, 'LegacyAuthSecret_LegacyAuthSecret');
  assert.equal(row.timezone, 'Asia/Kolkata');
  assert.equal(row.enabled, 1);
  assert.equal(row.disabled, 0);
});

test('migrated old rows read as platform=web, token=NULL (§15.12)', () => {
  const state = makeState();
  state.db.exec(OLD_SCHEMA);
  insertLegacyRow(state.db);
  migrateSchema(adaptWorkerSql(state.storage.sql));
  const row = state.db.prepare('SELECT platform, token FROM push_subscriptions WHERE device_key = ?').get('legacydevice001');
  assert.equal(row.platform, 'web');
  assert.equal(row.token, null);
});

test('ALTER TABLE with DEFAULT: old rows get web even when added later, not just at CREATE', () => {
  // Guard against the (wrong) assumption that the DEFAULT only applies to
  // future inserts — SQLite materializes NOT NULL DEFAULT on ADD COLUMN.
  const state = makeState();
  state.db.exec(OLD_SCHEMA);
  insertLegacyRow(state.db);
  insertLegacyRow(state.db, { deviceKey: 'legacydevice002' });
  state.db.exec(MIGRATE_SQL[0]); // platform column only
  const rows = state.db.prepare('SELECT device_key, platform FROM push_subscriptions ORDER BY device_key').all();
  assert.deepEqual(rows.map((r) => r.platform), ['web', 'web']);
});

// ---------------------------------------------------------------------------
// Legacy rows keep working end-to-end, WITHOUT re-registration (§7/§12)
// ---------------------------------------------------------------------------

test('migrated legacy row schedules and delivers through the dispatcher, no re-register', async () => {
  const state = makeState();
  state.db.exec(OLD_SCHEMA);
  insertLegacyRow(state.db);
  const send = sender();
  const doInstance = new LPPushDO(state, VAPID_ENV, { sendPushMessage: send });
  // The constructor ran the migration; the legacy row is live:
  const status = await doInstance.status();
  assert.equal(status.devices, 1, 'legacy registration present without re-registering');
  assert.equal(status.active, 1);
  // Water due at 12:00 IST = 06:30 UTC:
  const r = await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  assert.equal(r.deliveries, 1, 'legacy device delivered exactly as before');
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].payload.occurrenceId, 'legacydevice001:water:2026-01-15');
  assert.equal(send.calls[0].sub.endpoint, 'https://fcm.googleapis.com/fcm/send/legacy-endpoint');
});

test('migrated legacy row test-push works through the dispatcher', async () => {
  const state = makeState();
  state.db.exec(OLD_SCHEMA);
  insertLegacyRow(state.db);
  const send = sender();
  const doInstance = new LPPushDO(state, VAPID_ENV, { sendPushMessage: send });
  const r = await doInstance.testPush({ deviceKey: 'legacydevice001' });
  assert.equal(r.ok, true);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].payload.type, 'test');
});

// ---------------------------------------------------------------------------
// Native rows in the DO — stored correctly, never sent via Web Push (§2)
// ---------------------------------------------------------------------------

const nativeReg = (over = {}) => ({
  deviceKey: 'iosdevice00001',
  platform: 'ios',
  token: 'a'.repeat(64),
  timezone: 'Asia/Kolkata',
  times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  categories: { water: true, gym: true, goals: true, journal: true },
  quietStart: '22:30',
  quietEnd: '07:00',
  enabled: true,
  ...over,
});

test('DO register stores an iOS row with platform + token and empty web fields', async () => {
  const { doInstance, db, send } = makeDO();
  await doInstance.register(nativeReg());
  const row = db.prepare('SELECT * FROM push_subscriptions WHERE device_key = ?').get('iosdevice00001');
  assert.equal(row.platform, 'ios');
  assert.equal(row.token, 'a'.repeat(64));
  assert.equal(row.endpoint, '', 'no Web Push endpoint for native rows');
  const status = await doInstance.status();
  assert.equal(status.devices, 1);
  assert.equal(send.calls.length, 0);
});

test('DO register stores an Android row the same way', async () => {
  const { doInstance, db } = makeDO();
  await doInstance.register(nativeReg({ deviceKey: 'androiddev001', platform: 'android', token: 'fcm:token:example:0123456789' }));
  const row = db.prepare('SELECT * FROM push_subscriptions WHERE device_key = ?').get('androiddev001');
  assert.equal(row.platform, 'android');
  assert.equal(row.token, 'fcm:token:example:0123456789');
});

test('iOS tick claims + records honestly, never touches the Web Push sender (§15.15)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(nativeReg());
  const r = await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  assert.equal(r.deliveries, 0, 'not_configured is not a delivery');
  assert.equal(send.calls.length, 0, 'Web Push sender untouched for a native device');
  const status = await doInstance.status();
  assert.equal(status.occurrences['not-configured'], 1, 'honest occurrence state recorded');
  assert.equal(status.devices, 1, 'device kept — the provider may be configured later');
});

test('iOS testPush reports honestly instead of faking a send (Phase 3: not-configured)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(nativeReg());
  const r = await doInstance.testPush({ deviceKey: 'iosdevice00001' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not configured/i, 'APNs credentials absent in tests → honest not-configured');
  assert.equal(send.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Device identity: one deviceKey, replaceable platform/token (§8)
// ---------------------------------------------------------------------------

test('re-register on the same deviceKey replaces platform (web → ios)', async () => {
  const { doInstance, db } = makeDO();
  await doInstance.register({
    deviceKey: 'switchdevice01',
    platform: 'web',
    endpoint: 'https://push.example.com/ep',
    keys: { p256dh: 'BMockP256dhKey_MockP256dhKey_MockP256dhKey_Mock', auth: 'MockAuthSecret_MockAuthSecret' },
    timezone: 'Asia/Kolkata',
    times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
    categories: {},
    quietStart: '22:30',
    quietEnd: '07:00',
    enabled: true,
  });
  await doInstance.register(nativeReg({ deviceKey: 'switchdevice01' }));
  const row = db.prepare('SELECT platform, token, endpoint FROM push_subscriptions WHERE device_key = ?').get('switchdevice01');
  assert.equal(row.platform, 'ios');
  assert.equal(row.token, 'a'.repeat(64));
  assert.equal(row.endpoint, '', 'web credential fully replaced');
  const status = await doInstance.status();
  assert.equal(status.devices, 1, 'still ONE device identity');
});

test('re-register back to web clears the token (ios → web)', async () => {
  const { doInstance, db } = makeDO();
  await doInstance.register(nativeReg({ deviceKey: 'switchdevice02' }));
  await doInstance.register({
    deviceKey: 'switchdevice02',
    platform: 'web',
    endpoint: 'https://push.example.com/ep2',
    keys: { p256dh: 'BMockP256dhKey_MockP256dhKey_MockP256dhKey_Mock', auth: 'MockAuthSecret_MockAuthSecret' },
    timezone: 'Asia/Kolkata',
    times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
    categories: {},
    quietStart: '22:30',
    quietEnd: '07:00',
    enabled: true,
  });
  const row = db.prepare('SELECT platform, token, endpoint FROM push_subscriptions WHERE device_key = ?').get('switchdevice02');
  assert.equal(row.platform, 'web');
  assert.equal(row.endpoint, 'https://push.example.com/ep2');
  assert.equal(row.token, null, 'token cleared when the device moved back to web');
});

test('token rotation on the same native device updates in place (§8)', async () => {
  const { doInstance, db } = makeDO();
  await doInstance.register(nativeReg());
  await doInstance.register(nativeReg({ token: 'b'.repeat(64) }));
  const rows = db.prepare('SELECT token FROM push_subscriptions WHERE device_key = ?').all('iosdevice00001');
  assert.equal(rows.length, 1, 'no duplicate device identity');
  assert.equal(rows[0].token, 'b'.repeat(64), 'rotated token replaced the old one');
});
