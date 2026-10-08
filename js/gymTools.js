/** Gym helpers: estimated 1RM, plate calculator, progressive-overload hint. */

/** Epley estimated one-rep max (kg). Returns 0 for invalid input. */
export function estimate1RM(weight, reps) {
  const w = Number(weight);
  const r = Number(reps);
  if (!(w > 0) || !(r > 0)) return 0;
  if (r === 1) return w;
  return Math.round(w * (1 + r / 30) * 2) / 2;
}

export const PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];

/**
 * Plates needed per side for a target barbell weight.
 * @returns {{ perSide: number[], achieved: number, remainder: number, belowBar: boolean }}
 */
export function plateBreakdown(target, bar = 20, plates = PLATES) {
  const t = Number(target);
  if (!(t > 0)) return { perSide: [], achieved: 0, remainder: 0, belowBar: false };
  if (t < bar) return { perSide: [], achieved: bar, remainder: 0, belowBar: true };
  let left = (t - bar) / 2;
  const perSide = [];
  for (const p of [...plates].sort((a, b) => b - a)) {
    while (left + 1e-9 >= p) {
      perSide.push(p);
      left -= p;
    }
  }
  const achieved = bar + perSide.reduce((a, b) => a + b, 0) * 2;
  return { perSide, achieved, remainder: Math.round((t - achieved) * 100) / 100, belowBar: false };
}

/**
 * Next-session suggestion from last session's sets [{weight, reps}].
 * If every top-weight set reached `targetReps` → add weight; otherwise add a rep.
 */
export function overloadSuggestion(lastSets, { targetReps = 10, step = 2.5 } = {}) {
  const sets = (lastSets || []).filter((s) => s && s.weight > 0 && s.reps > 0);
  if (!sets.length) return null;
  const topWeight = Math.max(...sets.map((s) => s.weight));
  const atTop = sets.filter((s) => s.weight === topWeight);
  const ref = atTop.reduce((a, b) => (b.reps > a.reps ? b : a));
  if (atTop.every((s) => s.reps >= targetReps)) {
    return { weight: topWeight + step, reps: Math.max(6, targetReps - 2), reason: `You hit ${targetReps}+ reps at ${topWeight} kg` };
  }
  return { weight: topWeight, reps: ref.reps + 1, reason: `Add one rep at ${topWeight} kg` };
}
