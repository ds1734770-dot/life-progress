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
 *
 * V2.2 — OCCURRENCE OWNERSHIP + TIMING. The local sweep now runs on the
 * server's canonical occurrence model (server/push/domain.js):
 *   - ONE canonical occurrence identity across the page, the server and the
 *     service worker: `deviceKey:category:dateKey`.
 *   - The local sweep is TIME-GATED by the user's configured `times[category]`
 *     wall-clock time. It MUST NOT claim a reminder before its scheduled
 *     occurrence, and MUST NOT write a dedup marker or an ACK for a not-yet
 *     due occurrence.
 *   - The local sweep agrees with the server on `isDue` and `isEligible`.
 *   - ACK semantics: the local page only records that an occurrence is
 *     handled/presented; it never suppresses a server push for an occurrence
 *     that is not yet due or not yet shown.
 */


import { dateKey, daysBetween } from './utils.js';
import { isValidTime, inQuietHours, deviceTimezone } from './timeCore.js';
// V2.1 — notification appearance (wallpaper system): preferences live in the
// SAME notificationState store as a sibling record (id 'appearance'); the
// pure shape guards live in js/notifyWallpapers.js so screens never touch
// IndexedDB and the selection logic stays unit-testable in Node.
import { normalizeNotificationAppearance, pickNotificationWallpaper, defaultNotificationAppearance } from './notifyWallpapers.js';

const APPEARANCE_ID = 'appearance';
const CUSTOM_WALLPAPER_ID = 'wallpaper-custom';

/**
 * Canonical local occurrence dedup key: `<dedup key>:<period>`.
 * For timed reminders the caller passes key = `${category}:daily` and
 * period = the occurrence's dateKey — the date the wall-clock reminder time
 * belongs to in the user's IANA timezone (zonedParts). Different dates →
 * different dedup records, so a 14:00 reminder on 2026-09-24 is never
 * confused with the same category on 2026-09-25, and a 14:00 reminder is
 * never claimed at 09:00 (before its 14:00 occurrence).
 */
const dedupId = (key, period) => `${key}:${period}`;

// V2.2 — the canonical occurrence identity lives in js/timeCore.js and is
// shared verbatim with the server (server/push/domain.js re-exports it):
// `occurrenceId(deviceKey, category, dateKey)` = deviceKey:category:dateKey.


// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const STORE = 'notificationState';

// ---------------------------------------------------------------------------
// IndexedDB store (notificationState).
// Life Progress stores notification preferences + per-reminder dedup state in
// a single IndexedDB store (notificationState). The browser shim is loaded
// via the platform init; in the Node unit tests the store is swapped out for
// a deterministic in-memory mock through the injectable hook below.
// ---------------------------------------------------------------------------

// V2.2 — test-only injectable store hook (Node unit tests only).
// The sweep, dedup and prefs read/write live in the notificationState
// store; in the browser this is a real IndexedDB shim. Tests override it
// with a deterministic in-memory implementation so the time-gated sweep is
// fully controllable without touching a real DB.
//
// The storage surface is a plain object held in a module-level binding that
// the test harness rewrites (the harness replaces the `getStore` value by
// pointing `store` at a fresh mock).
/**
 * Storage binding for the notificationState store. DEFAULT (null) = the real
 * IndexedDB shim in js/db.js — the browser AND the Capacitor native shell
 * both go through it. Tests override the binding with a deterministic
 * in-memory implementation via setStoreState (and restore the real store
 * with setStoreState(null)); nothing else may special-case this.
 */
let _storeState = null;

export const getStore = () => _storeState ?? DB_STORE;

export function setStoreState(state) {
  _storeState = state;
}

import { dbGet, dbPut, dbGetAll, dbDelete, dbClear } from './db.js';
const DB_STORE = { dbGet, dbPut, dbGetAll, dbDelete, dbClear };

export function resetStore() {
  _storeState = null;
}
// The sweep, dedup and prefs read/write live in the notificationState
// store; in the browser this is a real IndexedDB shim. Tests override it
// via setStoreState with a deterministic in-memory implementation so the
// time-gated sweep is fully controllable without touching a real DB.

