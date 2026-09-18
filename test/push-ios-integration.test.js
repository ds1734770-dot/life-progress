/**
 * V2.0 Phase 3 — iOS integration tests: Durable Object ↔ dispatcher ↔ APNs
 * (spec §14.E/F/G/H).
 *
 * Proven end-to-end against a REAL SQLite engine (same harness conventions as
 * test/push-do-migration.test.js):
 *  · an iOS row dispatches through APNs ONLY — the Web Push sender is never
 *    invoked, and Web Push fields are never read for it (§14.F)
 *  · delivered / gone / transient / not_configured outcomes map to the exact
 *    existing occurrence + device bookkeeping (no scheduler changes)
 *  · token rotation on one deviceKey updates the token APNs receives (§14.G)
 *  · deep-link routes stay inside the app's route vocabulary (§14.H)
 *  · a configured APNs transport in the DO works with NO VAPID for iOS rows
 *    (tick's web-only VAPID guard is pre-existing behavior, not regressed —
 *    covered by the unconfigured-path tests in push-do-migration.test.js)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { LPPushDO } from '../cloudflare/do.js';
import { dispatchNotification } from '../server/push/dispatch.js';
import { OUTCOME } from '../server/push/outcomes.js';
import { routeFromNotification } from '../js/nativePush.js';
import { toApnsPayload } from '../server/push/apns.js';
import { buildPushPayload, ROUTES } from '../server/push/domain.js';

// ---------------------------------------------------------------------------
// Harness — identical shape to test/push-do-migration.test.js
// ---------------------------------------------------------------------------

function makeState() {
  const db = new DatabaseSync(':memory:');
  const raw = {
    exec(sql, ...params) {
      if (params.length === 0) {
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
          const rows = db.prepare(sql).all();
          return { toArray: () => rows, rows };
        }
        db.exec(sql);
        return { toArray: () => [] };
      }
      if (/^\s*SELECT/i.test(sql)) {
        const rows = db.prepare(sql).all(...params);
        return { toArray: () => rows, rows };
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
    return { ok: true, status: 201 };
  };
  fn.calls = calls;
  return fn;
}

/** Mock APNs provider — records sends, replays scripted outcomes. */
function apnsMock() {
  const calls = [];
  const provider = {
    platform: 'ios',
    transport: 'apns',
    configured: true,
    isConfigured: () => true,
    async send(device, payloadString) {
      calls.push({ device, payload: JSON.parse(payloadString) });
      if (provider.next) { const r = provider.next; provider.next = null; return r; }
      return { outcome: OUTCOME.DELIVERED, provider: 'apns', status: 200 };
    },
  };
  provider.calls = calls;
  provider.next = null;
  provider.sendNext = (outcome, extra = {}) => { provider.next = { outcome, ...extra }; };
  return provider;
}

function makeDO({ env = VAPID_ENV, send = sender(), apns = null, deps = {} } = {}) {
  const state = makeState();
  const doInstance = new LPPushDO(state, env, { sendPushMessage: send, apns, ...deps });
  return { doInstance, send, state, db: state.db };
}

/** Register an iOS device exactly the way js/nativePush.js does (§8). */
function iosReg(over = {}) {
  return {
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
  };
}

const WATER_DUE_IST = Date.UTC(2026, 0, 15, 6, 30, 30); // 12:00:30 IST

// ---------------------------------------------------------------------------
// E. Dispatcher — explicit platform→provider selection (§14.E)
// ---------------------------------------------------------------------------

test('dispatcher: iOS device reaches the APNs provider, never Web Push', async () => {
  const send = sender();
  const apns = apnsMock();
  const device = { platform: 'ios', token: 'tok123', endpoint: '', keys: {} };
  const result = await dispatchNotification(device, '{}', { sendPushMessage: send, apns });
  assert.equal(result.outcome, OUTCOME.DELIVERED);
  assert.equal(result.provider, 'apns');
  assert.equal(send.calls.length, 0, 'Web Push sender untouched for iOS');
  assert.equal(apns.calls.length, 1);
  assert.equal(apns.calls[0].device.token, 'tok123');
});

