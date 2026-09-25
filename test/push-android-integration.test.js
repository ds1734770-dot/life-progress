/**
 * V2.0 Phase 5 — Android integration tests: Durable Object ↔ dispatcher ↔ FCM
 * (spec §5.1/§5.4/§5.5/§5.7, mirroring test/push-ios-integration.test.js).
 *
 * Proven end-to-end against a REAL SQLite engine (same harness conventions as
 * test/push-do-migration.test.js / push-ios-integration.test.js):
 *  · an Android row dispatches through FCM ONLY — Web Push sender and APNs
 *    are never invoked, and Web Push fields are never read for it (§5.4)
 *  · delivered / gone / transient / not_configured outcomes map to the exact
 *    existing occurrence + device bookkeeping (no scheduler changes)
 *  · token rotation on one deviceKey updates the token FCM receives (§5.5)
 *  · platform switching (web → android on the same deviceKey) is a full,
 *    deterministic replace — no duplicate identity (§6.9)
 *  · one broken device never stops delivery to other devices (§6.7)
 *  · deep-link routes stay inside the app's route vocabulary (§5.7)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

import { LPPushDO } from '../cloudflare/do.js';
import { dispatchNotification } from '../server/push/dispatch.js';
import { OUTCOME } from '../server/push/outcomes.js';
import { routeFromNotification } from '../js/nativePush.js';
import { toFcmMessage } from '../server/push/fcm.js';
import { buildPushPayload, ROUTES } from '../server/push/domain.js';

// ---------------------------------------------------------------------------
// Harness — identical shape to test/push-ios-integration.test.js
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

/** Mock APNs provider — used only to PROVE Android never touches APNs. */
function apnsMock() {
  const calls = [];
  const provider = {
    platform: 'ios',
    transport: 'apns',
    configured: true,
    isConfigured: () => true,
    async send(device, payloadString) {
      calls.push({ device, payload: JSON.parse(payloadString) });
      return { outcome: OUTCOME.DELIVERED, provider: 'apns', status: 200 };
    },
  };
  provider.calls = calls;
  return provider;
}

/** Mock FCM provider — records sends, replays scripted outcomes. */
function fcmMock() {
  const calls = [];
  const provider = {
    platform: 'android',
    transport: 'fcm',
    configured: true,
    isConfigured: () => true,
    async send(device, payloadString) {
      calls.push({ device, payload: JSON.parse(payloadString) });
      if (provider.next) { const r = provider.next; provider.next = null; return r; }
      return { outcome: OUTCOME.DELIVERED, provider: 'fcm', status: 200 };
    },
  };
  provider.calls = calls;
  provider.next = null;
  provider.sendNext = (outcome, extra = {}) => { provider.next = { outcome, ...extra }; };
  return provider;
}

function makeDO({ env = VAPID_ENV, send = sender(), apns = null, fcm = null, deps = {} } = {}) {
  const state = makeState();
  const doInstance = new LPPushDO(state, env, { sendPushMessage: send, apns, fcm, ...deps });
  return { doInstance, send, state, db: state.db };
}

/** Register an Android device exactly the way js/nativePush.js does (§5.4). */
function androidReg(over = {}) {
  return {
    deviceKey: 'androiddevice01',
    platform: 'android',
    token: 'f'.repeat(152),
    timezone: 'Asia/Kolkata',
    times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
    categories: { water: true, gym: true, goals: true, journal: true },
    quietStart: '22:30',
    quietEnd: '07:00',
    enabled: true,
    ...over,
  };
}

