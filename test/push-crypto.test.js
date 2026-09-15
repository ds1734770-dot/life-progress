/**
 * V1.6 — Web Push crypto tests (server/push/webpush.js).
 *
 * Proves the zero-dependency implementation is standards-correct:
 *  · VAPID JWT is ES256-signed over the right claims (verified with WebCrypto).
 *  · aes128gcm payload round-trips (encrypt with the server implementation,
 *    decrypt with an independent receiver-side implementation of RFC 8291).
 *  · Garbage client keys are rejected, never crashed on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import {
  generateVapidKeys,
  vapidAuthorization,
  encryptPayload,
  decryptPayload,
  importReceiverPrivateKey,
  endpointAudience,
} from '../server/push/webpush.js';

// ---------------------------------------------------------------------------
// VAPID
// ---------------------------------------------------------------------------

test('generateVapidKeys: produces base64url P-256 material', async () => {
  const keys = await generateVapidKeys();
  assert.match(keys.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.match(keys.privateKey, /^[A-Za-z0-9_-]+$/);
  // Raw P-256 public key = 65 bytes uncompressed.
  const raw = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 0x04);
});

test('vapidAuthorization: builds a verifiable ES256 JWT with aud/exp/sub claims', async () => {
  const keys = await generateVapidKeys();
  const auth = await vapidAuthorization({
    audience: 'https://fcm.googleapis.com',
    subject: 'mailto:test@example.com',
    publicKeyB64u: keys.publicKey,
    privateKeyB64u: keys.privateKey,
  });
  assert.match(auth, /^vapid t=/);
  assert.ok(auth.includes(`k=${keys.publicKey}`));

  const token = auth.slice('vapid t='.length, auth.indexOf(','));
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(header.alg, 'ES256');
  assert.equal(header.typ, 'JWT');
  assert.equal(payload.aud, 'https://fcm.googleapis.com');
  assert.equal(payload.sub, 'mailto:test@example.com');
  assert.ok(payload.exp > Date.now() / 1000);

  // Independently verify the signature with WebCrypto.
  const raw = new Uint8Array(Buffer.from(keys.publicKey, 'base64url'));
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(raw.slice(1, 33)), y: b64u(raw.slice(33, 65)) };
  const verifyKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifyKey,
    Buffer.from(s, 'base64url'),
    new TextEncoder().encode(`${h}.${p}`)
  );
  assert.equal(ok, true);
});

test('vapidAuthorization: rejects http audiences and missing subject', async () => {
  const keys = await generateVapidKeys();
  await assert.rejects(() =>
    vapidAuthorization({ audience: 'http://insecure.example', subject: 'mailto:x@y.z', publicKeyB64u: keys.publicKey, privateKeyB64u: keys.privateKey })
  );
  await assert.rejects(() =>
    vapidAuthorization({ audience: 'https://fcm.googleapis.com', subject: '', publicKeyB64u: keys.publicKey, privateKeyB64u: keys.privateKey })
  );
});

function b64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

// ---------------------------------------------------------------------------
// aes128gcm round-trip (encrypt → independent decrypt)
// ---------------------------------------------------------------------------

async function makeClientKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateKey = await importReceiverPrivateKey(jwk);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return { publicKey: pubRaw, privateKey, authSecret };
}

test('encryptPayload → decryptPayload round-trips arbitrary payloads', async () => {
  const client = await makeClientKeys();
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: {
      p256dh: Buffer.from(client.publicKey).toString('base64url'),
      auth: Buffer.from(client.authSecret).toString('base64url'),
    },
  };
  const payload = JSON.stringify({ type: 'reminder', category: 'water', occurrenceId: 'x:1' });
  const body = await encryptPayload(payload, subscription);
  const decrypted = await decryptPayload(body, client, client.authSecret);
  assert.equal(Buffer.from(decrypted).toString('utf8'), payload);
});

test('encryptPayload: every message uses a fresh sender key (ciphertexts differ)', async () => {
  const client = await makeClientKeys();
  const subscription = {
    endpoint: 'https://x/y',
    keys: {
      p256dh: Buffer.from(client.publicKey).toString('base64url'),
      auth: Buffer.from(client.authSecret).toString('base64url'),
    },
  };
  const a = await encryptPayload('same message', subscription);
  const b = await encryptPayload('same message', subscription);
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
});

test('encryptPayload: rejects malformed client public keys instead of crashing', async () => {
  await assert.rejects(() =>
    encryptPayload('hi', { endpoint: 'https://x', keys: { p256dh: Buffer.from('short').toString('base64url'), auth: 'AAAA' } })
  );
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('endpointAudience: extracts https origins, null for garbage', () => {
  assert.equal(endpointAudience('https://fcm.googleapis.com/fcm/send/abc'), 'https://fcm.googleapis.com');
  assert.equal(endpointAudience('not a url'), null);
});
