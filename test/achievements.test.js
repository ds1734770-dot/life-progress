import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_CATEGORIES,
  CATEGORY_META,
  getAchievement,
  buildMetrics,
  achievementProgress,
  evaluateAchievements,
  nextMilestone,
  badgeMarkup,
} from '../js/achievements.js';
import { makeGoal, makeWaterEntry, makeWorkout, makeJournalEntry } from '../js/models.js';

const TODAY = '2026-09-11'; // fixed Friday for determinism
const TARGET = 3000; // default water target

const baseData = () => ({ waterEntries: [], goals: [], workouts: [], journalEntries: [] });

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

test('every achievement has complete, valid metadata', () => {
  assert.ok(ACHIEVEMENTS.length >= 25, `expected a curated set, got ${ACHIEVEMENTS.length}`);
  for (const a of ACHIEVEMENTS) {
    assert.equal(typeof a.id, 'string', 'id');
    assert.ok(a.id.length > 0, 'id non-empty');
    assert.equal(typeof a.title, 'string', `title for ${a.id}`);
    assert.ok(a.description.length > 0, `description for ${a.id}`);
    assert.ok(ACHIEVEMENT_CATEGORIES.includes(a.category), `category for ${a.id}`);
    assert.ok(['bronze', 'silver', 'gold', 'platinum'].includes(a.tier), `tier for ${a.id}`);
    assert.ok(Number.isInteger(a.target) && a.target > 0, `target for ${a.id}`);
    assert.equal(typeof a.requirement, 'string', `requirement for ${a.id}`);
    assert.equal(typeof a.getProgress, 'function', `getProgress for ${a.id}`);
    assert.equal(typeof a.evidence, 'function', `evidence for ${a.id}`);
  }
});

test('achievement ids are unique', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('achievement categories are the documented set', () => {
  assert.deepEqual(ACHIEVEMENT_CATEGORIES, ['all', 'streak', 'water', 'gym', 'goals', 'journal']);
  for (const c of ACHIEVEMENT_CATEGORIES.filter((x) => x !== 'all')) {
    assert.ok(CATEGORY_META[c], `category meta for ${c}`);
  }
});

test('badge markup is original SVG artwork (no emoji, no external refs)', () => {
  const markup = badgeMarkup(ACHIEVEMENTS[0], { unlocked: true });
  assert.ok(markup.includes('<svg'));
  assert.ok(markup.includes('badge-glyph'));
  assert.ok(!/http|url\(|img/i.test(markup.replace(/var\(/g, '')));
  assert.ok(badgeMarkup(ACHIEVEMENTS[0], { unlocked: false }).includes('locked'));
});

// ---------------------------------------------------------------------------
// Streak achievements (current any-activity streak)
// ---------------------------------------------------------------------------

test('streak-1 First Step earns after one active day', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: TODAY, workoutType: 'Strength' })];
  const { records, earnedNew } = evaluateAchievements(data, [], TODAY);
  const s1 = getAchievement('streak-1');
  assert.ok(earnedNew.some((a) => a.id === 'streak-1'));
  assert.equal(achievementProgress(s1, buildMetrics(data, TODAY)).current, 1);
  assert.ok(records.some((r) => r.id === 'streak-1'));
});

test('streak-3, streak-7 earn at exact thresholds from consecutive workout days', () => {
  const data = baseData();
  data.workouts = [
    makeWorkout({ date: '2026-09-09', workoutType: 'Strength' }),
    makeWorkout({ date: '2026-09-10', workoutType: 'Cardio' }),
    makeWorkout({ date: '2026-09-11', workoutType: 'Yoga' }),
  ];
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'streak-3'));
  assert.ok(!records.some((r) => r.id === 'streak-7'));
  // Extend to 7 consecutive days (Sep 5–11).
  for (let d = 5; d <= 8; d++) {
    data.workouts.push(makeWorkout({ date: `2026-09-0${d}`, workoutType: 'Strength' }));
  }
  const { records: again } = evaluateAchievements(data, [], TODAY);
  assert.ok(again.some((r) => r.id === 'streak-7'));
});

