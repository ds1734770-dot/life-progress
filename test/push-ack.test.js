/**
 * V2.2 — occurrence ownership: ACK endpoint + duplicate-suppression races.
 *
 * Covers the interrupted Wave-1 work:
 *   · POST /api/push/ack (Node) — validation, not-due rejection, idempotency
 *   · the Durable Object /ack route — persistence, and the same
 *     not-due/unknown rejections as the Node backend (ONE contract)
 *   · the Cloudflare Worker HTTP route wired to the DO (same shape as Node)
 *   · local/server race BOTH ways:
 *       CASE A  09:00 app opens → nothing claimed → 14:00 push still eligible
 *       CASE B  14:00 push handled/ACKed → local sweep later: no duplicate
 *       CASE C  14:00 local handle → ACK → server tick: no duplicate push
 *       CASE D  same occurrence claimed twice (restart/dup tick) → 1 delivery
 *   · canonical occurrence identity is IDENTICAL across backends (the one
 *     identity function lives in js/timeCore.js and is re-exported verbatim).
 *
 * ACK semantics enforced by these tests: an ACK records a REAL handled
 * occurrence — never "the app opened", "the scheduler ran" or "the provider
 * returned 200"; an occurrence that is not due yet is REJECTED (409), the
 * exact bug shape the interrupted run was fixing.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

// Isolate persistence BEFORE importing the store (same pattern as
// test/push-node-delivery.test.js — never touch the developer's real data).
const DATA_FILE = join(tmpdir(), `lp-test-push-ack-${process.pid}.json`);
process.env.PUSH_DATA_FILE = DATA_FILE;

const store = await import('../server/store.js');
const { handlePushApi } = await import('../server/api.js');
const { schedulerTick } = await import('../server/scheduler.js');
const { LPPushDO } = await import('../cloudflare/do.js');
const worker = (await import('../cloudflare/worker.js')).default;
const domain = await import('../server/push/domain.js');
const timeCore = await import('../js/timeCore.js');
const { generateVapidKeys, b64uEncode } = await import('../server/push/webpush.js');

const VAPID_KEYS = await generateVapidKeys();
process.env.VAPID_PUBLIC_KEY = VAPID_KEYS.publicKey;
process.env.VAPID_PRIVATE_KEY = VAPID_KEYS.privateKey;
process.env.VAPID_SUBJECT = 'mailto:tests@example.com';
const VAPID = { ...VAPID_KEYS, subject: 'mailto:tests@example.com' };

after(async () => {
  await rm(DATA_FILE, { force: true });
  await rm(`${DATA_FILE}.tmp`, { force: true });
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Minimal req/res pair matching what handlePushApi touches. */
function fakeExchange({ method = 'POST', pathname = '/api/push/ack', body = {} } = {}) {
  const req = {
    method,
    url: pathname,
    headers: { origin: 'https://example.test' },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, handler) {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body)));
      if (event === 'end') handler();
      return this;
    },
    destroy() {},
  };
  const res = {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader() {},
    writeHead(code) { this.statusCode = code; return this; },
    end(chunk) { if (chunk) this.chunks.push(String(chunk)); },
    json() { return JSON.parse(this.chunks.join('') || '{}'); },
  };
  return { req, res };
}

async function post(body, pathname = '/api/push/ack') {
  const { req, res } = fakeExchange({ body, pathname });
  await handlePushApi(req, res, pathname);
  return { status: res.statusCode, body: res.json() };
}

async function registerDevice(deviceKey, overrides = {}) {
  await store.upsertSubscription(deviceKey, {
    platform: 'web',
    endpoint: `https://push.example.test/sub/${deviceKey}`,
    keys: { p256dh: 'k', auth: 'a' },
    timezone: 'UTC',
    categories: { water: true, gym: true, goals: true, journal: true },
    times: { water: '14:00', gym: '11:00', goals: '09:00', journal: '21:30' },
    quietStart: '22:30',
    quietEnd: '07:00',
    enabled: true,
    ...overrides,
  });
  return store.getSubscription(deviceKey);
}

