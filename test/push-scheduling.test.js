/**
 * V1.6 background delivery — server-side scheduling policy tests.
 *
 * Covers the complete delivery decision policy (decideOccurrence), the
 * occurrence computation across timezone/DST/boundary hazards
 * (computeNextOccurrences), the deterministic occurrence-id scheme and the
 * minimal push payload shape. All pure — no network, no timers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextOccurrences, decideOccurrence, buildPushPayload } from '../server/scheduler.js';
import { nextDailyOccurrence, zonedParts, isValidTimezone, deviceTimezone, zonedTimeToEpoch } from '../js/timeCore.js';

const device = (over = {}) => ({
  deviceKey: 'dev-0001',
  timezone: 'Asia/Kolkata',
  enabled: true,
  categories: { water: true, gym: true, goals: true, journal: true },
  times: { water: '12:00', gym: '19:00', goals: '08:00', journal: '21:30' },
  quietStart: '22:30',
  quietEnd: '07:00',
  ...over,
});

// ---------------------------------------------------------------------------
// Timezone core
// ---------------------------------------------------------------------------

test('timezone validation accepts real IANA zones and rejects garbage', () => {
  // Intl canonicalizes to the modern id ('Asia/Kolkata'); legacy aliases
  // ('Asia/Calcutta') resolve too but may return the alias form — accept both.
  const kolkata = isValidTimezone('Asia/Kolkata');
  assert.ok(kolkata === 'Asia/Kolkata' || kolkata === 'Asia/Calcutta', kolkata);
  assert.ok(isValidTimezone('Europe/Paris'));
  assert.ok(isValidTimezone('America/New_York'));
  assert.equal(isValidTimezone('Not/AZone'), null);
  assert.equal(isValidTimezone(''), null);
  assert.equal(isValidTimezone(null), null);
  assert.equal(isValidTimezone(42), null);
  assert.ok(deviceTimezone()); // test machines expose a zone
});

test('zonedParts resolves wall-clock parts for Asia/Kolkata (UTC+5:30)', () => {
  // 06:30:00 UTC == 12:00 IST
  const parts = zonedParts(Date.UTC(2026, 0, 15, 6, 30), 'Asia/Kolkata');
  assert.equal(parts.hour, 12);
  assert.equal(parts.minute, 0);
  assert.equal(parts.dateKey, '2026-01-15');
});

test('nextDailyOccurrence: 12:00 Asia/Kolkata from 11:00 IST is today', () => {
  // 2026-01-15 05:30 UTC = 11:00 IST. 12:00 IST = 06:30 UTC.
  const after = Date.UTC(2026, 0, 15, 5, 30);
  const occ = nextDailyOccurrence('Asia/Kolkata', '12:00', after);
  assert.equal(occ.epochMs, Date.UTC(2026, 0, 15, 6, 30));
  assert.equal(occ.dateKey, '2026-01-15');
});

test('nextDailyOccurrence: after the time has passed, schedules tomorrow', () => {
  // 2026-01-15 07:00 UTC = 12:30 IST (12:00 already passed).
  const after = Date.UTC(2026, 0, 15, 7, 0);
  const occ = nextDailyOccurrence('Asia/Kolkata', '12:00', after);
  assert.equal(occ.epochMs, Date.UTC(2026, 0, 16, 6, 30));
  assert.equal(occ.dateKey, '2026-01-16');
});

test('nextDailyOccurrence: midnight (00:00) and month/year boundaries', () => {
  // Just before midnight IST on Jan 31 → occurrence Jan 32? No: Feb 1.
  const after = Date.UTC(2026, 0, 31, 18, 30); // 2026-01-31 24:00 − 1min IST = 00:00 upcoming Feb 1
  const occ = nextDailyOccurrence('Asia/Kolkata', '00:00', after - 60_000);
  assert.equal(occ.dateKey, '2026-02-01');
  // Year boundary: Dec 31 23:59 IST → Jan 1 occurrence.
  const newYearEve = Date.UTC(2026, 11, 31, 18, 28, 30);
  const occ2 = nextDailyOccurrence('Asia/Kolkata', '00:00', newYearEve);
  assert.equal(occ2.dateKey, '2027-01-01');
});

test('nextDailyOccurrence: leap year handled (Feb 28 → Feb 29 in 2028)', () => {
  // 2028-02-28 12:00 IST already passed; next 00:00 is Feb 29 (2028 IS a leap year).
  const after = Date.UTC(2028, 1, 28, 7, 0); // 12:30 IST
  const occ = nextDailyOccurrence('Asia/Kolkata', '00:00', after);
  assert.equal(occ.dateKey, '2028-02-29');
});

test('nextDailyOccurrence: DST-capable zone shifts correctly (America/New_York)', () => {
  // 2026-03-08 is the US spring-forward day (2:00 → 3:00 EDT).
  // A 12:00 noon reminder on Mar 7 (EST, UTC-5) = 17:00 UTC…
  const before = Date.UTC(2026, 2, 7, 16, 0); // 11:00 EST
  const occ1 = nextDailyOccurrence('America/New_York', '12:00', before);
  assert.equal(occ1.epochMs, Date.UTC(2026, 2, 7, 17, 0)); // EST: UTC-5
  // …but on Mar 9 (EDT, UTC-4) noon is 16:00 UTC.
  const before2 = Date.UTC(2026, 2, 9, 15, 0); // 11:00 EDT
  const occ2 = nextDailyOccurrence('America/New_York', '12:00', before2);
  assert.equal(occ2.epochMs, Date.UTC(2026, 2, 9, 16, 0)); // EDT: UTC-4
});

test('nextDailyOccurrence: a spring-forward gap resolves after the gap', () => {
  // 02:30 doesn't exist on 2026-03-08 in New York (clocks jump 2→3).
  const near = Date.UTC(2026, 2, 8, 6, 0); // 01:00 EST just before the jump
  const epochMs = zonedTimeToEpoch(near, 'America/New_York', 2, 30);
  const parts = zonedParts(epochMs, 'America/New_York');
  // Must land at/after the 3:00 wall time, same day.
  assert.equal(parts.dateKey, '2026-03-08');
  assert.ok(parts.hour >= 3, `expected hour >= 3, got ${parts.hour}`);
});

test('nextDailyOccurrence: never returns an instant at or before `after`', () => {
  let t = Date.UTC(2026, 5, 1, 0, 0);
  for (let i = 0; i < 50; i++) {
    const occ = nextDailyOccurrence('Pacific/Kiritimati', '23:59', t);
    assert.ok(occ.epochMs > t, `occurrence ${occ.epochMs} must be after ${t}`);
    t = occ.epochMs;
  }
});

// ---------------------------------------------------------------------------
// computeNextOccurrences
// ---------------------------------------------------------------------------

test('computeNextOccurrences: one entry per timed category, correct ids', () => {
  const now = Date.UTC(2026, 0, 15, 5, 0); // 10:30 IST
  const nexts = computeNextOccurrences(device(), now);
  assert.equal(nexts.length, 4);
  const water = nexts.find((o) => o.category === 'water');
  assert.equal(water.occurrenceId, 'dev-0001:water:2026-01-15');
  assert.equal(water.epochMs, Date.UTC(2026, 0, 15, 6, 30));
  const journal = nexts.find((o) => o.category === 'journal');
  assert.equal(journal.occurrenceId, 'dev-0001:journal:2026-01-15');
  assert.equal(journal.epochMs, Date.UTC(2026, 0, 15, 16, 0)); // 21:30 IST
});

test('computeNextOccurrences: disabled master, disabled device or category is excluded', () => {
  const now = Date.UTC(2026, 0, 15, 5, 0);
  assert.deepEqual(computeNextOccurrences(device({ enabled: false }), now), []);
  assert.deepEqual(computeNextOccurrences(device({ disabled: true }), now), []);
  const onlyWater = device({ categories: { water: true, gym: false, goals: false, journal: false } });
  const nexts = computeNextOccurrences(onlyWater, now);
  assert.equal(nexts.length, 1);
  assert.equal(nexts[0].category, 'water');
});

test('computeNextOccurrences: ledger position advances past handled occurrences', () => {
  const now = Date.UTC(2026, 0, 15, 5, 0); // 10:30 IST
  const sub = device({ ledger: { water: Date.UTC(2026, 0, 15, 6, 30) } });
  const nexts = computeNextOccurrences(sub, now);
  const water = nexts.find((o) => o.category === 'water');
  // Resume strictly after the handled 12:00 → tomorrow.
  assert.equal(water.dateKey, '2026-01-16');
  assert.equal(water.occurrenceId, 'dev-0001:water:2026-01-16');
});

test('computeNextOccurrences: device without timezone yields nothing (safe)', () => {
  assert.deepEqual(computeNextOccurrences(device({ timezone: undefined }), Date.now()), []);
});

// ---------------------------------------------------------------------------
// decideOccurrence — the full delivery policy (quiet hours, missed, early)
// ---------------------------------------------------------------------------

test('decideOccurrence: delivers inside the grace window after the instant', () => {
  const occ = { time: '12:00', epochMs: Date.UTC(2026, 0, 15, 6, 30), dateKey: '2026-01-15' };
  const d = decideOccurrence(device(), occ, occ.epochMs + 30_000); // 30s late
  assert.equal(d.action, 'deliver');
});

test('decideOccurrence: never delivers early (not-due → reschedule)', () => {
  const occ = { time: '12:00', epochMs: Date.UTC(2026, 0, 15, 6, 30), dateKey: '2026-01-15' };
  const early = decideOccurrence(device(), occ, occ.epochMs - 60_000);
  assert.equal(early.action, 'reschedule');
});

test('decideOccurrence: marks occurrences missed after the grace window (§11)', () => {
  const occ = { time: '12:00', epochMs: Date.UTC(2026, 0, 15, 6, 30), dateKey: '2026-01-15' };
  const late = decideOccurrence(device(), occ, occ.epochMs + 10 * 60_000); // 10 min late
  assert.equal(late.action, 'skip');
  assert.equal(late.reason, 'missed');
});

test('decideOccurrence: quiet hours suppress without replay (§12)', () => {
  // 06:00 reminder with default 22:30–07:00 quiet hours.
  const sub = device({ times: { ...device().times, water: '06:00' } });
  const occ = { time: '06:00', epochMs: Date.UTC(2026, 0, 15, 0, 30), dateKey: '2026-01-15' }; // 06:00 IST
  const d = decideOccurrence(sub, occ, occ.epochMs + 10_000);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'quiet-hours');
});

test('decideOccurrence: quiet hours crossing midnight suppress the late side too', () => {
  // 23:00 reminder, default window 22:30–07:00.
  const occ = { time: '23:00', epochMs: Date.UTC(2026, 0, 15, 17, 30), dateKey: '2026-01-15' };
  const d = decideOccurrence(device(), occ, occ.epochMs + 10_000);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'quiet-hours');
});

test('decideOccurrence: disabled quiet hours (start === end) never suppress', () => {
  const sub = device({ quietStart: '07:00', quietEnd: '07:00' });
  const occ = { time: '06:00', epochMs: Date.UTC(2026, 0, 15, 0, 30), dateKey: '2026-01-15' };
  const d = decideOccurrence(sub, occ, occ.epochMs + 10_000);
  assert.equal(d.action, 'deliver');
});

// ---------------------------------------------------------------------------
// Payload shape (§14) — minimal, no personal data
// ---------------------------------------------------------------------------

test('buildPushPayload: contains only category identity, route and timestamps', () => {
  const raw = buildPushPayload({ category: 'water', occurrenceId: 'dev-0001:water:2026-01-15', dateKey: '2026-01-15', route: '#/water' });
  const payload = JSON.parse(raw);
  assert.deepEqual(Object.keys(payload).sort(), ['category', 'dateKey', 'occurrenceId', 'route', 'serverTime', 'type']);
  assert.equal(payload.type, 'reminder');
  assert.equal(payload.route, '#/water');
  const flat = JSON.stringify(payload);
  // Privacy: no journal text, no names, no amounts.
  assert.doesNotMatch(flat, /journal|mood|note|ml|target/i);
});

// ---------------------------------------------------------------------------
// V1.6.4 regression — sub-minute anchors must not shift the occurrence.
// zoneOffsetMinutes once paired the seconds-truncated wall clock with the
// RAW epoch, so anchors with second ≥ 30 rounded the IST offset down by one
// minute and pushed "today"'s occurrence a full minute into the future
// (a tick at :31 saw the 19:54 IST reminder as "due at 19:55"). Alarms can
// fire at any second, so the scheduler must be second-independent.
// ---------------------------------------------------------------------------

test('regression: occurrence instant is identical for anchors at :05 and :31', () => {
  const sub = device(); // water at 12:00 IST
  const a5 = computeNextOccurrences(sub, Date.UTC(2026, 0, 15, 6, 30, 5));
  const a31 = computeNextOccurrences(sub, Date.UTC(2026, 0, 15, 6, 30, 31));
  const a59 = computeNextOccurrences(sub, Date.UTC(2026, 0, 15, 6, 30, 59));
  for (const [label, occs] of [[':05', a5], [':31', a31], [':59', a59]]) {
    const water = occs.find((o) => o.category === 'water');
    assert.ok(water, `anchor ${label} still computes the water occurrence`);
    assert.equal(water.epochMs, Date.UTC(2026, 0, 15, 6, 30, 0), `anchor ${label}: 12:00 IST = 06:30:00Z exactly`);
    assert.equal(water.dateKey, '2026-01-15');
  }
  // And the due decision is stable across the same second-of-minute sweep.
  assert.equal(decideOccurrence(sub, a5.find((o) => o.category === 'water'), Date.UTC(2026, 0, 15, 6, 30, 5)).action, 'deliver');
  assert.equal(decideOccurrence(sub, a31.find((o) => o.category === 'water'), Date.UTC(2026, 0, 15, 6, 30, 31)).action, 'deliver');
  assert.equal(decideOccurrence(sub, a59.find((o) => o.category === 'water'), Date.UTC(2026, 0, 15, 6, 30, 59)).action, 'deliver');
});

test('regression: every IST reminder time maps to the same UTC minute regardless of anchor seconds', () => {
  const tz = 'Asia/Kolkata';
  const times = [[0, 5], [7, 54], [12, 0], [19, 54], [23, 59]]; // (hh, mm) IST
  for (const [hh, mm] of times) {
    const at5 = zonedTimeToEpoch(Date.UTC(2026, 0, 15, 6, 30, 5), tz, hh, mm);
    const at31 = zonedTimeToEpoch(Date.UTC(2026, 0, 15, 6, 30, 31), tz, hh, mm);
    const at59 = zonedTimeToEpoch(Date.UTC(2026, 0, 15, 6, 30, 59), tz, hh, mm);
    assert.equal(at5, at31);
    assert.equal(at31, at59);
    // 19:54 IST = 14:24 UTC — the canonical example from the V1.6.4 spec.
    if (hh === 19 && mm === 54) assert.equal(at5, Date.UTC(2026, 0, 15, 14, 24, 0));
    if (hh === 7 && mm === 54) assert.equal(at5, Date.UTC(2026, 0, 15, 2, 24, 0));
    // The resolved instant must land exactly on the wall-clock minute.
    const parts = zonedParts(at5, tz);
    assert.equal(parts.hour, hh);
    assert.equal(parts.minute, mm);
    // Zero seconds is the essence of the fix: the occurrence instant sits on
    // the minute boundary, never smeared by the anchor's sub-minute residue.
    assert.equal(at5 % 60000, 0);
  }
});
