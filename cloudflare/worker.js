/**
 * Life Progress push backend — stateless Cloudflare Worker (V1.6.4).
 *
 * Responsibilities (§3): HTTP API routing, CORS, rate limiting, and the Cron
 * Trigger entry that asks the Durable Object to run a scheduler tick. ALL
 * state lives in the SQLite-backed Durable Object (cloudflare/do.js); this
 * Worker keeps nothing in memory between requests.
 *
 * API contract is byte-compatible with the Node backend (server/api.js):
 * the same routes, the same validation (shared via server/push/http.js), the
 * same JSON shapes — so js/pushClient.js works against either backend
 * unchanged (§8).
 *
 * CORS (§9): explicit allowlist via the PUSH_ALLOWED_ORIGINS var. Production
 * sets it to the GitHub Pages origin. Never "*". Options preflight handled
 * for every /api/push/* route.
 *
 * FREE-TIER SHAPE (§25): 1 DO request per API call + 1 per cron minute.
 * No polling loops, no alarms, no unbounded scans (subscription table is
 * single-user tiny), no paid features.
 */
import { LPPushDO } from './do.js';
import { corsHeaders, validateRegistration, publicVapidInfo } from '../server/push/http.js';

export { LPPushDO };

const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;

/** In-memory rate limiter. Workers isolate eviction makes this best-effort —
 * acceptable: it is abuse mitigation, not a security boundary. */
const rateBuckets = new Map();
function rateLimited(ip, now = Date.now()) {
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_WINDOW_MS;
  }
  bucket.count++;
  rateBuckets.set(ip, bucket);
  return bucket.count > RATE_MAX;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function doStub(env) {
  // One global DO instance for the single-user app (reasoning in do.js §25).
  return env.LP_PUSH.get(env.LP_PUSH.idFromName('global'));
}

async function readJson(request, maxBytes = 64 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('payload too large');
  return text ? JSON.parse(text) : {};
}

export default {
  // -------------------------------------------------------------------------
  // HTTP API
  // -------------------------------------------------------------------------
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health probe (§16): safe operational info only.
    if (url.pathname === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'life-progress-push', time: new Date().toISOString() });
    }

    if (!url.pathname.startsWith('/api/push/')) {
      return json({ ok: false, error: 'not found' }, 404);
    }

    const cors = corsHeaders(request.headers.get('Origin'), env.PUSH_ALLOWED_ORIGINS);

    // Preflight for every API route (§9).
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return json({ ok: false, error: 'too many requests' }, 429, cors);
    }

    try {
      if (request.method === 'GET' && url.pathname === '/api/push/vapid-public') {
        // Only the PUBLIC key ever leaves the Worker (§6). vapidPublicInfo is
        // the same shape the Node backend returns.
        const config = {
          publicKey: env.VAPID_PUBLIC_KEY,
          subject: env.VAPID_SUBJECT || 'mailto:life-progress@example.com',
          source: env.VAPID_PUBLIC_KEY ? 'env' : 'missing',
        };
        if (!config.publicKey) {
          return json({ ok: false, error: 'VAPID not configured' }, 503, cors);
        }
        return json(publicVapidInfo(config), 200, cors);
      }

      if (request.method === 'POST' && url.pathname === '/api/push/register') {
        const body = await readJson(request);
        const v = validateRegistration(body);
        if (v.error) return json({ ok: false, error: v.error }, 400, cors);
        const res = await doStub(env).fetch('https://do/register', {
          method: 'POST',
          body: JSON.stringify(v.value),
        });
        return new Response(res.body, { status: res.status, headers: cors });
      }

      if (request.method === 'POST' && url.pathname === '/api/push/unregister') {
        const body = await readJson(request);
        const res = await doStub(env).fetch('https://do/unregister', {
          method: 'POST',
          body: JSON.stringify({ deviceKey: body?.deviceKey }),
        });
        return new Response(res.body, { status: res.status, headers: cors });
      }

      if (request.method === 'POST' && url.pathname === '/api/push/test') {
        const body = await readJson(request);
        const res = await doStub(env).fetch('https://do/test', {
          method: 'POST',
          body: JSON.stringify({ deviceKey: body?.deviceKey }),
        });
        return new Response(res.body, { status: res.status, headers: cors });
      }

      if (request.method === 'GET' && url.pathname === '/api/push/status') {
        const res = await doStub(env).fetch('https://do/status', { method: 'GET' });
        return new Response(res.body, { status: res.status, headers: cors });
      }

      return json({ ok: false, error: 'not found' }, 404, cors);
    } catch (err) {
      // Malformed JSON, oversized bodies, DO failures — stable error codes,
      // no stack traces (§23/§24).
      const message = err?.message === 'payload too large' ? 'payload too large'
        : err instanceof SyntaxError ? 'invalid JSON'
        : 'internal error';
      return json({ ok: false, error: message }, err?.message === 'payload too large' || err instanceof SyntaxError ? 400 : 500, cors);
    }
  },

  // -------------------------------------------------------------------------
  // Cron Trigger — every minute (§10/§22). Stateless hop: ask the DO to tick.
  // -------------------------------------------------------------------------
  async scheduled(event, env) {
    const stub = doStub(env);
    const res = await stub.fetch('https://do/tick', { method: 'POST', body: '{}' });
    const result = await res.json().catch(() => ({}));
    if (!result.ok) {
      console.error('[lp-push] scheduled tick failed:', result.error || res.status);
    }
  },
};
