/**
 * Gym — V1.4 redesign. "Choose the workout I am doing today", not a form.
 *
 * Hierarchy:
 *   streak summary → RESUME banner (unfinished session) → MY WORKOUTS
 *   (templates, start-first) → Start Empty → recent history → personal bests
 *   → weekly volume → progress photos link (all existing content preserved).
 *
 * The legacy quick-log sheet stays available via #/gym/new (dashboard quick
 * action + smoke/QA drivers) — it now opens the empty-workout session flow,
 * which is strictly more capable than the old form.
 */
import * as gym from '../gym.js';
import * as gymT from '../gymTemplates.js';
import { checkAchievementsNow } from '../celebration.js';
import { gymWeightUnit } from '../models.js';
import { getSettings } from '../settings.js';
import * as photos from '../photos.js';
import * as ui from '../ui.js';
import { muscleSets, bodyMapMarkup, neglectNote, REGIONS, loadLevel } from '../bodyMap.js';
import { estimate1RM, plateBreakdown } from '../gymTools.js';
import { go } from '../router.js';
import { formatDate, formatDuration, todayKey } from '../utils.js';

export async function mount(root, params) {
  photos.revokePhotoUrls();
  const [workouts, templates, active, photoList] = await Promise.all([
    gym.getAllWorkouts(),
    gymT.getTemplates(),
    gymT.getActiveWorkout(),
    photos.getAllPhotos(),
  ]);
  const state = { workouts, templates, active, photoCount: photoList.length, expanded: new Set() };
  render(root, state);
}

function render(root, state) {
  const { workouts, templates, active } = state;
  const stats = gym.gymStats(workouts);
  const volume = gym.weeklyVolume(workouts, 8);
  const maxMinutes = Math.max(...volume.map((v) => v.minutes), 1);
  const prs = gym.personalRecords(workouts);
  const unit = gymWeightUnit(getSettings());

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Gym</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Stronger than yesterday</div>
      </div>
      ${stats.streak > 0 ? `<span class="pill pill-accent" style="font-size:var(--fs-sm)">${ui.icon('flame', 14)} ${stats.streak} day streak</span>` : ''}
    </header>

    <section class="section stagger">
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${stats.streak}</div><div class="stat-label">Streak</div></div>
        <div class="stat"><div class="stat-value">${stats.total}</div><div class="stat-label">Workouts</div></div>
        <div class="stat"><div class="stat-value">${stats.thisMonth}</div><div class="stat-label">This month</div></div>
      </div>
      <div class="muted" style="text-align:center;font-size:var(--fs-sm);font-weight:600;margin-top:8px">${stats.thisWeek} workout${stats.thisWeek === 1 ? '' : 's'} this week</div>
    </section>

    ${active ? resumeBanner(active) : ''}

    <section class="section stagger" aria-label="My workouts">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">My workouts</h3>
        ${templates.length ? `<button class="section-link" data-action="create-template">${ui.icon('plus', 14)} New</button>` : ''}
      </div>
      ${templates.length
        ? `<div class="flex-col">${templates.map((t) => templateCard(t, workouts)).join('')}</div>`
        : gymEmptyState(root)}
      <button class="btn btn-ghost btn-block stagger" data-action="start-empty" style="margin-top:var(--sp-3)">
        ${ui.icon('plus', 16)} Start empty workout
      </button>
    </section>

    ${workouts.length
      ? `<section class="section stagger">
          <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">Recent workouts</h3></div>
          <div class="flex-col">${workouts.slice(0, 5).map((w) => recentWorkoutCard(w, unit, state.expanded.has(w.id))).join('')}</div>
        </section>`
      : ''}

    ${workouts.length ? muscleMapSection(workouts, state.mapDays || 7) : ''}

    ${prs.length ? personalBestsSection(prs, unit) : ''}

    <section class="section stagger">
      <button class="btn btn-ghost btn-block" data-action="plate-calc">${ui.icon('dumbbell', 16)} Plate calculator</button>
    </section>

    ${workouts.length ? weeklyVolumeSection(volume, maxMinutes) : ''}

    <section class="section stagger">
      <div class="card card-interactive" data-action="open-photos">
        <div class="flex-between">
          <div class="flex-row" style="gap:10px">
            <div style="width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)">${ui.icon('camera', 20)}</div>
            <div>
              <div style="font-weight:700">Progress photos</div>
              <div class="muted" style="font-size:var(--fs-sm)">${state.photoCount} photo${state.photoCount === 1 ? '' : 's'} saved</div>
            </div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>
      </div>
    </section>
  `;

  ui.bindActions(root, {
    'create-template': () => go('gym/create'),
    'start-template': (d) => go(`gym/template/${d.id}`),
    'start-empty': () => go('gym/workout'),
    'resume-workout': () => go('gym/workout'),
    'discard-workout': async () => {
      const ok = await ui.openDialog({
        title: 'Discard workout?',
        message: 'Your unfinished session will be lost. Completed sets are not saved.',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
      await gymT.clearActiveWorkout();
      ui.toast('Workout discarded', 'info');
      mount(root, []);
    },
    'open-history-gym': () => go('history'),
    'plate-calc': () => openPlateCalc(),
    'map-days': (d) => {
      state.mapDays = Number(d.days) === 30 ? 30 : 7;
      render(root, state);
    },
    'open-photos': () => go('photos'),
    'open-template': (d) => go(`gym/template/${d.id}`),
    'workout-toggle': (d) => {
      if (state.expanded.has(d.id)) state.expanded.delete(d.id);
      else state.expanded.add(d.id);
      render(root, state);
    },
    'workout-delete': async (d) => {
      const workout = state.workouts.find((w) => w.id === d.id);
      const ok = await ui.openDialog({
        title: 'Delete workout?',
        message: `The ${workout.workoutType} workout from ${formatDate(workout.date)} will be removed.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await gym.deleteWorkout(d.id);
      state.workouts = state.workouts.filter((w) => w.id !== d.id);
      ui.toast('Workout deleted', 'info');
      render(root, state);
    },
  });
}

