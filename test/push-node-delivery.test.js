/**
 * V2.1 — Node backend DELIVERY-path tests (server/scheduler.js + server/api.js).
 *
 * Why this file exists (regression origin):
 *
 * Both Node delivery entry points referenced the category `ROUTES` table
 * WITHOUT importing it (`server/scheduler.js` deliverOccurrence and
 * `server/api.js` /api/push/test). The consequences were silent and severe:
 *
 *  · Every due reminder threw a ReferenceError inside deliverOccurrence.
 *    schedulerTick wraps each subscription in try/catch and counts a throw as
 *    a "skip", so the occurrence was already claimed by then — it was
 *    permanently consumed and never replayed. A lost reminder, every day, with
 *    nothing but a stderr line.
 *  · Every categorized test push answered `500 internal error`.
 *
 * The existing suite could not catch it: test/push-scheduling.test.js covers
 * only the PURE policy functions and never reaches deliverOccurrence, and the
 * Durable Object tests exercise cloudflare/do.js, which does import ROUTES.
 * 667 green tests and a completely broken Node delivery path — the exact trap
 * the brief warns about.
 *
 * These tests therefore drive the REAL functions with an isolated state file
 * and a stubbed global fetch, then DECRYPT the aes128gcm body the sender
 * produced. The assertions are about what a browser would actually receive,
 * not about internal call counts.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

// Isolate persistence BEFORE importing the store: server/store.js resolves its
// data file at module evaluation, and must never touch the developer's real
// .push-data.json.
const DATA_FILE = join(tmpdir(), `lp-test-node-delivery-${process.pid}.json`);
process.env.PUSH_DATA_FILE = DATA_FILE;

const store = await import('../server/store.js');
const { processSubscription } = await import('../server/scheduler.js');
const { handlePushApi } = await import('../server/api.js');
const { b64uEncode, decryptPayload, generateVapidKeys } = await import('../server/push/webpush.js');
const { ROUTES } = await import('../server/push/domain.js');

// VAPID from env so nothing is written to disk (.vapid-keys.json).
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

/** A real P-256 receiver keypair + auth secret (what a browser subscription holds). */
async function makeReceiver() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    publicKey: raw,
    privateKey: pair.privateKey,
    authSecret: auth,
    keys: { p256dh: b64uEncode(raw), auth: b64uEncode(auth) },
  };
}

/** Replace global fetch, capturing the raw Web Push request. */
function stubFetch(status = 201) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => '',
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Decrypt a captured aes128gcm body back into the JSON payload a SW would parse. */
async function decryptCall(call, receiver) {
  const body = call.opts.body;
  const plaintext = await decryptPayload(
    body,
    { publicKey: receiver.publicKey, privateKey: receiver.privateKey },
    receiver.authSecret
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

/** Minimal req/res pair matching what handlePushApi touches. */
function fakeExchange({ method = 'POST', pathname = '/api/push/test', body = {} } = {}) {
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
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(code, extra) {
      this.statusCode = code;
      if (extra) Object.assign(this.headers, extra);
      return this;
    },
    end(chunk) { if (chunk) this.chunks.push(String(chunk)); },
    json() { return JSON.parse(this.chunks.join('') || '{}'); },
  };
  return { req, res };
}

async function registerWebDevice(deviceKey, keys, { categories = {}, times = {} } = {}) {
  await store.upsertSubscription(deviceKey, {
    platform: 'web',
    endpoint: 'https://push.example.test/sub/abc',
    keys,
    timezone: 'UTC',
    categories,
    times,
    quietStart: '22:30',
    quietEnd: '07:00',
    enabled: true,
  });
  return store.getSubscription(deviceKey);
}

// ---------------------------------------------------------------------------
// Scheduler delivery path
// ---------------------------------------------------------------------------

test('Node scheduler: a due reminder actually reaches Web Push with its allowlisted route', async () => {
  await store.loadState();
  await store.resetState();
  const receiver = await makeReceiver();
  const deviceKey = 'nodedelivery0001';
  const sub = await registerWebDevice(
    deviceKey,
    receiver.keys,
    { categories: { water: true, gym: false, goals: false, journal: false }, times: { water: '12:00' } }
  );

  // 12:05 UTC — the 12:00 occurrence is 5 s old, inside the 90 s grace window.
  const occurrenceMs = Date.UTC(2026, 0, 15, 12, 0, 0);
  const nowMs = occurrenceMs + 5_000;

  const stub = stubFetch(201);
  let result;
  try {
    result = await processSubscription(sub, VAPID, nowMs);
  } finally {
    stub.restore();
  }

  // Before the fix this THREW (ReferenceError: ROUTES is not defined), which
  // schedulerTick swallowed as a "skip" — the occurrence was burnt regardless.
  assert.equal(result.handled, 1, 'the occurrence was handled, not thrown away');
  assert.equal(stub.calls.length, 1, 'exactly one Web Push request was made');

  const call = stub.calls[0];
  assert.equal(call.url, 'https://push.example.test/sub/abc');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['Content-Encoding'], 'aes128gcm');
  assert.match(call.opts.headers.Authorization, /^vapid t=/);

  // The private key must never travel; the `k=` parameter is the PUBLIC key.
  assert.ok(!call.opts.headers.Authorization.includes(VAPID_KEYS.privateKey), 'no private key on the wire');

  const payload = await decryptCall(call, receiver);
  assert.equal(payload.type, 'reminder');
  assert.equal(payload.category, 'water');
  assert.equal(payload.route, ROUTES.water, 'the category route resolved — this is what the missing import broke');
  assert.equal(payload.route, '#/water');
  assert.equal(payload.occurrenceId, `${deviceKey}:water:2026-01-15`);
  assert.equal(payload.dateKey, '2026-01-15');
  // Privacy contract: identity metadata only, never personal data.
  assert.deepEqual(Object.keys(payload).sort(), ['category', 'dateKey', 'occurrenceId', 'route', 'serverTime', 'type']);
});

