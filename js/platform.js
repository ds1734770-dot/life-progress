/**
 * Platform detection — the web/native boundary (V2.0 Phase 1).
 *
 * ONE tiny module every platform-aware decision goes through, so the app
 * keeps behaving identically in the browser/PWA and can branch cleanly
 * inside the native shells (docs/native-push-migration.md).
 *
 * Detection uses Capacitor's REAL runtime API — no user-agent sniffing:
 *  · Capacitor injects a global `window.Capacitor` bridge object into every
 *    page it serves (vanilla-JS apps are first-class; no framework needed).
 *  · `Capacitor.isNativePlatform()` reports whether we run inside a native
 *    shell, `Capacitor.getPlatform()` returns 'ios' | 'android' | 'web'.
 *  · In a plain browser NEITHER exists — the module falls back to 'web'
 *    without ever throwing, so importing this from the PWA is always safe.
 *
 * The bridge object is validated before use (shape checks, wrapped in try/
 * catch): a malformed or half-initialized `window.Capacitor` — or anything
 * else that happens to occupy that global — can never crash the app. When
 * validation fails we treat the environment as the web PWA, which is the
 * honest default: every existing browser behavior stays intact.
 */

/** Names Capacitor's runtime can report. 'web' = the normal browser/PWA. */
const PLATFORMS = ['ios', 'android', 'web'];

/**
 * Read and validate the Capacitor bridge, if one is actually present.
 * Returns null when the runtime is absent or malformed — never throws.
 * No user-agent sniffing anywhere: only the real bridge object is trusted.
 */
function capacitorBridge() {
  try {
    if (typeof window === 'undefined' || !window.Capacitor) return null;
    const cap = window.Capacitor;
    if (typeof cap !== 'object' && typeof cap !== 'function') return null;
    if (typeof cap.isNativePlatform !== 'function') return null;
    if (cap.isNativePlatform() !== true) return null; // e.g. Capacitor dev server
    return cap;
  } catch {
    return null; // getter threw, method threw, proxy misbehaved — plain browser
  }
}

/**
 * True when running inside a native (iOS/Android) Capacitor shell.
 * In any browser/PWA environment this is false. Never throws — a bridge
 * that explodes on invocation is treated as "no usable bridge".
 * @returns {boolean}
 */
export function isNative() {
  return capacitorBridge() !== null;
}

/**
 * The current platform: 'ios' | 'android' when native, 'web' otherwise
 * (browser, PWA, or Capacitor's own web preview). Unknown/invalid bridge
 * answers degrade to 'web' rather than inventing a platform.
 * @returns {'web'|'ios'|'android'}
 */
export function getPlatform() {
  const cap = capacitorBridge();
  if (!cap) return 'web';
  try {
    const p = cap.getPlatform();
    return PLATFORMS.includes(p) ? p : 'web';
  } catch {
    return 'web';
  }
}

/**
 * Convenience alias for the platform module tests and future platform-aware
 * callers: a stable snapshot of both answers.
 * @returns {{ native: boolean, platform: 'web'|'ios'|'android' }}
 */
export function platformInfo() {
  return { native: isNative(), platform: getPlatform() };
}
