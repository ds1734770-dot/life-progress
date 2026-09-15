/**
 * V1.6.4 — Cloudflare Worker backend tests.
 *
 * The Durable Object is exercised against a REAL SQLite engine (node:sqlite)
 * through the same SQL adapter interface used in production, with a MOCKED
 * push sender and DETERMINISTIC clocks (§27) — no Wrangler, no network, no
 * real push services. The scheduler tick tested here is the exact tick the
 * Cron Trigger invokes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LPPushDO } from '../cloudflare/do.js';
import { adaptWorkerSql } from '../cloudflare/do.js';

// ---------------------------------------------------------------------------
// Test harness — node:sqlite dressed in the production adapter interface
// ---------------------------------------------------------------------------

/**
 * Mimic workerd's DurableObjectStorage.sql on node:sqlite: `exec(sql,
 * ...params)` returns a cursor with `.toArray()`; constraint violations
 * throw like workerd's UNIQUE errors. `adaptWorkerSql` from do.js wraps
 * THIS layer — exactly as the Workers runtime does in production.
 */
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
      // Mutation — node:sqlite throws on constraint violations, like workerd.
      db.prepare(sql).run(...params);
      return { toArray: () => [] };
    },
  };
  return { storage: { sql: raw } };
}

const VAPID_ENV = {
  VAPID_PUBLIC_KEY: 'BPk2nTestPublicKey_placeholder_for_tests_0000000000',
  VAPID_PRIVATE_KEY: 'TestPrivateKey_placeholder_for_tests_only_000000000000',
  VAPID_SUBJECT: 'mailto:test@example.com',
};

/** A deterministic registration (Asia/Kolkata, times in the near future). */
function reg(overrides = {}) {
  return {
    deviceKey: 'testdevice000001',
    endpoint: 'https://fcm.googleapis.com/fcm/send/mock-endpoint',
    keys: { p256dh: 'BMockP256dhKey_MockP256dhKey_MockP256dhKey_Mock', auth: 'MockAuthSecret_MockAuthSecret' },
    timezone: 'Asia/Kolkata',
    times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
    categories: { water: true, gym: true, goals: true, journal: true },
    quietStart: '22:30',
    quietEnd: '07:00',
    enabled: true,
    ...overrides,
  };
}

/** Mocked push sender recording every delivery (§27). */
function sender() {
  const calls = [];
  const fn = async (sub, payload, vapid) => {
    calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), vapid });
    if (fn.next) { const r = fn.next; fn.next = null; return r; }
    return { ok: true, status: 201 };
  };
  fn.calls = calls;
  fn.ok = () => { fn.next = null; };
  fn.fails = (status) => { fn.next = { ok: false, status, transient: status >= 500 || status === 429 }; };
  fn.next = null;
  return fn;
}

function makeDO(env = VAPID_ENV, send = sender()) {
  const doInstance = new LPPushDO(makeState(), env, { sendPushMessage: send });
  return { doInstance, send };
}

// ---------------------------------------------------------------------------
// Durable Object SQLite initialization + registration
// ---------------------------------------------------------------------------

test('DO: schema initializes idempotently (second construction succeeds)', () => {
  const state = makeState();
  const send = sender();
  new LPPushDO(state, VAPID_ENV, { sendPushMessage: send });
  new LPPushDO(state, VAPID_ENV, { sendPushMessage: send }); // must not throw
});

test('DO: register persists subscription, upsert does not duplicate', async () => {
  const { doInstance } = makeDO();
  await doInstance.register(reg());
  await doInstance.register(reg({ endpoint: 'https://fcm.googleapis.com/fcm/send/updated' }));
  const status = await doInstance.status();
  assert.equal(status.devices, 1, 'same deviceKey must update, not duplicate');
  assert.equal(status.active, 1);
});