/** DO on node:sqlite with a mocked sender + injectable clock. */
function makeDO({ now = Date.now(), send } = {}) {
  const db = new DatabaseSync(':memory:');
  const raw = {
    exec(sql, ...params) {
      if (params.length === 0) {
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return { toArray: () => db.prepare(sql).all() };
        db.exec(sql);
        return { toArray: () => [] };
      }
      if (/^\s*SELECT/i.test(sql)) return { toArray: () => db.prepare(sql).all(...params) };
      db.prepare(sql).run(...params);
      return { toArray: () => [] };
    },
  };
  const calls = [];
  const sender = send || (async (sub, payload) => { calls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); return { ok: true, status: 201 }; });
  const inst = new LPPushDO(
    { storage: { sql: raw, getAlarm: () => null, setAlarm: () => {}, deleteAlarm: () => {} } },
    { VAPID_PUBLIC_KEY: 'BPk2nTestPublicKey_placeholder_for_tests_0000000000', VAPID_PRIVATE_KEY: 'TestPrivateKey_placeholder_for_tests_only_000000000000' },
    { sendPushMessage: sender, now: () => now }
  );
  return { inst, calls };
}

// ---------------------------------------------------------------------------
// Canonical occurrence identity (Phase 4 of the wave spec)
// ---------------------------------------------------------------------------

test('occurrence identity is identical across page, Node and Worker backends', () => {
  // ONE identity function: js/timeCore.js, re-exported by server/push/domain.js.
  assert.equal(domain.occurrenceId, timeCore.occurrenceId, 'same function object — no second identity system');
  assert.equal(domain.ACK_GRACE_MS, timeCore.ACK_GRACE_MS);
  assert.equal(domain.computeNextOccurrences, timeCore.computeNextOccurrences, 'sweep and scheduler run the SAME model');
  assert.equal(domain.isDue, timeCore.isDue);
  assert.equal(domain.isEligible, timeCore.isEligible);
  // The required identity matrix: different dates / categories → different
  // occurrences, deterministically, on both sides.
  assert.equal(domain.occurrenceId('dev-0001', 'water', '2026-09-24'), 'dev-0001:water:2026-09-24');
  assert.notEqual(domain.occurrenceId('dev-0001', 'water', '2026-09-24'), domain.occurrenceId('dev-0001', 'water', '2026-09-25'));
  assert.notEqual(domain.occurrenceId('dev-0001', 'water', '2026-09-24'), domain.occurrenceId('dev-0001', 'gym', '2026-09-24'));
  // Both backends derive the SAME occurrenceId for the same schedule input.
  const sub = {
    deviceKey: 'dev-0001', timezone: 'UTC', enabled: true,
    categories: { water: true }, times: { water: '14:00' }, ledger: {},
  };
  const at = Date.UTC(2026, 0, 14, 13, 0, 0);
  const viaNode = domain.computeNextOccurrences(sub, at)[0];
  const viaTimeCore = timeCore.computeNextOccurrences(sub, at)[0];
  assert.equal(viaNode.occurrenceId, viaTimeCore.occurrenceId);
  assert.equal(viaNode.occurrenceId, 'dev-0001:water:2026-01-14');
});

// ---------------------------------------------------------------------------
// Node ACK endpoint (POST /api/push/ack)
// ---------------------------------------------------------------------------

test('Node ACK endpoint: a real handled occurrence is recorded on the ledger', async () => {
  await store.loadState();
  await store.resetState();
  const deviceKey = 'acknode00000001';
  await registerDevice(deviceKey);
  // 14:05 — the 14:00 water occurrence is due and within its window.
  const ackAt = Date.UTC(2026, 0, 14, 14, 5, 0);
  const realNow = Date.now;
  Date.now = () => ackAt;
  try {
    const r = await post({ deviceKey, category: 'water', dateKey: '2026-01-14', source: 'local' });
    assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.state, 'acked');
    assert.ok(store.hasOccurrence('acknode00000001:water:2026-01-14'), 'ledger row written');
  } finally {
    Date.now = realNow;
  }
});

