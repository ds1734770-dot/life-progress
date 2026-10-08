import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lifeScore, lifeScoreSeries, scoreLabel, whatMoved } from '../js/lifeScore.js';
import { evaluateFreezes, normalizeFreeze } from '../js/streakFreeze.js';
import { computeStreaks } from '../js/history.js';
import { muscleFor, muscleSets, loadLevel, neglectNote, daysSinceTrained } from '../js/bodyMap.js';
import { estimate1RM, plateBreakdown, overloadSuggestion } from '../js/gymTools.js';
import { weightSeries, weightStats, bmi, kgToLb, lbToKg, makeBodyEntry, validateBodyEntry } from '../js/bodyMetrics.js';
import { dailyPrompt, onThisDay, PROMPTS } from '../js/journalExtras.js';
import { weeklyRecap, recapSlides, workoutVolume } from '../js/wrapped.js';
import { buildInsights } from '../js/insights.js';
import { subtaskProgress, toggleSubtask, subtaskDone } from '../js/goals.js';
import { makeGoal, makeWaterEntry, makeWorkout, makeJournalEntry, sanitizeSubtasks } from '../js/models.js';
import { addDays } from '../js/utils.js';
import { isValidPin } from '../js/journalLock.js';

const TODAY = '2026-03-18'; // Wednesday
const empty = () => ({ waterEntries: [], goals: [], workouts: [], journalEntries: [] });

test('lifeScore matches the dashboard weighting and ignores goals when none are due', () => {
  const data = empty();
  data.workouts.push(makeWorkout({ date: TODAY }));
  data.journalEntries.push(makeJournalEntry({ date: TODAY, mood: '😊' }));
  // gym 1 (0.15) + journal 1 (0.15) + water 0 (0.3), goals null -> 0.30 / 0.60 = 50
  assert.equal(lifeScore(TODAY, data).score, 50);
  assert.equal(lifeScore(addDays(TODAY, -1), data).score, 0);
  assert.equal(lifeScoreSeries(data, 5, TODAY).length, 5);
  assert.equal(scoreLabel(95), 'Outstanding');
  assert.equal(scoreLabel(0), 'Fresh page');
});

test('whatMoved reports a notable swing and stays quiet otherwise', () => {
  const data = empty();
  assert.equal(whatMoved(data, TODAY), null);
  for (let i = 1; i <= 7; i++) data.workouts.push(makeWorkout({ date: addDays(TODAY, -i) }));
  const m = whatMoved(data, TODAY);
  assert.equal(m.key, 'gym');
  assert.ok(m.delta < 0);
});

test('streak freeze spends one on a missed yesterday after a real streak, and earns on 7 days', () => {
  const done = new Set(['2026-03-14', '2026-03-15', '2026-03-16']); // Sat Sun Mon; Tue 17 missed
  const noBank = evaluateFreezes(done, { banked: 0 }, TODAY);
  assert.equal(noBank.events.length, 0);

  const banked = evaluateFreezes(done, { banked: 1 }, TODAY);
  assert.deepEqual(banked.state.frozenDays, ['2026-03-17']);
  assert.equal(banked.state.banked, 0);
  assert.equal(banked.events[0].type, 'used');
  // idempotent
  const again = evaluateFreezes(done, banked.state, TODAY);
  assert.equal(again.events.length, 0);

  // short lead-in (2 days) is not protected
  const short = evaluateFreezes(new Set(['2026-03-15', '2026-03-16']), { banked: 1 }, TODAY);
  assert.equal(short.events.length, 0);

  // 7 straight days earn a freeze, capped at 2
  const week = new Set(Array.from({ length: 7 }, (_, i) => addDays('2026-03-12', i)));
  const earn = evaluateFreezes(week, null, TODAY);
  assert.equal(earn.state.banked, 1);
  assert.equal(evaluateFreezes(week, earn.state, TODAY).events.length, 0);
  assert.equal(normalizeFreeze({ banked: 99 }).banked, 2);
});

test('frozen days bridge the overall streak', () => {
  const data = empty();
  for (const d of ['2026-03-15', '2026-03-16']) data.workouts.push(makeWorkout({ date: d }));
  const base = computeStreaks('all', data, TODAY).current;
  const bridged = computeStreaks('all', { ...data, frozenDays: ['2026-03-17'] }, TODAY).current;
  assert.ok(bridged > base);
});