test('Node scheduler: only the due, enabled category is delivered', async () => {
  await store.loadState();
  await store.resetState();
  const receiver = await makeReceiver();
  const sub = await registerWebDevice(
    'nodedelivery0002',
    receiver.keys,
    {
      categories: { water: true, gym: false, goals: true, journal: false },
      times: { water: '12:00', gym: '12:00', goals: '18:00' },
    }
  );

  const stub = stubFetch(201);
  try {
    await processSubscription(sub, VAPID, Date.UTC(2026, 0, 15, 12, 0, 30));
  } finally {
    stub.restore();
  }

  assert.equal(stub.calls.length, 1, 'the disabled category and the later occurrence were not sent');
  const payload = await decryptCall(stub.calls[0], receiver);
  assert.equal(payload.category, 'water');
});

test('Node scheduler: quiet hours are still skipped, never delivered', async () => {
  await store.loadState();
  await store.resetState();
  const receiver = await makeReceiver();
  const sub = await registerWebDevice(
    'nodedelivery0003',
    receiver.keys,
    { categories: { water: true }, times: { water: '23:00' } }
  );

  const stub = stubFetch(201);
  let result;
  try {
    result = await processSubscription(sub, VAPID, Date.UTC(2026, 0, 15, 23, 0, 10));
  } finally {
    stub.restore();
  }

  assert.equal(stub.calls.length, 0, 'nothing sent during quiet hours');
  assert.equal(result.handled, 1, 'the occurrence was handled (marked skip, not replayed)');
});

// ---------------------------------------------------------------------------
// API delivery path
// ---------------------------------------------------------------------------

test('POST /api/push/test with a category sends the REAL reminder payload (no 500)', async () => {
  await store.loadState();
  await store.resetState();
  const receiver = await makeReceiver();
  await registerWebDevice('nodeapitest0001', receiver.keys, {
    categories: { water: true }, times: { water: '12:00' },
  });

  const { req, res } = fakeExchange({ body: { deviceKey: 'nodeapitest0001', category: 'water' } });
  const stub = stubFetch(201);
  try {
    const handled = await handlePushApi(req, res, '/api/push/test');
    assert.equal(handled, true);
  } finally {
    stub.restore();
  }

  // Before the fix: `ROUTES is not defined` → outer catch → 500 internal error.
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode} ${res.chunks.join('')}`);
  assert.equal(res.json().ok, true);
  assert.equal(stub.calls.length, 1);

  const payload = await decryptCall(stub.calls[0], receiver);
  assert.equal(payload.type, 'reminder', 'category tests use the real reminder shape, not the generic test push');
  assert.equal(payload.category, 'water');
  assert.equal(payload.route, ROUTES.water);
});

test('POST /api/push/test without a category stays the generic test push', async () => {
  await store.loadState();
  await store.resetState();
  const receiver = await makeReceiver();
  await registerWebDevice('nodeapitest0002', receiver.keys, {
    categories: { water: true }, times: { water: '12:00' },
  });

  const { req, res } = fakeExchange({ body: { deviceKey: 'nodeapitest0002' } });
  const stub = stubFetch(201);
  try {
    await handlePushApi(req, res, '/api/push/test');
  } finally {
    stub.restore();
  }

  assert.equal(res.statusCode, 200);
  const payload = await decryptCall(stub.calls[0], receiver);
  assert.equal(payload.type, 'test');
  assert.equal(payload.route, '#/dashboard');
});

test('POST /api/push/test rejects an unknown device and an unknown category safely', async () => {
  await store.loadState();
  await store.resetState();

  const missing = fakeExchange({ body: { deviceKey: 'nobody000000000001' } });
  assert.equal(await handlePushApi(missing.req, missing.res, '/api/push/test'), true);
  assert.equal(missing.res.statusCode, 404);

  const receiver = await makeReceiver();
  await registerWebDevice('nodeapitest0003', receiver.keys, {
    categories: { water: true }, times: { water: '12:00' },
  });
  // Unknown category → the allowlist drops it and the generic test push is
  // used; it must never become an arbitrary category the server invents.
  const unknown = fakeExchange({ body: { deviceKey: 'nodeapitest0003', category: 'not-a-category' } });
  const stub = stubFetch(201);
  try {
    await handlePushApi(unknown.req, unknown.res, '/api/push/test');
  } finally {
    stub.restore();
  }
  assert.equal(unknown.res.statusCode, 200);
  const payload = await decryptCall(stub.calls[0], receiver);
  assert.equal(payload.type, 'test');
});
