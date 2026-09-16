/**
 * Pure time core — shared by the page, the service worker, the push server
 * and the unit tests. NO DOM, NO storage, NO browser-only APIs: everything
 * here is deterministic arithmetic over "HH:MM" strings, minutes and
 * IANA timezones (via Intl, which Node ≥ 14 ships with full ICU).
 *
 * Extracted from js/notifications.js (V1.5) so the server-side scheduler can
 * use the EXACT same semantics as the in-app engine — one definition, no
 * drift. js/notifications.js re-exports these names, so every existing
 * import keeps working unchanged.
 */

// ---------------------------------------------------------------------------
// "HH:MM" parsing + formatting
// ---------------------------------------------------------------------------

/** "HH:MM" → minutes since midnight. Returns null when invalid. */
export function timeToMinutes(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isValidTime(t) {
  return timeToMinutes(t) !== null;
}

/** Minutes since midnight → canonical "HH:MM" string. */
export function minutesToTime(mins) {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
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
// Quiet hours — [start, end), midnight-crossing, start === end disables.
// Identical semantics to the V1.5 in-app engine (see test/notifications.test.js).
// ---------------------------------------------------------------------------

/**
 * True when `minutes` is inside [start, end). Crossing midnight is supported:
 * 22:30→07:00 covers 23:00 and 03:00; 07:00→22:30 covers 12:00. Zero-length
 * ranges (start === end) mean "no quiet hours". Invalid ranges never block.
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
// IANA timezone wall-clock parts — the foundation of timezone-correct
// scheduling. Never add/subtract fixed UTC offsets by hand: Intl resolves the
// real current offset for the zone, DST transitions included.
// ---------------------------------------------------------------------------

/** Cached formatters — constructing Intl.DateTimeFormat is expensive. */
const dtfCache = new Map();

function zonedFormatter(tz) {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(tz, dtf);
  }
  return dtf;
}

/**
 * Validate an IANA timezone identifier ("Asia/Kolkata", "Europe/Paris", …).
 * Returns the normalized id, or null when the platform doesn't recognize it.
 */
export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return null;
  try {
    // Round-trip: Intl rejects unknown zones with a RangeError.
    const out = zonedFormatter(tz.trim()).resolvedOptions().timeZone;
    return out || null;
  } catch {
    return null;
  }
}

/**
 * The device's IANA timezone, or null when the platform doesn't expose one.
 */
export function deviceTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Wall-clock parts of a UTC instant in a timezone:
 * { year, month, day, hour, minute, minutes, dateKey } where `minutes` is
 * minutes-since-midnight and `dateKey` is "YYYY-MM-DD" in that zone.
 */
export function zonedParts(epochMs, tz) {
  const parts = zonedFormatter(tz).formatToParts(new Date(epochMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  // Some ICU builds render midnight as "24" under h23 — normalize.
  const h = hour === 24 ? 0 : hour;
  return {
    year,
    month,
    day,
    hour: h,
    minute,
    minutes: h * 60 + minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

/**
 * The UTC instant at which it is `hh:mm` wall-clock time in `tz` on the
 * calendar day containing `nearEpochMs`. DST-correct by construction, using
 * the two-offset candidate method (the standard approach):
 *
 * 1. Build the target wall time as a UTC instant under every zone offset that
 *    can apply to that day (sampled at day-1 / now / day+1 — transitions
 *    happen at most twice a year, so three samples cover any target day).
 * 2. Keep candidates whose ACTUAL wall clock in the zone equals the target.
 *    · Exactly one → that instant (the normal case).
 *    · Two (fall-back ambiguity, e.g. 01:30 happens twice) → the EARLIER one,
 *      so a reminder fires at the first occurrence.
 *    · None (spring-forward gap, e.g. 02:30 skipped) → resolve with the
 *      pre-transition offset, which lands on the first instant AFTER the gap
 *      (02:30 NY → 3:30 EDT) — the least-surprising interpretation.
 */
export function zonedTimeToEpoch(nearEpochMs, tz, hh, mm) {
  const p = zonedParts(nearEpochMs, tz);
  const targetMinutes = hh * 60 + mm;
  const wallTargetUTC = Date.UTC(p.year, p.month - 1, p.day, hh, mm);
  const offsets = [...new Set([
    zoneOffsetMinutes(nearEpochMs - 86400000, tz),
    zoneOffsetMinutes(nearEpochMs, tz),
    zoneOffsetMinutes(nearEpochMs + 86400000, tz),
  ])];
  const candidates = offsets
    .map((off) => wallTargetUTC - off * 60000)
    .filter((e) => {
      const w = zonedParts(e, tz);
      return w.dateKey === p.dateKey && w.minutes === targetMinutes;
    })
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0];
  // Spring-forward gap: use the pre-transition (smaller) offset.
  return wallTargetUTC - Math.min(...offsets) * 60000;
}

/** Minutes the zone is offset from UTC at a given instant (e.g. IST = 330). */
function zoneOffsetMinutes(epochMs, tz) {
  const p = zonedParts(epochMs, tz);
  // Compare minute-start to minute-start: `zonedParts` has no seconds, so
  // pairing the wall minute with the RAW epoch (which carries seconds)
  // smeared sub-minute residue into the offset — an anchor at :31 produced
  // offset−1 and shifted occurrences a full minute (V1.6.4 regression fix;
  // alarms can fire late, so anchors with arbitrary seconds are normal).
  const wallUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const epochMinuteStart = epochMs - (epochMs % 60000);
  return Math.round((wallUTC - epochMinuteStart) / 60000);
}

/**
 * The next occurrence of a daily "HH:MM" reminder in `tz`, strictly after
 * `afterEpochMs` (default: now). Returns the UTC epoch ms of the occurrence
 * AND the calendar date key (in `tz`) it belongs to — the deterministic
 * dedup period shared by the server ledger, the service worker and the page.
 *
 * Handles midnight (00:00), month/year boundaries and leap years for free:
 * they are all just wall-clock days in the zone.
 */
export function nextDailyOccurrence(tz, time, afterEpochMs = Date.now()) {
  const mins = timeToMinutes(time);
  if (mins === null) return null;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  const todayAtTime = zonedTimeToEpoch(afterEpochMs, tz, hh, mm);
  if (todayAtTime > afterEpochMs) {
    return { epochMs: todayAtTime, dateKey: zonedParts(todayAtTime, tz).dateKey };
  }
  // Tomorrow, in the zone: anchor on the wall date, add one calendar day,
  // then re-materialize the wall time (DST-safe across the boundary).
  const tomorrowWall = addOneDay(zonedParts(afterEpochMs, tz));
  const anchor = Date.UTC(tomorrowWall.year, tomorrowWall.month - 1, tomorrowWall.day, 12);
  const epochMs = zonedTimeToEpoch(anchor, tz, hh, mm);
  return { epochMs, dateKey: zonedParts(epochMs, tz).dateKey };
}

/** Calendar-day arithmetic on zoned parts (leap years included). */
function addOneDay({ year, month, day }) {
  const d = new Date(Date.UTC(year, month - 1, day, 12));
  d.setUTCDate(d.getUTCDate() + 1);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The date key ("YYYY-MM-DD") a given instant falls on in `tz` — used to
 * build deterministic occurrence ids shared across server and clients.
 */
export function zonedDateKey(epochMs, tz) {
  return zonedParts(epochMs, tz).dateKey;
}