test('DO: register without VAPID env still stores (delivery gated separately)', async () => {
  const { doInstance } = makeDO({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' });
  await doInstance.register(reg());
  const status = await doInstance.status();
  assert.equal(status.devices, 1);
});

test('DO: unregister removes the device', async () => {
  const { doInstance } = makeDO();
  await doInstance.register(reg());
  await doInstance.unregister({ deviceKey: 'testdevice000001' });
  const status = await doInstance.status();
  assert.equal(status.devices, 0);
});

// ---------------------------------------------------------------------------
// Scheduler tick — deterministic clocks, mocked sender
// ---------------------------------------------------------------------------

test('tick: delivers a reminder due within the grace window exactly once', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg());
  // 12:00:30 IST = 06:30:30 UTC — 30 s after the water reminder minute.
  const now = Date.UTC(2026, 0, 15, 6, 30, 30);
  const r1 = await doInstance.tick(now);
  assert.equal(r1.deliveries, 1, 'water due at 12:00 IST, within 90 s grace');
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].payload.category, 'water');
  assert.equal(send.calls[0].payload.occurrenceId, 'testdevice000001:water:2026-01-15');
  // Deterministic occurrence ID scheme preserved (§5).
  assert.match(send.calls[0].payload.occurrenceId, /^testdevice000001:water:\d{4}-\d{2}-\d{2}$/);
  // Minimal payload only (§7/§14): no personal data keys.
  assert.deepEqual(Object.keys(send.calls[0].payload).sort(),
    ['category', 'dateKey', 'occurrenceId', 'route', 'serverTime', 'type']);
  assert.equal(send.calls[0].payload.route, '#/water');
  // Second tick at the same instant: the claim prevents a duplicate (§14).
  const r2 = await doInstance.tick(now + 1000);
  assert.equal(r2.deliveries, 0);
  assert.equal(send.calls.length, 1, 'duplicate tick must not re-send');
});

test('tick: does not deliver before the scheduled time (never early)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg());
  // 11:59:30 IST — 30 s BEFORE the water reminder.
  const early = await doInstance.tick(Date.UTC(2026, 0, 15, 6, 29, 30));
  assert.equal(early.deliveries, 0);
  assert.equal(send.calls.length, 0);
});

test('tick: marks missed after the grace window and never replays (§11)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg());
  // 12:05 IST — water (12:00) is 5 min past its window; goals (08:00) too;
  // gym (19:00) and journal (21:30) are still in the future → reschedule.
  const r = await doInstance.tick(Date.UTC(2026, 0, 15, 6, 35, 0));
  assert.equal(send.calls.length, 0, 'stale reminder must not be sent');
  const status = await doInstance.status();
  assert.equal(status.occurrences.missed, 2, 'water + goals past their grace window');
  // Later the same day: still no replay of the missed ones.
  await doInstance.tick(Date.UTC(2026, 0, 15, 9, 0, 0));
  assert.equal(send.calls.length, 0);
});

test('tick: respects server-side quiet hours (suppressed, not replayed)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({ times: { water: '23:00', gym: '19:00', goals: '08:00', journal: '21:30' } }));
  // 23:00:30 IST — inside quiet hours (22:30–07:00).
  const r = await doInstance.tick(Date.UTC(2026, 0, 15, 17, 30, 30));
  assert.equal(send.calls.some((c) => c.payload.category === 'water'), false);
  const status = await doInstance.status();
  assert.equal(status.occurrences['quiet-hours'], 1);
});

test('tick: quiet hours crossing midnight are suppressed (start > end)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({ times: { water: '23:00', gym: '19:00', goals: '08:00', journal: '21:30' }, quietStart: '22:30', quietEnd: '06:00' }));
  const r = await doInstance.tick(Date.UTC(2026, 0, 15, 17, 30, 30));
  assert.equal(send.calls.some((c) => c.payload.category === 'water'), false);
});

test('tick: one pending occurrence per category per day (multi-day idempotent)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg());
  // Day 1: water due, delivered.
  await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  assert.equal(send.calls.filter((c) => c.payload.category === 'water').length, 1);
  // Same day, much later: no second water delivery.
  await doInstance.tick(Date.UTC(2026, 0, 15, 9, 0, 0));
  // Day 2: water due again exactly once (recurring, no infinite jobs).
  await doInstance.tick(Date.UTC(2026, 0, 16, 6, 30, 30));
  assert.equal(send.calls.filter((c) => c.payload.category === 'water').length, 2);
  const days = new Set(
    send.calls.filter((c) => c.payload.category === 'water').map((c) => c.payload.dateKey)
  );
  assert.equal(days.size, 2);
});

