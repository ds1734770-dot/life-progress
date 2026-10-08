/**
 * Weekly Wrapped — a private, on-device recap of one Monday–Sunday week.
 * Pure derivation (no storage). The screen turns the recap into story cards
 * and a shareable image.
 */
import { addDays, startOfWeekKey, todayKey, formatDate } from './utils.js';
import { totalOn, waterTarget } from './water.js';
import { lifeScoreSeries } from './lifeScore.js';
import { computeStreaks } from './history.js';
import { MOOD_SCORES } from './journal.js';

/** Total lifted kg for a workout (per-set detail when present, else sets×reps×weight). */
export function workoutVolume(w) {
  let total = 0;
  for (const ex of w.exercises || []) {
    if (Array.isArray(ex.performedSets) && ex.performedSets.length) {
      for (const s of ex.performedSets) total += (Number(s.weight) || 0) * (Number(s.reps) || 0);
    } else {
      total += (ex.sets || 0) * (ex.reps || 0) * (ex.weight || 0);
    }
  }
  return Math.round(total);
}

export function weekRange(offset = 0, today = todayKey()) {
  const start = addDays(startOfWeekKey(today), offset * 7);
  return { start, end: addDays(start, 6) };
}

export function weeklyRecap(data, offset = 0, today = todayKey()) {
  const { start, end } = weekRange(offset, today);
  const last = end > today ? today : end; // week-to-date for the current week
  const inWeek = (d) => d >= start && d <= last;
  const dayKeys = [];
  for (let k = start; k <= last; k = addDays(k, 1)) dayKeys.push(k);

  const target = waterTarget();
  const waterByDay = dayKeys.map((d) => totalOn(data.waterEntries || [], d));
  const waterTotal = waterByDay.reduce((a, b) => a + b, 0);

  const workouts = (data.workouts || []).filter((w) => inWeek(w.date));
  const exerciseCount = new Map();
  for (const w of workouts) for (const ex of w.exercises || []) {
    if (ex.exerciseName) exerciseCount.set(ex.exerciseName, (exerciseCount.get(ex.exerciseName) || 0) + 1);
  }
  const topExercise = [...exerciseCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const goalDays = new Map();
  for (const g of data.goals || []) for (const d of g.completedDays || []) if (inWeek(d)) goalDays.set(d, (goalDays.get(d) || 0) + 1);
  const goalsDone = [...goalDays.values()].reduce((a, b) => a + b, 0);

  const entries = (data.journalEntries || []).filter((e) => inWeek(e.date));
  const moods = entries.map((e) => e.mood).filter((m) => m in MOOD_SCORES);
  const moodTally = new Map();
  for (const m of moods) moodTally.set(m, (moodTally.get(m) || 0) + 1);
  const topMood = [...moodTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Scores for the span (+ previous week for the delta). `today` is the clamp.
  const scores = lifeScoreSeries(data, 14 + 7, last).slice(-dayKeys.length).map((s) => s.score);
  const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const prevScores = lifeScoreSeries(data, 7, addDays(start, -1)).map((s) => s.score);
  const prevAvg = Math.round(prevScores.reduce((a, b) => a + b, 0) / 7);
  let best = { date: null, score: -1 };
  dayKeys.forEach((d, i) => {
    if (scores[i] > best.score) best = { date: d, score: scores[i] };
  });

  const streak = computeStreaks('all', data, last).current;

  const recap = {
    start,
    end,
    last,
    isCurrent: end >= today,
    days: dayKeys.length,
    water: {
      totalMl: waterTotal,
      avgMl: dayKeys.length ? Math.round(waterTotal / dayKeys.length) : 0,
      daysMet: waterByDay.filter((v) => v >= target).length,
    },
    gym: {
      sessions: workouts.length,
      minutes: workouts.reduce((a, w) => a + (w.duration || 0), 0),
      volumeKg: workouts.reduce((a, w) => a + workoutVolume(w), 0),
      topExercise,
    },
    goals: { completed: goalsDone, daysWithWins: goalDays.size },
    journal: { entries: entries.length, days: new Set(entries.map((e) => e.date)).size, topMood },
    score: { avg: avgScore, delta: avgScore - prevAvg, best: best.date ? best : null },
    streak,
  };
  recap.empty = !(waterTotal || workouts.length || goalsDone || entries.length);
  recap.headline = headline(recap);
  return recap;
}

export function headline(r) {
  if (r.empty) return 'A blank page, a fresh start';
  if (r.score.avg >= 80) return 'A week to be proud of';
  if (r.gym.sessions >= 4) return 'Iron-willed week';
  if (r.water.daysMet >= 6) return 'Hydration hero';
  if (r.journal.days >= 5) return 'The reflective week';
  if (r.score.delta >= 10) return 'Momentum is building';
  return 'Showing up counts';
}

export function rangeLabel(r) {
  return `${formatDate(r.start, { short: true })} – ${formatDate(r.last, { short: true })}`;
}

/** Story slides derived from a recap. Each: { id, emoji, kicker, big, caption, tone }. */
export function recapSlides(r) {
  const L = (ml) => (ml >= 1000 ? `${(ml / 1000).toFixed(1)} L` : `${ml} ml`);
  const slides = [
    { id: 'intro', emoji: '✨', kicker: rangeLabel(r), big: r.headline, caption: r.isCurrent ? 'Your week so far' : 'Your week in review', tone: 'accent' },
    {
      id: 'score',
      emoji: '🎯',
      kicker: 'Life Score',
      big: `${r.score.avg}`,
      caption: r.score.delta === 0 ? 'Same as last week' : `${r.score.delta > 0 ? '▲' : '▼'} ${Math.abs(r.score.delta)} vs last week`,
      tone: 'accent',
    },
    {
      id: 'water',
      emoji: '💧',
      kicker: 'Hydration',
      big: L(r.water.totalMl),
      caption: `${r.water.daysMet} day${r.water.daysMet === 1 ? '' : 's'} on target · ${L(r.water.avgMl)} a day`,
      tone: 'info',
    },
    {
      id: 'gym',
      emoji: '🏋️',
      kicker: 'Training',
      big: `${r.gym.sessions} session${r.gym.sessions === 1 ? '' : 's'}`,
      caption: r.gym.sessions
        ? `${r.gym.volumeKg ? `${r.gym.volumeKg.toLocaleString()} kg lifted · ` : ''}${r.gym.minutes} min${r.gym.topExercise ? ` · ${r.gym.topExercise} was your go-to` : ''}`
        : 'Rest is part of the plan',
      tone: 'success',
    },
    {
      id: 'goals',
      emoji: '✅',
      kicker: 'Goals',
      big: `${r.goals.completed}`,
      caption: r.goals.completed ? `completed across ${r.goals.daysWithWins} day${r.goals.daysWithWins === 1 ? '' : 's'}` : 'Set one tiny goal for tomorrow',
      tone: 'warning',
    },
    {
      id: 'journal',
      emoji: r.journal.topMood || '📖',
      kicker: 'Reflection',
      big: `${r.journal.entries} entr${r.journal.entries === 1 ? 'y' : 'ies'}`,
      caption: r.journal.entries ? `on ${r.journal.days} day${r.journal.days === 1 ? '' : 's'}${r.journal.topMood ? ` · mostly ${r.journal.topMood}` : ''}` : 'A few lines can change a day',
      tone: 'accent',
    },
  ];
  if (r.score.best) {
    slides.push({
      id: 'best',
      emoji: '🏆',
      kicker: 'Best day',
      big: formatDate(r.score.best.date, { short: true }),
      caption: `Life Score ${r.score.best.score}${r.streak > 0 ? ` · ${r.streak}-day streak alive` : ''}`,
      tone: 'warning',
    });
  }
  return slides;
}
