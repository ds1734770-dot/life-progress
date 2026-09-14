/**
 * V1.5 — Notifications: local-first reminder foundation.
 *
 * A context-aware consistency layer over the EXISTING activity domains.
 * The engine never duplicates user data: eligibility is derived on demand
 * from water/goals/journal/gym/history records, and only preferences +
 * per-reminder dedup state live in their own store (notificationState).
 *
 * Layers:  settings UI → this domain → eligibility engine → Notification API
 *          (service worker handles display/click when the page is closed;
 *          the same payloads work without it while the app is open).
 *
 * Local-first: there is deliberately NO push server. Without a Push
 * subscription the browser can only show notifications while the app (or its
 * service worker) is alive, so reminders fire when the app is opened or
 * foregrounded — never fake background delivery. The payload/dedup shape is
 * push-ready: a future server can deliver the same { tag, body, data }
 * messages without touching this domain.
 *
 * Tone: a supportive coach, never an alarm. Every reminder must pass an
 * "is this actually useful right now?" gate before it is allowed to show.
 */

import { dbGet, dbPut, dbGetAll, dbDelete, dbClear } from './db.js';
import { dateKey, daysBetween } from './utils.js';

export const STORE = 'notificationState';
const PREFS_ID = 'prefs';

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const CATEGORIES = ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements'];

/**
 * Defaults. Times are LOCAL clock strings ("HH:MM") — the user's intended
 * wall-clock time, immune to timezone/UTC conversions. Quiet hours may cross
 * midnight (start > end).
 */
export function defaultNotificationPrefs() {
  return {
    id: PREFS_ID,
    enabled: false, // master OFF until the user opts in (no startup prompts)
    categories: {
      water: true,
      gym: true,
      goals: true,
      journal: true,
      streaks: true,
      achievements: true,
    },
    times: {
      water: '11:00',
      gym: '17:00',
      goals: '09:00',
      journal: '21:30',
    },
    quietStart: '22:30',
    quietEnd: '07:00',
    updatedAt: 0,
  };
}

/** Merge stored prefs with defaults — old/partial records keep working. */
export function normalizePrefs(stored) {
  const d = defaultNotificationPrefs();
  const s = stored && typeof stored === 'object' ? stored : {};
  const p = { ...d, ...s, id: PREFS_ID };
  p.categories = { ...d.categories, ...(s.categories || {}) };
  p.times = { ...d.times, ...(s.times || {}) };
  for (const c of CATEGORIES) p.categories[c] = p.categories[c] !== false;
  for (const c of Object.keys(d.times)) {
    if (!isValidTime(p.times[c])) p.times[c] = d.times[c];
  }
  if (!isValidTime(p.quietStart)) p.quietStart = d.quietStart;
  if (!isValidTime(p.quietEnd)) p.quietEnd = d.quietEnd;
  return p;
}

export async function getNotificationPrefs() {
  return normalizePrefs(await dbGet(STORE, PREFS_ID));
}

export async function saveNotificationPrefs(patch) {
  const current = await getNotificationPrefs();
  const next = normalizePrefs({ ...current, ...patch, updatedAt: Date.now() });
  await dbPut(STORE, next);
  return next;
}

/** "HH:MM" → minutes since midnight. Returns null when invalid. */
export function timeToMinutes(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isValidTime(t) {
  return timeToMinutes(t) !== null;
}

/** "14:30" → "2:30 PM" using the user's locale. */
export function formatTime12h(t) {
  const mins = timeToMinutes(t);
  if (mins === null) return String(t || '');
  const [h, m] = [Math.floor(mins / 60), mins % 60];
  try {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  }
}

// ---------------------------------------------------------------------------
// Permission + capability
// ---------------------------------------------------------------------------

/** 'unsupported' | 'default' | 'granted' | 'denied' */
export function permissionState() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission || 'default';
}

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

/**
 * Request permission ONLY from an explicit user action (enabling the master
 * toggle or sending the test notification). Returns 'granted' | 'denied' |
 * 'default' | 'unsupported'. Never asks again once denied — the browser
 * blocks repeat prompts anyway, and nagging is anti-product.
 */
