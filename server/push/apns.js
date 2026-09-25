/**
 * APNs provider — native iOS delivery (V2.0 Phase 3).
 *
 * Implements the Phase 2 provider contract from server/push/dispatch.js:
 *   send(device, payload) → { outcome: delivered | gone | transient_failure
 *                                          | permanent_failure | not_configured }
 *
 * AUTH (§3): APNs token-based authentication ONLY — an ES256 JWT signed with
 * the Apple .p8 auth key (kid = key ID, iss = team ID, iat = now). No
 * certificate-based auth. The key NEVER appears in git, frontend code, logs
 * or test fixtures; it arrives via runtime configuration only.
 *
 * RUNTIME-NEUTRAL BY TRANSPORT INJECTION (§5): APNs requires HTTP/2. Cloudflare
 * Workers' global fetch negotiates HTTP/2 to api.push.apple.com, but Node's
 * global fetch speaks HTTP/1.1 by default and APNs rejects it. The provider
 * therefore takes an `transport` function in its config:
 *   · Cloudflare DO → the global fetch (HTTP/2-capable) — zero extra code.
 *   · Node → a small `node:http2` adapter (server/push/nodeHttp2.js) provided
 *     by the Node entrypoints.
 * All APNs BUSINESS logic (JWT, headers, payload shaping, response mapping)
 * lives HERE, once — never duplicated between runtimes (§5/§20).
 *
 * WebCrypto note: Apple .p8 keys are PKCS#8 PEM. WebCrypto's importKey('pkcs8')
 * requires the DER bytes, so the PEM armor is stripped before import — pure
 * base64/DER parsing, no OpenSSL, works on Node and Workers alike.
 */
import { b64uEncode, b64uDecode } from './webpush.js';
import { OUTCOME, makeResult } from './outcomes.js';
import { genericForCategory } from '../../js/swPush.js';

const crypto = globalThis.crypto;
const encoder = new TextEncoder();

const PRODUCTION_HOST = 'api.push.apple.com';
const SANDBOX_HOST = 'api.sandbox.push.apple.com';
/** JWT re-sign window: Apple recommends reusing the token up to 1 hour. */
const JWT_TTL_MS = 50 * 60 * 1000;

// ---------------------------------------------------------------------------
// Configuration — environment-provided, never committed (§3/§17)
// ---------------------------------------------------------------------------

/** Names resolved lazily from a config object (env on both runtimes). */
export const APNS_ENV_KEYS = Object.freeze({
  keyId: 'APNS_KEY_ID',
  teamId: 'APNS_TEAM_ID',
  bundleId: 'APNS_BUNDLE_ID',
  privateKey: 'APNS_PRIVATE_KEY',
  env: 'APNS_ENV', // 'production' (default) | 'sandbox'
});

/**
 * Read + validate APNs configuration. Returns null when any required value is
 * missing — the honest `not_configured` signal; never a crash (§14.B).
 * Values are trimmed, so whitespace-only entries count as missing.
 * `source` defaults to the runtime environment (Node process.env / Workers env).
 */
export function apnsConfig(source = undefined, overrides = {}) {
  const env = source ?? (typeof process !== 'undefined' ? process.env : {});
  const pick = (v) => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  };
  const keyId = pick(overrides.keyId ?? env[APNS_ENV_KEYS.keyId]);
  const teamId = pick(overrides.teamId ?? env[APNS_ENV_KEYS.teamId]);
  const bundleId = pick(overrides.bundleId ?? env[APNS_ENV_KEYS.bundleId]);
  const privateKey = pick(overrides.privateKey ?? env[APNS_ENV_KEYS.privateKey]);
  if (!keyId || !teamId || !bundleId || !privateKey) return null;
  const environment = String(overrides.env ?? env[APNS_ENV_KEYS.env] ?? 'production').toLowerCase();
  if (environment !== 'production' && environment !== 'sandbox') return null;
  return {
    keyId,
    teamId,
    bundleId,
    privateKey,
    environment,
    host: environment === 'sandbox' ? SANDBOX_HOST : PRODUCTION_HOST,
  };
}

/** True when APNs is fully configured (used for honest status reporting). */
export function isApnsConfigured(source = undefined) {
  return apnsConfig(source) !== null;
}

