/**
 * Entities — factories that guarantee every record has a complete,
 * valid shape before it reaches the storage layer.
 */
import { uid, dateKey, clamp } from './utils.js';

export const GOAL_TYPES = ['daily', 'weekly', 'monthly', 'custom'];
export const GOAL_CATEGORIES = ['Fitness', 'Coding', 'Study', 'Personal', 'Health', 'Productivity', 'Custom'];
export const GOAL_PRIORITIES = ['low', 'medium', 'high'];
export const GOAL_STATUSES = ['not-started', 'in-progress', 'completed'];
export const WORKOUT_TYPES = ['Strength', 'Cardio', 'HIIT', 'Yoga', 'Mobility', 'Sports', 'Other'];

/** Display unit for workout weights. Only kg exists today; lb support can be added later without touching the UI. */
export function gymWeightUnit(_settings) {
  return 'kg';
}
export const MOODS = ['😊', '🙂', '😐', '😔', '😤', '🥳', '😴'];

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

export function makeWaterEntry(amount, timestamp = Date.now()) {
  return {
    id: uid(),
    amount: Math.max(0, Math.round(Number(amount) || 0)),
    timestamp,
    date: dateKey(new Date(timestamp)),
  };
}

export function isValidWaterAmount(amount) {
  return Number.isFinite(amount) && amount > 0;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export function makeGoal(data = {}) {
  const today = dateKey();
  return {
    id: data.id || uid(),
    title: String(data.title || '').trim(),
    description: String(data.description || '').trim(),
    category: GOAL_CATEGORIES.includes(data.category) ? data.category : 'Personal',
    type: GOAL_TYPES.includes(data.type) ? data.type : 'custom',
    startDate: data.startDate || today,
    endDate: data.endDate || today,
    priority: GOAL_PRIORITIES.includes(data.priority) ? data.priority : 'medium',
    status: GOAL_STATUSES.includes(data.status) ? data.status : 'not-started',
    progress: clamp(Number(data.progress) || 0, 0, 100),
    completedAt: data.completedAt || null,
    // Date keys (YYYY-MM-DD) of every completion — recurring goals need the
    // full history so their streak survives the status resetting each period.
    completedDays: Array.isArray(data.completedDays)
      ? [...new Set(data.completedDays.filter((k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k)))]
      : [],
    createdAt: data.createdAt || Date.now(),
  };
}

export function validateGoal(data) {
  if (!String(data.title || '').trim()) return 'Please give your goal a title.';
  if (data.type !== 'custom' && data.startDate && data.endDate && data.endDate < data.startDate) {
    return 'End date cannot be before the start date.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workouts + exercises
// ---------------------------------------------------------------------------

export function makeExercise(data = {}) {
  return {
    id: uid(),
    exerciseName: String(data.exerciseName || '').trim() || 'Exercise',
    sets: Math.max(0, Math.round(Number(data.sets) || 0)),
    reps: Math.max(0, Math.round(Number(data.reps) || 0)),
    weight: Math.max(0, Math.round(Number(data.weight) || 0)),
  };
}

export function makeWorkout(data = {}) {
  return {
    id: data.id || uid(),
    date: data.date || dateKey(),
    workoutType: WORKOUT_TYPES.includes(data.workoutType) ? data.workoutType : 'Strength',
    duration: Math.max(0, Math.round(Number(data.duration) || 0)),
    notes: String(data.notes || '').trim(),
    exercises: Array.isArray(data.exercises) ? data.exercises.map(makeExercise) : [],
    createdAt: data.createdAt || Date.now(),
  };
}

export function validateWorkout(data) {
  if (!data.exercises || !data.exercises.length) {
    return 'Add at least one exercise, or keep it simple and just log the session.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Progress photos
// ---------------------------------------------------------------------------

export function makeProgressPhoto(data = {}) {
  return {
    id: data.id || uid(),
    blob: data.blob || null,
    thumb: data.thumb || null,
    date: data.date || dateKey(),
    label: String(data.label || '').trim(),
    notes: String(data.notes || '').trim(),
    createdAt: data.createdAt || Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export function makeJournalEntry(data = {}) {
  const now = Date.now();
  return {
    id: data.id || uid(),
    title: String(data.title || '').trim(),
    content: String(data.content || '').trim(),
    date: data.date || dateKey(),
    mood: data.mood || null,
    tags: Array.isArray(data.tags)
      ? [...new Set(data.tags.map((t) => String(t).trim()).filter(Boolean))]
      : [],
    createdAt: data.createdAt || now,
    updatedAt: now,
  };
}

export function validateJournalEntry(data) {
  if (!String(data.title || '').trim() && !String(data.content || '').trim()) {
    return 'Write something — a title or a few words.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function defaultSettings() {
  return {
    id: 'settings',
    onboarded: false,
    name: '',
    theme: 'dark', // 'light' | 'dark' | 'system'
    backgroundImage: null, // { dataUrl, name }
    waterTarget: 3000, // ml per day
    waterUnit: 'ml', // 'ml' | 'L'
    goalsDefaultView: 'today',
    gymDefaultType: 'Strength',
    journalPrompt: 'How was your day?',
    // --- V1.1 personalization ---
    launchQuote: "Don't forget why u started.", // motivational launch quote
    avatar: { type: 'builtin', value: 'sunrise' }, // { type: 'builtin'|'initials'|'custom', value }
    avatarImage: null, // Blob — local, never uploaded (custom avatar only)
    createdAt: Date.now(),
  };
}

export function themeOptions() {
  return [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
}