/** Register a web device the way the legacy PWA client does. */
function webReg(over = {}) {
  return {
    deviceKey: 'androiddevice01',
    platform: 'web',
    endpoint: 'https://push.example.test/endpoint/xyz',
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
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
// Dispatcher — Android reaches FCM ONLY (§5.1/§14.E)
// ---------------------------------------------------------------------------

test('dispatcher: Android device reaches the FCM provider, never Web Push or APNs', async () => {
  const send = sender();
  const apns = apnsMock();
  const fcm = fcmMock();
  const device = { platform: 'android', token: 'fcm-token', endpoint: '', keys: {} };
  const result = await dispatchNotification(device, '{}', { sendPushMessage: send, apns, fcm });
  assert.equal(result.outcome, OUTCOME.DELIVERED);
  assert.equal(result.provider, 'fcm');
  assert.equal(send.calls.length, 0, 'Web Push sender untouched for Android');
  assert.equal(apns.calls.length, 0, 'APNs never used for Android');
  assert.equal(fcm.calls.length, 1);
  assert.equal(fcm.calls[0].device.token, 'fcm-token');
});

// ---------------------------------------------------------------------------
// DO integration — Android row through tick()/testPush() (§5.1)
// ---------------------------------------------------------------------------

test('DO tick delivers an Android occurrence through the injected FCM provider', async () => {
  const fcm = fcmMock();
  const { doInstance } = makeDO({ fcm });
  await doInstance.register(androidReg());
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1);
  assert.equal(fcm.calls.length, 1);
  assert.equal(fcm.calls[0].device.token, 'f'.repeat(152), 'the stored token reaches FCM');
  assert.equal(fcm.calls[0].device.platform, 'android');
  const sent = fcm.calls[0].payload;
  assert.equal(sent.occurrenceId, 'androiddevice01:water:2026-01-15');
  assert.equal(sent.category, 'water');
});

test('DO: Android record does not read Web Push fields (empty endpoint/keys row)', async () => {
  const fcm = fcmMock();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  const row = db.prepare('SELECT platform, token, endpoint, p256dh, auth FROM push_subscriptions WHERE device_key = ?').get('androiddevice01');
  assert.equal(row.platform, 'android');
  assert.equal(row.endpoint, '');
  assert.equal(row.p256dh, '');
  assert.equal(row.auth, '');
  // Full tick must succeed purely on the token:
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1);
});

test('DO: delivered Android occurrence is recorded exactly per existing semantics', async () => {
  const fcm = fcmMock();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  await doInstance.tick(WATER_DUE_IST);
  const occ = db.prepare("SELECT status, sent_at FROM notification_occurrences WHERE occurrence_id = ?").get('androiddevice01:water:2026-01-15');
  assert.equal(occ.status, 'delivered');
  assert.ok(occ.sent_at, 'sent_at recorded');
  const sub = db.prepare('SELECT last_delivered_at, failure_count, last_error FROM push_subscriptions WHERE device_key = ?').get('androiddevice01');
  assert.ok(sub.last_delivered_at, 'last_delivered_at recorded');
  assert.equal(sub.failure_count, 0);
  assert.equal(sub.last_error, null);
});

test('DO: gone (UNREGISTERED) removes the Android device record without crashing (§6.7)', async () => {
  const fcm = fcmMock();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  fcm.sendNext(OUTCOME.GONE, { status: 404, reason: 'UNREGISTERED' });
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 0, 'unregistered token removed per existing gone semantics');
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('androiddevice01:water:2026-01-15');
  assert.equal(occ.status, 'gone');
});

test('DO: transient FCM failure keeps the device and marks failure honestly (§6.7)', async () => {
  const fcm = fcmMock();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  fcm.sendNext(OUTCOME.TRANSIENT, { status: 503, error: 'fcm returned 503' });
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'device kept — token is still valid');
  const sub = db.prepare('SELECT failure_count, last_error FROM push_subscriptions WHERE device_key = ?').get('androiddevice01');
  assert.ok(sub.failure_count >= 1, 'failure recorded');
  assert.match(sub.last_error, /503/);
});

test('DO: not_configured keeps the Android device with an honest occurrence state (§6.7)', async () => {
  // Real dispatcher, no FCM credentials in env → honest not_configured.
  const { doInstance, db, send } = makeDO({}); // no fcm override
  await doInstance.register(androidReg());
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  assert.equal(send.calls.length, 0, 'never falls back to Web Push');
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'device kept');
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('androiddevice01:water:2026-01-15');
  assert.equal(occ.status, 'not-configured');
});

test('DO: Android testPush goes through FCM, never Web Push (§5.1/§24)', async () => {
  const fcm = fcmMock();
  const { doInstance, send } = makeDO({ fcm });
  await doInstance.register(androidReg());
  const r = await doInstance.testPush({ deviceKey: 'androiddevice01' });
  assert.equal(r.ok, true);
  assert.equal(fcm.calls.length, 1);
  assert.equal(send.calls.length, 0);
  assert.equal(fcm.calls[0].payload.type, 'test');
});

