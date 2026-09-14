/**
 * V1.4 — Active workout session. Set-based, tap-first logging (§8–§22).
 *
 * One exercise block at a time, each with per-set rows (weight · reps ·
 * completion circle). Values are PRE-FILLED from the last completed workout
 * containing each exercise (§9) — the user only changes what changed today.
 *
 * Reload-safe: every mutation persists the singleton active record, so an
 * unfinished session survives reload/offline (§20). Completing converts the
 * session into a real historical workout (existing stores), deletes the
 * active record, evaluates achievements, and shows the completion summary
 * with TODAY vs LAST TIME + real PR detection (§17, §22).
 */
import * as gym from '../gym.js';
import * as gymT from '../gymTemplates.js';
import { sessionCompletable, MUSCLE_GROUPS } from '../models.js';
import { checkAchievementsNow } from '../celebration.js';
import { getSettings } from '../settings.js';
import * as ui from '../ui.js';
import { go, registerCleanup } from '../router.js';
import { formatDate } from '../utils.js';

export async function mount(root, params) {
  let session = await gymT.getActiveWorkout();

  // No active session → decide how to start one.
  if (!session) {
    if (params[0] === 'empty') {
      session = gymT.buildEmptySession();
    } else {
      // Default: the most recently used template (or first), pre-filled.
      const templates = await gymT.getTemplates();
      const template = templates[0] || null;
      if (template) {
        const workouts = await gym.getAllWorkouts();
        session = gymT.buildSessionFromTemplate(template, workouts);
      } else {
        session = gymT.buildEmptySession();
      }
    }
    await gymT.persistActiveWorkout(session);
  }

  const workouts = await gym.getAllWorkouts();
  const state = { session, workouts, timerHandle: null, restHandle: null, restLeft: 0 };
  render(root, state);
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(root, state) {
  const { session } = state;
  clearInterval(state.timerHandle);
  stopRest(state);
  state.timerHandle = startElapsedTimer(root, session);
  // Timers must never survive a navigation (same contract as the camera).
  registerCleanup(() => {
    clearInterval(state.timerHandle);
    stopRest(state);
  });

  root.innerHTML = `
    <header class="gym-session-header" style="margin-top:var(--sp-2)">
      <button class="btn-icon" data-action="back" aria-label="Back to Gym">${ui.icon('arrow-left', 20)}</button>
      <div class="grow" style="text-align:center;min-width:0">
        <h2 style="font-size:var(--fs-lg);font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${ui.escapeHtml(session.templateName || 'Workout')}</h2>
        <div class="gym-elapsed muted" style="font-size:var(--fs-sm);font-weight:700;font-variant-numeric:tabular-nums" aria-live="off">00:00</div>
      </div>
      <button class="btn btn-primary btn-sm" data-action="finish" ${sessionCompletable(session) ? '' : 'disabled'}>Finish</button>
    </header>

    <div id="gym-rest-root"></div>

    <div id="gym-exercise-list"></div>

    <section class="section stagger">
      <button class="btn btn-ghost btn-block" data-action="add-exercise">${ui.icon('plus', 16)} Add exercise</button>
    </section>

    <section class="section stagger">
      <div class="field">
        <label class="field-label" for="gym-notes">Notes <span class="muted" style="font-weight:500">(optional)</span></label>
        <textarea class="textarea" id="gym-notes" style="min-height:56px" placeholder="Felt strong today…">${ui.escapeHtml(session.notes || '')}</textarea>
      </div>
    </section>

    <div style="height:120px"></div>
    <div class="gym-sticky-actions">
      <button class="btn btn-primary btn-block" data-action="finish" ${sessionCompletable(session) ? '' : 'disabled'}>
        ${ui.icon('check', 18)} Complete workout
      </button>
    </div>
  `;

  renderExercises(root, state);

  root.querySelector('#gym-notes').addEventListener('change', async (e) => {
    state.session.notes = e.target.value.trim();
    await gymT.persistActiveWorkout(state.session);
  });

  ui.bindActions(root, {
    back: () => go('gym'), // session stays persisted → resume banner
    'add-exercise': () => openAddExercise(root, state),
    finish: () => finishWorkout(root, state),
  });
}

function startElapsedTimer(root, session) {
  const node = () => root.querySelector('.gym-elapsed');
  const tick = () => {
    const el = node();
    if (el) el.textContent = gymT.formatElapsed(Date.now() - session.startedAt);
  };
  tick();
  return setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Exercise blocks + set rows
// ---------------------------------------------------------------------------

function renderExercises(root, state) {
  const list = root.querySelector('#gym-exercise-list');
  const { session, workouts } = state;

  list.replaceChildren(
    ...session.exercises.map((ex, exIndex) => {
      const last = gymT.lastTimeForExercise(workouts, ex.exerciseName);
      const bestToday = ex.sets.reduce(
        (b, s) => (!b || s.weight > b.weight || (s.weight === b.weight && s.reps > b.reps) ? { weight: s.weight, reps: s.reps } : b),
        null
      );
      const prevBest = last ? last.rows.reduce((b, r) => (!b || r.weight > b.weight || (r.weight === b.weight && r.reps > b.reps) ? r : b), null) : null;

      const card = ui.el('section', { class: 'card card-tight gym-exercise stagger', 'aria-label': ex.exerciseName });
      card.innerHTML = `
        <div class="flex-between">
          <div class="flex-row" style="gap:8px;min-width:0">
            <span class="gym-order-num" aria-hidden="true">${exIndex + 1}</span>
            <div style="min-width:0">
              <div style="font-weight:800;font-size:var(--fs-lg)">${ui.escapeHtml(ex.exerciseName)}</div>
              ${last ? `<div class="gym-last-line muted" style="font-size:var(--fs-xs);margin-top:2px">Last time ${last.rows[0].weight ? `${gymT.formatWeight(last.rows[0].weight)} kg × ${last.rows[0].reps}` : `${last.rows[0].reps} reps`} × ${last.rows.length}</div>` : '<div class="gym-last-line muted" style="font-size:var(--fs-xs);margin-top:2px">First time — set the baseline</div>'}
            </div>
          </div>
          ${beatPill(bestToday, prevBest)}
        </div>
        <div class="gym-set-header" aria-hidden="true">
          <span>SET</span><span>KG</span><span>REPS</span><span></span>
        </div>
        <div class="gym-set-list" role="list" aria-label="${ui.escapeHtml(ex.exerciseName)} sets"></div>
        <div class="flex-row" style="gap:8px;margin-top:10px">
          <button class="btn btn-ghost btn-sm" data-role="add-set">${ui.icon('plus', 14)} Add set</button>
          <span class="spacer"></span>
          <button class="btn-icon" style="width:36px;height:36px" data-role="move-up" aria-label="Move ${ui.escapeHtml(ex.exerciseName)} up" ${exIndex === 0 ? 'disabled' : ''}>${ui.icon('arrow-left', 14)}</button>
          <button class="btn-icon" style="width:36px;height:36px" data-role="move-down" aria-label="Move ${ui.escapeHtml(ex.exerciseName)} down" ${exIndex === session.exercises.length - 1 ? 'disabled' : ''}>${ui.icon('chevron-right', 14)}</button>
          <button class="btn-icon" style="width:36px;height:36px" data-role="skip" aria-label="Skip ${ui.escapeHtml(ex.exerciseName)} today">${ui.icon('x', 14)}</button>
        </div>
      `;

      const setList = card.querySelector('.gym-set-list');
      ex.sets.forEach((set, i) => setList.append(setRow(root, state, ex, i, set, prevBest)));

      card.querySelector('[data-role="add-set"]').addEventListener('click', () => {
        mutate(root, state, gymT.addSet(state.session, ex.id));
      });
      card.querySelector('[data-role="skip"]').addEventListener('click', async () => {
        const ok = await ui.openDialog({
          title: `Skip ${ex.exerciseName}?`,
          message: 'It stays in your workout plan — only today\'s session drops it.',
          confirmLabel: 'Skip today',
        });
        if (ok) mutate(root, state, gymT.removeSessionExercise(state.session, ex.id));
      });
      card.querySelector('[data-role="move-up"]').addEventListener('click', () => {
        mutate(root, state, gymT.moveSessionExercise(state.session, ex.id, -1));
      });
      card.querySelector('[data-role="move-down"]').addEventListener('click', () => {
        mutate(root, state, gymT.moveSessionExercise(state.session, ex.id, +1));
      });
      return card;
    })
  );

  if (!session.exercises.length) {
    const empty = ui.el('div', { class: 'empty', style: { marginTop: '16px' } }, [
      ui.el('div', { class: 'empty-icon' }, ui.icon('dumbbell', 30)),
      ui.el('div', { class: 'empty-title' }, 'Empty workout'),
      ui.el('div', { class: 'empty-sub' }, 'Add your first exercise below — sets and weights start simple.'),
    ]);
    list.append(empty);
  }
}

/**
 * One set row: − [ editable input ] unit +  for weight and reps, tap-to-
 * complete circle, and a guarded remove action (V1.4.1). The value between
 * the steppers is a REAL number input — tap, type, replace, delete — with
 * 0.5 kg weight precision preserved. Empty input shows a visible dash
 * placeholder; persistence happens on change/blur (controlled writes).
 */
function setRow(root, state, ex, index, set, prevBest) {
  const row = ui.el('div', { class: `gym-set-row${set.done ? ' done' : ''}`, role: 'listitem' });
  row.innerHTML = `
    <span class="gym-set-label">Set ${index + 1}</span>
    <div class="gym-stepper" data-kind="weight">
      <button class="gym-step-btn" data-dir="-1" aria-label="Decrease weight">−</button>
      <input class="gym-step-input" type="number" inputmode="decimal" step="0.5" min="0" value="${set.weight || ''}" placeholder="—" aria-label="Weight in kilograms for set ${index + 1}">
      <span class="gym-step-unit">kg</span>
      <button class="gym-step-btn" data-dir="1" aria-label="Increase weight">+</button>
    </div>
    <div class="gym-stepper" data-kind="reps">
      <button class="gym-step-btn" data-dir="-1" aria-label="Decrease reps">−</button>
      <input class="gym-step-input" type="number" inputmode="numeric" step="1" min="0" value="${set.reps || ''}" placeholder="—" aria-label="Reps for set ${index + 1}">
      <span class="gym-step-unit">reps</span>
      <button class="gym-step-btn" data-dir="1" aria-label="Increase reps">+</button>
    </div>
    <div class="gym-set-actions">
      <button class="gym-set-toggle" aria-pressed="${set.done}" aria-label="${set.done ? `Set ${index + 1} completed — tap to unmark` : `Complete set ${index + 1}`}">
        ${set.done ? ui.icon('check', 15) : ''}
      </button>
      <button class="gym-set-remove" aria-label="Remove set ${index + 1}" ${ex.sets.length <= 1 ? 'disabled' : ''} title="Remove set">${ui.icon('trash', 13)}</button>
    </div>
  `;

  // Steppers: ± with sensible gym increments; the input commits on
  // change/blur so a mid-edit empty value never persists.
  row.querySelectorAll('.gym-stepper').forEach((stepper) => {
    const kind = stepper.dataset.kind;
    const input = stepper.querySelector('.gym-step-input');
    stepper.querySelectorAll('.gym-step-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dir = Number(btn.dataset.dir);
        const current = Number(input.value) || 0;
        let next;
        if (kind === 'weight') next = gymT.stepWeight(current, dir);
        else next = Math.max(0, current + dir);
        input.value = next || '';
        commitInput();
      });
    });
    input.addEventListener('change', commitInput);
    input.addEventListener('blur', commitInput);

    function commitInput() {
      // Empty/invalid → 0 (inline-safe: no crash while the user clears the
      // field mid-edit; change/blur only fire when editing ends).
      const val = Number(input.value) || 0;
      const patch = kind === 'weight' ? { weight: val } : { reps: val };
      state.session = gymT.updateSet(state.session, ex.id, index, patch);
      gymT.persistActiveWorkout(state.session); // reload-safe (fire-and-forget)
    }
  });

  // Remove this set (guarded): min one set per exercise, confirm via dialog,
  // only ever touches the ACTIVE session — history is never modified.
  row.querySelector('.gym-set-remove').addEventListener('click', async () => {
    if (ex.sets.length <= 1) return; // keep the data model valid (min-1 rule)
    const ok = await ui.openDialog({
      title: `Remove set ${index + 1}?`,
      message: 'Only this set is removed — the other sets keep their values.',
      confirmLabel: 'Remove set',
      danger: true,
    });
    if (!ok) return;
    mutate(root, state, gymT.removeSet(state.session, ex.id, index));
  });

  // Tap the row's circle to complete the set (§18): immediate feedback +
  // subtle animation + rest timer.
  row.querySelector('.gym-set-toggle').addEventListener('click', () => {
    state.session = gymT.toggleSet(state.session, ex.id, index);
    gymT.persistActiveWorkout(state.session);
    ui.haptic(set.done ? 5 : 12);

    const next = !set.done;
    if (next) {
      row.classList.add('done');
      row.querySelector('.gym-set-toggle').innerHTML = ui.icon('check', 15);
      row.querySelector('.gym-set-toggle').setAttribute('aria-pressed', 'true');
      row.querySelector('.gym-set-toggle').setAttribute('aria-label', `Set ${index + 1} completed — tap to unmark`);
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        row.style.animation = 'gymSetDone 320ms var(--spring)';
        setTimeout(() => (row.style.animation = ''), 340);
      }
      maybeStartRest(state);
    } else {
      row.classList.remove('done');
      row.querySelector('.gym-set-toggle').innerHTML = '';
      row.querySelector('.gym-set-toggle').setAttribute('aria-pressed', 'false');
      row.querySelector('.gym-set-toggle').setAttribute('aria-label', `Complete set ${index + 1}`);
    }
  });

  return row;
}

