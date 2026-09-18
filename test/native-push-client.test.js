/**
 * V2.0 Phase 3 — native iOS push client tests (js/nativePush.js).
 *
 * Spec §7/§8/§10/§12/§14 (registration contract, inertness, deep links),
 * following the browser-environment harness conventions of
 * test/push-capability.test.js: faithful globals installed onto globalThis,
 * fresh module import per scenario, full restoration afterwards.
 *
 * What CAN be tested without an iPhone:
 *  · web/PWA inertness — the hard requirement: on web, every entry point
 *    is a no-op, the Capacitor plugin is never imported, nothing is sent
 *  · platform gating (native-but-Android → explicit refusal, §18)
 *  · the registration body: platform:'ios' + token, NO endpoint/p256dh/auth (§8)
 *  · backend rejection → honest error state, never a fake 'active'
 *  · token rotation reuses ONE deviceKey (§8)
 *  · deep-link allowlist (§10)
 *  · diagnostics shape: booleans/states only — no tokens, no credentials (§12/§17)
 *
 * What CANNOT be tested here (requires a physical iPhone + Apple account,
 * per spec §9/§21.18): real APNs token issuance, OS delivery while
 * terminated/force-quit, cold-start tap routing. NOT claimed anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Browser-environment harness (same pattern as push-capability.test.js)
// ---------------------------------------------------------------------------

const REAL = {};
const GLOBAL_KEYS = ['window', 'navigator', 'location', 'indexedDB', 'crypto', 'IDBRequest', 'fetch', 'document', '__LP_PUSH_PLUGIN_OVERRIDE__'];

function takeGlobals() {
  for (const k of GLOBAL_KEYS) {
    REAL[k] = { value: globalThis[k], had: Object.prototype.hasOwnProperty.call(globalThis, k) };
    try { delete globalThis[k]; } catch { /* not configurable — leave */ }
  }
}

function restoreGlobals() {
  for ( const k of GLOBAL_KEYS) {
    try {
      if (REAL[k].had) globalThis[k] = REAL[k].value;
      else delete globalThis[k];
    } catch { /* keep going */ }
  }
}

/**
 * Minimal IndexedDB mock covering dbGet/dbPut on the notificationState store.
 * ONE instance per process: js/db.js caches its connection module-wide
 * (dbPromise), so scenarios SHARE this backing store — `records.clear()` at
 * scenario start keeps tests isolated. Transactions auto-complete on a
 * microtask, after db.js assigns tx.oncomplete.
 */
const idb = (() => {
  const records = new Map();
  const request = (result) => ({ result, error: null });
  const store = {
    get: (key) => request(records.has(key) ? structuredClone(records.get(key)) : undefined),
    put: (value) => { records.set(value.id, structuredClone(value)); return request(value.id); },
  };
  return {
    records,
    clear: () => records.clear(),
    open: () => {
      const req = {
        result: {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const tx = { oncomplete: null, onerror: null, onabort: null, objectStore: () => store };
            queueMicrotask(() => { if (tx.oncomplete) tx.oncomplete(); });
            return tx;
          },
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => { if (req.onsuccess) req.onsuccess(); });
      return req;
    },
  };
})();

/**
 * A controllable fake of @capacitor/push-notifications (spec §14: mocks only,
 * never the real plugin). Listeners are recorded so tests can fire events.
 */
function makePluginMock({ failRegister = false, token = 'a'.repeat(64) } = {}) {
  const listeners = {};
  const calls = { register: 0, checkPermissions: 0, requestPermissions: 0 };
  const plugin = {
    calls,
    listeners,
    addListener: (event, cb) => {
      (listeners[event] = listeners[event] || []).push(cb);
      return { remove: () => { listeners[event] = listeners[event].filter((f) => f !== cb); } };
    },
    checkPermissions: async () => {
      calls.checkPermissions += 1;
      return plugin.perm ?? { receive: 'granted' };
    },
    requestPermissions: async () => {
      calls.requestPermissions += 1;
      return { receive: plugin.perm ?? 'granted' };
    },
    register: async () => {
      calls.register += 1;
      if (failRegister) {
        for (const cb of listeners.registrationError || []) cb({ error: 'APNs not available in simulator' });
        return;
      }
      for (const cb of listeners.registration || []) cb({ value: plugin.token ?? token });
    },
    setForegroundPresentation: async () => { calls.foreground = true; },
  };
  return plugin;
}

