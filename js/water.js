/**
 * Water domain logic — entries, daily totals, targets, streaks, history.
 */
import { dbDelete, dbGetAll, dbPut } from './db.js';
import { makeWaterEntry } from './models.js';
import { calculateStreak, clamp, todayKey, addDays, dateKey } from './utils.js';
import { getSettings } from './settings.js';

export function waterTarget() {
  return Math.max(100, getSettings().waterTarget || 3000);
}

export function waterUnit() {
  return getSettings().waterUnit === 'L' ? 'L' : 'ml';
}

export async function addWater(amount) {
  const entry = makeWaterEntry(amount);
  await dbPut('waterEntries', entry);
  return entry;
}

export async function removeWaterEntry(id) {
  await dbDelete('waterEntries', id);
}

/** Newest first. */
export async function getAllEntries() {
  return (await dbGetAll('waterEntries')).sort((a, b) => b.timestamp - a.timestamp);
}

export function totalOn(entries, key) {
  return entries.filter((e) => e.date === key).reduce((sum, e) => sum + e.amount, 0);
}

export function totalsByDay(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.date, (map.get(e.date) || 0) + e.amount);
  return map;
}

export function remaining(entries, key = todayKey()) {
  return Math.max(0, waterTarget() - totalOn(entries, key));
}

export function waterFraction(entries, key = todayKey()) {
  return clamp(totalOn(entries, key) / waterTarget(), 0, 1);
}

/** Days where the daily target was met (date-independent: every day is checked). */
export function metDays(entries) {
  const totals = totalsByDay(entries);
  const target = waterTarget();
  return [...totals.entries()].filter(([, total]) => total >= target).map(([key]) => key);
}

/** Current streak of target-met days; `today` is injectable for deterministic tests. */
export function waterStreak(entries, today = todayKey()) {
  return calculateStreak(metDays(entries), today);
}

/** Last 7 days (oldest first) with totals + labels. */
export function last7Days(entries) {
  const totals = totalsByDay(entries);
  const target = waterTarget();
  const today = todayKey();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = addDays(today, -i);
    const total = totals.get(key) || 0;
    days.push({
      key,
      label: i === 0 ? 'Today' : dateKeyLabel(key),
      total,
      target,
      met: total >= target,
      // Clamped so the bar height and % pill can never be NaN/negative/infinite
      // (e.g. a target of 0 after a bad import).
      pct: clamp(Math.round((total / Math.max(1, target)) * 100), 0, 100),
    });
  }
  return days;
}

function dateKeyLabel(key) {
  return new Date(key + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'narrow' });
}

export function averageDaily(entries, days = 7) {
  if (!entries.length) return 0;
  const today = todayKey();
  const cutoff = addDays(today, -(days - 1));
  const recent = entries.filter((e) => e.date >= cutoff && e.date <= today);
  return Math.round(recent.reduce((sum, e) => sum + e.amount, 0) / days);
}