/** Subtle "beat last time" pill (§16) — only when there is something to say. */
function beatPill(bestToday, prevBest) {
  if (!bestToday || (!bestToday.weight && !bestToday.reps)) return '';
  if (!prevBest) return '';
  const dw = Math.round((bestToday.weight - prevBest.weight) * 10) / 10;
  const dr = bestToday.reps - prevBest.reps;
  if (dw > 0) return `<span class="pill pill-success gym-beat-pill">+${gymT.formatWeight(dw)} kg</span>`;
  if (dw < 0) return `<span class="pill gym-beat-pill">${gymT.formatWeight(dw)} kg</span>`;
  if (dr > 0) return `<span class="pill pill-success gym-beat-pill">+${dr} reps</span>`;
  if (dr < 0) return `<span class="pill gym-beat-pill">${dr} reps</span>`;
  return '';
}

/** Apply a session mutation, persist, and re-render just the exercise list. */
function mutate(root, state, nextSession) {
  state.session = nextSession;
  gymT.persistActiveWorkout(state.session);
  renderExercises(root, state);
  // Refresh Finish buttons' disabled state.
  root.querySelectorAll('[data-action="finish"]').forEach((btn) => {
    btn.disabled = !sessionCompletable(state.session);
  });
}

// ---------------------------------------------------------------------------
// Add exercise during workout (§14) — pre-filled from history when known
// ---------------------------------------------------------------------------