/** Install a Capacitor-like native environment. Returns { fetchCalls }. */
function giveNativeEnv({ platform = 'ios', fetchFn } = {}) {
  idb.clear();
  const fetchCalls = [];
  const win = {
    LIFE_PROGRESS_PUSH_API: 'https://push.example.test',
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => platform,
    },
  };
  globalThis.navigator = { userAgent: 'CapacitorWebView iOS' };
  globalThis.location = { origin: 'https://app.example.test', hash: '' };
  win.location = globalThis.location; // the tap handler navigates via window.location.hash
  globalThis.window = win;
  globalThis.indexedDB = idb;
  globalThis.crypto = { randomUUID: () => 'test-uuid-key-0001' };
  globalThis.IDBRequest = function IDBRequest() {};
  // db.js resolves values via `request instanceof IDBRequest`; the mock's
  // request objects are plain objects, so make the instanceof check succeed.
  Object.defineProperty(globalThis.IDBRequest, Symbol.hasInstance, {
    value: () => true, configurable: true,
  });
  globalThis.fetch = fetchFn || (async (url, opts) => {
    fetchCalls.push({ url, opts: JSON.parse(opts?.body || '{}'), status: 200 });
    return { ok: true, status: 200, json: async () => ({ serverTime: 1_758_000_000_000 }) };
  });
  return { idb, fetchCalls };
}

async function withEnv(env, fn) {
  takeGlobals();
  try {
    const handles = giveNativeEnv(env);
    return await fn(handles);
  } finally {
    restoreGlobals();
  }
}

/** Fresh nativePush module per scenario + the injected plugin fake. */
async function importNativePush(pluginMock) {
  globalThis.__LP_PUSH_PLUGIN_OVERRIDE__ = { PushNotifications: pluginMock };
  return import('../js/nativePush.js?scenario=' + Math.random());
}

// ---------------------------------------------------------------------------
// Web/PWA inertness — the hard requirement (§7/§13)
// ---------------------------------------------------------------------------

test('WEB INERTNESS: on web every entry point is a no-op and nothing is sent', async () => {
  await withEnv({ platform: 'web' }, async ({ fetchCalls }) => {
    // Install a WEB (non-Capacitor) environment.
    globalThis.window = { LIFE_PROGRESS_PUSH_API: 'https://push.example.test' };
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);

    const perm = await m.requestNativePermission();
    assert.equal(perm.ok, false, 'permission request refuses on web');
    const reg = await m.registerNativePush();
    assert.equal(reg.ok, false, 'registration refuses on web');
    const sync = await m.syncNativePushRegistration({ enabled: true });
    assert.equal(sync.ok, false, 'sync refuses on web');
    const test = await m.sendNativeTestPush();
    assert.equal(test.ok, false, 'test push refuses on web');

    assert.equal(plugin.calls.register, 0, 'Capacitor plugin never registered');
    assert.equal(fetchCalls.length, 0, 'no network requests from web');
  });
});

test('WEB INERTNESS: attachNativeListenersOnce never attaches without the bridge', async () => {
  await withEnv({ platform: 'web' }, async () => {
    globalThis.window = { LIFE_PROGRESS_PUSH_API: 'https://push.example.test' };
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    m.attachNativeListenersOnce(); // must not throw, must not attach
    await new Promise((r) => setImmediate(r));
    assert.equal(Object.keys(plugin.listeners).length, 0);
  });
});

test('WEB INERTNESS: diagnostics on web report platform web, no probing', async () => {
  await withEnv({ platform: 'web' }, async () => {
    globalThis.window = { LIFE_PROGRESS_PUSH_API: 'https://push.example.test' };
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    const diag = await m.nativePushDiagnostics();
    assert.equal(diag.native, false);
    assert.equal(diag.platform, 'web');
    assert.equal(plugin.calls.checkPermissions, 0, 'no plugin probing on web');
  });
});

// ---------------------------------------------------------------------------
// Native iOS registration — the §8 contract
// ---------------------------------------------------------------------------

