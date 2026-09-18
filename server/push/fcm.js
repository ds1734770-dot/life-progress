/**
 * FCM provider — native Android delivery (V2.0 Phase 5).
 *
 * Implements the Phase 2 provider contract from server/push/dispatch.js:
 *   send(device, payload) → { outcome: delivered | gone | transient_failure
 *                                          | permanent_failure | not_configured }
 *
 * TRANSPORT (§5.2): FCM HTTP v1 — POST
 *   https://fcm.googleapis.com/v1/projects/{project}/messages:send
 * Unlike APNs, Google's endpoint accepts HTTP/1.1, so BOTH runtimes use the
 * global fetch — one transport contract, no Node http2 adapter needed:
 *   transport({ url, method, headers, body }) → { status, json? } | throws
 * All FCM BUSINESS logic (OAuth JWT, request shaping, response/error
 * mapping) lives HERE, once — never duplicated between runtimes.
 *
 * AUTH (§5.2): OAuth 2.0 service-account flow. An RS256 JWT
 *   { iss: client_email, scope: firebase.messaging, aud: token endpoint,
 *     iat, exp } signed with the service-account private key is exchanged at
 *   https://oauth2.googleapis.com/token for a short-lived access token
 *   (cached ~55 min). No Firebase Admin SDK (Node-only); raw WebCrypto RS256
 *   works on Node ≥ 16 and Workers alike. Credentials come from environment
 *   configuration ONLY — never committed, never logged, never in frontend
 *   code, never in Android source (§GLOBAL 13-16).
 *
 * The FCM registration token is OPAQUE (§5.4): never parsed, never
 * transformed, never stored in Web Push fields.
 */
import { b64uEncode, b64uDecode } from './webpush.js';
import { pemToDer } from './apns.js';
import { OUTCOME, makeResult } from './outcomes.js';
import { genericForCategory } from '../../js/swPush.js';

const crypto = globalThis.crypto;
const encoder = new TextEncoder();

const FCM_SEND_HOST = 'https://fcm.googleapis.com';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Access tokens live 1 h; refresh early. */
const OAUTH_TTL_MS = 55 * 60 * 1000;

// ---------------------------------------------------------------------------
// Configuration — environment-provided, never committed (§5.2/GLOBAL 13-16)
// ---------------------------------------------------------------------------

/** Names resolved lazily from a config object (env on both runtimes). */
export const FCM_ENV_KEYS = Object.freeze({
  projectId: 'FCM_PROJECT_ID',
  clientEmail: 'FCM_CLIENT_EMAIL',
  privateKey: 'FCM_PRIVATE_KEY', // service-account PKCS#8 PEM (JSON's \n newlines supported)
});

/**
 * Read + validate FCM configuration. Returns null when any required value is
 * missing — the honest `not_configured` signal; never a crash. Values are
 * trimmed; whitespace-only counts as missing.
 */
