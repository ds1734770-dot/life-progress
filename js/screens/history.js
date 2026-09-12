/**
 * History — V1.2. The user's consistency engine.
 *
 * Category selector (All / Water / Gym / Goals / Journal) + a monthly
 * calendar whose day states communicate completion, a streak card (current /
 * best + motivational line) and context-aware day details. Everything is
 * derived via js/history.js from the existing stores — nothing here touches
 * IndexedDB and no history data is persisted.
 *
 * State: { category, year, month, selected } — selected is a date key.
 * Category and month are orthogonal: switching one never resets the other.
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
} from '../utils.js';

// Display metadata per category (matches history.CATEGORIES order).
const META = {
  all: { label: 'All', icon: 'sparkles' },
  water: { label: 'Water', icon: 'droplet' },
  gym: { label: 'Gym', icon: 'dumbbell' },
  goals: { label: 'Goals', icon: 'target' },
  journal: { label: 'Journal', icon: 'book' },
};

/** State → day-cell CSS class ('empty' → none). */
const STATE_CLASS = { completed: 'done', partial: 'partial', empty: '' };

/** State → accessible phrase. */
const STATE_TEXT = {
  completed: {
    all: 'Day fully completed',
    water: 'Water goal completed',
    gym: 'Gym completed',
    goals: 'Goals completed',
    journal: 'Journal completed',
  },
  partial: {
    all: 'Partial activity',
    water: 'Water logged, goal not reached',
    gym: 'Gym activity',
    goals: 'Some goals completed',
    journal: 'Journal activity',
  },
};

const CHIP_ICONS = { water: 'droplet', gym: 'dumbbell', goals: 'target', journal: 'book' };

