/**
 * Native push client — Capacitor + APNs (iOS, V2.0 Phase 3) + FCM (Android,
 * V2.0 Phase 5).
 *
 * Owns the native half of the notification boundary. Inert on web/PWA builds
 * (every entry point gates on js/platform.js — bridge detection only, no
 * user-agent sniffing); the web path (js/pushClient.js + service worker)
 * stays untouched and authoritative for browsers (§7/§13).
 *
 * Responsibilities (§5.3/§7):
 *  · request notification permission (only from an explicit user action)
 *  · register with the platform transport (APNs on iOS, FCM on Android) and
 *    receive the device token — Capacitor's plugin exposes BOTH through the
 *    same `registration` event; only the token's origin differs
 *  · register/update that token with the EXISTING backend contract
 *    (POST /api/push/register, platform:'ios'|'android', token — no
 *    endpoint/p256dh/auth) (§5.4)
 *  · handle token rotation (same deviceKey — never a duplicate identity, §5.5)
 *  · handle notification taps → existing hash deep links (§5.7/§10)
 *  · foreground presentation policy (§5.8/§11)
 *  · safe listener lifecycle: registered once per app run, never duplicated
 *
 * Delivery is OS-driven (APNs → iOS, FCM system-tray → Android): it does not
 * depend on this page being alive, and it does NOT use the service worker
 * (§5.9/§9). Honest-state rule from js/pushClient.js applies here too:
 * nothing claims 'registered' before the backend confirmed the token.
 */
import { isNative, getPlatform } from './platform.js';
import { dbGet, dbPut } from './db.js';
import { STORE } from './notifications.js';

const PUSH_REG_ID = 'pushReg'; // same record web push uses — one identity per device
const API_BASE = () => String(window.LIFE_PROGRESS_PUSH_API || '').replace(/\/+$/, '');

/** Native platforms this module supports (web never reaches these paths). */
export const NATIVE_PLATFORMS = ['ios', 'android'];

/** Persisted native push states (§12) — kept distinct from web states. */
export const NATIVE_STATES = ['off', 'active', 'pending', 'denied', 'unavailable', 'error'];

async function capPush() {
  // Test seam (same convention as the backend's sendPushMessage / deps.apns
  // injection): tests may inject a fake plugin module; production always
  // dynamic-imports the real package, which stays out of web bundles.
  if (globalThis.__LP_PUSH_PLUGIN_OVERRIDE__) return globalThis.__LP_PUSH_PLUGIN_OVERRIDE__;
  return import('@capacitor/push-notifications');
}

/**
 * The persisted native registration record. Shape mirrors the web pushReg
 * record (status/deviceKey/...) plus platform-specific fields. Web builds
 * never read or write it.
 */
export async function currentNativePushState() {
  try {
    const reg = await dbGet(STORE, PUSH_REG_ID);
    return reg || { id: PUSH_REG_ID, status: 'off' };
  } catch {
    return { id: PUSH_REG_ID, status: 'off' };
  }
}

async function saveNativePushState(patch) {
  const current = await currentNativePushState();
  const next = { ...current, ...patch, id: PUSH_REG_ID, updatedAt: Date.now() };
  await dbPut(STORE, next);
  return next;
}

/**
 * The one deviceKey for this device — shared with the web path so a user who
 * later uses both transports still has ONE device identity. Reuses an existing
 * key instead of minting a second one (§8).
 */
async function resolveDeviceKey() {
  const existing = await currentNativePushState();
  if (existing.deviceKey) return existing.deviceKey;
  // Same generation scheme as pushClient.getDeviceKey.
  const key = (crypto.randomUUID ? crypto.randomUUID() : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 48);
  return key;
}

// ---------------------------------------------------------------------------
// Registration — permission → token → backend (§7/§8)
// ---------------------------------------------------------------------------

/** Map Capacitor's permission state to the app's honest vocabulary. */
function mapPermission(state) {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'default'; // 'prompt' | 'prompt-with-rationale' → not yet asked
}

/** Ask the OS for notification permission. Only called from a user action. */
export async function requestNativePermission() {
  if (!isNative() || !NATIVE_PLATFORMS.includes(getPlatform())) {
    return { ok: false, reason: 'unavailable' };
  }
  const { PushNotifications } = await capPush();
  try {
    const result = await PushNotifications.checkPermissions();
    let perm = mapPermission(result?.receive);
    if (perm === 'default') {
      const requested = await PushNotifications.requestPermissions();
      perm = mapPermission(requested?.receive);
    }
    return { ok: perm === 'granted', reason: perm };
  } catch (err) {
    return { ok: false, reason: `error: ${err?.message || err}` };
  }
}

/**
 * Full native registration flow: permission must ALREADY be granted (or this
 * grants it via the toggle's explicit action), then platform registration
 * yields the token (APNs on iOS, FCM on Android) which is registered with
 * the existing backend endpoint.
 * Returns { ok, state, reason? } — never a fake 'active' (§12).
 */