test('iOS registration: sends platform+token+timezone, NO endpoint/p256dh/auth (§8)', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    const result = await m.registerNativePush({ enabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.state.status, 'active');
    assert.equal(result.state.platform, 'ios');

    assert.equal(fetchCalls.length, 1, 'exactly one backend call');
    const body = fetchCalls[0].opts;
    assert.equal(fetchCalls[0].url, 'https://push.example.test/api/push/register');
    assert.equal(body.platform, 'ios');
    assert.equal(body.token, 'a'.repeat(64));
    assert.ok(body.deviceKey, 'deviceKey present');
    assert.ok(body.timezone, 'IANA timezone present');
    assert.equal('endpoint' in body, false, 'Web Push endpoint never sent for iOS');
    assert.equal('p256dh' in body, false, 'p256dh never sent for iOS');
    assert.equal('auth' in body, false, 'auth never sent for iOS');

    const tokenPromiseCbs = plugin.listeners.registration || [];
    assert.ok(Array.isArray(tokenPromiseCbs), 'one-shot listener cleaned up or scoped to registration flow');
  });
});

test('iOS registration: one-shot registration listeners are removed after success', async () => {
  await withEnv({}, async () => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    await m.registerNativePush({ enabled: true });
    // The one-shot listeners registered inside registerNativePush are removed;
    // only the persistent app-run listeners (attachNativeListenersOnce) remain.
    assert.equal((plugin.listeners.registration || []).length, 1, 'exactly the persistent rotation listener remains');
    assert.equal((plugin.listeners.registrationError || []).length, 0, 'one-shot error listener removed');
  });
});

test('iOS registration: backend rejection → honest error state, never fake active', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    const result = await m.registerNativePush({ enabled: true });
    assert.equal(result.ok, false);
    assert.equal(result.state.status, 'error');
    assert.match(result.reason, /403|forbidden/i);
    assert.notEqual(result.state.status, 'active');
  });
});

test('iOS registration: APNs registration failure → error state, no backend call', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    const plugin = makePluginMock({ failRegister: true });
    const m = await importNativePush(plugin);
    const result = await m.registerNativePush({ enabled: true });
    assert.equal(result.ok, false);
    assert.equal(result.state.status, 'error');
    assert.equal(fetchCalls.length, 0, 'no token → nothing sent to the backend');
  });
});

test('iOS registration: denied permission → denied state, no backend call', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    const plugin = makePluginMock();
    plugin.perm = { receive: 'denied' };
    const m = await importNativePush(plugin);
    const result = await m.registerNativePush({ enabled: true });
    assert.equal(result.ok, false);
    assert.equal(result.state.status, 'denied');
    assert.equal(fetchCalls.length, 0);
    assert.equal(plugin.calls.register, 0, 'never registers with APNs when denied');
  });
});

// ---------------------------------------------------------------------------
// Android out of scope (§18) — explicit refusal, no fake success
// ---------------------------------------------------------------------------

test('Android native shell refuses registration (FCM is Phase 4)', async () => {
  await withEnv({ platform: 'android' }, async ({ fetchCalls }) => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    const result = await m.registerNativePush({ enabled: true });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'platform-not-supported-yet');
    assert.equal(plugin.calls.register, 0, 'APNs never invoked on Android');
    assert.equal(fetchCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Token rotation — ONE deviceKey, token refresh updates in place (§8)
// ---------------------------------------------------------------------------

test('token rotation: persistent listener re-registers the SAME deviceKey with the new token', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    const first = await m.registerNativePush({ enabled: true });
    assert.equal(first.ok, true);
    const deviceKey = first.state.deviceKey;
    fetchCalls.length = 0;

    // OS refreshes the APNs token → persistent 'registration' listener fires.
    for (const cb of plugin.listeners.registration || []) await cb({ value: 'b'.repeat(64) });
    await new Promise((r) => setImmediate(r));

    assert.equal(fetchCalls.length, 1, 'rotation re-registered with the backend');
    assert.equal(fetchCalls[0].opts.deviceKey, deviceKey, 'SAME device identity');
    assert.equal(fetchCalls[0].opts.token, 'b'.repeat(64), 'NEW token sent');
    assert.equal(fetchCalls[0].opts.platform, 'ios');

    const state = await m.currentNativePushState();
    assert.equal(state.token, 'b'.repeat(64), 'local state holds the current token');
    assert.equal(state.deviceKey, deviceKey);
  });
});

