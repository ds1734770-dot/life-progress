/**
 * Server-side scheduling state — a single JSON file with atomic writes.
 *
 * Deliberately NOT a database: the scheduling state is tiny (one record per
 * device + a dedup ledger), and the project's zero-dependency convention
 * makes SQLite/Postgres disproportionate here (§19: "simplest reliable
 * persistence mechanism compatible with the existing deployment").
 *
 * Durability contract: every mutation is written to a temp file and renamed
 * over the target — POSIX rename is atomic, so a crash mid-write can never
 * corrupt the store. State survives process restarts; nothing lives only in
 * memory.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DATA_FILE = process.env.PUSH_DATA_FILE?.trim() || join(ROOT, '.push-data.json');

// ---------------------------------------------------------------------------
// Shape: { subscriptions: {deviceKey: {...}}, deliveries: {occurrenceId: {...}} }
// `deviceKey` is a server-generated opaque id; the client stores it locally so
// a re-subscribing device UPDATES its record instead of duplicating it (§20).
// ---------------------------------------------------------------------------

let data = null;
let writeChain = Promise.resolve();

function empty() {
  return { subscriptions: {}, deliveries: {} };
}

export function dataFilePath() {
  return DATA_FILE;
}

export async function loadState() {
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    data = {
      subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
      deliveries: parsed.deliveries && typeof parsed.deliveries === 'object' ? parsed.deliveries : {},
    };
  } catch {
    data = empty();
  }
  return data;
}

function state() {
  if (!data) throw new Error('store not loaded — call loadState() at startup');
  return data;
}

/** Serialize all mutations: no interleaved read-modify-write races. */
function mutate(fn) {
  writeChain = writeChain.then(async () => {
    fn(state());
    const tmp = `${DATA_FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(state()), 'utf8');
    await rename(tmp, DATA_FILE);
  }).catch((err) => {
    // Keep the chain alive but surface the failure loudly — a broken
    // persistence layer must never be silent (§19).
    console.error('[push-store] write failed:', err?.message || err);
    throw err;
  });
  return writeChain;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * Create or update the record for one device. The client supplies its
 * deviceKey (an opaque random id it persists); the server regenerates nothing.
 * Stored per device: endpoint, keys (p256dh/auth), timezone, quiet hours,
 * reminder schedule, enabled flag, and delivery bookkeeping.
 */
export function upsertSubscription(deviceKey, record) {
  const existing = state().subscriptions[deviceKey];
  const merged = {
    ...(existing || {}),
    ...record,
    deviceKey,
    // Server-owned bookkeeping (client values never overwrite these):
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    failureCount: 0,
    lastError: null,
  };
  return mutate((d) => {
    d.subscriptions[deviceKey] = merged;
  }).then(() => merged);
}

export function getSubscription(deviceKey) {
  return state().subscriptions[deviceKey] || null;
}

export function deleteSubscription(deviceKey) {
  return mutate((d) => {
    delete d.subscriptions[deviceKey];
  });
}

export function listSubscriptions() {
  return Object.values(state().subscriptions);
}

/** Record a delivery attempt outcome on the subscription record. */
export function markSubscriptionOutcome(deviceKey, { ok, error = null, permanent = false }) {
  return mutate((d) => {
    const sub = d.subscriptions[deviceKey];
    if (!sub) return;
    if (ok) {
      sub.lastDeliveredAt = Date.now();
      sub.failureCount = 0;
      sub.lastError = null;
    } else {
      sub.failureCount = (sub.failureCount || 0) + 1;
      sub.lastError = String(error || 'unknown');
      if (permanent) sub.disabled = true; // 404/410 from the push service
    }
  });
}

/**
 * Persist the last handled occurrence per category on the subscription —
 * the scheduler's restart-safe position (§10/§19). `epochMs` is the handled
 * occurrence's instant; the next computation resumes strictly after it.
 */
export function upsertLedger(deviceKey, category, epochMs) {
  return mutate((d) => {
    const sub = d.subscriptions[deviceKey];
    if (!sub) return;
    sub.ledger = sub.ledger || {};
    const prev = sub.ledger[category] || 0;
    if (epochMs > prev) sub.ledger[category] = epochMs;
  });
}

// ---------------------------------------------------------------------------
// Delivery ledger — the dedup backbone (§13)
// ---------------------------------------------------------------------------

/**
 * Atomically claim an occurrence. Returns true exactly once per occurrenceId;
 * every later claim (restart, duplicate tick, reconnect) returns false. This
 * is the ONLY gate before a push is sent, so a notification can never be
 * delivered twice no matter how the scheduler is triggered.
 */
export function claimOccurrence(occurrenceId, meta = {}) {
  if (state().deliveries[occurrenceId]) return Promise.resolve(false);
  return mutate((d) => {
    d.deliveries[occurrenceId] = { claimedAt: Date.now(), ...meta };
  }).then(() => true);
}

export function hasOccurrence(occurrenceId) {
  return Boolean(state().deliveries[occurrenceId]);
}

export function updateOccurrence(occurrenceId, patch) {
  return mutate((d) => {
    const rec = d.deliveries[occurrenceId];
    if (rec) Object.assign(rec, patch);
  });
}

/**
 * Ledger pruning: keep the last `keepDays` of records (default 45 — longer
 * than any plausible clock skew/outage so stale replays stay deduped), and
 * never more than `maxRecords` rows.
 */
export function pruneDeliveries(keepDays = 45, maxRecords = 5000) {
  const cutoff = Date.now() - keepDays * 86400000;
  return mutate((d) => {
    const entries = Object.entries(d.deliveries);
    const kept = entries
      .filter(([, rec]) => (rec.claimedAt || 0) >= cutoff)
      .sort((a, b) => (b[1].claimedAt || 0) - (a[1].claimedAt || 0))
      .slice(0, maxRecords);
    d.deliveries = Object.fromEntries(kept);
  });
}

/** Test/reset helper. */
export async function resetState() {
  data = empty();
  try {
    await mutate(() => {});
  } catch { /* best-effort */ }
}
