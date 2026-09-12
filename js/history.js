/**
 * History — a read/aggregation layer over the four activity domains.
 *
 * Phase 1 of V1.2: the calendar + day details. Everything here is DERIVED
 * from the existing stores (waterEntries, workouts, goals, journalEntries);
 * no history data is persisted and no store schema is touched. Future V1.2
 * phases (achievements, gym progression, journal intelligence, …) build on
 * the same summaries.
 *
 * Layering:  SCREEN → history.js → domain modules → db.js
 * (The screen never touches IndexedDB, and this module never mounts UI.)
 *
 * All date math uses the app's local-date key utilities (`YYYY-MM-DD` strings
 * that compare lexicographically) so activity can never shift days due to
 * UTC conversion. `today` is injectable for deterministic tests.
 */

import { addDays, dateKey, todayKey } from './utils.js';
import { isCompletedOn, inBucketOn } from './goals.js';
import { totalOn, metDays } from './water.js';

// ---------------------------------------------------------------------------
// Calendar month generation (pure)
// ---------------------------------------------------------------------------

/** Monday-first weekday labels. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Build the 6×7 grid of day cells for a month (Monday-first, matching
 * startOfWeekKey). Out-of-month leading/trailing days are included with
 * `inMonth: false` so the grid always fills exactly 42 cells and weeks stay
 * aligned. Returns cell descriptors only — no activity information.
 *
 * @param {number} year  full year (e.g. 2026)
 * @param {number} month 0-based month (0 = January, 11 = December)
 */
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    cells.push({
      key: dateKey(d),
      day: d.getDate(),
      month: d.getMonth(),
      year: d.getFullYear(),
      inMonth: d.getMonth() === month && d.getFullYear() === year,
    });
  }
  return cells;
}

/** Number of days in a month (leap-year aware). */
export function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

/** The month containing `key`, as { year, month } (month 0-based). */
export function monthOf(key) {
  return { year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)) - 1 };
}

/** `YYYY-MM` for a year/month pair (month 0-based). */
export function monthKeyOf(year, month) {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Previous/next month as { year, month }; pure so year rollover is trivial. */
export function prevMonth(year, month) {
  return month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 };
}

export function nextMonth(year, month) {
  return month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 };
}