test('muscle map classifies exercises and counts sets', () => {
  assert.equal(muscleFor('Bench Press'), 'Chest');
  assert.equal(muscleFor('Cable Tricep Kickback'), 'Triceps');
  assert.equal(muscleFor('Zottman Mystery'), 'Other');
  const w = makeWorkout({ date: TODAY, exercises: [{ exerciseName: 'Squat', sets: 4, reps: 5, weight: 100 }, { exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 60 }] });
  const sets = muscleSets([w], 7, TODAY);
  assert.equal(sets.Quads, 4);
  assert.equal(sets.Chest, 3);
  assert.equal(loadLevel(0), 0);
  assert.equal(loadLevel(5), 2);
  assert.equal(loadLevel(20), 4);
  assert.equal(daysSinceTrained([w], '2026-03-20').Quads, 2);
  assert.match(neglectNote([w], TODAY), /Shoulders|Back|Biceps|Triceps|Core|Glutes|Hamstrings|Calves/);
});

test('gym tools: 1RM, plates, overload', () => {
  assert.equal(estimate1RM(100, 1), 100);
  assert.equal(estimate1RM(100, 5), 116.5);
  assert.equal(estimate1RM(0, 5), 0);
  const p = plateBreakdown(100);
  assert.deepEqual(p.perSide, [25, 15]);
  assert.equal(p.achieved, 100);
  assert.equal(plateBreakdown(15).belowBar, true);
  assert.equal(plateBreakdown(61).achieved, 60);
  assert.equal(plateBreakdown(61).remainder, 1);
  assert.deepEqual(overloadSuggestion([{ weight: 60, reps: 10 }, { weight: 60, reps: 10 }]).weight, 62.5);
  assert.equal(overloadSuggestion([{ weight: 60, reps: 8 }, { weight: 60, reps: 7 }]).reps, 9);
  assert.equal(overloadSuggestion([]), null);
});

test('body metrics: validation, series, stats, bmi, units', () => {
  assert.ok(validateBodyEntry(makeBodyEntry({})));
  assert.equal(makeBodyEntry({ weight: '81.26' }).weight, 81.3);
  assert.equal(makeBodyEntry({ weight: 5 }).weight, null);
  const entries = [
    makeBodyEntry({ date: '2026-03-01', weight: 82, createdAt: 1 }),
    makeBodyEntry({ date: '2026-03-10', weight: 80, createdAt: 2 }),
    makeBodyEntry({ date: '2026-03-10', weight: 79.5, createdAt: 3 }),
  ];
  const s = weightSeries(entries, { today: TODAY });
  assert.equal(s.length, 2);
  assert.equal(s[1].weight, 79.5);
  assert.equal(weightStats(s).change, -2.5);
  assert.equal(weightSeries(entries, { days: 7, today: TODAY }).length, 0);
  assert.equal(bmi(70, 175), 22.9);
  assert.equal(bmi(70, null), null);
  assert.ok(Math.abs(lbToKg(kgToLb(75)) - 75) < 1e-9);
});

test('journal extras: stable prompt and memories', () => {
  assert.equal(dailyPrompt(TODAY), dailyPrompt(TODAY));
  assert.ok(PROMPTS.includes(dailyPrompt('2026-01-01')));
  const entries = [
    { date: addDays(TODAY, -7), createdAt: 1, title: 'a' },
    { date: '2025-03-18', createdAt: 2, title: 'b' },
    { date: '2026-03-01', createdAt: 3, title: 'c' },
  ];
  const mem = onThisDay(entries, TODAY);
  assert.deepEqual(mem.map((m) => m.label), ['A week ago', 'One year ago']);
});

test('journal PIN validation', () => {
  assert.ok(isValidPin('1234'));
  assert.ok(isValidPin('12345678'));
  assert.ok(!isValidPin('123'));
  assert.ok(!isValidPin('12ab'));
  assert.ok(!isValidPin('123456789'));
});

