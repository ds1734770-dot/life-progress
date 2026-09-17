/**
 * V1.6.1 — capability detection tests (js/pushClient.js).
 *
 * Regression suite for the false-"unsupported" bug: the original check
 * `'PushManager' in ServiceWorkerRegistration.prototype` was ALWAYS false
 * (the prototype property is the camelCase accessor `pushManager`), so every
 * browser — Chrome and iPhone included — was told "This browser doesn't
 * support background push."
 *
 * These tests install faithful browser-like globals onto globalThis, import
 * the module fresh per scenario, then restore the originals. Node 24's
 * built-in `navigator` is configurable, so the swap works — exactly what we
 * need to emulate Chrome desktop, iOS Safari tab and iOS Home Screen PWA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-environment harness
// ---------------------------------------------------------------------------

const REAL = {};
const GLOBAL_KEYS = ['window', 'navigator', 'ServiceWorkerRegistration', 'Notification', 'PushManager', 'location', 'document'];

function takeGlobals() {
  for (const k of GLOBAL_KEYS) {
    REAL[k] = { value: globalThis[k], had: Object.prototype.hasOwnProperty.call(globalThis, k) };
    try { delete globalThis[k]; } catch { /* not configurable — leave */ }
  }
}

function giveGlobals(env) {
  const overlay = {
    isSecureContext: env.secure !== false,
    matchMedia: (q) => ({ matches: Boolean(env.displayMode && q.includes(`display-mode: ${env.displayMode}`)) }),
  };
  // In a real browser `window` IS the global object, so `"Notification" in
  // window` and `"PushManager" in window` hold. Emulate that with a Proxy
  // over globalThis with a small per-scenario overlay on top.
  globalThis.window = new Proxy(globalThis, {
    get: (t, p) => (p in overlay ? overlay[p] : t[p]),
    has: (t, p) => p in overlay || p in t,
  });
  // NOTE: `'serviceWorker' in navigator` is true even for an undefined
  // value — when the API is absent the KEY must be omitted entirely (that's
  // also exactly what old browsers do). Present unless explicitly disabled;
  // when present it mocks a browser with no registration yet.
  globalThis.navigator = {
    ...(env.serviceWorkerApi !== false
      ? { serviceWorker: { getRegistration: async () => env.swRegistration ?? undefined } }
      : {}),
    userAgent: env.ua ?? 'Mozilla/5.0 (Macintosh) Chrome/126',
    standalone: Boolean(env.navigatorStandalone),
    platform: env.platform ?? 'Win32',
    maxTouchPoints: env.touch ?? 0,
  };
  const SWR = function ServiceWorkerRegistration() {};
  if (env.registrationHasPushManager !== false) {
    Object.defineProperty(SWR.prototype, 'pushManager', { value: null, configurable: true });
  }
  globalThis.ServiceWorkerRegistration = SWR;
  if (env.notificationApi !== false) {
    globalThis.Notification = function Notification() {};
    globalThis.Notification.permission = env.permission ?? 'default'; // static, as in real browsers
  }
  if (env.pushCtor) globalThis.PushManager = function PushManager() {};
  globalThis.location = { origin: env.origin ?? 'https://life-progress.example' };
  // V1.6.5 — Page Visibility API (used by the iOS terminated-PWA detection).
  // Only injected when the scenario asks for it, so the harness can also
  // exercise the no-document fallback branch.
  if (env.document) globalThis.document = env.document;
}

function restoreGlobals() {
  for (const k of GLOBAL_KEYS) {
    try {
      if (REAL[k].had) globalThis[k] = REAL[k].value;
      else delete globalThis[k];
    } catch { /* keep going */ }
  }
}

async function withBrowser(env, fn) {
  takeGlobals();
  try {
    giveGlobals(env);
    // Fresh module instance per scenario so module-scope assumptions can't leak.
    const mod = await import('../js/pushClient.js');
    return await fn(mod);
  } finally {
    restoreGlobals();
  }
}

