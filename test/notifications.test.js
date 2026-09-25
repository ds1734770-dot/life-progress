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
import assert from 'assert/strict';
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
  DEEP_LINKS,
} from '../js/notifications.js';
import {
  zonedTimeToEpoch,
  zonedParts,
  nextDailyOccurrence,
  timeToMinutes as tcTimeToMinutes,
  occurrenceId,
} from '../js/timeCore.js';

// CATEGORIES mirrors the original V1.5 full notification category list
// (identical to the exports in the module) — used by the preference and
// eligibility tests.  Do NOT re-export from notifications.js: that module
// was deliberately trimmed in V2.2, so the full list lives here.
const CATEGORIES = ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements'];

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

// ---------------------------------------------------------------------------
// Wave 1 — TIME-GATED LOCAL SWEEP regression tests
// ---------------------------------------------------------------------------

/**
 * Drive runReminderSweep() through the REAL canonical occurrence model
 * (js/timeCore.js computeNextOccurrences — the same code the server runs).
 * Only the environment edges are injected: an in-memory dedup/prefs store,
 * a spy display function (there is no Notification API in Node) and a spy
 * ACK recorder (there is no fetch in Node). Every gate that fires inside
 * the sweep — time-gate, grace window, quiet hours, dedup, usefulness —
 * runs for real.
 */
async function driveSweep(over = {}) {
  const {
    nowMs = Date.UTC(2026, 0, 14, 9, 0, 0), // 09:00 UTC
    deliveredBefore = [], // full dedup ids already present
    ctx = null,
    tz = 'UTC',
    showResult = true,
    times = null, // per-test schedule override
  } = over;

  const mod = await import('../js/notifications.js');
  const timeCore = await import('../js/timeCore.js');

  // Real prefs with a hardcoded schedule so every test is deterministic.
  const prefs = mod.defaultNotificationPrefs();
  prefs.enabled = true;
  prefs.categories.water = true;
  prefs.categories.gym = true;
  prefs.categories.goals = true;
  prefs.categories.journal = true;
  prefs.categories.streaks = true;
  prefs.times.water = '14:00';
  prefs.times.gym = '11:00';
  prefs.times.goals = '09:00';
  prefs.times.journal = '21:30';
  prefs.quietStart = '22:30';
  prefs.quietEnd = '07:00';
  if (times) Object.assign(prefs.times, times);

  // Deterministic in-memory store (dedup + prefs are the only state the
  // sweep reads/writes). `deliveredBefore` entries must be FULL dedup ids
  // (`water:daily:2026-01-14`) — the canonical `<key>:<period>` shape.
  const dedup = new Map();
  dedup.set('prefs', { id: 'prefs', ...prefs });
  for (const d of deliveredBefore) dedup.set(d, { id: d });
  mod.setStoreState({
    async dbGet(store, id) { return dedup.has(id) ? { id, ...dedup.get(id) } : null; },
    async dbPut(store, value) { dedup.set(value.id, value); return value; },
    async dbGetAll(store) { return Array.from(dedup.values()); },
    async dbDelete(store, id) { dedup.delete(id); return true; },
    async dbClear(store) { dedup.clear(); },
  });

  const shown = [];
  const acks = [];

  const result = await mod.runReminderSweep({
    now: new Date(nowMs),
    ctx,
    computeNextOccurrences: (sub, atMs) => timeCore.computeNextOccurrences({ ...sub, timezone: tz }, atMs),
    show: async (payload) => { shown.push(payload); return showResult; },
    ackOccurrence: async (occurrenceId) => { acks.push(occurrenceId); return true; },
  });

  mod.setStoreState(null);
  return { result, shown, acks, markers: Array.from(dedup.keys()).filter((k) => k !== 'prefs') };
}

/** Reminder context for tests that need a DELIVERABLE reminder (no IndexedDB
 * in Node — the eligibility engine derives usefulness from real data). */
