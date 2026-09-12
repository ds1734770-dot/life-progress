/**
 * Settings — appearance, personalization, per-feature preferences,
 * and safe data controls (export / import / clear with confirmation).
 */
import { getSettings, saveSettings, loadSettings, resetSettings } from '../settings.js';
import { ACHIEVEMENTS, loadAchievementRecords } from '../achievements.js';
import * as photos from '../photos.js';
import { dbExportAll, dbImportAll, dbResetAll } from '../db.js';
import { themeOptions, WORKOUT_TYPES } from '../models.js';
import { DEFAULT_LAUNCH_QUOTE, LAUNCH_QUOTE_MAX, launchQuote, sanitizeLaunchQuote, avatarMarkup, revokeAvatarUrls } from '../personalization.js';
import * as ui from '../ui.js';
import { go } from '../router.js';

export async function mount(root, params) {
  photos.revokePhotoUrls();
  const settings = getSettings();
  render(root, settings);
  refreshAchievementsSub(root);
}

/** Live "n of N unlocked" on the Achievements row (async, non-blocking). */
async function refreshAchievementsSub(root) {
  try {
    const records = await loadAchievementRecords();
    const known = new Set(records.map((r) => r.id));
    const sub = root.querySelector('#ach-settings-sub');
    if (sub) sub.textContent = `${known.size} of ${ACHIEVEMENTS.length} unlocked · View your accomplishments`;
  } catch {
    /* row keeps its static subtitle */
  }
}

