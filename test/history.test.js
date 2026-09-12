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
  summarizeDay,
  activityForDate,
  monthActivity,
  dateRangeHistory,
} from '../js/history.js';
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
