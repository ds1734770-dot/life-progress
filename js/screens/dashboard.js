/**
 * Dashboard — the personal command center.
 *
 * Hierarchy (chosen for impact in the first 3 seconds):
 *   Inspirational hero (greeting + background + quote)
 *   Quick actions
 *   Today's overall progress
 *   Today's goals → Water → Gym → Journal summaries
 *
 * Every value is calculated from real stored data; empty states are honest.
 */
import { getSettings, saveSettings } from '../settings.js';
import { avatarMarkup } from '../personalization.js';
import * as water from '../water.js';
import * as goals from '../goals.js';
import * as gym from '../gym.js';
import * as journal from '../journal.js';
import * as photos from '../photos.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import {
  calculateDailyProgress,
  greetingFor,
  todayKey,
  formatDate,
  formatWater,
  formatDuration,
  clamp,
} from '../utils.js';

const QUOTES = [
  { text: 'Discipline is choosing between what you want now and what you want most.', by: 'Abraham Lincoln' },
  { text: 'You don’t have to be extreme, just consistent.', by: '' },
  { text: 'Small progress is still progress.', by: '' },
  { text: 'The pain you feel today will be the strength you feel tomorrow.', by: '' },
  { text: 'Focus on being productive instead of busy.', by: 'Tim Ferriss' },
  { text: 'Push yourself, because no one else is going to do it for you.', by: '' },
  { text: 'Your future is created by what you do today, not tomorrow.', by: 'Robert Kiyosaki' },
  { text: 'The only bad workout is the one that didn’t happen.', by: '' },
];

function quoteOfTheDay() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  return QUOTES[dayOfYear % QUOTES.length];
}

