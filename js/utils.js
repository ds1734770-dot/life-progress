/**
 * Pure helpers — no DOM or browser APIs.
 * Safe to import and unit-test in Node.
 */

export function uid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---------------------------------------------------------------------------
// Dates — all helpers work in the LOCAL timezone (never UTC) so that a new day
// starts at midnight for the user, not at midnight UTC.
// ---------------------------------------------------------------------------

export function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayKey() {
  return dateKey(new Date());
}

export function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** Monday as the first day of the week. */
export function startOfWeekKey(key) {
  const d = parseKey(key);
  const diff = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diff);
  return dateKey(d);
}

export function weekKeys(key) {
  const start = startOfWeekKey(key);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export function monthKey(key) {
  return key.slice(0, 7);
}

export function daysBetween(aKey, bKey) {
  return Math.round((parseKey(bKey) - parseKey(aKey)) / 86400000);
}

/** "2026-09-07" string keys compare lexicographically, so < > work directly. */
export function isBefore(aKey, bKey) {
  return aKey < bKey;
}

export function formatDate(key, opts = {}) {
  const today = todayKey();
  if (key === today) {
    return opts.noToday
      ? parseKey(key).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : 'Today';
  }
  if (key === addDays(today, -1)) return 'Yesterday';
  const d = parseKey(key);
  if (opts.short) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function formatMonth(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function greetingFor(date = new Date()) {
  const h = date.getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

// ---------------------------------------------------------------------------
// Streaks — current consecutive-day streak.
//
// Semantics: a streak of N means the activity happened on N consecutive days,
// with today OR yesterday as the most recent day (so a user who hasn't acted
// yet today still sees their streak rather than it being unfairly zeroed).
// Correctly handles missing days (loop stops), multiple entries per day
// (keys are de-duplicated in a Set) and week/month boundaries (pure date math).
// ---------------------------------------------------------------------------

export function calculateStreak(dateKeys, today = todayKey()) {
  const set = new Set(dateKeys);
  let streak = 0;
  let cursor = today;
  if (!set.has(cursor)) cursor = addDays(cursor, -1);
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * Longest consecutive run within `dateKeys` (order-independent, de-duplicated).
 * Pairs with `calculateStreak` (current streak) so a "best streak" needs no
 * second algorithm — just the same set of day keys, scanned once.
 */
export function calculateBestStreak(dateKeys) {
  const days = [...new Set(dateKeys)].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const key of days) {
    run = prev !== null && addDays(prev, 1) === key ? run + 1 : 1;
    if (run > best) best = run;
    prev = key;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Overall daily progress.
//
// Combines four components, each a fraction 0..1 (or null when inactive):
//   goals   40%   completed today's goals / total today's goals
//   water   30%   intake today / daily target
//   gym     15%   did a workout today ? 1 : 0
//   journal 15%   wrote a journal entry today ? 1 : 0
//
// Inactive components (e.g. no goals defined today) are removed from BOTH the
// numerator and denominator, so a quiet day doesn't unfairly punish the score.
// This keeps the calculation modular: tweak PROGRESS_WEIGHTS or add components
// without touching any UI code.
// ---------------------------------------------------------------------------

export const PROGRESS_WEIGHTS = {
  goals: 0.4,
  water: 0.3,
  gym: 0.15,
  journal: 0.15,
};

export function calculateDailyProgress(parts) {
  const entries = [
    ['goals', parts.goals],
    ['water', parts.water],
    ['gym', parts.gym],
    ['journal', parts.journal],
  ];
  let score = 0;
  let weightSum = 0;
  for (const [key, value] of entries) {
    if (value == null) continue;
    score += clamp(value, 0, 1) * PROGRESS_WEIGHTS[key];
    weightSum += PROGRESS_WEIGHTS[key];
  }
  if (weightSum === 0) return 0;
  return Math.round((score / weightSum) * 100);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function trimNumber(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatWater(ml, unit = 'ml') {
  if (unit === 'L') {
    return ml >= 1000 ? `${trimNumber(ml / 1000)} L` : `${ml} ml`;
  }
  return `${ml} ml`;
}

export function formatDuration(minutes) {
  const min = Math.round(minutes);
  if (min <= 0) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** Safe async wrapper used by screens when a store might fail to open. */
export async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error('[LifeProgress]', err);
    return fallback;
  }
}