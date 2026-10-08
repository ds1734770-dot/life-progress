/**
 * Muscle map — which muscle groups you trained recently. Pure derivation
 * from logged workouts (no storage). Also owns the SVG body markup.
 */
import { addDays, daysBetween, todayKey } from './utils.js';
import { guessMuscleGroup } from './gymTemplates.js';

export const REGIONS = ['Chest', 'Shoulders', 'Biceps', 'Triceps', 'Back', 'Core', 'Glutes', 'Quads', 'Hamstrings', 'Calves'];

const KEYWORDS = [
  [/calf/, 'Calves'],
  [/leg curl|hamstring|romanian|rdl|good morning/, 'Hamstrings'],
  [/squat|lunge|leg press|leg extension|step.?up|hack/, 'Quads'],
  [/tricep|dip|skull|close.?grip|pushdown/, 'Triceps'],
  [/hip thrust|glute|bridge|kickback/, 'Glutes'],
  [/bicep|curl|preacher/, 'Biceps'],
  [/crunch|plank|sit.?up|\babs?\b|core|leg raise|russian/, 'Core'],
  [/lateral|shoulder|overhead|military|upright|front raise|arnold|face pull|shrug/, 'Shoulders'],
  [/row|pull|lat |chin|deadlift|back|pulldown/, 'Back'],
  [/bench|chest|fly|push.?up|pec|incline|decline/, 'Chest'],
];

export function muscleFor(name) {
  const known = guessMuscleGroup(name);
  if (known !== 'Other') return known;
  const n = String(name || '').toLowerCase();
  for (const [re, group] of KEYWORDS) if (re.test(n)) return group;
  return 'Other';
}

function setCount(ex) {
  if (Array.isArray(ex.performedSets) && ex.performedSets.length) return ex.performedSets.length;
  return Math.max(1, Number(ex.sets) || 0);
}

/** Sets per region over the last `days` days (today included). */
export function muscleSets(workouts, days = 7, today = todayKey()) {
  const from = addDays(today, -(days - 1));
  const out = Object.fromEntries(REGIONS.map((r) => [r, 0]));
  for (const w of workouts) {
    if (!w.date || w.date < from || w.date > today) continue;
    for (const ex of w.exercises || []) {
      const group = muscleFor(ex.exerciseName);
      const n = setCount(ex);
      if (group === 'Full Body') for (const r of REGIONS) out[r] += n * 0.4;
      else if (group in out) out[group] += n;
    }
  }
  for (const r of REGIONS) out[r] = Math.round(out[r]);
  return out;
}

/** 0 none · 1 light · 2 moderate · 3 solid · 4 heavy */
export function loadLevel(sets) {
  if (sets <= 0) return 0;
  if (sets <= 3) return 1;
  if (sets <= 7) return 2;
  if (sets <= 12) return 3;
  return 4;
}

/** Days since each region was last trained (null = never in the logs). */
export function daysSinceTrained(workouts, today = todayKey()) {
  const last = {};
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      const g = muscleFor(ex.exerciseName);
      const targets = g === 'Full Body' ? REGIONS : [g];
      for (const r of targets) if (REGIONS.includes(r) && (!last[r] || w.date > last[r])) last[r] = w.date;
    }
  }
  return Object.fromEntries(REGIONS.map((r) => [r, last[r] ? daysBetween(last[r], today) : null]));
}

/** Short coaching line about the most neglected region (needs some history). */
export function neglectNote(workouts, today = todayKey()) {
  if (!workouts.length) return null;
  const since = daysSinceTrained(workouts, today);
  const trained = REGIONS.filter((r) => since[r] !== null);
  if (trained.length < 2) return null;
  let worst = null;
  for (const r of REGIONS) {
    const d = since[r];
    if (d === null || d >= 7) {
      const weight = d === null ? 999 : d;
      if (!worst || weight > worst.weight) worst = { region: r, days: d, weight };
    }
  }
  if (!worst) return 'Every muscle group got attention this week. Balanced.';
  return worst.days === null ? `${worst.region} hasn’t shown up in your logs yet.` : `${worst.region} hasn’t been trained in ${worst.days} days.`;
}

// ---------------------------------------------------------------------------
// SVG body (front + back). Simple geometric silhouette, one shape per region.
// ---------------------------------------------------------------------------

const ARMS = '<rect x="18" y="55" width="11" height="26" rx="5.5"/><rect x="91" y="55" width="11" height="26" rx="5.5"/>';
const SHOULDERS = '<ellipse cx="30" cy="46" rx="9" ry="8"/><ellipse cx="90" cy="46" rx="9" ry="8"/>';
const CALVES = '<rect x="42" y="158" width="14" height="40" rx="6"/><rect x="64" y="158" width="14" height="40" rx="6"/>';

const FRONT = {
  Shoulders: SHOULDERS,
  Chest: '<path d="M42 40 Q60 36 78 40 L76 58 Q60 64 44 58Z"/>',
  Biceps: ARMS,
  Core: '<rect x="46" y="62" width="28" height="36" rx="9"/>',
  Quads: '<rect x="41" y="102" width="17" height="52" rx="8"/><rect x="62" y="102" width="17" height="52" rx="8"/>',
  Calves: CALVES,
};
const BACK = {
  Shoulders: SHOULDERS,
  Back: '<path d="M42 40 Q60 34 78 40 L74 82 Q60 90 46 82Z"/>',
  Triceps: ARMS,
  Glutes: '<ellipse cx="50" cy="96" rx="11" ry="10"/><ellipse cx="70" cy="96" rx="11" ry="10"/>',
  Hamstrings: '<rect x="41" y="110" width="17" height="46" rx="8"/><rect x="62" y="110" width="17" height="46" rx="8"/>',
  Calves: CALVES,
};

const SILHOUETTE = `<circle class="bm-base" cx="60" cy="18" r="11"/>
  <path class="bm-base" d="M40 36 Q60 30 80 36 L84 44 L98 52 L100 84 L92 86 L88 62 L84 60 L78 100 L80 108 L82 156 L80 200 L62 200 L60 150 L58 200 L40 200 L38 156 L40 108 L42 100 L36 60 L32 62 L28 86 L20 84 L22 52 L36 44Z"/>`;

function figure(title, shapes, sets) {
  const parts = Object.entries(shapes)
    .map(([region, svg]) => `<g class="bm-region bm-l${loadLevel(sets[region] || 0)}" data-region="${region}"><title>${region}: ${sets[region] || 0} sets</title>${svg}</g>`)
    .join('');
  return `<svg class="bm-fig" viewBox="0 0 120 206" role="img" aria-label="${title}">${SILHOUETTE}${parts}</svg>`;
}

export function bodyMapMarkup(sets) {
  return `<div class="bm-wrap">
    <div class="bm-col">${figure('Front muscles', FRONT, sets)}<span class="bm-cap">Front</span></div>
    <div class="bm-col">${figure('Back muscles', BACK, sets)}<span class="bm-cap">Back</span></div>
  </div>`;
}