function render(root, settings) {
  const name = (settings.name || '').trim() || 'friend';
  const bg = settings.backgroundImage;

  root.innerHTML = `
    <header style="margin-top:var(--sp-2)">
      <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em">Settings</h2>
      <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Make it yours</div>
    </header>

    <section class="section stagger">
      <div class="card flex-row pressable" data-action="open-avatar">
        ${avatarMarkup(settings, 42)}
        <div class="grow">
          <div style="font-weight:800;font-size:var(--fs-lg)">${ui.escapeHtml(name)}</div>
          <div class="muted" style="font-size:var(--fs-sm)">Personalize your experience</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-action="open-avatar">${ui.icon('edit', 15)} Edit</button>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Personalization</h3>
      <div class="settings-group">
        <div class="settings-row pressable" data-action="open-avatar">
          <div class="settings-row-icon">${ui.icon('user', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Choose avatar</div>
            <div class="settings-row-sub">Built-in, initials or your own photo</div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>
        <div class="settings-row pressable" data-action="edit-quote">
          <div class="settings-row-icon">${ui.icon('quote', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Motivational launch quote</div>
            <div class="settings-row-sub">Shown when you open the app</div>
            ${launchPreviewMarkup()}
          </div>
          <button class="btn btn-ghost btn-sm" data-action="edit-quote">${ui.icon('edit', 14)} Edit</button>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Appearance</h3>
      <div class="settings-group">
        <div class="settings-row" style="flex-wrap:wrap;gap:12px">
          <div class="settings-row-icon">${ui.icon('settings', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Theme</div>
            <div class="settings-row-sub">Applies instantly</div>
          </div>
          <div class="seg" style="flex:1;max-width:230px">
            ${themeOptions().map((opt) => `
              <button class="seg-item" data-action="theme" data-theme="${opt.value}" aria-selected="${settings.theme === opt.value}">${opt.label}</button>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Inspirational background</h3>
      <div class="settings-group">
        <div class="settings-row" style="align-items:stretch">
          <div class="settings-row-icon">${ui.icon('image', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Dashboard background</div>
            <div class="settings-row-sub">${bg ? 'Custom image set' : 'Default gradient'}</div>
            ${bg
              ? `<div style="margin-top:10px;border-radius:var(--r-m);overflow:hidden;max-height:140px;border:1px solid var(--border)"><img src="${bg.dataUrl}" alt="Background preview" style="width:100%;height:120px;object-fit:cover"></div>`
              : ''}
          </div>
          <div class="flex-col" style="gap:8px">
            <button class="btn btn-ghost btn-sm" data-action="change-bg">${ui.icon('image', 14)} Change</button>
            ${bg ? `<button class="btn btn-soft-danger btn-sm" data-action="remove-bg">${ui.icon('x', 14)} Remove</button>` : ''}
          </div>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Water</h3>
      <div class="settings-group">
        <div class="settings-row">
          <div class="settings-row-icon">${ui.icon('droplet', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Daily target</div>
            <div class="settings-row-sub">${settings.waterTarget >= 1000 ? `${Number((settings.waterTarget / 1000).toFixed(1))} L per day` : `${settings.waterTarget} ml per day`}</div>
          </div>
          <button class="btn btn-ghost btn-sm" data-action="water-target">${ui.icon('edit', 14)}</button>
        </div>
        <div class="settings-row" style="flex-wrap:wrap;gap:12px">
          <div class="settings-row-icon">${ui.icon('chart', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Measurement unit</div>
            <div class="settings-row-sub">How amounts are displayed</div>
          </div>
          <div class="seg" style="max-width:200px;flex:1">
            <button class="seg-item" data-action="unit" data-unit="ml" aria-selected="${settings.waterUnit === 'ml'}">Milliliters</button>
            <button class="seg-item" data-action="unit" data-unit="L" aria-selected="${settings.waterUnit === 'L'}">Liters</button>
          </div>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Goals</h3>
      <div class="settings-group">
        <div class="settings-row" style="flex-wrap:wrap;gap:12px">
          <div class="settings-row-icon">${ui.icon('target', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Default view</div>
            <div class="settings-row-sub">Opened when you visit Goals</div>
          </div>
          <div class="seg" style="max-width:200px;flex:1">
            ${['today', 'week', 'month', 'custom'].map((v) => `
              <button class="seg-item" data-action="goals-view" data-view="${v}" aria-selected="${settings.goalsDefaultView === v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
          </div>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Gym</h3>
      <div class="settings-group">
        <div class="settings-row" style="flex-wrap:wrap;gap:12px">
          <div class="settings-row-icon">${ui.icon('dumbbell', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Default workout type</div>
            <div class="settings-row-sub">Pre-selected when logging</div>
          </div>
          <select class="select" id="gym-type" style="max-width:150px;padding:8px 10px">
            ${WORKOUT_TYPES.map((t) => `<option value="${t}" ${settings.gymDefaultType === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Journal</h3>
      <div class="settings-group">
        <div class="settings-row" style="flex-wrap:wrap;gap:12px">
          <div class="settings-row-icon">${ui.icon('book', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Writing prompt</div>
            <div class="settings-row-sub">Shown while writing</div>
          </div>
          <input class="input" id="journal-prompt" type="text" value="${ui.escapeHtml(settings.journalPrompt)}" style="max-width:170px;padding:8px 10px" maxlength="60">
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Progress</h3>
      <div class="settings-group">
        <div class="settings-row pressable" data-action="open-achievements">
          <div class="settings-row-icon" style="background:color-mix(in srgb,var(--warning) 14%,transparent);color:var(--warning)">${ui.icon('star', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Achievements &amp; Badges</div>
            <div class="settings-row-sub" id="ach-settings-sub">View your accomplishments</div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>
      </div>
    </section>

    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Data</h3>
      <div class="settings-group">
        <div class="settings-row pressable" data-action="export-data">
          <div class="settings-row-icon">${ui.icon('download', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Export data</div>
            <div class="settings-row-sub">Download a full backup (JSON)</div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>
        <div class="settings-row pressable" data-action="import-data">
          <div class="settings-row-icon">${ui.icon('upload', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Import data</div>
            <div class="settings-row-sub">Restore from a backup file</div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>
        <div class="settings-row pressable" data-action="clear-data">
          <div class="settings-row-icon" style="background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger)">${ui.icon('trash', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title" style="color:var(--danger)">Clear all data</div>
            <div class="settings-row-sub">Permanently delete everything</div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>
      </div>
      <p class="muted" style="font-size:var(--fs-xs);margin-top:var(--sp-4);text-align:center;line-height:1.7">
        ${ui.icon('lock', 12)} Your journal, photos and workouts stay on this device.<br>
        Nothing is uploaded or tracked.
      </p>
    </section>
  `;

  root.querySelector('#gym-type').addEventListener('change', (e) => {
    saveSettings({ gymDefaultType: e.target.value });
    ui.toast('Gym preference saved', 'success');
  });
  root.querySelector('#journal-prompt').addEventListener('change', (e) => {
    saveSettings({ journalPrompt: e.target.value.trim() || 'How was your day?' });
    ui.toast('Journal preference saved', 'success');
  });

  ui.bindActions(root, {
    'open-avatar': () => go('avatar'),
    'open-achievements': () => go('achievements'),
    'edit-name': () => openNameDialog(root),
    'edit-quote': () => openQuoteEditor(root),
    theme: (d) => {
      saveSettings({ theme: d.theme });
      ui.haptic();
      render(root, getSettings());
    },
    unit: (d) => {
      saveSettings({ waterUnit: d.unit });
      ui.haptic();
      render(root, getSettings());
    },
    'goals-view': (d) => {
      saveSettings({ goalsDefaultView: d.view });
      ui.haptic();
      render(root, getSettings());
    },
    'change-bg': changeBackground,
    'remove-bg': removeBackground,
    'water-target': () => openWaterTargetDialog(root),
    'export-data': exportData,
    'import-data': importData,
    'clear-data': clearData,
  });
}

function openNameDialog(root) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Your name'));
    const input = ui.el('input', { class: 'input', type: 'text', placeholder: 'Name', value: getSettings().name, maxlength: '40' });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) {
        ui.toast('Enter your name.', 'info');
        return;
      }
      await saveSettings({ name });
      ui.toast('Name saved', 'success');
      ui.haptic();
      close();
      render(root, getSettings());
    });
    wrap.append(input, save);
    return wrap;
  });
}

// ---------------------------------------------------------------------------
// V1.1 — Motivational launch quote (view / edit / preview / save / reset)
// ---------------------------------------------------------------------------

/** Miniature replica of the launch screen: same background + overlay + type. */
function launchPreviewMarkup() {
  const settings = getSettings();
  const bg = settings.backgroundImage;
  const image = bg && typeof bg.dataUrl === 'string' ? bg.dataUrl : '';
  const style = image ? `background-image:url('${image}')` : '';
  return `
    <div class="launch-preview ${image ? 'has-image' : ''}" aria-hidden="true">
      <div class="launch-preview-bg" style="${style}"></div>
      <div class="launch-preview-content">
        <div class="launch-preview-quote">${ui.escapeHtml(launchQuote(settings))}</div>
        <div class="launch-preview-rule"></div>
        <div class="launch-preview-brand">Life Progress</div>
      </div>
    </div>`;
}

function openQuoteEditor(root) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col', id: 'quote-editor' });
    const title = ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Motivational launch quote');
    const sub = ui.el(
      'p',
      { class: 'muted', style: { fontSize: 'var(--fs-sm)', lineHeight: 1.6 } },
      'The words you see when you open Life Progress. Short works best.'
    );
    const counter = ui.el('div', {
      class: 'muted',
      id: 'quote-counter',
      style: { fontSize: 'var(--fs-xs)', fontWeight: 600, textAlign: 'right', marginTop: '4px' },
    });
    const input = ui.el('textarea', {
      class: 'textarea',
      id: 'quote-input',
      maxlength: String(LAUNCH_QUOTE_MAX),
      rows: '2',
      style: { minHeight: '72px' },
      'aria-label': 'Motivational launch quote',
    });
    input.value = launchQuote(getSettings());

    const preview = ui.el('div', { id: 'quote-preview' });
    const renderPreview = () => {
      preview.innerHTML = launchPreviewMarkup();
      preview.querySelector('.launch-preview-quote').textContent = sanitizeLaunchQuote(input.value) || ' '; // live text
    };
    const renderCounter = () => {
      const len = input.value.length;
      counter.textContent = `${len} / ${LAUNCH_QUOTE_MAX}`;
      counter.style.color = len >= LAUNCH_QUOTE_MAX ? 'var(--warning)' : 'var(--text-2)';
    };
    input.addEventListener('input', () => {
      renderPreview();
      renderCounter();
    });
    renderPreview();
    renderCounter();

    const actions = ui.el('div', { class: 'flex-row' });
    const reset = ui.el('button', { class: 'btn btn-ghost', type: 'button' }, 'Reset');
    const spacer = ui.el('div', { class: 'spacer' });
    const save = ui.el('button', { class: 'btn btn-primary', type: 'button' }, 'Save');
    actions.append(reset, spacer, save);

    save.addEventListener('click', async () => {
      const cleaned = sanitizeLaunchQuote(input.value);
      await saveSettings({ launchQuote: cleaned });
      ui.toast('Launch quote saved', 'success');
      ui.haptic();
      close();
      render(root, getSettings());
    });
    reset.addEventListener('click', async () => {
      input.value = DEFAULT_LAUNCH_QUOTE;
      renderPreview();
      renderCounter();
      await saveSettings({ launchQuote: DEFAULT_LAUNCH_QUOTE });
      ui.toast('Quote reset to default', 'info');
      ui.haptic();
      close();
      render(root, getSettings());
    });

    wrap.append(title, sub, input, counter, preview, actions);
    return wrap;
  });
}

async function changeBackground() {
  const file = await ui.pickFromGallery('image/*');
  if (!file) return;
  try {
    const blob = await photos.processImage(file, 1600, 0.82);
    const dataUrl = await ui.readFileAsDataURL(blob);
    await saveSettings({ backgroundImage: { dataUrl, name: file.name } });
    ui.toast('Background updated', 'success');
    ui.haptic();
    render(rootEl(), getSettings());
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
  render(rootEl(), getSettings());
}

function rootEl() {
  return document.getElementById('screen-root');
}

function openWaterTargetDialog(root) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col' });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Daily water target'));
    const input = ui.el('input', { class: 'input', type: 'number', min: 250, max: 10000, placeholder: 'ml per day', value: getSettings().waterTarget });
    const save = ui.el('button', { class: 'btn btn-primary btn-block', type: 'button' }, 'Save');
    save.addEventListener('click', async () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 250) {
        ui.toast('Enter a valid target.', 'info');
        return;
      }
      await saveSettings({ waterTarget: value });
      ui.toast('Daily goal updated', 'success');
      close();
      render(root, getSettings());
    });
    wrap.append(input, save);
    return wrap;
  });
}

async function exportData() {
  try {
    const dump = await dbExportAll(async (record) => ({
      ...record,
      blob: await photos.blobToDataURL(record.blob),
      thumb: await photos.blobToDataURL(record.thumb),
    }));
    // V1.1: the custom avatar image is a Blob in the settings record —
    // serialize it to a data URL so it survives the JSON round-trip.
    const settingsRecord = dump.data.settings?.[0];
    if (settingsRecord && settingsRecord.avatarImage instanceof Blob) {
      settingsRecord.avatarImage = await photos.blobToDataURL(settingsRecord.avatarImage);
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `life-progress-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ui.toast('Backup downloaded', 'success');
  } catch (err) {
    console.error(err);
    ui.toast('Export failed.', 'danger');
  }
}

async function importData() {
  const file = await ui.pickFromGallery('.json,application/json,text/json');
  if (!file) return;
  try {
    const text = await file.text();
    const dump = JSON.parse(text);
    if (!dump || dump.data == null) throw new Error('bad file');
    const ok = await ui.openDialog({
      title: 'Replace current data?',
      message: 'Importing a backup replaces all current entries on this device.',
      confirmLabel: 'Import',
      danger: true,
    });
    if (!ok) return;
    // V1.1: restore the custom avatar data URL back to a Blob BEFORE the
    // dump is written, so the stored settings record holds a real Blob.
    const settingsRecord = Array.isArray(dump.data.settings) ? dump.data.settings[0] : null;
    if (settingsRecord && typeof settingsRecord.avatarImage === 'string') {
      settingsRecord.avatarImage = await photos.dataURLToBlob(settingsRecord.avatarImage);
    }
    await dbImportAll(dump, async (record) => ({
      ...record,
      blob: await photos.dataURLToBlob(record.blob),
      thumb: await photos.dataURLToBlob(record.thumb),
    }));
    await loadSettings();
    ui.toast('Backup restored', 'success');
    ui.haptic(30);
    go('dashboard');
  } catch {
    ui.toast('That file is not a valid backup.', 'danger');
  }
}

async function clearData() {
  const ok = await ui.openDialog({
    title: 'Clear ALL data?',
    message: 'Every journal entry, goal, workout, photo and setting will be permanently deleted. This cannot be undone.',
    confirmLabel: 'Delete everything',
    danger: true,
  });
  if (!ok) return;
  try {
    await dbResetAll();
    resetSettings();
    photos.revokePhotoUrls();
    revokeAvatarUrls();
    ui.toast('All data cleared', 'info');
    go('dashboard');
  } catch {
    ui.toast('Could not clear data.', 'danger');
  }
}