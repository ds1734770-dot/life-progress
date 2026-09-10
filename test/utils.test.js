import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateKey,
  parseKey,
  addDays,
  startOfWeekKey,
  weekKeys,
  calculateStreak,
  calculateDailyProgress,
  formatWater,
  trimNumber,
  greetingFor,
  clamp,
  daysBetween,
  formatDate,
  monthKey,
} from '../js/utils.js';
import { makeGoal, makeWaterEntry, makeJournalEntry, makeWorkout, validateGoal } from '../js/models.js';
import {
  setGoalCompleted,
  isCompletedOn,
  inBucketOn,
  goalStats,
  filterGoals,
  goalStreak,
  todayProgressFraction,
  withCompletionHistory,
  isOverdue,
} from '../js/goals.js';
import { totalOn, metDays, waterStreak, last7Days, averageDaily } from '../js/water.js';
import { journalStreak, searchEntries } from '../js/journal.js';
import { workoutStreak, personalRecords, weeklyVolume } from '../js/gym.js';

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

test('dateKey round-trips local dates', () => {
  assert.equal(dateKey(new Date(2026, 8, 7)), '2026-09-07');
  assert.deepEqual(parseKey('2026-09-07'), new Date(2026, 8, 7));
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('startOfWeekKey is Monday and weekKeys has 7 consecutive days', () => {
  // 2026-09-07 is a Monday.
  assert.equal(startOfWeekKey('2026-09-09'), '2026-09-07');
  const keys = weekKeys('2026-09-09');
  assert.equal(keys.length, 7);
  assert.equal(keys[0], '2026-09-07');
  assert.equal(keys[6], '2026-09-13');
  // Week crossing a month boundary.
  assert.equal(startOfWeekKey('2026-10-01'), '2026-09-28');
});

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

test('streak counts consecutive days ending today', () => {
  assert.equal(calculateStreak(['2026-09-07', '2026-09-06', '2026-09-05'], '2026-09-07'), 3);
});

test('streak still counts when last activity was yesterday', () => {
  assert.equal(calculateStreak(['2026-09-06', '2026-09-05'], '2026-09-07'), 2);
});

test('streak breaks on a missing day', () => {
  assert.equal(calculateStreak(['2026-09-07', '2026-09-05'], '2026-09-07'), 1);
});

test('streak handles multiple entries on the same day', () => {
  assert.equal(calculateStreak(['2026-09-07', '2026-09-07', '2026-09-06'], '2026-09-07'), 2);
});

test('streak is zero for empty input', () => {
  assert.equal(calculateStreak([], '2026-09-07'), 0);
});

test('streak crosses month boundaries correctly', () => {
  assert.equal(calculateStreak(['2026-01-02', '2026-01-01', '2025-12-31', '2025-12-30'], '2026-01-02'), 4);
  // Gap across the boundary breaks it.
  assert.equal(calculateStreak(['2026-01-02', '2025-12-30'], '2026-01-02'), 1);
});

// ---------------------------------------------------------------------------
// Daily progress calculation
// ---------------------------------------------------------------------------

test('all components complete gives 100%', () => {
  assert.equal(calculateDailyProgress({ goals: 1, water: 1, gym: 1, journal: 1 }), 100);
});

test('nothing done gives 0%', () => {
  assert.equal(calculateDailyProgress({ goals: 0, water: 0, gym: 0, journal: 0 }), 0);
});

test('inactive components are excluded from the denominator', () => {
  // Only water active and it is full: 100%, not 30%.
  assert.equal(calculateDailyProgress({ goals: null, water: 1, gym: null, journal: null }), 100);
});

test('partial component scales within its weight', () => {
  // Goals at 50% and nothing else active.
  assert.equal(calculateDailyProgress({ goals: 0.5, water: null, gym: null, journal: null }), 50);
});

test('weights are honored when all active', () => {
  // goals=0 (40%), water=0 (30%), gym=1 (15%), journal=1 (15%) → 30/100
  assert.equal(calculateDailyProgress({ goals: 0, water: 0, gym: 1, journal: 1 }), 30);
});

test('values are clamped to 0..1', () => {
  assert.equal(calculateDailyProgress({ goals: 2, water: -1, gym: 1, journal: 1 }), 70);
});

test('all inactive gives 0', () => {
  assert.equal(calculateDailyProgress({ goals: null, water: null, gym: null, journal: null }), 0);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('formatWater switches unit', () => {
  assert.equal(formatWater(1800, 'L'), '1.8 L');
  assert.equal(formatWater(3000, 'L'), '3 L');
  assert.equal(formatWater(500, 'L'), '500 ml');
  assert.equal(formatWater(2500, 'ml'), '2500 ml');
});

test('trimNumber keeps integers clean', () => {
  assert.equal(trimNumber(3), '3');
  assert.equal(trimNumber(3.5), '3.5');
});

test('greetingFor changes with the hour', () => {
  assert.equal(greetingFor(new Date(2026, 8, 7, 9, 0)), 'Good morning');
  assert.equal(greetingFor(new Date(2026, 8, 7, 15, 0)), 'Good afternoon');
  assert.equal(greetingFor(new Date(2026, 8, 7, 19, 0)), 'Good evening');
  assert.equal(greetingFor(new Date(2026, 8, 7, 23, 0)), 'Good night');
});

// ---------------------------------------------------------------------------
// Models — factories round-trip ids and validate input safely
// ---------------------------------------------------------------------------

test('makeGoal keeps an existing id and sanitizes completion days', () => {
  const goal = makeGoal({ id: 'fixed-id', title: ' X ', completedDays: ['2026-09-07', '2026-09-07', 'bad', 42] });
  assert.equal(goal.id, 'fixed-id');
  assert.equal(goal.title, 'X');
  assert.deepEqual(goal.completedDays, ['2026-09-07']);
});

test('new goal factory defaults completedDays to an empty array', () => {
  assert.deepEqual(makeGoal({ title: 't' }).completedDays, []);
});

test('makeJournalEntry keeps an existing id (edit does not fork entries)', () => {
  const a = makeJournalEntry({ id: 'same', title: 'v1' });
  const b = makeJournalEntry({ id: 'same', title: 'v2' });
  assert.equal(a.id, 'same');
  assert.equal(b.id, 'same');
});

test('water entry factory rejects garbage amounts', () => {
  assert.equal(makeWaterEntry(NaN).amount, 0);
  assert.equal(makeWaterEntry(-5).amount, 0);
  assert.equal(makeWaterEntry('250').amount, 250);
  assert.equal(makeWaterEntry(250.4).amount, 250);
});

test('workout factory clamps negative numbers', () => {
  const w = makeWorkout({ duration: -30, exercises: [{ sets: -2, reps: 8, weight: 60 }] });
  assert.equal(w.duration, 0);
  assert.equal(w.exercises[0].sets, 0);
});

test('validateGoal catches empty titles and inverted fixed ranges', () => {
  assert.match(validateGoal({ title: '' }), /title/i);
  assert.match(validateGoal({ title: 'ok', type: 'weekly', startDate: '2026-09-10', endDate: '2026-09-01' }), /before/i);
  // Custom goals intentionally allow backdating (free date ranges).
  assert.equal(validateGoal({ title: 'ok', type: 'custom', startDate: '2026-09-10', endDate: '2026-09-01' }), null);
});

// ---------------------------------------------------------------------------
// Goals — per-day completion (daily goals reset, streaks survive)
// ---------------------------------------------------------------------------

const completedToday = () => makeGoal({ id: 'g1', title: 't', type: 'daily', completedDays: ['2026-09-10'], completedAt: Date.now(), status: 'completed' });

const TODAY = '2026-09-10';

test('daily goal completed yesterday reads pending today but keeps its history', () => {
  const goal = makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-09'] });
  assert.equal(isCompletedOn(goal, TODAY), false);
  assert.equal(isCompletedOn(goal, '2026-09-09'), true);
});

test('non-daily goal completion is not day-dependent', () => {
  const goal = makeGoal({ title: 't', type: 'weekly', status: 'completed', completedDays: ['2026-09-01'] });
  assert.equal(isCompletedOn(goal, TODAY), true);
  assert.equal(isCompletedOn(goal, '2026-09-01'), true);
});

test('legacy goal with only completedAt migrates its completion day', () => {
  const goal = makeGoal({ title: 't', type: 'daily' });
  goal.completedAt = new Date(2026, 8, 9, 12).getTime();
  delete goal.completedDays;
  const migrated = withCompletionHistory(goal);
  assert.deepEqual(migrated.completedDays, ['2026-09-09']);
  assert.equal(isCompletedOn(migrated, '2026-09-09'), true);
  assert.equal(isCompletedOn(migrated, TODAY), false);
});

test('bucket membership per day (daily always today; custom by range)', () => {
  const daily = makeGoal({ title: 't', type: 'daily' });
  const custom = makeGoal({ title: 't', type: 'custom', startDate: '2026-09-01', endDate: '2026-09-15' });
  const customExpired = makeGoal({ title: 't', type: 'custom', startDate: '2026-08-01', endDate: '2026-08-31' });
  assert.equal(inBucketOn(daily, 'daily', TODAY), true);
  assert.equal(inBucketOn(daily, 'weekly', TODAY), false);
  assert.equal(inBucketOn(custom, 'daily', TODAY), true); // active custom range shows on Today
  assert.equal(inBucketOn(custom, 'custom', TODAY), true);
  assert.equal(inBucketOn(customExpired, 'daily', TODAY), false);
});

test('goalStats and filterGoals honor per-day completion', () => {
  const done = completedToday();
  const pending = makeGoal({ id: 'g2', title: 't2', type: 'daily' });
  const list = [done, pending];
  assert.deepEqual(goalStats(list, TODAY), { total: 2, completed: 1, pending: 1, pct: 50 });
  assert.equal(filterGoals(list, 'completed', TODAY).length, 1);
  assert.equal(filterGoals(list, 'pending', TODAY).length, 1);
  // Same data, viewed for the previous day: nothing was completed then.
  assert.deepEqual(goalStats(list, '2026-09-09'), { total: 2, completed: 0, pending: 2, pct: 0 });
});

test('todayProgressFraction counts only today-completed goals', () => {
  const list = [completedToday(), makeGoal({ id: 'g2', title: 't2', type: 'daily' })];
  assert.equal(todayProgressFraction(list, TODAY), 0.5);
  assert.equal(todayProgressFraction([], TODAY), null);
});

test('goal streak survives the daily reset', () => {
  const goal = makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-10', '2026-09-09', '2026-09-08'] });
  assert.equal(goalStreak([goal]), 3);
});

test('overdue respects per-day completion and missing end dates', () => {
  const overdue = makeGoal({ title: 't', type: 'weekly', endDate: '2026-09-01' });
  const done = makeGoal({ title: 't', type: 'weekly', endDate: '2026-09-01', status: 'completed', completedDays: ['2026-09-01'] });
  const noEnd = makeGoal({ title: 't', type: 'custom' });
  assert.equal(isOverdue(overdue, TODAY), true);
  assert.equal(isOverdue(done, TODAY), false);
  assert.equal(isOverdue(noEnd, TODAY), false);
});

// ---------------------------------------------------------------------------
// Water math — totals, streaks, averages, invalid-value hardening
// ---------------------------------------------------------------------------

test('totalOn sums only the requested day and handles big/zero values', () => {
  const entries = [
    makeWaterEntry(250, new Date(2026, 8, 10, 8).getTime()),
    makeWaterEntry(4800, new Date(2026, 8, 10, 12).getTime()),
    makeWaterEntry(99999, new Date(2026, 8, 9, 9).getTime()),
    makeWaterEntry(0, new Date(2026, 8, 10, 13).getTime()),
  ];
  assert.equal(totalOn(entries, '2026-09-10'), 5050);
  assert.equal(totalOn(entries, '2026-09-09'), 99999);
  assert.equal(totalOn(entries, '2026-09-11'), 0);
});

test('water streak counts days at/above target and breaks on gaps', () => {
  const entries = [];
  // 8/9/10 hit 3000; 6 does not; 5 hits.
  for (const [d, ml] of [[10, 3000], [9, 3000], [8, 3000], [6, 2500], [5, 3000]]) {
    entries.push(makeWaterEntry(ml, new Date(2026, 8, d, 10).getTime()));
  }
  assert.deepEqual(metDays(entries, () => '2026-09-10').sort(), ['2026-09-05', '2026-09-08', '2026-09-09', '2026-09-10']);
});

test('water streak helper composes with calculateStreak', () => {
  const entries = [makeWaterEntry(3000, new Date(2026, 8, 10, 8).getTime()), makeWaterEntry(3000, new Date(2026, 8, 9, 8).getTime())];
  assert.equal(waterStreak(entries), 2);
});

test('last7Days clamps percentage to 0..100 and labels today', () => {
  const entries = [makeWaterEntry(99999, new Date(2026, 8, 10, 8).getTime())];
  const week = last7Days(entries);
  assert.equal(week.length, 7);
  assert.equal(week[6].label, 'Today');
  assert.ok(week[6].pct >= 0 && week[6].pct <= 100);
  // 99999 ml always clears any target → last bar (today, by construction) full.
  assert.ok(week.some((d) => d.pct === 100), `expected a full day, got ${JSON.stringify(week.map((d) => d.pct))}`);
});

test('averageDaily only counts the trailing window', () => {
  const today = new Date();
  const at = (daysAgo, ml) =>
    makeWaterEntry(ml, new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, 8).getTime());
  const entries = [at(0, 1000), at(6, 3000), at(7, 500)];
  assert.equal(averageDaily(entries, 7), Math.round(4000 / 7));
  assert.equal(averageDaily([], 7), 0);
});

// ---------------------------------------------------------------------------
// Journal + gym helpers
// ---------------------------------------------------------------------------

test('journal streak counts days, not entries', () => {
  const entries = [
    makeJournalEntry({ title: 'a', date: '2026-09-10' }),
    makeJournalEntry({ title: 'b', date: '2026-09-10' }),
    makeJournalEntry({ title: 'c', date: '2026-09-09' }),
  ];
  assert.equal(journalStreak(entries), 2);
});

test('searchEntries matches title, content and tags case-insensitively', () => {
  const entries = [makeJournalEntry({ title: 'Gym Day', content: 'heavy squats', tags: ['win'] })];
  assert.equal(searchEntries(entries, 'SQUAT').length, 1);
  assert.equal(searchEntries(entries, 'win').length, 1);
  assert.equal(searchEntries(entries, 'zzz').length, 0);
  assert.equal(searchEntries(entries, '').length, 1);
});

test('workout streak de-duplicates same-day workouts', () => {
  const mk = (d, created) => makeWorkout({ date: d, createdAt: created });
  const list = [mk('2026-09-10', 2), mk('2026-09-10', 1), mk('2026-09-09', 1)];
  assert.equal(workoutStreak(list), 2);
});

test('personalRecords keeps the best weight per exercise', () => {
  const mk = (name, weight, reps, d) => makeWorkout({ date: d, exercises: [{ exerciseName: name, sets: 3, reps, weight }] });
  const list = [
    mk('Bench', 60, 8, '2026-09-10'),
    mk('Bench', 70, 5, '2026-09-09'),
    mk('Squat', 100, 5, '2026-09-08'),
    mk('Zero', 0, 10, '2026-09-07'),
  ];
  const prs = personalRecords(list);
  assert.equal(prs.length, 2);
  assert.equal(prs[0].name, 'Squat');
  assert.equal(prs.find((r) => r.name === 'Bench').weight, 70);
});

test('weeklyVolume buckets totals into Monday-start weeks', () => {
  const mk = (d, minutes) => makeWorkout({ date: d, duration: minutes });
  const list = [mk('2026-09-10', 45), mk('2026-09-07', 30), mk('2026-08-31', 99)];
  const volume = weeklyVolume(list, 2);
  assert.equal(volume.length, 2);
  assert.equal(volume[1].minutes, 75); // week of 2026-09-07
  assert.equal(volume[0].minutes, 99); // week of 2026-08-31
});

// ---------------------------------------------------------------------------
// Misc date helpers used across screens
// ---------------------------------------------------------------------------

test('monthKey, daysBetween and formatDate basics', () => {
  assert.equal(monthKey('2026-09-10'), '2026-09');
  assert.equal(daysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(daysBetween('2026-09-01', '2026-08-31'), -1);
  // A non-today, non-yesterday key formats in full (date-relative, not fixed).
  assert.equal(formatDate('2026-03-15', { noToday: true }), 'Sunday, March 15');
  assert.equal(clamp(150, 0, 100), 100);
});