function openAddExercise(root, state) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Add exercise'));

    const search = ui.el('input', {
      class: 'input', type: 'search', placeholder: 'Search or type an exercise…',
      'aria-label': 'Search exercises', autocomplete: 'off',
    });
    const grid = ui.el('div', { class: 'gym-pick-grid', role: 'listbox', 'aria-label': 'Exercise results' });
    wrap.append(search, grid);

    const add = async (name) => {
      // Duplicate guard (§18): adding an exercise already in today's session
      // must never create a second block.
      if (state.session.exercises.some((e) => e.exerciseName.toLowerCase() === name.toLowerCase())) {
        ui.toast(`${name} is already in this workout`, 'info');
        close();
        return;
      }
      await gymT.touchLibrary([name]);
      // Pre-fill from the exercise's most recent history where appropriate (§14).
      const history = gymT.lastTimeForExercise(state.workouts, name);
      const prefill = history ? history.rows.map((r) => ({ weight: r.weight, reps: r.reps })) : null;
      const next = gymT.addSessionExercise(state.session, name, prefill);
      close();
      mutate(root, state, next);
    };

    const render = async (q = '') => {
      const query = q.trim().toLowerCase();
      const inSession = new Set(state.session.exercises.map((e) => e.exerciseName.toLowerCase()));
      const library = await gymT.getLibrary();
      const historyNames = state.workouts.reduce((acc, w) => {
        for (const ex of w.exercises || []) if (!acc.includes(ex.exerciseName)) acc.push(ex.exerciseName);
        return acc;
      }, []);
      const pool = [
        ...library.map((e) => ({ name: e.name, sub: e.muscleGroup, tag: 'My exercise' })),
        ...historyNames.map((n) => ({ name: n, sub: gymT.guessMuscleGroup(n), tag: 'Recent' })),
        ...gymT.SUGGESTED_EXERCISES.map((n) => ({ name: n, sub: gymT.guessMuscleGroup(n), tag: '' })),
      ];
      const seen = new Set();
      const items = pool.filter((item) => {
        const key = item.name.toLowerCase();
        if (seen.has(key) || inSession.has(key)) return false;
        if (query && !key.includes(query)) return false;
        seen.add(key);
        return true;
      });
      grid.replaceChildren(
        ...items.slice(0, 20).map((item) => {
          const btn = ui.el('button', { class: 'gym-pick-item', type: 'button', role: 'option' });
          btn.innerHTML = `
            <span class="gym-pick-name">${ui.escapeHtml(item.name)}</span>
            ${item.tag ? `<span class="gym-pick-sub">${item.tag}</span>` : ''}`;
          btn.addEventListener('click', () => add(item.name));
          return btn;
        })
      );
      if (!items.length && query) {
        const empty = ui.el('div', { class: 'muted', style: { padding: '10px 2px', fontSize: 'var(--fs-sm)' } }, `No match — create it below or press Enter`);
        grid.append(empty);
      }
    };

    // + Create New Exercise (V1.4.1): library-backed custom exercises.
    const createBtn = ui.el('button', { class: 'btn btn-ghost btn-block gym-pick-create', type: 'button' }, `${ui.icon('plus', 16)} Create New Exercise`);
    createBtn.addEventListener('click', () => openCreateExercise({ onCreate: (name) => { close(); add(name); } }));
    wrap.append(createBtn);

    search.addEventListener('input', () => render(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && search.value.trim()) add(search.value.trim());
    });
    render();
    return wrap;
  });
}

