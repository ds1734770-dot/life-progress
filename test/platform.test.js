/**
 * Platform detection tests (V2.0 Phase 1) — js/platform.js.
 *
 * Covers the six required cases (§17):
 *   1. Browser environment (no Capacitor at all)
 *   2. Capacitor unavailable / window missing
 *   3. Native iOS environment
 *   4. Native Android environment
 *   5. Malformed / hostile Capacitor objects
 *   6. Safe import in a normal browser
 *
 * The Capacitor runtime is MOCKED via `globalThis.window.Capacitor` — the
 * same bridge object the real native shell injects. No device is needed:
 * the module's contract is "validate the bridge, answer honestly, never
 * throw", and that is exactly what these tests pin down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

let restoreWindow = null;
let restoreDocument = null;

/** Load a fresh copy of the module with the given window/document globals. */
async function loadPlatform({ window: win, document: doc } = {}) {
  if (win === undefined) delete globalThis.window;
  else globalThis.window = win;
  if (doc === undefined) delete globalThis.document;
  else globalThis.document = doc;
  const mod = await import(`../js/platform.js?case=${Math.random().toString(36).slice(2)}`);
  return mod;
}

test.beforeEach(() => {
  restoreWindow = globalThis.window;
  restoreDocument = globalThis.document;
});

test.afterEach(() => {
  if (restoreWindow === undefined) delete globalThis.window;
  else globalThis.window = restoreWindow;
  if (restoreDocument === undefined) delete globalThis.document;
  else globalThis.document = restoreDocument;
});

// ---------------------------------------------------------------------------
// 1. Browser environment — the normal PWA case
// ---------------------------------------------------------------------------

test('browser without Capacitor: not native, platform web', async () => {
  const m = await loadPlatform({ window: {}, document: {} });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
  assert.deepEqual(m.platformInfo(), { native: false, platform: 'web' });
});

test('browser with unrelated Capacitor-shaped noise but no runtime methods: web', async () => {
  const m = await loadPlatform({ window: { Capacitor: { somePlugin: true } }, document: {} });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
});

// ---------------------------------------------------------------------------
// 2. Capacitor unavailable — missing window, missing globals
// ---------------------------------------------------------------------------

test('no window at all (SSR/test harness): web, never throws', async () => {
  const m = await loadPlatform({ window: undefined, document: undefined });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
});

test('Capacitor explicitly undefined/null on window: web', async () => {
  const a = await loadPlatform({ window: { Capacitor: undefined }, document: {} });
  const b = await loadPlatform({ window: { Capacitor: null }, document: {} });
  assert.equal(a.getPlatform(), 'web');
  assert.equal(b.getPlatform(), 'web');
});

// ---------------------------------------------------------------------------
// 3./4. Native iOS / Android environments — the real bridge contract
// ---------------------------------------------------------------------------

test('Capacitor iOS bridge: native, platform ios', async () => {
  const m = await loadPlatform({
    window: { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' } },
    document: {},
  });
  assert.equal(m.isNative(), true);
  assert.equal(m.getPlatform(), 'ios');
  assert.deepEqual(m.platformInfo(), { native: true, platform: 'ios' });
});

test('Capacitor Android bridge: native, platform android', async () => {
  const m = await loadPlatform({
    window: { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } },
    document: {},
  });
  assert.equal(m.isNative(), true);
  assert.equal(m.getPlatform(), 'android');
  assert.deepEqual(m.platformInfo(), { native: true, platform: 'android' });
});

test('bridge reporting web (Capacitor dev server): not native, platform web', async () => {
  const m = await loadPlatform({
    window: { Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' } },
    document: {},
  });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
});

// ---------------------------------------------------------------------------
// 5. Malformed / hostile Capacitor objects — must degrade to web, never throw
// ---------------------------------------------------------------------------

test('bridge without isNativePlatform: web', async () => {
  const m = await loadPlatform({
    window: { Capacitor: { getPlatform: () => 'ios' } }, // method missing
    document: {},
  });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
});

test('bridge where isNativePlatform is not a function: web', async () => {
  const m = await loadPlatform({
    window: { Capacitor: { isNativePlatform: true, getPlatform: () => 'ios' } },
    document: {},
  });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
});

test('bridge whose methods throw: web, never throws', async () => {
  const m = await loadPlatform({
    window: {
      Capacitor: {
        isNativePlatform: () => { throw new Error('bridge exploded'); },
        getPlatform: () => { throw new Error('bridge exploded'); },
      },
    },
    document: {},
  });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
});

test('bridge returning a bogus platform string: degrades to web', async () => {
  const m = await loadPlatform({
    window: { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'windows-phone' } },
    document: {},
  });
  assert.equal(m.isNative(), true); // native bridge IS present...
  assert.equal(m.getPlatform(), 'web'); // ...but the name is not one of ours
});

test('hostile window with throwing Capacitor getter: web, never throws', async () => {
  const m = await loadPlatform({
    window: Object.create(null, {
      Capacitor: { get() { throw new Error('no peeking'); } },
    }),
    document: {},
  });
  assert.equal(m.isNative(), false);
  assert.equal(m.getPlatform(), 'web');
});

// ---------------------------------------------------------------------------
// 6. Safe import in a normal browser — import must never throw and the
//    module must not touch IndexedDB, fetch, or anything browser-hostile.
// ---------------------------------------------------------------------------

test('module imports cleanly in a browser-like environment', async () => {
  const m = await loadPlatform({ window: {}, document: {} });
  assert.equal(typeof m.isNative, 'function');
  assert.equal(typeof m.getPlatform, 'function');
  assert.equal(typeof m.platformInfo, 'function');
  assert.equal(m.getPlatform(), 'web');
});
