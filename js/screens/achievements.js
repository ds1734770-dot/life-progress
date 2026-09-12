/**
 * Achievements & Badges — V1.2 Phase 2. A premium trophy cabinet.
 *
 * Reached from Settings (no new bottom tab). Renders from the achievement
 * domain (js/achievements.js) only — evaluation, progress, next milestone
 * and badge artwork all come from there; this screen owns presentation and
 * filtering alone.
 *
 * Layout: header (title + n/N unlocked ring) → category filters → UNLOCKED
 * grid → LOCKED / IN PROGRESS grid → badge detail sheet (evidence, earned
 * date, current stat, next milestone).
 */
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_CATEGORIES,
  CATEGORY_META,
  badgeMarkup,
  buildMetrics,
  achievementProgress,
  nextMilestone,
  loadAchievementRecords,
} from '../achievements.js';
import { loadHistoryData } from '../history.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { todayKey } from '../utils.js';

const FILTERS = ['all', ...ACHIEVEMENT_CATEGORIES.filter((c) => c !== 'all')];

export async function mount(root) {
  const [data, records] = await Promise.all([loadHistoryData(), loadAchievementRecords()]);
  const today = todayKey();
  const metrics = buildMetrics(data, today);
  const progress = new Map(ACHIEVEMENTS.map((d) => [d.id, achievementProgress(d, metrics)]));
  const earnedById = new Map(records.map((r) => [r.id, r.earnedAt]));

  // A badge is unlocked if a record exists (historical truth) OR the data
  // says it is earned right now (e.g. first evaluation before a sync).
  const isUnlocked = (d) => earnedById.has(d.id) || progress.get(d.id).earned;

  const state = { filter: 'all' };

  const unlockedCount = ACHIEVEMENTS.filter(isUnlocked).length;

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Achievements &amp; Badges</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Every badge represents something you achieved.</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-action="back">${ui.icon('arrow-left', 15)} Back</button>
    </header>

    <div class="card ach-progress-card stagger">
      <div class="ring-wrap">
        ${ui.ringMarkup(84, 9)}
        <div class="ring-center">
          <div style="font-size:17px;font-weight:800;font-variant-numeric:tabular-nums">${unlockedCount}</div>
          <div class="muted" style="font-size:10px;font-weight:700">of ${ACHIEVEMENTS.length}</div>
        </div>
      </div>
      <div class="grow">
        <div style="font-size:16px;font-weight:700">${unlockedCount} / ${ACHIEVEMENTS.length} unlocked</div>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600;margin-top:2px">Keep showing up — the next one is closer than you think.</div>
      </div>
    </div>

    <div class="ach-filters" role="tablist" aria-label="Badge categories">
      ${FILTERS.map((f) => `<button class="ach-filter" role="tab" data-action="pick-filter" data-filter="${f}" aria-selected="${f === state.filter}">${filterLabel(f)}</button>`).join('')}
    </div>

    <div id="ach-sections"></div>
  `;

  ui.setRing(root, Math.round((unlockedCount / ACHIEVEMENTS.length) * 100));

  ui.bindActions(root, {
    back: () => go('settings'),
    'pick-filter': (d) => {
      if (!FILTERS.includes(d.filter)) return;
      state.filter = d.filter;
      root.querySelectorAll('.ach-filter').forEach((chip) => {
        chip.setAttribute('aria-selected', chip.dataset.filter === state.filter ? 'true' : 'false');
      });
      renderSections();
    },
    'open-badge': (d, e, target) => openDetail(target.dataset.id),
  });

  renderSections();

  // -------------------------------------------------------------------------

  function filterLabel(f) {
    if (f === 'all') return 'All';
    const icon = { streak: 'flame', water: 'droplet', gym: 'dumbbell', goals: 'target', journal: 'book', overall: 'star' }[f];
    return `${ui.icon(icon, 13)} ${CATEGORY_META[f].label}`;
  }

  function renderSections() {
    const sections = root.querySelector('#ach-sections');
    const shown = ACHIEVEMENTS.filter((d) => state.filter === 'all' || d.category === state.filter);
    const unlocked = shown.filter(isUnlocked);
    const locked = shown.filter((d) => !isUnlocked(d));

    sections.replaceChildren(
      ui.el('div', { class: 'section' }, [
        unlocked.length
          ? ui.el('div', { class: 'ach-grid' }, unlocked.map((d) => badgeCard(d, true)))
          : ui.el('div', { class: 'empty', style: { padding: '18px 8px' } }, [
              ui.el('div', { class: 'empty-title', style: { fontSize: 'var(--fs-md)' } }, 'No badges here yet'),
              ui.el('div', { class: 'empty-sub', style: { fontSize: 'var(--fs-sm)' } }, 'Your first one is one action away.'),
            ]),
        locked.length
          ? ui.el('div', { class: 'section', style: { marginTop: 'var(--sp-5)' } }, [
              ui.el('h3', { class: 'section-title muted', style: { fontSize: 'var(--fs-md)' } }, 'Locked · in progress'),
              ui.el('div', { class: 'ach-grid' }, locked.map((d) => badgeCard(d, false))),
            ])
          : ui.el('div', { class: 'muted', style: { fontSize: 'var(--fs-sm)', textAlign: 'center', marginTop: 'var(--sp-4)' } },
              state.filter === 'all' ? 'Every badge unlocked. Remarkable.' : 'Everything in this category is unlocked.'),
      ])
    );
  }

  function badgeCard(definition, unlocked) {
    const p = progress.get(definition.id);
    const meta = CATEGORY_META[definition.category];
    const earnedAt = earnedById.get(definition.id);

    const card = ui.el(
      'button',
      {
        class: `ach-card ${unlocked ? 'unlocked' : 'locked'}`,
        type: 'button',
        'data-action': 'open-badge',
        'data-id': definition.id,
        'aria-label': unlocked
          ? `${definition.title}. ${meta.label} achievement. Unlocked.${earnedAt ? ` Earned ${formatDate(earnedAt)}.` : ''}`
          : `${definition.title}. ${definition.requirement} ${meta.label.toLowerCase()} achievement. Locked. Progress ${p.current} of ${p.target} ${definition.unit}s.`,
      },
      [
    ui.el('span', { class: 'ach-card-art' }),
        ui.el('span', { class: 'ach-card-title' }, definition.title),
        ui.el('span', { class: 'ach-card-req muted' }, unlocked ? (earnedAt ? formatDate(earnedAt) : 'Unlocked') : `${p.current} / ${p.target} ${definition.unit}s`),
      ]
    );

    // Badge artwork is markup, not text — insert it after creation.
    const art = badgeMarkup(definition, { unlocked, size: 58 });
    card.querySelector('.ach-card-art').innerHTML = art;

    if (!unlocked) {
      const bar = ui.el('div', { class: 'ach-progress-track', 'aria-hidden': 'true' });
      const fill = ui.el('div', { class: 'ach-progress-fill' });
      bar.append(fill);
      card.append(bar);
      requestAnimationFrame(() => {
        fill.style.width = `${p.pct}%`;
      });
    }
    return card;
  }

  async function openDetail(id) {
    const definition = ACHIEVEMENTS.find((a) => a.id === id);
    if (!definition) return;
    ui.haptic();
    const unlocked = isUnlocked(definition);
    const p = progress.get(definition.id);
    const meta = CATEGORY_META[definition.category];
    const earnedAt = earnedById.get(definition.id);
    const next = nextMilestone(definition.id, progress);

    const evidence = unlocked && typeof definition.evidence === 'function' ? definition.evidence(metrics) : [];

    const evidenceMarkup =
      unlocked && Array.isArray(evidence) && evidence.length
        ? `
          <div class="ach-detail-section">
            <div class="ach-detail-label">Your achievement</div>
            <div class="ach-evidence">${evidence
              .map((item) =>
                typeof item === 'string'
                  ? `<span class="ach-evidence-note">${ui.escapeHtml(item)}</span>`
                  : `<span class="ach-evidence-day">${ui.escapeHtml(item.label)} ${item.done ? '✓' : ''}</span>`
              )
              .join('')}</div>
          </div>`
        : '';

    const currentStat = currentStatLine(definition, metrics);
    const nextMarkup = next
      ? `
        <div class="ach-detail-section">
          <div class="ach-detail-label">Next milestone</div>
          <div class="ach-next-card">
            <span class="ach-next-title">${ui.escapeHtml(next.title)}</span>
            <span class="ach-next-req muted">${ui.escapeHtml(capitalize(next.requirement))}</span>
            <div class="ach-progress-track" style="margin-top:8px"><div class="ach-progress-fill" data-next-fill></div></div>
            <div class="muted" style="font-size:var(--fs-xs);font-weight:600;margin-top:5px">${progress.get(next.id).current} / ${progress.get(next.id).target} ${next.unit}s</div>
          </div>
        </div>`
      : '';

    const { element } = ui.openSheet((close) => {
      const wrap = ui.el('div', { class: 'ach-detail' });
      wrap.innerHTML = `
        <div class="ach-detail-head">
          <div class="ach-detail-badge">${badgeMarkup(definition, { unlocked, size: 76 })}</div>
          <div>
            <div class="ach-detail-title">${ui.escapeHtml(definition.title)}</div>
            <div class="muted" style="font-size:var(--fs-xs);font-weight:700;text-transform:uppercase;letter-spacing:0.06em">${meta.label}${unlocked ? ' · Unlocked' : ' · Locked'}</div>
          </div>
        </div>
        <p class="ach-detail-desc">${ui.escapeHtml(definition.description)}</p>
        <div class="ach-detail-req muted">${ui.escapeHtml(capitalize(definition.requirement))}</div>
        ${unlocked && earnedAt ? `<div class="ach-detail-earned">Earned ${formatDate(earnedAt)}</div>` : ''}
        ${!unlocked ? `<div class="ach-progress-track" style="margin-top:10px"><div class="ach-progress-fill" data-self-fill></div></div>
          <div class="muted" style="font-size:var(--fs-xs);font-weight:600;margin-top:5px">${p.current} / ${p.target} ${definition.unit}s${p.current > 0 ? ` — ${p.target - p.current} more to go` : ''}</div>` : ''}
        ${currentStat}
        ${evidenceMarkup}
        ${nextMarkup}
        <div class="dialog-actions">
          <button class="btn btn-ghost" data-detail-close type="button">Close</button>
        </div>`;
      wrap.querySelector('[data-detail-close]').addEventListener('click', close);
      return wrap;
    });

    const selfFill = element.querySelector('[data-self-fill]');
    if (selfFill) requestAnimationFrame(() => (selfFill.style.width = `${p.pct}%`));
    const nextFill = element.querySelector('[data-next-fill]');
    if (nextFill) {
      const np = progress.get(next.id);
      requestAnimationFrame(() => (nextFill.style.width = `${np.pct}%`));
    }
  }

  function currentStatLine(definition, m) {
    const lines = {
      streak: `Current activity streak: ${m.overallStreak} day${m.overallStreak === 1 ? '' : 's'}`,
      water: `Water goal reached on ${m.waterCompletedDays.length} day${m.waterCompletedDays.length === 1 ? '' : 's'} so far`,
      gym: `${m.workoutCount} workout${m.workoutCount === 1 ? '' : 's'} logged so far`,
      goals: `Goal completions on ${m.goalCompletionCount} day${m.goalCompletionCount === 1 ? '' : 's'} so far`,
      journal: `Journal entries on ${m.journalDayCount} day${m.journalDayCount === 1 ? '' : 's'} so far`,
      overall: `Full days in a row: ${m.overallStreak}`,
    };
    const text = lines[definition.category];
    return text ? `<div class="ach-detail-stat">${text}</div>` : '';
  }

  function formatDate(ts) {
    return new Date(Number(ts) || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function capitalize(str) {
    const s = String(str || '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
