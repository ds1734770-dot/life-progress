/**
 * V2.0 Phase 3 — APNs provider tests (server/push/apns.js).
 *
 * Covering spec §14 B/C/D + payload shaping:
 *  · missing config pieces → honest `not_configured`, never a crash
 *  · JWT: ES256 / kid = key ID / iss = team ID / iat present / 3 segments,
 *    signature VERIFIED against a GENERATED test key — never a real Apple
 *    credential, and no key material anywhere in the token (§17)
 *  · response mapping per the Phase 2 outcome contract (§14.D)
 *  · provider.send() end-to-end through an injected transport
 *  · the dispatcher's Web-Push-shaped payload is transformed into a proper
 *    APNs `aps` request, with user-visible copy from the SHARED table
 *    (js/swPush.js#genericForCategory) — no duplicated copy system
 *  · device tokens stay opaque (no endpoint/p256dh/auth coercion) (§8)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from 'node:crypto';

import {
  apnsConfig,
  isApnsConfigured,
  apnsJwtClaims,
  apnsProviderToken,
  apnsPath,
  apnsHeaders,
  apnsPayload,
  toApnsPayload,
  mapApnsResponse,
  apnsProvider,
} from '../server/push/apns.js';
import { OUTCOME } from '../server/push/outcomes.js';
import { buildPushPayload } from '../server/push/domain.js';
import { genericForCategory } from '../js/swPush.js';

/* ------------------------------------------------------------------ *
 * Generated EC P-256 key — a REAL PKCS#8 PEM, exactly the .p8 format,
 * but generated for this test run. Never a production Apple credential.
 * ------------------------------------------------------------------ */
const { publicKey: TEST_PUBLIC, privateKey: TEST_PRIVATE } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const TEST_P8_PEM = TEST_PRIVATE.export({ type: 'pkcs8', format: 'pem' });
const TEST_PUB_PEM = TEST_PUBLIC.export({ type: 'spki', format: 'pem' });

const FULL_ENV = Object.freeze({
  APNS_KEY_ID: 'TESTKEY123',
  APNS_TEAM_ID: 'TEAM00001',
  APNS_BUNDLE_ID: 'com.example.lifeprogress',
  APNS_PRIVATE_KEY: TEST_P8_PEM,
  APNS_ENV: 'sandbox',
});

const DEVICE = Object.freeze({
  device_key: 'device-key-ios-01',
  platform: 'ios',
  token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
});

function decodeB64u(s) {
  return Buffer.from(s, 'base64url');
}

/* ================================================================== *
 * B. Configuration (§14.B) — every missing piece is honest
 * ================================================================== */
test('apnsConfig: fully missing env → null (not_configured signal, no crash)', () => {
  assert.equal(apnsConfig({}), null);
  assert.equal(apnsConfig(undefined), null); // even with no environment at all
});

test('apnsConfig: each missing required key → null, naming the requirement', () => {
  for (const key of ['APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_BUNDLE_ID', 'APNS_PRIVATE_KEY']) {
    const env = { ...FULL_ENV };
    delete env[key];
    assert.equal(apnsConfig(env), null, `missing ${key} must not configure`);
  }
});

test('apnsConfig: blank-string values count as missing', () => {
  assert.equal(apnsConfig({ ...FULL_ENV, APNS_PRIVATE_KEY: '   ' }), null);
});

test('apnsConfig: full env → resolved config with sandbox host', () => {
  const config = apnsConfig(FULL_ENV);
  assert.equal(config.keyId, FULL_ENV.APNS_KEY_ID);
  assert.equal(config.teamId, FULL_ENV.APNS_TEAM_ID);
  assert.equal(config.bundleId, FULL_ENV.APNS_BUNDLE_ID);
  assert.equal(config.environment, 'sandbox');
  assert.equal(config.host, 'api.sandbox.push.apple.com');
  assert.equal(isApnsConfigured(FULL_ENV), true);
});