/** WELCOME BACK — unfinished session resume (§20). */
function resumeBanner(active) {
  const total = gymT.sessionExerciseCount(active);
  const done = active.exercises.filter((ex) => ex.sets.length && ex.sets.every((s) => s.done)).length;
  const minutes = Math.round((Date.now() - active.startedAt) / 60000);
  return `
    <div class="card gym-resume-card stagger" data-action="resume-workout" role="button" tabindex="0" aria-label="Continue unfinished workout ${ui.escapeHtml(active.templateName || '')}">
      <div class="flex-between">
        <div class="grow">
          <div class="flex-row" style="gap:8px">
            <span class="pill pill-warning">${ui.icon('timer', 12)} In progress · ${minutes} min</span>
          </div>
          <div style="font-weight:800;font-size:var(--fs-lg);margin-top:8px">${ui.escapeHtml(active.templateName || 'Workout')}</div>
          <div class="muted" style="font-size:var(--fs-sm);margin-top:2px">${done} / ${total} exercises completed</div>
        </div>
        <button class="btn btn-primary btn-sm" data-action="resume-workout">Continue</button>
      </div>
      <button class="gym-resume-discard" data-action="discard-workout">Discard workout</button>
    </div>`;
}

/** START → template card with focus + last-workout recency (§3). */
function templateCard(t, workouts) {
  const exerciseNames = t.exercises.map((e) => e.exerciseName);
  const last = workouts
    .filter((w) => w.exercises.some((ex) => exerciseNames.includes(ex.exerciseName)))
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const lastLabel = last
    ? `Last workout · ${last.date === todayKey() ? 'today' : formatDate(last.date, { short: true })}`
    : 'Not tried yet';
  const focusSub = t.exercises.length
    ? `${t.exercises.length} exercise${t.exercises.length === 1 ? '' : 's'} · ${ui.escapeHtml(t.focus)}`
    : 'No exercises yet';
  return `
    <div class="card card-tight gym-template-card card-interactive" data-action="start-template" data-id="${t.id}" role="button" tabindex="0" aria-label="Start ${ui.escapeHtml(t.name)}">
      <div class="flex-between">
        <div class="grow" style="min-width:0">
          <div style="font-weight:800;font-size:var(--fs-lg)">${ui.escapeHtml(t.name)}</div>
          <div class="muted" style="font-size:var(--fs-sm);margin-top:2px">${focusSub}</div>
          <div class="muted gym-template-last" style="font-size:var(--fs-xs);margin-top:4px">${ui.icon('timer', 11)} ${lastLabel}</div>
        </div>
        <span class="btn btn-primary btn-sm gym-start-btn">${ui.icon('chevron-right', 14)} Start</span>
      </div>
    </div>`;
}

