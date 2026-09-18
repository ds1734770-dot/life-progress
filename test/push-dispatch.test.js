/**
 * V2.0 Phase 2 — delivery dispatcher tests (server/push/dispatch.js).
 *
 * The dispatcher is the platform seam: provider selection must be EXPLICIT,
 * outcomes must be TYPED, and a native device must NEVER be silently sent
 * through Web Push. Web Push behavior is verified against the same mocked
 * sender contract the existing suites use (§15 items 1–5, 13–15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchNotification,
  resolveProvider,
  normalizePlatform,
  webPushProvider,
  makeResult,
  OUTCOME,
  PLATFORMS,
} from '../server/push/dispatch.js';

const VAPID = {
  publicKey: 'BPk2nTestPublicKey_placeholder_for_tests_0000000000',
  privateKey: 'TestPrivateKey_placeholder_for_tests_only_000000000000',
  subject: 'mailto:test@example.com',
};

/** Mocked sender matching server/push/webpush.js#sendPushMessage's contract. */
function sender() {
  const calls = [];
  const fn = async (sub, payload, vapid) => {
    calls.push({ sub, payload, vapid });
    if (fn.next instanceof Error) { const e = fn.next; fn.next = null; throw e; }
    if (fn.next) { const r = fn.next; fn.next = null; return r; }
    return { ok: true, status: 201 };
  };
  fn.calls = calls;
  fn.fails = (status, transient = status === 429 || status >= 500) => {
    fn.next = { ok: false, status, transient };
  };
  fn.throws = (message) => { fn.next = new Error(message); };
  fn.next = null;
  return fn;
}

const webDevice = (over = {}) => ({
  platform: 'web',
  endpoint: 'https://push.example.com/send/abc',
  keys: { p256dh: 'BMockP256dhKey_MockP256dhKey_MockP256dhKey_Mock', auth: 'MockAuthSecret_MockAuthSecret' },
  ...over,
});

// ---------------------------------------------------------------------------
// Provider selection — explicit, never accidental (§2/§15.15)
// ---------------------------------------------------------------------------

test('normalizePlatform: missing/empty platform defaults to web (legacy)', () => {
  assert.equal(normalizePlatform(undefined), 'web');
  assert.equal(normalizePlatform(null), 'web');
  assert.equal(normalizePlatform(''), 'web');
});

test('normalizePlatform: known platforms pass through', () => {
  for (const p of PLATFORMS) assert.equal(normalizePlatform(p), p);
});

test('normalizePlatform: unknown platform is rejected (null), never coerced to web', () => {
  assert.equal(normalizePlatform('windows'), null);
  assert.equal(normalizePlatform('Web'), null); // case-sensitive: not a platform
  assert.equal(normalizePlatform(42), null);
  assert.equal(normalizePlatform({}), null);
});

test('resolveProvider: web → web-push provider', () => {
  const p = resolveProvider('web', { vapid: VAPID });
  assert.equal(p.platform, 'web');
  assert.equal(p.transport, 'web-push');
});

test('resolveProvider: ios → APNs provider (own transport, not Web Push)', () => {
  const p = resolveProvider('ios');
  assert.equal(p.platform, 'ios');
  assert.equal(p.transport, 'apns');
  // Phase 3: the REAL APNs provider resolves. With no credentials in the
  // environment it reports honestly as not configured (never web push).
  assert.equal(p.isConfigured(), false);
});

test('resolveProvider: android → FCM provider (own transport, not Web Push)', () => {
  const p = resolveProvider('android');
  assert.equal(p.platform, 'android');
  assert.equal(p.transport, 'fcm');
  // Phase 5: the REAL FCM provider resolves. Without credentials in this
  // environment it reports honestly as not configured (never web push).
  assert.equal(p.isConfigured(), false);
});

test('resolveProvider: unknown platform → null (caller must reject)', () => {
  assert.equal(resolveProvider('windows'), null);
  assert.equal(resolveProvider(undefined), null);
});

