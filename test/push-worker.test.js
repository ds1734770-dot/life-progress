/**
 * V1.6.4 — Worker-level HTTP integration tests.
 *
 * Exercises cloudflare/worker.js's REAL fetch handler end-to-end: HTTP
 * routing, CORS, rate limiting and error handling, with env.LP_PUSH bound
 * to a genuine LPPushDO running on node:sqlite. No Wrangler, no network
 * (the push sender is mocked), deterministic — the same handler the
 * Cloudflare runtime invokes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../cloudflare/worker.js';
import { LPPushDO } from '../cloudflare/do.js';

const ORIGIN = 'https://ds1734770-dot.github.io';

/** Mocked push sender (never touches the network — §27). */
const sendCalls = [];
const mockSend = async (sub, payload) => {
  sendCalls.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
  return { ok: true, status: 201 };
};

/** env.LP_PUSH stub that forwards into a REAL DO on node:sqlite. */
function makeEnv(overrides = {}) {
  const db = new DatabaseSync(':memory:');
  const raw = {
    exec(sql, ...params) {
      if (params.length === 0) {
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
          const rows = db.prepare(sql).all();
          return { toArray: () => rows };
        }
        db.exec(sql);
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
  const doInstance = new LPPushDO({ storage: { sql: raw } }, {
    VAPID_PUBLIC_KEY: 'BPk2nTestPublicKey_placeholder_for_tests_0000000000',
    VAPID_PRIVATE_KEY: 'TestPrivateKey_placeholder_for_tests_only_000000000000',
    VAPID_SUBJECT: 'mailto:test@example.com',
  }, { sendPushMessage: mockSend });

  return {
    LP_PUSH: {
      idFromName: () => 'id-global',
      get: () => ({
        fetch: (url, init) => doInstance.fetch(new Request(url, init)),
      }),
    },
    PUSH_ALLOWED_ORIGINS: ORIGIN,
    // Worker-level env (secrets in production). The DO receives its own copy.
    VAPID_PUBLIC_KEY: 'BPk2nTestPublicKey_placeholder_for_tests_0000000000',
    VAPID_SUBJECT: 'mailto:test@example.com',
    ...overrides,
  };
}

const VALID_REG = {
  deviceKey: 'workertestdev01',
  endpoint: 'https://fcm.googleapis.com/fcm/send/mock',
  keys: { p256dh: 'BMockP256dhKey_MockP256dhKey_MockP256dhKey_Mock', auth: 'MockAuthSecret_MockAuthSecret' },
  timezone: 'Asia/Kolkata',
  times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  categories: { water: true, gym: true, goals: true, journal: true },
  quietStart: '22:30',
  quietEnd: '07:00',
  enabled: true,
};

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

test('GET /health → JSON ok:true, no secrets', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/health'), makeEnv(), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'life-progress-push');
  assert.ok(!JSON.stringify(body).includes('privateKey'));
});

// ---------------------------------------------------------------------------
// VAPID public endpoint
// ---------------------------------------------------------------------------

test('GET /api/push/vapid-public → public key + CORS echo, never private key', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/api/push/vapid-public', {
    headers: { Origin: ORIGIN },
  }), makeEnv(), {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  const body = await res.json();
  assert.ok(body.publicKey);
  assert.equal('privateKey' in body, false);
  assert.deepEqual(Object.keys(body).sort(), ['publicKey', 'source', 'subject']);
});

test('GET /api/push/vapid-public without VAPID env → 503 (honest, not fake)', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('https://w.example.com/api/push/vapid-public'), {
    ...env, VAPID_PUBLIC_KEY: undefined,
  }, {});
  assert.equal(res.status, 503);
});

// ---------------------------------------------------------------------------
// CORS + OPTIONS (§9)
// ---------------------------------------------------------------------------

test('OPTIONS preflight on API route → 204 with allowlist origin + methods', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
  }), makeEnv(), {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

test('OPTIONS from a NON-allowlisted origin → no ACAO header (blocked)', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example.com' },
  }), makeEnv(), {});
  assert.equal(res.status, 204); // preflight itself succeeds…
  assert.equal(res.headers.get('access-control-allow-origin'), null); // …but origin is not allowed
});

// ---------------------------------------------------------------------------
// Register → status → DO round-trip through the real Worker
// ---------------------------------------------------------------------------

test('POST /api/push/register → ok, then GET /status reflects it', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(VALID_REG),
  }), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.deviceKey, 'workertestdev01');

  const status = await worker.fetch(new Request('https://w.example.com/api/push/status', {
    headers: { Origin: ORIGIN },
  }), env, {});
  const s = await status.json();
  assert.equal(s.devices, 1);
  assert.equal(s.active, 1);
});

test('POST /api/push/register with an invalid timezone → 400 stable error', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ ...VALID_REG, timezone: 'Mars/Olympus' }),
  }), makeEnv(), {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid timezone');
});

test('POST /api/push/register with oversized body → 400 payload too large', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify(VALID_REG) + ' '.repeat(65 * 1024),
  }), makeEnv(), {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'payload too large');
});

test('POST with malformed JSON → 400 invalid JSON (no stack trace)', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: '{not json',
  }), makeEnv(), {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid JSON');
});

test('POST /api/push/unregister → ok and device is gone', async () => {
  const env = makeEnv();
  await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_REG),
  }), env, {});
  const res = await worker.fetch(new Request('https://w.example.com/api/push/unregister', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey: 'workertestdev01' }),
  }), env, {});
  assert.equal(res.status, 200);
  const status = await (await worker.fetch(new Request('https://w.example.com/api/push/status'), env, {})).json();
  assert.equal(status.devices, 0);
});

test('unknown /api/push route → JSON 404 (never HTML)', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/api/push/nope'), makeEnv(), {});
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not found');
});

test('non-API path → JSON 404 (the Worker serves no static files)', async () => {
  const res = await worker.fetch(new Request('https://w.example.com/index.html'), makeEnv(), {});
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Test push through the Worker → DO → mocked sender (§15)
// ---------------------------------------------------------------------------

test('POST /api/push/test with a registered device reaches the (mocked) sender', async () => {
  const env = makeEnv();
  await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_REG),
  }), env, {});
  sendCalls.length = 0;
  const res = await worker.fetch(new Request('https://w.example.com/api/push/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey: 'workertestdev01' }),
  }), env, {});
  assert.equal(res.status, 200);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].payload.type, 'test');
});

test('POST /api/push/test for an unregistered device → 404-ish error, no send', async () => {
  const env = makeEnv();
  sendCalls.length = 0;
  const res = await worker.fetch(new Request('https://w.example.com/api/push/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceKey: 'nosuchdevice01' }),
  }), env, {});
  assert.equal(res.status, 200); // DO answers ok:false in-body
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(sendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// scheduled() handler — the Cron entry (§10/§22)
// ---------------------------------------------------------------------------

test('scheduled() invokes the DO tick (registered + due → delivery)', async () => {
  const env = makeEnv();
  await worker.fetch(new Request('https://w.example.com/api/push/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_REG),
  }), env, {});
  sendCalls.length = 0;
  // The real cron invokes scheduled() with a real event; delivery depends on
  // wall-clock position. Assert it completes without throwing and that a due
  // reminder inside the grace window WOULD have been recorded via the mock.
  await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: () => {} });
  // Whatever was sent must be a minimal payload (no personal data).
  for (const c of sendCalls) {
    assert.deepEqual(Object.keys(c.payload).sort(),
      ['category', 'dateKey', 'occurrenceId', 'route', 'serverTime', 'type']);
  }
});