test('apnsConfig: production default + explicit env selection (§3)', () => {
  const { APNS_ENV, ...withoutEnv } = FULL_ENV;
  assert.equal(apnsConfig(withoutEnv).host, 'api.push.apple.com');
  assert.equal(apnsConfig({ ...withoutEnv, APNS_ENV: 'production' }).host, 'api.push.apple.com');
  assert.equal(apnsConfig({ ...withoutEnv, APNS_ENV: 'sandbox' }).host, 'api.sandbox.push.apple.com');
  // An unknown environment must NOT silently fall back to production.
  assert.equal(apnsConfig({ ...withoutEnv, APNS_ENV: 'staging' }), null);
});

/* ================================================================== *
 * C. JWT (§14.C)
 * ================================================================== */
test('apnsJwtClaims: ES256 header with kid, iss = team ID, iat = seconds', () => {
  const { header, payload } = apnsJwtClaims({ keyId: 'KID', teamId: 'TID' }, 1_758_000_000);
  assert.deepEqual(header, { alg: 'ES256', kid: 'KID' });
  assert.deepEqual(payload, { iss: 'TID', iat: 1_758_000_000 });
});

test('apnsProviderToken: 3 segments, correct header/claims, signature verifies (ES256)', async () => {
  const nowMs = 1_758_000_123_000;
  const jwt = await apnsProviderToken(apnsConfig(FULL_ENV), nowMs);
  const [headerB64, claimsB64, sigB64] = jwt.split('.');
  assert.ok(sigB64, 'JWT must carry a signature segment');

  const header = JSON.parse(decodeB64u(headerB64).toString('utf8'));
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, FULL_ENV.APNS_KEY_ID);

  const claims = JSON.parse(decodeB64u(claimsB64).toString('utf8'));
  assert.equal(claims.iss, FULL_ENV.APNS_TEAM_ID);
  assert.equal(claims.iat, 1_758_000_123); // Unix seconds, not ms

  // Cryptographic verification against the generated key (ieee-p1363 is the
  // WebCrypto ECDSA signature encoding the provider uses).
  const signingInput = `${headerB64}.${claimsB64}`;
  const ok = cryptoVerify(
    'sha256',
    Buffer.from(signingInput, 'utf8'),
    { key: createPublicKey(TEST_PUB_PEM), dsaEncoding: 'ieee-p1363' },
    decodeB64u(sigB64),
  );
  assert.equal(ok, true, 'JWT signature must verify against the test public key');
});

test('apnsProviderToken: no private key material leaks into the token (§17)', async () => {
  const jwt = await apnsProviderToken(apnsConfig(FULL_ENV));
  assert.equal(jwt.toLowerCase().includes('private'), false);
  assert.equal(jwt.includes('BEGIN'), false);
  // The DER body of the test key must not appear either.
  const derBody = TEST_P8_PEM.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  assert.equal(jwt.includes(derBody.slice(0, 24)), false);
});

test('apnsProviderToken: invalid PEM → throws (provider converts to not_configured)', async () => {
  await assert.rejects(
    () => apnsProviderToken(apnsConfig({ ...FULL_ENV, APNS_PRIVATE_KEY: 'not a pem' })),
    Error,
  );
});

/* ================================================================== *
 * Request shaping (§4)
 * ================================================================== */
test('apnsPath: opaque token in the URL path — never parsed or transformed', () => {
  assert.equal(apnsPath(DEVICE.token), `/3/device/${DEVICE.token}`);
});

test('apnsHeaders: bearer auth, apns-topic = bundle ID, alert push type, priority 10', () => {
  const config = apnsConfig(FULL_ENV);
  const headers = apnsHeaders(config, 'JWT.X.Y');
  assert.equal(headers.authorization, 'bearer JWT.X.Y');
  assert.equal(headers['apns-topic'], FULL_ENV.APNS_BUNDLE_ID);
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(headers['apns-priority'], '10');
});

/* ================================================================== *
 * D. Response mapping (§14.D)
 * ================================================================== */
test('mapApnsResponse: 200 → delivered', () => {
  assert.equal(mapApnsResponse(200), OUTCOME.DELIVERED);
});

test('mapApnsResponse: 410 and Unregistered/BadDeviceToken → gone', () => {
  assert.equal(mapApnsResponse(410), OUTCOME.GONE);
  assert.equal(mapApnsResponse(400, 'Unregistered'), OUTCOME.GONE);
  assert.equal(mapApnsResponse(400, 'BadDeviceToken'), OUTCOME.GONE);
  assert.equal(mapApnsResponse(400, 'DeviceTokenNotForTopic'), OUTCOME.GONE);
});