// V2.2 — full notification category list (identical to the original V1.5
// exports). The localized timed categories that the sweep gates on are
// `CONTENT_CATEGORIES` (server/push/domain.js + server/api.js).
export const CATEGORIES = ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements'];
const PREFS_ID = 'prefs';

/** Defaults. Times are LOCAL clock strings ("HH:MM") — the user's intended
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
  const s = getStore();
  return normalizePrefs(await s.dbGet(STORE, PREFS_ID));
}

export async function saveNotificationPrefs(patch) {
  const s = getStore();
  const current = await getNotificationPrefs();
  const next = normalizePrefs({ ...current, ...patch, updatedAt: Date.now() });
  await s.dbPut(STORE, next);
  return next;
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

/** Request permission ONLY from an explicit user action. */
export async function requestPermission() {
  if (permissionState() !== 'default') return permissionState();
  try {
    return (await Notification.requestPermission()) || 'default';
  } catch {
    return 'denied';
  }
}

// ---------------------------------------------------------------------------
// Deduplication (persistent, reload/SW-restart safe)
// ---------------------------------------------------------------------------

/** True if this logical reminder was already delivered for the period. */
export async function wasDelivered(key, period) {
  const s = getStore();
  return Boolean(await s.dbGet(STORE, dedupId(key, period)));
}

export async function markDelivered(key, period, meta = {}) {
  const s = getStore();
  await s.dbPut(STORE, {
    id: dedupId(key, period),
    type: key,
    period,
    deliveredAt: Date.now(),
    ...meta,
  });
}

/** Delete a dedup record (test/maintenance helper — delivery markers are
 * otherwise pruned by age in pruneDeliveryState). */
export async function clearDelivered(key, period) {
  const s = getStore();
  await s.dbDelete(STORE, dedupId(key, period));
}

// ---------------------------------------------------------------------------
// Server ACK — the local→server half of occurrence ownership (V2.2)
// ---------------------------------------------------------------------------

/** Opaque device key + API base from the persisted push registration
 * (works in the page AND in the service worker — both read IndexedDB). */
async function currentAckContext() {
  try {
    const { currentPushState } = await import('./pushClient.js');
    const state = await currentPushState();
    if (state?.deviceKey) return { deviceKey: state.deviceKey, apiBase: String(state.apiBase || '') };
  } catch { /* no registration — nothing to ACK against */ }
  return null;
}

/**
 * Tell the server that a REAL occurrence (due, presented, dedup-marked) was
 * handled on this device. Fire-and-forget by design: failure only means the
 * server may send a duplicate push, which the client-side dedup still
 * suppresses. Never called for an occurrence that was not shown.
 * Works from the page and from the service worker (the API base is read
 * from the persisted registration — the SW has no window/push-config).
 * Returns false in non-browser environments (Node tests, server imports).
 */