// ---------------------------------------------------------------------------
// The regression: Chrome must never be "unsupported"
// ---------------------------------------------------------------------------

test('REGRESSION: Chrome-like environment is capability-ready (not unsupported)', async () => {
  await withBrowser({ pushCtor: true }, (m) => {
    const caps = m.pushCapabilities();
    assert.equal(caps.secure, true);
    assert.equal(caps.swSupported, true);
    assert.equal(caps.notifSupported, true);
    assert.equal(caps.pushSupported, true, 'Chrome must be detected as push-capable');
    assert.equal(m.capabilityBlocker(caps), null);
  });
});

test('REGRESSION: old check was always false — the corrected one is true', async () => {
  // Documents the bug itself so nobody reintroduces it.
  const ChromeLikeProto = {};
  Object.defineProperty(ChromeLikeProto, 'pushManager', { value: null });
  assert.equal('PushManager' in ChromeLikeProto, false, 'old check: always false (the bug)');
  assert.equal('pushManager' in ChromeLikeProto, true, 'new check: camelCase accessor');
});

test('iPhone Home Screen PWA (standalone) is capability-ready', async () => {
  await withBrowser({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    navigatorStandalone: true,
    pushCtor: false, // Safari exposes the accessor; the constructor need not be present
  }, (m) => {
    const caps = m.pushCapabilities();
    assert.equal(caps.ios, true);
    assert.equal(caps.standalone, true, 'navigator.standalone must detect iOS Home Screen');
    assert.equal(caps.pushSupported, true);
    assert.equal(m.capabilityBlocker(caps), null);
  });
});

test('iPhone Safari TAB is not a capability failure — it is install-required', async () => {
  await withBrowser({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    navigatorStandalone: false,
  }, (m) => {
    const caps = m.pushCapabilities();
    assert.equal(caps.ios, true);
    assert.equal(caps.standalone, false);
    const blocker = m.capabilityBlocker(caps);
    assert.ok(blocker, 'iOS tab must be blocked from subscribing');
    assert.equal(blocker.state, 'install-required');
    assert.match(blocker.reason, /Home Screen/i);
    assert.match(blocker.hint, /Add to Home Screen/i);
  });
});

test('iPadOS (reports as Mac with touch) standalone detection', async () => {
  await withBrowser({
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15',
    platform: 'MacIntel',
    touch: 5,
    navigatorStandalone: true,
  }, (m) => {
    const caps = m.pushCapabilities();
    assert.equal(caps.ios, true, 'iPadOS 13+ masquerades as MacIntel + touch');
    assert.equal(caps.standalone, true);
    assert.equal(m.capabilityBlocker(caps), null);
  });
});

test('display-mode: standalone via matchMedia is detected', async () => {
  await withBrowser({ displayMode: 'standalone' }, (m) => {
    assert.equal(m.pushCapabilities().standalone, true);
  });
});

test('insecure context → insecure blocker, not unsupported', async () => {
  await withBrowser({ secure: false, pushCtor: true }, (m) => {
    const blocker = m.capabilityBlocker(m.pushCapabilities());
    assert.equal(blocker.state, 'insecure');
    assert.match(blocker.reason, /secure/i);
  });
});

test('no service worker API → unsupported', async () => {
  await withBrowser({ serviceWorkerApi: false, pushCtor: true }, (m) => {
    const blocker = m.capabilityBlocker(m.pushCapabilities());
    assert.equal(blocker.state, 'unsupported');
  });
});

test('no Notification API → unsupported', async () => {
  await withBrowser({ notificationApi: false }, (m) => {
    const blocker = m.capabilityBlocker(m.pushCapabilities());
    assert.equal(blocker.state, 'unsupported');
  });
});

test('no Push API anywhere → unsupported (honest)', async () => {
  await withBrowser({ registrationHasPushManager: false }, (m) => {
    const blocker = m.capabilityBlocker(m.pushCapabilities());
    assert.equal(blocker.state, 'unsupported');
    assert.match(blocker.reason, /doesn’t support background push/);
  });
});

