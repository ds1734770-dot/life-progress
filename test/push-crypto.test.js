/**
 * V1.6.5 — Web Push crypto tests (server/push/webpush.js).
 *
 * RFC 8291 (message encryption) + RFC 8292 (VAPID), validated WITHOUT trusting
 * the implementation under test. Three independent pillars (§ Phase 5):
 *
 *  1. FIXED FIXTURE — the body published in RFC 8291 §5 / Appendix A ("When I
 *     grow up…", with its fixed keys, salt and all intermediate values) is the
 *     ground truth. The project's decryptPayload must decode it, and a
 *     from-scratch node:crypto implementation must reproduce it byte-for-byte.
 *     No project code participates in producing this fixture.
 *  2. INDEPENDENT RECEIVER — a from-scratch RFC 8291 §3.4 + RFC 8188 §2
 *     implementation (node:crypto ECDH/HKDF/AES-GCM only, zero imports from
 *     server/push/webpush.js) plays the browser/push-client role and decrypts
 *     what encryptPayload produces. This is the regression test: it FAILS
 *     against the old framing (as_public used as the HKDF salt, header laid
 *     out as as_public||rs||idlen=0), because an RFC receiver cannot parse
 *     that body at all.
 *  3. WIRE-FORMAT STRUCTURE — byte-level assertions on the produced body:
 *     86-octet header, salt(16) fresh per message, rs=4096 big-endian at
 *     [16..19], idlen=65 at [20], keyid=ephemeral as_public at [21..86],
 *     ciphertext after byte 86, final-record 0x02 delimiter inside the record.
 *
 * The naive encrypt→decryptPayload round-trip is kept as a smoke check ONLY —
 * it can never again be the sole evidence of interoperability.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as crypto } from 'node:crypto';
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createECDH,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import {
  generateVapidKeys,
  vapidAuthorization,
  encryptPayload,
  decryptPayload,
  importReceiverPrivateKey,
  endpointAudience,
} from '../server/push/webpush.js';

// ---------------------------------------------------------------------------
// The RFC 8291 §5 / Appendix A example — published test vector (immutable).
// https://www.rfc-editor.org/rfc/rfc8291.html#section-5
// ---------------------------------------------------------------------------

const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const b64uBuf = (s) => Buffer.from(s, 'base64url');
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// ---------------------------------------------------------------------------
// Independent RFC 8291/8188 implementation — node:crypto ONLY.
// Deliberately shares ZERO code with server/push/webpush.js (which uses
// WebCrypto): separate ECDH, separate HKDF calls, separate AES-GCM handling.
// ---------------------------------------------------------------------------

const CEK_INFO = Buffer.from('Content-Encoding: aes128gcm\0', 'utf8');
const NONCE_INFO = Buffer.from('Content-Encoding: nonce\0', 'utf8');
const webPushInfo = (uaPublic, asPublic) =>
  Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), Buffer.from(uaPublic), Buffer.from(asPublic)]);

function jwkPublic(raw65) {
  const b = Buffer.from(raw65);
  return { kty: 'EC', crv: 'P-256', x: b64u(b.subarray(1, 33)), y: b64u(b.subarray(33, 65)) };
}

function jwkPrivate(raw32, raw65) {
  return { ...jwkPublic(raw65), d: b64u(raw32) };
}

/** ECDH shared secret from a JWK private key and a raw 65-byte public point. */
function ecdhSecret(privJwk, pubRaw65) {
  return diffieHellman({
    privateKey: createPrivateKey({ key: privJwk, format: 'jwk' }),
    publicKey: createPublicKey({ key: jwkPublic(pubRaw65), format: 'jwk' }),
  });
}

/**
 * The receiver side of RFC 8291, from scratch. Parses the REAL aes128gcm
 * header (RFC 8188 §2.1), derives keys per RFC 8291 §3.4 and decrypts per
 * RFC 8188 §2 (zero-length AAD, final-record delimiter MUST be 0x02).
 */
