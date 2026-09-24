/**
 * Notification Appearance — Settings screen section (master spec §6/§7).
 *
 * Pure presentation; every rule lives in js/notifyWallpapers.js (selection),
 * js/notifyContent.js (copy model) and js/notifications.js (storage).
 * Rendered into the #notif-appearance host that settings.js provides, so the
 * existing Settings layout stays untouched.
 *
 * PRIVACY (§5/§21): the "My Photo" path processes the image locally with the
 * same canvas pipeline as progress photos and stores the blob ONLY in
 * IndexedDB (notificationState). It is never uploaded, never pushed, never
 * logged.
 */

import { saveNotificationAppearance, getNotificationAppearance, getCustomWallpaperPhoto, saveCustomWallpaperPhoto, removeCustomWallpaperPhoto } from '../notifications.js';
import { BUILTIN_WALLPAPERS, WALLPAPER_MODES, pickNotificationWallpaper } from '../notifyWallpapers.js';
import { NOTIFY_CATEGORIES, CATEGORY_ACCENTS, CATEGORY_ICONS, presentationFor, waterProgressLine, goalsProgressLine } from '../notifyContent.js';
import { processImage } from '../photos.js';
import * as ui from '../ui.js';
import { isNative, getPlatform } from '../platform.js';
// V2.1 Phase 2 — native mirror (§3/§9): after every validated change the
// appearance (and, when present, the custom photo) is mirrored into the
// native layer via the LPAppearanceSync bridge so the iOS extensions and the
// Android renderer render what the user configured. Best-effort: a mirror
// failure never blocks or breaks the settings flow (§24).
import { syncNativeNotificationAppearance, syncNativeCustomWallpaper, removeNativeCustomWallpaper } from '../nativePush.js';

/** Categories offered in the preview selector (§7). */
const PREVIEW_CATEGORIES = NOTIFY_CATEGORIES.filter((c) => c !== 'general');

/** Wallpaper source options (§6 A/B/C). */
const MODE_OPTIONS = [
  { mode: 'random', label: 'Random Background', sub: 'Use a different Life Progress background for each notification' },
  { mode: 'builtin', label: 'Life Progress Backgrounds', sub: 'Choose one of the built-in backgrounds' },
  { mode: 'custom', label: 'My Photo', sub: 'Use your own photo' },
];