/**
 * CREATE EXERCISE sheet (V1.4.1 §11–§18): name required, optional muscle
 * group, duplicate-safe, saved into the existing exerciseLibrary so it
 * appears in every future picker. Sets/reps/weight belong to the session,
 * never to creation.
 */
export function openCreateExercise({ onCreate }) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Create exercise'));

    const nameInput = ui.el('input', {
      class: 'input', type: 'text', placeholder: 'e.g. Cable Chest Fly', maxlength: '48',
      'aria-label': 'Exercise name', autocomplete: 'off',
    });
    const muscleSelect = ui.el('select', { class: 'select', 'aria-label': 'Muscle group (optional)' },
      ['Auto', ...MUSCLE_GROUPS].map((g) => `<option value="${g === 'Auto' ? '' : g}">${g}</option>`).join('')
    );
    const addBtn = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Add Exercise');
    const hint = ui.el('div', { class: 'muted', style: { fontSize: 'var(--fs-xs)', minHeight: '16px' } });
    wrap.append(nameInput, muscleSelect, addBtn, hint);

    const submit = async () => {
      const result = await gymT.createCustomExercise(nameInput.value, muscleSelect.value || null);
      if (result.error) {
        hint.textContent = result.existing ? `${result.error} Selecting it.` : result.error;
        if (result.existing && onCreate) onCreate(result.existing.name); // duplicate → use it
        return;
      }
      ui.toast(`${result.entry.name} saved to your exercises`, 'success');
      close();
      if (onCreate) onCreate(result.entry.name);
    };
    addBtn.addEventListener('click', submit);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    setTimeout(() => nameInput.focus(), 80);
    return wrap;
  });
}