// ---------------------------------------------------------------------------
// .p8 handling — PEM armor stripped, DER imported as PKCS#8 (ES256)
// ---------------------------------------------------------------------------

/** Extract the DER body from a PKCS#8 PEM (.p8). Throws on malformed input. */
export function pemToDer(p8) {
  const body = String(p8)
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('apns: private key is empty');
  const der = b64uDecode(body.replace(/-/g, '+').replace(/_/g, '/'));
  if (der.length < 32) throw new Error('apns: private key too short to be a PKCS#8 EC key');
  return der;
}

/** Import the .p8 as an ES256 signing CryptoKey. Cached per provider instance. */
async function importSigningKey(privateKeyPem) {
  return crypto.subtle.importKey('pkcs8', pemToDer(privateKeyPem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

// ---------------------------------------------------------------------------
// The Apple provider token (ES256 JWT) (§3)
// ---------------------------------------------------------------------------

/** Build the JWT header/payload JSON (exported for tests — no secrets in it). */
export function apnsJwtClaims({ keyId, teamId }, iatSeconds) {
  return {
    header: { alg: 'ES256', kid: keyId },
    payload: { iss: teamId, iat: iatSeconds },
  };
}

/**
 * Sign the Apple provider token. Key material never leaves this function;
 * only the compact JWT is returned. Never log it (§17).
 */
export async function apnsProviderToken(config, nowMs = Date.now()) {
  const { header, payload } = apnsJwtClaims(config, Math.floor(nowMs / 1000));
  const headerB64 = b64uEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = b64uEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);
  const key = await importSigningKey(config.privateKey);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput));
  return `${headerB64}.${payloadB64}.${b64uEncode(sig)}`;
}

// ---------------------------------------------------------------------------
// Request shaping — the exact APNs HTTP/2 request contract (§4)
// ---------------------------------------------------------------------------

/** Path for one device token. The token is opaque — never parsed, never transformed. */
export function apnsPath(token) {
  return `/3/device/${encodeURIComponent(String(token))}`;
}

/**
 * APNs request headers. `apns-topic` is the bundle ID; push type is `alert`
 * (user-visible reminders); priority 10 = deliver immediately. No
 * collapse-id: each reminder occurrence is distinct by design and the
 * client-side tag/coalescing semantics already handle dedup on display.
 */
export function apnsHeaders(config, providerToken, { pushType = 'alert', priority = 10 } = {}) {
  return {
    authorization: `bearer ${providerToken}`,
    'apns-topic': config.bundleId,
    'apns-push-type': pushType,
    'apns-priority': String(priority),
  };
}

/**
 * Build the APNs JSON payload (§4). Native displays need title/body at SEND
 * time (there is no service-worker context on iOS to derive copy), so the
 * alert copy comes from the SHARED static table in js/swPush.js — the exact
 * wording the web fallback shows. The eligibility engine stays the single
 * copy authority for personalized text; it is NOT duplicated here, and no
 * personal data is added (the payload stays category + identity + route).
 *
 * Identity fields mirror the Web Push payload exactly, so dedup semantics,
 * occurrence IDs and deep-link routes stay comparable across transports.
 */
export function apnsPayload({ type = 'reminder', category, occurrenceId, dateKey, route, title, body }) {
  const alert = {
    title: String(title || 'Life Progress'),
    body: String(body || 'Time for a quick check-in.'),
  };
  const aps = {
    alert,
    badge: 1,
    'mutable-content': 1,
    // V2.1 Phase 2 — the native category id that unlocks iOS's officially
    // supported custom presentation: a UNNotificationContentExtension
    // registered for this category renders the immersive Life Progress card,
    // and the registered UNNotificationActions appear on the notification.
    // UPPER_SNAKE per Apple convention; the top-level wire `category`
    // (lowercase, web vocabulary) below is untouched.
    category: apnsCategoryId(category),
  };
  if (type === 'reminder') {
    aps.sound = 'default';
  }
  // Group per-category reminders in Notification Center. thread-id is an
  // OFFICIAL aps key and must live INSIDE the aps dictionary (a top-level
  // 'thread-id' is ignored by iOS).
  aps['thread-id'] = String(category || 'general');
  return JSON.stringify({
    aps,
    type,
    category: String(category || ''),
    occurrenceId: String(occurrenceId || ''),
    dateKey: String(dateKey || ''),
    route: String(route || '#/dashboard'),
  });
}