test('DO: one broken Android device never stops delivery to other devices (§6.7)', async () => {
  const fcm = fcmMock();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg()); // will fail transiently
  await doInstance.register(androidReg({ deviceKey: 'androiddevice02', token: 'e'.repeat(152), times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' } }));
  fcm.sendNext(OUTCOME.TRANSIENT, { status: 500, error: 'fcm returned 500' }); // only the FIRST send fails
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1, 'the second device still got its notification');
  assert.equal(fcm.calls.length, 2, 'both devices were attempted');
  const first = db.prepare('SELECT failure_count FROM push_subscriptions WHERE device_key = ?').get('androiddevice01');
  const second = db.prepare('SELECT failure_count, last_delivered_at FROM push_subscriptions WHERE device_key = ?').get('androiddevice02');
  assert.ok(first.failure_count >= 1, 'failure isolated to the broken device');
  assert.ok(second.last_delivered_at, 'healthy device recorded delivery');
});

// ---------------------------------------------------------------------------
// Token rotation — same deviceKey, new token reaches FCM (§5.5)
// ---------------------------------------------------------------------------

test('token rotation: re-register updates the token FCM receives (§5.5)', async () => {
  const fcm = fcmMock();
  const { doInstance } = makeDO({ fcm });
  await doInstance.register(androidReg());
  await doInstance.register(androidReg({ token: 'b'.repeat(152) })); // rotated
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1);
  assert.equal(fcm.calls.length, 1);
  assert.equal(fcm.calls[0].device.token, 'b'.repeat(152), 'CURRENT token used, not the old one');
});

test('token rotation: only ONE device identity exists after rotation (§5.5)', async () => {
  const fcm = fcmMock();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  await doInstance.register(androidReg({ token: 'c'.repeat(152) }));
  await doInstance.register(androidReg({ token: 'd'.repeat(152) }));
  const rows = db.prepare('SELECT device_key, token FROM push_subscriptions').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token, 'd'.repeat(152));
});

// ---------------------------------------------------------------------------
// Platform switching — deterministic full replace, no duplicates (§6.9)
// ---------------------------------------------------------------------------

test('platform switch: web → android on the same deviceKey replaces the transport (§6.9)', async () => {
  const fcm = fcmMock();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(webReg()); // originally a Web Push device
  await doInstance.register(androidReg()); // same deviceKey, now native Android
  const rows = db.prepare('SELECT device_key, platform, token, endpoint FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'no duplicate identity');
  assert.equal(rows[0].platform, 'android', 'platform replaced');
  assert.equal(rows[0].token, 'f'.repeat(152), 'token replaced');
  // And delivery follows the NEW platform exclusively:
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1);
  assert.equal(fcm.calls.length, 1);
  assert.equal(fcm.calls[0].device.token, 'f'.repeat(152));
});

// ---------------------------------------------------------------------------
// Deep links — same route vocabulary as the service worker (§5.7)
// ---------------------------------------------------------------------------