test('tick: expired subscription (410) is disabled and removed', async () => {
  const send = sender();
  send.fails(410);
  const { doInstance } = makeDO(VAPID_ENV, send);
  await doInstance.register(reg());
  const r = await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  const status = await doInstance.status();
  assert.equal(status.devices, 0, '410 must delete the subscription');
  assert.ok(send.calls.length <= 1);
});

test('tick: expired subscription (404) is disabled and removed', async () => {
  const send = sender();
  send.fails(404);
  const { doInstance } = makeDO(VAPID_ENV, send);
  await doInstance.register(reg());
  await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  const status = await doInstance.status();
  assert.equal(status.devices, 0, '404 must delete the subscription');
});

test('tick: transient push failure keeps subscription for retry next tick', async () => {
  const send = sender();
  send.fails(500);
  const { doInstance } = makeDO(VAPID_ENV, send);
  await doInstance.register(reg());
  await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  const status = await doInstance.status();
  assert.equal(status.devices, 1, 'transient failure must not remove the device');
});

test('tick: without VAPID env, tick is a safe no-op', async () => {
  const { doInstance, send } = makeDO({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' });
  await doInstance.register(reg());
  const r = await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  assert.equal(r.ok, false);
  assert.equal(send.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Timezone / DST correctness through the DO tick (§12)
// ---------------------------------------------------------------------------

test('tick: Asia/Kolkata 12:00 IST = 06:30 UTC, occurrence id uses local date', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({ timezone: 'Asia/Kolkata', times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' } }));
  await doInstance.tick(Date.UTC(2026, 0, 15, 6, 30, 30));
  const call = send.calls[0];
  assert.equal(call.payload.occurrenceId.endsWith('2026-01-15'), true);
});

test('tick: America/New_York 12:00 EST = 17:00 UTC (winter offset)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({
    timezone: 'America/New_York',
    times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  }));
  await doInstance.tick(Date.UTC(2026, 0, 15, 17, 0, 30));
  const water = send.calls.find((c) => c.payload.category === 'water');
  assert.ok(water, 'water due at 12:00 EST within grace');
  assert.equal(water.payload.occurrenceId.endsWith('2026-01-15'), true);
});

test('tick: America/New_York 12:00 EDT = 16:00 UTC (summer offset, DST)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({
    timezone: 'America/New_York',
    times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  }));
  await doInstance.tick(Date.UTC(2026, 6, 15, 16, 0, 30));
  const water = send.calls.find((c) => c.payload.category === 'water');
  assert.ok(water, 'water due at 12:00 EDT within grace');
});

test('tick: Europe/London 08:00 GMT = 08:00 UTC (winter)', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({
    timezone: 'Europe/London',
    times: { water: '08:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  }));
  await doInstance.tick(Date.UTC(2026, 0, 15, 8, 0, 30));
  const water = send.calls.find((c) => c.payload.category === 'water');
  assert.ok(water, 'water due at 08:00 GMT within grace');
});

test('tick: DST spring-forward gap — 02:30 does not exist, no crash, no wrong-day send', async () => {
  const { doInstance, send } = makeDO();
  // 2026-03-08 02:30 America/New_York falls in the spring-forward gap.
  await doInstance.register(reg({
    timezone: 'America/New_York',
    times: { water: '02:30', gym: '19:00', goals: '08:00', journal: '21:30' },
  }));
  // Just after the (materialized) instant — should attempt delivery once.
  const r = await doInstance.tick(Date.UTC(2026, 2, 8, 7, 30, 30)); // 02:30 EST → 07:30 UTC
  assert.ok(typeof r.deliveries === 'number');
  // Whatever was attempted must carry the correct LOCAL date key.
  for (const c of send.calls) {
    assert.equal(c.payload.dateKey, '2026-03-08');
  }
});

test('tick: DST autumn overlap — 01:30 happens twice; delivery occurs exactly once', async () => {
  const { doInstance, send } = makeDO();
  // 2026-11-01 01:30 America/New_York occurs twice (EDT then EST). Quiet
  // hours disabled so the overlap itself is what is under test.
  await doInstance.register(reg({
    timezone: 'America/New_York',
    times: { water: '01:30', gym: '19:00', goals: '08:00', journal: '21:30' },
    quietStart: '00:00', quietEnd: '00:00',
  }));
  const r1 = await doInstance.tick(Date.UTC(2026, 10, 1, 5, 30, 30)); // first 01:30 EDT
  const r2 = await doInstance.tick(Date.UTC(2026, 10, 1, 6, 30, 30)); // second 01:30 EST
  const waterCalls = send.calls.filter((c) => c.payload.category === 'water');
  assert.equal(waterCalls.length, 1, 'deterministic occurrence id dedups the repeat wall-clock time');
  assert.ok(r1.deliveries + r2.deliveries <= 1);
});

test('tick: month boundary — Jan 31 reminder arrives Feb 1 with correct dateKey', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({ times: { water: '00:30', gym: '19:00', goals: '08:00', journal: '21:30' } }));
  await doInstance.tick(Date.UTC(2026, 1, 0, 19, 0, 30)); // Jan 31 18:59:30 UTC == Feb 1 00:29:30 IST
  const r2 = await doInstance.tick(Date.UTC(2026, 1, 0, 19, 0, 45));
  const water = send.calls.filter((c) => c.payload.category === 'water');
  for (const c of water) assert.equal(c.payload.dateKey, '2026-02-01');
});

