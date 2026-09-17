/**
 * V2.0 Phase 2 — platform-aware registration validation tests
 * (server/push/http.js#validateRegistration).
 *
 * Hard rules under test (§4/§5/§15.6–9):
 *  · legacy bodies (no platform) keep validating EXACTLY as before → web
 *  · explicit web requires the unchanged endpoint + p256dh/auth contract
 *  · ios/android require a push token and do NOT require Web Push fields
 *  · malformed registrations are rejected; nothing is loosened for web
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration } from '../server/push/http.js';

const webBody = (over = {}) => ({
  deviceKey: 'webdevice00001',
  endpoint: 'https://fcm.googleapis.com/fcm/send/mock-endpoint',
  keys: { p256dh: 'BMockP256dhKey_MockP256dhKey_MockP256dhKey_Mock', auth: 'MockAuthSecret_MockAuthSecret' },
  timezone: 'Asia/Kolkata',
  times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  categories: { water: true, gym: true, goals: true, journal: true },
  quietStart: '22:30',
  quietEnd: '07:00',
  enabled: true,
  ...over,
});

const iosBody = (over = {}) => ({
  deviceKey: 'iosdevice00001',
  platform: 'ios',
  token: 'a'.repeat(64), // APNs-shaped 64-hex token
  timezone: 'Asia/Kolkata',
  times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  categories: { water: true, gym: true, goals: true, journal: true },
  quietStart: '22:30',
  quietEnd: '07:00',
  enabled: true,
  ...over,
});

// ---------------------------------------------------------------------------
// Legacy / web compatibility — the pre-existing contract is untouched (§7)
// ---------------------------------------------------------------------------

test('legacy body (no platform) validates exactly as before → platform web', () => {
  const v = validateRegistration(webBody());
  assert.equal(v.error, undefined);
  assert.equal(v.value.platform, 'web');
  assert.equal(v.value.endpoint, 'https://fcm.googleapis.com/fcm/send/mock-endpoint');
  assert.deepEqual(v.value.keys, {
    p256dh: 'BMockP256dhKey_MockP256dhKey_MockP256dhKey_Mock',
    auth: 'MockAuthSecret_MockAuthSecret',
  });
  // Node's Intl may canonicalize to the legacy alias (see push-scheduling.test.js).
  assert.ok(v.value.timezone === 'Asia/Kolkata' || v.value.timezone === 'Asia/Calcutta', v.value.timezone);
  assert.equal(v.value.enabled, true);
  assert.equal('token' in v.value, false, 'web records carry no token');
});

test('explicit platform:"web" validates with the same unchanged rules', () => {
  const v = validateRegistration(webBody({ platform: 'web' }));
  assert.equal(v.error, undefined);
  assert.equal(v.value.platform, 'web');
});

test('legacy invalid endpoint still rejected (nothing loosened for web)', () => {
  for (const endpoint of ['http://insecure.example.com/x', 'not a url', '']) {
    const v = validateRegistration(webBody({ endpoint }));
    assert.equal(v.error, 'invalid endpoint', endpoint);
  }
});

test('legacy oversized endpoint/keys still rejected (unchanged bounds)', () => {
  assert.equal(validateRegistration(webBody({ endpoint: `https://x.test/${'a'.repeat(2100)}` })).error, 'invalid endpoint');
  assert.equal(validateRegistration(webBody({ keys: { p256dh: 'x'.repeat(513), auth: 'ok' } })).error, 'invalid keys');
  assert.equal(validateRegistration(webBody({ keys: { p256dh: 'ok', auth: 'x'.repeat(257) } })).error, 'invalid keys');
});

test('legacy missing keys still rejected', () => {
  assert.equal(validateRegistration(webBody({ keys: undefined })).error, 'invalid keys');
  assert.equal(validateRegistration(webBody({ keys: { p256dh: 'only-p256dh' } })).error, 'invalid keys');
});

test('invalid deviceKey / timezone / times rules unchanged for all platforms', () => {
  assert.equal(validateRegistration(webBody({ deviceKey: 'short' })).error, 'invalid deviceKey');
  assert.equal(validateRegistration(iosBody({ deviceKey: 'bad key!' })).error, 'invalid deviceKey');
  assert.equal(validateRegistration(webBody({ timezone: 'Not/AZone' })).error, 'invalid timezone');
  assert.equal(validateRegistration(iosBody({ timezone: 42 })).error, 'invalid timezone');
  assert.equal(validateRegistration(webBody({ times: {} })).error, 'missing reminder times');
  assert.equal(validateRegistration(iosBody({ times: { water: 'not-a-time' } })).error, 'missing reminder times');
});

// ---------------------------------------------------------------------------
// iOS / Android — token replaces the Web Push credential (§5)
// ---------------------------------------------------------------------------

test('iOS registration accepts token without any Web Push fields (§15.7)', () => {
  const v = validateRegistration(iosBody());
  assert.equal(v.error, undefined);
  assert.equal(v.value.platform, 'ios');
  assert.equal(v.value.token, 'a'.repeat(64));
  assert.equal('endpoint' in v.value, false, 'no endpoint for native records');
  assert.equal('keys' in v.value, false, 'no p256dh/auth for native records');
});

test('Android registration accepts token without any Web Push fields (§15.8)', () => {
  const v = validateRegistration(iosBody({ deviceKey: 'androiddev001', platform: 'android', token: 'fcm:token:example:with:colons:0123456789' }));
  assert.equal(v.error, undefined);
  assert.equal(v.value.platform, 'android');
  assert.equal(v.value.token, 'fcm:token:example:with:colons:0123456789');
  assert.equal('endpoint' in v.value, false);
  assert.equal('keys' in v.value, false);
});

test('native without token rejected', () => {
  assert.equal(validateRegistration(iosBody({ token: undefined })).error, 'invalid token');
  assert.equal(validateRegistration(iosBody({ token: '' })).error, 'invalid token');
  assert.equal(validateRegistration(iosBody({ token: null })).error, 'invalid token');
});

test('native token bounds enforced (16–4096, no whitespace)', () => {
  assert.equal(validateRegistration(iosBody({ token: 'short-token' })).error, 'invalid token'); // < 16 chars
  assert.equal(validateRegistration(iosBody({ token: 'x'.repeat(4097) })).error, 'invalid token'); // > 4096
  assert.equal(validateRegistration(iosBody({ token: 'has spaces in it 1234' })).error, 'invalid token');
  // Lower bounds of reality are fine:
  assert.equal(validateRegistration(iosBody({ token: 'x'.repeat(16) })).error, undefined);
  assert.equal(validateRegistration(iosBody({ token: 'x'.repeat(4096) })).error, undefined);
});

test('native registration ignores stray Web Push fields instead of rejecting', () => {
  // A client that over-sends must not fail: unknown/irrelevant fields are
  // simply dropped (existing convention), and the native record is token-only.
  const v = validateRegistration(iosBody({ endpoint: 'https://irrelevant.example.com', keys: { p256dh: 'x', auth: 'y' } }));
  assert.equal(v.error, undefined);
  assert.equal('endpoint' in v.value, false);
  assert.equal('keys' in v.value, false);
});

test('malformed native registrations rejected (§15.9)', () => {
  assert.ok(validateRegistration({ platform: 'ios', deviceKey: 'iosdevice00001' }).error, 'missing prefs rejected');
  assert.equal(validateRegistration(iosBody({ platform: 'blackberry', token: 'x'.repeat(64) })).error, 'invalid platform');
  assert.equal(validateRegistration(iosBody({ platform: 'IOS' })).error, 'invalid platform');
});

// ---------------------------------------------------------------------------
// Shared preference fields still normalize identically
// ---------------------------------------------------------------------------

test('defaults and normalization unchanged across platforms', () => {
  const w = validateRegistration(webBody({ quietStart: 'nope', quietEnd: null, enabled: false }));
  assert.equal(w.value.quietStart, '22:30');
  assert.equal(w.value.quietEnd, '07:00');
  assert.equal(w.value.enabled, false);
  const i = validateRegistration(iosBody({ categories: { water: false, gym: false, goals: false, journal: false } }));
  assert.deepEqual(i.value.categories, { water: false, gym: false, goals: false, journal: false });
});