export function fcmConfig(source = undefined, overrides = {}) {
  const env = source ?? (typeof process !== 'undefined' ? process.env : {});
  const pick = (v) => {
    if (v === undefined || v === null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  };
  const projectId = pick(overrides.projectId ?? env[FCM_ENV_KEYS.projectId]);
  const clientEmail = pick(overrides.clientEmail ?? env[FCM_ENV_KEYS.clientEmail]);
  const privateKey = pick(overrides.privateKey ?? env[FCM_ENV_KEYS.privateKey]);
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

/** True when FCM is fully configured (used for honest status reporting). */
export function isFcmConfigured(source = undefined) {
  return fcmConfig(source) !== null;
}

// ---------------------------------------------------------------------------
// Service-account key handling — JSON or raw PEM both accepted
// ---------------------------------------------------------------------------

/**
 * Accept the private key in two shapes:
 *  · a full service-account JSON (as downloaded from Firebase) — the JSON is
 *    parsed for `client_email`/`private_key` when those parts are missing
 *  · a raw PKCS#8 PEM
 * In git, tests, and logs there is only ever a placeholder; the real value
 * arrives via secrets at runtime.
 */
export function parseServiceAccountKey(value) {
  const raw = String(value).trim();
  if (raw.startsWith('{')) {
    const json = JSON.parse(raw); // throws on malformed JSON → not_configured upstream
    const pk = json.private_key || json.privateKey;
    if (!pk) throw new Error('fcm: service-account JSON has no private_key');
    // Normalize ONLY the extracted PEM — normalizing the whole JSON first
    // would corrupt its escape sequences.
    return { privateKey: normalizePem(String(pk)), clientEmail: json.client_email || json.clientEmail || undefined };
  }
  return { privateKey: normalizePem(raw), clientEmail: undefined };
}

/**
 * PEM armor normalization for keys that passed through layers that escape
 * newlines (some secret stores double-escape `\n`): literal backslash-n
 * sequences become real newlines. A valid PEM contains no backslashes, so
 * this is always safe.
 */
function normalizePem(pem) {
  return String(pem).includes('\\n') ? String(pem).replace(/\\n/g, '\n') : String(pem);
}

// ---------------------------------------------------------------------------
// The OAuth 2.0 assertion (RS256 JWT → access token)
// ---------------------------------------------------------------------------

/** Build the JWT header/claims (exported for tests — no secrets in them). */
export function fcmJwtClaims({ clientEmail }, { iat, exp }) {
  return {
    header: { alg: 'RS256', typ: 'JWT' },
    payload: { iss: clientEmail, scope: OAUTH_SCOPE, aud: OAUTH_TOKEN_URL, iat, exp },
  };
}

/**
 * Sign the OAuth assertion JWT (RS256). Key material never leaves this
 * function; only the compact JWT is returned. Never log it.
 */
export async function fcmAssertionJwt(config, nowMs = Date.now()) {
  const { privateKey } = parseServiceAccountKey(config.privateKey);
  const iat = Math.floor(nowMs / 1000);
  const { header, payload } = fcmJwtClaims(config, { iat, exp: iat + 3600 });
  const headerB64 = b64uEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = b64uEncode(encoder.encode(JSON.stringify(payload)));
  const signingInput = encoder.encode(`${headerB64}.${payloadB64}`);
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, signingInput));
  return `${headerB64}.${payloadB64}.${b64uEncode(sig)}`;
}

// ---------------------------------------------------------------------------
// Request shaping — the FCM HTTP v1 message contract (§5.1/§5.7/§5.8)
// ---------------------------------------------------------------------------

/** Endpoint for one project. The registration token rides in the body only. */
export function fcmSendUrl(projectId) {
  return `${FCM_SEND_HOST}/v1/projects/${encodeURIComponent(String(projectId))}/messages:send`;
}

/**
 * Build the FCM message body. Copy comes from the SHARED static table in
 * js/swPush.js — the exact wording web/iOS show (§6.4: one copy system).
 * The `notification` block makes Android display the message even when the
 * app was killed (FCM system-tray delivery); `data` carries ONLY identity
 * metadata (category/occurrence/route) for deep links + dedup — no personal
 * content (§GLOBAL privacy). `android.channel_id` groups reminders per
 * category when the app defines channels; unknown categories fall back to
 * the generic channel.
 */
export function fcmMessage({ type = 'reminder', category, occurrenceId, dateKey, route, title, body }, token) {
  const copy = {
    title: String(title || 'Life Progress'),
    body: String(body || 'Time for a quick check-in.'),
  };
  const safeCategory = String(category || '');
  const message = {
    token, // opaque registration token (§5.4)
    notification: { ...copy },
    data: {
      type: String(type),
      category: safeCategory,
      occurrenceId: String(occurrenceId || ''),
      dateKey: String(dateKey || ''),
      route: String(route || '#/dashboard'),
    },
    android: {
      // FCM system-tray delivery: the OS shows it whether or not the app
      // process is alive (§5.9). priority HIGH for time-relevant reminders.
      priority: 'HIGH',
      channel_id: safeCategory ? `lp_${safeCategory}` : 'lp_general',
    },
  };
  // Test pushes are silent-adjacent: still visible (so the user SEES the
  // chain works) but no alarm-style urgency beyond the default.
  if (type === 'test') message.android.priority = 'DEFAULT';
  return { message };
}

