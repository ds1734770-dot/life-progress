/**
 * Gym — workout logging, exercises (sets/reps/weight), history,
 * weekly volume chart, personal records and stats.
 */
import { getSettings, saveSettings } from '../settings.js';
import * as gym from '../gym.js';
import { checkAchievementsNow } from '../celebration.js';
import { gymWeightUnit } from '../models.js';
import * as photos from '../photos.js';
import { WORKOUT_TYPES } from '../models.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { todayKey, formatDate, formatDuration } from '../utils.js';

export async function mount(root, params) {
  photos.revokePhotoUrls();
  const [workouts, photoList] = await Promise.all([gym.getAllWorkouts(), photos.getAllPhotos()]);
  const state = { workouts, photoCount: photoList.length, expanded: new Set() };
  render(root, state);
  if (params[0] === 'new') openWorkoutSheet(root, state);
}

function render(root, state) {
  const { workouts, photoCount } = state;
  const stats = gym.gymStats(workouts);
  const volume = gym.weeklyVolume(workouts, 8);
  const maxMinutes = Math.max(...volume.map((v) => v.minutes), 1);
  const prs = gym.personalRecords(workouts);

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

    <button class="btn btn-primary btn-block stagger" data-action="add-workout" style="margin-top:var(--sp-4)">
      ${ui.icon('plus', 18)} Log workout
    </button>

    ${workouts.length ? `
    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Weekly volume</h3>
      </div>
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
    </section>` : ''}

    ${prs.length ? `
    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Personal bests</h3>
      </div>
      <div class="card card-tight">
        ${prs.map((r) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${ui.escapeHtml(r.name)}</div>
              <div class="row-sub">${formatDate(r.date, { short: true })}</div>
            </div>
            <span style="font-weight:800;font-variant-numeric:tabular-nums">${r.weight} ${prUnit()}</span>
            <span class="muted" style="font-size:var(--fs-sm)">× ${r.reps}</span>
          </div>`).join('')}
      </div>
    </section>` : ''}

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Workout history</h3>
      </div>
      ${workouts.length
        ? `<div class="flex-col">${workouts.map((w) => workoutCard(w, state)).join('')}</div>`
        : ui.emptyState({
            iconName: 'dumbbell',
            title: 'Your fitness journey starts here',
            sub: 'Log your first workout and watch the progress build.',
            actionLabel: 'Log first workout',
            action: () => openWorkoutSheet(root, state),
          }).outerHTML}
    </section>

    <section class="section stagger">
      <div class="card card-interactive" data-action="open-photos">
        <div class="flex-between">
          <div class="flex-row" style="gap:10px">
            <div style="width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent) 12%,transparent);color:var(--accent)">${ui.icon('camera', 20)}</div>              <div>
                <div style="font-weight:700">Progress photos</div>
                <div class="muted" style="font-size:var(--fs-sm)">${photoCount} photo${photoCount === 1 ? '' : 's'} saved</div>
              </div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>
      </div>
    </section>
  `;

  ui.bindActions(root, {
    'add-workout': () => openWorkoutSheet(root, state),
    'open-photos': () => go('photos'),
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

function workoutCard(w, state) {
  const expanded = state.expanded.has(w.id);
  return `
    <div class="card card-tight pressable" data-action="workout-toggle" data-id="${w.id}">
      <div class="flex-between">
        <div class="grow">
          <div class="flex-row" style="gap:8px;flex-wrap:wrap">
            <span class="pill pill-accent">${ui.escapeHtml(w.workoutType)}</span>
            ${w.duration > 0 ? `<span class="pill">${formatDuration(w.duration)}</span>` : ''}
          </div>
          <div class="muted" style="font-size:var(--fs-sm);margin-top:6px">${w.date === todayKey() ? 'Today' : formatDate(w.date)}</div>
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
              <span class="ex-detail">${ex.sets} × ${ex.reps}${ex.weight ? ` · ${ex.weight} ${prUnit()}` : ''}</span>
            </div>`).join('')}
        </div>` : ''}
        ${w.notes ? `<div class="muted" style="font-size:var(--fs-sm);margin-top:8px">${ui.escapeHtml(w.notes)}</div>` : ''}
      ` : ''}
    </div>`;
}

function prUnit() {
  return gymWeightUnit(getSettings());
}

function openWorkoutSheet(root, state) {
  const today = todayKey();
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Log workout'));

    const date = ui.el('input', { class: 'input', type: 'date', value: today });
    const type = ui.el('select', { class: 'select' }, WORKOUT_TYPES.map((t) => ui.el('option', { value: t }, t)));
    type.value = getSettings().gymDefaultType || 'Strength';
    type.addEventListener('change', () => saveSettings({ gymDefaultType: type.value }));
    const duration = ui.el('input', { class: 'input', type: 'number', min: 0, placeholder: 'Duration (minutes)' });
    const notes = ui.el('textarea', { class: 'textarea', placeholder: 'Notes (optional)', style: { minHeight: 56 } });

    const exercisesWrap = ui.el('div', { class: 'flex-col' });
    function exerciseRow(ex = {}) {
      const row = ui.el('div', { class: 'form-grid' }, [
        ui.el('input', { class: 'input', placeholder: 'Exercise', value: ex.exerciseName || '', id: 'ex-name' }),
        ui.el('input', { class: 'input', type: 'number', min: 0, placeholder: 'Sets', value: ex.sets || '' }),
        ui.el('input', { class: 'input', type: 'number', min: 0, placeholder: 'Reps', value: ex.reps || '' }),
        ui.el('input', { class: 'input', type: 'number', min: 0, placeholder: 'Weight (kg)', value: ex.weight || '' }),
      ]);
      row.style.display = 'grid';
      return row;
    }
    exercisesWrap.append(exerciseRow());

    const addExercise = ui.el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, ui.icon('plus', 15) + ' Add exercise');
    addExercise.addEventListener('click', () => exercisesWrap.append(exerciseRow()));

    const error = ui.el('div', { style: { fontSize: 'var(--fs-sm)', color: 'var(--danger)', minHeight: 18 } });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save workout');
    save.addEventListener('click', async () => {
      const exercises = [...exercisesWrap.querySelectorAll(':scope > .form-grid')]
        .map((rowEl) => {
          const [nameEl, setsEl, repsEl, weightEl] = rowEl.querySelectorAll('input');
          return {
            exerciseName: nameEl.value,
            sets: Number(setsEl.value) || 0,
            reps: Number(repsEl.value) || 0,
            weight: Number(weightEl.value) || 0,
          };
        })
        .filter((ex) => ex.exerciseName || ex.sets || ex.reps || ex.weight);
      if (!exercises.length && !duration.value && !notes.value) {
        error.textContent = 'Add an exercise or a duration to log the session.';
        return;
      }
      const workout = await gym.addWorkout({
        date: date.value || today,
        workoutType: type.value,
        duration: Number(duration.value) || 0,
        notes: notes.value,
        exercises,
      });
      state.workouts = gym.sortWorkouts([workout, ...state.workouts]);
      checkAchievementsNow(); // V1.2: evaluate + celebrate (fire-and-forget)
      ui.haptic();
      ui.toast('Workout saved', 'success');
      close();
      render(root, state);
    });

    wrap.append(
      ui.el('div', { class: 'form-grid' }, [
        ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Date'), date]),
        ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Type'), type]),
      ]),
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Duration'), duration]),
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Exercises'), exercisesWrap, addExercise]),
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Notes'), notes]),
      error,
      save
    );
    return wrap;
  });
}