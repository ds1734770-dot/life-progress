/**
 * Life Score — one 0–100 number per day, built from the SAME weights and
 * rules as the dashboard's "Today" progress (calculateDailyProgress), so the
 * score for today always equals the rings' percentage. Pure and derived:
 * nothing is stored, any past day can be scored from the activity stores.
 */
import { addDays, calculateDailyProgress, clamp, todayKey } from './utils.js';
import { inBucketOn, isCompletedOn } from './goals.js';
import { totalOn, waterTarget } from './water.js';

export const PART_LABELS = { goals: 'Goals', water: 'Water', gym: 'Workout', journal: 'Journal' };

/** Each part is 0..1, or null when it does not apply (no goals due). */
export function dayParts(date, data) {
  const due = (data.goals || []).filter((g) => inBucketOn(g, 'daily', date));
  const target = waterTarget();
  return {
    goals: due.length ? due.filter((g) => isCompletedOn(g, date)).length / due.length : null,
    water: clamp(totalOn(data.waterEntries || [], date) / target, 0, 1),
    gym: (data.workouts || []).some((w) => w.date === date) ? 1 : 0,
    journal: (data.journalEntries || []).some((e) => e.date === date) ? 1 : 0,
  };
}

export function lifeScore(date, data) {
  const parts = dayParts(date, data);
  return { date, parts, score: calculateDailyProgress(parts) };
}

/** Oldest → newest scores for the last `days` days. */
export function lifeScoreSeries(data, days = 14, today = todayKey()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(lifeScore(addDays(today, -i), data));
  return out;
}

const avg = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : 0);

/** 7-day average vs the 7 days before it. */
export function scoreTrend(data, today = todayKey()) {
  const s = lifeScoreSeries(data, 14, today).map((d) => d.score);
  const prev = Math.round(avg(s.slice(0, 7)));
  const cur = Math.round(avg(s.slice(7)));
  return { current: cur, previous: prev, delta: cur - prev };
}

export function scoreLabel(score) {
  if (score >= 90) return 'Outstanding';
  if (score >= 70) return 'Strong';
  if (score >= 45) return 'Building';
  if (score > 0) return 'Getting started';
  return 'Fresh page';
}

/**
 * What moved today's score? Compares each part against its average over the
 * previous 7 days and returns the biggest swing (or null if nothing notable).
 */
export function whatMoved(data, today = todayKey()) {
  const now = dayParts(today, data);
  const hist = Array.from({ length: 7 }, (_, i) => dayParts(addDays(today, -(i + 1)), data));
  let best = null;
  for (const key of Object.keys(PART_LABELS)) {
    if (now[key] == null) continue;
    const past = hist.map((h) => h[key]).filter((v) => v != null);
    if (!past.length) continue;
    const delta = now[key] - avg(past);
    if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { key, label: PART_LABELS[key], delta };
  }
  if (!best || Math.abs(best.delta) < 0.2) return null;
  return best;
}
