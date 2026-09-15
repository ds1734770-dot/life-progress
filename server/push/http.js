/**
 * Shared HTTP helpers for both push backends (Node + Cloudflare Worker).
 * Keeping CORS, validation and public-info shaping in one place guarantees
 * the two deployments answer browsers identically (§8/§9 of the V1.6.4
 * spec). This module must stay RUNTIME-NEUTRAL: no node: imports, no
 * Workers-only globals.
 *
 * Origin policy: explicit allowlist via the PUSH_ALLOWED_ORIGINS env var
 * (comma-separated exact origins). When it is unset — private single-user
 * deployments — the request origin is reflected; a literal "*" is never
 * used because the response would then be unusable for credentialed
 * requests and broader than the single origin this app needs.
 */
import { isValidTimezone, isValidTime } from '../../js/timeCore.js';

export const CATEGORIES = ['water', 'gym', 'goals', 'journal'];

/**
 * Resolve whether a request origin is allowed and what to echo back.
 * Pure — unit-tested; both backends consume the result.
 * @param {{origin?: string|null, allowedOrigins?: string|null}} req
 * @returns {{allowed: boolean, echoOrigin: string|null}}
 */
export function resolveCorsOrigin({ origin, allowedOrigins } = {}) {
  if (!origin) return { allowed: false, echoOrigin: null };
  const list = String(allowedOrigins || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Unset allowlist = reflect (private single-user deployments).
  if (list.length === 0) return { allowed: true, echoOrigin: origin };
  if (list.includes(origin)) return { allowed: true, echoOrigin: origin };
  return { allowed: false, echoOrigin: null };
}

/** CORS headers for a (possibly disallowed) origin. Empty object when blocked. */
export function corsHeaders(origin, allowedOrigins) {
  const { allowed, echoOrigin } = resolveCorsOrigin({ origin, allowedOrigins });
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': echoOrigin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
  };
}

/**
 * Non-secret VAPID summary safe to expose via /api/push/vapid-public.
 * Defined here (pure module) so the Cloudflare Worker can share it WITHOUT
 * importing server/vapid.js, which reads the Node filesystem (§3/§7).
 */
export function publicVapidInfo(config) {
  return { publicKey: config.publicKey, subject: config.subject, source: config.source };
}

/**
 * Validate and normalize a registration body — identical contract in both
 * backends (extracted verbatim from server/api.js). Returns { error } or
 * { value }. Only known fields survive; unknown fields are dropped.
 */
export function validateRegistration(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid body' };
  const { deviceKey, endpoint, keys, timezone, categories, times, quietStart, quietEnd, enabled } = body;

  if (typeof deviceKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceKey)) {
    return { error: 'invalid deviceKey' };
  }
  if (typeof endpoint !== 'string' || !/^https:\/\/[^\s]+$/.test(endpoint) || endpoint.length > 2048) {
    return { error: 'invalid endpoint' };
  }
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' ||
      keys.p256dh.length > 512 || keys.auth.length > 256) {
    return { error: 'invalid keys' };
  }
  const tz = isValidTimezone(timezone);
  if (!tz) return { error: 'invalid timezone' };

  const cats = {};
  for (const c of CATEGORIES) cats[c] = categories?.[c] !== false;

  const tms = {};
  for (const c of CATEGORIES) {
    const t = times?.[c];
    if (t != null && isValidTime(t)) tms[c] = t;
  }
  // Require at least a sane set — missing entries keep previous server values.
  if (Object.keys(tms).length === 0) return { error: 'missing reminder times' };

  const qs = isValidTime(quietStart) ? quietStart : '22:30';
  const qe = isValidTime(quietEnd) ? quietEnd : '07:00';

  return {
    value: {
      deviceKey,
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      timezone: tz,
      categories: cats,
      times: tms,
      quietStart: qs,
      quietEnd: qe,
      enabled: enabled !== false,
    },
  };
}