/**
 * V2.1 Phase 2 — wire category → native iOS category identifier.
 * Must stay in sync with the ids the app registers at launch
 * (ios/App/App/NotificationCategories.swift) and the extension's copy
 * tables — asserted cross-language by test/push-apns.test.js.
 */
export function apnsCategoryId(category) {
  const known = {
    water: 'WATER_REMINDER',
    gym: 'GYM_REMINDER',
    goals: 'GOALS_REMINDER',
    journal: 'JOURNAL_REMINDER',
    streaks: 'STREAK_REMINDER',
    achievements: 'ACHIEVEMENT_REMINDER',
  };
  return known[String(category || '')] || 'GENERAL_REMINDER';
}

/**
 * Wrap the shared buildPushPayload() output (the dispatcher contract) into an
 * APNs-ready payload. The dispatcher hands every provider the SAME minimal
 * JSON string — native providers translate; the scheduler never knows.
 * If the payload already carries an `aps` dictionary it is passed through.
 */
export function toApnsPayload(payloadString) {
  let raw = {};
  try {
    raw = JSON.parse(String(payloadString));
    if (raw && typeof raw === 'object' && raw.aps) return String(payloadString);
  } catch {
    raw = {}; // unparseable → fall through to a safe generic alert
  }
  const isTest = raw.type === 'test' || raw.category === 'test';
  const copy = isTest
    ? { title: 'Life Progress', body: 'Notifications are working 🔔 Background reminders are active.' }
    : genericForCategory(String(raw.category || ''));
  return apnsPayload({
    type: isTest ? 'test' : 'reminder',
    category: raw.category,
    occurrenceId: raw.occurrenceId,
    dateKey: raw.dateKey,
    route: raw.route,
    title: copy.title,
    body: copy.body,
  });
}

// ---------------------------------------------------------------------------
// Response mapping — typed outcomes per §2/§14.D
// ---------------------------------------------------------------------------

/**
 * Apple `reason` strings that describe a SERVER-SIDE configuration mistake
 * rather than a device whose token is dead.
 *
 * APNs returns `BadDeviceToken` when the token does not match the
 * ENVIRONMENT — i.e. a wrong `apns-topic`/bundle id, or a development token
 * sent to the production host (Apple's own wording: "Verify that the request
 * contains a valid token and that the token matches the environment"). None of
 * these mean "this device will never accept a push again".
 *
 * V2.1 FIX — they used to be classified GONE, and GONE DELETES the device:
 * cloudflare/do.js#tick runs `DELETE FROM push_subscriptions`, and the Node
 * scheduler marks the record permanently disabled. A deployment mistake
 * (bundle-id typo, sandbox/production mix-up) therefore permanently
 * unregistered a perfectly healthy device, silently — the classic "it
 * registered fine, then delivery stopped and never recovered".
 */
const APNS_CONFIG_REASONS = /BadDeviceToken|DeviceTokenNotForTopic|TopicDisallowed|MissingTopic|InvalidProviderToken|ExpiredProviderToken/i;

/**
 * Map one APNs HTTP response to a Phase 2 outcome. `reason` is Apple's
 * machine-readable `reason` field (e.g. 'Unregistered', 'BadDeviceToken').
 *
 * Classification is deliberately conservative about deletion:
 *  · 200                  → delivered
 *  · 410 / `Unregistered`  → gone  (the ONLY definitive dead-token signal —
 *                             APNs has no record of it; safe to forget)
 *  · config/provider errors → not_configured (retain the device, record the
 *                             error, surface it — never delete)
 *  · 429 / 5xx             → transient (retry later)
 *  · everything else       → permanent (keep the record, stop retrying it)
 */
export function mapApnsResponse(status, reason = null) {
  if (status === 200) return OUTCOME.DELIVERED;
  const r = String(reason || '');
  if (status === 410) return OUTCOME.GONE;
  if (status === 400 && /Unregistered/i.test(r)) return OUTCOME.GONE;
  // Configuration / provider identity — never a reason to forget a device.
  if (APNS_CONFIG_REASONS.test(r)) return OUTCOME.NOT_CONFIGURED;
  if (status === 401 || status === 403) return OUTCOME.NOT_CONFIGURED;
  if (status === 429 || status >= 500) return OUTCOME.TRANSIENT;
  return OUTCOME.PERMANENT;
}

