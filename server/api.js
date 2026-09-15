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
import { sendPushMessage } from './push/webpush.js';
import { buildPushPayload } from './scheduler.js';
import { isValidTimezone, isValidTime } from '../js/timeCore.js';

const CATEGORIES = ['water', 'gym', 'goals', 'journal'];

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

/**
 * Validate and normalize a registration body. Returns { ok, value|error }.
 * Only known fields survive; unknown fields are dropped (never persisted).
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

// ---------------------------------------------------------------------------
// Route handler — mounted from server.js
// ---------------------------------------------------------------------------

/**
 * Handle push API requests. Returns true when the request was handled.
 */
export async function handlePushApi(req, res, pathname) {
  if (!pathname.startsWith('/api/push/')) return false;
  const method = req.method;
  const ip = req.socket?.remoteAddress || 'unknown';

  // CORS: the app and its API share an origin in production; permissive CORS
  // only for the GET of the public key (harmless, non-secret) keeps local
  // multi-port development workable.
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
      const vapid = await getVapidConfig();
      const occurrenceId = `${sub.deviceKey}:test:${Date.now()}`;
      const payload = buildPushPayload({ kind: 'test', category: 'test', occurrenceId, dateKey: '', route: '#/dashboard' });
      const result = await sendPushMessage({ endpoint: sub.endpoint, keys: sub.keys }, payload, vapid);
      if (result.ok) {
        await markSubscriptionOutcome(sub.deviceKey, { ok: true });
        json(res, 200, { ok: true });
      } else {
        await markSubscriptionOutcome(sub.deviceKey, {
          ok: false,
          error: result.error || `status ${result.status}`,
          permanent: result.status === 404 || result.status === 410,
        });
        json(res, 502, { ok: false, error: result.error || `push service returned ${result.status}`, transient: !!result.transient });
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