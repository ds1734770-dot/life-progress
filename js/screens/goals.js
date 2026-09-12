/**
 * Goals — today / week / month / custom buckets with filtering,
 * creation sheet, completion animation, stats and streak.
 */
import { getSettings, saveSettings } from '../settings.js';
import * as goals from '../goals.js';
import { checkAchievementsNow } from '../celebration.js';
import { GOAL_TYPES, GOAL_CATEGORIES, GOAL_PRIORITIES } from '../models.js';
import * as ui from '../ui.js';
import { todayKey, formatDate, addDays, startOfWeekKey, formatMonth } from '../utils.js';

const CATEGORY_PILL = {
  Fitness: 'pill-accent',
  Coding: 'pill-info',
  Study: 'pill-info',
  Personal: '',
  Health: 'pill-success',
  Productivity: 'pill-warning',
  Custom: '',
};

export async function mount(root, params) {
  const goalList = (await goals.getAllGoals()).map((g) => goals.withCompletionHistory(g));
  const state = {
    view: getSettings().goalsDefaultView || 'today',
    filter: 'all',
    goals: goalList,
  };
  render(root, state);
  if (params[0] === 'new') openGoalSheet(root, state, null);
}

function render(root, state) {
  // View names are user-facing (today/week/month) while goal types are
  // data-facing (daily/weekly/monthly/custom).
  const VIEW_TO_BUCKET = { today: 'daily', week: 'weekly', month: 'monthly', custom: 'custom' };
  const bucket = VIEW_TO_BUCKET[state.view] || state.view;
  const bucketGoals = state.goals.filter((g) => goals.inBucketOn(g, bucket));
  const visible = goals.filterGoals(bucketGoals, state.filter);
  const stats = goals.goalStats(bucketGoals);
  const streak = goals.goalStreak(state.goals);

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Goals</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Track → understand → improve</div>
      </div>
      ${streak > 0 ? `<span class="pill pill-accent" style="font-size:var(--fs-sm)">${ui.icon('flame', 14)} ${streak} day goal streak</span>` : ''}
    </header>

    <section class="section stagger">
      <div class="seg" role="tablist" aria-label="Goal timeframe">
        ${['today', 'week', 'month', 'custom'].map((v) => `
          <button class="seg-item" role="tab" data-action="view" data-view="${v}" aria-selected="${state.view === v}">
            ${v === 'today' ? 'Today' : v === 'week' ? 'Week' : v === 'month' ? 'Month' : 'Custom'}
          </button>`).join('')}
      </div>
      <div class="chip-grid" style="margin-top:var(--sp-3)">
        <button class="chip ${state.filter === 'all' ? 'active' : ''}" data-action="filter" data-filter="all">All</button>
        <button class="chip ${state.filter === 'pending' ? 'active' : ''}" data-action="filter" data-filter="pending">Pending</button>
        <button class="chip ${state.filter === 'completed' ? 'active' : ''}" data-action="filter" data-filter="completed">Completed</button>
      </div>
    </section>

    <section class="section stagger">
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${stats.total}</div><div class="stat-label">Total</div></div>
        <div class="stat"><div class="stat-value text-success">${stats.completed}</div><div class="stat-label">Completed</div></div>
        <div class="stat"><div class="stat-value">${stats.pct}%</div><div class="stat-label">Complete</div></div>
      </div>
    </section>

    <section class="section stagger" id="goals-list">
      ${visible.length
        ? `<div class="flex-col">${visible.map((g) => goalCard(g)).join('')}</div>`
        : ui.emptyState({
            iconName: 'target',
            title: state.goals.length ? `No ${state.filter !== 'all' ? state.filter : ''} goals in ${state.view}` : 'No goals yet',
            sub: state.goals.length ? 'Try a different view or filter.' : 'Create your first goal — small steps every day.',
            actionLabel: state.goals.length ? null : 'Create your first goal',
            action: () => openGoalSheet(root, state, null),
          }).outerHTML}
    </section>

    <button class="btn btn-primary btn-block" data-action="add-goal" style="margin-top:var(--sp-5)">
      ${ui.icon('plus', 18)} Add goal
    </button>
  `;

  ui.bindActions(root, {
    view: (d) => {
      state.view = d.view;
      saveSettings({ goalsDefaultView: d.view });
      render(root, state);
    },
    filter: (d) => {
      state.filter = d.filter;
      render(root, state);
    },
    'add-goal': () => openGoalSheet(root, state, null),
    'goal-toggle': async (d) => {
      const goal = state.goals.find((g) => g.id === d.id);
      if (!goal) return;
      const completing = !goals.isCompletedOn(goal);
      await goals.setGoalCompleted(goal, completing);
      checkAchievementsNow(); // V1.2: evaluate + celebrate (fire-and-forget)
      ui.haptic();
      render(root, state);
      if (completing) {
        const check = root.querySelector(`[data-goal-check="${goal.id}"]`);
        if (check) {
          const burst = ui.el('span', { class: 'burst-ring' });
          check.appendChild(burst);
          ui.pulse(check);
        }
        ui.toast('Goal completed', 'success');
      }
    },
    'goal-edit': (d) => {
      const goal = state.goals.find((g) => g.id === d.id);
      if (goal) openGoalSheet(root, state, goal);
    },
    'goal-delete': async (d) => {
      const goal = state.goals.find((g) => g.id === d.id);
      const ok = await ui.openDialog({
        title: 'Delete goal?',
        message: `“${goal.title}” will be removed permanently.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await goals.deleteGoal(d.id);
      state.goals = state.goals.filter((g) => g.id !== d.id);
      ui.toast('Goal deleted', 'info');
      render(root, state);
    },
  });
}

