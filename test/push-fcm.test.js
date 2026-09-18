/**
 * V2.0 Phase 5 — FCM provider tests (server/push/fcm.js).
 *
 * Covering spec §5.1/§5.2 + payload shaping, mirroring the APNs suite:
 *  · missing config pieces → honest `not_configured`, never a crash
 *  · OAuth assertion: RS256, correct iss/scope/aud, iat+exp, signature
 *    VERIFIED against a GENERATED test key — never a real Google credential;
 *    no key material anywhere in the token (§GLOBAL 13-16)
 *  · service-account JSON and raw PEM both accepted
 *  · request shaping: opaque token in the message body, shared copy table,
 *    identity metadata only in `data`, system-tray `notification` present
 *  · response mapping per the Phase 2 outcome contract (§5.1)
 *  · provider.send() end-to-end through an injected transport
 *  · device tokens stay opaque (no endpoint/p256dh/auth coercion) (§5.4)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from 'node:crypto';

import {
  fcmConfig,
  isFcmConfigured,
  fcmJwtClaims,
  fcmAssertionJwt,
  fcmSendUrl,
  fcmMessage,
  toFcmMessage,
  mapFcmResponse,
  fcmProvider,
} from '../server/push/fcm.js';
import { OUTCOME } from '../server/push/outcomes.js';
import { buildPushPayload } from '../server/push/domain.js';
import { genericForCategory } from '../js/swPush.js';

/* ------------------------------------------------------------------ *
 * Generated RSA-2048 key — a REAL PKCS#8 PEM, exactly the service-
 * account key format, but generated for this test run. Never a
 * production Google credential.
 * ------------------------------------------------------------------ */
const { publicKey: TEST_PUBLIC, privateKey: TEST_PRIVATE } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const TEST_SA_PEM = TEST_PRIVATE.export({ type: 'pkcs8', format: 'pem' });
const TEST_PUB_PEM = TEST_PUBLIC.export({ type: 'spki', format: 'pem' });

const FULL_ENV = Object.freeze({
  FCM_PROJECT_ID: 'life-progress-test',
  FCM_CLIENT_EMAIL: 'push@life-progress-test.iam.gserviceaccount.com',
  FCM_PRIVATE_KEY: TEST_SA_PEM,
});

const DEVICE = Object.freeze({
  device_key: 'device-key-android-01',
  platform: 'android',
  token: 'f'.repeat(152), // FCM-style token shape — opaque to the provider
});

function decodeB64u(s) {
  return Buffer.from(s, 'base64url');
}

/* ================================================================== *
 * Configuration (§5.1/§5.2) — every missing piece is honest
 * ================================================================== */
test('fcmConfig: fully missing env → null (not_configured signal, no crash)', () => {
  assert.equal(fcmConfig({}), null);
  assert.equal(fcmConfig(undefined), null); // even with no environment at all
});

test('fcmConfig: each missing required key → null', () => {
  for (const key of ['FCM_PROJECT_ID', 'FCM_CLIENT_EMAIL', 'FCM_PRIVATE_KEY']) {
    const env = { ...FULL_ENV };
    delete env[key];
    assert.equal(fcmConfig(env), null, `missing ${key} must not configure`);
  }
});

test('fcmConfig: blank-string values count as missing', () => {
  assert.equal(fcmConfig({ ...FULL_ENV, FCM_PRIVATE_KEY: '   ' }), null);
});

test('fcmConfig: full env → resolved config; isFcmConfigured agrees', () => {
  const config = fcmConfig(FULL_ENV);
  assert.equal(config.projectId, FULL_ENV.FCM_PROJECT_ID);
  assert.equal(config.clientEmail, FULL_ENV.FCM_CLIENT_EMAIL);
  // The key is PEM-normalized (trimmed, CRLF-safe) rather than byte-identical.
  assert.equal(config.privateKey.includes('BEGIN PRIVATE KEY'), true);
  assert.equal(isFcmConfigured(FULL_ENV), true);
});

