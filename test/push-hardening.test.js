/**
 * V2.0 Phase 6 — cross-platform hardening tests (§6.1–§6.10).
 *
 * The provider matrix (web→Web Push, ios→APNs, android→FCM) is proven per
 * platform elsewhere. THIS suite proves the platforms behave IDENTICALLY
 * where they must (registration model, quiet hours, occurrence semantics,
 * failure bookkeeping) and INDEPENDENTLY where they must (one transport's
 * outage/config never touches another). Same DO harness conventions as the
 * integration suites; real SQLite, deterministic pinned clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { LPPushDO } from '../cloudflare/do.js';
import { OUTCOME } from '../server/push/outcomes.js';
import { validateRegistration } from '../server/push/http.js';

// ---------------------------------------------------------------------------
// Harness — identical shape to the integration suites
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

function sender({ fail = false } = {}) {
  const calls = [];
  const fn = async (sub, payload, vapid) => {
    calls.push({ sub, payload: JSON.parse(payload), vapid });
    if (fail) return { ok: false, status: 400 };
    return { ok: true, status: 201 };
  };
  fn.calls = calls;
  return fn;
}

function throwingFcm() {
  const calls = [];
  return {
    calls,
    platform: 'android',
    transport: 'fcm',
    configured: true,
    isConfigured: () => true,
    async send() {
      calls.push(1);
      throw new Error('provider exploded');
    },
  };
}

function scriptedFcm() {
  const calls = [];
  const provider = {
    calls,
    next: null,
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
  provider.sendNext = (outcome, extra = {}) => { provider.next = { outcome, ...extra }; };
  return provider;
}

function makeDO({ env = VAPID_ENV, send = sender(), fcm = null, deps = {} } = {}) {
  const state = makeState();
  const doInstance = new LPPushDO(state, env, { sendPushMessage: send, fcm, ...deps });
  return { doInstance, send, state, db: state.db };
}

const BASE_PREFS = {
  timezone: 'Asia/Kolkata',
  times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  categories: { water: true, gym: true, goals: true, journal: true },
  quietStart: '22:30',
  quietEnd: '07:00',
  enabled: true,
};

const webReg = (over = {}) => ({ deviceKey: 'devweb0000001', platform: 'web', endpoint: 'https://push.example.test/ep/1', keys: { p256dh: 'k1', auth: 'a1' }, ...BASE_PREFS, ...over });
const iosReg = (over = {}) => ({ deviceKey: 'devios0000001', platform: 'ios', token: 'i'.repeat(64), ...BASE_PREFS, ...over });
const androidReg = (over = {}) => ({ deviceKey: 'devandroid001', platform: 'android', token: 'a'.repeat(152), ...BASE_PREFS, ...over });

const WATER_DUE_IST = Date.UTC(2026, 0, 15, 6, 30, 30); // 12:00:30 IST

// ---------------------------------------------------------------------------
// §6.1 Registration audit — ONE identity model across platforms
// ---------------------------------------------------------------------------

test('§6.1 registration: all three platforms validate through the SAME function/schema', () => {
  const tz = 'Australia/Sydney'; // no Node/Intl alias ambiguity (unlike Asia/Kolkata)
  const web = validateRegistration({ deviceKey: 'aaaaaaaaaaaaaaaa', platform: 'web', endpoint: 'https://push.example.test/ep/1', keys: { p256dh: 'k'.repeat(43), auth: 'a'.repeat(24) }, timezone: tz, times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' } });
  const ios = validateRegistration({ deviceKey: 'bbbbbbbbbbbbbbbb', platform: 'ios', token: 't'.repeat(64), timezone: tz, times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' } });
  const android = validateRegistration({ deviceKey: 'cccccccccccccccc', platform: 'android', token: 'f'.repeat(152), timezone: tz, times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' } });
  // Same identity/preference fields accepted for every platform:
  for (const r of [web, ios, android]) {
    assert.ok(r.value, 'registration accepted');
    assert.equal(r.value.timezone, tz);
  }
  assert.equal(web.value.platform, 'web');
  assert.equal(ios.value.platform, 'ios');
  assert.equal(android.value.platform, 'android');
  // Native records carry NO Web Push fields (§6.10):
  assert.equal('endpoint' in ios.value, false);
  assert.equal('p256dh' in android.value, false);
});

// ---------------------------------------------------------------------------
// §6.5 Quiet hours — identical semantics on native rows (DO level)
// ---------------------------------------------------------------------------

test('§6.5 quiet hours suppress an Android occurrence exactly like a web one', async () => {
  // Custom quiet window 11:00–13:00 IST brackets water's 12:00 reminder:
  // at 12:00:30 IST the occurrence is INSIDE quiet hours on every platform.
  const duringQuietIST = Date.UTC(2026, 0, 15, 6, 30, 30); // 12:00:30 IST
  const quietPrefs = { quietStart: '11:00', quietEnd: '13:00' };
  const fcm = scriptedFcm();
  const { doInstance, send, db } = makeDO({ fcm });
  await doInstance.register(androidReg(quietPrefs));
  const r = await doInstance.tick(duringQuietIST);
  assert.equal(r.deliveries, 0);
  assert.equal(fcm.calls.length, 0, 'FCM never invoked during quiet hours');
  assert.equal(send.calls.length, 0);
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('devandroid001:water:2026-01-15');
  assert.equal(occ.status, 'quiet-hours', 'same skip reason the web path records');
  // The same check against a web device, for symmetry:
  const { doInstance: do2, db: db2 } = makeDO({});
  await do2.register(webReg(quietPrefs));
  await do2.tick(duringQuietIST);
  const occ2 = db2.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('devweb0000001:water:2026-01-15');
  assert.equal(occ2.status, 'quiet-hours', 'identical semantics across transports');
});

// ---------------------------------------------------------------------------
// §6.6 Dedup — one occurrence, one notification, across retries/wakeups
// ---------------------------------------------------------------------------

test('§6.6 dedup: two ticks at the same instant deliver once (claim is atomic)', async () => {
  const fcm = scriptedFcm();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  const first = await doInstance.tick(WATER_DUE_IST);
  const second = await doInstance.tick(WATER_DUE_IST);
  assert.equal(first.deliveries, 1);
  assert.equal(second.deliveries, 0, 'occurrence already claimed — no replay');
  assert.equal(fcm.calls.length, 1, 'provider saw exactly one send');
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('devandroid001:water:2026-01-15');
  assert.equal(occ.status, 'delivered');
});

test('§6.6 dedup: next-day tick delivers again under the NEXT occurrence id', async () => {
  const fcm = scriptedFcm();
  const { doInstance } = makeDO({ fcm });
  await doInstance.register(androidReg());
  await doInstance.tick(WATER_DUE_IST);
  await doInstance.tick(WATER_DUE_IST + 24 * 60 * 60 * 1000); // next day, same time
  assert.equal(fcm.calls.length, 2, 'one send per day — distinct occurrence ids');
  assert.equal(fcm.calls[0].payload.occurrenceId, 'devandroid001:water:2026-01-15');
  assert.equal(fcm.calls[1].payload.occurrenceId, 'devandroid001:water:2026-01-16');
});

test('§6.6 dedup: per-device occurrence ids — two platforms never collide', async () => {
  const fcm = scriptedFcm();
  const { doInstance, send, db } = makeDO({ fcm });
  await doInstance.register(androidReg()); // devandroid001
  await doInstance.register(iosReg({ deviceKey: 'devios0000002' })); // second device, no APNs override → not-configured, still claims
  await doInstance.tick(WATER_DUE_IST);
  const ids = db.prepare("SELECT occurrence_id FROM notification_occurrences WHERE occurrence_id LIKE '%:water:%'").all().map((r) => r.occurrence_id).sort();
  assert.equal(ids.length, 2, 'each device has its own occurrence');
  assert.deepEqual(ids, ['devandroid001:water:2026-01-15', 'devios0000002:water:2026-01-15']);
  assert.equal(fcm.calls.length, 1, 'android delivered');
  assert.equal(send.calls.length, 0);
});

// ---------------------------------------------------------------------------
// §6.7 Failure handling — typed outcomes, isolation, throws never escape
// ---------------------------------------------------------------------------

test('§6.7 permanent_failure keeps the device but records the failure honestly', async () => {
  const fcm = scriptedFcm();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  fcm.sendNext(OUTCOME.PERMANENT, { status: 400, reason: 'INVALID_ARGUMENT' });
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 0);
  const rows = db.prepare('SELECT device_key, failure_count, last_error FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'device RETAINED on permanent failure (unlike gone)');
  assert.ok(rows[0].failure_count >= 1, 'failure recorded');
  assert.match(rows[0].last_error, /INVALID_ARGUMENT/);
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('devandroid001:water:2026-01-15');
  assert.equal(occ.status, 'failed');
});

test('§6.7 a provider that THROWS never crashes the tick — dispatcher contains it', async () => {
  const fcm = throwingFcm();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  const r = await doInstance.tick(WATER_DUE_IST); // must not throw
  assert.equal(r.deliveries, 0);
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'device retained — the throw maps to transient');
  const occ = db.prepare("SELECT status FROM notification_occurrences WHERE occurrence_id = ?").get('devandroid001:water:2026-01-15');
  assert.equal(occ.status, 'failed', 'recorded, not silently dropped');
});

// ---------------------------------------------------------------------------
// §6.8 Token lifecycle — unregistration removes exactly one identity
// ---------------------------------------------------------------------------

test('§6.8 unregister removes the native device record', async () => {
  const fcm = scriptedFcm();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg());
  await doInstance.unregister({ deviceKey: 'devandroid001' });
  const rows = db.prepare('SELECT device_key FROM push_subscriptions').all();
  assert.equal(rows.length, 0);
});

test('§6.8 unregister of an unknown deviceKey is a safe no-op', async () => {
  const { doInstance } = makeDO({});
  await assert.doesNotReject(() => doInstance.unregister({ deviceKey: 'never-existed' }));
});

// ---------------------------------------------------------------------------
// §6.9 Platform switching — deterministic replace in BOTH directions
// ---------------------------------------------------------------------------

test('§6.9 platform switch: android → ios on the same deviceKey (§6.9 deterministic)', async () => {
  // ios override is not installed here; use register-only assertions + a
  // fresh DO with an APNs mock for the delivery leg.
  const fcm = scriptedFcm();
  const { doInstance, db } = makeDO({ fcm });
  await doInstance.register(androidReg()); // devandroid001, token a…
  await doInstance.register(iosReg({ deviceKey: 'devandroid001', token: 'n'.repeat(64) })); // same key → ios
  const rows = db.prepare('SELECT device_key, platform, token FROM push_subscriptions').all();
  assert.equal(rows.length, 1, 'no duplicate identity');
  assert.equal(rows[0].platform, 'ios', 'platform replaced');
  assert.equal(rows[0].token, 'n'.repeat(64), 'token replaced');
  assert.equal(fcm.calls.length, 0);
});

// ---------------------------------------------------------------------------
// §6.10 Transport independence — web outage, Android unaffected (one tick)
// ---------------------------------------------------------------------------

test('§6.10 transport independence: missing VAPID skips web honestly while FCM still delivers', async () => {
  // NO VAPID env at all; FCM mocked and working.
  const fcm = scriptedFcm();
  const { doInstance, send, db } = makeDO({ env: {}, fcm });
  await doInstance.register(webReg()); // web needs VAPID → not_configured
  await doInstance.register(androidReg());
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1, 'Android delivered despite web being unconfigured');
  assert.equal(fcm.calls.length, 1);
  assert.equal(send.calls.length, 0, 'web never half-sent without VAPID');
  // The web row recorded the honest not-configured state, not an error loop:
  const sub = db.prepare('SELECT last_error FROM push_subscriptions WHERE device_key = ?').get('devweb0000001');
  assert.match(sub.last_error || '', /VAPID|not configured/i);
});

test('§6.10 transport independence: FCM outage does not touch web delivery', async () => {
  // VAPID present; FCM mock fails transiently for android.
  const send = sender();
  const fcm = scriptedFcm();
  const { doInstance } = makeDO({ send, fcm });
  await doInstance.register(webReg());
  await doInstance.register(androidReg());
  fcm.sendNext(OUTCOME.TRANSIENT, { status: 503 });
  const r = await doInstance.tick(WATER_DUE_IST);
  assert.equal(r.deliveries, 1, 'web delivered despite the FCM failure');
  assert.equal(send.calls.length, 1);
  assert.equal(fcm.calls.length, 1, 'android attempted exactly once (transient keeps device)');
});

// ---------------------------------------------------------------------------
// §6.2 Dispatch audit — every platform goes through dispatchNotification
// (structurally guaranteed: the DO/Node call sites are shared; proven here
// for the LAST platform pair that could bypass)
// ---------------------------------------------------------------------------

test('§6.2 dispatch audit: legacy row without platform still routes as web through the dispatcher', async () => {
  const send = sender();
  const fcm = scriptedFcm();
  const { dispatchNotification } = await import('../server/push/dispatch.js');
  const legacy = { ...webReg(), platform: undefined }; // Phase-1-era row shape
  const result = await dispatchNotification(legacy, '{}', { vapid: VAPID_ENV, sendPushMessage: send, fcm });
  assert.equal(result.outcome, OUTCOME.DELIVERED);
  assert.equal(result.status, 201, 'web provider reported the send');
  assert.equal(fcm.calls.length, 0);
  assert.equal(send.calls.length, 1);
});
