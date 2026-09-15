/**
 * Reminder scheduler — the independent background process (§18).
 *
 * Responsibility: for every registered device, compute the next occurrence of
 * each enabled daily reminder in the DEVICE's timezone, sleep until the
 * earliest one, then deliver it via Web Push. Recurring semantics follow
 * §10: exactly one pending occurrence per reminder is held — after delivery
 * (or skip) the next occurrence is computed. No infinite job lists.
 *
 * Correctness rules implemented here:
 *  - Timezone-correct: occurrences are wall-clock times in the device's IANA
 *    zone (js/timeCore.js drives the math; DST-safe by construction).
 *  - Quiet hours (§12): an occurrence that falls inside the device's quiet
 *    window is SKIPPED — never delivered, never replayed later.
 *  - Missed reminders (§11): if a scheduled instant passed while the process
 *    was down, the occurrence is marked `missed`, NOT pushed (no stale flood
 *    after recovery) — except a small grace window for ticks that fire a few
 *    seconds early/late.
 *  - Dedup (§13): every push is preceded by an atomic claimOccurrence() on a
 *    deterministic id `device:category:occurrenceDateKey`. Duplicate ticks,
 *    restarts and reconnects can never double-send.
 *  - Restart-safe (§19): pending state is derived from the persisted
 *    subscription records on every tick; there is no in-memory schedule to
 *    lose. The ledger records the last handled occurrence per reminder.
 *  - Push cleanup (§20): 404/410 from the push service disables the
 *    subscription; transient failures retry with backoff (bounded).
 *
 * The payload sent to the service worker is intentionally minimal (§14):
 * category, occurrence id, dedup key, route hint and timestamps. NO personal
 * data — the service worker derives context-aware copy locally.
 */
import { claimOccurrence, listSubscriptions, markSubscriptionOutcome, hasOccurrence, updateOccurrence } from './store.js';
import { sendPushMessage } from './push/webpush.js';
import { nextDailyOccurrence } from '../js/timeCore.js';
import {
  GRACE_MS,
  computeNextOccurrences,
  decideOccurrence,
  buildPushPayload,
} from './push/domain.js';

// Pure scheduling domain moved to server/push/domain.js (V1.6.4) so the
// Cloudflare Worker backend can reuse the exact same delivery policy.
export { computeNextOccurrences, decideOccurrence, buildPushPayload, GRACE_MS };

const TICK_MS = 15 * 1000; // scheduler heartbeat
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000;
const CONTENT_CATEGORIES = ['water', 'gym', 'goals', 'journal'];

async function deliverOccurrence(sub, occ, vapid) {
  const payload = buildPushPayload({
    category: occ.category,
    occurrenceId: occ.occurrenceId,
    dateKey: occ.dateKey,
    route: ROUTES[occ.category],
  });
  const result = await sendPushMessage({ endpoint: sub.endpoint, keys: sub.keys }, payload, vapid);
  if (result.ok) {
    await markSubscriptionOutcome(sub.deviceKey, { ok: true });
    return { ok: true };
  }
  await markSubscriptionOutcome(sub.deviceKey, {
    ok: false,
    error: result.error || `status ${result.status}`,
    permanent: result.status === 404 || result.status === 410,
  });
  return { ok: false, ...result };
}

/**
 * Handle one subscription: deliver everything due, skip/miss what isn't,
 * persist the ledger position and return the earliest upcoming occurrence
 * across all categories.
 */
