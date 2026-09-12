import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKDAY_LABELS,
  monthGrid,
  daysInMonth,
  monthOf,
  monthKeyOf,
  prevMonth,
  nextMonth,
  monthLabel,
  ACTIVITY_TYPES,
  CATEGORIES,
  summarizeDay,
  activityForDate,
  monthActivity,
  dateRangeHistory,
  completionIndex,
  computeStreaks,
  streakMotivation,
  categoryHeader,
} from '../js/history.js';
import { calculateBestStreak } from '../js/utils.js';
import { makeGoal, makeWaterEntry, makeWorkout, makeJournalEntry } from '../js/models.js';

const TODAY = '2026-09-11'; // fixed reference date (a Friday) for determinism

// ---------------------------------------------------------------------------
// Calendar month generation
// ---------------------------------------------------------------------------

test('WEEKDAY_LABELS are Monday-first', () => {
  assert.deepEqual(WEEKDAY_LABELS, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
});

test('monthGrid produces 42 cells with Monday-first alignment', () => {
  // 2026-09-01 is a Tuesday → grid starts Monday 2026-08-31.
  const cells = monthGrid(2026, 8);
  assert.equal(cells.length, 42);
  assert.equal(cells[0].key, '2026-08-31');
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[1].key, '2026-09-01');
  assert.equal(cells[1].inMonth, true);
  // Last in-month day is the 30th; the rest trail into October.
  const lastInMonth = cells.findLast((c) => c.inMonth);
  assert.equal(lastInMonth.key, '2026-09-30');
});

test('monthGrid handles 28-day months', () => {
  const cells = monthGrid(2026, 1); // February 2026 (non-leap)
  const inMonth = cells.filter((c) => c.inMonth);
  assert.equal(inMonth.length, 28);
  assert.equal(inMonth.at(-1).key, '2026-02-28');
});

test('monthGrid handles 29-day February (leap year)', () => {
  const cells = monthGrid(2028, 1); // 2028 is a leap year
  const inMonth = cells.filter((c) => c.inMonth);
  assert.equal(inMonth.length, 29);
  assert.equal(inMonth.at(-1).key, '2028-02-29');
});

test('monthGrid handles 30- and 31-day months', () => {
  assert.equal(monthGrid(2026, 3).filter((c) => c.inMonth).length, 30); // April
  assert.equal(monthGrid(2026, 0).filter((c) => c.inMonth).length, 31); // January
});

test('monthGrid crosses year boundaries', () => {
  // January 2027: grid starts Monday 2026-12-28 (December belongs to 2026).
  const cells = monthGrid(2027, 0);
  assert.equal(cells[0].key, '2026-12-28');
  assert.equal(cells[0].year, 2026);
  const last = cells.findLast((c) => c.inMonth);
  assert.equal(last.key, '2027-01-31');
  // December 2026: trailing cells belong to 2027.
  const dec = monthGrid(2026, 11);
  assert.equal(dec.findLast((c) => c.inMonth).key, '2026-12-31');
  assert.equal(dec.at(-1).year, 2027);
});

test('daysInMonth is leap-year aware', () => {
  assert.equal(daysInMonth(2026, 1), 28);
  assert.equal(daysInMonth(2028, 1), 29);
  assert.equal(daysInMonth(2026, 8), 30);
  assert.equal(daysInMonth(2026, 0), 31);
  assert.equal(daysInMonth(2000, 1), 29); // divisible by 400 → leap
  assert.equal(daysInMonth(1900, 1), 28); // divisible by 100 but not 400 → not leap
});

test('monthOf, monthKeyOf, prevMonth and nextMonth roll over years', () => {
  assert.deepEqual(monthOf('2026-09-11'), { year: 2026, month: 8 });
  assert.equal(monthKeyOf(2026, 8), '2026-09');
  assert.equal(monthKeyOf(2026, 0), '2026-01');
  assert.deepEqual(prevMonth(2026, 0), { year: 2025, month: 11 });
  assert.deepEqual(nextMonth(2026, 11), { year: 2027, month: 0 });
  assert.deepEqual(prevMonth(2026, 8), { year: 2026, month: 7 });
  assert.deepEqual(nextMonth(2026, 8), { year: 2026, month: 9 });
});

