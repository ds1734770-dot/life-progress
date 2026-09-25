/**
 * Pure reminder-scheduling domain — shared by BOTH backends (V2.2).
 *
 * V2.2 — ONE canonical occurrence model. `computeNextOccurrences`,
 * `isDue`, `isEligible`, `occurrenceId` and `ACK_GRACE_MS` live in
 * js/timeCore.js (client-safe: no server imports) and are RE-EXPORTED here
 * verbatim. The server scheduler and the page's local sweep therefore run
 * the EXACT same code — they cannot disagree about when an occurrence is
 * due, what its identity is, or when it is too late to claim it.
 *
 * Canonical occurrence identity: deviceKey:category:dateKey
 *   - device (via deviceKey)
 *   - category
 *   - date (the date the wall-clock reminder time belongs to in the device's
 *     IANA timezone; decided by wall-clock math, never by the UTC date of
 *     the epoch instant)
 *
 * Delivery-state models used by the server and the local page:
 *   - server:  the deliveries ledger (server/store.js / DO
 *              `notification_occurrences`, occurrenceId PK). claimOccurrence()
 *              is the ONLY gate before a push travels; a client ACK writes
 *              the same ledger row, so a locally-handled occurrence is never
 *              pushed afterwards.
 *   - local:   notificationState store (js/db.js), dedup record
 *              `category:daily:dateKey` (kept client-side only).
 *
 * Shared terms: occurrenceId, dateKey, isDue, isEligible, ackOccurrence,
 *   isAcked.
 */

import { nextDailyOccurrence, timeToMinutes, inQuietHours } from '../../js/timeCore.js';
import {
  ACK_GRACE_MS,
  occurrenceId,
  computeNextOccurrences,
  isDue,
  isEligible,
} from '../../js/timeCore.js';

export { ACK_GRACE_MS, occurrenceId, computeNextOccurrences, isDue, isEligible };

export const GRACE_MS = 90 * 1000; // deliver up to 90s late (tick jitter, clock drift)
export const CATEGORIES = ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements'];
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
 * Decide what to do with an occurrence. Returns one of:
 *   { action: 'deliver' } | { action: 'skip', reason } | { action: 'reschedule' }
 * Exported for unit tests — this is the complete server delivery policy (§11/§12).
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

/**
 * Validate + normalize an ACK request body — the shared contract for the
 * Node backend and the Cloudflare Worker (extracted here so both backends
 * enforce the identical shape). Returns { error } or { value }.
 *
 * ACK semantics (V2.2): an ack records that a REAL occurrence was handled
 * and PRESENTED on the device. It must never be sent for "the app opened",
 * "the scheduler ran" or "the provider returned 200". A not-yet-due
 * occurrence (scheduledFor in the future) is rejected — claiming an
 * occurrence before its scheduled instant is exactly the bug being fixed.
 */
export function validateAck(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid body' };
  const { deviceKey, category, dateKey, source } = body;
  if (typeof deviceKey !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(deviceKey)) {
    return { error: 'invalid deviceKey' };
  }
  if (!CONTENT_CATEGORIES.includes(category)) return { error: 'invalid category' };
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return { error: 'invalid dateKey' };
  }
  const src = source === 'push' || source === 'local' ? source : 'local';
  return { value: { deviceKey, category, dateKey, source: src, occurrenceId: occurrenceId(deviceKey, category, dateKey) } };
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
