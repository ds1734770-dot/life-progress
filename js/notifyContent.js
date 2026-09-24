/**
 * Notification presentation model — ONE shared source of truth for the
 * category-aware reminder experience (master spec §2/§9/§10).
 *
 * Layering (extends, never replaces, the V1.6 architecture):
 *
 *   scheduler → occurrence → dispatchNotification(device, payload, deps)
 *     → Web Push / APNs / FCM            (minimal identity payload, unchanged)
 *     → device resolves LOCALLY:
 *         category → presentation model (this module) → wallpaper →
 *         local application data → rendered notification UI
 *
 * The server NEVER receives copy, wallpapers or personal data — payloads stay
 * the minimal identity shape built by server/push/domain.buildPushPayload().
 * This module is the presentation half the device consults. It is pure
 * (no I/O, no imports beyond js/utils) so every surface — service worker,
 * settings preview, iOS content extension copy table, Android activity and
 * the Node test suite — shares the exact same wording.
 *
 * Tone invariant (§10): supportive, never shame-based. "Keep going." —
 * never "You failed." Real data is injected by callers via `ctx`; when a
 * value is missing the copy degrades to the static fallback, never invented.
 */

import { daysBetween, dateKey } from './utils.js';

/** Categories with a dedicated presentation. Order drives the settings UI. */
export const NOTIFY_CATEGORIES = ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements', 'general'];

/**
 * Deep-link allowlist — the SAME vocabulary js/swPush.js#routeFor already
 * enforces (§20). No new route space is introduced.
 */
export const CATEGORY_ROUTES = {
  water: '#/water',
  gym: '#/gym',
  goals: '#/goals',
  journal: '#/journal',
  streaks: '#/dashboard',
  achievements: '#/achievements',
  general: '#/dashboard',
};

/**
 * Category accents (§8) — identify the notification category ONLY. They are
 * never applied globally to the app theme.
 */
export const CATEGORY_ACCENTS = {
  water: '#22b8e6',
  gym: '#f97316',
  goals: '#2fbf71',
  journal: '#e8c47a',
  streaks: '#a78bfa',
  achievements: '#c9a227',
  general: '#8fa3b8',
};

/** Category icon names (js/ui.js icon set) for preview + native badges. */
export const CATEGORY_ICONS = {
  water: 'droplet',
  gym: 'dumbbell',
  goals: 'target',
  journal: 'book',
  streaks: 'flame',
  achievements: 'star',
  general: 'bell',
};

/**
 * Rotating motivational quotes (§2/§7). Deterministically picked per
 * (category, dateKey) so previews and actual notifications agree on a given
 * day without any shared mutable state.
 */
const QUOTES = [
  'Small steps make big progress.',
  'Discipline today builds a stronger tomorrow.',
  'Show up for yourself.',
  'Keep going — future you is grateful.',
  'Progress, not perfection.',
  'One step at a time is still progress.',
  'You promised yourself. Keep the promise.',
];

/** Deterministic quote for a category on a given day. */
export function quoteFor(category, dayKey) {
  const key = String(dayKey || dateKey());
  let hash = 0;
  const s = `${category}:${key}`;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return QUOTES[hash % QUOTES.length];
}

/**
 * Format a water progress line from REAL data. Returns null when either
 * value is missing — callers fall back to static copy rather than invent
 * numbers (§11).
 */
export function waterProgressLine(totalMl, targetMl) {
  if (!Number.isFinite(totalMl) || !Number.isFinite(targetMl) || targetMl <= 0) return null;
  const liters = (ml) => `${Math.round(ml / 100) / 10} L`;
  return `${liters(totalMl)} of ${liters(targetMl)} today`;
}

/** Goals line — "3 of 4 goals completed". Null when no goals exist. */
export function goalsProgressLine(completed, total) {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return null;
  return `${completed} of ${total} goals completed`;
}

/**
 * The presentation model (§9). `ctx` is the reminder context from
 * js/notifications.js#buildReminderContext() (or a partial test fixture).
 * Every field is derived; nothing is fabricated. Unknown category → null.
 */
