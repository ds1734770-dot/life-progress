/**
 * Pure reminder-scheduling domain — shared by BOTH backends (V1.6.4).
 *
 * Extracted verbatim from server/scheduler.js so the Cloudflare Worker can
 * reuse the exact V1.6.3 delivery policy without importing the Node
 * filesystem store. Contains NO I/O: every function is pure and takes its
 * clock as a parameter, which is what makes deterministic testing possible
 * on either runtime.
 *
 * Semantics preserved exactly (§10–§13 of the V1.6.3 spec):
 *  - one pending occurrence per enabled category, deterministic id
 *    `deviceKey:category:dateKey-in-user-tz`
 *  - 90 s grace window; older occurrences are `missed`, never replayed
 *  - quiet hours evaluated for the occurrence's wall-clock minute in the
 *    device timezone; suppressed occurrences are never replayed
 *  - minimal payload: category/occurrenceId/dateKey/route/serverTime only —
 *    no personal data; the service worker derives copy locally
 */
import { nextDailyOccurrence, timeToMinutes, inQuietHours, zonedTimeToEpoch, zonedParts } from '../../js/timeCore.js';

export const GRACE_MS = 90 * 1000; // deliver up to 90s late (tick jitter, clock drift)
export const CONTENT_CATEGORIES = ['water', 'gym', 'goals', 'journal'];

/** Route hint per category — same hash routes the in-app router uses. */
export const ROUTES = {
  water: '#/water',
  gym: '#/gym',
  goals: '#/goals',
  journal: '#/journal',
  streaks: '#/dashboard',
  achievements: '#/achievements',
  test: '#/dashboard',
};

/**
 * Compute the next pending occurrence for every timed, enabled category of a
 * subscription. Pure: derives everything from the record + the given clock.
 */
export function computeNextOccurrences(sub, nowMs = Date.now()) {
  const out = [];
  if (!sub || sub.enabled === false || sub.disabled) return out;
  const tz = sub.timezone;
  if (!tz) return out;
  for (const category of CONTENT_CATEGORIES) {
    if (sub.categories?.[category] === false) continue;
    const time = sub.times?.[category];
    const mins = timeToMinutes(time);
    if (mins === null) continue;
    // Resume from the ledger position if we have one, so a restart never
    // re-delivers the occurrence that was already handled.
    const lastHandled = sub.ledger?.[category] || null;
    const anchor = lastHandled ? Math.max(nowMs, lastHandled) : nowMs;

    // V1.6.4 FIX (grace-window reachability): the previous implementation
    // only ever surfaced STRICTLY FUTURE occurrences, so a tick landing a
    // few seconds after the wall-clock minute — which is every tick — skipped
    // the occurrence entirely and decideOccurrence's 90 s grace window was
    // unreachable: daily reminders silently never fired. Now TODAY'S
    // occurrence is always surfaced unless the ledger already records it as
    // handled (never re-deliver, §13); decideOccurrence then classifies it:
    // future → reschedule, within grace → deliver, past grace → missed.
    const hh = Math.floor(mins / 60);
    const mm = mins % 60;
    const todayAtTime = zonedTimeToEpoch(anchor, tz, hh, mm);
    const alreadyHandled = lastHandled && todayAtTime <= lastHandled;

    const next = alreadyHandled
      ? nextDailyOccurrence(tz, time, anchor) // Tomorrow, DST-safe (§10).
      : { epochMs: todayAtTime, dateKey: zonedParts(todayAtTime, tz).dateKey };
    if (!next) continue;
    out.push({
      category,
      time,
      epochMs: next.epochMs,
      dateKey: next.dateKey,
      occurrenceId: `${sub.deviceKey}:${category}:${next.dateKey}`,
    });
  }
  return out;
}

/**
 * Decide what to do with an occurrence. Returns one of:
 *  { action: 'deliver' } | { action: 'skip', reason } | { action: 'reschedule' }
 * Exported for unit tests — this is the complete delivery policy (§11/§12).
 */
export function decideOccurrence(sub, occ, nowMs = Date.now()) {
  // Not due yet — wait for the next tick. Never deliver early.
  if (occ.epochMs > nowMs) {
    return { action: 'reschedule' };
  }
  // Quiet hours are evaluated in the DEVICE's timezone for the occurrence's
  // wall-clock minute (not "now" — the scheduled time is what matters).
  const occMinutes = timeToMinutes(occ.time);
  if (inQuietHours(occMinutes, sub.quietStart ?? '22:30', sub.quietEnd ?? '07:00')) {
    return { action: 'skip', reason: 'quiet-hours' };
  }
  // Missed window: the instant passed too long ago (server was down, etc.).
  if (nowMs - occ.epochMs > GRACE_MS) {
    return { action: 'skip', reason: 'missed' };
  }
  return { action: 'deliver' };
}

/** Build the minimal push payload (§14). Nothing personal ever goes here. */
export function buildPushPayload({ kind = 'reminder', category, occurrenceId, dateKey, route, serverTime = Date.now() }) {
  return JSON.stringify({
    type: kind,
    category: String(category),
    occurrenceId: String(occurrenceId),
    dateKey: String(dateKey || ''),
    route: String(route || ROUTES[category] || '#/dashboard'),
    serverTime,
  });
}