// ---------------------------------------------------------------------------
// Rest timer (§19) — lightweight, non-blocking, dismissible
// ---------------------------------------------------------------------------

function maybeStartRest(state) {
  const settings = getSettings();
  if (!settings.restAutoStart || !settings.restTimerSeconds) return;
  startRest(state, settings.restTimerSeconds);
}

function startRest(state, seconds) {
  clearInterval(state.restHandle);
  state.restLeft = seconds;
  const root = document.getElementById('gym-rest-root') || document.getElementById('screen-root');
  const host = document.getElementById('gym-rest-root');
  if (!host) return;
  host.innerHTML = `
    <div class="gym-rest" role="timer" aria-live="off">
      <span class="gym-rest-label">REST</span>
      <span class="gym-rest-clock">${gymT.formatElapsed(state.restLeft * 1000)}</span>
      <button class="btn btn-ghost btn-sm" data-rest="add">+30s</button>
      <button class="btn btn-ghost btn-sm" data-rest="skip">Skip</button>
    </div>`;

  const paint = () => {
    const clock = host.querySelector('.gym-rest-clock');
    if (clock) clock.textContent = gymT.formatElapsed(state.restLeft * 1000);
  };
  clearInterval(state.restHandle);
  state.restHandle = setInterval(() => {
    state.restLeft -= 1;
    if (state.restLeft <= 0) return stopRest(state);
    paint();
  }, 1000);

  host.querySelector('[data-rest="add"]').addEventListener('click', () => {
    state.restLeft += 30;
    paint();
  });
  host.querySelector('[data-rest="skip"]').addEventListener('click', () => stopRest(state));
}