export async function registerNativePush(prefs) {
  if (!isNative()) return { ok: false, state: await currentNativePushState(), reason: 'unavailable' };
  const platform = getPlatform();
  if (!NATIVE_PLATFORMS.includes(platform)) {
    // Unknown native platform — do not pretend registration works there.
    return { ok: false, state: await currentNativePushState(), reason: 'platform-not-supported-yet' };
  }
  try {
    const { PushNotifications } = await capPush();

    const permResult = await requestNativePermission();
    if (!permResult.ok) {
      const state = await saveNativePushState({ status: permResult.reason === 'denied' ? 'denied' : 'error', reason: permResult.reason });
      return { ok: false, state, reason: permResult.reason };
    }

    // addListener BEFORE register — the token can arrive quickly (§7).
    // Both one-shot listeners remove THEMSELVES and EACH OTHER on either
    // outcome, and the timeout is cleared — no leaks across enable/disable
    // cycles (§7).
    const tokenPromise = new Promise((resolve, reject) => {
      const t = PushNotifications.addListener('registration', (token) => {
        t.remove();
        e.remove();
        clearTimeout(timer);
        resolve(String(token?.value || ''));
      });
      const e = PushNotifications.addListener('registrationError', (err) => {
        e.remove();
        t.remove();
        clearTimeout(timer);
        reject(new Error(err?.error || 'push registration failed'));
      });
      // Safety valve: registration neither succeeds nor fails within 20 s.
      const timer = setTimeout(() => {
        t.remove();
        e.remove();
        reject(new Error('push registration timed out'));
      }, 20000);
    });

    await PushNotifications.register();

    const token = await tokenPromise;
    if (!token) throw new Error('empty push token');

    const deviceKey = await resolveDeviceKey();
    const registered = await registerTokenWithBackend(deviceKey, token, prefs, platform);

    const state = await saveNativePushState({
      status: 'active',
      platform,
      deviceKey,
      token,
      registeredAt: registered?.at || Date.now(),
      reason: null,
    });
    attachNativeListenersOnce(); // taps + token refresh for this app run
    return { ok: true, state };
  } catch (err) {
    const message = String(err?.message || err);
    const networkish = /unreachable|fetch|network|Failed to fetch|timed out/i.test(message);
    const state = await saveNativePushState({ status: networkish ? 'pending' : 'error', reason: message });
    return { ok: false, state, reason: message };
  }
}

/**
 * POST /api/push/register with the Phase 2 native contract — exactly the
 * fields validateRegistration() accepts for platform:'ios'|'android'. NO
 * endpoint, NO p256dh/auth (§5.4). Token rotation reuses the SAME deviceKey.
 */