test('broken streak does not earn streak badges and does not remove earned ones', () => {
  const data = baseData();
  data.workouts = [
    makeWorkout({ date: '2026-09-01', workoutType: 'Strength' }),
    makeWorkout({ date: '2026-09-02', workoutType: 'Strength' }),
  ]; // ended 9 days ago
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(!records.some((r) => r.id === 'streak-3'));
  // Simulate a previously earned 30-day badge with the streak now broken.
  const existing = [{ id: 'streak-30', earnedAt: 1750000000000 }];
  const { records: kept } = evaluateAchievements(data, existing, TODAY);
  assert.ok(kept.some((r) => r.id === 'streak-30'), 'earned badge remains after streak break');
});

test('timezone correctness: streak days are LOCAL date keys, not UTC shifts', () => {
  const data = baseData();
  // Entry logged 23:30 local on Sep 1 (UTC would already be Sep 2).
  data.waterEntries = [makeWaterEntry(TARGET, new Date(2026, 8, 1, 23, 30).getTime())];
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'streak-1'), 'local Sep 1 activity counts');
  // And the next local day continues the streak.
  data.waterEntries.push(makeWaterEntry(TARGET, new Date(2026, 8, 2, 8).getTime()));
  data.waterEntries.push(makeWaterEntry(TARGET, new Date(2026, 8, 3, 8).getTime()));
  const { records: three } = evaluateAchievements(data, [], TODAY);
  assert.ok(three.some((r) => r.id === 'streak-3'));
});

// ---------------------------------------------------------------------------
// Water achievements (distinct days the target was reached)
// ---------------------------------------------------------------------------

test('water-first earns when the daily target is reached; below-target never counts', () => {
  const data = baseData();
  data.waterEntries = [makeWaterEntry(TARGET, new Date(2026, 8, 11, 9).getTime())];
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'water-first'));

  const below = baseData();
  below.waterEntries = [makeWaterEntry(TARGET - 1, new Date(2026, 8, 11, 9).getTime())];
  const { records: none } = evaluateAchievements(below, [], TODAY);
  assert.ok(!none.some((r) => r.id === 'water-first'), 'TARGET-1 ml must not unlock First Sip');
});

test('water-7 counts 7 DISTINCT completed days (not 7 entries)', () => {
  const data = baseData();
  // 10 entries across only 3 days must NOT earn the 7-day badge.
  for (let i = 0; i < 10; i++) {
    data.waterEntries.push(makeWaterEntry(TARGET / 10 + 100, new Date(2026, 8, 9 + (i % 3), 10).getTime()));
  }
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(!records.some((r) => r.id === 'water-7'));
  // 7 distinct days at/above target DO earn it (two entries on one day is fine).
  for (let d = 5; d <= 11; d++) {
    data.waterEntries.push(makeWaterEntry(TARGET, new Date(2026, 8, d, 9).getTime()));
  }
  const { records: seven } = evaluateAchievements(data, [], TODAY);
  assert.ok(seven.some((r) => r.id === 'water-7'));
});

test('water-30 and water-100 thresholds respect distinct-day counting', () => {
  const data = baseData();
  for (let d = 1; d <= 30; d++) {
    data.waterEntries.push(makeWaterEntry(TARGET, new Date(2026, 7, d, 9).getTime())); // Aug 1–30
  }
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'water-30'));
  assert.ok(!records.some((r) => r.id === 'water-100'));
  const metrics = buildMetrics(data, TODAY);
  const w100 = getAchievement('water-100');
  assert.equal(achievementProgress(w100, metrics).current, 30);
});

// ---------------------------------------------------------------------------
// Gym achievements (workouts logged)
// ---------------------------------------------------------------------------

test('gym-1 earns on the first workout; gym-10 at ten', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: TODAY, workoutType: 'Strength' })];
  let { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'gym-1'));
  assert.ok(!records.some((r) => r.id === 'gym-10'));

  data.workouts = [];
  for (let i = 0; i < 10; i++) {
    data.workouts.push(makeWorkout({ date: `2026-09-0${(i % 9) + 1}`, workoutType: 'Strength' }));
  }
  ({ records } = evaluateAchievements(data, [], TODAY));
  assert.ok(records.some((r) => r.id === 'gym-10'));
});

