/**
 * Goals domain logic — CRUD, buckets (today/week/month/custom), stats, streaks.
 */
import { dbDelete, dbGetAll, dbPut } from './db.js';
import { makeGoal } from './models.js';
import { calculateStreak, dateKey, todayKey, addDays } from './utils.js';

export async function getAllGoals() {
  return (await dbGetAll('goals')).sort((a, b) => a.createdAt - b.createdAt);
}

export async function addGoal(data) {
  const goal = makeGoal(data);
  await dbPut('goals', goal);
  return goal;
}

export async function updateGoal(goal) {
  await dbPut('goals', goal);
}

export async function deleteGoal(id) {
  await dbDelete('goals', id);
}

/**
 * Daily goals recur: completion is tracked per day (completedDays), so a goal
 * completed yesterday resets to pending today while its streak stays intact.
 * Non-daily goals keep the previous boolean behavior.
 */
export async function setGoalCompleted(goal, completed) {
  const today = todayKey();
  const days = new Set(goal.completedDays || []);
  if (completed) {
    days.add(today);
    goal.completedAt = Date.now();
  } else if (goal.type === 'daily') {
    days.delete(today); // only today's completion is undone
  } else {
    days.clear();
    goal.completedAt = null;
  }
  goal.completedDays = [...days];
  goal.status = completed ? 'completed' : 'not-started';
  goal.progress = completed ? 100 : 0;
  await updateGoal(goal);
}

/** True when the goal counts as completed on the given day. */
export function isCompletedOn(goal, key = todayKey()) {
  if (goal.type === 'daily') return (goal.completedDays || []).includes(key);
  return goal.status === 'completed';
}

/**
 * Does this goal belong to the given view bucket for the given day?
 * Daily goals always live in the Today bucket; weekly/monthly goals appear in
 * their own bucket; custom goals additionally surface in other buckets while
 * the day falls inside their date range.
 */
export function inBucketOn(goal, bucket, key = todayKey()) {
  if (goal.type === 'daily') return bucket === 'daily';
  if (goal.type === bucket) return true;
  return goal.type === 'custom' && Boolean(goal.startDate) && Boolean(goal.endDate) && goal.startDate <= key && key <= goal.endDate;
}

/** A goal belongs to one bucket based on its type. */
export function bucketOf(goal) {
  return goal.type === 'custom' ? 'custom' : goal.type;
}

export function goalsInBucket(goals, bucket) {
  return goals.filter((g) => bucketOf(g) === bucket);
}

export function isOverdue(goal, key = todayKey()) {
  if (isCompletedOn(goal, key)) return false;
  return Boolean(goal.endDate) && goal.endDate < key;
}

export function goalStatusLabel(goal) {
  if (goal.status === 'completed') return 'Completed';
  if (isOverdue(goal)) return 'Overdue';
  if (goal.status === 'in-progress') return 'In progress';
  return 'Not started';
}

/**
 * Bucket stats for the given day. Daily goals count as completed only if they
 * were completed that day, so yesterday's checkmarks don't inflate the count.
 */
export function goalStats(goals, key = todayKey()) {
  const total = goals.length;
  const completed = goals.filter((g) => isCompletedOn(g, key)).length;
  const pending = total - completed;
  return {
    total,
    completed,
    pending,
    pct: total ? Math.round((completed / total) * 100) : 0,
  };
}

/** Pending/completed filter honoring per-day completion for daily goals. */
export function filterGoals(goals, filter, key = todayKey()) {
  if (filter === 'completed') return goals.filter((g) => isCompletedOn(g, key));
  if (filter === 'pending') return goals.filter((g) => !isCompletedOn(g, key));
  return goals;
}

/**
 * Days (ending today/yesterday) that had at least one goal completed.
 * Uses the full per-day completion history, so recurring daily goals keep
 * their streak across resets, and legacy records still count.
 */
export function goalStreak(goals) {
  const days = new Set();
  for (const g of goals) {
    if (g.completedDays?.length) {
      for (const k of g.completedDays) days.add(k);
    } else if (g.completedAt) {
      days.add(dateKey(new Date(g.completedAt))); // legacy pre-history record
    }
  }
  return calculateStreak([...days]);
}

/**
 * Legacy goals (created before completedDays existed) migrate lazily so their
 * completion still counts once for the day it happened.
 */
export function withCompletionHistory(goal) {
  if (goal.completedDays?.length || !goal.completedAt) return goal;
  goal.completedDays = [dateKey(new Date(goal.completedAt))];
  return goal;
}

/**
 * Overall progress fraction for today's goals, honoring daily reset: a daily
 * goal completed yesterday is pending again today.
 */
export function todayProgressFraction(goals, key = todayKey()) {
  const todays = goals.filter((g) => inBucketOn(g, 'daily', key));
  if (!todays.length) return null;
  const done = todays.filter((g) => isCompletedOn(g, key)).length;
  return done / todays.length;
}