test('weekly recap totals a Monday-Sunday week and builds slides', () => {
  const data = empty();
  // week of Mon 2026-03-16 .. Wed 18 (week to date)
  data.waterEntries.push(makeWaterEntry(3000, new Date('2026-03-16T10:00:00').getTime()));
  data.waterEntries.push(makeWaterEntry(1000, new Date('2026-03-17T10:00:00').getTime()));
  data.workouts.push(makeWorkout({ date: '2026-03-17', duration: 45, exercises: [{ exerciseName: 'Squat', sets: 3, reps: 5, weight: 100 }] }));
  data.journalEntries.push(makeJournalEntry({ date: '2026-03-18', mood: '🥳' }));
  const goal = makeGoal({ title: 'x', type: 'daily', completedDays: ['2026-03-16', '2026-03-17'] });
  data.goals.push(goal);
  const r = weeklyRecap(data, 0, TODAY);
  assert.equal(r.start, '2026-03-16');
  assert.equal(r.days, 3);
  assert.equal(r.water.totalMl, 4000);
  assert.equal(r.gym.sessions, 1);
  assert.equal(r.gym.volumeKg, 1500);
  assert.equal(r.gym.topExercise, 'Squat');
  assert.equal(r.goals.completed, 2);
  assert.equal(r.journal.topMood, '🥳');
  assert.equal(r.empty, false);
  const slides = recapSlides(r);
  assert.ok(slides.length >= 6);
  assert.ok(slides.every((s) => s.id && s.big !== undefined));
  assert.equal(weeklyRecap(empty(), -1, TODAY).empty, true);
  assert.equal(workoutVolume({ exercises: [{ performedSets: [{ weight: 50, reps: 10 }, { weight: 50, reps: 8 }] }] }), 900);
});

test('insights stay silent without data and speak with enough', () => {
  assert.deepEqual(buildInsights(empty(), TODAY), []);
  const data = empty();
  // 40 days: workout days always hit water goal, rest days never
  for (let i = 0; i < 40; i++) {
    const d = addDays(TODAY, -i);
    if (i % 2 === 0) {
      data.workouts.push(makeWorkout({ date: d }));
      data.waterEntries.push(makeWaterEntry(5000, new Date(d + 'T10:00:00').getTime()));
    }
  }
  const ins = buildInsights(data, TODAY);
  assert.ok(ins.find((i) => i.id === 'water-gym'));
  assert.ok(ins.length <= 4);
});

test('goal checklists reset daily for daily goals and persist otherwise', () => {
  const subs = sanitizeSubtasks([{ text: ' one ' }, { text: '' }, { text: 'two' }]);
  assert.equal(subs.length, 2);
  const g = makeGoal({ title: 't', type: 'daily', subtasks: subs });
  assert.equal(subtaskProgress(g, '2026-03-18').done, 0);
  assert.equal(toggleSubtask(g, g.subtasks[0].id, '2026-03-18'), true);
  assert.equal(subtaskProgress(g, '2026-03-18').done, 1);
  assert.equal(subtaskProgress(g, '2026-03-19').done, 0); // new day resets
  toggleSubtask(g, g.subtasks[1].id, '2026-03-18');
  assert.equal(subtaskProgress(g, '2026-03-18').all, true);
  const w = makeGoal({ title: 'w', type: 'weekly', subtasks: [{ text: 'a', doneDay: '2026-03-10' }] });
  assert.equal(subtaskDone(w, w.subtasks[0], '2026-03-18'), true);
});

test('backupDue nudges after a week, respects snooze and empty data', async () => {
  const { backupDue } = await import('../js/backup.js');
  const now = Date.parse('2026-03-18T12:00:00');
  const day = 86400000;
  assert.equal(backupDue({}, null, now, TODAY), false); // no data
  assert.equal(backupDue({}, '2026-03-17', now, TODAY), false); // too new
  assert.equal(backupDue({}, '2026-03-01', now, TODAY), true); // week of use, never backed up
  assert.equal(backupDue({ lastBackupAt: now - 2 * day }, '2026-01-01', now, TODAY), false);
  assert.equal(backupDue({ lastBackupAt: now - 8 * day }, '2026-01-01', now, TODAY), true);
  assert.equal(backupDue({ lastBackupAt: now - 8 * day, backupSnoozeUntil: now + day }, '2026-01-01', now, TODAY), false);
});

test('quotes: custom lines rotate with built-ins and parse safely', async () => {
  const { quoteOfTheDay, parseCustomQuotes, BUILT_IN_QUOTES } = await import('../js/quotes.js');
  assert.ok(BUILT_IN_QUOTES.length >= 30);
  assert.deepEqual(parseCustomQuotes('  a \n\n a\nb'), ['a', 'b']);
  assert.equal(parseCustomQuotes('x'.repeat(500))[0].length, 140);
  const d = new Date(2026, 2, 18);
  assert.ok(BUILT_IN_QUOTES.includes(quoteOfTheDay(d, [])));
  const seen = new Set();
  for (let i = 0; i < 12; i++) seen.add(quoteOfTheDay(new Date(2026, 2, 1 + i), ['mine']).text);
  assert.ok(seen.has('mine'));
  assert.ok(seen.size > 1);
});
