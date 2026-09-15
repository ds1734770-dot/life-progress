/**
 * Web Push sender — RFC 8291 (aes128gcm message encryption) + RFC 8292
 * (VAPID) implemented directly on standard WebCrypto, keeping the project's
 * zero-dependency convention.
 *
 * ISOMORPHIC (V1.6.4): runs unmodified on Node (18+, where globalThis.crypto
 * and atob/btoa are built in) AND on Cloudflare Workers — no node: imports,
 * no Buffer. The Node backend and the Cloudflare Worker therefore share ONE
 * push-crypto implementation, so a fix or audit applies to both.
 *
 * This module performs ONLY byte-level push cryptography. It trusts nothing:
 * the subscription record is validated by api.js before it reaches here, and
 * the notification payload is built by scheduler.js from server-owned data.
 */
const crypto = globalThis.crypto;

const encoder = new TextEncoder();
const P256_PUB_LEN = 65; // 0x04 || X(32) || Y(32)

// ---------------------------------------------------------------------------
// Base64url helpers — plain WebCrypto-era primitives (no Buffer)
// ---------------------------------------------------------------------------

function toByteView(buf) {
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf, (buf.byteOffset || 0), buf.byteLength);
}

export function b64uEncode(buf) {
  const bytes = toByteView(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(s) {
  let str = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// VAPID keys — generated once, stored by the caller (see vapid.js)
// ---------------------------------------------------------------------------

/** Generate a P-256 keypair for VAPID signing. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey: b64uEncode(pub),
    privateKey: b64uEncode(priv),
  };
}

async function importVapidPrivateKey(privateKeyB64u) {
  return crypto.subtle.importKey(
    'pkcs8',
    b64uDecode(privateKeyB64u),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

/**
 * RFC 8292 Authorization header: `vapid t=<JWT>, k=<uncompressed public key>`.
 * The JWT is ES256-signed with aud = push-service origin, exp = now + ttl,
 * sub = the configured mailto/https contact.
 */
export async function vapidAuthorization({ audience, subject, publicKeyB64u, privateKeyB64u, ttlMs = 4 * 3600 * 1000 }) {
  if (!audience || !/^https:\/\//.test(audience)) throw new Error('vapid: audience must be an https origin');
  if (!subject) throw new Error('vapid: subject (VAPID_SUBJECT) is not configured');
  const header = b64uJson({ typ: 'JWT', alg: 'ES256' });
  const payload = b64uJson({ aud: audience, exp: Math.floor((Date.now() + ttlMs) / 1000), sub: subject });
  const data = encoder.encode(`${header}.${payload}`);
  const key = await importVapidPrivateKey(privateKeyB64u);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data)
  );
  const token = `${header}.${payload}.${b64uEncode(sig)}`;
  return `vapid t=${token}, k=${publicKeyB64u}`;
}

function b64uJson(obj) {
  return b64uEncode(encoder.encode(JSON.stringify(obj)));
}

// ---------------------------------------------------------------------------
// RFC 8291 aes128gcm message encryption
// ---------------------------------------------------------------------------

async function importEcdhPublic(raw) {
  if (raw.length !== P256_PUB_LEN || raw[0] !== 0x04) {
    throw new Error('invalid p256dh key: expected 65-byte uncompressed EC point');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function hkdf(ikm, salt, info, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, lengthBytes * 8)
  );
}

/**
 * Encrypt `payload` (string or bytes) for one push subscription.
 * Returns the aes128gcm binary body (Uint8Array) to POST to the endpoint.
 */
export async function encryptPayload(payload, subscription) {
  const uaPublic = b64uDecode(subscription.keys.p256dh);
  const authSecret = b64uDecode(subscription.keys.auth);

  // Ephemeral sender keypair (fresh per message, as required).
  const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey));
  const receiverPublic = await importEcdhPublic(uaPublic);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: receiverPublic }, sender.privateKey, 256)
  );

  // ikm = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0" || uaPub || asPub, 32)
  const info = new Uint8Array(14 + uaPublic.length + senderPublic.length);
  info.set(encoder.encode('WebPush: info\0'), 0);
  info.set(uaPublic, 14);
  info.set(senderPublic, 14 + uaPublic.length);
  const ikm = await hkdf(ecdhSecret, authSecret, info, 32);

  // Per aes128gcm: salt = sender public key.
  const cek = await hkdf(ikm, senderPublic, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, senderPublic, encoder.encode('Content-Encoding: nonce\0'), 12);

  // Record = plaintext || 0x02 delimiter (no further padding; single record).
  const plaintext = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const record = new Uint8Array(plaintext.length + 1);
  record.set(plaintext, 0);
  record[plaintext.length] = 0x02;

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(0), tagLength: 128 }, key, record)
  );

  // Header: sender public key (65) || rs (4 BE, 4096) || idlen (1, 0).
  const rs = 4096;
  if (ciphertext.length > rs - 17) throw new Error('payload too large for a single aes128gcm record');
  const header = new Uint8Array(P256_PUB_LEN + 4 + 1);
  header.set(senderPublic, 0);
  const dv = new DataView(header.buffer);
  dv.setUint32(P256_PUB_LEN, rs);
  dv.setUint8(P256_PUB_LEN + 4, 0); // no key id

  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);
  return body;
}

