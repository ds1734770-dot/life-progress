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

/**
 * V1.4 Gym templates — optional focus/category for a workout template.
 * Display-only metadata; exercises carry their own muscle grouping.
 */
export const TEMPLATE_FOCUSES = ['Custom', 'Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Full Body'];

/** Coarse muscle group per exercise (used for template focus + future trends). */
export const MUSCLE_GROUPS = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Core', 'Full Body', 'Other'];

/**
 * Weight stepper increments (kg) by magnitude. Practical gym plates are 2.5 kg
 * per side (5 kg total); dumbbells move in ~2.5 kg steps. Light weights use a
 * finer step so 40 → 42.5 stays one tap. Lb support can swap this table.
 */
export const WEIGHT_STEPS = [
  { above: 0, step: 2.5 },
  { above: 20, step: 2.5 },
  { above: 40, step: 2.5 },
  { above: 60, step: 5 },
  { above: 100, step: 5 },
];

export function weightStepFor(weight) {
  let step = WEIGHT_STEPS[0].step;
  for (const band of WEIGHT_STEPS) if (weight > band.above) step = band.step;
  return step;
}

/** Common rep targets for tap-to-set chips (always freely editable too). */
export const REP_CHIPS = [5, 6, 8, 10, 12, 15];

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
    // Nearest 0.5 — keeps every legacy integer value identical while allowing
    // real gym increments such as 42.5 kg / 62.5 kg (V1.4 set-based logging).
    weight: Math.max(0, Math.round((Number(data.weight) || 0) * 2) / 2),
    // V1.4 additive: per-set detail recorded by the session flow
    // [{ weight, reps }] in performed order. Legacy consumers ignore it.
    performedSets: validPerformedSets(data.performedSets),
  };
}

function validPerformedSets(value) {
  if (!Array.isArray(value)) return null;
  const rows = value
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({ weight: Math.max(0, Math.round((Number(s.weight) || 0) * 2) / 2), reps: Math.max(0, Math.round(Number(s.reps) || 0)) }));
  return rows.length ? rows : null;
}

export function makeWorkout(data = {}) {
  const workout = {
    id: data.id || uid(),
    date: data.date || dateKey(),
    workoutType: WORKOUT_TYPES.includes(data.workoutType) ? data.workoutType : 'Strength',
    duration: Math.max(0, Math.round(Number(data.duration) || 0)),
    notes: String(data.notes || '').trim(),
    exercises: Array.isArray(data.exercises) ? data.exercises.map(makeExercise) : [],
    createdAt: data.createdAt || Date.now(),
  };
  // V1.4 additive provenance (optional — legacy workouts never carry these).
  if (data.templateId) workout.templateId = String(data.templateId);
  if (data.templateName) workout.templateName = String(data.templateName).trim();
  return workout;
}

/**
 * V1.4 — exercise library entry. Remembers every exercise name the user has
 * ever used so repeat logging is selection, not typing. Identity is the
 * lowercased name (stable across renames of entries); `usedAt`/`useCount`
 * power "recent" ordering in pickers.
 */
export function makeLibraryExercise(data = {}) {
  const name = String(data.name || '').trim();
  return {
    id: data.id || uid(),
    name,
    key: name.toLowerCase(),
    muscleGroup: MUSCLE_GROUPS.includes(data.muscleGroup) ? data.muscleGroup : 'Other',
    usedAt: Number(data.usedAt) || Date.now(),
    useCount: Math.max(1, Math.round(Number(data.useCount) || 1)),
  };
}

/**
 * V1.4 — workout template: the reusable STRUCTURE of a recurring workout
 * ("Push Day"). Templates are plans, never history: completed sessions live
 * only in the workouts store. Exercises keep default set structure so the
 * next session can be pre-filled.
 */