test('dispatcher: android still returns not_configured (FCM is Phase 4, §18)', async () => {
  const send = sender();
  const apns = apnsMock();
  const device = { platform: 'android', token: 'fcm-token', endpoint: '', keys: {} };
  const result = await dispatchNotification(device, '{}', { sendPushMessage: send, apns });
  assert.equal(result.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(send.calls.length, 0);
  assert.equal(apns.calls.length, 0, 'APNs never used for Android');
});

test('dispatcher: unknown platform → permanent failure, no provider touched', async () => {
  const send = sender();
  const apns = apnsMock();
  const result = await dispatchNotification({ platform: 'windows' }, '{}', { sendPushMessage: send, apns });
  assert.equal(result.outcome, OUTCOME.PERMANENT);
  assert.equal(send.calls.length, 0);
  assert.equal(apns.calls.length, 0);
});

// ---------------------------------------------------------------------------
// F. DO integration — iOS row through tick()/testPush() (§14.F)
// ---------------------------------------------------------------------------

test('DO tick delivers an iOS occurrence through the injected APNs provider', async () => {
  const apns = apnsMock();
  const { doInstance } = makeDO({ apns });
  await doInstance.register(iosReg());
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1);
  assert.equal(apns.calls.length, 1);
  assert.equal(apns.calls[0].device.token, 'a'.repeat(64), 'the stored token reaches APNs');
  assert.equal(apns.calls[0].device.platform, 'ios');
  const sent = apns.calls[0].payload;
  assert.equal(sent.occurrenceId, 'iosdevice00001:water:2026-01-15');
  assert.equal(sent.category, 'water');
});

test('DO: iOS record does not read Web Push fields (empty endpoint/keys row)', async () => {
  const apns = apnsMock();
  const { doInstance, db } = makeDO({ apns });
  await doInstance.register(iosReg());
  const row = db.prepare('SELECT platform, token, endpoint, p256dh, auth FROM push_subscriptions WHERE device_key = ?').get('iosdevice00001');
  assert.equal(row.platform, 'ios');
  assert.equal(row.endpoint, '');
  assert.equal(row.p256dh, '');
  assert.equal(row.auth, '');
  // Full tick must succeed purely on the token:
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1);
});

test('DO: delivered iOS occurrence is recorded exactly per existing semantics', async () => {
  const apns = apnsMock();
  const { doInstance, db } = makeDO({ apns });
  await doInstance.register(iosReg());
  await doInstance.tick(WATER_DUE_IST);
  const occ = db.prepare("SELECT status, sent_at FROM notification_occurrences WHERE occurrence_id = ?").get('iosdevice00001:water:2026-01-15');
  assert.equal(occ.status, 'delivered');
  assert.ok(occ.sent_at, 'sent_at recorded');
  const sub = db.prepare('SELECT last_delivered_at, failure_count, last_error FROM push_subscriptions WHERE device_key = ?').get('iosdevice00001');
  assert.ok(sub.last_delivered_at, 'last_delivered_at recorded');
  assert.equal(sub.failure_count, 0);
  assert.equal(sub.last_error, null);
});

test('DO: gone outcome removes the iOS device record without crashing (§6)', async () => {
  const apns = apnsMock();
  const { doInstance, db } = makeDO({ apns });
  await doInstance.register(iosReg());
  apns.sendNext(OUTCOME.GONE, { status: 410, reason: 'Unregistered' });
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 0, 'unregistered token removed per existing gone semantics');
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('iosdevice00001:water:2026-01-15');
  assert.equal(occ.status, 'gone');
});

test('DO: transient APNs failure keeps the device and marks failure honestly (§6)', async () => {
  const apns = apnsMock();
  const { doInstance, db } = makeDO({ apns });
  await doInstance.register(iosReg());
  apns.sendNext(OUTCOME.TRANSIENT, { status: 503, error: 'apns returned 503' });
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'device kept — token is still valid');
  const sub = db.prepare('SELECT failure_count, last_error FROM push_subscriptions WHERE device_key = ?').get('iosdevice00001');
  assert.ok(sub.failure_count >= 1, 'failure recorded');
  assert.match(sub.last_error, /503/);
});

test('DO: not_configured keeps the device with an honest occurrence state (§6)', async () => {
  // Real dispatcher, no APNs credentials in env → honest not_configured.
  const { doInstance, db, send } = makeDO({}); // no apns override
  await doInstance.register(iosReg());
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  assert.equal(send.calls.length, 0, 'never falls back to Web Push');
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'device kept');
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('iosdevice00001:water:2026-01-15');
  assert.equal(occ.status, 'not-configured');
});

test('DO: iOS testPush goes through APNs, never Web Push (§14.F/§24)', async () => {
  const apns = apnsMock();
  const { doInstance, send } = makeDO({ apns });
  await doInstance.register(iosReg());
  const r = await doInstance.testPush({ deviceKey: 'iosdevice00001' });
  assert.equal(r.ok, true);
  assert.equal(apns.calls.length, 1);
  assert.equal(send.calls.length, 0);
  assert.equal(apns.calls[0].payload.type, 'test');
});