test('monthLabel renders a human month/year', () => {
  assert.equal(monthLabel(2026, 8), 'September 2026');
});

// ---------------------------------------------------------------------------
// Activity aggregation
// ---------------------------------------------------------------------------

const baseData = () => ({ waterEntries: [], goals: [], workouts: [], journalEntries: [] });

test('water activity detected from entries on the date', () => {
  const data = baseData();
  data.waterEntries = [makeWaterEntry(500, new Date(2026, 8, 10, 8).getTime())];
  const s = summarizeDay('2026-09-10', data, TODAY);
  assert.equal(s.water.logged, true);
  assert.equal(s.water.total, 500);
  assert.equal(s.activityCount, 1);
  assert.deepEqual(activityForDate('2026-09-10', data, TODAY), ['water']);
});

test('gym activity detected from workouts on the date', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: '2026-09-10', workoutType: 'Strength', duration: 45 })];
  const s = summarizeDay('2026-09-10', data, TODAY);
  assert.equal(s.gym.workouts, 1);
  assert.equal(s.gym.minutes, 45);
  assert.deepEqual(s.gym.types, ['Strength']);
  assert.deepEqual(activityForDate('2026-09-10', data, TODAY), ['gym']);
});

test('goal activity detected from per-day completion history', () => {
  const data = baseData();
  data.goals = [makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-10'] })];
  const s = summarizeDay('2026-09-10', data, TODAY);
  assert.equal(s.goals.activity, true);
  assert.deepEqual(activityForDate('2026-09-10', data, TODAY), ['goals']);
});

test('goal activity detected from legacy completedAt timestamps', () => {
  const data = baseData();
  data.goals = [{ ...makeGoal({ title: 'legacy', type: 'custom' }), completedDays: [], completedAt: new Date(2026, 8, 10, 14).getTime() }];
  const s = summarizeDay('2026-09-10', data, TODAY);
  assert.equal(s.goals.activity, true);
});

test('journal activity detected from entries on the date', () => {
  const data = baseData();
  data.journalEntries = [makeJournalEntry({ title: 'a', date: '2026-09-10' })];
  const s = summarizeDay('2026-09-10', data, TODAY);
  assert.equal(s.journal.entries, 1);
  assert.deepEqual(activityForDate('2026-09-10', data, TODAY), ['journal']);
});

test('multiple activity types on one date are all detected', () => {
  const data = baseData();
  data.waterEntries = [makeWaterEntry(250, new Date(2026, 8, 10, 9).getTime())];
  data.workouts = [makeWorkout({ date: '2026-09-10', workoutType: 'Cardio' })];
  data.goals = [makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-10'] })];
  data.journalEntries = [makeJournalEntry({ title: 'a', date: '2026-09-10' })];
  assert.equal(summarizeDay('2026-09-10', data, TODAY).activityCount, 4);
  assert.deepEqual(activityForDate('2026-09-10', data, TODAY), ['water', 'gym', 'goals', 'journal']);
  assert.equal(ACTIVITY_TYPES.length, 4);
});

test('no activity produces an empty summary (all zeroed)', () => {
  const s = summarizeDay('2026-09-05', baseData(), TODAY);
  assert.equal(s.water.logged, false);
  assert.equal(s.water.total, 0);
  assert.equal(s.gym.workouts, 0);
  assert.equal(s.goals.activity, false);
  assert.equal(s.journal.entries, 0);
  assert.equal(s.activityCount, 0);
  assert.deepEqual(activityForDate('2026-09-05', baseData(), TODAY), []);
});

test('summaries are grouped by LOCAL date, never shifted by UTC', () => {
  // 2026-09-01 local, 23:30 → in UTC that instant is already Sep 2. The
  // local date must win: the entry stays on September 1.
  const data = baseData();
  data.waterEntries = [makeWaterEntry(300, new Date(2026, 8, 1, 23, 30).getTime())];
  assert.equal(summarizeDay('2026-09-01', data, TODAY).water.total, 300);
  assert.equal(summarizeDay('2026-08-31', data, TODAY).water.total, 0);
  assert.equal(summarizeDay('2026-09-02', data, TODAY).water.total, 0);
});

test('monthActivity aggregates one cell per day with the right flags', () => {
  const data = baseData();
  data.waterEntries = [makeWaterEntry(250, new Date(2026, 8, 10, 8).getTime())];
  data.workouts = [makeWorkout({ date: '2026-09-11', workoutType: 'Strength' })];
  data.journalEntries = [makeJournalEntry({ title: 'a', date: '2026-09-11' })];
  data.goals = [makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-11'] })];
  const days = monthActivity(2026, 8, data, TODAY);
  assert.equal(days.size, 2);
  assert.deepEqual(days.get('2026-09-10'), { water: true, gym: false, goals: false, journal: false, count: 1 });
  assert.deepEqual(days.get('2026-09-11'), { water: false, gym: true, goals: true, journal: true, count: 3 });
});

test('monthActivity ignores records outside the requested month', () => {
  const data = baseData();
  data.waterEntries = [
    makeWaterEntry(250, new Date(2026, 7, 31, 10).getTime()), // Aug 31
    makeWaterEntry(250, new Date(2026, 8, 1, 10).getTime()), // Sep 1
    makeWaterEntry(250, new Date(2026, 9, 1, 10).getTime()), // Oct 1
  ];
  const days = monthActivity(2026, 8, data, TODAY);
  assert.equal(days.size, 1);
  assert.ok(days.has('2026-09-01'));
});

test('dateRangeHistory returns only active days across a boundary', () => {
  const data = baseData();
  data.waterEntries = [makeWaterEntry(250, new Date(2026, 8, 30, 8).getTime())];
  data.workouts = [makeWorkout({ date: '2026-10-02', workoutType: 'Yoga' })];
  const range = dateRangeHistory('2026-09-29', '2026-10-03', data, TODAY);
  assert.deepEqual(range.map((s) => s.date), ['2026-09-30', '2026-10-02']);
});

// ---------------------------------------------------------------------------
// Categories & completion states (V1.2 enhancement)
// ---------------------------------------------------------------------------

test('CATEGORIES lists the five calendar views in display order', () => {
  assert.deepEqual(CATEGORIES, ['all', 'water', 'gym', 'goals', 'journal']);
});

test('water completion follows the daily target (met vs partial)', () => {
  const data = baseData();
  data.waterEntries = [
    makeWaterEntry(3000, new Date(2026, 8, 10, 9).getTime()), // = default target → completed
    makeWaterEntry(500, new Date(2026, 8, 11, 9).getTime()), // below target → partial
  ];
  const idx = completionIndex(data, TODAY);
  assert.equal(idx.get('2026-09-10').water, 'completed');
  assert.equal(idx.get('2026-09-11').water, 'partial');
  assert.equal(idx.get('2026-09-05')?.water || 'empty', 'empty');
});

test('water partial promotes to completed when entries sum past the target', () => {
  const data = baseData();
  data.waterEntries = [
    makeWaterEntry(1500, new Date(2026, 8, 10, 8).getTime()),
    makeWaterEntry(1500, new Date(2026, 8, 10, 14).getTime()),
  ];
  assert.equal(completionIndex(data, TODAY).get('2026-09-10').water, 'completed');
});

test('gym completion requires a logged workout; other days stay empty', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: '2026-09-10', workoutType: 'Strength' })];
  const idx = completionIndex(data, TODAY);
  assert.equal(idx.get('2026-09-10').gym, 'completed');
  assert.equal(idx.get('2026-09-11')?.gym || 'empty', 'empty');
});

