/**
 * Gym domain logic — workouts, exercises, streaks, analytics.
 */
import { dbDelete, dbGetAll, dbPut } from './db.js';
import { makeWorkout } from './models.js';
import { calculateStreak, todayKey, addDays, startOfWeekKey, formatDate } from './utils.js';

export async function getAllWorkouts() {
  return sortWorkouts(await dbGetAll('workouts'));
}

/** Newest day first; within a day, newest logged first. */
export function sortWorkouts(list) {
  return list.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));
}

export async function addWorkout(data) {
  const workout = makeWorkout(data);
  await dbPut('workouts', workout);
  return workout;
}

export async function deleteWorkout(id) {
  await dbDelete('workouts', id);
}

export function workoutsOn(workouts, key) {
  return workouts.filter((w) => w.date === key);
}

export function workoutStreak(workouts) {
  return calculateStreak(workouts.map((w) => w.date));
}

export function gymStats(workouts) {
  const today = todayKey();
  const weekStart = startOfWeekKey(today);
  const monthKey = today.slice(0, 7);
  return {
    streak: workoutStreak(workouts),
    total: workouts.length,
    thisWeek: workouts.filter((w) => w.date >= weekStart && w.date <= today).length,
    thisMonth: workouts.filter((w) => w.date.startsWith(monthKey)).length,
  };
}

/** Total duration per week for the last `weeks` weeks (oldest first). */
export function weeklyVolume(workouts, weeks = 8) {
  const today = todayKey();
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(startOfWeekKey(today), -i * 7);
    const end = addDays(start, 6);
    const sum = workouts
      .filter((w) => w.date >= start && w.date <= end)
      .reduce((acc, w) => acc + (w.duration || 0), 0);
    buckets.push({ key: start, label: formatDate(start, { short: true }), minutes: sum });
  }
  return buckets;
}

/** Personal best weight per exercise. */
export function personalRecords(workouts) {
  const map = new Map();
  for (const w of workouts) {
    for (const ex of w.exercises) {
      if (!ex.exerciseName) continue;
      const name = ex.exerciseName;
      const current = map.get(name);
      if (!current || ex.weight > current.weight) {
        map.set(name, { name, weight: ex.weight, reps: ex.reps, date: w.date });
      }
    }
  }
  return [...map.values()]
    .filter((r) => r.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6);
}

/** Exercise split: how many times each exercise appears. */
export function exerciseFrequency(workouts) {
  const map = new Map();
  for (const w of workouts) {
    const seen = new Set();
    for (const ex of w.exercises) {
      if (!ex.exerciseName || seen.has(ex.exerciseName)) continue;
      seen.add(ex.exerciseName);
      map.set(ex.exerciseName, (map.get(ex.exerciseName) || 0) + 1);
    }
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
}