function gymEmptyState(root) {
  const node = ui.el('div', { class: 'empty' }, [
    ui.el('div', { class: 'empty-icon' }, ui.icon('dumbbell', 30)),
    ui.el('div', { class: 'empty-title' }, 'Your gym journey starts here'),
    ui.el('div', { class: 'empty-sub' }, 'Build your workout once — we\'ll remember it for you. You won\'t have to enter your exercises every time.'),
    ui.el('button', { class: 'btn btn-primary', type: 'button', 'data-action': 'create-template' }, ui.icon('plus', 16) + ' Create workout'),
  ]);
  return node.outerHTML;
}

function recentWorkoutCard(w, unit, expanded) {
  return `
    <div class="card card-tight pressable" data-action="workout-toggle" data-id="${w.id}">
      <div class="flex-between">
        <div class="grow">
          <div class="flex-row" style="gap:8px;flex-wrap:wrap">
            ${w.templateName ? `<span class="pill pill-accent">${ui.escapeHtml(w.templateName)}</span>` : `<span class="pill">${ui.escapeHtml(w.workoutType)}</span>`}
            ${w.duration > 0 ? `<span class="pill">${formatDuration(w.duration)}</span>` : ''}
          </div>
          <div class="muted" style="font-size:var(--fs-sm);margin-top:6px">${w.date === todayKey() ? 'Today' : formatDate(w.date)} · ${w.exercises.length} exercise${w.exercises.length === 1 ? '' : 's'}</div>
        </div>
        <div class="flex-row" style="gap:6px">
          ${ui.icon('chevron-right', 18)}
          <button class="btn-icon" style="width:34px;height:34px" data-action="workout-delete" data-id="${w.id}" aria-label="Delete workout">${ui.icon('trash', 15)}</button>
        </div>
      </div>
      ${expanded ? `
        ${w.exercises.length ? `
        <div class="exercise-list">
          ${w.exercises.map((ex) => `
            <div class="exercise-row">
              <span class="ex-name">${ui.escapeHtml(ex.exerciseName)}</span>
              <span class="ex-detail">${ex.sets} × ${ex.reps}${ex.weight ? ` · ${ex.weight} ${unit}` : ''}</span>
            </div>`).join('')}
        </div>` : ''}
        ${w.notes ? `<div class="muted" style="font-size:var(--fs-sm);margin-top:8px">${ui.escapeHtml(w.notes)}</div>` : ''}
      ` : ''}
    </div>`;
}