test('goals completion is honest: all-due vs some-due', () => {
  const data = baseData();
  data.goals = [
    makeGoal({ title: 'a', type: 'daily', completedDays: ['2026-09-10'] }),
    makeGoal({ title: 'b', type: 'daily', startDate: '2026-09-01', endDate: '2026-09-30' }),
  ];
  const idx = completionIndex(data, TODAY);
  // Only one of the two in-scope goals is completed → partial, never a fake ✓.
  assert.equal(idx.get('2026-09-10').goals, 'partial');
  // A day whose due goals are all completed → completed.
  data.goals[1].completedDays = ['2026-09-10'];
  assert.equal(completionIndex(data, TODAY).get('2026-09-10').goals, 'completed');
});

test('goals completion on a day with no due goals still counts', () => {
  const data = baseData();
  // A completion recorded outside the goal's date range (e.g. a custom goal
  // completed after its window) has no due goals that day — it still counts.
  data.goals = [makeGoal({ title: 'one-off', type: 'custom', startDate: '2026-09-05', endDate: '2026-09-05', completedDays: ['2026-09-01'] })];
  const idx = completionIndex(data, TODAY);
  assert.equal(idx.get('2026-09-01').goals, 'completed');
});

test('journal completion marks any day with an entry', () => {
  const data = baseData();
  data.journalEntries = [makeJournalEntry({ title: 'a', date: '2026-09-10' })];
  assert.equal(completionIndex(data, TODAY).get('2026-09-10').journal, 'completed');
});

