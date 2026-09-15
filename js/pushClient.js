/**
 * Push subscription manager — the CLIENT half of background reminders.
 *
 * Owns the full subscription lifecycle (§6): capability checks → service
 * worker readiness → PushManager.subscribe (VAPID) → server registration →
 * persisted state. Never asks for permission on its own; permission is always
 * requested by an explicit user action in the settings screen.
 *
 * State lives in IndexedDB (notificationState store, record 'pushReg') so the
 * SERVICE WORKER can read the device key too (SW has no localStorage) — the
 * same record powers boot re-sync and `pushsubscriptionchange` recovery.
 *
 * Delivery states (§33): 'off' | 'active' | 'pending' | 'denied' |
 * 'unsupported' | 'insecure' | 'error'. The UI renders each honestly; nothing
 * here ever claims delivery that has not actually been registered.
 */
import { dbGet, dbPut, dbDelete } from './db.js';
import { STORE } from './notifications.js';

const PUSH_REG_ID = 'pushReg';
const API_BASE = () => String(window.LIFE_PROGRESS_PUSH_API || '').replace(/\/+$/, '');

export const PUSH_STATES = ['off', 'active', 'pending', 'denied', 'unsupported', 'insecure', 'error'];

// ---------------------------------------------------------------------------
// Capability detection (§23) — honest, per-platform
// ---------------------------------------------------------------------------

export function pushCapabilities() {
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const notifSupported = typeof window !== 'undefined' && 'Notification' in window;
  const pushSupported = secure && swSupported && notifSupported &&
    'PushManager' in window && 'PushManager' in ServiceWorkerRegistration.prototype;
  const standalone =
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches) ||
    (typeof navigator !== 'undefined' && navigator.standalone === true);
  return { secure, swSupported, notifSupported, pushSupported, standalone };
}

/** Human-readable reason when background push is unavailable (§22/§33). */
export function unsupportedReason(caps = pushCapabilities()) {
  if (!caps.swSupported) return 'This browser has no service worker support.';
  if (!caps.notifSupported) return 'This browser has no notification support.';
  if (!caps.secure) return 'Background reminders need a secure (https or localhost) connection.';
  if (!caps.pushSupported) return 'This browser doesn’t support background push.';
  return null;
}

// ---------------------------------------------------------------------------
// Device key + persisted state (IndexedDB)
// ---------------------------------------------------------------------------

export async function getDeviceKey() {
  const reg = await dbGet(STORE, PUSH_REG_ID);
  if (reg?.deviceKey) return reg.deviceKey;
  const key = (crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 48);
  return key;
}

/** Current persisted push state (defaults to 'off'). */
export async function currentPushState() {
  try {
    const reg = await dbGet(STORE, PUSH_REG_ID);
    return reg || { id: PUSH_REG_ID, status: 'off' };
  } catch {
    return { id: PUSH_REG_ID, status: 'off' };
  }
}

async function savePushState(patch) {
  const current = await currentPushState();
  const next = { ...current, ...patch, id: PUSH_REG_ID, updatedAt: Date.now() };
  await dbPut(STORE, next);
  return next;
}

// ---------------------------------------------------------------------------
// VAPID public key — fetched from the server, cached for offline re-sync
// ---------------------------------------------------------------------------

const LS_KEY_CACHE = 'lp-push-vapid-public';

async function getVapidPublicKey() {
  const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY_CACHE) : null;
  try {
    const res = await fetch(`${API_BASE()}/api/push/vapid-public`);
    if (!res.ok) throw new Error(`server ${res.status}`);
    const data = await res.json();
    if (!data?.publicKey) throw new Error('server has no VAPID key');
    if (typeof localStorage !== 'undefined') localStorage.setItem(LS_KEY_CACHE, data.publicKey);
    return data.publicKey;
  } catch (err) {
    if (cached) return cached; // server briefly unreachable — cached key is fine for re-subscribe
    throw new Error(`push server unreachable (${err?.message || err})`);
  }
}