test('readiness probe separates capability from setup state (§5)', async () => {
  await withBrowser({ pushCtor: true }, async (m) => {
    const ready = await m.pushReadiness();
    // A supported browser with NO subscription yet must not read "unsupported":
    assert.equal(ready.pushApi, true);
    assert.equal(ready.subscription, 'none');
    assert.equal(ready.serviceWorker, 'unavailable', 'no registration in this mock — observed honestly');
    assert.equal(ready.notificationPermission, 'default');
    // The important structural property: readiness is a detailed object, not one boolean.
    for (const key of ['secureContext', 'serviceWorkerApi', 'pushApi', 'notificationPermission', 'subscription', 'serverRegistration', 'vapid', 'backgroundReminders']) {
      assert.ok(key in ready, `readiness exposes ${key}`);
    }
  });
});

// ---------------------------------------------------------------------------
// V1.6.5 — iOS terminated-PWA lifecycle detection (closed-app push failure)
// ---------------------------------------------------------------------------

test('pushCapabilities: pageVisible is true when the document is visible', async () => {
  await withBrowser({ pushCtor: true, document: { visibilityState: 'visible' } }, (m) => {
    const caps = m.pushCapabilities();
    assert.equal(caps.pageVisible, true);
  });
});

test('pushCapabilities: pageVisible is false when the document is hidden', async () => {
  await withBrowser({ pushCtor: true, document: { visibilityState: 'hidden' } }, (m) => {
    assert.equal(m.pushCapabilities().pageVisible, false);
  });
});

test('pushCapabilities: pageVisible is false when document is absent (SW/global fallback)', async () => {
  await withBrowser({ pushCtor: true }, (m) => {
    assert.equal(m.pushCapabilities().pageVisible, false, 'no document in the harness → treated as not-foreground');
  });
});

test('REGRESSION: iPhone Home Screen PWA, app terminated (hidden) → ios-terminated blocker', async () => {
  await withBrowser({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    navigatorStandalone: true,
    pushCtor: false,
    document: { visibilityState: 'hidden' },
  }, (m) => {
    const blocker = m.iosLifecycleBlocker();
    assert.ok(blocker, 'terminated state must be diagnosed');
    assert.equal(blocker.state, 'ios-terminated');
    assert.match(blocker.reason, /swiped away/i);
    assert.match(blocker.hint, /app switcher/i);
    assert.ok(!blocker.hint.match(/unsupported/i), 'never mislabels the platform as unsupported');
  });
});

test('iPhone Home Screen PWA in the foreground → NO lifecycle blocker', async () => {
  await withBrowser({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    navigatorStandalone: true,
    pushCtor: false,
    document: { visibilityState: 'visible' },
  }, (m) => {
    assert.equal(m.iosLifecycleBlocker(), null);
  });
});

test('iPhone Safari TAB hidden → still install-required, NOT ios-terminated', async () => {
  await withBrowser({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    navigatorStandalone: false,
    document: { visibilityState: 'hidden' },
  }, (m) => {
    assert.equal(m.iosLifecycleBlocker(), null, 'tabs were never subscribed — install-required already covers them');
    const blocker = m.capabilityBlocker(m.pushCapabilities());
    assert.equal(blocker.state, 'install-required');
  });
});

test('Desktop Chrome hidden → NO lifecycle blocker (macOS Safari push has no such limit)', async () => {
  await withBrowser({ pushCtor: true, document: { visibilityState: 'hidden' } }, (m) => {
    assert.equal(m.iosLifecycleBlocker(), null);
  });
});

test('readiness probe exposes pageVisible + iosLifecycle (diagnostics UI fields)', async () => {
  await withBrowser({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15',
    navigatorStandalone: true,
    pushCtor: false,
    document: { visibilityState: 'hidden' },
  }, async (m) => {
    const ready = await m.pushReadiness();
    assert.equal(ready.pageVisible, false);
    assert.equal(ready.iosLifecycle, 'ios-terminated');
  });
});