async function registerTokenWithBackend(deviceKey, token, prefs, platform = 'ios') {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const res = await fetch(`${API_BASE()}/api/push/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceKey,
      platform,
      token,
      timezone: tz,
      categories: prefs?.categories,
      times: prefs?.times,
      quietStart: prefs?.quietStart,
      quietEnd: prefs?.quietEnd,
      enabled: prefs?.enabled !== false,
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
 * Current permission state WITHOUT prompting (settings display use).
 * 'granted' | 'denied' | 'default' | 'unavailable'.
 */
export async function nativePermissionState() {
  if (!isNative() || !NATIVE_PLATFORMS.includes(getPlatform())) return 'unavailable';
  try {
    const { PushNotifications } = await capPush();
    if (typeof PushNotifications.checkPermissions !== 'function') return 'unavailable';
    const perm = await PushNotifications.checkPermissions();
    return mapPermission(perm?.receive);
  } catch {
    return 'unavailable';
  }
}

/**
 * Real-path test notification for native (§24 of the master spec): asks the
 * SERVER to deliver a test through the registered transport (APNs) — the
 * same full chain scheduled reminders use. No local fallback faking it.
 */
export async function sendNativeTestPush() {
  const state = await currentNativePushState();
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

/** Re-send the CURRENT stored token + prefs (called when prefs change). */
export async function syncNativePushRegistration(prefs) {
  const platform = getPlatform();
  if (!isNative() || !NATIVE_PLATFORMS.includes(platform)) return { ok: false, reason: 'unavailable' };
  if (!prefs?.enabled) {
    await disableNativePush();
    return { ok: true, state: await currentNativePushState() };
  }
  const state = await currentNativePushState();
  if (state.status === 'active' && state.token && state.deviceKey) {
    try {
      await registerTokenWithBackend(state.deviceKey, state.token, prefs, state.platform || platform);
      return { ok: true, state };
    } catch (err) {
      return { ok: false, state, reason: String(err?.message || err) };
    }
  }
  // Not registered yet — an explicit enable action will run the full flow.
  return { ok: false, state, reason: 'not-registered' };
}

/** Best-effort disable: inform the backend, keep the local identity record. */
export async function disableNativePush() {
  try {
    const state = await currentNativePushState();
    if (state.deviceKey) {
      await fetch(`${API_BASE()}/api/push/unregister`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceKey: state.deviceKey }),
      }).catch(() => {});
    }
  } catch { /* best-effort */ }
  return saveNativePushState({ status: 'off', reason: null });
}

// ---------------------------------------------------------------------------
// Listeners — taps (deep links) + token refresh, exactly once (§7/§10)
// ---------------------------------------------------------------------------

let listenersAttached = false;

/**
 * Allowlist: a notification can never navigate outside the app's routes.
 * Exported for tests — the SAME route vocabulary the service worker's
 * notificationclick handler uses (js/swPush.js#routeFor).
 */
export function routeFromNotification(notification) {
  const route = notification?.data?.route;
  if (typeof route === 'string' && /^#\/[a-z]+$/.test(route)) return route;
  return '#/dashboard';
}

/**
 * Register the per-app-run listeners. `listenersAttached` guarantees one set
 * even if registration runs twice (enable → disable → enable).
 * Deep links reuse the SAME hash routes the web notificationclick handler
 * posts — no parallel routing system (§10).
 */
export function attachNativeListenersOnce() {
  if (listenersAttached || !isNative()) return;
  if (!NATIVE_PLATFORMS.includes(getPlatform())) return;
  listenersAttached = true;
  capPush().then(({ PushNotifications }) => {
    // Token rotation (§5.5): the OS may refresh the token (APNs on iOS,
    // FCM instance churn on Android); update the SAME device record.
    PushNotifications.addListener('registration', async (token) => {
      try {
        const state = await currentNativePushState();
        if (state.deviceKey && state.status === 'active' && token?.value && token.value !== state.token) {
          const prefsMod = await import('./notifications.js');
          const prefs = await prefsMod.getNotificationPrefs();
          await registerTokenWithBackend(state.deviceKey, String(token.value), prefs, state.platform || getPlatform());
          await saveNativePushState({ token: String(token.value) });
        }
      } catch { /* next boot re-syncs */ }
    });

    // Tap/action handling: foreground taps arrive here; background/cold-start
    // taps are delivered to the same event right after launch (§10).
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      // Foreground arrival (§5.8): on Android the Capacitor plugin presents
      // FCM foreground messages itself; on iOS setForegroundPresentation()
      // below controls it. Nothing else to do — the OS routed the payload.
      void notification;
    });
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      // Guarded: a tap handler must never throw (e.g. mid-teardown environments).
      try {
        const route = routeFromNotification(action?.notification);
        const loc = typeof window !== 'undefined' ? window?.location : undefined;
        if (loc) loc.hash = route;
      } catch { /* never break the app over a navigation */ }
    });
  }).catch(() => { listenersAttached = false; });
}

/**
 * Foreground presentation policy (§11): show iOS notifications while the app
 * is open — consistent with the PWA behavior where in-app reminders also
 * surface while the page is visible. Positive, non-guilt copy is already
 * guaranteed server-side (shared static copy), so we simply present.
 */
export async function setForegroundPresentation() {
  // iOS-specific API; on Android the plugin auto-presents foreground FCM
  // messages, so absence of this call is the correct behavior there (§5.8).
  if (!isNative() || getPlatform() !== 'ios') return false;
  try {
    const { PushNotifications } = await capPush();
    if (typeof PushNotifications.setForegroundPresentation === 'function') {
      await PushNotifications.setForegroundPresentation({ present: true });
      return true;
    }
  } catch { /* optional API — absence is fine */ }
  return false;
}

/**
 * Diagnostics (§12): everything the settings screen needs, honestly. Never
 * exposes tokens or credentials — booleans and states only.
 */
export async function nativePushDiagnostics() {
  const platform = getPlatform();
  const base = {
    platform,
    native: isNative(),
    transport: platform === 'ios' ? 'apns' : platform === 'android' ? 'fcm' : null,
    pluginAvailable: false,
    permission: 'unavailable',
    tokenReceived: false,
    registration: 'unknown',
    backendReachable: 'unknown',
  };
  if (!base.native || !NATIVE_PLATFORMS.includes(base.platform)) return base;
  const state = await currentNativePushState();
  base.registration = state.status || 'off';
  base.tokenReceived = Boolean(state.token);
  try {
    const { PushNotifications } = await capPush();
    base.pluginAvailable = true;
    if (typeof PushNotifications.checkPermissions === 'function') {
      const perm = await PushNotifications.checkPermissions();
      base.permission = mapPermission(perm?.receive);
    }
    try {
      const res = await fetch(`${API_BASE()}/api/push/status`, { method: 'GET' });
      base.backendReachable = res.ok ? 'reachable' : `http ${res.status}`;
    } catch {
      base.backendReachable = 'unreachable';
    }
  } catch { /* plugin missing — reported via pluginAvailable */ }
  return base;
}
