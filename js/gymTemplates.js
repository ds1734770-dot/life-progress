/**
 * V1.4 — Gym templates domain.
 *
 * Workout TEMPLATES are reusable plans ("Push Day"): structure only, no
 * history. A WORKOUT SESSION is what the user actually performs on a date;
 * only completed sessions become historical workouts (workouts store) and
 * thereby feed streaks, achievements, history and the dashboard.
 *
 * Layering (unchanged):  SCREEN → this module + gym.js → db.js
 * This module never touches the DOM. All storage access goes through db.js.
 *
 * Pre-fill rule (§9): when starting a session, every exercise looks for the
 * most recent COMPLETED workout containing that exercise (name, case-
 * insensitive) and copies set count, reps and weight as today's starting
 * values. Historical workouts are never mutated.
 */

import { dbGet, dbGetAll, dbPut, dbDelete, dbBulkPut, dbClear, STORES } from './db.js';
import {
  makeWorkoutTemplate,
  makeWorkout,
  makeActiveWorkout,
  makeSessionExercise,
  makeLibraryExercise,
  sessionCompletable,
} from './models.js';
import { uid, todayKey } from './utils.js';

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function getTemplates() {
  const rows = await dbGetAll(STORES.workoutTemplates);
  return rows.map((t) => makeWorkoutTemplate(t)).sort((a, b) => {
    if (a.lastUsedAt !== b.lastUsedAt) return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    return a.name.localeCompare(b.name);
  });
}

export async function getTemplate(id) {
  const row = await dbGet(STORES.workoutTemplates, id);
  return row ? makeWorkoutTemplate(row) : null;
}

export async function saveTemplate(data) {
  const now = Date.now();
  const template = makeWorkoutTemplate({ ...data, updatedAt: now });
  await dbPut(STORES.workoutTemplates, template);
  await touchLibrary(template.exercises.map((e) => e.exerciseName));
  return template;
}

