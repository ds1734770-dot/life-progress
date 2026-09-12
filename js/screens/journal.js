/**
 * Journal — private, calm writing space. Timeline grouped by day, search,
 * mood + tags, streak, and a distraction-free editor screen.
 */
import { getSettings } from '../settings.js';
import * as journal from '../journal.js';
import { checkAchievementsNow } from '../celebration.js';
import { MOODS } from '../models.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import { todayKey, formatDate } from '../utils.js';

export async function mount(root, params, mode) {
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