function goalCard(g) {
  const overdue = goals.isOverdue(g);
  const completedToday = goals.isCompletedOn(g);
  const status = completedToday ? 'done' : '';
  const deadline =
    g.type === 'daily'
      ? 'Today'
      : g.type === 'weekly'
        ? `Ends ${formatDate(g.endDate, { short: true })}`
        : g.type === 'monthly'
          ? formatMonth(g.endDate)
          : `${formatDate(g.startDate, { short: true })} → ${formatDate(g.endDate, { short: true })}`;
  const priorityPill =
    g.priority === 'high' ? 'pill-danger' : g.priority === 'medium' ? 'pill-warning' : '';

  return `
    <div class="goal-card ${status}" data-goal-id="${g.id}">
      <button class="goal-check" data-action="goal-toggle" data-id="${g.id}" data-goal-check="${g.id}" aria-label="${completedToday ? 'Mark not completed' : 'Mark completed'}">
        ${ui.icon('check')}
      </button>
      <div class="goal-body">
        <div class="goal-title">${ui.escapeHtml(g.title)}</div>
        ${g.description ? `<div class="muted" style="font-size:var(--fs-sm);margin-top:3px">${ui.escapeHtml(g.description)}</div>` : ''}
        <div class="goal-meta">
          <span class="pill ${CATEGORY_PILL[g.category] || ''}">${ui.escapeHtml(g.category)}</span>
          ${g.priority !== 'medium' ? `<span class="pill ${priorityPill}">${g.priority} priority</span>` : ''}
          <span class="pill ${overdue ? 'pill-danger' : 'pill-info'}">${overdue ? 'Overdue' : deadline}</span>
        </div>
      </div>
      <div class="flex-col" style="gap:6px">
        <button class="btn-icon" style="width:34px;height:34px" data-action="goal-edit" data-id="${g.id}" aria-label="Edit goal">${ui.icon('edit', 15)}</button>
        <button class="btn-icon" style="width:34px;height:34px" data-action="goal-delete" data-id="${g.id}" aria-label="Delete goal">${ui.icon('trash', 15)}</button>
      </div>
    </div>`;
}

function openGoalSheet(root, state, existing) {
  const isEdit = Boolean(existing);
  const today = todayKey();
  const weekStart = startOfWeekKey(today);
  const weekEnd = addDays(weekStart, 6);
  const monthStart = today.slice(0, 7) + '-01';
  const monthEnd = (() => {
    const d = new Date(today.slice(0, 7) + '-01T00:00:00');
    d.setMonth(d.getMonth() + 1, 0);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  })();

  const defaults = existing || { title: '', description: '', category: 'Personal', type: 'daily', startDate: today, endDate: today, priority: 'medium' };

  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, isEdit ? 'Edit goal' : 'New goal'));

    const title = ui.el('input', { class: 'input', placeholder: 'Goal title', value: defaults.title, maxlength: '80' });
    const description = ui.el('textarea', { class: 'textarea', placeholder: 'Description (optional)', style: { minHeight: 64 } });
    description.value = defaults.description || '';

    const category = ui.el('select', { class: 'select' }, GOAL_CATEGORIES.map((c) => ui.el('option', { value: c }, c)));
    category.value = defaults.category;

    const type = ui.el('select', { class: 'select' }, GOAL_TYPES.map((t) => ui.el('option', { value: t }, t[0].toUpperCase() + t.slice(1))));
    type.value = defaults.type;

    const startDate = ui.el('input', { class: 'input', type: 'date', value: defaults.startDate });
    const endDate = ui.el('input', { class: 'input', type: 'date', value: defaults.endDate });

    const priority = ui.el('select', { class: 'select' }, GOAL_PRIORITIES.map((p) => ui.el('option', { value: p }, p[0].toUpperCase() + p.slice(1))));
    priority.value = defaults.priority;

    // Auto-set sensible date ranges when the type changes.
    type.addEventListener('change', () => {
      if (type.value === 'daily') { startDate.value = today; endDate.value = today; }
      else if (type.value === 'weekly') { startDate.value = weekStart; endDate.value = weekEnd; }
      else if (type.value === 'monthly') { startDate.value = monthStart; endDate.value = monthEnd; }
    });

    const error = ui.el('div', { class: 'muted', style: { fontSize: 'var(--fs-sm)', color: 'var(--danger)', minHeight: 18 } });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, isEdit ? 'Save changes' : 'Create goal');
    save.addEventListener('click', async () => {
      const data = {
        title: title.value,
        description: description.value,
        category: category.value,
        type: type.value,
        startDate: startDate.value || today,
        endDate: endDate.value || today,
        priority: priority.value,
      };
      const err = (await import('../models.js')).validateGoal(data);
      if (err) { error.textContent = err; return; }
      if (isEdit) {
        Object.assign(existing, data);
        await goals.updateGoal(existing);
        ui.toast('Goal updated', 'success');
      } else {
        const created = await goals.addGoal(data);
        state.goals.push(created);
        ui.toast('Goal created', 'success');
      }
      ui.haptic();
      close();
      render(root, state);
    });

    wrap.append(
      title,
      description,
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Category'), category]),
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Type'), type]),
      ui.el('div', { class: 'form-grid' }, [
        ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Start'), startDate]),
        ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'End'), endDate]),
      ]),
      ui.el('div', { class: 'field' }, [ui.el('label', { class: 'field-label' }, 'Priority'), priority]),
      error,
      save
    );
    return wrap;
  });
}