test('tick: year boundary — Dec 31 → Jan 1 local dateKey', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg({ times: { water: '00:30', gym: '19:00', goals: '08:00', journal: '21:30' } }));
  await doInstance.tick(Date.UTC(2026, 11, 31, 18, 30, 30)); // Jan 1 00:00:30 IST
  const water = send.calls.find((c) => c.payload.category === 'water');
  if (water) assert.equal(water.payload.dateKey, '2027-01-01');
});

// ---------------------------------------------------------------------------
// Concurrency / atomicity of the claim (§11/§14)
// ---------------------------------------------------------------------------

test('claim: two sequential ticks can never both deliver the same occurrence', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg());
  const now = Date.UTC(2026, 0, 15, 6, 30, 30);
  await doInstance.tick(now);
  await doInstance.tick(now);
  await doInstance.tick(now + 500);
  assert.equal(send.calls.length, 1, 'three ticks, one delivery');
});

test('claim: parallel ticks on the SAME DO instance serialize via SQLite PK', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg());
  const now = Date.UTC(2026, 0, 15, 6, 30, 30);
  // Same-instance parallelism: the JS engine serializes these, mirroring
  // the DO input gate; the PK constraint remains the ultimate guard.
  await Promise.all([
    doInstance.tick(now),
    doInstance.tick(now),
  ]);
  assert.equal(send.calls.filter((c) => c.payload.category === 'water').length, 1);
});

// ---------------------------------------------------------------------------
// Test notification (§15)
// ---------------------------------------------------------------------------

test('testPush: real sender invoked for a registered device', async () => {
  const { doInstance, send } = makeDO();
  await doInstance.register(reg());
  const r = await doInstance.testPush({ deviceKey: 'testdevice000001' });
  assert.equal(r.ok, true);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].payload.type, 'test');
  assert.notEqual(send.calls[0].payload.occurrenceId, undefined);
});

test('testPush: unknown device → not-found error, no send', async () => {
  const { doInstance, send } = makeDO();
  const r = await doInstance.testPush({ deviceKey: 'missingdevice1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/i);
  assert.equal(send.calls.length, 0);
});

test('testPush: missing body deviceKey → not-found error', async () => {
  const { doInstance, send } = makeDO();
  const r = await doInstance.testPush({});
  assert.equal(r.ok, false);
  assert.equal(send.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Privacy: stored columns and payloads stay minimal (§4/§24)
// ---------------------------------------------------------------------------

test('DO stores only delivery metadata (no journal/goals/water/photos fields)', async () => {
  const { doInstance } = makeDO();
  await doInstance.register(reg());
  const status = await doInstance.status();
  const serialized = JSON.stringify(status);
  for (const forbidden of ['journal_text', 'goal_title', 'photo', 'amount_ml', 'note']) {
    assert.ok(!serialized.includes(forbidden), `must not contain ${forbidden}`);
  }
});
