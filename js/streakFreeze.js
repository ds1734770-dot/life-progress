/**
 * Streak freezes — earn one for every 7 consecutive complete days (bank of
 * 2). When yesterday was missed but a streak of 3+ days led into it, a
 * banked freeze is spent automatically so one slip never erases the streak.
 * Frozen days are bridged only in the overall ("all") streak.
 *
 * State (settings.freeze): { banked, frozenDays: [dateKey], awards: {startKey: n} }
 */
import { addDays, todayKey } from './utils.js';

export const MAX_FREEZES = 2;
export const FREEZE_EVERY = 7;
export const MIN_STREAK_TO_PROTECT = 3;

export function normalizeFreeze(raw) {
  const f = raw && typeof raw === 'object' ? raw : {};
  return {
    banked: Math.min(MAX_FREEZES, Math.max(0, Math.floor(Number(f.banked) || 0))),
    frozenDays: Array.isArray(f.frozenDays) ? [...new Set(f.frozenDays.filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)))] : [],
    awards: f.awards && typeof f.awards === 'object' ? { ...f.awards } : {},
  };
}

/** Length + start of the run of covered days ending at `endKey` (0 if endKey is not covered). */
function runEndingAt(covered, endKey) {
  let n = 0;
  let key = endKey;
  while (covered.has(key)) {
    n++;
    key = addDays(key, -1);
  }
  return { length: n, start: n ? addDays(endKey, -(n - 1)) : null };
}

/**
 * @param completedDays Set of date keys where the overall day is complete
 * @returns {{ state, events: Array<{type:'used'|'earned', date?:string, count?:number}> }}
 */
export function evaluateFreezes(completedDays, rawState, today = todayKey()) {
  const state = normalizeFreeze(rawState);
  const events = [];
  const covered = new Set([...completedDays, ...state.frozenDays]);

  // 1) Spend a freeze on yesterday if it was missed and a real streak led in.
  const yesterday = addDays(today, -1);
  if (!covered.has(yesterday) && state.banked > 0) {
    const lead = runEndingAt(covered, addDays(yesterday, -1));
    if (lead.length >= MIN_STREAK_TO_PROTECT) {
      state.frozenDays.push(yesterday);
      state.banked -= 1;
      covered.add(yesterday);
      events.push({ type: 'used', date: yesterday });
    }
  }

  // 2) Earn freezes for each full week of the current run (ending today or yesterday).
  const end = covered.has(today) ? today : yesterday;
  const run = runEndingAt(covered, end);
  if (run.length >= FREEZE_EVERY) {
    const milestones = Math.floor(run.length / FREEZE_EVERY);
    const already = state.awards[run.start] || 0;
    if (milestones > already) {
      const gained = Math.min(MAX_FREEZES - state.banked, milestones - already);
      state.awards[run.start] = milestones;
      if (gained > 0) {
        state.banked += gained;
        events.push({ type: 'earned', count: gained });
      }
    }
  }

  // Housekeeping: keep the record small.
  const cutoff = addDays(today, -400);
  state.frozenDays = state.frozenDays.filter((k) => k >= cutoff);
  for (const k of Object.keys(state.awards)) if (k < cutoff) delete state.awards[k];
  return { state, events };
}