export async function mount(root, params) {
  photos.revokePhotoUrls();
  const state = await loadState();
  const settings = getSettings();
  const quote = quoteOfTheDay();

  const name = (settings.name || '').trim() || 'friend';
  const bg = settings.backgroundImage;

  root.innerHTML = `
    <header id="dash-hero" class="dash-hero ${bg ? 'has-image' : ''}" style="${bg ? `background-image:url('${bg.dataUrl}')` : ''}">
      <div class="dash-hero-top">
        <div class="dash-hero-greeting">
          <div class="dash-hello">${formatDate(todayKey(), { noToday: true })}</div>
          <h1 class="dash-name">${ui.escapeHtml(greetingFor())}, ${ui.escapeHtml(name)}.</h1>
        </div>
        <div class="dash-avatar">${avatarMarkup(settings, 44)}</div>
      </div>
      <div class="dash-quote">
        <p>${ui.escapeHtml(quote.text)}</p>
        ${quote.by ? `<div class="dash-quote-by">— ${ui.escapeHtml(quote.by)}</div>` : ''}
      </div>
      <div class="dash-hero-actions">
        <button class="btn btn-ghost btn-sm" data-action="change-bg">${ui.icon('image', 15)} ${bg ? 'Change' : 'Set background'}</button>
        ${bg ? `<button class="btn btn-ghost btn-sm" data-action="remove-bg">${ui.icon('x', 15)} Remove</button>` : ''}
      </div>
    </header>

    <section class="quick-actions stagger" aria-label="Quick actions">
      <div class="qa-item"><button class="qa-circle" data-action="quick-water">${ui.icon('droplet', 24)}</button><span class="qa-label">Water</span></div>
      <div class="qa-item"><button class="qa-circle" data-action="quick-workout">${ui.icon('dumbbell', 24)}</button><span class="qa-label">Workout</span></div>
      <div class="qa-item"><button class="qa-circle" data-action="quick-goal">${ui.icon('target', 24)}</button><span class="qa-label">Goal</span></div>
      <div class="qa-item"><button class="qa-circle" data-action="quick-journal">${ui.icon('book', 24)}</button><span class="qa-label">Journal</span></div>
      <div class="qa-item"><button class="qa-circle" data-action="quick-photo">${ui.icon('camera', 24)}</button><span class="qa-label">Photo</span></div>
    </section>

    <section id="card-progress"></section>
    <section id="card-goals"></section>
    <section id="card-water"></section>
    <section id="card-gym"></section>
    <section id="card-journal"></section>
  `;

  updateSections(root, state);

  ui.bindActions(root, {
    'change-bg': changeBackground,
    'remove-bg': removeBackground,
    'quick-water': () => openQuickWaterSheet(root),
    'quick-workout': () => go('gym/new'),
    'quick-goal': () => go('goals/new'),
    'quick-journal': () => go('journal/edit'),
    'quick-photo': () => go('photos/add'),
    'goal-toggle': async (d) => {
      const goal = state.goals.find((g) => g.id === d.id);
      if (!goal) return;
      ui.haptic();
      await goals.setGoalCompleted(goal, goal.status !== 'completed');
      refreshSections(root, ['progress', 'goals']);
      if (goal.status === 'completed') ui.toast('Goal completed', 'success');
    },
    'open-goals': () => go('goals'),
    'open-water': () => go('water'),
    'open-gym': () => go('gym'),
    'open-journal': () => go('journal'),
    'open-photos': () => go('photos'),
    'water-mini': () => openQuickWaterSheet(root),
  });

  async function changeBackground() {
    const file = await ui.pickFromGallery('image/*');
    if (!file) return;
    try {
      const blob = await photos.processImage(file, 1600, 0.82);
      const dataUrl = await ui.readFileAsDataURL(blob);
      await saveSettings({ backgroundImage: { dataUrl, name: file.name } });
      ui.toast('Background updated', 'success');
      ui.haptic();
      refreshHero(root);
    } catch {
      ui.toast('Could not read that image.', 'danger');
    }
  }

  async function removeBackground() {
    const ok = await ui.openDialog({
      title: 'Remove background?',
      message: 'Your dashboard will go back to the default gradient.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await saveSettings({ backgroundImage: null });
    ui.toast('Background removed', 'info');
    refreshHero(root);
  }
}

// ---------------------------------------------------------------------------

async function loadState() {
  const [waterEntries, goalList, workouts, journalEntries, photoList] = await Promise.all([
    water.getAllEntries(),
    goals.getAllGoals(),
    gym.getAllWorkouts(),
    journal.getAllEntries(),
    photos.getAllPhotos(),
  ]);
  return { waterEntries, goals: goalList, workouts, journalEntries, photoList };
}

function refreshHero(root) {
  const bg = getSettings().backgroundImage;
  const hero = root.querySelector('#dash-hero');
  if (!hero) return;
  hero.classList.toggle('has-image', Boolean(bg));
  hero.style.backgroundImage = bg ? `url('${bg.dataUrl}')` : '';
  const actions = hero.querySelector('.dash-hero-actions');
  actions.innerHTML = `
    <button class="btn btn-ghost btn-sm" data-action="change-bg">${ui.icon('image', 15)} ${bg ? 'Change' : 'Set background'}</button>
    ${bg ? `<button class="btn btn-ghost btn-sm" data-action="remove-bg">${ui.icon('x', 15)} Remove</button>` : ''}
  `;
}

async function refreshSections(root, which) {
  const fresh = await loadState();
  loadState._cache = fresh;
  updateSections(root, fresh, which);
}

function updateSections(root, state, only = null) {
  const updaters = {
    progress: () => renderProgressCard(root, state),
    goals: () => renderGoalsCard(root, state),
    water: () => renderWaterCard(root, state),
    gym: () => renderGymCard(root, state),
    journal: () => renderJournalCard(root, state),
  };
  for (const [key, fn] of Object.entries(updaters)) {
    if (!only || only.includes(key)) fn();
  }
}

function renderProgressCard(root, state) {
  const today = todayKey();
  const goalsFrac = goals.todayProgressFraction(state.goals, today);
  const waterFrac = water.waterFraction(state.waterEntries);
  const workoutDone = gym.workoutsOn(state.workouts, today).length > 0;
  const journalDone = state.journalEntries.some((e) => e.date === today);

  const pct = calculateDailyProgress({
    goals: goalsFrac,
    water: waterFrac,
    gym: workoutDone ? 1 : 0,
    journal: journalDone ? 1 : 0,
  });

  const todayGoals = state.goals.filter((g) => goals.inBucketOn(g, 'daily', today));
  const doneGoals = todayGoals.filter((g) => goals.isCompletedOn(g, today)).length;
  const parts = [];
  if (todayGoals.length) parts.push(`${doneGoals}/${todayGoals.length} goals`);
  parts.push(`${formatWater(water.totalOn(state.waterEntries, today), water.waterUnit())} water`);
  parts.push(`Workout ${workoutDone ? '✓' : '—'}`);
  parts.push(`Journal ${journalDone ? '✓' : '—'}`);

  const node = root.querySelector('#card-progress');
  if (!node) return; // screen was replaced mid-render (navigation race)
  node.innerHTML = `
    <div class="card dash-progress-card stagger">
      <div class="ring-wrap">
        ${ui.ringMarkup(132, 12)}
        <div class="ring-center">
          <div id="dash-pct" style="font-size:34px;font-weight:800;letter-spacing:-0.02em;font-variant-numeric:tabular-nums">0%</div>
          <div class="muted" style="font-size:11px;font-weight:600">Today</div>
        </div>
      </div>
      <div class="dash-progress-text grow">
        <div class="dash-progress-label" style="font-size:17px;font-weight:700">Today's Progress</div>
        <div class="dash-progress-sub">${ui.escapeHtml(parts.join(' · '))}</div>
      </div>
    </div>`;
  ui.setRing(node, pct);
  ui.animateCount(node.querySelector('#dash-pct'), pct, { format: (n) => `${Math.round(n)}%` });
}

function renderGoalsCard(root, state) {
  const today = todayKey();
  const todayGoals = state.goals.filter((g) => goals.inBucketOn(g, 'daily', today));
  const done = todayGoals.filter((g) => goals.isCompletedOn(g, today)).length;
  const node = root.querySelector('#card-goals');
  if (!node) return; // screen was replaced mid-render

  const rows = todayGoals.slice(0, 3).map(
    (g) => {
      const doneNow = goals.isCompletedOn(g, today);
      return `
      <div class="row pressable" data-action="goal-toggle" data-id="${g.id}">
        <button class="goal-check ${doneNow ? 'done' : ''}" data-action="goal-toggle" data-id="${g.id}">${ui.icon('check')}</button>
        <div class="row-main">
          <div class="row-title" style="${doneNow ? 'text-decoration:line-through;color:var(--text-3)' : ''}">${ui.escapeHtml(g.title)}</div>
        </div>
        ${doneNow ? `<span class="pill pill-success">Done</span>` : ''}
      </div>`;
    }
  ).join('');

  node.innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2 class="section-title">Today's Goals</h2>
        <button class="section-link" data-action="open-goals">Open ${ui.icon('chevron-right', 14)}</button>
      </div>
      <div class="card card-tight">
        ${todayGoals.length
          ? `
          <div class="flex-between" style="margin-bottom:10px">
            <span class="muted" style="font-size:var(--fs-sm);font-weight:600">${done} of ${todayGoals.length} completed</span>
            <span class="pill ${done === todayGoals.length ? 'pill-success' : 'pill-info'}">${Math.round((done / todayGoals.length) * 100)}%</span>
          </div>
          <div class="progress-track" style="margin-bottom:6px"><div class="progress-fill" data-bar="${Math.round((done / todayGoals.length) * 100)}"></div></div>
          ${rows}
          ${todayGoals.length > 3 ? `<button class="section-link" data-action="open-goals" style="margin-top:8px">View all ${todayGoals.length} goals ${ui.icon('chevron-right', 14)}</button>` : ''}`
          : `
          <div class="empty" style="padding:20px 8px">
            <div class="empty-title" style="font-size:var(--fs-md)">No goals for today</div>
            <div class="empty-sub" style="font-size:var(--fs-sm)">Add a goal to see it here.</div>
            <button class="btn btn-primary btn-sm" data-action="quick-goal">${ui.icon('plus', 15)} Add goal</button>
          </div>`}
      </div>
    </div>`;

  node.querySelectorAll('[data-bar]').forEach((bar) => ui.animateBar(bar, Number(bar.dataset.bar)));
}

function renderWaterCard(root, state) {
  const today = todayKey();
  const target = water.waterTarget();
  const total = water.totalOn(state.waterEntries, today);
  const frac = clamp(total / target, 0, 1);
  const node = root.querySelector('#card-water');
  if (!node) return; // screen was replaced mid-render
  node.innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2 class="section-title">Water</h2>
        <button class="section-link" data-action="open-water">Open ${ui.icon('chevron-right', 14)}</button>
      </div>
      <div class="card card-interactive" data-action="open-water">
        <div class="flex-between">
          <div>
            <div style="font-size:22px;font-weight:800;letter-spacing:-0.02em">${formatWater(total, water.waterUnit())} <span class="muted" style="font-size:14px;font-weight:600">/ ${formatWater(target, water.waterUnit())}</span></div>
            <div class="muted" style="font-size:var(--fs-sm);font-weight:600;margin-top:2px">${frac >= 1 ? 'Goal reached — well done 💧' : `${formatWater(Math.max(0, target - total), water.waterUnit())} remaining`}</div>
          </div>
          <button class="btn-icon" data-action="water-mini" aria-label="Add water">${ui.icon('plus', 20)}</button>
        </div>
        <div class="progress-track" style="margin-top:12px"><div class="progress-fill" data-bar="${Math.round(frac * 100)}" style="${frac >= 1 ? 'background:var(--success)' : ''}"></div></div>
      </div>
    </div>`;
  node.querySelectorAll('[data-bar]').forEach((bar) => ui.animateBar(bar, Number(bar.dataset.bar)));
}

function renderGymCard(root, state) {
  const today = todayKey();
  const workoutsToday = gym.workoutsOn(state.workouts, today);
  const stats = gym.gymStats(state.workouts);
  const latest = state.workouts[0];
  const latestPhoto = state.photoList[0];
  const node = root.querySelector('#card-gym');
  if (!node) return; // screen was replaced mid-render

  const sub =
    stats.streak > 0
      ? `${stats.streak} day streak · ${stats.total} workouts logged`
      : state.workouts.length
        ? `${stats.total} workouts logged`
        : 'Your fitness journey starts here';

  node.innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2 class="section-title">Gym</h2>
        <button class="section-link" data-action="open-gym">Open ${ui.icon('chevron-right', 14)}</button>
      </div>
      <div class="card card-interactive" data-action="open-gym">
        <div class="flex-between">
          <div class="flex-col" style="gap:6px">
            <div class="flex-row" style="gap:8px">
              <span class="pill ${workoutsToday.length ? 'pill-success' : 'pill-warning'}">${workoutsToday.length ? 'Workout Complete ✓' : 'Workout Pending'}</span>
              ${stats.streak > 0 ? `<span class="pill pill-accent">${ui.icon('flame', 12)} ${stats.streak}</span>` : ''}
            </div>
            <div class="muted" style="font-size:var(--fs-sm);font-weight:600">${sub}</div>
            ${latest ? `<div class="muted" style="font-size:var(--fs-sm)">Last: ${ui.escapeHtml(latest.workoutType)} · ${formatDuration(latest.duration)}</div>` : ''}
          </div>
          ${latestPhoto
            ? `<button class="pressable" data-action="open-photos" aria-label="Latest progress photo" style="border-radius:14px;overflow:hidden;flex-shrink:0"><img src="${photos.photoUrl(latestPhoto)}" alt="Latest progress photo" style="width:64px;height:64px;object-fit:cover;border:1px solid var(--border)"></button>`
            : ''}
        </div>
      </div>
    </div>`;
}

function renderJournalCard(root, state) {
  const today = todayKey();
  const todayEntry = state.journalEntries.find((e) => e.date === today);
  const latest = state.journalEntries[0];
  const streak = journal.journalStreak(state.journalEntries);
  const node = root.querySelector('#card-journal');
  if (!node) return; // screen was replaced mid-render

  let status;
  if (todayEntry) status = 'Today’s reflection saved ✓';
  else if (latest) status = `Last written ${formatDate(latest.date, { short: true })}`;
  else status = 'Today’s reflection is waiting for you';

  node.innerHTML = `
    <div class="section">
      <div class="section-head">
        <h2 class="section-title">Journal</h2>
        <button class="section-link" data-action="open-journal">Open ${ui.icon('chevron-right', 14)}</button>
      </div>
      <div class="card card-interactive" data-action="open-journal">
        <div class="flex-between">
          <div class="grow">
            <div class="flex-row" style="gap:8px">
              <span class="pill ${todayEntry ? 'pill-success' : 'pill-info'}">${todayEntry ? 'Written today' : 'Not written yet'}</span>
              ${streak > 0 ? `<span class="pill pill-accent">${ui.icon('flame', 12)} ${streak} day streak</span>` : ''}
            </div>
            <div class="muted" style="font-size:var(--fs-sm);font-weight:600;margin-top:6px">${ui.escapeHtml(status)}</div>
            ${latest && !todayEntry ? `<div class="muted" style="font-size:var(--fs-sm);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">“${ui.escapeHtml(journal.entryPreview(latest, 60))}”</div>` : ''}
          </div>
          <button class="btn-icon" data-action="quick-journal" aria-label="New journal entry">${ui.icon('plus', 20)}</button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Quick-add water sheet
// ---------------------------------------------------------------------------

function openQuickWaterSheet(root) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(
      ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Add water'),
      ui.el('div', { class: 'chip-grid' })
    );
    const chips = wrap.querySelector('.chip-grid');
    const add = async (amount) => {
      await water.addWater(amount);
      ui.haptic();
      ui.toast(`+${amount} ml added`, 'success');
      const fresh = await loadState();
      loadState._cache = fresh;
      updateSections(root, fresh, ['progress', 'water']);
    };
    for (const amount of [100, 250, 500, 750]) {
      const chip = ui.el('button', { class: 'chip', type: 'button' }, `${amount} ml`);
      chip.addEventListener('click', () => add(amount));
      chips.append(chip);
    }
    const customRow = ui.el('div', { class: 'flex-row' }, [
      ui.el('input', { class: 'input grow', type: 'number', min: 50, max: 2000, placeholder: 'Custom ml', id: 'qw-custom' }),
      ui.el('button', { class: 'btn btn-ghost', type: 'button' }, 'Add'),
    ]);  customRow.querySelector('button').addEventListener('click', async () => {
    const value = Number(customRow.querySelector('input').value);
    if (!Number.isFinite(value) || value <= 0) {
      ui.toast('Enter a valid amount.', 'info');
      return;
    }
    await add(value);
    customRow.querySelector('input').value = '';
  });
  wrap.append(customRow, ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Done'));
  wrap.querySelector('.btn-primary').addEventListener('click', () => close());
  return wrap;
});
}