function muscleMapSection(workouts, days) {
  const sets = muscleSets(workouts, days);
  const note = neglectNote(workouts);
  const total = REGIONS.reduce((t, r) => t + sets[r], 0);
  const ranked = REGIONS.filter((r) => sets[r] > 0).sort((a, b) => sets[b] - sets[a]);
  return `
    <section class="section stagger" aria-label="Muscle map">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Muscle map</h3>
        <div class="seg" style="max-width:150px">
          <button class="seg-item" data-action="map-days" data-days="7" aria-selected="${days === 7}">7d</button>
          <button class="seg-item" data-action="map-days" data-days="30" aria-selected="${days === 30}">30d</button>
        </div>
      </div>
      <div class="card">
        ${total ? bodyMapMarkup(sets) : `<div class="muted" style="text-align:center;padding:16px 8px;font-size:var(--fs-sm)">No sets logged in the last ${days} days. Finish a workout to light up your map.</div>`}
        ${total ? `<div class="bm-legend" aria-hidden="true">Less <i class="bm-sw bm-l1"></i><i class="bm-sw bm-l2"></i><i class="bm-sw bm-l3"></i><i class="bm-sw bm-l4"></i> More</div>` : ''}
        ${ranked.length ? `<div class="bm-rank">${ranked.slice(0, 5).map((r) => `<span class="pill">${r} · ${sets[r]} sets</span>`).join('')}</div>` : ''}
        ${note ? `<div class="bm-note">${ui.icon('sparkles', 14)} ${ui.escapeHtml(note)}</div>` : ''}
      </div>
    </section>`;
}

function openPlateCalc() {
  ui.openSheet(() => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Plate calculator'));
    const input = ui.el('input', { class: 'input', type: 'number', inputmode: 'decimal', min: '0', step: '2.5', placeholder: 'Target weight (kg)' });
    const bar = ui.el('select', { class: 'select' }, [20, 15, 10].map((b) => ui.el('option', { value: String(b) }, `${b} kg bar`)));
    const out = ui.el('div', { class: 'plate-out', 'aria-live': 'polite' }, 'Enter a weight to see the plates for each side.');
    const update = () => {
      const r = plateBreakdown(Number(input.value), Number(bar.value));
      if (!(Number(input.value) > 0)) {
        out.textContent = 'Enter a weight to see the plates for each side.';
      } else if (r.belowBar) {
        out.textContent = `That is lighter than the ${bar.value} kg bar.`;
      } else {
        const counts = new Map();
        for (const p of r.perSide) counts.set(p, (counts.get(p) || 0) + 1);
        out.innerHTML = `<div class="plate-row">${r.perSide.length ? r.perSide.map((p) => `<span class="plate p${String(p).replace('.', '_')}">${p}</span>`).join('') : '<span class="muted">Just the bar</span>'}</div>
          <div class="muted" style="font-size:var(--fs-sm);margin-top:8px">Per side: ${[...counts.entries()].map(([p, n]) => `${n}×${p}`).join(' + ') || 'none'}. Total ${r.achieved} kg${r.remainder ? ` (${r.remainder} kg short: smallest plate is 1.25)` : ''}.</div>`;
      }
    };
    input.addEventListener('input', update);
    bar.addEventListener('change', update);
    wrap.append(input, bar, out);
    return wrap;
  });
}

function personalBestsSection(prs, unit) {
  return `
    <section class="section stagger">
      <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">Personal bests</h3></div>
      <div class="card card-tight">
        ${prs.map((r) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${ui.escapeHtml(r.name)}</div>
              <div class="row-sub">${formatDate(r.date, { short: true })}</div>
            </div>
            <span style="font-weight:800;font-variant-numeric:tabular-nums">${r.weight} ${unit}</span>
            <span class="muted" style="font-size:var(--fs-sm)">× ${r.reps}${estimate1RM(r.weight, r.reps) > r.weight ? ` · est. 1RM ${estimate1RM(r.weight, r.reps)}` : ''}</span>
          </div>`).join('')}
      </div>
    </section>`;
}

function weeklyVolumeSection(volume, maxMinutes) {
  return `
    <section class="section stagger">
      <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">Weekly volume</h3></div>
      <div class="card">
        <div class="bars" style="height:130px">
          ${volume.map((v) => `
            <div class="bar-col">
              <div class="bar-value">${v.minutes > 0 ? `${Math.round(v.minutes / 60 * 10) / 10}h` : ''}</div>
              <div class="bar ${v.minutes > 0 ? 'done' : ''}" data-volbar style="height:${Math.max(2, (v.minutes / maxMinutes) * 100)}%"></div>
              <div class="bar-label">${v.label}</div>
            </div>`).join('')}
        </div>
      </div>
    </section>`;
}