const RICH_CTX = { waterTarget: 2500, waterTotal: 1000, waterRemaining: 1500, journalToday: false, goalStats: { total: 4, completed: 2, pending: 2, pct: 50 }, streaks: { water: 3, gym: 0, goals: 5, journal: 0 }, hasWorkoutToday: false, workouts: [] };

test('time-gated sweep: app opened before configured time → no occurrence claimed', async () => {
  // Water reminder = 14:00. App opened at 09:00. The occurrence is not due:
  // nothing delivered, nothing shown, NO dedup marker, NO ACK.
  const { result, shown, acks, markers } = await driveSweep({
    nowMs: Date.UTC(2026, 0, 14, 9, 0, 0),
  });
  assert.equal(result.delivered.length, 0, 'nothing delivered before the scheduled time');
  assert.equal(shown.length, 0, 'no notification shown (time gate respected)');
  assert.equal(markers.length, 0, 'no dedup marker written before the scheduled time');
  assert.equal(acks.length, 0, 'no ACK sent before the scheduled time');
  // Skip entries prove the time-gate fired (water 14:00, not yet due).
  assert.ok(result.skipped.some((s) => s.startsWith('water:before-')), 'sweep recorded the before-time skip');
});

test('time-gated sweep: occurrence becomes due at the configured time', async () => {
  // Sweep at 14:00 UTC — the water occurrence is exactly due: presented
  // once, canonical dedup marker written, occurrence ACKed to the server.
  const nowMs = Date.UTC(2026, 0, 14, 14, 0, 0);
  const { result, shown, acks, markers } = await driveSweep({ nowMs, ctx: RICH_CTX });
  assert.ok(result.delivered.includes('water'), 'the due occurrence was delivered');
  assert.equal(shown.length, 1, 'one notification shown');
  assert.ok(markers.includes('water:daily:2026-01-14'), 'canonical dedup marker (category:daily:dateKey)');
  assert.deepEqual(acks, ['local-page:water:2026-01-14'], 'ACK carries the canonical occurrenceId');
});

test('time-gated sweep: occurrence already handled → no duplicate local reminder', async () => {
  // A dedup marker for the 01-14 occurrence already exists (an earlier sweep
  // or the push path handled it): the sweep must not present it again.
  const nowMs = Date.UTC(2026, 0, 14, 14, 0, 0);
  const { result, shown, acks, markers } = await driveSweep({
    nowMs,
    deliveredBefore: ['water:daily:2026-01-14'],
  });
  assert.equal(result.delivered.length, 0, 'already-handled occurrence NOT duplicated');
  assert.equal(shown.length, 0, 'no second notification shown');
  assert.equal(markers.filter((m) => m === 'water:daily:2026-01-14').length, 1, 'no new marker written (idempotent store)');
  assert.equal(acks.length, 0, 'no second ACK for the same occurrence');
});

test('time-gated sweep: occurrence expired after grace window → missed, no claim', async () => {
  // Sweep 10 min after the 14:00 occurrence — past the 5-minute handling
  // window. Documented missed-occurrence policy: no presentation, no
  // marker, NO ACK, and the reminder is never re-created at the sweep instant.
  const nowMs = Date.UTC(2026, 0, 14, 14, 10, 0);
  const { result, shown, acks, markers } = await driveSweep({ nowMs });
  assert.equal(result.delivered.length, 0, 'expired occurrence not delivered');
  assert.ok(result.skipped.some((s) => s === 'water:missed'), 'missed policy recorded');
  assert.equal(shown.length, 0, 'nothing shown after grace');
  assert.equal(markers.length, 0, 'no dedup marker written (occurrence missed, not claimed)');
  assert.equal(acks.length, 0, 'no ACK for a missed occurrence');
});