function urlBase64ToUint8Array(b64u) {
  const pad = '='.repeat((4 - (b64u.length % 4)) % 4);
  const b64 = (b64u + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Normalize any BufferSource to a plain byte view before encoding. */
function toByteView(buf) {
  if (buf instanceof Uint8Array) return buf;
  return new Uint8Array(buf, (buf.byteOffset || 0), buf.byteLength);
}

function bufToBase64Url(buf) {
  const bytes = toByteView(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// Core subscription flow (§6)
// ---------------------------------------------------------------------------

/**
 * Subscribe the browser and register the schedule with the server.
 * `prefs` is the normalized notification prefs record. Permission must ALREADY
 * be granted — this function never prompts.
 */
export async function subscribeAndRegister(prefs) {
  const caps = pushCapabilities();
  const reason = unsupportedReason(caps);
  if (reason) {
    const state = await savePushState({ status: caps.secure ? 'unsupported' : 'insecure', reason });
    return { ok: false, state, reason };
  }
  if (Notification.permission !== 'granted') {
    const state = await savePushState({ status: 'denied', reason: 'Notification permission not granted.' });
    return { ok: false, state, reason: state.reason };
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg.pushManager) throw new Error('PushManager unavailable on this registration');

    const publicKey = await getVapidPublicKey();
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    // Reuse an existing subscription for the same key; replace one minted
    // against a different key (server rotated) — §20, no uncontrolled dupes.
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      const existingKey = sub.options?.applicationServerKey;
      const sameKey = existingKey && bufToBase64Url(existingKey) === bufToBase64Url(applicationServerKey);
      if (!sameKey) {
        await sub.unsubscribe();
        sub = null;
      }
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    }

    const deviceKey = await getDeviceKey();
    const registered = await registerWithServer(deviceKey, sub, prefs, publicKey);
    const state = await savePushState({
      status: 'active',
      deviceKey,
      endpoint: sub.endpoint,
      vapidPublic: publicKey,
      registeredAt: registered?.at || Date.now(),
      reason: null,
    });
    return { ok: true, state, subscription: sub };
  } catch (err) {
    // Network/server failures keep the reminder saved locally and mark the
    // registration pending — never a fake "active" (§21/§33).
    const message = String(err?.message || err);
    const networkish = /unreachable|fetch|network|Failed to fetch/i.test(message);
    const state = await savePushState({ status: networkish ? 'pending' : 'error', reason: message });
    return { ok: false, state, reason: message };
  }
}

async function registerWithServer(deviceKey, sub, prefs, vapidPublic) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const res = await fetch(`${API_BASE()}/api/push/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceKey,
      endpoint: sub.endpoint,
      keys: {
        p256dh: bufToBase64Url(sub.getKey('p256dh')),
        auth: bufToBase64Url(sub.getKey('auth')),
      },
      timezone: tz,
      categories: prefs.categories,
      times: prefs.times,
      quietStart: prefs.quietStart,
      quietEnd: prefs.quietEnd,
      enabled: prefs.enabled !== false,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.error || ''; } catch { /* opaque */ }
    throw new Error(`server rejected registration (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json().catch(() => ({}));
  return { at: data.serverTime || Date.now() };
}

/**
 * Reconcile push state with current prefs — called on boot, when prefs change
 * and when connectivity returns (§21). Idempotent; never prompts for
 * permission; never blocks.
 */
export async function syncPushRegistration(prefs) {
  if (!prefs.enabled) {
    const state = await currentPushState();
    if (state.status !== 'off' && state.status !== 'unsupported' && state.status !== 'insecure') {
      await disablePush();
    }
    return { ok: true, state: await currentPushState() };
  }
  if (Notification.permission === 'denied') {
    return { ok: false, state: await savePushState({ status: 'denied', reason: 'Notifications are blocked in browser settings.' }) };
  }
  const caps = pushCapabilities();
  const reason = unsupportedReason(caps);
  if (reason) {
    return { ok: false, state: await savePushState({ status: caps.secure ? 'unsupported' : 'insecure', reason }) };
  }
  if (Notification.permission !== 'granted') {
    // Enabled but permission not yet granted — subscription happens from the
    // explicit toggle action; keep local-only until then.
    return { ok: false, state: await currentPushState() };
  }
  return subscribeAndRegister(prefs);
}

/**
 * Stop background delivery: tell the server AND unsubscribe the browser.
 * Best-effort — safe offline (§26).
 */
export async function disablePush() {
  try {
    const reg = await currentPushState();
    if (reg.deviceKey) {
      await fetch(`${API_BASE()}/api/push/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceKey: reg.deviceKey }),
      }).catch(() => {});
    }
    const swReg = await navigator.serviceWorker?.getRegistration();
    const sub = swReg && (await swReg.pushManager.getSubscription());
    if (sub) await sub.unsubscribe().catch(() => {});
  } catch { /* best-effort */ }
  return savePushState({ status: 'off', endpoint: null, reason: null });
}

/** Full wipe support (§26): server deregistration + browser unsubscribe. */
export async function wipePushRegistration() {
  await disablePush();
  try { await dbDelete(STORE, PUSH_REG_ID); } catch { /* store may be mid-clear */ }
  try { if (typeof localStorage !== 'undefined') localStorage.removeItem(LS_KEY_CACHE); } catch { /* ignore */ }
}

/**
 * Real-path test notification (§16): asks the SERVER to push a test message
 * through the full chain (server → web push → service worker → OS).
 * Returns { ok, via: 'push' | null, reason? } — no local fallback here; the
 * caller decides what to do when the push path fails.
 */
export async function sendTestPush() {
  const state = await currentPushState();
  if (state.status !== 'active' || !state.deviceKey) {
    return { ok: false, via: null, reason: 'not-registered' };
  }
  try {
    const res = await fetch(`${API_BASE()}/api/push/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceKey: state.deviceKey }),
    });
    if (res.ok) return { ok: true, via: 'push' };
    const data = await res.json().catch(() => ({}));
    return { ok: false, via: 'push', reason: data?.error || `server ${res.status}` };
  } catch (err) {
    return { ok: false, via: null, reason: `unreachable: ${err?.message || err}` };
  }
}