test('fcmConfig: service-account JSON accepted as FCM_PRIVATE_KEY (fills client email)', () => {
  const saJson = JSON.stringify({
    client_email: FULL_ENV.FCM_CLIENT_EMAIL,
    private_key: TEST_SA_PEM,
  });
  const config = fcmConfig({ ...FULL_ENV, FCM_PRIVATE_KEY: saJson });
  assert.equal(config.projectId, FULL_ENV.FCM_PROJECT_ID);
  assert.equal(config.clientEmail, FULL_ENV.FCM_CLIENT_EMAIL);
  // PEM-only path still works:
  assert.equal(fcmConfig(FULL_ENV).clientEmail, FULL_ENV.FCM_CLIENT_EMAIL);
});

/* ================================================================== *
 * OAuth assertion JWT (§5.2)
 * ================================================================== */
test('fcmJwtClaims: RS256 header, iss = service account, firebase scope, token endpoint aud', () => {
  const { header, payload } = fcmJwtClaims({ clientEmail: 'sa@project.iam' }, { iat: 1_758_000_000, exp: 1_758_003_600 });
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, 'sa@project.iam');
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(payload.exp - payload.iat, 3600);
});

test('fcmAssertionJwt: 3 segments, correct claims, signature VERIFIES (RS256)', async () => {
  const nowMs = 1_758_000_123_000;
  const jwt = await fcmAssertionJwt(fcmConfig(FULL_ENV), nowMs);
  const [headerB64, claimsB64, sigB64] = jwt.split('.');
  assert.ok(sigB64, 'JWT must carry a signature segment');

  const header = JSON.parse(decodeB64u(headerB64).toString('utf8'));
  assert.equal(header.alg, 'RS256');

  const claims = JSON.parse(decodeB64u(claimsB64).toString('utf8'));
  assert.equal(claims.iss, FULL_ENV.FCM_CLIENT_EMAIL);
  assert.equal(claims.iat, 1_758_000_123); // Unix seconds, not ms

  const ok = cryptoVerify(
    'sha256',
    Buffer.from(`${headerB64}.${claimsB64}`, 'utf8'),
    { key: createPublicKey(TEST_PUB_PEM) },
    decodeB64u(sigB64),
  );
  assert.equal(ok, true, 'JWT signature must verify against the test public key');
});

test('fcmAssertionJwt: no private key material leaks into the token', async () => {
  const jwt = await fcmAssertionJwt(fcmConfig(FULL_ENV));
  assert.equal(jwt.toLowerCase().includes('private'), false);
  assert.equal(jwt.includes('BEGIN'), false);
  const derBody = TEST_SA_PEM.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  assert.equal(jwt.includes(derBody.slice(0, 24)), false);
});

test('fcmAssertionJwt: malformed service-account JSON → throws (provider maps to not_configured)', async () => {
  await assert.rejects(
    () => fcmAssertionJwt(fcmConfig({ ...FULL_ENV, FCM_PRIVATE_KEY: '{not json' })),
    Error,
  );
});

test('fcmAssertionJwt: escaped-JSON private key (\\n newlines) signs correctly', async () => {
  // Real service-account JSON files store the PEM with literal \n sequences.
  const escaped = TEST_SA_PEM.split('\n').join('\\n');
  const jwt = await fcmAssertionJwt(fcmConfig({ ...FULL_ENV, FCM_PRIVATE_KEY: JSON.stringify({ client_email: FULL_ENV.FCM_CLIENT_EMAIL, private_key: escaped }) }));
  assert.equal(jwt.split('.').length, 3);
});

/* ================================================================== *
 * Request shaping (§5.1/§5.4/§5.7)
 * ================================================================== */
test('fcmSendUrl: project-scoped v1 endpoint', () => {
  assert.equal(fcmSendUrl('my-project'), 'https://fcm.googleapis.com/v1/projects/my-project/messages:send');
});

test('fcmMessage: opaque token, notification for system-tray display, data = identity only', () => {
  const { message } = fcmMessage({ type: 'reminder', category: 'water', occurrenceId: 'occ_1', dateKey: '2026-09-18', route: '#/water', title: 'T', body: 'B' }, DEVICE.token);
  assert.equal(message.token, DEVICE.token);
  assert.equal(message.notification.title, 'T');
  assert.equal(message.notification.body, 'B');
  // data carries ONLY identity metadata — no personal content:
  assert.deepEqual(message.data, { type: 'reminder', category: 'water', occurrenceId: 'occ_1', dateKey: '2026-09-18', route: '#/water' });
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.channel_id, 'lp_water');
  // The token never appears anywhere else in the message:
  assert.equal(JSON.stringify(message).split(DEVICE.token).length, 2);
});