export async function requestPermission() {
  if (permissionState() !== 'default') return permissionState();
  try {
    return (await Notification.requestPermission()) || 'default';
  } catch {
    return 'denied';
  }
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------

/**
 * True when `minutes` (or now) is inside [start, end). Crossing midnight is
 * supported: 22:30→07:00 covers 23:00 and 03:00; 07:00→22:30 covers 12:00.
 * Zero-length ranges (start === end) mean "no quiet hours".
 */
export function inQuietHours(minutes = null, start = null, end = null) {
  const s = timeToMinutes(start ?? '22:30');
  const e = timeToMinutes(end ?? '07:00');
  if (s === null || e === null || s === e) return false;
  const m = minutes ?? new Date().getHours() * 60 + new Date().getMinutes();
  if (s < e) return m >= s && m < e;
  return m >= s || m < e; // crosses midnight
}

// ---------------------------------------------------------------------------
// Deduplication (persistent, reload/SW-restart safe)
// ---------------------------------------------------------------------------

const dedupId = (key, period) => `${key}:${period}`;

/**
 * True if this logical reminder was already delivered for the period. A
 * record exists ⇒ delivered. Nothing is version-faked: dedup records are
 * only written by markDelivered after a real show.
 */
export async function wasDelivered(key, period) {
  return Boolean(await dbGet(STORE, dedupId(key, period)));
}

export async function markDelivered(key, period, meta = {}) {
  await dbPut(STORE, {
    id: dedupId(key, period),
    type: key.split(':')[0],
    period,
    deliveredAt: Date.now(),
    ...meta,
  });
}

/**
 * Delivered-status for a reminder, evaluating dedup + all preference gates
 * at once: master toggle, category, quiet hours. Pure-ish (data injected),
 * so unit tests can drive every branch without a browser.
 */
export function reminderBlocked(prefs, { category, key, period, now = new Date() }) {
  if (!prefs.enabled) return 'master-off';
  if (category && !prefs.categories[category]) return 'category-off';
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (inQuietHours(minutes, prefs.quietStart, prefs.quietEnd)) return 'quiet-hours';
  return null; // not blocked — dedup + activity checks happen at delivery
}

// ---------------------------------------------------------------------------
// Deep links (SW click handler uses the same routes)
// ---------------------------------------------------------------------------

export const DEEP_LINKS = {
  water: '#/water',
  gym: '#/gym',
  goals: '#/goals',
  journal: '#/journal',
  achievements: '#/achievements',
};

/**
 * Build a NotificationOptions payload. `data.route` is the deep link; `tag`
 * coalesces same-topic notifications; actions are used when supported.
 * Journal content is NEVER included — privacy by construction.
 */
export function buildPayload({ title, body, route, tag, actions = [] }) {
  return {
    title,
    body,
    options: {
      tag,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { route, app: 'life-progress' },
      ...(actions.length ? { actions } : {}),
    },
  };
}

/**
 * Show a notification through the page Notification API. Used by the engine
 * while the app is open (the common case for local reminders) and by the
 * test button. The SW path only takes over when the page is closed.
 */
export async function showNotification(payload) {
  if (permissionState() !== 'granted') return false;
  try {
    new Notification(payload.title, payload.options);
    return true;
  } catch {
    return false;
  }
}

/** Send the Settings → test notification (requests permission if needed). */
export async function sendTestNotification() {
  if (!notificationsSupported()) return { ok: false, reason: 'unsupported' };
  if (permissionState() === 'denied') return { ok: false, reason: 'denied' };
  if (permissionState() === 'default') {
    const result = await requestPermission();
    if (result !== 'granted') return { ok: false, reason: result };
  }
  const payload = buildPayload({
    title: 'Life Progress',
    body: 'Notifications are working 🔔 Your reminders are ready to help you stay consistent.',
    route: '#/dashboard',
    tag: 'test',
  });
  const shown = await showNotification(payload);
  return { ok: shown, reason: shown ? null : 'failed' };
}

// ---------------------------------------------------------------------------
// Eligibility engine — derived from authoritative activity data
// ---------------------------------------------------------------------------

/**
 * Derive today's reminder context from the activity domains. Every check
 * reads real records; nothing is cached or duplicated here.
 */
export async function buildReminderContext() {
  const [waterMod, goalsMod, journalMod, gymMod] = await Promise.all([
    import('./water.js'),
    import('./goals.js'),
    import('./journal.js'),
    import('./gym.js'),
  ]);
  const today = dateKey();
  const [waterEntries, goals, journalEntries, workouts] = await Promise.all([
    waterMod.getAllEntries(),
    goalsMod.getAllGoals(),
    journalMod.getAllEntries(),
    gymMod.getAllWorkouts(),
  ]);
  const waterTarget = waterMod.waterTarget();
  const waterTotal = waterMod.totalOn(waterEntries, today);
  const journalToday = journalEntries.some((e) => e.date === today);
  const goalStats = goalsMod.goalStats(goals, today);
  const streaks = {
    water: waterMod.waterStreak(waterEntries, today),
    goals: goalsMod.goalStreak(goals, today),
    journal: journalMod.journalStreak(journalEntries, today),
    gym: gymMod.workoutStreak(workouts, today),
  };
  const hasWorkoutToday = workouts.some((w) => w.date === today);
  return { today, waterTarget, waterTotal, waterRemaining: Math.max(0, waterTarget - waterTotal), journalToday, goalStats, streaks, hasWorkoutToday, workouts };
}

/**
 * Category eligibility — pure functions over the reminder context. Each
 * returns a payload, or null when a reminder would be noise.
 */
export const ELIGIBILITY = {
  water(ctx) {
    if (!ctx.waterTarget || ctx.waterTarget <= 0) return null; // no target → no reminder
    if (ctx.waterRemaining <= 0) return null; // target met → stay quiet
    return {
      title: 'Time for some water 💧',
      body: `${ctx.waterRemaining} ml left to reach today's goal.`,
      route: DEEP_LINKS.water,
      tag: 'water',
    };
  },

  gym(ctx) {
    if (ctx.hasWorkoutToday) return null; // trained today → no nudge
    const last = [...ctx.workouts].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!last) return null; // never trained — onboarding copy isn't a reminder's job
    const days = Math.max(0, daysBetween(last.date, ctx.today));
    if (days < 3) return null; // recent session — don't nag
    return {
      title: days >= 7 ? 'Ready to move again?' : 'Ready for a workout?',
      body: days >= 7 ? `It's been a week since your last session — your plan is waiting.` : `It's been ${days} days — a short session keeps the rhythm.`,
      route: DEEP_LINKS.gym,
      tag: 'gym',
    };
  },

  goals(ctx) {
    const pending = ctx.goalStats.pending;
    if (!ctx.goalStats.total || pending <= 0) return null; // nothing pending → quiet
    return {
      title: 'Your goals are waiting',
      body: pending === 1 ? 'You have 1 goal left for today.' : `You have ${pending} goals left for today.`,
      route: DEEP_LINKS.goals,
      tag: 'goals',
    };
  },

  journal(ctx) {
    if (ctx.journalToday) return null; // already checked in today
    return {
      title: 'Take a minute for yourself',
      body: 'A short journal entry keeps your reflection streak going.',
      route: DEEP_LINKS.journal,
      tag: 'journal',
    };
  },

  streaks(ctx) {
    // A streak "at risk" means it's alive but today's action hasn't happened
    // yet (calculateStreak counts up to yesterday when today is empty).
    const atRisk = [
      ['water', ctx.streaks.water, ctx.waterRemaining > 0],
      ['gym', ctx.streaks.gym, !ctx.hasWorkoutToday],
      ['goals', ctx.streaks.goals, ctx.goalStats.pending > 0],
      ['journal', ctx.streaks.journal, !ctx.journalToday],
    ].filter(([, count, todayPending]) => count > 0 && todayPending);
    if (!atRisk.length) return null; // nothing at risk → stay encouragingly quiet
    const [name, count] = atRisk.sort((a, b) => b[1] - a[1])[0];
    const label = { water: 'water', gym: 'workout', goals: 'goal', journal: 'journal' }[name] || name;
    return {
      title: `🔥 Your ${count}-day streak is alive`,
      body: `One quick ${label} today keeps it going.`,
      route: DEEP_LINKS[name] || '#/dashboard',
    tag: 'streaks',
    };
  },
};