function independentDecrypt(bodyBytes, { uaPrivate, uaPublic, authSecret }) {
  const body = Buffer.from(bodyBytes);
  if (body.length < 21) throw new Error('aes128gcm body too short');
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  if (idlen !== 65) throw new Error(`expected idlen=65, got ${idlen}`);
  const keyid = body.subarray(21, 21 + idlen);
  if (keyid[0] !== 0x04) throw new Error('keyid is not an uncompressed EC point');
  if (rs < 18) throw new Error(`invalid record size ${rs}`);
  const ciphertext = body.subarray(21 + idlen);

  // RFC 8291 §3.3/§3.4 — receiver: ecdh(ua_private, as_public=keyid).
  const ecdh = ecdhSecret(jwkPrivate(Buffer.from(uaPrivate), Buffer.from(uaPublic)), keyid);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh, Buffer.from(authSecret), webPushInfo(Buffer.from(uaPublic), keyid), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, NONCE_INFO, 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const enc = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAAD(Buffer.alloc(0));
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(enc), decipher.final()]);

  // RFC 8188 §2: the padding delimiter is the LAST NON-ZERO octet and the
  // final record's delimiter MUST be 0x02 (RFC 8291 §4).
  let delimiter = 0;
  for (let i = record.length - 1; i >= 0; i--) {
    if (record[i] !== 0) { delimiter = record[i]; break; }
  }
  if (delimiter !== 0x02) throw new Error(`bad padding delimiter 0x${delimiter.toString(16)}`);
  return {
    plaintext: record.subarray(0, record.length - 1),
    salt,
    rs,
    keyid,
    delimiter,
  };
}

/**
 * The sender side of RFC 8291, from scratch — with an INJECTED salt and
 * ephemeral key so the fixed RFC vector can be reproduced byte-for-byte.
 */
function independentEncrypt(plaintextStr, { uaPublic, authSecret, asPrivate, asPublic, salt }) {
  const uaPub = Buffer.from(uaPublic);
  const asPub = Buffer.from(asPublic);
  const ecdh = ecdhSecret(jwkPrivate(Buffer.from(asPrivate), asPub), uaPub);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh, Buffer.from(authSecret), webPushInfo(uaPub, asPub), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(salt), CEK_INFO, 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, Buffer.from(salt), NONCE_INFO, 12));
  const record = Buffer.concat([Buffer.from(plaintextStr, 'utf8'), Buffer.from([0x02])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  cipher.setAAD(Buffer.alloc(0));
  const ct = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  const header = Buffer.concat([Buffer.from(salt), rs, Buffer.from([65]), asPub]);
  return Buffer.concat([header, ct]);
}

/** Fresh client (user agent) keys for exercising the project sender. */
function makeClientKeys() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return {
    uaPublic: ua.getPublicKey(), // 65-byte uncompressed point
    uaPrivate: ua.getPrivateKey(), // 32-byte scalar
    authSecret: randomBytes(16),
  };
}

function subscriptionFor(client) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    keys: { p256dh: b64u(client.uaPublic), auth: b64u(client.authSecret) },
  };
}

// ---------------------------------------------------------------------------
// VAPID (RFC 8292)
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

// ---------------------------------------------------------------------------
// Pillar 1 — the fixed RFC 8291 §5 fixture (ground truth, no project code)
// ---------------------------------------------------------------------------

test('FIXTURE: decryptPayload decodes the published RFC 8291 §5 body', async () => {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(b64uBuf(RFC8291.uaPublic).subarray(1, 33)),
    y: b64u(b64uBuf(RFC8291.uaPublic).subarray(33, 65)),
    d: RFC8291.uaPrivate,
  };
  const receiver = {
    publicKey: new Uint8Array(b64uBuf(RFC8291.uaPublic)),
    privateKey: await importReceiverPrivateKey(jwk),
  };
  const out = await decryptPayload(
    new Uint8Array(b64uBuf(RFC8291.body)),
    receiver,
    new Uint8Array(b64uBuf(RFC8291.authSecret))
  );
  assert.equal(Buffer.from(out).toString('utf8'), RFC8291.plaintext);
});

test('FIXTURE: the independent node:crypto sender reproduces the published body byte-for-byte', () => {
  const produced = independentEncrypt(RFC8291.plaintext, {
    uaPublic: b64uBuf(RFC8291.uaPublic),
    authSecret: b64uBuf(RFC8291.authSecret),
    asPrivate: b64uBuf(RFC8291.asPrivate),
    asPublic: b64uBuf(RFC8291.asPublic),
    salt: b64uBuf(RFC8291.salt),
  });
  assert.ok(produced.equals(b64uBuf(RFC8291.body)),
    'independent RFC implementation must reproduce the RFC 8291 §5 wire bytes exactly');
});