test('mapApnsResponse: 429 and 5xx → transient_failure', () => {
  assert.equal(mapApnsResponse(429), OUTCOME.TRANSIENT);
  assert.equal(mapApnsResponse(500), OUTCOME.TRANSIENT);
  assert.equal(mapApnsResponse(503, 'ServiceUnavailable'), OUTCOME.TRANSIENT);
});

test('mapApnsResponse: other 4xx → permanent_failure (nothing silently retried)', () => {
  assert.equal(mapApnsResponse(400, 'PayloadEmpty'), OUTCOME.PERMANENT);
  assert.equal(mapApnsResponse(400, null), OUTCOME.PERMANENT);
  assert.equal(mapApnsResponse(403, 'Forbidden'), OUTCOME.PERMANENT);
});

/* ================================================================== *
 * Provider end-to-end via injected transport
 * ================================================================== */
function makeTransport(status, reason) {
  const calls = [];
  return {
    calls,
    transport: async (req) => {
      calls.push(req);
      if (status instanceof Error) throw status;
      return { status, reason };
    },
  };
}

test('provider: unconfigured APNs → not_configured, transport never called', async () => {
  const { calls, transport } = makeTransport(200);
  const provider = apnsProvider({ configSource: {}, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(calls.length, 0);
});

test('provider: garbage .p8 → not_configured (config problem, not a retry loop)', async () => {
  const { calls, transport } = makeTransport(200);
  const provider = apnsProvider({ configSource: { ...FULL_ENV, APNS_PRIVATE_KEY: 'garbage' }, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(calls.length, 0);
});

test('provider: empty/missing token → permanent failure without transport call', async () => {
  const { calls, transport } = makeTransport(200);
  const provider = apnsProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send({ platform: 'ios', token: '' }, '{}');
  assert.equal(result.outcome, OUTCOME.PERMANENT);
  assert.equal(calls.length, 0);
});

test('provider: network exception → transient_failure, never escapes (§2)', async () => {
  const { transport } = makeTransport(new Error('ECONNRESET'));
  const provider = apnsProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.outcome, OUTCOME.TRANSIENT);
});

test('provider: 200 → delivered; request carries host/path/headers/body', async () => {
  const { calls, transport } = makeTransport(200);
  const provider = apnsProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send(DEVICE, toApnsPayload(buildPushPayload({ kind: 'reminder', category: 'water', occurrenceId: 'occ_1', dateKey: '2026-09-18', route: '#/water' })));
  assert.equal(result.outcome, OUTCOME.DELIVERED);
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.host, 'api.sandbox.push.apple.com');
  assert.equal(req.path, `/3/device/${DEVICE.token}`);
  assert.match(req.headers.authorization, /^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(req.headers['apns-topic'], FULL_ENV.APNS_BUNDLE_ID);
  const body = JSON.parse(req.body);
  assert.equal(body.aps.alert.title, genericForCategory('water').title);
});

test('provider: maps 410 → gone and 400 Unregistered → gone', async () => {
  for (const [status, reason] of [[410, null], [400, 'Unregistered']]) {
    const { transport } = makeTransport(status, reason);
    const provider = apnsProvider({ configSource: FULL_ENV, transport });
    const result = await provider.send(DEVICE, '{}');
    assert.equal(result.outcome, OUTCOME.GONE, `${status}/${reason}`);
  }
});

test('provider: 429 → transient, 400 PayloadEmpty → permanent', async () => {
  const t429 = makeTransport(429, 'TooManyRequests');
  assert.equal((await apnsProvider({ configSource: FULL_ENV, transport: t429.transport }).send(DEVICE, '{}')).outcome, OUTCOME.TRANSIENT);
  const t400 = makeTransport(400, 'PayloadEmpty');
  assert.equal((await apnsProvider({ configSource: FULL_ENV, transport: t400.transport }).send(DEVICE, '{}')).outcome, OUTCOME.PERMANENT);
});

/* ================================================================== *
 * F. Token opacity (§8) — no Web Push structures for native devices
 * ================================================================== */
test('provider: iOS result never fabricates endpoint/p256dh/auth', async () => {
  const { transport } = makeTransport(200);
  const provider = apnsProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.endpoint, undefined);
  assert.equal(result.p256dh, undefined);
  assert.equal(result.auth, undefined);
});

/* ================================================================== *
 * G. Payload transformation (aps wrapper + shared copy, §11)
 * ================================================================== */
test('toApnsPayload: shared buildPushPayload output becomes a valid aps alert', () => {
  const shared = buildPushPayload({ kind: 'reminder', category: 'gym', occurrenceId: 'occ_9', dateKey: '2026-09-18', route: '#/gym', serverTime: 1_758_000_000_000 });
  const out = JSON.parse(toApnsPayload(shared));
  const copy = genericForCategory('gym');
  assert.equal(out.aps.alert.title, copy.title);
  assert.equal(out.aps.alert.body, copy.body);
  assert.equal(out.aps.sound, 'default'); // reminder = audible
  assert.equal(out.aps['mutable-content'], 1);
  assert.equal(out.aps.badge, 1);
  // Identity metadata preserved verbatim for the client (deep link + dedup):
  assert.equal(out.type, 'reminder');
  assert.equal(out.category, 'gym');
  assert.equal(out.occurrenceId, 'occ_9');
  assert.equal(out.dateKey, '2026-09-18');
  assert.equal(out.route, '#/gym');
});

test('toApnsPayload: test notifications get the test copy, no sound', () => {
  const out = JSON.parse(toApnsPayload(JSON.stringify({ type: 'test', category: 'test', occurrenceId: 't1', dateKey: '', route: '#/dashboard' })));
  assert.equal(out.type, 'test');
  assert.equal(out.aps.alert.body, 'Notifications are working 🔔 Background reminders are active.');
  assert.equal(out.aps.sound, undefined);
});

// ==================================================================
// V2.1 Phase 2 — native category mapping (aps.category + thread-id)
// ==================================================================
test('aps.category maps every wire category to the native UPPER_SNAKE id', () => {
  const pairs = {
    water: 'WATER_REMINDER',
    gym: 'GYM_REMINDER',
    goals: 'GOALS_REMINDER',
    journal: 'JOURNAL_REMINDER',
    streaks: 'STREAK_REMINDER',
    achievements: 'ACHIEVEMENT_REMINDER',
    test: 'GENERAL_REMINDER',
    '': 'GENERAL_REMINDER',
    'bogus': 'GENERAL_REMINDER',
  };
  for (const [wire, native] of Object.entries(pairs)) {
    const out = JSON.parse(toApnsPayload(buildPushPayload({ kind: wire === 'test' ? 'test' : 'reminder', category: wire, occurrenceId: 'o', dateKey: '2026-09-24', route: '#/dashboard' })));
    assert.equal(out.aps.category, native, wire);
    // thread-id groups per category in Notification Center; empty/unknown → 'general'.
    // It is an OFFICIAL aps key and lives INSIDE the aps dictionary.
    if (wire !== 'test') assert.equal(out.aps['thread-id'], wire || 'general', wire);
  }
  // The wire `category` field keeps its lowercase web vocabulary.
  const water = JSON.parse(toApnsPayload(buildPushPayload({ kind: 'reminder', category: 'water', occurrenceId: 'o', dateKey: '2026-09-24', route: '#/water' })));
  assert.equal(water.category, 'water');
  assert.notEqual(water.aps.category, water.category);
});

test('toApnsPayload: already-aps payloads pass through untouched', () => {
  const apsReady = JSON.stringify({ aps: { alert: { title: 'x', body: 'y' } }, type: 'reminder' });
  assert.equal(toApnsPayload(apsReady), apsReady);
});

test('toApnsPayload: unparseable payload → safe generic alert, never throws', () => {
  const out = JSON.parse(toApnsPayload('not json at all'));
  assert.equal(out.aps.alert.title, 'Life Progress');
  assert.equal(out.aps.alert.body, 'Time for a quick check-in.');
  assert.equal(out.route, '#/dashboard');
});

test('toApnsPayload: unknown category falls back to the generic copy', () => {
  const out = JSON.parse(toApnsPayload(JSON.stringify({ type: 'reminder', category: 'mystery' })));
  assert.equal(out.aps.alert.title, 'Life Progress');
  assert.equal(out.aps.alert.body, 'Time for a quick check-in.');
});
