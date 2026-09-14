/**
 * V1.4 Gym templates — unit tests for the pure domain logic:
 * template semantics, pre-fill from last workout, session mutations,
 * session→history conversion, PR detection, comparisons, migration helper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prefillSetsForExercise,
  findLastWorkoutWith,
  buildSessionFromTemplate,
  buildEmptySession,
  toggleSet,
  updateSet,
  addSet,
  removeSet,
  addSessionExercise,
  removeSessionExercise,
  moveSessionExercise,
  sessionVolume,
  sessionSetCount,
  sessionCompletedSetCount,
  completeSession,
  lastWorkoutBeforeToday,
  lastTimeForExercise,
  bestSetEver,
  compareBestSet,
  sessionPRs,
  templateDataFromWorkout,
  formatWeight,
  formatElapsed,
  stepWeight,
  reorderTemplateExercises,
  isUniqueExerciseName,
  groupLibraryEntries,
} from '../js/gymTemplates.js';
import { makeWorkout, makeTemplateExercise, makeWorkoutTemplate, makeActiveWorkout, makeSessionExercise, sessionCompletable } from '../js/models.js';

const TODAY = '2026-09-14';

function workoutOn(date, exercises, createdAt = 1) {
  return makeWorkout({ date, workoutType: 'Strength', duration: 40, exercises, createdAt });
}

// ---------------------------------------------------------------------------
// Pre-fill from last workout (§9)
// ---------------------------------------------------------------------------

test('pre-fill uses the most recent workout containing the exercise', () => {
  const older = workoutOn('2026-09-01', [{ exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 55 }]);
  const newer = workoutOn('2026-09-08', [{ exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 60 }]);
  const tex = makeTemplateExercise({ exerciseName: 'Bench Press', defaultSets: 3 });
  const rows = prefillSetsForExercise(tex, [older, newer], { beforeDate: TODAY });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].weight, 60);
  assert.equal(rows[0].reps, 8);
  assert.equal(rows[0].done, false);
});

test('pre-fill falls back to template defaults when there is no history', () => {
  const tex = makeTemplateExercise({ exerciseName: 'Squat', defaultSets: 4, reps: 5, weight: 100 });
  const rows = prefillSetsForExercise(tex, [], { beforeDate: TODAY });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].weight, 100);
  assert.equal(rows[0].reps, 5);
});

test('pre-fill matches exercise names case-insensitively', () => {
  const w = workoutOn('2026-09-08', [{ exerciseName: 'bench press', sets: 2, reps: 10, weight: 40 }]);
  const tex = makeTemplateExercise({ exerciseName: 'Bench Press', defaultSets: 2 });
  const rows = prefillSetsForExercise(tex, [w], { beforeDate: TODAY });
  assert.equal(rows[0].weight, 40);
});

test('pre-fill prefers per-set performed detail when present', () => {
  const w = workoutOn('2026-09-08', [
    { exerciseName: 'Bench Press', sets: 2, reps: 8, weight: 60, performedSets: [{ weight: 60, reps: 8 }, { weight: 62.5, reps: 6 }] },
  ]);
  const tex = makeTemplateExercise({ exerciseName: 'Bench Press', defaultSets: 3 });
  const rows = prefillSetsForExercise(tex, [w], { beforeDate: TODAY });
  assert.deepEqual(
    rows.map((r) => [r.weight, r.reps]),
    [[60, 8], [62.5, 6]]
  );
});

test('historical workouts are never mutated by building a session', () => {
  const w = workoutOn('2026-09-08', [{ exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 60 }]);
  const before = JSON.stringify(w);
  const template = makeWorkoutTemplate({ name: 'Push', exercises: [{ exerciseName: 'Bench Press', defaultSets: 3 }] });
  const session = buildSessionFromTemplate(template, [w]);
  session.exercises[0].sets[0].weight = 100;
  assert.equal(JSON.stringify(w), before, 'history untouched');
});

// ---------------------------------------------------------------------------
// findLastWorkoutWith
// ---------------------------------------------------------------------------

test('findLastWorkoutWith skips future workouts and respects exclusions', () => {
  const a = workoutOn('2026-09-01', [{ exerciseName: 'Squat', sets: 1, reps: 5, weight: 80 }]);
  const b = workoutOn('2026-09-10', [{ exerciseName: 'Squat', sets: 1, reps: 5, weight: 90 }]);
  assert.equal(findLastWorkoutWith([a, b], 'Squat', { beforeDate: TODAY }), b);
  assert.equal(findLastWorkoutWith([a, b], 'Squat', { beforeDate: '2026-09-05' }), a);
  assert.equal(findLastWorkoutWith([a, b], 'Squat', { beforeDate: TODAY, excludeWorkoutId: b.id }), a);
  assert.equal(findLastWorkoutWith([a], 'Bench Press', {}), null);
});

// ---------------------------------------------------------------------------
// Session mutations
// ---------------------------------------------------------------------------

function sessionWithBench() {
  return makeActiveWorkout({
    templateName: 'Push',
    exercises: [makeSessionExercise({ exerciseName: 'Bench Press', sets: [{ weight: 60, reps: 8, done: false }, { weight: 60, reps: 8, done: false }] })],
  });
}

test('toggleSet flips completion without touching other sets', () => {
  const s = sessionWithBench();
  const next = toggleSet(s, s.exercises[0].id, 0);
  assert.equal(next.exercises[0].sets[0].done, true);
  assert.equal(next.exercises[0].sets[1].done, false);
  assert.equal(s.exercises[0].sets[0].done, false, 'original untouched');
});

test('updateSet changes only the targeted value; weight keeps 0.5 precision', () => {
  const s = sessionWithBench();
  const next = updateSet(s, s.exercises[0].id, 1, { weight: 62.5 });
  assert.equal(next.exercises[0].sets[1].weight, 62.5);
  assert.equal(next.exercises[0].sets[0].weight, 60);
  const rounded = updateSet(s, s.exercises[0].id, 0, { weight: 60.4 });
  assert.equal(rounded.exercises[0].sets[0].weight, 60.5);
});

test('addSet copies the last set as a fresh uncompleted row', () => {
  const s = sessionWithBench();
  const next = addSet(s, s.exercises[0].id);
  assert.equal(next.exercises[0].sets.length, 3);
  assert.equal(next.exercises[0].sets[2].weight, 60);
  assert.equal(next.exercises[0].sets[2].done, false);
});

test('removeSet removes only the targeted set; never leaves zero sets', () => {
  const s = sessionWithBench();
  const one = removeSet(s, s.exercises[0].id, 0);
  assert.equal(one.exercises[0].sets.length, 1);
  const empty = removeSet(one, one.exercises[0].id, 0);
  assert.equal(empty.exercises[0].sets.length, 1);
  assert.equal(empty.exercises[0].sets[0].weight, 0);
});

test('addSessionExercise appends with one empty set', () => {
  const s = sessionWithBench();
  const next = addSessionExercise(s, 'Lat Pulldown');
  assert.equal(next.exercises.length, 2);
  assert.equal(next.exercises[1].sets.length, 1);
});

test('removeSessionExercise drops only today (session), not the template concept', () => {
  const s = sessionWithBench();
  const next = removeSessionExercise(s, s.exercises[0].id);
  assert.equal(next.exercises.length, 0);
});

test('moveSessionExercise reorders within the session only', () => {
  const s = makeActiveWorkout({
    exercises: [makeSessionExercise({ exerciseName: 'A' }), makeSessionExercise({ exerciseName: 'B' }), makeSessionExercise({ exerciseName: 'C' })],
  });
  const next = moveSessionExercise(s, s.exercises[0].id, 1);
  assert.deepEqual(next.exercises.map((e) => e.exerciseName), ['B', 'A', 'C']);
  const same = moveSessionExercise(next, next.exercises[0].id, -1); // out of range
  assert.deepEqual(same.exercises.map((e) => e.exerciseName), ['B', 'A', 'C']);
});

// ---------------------------------------------------------------------------
// Session metrics + completion (§22, §30)
// ---------------------------------------------------------------------------

test('session volume / set counts are computed from real set rows', () => {
  const s = makeActiveWorkout({
    exercises: [
      makeSessionExercise({ exerciseName: 'A', sets: [{ weight: 60, reps: 8, done: true }, { weight: 60, reps: 8, done: true }, { weight: 60, reps: 8, done: false }] }),
      makeSessionExercise({ exerciseName: 'B', sets: [{ weight: 0, reps: 20, done: true }] }),
    ],
  });
  assert.equal(sessionVolume(s), 60 * 8 * 3);
  assert.equal(sessionSetCount(s), 4);
  assert.equal(sessionCompletedSetCount(s), 3);
});

test('completeSession converts the session into a historical workout', () => {
  const s = makeActiveWorkout({
    templateId: 'tpl-1',
    templateName: 'Push Day',
    startedAt: Date.now() - 42 * 60000,
    exercises: [makeSessionExercise({ exerciseName: 'Bench Press', sets: [{ weight: 60, reps: 8, done: true }, { weight: 62.5, reps: 8, done: true }, { weight: 62.5, reps: 8, done: true }] })],
  });
  const w = completeSession(s, { endedAt: Date.now(), durationOverride: 42 });
  assert.equal(w.duration, 42);
  assert.equal(w.templateId, 'tpl-1');
  assert.equal(w.templateName, 'Push Day');
  assert.equal(w.exercises[0].exerciseName, 'Bench Press');
  assert.equal(w.exercises[0].sets, 3);
  assert.equal(w.exercises[0].weight, 62.5, 'max weight kept');
  assert.equal(w.exercises[0].reps, 8);
  assert.equal(w.exercises[0].performedSets.length, 3, 'per-set detail preserved');
});

test('sessionCompletable requires at least one set', () => {
  assert.equal(sessionCompletable(buildEmptySession()), false);
  const s = sessionWithBench();
  assert.equal(sessionCompletable(s), true);
});

// ---------------------------------------------------------------------------
// Beat last time + PR detection (§16, §17)
// ---------------------------------------------------------------------------

test('bestSetEver finds the heaviest real set across history', () => {
  const w1 = workoutOn('2026-09-01', [{ exerciseName: 'Bench', sets: 3, reps: 8, weight: 60 }]);
  const w2 = workoutOn('2026-09-08', [{ exerciseName: 'Bench', sets: 3, reps: 5, weight: 70 }]);
  assert.deepEqual(bestSetEver([w1, w2], 'Bench', { beforeDate: TODAY }), { weight: 70, reps: 5, date: '2026-09-08' });
  assert.equal(bestSetEver([w1, w2], 'Bench', { beforeDate: '2026-09-05' }).weight, 60);
  assert.equal(bestSetEver([w1, w2], 'Row', { beforeDate: TODAY }), null);
});

test('compareBestSet computes deltas and flags a strict improvement', () => {
  assert.deepEqual(compareBestSet({ weight: 62.5, reps: 8 }, { weight: 60, reps: 8 }), { weight: 2.5, reps: 0, newPR: true });
  assert.deepEqual(compareBestSet({ weight: 60, reps: 10 }, { weight: 60, reps: 8 }), { weight: 0, reps: 2, newPR: true });
  assert.deepEqual(compareBestSet({ weight: 60, reps: 8 }, { weight: 60, reps: 8 }), { weight: 0, reps: 0, newPR: false });
  const firstEver = compareBestSet({ weight: 40, reps: 8 }, null);
  assert.equal(firstEver.newPR, false, 'first-ever performance is not a PR (nothing beaten)');
});

test('sessionPRs detects real PRs and never invents them', () => {
  const history = [
    workoutOn('2026-09-01', [{ exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 60 }]),
    workoutOn('2026-09-08', [{ exerciseName: 'Squat', sets: 3, reps: 5, weight: 100 }]),
  ];
  const session = makeActiveWorkout({
    exercises: [
      makeSessionExercise({ exerciseName: 'Bench Press', sets: [{ weight: 62.5, reps: 8, done: true }] }), // PR +2.5
      makeSessionExercise({ exerciseName: 'Squat', sets: [{ weight: 100, reps: 5, done: true }] }), // equal, not a PR
      makeSessionExercise({ exerciseName: 'New Exercise', sets: [{ weight: 50, reps: 10, done: true }] }), // first time, not a PR
    ],
  });
  const prs = sessionPRs(session, history, { today: TODAY });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].exerciseName, 'Bench Press');
  assert.equal(prs[0].weight, 62.5);
  assert.equal(prs[0].previousWeight, 60);
  assert.equal(prs[0].weightDelta, 2.5);
});

test('PR via reps at equal weight is detected', () => {
  const history = [workoutOn('2026-09-01', [{ exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 60 }])];
  const session = makeActiveWorkout({
    exercises: [makeSessionExercise({ exerciseName: 'Bench Press', sets: [{ weight: 60, reps: 10, done: true }] })],
  });
  const prs = sessionPRs(session, history, { today: TODAY });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].repsDelta, 2);
});

test('lastWorkoutBeforeToday ignores today and orders correctly', () => {
  const a = workoutOn('2026-09-01', [{ exerciseName: 'A', sets: 1, reps: 1, weight: 0 }]);
  const b = workoutOn('2026-09-09', [{ exerciseName: 'B', sets: 1, reps: 1, weight: 0 }]);
  const c = workoutOn(TODAY, [{ exerciseName: 'C', sets: 1, reps: 1, weight: 0 }]);
  assert.equal(lastWorkoutBeforeToday([a, b, c], TODAY), b);
  assert.equal(lastWorkoutBeforeToday([c], TODAY), null);
});

test('lastTimeForExercise returns rows + date', () => {
  const w = workoutOn('2026-09-08', [{ exerciseName: 'Bench', sets: 2, reps: 8, weight: 60 }]);
  const last = lastTimeForExercise([w], 'Bench', { today: TODAY });
  assert.equal(last.date, '2026-09-08');
  assert.equal(last.rows.length, 2);
  assert.equal(lastTimeForExercise([w], 'Row', { today: TODAY }), null);
});

// ---------------------------------------------------------------------------
// Migration: SAVE AS TEMPLATE (§27/§28)
// ---------------------------------------------------------------------------

test('templateDataFromWorkout converts a historical workout into template data', () => {
  const w = workoutOn('2026-09-08', [
    { exerciseName: 'Bench Press', sets: 4, reps: 8, weight: 60 },
    { exerciseName: 'Row', sets: 3, reps: 10, weight: 50 },
  ]);
  const data = templateDataFromWorkout(w);
  assert.equal(data.exercises.length, 2);
  assert.equal(data.exercises[0].exerciseName, 'Bench Press');
  assert.equal(data.exercises[0].defaultSets, 4);
  assert.equal(data.exercises[0].reps, 8);
  assert.equal(data.exercises[0].weight, 60);
});

// ---------------------------------------------------------------------------
// Template factory invariants (§30/§32: template ≠ history)
// ---------------------------------------------------------------------------

test('editing template data never rewrites historical workout objects', () => {
  const w = workoutOn('2026-09-08', [{ exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 60 }]);
  const template = makeWorkoutTemplate({ name: 'Push', exercises: [{ exerciseName: 'Bench Press', defaultSets: 3 }] });
  const snapshot = JSON.stringify(w);
  template.exercises = []; // simulate removing an exercise from the plan
  template.name = 'Renamed';
  assert.equal(JSON.stringify(w), snapshot);
});

// ---------------------------------------------------------------------------
// Formatting + stepping helpers
// ---------------------------------------------------------------------------

test('formatWeight trims .0 but keeps halves', () => {
  assert.equal(formatWeight(60), '60');
  assert.equal(formatWeight(62.5), '62.5');
  assert.equal(formatWeight(62.25), '62.3');
});

test('formatElapsed renders mm:ss', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(62000), '01:02');
});

test('stepWeight uses practical gym increments', () => {
  assert.equal(stepWeight(60, 1), 62.5);
  assert.equal(stepWeight(42.5, 1), 45);
  assert.equal(stepWeight(100, 1), 105);
  assert.equal(stepWeight(2.5, -1), 0, 'never negative');
});

test('reorderTemplateExercises moves an item and keeps others stable', () => {
  const list = ['a', 'b', 'c'].map((exerciseName) => ({ exerciseName }));
  assert.deepEqual(reorderTemplateExercises(list, 0, 2).map((e) => e.exerciseName), ['b', 'c', 'a']);
  assert.deepEqual(list.map((e) => e.exerciseName), ['a', 'b', 'c'], 'input untouched');
});

// ---------------------------------------------------------------------------
// Empty workout (§29)
// ---------------------------------------------------------------------------

test('empty session has no template linkage and no exercises', () => {
  const s = buildEmptySession();
  assert.equal(s.templateId, null);
  assert.equal(s.exercises.length, 0);
  assert.equal(sessionCompletable(s), false);
});

// ---------------------------------------------------------------------------
// V1.4.1 — set value editing + validation semantics (§2–§6)
// ---------------------------------------------------------------------------

test('updateSet accepts decimal weights typed directly (42.5, 62.5)', () => {
  const s = sessionWithBench();
  const a = updateSet(s, s.exercises[0].id, 0, { weight: 42.5 });
  assert.equal(a.exercises[0].sets[0].weight, 42.5);
  const b = updateSet(s, s.exercises[0].id, 1, { weight: 62.5 });
  assert.equal(b.exercises[0].sets[1].weight, 62.5);
});

test('updateSet treats empty/cleared input as 0 without crashing', () => {
  const s = sessionWithBench();
  const next = updateSet(s, s.exercises[0].id, 0, { weight: NaN, reps: NaN });
  assert.equal(next.exercises[0].sets[0].weight, 0);
  assert.equal(next.exercises[0].sets[0].reps, 0);
});

test('updateSet rejects negative weight/reps', () => {
  const s = sessionWithBench();
  const next = updateSet(s, s.exercises[0].id, 0, { weight: -20, reps: -3 });
  assert.equal(next.exercises[0].sets[0].weight, 0);
  assert.equal(next.exercises[0].sets[0].reps, 0);
});

test('reps normalize to integers; weight keeps 0.5 steps', () => {
  const s = sessionWithBench();
  const next = updateSet(s, s.exercises[0].id, 0, { weight: 60.3, reps: 8.7 });
  assert.equal(next.exercises[0].sets[0].weight, 60.5);
  assert.equal(next.exercises[0].sets[0].reps, 9);
});

test('stepWeight keeps 0.5 kg increments below 100 kg and 5 kg above', () => {
  assert.equal(stepWeight(60, 1), 62.5);
  assert.equal(stepWeight(62.5, 1), 65);
  assert.equal(stepWeight(60, -1), 57.5);
  assert.equal(stepWeight(100, 1), 105);
});

// ---------------------------------------------------------------------------
// V1.4.1 — set deletion combinations (§7–§10)
// ---------------------------------------------------------------------------

function fourSetSession() {
  const s = buildEmptySession();
  const withSets = addSessionExercise(s, 'Chest Fly');
  withSets.exercises[0].sets = [
    { weight: 20, reps: 12, done: true },
    { weight: 20, reps: 12, done: false },
    { weight: 22.5, reps: 10, done: true },
    { weight: 22.5, reps: 10, done: false },
  ];
  return withSets;
}

test('delete first set keeps remaining values and completion state', () => {
  const s = fourSetSession();
  const next = removeSet(s, s.exercises[0].id, 0);
  assert.equal(next.exercises[0].sets.length, 3);
  assert.deepEqual(next.exercises[0].sets.map((x) => x.weight), [20, 22.5, 22.5]);
  assert.deepEqual(next.exercises[0].sets.map((x) => x.done), [false, true, false]);
});

test('delete middle set keeps first and last untouched', () => {
  const s = fourSetSession();
  const next = removeSet(s, s.exercises[0].id, 1);
  assert.equal(next.exercises[0].sets.length, 3);
  assert.deepEqual(next.exercises[0].sets.map((x) => [x.weight, x.done]), [[20, true], [22.5, true], [22.5, false]]);
});

test('delete last set of many', () => {
  const s = fourSetSession();
  const next = removeSet(s, s.exercises[0].id, 3);
  assert.equal(next.exercises[0].sets.length, 3);
  assert.equal(next.exercises[0].sets[2].weight, 22.5);
});

test('delete set after editing values of remaining sets', () => {
  let s = fourSetSession();
  s = updateSet(s, s.exercises[0].id, 0, { weight: 25, reps: 8 });
  s = removeSet(s, s.exercises[0].id, 2);
  assert.equal(s.exercises[0].sets.length, 3);
  assert.equal(s.exercises[0].sets[0].weight, 25);
  assert.equal(s.exercises[0].sets[0].reps, 8);
});

test('delete set after adding a set (index integrity)', () => {
  let s = fourSetSession();
  s = addSet(s, s.exercises[0].id);
  assert.equal(s.exercises[0].sets.length, 5);
  s = removeSet(s, s.exercises[0].id, 4);
  assert.equal(s.exercises[0].sets.length, 4);
  assert.equal(s.exercises[0].sets[4 - 1].weight, 22.5);
});

test('minimum-set rule: deleting the final set resets it instead of emptying', () => {
  const s = fourSetSession();
  let one = removeSet(s, s.exercises[0].id, 0);
  one = removeSet(one, one.exercises[0].id, 0);
  one = removeSet(one, one.exercises[0].id, 0);
  assert.equal(one.exercises[0].sets.length, 1, 'never zero sets');
});

test('completed session volume is unchanged by which sets were removed later', () => {
  // Historical conversion always happens from the session's own sets —
  // deletion of active-session sets can never touch stored history.
  const s = fourSetSession();
  const workout = completeSession(s);
  assert.equal(workout.exercises[0].sets, 4);
});

// ---------------------------------------------------------------------------
// V1.4.1 — custom exercise helpers (§11–§21, pure logic)
// ---------------------------------------------------------------------------

test('isUniqueExerciseName is case-insensitive and whitespace tolerant', () => {
  const taken = ['Chest Fly', 'Lat Pulldown'];
  assert.equal(isUniqueExerciseName('chest fly', taken), false);
  assert.equal(isUniqueExerciseName('  CHEST FLY  ', taken), false);
  assert.equal(isUniqueExerciseName('Cable Chest Fly', taken), true);
  assert.equal(isUniqueExerciseName('', taken), false);
  assert.equal(isUniqueExerciseName('   ', taken), false);
});

test('groupLibraryEntries separates single-use entries (custom) from used ones', () => {
  const entries = [
    { name: 'Cable Chest Fly', key: 'cable chest fly', useCount: 1, usedAt: 3 },
    { name: 'Bench Press', key: 'bench press', useCount: 5, usedAt: 2 },
    { name: 'Squat', key: 'squat', useCount: 1, usedAt: 1 },
  ];
  const { custom, rest } = groupLibraryEntries(entries);
  assert.deepEqual(custom.map((e) => e.name), ['Cable Chest Fly', 'Squat']);
  assert.deepEqual(rest.map((e) => e.name), ['Bench Press']);
});

test('custom exercise pre-fills from history exactly like predefined ones', () => {
  const w = workoutOn('2026-09-08', [{ exerciseName: 'Cable Chest Fly', sets: 3, reps: 12, weight: 20 }]);
  const tex = makeTemplateExercise({ exerciseName: 'Cable Chest Fly', defaultSets: 3 });
  const rows = prefillSetsForExercise(tex, [w], { beforeDate: TODAY });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.weight, r.reps]), [[20, 12], [20, 12], [20, 12]]);
});

test('custom exercise earns PRs and feeds volume like any exercise', () => {
  const history = workoutOn('2026-09-08', [{ exerciseName: 'Cable Chest Fly', sets: 3, reps: 12, weight: 20 }]);
  const session = buildEmptySession();
  const withCustom = addSessionExercise(session, 'Cable Chest Fly', [{ weight: 22.5, reps: 12 }, { weight: 22.5, reps: 12 }]);
  withCustom.exercises[0].sets.forEach((x) => (x.done = true));
  const prs = sessionPRs(withCustom, [history], { today: TODAY });
  assert.equal(prs.length, 1);
  assert.equal(prs[0].exerciseName, 'Cable Chest Fly');
  assert.equal(prs[0].weightDelta, 2.5);
});