/** Duplicate with a fresh id, "(copy)" name and no last-used stamp. */
export async function duplicateTemplate(id) {
  const source = await getTemplate(id);
  if (!source) return null;
  const copy = makeWorkoutTemplate({
    ...source,
    id: undefined,
    name: `${source.name} (copy)`,
    lastUsedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await dbPut(STORES.workoutTemplates, copy);
  return copy;
}

/**
 * Delete a template. Historical workouts are NEVER touched — a template is a
 * plan, and deleting the plan does not delete the sessions that happened (§7).
 */
export async function deleteTemplate(id) {
  await dbDelete(STORES.workoutTemplates, id);
}

/** Mark a template used (reorders "My workouts" by recency). */
export async function markTemplateUsed(id) {
  const row = await dbGet(STORES.workoutTemplates, id);
  if (!row) return;
  await dbPut(STORES.workoutTemplates, makeWorkoutTemplate({ ...row, lastUsedAt: Date.now() }));
}

// ---------------------------------------------------------------------------
// Exercise library — remembers every exercise the user has used
// ---------------------------------------------------------------------------

export async function getLibrary() {
  const rows = await dbGetAll(STORES.exerciseLibrary);
  return rows.map((r) => makeLibraryExercise(r)).sort((a, b) => {
    if (a.usedAt !== b.usedAt) return b.usedAt - a.usedAt; // most recent first
    return a.name.localeCompare(b.name);
  });
}

/** Registry every picker filters: the default list until the user adds their own. */
export const SUGGESTED_EXERCISES = [
  'Bench Press', 'Incline Dumbbell Press', 'Shoulder Press', 'Lateral Raise',
  'Tricep Pushdown', 'Squat', 'Deadlift', 'Lat Pulldown', 'Bicep Curl',
  'Romanian Deadlift', 'Leg Press', 'Overhead Press', 'Barbell Row', 'Pull-Up',
  'Chest Fly', 'Face Pull', 'Hammer Curl', 'Leg Curl', 'Leg Extension', 'Plank',
];

export const SUGGESTED_MUSCLES = {
  'bench press': 'Chest', 'incline dumbbell press': 'Chest', 'chest fly': 'Chest',
  'shoulder press': 'Shoulders', 'lateral raise': 'Shoulders', 'overhead press': 'Shoulders', 'face pull': 'Shoulders',
  'tricep pushdown': 'Triceps', 'squat': 'Quads', 'deadlift': 'Back',
  'lat pulldown': 'Back', 'barbell row': 'Back', 'pull-up': 'Back',
  'bicep curl': 'Biceps', 'hammer curl': 'Biceps',
  'romanian deadlift': 'Hamstrings', 'leg curl': 'Hamstrings',
  'leg press': 'Quads', 'leg extension': 'Quads', 'plank': 'Core',
};

export function guessMuscleGroup(name) {
  const key = String(name || '').trim().toLowerCase();
  return SUGGESTED_MUSCLES[key] || 'Other';
}

/** Record exercise names as used (idempotent, merges counters). */
export async function touchLibrary(names, usedAt = Date.now()) {
  const existing = await getLibrary();
  const byKey = new Map(existing.map((e) => [e.key, e]));
  const updates = [];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const prior = byKey.get(key);
    if (prior) {
      updates.push({ ...prior, usedAt: Math.max(prior.usedAt, usedAt), useCount: prior.useCount + 1 });
      byKey.delete(key); // don't double-count the same name twice in one call
    } else {
      updates.push(makeLibraryExercise({ name, muscleGroup: guessMuscleGroup(name), usedAt, useCount: 1 }));
    }
  }
  if (updates.length) await dbBulkPut(STORES.exerciseLibrary, updates);
  return updates;
}

// ---------------------------------------------------------------------------
// Pre-fill from last workout (§9) — pure helpers
// ---------------------------------------------------------------------------

/** Best historical set summary for one exercise name: [weight, reps] pairs. */
function exerciseHistoryRows(workout, lowerName) {
  const rows = [];
  for (const ex of workout.exercises || []) {
    if (String(ex.exerciseName || '').trim().toLowerCase() !== lowerName) continue;
    // Preferred: per-set performed detail (V1.4 sessions).
    if (Array.isArray(ex.performedSets) && ex.performedSets.length) {
      for (const s of ex.performedSets) rows.push({ weight: Number(s.weight) || 0, reps: Number(s.reps) || 0 });
    } else {
      for (let i = 0; i < Math.max(1, ex.sets || 0); i++) rows.push({ weight: ex.weight || 0, reps: ex.reps || 0 });
    }
  }
  return rows;
}

/**
 * The most recent completed workout (before or on `beforeDateKey`, strictly
 * before `excludeWorkoutId`) containing the given exercise. Templates look
 * backwards in time only.
 */
export function findLastWorkoutWith(workouts, exerciseName, { beforeDate, excludeWorkoutId } = {}) {
  const lower = String(exerciseName || '').trim().toLowerCase();
  if (!lower) return null;
  const sorted = [...workouts].sort((a, b) =>
    a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : b.date.localeCompare(a.date)
  );
  for (const w of sorted) {
    if (excludeWorkoutId && w.id === excludeWorkoutId) continue;
    if (beforeDate && w.date > beforeDate) continue;
    const has = (w.exercises || []).some(
      (ex) => String(ex.exerciseName || '').trim().toLowerCase() === lower
    );
    if (has) return w;
  }
  return null;
}

/**
 * Pre-fill rows for one exercise from its most recent history: the last
 * completed workout containing the exercise wins. Returns [{ weight, reps }]
 * (array of set rows). Falls back to the template defaults when no history.
 */
export function prefillSetsForExercise(templateExercise, workouts, { beforeDate, excludeWorkoutId } = {}) {
  const last = findLastWorkoutWith(workouts, templateExercise.exerciseName, { beforeDate, excludeWorkoutId });
  if (last) {
    const rows = exerciseHistoryRows(last, templateExercise.exerciseName.trim().toLowerCase());
    if (rows.length) return rows.map((r) => ({ weight: r.weight, reps: r.reps, done: false }));
  }
  // Template defaults (§46 fallback: structure, empty-feeling values).
  const reps = templateExercise.reps || 0;
  const weight = templateExercise.weight || 0;
  return Array.from({ length: templateExercise.defaultSets || 3 }, () => ({ weight, reps, done: false }));
}

/**
 * Build a full active session from a template + history. Every exercise gets
 * pre-filled set rows from its own last performance; the template structure is
 * preserved and historical workouts are only ever read.
 */
export function buildSessionFromTemplate(template, workouts = [], { startedAt = Date.now() } = {}) {
  return makeActiveWorkout({
    templateId: template.id,
    templateName: template.name,
    focus: template.focus,
    exercises: template.exercises.map((tex) =>
      makeSessionExercise({
        exerciseName: tex.exerciseName,
        muscleGroup: tex.muscleGroup || guessMuscleGroup(tex.exerciseName),
        sets: prefillSetsForExercise(tex, workouts),
      })
    ),
    startedAt,
  });
}

/** Empty/freeform session (§29) — add exercises from the library, sets from scratch. */
export function buildEmptySession({ startedAt = Date.now(), templateName = '', templateId = null } = {}) {
  return makeActiveWorkout({ templateId, templateName, exercises: [], startedAt });
}

// ---------------------------------------------------------------------------
// Active session persistence (§20) — singleton record, reload-safe
// ---------------------------------------------------------------------------

export async function getActiveWorkout() {
  const row = await dbGet(STORES.activeWorkout, 'active');
  return row || null;
}

export async function persistActiveWorkout(session) {
  await dbPut(STORES.activeWorkout, session);
  return session;
}

export async function clearActiveWorkout() {
  await dbDelete(STORES.activeWorkout, 'active');
}

// ---------------------------------------------------------------------------
// Session mutations (each returns a NEW session object — screens re-render)
// ---------------------------------------------------------------------------

export function toggleSet(session, exerciseId, setIndex) {
  const next = cloneSession(session);
  const ex = next.exercises.find((e) => e.id === exerciseId);
  const set = ex?.sets[setIndex];
  if (set) set.done = !set.done;
  return next;
}

export function updateSet(session, exerciseId, setIndex, patch) {
  const next = cloneSession(session);
  const ex = next.exercises.find((e) => e.id === exerciseId);
  const set = ex?.sets[setIndex];
  if (set) {
    if (patch.weight != null) set.weight = Math.max(0, Math.round((Number(patch.weight) || 0) * 2) / 2);
    if (patch.reps != null) set.reps = Math.max(0, Math.round(Number(patch.reps) || 0));
  }
  return next;
}

export function addSet(session, exerciseId) {
  const next = cloneSession(session);
  const ex = next.exercises.find((e) => e.id === exerciseId);
  if (!ex) return next;
  const ref = ex.sets[ex.sets.length - 1] || { weight: 0, reps: 0 };
  ex.sets.push({ weight: ref.weight, reps: ref.reps, done: false });
  return next;
}

export function removeSet(session, exerciseId, setIndex) {
  const next = cloneSession(session);
  const ex = next.exercises.find((e) => e.id === exerciseId);
  if (ex && ex.sets.length > 1) ex.sets.splice(setIndex, 1);
  else if (ex) ex.sets[0] = { weight: 0, reps: 0, done: false };
  return next;
}

/**
 * Add an exercise to today's session (§14). When the exercise has history,
 * pass prefill rows so today starts from the last performance; otherwise it
 * starts with one empty set.
 */
export function addSessionExercise(session, name, prefillSets = null) {
  const next = cloneSession(session);
  const sets = Array.isArray(prefillSets) && prefillSets.length
    ? prefillSets.map((r) => ({ weight: r.weight || 0, reps: r.reps || 0, done: false }))
    : [{ weight: 0, reps: 0, done: false }];
  next.exercises.push(
    makeSessionExercise({
      exerciseName: name,
      sets,
    })
  );
  return next;
}

export function removeSessionExercise(session, exerciseId) {
  const next = cloneSession(session);
  next.exercises = next.exercises.filter((e) => e.id !== exerciseId);
  return next;
}

/** Move an exercise within today's session (does not touch the template). */
export function moveSessionExercise(session, exerciseId, dir) {
  const next = cloneSession(session);
  const i = next.exercises.findIndex((e) => e.id === exerciseId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= next.exercises.length) return next;
  const [item] = next.exercises.splice(i, 1);
  next.exercises.splice(j, 0, item);
  return next;
}

function cloneSession(session) {
  return {
    ...session,
    exercises: session.exercises.map((ex) => ({ ...ex, sets: ex.sets.map((s) => ({ ...s })) })),
  };
}

// ---------------------------------------------------------------------------
// Session → historical workout (§30: session ≠ template ≠ history)
// ---------------------------------------------------------------------------

/** Volume = Σ(weight × reps) over every performed set. */
export function sessionVolume(session) {
  return (session.exercises || []).reduce(
    (acc, ex) => acc + ex.sets.reduce((s, set) => s + (set.weight || 0) * (set.reps || 0), 0),
    0
  );
}

export function sessionSetCount(session) {
  return (session.exercises || []).reduce((acc, ex) => acc + ex.sets.length, 0);
}

export function sessionCompletedSetCount(session) {
  return (session.exercises || []).reduce((acc, ex) => acc + ex.sets.filter((s) => s.done).length, 0);
}

export function sessionExerciseCount(session) {
  return (session.exercises || []).length;
}

/**
 * Convert an active session into a completed historical workout. Sets are
 * aggregated as { sets, reps, weight } (max weight, most common reps — the
 * historical display shape) PLUS the full per-set `performedSets` detail for
 * future progression features. The active record is deleted; the workout is
 * returned unsaved (the caller decides when to persist).
 */
export function completeSession(session, { endedAt = Date.now(), durationOverride } = {}) {
  const exercises = (session.exercises || [])
    .filter((ex) => ex.sets.length)
    .map((ex) => {
      const weights = ex.sets.map((s) => s.weight || 0);
      const repsList = ex.sets.map((s) => s.reps || 0);
      const maxWeight = Math.max(...weights);
      const repsMode = mode(repsList);
      return {
        exerciseName: ex.exerciseName,
        sets: ex.sets.length,
        reps: repsMode,
        weight: maxWeight,
        performedSets: ex.sets.map((s) => ({ weight: s.weight || 0, reps: s.reps || 0 })),
      };
    });

  const durationMinutes =
    durationOverride != null
      ? Math.round(durationOverride)
      : Math.max(1, Math.round((endedAt - session.startedAt) / 60000));

  const workout = makeWorkout({
    date: todayKey(),
    workoutType: 'Strength',
    duration: durationMinutes,
    notes: session.notes || '',
    exercises,
    templateId: session.templateId || undefined,
    templateName: session.templateName || undefined,
  });

  return workout;
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v > best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// LAST TIME + BEAT LAST TIME (§16) + PR detection (§17)
// ---------------------------------------------------------------------------

/** The user's most recent workout before today (any workout). */
export function lastWorkoutBeforeToday(workouts, today = todayKey()) {
  return (
    [...workouts]
      .filter((w) => w.date < today)
      .sort((a, b) => (a.date === b.date ? (b.createdAt || 0) - (a.createdAt || 0) : b.date.localeCompare(a.date)))[0] || null
  );
}

/**
 * LAST TIME summary for an exercise: from the most recent completed workout
 * containing it. Returns { date, rows: [{weight, reps}] } or null.
 */
export function lastTimeForExercise(workouts, exerciseName, { today = todayKey(), excludeWorkoutId } = {}) {
  const last = findLastWorkoutWith(workouts, exerciseName, { beforeDate: today, excludeWorkoutId });
  if (!last) return null;
  const rows = exerciseHistoryRows(last, String(exerciseName).trim().toLowerCase());
  return rows.length ? { date: last.date, rows } : null;
}

/**
 * Best-ever historical set for an exercise (heaviest set; ties broken by
 * reps). PR detection (§17) compares today's sets against this — REAL data
 * only, never invented.
 */
export function bestSetEver(workouts, exerciseName, { beforeDate, excludeWorkoutId } = {}) {
  const lower = String(exerciseName || '').trim().toLowerCase();
  let best = null;
  for (const w of workouts) {
    if (excludeWorkoutId && w.id === excludeWorkoutId) continue;
    if (beforeDate && w.date > beforeDate) continue;
    for (const row of exerciseHistoryRows(w, lower)) {
      if (!row.weight && !row.reps) continue;
      const better =
        !best ||
        row.weight > best.weight ||
        (row.weight === best.weight && row.reps > best.reps);
      if (better) best = { weight: row.weight, reps: row.reps, date: w.date };
    }
  }
  return best;
}

/** { weight: +2.5, reps: +2 } deltas of today's best set vs the last time. */
export function compareBestSet(todayBest, lastBest) {
  if (!todayBest) return null;
  // No history = first-ever performance: an improvement over nothing is not
  // a PR (§17 — never invent PRs), it only sets the baseline.
  if (!lastBest) return { weight: todayBest.weight, reps: todayBest.reps, newPR: false };
  return {
    weight: round1(todayBest.weight - lastBest.weight),
    reps: todayBest.reps - lastBest.reps,
    newPR: todayBest.weight > lastBest.weight || (todayBest.weight === lastBest.weight && todayBest.reps > lastBest.reps),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * PRs earned in a finished session (§17) — derived purely from real stored
 * workout history + today's session. An exercise earns a PR when its best set
 * today strictly beats the best set ever recorded before today.
 */
export function sessionPRs(session, workouts, { today = todayKey() } = {}) {
  const prs = [];
  for (const ex of session.exercises || []) {
    const todayRows = ex.sets.filter((s) => s.weight > 0 || s.reps > 0);
    if (!todayRows.length) continue;
    const todayBest = todayRows.reduce(
      (b, s) => (!b || s.weight > b.weight || (s.weight === b.weight && s.reps > b.reps) ? { weight: s.weight, reps: s.reps } : b),
      null
    );
    const prevBest = bestSetEver(workouts, ex.exerciseName, { beforeDate: today });
    // A PR needs a strict improvement over recorded history. When there is no
    // history at all, the first honest performance is not a PR (nothing was
    // beaten) — but it still seeds the baseline for next time.
    if (!prevBest) continue;
    const beats = todayBest.weight > prevBest.weight || (todayBest.weight === prevBest.weight && todayBest.reps > prevBest.reps);
    if (beats) {
      prs.push({
        exerciseName: ex.exerciseName,
        weight: todayBest.weight,
        reps: todayBest.reps,
        previousWeight: prevBest.weight,
        previousReps: prevBest.reps,
        weightDelta: round1(todayBest.weight - prevBest.weight),
        repsDelta: todayBest.reps - prevBest.reps,
      });
    }
  }
  return prs;
}

// ---------------------------------------------------------------------------
// Migration (§27) — turn a historical workout into a reusable template
// ---------------------------------------------------------------------------

/**
 * Build template data from a completed historical workout (SAVE AS TEMPLATE).
 * Sets/reps/weights become the template defaults; nothing is removed from
 * history. Returns unsaved template data (caller persists via saveTemplate).
 */
export function templateDataFromWorkout(workout) {
  return {
    name: '',
    focus: 'Custom',
    exercises: (workout.exercises || []).map((ex) => ({
      exerciseName: ex.exerciseName,
      muscleGroup: guessMuscleGroup(ex.exerciseName),
      defaultSets: Math.max(1, ex.sets || 1),
      reps: ex.reps || 0,
      weight: ex.weight || 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Wipe safety (§39) — called by the existing data-wipe path
// ---------------------------------------------------------------------------

/** Wipe every V1.4 gym store. Historical workouts are cleared by dbResetAll. */
export async function wipeGymV14Data() {
  await dbClear(STORES.workoutTemplates);
  await dbClear(STORES.exerciseLibrary);
  await dbClear(STORES.activeWorkout);
}

// ---------------------------------------------------------------------------
// Misc shared helpers
// ---------------------------------------------------------------------------

/** Reorder helper for the template editor (drag handles). */
export function reorderTemplateExercises(exercises, from, to) {
  const next = [...exercises];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Formats "60 kg × 8 × 3" style summaries; trims trailing .0 weights. */
export function formatWeight(kg) {
  return Number.isInteger(kg) ? `${kg}` : String(Math.round(kg * 10) / 10);
}

/** Elapsed mm:ss for the workout / rest timer. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Suggested next weight for +/− steppers: real gym increments. 2.5 kg steps
 * keep 40 → 42.5 → 45 → 62.5 → 65 natural; 5 kg kicks in for heavy barbell
 * work (100 kg+).
 */
export function stepWeight(weight, dir, { min = 0 } = {}) {
  const step = weight >= 100 ? 5 : 2.5;
  const raw = (Number(weight) || 0) + dir * step;
  return Math.max(min, Math.round(raw * 2) / 2);
}

// Re-export so screens have one import point for the completable check.
export { sessionCompletable };