test('fcmMessage: unknown category → generic channel; test → DEFAULT priority', () => {
  assert.equal(fcmMessage({ type: 'reminder', category: '' }, 'tok').message.android.channel_id, 'lp_general');
  assert.equal(fcmMessage({ type: 'test', category: 'test' }, 'tok').message.android.priority, 'DEFAULT');
});

test('toFcmMessage: shared buildPushPayload output becomes a valid FCM message with shared copy', () => {
  const shared = buildPushPayload({ kind: 'reminder', category: 'gym', occurrenceId: 'occ_9', dateKey: '2026-09-18', route: '#/gym', serverTime: 1_758_000_000_000 });
  const { message } = toFcmMessage(shared, DEVICE.token);
  const copy = genericForCategory('gym');
  assert.equal(message.notification.title, copy.title);
  assert.equal(message.notification.body, copy.body);
  assert.equal(message.data.category, 'gym');
  assert.equal(message.data.occurrenceId, 'occ_9');
  assert.equal(message.data.route, '#/gym');
});

test('toFcmMessage: test notifications get the test copy', () => {
  const { message } = toFcmMessage(JSON.stringify({ type: 'test', category: 'test', occurrenceId: 't1', dateKey: '', route: '#/dashboard' }), DEVICE.token);
  assert.equal(message.data.type, 'test');
  assert.equal(message.notification.body, 'Notifications are working 🔔 Background reminders are active.');
});

test('toFcmMessage: already-FCM-shaped payloads pass through untouched', () => {
  const ready = { message: { token: 'x', notification: { title: 'a', body: 'b' } } };
  assert.deepEqual(toFcmMessage(JSON.stringify(ready), DEVICE.token), ready);
});

test('toFcmMessage: unparseable payload → safe generic message, never throws', () => {
  const { message } = toFcmMessage('not json at all', DEVICE.token);
  assert.equal(message.notification.title, 'Life Progress');
  assert.equal(message.notification.body, 'Time for a quick check-in.');
  assert.equal(message.data.route, '#/dashboard');
});

/* ================================================================== *
 * Response mapping (§5.1)
 * ================================================================== */
test('mapFcmResponse: 200 → delivered', () => {
  assert.equal(mapFcmResponse(200), OUTCOME.DELIVERED);
});

test('mapFcmResponse: 404/410 and UNREGISTERED → gone', () => {
  assert.equal(mapFcmResponse(404), OUTCOME.GONE);
  assert.equal(mapFcmResponse(410), OUTCOME.GONE);
  assert.equal(mapFcmResponse(400, 'UNREGISTERED'), OUTCOME.GONE);
});

test('mapFcmResponse: 429 and 5xx → transient_failure', () => {
  assert.equal(mapFcmResponse(429), OUTCOME.TRANSIENT);
  assert.equal(mapFcmResponse(500, 'INTERNAL'), OUTCOME.TRANSIENT);
  assert.equal(mapFcmResponse(503, 'UNAVAILABLE'), OUTCOME.TRANSIENT);
});

test('mapFcmResponse: 401/403 (server identity problems) → not_configured', () => {
  assert.equal(mapFcmResponse(401), OUTCOME.NOT_CONFIGURED);
  assert.equal(mapFcmResponse(403, 'PERMISSION_DENIED'), OUTCOME.NOT_CONFIGURED);
  assert.equal(mapFcmResponse(403, 'SENDER_ID_MISMATCH'), OUTCOME.NOT_CONFIGURED);
});

test('mapFcmResponse: other 4xx → permanent_failure (nothing silently retried)', () => {
  assert.equal(mapFcmResponse(400, 'INVALID_ARGUMENT'), OUTCOME.PERMANENT);
  assert.equal(mapFcmResponse(422, null), OUTCOME.PERMANENT);
});

/* ================================================================== *
 * Provider end-to-end via injected transport
 * ================================================================== */