/**
 * Decrypt side — implemented ONLY for tests, mirroring RFC 8291 §5.1 exactly,
 * so the test suite can prove the encryption is interoperable with what a
 * browser push service expects (encrypt → decrypt round-trip).
 *
 * @param {Uint8Array} body               aes128gcm body produced by encryptPayload
 * @param {{publicKey: Uint8Array, privateKey: CryptoKey}} receiver  the client-side keypair
 *        (publicKey = raw uncompressed point, privateKey = an imported ECDH CryptoKey)
 * @param {Uint8Array} authSecret         the client's auth secret
 */
export async function decryptPayload(body, receiver, authSecret) {
  const senderPublic = body.slice(0, P256_PUB_LEN);
  const idlen = body[69];
  const ciphertext = body.slice(70 + idlen);

  const senderPub = await importEcdhPublic(senderPublic);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: senderPub }, receiver.privateKey, 256)
  );
  // RFC 8291 §5.1: info = "WebPush: info" || 0x00 || receiver_pub || sender_pub
  const info = new Uint8Array(14 + receiver.publicKey.length + senderPublic.length);
  info.set(encoder.encode('WebPush: info\0'), 0);
  info.set(receiver.publicKey, 14);
  info.set(senderPublic, 14 + receiver.publicKey.length);
  const ikm = await hkdf(ecdhSecret, authSecret, info, 32);
  const cek = await hkdf(ikm, senderPublic, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, senderPublic, encoder.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(0), tagLength: 128 }, key, ciphertext)
  );
  if (record[record.length - 1] !== 0x02) throw new Error('bad padding delimiter');
  return record.slice(0, -1);
}

/** Import a raw client private scalar is not possible; tests build the
 * receiver CryptoKey from a JWK via this helper. */
export async function importReceiverPrivateKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** Extract the https origin of a push endpoint (the VAPID audience). */
export function endpointAudience(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Send one encrypted push message. Returns { ok, status, retryAfter? }.
 * 404/410 mean the subscription is gone and must be cleaned up by the caller.
 */
export async function sendPushMessage({ endpoint, keys }, payload, vapid) {
  const audience = endpointAudience(endpoint);
  const authorization = await vapidAuthorization({
    audience,
    subject: vapid.subject,
    publicKeyB64u: vapid.publicKey,
    privateKeyB64u: vapid.privateKey,
  });
  const body = await encryptPayload(payload, { endpoint, keys });
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        // NOTE: no Content-Length — fetch sets it from the body, and the
        // Cloudflare Workers runtime forbids setting it manually.
        TTL: String(vapid.ttlSeconds ?? 4 * 3600),
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        // Prefer responses without payload; we never need one.
        'Prefer': 'respond-async',
      },
      body,
    });
  } catch (err) {
    return { ok: false, transient: true, error: `network: ${err?.message || err}` };
  }
  const status = res.status;
  if (status >= 200 && status < 300) return { ok: true, status };
  const retryAfter = Number(res.headers.get('retry-after')) || null;
  // Drain the body so the socket is released.
  try { await res.text(); } catch { /* ignore */ }
  const transient = status === 429 || status >= 500;
  return { ok: false, status, transient, retryAfter };
}