export function presentationFor(category, ctx = {}, { dayKey = dateKey() } = {}) {
  const quote = quoteFor(category, dayKey);
  const base = { category, quote, route: CATEGORY_ROUTES[category] || CATEGORY_ROUTES.general, accent: CATEGORY_ACCENTS[category] || CATEGORY_ACCENTS.general };

  switch (category) {
    case 'water': {
      const remaining = Number.isFinite(ctx.waterRemaining) ? ctx.waterRemaining : null;
      const progress = waterProgressLine(ctx.waterTotal, ctx.waterTarget);
      return {
        ...base,
        type: 'water',
        brand: 'Life Progress',
        kicker: 'REMINDER',
        title: 'Drink Water',
        subtitle: 'Stay hydrated, stay consistent.',
        message: progress || 'A glass of water now keeps your day on track.',
        progress: progress ? { primary: progress } : null,
        primaryAction: 'Log Water Now',
        secondaryAction: 'Remind Me Later',
        ...(remaining != null && remaining <= 0 ? { message: 'Target reached — nicely done.' } : {}),
      };
    }
    case 'gym': {
      const name = typeof ctx.workoutName === 'string' && ctx.workoutName.trim() ? ctx.workoutName.trim() : null;
      const days = ctx.lastWorkoutDate && ctx.today ? Math.max(0, daysBetween(ctx.lastWorkoutDate, ctx.today)) : null;
      return {
        ...base,
        type: 'gym',
        brand: 'Life Progress',
        kicker: 'REMINDER',
        title: 'Time to Train',
        subtitle: 'Your workout is waiting.',
        message: name ? `Today's Workout\n${name}` : 'A short session keeps the rhythm going.',
        progress: name ? { label: "Today's Workout", primary: name } : null,
        primaryAction: 'Start Workout',
        secondaryAction: 'Remind Me Later',
        ...(days != null && days >= 1 ? { message: `${days} day${days === 1 ? '' : 's'} since your last session. ${name ? `Today's Workout\n${name}` : 'Your plan is waiting.'}` } : {}),
      };
    }
    case 'goals': {
      const stats = ctx.goalStats || {};
      const total = Number.isFinite(stats.total) ? stats.total : null;
      const completed = Number.isFinite(stats.completed) ? stats.completed : null;
      const pending = Number.isFinite(stats.pending) ? stats.pending : null;
      const line = total != null && completed != null ? goalsProgressLine(completed, total) : null;
      const oneLeft = pending === 1;
      return {
        ...base,
        type: 'goals',
        brand: 'Life Progress',
        kicker: 'REMINDER',
        title: oneLeft ? 'One Goal Left' : 'Goals Are Waiting',
        subtitle: oneLeft ? "You're almost there. Finish it today." : 'A few minutes now moves them forward.',
        message: line || 'Open Life Progress to see what is next.',
        progress: line ? { primary: line } : null,
        primaryAction: 'Open Goals',
        secondaryAction: 'Remind Me Later',
      };
    }
    case 'journal':
      return {
        ...base,
        type: 'journal',
        brand: 'Life Progress',
        kicker: 'REMINDER',
        title: 'Take a Moment',
        subtitle: 'How was your day?',
        message: 'Write something for yourself.',
        progress: null,
        primaryAction: 'Open Journal',
        secondaryAction: 'Remind Me Later',
      };
    case 'streaks': {
      const count = Number.isFinite(ctx.streakCount) ? ctx.streakCount : null;
      const label = typeof ctx.streakLabel === 'string' && ctx.streakLabel ? ctx.streakLabel : 'streak';
      return {
        ...base,
        type: 'streaks',
        brand: 'Life Progress',
        kicker: 'REMINDER',
        title: 'Keep the Streak Alive',
        subtitle: count != null ? `${count} day${count === 1 ? '' : 's'} and counting.` : 'Keep the momentum going.',
        message: `One quick ${label} today keeps it going.`,
        progress: count != null ? { primary: `${count}-day ${label} streak` } : null,
        primaryAction: 'View Progress',
        secondaryAction: 'Remind Me Later',
      };
    }
    case 'achievements':
      return {
        ...base,
        type: 'achievements',
        brand: 'Life Progress',
        kicker: 'UNLOCKED',
        title: 'Achievement Unlocked',
        subtitle: typeof ctx.achievementTitle === 'string' && ctx.achievementTitle ? ctx.achievementTitle : 'New progress to celebrate.',
        message: 'Take a look at what you earned.',
        progress: null,
        primaryAction: 'View Achievements',
        secondaryAction: 'Remind Me Later',
      };
    case 'general':
      return {
        ...base,
        type: 'general',
        brand: 'Life Progress',
        kicker: 'REMINDER',
        title: 'A Moment for You',
        subtitle: 'Keep moving forward.',
        message: 'A quick check-in keeps your progress honest.',
        progress: null,
        primaryAction: 'Open Life Progress',
        secondaryAction: 'Remind Me Later',
      };
    default:
      return null;
  }
}

/**
 * Compact the presentation model into the static { title, body } fallback the
 * existing transports already show (§24 fallback level 3/4). The body joins
 * subtitle + message so no information silently disappears on platforms
 * without custom UI.
 */
export function toStaticCopy(p) {
  if (!p) return null;
  const body = p.message ? `${p.subtitle} ${p.message}` : p.subtitle;
  return { title: p.title, body, route: p.route, tag: p.category };
}

/** Map a wire category (PUSH_CATEGORIES) to a presentation category. */
export function presentationCategory(wireCategory) {
  return NOTIFY_CATEGORIES.includes(wireCategory) ? wireCategory : 'general';
}