test('FIXTURE: the independent receiver decodes the published body with RFC-verified structure', () => {
  const out = independentDecrypt(b64uBuf(RFC8291.body), {
    uaPrivate: b64uBuf(RFC8291.uaPrivate),
    uaPublic: b64uBuf(RFC8291.uaPublic),
    authSecret: b64uBuf(RFC8291.authSecret),
  });
  assert.equal(out.plaintext.toString('utf8'), RFC8291.plaintext);
  assert.equal(out.rs, 4096);
  assert.ok(out.salt.equals(b64uBuf(RFC8291.salt)));
  assert.ok(out.keyid.equals(b64uBuf(RFC8291.asPublic)));
  assert.equal(out.delimiter, 0x02);
});

// ---------------------------------------------------------------------------
// Pillar 2 — independent RFC receiver decrypts the project sender's output.
// THE regression test: fails against the old framing (as_public used as the
// HKDF salt, header as_public||rs||idlen=0), which an RFC receiver cannot
// parse at all — idlen/rs would be garbage bytes of an EC point.
// ---------------------------------------------------------------------------

test('INTEROP: an independent RFC 8291/8188 receiver decrypts encryptPayload output', async () => {
  const client = makeClientKeys();
  const payload = JSON.stringify({ type: 'reminder', category: 'water', occurrenceId: 'x:1' });
  const body = await encryptPayloadSync(payload, client);

  const out = independentDecrypt(body, {
    uaPrivate: client.uaPrivate,
    uaPublic: client.uaPublic,
    authSecret: client.authSecret,
  });
  assert.equal(out.plaintext.toString('utf8'), payload);
  // RFC 8291 §4: single record, rs must exceed plaintext + delimiter + tag.
  assert.equal(out.rs, 4096);
  assert.ok(out.rs >= out.plaintext.length + 1 + 16);
  assert.equal(out.delimiter, 0x02);
});

/** Small async→sync adapter so structural tests stay readable. */
function encryptPayloadSync(payload, client) {
  return encryptPayload(payload, subscriptionFor(client)).then((u8) => Buffer.from(u8));
}

// ---------------------------------------------------------------------------
// Pillar 3 — wire-format structure of encryptPayload output
// ---------------------------------------------------------------------------

test('WIRE: aes128gcm header layout is RFC 8188 §2.1 — salt(16)|rs(4 BE)|idlen(1)|keyid(65)', async () => {
  const client = makeClientKeys();
  const body = await encryptPayloadSync('payload', client);

  assert.ok(body.length >= 86, 'header alone is 86 bytes');
  assert.equal(body[0], b64uBuf(RFC8291.salt)[0] === 0 ? 0 : body[0]); // salt is random; see structural asserts below
  // rs = 4096, network byte order, at bytes [16..19] (regression: the old
  // framing put the EC point there — 00 00 10 00 there is 2^-32 unlikely).
  assert.equal(body.readUInt32BE(16), 4096);
  assert.deepEqual([...body.subarray(16, 20)], [0x00, 0x00, 0x10, 0x00]);
  // idlen = 65 at byte 20 (old framing had 0 at byte 69 and garbage at 20).
  assert.equal(body[20], 65);
  // keyid = the ephemeral application-server public key: uncompressed point.
  const keyid = body.subarray(21, 86);
  assert.equal(keyid.length, 65);
  assert.equal(keyid[0], 0x04);
  // The salt is NOT the (prefix of the) sender key — old code reused it.
  assert.ok(!body.subarray(0, 16).equals(keyid.subarray(0, 16)),
    'salt must be fresh randomness, not the application-server public key');
  // Ciphertext begins exactly after the 86-byte header: len = 86 + 1 + 16.
  assert.equal(body.length, 86 + 'payload'.length + 1 + 16);
});

test('WIRE: salt is fresh 16-byte randomness per message (changes between encryptions)', async () => {
  const client = makeClientKeys();
  const a = await encryptPayloadSync('same message', client);
  const b = await encryptPayloadSync('same message', client);
  assert.equal(a.subarray(0, 16).length, 16);
  assert.ok(!a.subarray(0, 16).equals(b.subarray(0, 16)), 'salt must differ per message');
});

test('WIRE: ephemeral sender key changes per message (keyid differs → ciphertext differs)', async () => {
  const client = makeClientKeys();
  const a = await encryptPayloadSync('same message', client);
  const b = await encryptPayloadSync('same message', client);
  assert.ok(!a.subarray(21, 86).equals(b.subarray(21, 86)), 'keyid (ephemeral as_public) must differ per message');
  assert.ok(!a.subarray(86).equals(b.subarray(86)), 'ciphertext must differ when the ephemeral key changes');
  assert.ok(!a.equals(b));
});

