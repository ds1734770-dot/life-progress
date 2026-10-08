/**
 * Smart insights — plain-language patterns found in the user's own data.
 * Pure and on-device. Every rule needs a minimum sample before it speaks, so
 * nothing is ever claimed from two data points.
 */
import { addDays, todayKey, parseKey } from './utils.js';
import { totalOn, waterTarget } from './water.js';
import { lifeScoreSeries } from './lifeScore.js';
import { MOOD_SCORES } from './journal.js';

const WINDOW = 60;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const avg = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0);
const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

function days(today, n = WINDOW) {
  return Array.from({ length: n }, (_, i) => addDays(today, -i));
}

/** Water goal hit-rate on workout days vs rest days. */
function waterVsGym(data, today) {
  const target = waterTarget();
  const gymDays = new Set((data.workouts || []).map((w) => w.date));
  const withGym = [];
  const without = [];
  for (const d of days(today)) {
    const hit = totalOn(data.waterEntries || [], d) >= target;
    (gymDays.has(d) ? withGym : without).push(hit);
  }
  if (withGym.length < 4 || without.length < 4) return null;
  const a = pct(withGym.filter(Boolean).length, withGym.length);
  const b = pct(without.filter(Boolean).length, without.length);
  if (Math.abs(a - b) < 15) return null;
  return {
    id: 'water-gym',
    icon: 'droplet',
    tone: a > b ? 'good' : 'info',
    priority: 3,
    title: a > b ? 'Training makes you drink more' : 'Rest days are your best hydration days',
    text: `You hit your water goal on ${a}% of workout days vs ${b}% of rest days.`,
  };
}

/** Average mood on workout days vs other days. */
function moodVsGym(data, today) {
  const gymDays = new Set((data.workouts || []).map((w) => w.date));
  const byDay = new Map();
  for (const e of data.journalEntries || []) {
    if (e.mood in MOOD_SCORES && e.date <= today && e.date >= addDays(today, -(WINDOW - 1))) {
      byDay.set(e.date, [...(byDay.get(e.date) || []), MOOD_SCORES[e.mood]]);
    }
  }
  const withGym = [];
  const without = [];
  for (const [d, scores] of byDay) (gymDays.has(d) ? withGym : without).push(avg(scores));
  if (withGym.length < 4 || without.length < 4) return null;
  const diff = avg(withGym) - avg(without);
  if (Math.abs(diff) < 0.4) return null;
  return {
    id: 'mood-gym',
    icon: 'sparkles',
    tone: diff > 0 ? 'good' : 'info',
    priority: 4,
    title: diff > 0 ? 'Workouts lift your mood' : 'Your mood dips on workout days',
    text: diff > 0 ? 'Your logged mood is noticeably higher on days you train.' : 'Your logged mood is lower on training days. Consider more recovery or lighter sessions.',
  };
}

/** Strongest weekday by average life score (needs ~4 weeks). */
function bestWeekday(data, today) {
  const series = lifeScoreSeries(data, 35, today);
  const buckets = Array.from({ length: 7 }, () => []);
  for (const s of series) buckets[parseKey(s.date).getDay()].push(s.score);
  if (buckets.some((b) => b.length < 4)) return null;
  const means = buckets.map(avg);
  if (Math.max(...means) < 25) return null;
  const best = means.indexOf(Math.max(...means));
  const worst = means.indexOf(Math.min(...means));
  if (means[best] - means[worst] < 15) return null;
  return {
    id: 'best-weekday',
    icon: 'calendar',
    tone: 'info',
    priority: 2,
    title: `${DAY_NAMES[best]} are your power days`,
    text: `You score ${Math.round(means[best])} on average on ${DAY_NAMES[best]} and ${Math.round(means[worst])} on ${DAY_NAMES[worst]}. Plan the hard things accordingly.`,
  };
}

/** This week vs last week. */
function weekOverWeek(data, today) {
  const s = lifeScoreSeries(data, 14, today).map((d) => d.score);
  const prev = avg(s.slice(0, 7));
  const cur = avg(s.slice(7));
  if (prev === 0 && cur === 0) return null;
  const delta = Math.round(cur - prev);
  if (Math.abs(delta) < 5) return null;
  return {
    id: 'week-delta',
    icon: 'flame',
    tone: delta > 0 ? 'good' : 'warn',
    priority: 5,
    title: delta > 0 ? `Up ${delta} points on last week` : `Down ${Math.abs(delta)} points on last week`,
    text: delta > 0 ? 'Your 7-day average is climbing. Keep the routine that got you here.' : 'A softer week. One small win today is enough to turn it around.',
  };
}

/** Water trend over the last two weeks. */
function waterTrend(data, today) {
  const t = waterTarget();
  const sum = (from, to) => {
    let total = 0;
    for (let i = from; i < to; i++) total += totalOn(data.waterEntries || [], addDays(today, -i));
    return total / (to - from);
  };
  const cur = sum(0, 7);
  const prev = sum(7, 14);
  if (prev < t * 0.1 && cur < t * 0.1) return null;
  const change = pct(cur - prev, prev || 1);
  if (Math.abs(change) < 15 || prev === 0) return null;
  return {
    id: 'water-trend',
    icon: 'droplet',
    tone: change > 0 ? 'good' : 'warn',
    priority: 3,
    title: change > 0 ? 'Hydration is trending up' : 'Hydration is slipping',
    text: `You averaged ${Math.round(cur)} ml/day this week vs ${Math.round(prev)} ml last week.`,
  };
}

/** Which habit is the weakest link over the last 14 days. */
function weakestHabit(data, today) {
  const series = lifeScoreSeries(data, 14, today);
  if (series.every((s) => s.score === 0)) return null;
  const sums = { Workout: 0, Journal: 0 };
  for (const s of series) {
    sums.Workout += s.parts.gym;
    sums.Journal += s.parts.journal;
  }
  const entries = Object.entries(sums).sort((a, b) => a[1] - b[1]);
  const [name, count] = entries[0];
  if (count > 4) return null;
  return {
    id: 'weakest',
    icon: 'target',
    tone: 'info',
    priority: 1,
    title: `${name} is your growth edge`,
    text: `Only ${count} of the last 14 days included a ${name.toLowerCase()}. Even a short one would lift your score.`,
  };
}

const RULES = [waterVsGym, moodVsGym, bestWeekday, weekOverWeek, waterTrend, weakestHabit];

export function buildInsights(data, today = todayKey(), limit = 4) {
  const found = [];
  for (const rule of RULES) {
    try {
      const r = rule(data, today);
      if (r) found.push(r);
    } catch {
      /* one broken rule must never hide the rest */
    }
  }
  return found.sort((a, b) => b.priority - a.priority).slice(0, limit);
}

/** Total distinct days with any activity in the last `n` days — gates the empty state. */
export function activeDayCount(data, today = todayKey(), n = 30) {
  const set = new Set();
  const from = addDays(today, -(n - 1));
  const add = (d) => d && d >= from && d <= today && set.add(d);
  (data.waterEntries || []).forEach((e) => add(e.date));
  (data.workouts || []).forEach((e) => add(e.date));
  (data.journalEntries || []).forEach((e) => add(e.date));
  return set.size;
}
