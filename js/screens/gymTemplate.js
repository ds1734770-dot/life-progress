/**
 * V1.4 — Template detail + create/edit.
 *
 * Detail view (§7): exercise sequence, last-time summary, START, and the
 * management actions (Edit / Rename / Duplicate / Delete with a proper
 * confirmation dialog — never alert()). Deleting a template never touches
 * historical workouts.
 *
 * Create/edit flow (§5): name → focus → exercises (library search, tap to
 * add, remove, drag-to-reorder). Existing data is pre-filled for edits.
 */
import * as gymT from '../gymTemplates.js';
import { TEMPLATE_FOCUSES } from '../models.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { formatDate, formatDuration } from '../utils.js';

export async function mount(root, params, mode) {
  const templateId = params[0] || null;
  // Explicit modes from the router keep 'create'/'edit' from being mistaken
  // for template ids; an id without a mode renders the detail view.
  if (mode === 'create') {
    await renderEditor(root, null);
    return;
  }
  if (templateId) {
    const template = await gymT.getTemplate(templateId);
    if (!template) {
      // §46 fallback — unknown template id degrades to a safe empty workout.
      ui.toast('Workout not found — starting an empty workout instead', 'info');
      go('gym/workout');
      return;
    }
    if (mode === 'edit') await renderEditor(root, template);
    else renderDetail(root, template);
  } else {
    await renderEditor(root, null);
  }
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function renderDetail(root, template) {
  const exercises = template.exercises;
  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <button class="btn-icon" data-action="back" aria-label="Back to Gym">${ui.icon('arrow-left', 20)}</button>
      <button class="btn-icon" data-action="edit" aria-label="Edit workout">${ui.icon('edit', 18)}</button>
    </header>

    <section class="section" style="margin-top:var(--sp-3)">
      ${template.focus && template.focus !== 'Custom' ? `<span class="pill pill-accent">${ui.escapeHtml(template.focus)}</span>` : ''}
      <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em;margin-top:6px">${ui.escapeHtml(template.name)}</h2>
      <div class="muted" style="font-size:var(--fs-sm);font-weight:600;margin-top:2px">${exercises.length} exercise${exercises.length === 1 ? '' : 's'}</div>
    </section>

    <section class="section stagger">
      <div class="card card-tight">
        ${exercises.length
          ? exercises.map((ex, i) => `
            <div class="row">
              <span class="gym-order-num" aria-hidden="true">${i + 1}</span>
              <div class="row-main">
                <div class="row-title">${ui.escapeHtml(ex.exerciseName)}</div>
                ${ex.reps || ex.weight ? `<div class="row-sub">${gymT.formatWeight(ex.weight)} kg × ${ex.reps} × ${ex.defaultSets}</div>` : `<div class="row-sub">${ex.defaultSets} sets</div>`}
              </div>
            </div>`).join('')
          : `<div class="empty"><div class="empty-title">No exercises yet</div><div class="empty-sub">Edit this workout to add exercises.</div></div>`}
      </div>
    </section>

    <section class="section stagger" id="tpl-last-time"></section>

    <div class="gym-sticky-actions" style="margin-top:var(--sp-5)">
      <button class="btn btn-primary btn-block" data-action="start" ${exercises.length ? '' : 'disabled'}>${ui.icon('chevron-right', 18)} Start workout</button>
    </div>

    <section class="section stagger">
      <div class="card card-tight">
        <button class="gym-action-row" data-action="edit" type="button">${ui.icon('edit', 17)} Edit exercises</button>
        <button class="gym-action-row" data-action="rename" type="button">${ui.icon('book', 17)} Rename</button>
        <button class="gym-action-row" data-action="duplicate" type="button">${ui.icon('columns', 17)} Duplicate</button>
        <button class="gym-action-row gym-action-danger" data-action="delete" type="button">${ui.icon('trash', 17)} Delete workout</button>
      </div>
    </section>
  `;

  renderLastTime(root, template);

  ui.bindActions(root, {
    back: () => go('gym'),
    edit: () => go(`gym/edit/${template.id}`),
    start: async () => {
      await gymT.markTemplateUsed(template.id);
      go('gym/workout');
    },
    rename: () => openRenameDialog(root, template),
    duplicate: async () => {
      const copy = await gymT.duplicateTemplate(template.id);
      ui.toast('Workout duplicated', 'success');
      if (copy) go(`gym/template/${copy.id}`);
    },
    delete: async () => {
      const ok = await ui.openDialog({
        title: `Delete “${template.name}”?`,
        message: 'Your saved workouts (history) are not deleted — only this reusable plan is removed.',
        confirmLabel: 'Delete plan',
        danger: true,
      });
      if (!ok) return;
      await gymT.deleteTemplate(template.id);
      ui.toast('Workout deleted', 'info');
      go('gym');
    },
  });
}

/** LAST WORKOUT summary — real historical data only. */
async function renderLastTime(root, template) {
  const node = root.querySelector('#tpl-last-time');
  if (!node) return;
  const { dbGetAll } = await import('../db.js');
  const workouts = (await dbGetAll('workouts')).sort((a, b) => b.date.localeCompare(a.date));
  const names = template.exercises.map((e) => e.exerciseName);
  const last = workouts.find((w) => w.exercises.some((ex) => names.includes(ex.exerciseName)));
  if (!last) {
    node.innerHTML = `
      <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">Last workout</h3></div>
      <div class="card card-tight"><div class="muted" style="font-size:var(--fs-sm)">Not tried yet — your first session will become the starting point.</div></div>`;
    return;
  }
  node.innerHTML = `
    <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">Last workout</h3></div>
    <div class="card card-tight">
      <div class="flex-between">
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">${formatDate(last.date)}${last.duration ? ` · ${formatDuration(last.duration)}` : ''}</div>
        <span class="pill">${last.exercises.length} exercise${last.exercises.length === 1 ? '' : 's'}</span>
      </div>
      <div class="exercise-list" style="margin-top:8px">
        ${template.exercises.map((tex) => {
          const ex = last.exercises.find((e) => e.exerciseName.toLowerCase() === tex.exerciseName.toLowerCase());
          return ex
            ? `<div class="exercise-row"><span class="ex-name">${ui.escapeHtml(ex.exerciseName)}</span><span class="ex-detail">${ex.sets} × ${ex.reps}${ex.weight ? ` · ${gymT.formatWeight(ex.weight)} kg` : ''}</span></div>`
            : '';
        }).join('')}
      </div>
    </div>`;
}

function openRenameDialog(root, template) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Rename workout'));
    const input = ui.el('input', { class: 'input', type: 'text', value: template.name, maxlength: '40', 'aria-label': 'Workout name' });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) {
        ui.toast('Enter a name.', 'info');
        return;
      }
      await gymT.saveTemplate({ ...template, name });
      ui.toast('Renamed', 'success');
      close();
      go(`gym/template/${template.id}`); // force re-render
    });
    wrap.append(input, save);
    return wrap;
  });
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

async function renderEditor(root, existing) {
  const library = await gymT.getLibrary();
  const state = {
    name: existing?.name || '',
    focus: existing?.focus || 'Custom',
    exercises: existing ? existing.exercises.map((e) => ({ ...e })) : [],
  };

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <button class="btn-icon" data-action="back" aria-label="Back">${ui.icon('arrow-left', 20)}</button>
      <h2 style="font-size:var(--fs-lg);font-weight:800">${existing ? 'Edit workout' : 'Create workout'}</h2>
      <span style="width:42px"></span>
    </header>

    <section class="section" style="margin-top:var(--sp-4)">
      <div class="field">
        <label class="field-label" for="tpl-name">Workout name</label>
        <input class="input" id="tpl-name" type="text" placeholder="e.g. Push Day" maxlength="40" value="${ui.escapeHtml(state.name)}">
      </div>
      <div class="field" style="margin-top:var(--sp-4)">
        <label class="field-label" for="tpl-focus">Focus <span class="muted" style="font-weight:500">(optional)</span></label>
        <select class="select" id="tpl-focus">
          ${TEMPLATE_FOCUSES.map((f) => `<option value="${f}" ${state.focus === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
      </div>
    </section>

    <section class="section stagger">
      <div class="section-head">
        <h3 class="section-title" style="font-size:var(--fs-lg)">Exercises <span class="muted" id="tpl-count" style="font-weight:600">${state.exercises.length}</span></h3>
      </div>
      <div class="flex-col" id="tpl-exercise-list"></div>
      <button class="btn btn-ghost btn-block" data-action="add-exercise" style="margin-top:var(--sp-3)">${ui.icon('plus', 16)} Add exercise</button>
    </section>

    <div class="gym-sticky-actions" style="margin-top:var(--sp-5)">
      <button class="btn btn-primary btn-block" data-action="save">Save workout</button>
    </div>
    <div style="height:24px"></div>
  `;

  const list = root.querySelector('#tpl-exercise-list');
  const count = root.querySelector('#tpl-count');

  function renderList() {
    count.textContent = state.exercises.length;
    list.replaceChildren(
      ...state.exercises.map((ex, i) => {
        const row = ui.el('div', { class: 'card card-tight gym-pick-row' });
        row.innerHTML = `
          <div class="flex-row" style="gap:10px">
            <button class="gym-drag-handle" data-action="drag" aria-label="Reorder ${ui.escapeHtml(ex.exerciseName)}" ${state.exercises.length < 2 ? 'disabled' : ''}>${ui.icon('columns', 16)}</button>
            <div class="grow" style="min-width:0">
              <div style="font-weight:700">${ui.escapeHtml(ex.exerciseName)}</div>
              <div class="muted" style="font-size:var(--fs-xs);margin-top:2px">${ex.muscleGroup || ''}</div>
            </div>
            <button class="btn-icon" style="width:36px;height:36px" data-action="remove" aria-label="Remove ${ui.escapeHtml(ex.exerciseName)}">${ui.icon('x', 15)}</button>
          </div>
          <div class="gym-drag-slots" aria-hidden="true"></div>`;
        // Drag to reorder (pointer-based; falls back to tap-select on desktop).
        setupDrag(row, ex, i);
        row.querySelector('[data-action="remove"]').addEventListener('click', () => {
          state.exercises.splice(i, 1);
          renderList();
        });
        return row;
      })
    );
    if (!state.exercises.length) {
      list.append(
        ui.el('div', { class: 'muted', style: { fontSize: 'var(--fs-sm)', textAlign: 'center', padding: '14px 0' } }, 'No exercises yet — add your first one.')
      );
    }
  }

  function setupDrag(row, ex, index) {
    const handle = row.querySelector('[data-action="drag"]');
    const slots = row.querySelector('.gym-drag-slots');
    let startY = 0;
    let dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
      row.style.transition = 'none';
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      row.style.zIndex = '5';
      slots.textContent = `move to position ${Math.min(state.exercises.length, Math.max(1, index + 1 + Math.round(dy / 64)))}`;
    });
    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      const dy = e.clientY - startY;
      const shift = Math.round(dy / 64);
      row.style.transform = '';
      row.style.zIndex = '';
      row.style.transition = '';
      if (shift) {
        const to = Math.min(state.exercises.length - 1, Math.max(0, index + shift));
        state.exercises = gymT.reorderTemplateExercises(state.exercises, index, to);
      }
      renderList();
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  renderList();

  ui.bindActions(root, {
    back: () => go(existing?.id ? `gym/template/${existing.id}` : 'gym'),
    'add-exercise': () => openExercisePicker(state, renderList).catch((err) => console.error('[LifeProgress] exercise picker failed', err)),
    save: async () => {
      const name = root.querySelector('#tpl-name').value.trim();
      const focus = root.querySelector('#tpl-focus').value;
      if (!name) {
        ui.toast('Give your workout a name.', 'info');
        return;
      }
      if (!state.exercises.length) {
        ui.toast('Add at least one exercise.', 'info');
        return;
      }
      const saved = await gymT.saveTemplate({
        ...(existing || {}),
        name,
        focus,
        exercises: state.exercises,
      });
      ui.toast(existing ? 'Workout updated' : 'Workout created', 'success');
      ui.haptic();
      go(`gym/template/${saved.id}`);
    },
  });
}

/** Exercise picker sheet — search + library/recent + create-your-own (§5/§6/§16). */
async function openExercisePicker(state, onChange) {
  const library = await gymT.getLibrary();
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Add exercise'));

    const search = ui.el('input', {
      class: 'input', type: 'search', placeholder: 'Search exercises…',
      'aria-label': 'Search exercises', autocomplete: 'off',
    });
    wrap.append(search);

    const grid = ui.el('div', { class: 'gym-pick-grid', role: 'listbox', 'aria-label': 'Exercise results' });
    wrap.append(grid);

    async function add(name) {
      // Duplicate guard: never push the same exercise twice into one workout.
      if (state.exercises.some((e) => e.exerciseName.toLowerCase() === name.toLowerCase())) {
        ui.toast(`${name} is already in this workout`, 'info');
        close();
        return;
      }
      await gymT.touchLibrary([name]);
      state.exercises.push({
        exerciseName: name,
        muscleGroup: gymT.guessMuscleGroup(name),
        defaultSets: 3,
        reps: 0,
        weight: 0,
      });
      ui.toast(`${name} added`, 'success');
      onChange();
      close();
    }

    function render(q = '') {
      const query = q.trim().toLowerCase();
      const inWorkout = new Set(state.exercises.map((e) => e.exerciseName.toLowerCase()));
      const libNames = library.map((e) => e.name);
      const { custom, rest } = gymT.groupLibraryEntries(library);
      const suggestions = gymT.SUGGESTED_EXERCISES.filter((n) => !libNames.some((l) => l.toLowerCase() === n.toLowerCase()));
      const pool = [
        ...custom.map((e) => ({ name: e.name, sub: e.muscleGroup, tag: 'My exercise' })),
        ...rest.map((e) => ({ name: e.name, sub: e.muscleGroup, tag: 'Recent' })),
        ...suggestions.map((n) => ({ name: n, sub: gymT.guessMuscleGroup(n), tag: '' })),
      ];
      const seen = new Set();
      const items = pool.filter((item) => {
        const key = item.name.toLowerCase();
        if (seen.has(key) || inWorkout.has(key)) return false;
        if (query && !key.includes(query) && !String(item.sub || '').toLowerCase().includes(query)) return false;
        seen.add(key);
        return true;
      });
      grid.replaceChildren(
        ...items.slice(0, 24).map((item) => {
          const btn = ui.el('button', { class: 'gym-pick-item', type: 'button', role: 'option' });
          btn.innerHTML = `
            <span class="gym-pick-name">${ui.escapeHtml(item.name)}</span>
            <span class="gym-pick-sub">${item.tag ? `<span class="pill pill-accent">${item.tag}</span> ` : ''}${ui.escapeHtml(item.sub || '')}</span>`;
          btn.addEventListener('click', () => add(item.name));
          return btn;
        })
      );
      if (!items.length) {
        const empty = ui.el('div', { class: 'muted', style: { padding: '10px 2px', fontSize: 'var(--fs-sm)' } });
        empty.textContent = query
          ? `No match for “${query}” — create it below.`
          : 'All suggested exercises are already in this workout.';
        grid.append(empty);
      }
    }

    // + Create New Exercise (V1.4.1): saves to the library, then adds here.
    const createBtn = ui.el('button', { class: 'btn btn-ghost btn-block gym-pick-create', type: 'button' }, `${ui.icon('plus', 16)} Create New Exercise`);
    createBtn.addEventListener('click', () => {
      import('../screens/gymSession.js').then(({ openCreateExercise }) => {
        openCreateExercise({ onCreate: (name) => { close(); add(name); } });
      });
    });
    wrap.append(createBtn);

    search.addEventListener('input', () => render(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const typed = search.value.trim();
        if (typed && !grid.querySelector('.gym-pick-item')) add(typed);
      }
    });
    render();
    return wrap;
  });
}