/**
 * Evaluate one reminder for a category. Full gate order: master → category →
 * quiet hours → dedup → context-derived usefulness. Returns the payload when
 * a reminder should be delivered, null otherwise (with reason logging).
 */
export async function evaluateReminder(category, { now = new Date(), ctx = null } = {}) {
  const prefs = await getNotificationPrefs();
  const period = dateKey(now);
  const key = `${category}:daily`;
  const blocked = reminderBlocked(prefs, { category, key, period, now });
  if (blocked) return { deliver: false, reason: blocked };
  if (await wasDelivered(key, period)) return { deliver: false, reason: 'already-delivered' };
  try {
    const context = ctx || (await buildReminderContext());
    const payload = ELIGIBILITY[category] ? ELIGIBILITY[category](context) : null;
    return payload ? { deliver: true, payload, key, period } : { deliver: false, reason: 'not-useful-now' };
  } catch (err) {
    return { deliver: false, reason: `context-error: ${err?.message || err}` };
  }
}

/**
 * Run all due reminders once. Called on app foreground/boot and from a light
 * interval while the page is open. Each deliverable reminder is shown and
 * then immediately marked delivered — the write happens only after a real
 * show, so a crash can never leave a "delivered" marker for an unseen
 * notification. Returns a summary for tests/QA.
 */