test('all category: completed only when EVERY active category is complete', () => {
  const data = baseData();
  data.waterEntries = [makeWaterEntry(3000, new Date(2026, 8, 10, 9).getTime())];
  data.workouts = [makeWorkout({ date: '2026-09-10', workoutType: 'Strength' })];
  data.journalEntries = [makeJournalEntry({ title: 'a', date: '2026-09-10' })];
  // water ✓ gym ✓ journal ✓ and no goal activity → completed: an inactive
  // category never punishes the day (mirrors calculateDailyProgress).
  assert.equal(completionIndex(data, TODAY).get('2026-09-10').all, 'completed');
  // …but a PARTIAL active category breaks the full completion.
  data.waterEntries = [makeWaterEntry(500, new Date(2026, 8, 10, 9).getTime())];
  assert.equal(completionIndex(data, TODAY).get('2026-09-10').all, 'partial');
});

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

test('calculateBestStreak finds the longest run, order- and duplicate-proof', () => {
  assert.equal(calculateBestStreak([]), 0);
  assert.equal(calculateBestStreak(['2026-09-10']), 1);
  assert.equal(calculateBestStreak(['2026-09-05', '2026-09-10', '2026-09-11', '2026-09-12']), 3);
  assert.equal(calculateBestStreak(['2026-09-10', '2026-09-10', '2026-09-11']), 2);
  assert.equal(calculateBestStreak(['2026-12-30', '2026-12-31', '2027-01-01']), 3); // year boundary
  assert.equal(calculateBestStreak(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']), 4); // leap day
});

test('computeStreaks water: current, best and endingToday', () => {
  const data = baseData();
  data.waterEntries = [
    makeWaterEntry(3000, new Date(2026, 8, 9, 9).getTime()),
    makeWaterEntry(3000, new Date(2026, 8, 10, 9).getTime()),
    makeWaterEntry(3000, new Date(2026, 8, 11, 9).getTime()),
    // A broken patch earlier in the month.
    makeWaterEntry(3000, new Date(2026, 8, 2, 9).getTime()),
    makeWaterEntry(3000, new Date(2026, 8, 3, 9).getTime()),
    makeWaterEntry(3000, new Date(2026, 8, 4, 9).getTime()),
  ];
  const s = computeStreaks('water', data, TODAY);
  assert.equal(s.current, 3);
  assert.equal(s.best, 3);
  assert.equal(s.endingToday, true);
});

test('computeStreaks keeps today-or-yesterday grace for an unfinished today', () => {
  const data = baseData();
  data.waterEntries = [
    makeWaterEntry(3000, new Date(2026, 8, 10, 9).getTime()), // yesterday only
  ];
  const s = computeStreaks('water', data, TODAY);
  assert.equal(s.current, 1); // streak alive by grace
  assert.equal(s.endingToday, false); // …but today is not part of it yet
  assert.equal(streakMotivation('water', false, true), 'You’re one action away from keeping your streak going.');
});

test('computeStreaks gym/goals/journal use their own day sets', () => {
  const gymData = baseData();
  gymData.workouts = [
    makeWorkout({ date: '2026-09-11', workoutType: 'Strength' }),
    makeWorkout({ date: '2026-09-10', workoutType: 'Cardio' }),
  ];
  assert.equal(computeStreaks('gym', gymData, TODAY).current, 2);

  const goalData = baseData();
  goalData.goals = [makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-11', '2026-09-10', '2026-09-09'] })];
  assert.equal(computeStreaks('goals', goalData, TODAY).current, 3);

  const journalData = baseData();
  journalData.journalEntries = [
    makeJournalEntry({ title: 'a', date: '2026-09-11' }),
    makeJournalEntry({ title: 'b', date: '2026-09-11' }), // same day → counts once
    makeJournalEntry({ title: 'c', date: '2026-09-10' }),
  ];
  assert.equal(computeStreaks('journal', journalData, TODAY).current, 2);
});

test('computeStreaks all: a day counts only when every active category completed', () => {
  const data = baseData();
  // Sep 9–11: everything done (one daily goal completed each day).
  // Sep 8: only partial water → NOT counted (honest, no free pass).
  data.goals = [
    makeGoal({ title: 'daily habit', type: 'daily', completedDays: ['2026-09-09', '2026-09-10', '2026-09-11'] }),
  ];
  for (const day of [9, 10, 11]) {
    data.waterEntries.push(makeWaterEntry(3000, new Date(2026, 8, day, 9).getTime()));
    data.workouts.push(makeWorkout({ date: `2026-09-${String(day).padStart(2, '0')}`, workoutType: 'Strength' }));
    data.journalEntries.push(makeJournalEntry({ title: 'a', date: `2026-09-${String(day).padStart(2, '0')}` }));
  }
  data.waterEntries.push(makeWaterEntry(500, new Date(2026, 8, 8, 9).getTime()));
  const s = computeStreaks('all', data, TODAY);
  assert.equal(s.current, 3);
  assert.equal(s.best, 3);
});

test('computeStreaks handles broken and single-day streaks honestly', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: '2026-09-05', workoutType: 'Strength' })];
  const s = computeStreaks('gym', data, TODAY);
  assert.equal(s.current, 0); // ended 6 days ago
  assert.equal(s.best, 1);
  assert.equal(s.endingToday, false);
});

// ---------------------------------------------------------------------------
// Motivational messaging + headers
// ---------------------------------------------------------------------------

test('streakMotivation pins every branch honestly', () => {
  assert.equal(streakMotivation('water', true, true), 'Streak alive 🔥');
  assert.equal(streakMotivation('water', true, false), 'Done. Tomorrow it becomes a streak.');
  assert.equal(streakMotivation('gym', false, true), 'You’re one action away from keeping your streak going.');
  assert.equal(streakMotivation('gym', false, false), 'Your new streak starts today.');
  assert.equal(streakMotivation('all', true, true), 'Every category done today. Streak alive 🔥');
  assert.equal(streakMotivation('all', false, false), 'Small wins every day become your progress.');
});

test('categoryHeader switches the title/tagline per view', () => {
  assert.deepEqual(categoryHeader('all'), { title: 'History', tagline: 'Your journey, day by day.' });
  assert.equal(categoryHeader('water').title, 'Water History');
  assert.equal(categoryHeader('gym').tagline, 'Stronger every day.');
  assert.equal(categoryHeader('goals').title, 'Goals History');
  assert.equal(categoryHeader('journal').tagline, 'Keep showing up for yourself.');
});
