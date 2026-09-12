/**
 * Achievements — V1.2 Phase 2. Milestone badges for real consistency.
 *
 * Data-driven registry (ADefinitions) + pure evaluation over the same data
 * the History layer uses. Nothing here duplicates domain semantics: streak
 * metrics reuse computeStreaks, day metrics reuse completionIndex, and the
 * day key comes from the app's local-date utils.
 *
 * Layering:  SCREEN / CELEBRATION → achievements.js → history/domain → db.js
 * (The screen never touches IndexedDB; the celebration never defines rules.)
 *
 * Persistence is deliberately tiny: one record per earned achievement
 *   { id, earnedAt }  in the achievementRecords store.
 * Eligibility itself is always derived — if a record is missing but the data
 * says it was earned (e.g. after an import), evaluation re-awards it once.
 * Earned badges are historical: a later broken streak never removes them.
 */

import { todayKey, daysBetween } from './utils.js';
import { computeStreaks, completionIndex } from './history.js';
import { goalCompletionDays } from './goals.js';

// ---------------------------------------------------------------------------
// Badge artwork — original inline SVG, theme-token colors (no emoji, no
// external icon libraries). One glyph per category; tier adds a ring band.
// ---------------------------------------------------------------------------

const ART = {
  streak: '<path d="M12 2c1 3 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-5 .5 1 1.5 1.5 2 2-.5-2 0-5 1-7z"/>',
  water: '<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/>',
  gym: '<path d="M6.5 6.5v11M17.5 6.5v11M4 9.5v5M20 9.5v5M6.5 12h11"/>',
  goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  journal: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  overall: '<path d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z"/>',
};

export const CATEGORY_META = {
  streak: { label: 'Streak', color: 'var(--warning)', icon: 'streak' },
  water: { label: 'Water', color: 'var(--info)', icon: 'water' },
  gym: { label: 'Gym', color: 'var(--accent)', icon: 'gym' },
  goals: { label: 'Goals', color: 'var(--success)', icon: 'goals' },
  journal: { label: 'Journal', color: 'var(--warning)', icon: 'journal' },
  all: { label: 'Life', color: 'var(--accent)', icon: 'star' },
};

export const ACHIEVEMENT_CATEGORIES = ['all', 'streak', 'water', 'gym', 'goals', 'journal'];

/** Tier ring treatment (bronze→platinum), mapped to existing theme tokens. */
const TIERS = {
  bronze: { color: '#cd8f52', label: 'Bronze' },
  silver: { color: '#9fb0c0', label: 'Silver' },
  gold: { color: '#e8c14d', label: 'Gold' },
  platinum: { color: '#8fd8cf', label: 'Platinum' },
};

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/**
 * Badge artwork markup. `unlocked` controls the reveal styling; `size` the
 * rendered diameter. Used by the collection grid, the detail sheet and the
 * celebration so every surface shows the same artwork.
 */
export function badgeMarkup(definition, { unlocked = false, size = 64 } = {}) {
  const meta = CATEGORY_META[definition.category] || CATEGORY_META.overall;
  const tier = TIERS[definition.tier] || TIERS.bronze;
  return `
    <span class="badge-art ${unlocked ? 'unlocked' : 'locked'}" style="width:${size}px;height:${size}px;--badge-c:${meta.color};--tier-c:${tier.color}">
      <svg class="badge-ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="29" fill="none" stroke="var(--tier-c)" stroke-width="2.5" opacity="0.9"/>
        <circle cx="32" cy="32" r="24" fill="none" stroke="color-mix(in srgb, var(--badge-c) 45%, transparent)" stroke-width="1.5"/>
      </svg>
      <svg class="badge-glyph" ${SVG_ATTRS}>${ART[meta.icon] || ART.overall}</svg>
    </span>`;
}

// ---------------------------------------------------------------------------
// Activity metrics — one shared pass over the data (never per badge).
// ---------------------------------------------------------------------------