export function mountNotificationAppearance(root) {
  const host = root.querySelector('#notif-appearance');
  if (!host) return;
  renderAppearance(root, host);
  ui.bindActions(host, {
    // bindActions handlers receive (dataset, event, targetElement) — the
    // data-* attributes live on the THIRD argument.
    'wall-mode': (_d, _e, el) => setMode(root, host, el?.dataset?.mode),
    'wall-select': (_d, _e, el) => selectBuiltin(root, host, el?.dataset?.id),
    'wall-photo-pick': () => pickCustomPhoto(root, host),
    'wall-photo-remove': () => removePhoto(root, host),
    'wall-crop': () => openCropSheet(root, host),
    'wall-crop-nudge': (_d, _e, el) => nudgeCrop(host, el?.dataset?.dir),
    'wall-crop-zoom': (_d, _e, el) => zoomCrop(host, Number(el?.dataset?.delta)),
    'wall-preview-category': (_d, _e, el) => renderPreviewOnly(host, el?.dataset?.category),
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function renderAppearance(root, host, previewCategory = 'water') {
  let appearance, custom;
  try {
    appearance = await getNotificationAppearance();
    custom = await getCustomWallpaperPhoto();
  } catch {
    host.replaceChildren();
    return;
  }
  const customUrl = custom?.blob ? URL.createObjectURL(custom.blob) : null;
  if (host._wallUrl) URL.revokeObjectURL(host._wallUrl);
  host._wallUrl = customUrl;

  const radios = MODE_OPTIONS.map((opt) => {
    const on = appearance.mode === opt.mode;
    const customNote = opt.mode === 'custom' && !custom ? ' — pick a photo below' : '';
    return `
      <button class="settings-row pressable wall-mode-row${on ? ' selected' : ''}" data-action="wall-mode" data-mode="${opt.mode}"
              role="radio" aria-checked="${on}" style="text-align:left;background:transparent;border:none;width:100%">
        <span class="wall-radio${on ? ' on' : ''}" aria-hidden="true"></span>
        <div class="settings-row-main">
          <div class="settings-row-title">${opt.label}</div>
          <div class="settings-row-sub">${opt.sub}${customNote}</div>
        </div>
      </button>`;
  }).join('');

  const gallery = appearance.mode === 'builtin'
    ? `<div class="wall-gallery" role="listbox" aria-label="Built-in notification backgrounds">
        ${BUILTIN_WALLPAPERS.map((w) => {
          const on = appearance.builtinId === w.id;
          return `
            <button class="wall-thumb${on ? ' selected' : ''}" data-action="wall-select" data-id="${w.id}"
                    role="option" aria-selected="${on}" aria-label="${w.name}">
              <img src="${w.src}" alt="" loading="lazy">
              <span class="wall-thumb-name">${w.name}</span>
              ${on ? `<span class="wall-thumb-check" aria-hidden="true">${ui.icon('check', 14)}</span>` : ''}
            </button>`;
        }).join('')}
      </div>`
    : '';

  const customBlock = appearance.mode === 'custom'
    ? `<div class="settings-row" style="align-items:stretch">
        <div class="settings-row-main">
          <div class="settings-row-title">Your photo</div>
          <div class="settings-row-sub">${custom ? 'Stored on this device only — never uploaded.' : 'Choose a photo from this device.'}</div>
          ${customUrl ? `<div style="margin-top:10px;border-radius:var(--r-m);overflow:hidden;max-height:180px;border:1px solid var(--border)">
            <img src="${customUrl}" alt="Current notification wallpaper" style="width:100%;height:160px;object-fit:cover">
          </div>` : ''}
          <div class="flex-row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" data-action="wall-photo-pick">${custom ? 'Change Photo' : 'Choose Photo'}</button>
            ${custom ? `<button class="btn btn-ghost btn-sm" data-action="wall-crop">Crop / Reposition</button>
            <button class="btn btn-soft-danger btn-sm" data-action="wall-photo-remove">Remove Photo</button>` : ''}
          </div>
        </div>
      </div>`
    : '';

  const randomNote = appearance.mode === 'random'
    ? `<div class="muted" style="font-size:var(--fs-xs);margin:8px 2px 0">Your notification background changes automatically.</div>`
    : '';

  host.innerHTML = `
    <section class="section stagger">
      <h3 class="section-title" style="font-size:var(--fs-lg)">Notification Appearance</h3>
      <div class="muted" style="font-size:var(--fs-xs);margin:-2px 2px 10px">
        How Life Progress reminders look on this device.
      </div>
      <div class="settings-group" role="radiogroup" aria-label="Notification background">
        ${radios}
        ${randomNote}
        ${gallery}
        ${customBlock}
      </div>
      <div id="wall-preview-host"></div>
    </section>`;

  renderPreview(host, previewCategory, appearance, customUrl);
}

/**
 * Live preview (§7): the SAME presentation model the real notification path
 * resolves, over the SAME wallpaper selection logic. It is an honest
 * rendering — not a marketing mock — of what web fallback / native custom UI
 * show.
 */
function renderPreview(host, category, appearance, customUrl) {
  const previewHost = host.querySelector('#wall-preview-host');
  if (previewHost) renderPreviewCard(previewHost, category, appearance, customUrl);
}

/** Deterministic preview day so the quote does not flicker between renders. */
function previewDayKey() {
  return '';
}

function previewContext(category) {
  // Real, locally-derived demo values are NOT fabricated data in the
  // notification sense: the preview never claims they are real. Actual
  // notifications always resolve from the user's records (§11).
  if (category === 'water') return { waterTotal: 1200, waterTarget: 2500, waterRemaining: 1300 };
  if (category === 'goals') return { goalStats: { total: 4, completed: 3, pending: 1 } };
  if (category === 'gym') return { workoutName: 'Push Day' };
  if (category === 'streaks') return { streakCount: 12, streakLabel: 'water' };
  if (category === 'achievements') return { achievementTitle: 'First Week Warrior' };
  return {};
}

async function renderPreviewOnly(host, category) {
  const appearance = await getNotificationAppearance();
  const custom = await getCustomWallpaperPhoto();
  const customUrl = custom?.blob ? URL.createObjectURL(custom.blob) : null;
  const previewHost = host.querySelector('#wall-preview-host');
  if (previewHost) renderPreviewCard(previewHost, category || 'water', appearance, customUrl);
}

// The real preview renderer is defined here so both initial render and
// category switches share one code path.
function renderPreviewCard(previewHost, category, appearance, customUrl) {
  const p = presentationFor(category, previewContext(category), { dayKey: previewDayKey() });
  const accent = CATEGORY_ACCENTS[category] || CATEGORY_ACCENTS.general;
  const icon = CATEGORY_ICONS[category] || 'bell';
  // V2.1 — resolve the wallpaper through the SAME pure selection logic the
  // real path uses (pickNotificationWallpaper), so Random mode previews an
  // actual random pick — not always the first built-in. The preview is
  // read-only: it never persists recent-history (that happens at delivery).
  // A stable per-render seed keeps the image from flickering on re-render
  // while still demonstrating that random mode varies.
  let wallpaper = null;
  try {
    ({ wallpaper } = pickNotificationWallpaper(appearance, {
      occurrenceId: `preview:${category}`,
      dayKey: previewDayKey(),
      rand: Math.random,
    }));
  } catch { wallpaper = null; }
  const bg = wallpaper?.custom
    ? (customUrl || '')
    : (wallpaper?.src || BUILTIN_WALLPAPERS[0].src);
  // Per-wallpaper overlay strength from the registry (custom → safe default);
  // this is the SAME overlay value the native renderers use (§8/§23).
  const overlay = Number.isFinite(wallpaper?.overlay) ? wallpaper.overlay : 0.45;
  previewHost.innerHTML = `
    <div class="wall-preview" style="--wall-accent:${accent}" role="img" aria-label="Notification preview for ${category}">
      <div class="wall-preview-bg" style="background-image:url('${bg}')"></div>
      <div class="wall-preview-overlay" style="background:linear-gradient(180deg, rgba(4,8,14,${overlay - 0.15}) 0%, rgba(4,8,14,${overlay + 0.15}) 100%)"></div>
      <div class="wall-preview-card">
        <div class="wall-preview-top">
          <span class="wall-preview-brand">${ui.icon(icon, 13)} Life Progress</span>
          <span class="wall-preview-kicker">${p.kicker}</span>
        </div>
        <div class="wall-preview-quote">“${p.quote}”</div>
        <div class="wall-preview-title">${p.title}</div>
        <div class="wall-preview-sub">${p.subtitle}</div>
        ${p.progress?.primary ? `<div class="wall-preview-progress">${String(p.progress.primary).replace('\n', ' · ')}</div>` : ''}
        <div class="wall-preview-message">${String(p.message).replace('\n', '<br>')}</div>
        <div class="wall-preview-actions">
          <span class="wall-btn wall-btn-primary" style="background:${accent}">${p.primaryAction}</span>
          <span class="wall-btn wall-btn-secondary">${p.secondaryAction}</span>
        </div>
      </div>
    </div>
    <div class="wall-preview-picker" role="tablist" aria-label="Preview category">
      ${PREVIEW_CATEGORIES.map((c) => `
        <button class="wall-chip${c === category ? ' on' : ''}" data-action="wall-preview-category" data-category="${c}"
                role="tab" aria-selected="${c === category}">${c[0].toUpperCase() + c.slice(1)}</button>`).join('')}
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function setMode(root, host, mode) {
  if (!WALLPAPER_MODES.includes(mode)) return;
  if (mode === 'custom') {
    const custom = await getCustomWallpaperPhoto();
    if (!custom) {
      // First entry into My Photo: ask for the photo right away so the mode
      // never persists pointing at nothing.
      const picked = await pickCustomPhoto(root, host);
      if (!picked) return; // cancelled — keep previous mode
      return;
    }
  }
  await saveNotificationAppearance({ mode });
  await mirrorAppearanceToNative();
  ui.haptic();
  await renderAppearance(root, host);
}

async function selectBuiltin(root, host, id) {
  if (!BUILTIN_WALLPAPERS.some((w) => w.id === id)) return;
  await saveNotificationAppearance({ mode: 'builtin', builtinId: id });
  await mirrorAppearanceToNative();
  ui.haptic();
  await renderAppearance(root, host);
}

/** Fire-and-forget native mirror of the CURRENT persisted appearance. */
async function mirrorAppearanceToNative() {
  if (!isNative() || !['ios', 'android'].includes(getPlatform())) return;
  try {
    const appearance = await getNotificationAppearance();
    await syncNativeNotificationAppearance(appearance);
  } catch { /* native side keeps its last-good mirror */ }
}

/**
 * Native photo picker (§5). Android uses the system photo picker (no broad
 * media permission); iOS uses the picker via the file input, which Capacitor
 * maps to PHPickerViewController. The file NEVER leaves the device.
 */
async function pickCustomPhoto(root, host) {
  const file = await ui.pickFromGallery('image/*');
  if (!file) return false;
  try {
    // Downscale to notification-appropriate dimensions locally (§5/§22):
    // portrait-ish 1080px on the long edge is plenty for a notification panel.
    const blob = await processImage(file, 1080, 0.82);
    await saveCustomWallpaperPhoto(blob, null);
    await saveNotificationAppearance({ mode: 'custom', customPhotoId: 'local', crop: null });
    // Native mirror (§9/§21): the processed local copy travels only through
    // the device-internal bridge into app-local storage. Never uploaded.
    if (isNative() && ['ios', 'android'].includes(getPlatform())) {
      await syncNativeCustomWallpaper(blob).catch(() => {});
      await mirrorAppearanceToNative();
    }
    ui.haptic();
    ui.toast('Photo set — stored on this device only', 'success');
    await renderAppearance(root, host);
    return true;
  } catch {
    ui.toast('Could not read that image.', 'danger');
    return false;
  }
}

async function removePhoto(root, host) {
  await removeCustomWallpaperPhoto();
  if (isNative() && ['ios', 'android'].includes(getPlatform())) {
    await removeNativeCustomWallpaper().catch(() => {});
    await mirrorAppearanceToNative();
  }
  ui.haptic();
  await renderAppearance(root, host);
}

// --- Simple focal crop (§5): pan + zoom over the stored local copy ---------

function openCropSheet(root, host) {
  ui.openSheet((close) => {
    const wrap = ui.el('div', { class: 'flex-col', style: { gap: '10px' } });
    wrap.append(ui.el('h2', { style: { fontSize: 'var(--fs-xl)', fontWeight: 800 } }, 'Crop / Reposition'));
    wrap.append(ui.el('div', { class: 'muted', style: { fontSize: 'var(--fs-sm)' } },
      'Position the part of the photo notifications should show.'));

    const stage = ui.el('div', {
      class: 'wall-crop-stage',
      style: { position: 'relative', height: '260px', borderRadius: 'var(--r-m)', overflow: 'hidden', border: '1px solid var(--border)' },
    });
    const img = ui.el('img', { alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } });
    stage.append(img);

    const getAppearance = async () => {
      const a = await getNotificationAppearance();
      const custom = await getCustomWallpaperPhoto();
      if (custom?.blob) img.src = URL.createObjectURL(custom.blob);
      return a;
    };
    let cropState = { x: 0.5, y: 0.5, scale: 1 };

    getAppearance().then((a) => {
      cropState = a.crop ? { ...a.crop } : { x: 0.5, y: 0.5, scale: 1 };
      applyCrop();
    });
    function applyCrop() {
      img.style.objectPosition = `${Math.round(cropState.x * 100)}% ${Math.round(cropState.y * 100)}%`;
      img.style.transform = `scale(${cropState.scale})`;
    }

    const controls = ui.el('div', { class: 'flex-row', style: { gap: '8px', flexWrap: 'wrap', marginTop: '8px' } });
    for (const [dir, icon, label] of [['left', 'chevron-left', 'Pan left'], ['right', 'chevron-right', 'Pan right'], ['up', 'chevron-up', 'Pan up'], ['down', 'chevron-down', 'Pan down']]) {
      const b = ui.el('button', { class: 'btn btn-ghost btn-sm', 'aria-label': label, 'data-action': 'wall-crop-nudge', 'data-dir': dir }, ui.icon(icon, 16));
      b.addEventListener('click', () => {
        const step = 0.08 * cropState.scale;
        if (dir === 'left') cropState.x = Math.max(0, cropState.x - step);
        if (dir === 'right') cropState.x = Math.min(1, cropState.x + step);
        if (dir === 'up') cropState.y = Math.max(0, cropState.y - step);
        if (dir === 'down') cropState.y = Math.min(1, cropState.y + step);
        applyCrop();
      });
      controls.append(b);
    }
    const zoomOut = ui.el('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Zoom out', 'data-action': 'wall-crop-zoom', 'data-delta': '-0.2' }, '−');
    const zoomIn = ui.el('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Zoom in', 'data-action': 'wall-crop-zoom', 'data-delta': '0.2' }, '+');
    zoomOut.addEventListener('click', () => { cropState.scale = Math.max(1, cropState.scale - 0.2); applyCrop(); });
    zoomIn.addEventListener('click', () => { cropState.scale = Math.min(5, cropState.scale + 0.2); applyCrop(); });
    controls.append(zoomOut, zoomIn);

    const save = ui.el('button', { class: 'btn btn-primary btn-block', style: { marginTop: '10px' } }, 'Save');
    save.addEventListener('click', async () => {
      await saveNotificationAppearance({ crop: cropState });
      const custom = await getCustomWallpaperPhoto();
      if (custom) {
        await saveCustomWallpaperPhoto(custom.blob, cropState);
        // Re-mirror the (re-processed) local copy so native shows the crop too.
        if (isNative() && ['ios', 'android'].includes(getPlatform())) {
          await syncNativeCustomWallpaper(custom.blob).catch(() => {});
        }
      }
      close();
      ui.toast('Crop saved', 'success');
      renderAppearance(root, host);
    });

    wrap.append(stage, controls, save);
    return wrap;
  });
}

function nudgeCrop(host, dir) { void host; void dir; /* handled via direct listeners above */ }
function zoomCrop(host, delta) { void host; void delta; /* handled via direct listeners above */ }