/**
 * Wrap the shared buildPushPayload() output (the dispatcher contract) into an
 * FCM message body. Mirrors apns.toApnsPayload(): the dispatcher hands every
 * provider the SAME minimal JSON string — native providers translate.
 */
export function toFcmMessage(payloadString, token) {
  let raw = {};
  try {
    raw = JSON.parse(String(payloadString));
    if (raw && typeof raw === 'object' && raw.message && raw.message.token) {
      return { message: raw.message }; // already FCM-shaped → pass through
    }
  } catch {
    raw = {}; // unparseable → fall through to a safe generic message
  }
  const isTest = raw.type === 'test' || raw.category === 'test';
  const copy = isTest
    ? { title: 'Life Progress', body: 'Notifications are working 🔔 Background reminders are active.' }
    : genericForCategory(String(raw.category || ''));
  return fcmMessage({
    type: isTest ? 'test' : 'reminder',
    category: raw.category,
    occurrenceId: raw.occurrenceId,
    dateKey: raw.dateKey,
    route: raw.route,
    title: copy.title,
    body: copy.body,
  }, token);
}

// ---------------------------------------------------------------------------
// Response mapping — typed outcomes per §5.1
// ---------------------------------------------------------------------------

/**
 * Map one FCM HTTP v1 response (+ optional Google error `status` string from
 * the JSON error body) to a Phase 2 outcome. Classification is deliberate:
 *  · 200 → delivered
 *  · 404/410 or UNREGISTERED/INVALID_ARGUMENT-token → gone (device will never
 *    accept again; cleanup semantics apply)
 *  · 429 (QUOTA_EXCEEDED/RESOURCE_EXHAUSTED) and 5xx (INTERNAL/UNAVAILABLE) →
 *    transient
 *  · 401/403 (authentication/permission of the SERVER identity) →
 *    not_configured (a configuration problem, not a device problem — no
 *    retry storm, no wrong cleanup)
 *  · other 4xx → permanent (bad request will never succeed as-is)
 */
export function mapFcmResponse(status, googleStatus = null) {
  if (status === 200) return OUTCOME.DELIVERED;
  const g = String(googleStatus || '');
  if (status === 404 || status === 410) return OUTCOME.GONE;
  if (status === 400 && /UNREGISTERED/i.test(g)) return OUTCOME.GONE;
  if (status === 429) return OUTCOME.TRANSIENT;
  if (status >= 500) return OUTCOME.TRANSIENT;
  // 401/403: the SERVER identity failed auth/permission (bad service
  // account, wrong project) — a configuration problem, not device state
  // (covers SENDER_ID_MISMATCH/PERMISSION_DENIED too).
  if (status === 401 || status === 403) return OUTCOME.NOT_CONFIGURED;
  return OUTCOME.PERMANENT;
}

// ---------------------------------------------------------------------------
// The provider — same send() contract as the web/APNs providers
// ---------------------------------------------------------------------------

/**
 * Create the FCM provider. `configSource` is the env-like object credentials
 * are read from; `transport` is the HTTP function:
 *   transport({ url, method, headers, body }) →
 *     { status, json? }  |  throws (network failure → transient)
 */
