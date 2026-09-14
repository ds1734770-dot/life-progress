/**
 * V1.5 Notifications — unit tests for the pure domain logic:
 * preferences normalization, time parsing, quiet hours (incl. midnight
 * crossing + boundaries), gate ordering (reminderBlocked), eligibility
 * payload derivation from real context data, and payload shape.
 *
 * IndexedDB-backed behavior (dedup persistence, permission flows, SW click)
 * is covered by scripts/qa-notifications.js in a real browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultNotificationPrefs,
  normalizePrefs,
  timeToMinutes,
  isValidTime,
  formatTime12h,
  inQuietHours,
  reminderBlocked,
  buildPayload,
  ELIGIBILITY,
  CATEGORIES,
  DEEP_LINKS,
} from '../js/notifications.js';

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

test('default prefs: master OFF, all categories ON, sensible times', () => {
  const d = defaultNotificationPrefs();
  assert.equal(d.enabled, false); // no startup prompts, ever
  assert.equal(d.id, 'prefs');
  for (const c of CATEGORIES) assert.equal(d.categories[c], true, c);
  assert.equal(d.times.water, '11:00');
  assert.equal(d.times.journal, '21:30');
  assert.equal(d.quietStart, '22:30');
  assert.equal(d.quietEnd, '07:00');
});

test('normalizePrefs: partial/legacy records gain defaults without losing user values', () => {
  const p = normalizePrefs({ enabled: true, categories: { water: false }, times: { water: '08:15' } });
  assert.equal(p.enabled, true);
  assert.equal(p.categories.water, false);
  assert.equal(p.categories.gym, true); // untouched → default
  assert.equal(p.times.water, '08:15'); // user value kept
  assert.equal(p.times.journal, '21:30'); // missing → default
  assert.equal(p.quietStart, '22:30');
});

test('normalizePrefs: invalid times fall back to defaults', () => {
  const p = normalizePrefs({ times: { water: '25:99', gym: 'nonsense' }, quietStart: '9am', quietEnd: '' });
  assert.equal(p.times.water, '11:00');
  assert.equal(p.times.gym, '17:00');
  assert.equal(p.quietStart, '22:30');
  assert.equal(p.quietEnd, '07:00');
});

test('normalizePrefs: null/undefined input yields defaults', () => {
  assert.deepEqual(normalizePrefs(null).categories, defaultNotificationPrefs().categories);
  assert.equal(normalizePrefs(undefined).enabled, false);
});

// ---------------------------------------------------------------------------
// Time parsing + formatting
// ---------------------------------------------------------------------------

test('timeToMinutes: valid times', () => {
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('11:00'), 660);
  assert.equal(timeToMinutes('23:59'), 1439);
  assert.equal(timeToMinutes('9:05'), 545); // single-digit hour tolerated
});

test('timeToMinutes: invalid inputs return null', () => {
  for (const bad of ['', null, undefined, '24:00', '12:60', 'abc', '12', '12:5', '--:--']) {
    assert.equal(timeToMinutes(bad), null, String(bad));
  }
  assert.equal(isValidTime('12:60'), false);
  assert.equal(isValidTime('07:00'), true);
});

test('formatTime12h: renders a readable 12-hour label', () => {
  const t = formatTime12h('14:30');
  assert.match(t, /2:30/);
  assert.match(t, /pm/i);
  const midnight = formatTime12h('00:15');
  assert.match(midnight, /12:15/);
});

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

test('quiet hours: normal same-day range', () => {
  // 13:00 → 14:00
  assert.equal(inQuietHours(13 * 60 + 30, '13:00', '14:00'), true);
  assert.equal(inQuietHours(12 * 60 + 59, '13:00', '14:00'), false);
  assert.equal(inQuietHours(14 * 60, '13:00', '14:00'), false); // end is exclusive
});

test('quiet hours: midnight-crossing ranges', () => {
  for (const m of [22 * 60 + 30, 23 * 60, 3 * 60, 6 * 60 + 59]) {
    assert.equal(inQuietHours(m, '22:30', '07:00'), true, `min ${m}`);
  }
  assert.equal(inQuietHours(7 * 60, '22:30', '07:00'), false); // 07:00 = morning, not quiet
  assert.equal(inQuietHours(12 * 60, '22:30', '07:00'), false);
  // 23:00 → 06:00
  assert.equal(inQuietHours(23 * 60 + 30, '23:00', '06:00'), true);
  assert.equal(inQuietHours(5 * 60 + 59, '23:00', '06:00'), true);
  assert.equal(inQuietHours(6 * 60, '23:00', '06:00'), false);
});

test('quiet hours: boundary semantics are unambiguous', () => {
  assert.equal(inQuietHours(22 * 60 + 30, '22:30', '07:00'), true); // start inclusive
  assert.equal(inQuietHours(6 * 60 + 59, '22:30', '07:00'), true); // last quiet minute
});

test('quiet hours: start === end means disabled', () => {
  assert.equal(inQuietHours(12 * 60, '07:00', '07:00'), false);
  assert.equal(inQuietHours(3 * 60, '07:00', '07:00'), false);
});

test('quiet hours: invalid ranges never block; nulls use the default window', () => {
  assert.equal(inQuietHours(3 * 60, 'bad', '07:00'), false);
  // null start/end → default 22:30–07:00 applies (documented behavior).
  assert.equal(inQuietHours(3 * 60, null, null), true);
  assert.equal(inQuietHours(12 * 60, null, null), false);
});

// ---------------------------------------------------------------------------
// Gate ordering (reminderBlocked) — §7 gate list
// ---------------------------------------------------------------------------

const grantedPrefs = (over = {}) =>
  normalizePrefs({ enabled: true, ...over });

test('gates: master off blocks everything, even with category on', () => {
  const p = normalizePrefs({ enabled: false });
  assert.equal(reminderBlocked(p, { category: 'water', key: 'water:daily', period: '2026-09-14' }), 'master-off');
});

test('gates: disabled category blocks only that category', () => {
  const p = grantedPrefs({ categories: { water: false } });
  const noon = new Date(2026, 8, 14, 12, 0); // deterministic: outside quiet hours
  assert.equal(reminderBlocked(p, { category: 'water', key: 'water:daily', period: 'x', now: noon }), 'category-off');
  assert.equal(reminderBlocked(p, { category: 'gym', key: 'gym:daily', period: 'x', now: noon }), null);
});

test('gates: quiet hours block during the window (checked after toggles)', () => {
  const p = grantedPrefs();
  const at23 = new Date(2026, 8, 14, 23, 0);
  assert.equal(reminderBlocked(p, { category: 'water', key: 'water:daily', period: 'x', now: at23 }), 'quiet-hours');
  const atNoon = new Date(2026, 8, 14, 12, 0);
  assert.equal(reminderBlocked(p, { category: 'water', key: 'water:daily', period: 'x', now: atNoon }), null);
});

test('gates: quiet hours respect a customized midnight-crossing window', () => {
  const p = grantedPrefs({ quietStart: '01:00', quietEnd: '05:00' });
  const at3 = new Date(2026, 8, 14, 3, 0);
  assert.equal(reminderBlocked(p, { category: 'gym', key: 'gym:daily', period: 'x', now: at3 }), 'quiet-hours');
  const at23 = new Date(2026, 8, 14, 23, 0);
  assert.equal(reminderBlocked(p, { category: 'gym', key: 'gym:daily', period: 'x', now: at23 }), null);
});

// ---------------------------------------------------------------------------
// Eligibility — derived from real context (no invented data)
// ---------------------------------------------------------------------------

const ctx = (over = {}) => ({
  today: '2026-09-14',
  waterTarget: 2500,
  waterTotal: 1000,
  waterRemaining: 1500,
  journalToday: false,
  goalStats: { total: 4, completed: 2, pending: 2, pct: 50 },
  streaks: { water: 3, gym: 0, goals: 5, journal: 0 },
  hasWorkoutToday: false,
  workouts: [{ date: '2026-09-10' }],
  ...over,
});

test('water: reminds with the REAL remaining amount', () => {
  const p = ELIGIBILITY.water(ctx());
  assert.ok(p);
  assert.match(p.body, /1500 ml/);
  assert.equal(p.route, DEEP_LINKS.water);
  assert.equal(p.tag, 'water');
});

test('water: silent when target met', () => {
  assert.equal(ELIGIBILITY.water(ctx({ waterRemaining: 0, waterTotal: 2500 })), null);
});

test('water: silent when no target configured (no broken reminders)', () => {
  assert.equal(ELIGIBILITY.water(ctx({ waterTarget: 0, waterRemaining: 0 })), null);
});

test('gym: silent on workout day and within 2 rest days', () => {
  assert.equal(ELIGIBILITY.gym(ctx({ hasWorkoutToday: true, workouts: [{ date: '2026-09-14' }] })), null);
  assert.equal(ELIGIBILITY.gym(ctx({ workouts: [{ date: '2026-09-13' }] })), null); // 1 day
  assert.equal(ELIGIBILITY.gym(ctx({ workouts: [{ date: '2026-09-12' }] })), null); // 2 days
});

test('gym: reminds after 3+ days with friendly, non-guilt copy', () => {
  const p = ELIGIBILITY.gym(ctx({ workouts: [{ date: '2026-09-10' }] })); // 4 days
  assert.ok(p);
  assert.match(p.body, /4 days/);
  assert.doesNotMatch(p.title + p.body, /fail|missed|lazy|break/i);
  assert.equal(p.route, DEEP_LINKS.gym);
});

test('gym: after a week the message acknowledges the gap kindly', () => {
  const p = ELIGIBILITY.gym(ctx({ workouts: [{ date: '2026-09-06' }] }));
  assert.ok(p);
  assert.match(p.title, /Ready to move again/);
});

test('gym: never trained → no reminder (no invented schedule)', () => {
  assert.equal(ELIGIBILITY.gym(ctx({ workouts: [] })), null);
});

test('journal: reminds only when today has no entry; never leaks content', () => {
  const p = ELIGIBILITY.journal(ctx());
  assert.ok(p);
  assert.equal(p.route, DEEP_LINKS.journal);
  assert.equal(ELIGIBILITY.journal(ctx({ journalToday: true })), null);
  const flat = JSON.stringify(p);
  assert.doesNotMatch(flat, /mood|entry text|private/i);
});

test('goals: counts only real pending goals', () => {
  const p = ELIGIBILITY.goals(ctx());
  assert.ok(p);
  assert.match(p.body, /2 goals left/);
  assert.equal(ELIGIBILITY.goals(ctx({ goalStats: { total: 3, completed: 3, pending: 0, pct: 100 } })), null);
  assert.equal(ELIGIBILITY.goals(ctx({ goalStats: { total: 0, completed: 0, pending: 0, pct: 0 } })), null);
});

test('goals: singular copy for one remaining goal', () => {
  const p = ELIGIBILITY.goals(ctx({ goalStats: { total: 1, completed: 0, pending: 1, pct: 0 } }));
  assert.match(p.body, /1 goal left/);
});

test('streaks: celebrates only when alive AND today’s action still pending', () => {
  const p = ELIGIBILITY.streaks(ctx({ streaks: { water: 7, gym: 0, goals: 0, journal: 0 } }));
  assert.ok(p);
  assert.match(p.title, /7-day streak is alive/);
  assert.match(p.title, /🔥/);
  assert.doesNotMatch(p.title + p.body, /break|fail|lose|failed/i); // no guilt language
});

test('streaks: silent when today’s action is already done (streak safe)', () => {
  const c = ctx({ streaks: { water: 7, gym: 2, goals: 4, journal: 9 }, waterRemaining: 0, hasWorkoutToday: true, goalStats: { total: 4, completed: 4, pending: 0, pct: 100 }, journalToday: true });
  assert.equal(ELIGIBILITY.streaks(c), null);
});

test('streaks: silent when nothing is alive (never fabricates)', () => {
  assert.equal(ELIGIBILITY.streaks(ctx({ streaks: { water: 0, gym: 0, goals: 0, journal: 0 } })), null);
});

// ---------------------------------------------------------------------------
// Payloads + deep links
// ---------------------------------------------------------------------------

test('buildPayload: carries route, tag and app identity; coalesces by tag', () => {
  const p = buildPayload({ title: 'T', body: 'B', route: '#/water', tag: 'water' });
  assert.equal(p.title, 'T');
  assert.equal(p.body, 'B');
  assert.equal(p.options.tag, 'water');
  assert.equal(p.options.data.route, '#/water');
  assert.equal(p.options.data.app, 'life-progress');
  assert.ok(p.options.icon);
});

test('deep links use existing router routes', () => {
  assert.equal(DEEP_LINKS.water, '#/water');
  assert.equal(DEEP_LINKS.gym, '#/gym');
  assert.equal(DEEP_LINKS.goals, '#/goals');
  assert.equal(DEEP_LINKS.journal, '#/journal');
  assert.equal(DEEP_LINKS.achievements, '#/achievements');
});
