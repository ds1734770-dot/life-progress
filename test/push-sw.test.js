/**
 * V1.6 — service-worker push handler tests (js/swPush.js).
 *
 * Every branch of processPush is driven with injected dependencies: payload
 * validation, gate order (master → category → quiet → dedup → context),
 * cross-mechanism dedup, silent "not useful now", static fallback on context
 * failure, and the test-notification path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePushPayload, processPush, genericForCategory, routeFor, notificationOptions } from '../js/swPush.js';

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const noon = new Date(2026, 8, 14, 12, 0); // outside default quiet hours

function makeDeps(over = {}) {
  const prefs = {
    enabled: true,
    categories: { water: true, gym: true, goals: true, journal: true, streaks: true, achievements: true },
    quietStart: '22:30',
    quietEnd: '07:00',
    ...over.prefs,
  };
  const delivered = new Set(over.delivered || []);
  const marked = [];
  const shown = [];
  // Mirror of the real ELIGIBILITY.water decision, driven by the same ctx:
  // target met ⇒ silent; otherwise personalizes with the remaining amount.
  const eligibility = over.ELIGIBILITY || {
    water: (ctx) => {
      if (!ctx.waterTarget || ctx.waterTarget <= 0) return null;
      if (ctx.waterRemaining <= 0) return null;
      return { title: 'Time for some water 💧', body: `${ctx.waterRemaining} ml left to reach today's goal.`, route: '#/water', tag: 'water' };
    },
  };
  return {
    getNotificationPrefs: async () => prefs,
    reminderBlocked: over.reminderBlocked || ((p, { category, now }) => {
      if (!p.enabled) return 'master-off';
      if (category && !p.categories[category]) return 'category-off';
      const minutes = now.getHours() * 60 + now.getMinutes();
      if ((minutes >= 22 * 60 + 30 || minutes < 7 * 60) && !(p.quietStart === '00:00' && p.quietEnd === '00:00')) return 'quiet-hours';
      return null;
    }),
    wasDelivered: async (key, period) => delivered.has(`${key}:${period}`),
    markDelivered: async (key, period, meta) => marked.push({ key, period, ...meta }),
    buildReminderContext: over.buildReminderContext || (async () => ({
      today: '2026-09-14',
      waterTarget: 2500,
      waterTotal: 1000,
      waterRemaining: 1500,
      journalToday: false,
      goalStats: { total: 4, completed: 2, pending: 2, pct: 50 },
      streaks: { water: 3, gym: 0, goals: 5, journal: 0 },
      hasWorkoutToday: false,
      workouts: [{ date: '2026-09-10' }],
    })),
    ELIGIBILITY: eligibility,
    show: async (n) => shown.push(n),
    now: over.now || noon,
    __marked: marked,
    __shown: shown,
  };
}

const reminderPayload = (over = {}) => ({
  type: 'reminder',
  category: 'water',
  occurrenceId: 'dev-1:water:2026-09-14',
  dateKey: '2026-09-14',
  route: '#/water',
  serverTime: Date.now(),
  ...over,
});

// ---------------------------------------------------------------------------
// Payload validation (§14/§24)
// ---------------------------------------------------------------------------

test('validatePushPayload: accepts a well-formed reminder payload', () => {
  const r = validatePushPayload(reminderPayload());
  assert.equal(r.ok, true);
  assert.equal(r.value.category, 'water');
  assert.equal(r.value.key, 'water:daily');
  assert.equal(r.value.period, '2026-09-14');
  assert.equal(r.value.route, '#/water');
});

test('validatePushPayload: rejects garbage, unknown categories and oversized ids', () => {
  assert.equal(validatePushPayload(null).ok, false);
  assert.equal(validatePushPayload('x').ok, false);
  assert.equal(validatePushPayload({}).ok, false);
  assert.equal(validatePushPayload({ type: 'reminder' }).ok, false);
  assert.equal(validatePushPayload(reminderPayload({ category: 'journal-text' })).ok, false);
  assert.equal(validatePushPayload(reminderPayload({ occurrenceId: 'x'.repeat(200) })).ok, false);
});

test('validatePushPayload: missing dateKey falls back to the device date (SW-side)', () => {
  const r = validatePushPayload({ type: 'reminder', category: 'gym', occurrenceId: 'dev-1:gym:x' });
  assert.equal(r.ok, true);
  assert.match(r.value.period, /^\d{4}-\d{2}-\d{2}$/);
});

test('validatePushPayload: route is allowlisted — injection cannot navigate elsewhere', () => {
  const evil = validatePushPayload(reminderPayload({ route: 'javascript:alert(1)' }));
  assert.equal(evil.value.route, '#/water');
  const evil2 = validatePushPayload(reminderPayload({ route: 'https://evil.example' }));
  assert.equal(evil2.value.route, '#/water');
  assert.equal(routeFor('water', '#/journal'), '#/journal'); // known routes pass through
});

test('validatePushPayload: test payloads use their own identity', () => {
  const r = validatePushPayload({ type: 'test', occurrenceId: 'dev-1:test:1' });
  assert.equal(r.ok, true);
  assert.equal(r.value.type, 'test');
  assert.equal(r.value.route, '#/dashboard');
});

// ---------------------------------------------------------------------------
// processPush — gate order
// ---------------------------------------------------------------------------

test('processPush: invalid payload → silent, nothing shown', async () => {
  const deps = makeDeps();
  const r = await processPush(null, deps);
  assert.equal(r.shown, false);
  assert.equal(r.reason, 'invalid-payload');
  assert.equal(deps.__shown.length, 0);
});

test('processPush: master off → silent (server double-gates, SW verifies)', async () => {
  const deps = makeDeps({ prefs: { enabled: false } });
  const r = await processPush(reminderPayload(), deps);
  assert.equal(r.shown, false);
  assert.equal(r.reason, 'master-off');
});

test('processPush: category off → silent', async () => {
  const deps = makeDeps({ prefs: { categories: { water: false } } });
  const r = await processPush(reminderPayload(), deps);
  assert.equal(r.reason, 'category-off');
});

test('processPush: quiet hours at delivery time → silent', async () => {
  const deps = makeDeps({ now: new Date(2026, 8, 14, 23, 0) }); // 23:00, inside 22:30–07:00
  const r = await processPush(reminderPayload(), deps);
  assert.equal(r.reason, 'quiet-hours');
});

test('processPush: already delivered (same dedup space as the in-app sweep) → silent, no duplicate', async () => {
  const deps = makeDeps({ delivered: ['water:daily:2026-09-14'] });
  const r = await processPush(reminderPayload(), deps);
  assert.equal(r.reason, 'already-delivered');
  assert.equal(deps.__shown.length, 0);
});

test('processPush: eligible → shows the LOCAL context-aware copy (privacy)', async () => {
  const deps = makeDeps();
  const r = await processPush(reminderPayload(), deps);
  assert.equal(r.shown, true);
  assert.equal(r.personalized, true);
  assert.match(deps.__shown[0].body, /1500 ml/);
  assert.equal(deps.__shown[0].options.data.route, '#/water');
  // Dedup marker written AFTER a real show, in the shared space.
  assert.deepEqual(deps.__marked, [{ key: 'water:daily', period: '2026-09-14', route: '#/water', source: 'push' }]);
});

test('processPush: context says not useful (water target met) → SILENT, no dedup marker', async () => {
  const deps = makeDeps({
    buildReminderContext: async () => ({
      today: '2026-09-14', waterTarget: 2500, waterTotal: 2500, waterRemaining: 0,
      journalToday: false, goalStats: { total: 4, completed: 2, pending: 2, pct: 50 },
      streaks: { water: 3, gym: 0, goals: 5, journal: 0 }, hasWorkoutToday: false, workouts: [],
    }),
  });
  const r = await processPush(reminderPayload(), deps);
  assert.equal(r.shown, false);
  assert.equal(r.reason, 'not-useful-now');
  assert.equal(deps.__marked.length, 0); // may still fire later today if context changes
});

test('processPush: context read failure → static fallback copy, reminder survives', async () => {
  const deps = makeDeps({ buildReminderContext: async () => { throw new Error('idb gone'); } });
  const r = await processPush(reminderPayload(), deps);
  assert.equal(r.shown, true);
  assert.equal(r.personalized, false);
  assert.ok(deps.__shown[0].title.length > 0);
  assert.equal(deps.__shown[0].options.data.route, '#/water');
});

test('processPush: test payload shows without touching prefs/dedup', async () => {
  const deps = makeDeps();
  const r = await processPush({ type: 'test', occurrenceId: 'dev-1:test:1' }, deps);
  assert.equal(r.shown, true);
  assert.match(deps.__shown[0].body, /working/);
  assert.equal(deps.__marked.length, 0);
});

// ---------------------------------------------------------------------------
// Static copy + options
// ---------------------------------------------------------------------------

test('genericForCategory: covers every category with safe copy', () => {
  for (const c of ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements']) {
    const g = genericForCategory(c);
    assert.ok(g.title && g.body, c);
    assert.match(g.route, /^#\/[a-z]+$/);
  }
});

test('notificationOptions: same shape as the in-app buildPayload (coalescing tag + route data)', () => {
  const n = notificationOptions({ title: 'T', body: 'B', route: '#/gym', tag: 'gym' });
  assert.equal(n.title, 'T');
  assert.equal(n.options.tag, 'gym');
  assert.equal(n.options.data.route, '#/gym');
  assert.equal(n.options.data.app, 'life-progress');
  assert.ok(n.options.icon);
});