function makeTransport({ status = 200, json = {}, tokenResponse = { status: 200, json: { access_token: 'ya29.test-token' } }, fail } = {}) {
  const calls = [];
  return {
    calls,
    transport: async (req) => {
      calls.push(req);
      if (fail) throw fail;
      if (req.url.startsWith('https://oauth2.googleapis.com/token')) return tokenResponse;
      return { status, json };
    },
  };
}

test('provider: unconfigured FCM → not_configured, transport never called', async () => {
  const { calls, transport } = makeTransport();
  const provider = fcmProvider({ configSource: {}, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(calls.length, 0);
});

test('provider: empty/missing token → permanent failure without transport call', async () => {
  const { calls, transport } = makeTransport();
  const provider = fcmProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send({ platform: 'android', token: '' }, '{}');
  assert.equal(result.outcome, OUTCOME.PERMANENT);
  assert.equal(calls.length, 0);
});

test('provider: 200 → delivered; request carries URL/auth/body; token cached across sends', async () => {
  const { calls, transport } = makeTransport();
  const provider = fcmProvider({ configSource: FULL_ENV, transport });
  const payload = buildPushPayload({ kind: 'reminder', category: 'water', occurrenceId: 'occ_1', dateKey: '2026-09-18', route: '#/water' });
  const first = await provider.send(DEVICE, payload);
  assert.equal(first.outcome, OUTCOME.DELIVERED);
  assert.equal(first.provider, 'fcm');
  await provider.send(DEVICE, payload); // second send reuses the access token
  assert.equal(calls.length, 3); // 1 oauth + 2 sends — oauth NOT repeated
  const oauth = calls.filter((c) => c.url.startsWith('https://oauth2.googleapis.com'));
  assert.equal(oauth.length, 1, 'access token is cached');
  const send = calls.find((c) => c.url.includes('messages:send'));
  assert.equal(send.url, fcmSendUrl('life-progress-test'));
  assert.match(send.headers.Authorization, /^Bearer ya29\./);
  const body = JSON.parse(send.body);
  assert.equal(body.message.token, DEVICE.token);
  assert.equal(body.message.notification.title, genericForCategory('water').title);
});

test('provider: oauth failure (401 invalid_grant) → not_configured, no send attempted', async () => {
  const { calls, transport } = makeTransport({ tokenResponse: { status: 401, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } } });
  const provider = fcmProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(calls.length, 1, 'only the oauth call happened');
});

test('provider: malformed service-account key → not_configured (config problem, not a retry loop)', async () => {
  const { calls, transport } = makeTransport();
  const provider = fcmProvider({ configSource: { ...FULL_ENV, FCM_PRIVATE_KEY: 'garbage' }, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(calls.length, 0);
});

test('provider: network exception → transient_failure, never escapes (§5.1)', async () => {
  const { transport } = makeTransport({ fail: new Error('ECONNRESET') });
  const provider = fcmProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.outcome, OUTCOME.TRANSIENT);
});

test('provider: maps 404/UNREGISTERED → gone; 429 → transient; 400 INVALID_ARGUMENT → permanent', async () => {
  for (const [status, json, expected] of [
    [404, { error: { status: 'NOT_FOUND' } }, OUTCOME.GONE],
    [400, { error: { status: 'UNREGISTERED' } }, OUTCOME.GONE],
    [429, { error: { status: 'RESOURCE_EXHAUSTED' } }, OUTCOME.TRANSIENT],
    [400, { error: { status: 'INVALID_ARGUMENT' } }, OUTCOME.PERMANENT],
  ]) {
    const { transport } = makeTransport({ status, json });
    const provider = fcmProvider({ configSource: FULL_ENV, transport });
    const result = await provider.send(DEVICE, '{}');
    assert.equal(result.outcome, expected, `${status}/${json?.error?.status}`);
  }
});

/* ================================================================== *
 * Token opacity (§5.4) — no Web Push structures for native devices
 * ================================================================== */
test('provider: Android result never fabricates endpoint/p256dh/auth', async () => {
  const { transport } = makeTransport();
  const provider = fcmProvider({ configSource: FULL_ENV, transport });
  const result = await provider.send(DEVICE, '{}');
  assert.equal(result.endpoint, undefined);
  assert.equal(result.p256dh, undefined);
  assert.equal(result.auth, undefined);
});
