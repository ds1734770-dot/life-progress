/**
 * Body metrics — weight and tape measurements over time. Stored in kg/cm;
 * the display unit (kg or lb) is a setting. One store: bodyMetrics.
 */
import { dbDelete, dbGetAll, dbPut } from './db.js';
import { uid, todayKey, addDays } from './utils.js';

export const KG_PER_LB = 0.45359237;
export const kgToLb = (kg) => kg / KG_PER_LB;
export const lbToKg = (lb) => lb * KG_PER_LB;

const num = (v, min, max) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null;
};

export function makeBodyEntry(data = {}) {
  return {
    id: data.id || uid(),
    date: data.date || todayKey(),
    weight: num(data.weight, 20, 400), // kg
    waist: num(data.waist, 30, 250), // cm
    chest: num(data.chest, 30, 250),
    hips: num(data.hips, 30, 250),
    note: String(data.note || '').trim().slice(0, 140),
    createdAt: data.createdAt || Date.now(),
  };
}

export function validateBodyEntry(e) {
  if (e.weight == null && e.waist == null && e.chest == null && e.hips == null) return 'Enter at least one valid measurement.';
  return null;
}

export async function getAllEntries() {
  return (await dbGetAll('bodyMetrics')).sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));
}
export async function saveEntry(data) {
  const entry = makeBodyEntry(data);
  await dbPut('bodyMetrics', entry);
  return entry;
}
export async function deleteEntry(id) {
  await dbDelete('bodyMetrics', id);
}

/** One weight per day (the latest logged that day), oldest first. */
export function weightSeries(entries, { days = null, today = todayKey() } = {}) {
  const byDay = new Map();
  for (const e of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    if (e.weight != null) byDay.set(e.date, e.weight);
  }
  const cutoff = days ? addDays(today, -(days - 1)) : '0000-00-00';
  return [...byDay.entries()]
    .filter(([d]) => d >= cutoff)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, weight]) => ({ date, weight }));
}

export function weightStats(series) {
  if (!series.length) return null;
  const first = series[0].weight;
  const last = series[series.length - 1].weight;
  const ws = series.map((s) => s.weight);
  return { first, last, change: Math.round((last - first) * 10) / 10, min: Math.min(...ws), max: Math.max(...ws) };
}

export function bmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

export function bmiCategory(v) {
  if (v == null) return '';
  if (v < 18.5) return 'Underweight range';
  if (v < 25) return 'Healthy range';
  if (v < 30) return 'Overweight range';
  return 'Obese range';
}

export function displayWeight(kg, unit) {
  if (kg == null) return '—';
  const v = unit === 'lb' ? kgToLb(kg) : kg;
  return `${Math.round(v * 10) / 10} ${unit}`;
}

export function toKg(value, unit) {
  const n = Number(value);
  return unit === 'lb' ? lbToKg(n) : n;
}