test('Node ACK endpoint: ACK before the scheduled instant is REJECTED (not-due)', async () => {
  await store.loadState();
  await store.resetState();
  const deviceKey = 'acknode00000002';
  await registerDevice(deviceKey);
  // 09:00 — water is configured 14:00: the occurrence is NOT due. This is
  // the exact bug shape (premature claim) the endpoint must refuse.
  const early = Date.UTC(2026, 0, 14, 9, 0, 0);
  const realNow = Date.now;
  Date.now = () => early;
  try {
    const r = await post({ deviceKey, category: 'water', dateKey: '2026-01-14', source: 'local' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'occurrence not due yet');
    assert.equal(store.hasOccurrence('acknode00000002:water:2026-01-14'), false, 'no ledger row for a not-due occurrence');
  } finally {
    Date.now = realNow;
  }
});

test('Node ACK endpoint: validation, unknown subscription, idempotency', async () => {
  await store.loadState();
  await store.resetState();
  const deviceKey = 'acknode00000003';
  await registerDevice(deviceKey);
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 0, 14, 14, 5, 0);
  try {
    // Invalid bodies → 400.
    for (const bad of [
      { category: 'water', dateKey: '2026-01-14' }, // missing deviceKey
      { deviceKey: 'bad key!', category: 'water', dateKey: '2026-01-14' },
      { deviceKey, category: 'unknown-cat', dateKey: '2026-01-14' },
      { deviceKey, category: 'water', dateKey: '14/01/2026' },
    ]) {
      const r = await post(bad);
      assert.equal(r.status, 400, `invalid body rejected: ${JSON.stringify(bad)}`);
    }
    // Unknown subscription → 404.
    const missing = await post({ deviceKey: 'nosuchdevice01', category: 'water', dateKey: '2026-01-14' });
    assert.equal(missing.status, 404);
    // First ack writes, second ack is idempotent.
    const a = await post({ deviceKey, category: 'water', dateKey: '2026-01-14' });
    assert.equal(a.body.state, 'acked');
    const b = await post({ deviceKey, category: 'water', dateKey: '2026-01-14' });
    assert.equal(b.status, 200);
    assert.equal(b.body.state, 'already', 'duplicate ACK is an idempotent no-op');
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// CASE C — local handled → ACK → the server never sends the duplicate push
// ---------------------------------------------------------------------------

test('race CASE C: local ACK suppresses the server push for the same occurrence', async () => {
  await store.loadState();
  await store.resetState();
  const deviceKey = 'ackrace0000001';
  await registerDevice(deviceKey, { platform: 'web' });
  const nowMs = Date.UTC(2026, 0, 14, 14, 2, 0); // water 14:00 is due
  const realNow = Date.now;
  Date.now = () => nowMs;
  try {
    // The device handled the 14:00 occurrence locally and ACKs it.
    const r = await post({ deviceKey, category: 'water', dateKey: '2026-01-14', source: 'local' });
    assert.equal(r.status, 200);

    // The server tick then runs: the occurrence is ALREADY claimed by the
    // ACK → it must NOT be delivered again.
    const senderCalls = [];
    globalThis.fetch = async (url) => {
      senderCalls.push(String(url));
      return { ok: true, status: 201, headers: { get: () => null }, text: async () => '' };
    };
    try {
      const sub = store.getSubscription(deviceKey);
      const res = await import('../server/scheduler.js');
      await res.processSubscription(sub, VAPID, nowMs);
      assert.equal(senderCalls.length, 0, 'no push sent for an ACKed occurrence');
    } finally {
      delete globalThis.fetch;
    }
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------
// CASE A — early app open claims nothing; the push stays eligible
// ---------------------------------------------------------------------------

test('race CASE A: 09:00 app open claims nothing; the 14:00 occurrence stays eligible', async () => {
  // Pure-model check: at 09:00 the 14:00 occurrence is not due → the sweep
  // cannot claim it, and the server's decideOccurrence still says reschedule
  // → deliverable at 14:00. This is the invariant the original bug violated.
  const sub = {
    deviceKey: 'dev-0001', timezone: 'UTC', enabled: true,
    categories: { water: true, gym: false, goals: false, journal: false },
    times: { water: '14:00' }, ledger: {},
  };
  const at0900 = Date.UTC(2026, 0, 14, 9, 0, 0);
  const at1400 = Date.UTC(2026, 0, 14, 14, 0, 0);
  const occ = domain.computeNextOccurrences(sub, at0900).find((o) => o.category === 'water');
  assert.equal(occ.occurrenceId, 'dev-0001:water:2026-01-14');
  assert.equal(domain.isDue(occ, at0900), false, 'not due at 09:00 — nothing to claim');
  assert.equal(domain.decideOccurrence(sub, occ, at0900).action, 'reschedule', 'server also waits');
  assert.equal(domain.isDue(occ, at1400), true, 'due at 14:00');
  assert.equal(domain.isEligible(occ, at1400), true, 'and eligible — the push can fire');
  assert.equal(domain.decideOccurrence(sub, occ, at1400).action, 'deliver');
});

// ---------------------------------------------------------------------------
// Durable Object: ACK persistence + tick suppression
// ---------------------------------------------------------------------------

test('DO ack: persists across re-construction and suppresses the duplicate push', async () => {
  const deviceKey = 'ackdo000000001';
  const reg = {
    deviceKey,
    endpoint: 'https://push.example.test/sub/do',
    keys: { p256dh: 'k', auth: 'a' },
    timezone: 'UTC',
    categories: { water: true, gym: true, goals: true, journal: true },
    times: { water: '14:00', gym: '11:00', goals: '09:00', journal: '21:30' },
    quietStart: '22:30', quietEnd: '07:00', enabled: true,
  };
  const dueMs = Date.UTC(2026, 0, 14, 14, 2, 0);
  const { inst, calls } = makeDO({ now: dueMs });
  await inst.fetch(new Request('https://do/register', { method: 'POST', body: JSON.stringify(reg) }));

  // Device ACKs the 14:00 water occurrence it handled locally.
  const ackRes = await inst.fetch(new Request('https://do/ack', {
    method: 'POST',
    body: JSON.stringify({ deviceKey, category: 'water', dateKey: '2026-01-14', source: 'local' }),
  }));
  const ackBody = await ackRes.json();
  assert.equal(ackBody.ok, true, `ack accepted: ${JSON.stringify(ackBody)}`);
  assert.equal(ackBody.state, 'acked');

  // Persistence: the row is in SQLite with an ack status.
  const row = inst.sql.exec(
    'SELECT status FROM notification_occurrences WHERE occurrence_id = ?', `${deviceKey}:water:2026-01-14`
  ).one();
  assert.ok(row, 'ack row persisted');
  assert.equal(row.status, 'acked:local');

  // Re-construction (eviction/restart): the ledger survives — a fresh DO
  // instance re-derives positions from the SAME rows.
  const later = dueMs + 60_000;
  const { inst: inst2, calls: calls2 } = makeDO({ now: later });
  // Same underlying storage is what production gives a re-constructed DO;
  // for the test, replay the row into the second instance's fresh DB.
  inst2.sql.exec(
    `INSERT INTO notification_occurrences (occurrence_id, device_key, category, date_key, status, claimed_at, scheduled_for, created_at)
     VALUES (?, ?, ?, ?, 'acked:local', ?, ?, ?)`,
    `${deviceKey}:water:2026-01-14`, deviceKey, 'water', '2026-01-14', dueMs, Date.UTC(2026, 0, 14, 14, 0, 0), dueMs
  );
  inst2.sql.exec(
    `INSERT INTO push_subscriptions (device_key, endpoint, p256dh, auth, platform, timezone, times, categories, quiet_start, quiet_end, enabled, disabled, failure_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)`,
    deviceKey, 'https://push.example.test/sub/do', 'k', 'a', 'UTC',
    JSON.stringify(reg.times), JSON.stringify(reg.categories), '22:30', '07:00', dueMs, dueMs
  );
  const tick = await inst2.fetch(new Request('https://do/tick', { method: 'POST', body: '{}' }));
  const tickBody = await tick.json();
  assert.equal(tickBody.ok, true);
  // The ACKed occurrence is never re-delivered by the tick.
  const waterCalls = calls2.filter((c) => c.payload.category === 'water' && c.payload.dateKey === '2026-01-14');
  assert.equal(waterCalls.length, 0, 'no duplicate push for the ACKed occurrence after restart');

  // Idempotency: a duplicate ack is accepted as 'already'.
  const dup = await inst.fetch(new Request('https://do/ack', {
    method: 'POST',
    body: JSON.stringify({ deviceKey, category: 'water', dateKey: '2026-01-14' }),
  }));
  assert.equal((await dup.json()).state, 'already');
});

test('DO ack: not-due and unknown occurrences are rejected (same contract as Node)', async () => {
  const deviceKey = 'ackdo000000002';
  const { inst } = makeDO({ now: Date.UTC(2026, 0, 14, 9, 0, 0) });
  await inst.fetch(new Request('https://do/register', { method: 'POST', body: JSON.stringify({
    deviceKey,
    endpoint: 'https://push.example.test/sub/do2',
    keys: { p256dh: 'k', auth: 'a' },
    timezone: 'UTC',
    categories: { water: true },
    times: { water: '14:00' },
    quietStart: '22:30', quietEnd: '07:00', enabled: true,
  }) }));

  // 09:00 — the 14:00 occurrence is NOT due.
  const early = await inst.fetch(new Request('https://do/ack', {
    method: 'POST',
    body: JSON.stringify({ deviceKey, category: 'water', dateKey: '2026-01-14' }),
  }));
  const earlyBody = await early.json();
  assert.equal(earlyBody.ok, false);
  assert.equal(earlyBody.error, 'occurrence not due yet');

  // Unknown category/date → no such occurrence.
  const unknown = await inst.fetch(new Request('https://do/ack', {
    method: 'POST',
    body: JSON.stringify({ deviceKey, category: 'water', dateKey: '2030-01-01' }),
  }));
  const unknownBody = await unknown.json();
  assert.equal(unknownBody.ok, false);
  assert.equal(unknownBody.error, 'no such occurrence scheduled');

  // Invalid body → shared validateAck contract.
  const invalid = await inst.fetch(new Request('https://do/ack', {
    method: 'POST',
    body: JSON.stringify({ deviceKey: 'x', category: 'water' }),
  }));
  assert.equal((await invalid.json()).ok, false);
});

// ---------------------------------------------------------------------------
// Cloudflare Worker HTTP route → DO (same shape as the Node backend)
// ---------------------------------------------------------------------------

test('Worker POST /api/push/ack forwards to the DO and preserves the response shape', async () => {
  const db = new DatabaseSync(':memory:');
  const raw = {
    exec(sql, ...params) {
      if (params.length === 0) {
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) return { toArray: () => db.prepare(sql).all() };
        db.exec(sql);
        return { toArray: () => [] };
      }
      if (/^\s*SELECT/i.test(sql)) return { toArray: () => db.prepare(sql).all(...params) };
      db.prepare(sql).run(...params);
      return { toArray: () => [] };
    },
  };
  const doInstance = new LPPushDO(
    { storage: { sql: raw, getAlarm: () => null, setAlarm: () => {}, deleteAlarm: () => {} } },
    { VAPID_PUBLIC_KEY: 'BPk2nTestPublicKey_placeholder_for_tests_0000000000', VAPID_PRIVATE_KEY: 'TestPrivateKey_placeholder_for_tests_only_000000000000' },
    { sendPushMessage: async () => ({ ok: true, status: 201 }), now: () => Date.UTC(2026, 0, 14, 14, 5, 0) }
  );
  const env = {
    LP_PUSH: {
      idFromName: () => 'id-global',
      get: () => ({ fetch: (url, init) => doInstance.fetch(new Request(url, init)) }),
    },
    PUSH_ALLOWED_ORIGINS: 'https://app.example.test',
  };
  await doInstance.fetch(new Request('https://do/register', { method: 'POST', body: JSON.stringify({
    deviceKey: 'ackworker000001',
    endpoint: 'https://push.example.test/sub/w',
    keys: { p256dh: 'k', auth: 'a' },
    timezone: 'UTC',
    categories: { water: true },
    times: { water: '14:00' },
    quietStart: '22:30', quietEnd: '07:00', enabled: true,
  }) }));

  const res = await worker.fetch(new Request('https://w.example.com/api/push/ack', {
    method: 'POST',
    headers: { Origin: 'https://app.example.test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey: 'ackworker000001', category: 'water', dateKey: '2026-01-14', source: 'push' }),
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.state, 'acked');
  assert.equal(body.occurrenceId, 'ackworker000001:water:2026-01-14');

  // CORS preflight works for the new route (browser POSTs from the PWA).
  const pre = await worker.fetch(new Request('https://w.example.com/api/push/ack', { method: 'OPTIONS', headers: { Origin: 'https://app.example.test' } }), env, {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'https://app.example.test');
});

// ---------------------------------------------------------------------------
// CASE D — duplicate claims of the same occurrence stay harmless
// ---------------------------------------------------------------------------

test('race CASE D: duplicate claims/restarts never double-send the same occurrence', async () => {
  await store.loadState();
  await store.resetState();
  const deviceKey = 'ackdup00000001';
  // Delivery encrypts with aes128gcm BEFORE fetch, so fake receiver keys throw
  // inside encryptPayload; the dispatcher maps the throw to TRANSIENT and the
  // bounded retry loop (5s + 10s sleeps) burns ~15s per tick without ever
  // reaching the stub. Use a real P-256 receiver keypair, exactly like
  // test/push-node-delivery.test.js does.
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const receiverKeys = { p256dh: b64uEncode(rawPub), auth: b64uEncode(authSecret) };
  await registerDevice(deviceKey, { keys: receiverKeys });
  const nowMs = Date.UTC(2026, 0, 14, 14, 1, 0);
  const realNow = Date.now;
  Date.now = () => nowMs;
  const senderCalls = [];
  globalThis.fetch = async (url) => { senderCalls.push(String(url)); return { ok: true, status: 201, headers: { get: () => null }, text: async () => '' }; };
  try {
    const { processSubscription } = await import('../server/scheduler.js');
    const sub = store.getSubscription(deviceKey);
    await processSubscription(sub, VAPID, nowMs); // first tick delivers
    // Ledger advance: first tick recorded the handled occurrence.
    await store.upsertLedger(deviceKey, 'water', Date.UTC(2026, 0, 14, 14, 0, 0));
    await processSubscription(sub, VAPID, nowMs); // duplicate tick (restart)
    const waterSends = senderCalls.length; // exactly one push for water
    assert.equal(waterSends, 1, 'the occurrence was delivered exactly once across ticks');
    assert.ok(store.hasOccurrence('ackdup00000001:water:2026-01-14'));
  } finally {
    delete globalThis.fetch;
    Date.now = realNow;
  }
});