/**
 * Build the metric bundle every definition reads from. Computed ONCE per
 * evaluation — definitions never query storage themselves.
 */
export function buildMetrics(data, today = todayKey()) {
  const idx = completionIndex(data, today);
  const allCompletedDays = [...idx.entries()].filter(([, row]) => row.all === 'completed').map(([k]) => k);
  const streaks = {
    all: computeStreaks('all', data, today),
    water: computeStreaks('water', data, today),
    gym: computeStreaks('gym', data, today),
    goals: computeStreaks('goals', data, today),
    journal: computeStreaks('journal', data, today),
  };
  // Badges are HISTORICAL accomplishments (spec: a later broken streak never
  // removes one), so milestone thresholds key off the best run ever reached,
  // not the currently-live streak.
  const bestRun = longestRun([...idx.keys()]);
  const bestAllRun = longestRun(allCompletedDays);
  return {
    today,
    idx,
    streaks,
    overallStreak: streaks.all.current,
    bestOverallStreak: streaks.all.best,
    bestRun,
    bestAllRun,
    bestGoalRun: longestRun(goalCompletionDays(data.goals || [])),
    allCompletedDays,
    waterCompletedDays: [...idx.entries()].filter(([, r]) => r.water === 'completed').map(([k]) => k),
    workoutCount: (data.workouts || []).length,
    goalCompletionCount: goalCompletionDays(data.goals || []).length,
    journalDayCount: new Set((data.journalEntries || []).map((e) => e.date).filter(Boolean)).size,
    hasAnyActivity:
      (data.waterEntries || []).length + (data.workouts || []).length + (data.goals || []).length + (data.journalEntries || []).length > 0,
  };
}

/**
 * Longest consecutive local-date run among the given keys (chronological,
 * duplicates collapsed). Pure — independent of "today" — because it feeds
 * historical milestone semantics.
 */
function longestRun(keys) {
  const sorted = [...new Set(keys)].sort();
  let best = [];
  let run = [];
  for (const key of sorted) {
    if (run.length && daysBetween(run[run.length - 1], key) === 1) run.push(key);
    else {
      if (run.length > best.length) best = run;
      run = [key];
    }
  }
  return run.length > best.length ? run : best;
}

// ---------------------------------------------------------------------------
// Definition registry — data-driven; future phases append entries here.
// ---------------------------------------------------------------------------

/**
 * Definition shape:
 *   { id, title, description, category, tier, requirement, target, unit,
 *     getProgress(metrics) → { current, target }, evidence(metrics) → [...] }
 * An achievement is earned when current >= target. Progress drives the
 * locked-card bars and the next-milestone bridge.
 */