test('gym-25, gym-50, gym-100 count workouts (multiple per day allowed)', () => {
  const data = baseData();
  for (let i = 0; i < 25; i++) {
    data.workouts.push(makeWorkout({ date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, workoutType: 'Strength' }));
  }
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'gym-25'));
  assert.ok(!records.some((r) => r.id === 'gym-50'));
  const metrics = buildMetrics(data, TODAY);
  assert.equal(achievementProgress(getAchievement('gym-50'), metrics).current, 25);
  assert.equal(achievementProgress(getAchievement('gym-100'), metrics).current, 25);
});

// ---------------------------------------------------------------------------
// Goal achievements
// ---------------------------------------------------------------------------

test('goals-1 earns on the first goal completion day; goals-10 at ten distinct days', () => {
  const data = baseData();
  data.goals = [makeGoal({ title: 't', type: 'daily', completedDays: [TODAY] })];
  let { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'goals-1'));

  data.goals = [makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-01', '2026-09-02', '2026-09-03'] })];
  ({ records } = evaluateAchievements(data, [], TODAY));
  assert.ok(!records.some((r) => r.id === 'goals-10'), '3 completion days ≠ 10');
  assert.equal(achievementProgress(getAchievement('goals-10'), buildMetrics(data, TODAY)).current, 3);
});

test('goals-consistency-7 uses the existing goal streak semantics', () => {
  const data = baseData();
  data.goals = [makeGoal({ title: 't', type: 'daily', completedDays: ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11'] })];
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'goals-consistency-7'));
});

// ---------------------------------------------------------------------------
// Journal achievements
// ---------------------------------------------------------------------------

test('journal-1 and journal-7 count distinct days, never expose content', () => {
  const data = baseData();
  data.journalEntries = [makeJournalEntry({ title: 'private', content: 'very private', date: TODAY })];
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'journal-1'));

  for (let d = 5; d <= 11; d++) {
    data.journalEntries.push(makeJournalEntry({ title: 'x', content: 'private text', date: `2026-09-0${d}`.slice(0, 10) }));
  }
  const { records: seven } = evaluateAchievements(data, [], TODAY);
  assert.ok(seven.some((r) => r.id === 'journal-7'));
  // Evidence must never include journal text.
  const metrics = buildMetrics(data, TODAY);
  const evidence = JSON.stringify(getAchievement('journal-7').evidence(metrics));
  assert.ok(!evidence.includes('private text'));
});

// ---------------------------------------------------------------------------
// Overall life achievements (all-category consistency streak)
// ---------------------------------------------------------------------------

function fullDay(data, key) {
  data.waterEntries.push(makeWaterEntry(TARGET, new Date(key.slice(0, 4), key.slice(5, 7) - 1, key.slice(8, 10), 9).getTime()));
  data.workouts.push(makeWorkout({ date: key, workoutType: 'Strength' }));
  data.journalEntries.push(makeJournalEntry({ title: 'x', content: 'y', date: key }));
  // ONE daily goal collecting each completed day — separate goals per day
  // would leave every day with N due goals and 1 completed (partial).
  let goal = data.goals.find((g) => g.type === 'daily');
  if (goal) goal.completedDays.push(key);
  else data.goals.push(makeGoal({ title: 'daily', type: 'daily', completedDays: [key] }));
}

test('life-7 earns after 7 consecutive full days; life-30 requires 30', () => {
  const data = baseData();
  for (let d = 5; d <= 11; d++) fullDay(data, `2026-09-${String(d).padStart(2, '0')}`);
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(records.some((r) => r.id === 'life-7'));
  assert.ok(!records.some((r) => r.id === 'life-30'));

  const metrics = buildMetrics(data, TODAY);
  assert.equal(metrics.overallStreak, 7);
  assert.equal(achievementProgress(getAchievement('life-30'), metrics).current, 7);
});

test('a partial day breaks the overall consistency streak (honest all)', () => {
  const data = baseData();
  for (let d = 8; d <= 11; d++) fullDay(data, `2026-09-${String(d).padStart(2, '0')}`);
  // Sep 7: water below target only → partial → breaks the all-streak.
  data.waterEntries.push(makeWaterEntry(500, new Date(2026, 8, 7, 9).getTime()));
  const { records } = evaluateAchievements(data, [], TODAY);
  assert.ok(!records.some((r) => r.id === 'life-7'));
  assert.equal(buildMetrics(data, TODAY).overallStreak, 4);
});

