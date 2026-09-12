/**
 * History — V1.2 Phase 1. A monthly calendar of the user's journey.
 *
 * Renders from the aggregation layer (js/history.js) only: the screen never
 * touches IndexedDB directly and history is never persisted — it is derived
 * from the existing water/gym/goals/journal records on each mount.
 *
 * State: { year, month, selected } — selected is a date key; defaults to today.
 */
import * as history from '../history.js';
import * as ui from '../ui.js';
import * as water from '../water.js';
import {
  todayKey,
  formatDate,
  parseKey,
  formatWater,
  formatDuration,
  dateKey,
} from '../utils.js';

// Fixed display order for the activity dots + legend (matches ACTIVITY_TYPES).
const META = {
  water: { label: 'Water', icon: 'droplet' },
  gym: { label: 'Gym', icon: 'dumbbell' },
  goals: { label: 'Goals', icon: 'target' },
  journal: { label: 'Journal', icon: 'book' },
};

export async function mount(root) {
  const [data, unit] = await Promise.all([history.loadHistoryData(), Promise.resolve(water.waterUnit())]);
  const today = todayKey();
  const state = { ...history.monthOf(today), selected: today };

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">History</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Your journey, day by day.</div>
      </div>
      <span class="pill pill-accent">${ui.icon('calendar', 14)} V1.2</span>
    </header>

    <div class="card hist-card stagger">
      <div class="hist-nav" role="group" aria-label="Month navigation">
        <button class="btn-icon" data-action="prev-month" aria-label="Previous month">${ui.icon('chevron-left', 20)}</button>
        <div class="hist-month" id="hist-month" aria-live="polite"></div>
        <button class="btn-icon" data-action="next-month" aria-label="Next month">${ui.icon('chevron-right', 20)}</button>
      </div>
      <button class="section-link hist-today" data-action="go-today">Today</button>

      <div class="hist-week" aria-hidden="true">
        ${history.WEEKDAY_LABELS.map((d) => `<span class="hist-dow">${d}</span>`).join('')}
      </div>
      <div class="hist-grid" id="hist-grid"></div>

      <div class="hist-legend" aria-hidden="true">
        ${Object.entries(META)
          .map(([type, m]) => `<span class="hist-legend-item"><span class="hist-dot dot-${type}"></span>${m.label}</span>`)
          .join('')}
      </div>
    </div>

    <section class="section" id="hist-details-section" aria-label="Selected day details"></section>
  `;

  ui.bindActions(root, {
    'prev-month': () => shiftMonth(-1),
    'next-month': () => shiftMonth(1),
    'go-today': () => {
      ui.haptic();
      const m = history.monthOf(todayKey());
      state.year = m.year;
      state.month = m.month;
      state.selected = todayKey();
      renderMonth();
      renderDetails();
    },
    'day-pick': (d) => {
      ui.haptic();
      state.selected = d.date;
      renderGrid();
      renderDetails();
    },
  });

  renderMonth();
  renderDetails();

  // -------------------------------------------------------------------------

  function shiftMonth(dir) {
    const next = dir < 0 ? history.prevMonth(state.year, state.month) : history.nextMonth(state.year, state.month);
    state.year = next.year;
    state.month = next.month;
    // Keep the selection when the selected day is inside the new month;
    // otherwise select the 1st so the details follow the visible month.
    const selMonth = history.monthOf(state.selected);
    state.selected =
      selMonth.year === next.year && selMonth.month === next.month
        ? state.selected
        : `${history.monthKeyOf(next.year, next.month)}-01`;
    renderMonth();
    renderDetails();
  }

  function renderMonth() {
    root.querySelector('#hist-month').textContent = history.monthLabel(state.year, state.month);
    renderGrid();
  }

  function renderGrid() {
    const activity = history.monthActivity(state.year, state.month, data, today);
    const grid = root.querySelector('#hist-grid');
    grid.replaceChildren(
      ...history.monthGrid(state.year, state.month).map((cell) => {
        const btn = ui.el('button', {
          class: [
            'hist-day',
            cell.inMonth ? '' : 'out',
            cell.key === today ? 'is-today' : '',
            cell.key === state.selected ? 'is-selected' : '',
          ]
            .filter(Boolean)
            .join(' '),
          type: 'button',
          'data-action': 'day-pick',
          'data-date': cell.key,
          'aria-label': dayAriaLabel(cell, activity.get(cell.key)),
          'aria-pressed': cell.key === state.selected ? 'true' : 'false',
        });
        btn.append(ui.el('span', { class: 'hist-daynum' }, String(cell.day)));
        if (activity.has(cell.key)) {
          const dots = ui.el('span', { class: 'hist-dots', 'aria-hidden': 'true' });
          for (const t of history.ACTIVITY_TYPES) {
            if (activity.get(cell.key)[t]) dots.append(ui.el('span', { class: `hist-dot dot-${t}` }));
          }
          btn.append(dots);
        }
        return btn;
      })
    );
  }

  function dayAriaLabel(cell, act) {
    const d = parseKey(cell.key);
    const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const parts = act ? history.ACTIVITY_TYPES.filter((t) => act[t]).map((t) => META[t].label) : [];
    const activityText = parts.length
      ? parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]} activity`
      : 'no activity';
    const state2 = [cell.key === today ? 'Today' : '', cell.key === state.selected ? 'Selected' : '']
      .filter(Boolean)
      .join('. ');
    return `${label}. ${activityText}.${state2 ? ` ${state2}.` : ''}`;
  }

  function renderDetails() {
    const node = root.querySelector('#hist-details-section');
    const s = history.summarizeDay(state.selected, data, today);
    const heading = `${formatDate(state.selected, { noToday: true })}${s.date === today ? ' · Today' : ''}`;
    node.innerHTML = `
      <div class="section-head">
        <h3 class="section-title" id="hist-day-title">${ui.escapeHtml(heading)}</h3>
        <span class="pill ${s.activityCount > 0 ? 'pill-info' : ''}">${
          s.activityCount === 0 ? 'Rest day' : `${s.activityCount} of 4 active`
        }</span>
      </div>
      <div class="card card-tight hist-details">
        ${detailWater(s, unit)}
        ${detailGym(s)}
        ${detailGoals(s)}
        ${detailJournal(s)}
      </div>`;

    // Update the header pill/date for screen readers without a full re-render.
    const title = node.querySelector('#hist-day-title');
    title?.setAttribute('aria-live', 'polite');
  }

  function detailWater(s, waterUnit) {
    return detailRow(
      'water',
      'Water',
      s.water.logged
        ? `${formatWater(s.water.total, waterUnit)} ${s.water.targetMet ? '· daily goal reached' : ''}`
        : 'No water entries',
      s.water.logged
    );
  }

  function detailGym(s) {
    const gymText = s.gym.workouts
      ? `${s.gym.types.join(', ')} · ${formatDuration(s.gym.minutes)}${s.gym.workouts > 1 ? ` · ${s.gym.workouts} sessions` : ''}`
      : 'No workout';
    return detailRow('gym', 'Gym', gymText, s.gym.workouts > 0);
  }

  function detailGoals(s) {
    // Daily goals show the honest n-of-due breakdown; completions that fall
    // outside today's daily bucket (custom/one-off goals) count on their own.
    const goalsText = !s.goals.activity
      ? 'No goal activity'
      : s.goals.due > 0
        ? `${s.goals.completed} of ${s.goals.due} daily goals completed`
        : `${s.goals.completed} ${s.goals.completed === 1 ? 'goal' : 'goals'} completed`;
    return detailRow('goals', 'Goals', goalsText, s.goals.activity);
  }

  function detailJournal(s) {
    return detailRow(
      'journal',
      'Journal',
      s.journal.entries ? `${s.journal.entries} ${s.journal.entries === 1 ? 'entry' : 'entries'}` : 'No journal entry',
      s.journal.entries > 0
    );
  }

  function detailRow(type, label, text, active) {
    return `
      <div class="hist-detail-row${active ? ' has-activity' : ''}">
        <span class="hist-detail-icon">${ui.icon(META[type].icon, 18)}</span>
        <div class="hist-detail-main">
          <div class="hist-detail-label">${label}</div>
          <div class="hist-detail-value">${ui.escapeHtml(text)}</div>
        </div>
        <span class="hist-dot dot-${type}" aria-hidden="true"></span>
      </div>`;
  }
}