function stopRest(state) {
  clearInterval(state.restHandle);
  state.restHandle = null;
  const host = document.getElementById('gym-rest-root');
  if (host) host.replaceChildren();
}

// ---------------------------------------------------------------------------
// Completion (§22) — summary, real PRs, historical workout, achievements
// ---------------------------------------------------------------------------

async function finishWorkout(root, state) {
  if (!sessionCompletable(state.session)) return;
  stopRest(state);
  clearInterval(state.timerHandle);

  const session = state.session;
  const workoutsBefore = state.workouts;
  const workout = gymT.completeSession(session);
  const prs = gymT.sessionPRs(session, workoutsBefore);
  const last = gymT.lastWorkoutBeforeToday(workoutsBefore);
  const lastVolume = last ? (last.exercises || []).reduce((a, ex) => a + (ex.weight || 0) * (ex.reps || 0) * (ex.sets || 1), 0) : 0;
  const volume = gymT.sessionVolume(session);
  const volumeDeltaPct = lastVolume > 0 ? Math.round(((volume - lastVolume) / lastVolume) * 100) : null;

  // Persist: historical workout + delete active record (+ streak/achievements).
  // Wrapped so a storage failure can never strand the user on the session
  // screen without feedback (the summary renders only after success).
  try {
    await gym.addWorkout(workout);
    await gymT.clearActiveWorkout();
    if (session.templateId) await gymT.markTemplateUsed(session.templateId).catch(() => {});
  } catch (err) {
    console.error('[LifeProgress] Failed to save completed workout', err);
    ui.toast('Could not save the workout — please try again.', 'danger');
    return;
  }
  checkAchievementsNow(); // existing system — fire-and-forget

  renderSummary(root, { session, workout, prs, volumeDeltaPct });
}