export async function mount(root) {
  const data = await history.loadHistoryData();
  const unit = water.waterUnit();
  const today = todayKey();
  const state = { category: 'all', ...history.monthOf(today), selected: today };

  // One aggregation pass per mount; invalidated never (a remount reloads data).
  let completionIdx = null;
  function completionIndex() {
    if (!completionIdx) completionIdx = history.completionIndex(data, today);
    return completionIdx;
  }

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 id="hist-title" style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">History</h2>
        <div class="muted" id="hist-tagline" style="font-size:var(--fs-sm);font-weight:600">Your journey, day by day.</div>
      </div>
      <span class="pill pill-accent">${ui.icon('calendar', 14)} V1.2</span>
    </header>

    <div class="hist-chips" role="tablist" aria-label="History category">
      ${history.CATEGORIES.map((c) => {
        const m = META[c];
        const icon = CHIP_ICONS[c] ? ui.icon(CHIP_ICONS[c], 14) : '';
        return `<button class="hist-chip" role="tab" data-action="pick-category" data-category="${c}"
          aria-selected="${c === state.category}" aria-label="Show ${m.label} history">${icon}${m.label}</button>`;
      }).join('')}
    </div>

    <div class="card hist-streak-card" id="hist-streak-card"></div>

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
    </div>

    <section class="section" id="hist-details-section" aria-label="Selected day details"></section>
  `;

  ui.bindActions(root, {
    'pick-category': (d) => {
      if (!history.CATEGORIES.includes(d.category)) return;
      ui.haptic();
      state.category = d.category;
      renderHeader();
      renderChips();
      renderStreakCard();
      renderGrid();
      renderDetails();
    },
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

  renderHeader();
  renderStreakCard();
  renderMonth();
  renderDetails();

  // -------------------------------------------------------------------------

  function renderHeader() {
    const { title, tagline } = history.categoryHeader(state.category);
    root.querySelector('#hist-title').textContent = title;
    root.querySelector('#hist-tagline').textContent = tagline;
  }

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

  function renderChips() {
    root.querySelectorAll('.hist-chip').forEach((chip) => {
      chip.setAttribute('aria-selected', chip.dataset.category === state.category ? 'true' : 'false');
    });
  }

  function renderStreakCard() {
    const streak = history.computeStreaks(state.category, data, today);
    const doneToday = dayState(today, state.category) === 'completed';
    const message = history.streakMotivation(state.category, doneToday, streak.current > 0);
    const meta = META[state.category];

    root.querySelector('#hist-streak-card').innerHTML = `
      <div class="hist-streak-main">
        <span class="hist-streak-flame" aria-hidden="true">${ui.icon('flame', 20)}</span>
        <div class="hist-streak-count">
          <div class="hist-streak-num">${streak.current} <span class="hist-streak-unit">day${streak.current === 1 ? '' : 's'}</span></div>
          <div class="muted hist-streak-label">Current streak</div>
        </div>
        <div class="hist-streak-best">
          <span aria-hidden="true">${ui.icon('star', 14)}</span> ${streak.best} best
        </div>
      </div>
      <div class="hist-streak-msg" role="status">${ui.escapeHtml(message)}</div>
      <span class="visually-hidden" id="hist-streak-announce">${meta.label} streak: ${streak.current} days current, ${streak.best} days best.</span>`;

    const card = root.querySelector('#hist-streak-card');
    card.classList.toggle('alive', streak.current > 0);
    card.classList.toggle('done-today', doneToday);
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      card.style.animation = 'none';
      void card.offsetWidth; // restart the entrance on category change
      card.style.animation = '';
    }
  }

  /** Cell state for the active category (out-of-grid lookups are fine — the index covers all days). */
  function dayState(key, category = state.category) {
    return completionIndex().get(key)?.[category] || 'empty';
  }

  function renderMonth() {
    root.querySelector('#hist-month').textContent = history.monthLabel(state.year, state.month);
    renderGrid();
  }

  function renderGrid() {
    const idx = completionIndex();
    const activity = state.category === 'all' ? history.monthActivity(state.year, state.month, data, today) : null;
    const grid = root.querySelector('#hist-grid');
    grid.replaceChildren(
      ...history.monthGrid(state.year, state.month).map((cell) => {
        const st = idx.get(cell.key)?.[state.category] || 'empty';
        const btn = ui.el('button', {
          class: [
            'hist-day',
            cell.inMonth ? '' : 'out',
            cell.key === today ? 'is-today' : '',
            cell.key === state.selected ? 'is-selected' : '',
            STATE_CLASS[st],
            st === 'completed' ? 'in-chain' : '',
          ]
            .filter(Boolean)
            .join(' '),
          type: 'button',
          'data-action': 'day-pick',
          'data-date': cell.key,
          'data-state': st,
          'aria-label': dayAriaLabel(cell, st, activity?.get(cell.key)),
          'aria-pressed': cell.key === state.selected ? 'true' : 'false',
        });
        btn.append(ui.el('span', { class: 'hist-daynum' }, String(cell.day)));
        if (st !== 'empty') {
          // Completed days carry a real checkmark; partial days an empty ring.
          const mark = ui.el('span', {
            class: `hist-mark ${st === 'completed' ? 'mark-done' : 'mark-partial'}`,
            'aria-hidden': 'true',
          });
          if (st === 'completed') mark.innerHTML = ui.icon('check', 11);
          btn.append(mark);
        }
        return btn;
      })
    );
  }

  function dayAriaLabel(cell, st, act) {
    const d = parseKey(cell.key);
    const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    let activityText;
    if (state.category === 'all') {
      const parts = act ? history.ACTIVITY_TYPES.filter((t) => act[t]).map((t) => META[t].label) : [];
      activityText = parts.length
        ? parts.map((p) => `${p} activity`).join(', ')
        : 'no activity';
      if (st === 'completed') activityText = `Day fully completed. ${activityText}`;
      else if (st === 'partial') activityText = `Partial day. ${activityText}`;
    } else {
      activityText =
        st === 'empty'
          ? 'no activity'
          : STATE_TEXT[st]?.[state.category] || 'no activity';
    }
    const extras = [cell.key === today ? 'Today' : '', cell.key === state.selected ? 'Selected' : '']
      .filter(Boolean)
      .join('. ');
    return `${label}. ${activityText}.${extras ? ` ${extras}.` : ''}`;
  }

  function renderDetails() {
    const node = root.querySelector('#hist-details-section');
    const s = history.summarizeDay(state.selected, data, today);
    const st = dayState(state.selected);
    const heading = `${formatDate(state.selected, { noToday: true })}${s.date === today ? ' · Today' : ''}`;
    const pill =
      st === 'completed' ? `<span class="pill pill-success">✓ Completed</span>` : st === 'partial' ? `<span class="pill pill-info">Partial</span>` : `<span class="pill">Rest day</span>`;

    const streak = history.computeStreaks(state.category, data, today);
    const streakLine =
      state.category === 'all'
        ? ''
        : `<div class="hist-detail-streak">${ui.icon('flame', 13)} Current streak: ${streak.current} day${streak.current === 1 ? '' : 's'}</div>`;

    node.innerHTML = `
      <div class="section-head">
        <h3 class="section-title" id="hist-day-title" aria-live="polite">${ui.escapeHtml(heading)}</h3>
        ${pill}
      </div>
      ${streakLine}
      <div class="card card-tight hist-details">
        ${state.category === 'all' || state.category === 'water' ? detailWater(s, unit) : ''}
        ${state.category === 'all' || state.category === 'gym' ? detailGym(s) : ''}
        ${state.category === 'all' || state.category === 'goals' ? detailGoals(s) : ''}
        ${state.category === 'all' || state.category === 'journal' ? detailJournal(s) : ''}
      </div>`;
  }

  function detailWater(s, waterUnit) {
    const text = s.water.logged
      ? s.water.targetMet
        ? `${formatWater(s.water.total, waterUnit)} / ${formatWater(water.waterTarget(), waterUnit)} — daily goal reached ✓`
        : `${formatWater(s.water.total, waterUnit)} / ${formatWater(water.waterTarget(), waterUnit)}`
      : 'No water entries';
    return detailRow('water', 'Water', text, dayState(state.selected, 'water'));
  }

  function detailGym(s) {
    const gymText = s.gym.workouts
      ? `${s.gym.types.join(', ')} · ${formatDuration(s.gym.minutes)}${s.gym.workouts > 1 ? ` · ${s.gym.workouts} sessions` : ''}`
      : 'No workout';
    return detailRow('gym', 'Gym', gymText, dayState(state.selected, 'gym'));
  }

  function detailGoals(s) {
    const goalsText = !s.goals.activity
      ? 'No goal activity'
      : s.goals.due > 0
        ? `${s.goals.completed} of ${s.goals.due} goals completed`
        : `${s.goals.completed} ${s.goals.completed === 1 ? 'goal' : 'goals'} completed`;
    return detailRow('goals', 'Goals', goalsText, dayState(state.selected, 'goals'));
  }

  function detailJournal(s) {
    return detailRow(
      'journal',
      'Journal',
      s.journal.entries ? `${s.journal.entries} ${s.journal.entries === 1 ? 'entry' : 'entries'}` : 'No journal entry',
      dayState(state.selected, 'journal')
    );
  }

  function detailRow(type, label, text, st = 'empty') {
    const doneMark = st === 'completed' ? `<span class="hist-detail-check" aria-hidden="true">${ui.icon('check', 12)}</span>` : '';
    return `
      <div class="hist-detail-row${st !== 'empty' ? ' has-activity' : ''}${st === 'completed' ? ' is-done' : ''}">
        <span class="hist-detail-icon">${ui.icon(META[type].icon, 18)}</span>
        <div class="hist-detail-main">
          <div class="hist-detail-label">${label}</div>
          <div class="hist-detail-value">${ui.escapeHtml(text)}</div>
        </div>
        ${doneMark || `<span class="hist-dot dot-${type}" aria-hidden="true"></span>`}
      </div>`;
  }
}