// ---------------------------------------------------------------------------
// The provider — same send() contract as the Phase 2 web/FCM providers
// ---------------------------------------------------------------------------

/**
 * Create the APNs provider. `configSource` is the env-like object APNs
 * credentials are read from (Workers env / Node process.env / test maps);
 * `transport` is the HTTP/2 request function:
 *   transport({ host, path, headers, body }) →
 *     { status, reason? }  |  throws (network failure → transient)
 */
export function apnsProvider({ configSource = undefined, transport = globalThis.fetch, now = () => Date.now(), diagnostics = () => {} } = {}) {
  let cachedConfig;
  let cachedKey = { key: null, for: null };
  let cachedToken = { jwt: null, at: 0 };

  function config() {
    if (cachedConfig === undefined) cachedConfig = apnsConfig(configSource);
    return cachedConfig;
  }

  async function providerToken() {
    const cfg = config();
    const nowMs = now();
    if (cachedToken.jwt && cachedKey.for === cfg.privateKey && nowMs - cachedToken.at < JWT_TTL_MS) {
      return cachedToken.jwt;
    }
    const jwt = await apnsProviderToken(cfg, nowMs);
    cachedToken = { jwt, at: nowMs };
    cachedKey = { key: cfg.privateKey, for: cfg.privateKey };
    return jwt;
  }

  return {
    platform: 'ios',
    transport: 'apns',
    configured: true,

    /** Honest capability probe for status/diagnostics UI. */
    isConfigured() {
      return config() !== null;
    },

    /**
     * Send one notification to one iOS device token.
     * Returns the typed outcome; never throws (§2).
     */
    async send(device, payloadString) {
      const cfg = config();
      if (!cfg) {
        return makeResult(OUTCOME.NOT_CONFIGURED, {
          provider: 'apns',
          reason: 'APNs is not configured (APNS_KEY_ID / APNS_TEAM_ID / APNS_BUNDLE_ID / APNS_PRIVATE_KEY missing)',
        });
      }
      if (!device || typeof device.token !== 'string' || !device.token) {
        return makeResult(OUTCOME.PERMANENT, { provider: 'apns', reason: 'missing device token' });
      }

      let jwt;
      try {
        jwt = await providerToken();
      } catch (err) {
        // A malformed/unimportable key is a configuration problem, not a
        // delivery failure — do NOT spin the scheduler retrying it.
        return makeResult(OUTCOME.NOT_CONFIGURED, {
          provider: 'apns',
          reason: `APNs key invalid: ${err?.message || err}`,
        });
      }

      const headers = apnsHeaders(cfg, jwt);
      const path = apnsPath(device.token);
      let res;
      try {
        res = await transport({
          host: cfg.host,
          path,
          headers,
          body: toApnsPayload(payloadString),
        });
      } catch (err) {
        return makeResult(OUTCOME.TRANSIENT, {
          provider: 'apns',
          error: `network: ${err?.message || err}`,
        });
      }

      const status = res.status;
      const reason = res.reason || null;
      const outcome = mapApnsResponse(status, reason);
      if (outcome === OUTCOME.DELIVERED) {
        return makeResult(OUTCOME.DELIVERED, { provider: 'apns', status });
      }
      if (outcome === OUTCOME.GONE) {
        return makeResult(OUTCOME.GONE, { provider: 'apns', status, reason: reason || `status ${status}` });
      }
      if (outcome === OUTCOME.TRANSIENT) {
        return makeResult(OUTCOME.TRANSIENT, {
          provider: 'apns',
          status,
          reason: reason || undefined,
          error: reason || `apns returned ${status}`,
        });
      }
      diagnostics(`apns: status ${status}${reason ? ` (${reason})` : ''} — token redacted`);
      return makeResult(OUTCOME.PERMANENT, {
        provider: 'apns',
        status,
        reason: reason || undefined,
        error: reason || `apns returned ${status}`,
      });
    },
  };
}