export const ACHIEVEMENTS = [
  // ---- STREAK (current streak of any-activity days) -----------------------
  def({ id: 'streak-1', title: 'First Step', category: 'streak', tier: 'bronze', target: 1, unit: 'day',
    description: 'Complete your first meaningful activity day.',
    progress: (m) => Math.max(m.bestRun.length, m.hasAnyActivity ? 1 : 0),
    evidence: (m) => runEvidence(m.bestRun, 1, 'first active day') }),
  def({ id: 'streak-3', title: 'Getting Started', category: 'streak', tier: 'bronze', target: 3, unit: 'day',
    description: 'Keep a 3-day activity streak going.',
    progress: (m) => m.bestRun.length, evidence: (m) => runEvidence(m.bestRun, 3) }),
  def({ id: 'streak-7', title: 'Week Warrior', category: 'streak', tier: 'silver', target: 7, unit: 'day',
    description: 'Show up 7 days in a row.', next: 'streak-14',
    progress: (m) => m.bestRun.length, evidence: (m) => runEvidence(m.bestRun, 7) }),
  def({ id: 'streak-14', title: 'Momentum', category: 'streak', tier: 'gold', target: 14, unit: 'day',
    description: 'Two full weeks of momentum.', next: 'streak-30',
    progress: (m) => m.bestRun.length, evidence: (m) => runEvidence(m.bestRun, 14) }),
  def({ id: 'streak-30', title: 'Unstoppable', category: 'streak', tier: 'gold', target: 30, unit: 'day',
    description: 'A 30-day streak. That is a habit.', next: 'streak-100',
    progress: (m) => m.bestRun.length, evidence: (m) => runEvidence(m.bestRun, 30) }),
  def({ id: 'streak-100', title: 'Legendary', category: 'streak', tier: 'platinum', target: 100, unit: 'day',
    description: '100 straight days. You are the routine now.',
    progress: (m) => m.bestRun.length, evidence: (m) => runEvidence(m.bestRun, 100) }),

  // ---- WATER (distinct days the daily target was reached) -----------------
  def({ id: 'water-first', title: 'First Sip', category: 'water', tier: 'bronze', target: 1, unit: 'day',
    description: 'Reach your daily water target for the first time.', next: 'water-7',
    progress: (m) => m.waterCompletedDays.length, evidence: (m) => dayListEvidence(m.waterCompletedDays, 1) }),
  def({ id: 'water-7', title: 'Hydration Habit', category: 'water', tier: 'bronze', target: 7, unit: 'day',
    description: 'Hit your water goal on 7 different days.', next: 'water-30',
    progress: (m) => m.waterCompletedDays.length, evidence: (m) => dayListEvidence(m.waterCompletedDays, 7) }),
  def({ id: 'water-30', title: 'Hydration Hero', category: 'water', tier: 'gold', target: 30, unit: 'day',
    description: 'Hit your water goal on 30 different days.', next: 'water-100',
    progress: (m) => m.waterCompletedDays.length, evidence: (m) => dayListEvidence(m.waterCompletedDays, 30) }),
  def({ id: 'water-100', title: 'Hydration Master', category: 'water', tier: 'platinum', target: 100, unit: 'day',
    description: '100 days of hitting your water goal.',
    progress: (m) => m.waterCompletedDays.length, evidence: (m) => dayListEvidence(m.waterCompletedDays, 100) }),

  // ---- GYM (workouts logged) ----------------------------------------------
  def({ id: 'gym-1', title: 'First Workout', category: 'gym', tier: 'bronze', target: 1, unit: 'workout',
    description: 'Log your first workout.', next: 'gym-10',
    progress: (m) => m.workoutCount, evidence: (m) => countEvidence(m.workoutCount, 'workout') }),
  def({ id: 'gym-10', title: 'Consistent Lifter', category: 'gym', tier: 'bronze', target: 10, unit: 'workout',
    description: 'Log 10 workouts.', next: 'gym-25',
    progress: (m) => m.workoutCount, evidence: (m) => countEvidence(m.workoutCount, 'workout') }),
  def({ id: 'gym-25', title: 'Iron Routine', category: 'gym', tier: 'silver', target: 25, unit: 'workout',
    description: 'Log 25 workouts.', next: 'gym-50',
    progress: (m) => m.workoutCount, evidence: (m) => countEvidence(m.workoutCount, 'workout') }),
  def({ id: 'gym-50', title: 'Dedicated Athlete', category: 'gym', tier: 'gold', target: 50, unit: 'workout',
    description: 'Log 50 workouts.', next: 'gym-100',
    progress: (m) => m.workoutCount, evidence: (m) => countEvidence(m.workoutCount, 'workout') }),
  def({ id: 'gym-100', title: 'Hundred Strong', category: 'gym', tier: 'platinum', target: 100, unit: 'workout',
    description: 'Log 100 workouts.',
    progress: (m) => m.workoutCount, evidence: (m) => countEvidence(m.workoutCount, 'workout') }),

  // ---- GOALS ---------------------------------------------------------------
  def({ id: 'goals-1', title: 'First Win', category: 'goals', tier: 'bronze', target: 1, unit: 'goal day',
    description: 'Complete a goal for the first time.', next: 'goals-10',
    progress: (m) => m.goalCompletionCount, evidence: (m) => countEvidence(m.goalCompletionCount, 'goal day') }),
  def({ id: 'goals-10', title: 'Goal Getter', category: 'goals', tier: 'bronze', target: 10, unit: 'goal day',
    description: 'Record goal completions on 10 different days.', next: 'goals-50',
    progress: (m) => m.goalCompletionCount, evidence: (m) => countEvidence(m.goalCompletionCount, 'goal day') }),
  def({ id: 'goals-50', title: 'Goal Crusher', category: 'goals', tier: 'gold', target: 50, unit: 'goal day',
    description: 'Record goal completions on 50 different days.',
    progress: (m) => m.goalCompletionCount, evidence: (m) => countEvidence(m.goalCompletionCount, 'goal day') }),
  def({ id: 'goals-consistency-7', title: 'Consistency Master', category: 'goals', tier: 'silver', target: 7, unit: 'day',
    description: 'Complete every goal due for 7 days in a row.',
    progress: (m) => m.bestGoalRun.length, evidence: (m) => runEvidence(m.bestGoalRun, 7) }),

  // ---- JOURNAL (distinct days with an entry) ------------------------------
  def({ id: 'journal-1', title: 'First Reflection', category: 'journal', tier: 'bronze', target: 1, unit: 'day',
    description: 'Write your first journal entry.', next: 'journal-7',
    progress: (m) => m.journalDayCount, evidence: (m) => countEvidence(m.journalDayCount, 'journal day') }),
  def({ id: 'journal-7', title: 'Reflective Week', category: 'journal', tier: 'bronze', target: 7, unit: 'day',
    description: 'Write on 7 different days.', next: 'journal-30',
    progress: (m) => m.journalDayCount, evidence: (m) => countEvidence(m.journalDayCount, 'journal day') }),
  def({ id: 'journal-30', title: 'Deep Thinker', category: 'journal', tier: 'gold', target: 30, unit: 'day',
    description: 'Write on 30 different days.', next: 'journal-100',
    progress: (m) => m.journalDayCount, evidence: (m) => countEvidence(m.journalDayCount, 'journal day') }),
  def({ id: 'journal-100', title: 'Story Keeper', category: 'journal', tier: 'platinum', target: 100, unit: 'day',
    description: 'Write on 100 different days.',
    progress: (m) => m.journalDayCount, evidence: (m) => countEvidence(m.journalDayCount, 'journal day') }),

  // ---- ALL / OVERALL (the History "all" consistency streak) ----------------
  def({ id: 'life-7', title: 'Life in Motion', category: 'all', tier: 'silver', target: 7, unit: 'day',
    description: 'Complete every active category for 7 days running.', next: 'life-14',
    progress: (m) => m.bestAllRun.length, evidence: (m) => runEvidence(m.bestAllRun, 7) }),
  def({ id: 'life-14', title: 'Life Momentum', category: 'all', tier: 'gold', target: 14, unit: 'day',
    description: '14 days of full days.', next: 'life-30',
    progress: (m) => m.bestAllRun.length, evidence: (m) => runEvidence(m.bestAllRun, 14) }),
  def({ id: 'life-30', title: 'Unstoppable Life', category: 'all', tier: 'gold', target: 30, unit: 'day',
    description: 'A full month of complete days.', next: 'life-100',
    progress: (m) => m.bestAllRun.length, evidence: (m) => runEvidence(m.bestAllRun, 30) }),
  def({ id: 'life-100', title: 'Life Progress Legend', category: 'all', tier: 'platinum', target: 100, unit: 'day',
    description: '100 days of complete days. Historic.',
    progress: (m) => m.bestAllRun.length, evidence: (m) => runEvidence(m.bestAllRun, 100) }),
];

