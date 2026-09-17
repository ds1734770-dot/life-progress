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

export const PUSH_STATES = ['off', 'active', 'pending', 'denied', 'unsupported', 'insecure', 'install-required', 'error'];

// ---------------------------------------------------------------------------
// Capability detection (§23/§30) — feature detection only, no UA sniffing.
//
// V1.6.1 FIX: the original check tested `'PushManager' in
// ServiceWorkerRegistration.prototype` — but the prototype's property is the
// camelCase instance accessor `pushManager`. There is no `PushManager` on the
// prototype, so that test was false in EVERY browser, and Chrome + iPhone
// were both wrongly reported as "This browser doesn't support background
// push." The authoritative check is `registration.pushManager` (a property of
// the actual ServiceWorkerRegistration instance); the prototype check is kept
// only as an early, correctly-spelled signal.
// ---------------------------------------------------------------------------

export function pushCapabilities() {
  const secure = typeof window !== 'undefined' && window.isSecureContext === true;
  const swSupported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const notifSupported = typeof window !== 'undefined' && 'Notification' in window;
  // Push API presence: the registration-side accessor is authoritative, the
  // prototype check is a cheap early signal, the window constructor is
  // informative only. ANY of the first two is sufficient (§30 — standards
  // first; Safari pre-16.4 lacks the constructor but post-16.4 standalone
  // apps expose the accessor).
  const protoHasPush = typeof ServiceWorkerRegistration !== 'undefined' &&
    'pushManager' in ServiceWorkerRegistration.prototype;
  const pushSupported = swSupported && notifSupported &&
    protoHasPush &&
    (typeof PushManager !== 'undefined' || protoHasPush);
  // Standalone/installation display-mode detection (§8) — feature-based:
  // matchMedia covers standard manifests; navigator.standalone covers iOS
  // Home Screen web apps (Safari-only legacy flag).
  const standalone =
    (typeof window !== 'undefined' && (
      window.matchMedia?.('(display-mode: standalone)')?.matches ||
      window.matchMedia?.('(display-mode: fullscreen)')?.matches ||
      window.matchMedia?.('(display-mode: minimal-ui)')?.matches
    )) ||
    (typeof navigator !== 'undefined' && navigator.standalone === true);
  // iOS/iPadOS only delivers background Web Push to INSTALLED Home Screen
  // web apps (16.4+). Purely diagnostic — never used to disable features.
  // (iPadOS 13+ reports itself as desktop Safari — the MacIntel + touch
  // points check catches that; short-circuits are ordered to stay safe when
  // navigator is absent entirely.)
  const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  const ios = /iPad|iPhone|iPod/.test(ua) ||
    (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && (navigator.maxTouchPoints | 0) > 1);
  // V1.6.5 — iOS lifecycle diagnostic. When a Home Screen web app is
  // force-terminated (swiped away from the app switcher), WebKit stops
  // handing pushes to it: webpushd has no live app process to wake, and iOS
  // does not relaunch terminated web apps for push (WebKit bug 258254).
  // There is no direct API for "was I terminated", but the page-visible
  // flag is a reliable signal for the FOREGROUND state: a resumed app is
  // still page-visible, while one that was reaped (or re-launched) is not.
  // In-app reminders run from the interval sweep regardless — this is
  // purely diagnostic (see iosLifecycleBlocker).
  const pageVisible = typeof document !== 'undefined'
    ? document.visibilityState === 'visible'
    : false;
  return { secure, swSupported, notifSupported, pushSupported, standalone, ios, protoHasPush, pageVisible };
}

/**
 * V1.6.5 — the one platform limitation this app cannot engineer away, made
 * explicit and user-visible (the opposite of a fake success claim):
 *
 * On iOS/iPadOS, background Web Push delivery requires the web app's
 * process. WebKit hands an incoming push to webpushd, which wakes the
 * application to run its service worker (webkit.org/blog/12979). When the
 * Home Screen web app is force-terminated from the app switcher, there is
 * no process to wake — iOS does NOT relaunch it — so scheduled reminders
 * cannot arrive until the app is opened again. Backgrounded-but-alive
 * (Recents, locked) keeps working.
 *
 * Returns a blocker ONLY for the diagnosed foreground state of an installed
 * iOS PWA (pageVisible === false). Browser tabs are unaffected: Safari on
 * macOS/Linux/Windows has no such limitation, and on iOS the tab was never
 * install-required in the first place. In-app reminders still fire from the
 * page's interval sweep — the UI says exactly that.
 */
