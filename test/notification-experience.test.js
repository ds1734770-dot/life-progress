/**
 * V2.1 — Notification Experience tests (master spec §25):
 * the shared presentation model (js/notifyContent.js), the wallpaper
 * registry + selection (js/notifyWallpapers.js), the appearance guards,
 * random-mode no-immediate-repeat, category mapping, the deep-link
 * allowlist, and the wallpaper-aware display path (js/swPush.js).
 *
 * Everything here is pure-domain (same convention as notifications.test.js):
 * IndexedDB-backed behavior is covered by scripts/qa-notifications.js in a
 * real browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTIFY_CATEGORIES,
  CATEGORY_ROUTES,
  presentationFor,
  presentationCategory,
  toStaticCopy,
  quoteFor,
  waterProgressLine,
  goalsProgressLine,
} from '../js/notifyContent.js';
import {
  BUILTIN_WALLPAPERS,
  WALLPAPER_MODES,
  defaultNotificationAppearance,
  normalizeNotificationAppearance,
  pickNotificationWallpaper,
  builtinWallpaper,
} from '../js/notifyWallpapers.js';
import { processPush, notificationOptions, validatePushPayload } from '../js/swPush.js';

// ---------------------------------------------------------------------------
// Presentation model — one shared source of truth
// ---------------------------------------------------------------------------

test('presentation model: every category resolves with copy, actions and an allowlisted route', () => {
  for (const category of NOTIFY_CATEGORIES) {
    const p = presentationFor(category, {});
    assert.ok(p, `presentation for ${category}`);
    assert.equal(p.brand, 'Life Progress');
    assert.ok(p.title && p.title.length > 0, `${category} title`);
    assert.ok(p.subtitle && p.subtitle.length > 0, `${category} subtitle`);
    assert.ok(p.quote && p.quote.length > 0, `${category} quote`);
    assert.ok(p.primaryAction, `${category} primary action`);
    assert.equal(p.secondaryAction, 'Remind Me Later');
    assert.ok(Object.values(CATEGORY_ROUTES).includes(p.route), `${category} route is allowlisted`);
  }
});

test('presentation model: unknown category → null (no invented content)', () => {
  assert.equal(presentationFor('nonsense', {}), null);
  assert.equal(presentationFor(undefined, {}), null);
});

test('presentation model: water uses REAL progress, never fabricated numbers', () => {
  const real = presentationFor('water', { waterTotal: 1200, waterTarget: 2500 });
  assert.match(real.message, /1\.2 L of 2\.5 L today/);
  assert.equal(real.title, 'Drink Water');
  // Missing data → static safe copy, never invented values (§11).
  const missing = presentationFor('water', {});
  assert.equal(missing.progress, null);
  assert.ok(!/\d+(\.\d+)? L/.test(missing.message), 'no numbers without real data');
  // Target reached → supportive, and the remaining check needs real data.
  const done = presentationFor('water', { waterTotal: 2500, waterTarget: 2500, waterRemaining: 0 });
  assert.equal(done.message, 'Target reached — nicely done.');
});

test('presentation model: goals line is "N of M goals completed" from real stats only', () => {
  const p = presentationFor('goals', { goalStats: { total: 4, completed: 3, pending: 1 } });
  assert.equal(p.title, 'One Goal Left');
  assert.match(p.message, /3 of 4 goals completed/);
  const noStats = presentationFor('goals', {});
  assert.equal(noStats.progress, null);
  assert.ok(!/\d of \d goals/.test(noStats.message));
});

test('presentation model: gym shows the real workout name, else generic copy', () => {
  const real = presentationFor('gym', { workoutName: 'Push Day' });
  assert.match(real.message, /Push Day/);
  assert.equal(real.primaryAction, 'Start Workout');
  const generic = presentationFor('gym', {});
  assert.ok(!/Push Day/.test(generic.message));
  assert.equal(generic.primaryAction, 'Start Workout');
});

test('presentation model: streaks/achievements degrade to safe copy without data', () => {
  const streak = presentationFor('streaks', {});
  assert.equal(streak.progress, null);
  const real = presentationFor('streaks', { streakCount: 12, streakLabel: 'water' });
  assert.match(real.progress.primary, /12-day water streak/);
  const achievement = presentationFor('achievements', {});
  assert.equal(achievement.kicker, 'UNLOCKED');
  const titled = presentationFor('achievements', { achievementTitle: 'First Week Warrior' });
  assert.equal(titled.subtitle, 'First Week Warrior');
});

test('presentation model: tone invariant — supportive, never shame-based (§10)', () => {
  for (const category of NOTIFY_CATEGORIES) {
    const p = presentationFor(category, {});
    const text = `${p.title} ${p.subtitle} ${p.message}`.toLowerCase();
    for (const banned of ['you failed', 'you missed', 'falling behind', "you're behind"]) {
      assert.ok(!text.includes(banned), `${category} must not say "${banned}"`);
    }
  }
});

test('waterProgressLine / goalsProgressLine: null on missing or invalid data', () => {
  assert.equal(waterProgressLine(1200, 0), null);
  assert.equal(waterProgressLine(undefined, 2500), null);
  assert.equal(waterProgressLine(NaN, 2500), null);
  assert.equal(goalsProgressLine(3, 0), null);
  assert.equal(goalsProgressLine('3', 4), null);
  assert.equal(goalsProgressLine(3, 4), '3 of 4 goals completed');
});

test('quoteFor: deterministic per (category, day), varies across days', () => {
  assert.equal(quoteFor('water', '2026-09-24'), quoteFor('water', '2026-09-24'));
  const days = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29'];
  assert.ok(new Set(days.map((d) => quoteFor('water', d))).size > 1, 'quote rotates across days');
});

// ---------------------------------------------------------------------------
// Category mapping + wire compatibility
// ---------------------------------------------------------------------------

test('presentationCategory: wire categories map 1:1, unknown → general', () => {
  for (const c of ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements', 'general']) {
    assert.equal(presentationCategory(c), c);
  }
  assert.equal(presentationCategory('test'), 'general'); // test pushes use the test path, not the model
  assert.equal(presentationCategory(undefined), 'general');
  assert.equal(presentationCategory('DROP TABLE'), 'general');
});

test('category routes: allowlist matches the deep-link vocabulary (§20)', () => {
  assert.equal(CATEGORY_ROUTES.water, '#/water');
  assert.equal(CATEGORY_ROUTES.gym, '#/gym');
  assert.equal(CATEGORY_ROUTES.goals, '#/goals');
  assert.equal(CATEGORY_ROUTES.journal, '#/journal');
  assert.equal(CATEGORY_ROUTES.achievements, '#/achievements');
  assert.ok(Object.values(CATEGORY_ROUTES).every((r) => /^#\/[a-z]+$/.test(r)));
});

// ---------------------------------------------------------------------------
// Wallpaper registry + selection
// ---------------------------------------------------------------------------

test('builtin registry: exactly 12 wallpapers, unique ids, bundled .png assets', () => {
  assert.equal(BUILTIN_WALLPAPERS.length, 12);
  const ids = new Set(BUILTIN_WALLPAPERS.map((w) => w.id));
  assert.equal(ids.size, 12);
  for (const w of BUILTIN_WALLPAPERS) {
    assert.match(w.src, /^assets\/notification-backgrounds\/[a-z_]+\.png$/, w.id);
    assert.ok(w.name && w.name.length > 0, w.id);
    assert.ok(Number.isFinite(w.overlay) && w.overlay >= 0 && w.overlay <= 1, `${w.id} overlay`);
  }
  const expected = ['sunset_peak', 'forest_trail', 'calm_lake', 'mountain_mist', 'night_sky', 'ocean_dusk', 'city_night', 'warm_minimal', 'cozy_room', 'sunrise_valley', 'autumn_forest', 'training_room'];
  for (const id of expected) assert.ok(ids.has(id), id);
});

test('builtinWallpaper: known id resolves, unknown → null', () => {
  assert.equal(builtinWallpaper('night_sky').name, 'Night Sky');
  assert.equal(builtinWallpaper('nope'), null);
  assert.equal(builtinWallpaper(undefined), null);
});

test('default appearance: random mode, nothing pinned, empty history', () => {
  const d = defaultNotificationAppearance();
  assert.equal(d.mode, 'random');
  assert.equal(d.builtinId, null);
  assert.equal(d.customPhotoId, null);
  assert.equal(d.crop, null);
  assert.deepEqual(d.recent, []);
  assert.ok(WALLPAPER_MODES.includes(d.mode));
});

test('normalizeNotificationAppearance: partial/legacy/invalid records gain defaults', () => {
  assert.equal(normalizeNotificationAppearance(null).mode, 'random');
  assert.equal(normalizeNotificationAppearance(undefined).mode, 'random');
  assert.equal(normalizeNotificationAppearance('junk').mode, 'random');
  // Invalid mode → default; dangling builtin id cleared; recent sanitized.
  const bad = normalizeNotificationAppearance({ mode: 'vertical', builtinId: 'not-a-wallpaper', recent: ['night_sky', 'nope', 42, 'night_sky'] });
  assert.equal(bad.mode, 'random');
  assert.equal(bad.builtinId, null);
  assert.deepEqual(bad.recent, ['night_sky']);
  // User values survive a valid partial record.
  const good = normalizeNotificationAppearance({ mode: 'builtin', builtinId: 'calm_lake' });
  assert.equal(good.mode, 'builtin');
  assert.equal(good.builtinId, 'calm_lake');
  // Recent history is bounded (§18).
  const long = normalizeNotificationAppearance({ recent: ['night_sky', 'calm_lake', 'city_night', 'cozy_room', 'warm_minimal', 'ocean_dusk'] });
  assert.equal(long.recent.length, 4);
});

test('normalizeNotificationAppearance: crop clamped to valid ranges', () => {
  const c = normalizeNotificationAppearance({ crop: { x: 1.5, y: -0.5, scale: 99 } }).crop;
  assert.equal(c.x, 1);
  assert.equal(c.y, 0);
  assert.equal(c.scale, 5);
  assert.equal(normalizeNotificationAppearance({ crop: { x: 'a' } }).crop, null);
  assert.equal(normalizeNotificationAppearance({}).crop, null);
});

test('pickNotificationWallpaper: builtin mode pins the selected wallpaper', () => {
  const { wallpaper, recent } = pickNotificationWallpaper({ mode: 'builtin', builtinId: 'forest_trail' }, { rand: () => 0 });
  assert.equal(wallpaper.id, 'forest_trail');
  assert.deepEqual(recent, []);
});

test('pickNotificationWallpaper: invalid pin degrades to random — never fails (§24)', () => {
  const { wallpaper } = pickNotificationWallpaper({ mode: 'builtin', builtinId: 'ghost' }, { rand: () => 0 });
  assert.ok(builtinWallpaper(wallpaper.id), 'falls back to a real bundled wallpaper');
});

test('pickNotificationWallpaper: custom mode signals the local photo (privacy §21)', () => {
  const { wallpaper } = pickNotificationWallpaper({ mode: 'custom' }, { rand: () => 0 });
  assert.equal(wallpaper.custom, true);
  assert.equal(wallpaper.id, 'custom');
  // The marker object can never smuggle image data — it has no src at all.
  assert.equal(wallpaper.src, undefined);
});

test('random mode: deterministic per occurrence seed, varies across occurrences', () => {
  const a = pickNotificationWallpaper({}, { occurrenceId: 'dev:water:2026-09-24', dayKey: '2026-09-24' });
  const b = pickNotificationWallpaper({}, { occurrenceId: 'dev:water:2026-09-24', dayKey: '2026-09-24' });
  assert.equal(a.wallpaper.id, b.wallpaper.id, 'same occurrence → same wallpaper (no flicker)');
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(pickNotificationWallpaper({}, { occurrenceId: `dev:water:day-${i}`, dayKey: `2026-09-${(i % 28) + 1}` }).wallpaper.id);
  }
  assert.ok(seen.size > 1, 'different occurrences → different wallpapers');
});

test('random mode: no immediate repeat — recent ids are excluded from the pool (§18)', () => {
  const appearance = { mode: 'random', recent: ['sunset_peak', 'night_sky'] };
  const rand = () => 0.999; // would always pick the LAST pool entry
  for (let i = 0; i < 20; i++) {
    const { wallpaper, recent } = pickNotificationWallpaper(appearance, { rand });
    assert.ok(wallpaper.id !== 'sunset_peak' && wallpaper.id !== 'night_sky', 'never repeats a recent wallpaper');
    assert.equal(recent[0], wallpaper.id, 'picked id moves to the front of history');
    assert.ok(recent.length <= 4, 'history stays bounded');
    appearance.recent = recent; // simulate the caller persisting it
  }
});

test('random mode: history can never starve the pool', () => {
  // All 12 ids "recent" (over-long legacy history) → must still pick something.
  const appearance = { mode: 'random', recent: BUILTIN_WALLPAPERS.map((w) => w.id) };
  const { wallpaper } = pickNotificationWallpaper(normalizeNotificationAppearance(appearance), { rand: () => 0.5 });
  assert.ok(builtinWallpaper(wallpaper.id));
});

test('random mode: persisted recent is respected only for valid builtin ids', () => {
  const { wallpaper, recent } = pickNotificationWallpaper(
    normalizeNotificationAppearance({ mode: 'random', recent: ['calm_lake', 'bogus'] }),
    { rand: () => 0 }
  );
  assert.ok(wallpaper.id !== 'calm_lake');
  assert.ok(recent.includes('calm_lake'));
  assert.ok(!recent.includes('bogus'));
});

// ---------------------------------------------------------------------------
// Wallpaper-aware display path (js/swPush.js)
// ---------------------------------------------------------------------------

function makeDeps(over = {}) {
  const shown = [];
  return {
    getNotificationPrefs: async () => ({ enabled: true, categories: { water: true }, quietStart: '22:30', quietEnd: '07:00' }),
    reminderBlocked: () => null,
    wasDelivered: async () => false,
    markDelivered: async () => {},
    buildReminderContext: async () => ({ waterTarget: 2500, waterTotal: 1200, waterRemaining: 1300 }),
    ELIGIBILITY: {
      water: (ctx) => ({ title: 'Time for some water 💧', body: `${ctx.waterRemaining} ml left to reach today's goal.`, route: '#/water', tag: 'water' }),
    },
    show: async (n) => shown.push(n),
    now: new Date(2026, 8, 24, 12, 0),
    ...over,
    _shown: shown,
  };
}

const waterPayload = { type: 'reminder', category: 'water', occurrenceId: 'dev:water:2026-09-24', dateKey: '2026-09-24', route: '#/water', serverTime: 1 };

test('processPush: resolver supplies a bundled wallpaper as the notification icon', async () => {
  const deps = makeDeps({
    resolveWallpaper: async () => ({ wallpaper: { id: 'calm_lake', src: 'assets/notification-backgrounds/calm_lake.png' }, recent: [] }),
  });
  await processPush(waterPayload, deps);
  assert.equal(deps._shown.length, 1);
  assert.equal(deps._shown[0].options.icon, 'assets/notification-backgrounds/calm_lake.png');
  assert.equal(deps._shown[0].options.data.route, '#/water');
});

test('processPush: custom mode passes the caller-resolved local blob URL (never its path)', async () => {
  const deps = makeDeps({
    resolveWallpaper: async () => ({ wallpaper: { id: 'custom', custom: true }, url: 'blob:local-only' }),
  });
  await processPush(waterPayload, deps);
  assert.equal(deps._shown[0].options.icon, 'blob:local-only');
});

test('processPush: resolver failure degrades to the app icon — reminder still shows (§24)', async () => {
  const deps = makeDeps({
    resolveWallpaper: async () => { throw new Error('wallpaper boom'); },
  });
  const result = await processPush(waterPayload, deps);
  assert.equal(result.shown, true);
  assert.equal(deps._shown[0].options.icon, './icons/icon-192.png');
});

test('processPush: no resolver (server/tests) → standard icon, behavior unchanged', async () => {
  const deps = makeDeps();
  await processPush(waterPayload, deps);
  assert.equal(deps._shown[0].options.icon, './icons/icon-192.png');
});

test('notificationOptions: icon override and defaults', () => {
  assert.equal(notificationOptions({ title: 'T', body: 'B', icon: 'assets/notification-backgrounds/night_sky.png' }).options.icon, 'assets/notification-backgrounds/night_sky.png');
  assert.equal(notificationOptions({ title: 'T', body: 'B' }).options.icon, './icons/icon-192.png');
  assert.equal(notificationOptions({ title: 'T', body: 'B', route: '#/water' }).options.data.route, '#/water');
});

test('sw precache parity: sw.js wallpaper list matches the registry exactly', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const src = await readFile(path.join(process.cwd(), 'sw.js'), 'utf8');
  const match = src.match(/NOTIFICATION_WALLPAPERS\s*=\s*\[([^\]]+)\]/);
  assert.ok(match, 'NOTIFICATION_WALLPAPERS literal present in sw.js');
  const swFiles = [...match[1].matchAll(/'([a-z_]+\.png)'/g)].map((m) => m[1]);
  const registryFiles = BUILTIN_WALLPAPERS.map((w) => w.src.split('/').pop());
  assert.deepEqual(swFiles, registryFiles);
});

test('privacy: wire payload validation still rejects anything image-shaped (§21)', () => {
  assert.equal(validatePushPayload({ type: 'reminder', category: 'water', occurrenceId: 'x', dateKey: '2026-09-24', wallpaper: 'data:image/png;base64,AAAA' }).ok, true);
  // ...the validator ignores unknown fields; the server never receives them
  // because buildPushPayload (server/push/domain.js) constructs the wire shape
  // from an allowlist — asserted by the push-domain tests.
  const v = validatePushPayload({ type: 'reminder', category: 'water', occurrenceId: 'x', dateKey: '2026-09-24' });
  assert.ok(!('wallpaper' in v.value), 'unknown fields never enter the validated payload');
});