test('deep link: FCM payload route matches the shared domain ROUTES table', () => {
  for (const category of ['water', 'gym', 'goals', 'journal']) {
    const { message } = toFcmMessage(buildPushPayload({ kind: 'reminder', category, occurrenceId: 'x', dateKey: '2026-09-18', route: ROUTES[category] }), 'tok');
    assert.equal(message.data.route, ROUTES[category]);
    assert.match(message.data.route, /^#\/[a-z]+$/, 'hash route vocabulary preserved');
    // And the client allowlist accepts exactly this shape:
    assert.equal(routeFromNotification({ data: { route: message.data.route } }), message.data.route);
  }
});

test('deep link: DO-sent Android payload carries the route the client allowlists', async () => {
  const fcm = fcmMock();
  const { doInstance } = makeDO({ fcm });
  await doInstance.register(androidReg());
  await doInstance.tick(WATER_DUE_IST);
  const sent = fcm.calls[0].payload;
  assert.equal(sent.route, '#/water');
  assert.equal(routeFromNotification({ data: { route: sent.route } }), sent.route);
});

// ---------------------------------------------------------------------------
// Provider/transport isolation — the DO works with an HTTP-level mock too
// ---------------------------------------------------------------------------

test('DO with fcmTransport injection: configured FCM path delivers end-to-end', async () => {
  // A VALID generated RSA key (JWT signing still happens; only HTTP is mocked).
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const saPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const transportCalls = [];
  const { doInstance } = makeDO({
    env: {
      ...VAPID_ENV,
      FCM_PROJECT_ID: 'life-progress-test',
      FCM_CLIENT_EMAIL: 'push@life-progress-test.iam.gserviceaccount.com',
      FCM_PRIVATE_KEY: saPem,
    },
    deps: {
      fcmTransport: async (req) => {
        transportCalls.push(req);
        if (req.url.startsWith('https://oauth2.googleapis.com/token')) {
          return { status: 200, json: { access_token: 'ya29.mock-access-token' } };
        }
        return { status: 200, json: { name: 'projects/life-progress-test/messages/mock-msg-id' } };
      },
    },
  });
  await doInstance.register(androidReg());
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1, 'delivery via the real provider + mock HTTP transport');
  const oauth = transportCalls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com'));
  const sends = transportCalls.filter((c) => c.url.includes('messages:send'));
  assert.equal(oauth.length, 1, 'exactly one OAuth exchange');
  assert.equal(sends.length, 1);
  assert.match(sends[0].headers.Authorization, /^Bearer ya29\./);
  assert.equal(sends[0].url, 'https://fcm.googleapis.com/v1/projects/life-progress-test/messages:send');
  const body = JSON.parse(sends[0].body);
  assert.equal(body.message.token, 'f'.repeat(152));
  assert.equal(body.message.notification.title, 'Time for some water 💧', 'shared copy table, not an Android-specific copy system');
  assert.equal(body.message.data.route, '#/water');
});

/* ================================================================== *
 * Native source integrity — a build-stopping defect must never pass the suite
 * (V2.1 regression)
 *
 * `LPMessagingService.buildRichNotification()` declared
 * `android.app.Notification` as its return type and had NO return statement,
 * so javac rejected the whole module with "missing return statement" — the
 * Android app could not be assembled at all, which means no APK, which means
 * no notification in ANY lifecycle state. Every static test passed anyway.
 *
 * There is no JDK in this test environment, so compilation cannot be run here;
 * the next best guarantee is to assert the structural invariant directly on
 * the source. The check is deliberately general — it walks the real braces of
 * EVERY method that declares a Notification return type — so the immersive /
 * full-screen methods being added next are covered automatically.
 * ================================================================== */

/** Extract a Java method body by name via brace matching from its opening brace. */
function javaMethodBody(source, name) {
  const at = source.indexOf(`${name}(`);
  assert.ok(at > -1, `${name} not found in source`);
  const open = source.indexOf('{', at);
  assert.ok(open > -1, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${name}`);
}

test('LPMessagingService: every Notification-returning method actually returns (the missing-return regression)', () => {
  const src = readFileSync(
    join(ROOT, 'android/app/src/main/java/com/example/lifeprogress/LPMessagingService.java'),
    'utf8'
  );
  // Every method whose return type is a Notification.
  const decls = [...src.matchAll(/([\w.]+\s+)(\w+)\s*\(([^)]*)\)\s*\{/g)]
    .filter((m) => /Notification$/.test(m[1].trim()));
  assert.ok(decls.length >= 1, 'expected at least one Notification-returning method');
  for (const decl of decls) {
    const body = javaMethodBody(src, decl[2]);
    assert.match(body, /\breturn\b/, `${decl[2]}() must return — a missing return is a javac error, not a warning`);
  }
  assert.match(src, /return b\.build\(\);/, 'buildRichNotification must return the built notification');
});

test('LPMessagingService: the notification is built on the per-category channel', () => {
  const src = readFileSync(
    join(ROOT, 'android/app/src/main/java/com/example/lifeprogress/LPMessagingService.java'),
    'utf8'
  );
  // The channel id must match server/push/fcm.js (`lp_<category>`) and
  // NotificationChannels; an unknown channel silently degrades presentation.
  assert.match(src, /NotificationCompat\.Builder\(\s*context,\s*"lp_"\s*\+\s*category\s*\)/);
});
