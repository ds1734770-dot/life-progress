/**
 * Push API — HTTP endpoints for subscription lifecycle + test delivery.
 *
 * Validation-first: every field is checked before it is persisted (§24).
 * Rate limits guard registration and test pushes. Nothing personal is ever
 * stored (§4): endpoint, crypto keys, timezone, quiet hours, reminder times,
 * enabled flags — that's the whole record.
 */
import { getVapidConfig, vapidPublicInfo } from './vapid.js';
import {
  upsertSubscription,
  getSubscription,
  deleteSubscription,
  listSubscriptions,
  markSubscriptionOutcome,
} from './store.js';
import { dispatchNotification, OUTCOME } from './push/dispatch.js';
import { apnsNodeTransport } from './push/nodeHttp2.js';
import { buildPushPayload } from './scheduler.js';
// V2.1 — allowlist for per-category test pushes (see /api/push/test).
const TEST_CATEGORIES = ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements'];
import {
  corsHeaders,
  validateRegistration,
} from './push/http.js';

// Registration validation + CORS policy live in server/push/http.js (V1.6.4)
// so the Cloudflare Worker backend enforces the identical contract.
export { validateRegistration };

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per IP — generous; abuse unlikely for a personal app)
// ---------------------------------------------------------------------------

const rateBuckets = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 30;

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + RATE_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_WINDOW_MS;
  }
  bucket.count++;
  rateBuckets.set(ip, bucket);
  return bucket.count > RATE_MAX;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function badRequest(res, message) {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Route handler — mounted from server.js
// ---------------------------------------------------------------------------

/**
 * CORS for split deployments (§9): the static app (GitHub Pages etc.) and
 * this backend usually sit on DIFFERENT origins. Allowed origins come from
 * the PUSH_ALLOWED_ORIGINS env var (comma-separated, exact match, e.g.
 * "https://user.github.io"). When it is unset — personal/single-user
 * deployments — the request origin is reflected (never a literal "*"; no
 * credentials/cookies are involved anywhere in this API).
 */
function applyCors(req, res) {
  const headers = corsHeaders(req.headers?.origin, process.env.PUSH_ALLOWED_ORIGINS);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
}

/**
 * Handle push API requests. Returns true when the request was handled.
 */
export async function handlePushApi(req, res, pathname) {
  if (!pathname.startsWith('/api/push/')) return false;
  const method = req.method;
  const ip = req.socket?.remoteAddress || 'unknown';
  applyCors(req, res);

  // Browser preflight for cross-origin POSTs (split deployments).
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (method === 'GET' && pathname === '/api/push/vapid-public') {
    const config = await getVapidConfig();
    json(res, 200, vapidPublicInfo(config));
    return true;
  }

  if (rateLimited(ip)) {
    json(res, 429, { ok: false, error: 'too many requests' });
    return true;
  }

  // Body reader with a hard cap — never buffer unbounded input.
  const readBody = () =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 64 * 1024) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });

  try {
    if (method === 'POST' && pathname === '/api/push/register') {
      const body = JSON.parse((await readBody()) || '{}');
      const v = validateRegistration(body);
      if (v.error) return badRequest(res, v.error), true;
      await upsertSubscription(v.value.deviceKey, v.value);
      json(res, 200, { ok: true, deviceKey: v.value.deviceKey });
      return true;
    }

    if (method === 'POST' && pathname === '/api/push/unregister') {
      const body = JSON.parse((await readBody()) || '{}');
      if (typeof body.deviceKey === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.deviceKey)) {
        await deleteSubscription(body.deviceKey);
      }
      json(res, 200, { ok: true });
      return true;
    }

    if (method === 'POST' && pathname === '/api/push/test') {
      const body = JSON.parse((await readBody()) || '{}');
      const sub = typeof body.deviceKey === 'string' ? getSubscription(body.deviceKey) : null;
      if (!sub) {
        json(res, 404, { ok: false, error: 'subscription not found — enable notifications first' });
        return true;
      }
      // V2.1 — optional allowlisted category: per-category test pushes use
      // the REAL reminder payload shape (kind 'reminder', real copy) so the
      // device renders exactly what a scheduled reminder renders. Unknown or
      // absent → the legacy generic test push.
      const category = TEST_CATEGORIES.includes(body.category) ? body.category : null;
      const vapid = await getVapidConfig();
      const occurrenceId = `${sub.deviceKey}:test:${Date.now()}`;
      const payload = category
        ? buildPushPayload({ kind: 'reminder', category, occurrenceId, dateKey: '', route: ROUTES[category] })
        : buildPushPayload({ kind: 'test', category: 'test', occurrenceId, dateKey: '', route: '#/dashboard' });
      // V2.0 Phase 2 — the test path uses the same platform dispatcher as
      // the scheduler (§11): no provider logic duplicated here.
      const result = await dispatchNotification(
        { platform: sub.platform, endpoint: sub.endpoint, keys: sub.keys, token: sub.token },
        payload,
        { vapid, env: process.env, apnsTransport: apnsNodeTransport }
      );
      if (result.outcome === OUTCOME.DELIVERED) {
        await markSubscriptionOutcome(sub.deviceKey, { ok: true });
        json(res, 200, { ok: true });
      } else if (result.outcome === OUTCOME.NOT_CONFIGURED) {
        json(res, 503, { ok: false, error: result.reason || 'provider not configured' });
      } else {
        await markSubscriptionOutcome(sub.deviceKey, {
          ok: false,
          error: result.error || result.reason || `status ${result.status}`,
          permanent: result.outcome === OUTCOME.GONE,
        });
        json(res, 502, { ok: false, error: result.error || result.reason || `push service returned ${result.status}`, transient: result.outcome === OUTCOME.TRANSIENT });
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/push/status') {
      const subs = listSubscriptions();
      json(res, 200, {
        ok: true,
        devices: subs.length,
        active: subs.filter((s) => s.enabled !== false && !s.disabled).length,
        nextDeliveries: subs
          .map((s) => ({ deviceKey: s.deviceKey, ledger: s.ledger || {}, lastDeliveredAt: s.lastDeliveredAt || null, disabled: !!s.disabled }))
          .slice(0, 20),
      });
      return true;
    }
  } catch (err) {
    console.error('[push-api] error:', err?.message || err);
    json(res, 500, { ok: false, error: 'internal error' });
    return true;
  }

  // Unknown push API route.
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
  return true;
}