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

import { addDays, dateKey, todayKey, calculateStreak, calculateBestStreak } from './utils.js';
import { isCompletedOn, inBucketOn, goalCompletionDays } from './goals.js';
import { totalOn, metDays, waterTarget } from './water.js';

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
 * The calendar views History can show. "all" combines every category;
 * the rest focus one habit. Fixed display order for the selector.
 */
export const CATEGORIES = ['all', 'water', 'gym', 'goals', 'journal'];

/**
 * Day-level state for a calendar cell, per category. Completion is always
 * honest — it uses each domain's own definition:
 *   water   → the daily water target was reached that day (existing metDays)
 *   gym     → a workout was logged
 *   goals   → every goal due that day was completed (a completion with no
 *             due goals also counts; partial = some activity but not all)
 *   journal → a journal entry exists
 *   all     → every category that was active that day is complete
 *             ("completed" = all 4 logged; "partial" = any activity)
 *
 * Values: 'completed' | 'partial' | 'empty'.
 */
export function completionIndex(data, today = todayKey()) {
  const idx = new Map();
  const bump = (key, cat, state) => {
    if (!idx.has(key)) idx.set(key, { all: 'empty', water: 'empty', gym: 'empty', goals: 'empty', journal: 'empty' });
    idx.get(key)[cat] = state;
  };

  // WATER — target-met days (existing semantics) are completed; other days
  // with entries are partial. Reuses totalsByDay so this is one pass.
  const totals = new Map();
  for (const e of data.waterEntries || []) {
    if (e.date) totals.set(e.date, (totals.get(e.date) || 0) + e.amount);
  }
  const target = waterTarget();
  for (const [key, total] of totals) {
    bump(key, 'water', total >= target ? 'completed' : 'partial');
  }

  // GYM — any logged workout is a completed day.
  for (const w of data.workouts || []) {
    if (w.date) bump(w.date, 'gym', 'completed');
  }

  // GOALS — completions recorded on the day (recurring history or legacy
  // timestamp), judged against the goals that were due that day.
  const dueCache = new Map();
  const dueOn = (key) => {
    if (!dueCache.has(key)) {
      dueCache.set(key, (data.goals || []).filter((g) => inBucketOn(g, 'daily', key)));
    }
    return dueCache.get(key);
  };
  for (const key of goalCompletionDays(data.goals || [])) {
    const due = dueOn(key);
    const done = due.filter((g) => isCompletedOn(g, key)).length;
    bump(key, 'goals', due.length === 0 || done === due.length ? 'completed' : 'partial');
  }

  // JOURNAL — any entry counts as a completed day.
  for (const e of data.journalEntries || []) {
    if (e.date) bump(e.date, 'journal', 'completed');
  }

  // ALL — "completed" only when every active category that day is complete.
  for (const row of idx.values()) {
    const cats = ACTIVITY_TYPES.filter((c) => row[c] !== 'empty');
    row.all = cats.length === 0 ? 'empty' : cats.every((c) => row[c] === 'completed') ? 'completed' : 'partial';
  }

  void today;
  return idx;
}

/**
 * Current + best streak for one category, reusing the existing domain streak
 * semantics (calculateStreak with today-or-yesterday grace; no new algorithm).
 *
 *   water   → waterStreak (target-met days)
 *   gym     → workoutStreak (workout days)
 *   goals   → goalStreak (any goal completion days)
 *   journal → journalStreak (days with entries)
 *   all     → consistency streak: a day counts when EVERY category active
 *             that day is complete (see completionIndex). Documented and
 *             unit-tested; individual category semantics are untouched.
 *
 * Returns { current, best, endingToday } — endingToday tells the UI whether
 * today is already part of the current streak (drives the motivational line).
 */
export function computeStreaks(category, data, today = todayKey()) {
  let days;
  switch (category) {
    case 'water':
      days = metDays(data.waterEntries || []);
      break;
    case 'gym':
      days = (data.workouts || []).map((w) => w.date).filter(Boolean);
      break;
    case 'goals':
      days = goalCompletionDays(data.goals || []);
      break;
    case 'journal':
      days = [...new Set((data.journalEntries || []).map((e) => e.date).filter(Boolean))];
      break;
    case 'all':
    default: {
      const idx = completionIndex(data, today);
      days = [...idx.entries()].filter(([, row]) => row.all === 'completed').map(([key]) => key);
      break;
    }
  }
  const current = calculateStreak(days, today);
  return { current, best: calculateBestStreak(days), endingToday: current > 0 && days.includes(today) };
}

/**
 * Short, honest, non-guilt motivational line for the current state.
 * `doneToday` = the selected category is completed today; `alive` = the
 * category's current streak is > 0. Pure so tests can pin every branch.
 */
export function streakMotivation(category, doneToday, alive) {
  if (category === 'all' && doneToday) return 'Every category done today. Streak alive 🔥';
  if (category === 'all') return 'Small wins every day become your progress.';
  if (doneToday) return alive ? 'Streak alive 🔥' : 'Done. Tomorrow it becomes a streak.';
  if (alive) return 'You’re one action away from keeping your streak going.';
  return 'Your new streak starts today.';
}

/** Header + tagline for a category view (see the History screen). */
export function categoryHeader(category) {
  switch (category) {
    case 'water':
      return { title: 'Water History', tagline: 'Keep the hydration going.' };
    case 'gym':
      return { title: 'Gym History', tagline: 'Stronger every day.' };
    case 'goals':
      return { title: 'Goals History', tagline: 'One step closer.' };
    case 'journal':
      return { title: 'Journal History', tagline: 'Keep showing up for yourself.' };
    case 'all':
    default:
      return { title: 'History', tagline: 'Your journey, day by day.' };
  }
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