// ---------------------------------------------------------------------------
// Evaluation semantics: no duplicates, re-award, progress, next milestone
// ---------------------------------------------------------------------------

test('no duplicate awards: existing records suppress earnedNew', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: TODAY, workoutType: 'Strength' })];
  const existing = [{ id: 'streak-1', earnedAt: 1750000000000 }, { id: 'gym-1', earnedAt: 1750000000000 }];
  const { earnedNew, records } = evaluateAchievements(data, existing, TODAY);
  assert.equal(earnedNew.filter((a) => a.id === 'streak-1' || a.id === 'gym-1').length, 0);
  assert.equal(records.filter((r) => r.id === 'streak-1').length, 1);
  assert.equal(records.find((r) => r.id === 'streak-1').earnedAt, 1750000000000, 'original earnedAt preserved');
});

test('imported data without records re-awards once (reconstruction)', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: TODAY, workoutType: 'Strength' })];
  // No existing records at all (e.g. import from a backup without them).
  const { earnedNew, records } = evaluateAchievements(data, [], TODAY);
  assert.ok(earnedNew.some((a) => a.id === 'gym-1'));
  assert.equal(records.filter((r) => r.id === 'gym-1').length, 1, 'exactly one record');
});

test('malformed/unknown records are ignored safely', () => {
  const data = baseData();
  data.workouts = [makeWorkout({ date: TODAY, workoutType: 'Strength' })];
  const junk = [{ id: 'does-not-exist' }, null, {}, { id: 'streak-1', earnedAt: 42 }];
  const { records } = evaluateAchievements(data, junk, TODAY);
  assert.ok(!records.some((r) => r.id === 'does-not-exist'));
  assert.ok(records.some((r) => r.id === 'streak-1' && r.earnedAt === 42), 'valid record kept');
});

test('progress reports honest numerators for locked badges', () => {
  const data = baseData();
  data.workouts = Array.from({ length: 7 }, (_, i) => makeWorkout({ date: `2026-09-0${i + 1}`, workoutType: 'Strength' }));
  const metrics = buildMetrics(data, TODAY);
  const p = achievementProgress(getAchievement('gym-10'), metrics);
  assert.equal(p.current, 7);
  assert.equal(p.target, 10);
  assert.equal(p.earned, false);
  assert.equal(p.pct, 70);
});

test('nextMilestone bridges from an earned badge to the next tier', () => {
  const data = baseData();
  data.workouts = Array.from({ length: 10 }, (_, i) => makeWorkout({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, workoutType: 'Strength' }));
  const { progress } = evaluateAchievements(data, [], TODAY);
  // gym-1 earned → its declared next is gym-10 (also earned) → ladder falls to gym-25.
  const next = nextMilestone('gym-1', progress);
  assert.ok(next && next.id === 'gym-25', `got ${next && next.id}`);
  // Locked badge: next for gym-10 is gym-25 as well.
  assert.equal(nextMilestone('gym-10', progress).id, 'gym-25');
});

test('nextMilestone returns null when everything is earned', () => {
  const data = baseData();
  // Artificially earn everything via records and pass a progress map marking them earned.
  const progress = new Map(ACHIEVEMENTS.map((d) => [d.id, { current: d.target, target: d.target, earned: true, pct: 100 }]));
  assert.equal(nextMilestone('gym-1', progress), null);
});

// ---------------------------------------------------------------------------
// Leap day / year boundary sanity for achievement streaks
// ---------------------------------------------------------------------------

test('leap day counts as a normal local day in streaks', () => {
  const data = baseData();
  for (const key of ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']) {
    data.workouts.push(makeWorkout({ date: key, workoutType: 'Strength' }));
  }
  const metrics = buildMetrics(data, '2028-03-01');
  assert.equal(metrics.streaks.gym.current, 4);
});

test('year boundary does not break the overall streak', () => {
  const data = baseData();
  for (const key of ['2026-12-30', '2026-12-31', '2027-01-01']) {
    fullDay(data, key);
  }
  const metrics = buildMetrics(data, '2027-01-01');
  assert.equal(metrics.overallStreak, 3);
});