export async function runReminderSweep({ now = new Date(), ctx = null } = {}) {
  const prefs = await getNotificationPrefs();
  if (!prefs.enabled) return { delivered: [], skipped: ['master-off'] };
  const results = { delivered: [], skipped: [] };
  for (const category of ['water', 'gym', 'goals', 'journal', 'streaks']) {
    const decision = await evaluateReminder(category, { now, ctx });
    if (decision.deliver) {
      const shown = await showNotification(decision.payload);
      if (shown) {
        await markDelivered(decision.key, decision.period, { route: decision.payload.data?.route });
        results.delivered.push(category);
      } else {
        results.skipped.push(`${category}:show-failed`);
      }
    } else {
      results.skipped.push(`${category}:${decision.reason}`);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Achievement notifications — an additional entry point, never a replacement
// ---------------------------------------------------------------------------

/**
 * Called from celebration.js after achievements.js has ALREADY decided a
 * badge is newly earned. The celebration stays authoritative and unchanged;
 * this only adds a system notification, deduped by achievement id (so a
 * badge can never be notified twice even across reloads/SW restarts).
 */
export async function notifyAchievement(achievement) {
  if (!achievement?.id || !achievement?.title) return false;
  const prefs = await getNotificationPrefs();
  const blocked = reminderBlocked(prefs, { category: 'achievements', key: 'achievements:x', period: dateKey() });
  if (blocked) return false;
  const key = `achievements:${achievement.id}`;
  const period = 'once'; // an achievement is earned exactly once, ever
  if (await wasDelivered(key, period)) return false;
  const payload = buildPayload({
    title: '🏆 Achievement unlocked',
    body: achievement.title,
    route: DEEP_LINKS.achievements,
    tag: `achievement-${achievement.id}`,
  });
  const shown = await showNotification(payload);
  if (shown) await markDelivered(key, period, { route: DEEP_LINKS.achievements });
  return shown;
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Remove dedup records older than 30 days (preferences are never touched). */
export async function pruneDeliveryState(olderThanDays = 30) {
  const cutoff = Date.now() - olderThanDays * 86400000;
  const all = await dbGetAll(STORE);
  const stale = all.filter((r) => r.id !== PREFS_ID && (r.deliveredAt || 0) < cutoff);
  for (const r of stale) await dbDelete(STORE, r.id);
  return stale.length;
}

/** Full-wipe support: remove ALL notification state (prefs + dedup records). */
export async function clearNotificationState() {
  await dbClear(STORE);
}