export async function ackPushOccurrence(occurrenceId) {
  if (typeof fetch !== 'function') return false;
  if (!occurrenceId) return false;
  try {
    const ctx = await currentAckContext();
    if (!ctx?.deviceKey) return false;
    // occurrenceId is the canonical `deviceKey:category:dateKey` identity
    // (js/timeCore.js); the deviceKey part must match this device.
    const parts = String(occurrenceId).split(':');
    if (parts.length !== 3) return false;
    const [occDevice, category, occDateKey] = parts;
    if (occDevice !== ctx.deviceKey) return false;
    const res = await fetch(`${ctx.apiBase}/api/push/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceKey: ctx.deviceKey, category, dateKey: occDateKey, source: 'local' }),
    });
    return res.ok;
  } catch {
    return false; // offline / CORS / server down — the dedup marker already protects the user
  }
}

/** Delivered-status for a reminder, evaluating prefs gates at a given moment. */
export function reminderBlocked(prefs, { category, now = new Date() }) {
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

/** Build a NotificationOptions payload. */
export function buildPayload({ title, body, route, tag, actions = [], icon = null }) {
  return {
    title,
    body,
    options: {
      tag,
      icon: icon || './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { route, app: 'life-progress' },
      ...(actions.length ? { actions } : {}),
    },
  };
}

/** Show a notification through the page Notification API. */
export async function showNotification(payload) {
  if (permissionState() !== 'granted') return false;
  try {
    new Notification(payload.title, payload.options);
    return true;
  } catch {
    return false;
  }
}

/** Send the Settings → test notification (real push path first). */
export async function sendTestNotification() {
  if (!notificationsSupported()) return { ok: false, reason: 'unsupported', via: null };
  if (permissionState() === 'denied') return { ok: false, reason: 'denied', via: null };
  if (permissionState() === 'default') {
    const result = await requestPermission();
    if (result !== 'granted') return { ok: false, reason: result, via: null };
  }

  try {
    const { sendTestPush, currentPushState } = await import('./pushClient.js');
    const pushState = await currentPushState();
    if (pushState.status === 'active') {
      const pushResult = await sendTestPush();
      if (pushResult.ok) return { ok: true, via: 'push', reason: null };
      return {
        ok: false,
        via: 'push',
        reason: pushResult.reason === 'not-registered' ? 'not-registered' : `push-failed: ${pushResult.reason}`,
      };
    }
  } catch { /* fall through to the local path */ }

  const payload = buildPayload({
    title: 'Life Progress',
    body: 'Notifications are working 🔔 Your reminders are ready to help you stay consistent.',
    route: '#/dashboard',
    tag: 'test',
  });
  const shown = await showNotification(payload);
  return { ok: shown, via: shown ? 'local' : null, reason: shown ? null : 'failed' };
}

// ---------------------------------------------------------------------------
// Eligibility engine — derived from authoritative activity data
// ---------------------------------------------------------------------------

/** Derive today's reminder context from the activity domains. */
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

/** Category eligibility — pure functions over the reminder context. */
export const ELIGIBILITY = {
  water(ctx) {
    if (!ctx.waterTarget || ctx.waterTarget <= 0) return null;
    if (ctx.waterRemaining <= 0) return null;
    return {
      title: 'Time for some water 💧',
      body: `${ctx.waterRemaining} ml left to reach today's goal.`,
      route: DEEP_LINKS.water,
      tag: 'water',
    };
  },

  gym(ctx) {
    if (ctx.hasWorkoutToday) return null;
    const last = [...ctx.workouts].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!last) return null;
    const days = Math.max(0, daysBetween(last.date, ctx.today));
    if (days < 3) return null;
    return {
      title: days >= 7 ? 'Ready to move again?' : 'Ready for a workout?',
      body: days >= 7 ? `It's been a week since your last session — your plan is waiting.` : `It's been ${days} days — a short session keeps the rhythm.`,
      route: DEEP_LINKS.gym,
      tag: 'gym',
    };
  },

  goals(ctx) {
    const pending = ctx.goalStats.pending;
    if (!ctx.goalStats.total || pending <= 0) return null;
    return {
      title: 'Your goals are waiting',
      body: pending === 1 ? 'You have 1 goal left for today.' : `You have ${pending} goals left for today.`,
      route: DEEP_LINKS.goals,
      tag: 'goals',
    };
  },

  journal(ctx) {
    if (ctx.journalToday) return null;
    return {
      title: 'Take a minute for yourself',
      body: 'A short journal entry keeps your reflection streak going.',
      route: DEEP_LINKS.journal,
      tag: 'journal',
    };
  },

  streaks(ctx) {
    const atRisk = [
      ['water', ctx.streaks.water, ctx.waterRemaining > 0],
      ['gym', ctx.streaks.gym, !ctx.hasWorkoutToday],
      ['goals', ctx.streaks.goals, ctx.goalStats.pending > 0],
      ['journal', ctx.streaks.journal, !ctx.journalToday],
    ].filter(([, count, todayPending]) => count > 0 && todayPending);
    if (!atRisk.length) return null;
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
 *
 * NOTE: this function does NOT gate on the user's configured `times[category]`.
 * That gating lives in `runReminderSweep()`, the only caller that should
 * present a timed reminder. `evaluateReminder()` stays exported for direct
 * unit tests of the eligibility engine (context reads, quiet hours, dedup).
 */
export async function evaluateReminder(category, { now = new Date(), ctx = null, period = null } = {}) {
  const prefs = await getNotificationPrefs();
  // `period` lets the time-gated sweep pin the occurrence's OWN dateKey (the
  // sweep instant can sit a few minutes past midnight of a 23:59 reminder);
  // every other caller derives the local date of `now` as before.
  const per = period || dateKey(now);
  const key = `${category}:daily`;
  const blocked = reminderBlocked(prefs, { category, key, period: per, now });
  if (blocked) return { deliver: false, reason: blocked };
  if (await wasDelivered(key, per)) return { deliver: false, reason: 'already-delivered' };
  try {
    const context = ctx || (await buildReminderContext());
    const payload = ELIGIBILITY[category] ? ELIGIBILITY[category](context) : null;
    return payload ? { deliver: true, payload, key, period } : { deliver: false, reason: 'not-useful-now' };
  } catch (err) {
    return { deliver: false, reason: `context-error: ${err?.message || err}` };
  }
}

/**
 * Local sweep entry point — fully time-gated on the canonical occurrence
 * model (js/timeCore.js: computeNextOccurrences/isDue/isEligible, the same
 * code the server scheduler runs). This is the ONLY path the app boot /
 * foreground / visibility path calls.
 *
 * Required invariant (the Wave-1 bug this fixes):
 *   - occurrence not yet due (water configured 14:00, app opened 09:00)
 *       → NOT claimed, no dedup marker, NO ACK — the server keeps the push
 *   - occurrence due (at/after the configured time, inside the grace window)
 *       → presented once, dedup marker written, occurrence ACKed to the server
 *   - occurrence already handled → never presented again (dedup gate)
 *   - occurrence past the grace window → MISSED (documented policy): no
 *       presentation, no marker, no ACK — never silently re-created at the
 *       sweep instant; tomorrow's occurrence is a fresh one
 *
 * The occurrence model functions are injectable for tests; the defaults are
 * the canonical (server-identical) model from js/timeCore.js.
 */
export async function runReminderSweep({
  now = new Date(),
  ctx = null,
  computeNextOccurrences: computeOpt = null,
  isDue: isDueOpt = null,
  isEligible: isEligibleOpt = null,
  ackOccurrence: ackOpt = null,
  show: showOpt = null,
} = {}) {
  const prefs = await getNotificationPrefs();
  if (!prefs.enabled) return { delivered: [], skipped: ['master-off'] };
  const results = { delivered: [], skipped: [] };

  // The occurrence identity must MATCH the server's canonical identity
  // (`<realDeviceKey>:category:dateKey`), so a locally-handled occurrence
  // ACKs exactly the occurrence the scheduler would claim. Without a push
  // registration there is nothing to ACK — the opaque 'local-page' key keeps
  // the local dedup working and the ACK resolves to a no-op.
  const ackCtx = await currentAckContext();
  const deviceKey = ackCtx?.deviceKey || 'local-page';

  // Defaults = the canonical occurrence model (identical to the server's:
  // server/push/domain.js re-exports these verbatim from js/timeCore.js).
  const {
    computeNextOccurrences: defaultComputeNextOccurrences,
    isDue: defaultIsDue,
    isEligible: defaultIsEligible,
  } = await import('../js/timeCore.js');
  const compute = computeOpt ?? defaultComputeNextOccurrences;
  const due = isDueOpt ?? defaultIsDue;
  const eligible = isEligibleOpt ?? defaultIsEligible;
  const ack = ackOpt ?? ackPushOccurrence;
  const display = showOpt ?? showNotification;

  const occurrences = compute(
    {
      deviceKey,
      timezone: deviceTimezone() || 'UTC',
      enabled: true,
      categories: { ...prefs.categories },
      times: prefs.times,
      quietStart: prefs.quietStart,
      quietEnd: prefs.quietEnd,
      ledger: {},
    },
    now.getTime()
  );

  // One occurrence per category by construction (daily schedule) — index by
  // category so the sweep evaluates exactly the canonical occurrence.
  const byCategory = new Map(occurrences.map((occ) => [occ.category, occ]));

  for (const category of ['water', 'gym', 'goals', 'journal', 'streaks']) {
    const occ = byCategory.get(category);
    if (!occ) {
      // No occurrence for this category at this instant (disabled, invalid
      // time, or the ledger already sits past it) → nothing to present.
      results.skipped.push(`${category}:no-occurrence-now`);
      continue;
    }

    // 1) Time-gate: the scheduled occurrence is not due at the sweep moment.
    //    This is the Wave-1 bug: the old sweep claimed today's occurrence at
    //    09:00 even when the configured time was 14:00.
    if (!due(occ, now.getTime())) {
      results.skipped.push(`${category}:before-${occ.time}`);
      continue;
    }

    // 2) Due but past the handling window → missed (documented policy):
    //    no presentation, no marker, no ACK — the reminder is never silently
    //    re-created at the sweep instant.
    if (!eligible(occ, now.getTime())) {
      results.skipped.push(`${category}:missed`);
      continue;
    }

    // 3) Due + eligible: the normal gate order still applies (quiet hours,
    //    dedup, usefulness). evaluateReminder pins the occurrence's OWN
    //    dateKey so the dedup marker is the canonical one even when the
    //    sweep instant sits past local midnight.
    const decision = await evaluateReminder(category, { now, ctx, period: occ.dateKey });
    if (!decision.deliver) {
      results.skipped.push(`${category}:${decision.reason}`);
      continue;
    }

    const shown = await display(decision.payload);
    if (!shown) {
      results.skipped.push(`${category}:show-failed`);
      continue;
    }
    // Marker written only AFTER a real show (V1.5 invariant); the record is
    // the canonical `<category>:daily:<dateKey>` dedup identity.
    await markDelivered(decision.key, decision.period, { route: decision.payload.data?.route, dateKey: occ.dateKey });
    results.delivered.push(category);
    // Tell the server this occurrence was handled locally so its push for
    // the same occurrence is suppressed. The gates above guarantee the
    // occurrence was DUE and shown before any ACK fires — an ACK never
    // means "the app opened" or "the scheduler ran".
    const acked = await ack(occ.occurrenceId);
    if (!acked) results.skipped.push(`${category}:ack-failed`);
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
  const blocked = reminderBlocked(prefs, { category: 'achievements', key: 'achievements:x', period: dateKey(), now: new Date() });
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

// V2.2 — timeCore re-exports: the sweep and the server share ONE zone/time
// definition, and the server's computeNextOccurrences already lives in
// server/push/domain.js. The page re-exports the handful of helpers the
// sweep's time-gating and date-boundary logic needs.
export { zonedParts, zonedTimeToEpoch, nextDailyOccurrence, timeToMinutes, inQuietHours, formatTime12h, isValidTime } from './timeCore.js';

// V2.2 — the local sweep drives its time-gating + date-boundary math from
// the server's canonical occurrence model, so the page and the server agree
// on `computeNextOccurrences`, `isDue`, and `isEligible` (same semantics as
// server/push/domain.js, same IANA-zone wall-clock math via timeCore.js).
export { computeNextOccurrences, isDue, isEligible } from './timeCore.js';

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/** Remove dedup records older than 30 days. */
export async function pruneDeliveryState(olderThanDays = 30) {
  const s = getStore();
  const all = await s.dbGetAll(STORE);
  const cutoff = Date.now() - olderThanDays * 86400000;
  const stale = all.filter((r) => r.id !== PREFS_ID && (r.deliveredAt || 0) < cutoff);
  for (const r of stale) await s.dbDelete(STORE, r.id);
  return stale.length;
}

/** Full-wipe support: remove ALL notification state. */
export async function clearNotificationState() {
  const s = getStore();
  await s.dbClear(STORE);
}
