/**
 * Journal — private, calm writing space. Timeline grouped by day, search,
 * mood + tags, streak, and a distraction-free editor screen.
 */
import { getSettings } from '../settings.js';
import * as journal from '../journal.js';
import { checkAchievementsNow } from '../celebration.js';
import { MOODS } from '../models.js';
import * as ui from '../ui.js';
import * as lock from '../journalLock.js';
import { dailyPrompt, onThisDay, GRATITUDE_TEMPLATE } from '../journalExtras.js';
import { go } from '../router.js';
import { todayKey, formatDate } from '../utils.js';

/** PIN keypad shown instead of the journal while it is locked. */
function renderLock(root, onUnlock) {
  root.innerHTML = `
    <div class="lock-screen">
      <div class="lock-icon">${ui.icon('lock', 30)}</div>
      <h2 style="font-size:var(--fs-xl);font-weight:800">Journal locked</h2>
      <div class="muted" style="font-size:var(--fs-sm)">Enter your PIN to continue</div>
      <div class="lock-dots" id="lock-dots" aria-live="polite"></div>
      <div class="lock-pad">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button class="lock-key" data-key="${n}">${n}</button>`).join('')}
        <button class="lock-key lock-aux" data-key="back" aria-label="Delete">${ui.icon('arrow-left', 20)}</button>
        <button class="lock-key" data-key="0">0</button>
        <button class="lock-key lock-aux lock-go" data-key="go" aria-label="Unlock">${ui.icon('check', 22)}</button>
      </div>
      <div class="lock-error" id="lock-error" role="alert"></div>
    </div>`;
  let pin = '';
  const dots = root.querySelector('#lock-dots');
  const error = root.querySelector('#lock-error');
  const paint = () => {
    dots.innerHTML = Array.from({ length: Math.max(lock.PIN_MIN, pin.length) }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('');
  };
  paint();
  async function submit() {
    if (!pin) return;
    if (await lock.verifyPin(pin)) {
      lock.markUnlocked();
      ui.haptic(20);
      onUnlock();
      return;
    }
    error.textContent = 'Wrong PIN. Try again.';
    pin = '';
    paint();
    ui.haptic([30, 40, 30]);
    const pad = root.querySelector('.lock-screen');
    pad.classList.remove('shake');
    void pad.offsetWidth;
    pad.classList.add('shake');
  }
  root.querySelector('.lock-pad').addEventListener('click', (e) => {
    const k = e.target.closest('[data-key]')?.dataset.key;
    if (!k) return;
    error.textContent = '';
    if (k === 'back') pin = pin.slice(0, -1);
    else if (k === 'go') return submit();
    else if (pin.length < lock.PIN_MAX) pin += k;
    paint();
    ui.haptic(6);
    // Auto-submit at the longest length; otherwise the user taps the check.
    if (pin.length === lock.PIN_MAX) submit();
  });
}

export async function mount(root, params, mode) {
  if (lock.isLocked()) {
    renderLock(root, () => mount(root, params, mode));
    return;
  }
  if (mode === 'edit') {
    const entries = await journal.getAllEntries();
    const entry = params[1] ? entries.find((e) => e.id === params[1]) : null;
    renderEditor(root, entry);
    return;
  }
  const entries = await journal.getAllEntries();
  const state = { entries, query: '' };
  render(root, state);
}

function memoriesMarkup(entries) {
  const mem = onThisDay(entries);
  if (!mem.length) return '';
  return `
    <section class="section stagger">
      <div class="section-head"><h3 class="section-title" style="font-size:var(--fs-lg)">On this day</h3></div>
      <div class="flex-col">
        ${mem.map((m) => `<div class="card card-interactive memory" data-action="entry-edit" data-id="${m.entry.id}" role="button" tabindex="0">
          <div class="memory-label">${ui.escapeHtml(m.label)} ${m.entry.mood || ''}</div>
          <div style="font-weight:700">${ui.escapeHtml(m.entry.title || 'Untitled')}</div>
          <div class="muted memory-text">${ui.escapeHtml(journal.entryPreview(m.entry, 110))}</div>
        </div>`).join('')}
      </div>
    </section>`;
}

/** 14-day mood line (SVG). Hidden until there are at least two mood days. */
function moodChartMarkup(entries) {
  const series = journal.moodSeries(entries, 14);
  const pts = series.filter((p) => p.score !== null);
  if (pts.length < 2) return '';
  const W = 320, H = 110, padX = 16, top = 14, bottom = 24;
  const x = (i) => padX + (i * (W - padX * 2)) / (series.length - 1);
  const y = (score) => top + ((5 - score) / 4) * (H - top - bottom);
  const coords = series.map((p, i) => (p.score === null ? null : [x(i), y(p.score)]));
  const known = coords.filter(Boolean);
  const line = known.map((c, i) => `${i ? 'L' : 'M'}${c[0].toFixed(1)} ${c[1].toFixed(1)}`).join(' ');
  const area = `${line} L${known[known.length - 1][0].toFixed(1)} ${H - bottom} L${known[0][0].toFixed(1)} ${H - bottom} Z`;
  const avg = pts.reduce((t, p) => t + p.score, 0) / pts.length;
  const label = avg >= 4.3 ? 'Glowing lately ✨' : avg >= 3.5 ? 'Mostly good vibes' : avg >= 2.5 ? 'A steady stretch' : 'Be gentle with yourself 💛';
  const axis = series
    .map((p, i) => (i % 3 === 0 || i === series.length - 1 ? `<text class="mood-axis" x="${x(i).toFixed(1)}" y="${H - 6}">${Number(p.key.slice(8))}</text>` : ''))
    .join('');
  const dots = series
    .map((p, i) => (p.emoji ? `<text class="mood-dot" x="${x(i).toFixed(1)}" y="${y(p.score).toFixed(1)}">${p.emoji}</text>` : ''))
    .join('');
  return `
    <section class="section stagger">
      <div class="card mood-card">
        <div class="flex-between" style="margin-bottom:6px">
          <h3 class="section-title" style="font-size:var(--fs-lg)">Mood · 14 days</h3>
          <span class="pill pill-accent">${pts.length} logged</span>
        </div>
        <svg class="mood-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Mood over the last 14 days. ${label}">
          <defs><linearGradient id="mood-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity="0.35"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
          <line class="mood-grid" x1="${padX}" x2="${W - padX}" y1="${y(5)}" y2="${y(5)}"/>
          <line class="mood-grid" x1="${padX}" x2="${W - padX}" y1="${y(3)}" y2="${y(3)}"/>
          <line class="mood-grid" x1="${padX}" x2="${W - padX}" y1="${y(1)}" y2="${y(1)}"/>
          <path class="mood-area" d="${area}"/>
          <path class="mood-line" d="${line}"/>
          ${dots}${axis}
        </svg>
        <div class="mood-caption">${label}</div>
      </div>
    </section>`;
}

function render(root, state) {
  const stats = journal.journalStats(state.entries);
  const filtered = journal.searchEntries(state.entries, state.query);
  const groups = journal.groupByDay(filtered);

  root.innerHTML = `
    <header class="flex-between" style="margin-top:var(--sp-2)">
      <div>
        <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Journal</h2>
        <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Your story starts with one page</div>
      </div>
    </header>

    <section class="section stagger">
      <div class="stat-grid">
        <div class="stat"><div class="stat-value">${stats.streak}</div><div class="stat-label">Streak</div></div>
        <div class="stat"><div class="stat-value">${stats.total}</div><div class="stat-label">Entries</div></div>
        <div class="stat"><div class="stat-value">${stats.thisMonth}</div><div class="stat-label">This month</div></div>
      </div>
    </section>

    ${memoriesMarkup(state.entries)}

    ${moodChartMarkup(state.entries)}

    <section class="section stagger">
      <div class="search-box">
        ${ui.icon('search', 17)}
        <input class="input" id="journal-search" type="search" placeholder="Search entries, tags…" value="${ui.escapeHtml(state.query)}">
      </div>
      <button class="btn btn-primary btn-block" data-action="new-entry" style="margin-top:var(--sp-3)">
        ${ui.icon('plus', 18)} New entry
      </button>
    </section>

    <section class="section" id="journal-timeline">
      ${state.entries.length === 0
        ? ui.emptyState({
            iconName: 'book',
            title: 'Your story starts with one page',
            sub: 'Write one honest line today. That’s enough.',
            actionLabel: 'Write your first entry',
            action: () => go('journal/edit'),
          }).outerHTML
        : filtered.length === 0
          ? ui.emptyState({
              iconName: 'search',
              title: 'No matches',
              sub: 'Try a different search.',
            }).outerHTML
          : groups
              .map(
                ([day, entries]) => `
                <div class="journal-day stagger">
                  <div class="journal-day-head">
                    <span class="journal-day-date">${day === todayKey() ? 'Today' : formatDate(day)}</span>
                    <span class="journal-day-count">${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}</span>
                  </div>
                  <div class="flex-col">
                    ${entries.map((e) => entryCard(e)).join('')}
                  </div>
                </div>`
              )
              .join('')}
    </section>
  `;

  const search = root.querySelector('#journal-search');
  search.addEventListener('input', () => {
    state.query = search.value;
    render(root, state);
    // Re-rendering the whole screen steals focus from the search input after
    // every keystroke — restore it and keep the caret at the end.
    const fresh = root.querySelector('#journal-search');
    if (fresh && fresh === document.activeElement) {
      // already focused — keep the caret at the end after re-render
      const len = fresh.value.length;
      fresh.setSelectionRange(len, len);
    } else if (fresh) {
      fresh.focus();
      const len = fresh.value.length;
      fresh.setSelectionRange(len, len);
    }
  });

  ui.bindActions(root, {
    'new-entry': () => go('journal/edit'),
    'entry-edit': (d) => go(`journal/edit/${d.id}`),
    'entry-delete': async (d) => {
      const entry = state.entries.find((e) => e.id === d.id);
      const ok = await ui.openDialog({
        title: 'Delete entry?',
        message: entry.title ? `“${entry.title}” will be removed forever.` : 'This entry will be removed forever.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await journal.deleteEntry(d.id);
      state.entries = state.entries.filter((e) => e.id !== d.id);
      ui.toast('Entry deleted', 'info');
      render(root, state);
    },
  });
}

function entryCard(e) {
  const preview = journal.entryPreview(e, 120);
  return `
    <div class="card card-tight pressable" data-action="entry-edit" data-id="${e.id}">
      <div class="flex-between">
        <div class="grow">
          ${e.title ? `<div class="row-title" style="font-weight:700">${ui.escapeHtml(e.title)}</div>` : ''}
          ${e.content ? `<div class="muted" style="font-size:var(--fs-sm);margin-top:3px;line-height:1.55">${ui.escapeHtml(preview)}</div>` : ''}
          <div class="goal-meta" style="margin-top:8px">
            ${e.mood ? `<span class="pill" style="font-size:var(--fs-md);padding:2px 8px">${e.mood}</span>` : ''}
            ${(e.tags || []).map((t) => `<span class="pill pill-info">#${ui.escapeHtml(t)}</span>`).join('')}
            <span class="pill">${formatDate(e.date, { short: true })}</span>
          </div>
        </div>
        <button class="btn-icon" style="width:34px;height:34px" data-action="entry-delete" data-id="${e.id}" aria-label="Delete entry">${ui.icon('trash', 15)}</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function renderEditor(root, entry) {
  const settings = getSettings();
  const isEdit = Boolean(entry);
  root.innerHTML = `
    <div class="journal-editor">
      <div class="flex-between">
        <button class="btn btn-ghost btn-sm" data-action="back">${ui.icon('arrow-left', 15)} Back</button>
        <button class="btn btn-primary btn-sm" data-action="save-entry">${ui.icon('check', 15)} Save</button>
      </div>
      <input class="editor-title" id="j-title" type="text" placeholder="Title (optional)" value="${ui.escapeHtml(entry?.title || '')}" maxlength="120">
      <div class="prompt-row" id="prompt-row">
        <button class="chip" data-action="use-prompt" type="button">${ui.icon('sparkles', 14)} Need a prompt?</button>
        <button class="chip" data-action="use-gratitude" type="button">🙏 Gratitude</button>
      </div>
      <textarea class="editor-body" id="j-body" placeholder="${ui.escapeHtml(settings.journalPrompt || 'How was your day?')}">${ui.escapeHtml(entry?.content || '')}</textarea>
      <div class="section" style="margin-top:var(--sp-5)">
        <div class="section-title" style="font-size:var(--fs-md);margin-bottom:8px">How are you feeling?</div>
        <div class="mood-row" id="mood-row">
          ${MOODS.map((m) => `<button class="mood ${entry?.mood === m ? 'active' : ''}" data-mood="${m}"><span class="mood-emoji">${m}</span></button>`).join('')}
        </div>
      </div>
      <div class="field" style="margin-top:var(--sp-4)">
        <label class="field-label" for="j-tags">Tags (comma separated)</label>
        <input class="input" id="j-tags" type="text" placeholder="gym, focus, wins" value="${ui.escapeHtml((entry?.tags || []).join(', '))}">
      </div>
    </div>
  `;

  let mood = entry?.mood || null;
  root.querySelectorAll('[data-mood]').forEach((btn) => {
    btn.addEventListener('click', () => {
      mood = btn.dataset.mood;
      root.querySelectorAll('[data-mood]').forEach((b) => b.classList.toggle('active', b === btn));
      ui.haptic();
    });
  });

  ui.bindActions(root, {
    'use-prompt': () => {
      const body = root.querySelector('#j-body');
      const prompt = dailyPrompt();
      body.placeholder = prompt;
      if (!body.value.trim()) body.value = `${prompt}\n\n`;
      body.focus();
      body.setSelectionRange(body.value.length, body.value.length);
      ui.haptic();
    },
    'use-gratitude': () => {
      const body = root.querySelector('#j-body');
      const title = root.querySelector('#j-title');
      const tags = root.querySelector('#j-tags');
      if (!body.value.trim()) body.value = GRATITUDE_TEMPLATE;
      if (!title.value.trim()) title.value = 'Gratitude';
      if (!/(^|,)\s*gratitude\s*(,|$)/i.test(tags.value)) tags.value = tags.value.trim() ? `${tags.value.trim()}, gratitude` : 'gratitude';
      body.focus();
      ui.haptic();
    },
    back: async () => {
      const title = root.querySelector('#j-title').value.trim();
      const content = root.querySelector('#j-body').value.trim();
      const started = Boolean(title || content);
      const changed = started && (!entry || title !== (entry.title || '') || content !== (entry.content || ''));
      if (changed) {
        const ok = await ui.openDialog({
          title: 'Discard changes?',
          message: 'Your entry has unsaved changes.',
          confirmLabel: 'Discard',
          danger: true,
        });
        if (!ok) return;
      }
      go('journal');
    },
    'save-entry': async () => {
      const title = root.querySelector('#j-title').value.trim();
      const content = root.querySelector('#j-body').value.trim();
      const err = (await import('../models.js')).validateJournalEntry({ title, content });
      if (err) {
        ui.toast(err, 'info');
        return;
      }
      const tags = root
        .querySelector('#j-tags')
        .value.split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      await journal.saveEntry({ id: entry?.id, title, content, mood, tags, date: entry?.date || todayKey() });
      checkAchievementsNow(); // V1.2: evaluate + celebrate (fire-and-forget)
      ui.haptic(20);
      ui.toast(isEdit ? 'Entry updated' : 'Entry saved', 'success');
      go('journal');
    },
  });
}