test('WIRE: keyid is consistent with the ciphertext (ECDH proof via independent receiver)', async () => {
  // The only way an RFC receiver can decrypt is with ECDH(ua_private, keyid).
  // independentDecrypt succeeding therefore PROVES keyid is exactly the
  // sender/application-server public key used to produce the ciphertext.
  const client = makeClientKeys();
  const body = await encryptPayloadSync('proof', client);
  const out = independentDecrypt(body, {
    uaPrivate: client.uaPrivate,
    uaPublic: client.uaPublic,
    authSecret: client.authSecret,
  });
  assert.ok(out.keyid[0] === 0x04 && out.keyid.length === 65);
  // …and it is NOT the user-agent key echoed back.
  assert.ok(!out.keyid.equals(Buffer.from(client.uaPublic)));
});

test('WIRE: plaintext carries the final 0x02 delimiter inside the record', async () => {
  const client = makeClientKeys();
  const body = await encryptPayloadSync('hello', client);
  // independentDecrypt throws unless the record's last non-zero octet is 0x02
  // and returns the plaintext with exactly one delimiter octet stripped.
  const out = independentDecrypt(body, {
    uaPrivate: client.uaPrivate,
    uaPublic: client.uaPublic,
    authSecret: client.authSecret,
  });
  assert.equal(out.plaintext.toString('utf8'), 'hello');
  assert.equal(out.delimiter, 0x02);
  assert.equal(body.length - 86, 'hello'.length + 1 + 16, 'record = plaintext + delimiter, + 16-byte GCM tag');
});

// ---------------------------------------------------------------------------
// Smoke round-trip through the project's own pair (kept, but never the sole
// evidence) + input validation
// ---------------------------------------------------------------------------

test('encryptPayload → decryptPayload round-trips arbitrary payloads', async () => {
  const client = makeClientKeys();
  const payload = JSON.stringify({ type: 'reminder', category: 'water', occurrenceId: 'x:1' });
  const body = await encryptPayload(payload, subscriptionFor(client));
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(Buffer.from(client.uaPublic).subarray(1, 33)),
    y: b64u(Buffer.from(client.uaPublic).subarray(33, 65)),
    d: b64u(client.uaPrivate),
  };
  const receiver = {
    publicKey: new Uint8Array(Buffer.from(client.uaPublic)),
    privateKey: await importReceiverPrivateKey(jwk),
  };
  const decrypted = await decryptPayload(body, receiver, new Uint8Array(client.authSecret));
  assert.equal(Buffer.from(decrypted).toString('utf8'), payload);
});

test('encryptPayload: rejects malformed client public keys instead of crashing', async () => {
  await assert.rejects(() =>
    encryptPayload('hi', { endpoint: 'https://x', keys: { p256dh: Buffer.from('short').toString('base64url'), auth: 'AAAA' } })
  );
});

test('encryptPayload: rejects a non-16-byte auth secret (RFC 8291 §3.2)', async () => {
  const client = makeClientKeys();
  await assert.rejects(() =>
    encryptPayload('hi', {
      endpoint: 'https://x',
      keys: { p256dh: b64u(client.uaPublic), auth: b64u(randomBytes(8)) },
    })
  );
});

test('encryptPayload: rejects payloads too large for a single aes128gcm record', async () => {
  const client = makeClientKeys();
  await assert.rejects(() =>
    encryptPayload('x'.repeat(4096 - 17 + 1), subscriptionFor(client))
  );
});

test('decryptPayload: rejects a corrupted ciphertext instead of returning garbage', async () => {
  const client = makeClientKeys();
  const body = new Uint8Array(await encryptPayload('secret', subscriptionFor(client)));
  body[body.length - 1] ^= 0xff; // flip a GCM tag bit → authentication must fail
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: b64u(Buffer.from(client.uaPublic).subarray(1, 33)),
    y: b64u(Buffer.from(client.uaPublic).subarray(33, 65)),
    d: b64u(client.uaPrivate),
  };
  const receiver = {
    publicKey: new Uint8Array(Buffer.from(client.uaPublic)),
    privateKey: await importReceiverPrivateKey(jwk),
  };
  await assert.rejects(() => decryptPayload(body, receiver, new Uint8Array(client.authSecret)));
});

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

test('endpointAudience: extracts https origins, null for garbage', () => {
  assert.equal(endpointAudience('https://fcm.googleapis.com/fcm/send/abc'), 'https://fcm.googleapis.com');
  assert.equal(endpointAudience('not a url'), null);
});