/** Human label for the month navigation header. */
export function monthLabel(year, month) {
  return new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Activity aggregation (pure — operates on plain arrays from the stores)
// ---------------------------------------------------------------------------

/** The four tracked activity categories. */
export const ACTIVITY_TYPES = ['water', 'gym', 'goals', 'journal'];

/**
 * One day's activity as a clean domain-level summary (never raw records):
 *   { date, water, gym, goals, journal, activityCount }
 *
 *   water   { logged, total, targetMet }
 *   gym     { workouts, types, minutes }
 *   goals   { completed, total, due }   — daily goals that existed on that day
 *   journal { entries }
 */
export function summarizeDay(date, data, today = todayKey()) {
  const waterTotal = totalOn(data.waterEntries || [], date);
  const workouts = (data.workouts || []).filter((w) => w.date === date);
  const journalEntries = (data.journalEntries || []).filter((e) => e.date === date);

  // Goal activity: completions recorded on that date (per-day history for
  // recurring goals, legacy completedAt fallback) plus which daily/custom
  // goals were in scope on the day, so "3/4 completed" is honest.
  const goalDays = new Set();
  const goalsData = data.goals || [];
  for (const g of goalsData) {
    if (g.completedDays?.length) {
      for (const k of g.completedDays) if (k === date) goalDays.add(k);
    } else if (g.completedAt && dateKey(new Date(g.completedAt)) === date) {
      goalDays.add(date);
    }
  }
  const dueGoals = goalsData.filter((g) => inBucketOn(g, 'daily', date));
  const dueCompleted = dueGoals.filter((g) => isCompletedOn(g, date)).length;
  const goalsActivity = dueCompleted > 0 || goalDays.size > 0;

  return {
    date,
    water: {
      logged: waterTotal > 0,
      total: waterTotal,
      targetMet: waterTotal > 0 && metDays([{ date, amount: waterTotal }]).includes(date),
    },
    gym: {
      workouts: workouts.length,
      types: [...new Set(workouts.map((w) => w.workoutType).filter(Boolean))],
      minutes: workouts.reduce((sum, w) => sum + (w.duration || 0), 0),
    },
    goals: {
      completed: goalDays.size > 0 ? Math.max(dueCompleted, 1) : dueCompleted,
      total: dueGoals.length,
      due: dueGoals.length,
      activity: goalsActivity,
    },
    journal: { entries: journalEntries.length },
    activityCount:
      (waterTotal > 0 ? 1 : 0) +
      (workouts.length > 0 ? 1 : 0) +
      (goalsActivity ? 1 : 0) +
      (journalEntries.length > 0 ? 1 : 0),
  };
}

/**
 * Which of the four activity categories happened on `date`. Dots in the
 * calendar are driven by this, in a fixed display order.
 */
export function activityForDate(date, data, today = todayKey()) {
  const s = summarizeDay(date, data, today);
  const types = [];
  if (s.water.logged) types.push('water');
  if (s.gym.workouts > 0) types.push('gym');
  if (s.goals.activity) types.push('goals');
  if (s.journal.entries > 0) types.push('journal');
  return types;
}

/**
 * Aggregate a whole month into Map<dateKey, { water, gym, goals, journal }> —
 * one pass over each dataset, then O(1) lookups per calendar cell. This is
 * what the calendar renders from; it must never query per-cell.
 *
 * @returns {Map<string, {water:boolean, gym:boolean, goals:boolean, journal:boolean, count:number}>}
 */
export function monthActivity(year, month, data, today = todayKey()) {
  const prefix = monthKeyOf(year, month);
  const days = new Map();

  const touch = (key) => {
    if (!key || !key.startsWith(prefix)) return null;
    if (!days.has(key)) {
      days.set(key, { water: false, gym: false, goals: false, journal: false, count: 0 });
    }
    return days.get(key);
  };

  for (const e of data.waterEntries || []) {
    const cell = e.date && touch(e.date);
    if (cell && !cell.water) {
      cell.water = true;
      cell.count += 1;
    }
  }
  for (const w of data.workouts || []) {
    const cell = touch(w.date);
    if (cell && !cell.gym) {
      cell.gym = true;
      cell.count += 1;
    }
  }
  for (const e of data.journalEntries || []) {
    const cell = touch(e.date);
    if (cell && !cell.journal) {
      cell.journal = true;
      cell.count += 1;
    }
  }
  for (const g of data.goals || []) {
    // Per-day completion history (recurring goals) or the legacy timestamp.
    const keys = g.completedDays?.length
      ? g.completedDays
      : g.completedAt
        ? [dateKey(new Date(g.completedAt))]
        : [];
    for (const k of keys) {
      const cell = touch(k);
      if (cell && !cell.goals) {
        cell.goals = true;
        cell.count += 1;
      }
    }
  }

  return days;
}

/**
 * History for a date range (inclusive) — the foundation for future V1.2
 * features that need spans (achievements, progression charts). Returns
 * one summarizeDay() result per day that has any activity.
 */
export function dateRangeHistory(startDate, endDate, data, today = todayKey()) {
  const out = [];
  for (let key = startDate; key <= endDate; key = addDays(key, 1)) {
    const summary = summarizeDay(key, data, today);
    if (summary.activityCount > 0) out.push(summary);
  }
  return out;
}

/**
 * Screen-level loader: fetches the four stores once and returns the plain
 * arrays history functions operate on. Keeps the storage shape out of the
 * screen and avoids repeated IndexedDB reads while navigating months.
 */
export async function loadHistoryData() {
  const { dbGetAll } = await import('./db.js');
  const [waterEntries, goals, workouts, journalEntries] = await Promise.all([
    dbGetAll('waterEntries'),
    dbGetAll('goals'),
    dbGetAll('workouts'),
    dbGetAll('journalEntries'),
  ]);
  return { waterEntries, goals, workouts, journalEntries };
}