export async function processSubscription(sub, vapid, nowMs = Date.now()) {
  const nexts = computeNextOccurrences(sub, nowMs);
  let handled = 0;

  for (const occ of nexts) {
    const decision = decideOccurrence(sub, occ, nowMs);
    if (decision.action === 'reschedule') continue; // still in the future

    // Atomic claim — dedup against restarts/duplicate ticks (§13).
    const claimed = await claimOccurrence(occ.occurrenceId, {
      deviceKey: sub.deviceKey,
      category: occ.category,
      scheduledFor: occ.epochMs,
    });
    if (!claimed) {
      // Someone already handled this occurrence — advance the ledger only.
      await updateOccurrence(occ.occurrenceId, {});
      await recordLedger(sub, occ);
      handled++;
      continue;
    }

    if (decision.action === 'skip') {
      await updateOccurrence(occ.occurrenceId, { status: decision.reason, decidedAt: nowMs });
      await recordLedger(sub, occ);
      handled++;
      continue;
    }

    // Deliver. A transient failure retries a bounded number of times with
    // backoff; permanent failures (404/410) mark the record so it is skipped.
    // Operational logs carry only the occurrence id — never personal data
    // or credentials (§24).
    console.log(`[push] sending occurrence ${occ.occurrenceId}`);
    let result = await deliverOccurrence(sub, occ, vapid);
    let attempts = 1;
    while (!result.ok && result.transient && attempts < 3) {
      const delay = Math.min(MAX_RETRY_DELAY_MS, 5000 * 2 ** (attempts - 1));
      await sleep(delay);
      result = await deliverOccurrence(sub, occ, vapid);
      attempts++;
    }
    await updateOccurrence(occ.occurrenceId, {
      status: result.ok ? 'delivered' : result.status === 404 || result.status === 410 ? 'gone' : 'failed',
      attempts,
      decidedAt: Date.now(),
    });
    await recordLedger(sub, occ);
    if (result.ok) {
      console.log(`[push] delivery accepted ${occ.occurrenceId}`);
    } else {
      console.error(`[push] delivery failed ${occ.occurrenceId} (status ${result.status || 'n/a'}, ${result.transient ? 'transient' : 'permanent'})`);
    }
    handled++;
  }

  // Earliest future occurrence still pending for this device.
  const upcoming = computeNextOccurrences(sub, Date.now())
    .filter((o) => !hasOccurrence(o.occurrenceId))
    .sort((a, b) => a.epochMs - b.epochMs)[0] || null;
  return { handled, next: upcoming };
}

/** Persist per-category ledger position on the subscription record. */
function recordLedger(sub, occ) {
  return import('./store.js').then(({ upsertLedger }) =>
    upsertLedger(sub.deviceKey, occ.category, occ.epochMs)
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

let running = false;
let stopped = false;

/**
 * One sweep over all subscriptions. Returns a small summary (used by tests
 * and the /api/push/status endpoint).
 */
export async function schedulerTick(vapid, nowMs = Date.now()) {
  const subs = listSubscriptions();
  let deliveries = 0;
  let skips = 0;
  let nextAt = null;
  for (const sub of subs) {
    try {
      const res = await processSubscription(sub, vapid, nowMs);
      deliveries += res.handled;
      if (res.next && (nextAt === null || res.next.epochMs < nextAt)) nextAt = res.next.epochMs;
    } catch (err) {
      skips++;
      console.error('[scheduler] subscription failed:', sub.deviceKey, err?.message || err);
    }
  }
  return { devices: subs.length, deliveries, skips, nextAt };
}

/**
 * Run the scheduler loop until stop(). The loop is tick-driven rather than
 * timer-per-reminder: cheap, restart-safe, and drift-tolerant.
 */
export async function runScheduler(vapid, { tickMs = TICK_MS } = {}) {
  if (running) return; // duplicate worker startup is a no-op (§19)
  running = true;
  stopped = false;
  console.log(`[push] scheduler started (tick ${tickMs}ms)`);
  while (!stopped) {
    try {
      await schedulerTick(vapid);
    } catch (err) {
      console.error('[scheduler] tick failed:', err?.message || err);
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
  running = false;
}

export function stopScheduler() {
  stopped = true;
}

export function isRunning() {
  return running;
}

/** Test hook: synchronous single tick with an injected clock. */
export async function tickOnce(vapid, nowMs) {
  return schedulerTick(vapid, nowMs);
}