export function iosLifecycleBlocker(caps = pushCapabilities()) {
  if (!caps.ios || !caps.standalone) return null;
  if (caps.pageVisible !== false) return null; // foreground or undetectable — no claim
  return {
    state: 'ios-terminated',
    reason: 'iOS stops background delivery while Life Progress is swiped away from the app switcher.',
    hint: 'Keep Life Progress in the app switcher (just lock the screen or go Home). Reminders resume when you reopen the app. This is an iOS limitation for web apps.',
  };
}

/**
 * Capability vs readiness are DIFFERENT concepts (§5):
 *  · capability  — can THIS browser ever do background push? (static facts)
 *  · readiness   — which setup step is the user at right now? (dynamic)
 * A supported browser with no subscription yet must read "Ready to set up",
 * never "unsupported".
 */
export function capabilityBlocker(caps = pushCapabilities()) {
  if (!caps.swSupported) return { state: 'unsupported', reason: 'This browser has no service worker support.' };
  if (!caps.notifSupported) return { state: 'unsupported', reason: 'This browser has no notification support.' };
  if (!caps.secure) return { state: 'insecure', reason: 'Background reminders need a secure (https or localhost) connection.' };
  if (!caps.pushSupported) return { state: 'unsupported', reason: 'This browser doesn’t support background push.' };
  // iOS/iPadOS: background push requires the installed Home Screen web app.
  if (caps.ios && !caps.standalone) {
    return {
      state: 'install-required',
      reason: 'Install Life Progress on your Home Screen to enable background reminders.',
      hint: 'In Safari, tap Share → “Add to Home Screen”, then open Life Progress from the Home Screen icon and enable reminders there.',
    };
  }
  // V1.6.5 — while the app is NOT foreground, tell the truth about the
  // terminated-PWA limitation. Deliberately returned as a SECOND return:
  // `syncPushRegistration` treats any blocker as not-subscribable, and the
  // subscription itself is already active at this point — this signal is
  // diagnostic-only and reaches the user via deliveryStatusFor() below.
  return null;
}

/**
 * Persist a capability blocker as the current push state — used by the
 * settings toggle when enabling is blocked (e.g. iOS Safari tab) so the UI
 * reflects the real situation on next render.
 */
export async function saveBlockerState(blocker) {
  if (!blocker) return currentPushState();
  return savePushState({ status: blocker.state, reason: blocker.reason || null, hint: blocker.hint || null });
}

/** @deprecated legacy single-boolean gate — kept for one release, now only
 * reports TRUE capability blockers (never conflates setup readiness). */
export function unsupportedReason(caps = pushCapabilities()) {
  const blocker = capabilityBlocker(caps);
  return blocker ? blocker.reason : null;
}

// ---------------------------------------------------------------------------
// Readiness probe (§4/§5/§29) — every setup stage observed separately, for
// the UI and for the on-device diagnostic report. Pure observation: changes
// nothing, prompts nothing.
// ---------------------------------------------------------------------------

/**
 * Classify a GET /api/push/vapid-public response (pure — unit-tested).
 * Distinguishes the three failure families the UI must never conflate:
 *  · HTTP with HTML body → a STATIC host answered (its 404 page): backend
 *    simply is not deployed at this origin.
 *  · HTTP with non-2xx API answer → backend present but unhappy.
 *  · thrown fetch → refused connection / CORS / DNS — a different problem.
 */
export function classifyServerProbe({ gotHttpResponse, ok, status, contentType, errorMessage }) {
  if (gotHttpResponse && ok) return { vapid: 'reachable', staticHostSuspected: false, vapidReason: null };
  if (gotHttpResponse) {
    const staticHost = /text\/html/i.test(contentType || '');
    return {
      vapid: `http ${status}`,
      serverHttpStatus: status,
      staticHostSuspected: staticHost,
      vapidReason: staticHost
        ? 'No notification server at this origin — the backend is not deployed here (static hosting).'
        : null,
    };
  }
  return { vapid: 'unreachable', serverHttpStatus: null, staticHostSuspected: false, serverError: String(errorMessage || '') };
}

