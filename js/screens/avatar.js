/**
 * Avatar picker — dedicated screen for choosing the user's avatar.
 *
 * Options: built-in illustrated avatars (local SVG, offline), initials from
 * the saved name, or a custom image from the device gallery (downscaled and
 * stored locally — never uploaded). Selection saves immediately, matching the
 * settings-screen convention (theme/units also save in place).
 */
import { getSettings, saveSettings } from '../settings.js';
import * as photos from '../photos.js';
import * as ui from '../ui.js';
import { go } from '../router.js';
import {
  builtinAvatarList,
  isBuiltinAvatar,
  normalizeAvatar,
  initialsFor,
  avatarMarkup,
  builtinAvatarMarkup,
  initialsAvatarMarkup,
  revokeAvatarUrls,
  processAvatarImage,
  AVATAR_SIZE,
  AVATAR_QUALITY,
} from '../personalization.js';

export async function mount(root) {
  photos.revokePhotoUrls();
  revokeAvatarUrls();
  render(root);
}

function render(root) {
  const settings = getSettings();
  const avatar = normalizeAvatar(settings.avatar);
  const initials = initialsFor(settings.name);
  const name = (settings.name || '').trim() || 'friend';

  root.innerHTML = `
    <header style="margin-top:var(--sp-2)">
      <div class="flex-row" style="gap:6px">
        <button class="btn-icon" data-action="back" aria-label="Back to settings">${ui.icon('arrow-left', 18)}</button>
      </div>
      <h2 style="font-size:var(--fs-2xl);font-weight:800;letter-spacing:-0.02em;margin-top:var(--sp-3)">Choose avatar</h2>
      <div class="muted" style="font-size:var(--fs-sm);font-weight:600">Shown beside your greeting and in Settings</div>
    </header>

    <div class="avatar-hero">
      ${avatarMarkup(settings, 84)}
      <div class="avatar-hero-name">${ui.escapeHtml(name)}</div>
      <div class="avatar-hero-sub">${avatar.type === 'builtin' ? 'Built-in avatar' : avatar.type === 'initials' ? 'Your initials' : 'Custom image'}</div>
    </div>

    <section class="section">
      <h3 class="section-title">Built-in avatars</h3>
      <div class="avatar-grid" role="radiogroup" aria-label="Built-in avatars">
        ${builtinAvatarList()
          .map(
            (a) => `
          <button class="avatar-option ${avatar.type === 'builtin' && avatar.value === a.id ? 'selected' : ''}"
                  data-action="pick-builtin" data-id="${a.id}" role="radio"
                  aria-checked="${avatar.type === 'builtin' && avatar.value === a.id}" aria-label="${ui.escapeHtml(a.label)}">
            ${builtinSvgInner(a.id)}
            ${avatar.type === 'builtin' && avatar.value === a.id ? `<span class="avatar-check">${ui.icon('check', 13)}</span>` : ''}
          </button>`
          )
          .join('')}
      </div>
    </section>

    <section class="section">
      <h3 class="section-title">More ways to personalize</h3>
      <div class="settings-group">
        <div class="settings-row pressable" data-action="pick-initials">
          <div class="settings-row-icon">${initialsIcon(initials)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Use my initials</div>
            <div class="settings-row-sub">${initials ? `${ui.escapeHtml(initials)} — from your name` : 'Add your name in Settings first'}</div>
          </div>
          ${avatar.type === 'initials' ? `<span class="avatar-check">${ui.icon('check', 13)}</span>` : ui.icon('chevron-right', 18)}
        </div>
        <div class="settings-row pressable" data-action="pick-custom">
          <div class="settings-row-icon">${ui.icon('image', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title">Choose from gallery</div>
            <div class="settings-row-sub">Stored on this device only — never uploaded</div>
          </div>
          ${avatar.type === 'custom' ? `<span class="avatar-check">${ui.icon('check', 13)}</span>` : ui.icon('chevron-right', 18)}
        </div>
        ${
          avatar.type === 'custom'
            ? `
        <div class="settings-row pressable" data-action="remove-custom">
          <div class="settings-row-icon" style="background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger)">${ui.icon('trash', 18)}</div>
          <div class="settings-row-main">
            <div class="settings-row-title" style="color:var(--danger)">Remove custom image</div>
            <div class="settings-row-sub">Switch back to the previous avatar</div>
          </div>
          ${ui.icon('chevron-right', 18)}
        </div>`
            : ''
        }
      </div>
    </section>
  `;

  ui.bindActions(root, {
    back: () => go('settings'),
    'pick-builtin': async (d, e) => {
      if (avatar.type === 'builtin' && avatar.value === d.id) return;
      await saveSettings({ avatar: { type: 'builtin', value: d.id } });
      ui.haptic();
      ui.pulse(e.currentTarget || e.target);
      render(root);
    },
    'pick-initials': async () => {
      if (!initials) {
        ui.toast('Add your name in Settings first.', 'info');
        return;
      }
      if (avatar.type === 'initials') return;
      await saveSettings({ avatar: { type: 'initials', value: '' } });
      ui.haptic();
      ui.toast('Initials avatar set', 'success');
      render(root);
    },
    'pick-custom': pickCustom,
    'remove-custom': removeCustom,
  });

  async function pickCustom() {
    // Permission is requested by the browser's own file picker — only when
    // the user taps this option, never at startup.
    const file = await ui.pickFromGallery('image/*');
    if (!file) return; // cancelled or permission denied — nothing to do
    try {
      const blob = await processAvatarImage(file, AVATAR_SIZE, AVATAR_QUALITY, photos.processImage);
      await saveSettings({ avatar: { type: 'custom', value: '' }, avatarImage: blob });
      revokeAvatarUrls();
      ui.haptic();
      ui.toast('Custom avatar saved', 'success');
      render(root);
    } catch {
      ui.toast('Could not read that image. Try another one.', 'danger');
    }
  }

  async function removeCustom() {
    const ok = await ui.openDialog({
      title: 'Remove custom avatar?',
      message: 'The image will be deleted from this device. Your initials avatar will be used instead.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await saveSettings({ avatar: { type: 'initials', value: '' }, avatarImage: null });
    revokeAvatarUrls();
    ui.toast('Custom avatar removed', 'info');
    render(root);
  }
}

function builtinSvgInner(id) {
  // Reuse the same generator used for previews — the markup builder returns
  // a <span> wrapper; here we need only the raw svg for the circular button.
  const tmp = document.createElement('div');
  tmp.innerHTML = builtinAvatarMarkup(id, 96);
  const svg = tmp.querySelector('svg');
  return svg ? svg.outerHTML : '';
}

function initialsIcon(initials) {
  const tmp = document.createElement('div');
  tmp.innerHTML = initials ? initialsAvatarMarkup(initials, 38) : ui.icon('user', 18);
  return tmp.firstElementChild.outerHTML;
}