function renderSummary(root, { session, workout, prs, volumeDeltaPct }) {
  const setCount = gymT.sessionSetCount(session);
  const exCount = gymT.sessionExerciseCount(session);
  const prNames = new Set(prs.map((p) => p.exerciseName.toLowerCase()));

  root.innerHTML = `
    <section class="gym-summary stagger">
      <div class="gym-summary-badge" aria-hidden="true">🎉</div>
      <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Workout complete</h2>
      <div class="muted" style="font-size:var(--fs-md);font-weight:600;margin-top:4px">${ui.escapeHtml(session.templateName || 'Workout')} · ${formatDate(workout.date)}</div>

      <div class="stat-grid" style="margin-top:var(--sp-5)">
        <div class="stat"><div class="stat-value">${workout.duration}<span style="font-size:var(--fs-sm)"> min</span></div><div class="stat-label">Duration</div></div>
        <div class="stat"><div class="stat-value">${exCount}</div><div class="stat-label">Exercises</div></div>
        <div class="stat"><div class="stat-value">${setCount}</div><div class="stat-label">Sets</div></div>
      </div>

      ${volumeDeltaPct != null ? `
      <div class="card card-tight" style="margin-top:var(--sp-4)">
        <div class="flex-between">
          <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Volume vs last time</div>
          <span class="pill ${volumeDeltaPct >= 0 ? 'pill-success' : ''}" style="font-size:var(--fs-md)">${volumeDeltaPct >= 0 ? '+' : ''}${volumeDeltaPct}%</span>
        </div>
      </div>` : ''}

      ${prs.length ? `
      <div class="card card-tight" style="margin-top:var(--sp-3);border-color:color-mix(in srgb,var(--warning) 35%,transparent)">
        <div class="flex-row" style="gap:8px;margin-bottom:6px">
          <span class="pill pill-warning">NEW PERSONAL RECORD</span>
        </div>
        ${prs.map((pr) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${ui.escapeHtml(pr.exerciseName)}</div>
              <div class="row-sub">Previous best ${gymT.formatWeight(pr.previousWeight)} kg × ${pr.previousReps}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:800;font-variant-numeric:tabular-nums">${gymT.formatWeight(pr.weight)} kg × ${pr.reps}</div>
              <div class="pill pill-success" style="margin-top:2px">${pr.weightDelta > 0 ? `+${gymT.formatWeight(pr.weightDelta)} kg` : `+${pr.repsDelta} reps`} 🔥</div>
            </div>
          </div>`).join('')}
      </div>` : ''}

      <div class="card card-tight" style="margin-top:var(--sp-3)">
        ${workout.exercises.map((ex) => `
          <div class="exercise-row">
            <span class="ex-name">${ui.escapeHtml(ex.exerciseName)}${prNames.has(ex.exerciseName.toLowerCase()) ? ' 🔥' : ''}</span>
            <span class="ex-detail">${ex.sets} × ${ex.reps}${ex.weight ? ` · ${gymT.formatWeight(ex.weight)} kg` : ''}</span>
          </div>`).join('')}
      </div>

      <button class="btn btn-primary btn-block" data-action="done" style="margin-top:var(--sp-5)">Done</button>
    </section>
  `;

  root.querySelector('[data-action="done"]').addEventListener('click', () => go('gym'));
}