test('token rotation: unchanged token does NOT trigger a backend call', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    await m.registerNativePush({ enabled: true });
    fetchCalls.length = 0;
    for (const cb of plugin.listeners.registration || []) await cb({ value: 'a'.repeat(64) });
    await new Promise((r) => setImmediate(r));
    assert.equal(fetchCalls.length, 0, 'no duplicate registration for the same token');
  });
});

test('syncNativePushRegistration: re-sends the CURRENT token + prefs on prefs change', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    await m.registerNativePush({ enabled: true });
    fetchCalls.length = 0;
    const r = await m.syncNativePushRegistration({ enabled: true, quietStart: '23:00' });
    assert.equal(r.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].opts.token, 'a'.repeat(64));
    assert.equal(fetchCalls[0].opts.quietStart, '23:00', 'updated prefs travel with the token');
  });
});

// ---------------------------------------------------------------------------
// Deep links (§10/§14.H)
// ---------------------------------------------------------------------------

test('deep link allowlist: app routes pass, everything else falls back safely', () => {
  // Direct unit test of the exported pure function (no native env needed).
  return withEnv({}, async () => {
    const m = await importNativePush(makePluginMock());
    const cases = [
      [{ data: { route: '#/water' } }, '#/water'],
      [{ data: { route: '#/achievements' } }, '#/achievements'],
      [{ data: { route: 'javascript:alert(1)' } }, '#/dashboard'],
      [{ data: {} }, '#/dashboard'],
      [undefined, '#/dashboard'],
    ];
    for (const [notification, expected] of cases) {
      assert.equal(m.routeFromNotification(notification), expected);
    }
  });
});

test('tap action: performed listener navigates via location.hash (§10)', async () => {
  await withEnv({}, async () => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    await m.registerNativePush({ enabled: true }); // attaches persistent listeners
    for (const cb of plugin.listeners.pushNotificationActionPerformed || []) {
      cb({ notification: { data: { route: '#/gym' } } });
    }
    assert.equal(globalThis.location.hash, '#/gym', 'tap navigated to the gym screen');
  });
});

// ---------------------------------------------------------------------------
// Foreground policy + test push + diagnostics (§11/§12/§24)
// ---------------------------------------------------------------------------

test('foreground presentation: plugin API invoked on iOS, no-op on web', async () => {
  await withEnv({}, async () => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    assert.equal(await m.setForegroundPresentation(), true);
    assert.equal(plugin.calls.foreground, true);
  });
  // Web case:
  await withEnv({ platform: 'web' }, async () => {
    globalThis.window = { LIFE_PROGRESS_PUSH_API: 'https://push.example.test' };
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    assert.equal(await m.setForegroundPresentation(), false);
    assert.notEqual(plugin.calls.foreground, true);
  });
});

test('sendNativeTestPush: real backend path when registered, honest refusal when not', async () => {
  await withEnv({}, async ({ fetchCalls }) => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    // Not registered yet → honest refusal, no call:
    const refused = await m.sendNativeTestPush();
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'not-registered');
    assert.equal(fetchCalls.length, 0);

    await m.registerNativePush({ enabled: true });
    fetchCalls.length = 0;
    const r = await m.sendNativeTestPush();
    assert.equal(r.ok, true);
    assert.equal(r.via, 'push', 'test goes through the real backend/APNs chain');
    assert.equal(fetchCalls[0].url, 'https://push.example.test/api/push/test');
    assert.equal(fetchCalls[0].opts.deviceKey, 'test-uuid-key-0001');
  });
});

test('diagnostics: booleans/states only — never a token, never credentials (§12/§17)', async () => {
  await withEnv({}, async () => {
    const plugin = makePluginMock();
    const m = await importNativePush(plugin);
    await m.registerNativePush({ enabled: true });
    const diag = await m.nativePushDiagnostics();
    const json = JSON.stringify(diag);
    assert.equal(json.includes('a'.repeat(64)), false, 'device token never in diagnostics');
    assert.equal(json.includes('test-uuid-key-0001'), false, 'deviceKey never in diagnostics');
    assert.equal(diag.tokenReceived, true, 'token presence as a BOOLEAN');
    assert.equal(diag.registration, 'active');
    assert.equal(diag.permission, 'granted');
    assert.equal(diag.pluginAvailable, true);
  });
});