function def({ id, title, description, category, tier = 'bronze', target, unit, progress, evidence, next }) {
  return { id, title, description, category, tier, target, unit, requirement: `${target} ${unit}${target === 1 ? '' : 's'}`, getProgress: progress, evidence, next: next || null };
}

// Evidence helpers — derived from real data; journal never exposes text.
/** Evidence rows from an actual consecutive run (the days that earned it). */
function runEvidence(run, n, fallbackLabel) {
  if (!run || run.length === 0) return fallbackLabel ? [fallbackLabel] : [];
  return run.slice(-n).map((key) => ({ label: formatDayLabel(key), done: true }));
}

function dayListEvidence(days, n) {
  return days
    .slice()
    .sort()
    .slice(-Math.min(n, days.length))
    .map((key) => ({ label: formatDayLabel(key), done: true }));
}

function countEvidence(count, noun) {
  return `Completed ${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatDayLabel(key) {
  const d = new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Pure evaluation API
// ---------------------------------------------------------------------------

export function getAchievement(id) {
  return ACHIEVEMENTS.find((a) => a.id === id) || null;
}

/** { current, target, earned, pct } for one definition against the metrics. */
export function achievementProgress(definition, metrics) {
  const current = Math.max(0, Math.round(definition.getProgress(metrics) || 0));
  return {
    current,
    target: definition.target,
    earned: current >= definition.target,
    pct: Math.min(100, Math.round((current / definition.target) * 100)),
  };
}

/**
 * Evaluate every definition once. Returns
 *   { earnedNew: [definitions], records: [{ id, earnedAt }], progress: Map }
 * `records` = the full earned set (existing records ∪ newly earned).
 */
export function evaluateAchievements(data, existingRecords = [], today = todayKey()) {
  const metrics = buildMetrics(data, today);
  const known = new Set(ACHIEVEMENTS.map((a) => a.id));
  const earnedAt = new Map();
  for (const rec of existingRecords || []) {
    if (rec && known.has(rec.id)) earnedAt.set(rec.id, rec.earnedAt || Date.now());
  }
  const earnedNew = [];
  const progress = new Map();
  for (const definition of ACHIEVEMENTS) {
    const p = achievementProgress(definition, metrics);
    progress.set(definition.id, p);
    if (p.earned && !earnedAt.has(definition.id)) {
      earnedAt.set(definition.id, Date.now());
      earnedNew.push(definition);
    }
  }
  return {
    metrics,
    progress,
    earnedNew,
    records: [...earnedAt.entries()].map(([id, at]) => ({ id, earnedAt: at })),
  };
}

/** Next unearned milestone in the same family (by `next` link, else category ladder). */
export function nextMilestone(definitionId, progress) {
  const definition = getAchievement(definitionId);
  if (!definition) return null;
  const candidate = definition.next ? getAchievement(definition.next) : null;
  if (candidate && !progress.get(candidate.id)?.earned) return candidate;
  // Fall back to the lowest-target unearned badge in the same category.
  const fallback = ACHIEVEMENTS.filter((a) => a.category === definition.category && !progress.get(a.id)?.earned).sort((a, b) => a.target - b.target)[0];
  return fallback || null;
}

// ---------------------------------------------------------------------------
// Persistence — the only IndexedDB access in this module, behind small fns.
// ---------------------------------------------------------------------------

export async function loadAchievementRecords() {
  const { dbGetAll } = await import('./db.js');
  const rows = await dbGetAll('achievementRecords');
  return rows.filter((r) => r && typeof r.id === 'string' && r.id);
}

export async function persistAchievements(records) {
  if (!records.length) return;
  const { dbBulkPut } = await import('./db.js');
  await dbBulkPut('achievementRecords', records.map((r) => ({ id: String(r.id), earnedAt: Number(r.earnedAt) || Date.now() })));
}

/**
 * Full round-trip used by the app: load records, evaluate, persist anything
 * newly earned, and return { earnedNew, records, metrics, progress }.
 */
export async function syncAchievements(data, today = todayKey()) {
  const existing = await loadAchievementRecords();
  const result = evaluateAchievements(data, existing, today);
  if (result.earnedNew.length) {
    await persistAchievements(result.records);
  }
  return result;
}