export function fcmProvider({ configSource = undefined, transport = globalThis.fetch, now = () => Date.now(), diagnostics = () => {} } = {}) {
  let cachedConfig;
  let cachedToken = { accessToken: null, at: 0 };

  function config() {
    if (cachedConfig === undefined) cachedConfig = fcmConfig(configSource);
    return cachedConfig;
  }

  async function accessToken() {
    const cfg = config();
    const nowMs = now();
    if (cachedToken.accessToken && nowMs - cachedToken.at < OAUTH_TTL_MS) {
      return cachedToken.accessToken;
    }
    // Signing failures = configuration problems (bad/missing key).
    let assertion;
    try {
      assertion = await fcmAssertionJwt(cfg, nowMs);
    } catch (err) {
      const e = new Error(`FCM key invalid: ${err?.message || err}`);
      e.notConfigured = true;
      throw e;
    }
    // Transport failures = network problems → transient, NOT config.
    let res;
    try {
      res = await transport({
        url: OAUTH_TOKEN_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
    } catch (err) {
      const e = new Error(`network: ${err?.message || err}`);
      e.network = true;
      throw e;
    }
    const json = res.json ?? null;
    if (res.status !== 200 || !json?.access_token) {
      // Server-identity auth failed → a configuration problem, not device
      // state. Honest not_configured; the scheduler must not retry-loop it.
      const errDesc = json?.error_description || json?.error || `oauth ${res.status}`;
      const e = new Error(`fcm auth failed: ${errDesc}`);
      e.notConfigured = true;
      throw e;
    }
    cachedToken = { accessToken: String(json.access_token), at: nowMs };
    return cachedToken.accessToken;
  }

  return {
    platform: 'android',
    transport: 'fcm',
    configured: true,

    /** Honest capability probe for status/diagnostics UI. */
    isConfigured() {
      return config() !== null;
    },

    /**
     * Send one notification to one Android FCM token.
     * Returns the typed outcome; never throws (§5.1/GLOBAL 15).
     */
    async send(device, payloadString) {
      const cfg = config();
      if (!cfg) {
        return makeResult(OUTCOME.NOT_CONFIGURED, {
          provider: 'fcm',
          reason: 'FCM is not configured (FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY missing)',
        });
      }
      if (!device || typeof device.token !== 'string' || !device.token) {
        return makeResult(OUTCOME.PERMANENT, { provider: 'fcm', reason: 'missing device token' });
      }

      let auth;
      try {
        auth = await accessToken();
      } catch (err) {
        if (err?.network) {
          // OAuth endpoint unreachable — transient (the network may recover).
          return makeResult(OUTCOME.TRANSIENT, { provider: 'fcm', error: String(err.message || err) });
        }
        // Bad service-account key / oauth rejection: config problem.
        return makeResult(OUTCOME.NOT_CONFIGURED, { provider: 'fcm', reason: String(err.message || err) });
      }

      const url = fcmSendUrl(cfg.projectId);
      let res;
      try {
        res = await transport({
          url,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth}`,
            'Content-Type': 'application/json; UTF-8',
          },
          body: JSON.stringify(toFcmMessage(payloadString, device.token)),
        });
      } catch (err) {
        return makeResult(OUTCOME.TRANSIENT, {
          provider: 'fcm',
          error: `network: ${err?.message || err}`,
        });
      }

      const status = res.status;
      const googleStatus = res.json?.error?.status || res.json?.error?.details?.[0]?.reason || null;
      const outcome = mapFcmResponse(status, googleStatus);
      if (outcome === OUTCOME.DELIVERED) {
        return makeResult(OUTCOME.DELIVERED, { provider: 'fcm', status });
      }
      if (outcome === OUTCOME.GONE) {
        return makeResult(OUTCOME.GONE, { provider: 'fcm', status, reason: googleStatus || `status ${status}` });
      }
      if (outcome === OUTCOME.NOT_CONFIGURED) {
        return makeResult(OUTCOME.NOT_CONFIGURED, { provider: 'fcm', reason: googleStatus || `fcm auth ${status}` });
      }
      if (outcome === OUTCOME.TRANSIENT) {
        return makeResult(OUTCOME.TRANSIENT, {
          provider: 'fcm',
          status,
          reason: googleStatus || undefined,
          error: googleStatus || `fcm returned ${status}`,
        });
      }
      diagnostics(`fcm: status ${status}${googleStatus ? ` (${googleStatus})` : ''} — token redacted`);
      return makeResult(OUTCOME.PERMANENT, {
        provider: 'fcm',
        status,
        reason: googleStatus || undefined,
        error: googleStatus || `fcm returned ${status}`,
      });
    },
  };
}