test('DO tick with UNCONFIGURED APNs (no override, no env): honest skip, no crash', async () => {
  const apns = apnsMock();
  const { doInstance, send } = makeDO({ apns });
  await doInstance.register(iosReg());
  apns.sendNext(OUTCOME.NOT_CONFIGURED, { reason: 'APNs is not configured' });
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  assert.equal(send.calls.length, 0);
});

// ---------------------------------------------------------------------------
// G. Token rotation — same deviceKey, new token reaches APNs (§14.G)
// ---------------------------------------------------------------------------

test('token rotation: re-register updates the token APNs receives (§8/§14.G)', async () => {
  const apns = apnsMock();
  const { doInstance } = makeDO({ apns });
  await doInstance.register(iosReg());
  await doInstance.register(iosReg({ token: 'b'.repeat(64) })); // rotated
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1);
  assert.equal(apns.calls.length, 1);
  assert.equal(apns.calls[0].device.token, 'b'.repeat(64), 'CURRENT token used, not the old one');
});

test('token rotation: only ONE device identity exists after rotation', async () => {
  const apns = apnsMock();
  const { doInstance, db } = makeDO({ apns });
  await doInstance.register(iosReg());
  await doInstance.register(iosReg({ token: 'c'.repeat(64) }));
  await doInstance.register(iosReg({ token: 'd'.repeat(64) }));
  const rows = db.prepare('SELECT device_key, token FROM push_subscriptions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token, 'd'.repeat(64));
});

// ---------------------------------------------------------------------------
// H. Deep links — same route vocabulary as the service worker (§14.H)
// ---------------------------------------------------------------------------

test('deep link: notification data routes map inside the app allowlist', () => {
  const cases = [
    [{ data: { route: '#/water' } }, '#/water'],
    [{ data: { route: '#/gym' } }, '#/gym'],
    [{ data: { route: '#/goals' } }, '#/goals'],
    [{ data: { route: '#/journal' } }, '#/journal'],
    [{ data: { route: '#/achievements' } }, '#/achievements'],
    [{ data: { route: 'javascript:alert(1)' } }, '#/dashboard'],
    [{ data: { route: 'https://evil.example.com' } }, '#/dashboard'],
    [{ data: {} }, '#/dashboard'],
    [null, '#/dashboard'],
  ];
  for (const [notification, expected] of cases) {
    assert.equal(routeFromNotification(notification), expected);
  }
});

test('deep link: APNs payload route matches the shared domain ROUTES table', () => {
  for (const category of ['water', 'gym', 'goals', 'journal']) {
    const payload = JSON.parse(toApnsPayload(buildPushPayload({ kind: 'reminder', category, occurrenceId: 'x', dateKey: '2026-09-18', route: ROUTES[category] })));
    assert.equal(payload.route, ROUTES[category]);
    assert.match(payload.route, /^#\/[a-z]+$/, 'hash route vocabulary preserved');
  }
});

test('deep link: DO-sent iOS payload carries the route the client allowlists', async () => {
  const apns = apnsMock();
  const { doInstance } = makeDO({ apns });
  await doInstance.register(iosReg());
  await doInstance.tick(WATER_DUE_IST);
  const sent = apns.calls[0].payload;
  assert.equal(sent.route, '#/water');
  assert.equal(routeFromNotification({ data: { route: sent.route } }), sent.route);
});

// ---------------------------------------------------------------------------
// Provider/transport isolation — the DO works with an HTTP-level mock too
// ---------------------------------------------------------------------------

test('DO with apnsTransport injection: configured APNs path delivers end-to-end', async () => {
  // A VALID generated .p8 (JWT signing still happens; only HTTP is mocked).
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const transportCalls = [];
  const { doInstance } = makeDO({
    env: {
      ...VAPID_ENV,
      APNS_KEY_ID: 'TESTKEY123',
      APNS_TEAM_ID: 'TEAM00001',
      APNS_BUNDLE_ID: 'com.example.lifeprogress',
      APNS_PRIVATE_KEY: p8,
      APNS_ENV: 'sandbox',
    },
    deps: {
      apnsTransport: async (req) => {
        transportCalls.push(req);
        return { status: 200, reason: null };
      },
    },
  });
  await doInstance.register(iosReg());
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1, 'delivery via the real provider + mock HTTP transport');
  assert.equal(transportCalls.length, 1);
  assert.equal(transportCalls[0].host, 'api.sandbox.push.apple.com');
  const body = JSON.parse(transportCalls[0].body);
  assert.equal(body.aps.alert.title, 'Time for some water 💧');
});