export function makeTemplateExercise(data = {}) {
  return {
    id: data.id || uid(),
    exerciseName: String(data.exerciseName || '').trim() || 'Exercise',
    muscleGroup: MUSCLE_GROUPS.includes(data.muscleGroup) ? data.muscleGroup : null,
    defaultSets: Math.max(1, Math.round(Number(data.defaultSets ?? data.sets) || 3)),
    reps: Math.max(0, Math.round(Number(data.reps) || 0)),
    weight: Number(data.weight) >= 0 ? Number(data.weight) : 0,
  };
}

export function makeWorkoutTemplate(data = {}) {
  const exercises = Array.isArray(data.exercises) ? data.exercises.map(makeTemplateExercise) : [];
  return {
    id: data.id || uid(),
    name: String(data.name || '').trim(),
    focus: TEMPLATE_FOCUSES.includes(data.focus) ? data.focus : 'Custom',
    notes: String(data.notes || '').trim(),
    exercises,
    lastUsedAt: Number(data.lastUsedAt) || null, // null = never started
    createdAt: data.createdAt || Date.now(),
    updatedAt: data.updatedAt || Date.now(),
  };
}

export function validateWorkoutTemplate(data) {
  if (!String(data.name || '').trim()) return 'Give your workout a name.';
  if (!Array.isArray(data.exercises) || !data.exercises.length) return 'Add at least one exercise.';
  return null;
}

/**
 * V1.4 — ACTIVE workout session (the one in-progress workout). Exactly one
 * record (id 'active') is persisted so an unfinished session survives a
 * reload or app close; completing the workout deletes it and writes a real
 * historical workout. `sets` are per-set rows: { weight, reps, done }.
 */
export function makeSessionSet(data = {}) {
  return {
    weight: Number(data.weight) >= 0 ? Number(data.weight) : 0,
    reps: Math.max(0, Math.round(Number(data.reps) || 0)),
    done: Boolean(data.done),
  };
}

export function makeSessionExercise(data = {}) {
  return {
    id: data.id || uid(),
    exerciseName: String(data.exerciseName || '').trim() || 'Exercise',
    muscleGroup: MUSCLE_GROUPS.includes(data.muscleGroup) ? data.muscleGroup : null,
    sets: Array.isArray(data.sets) ? data.sets.map(makeSessionSet) : [],
  };
}

export function makeActiveWorkout(data = {}) {
  return {
    id: 'active', // singleton record
    templateId: data.templateId || null, // null = empty/freeform workout
    templateName: String(data.templateName || '').trim(),
    focus: TEMPLATE_FOCUSES.includes(data.focus) ? data.focus : null,
    workoutType: WORKOUT_TYPES.includes(data.workoutType) ? data.workoutType : 'Strength',
    startedAt: Number(data.startedAt) || Date.now(),
    exercises: Array.isArray(data.exercises) ? data.exercises.map(makeSessionExercise) : [],
    notes: String(data.notes || '').trim(),
  };
}

export function validateWorkout(data) {
  if (!data.exercises || !data.exercises.length) {
    return 'Add at least one exercise, or keep it simple and just log the session.';
  }
  return null;
}

/** V1.4 — a session is finishable when it has at least one exercise with at least one set. */
export function sessionCompletable(session) {
  return Boolean(session && session.exercises && session.exercises.some((ex) => ex.sets && ex.sets.length));
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
    // --- V1.3 smart progress camera ---
    photoTemplateId: null, // progress photo used as the alignment reference
    photoAutoCapture: true, // auto shutter once the position is stable
    referenceMode: 'ghost', // 'ghost' | 'outline' | 'off' — reference guide visibility
    createdAt: Date.now(),
  };
}

/**
 * V1.4 — optional rest-timer defaults, merged onto stored settings at load
 * (same zero-migration approach as the V1.1 personalization fields).
 */
export function gymDefaults() {
  return {
    restTimerSeconds: 90, // suggested rest after a completed set (0 = off)
    restAutoStart: true,
  };
}

export function themeOptions() {
  return [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
}