test('webPushProvider without VAPID: not_configured — never a fake send', async () => {
  const send = sender();
  const provider = webPushProvider({ sendPushMessage: send });
  const r = await provider.send(webDevice(), '{}');
  assert.equal(r.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(send.calls.length, 0, 'no sender invocation without credentials');
});

// ---------------------------------------------------------------------------
// Dispatch outcomes — typed, per §9
// ---------------------------------------------------------------------------

test('web dispatch selects Web Push and passes endpoint/keys/vapid through', async () => {
  const send = sender();
  const device = webDevice();
  const r = await dispatchNotification(device, '{"category":"water"}', { vapid: VAPID, sendPushMessage: send });
  assert.equal(r.outcome, OUTCOME.DELIVERED);
  assert.equal(send.calls.length, 1);
  assert.equal(send.calls[0].sub.endpoint, device.endpoint);
  assert.deepEqual(send.calls[0].sub.keys, device.keys);
  assert.equal(send.calls[0].vapid, VAPID);
});

test('legacy device without platform dispatches through Web Push (§15.5)', async () => {
  const send = sender();
  const { platform, ...legacy } = webDevice();
  const r = await dispatchNotification(legacy, '{}', { vapid: VAPID, sendPushMessage: send });
  assert.equal(r.outcome, OUTCOME.DELIVERED);
  assert.equal(send.calls.length, 1);
});

test('ios dispatch returns not_configured — never sent via Web Push (§15.2/15.15)', async () => {
  const send = sender();
  const device = { platform: 'ios', token: 'a'.repeat(64) };
  const r = await dispatchNotification(device, '{}', { vapid: VAPID, sendPushMessage: send });
  assert.equal(r.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(r.provider, 'apns');
  assert.match(r.reason, /not configured/i, 'Phase 3: real APNs provider, no credentials in tests');
  assert.equal(send.calls.length, 0, 'Web Push sender must not be touched for iOS');
});

test('android dispatch returns not_configured — never sent via Web Push (§15.3/15.15)', async () => {
  const send = sender();
  const device = { platform: 'android', token: 'fcm-token-example-123456' };
  const r = await dispatchNotification(device, '{}', { vapid: VAPID, sendPushMessage: send });
  assert.equal(r.outcome, OUTCOME.NOT_CONFIGURED);
  assert.equal(r.provider, 'fcm');
  assert.equal(send.calls.length, 0, 'Web Push sender must not be touched for Android');
});

test('unknown platform → permanent_failure, nothing sent (§15.4)', async () => {
  const send = sender();
  const r = await dispatchNotification({ platform: 'windows', token: 'x'.repeat(64) }, '{}', { vapid: VAPID, sendPushMessage: send });
  assert.equal(r.outcome, OUTCOME.PERMANENT);
  assert.equal(send.calls.length, 0);
});

test('web dispatch: 404/410 map to gone (§15.14)', async () => {
  for (const status of [404, 410]) {
    const send = sender();
    send.fails(status);
    const r = await dispatchNotification(webDevice(), '{}', { vapid: VAPID, sendPushMessage: send });
    assert.equal(r.outcome, OUTCOME.GONE, `status ${status}`);
    assert.equal(r.status, status);
  }
});

test('web dispatch: 429/5xx map to transient_failure', async () => {
  for (const status of [429, 500, 503]) {
    const send = sender();
    send.fails(status);
    const r = await dispatchNotification(webDevice(), '{}', { vapid: VAPID, sendPushMessage: send });
    assert.equal(r.outcome, OUTCOME.TRANSIENT, `status ${status}`);
  }
});

test('web dispatch: other client errors (400/401/413) map to permanent_failure', async () => {
  for (const status of [400, 401, 413]) {
    const send = sender();
    send.fails(status, false);
    const r = await dispatchNotification(webDevice(), '{}', { vapid: VAPID, sendPushMessage: send });
    assert.equal(r.outcome, OUTCOME.PERMANENT, `status ${status}`);
  }
});

test('provider throwing maps to transient_failure — the tick survives (§9)', async () => {
  const send = sender();
  send.throws('crypto exploded');
  const r = await dispatchNotification(webDevice(), '{}', { vapid: VAPID, sendPushMessage: send });
  assert.equal(r.outcome, OUTCOME.TRANSIENT);
  assert.match(r.error, /provider error/);
});

test('dispatch with no deps (no VAPID): web → not_configured, honest result', async () => {
  const r = await dispatchNotification(webDevice(), '{}', {});
  assert.equal(r.outcome, OUTCOME.NOT_CONFIGURED);
  assert.match(r.reason, /VAPID/i);
});

// ---------------------------------------------------------------------------
// Result shape stability — callers rely on the exact fields
// ---------------------------------------------------------------------------

test('makeResult: outcome always present, extras ride along', () => {
  const r = makeResult(OUTCOME.DELIVERED, { status: 201 });
  assert.deepEqual(r, { outcome: 'delivered', status: 201 });
});