export async function pushReadiness() {
  const caps = pushCapabilities();
  const r = {
    secureContext: caps.secure,
    origin: typeof location !== 'undefined' ? location.origin : null,
    serviceWorkerApi: caps.swSupported,
    notificationsApi: caps.notifSupported,
    pushApi: caps.pushSupported,
    notificationPermission: caps.notifSupported && typeof Notification !== 'undefined' ? Notification.permission : 'unavailable',
    standalone: caps.standalone,
    ios: caps.ios || false,
    serviceWorker: 'unavailable',
    serviceWorkerScope: null,
    swActive: false, swWaiting: false, swInstalling: false,
    pushManagerOnRegistration: false,
    subscription: 'none',
    subscriptionError: null,
    serverRegistration: 'unknown',
    vapid: 'unknown',
    serverHttpStatus: null,
    staticHostSuspected: false,
    backgroundReminders: 'off',
    // V1.6.5 — iOS terminated-PWA diagnostic, always present (even in SW or
    // no-registration environments where pushReadiness returns early).
    pageVisible: caps.pageVisible,
    iosLifecycle: iosLifecycleBlocker(caps)?.state || null,
  };
  if (!caps.swSupported) return r;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return r;
    r.serviceWorker = 'registered';
    r.serviceWorkerScope = reg.scope || null;
    r.swActive = !!reg.active;
    r.swWaiting = !!reg.waiting;
    r.swInstalling = !!reg.installing;
    r.pushManagerOnRegistration = !!reg.pushManager;
    const sub = reg.pushManager ? await reg.pushManager.getSubscription().catch((err) => {
      r.subscriptionError = String(err?.name || 'Error') + ': ' + String(err?.message || err);
      return null;
    }) : null;
    r.subscription = sub ? 'active' : 'none';
  } catch (err) {
    r.serviceWorker = 'error';
    r.subscriptionError = r.subscriptionError || (String(err?.name || 'Error') + ': ' + String(err?.message || err));
  }
  try {
    const pushState = await currentPushState();
    r.serverRegistration = pushState?.deviceKey && pushState?.status === 'active' ? 'registered' : pushState?.status === 'pending' ? 'pending' : 'none';
    r.backgroundReminders = pushState?.status || 'off';
  } catch { /* keep defaults */ }
  // Defaults — probe results are merged in below (§27).
  r.serverHttpStatus = null;
  r.staticHostSuspected = false;
  r.vapidReason = null;
  r.apiBase = API_BASE() || '(same origin)';
  try {
    const res = await fetch(`${API_BASE()}/api/push/vapid-public`, { method: 'GET' });
    Object.assign(r, classifyServerProbe({
      gotHttpResponse: true,
      ok: res.ok,
      status: res.status,
      contentType: res.headers?.get ? (res.headers.get('content-type') || '') : '',
    }));
  } catch (err) {
    Object.assign(r, classifyServerProbe({ gotHttpResponse: false, errorMessage: err?.message || err }));
  }
  return r;
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
  const blocker = capabilityBlocker(caps);
  if (blocker) {
    const state = await savePushState({ status: blocker.state, reason: blocker.reason, hint: blocker.hint || null });
    return { ok: false, state, reason: blocker.reason };
  }
  if (Notification.permission !== 'granted') {
    const state = await savePushState({ status: 'denied', reason: 'Notification permission not granted.' });
    return { ok: false, state, reason: state.reason };
  }

  try {
    // Ensure a service worker is registered AND activated before touching
    // PushManager (§10) — navigator.serviceWorker.ready resolves only once
    // an active worker controls (or is waiting to control) this page.
    if (!('serviceWorker' in navigator)) throw new Error('serviceWorker unavailable');
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) throw new Error('PushManager unavailable on this registration');

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
    if (state.status !== 'off' && state.status !== 'unsupported' && state.status !== 'insecure' && state.status !== 'install-required') {
      await disablePush();
    }
    return { ok: true, state: await currentPushState() };
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    return { ok: false, state: await savePushState({ status: 'denied', reason: 'Notifications are blocked in browser settings.' }) };
  }
  const caps = pushCapabilities();
  const blocker = capabilityBlocker(caps);
  if (blocker) {
    return { ok: false, state: await savePushState({ status: blocker.state, reason: blocker.reason, hint: blocker.hint || null }) };
  }
  if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
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