test('time-gated sweep: different dates are distinct occurrences', async () => {
  // Water moved to 11:00. At 2026-09-24 11:00 UTC the 09-24 occurrence is
  // due and claimed; the 09-25 occurrence does not exist yet (one occurrence
  // per day by construction). The marker carries the dateKey, so the same
  // category on a different date is a DIFFERENT occurrence.
  const nowMs = Date.UTC(2026, 8, 24, 11, 0, 0);
  const { result, shown, acks, markers } = await driveSweep({
    nowMs,
    ctx: RICH_CTX,
    times: { water: '11:00' },
  });
  assert.ok(result.delivered.includes('water'), 'today (09-24) occurrence delivered');
  assert.ok(markers.includes('water:daily:2026-09-24'), 'marker keyed by the 09-24 dateKey');
  assert.ok(!markers.includes('water:daily:2026-09-25'), 'the 09-25 occurrence was not claimed');
  assert.ok(acks.includes('local-page:water:2026-09-24'), 'ACK identity is date-scoped');
  assert.equal(shown.length, 1, 'exactly one notification shown');
});

test('canonical occurrence identity: category and date changes yield distinct occurrences', () => {
  // The required identity matrix (Wave-1 spec): water+2026-09-24,
  // water+2026-09-25 and gym+2026-09-24 are three DIFFERENT occurrences —
  // by construction, in the ONE identity function both server and page run.
  const water24 = occurrenceId('dev-0001', 'water', '2026-09-24');
  const water25 = occurrenceId('dev-0001', 'water', '2026-09-25');
  const gym24 = occurrenceId('dev-0001', 'gym', '2026-09-24');
  assert.equal(water24, 'dev-0001:water:2026-09-24');
  assert.notEqual(water24, water25, 'different dates → different occurrences');
  assert.notEqual(water24, gym24, 'different categories → different occurrences');
  assert.notEqual(water25, gym24, 'date and category both matter');
});

test('time-gated sweep: category identity flows through the canonical dedup key', async () => {
  // At 11:00 the 14:00 water occurrence is NOT due: no water notification,
  // no water dedup marker, no water ACK — one category's due state never
  // claims another category's occurrence.
  const nowMs = Date.UTC(2026, 8, 24, 11, 0, 0);
  const { result, shown, acks, markers } = await driveSweep({ nowMs, ctx: RICH_CTX });
  assert.equal(result.delivered.includes('water'), false, 'water not delivered before its 14:00 time');
  assert.ok(!markers.some((m) => m.startsWith('water:')), 'no water marker written before its time');
  assert.equal(acks.filter((a) => a.includes(':water:')).length, 0, 'no water ACK before its time');
});

test('time-gated sweep: non-UTC zone respects the LOCAL calendar day boundary', async () => {
  // A New York user (UTC-5 in January) with a 23:50 local reminder: the
  // occurrence belongs to the LOCAL day's dateKey, not the UTC one.
  // 2026-01-14 23:50 America/New_York = 2026-01-15 04:50 UTC. At 04:00 UTC
  // (23:00 local, before the scheduled time) nothing may fire; at 04:50 UTC
  // it is due, and the marker + ACK carry the LOCAL dateKey 2026-01-14 —
  // proving the identity is anchored to the user's calendar, not the server's.
  const { result, shown, acks, markers } = await driveSweep({
    nowMs: Date.UTC(2026, 0, 15, 4, 0, 0),
    ctx: RICH_CTX,
    tz: 'America/New_York',
    times: { water: '23:50' },
  });
  assert.equal(result.delivered.length, 0, '23:00 local: before the scheduled time, nothing fires');
  assert.ok(result.skipped.some((s) => s.startsWith('water:before-')), 'time-gate skip recorded');

  const due = await driveSweep({
    nowMs: Date.UTC(2026, 0, 15, 4, 50, 0),
    ctx: RICH_CTX,
    tz: 'America/New_York',
    times: { water: '23:50' },
  });
  assert.ok(due.result.delivered.includes('water'), 'due in local time → delivered');
  assert.ok(due.markers.includes('water:daily:2026-01-14'), 'dedup marker carries the LOCAL dateKey (2026-01-14)');
  assert.ok(due.acks.includes('local-page:water:2026-01-14'), 'ACK carries the LOCAL dateKey');
  assert.equal(due.shown.length, 1, 'exactly one notification');
});
