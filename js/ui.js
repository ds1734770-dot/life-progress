/**
 * UI helpers — DOM creation, icons, toasts, sheets/dialogs, haptics,
 * number/ring animations, event delegation, image picking.
 */

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  droplet: '<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/>',
  dumbbell: '<path d="M6.5 6.5v11M17.5 6.5v11M4 9.5v5M20 9.5v5M6.5 12h11"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  flame: '<path d="M12 2c1 3 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-5 .5 1 1.5 1.5 2 2-.5-2 0-5 1-7z"/>',
  star: '<path d="m12 3 2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v-4M12 15V7M17 15v-6"/>',
  columns: '<rect x="3" y="4" width="7" height="16" rx="1.5"/><rect x="14" y="4" width="7" height="16" rx="1.5"/>',
  timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  sparkles: '<path d="m12 3-1.2 3.6L7.2 7.8l3.6 1.2L12 12.6l1.2-3.6 3.6-1.2-3.6-1.2z"/><path d="m19 14-.8 2.2-2.2.8 2.2.8.8 2.2.8-2.2 2.2-.8-2.2-.8z"/>',
  'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
  'minus-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
  quote: '<path d="M10 11H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4"/><path d="M20 11h-4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v6a4 4 0 0 1-4 4"/>',
};

export function icon(name, size = 22, className = '') {
  const paths = ICONS[name] || ICONS.sparkles;
  return `<svg width="${size}" height="${size}" class="${className}" ${SVG_ATTRS}>${paths}</svg>`;
}

/** Create a DOM element from a tag + props + children (string or nodes). */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    if (child instanceof Node) {
      node.append(child);
    } else if (typeof child === 'string' && child.trim().startsWith('<')) {
      // HTML strings (e.g. SVG icons) are parsed into real elements.
      const tpl = document.createElement('template');
      tpl.innerHTML = child;
      node.append(tpl.content);
    } else {
      node.append(document.createTextNode(String(child)));
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Toast + haptics
// ---------------------------------------------------------------------------

let toastTimer = null;

export function toast(message, type = 'success') {
  const root = document.getElementById('toast-root');
  const colors = { success: 'var(--success)', danger: 'var(--danger)', info: 'var(--info)' };
  const iconName = type === 'danger' ? 'alert' : type === 'info' ? 'sparkles' : 'check';
  const node = el('div', { class: 'toast', role: 'status' }, [
    icon(iconName, 16),
    message,
  ]);
  node.querySelector('svg').style.color = colors[type];
  root.replaceChildren(node);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.style.transition = 'opacity 200ms ease, transform 200ms ease';
    node.style.opacity = '0';
    node.style.transform = 'translateX(-50%) translateY(6px)';
    setTimeout(() => node.remove(), 220);
  }, 2200);
}

/** Vibrate where supported (Android Chrome; no-op elsewhere). */
export function haptic(pattern = 10) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

export function closeModal() {
  const root = document.getElementById('modal-root');
  root.replaceChildren();
}

function mountBackdrop(inner) {
  const root = document.getElementById('modal-root');
  root.replaceChildren(inner);
  return inner;
}

/** Bottom sheet with arbitrary content. Returns { element, close }. */
export function openSheet(buildContent) {
  const backdrop = el('div', { class: 'modal-backdrop' });
  const sheet = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'sheet-grabber' }),
  ]);
  const close = () => {
    sheet.style.transition = 'transform 180ms ease, opacity 180ms ease';
    sheet.style.transform = 'translateY(12px)';
    sheet.style.opacity = '0';
    setTimeout(() => backdrop.remove(), 180);
  };
  const content = buildContent(close);
  sheet.append(content);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  }, { once: true });

  backdrop.append(sheet);
  mountBackdrop(backdrop);
  return { element: content, close };
}

/** Centered confirmation dialog. Resolves true/false. */
export function openDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop', style: { alignItems: 'center' } });
    const close = (value) => {
      backdrop.remove();
      resolve(value);
    };
    const dialog = el('div', { class: 'dialog' }, [
      el('div', { style: { fontSize: 'var(--fs-lg)', fontWeight: 700, marginBottom: 8 } }, title),
      message ? el('p', { class: 'muted', style: { fontSize: 'var(--fs-sm)', lineHeight: 1.6 } }, message) : null,
      el('div', { class: 'dialog-actions' }, [
        el('button', { class: 'btn btn-ghost', type: 'button' }, 'Cancel'),
        el('button', {
          class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`,
          type: 'button',
          onclick: () => close(true),
        }, confirmLabel),
      ]),
    ]);
    dialog.querySelector('.btn-ghost').addEventListener('click', () => close(false));
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
    });
    backdrop.append(dialog);
    mountBackdrop(backdrop);
  });
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------

const RING_CIRCUMFERENCE = 339.292;

export function ringMarkup(size = 120, stroke = 10) {
  return `
    <svg class="ring" width="${size}" height="${size}" viewBox="0 0 120 120">
      <circle class="ring-track" cx="60" cy="60" r="54" stroke-width="${stroke}"></circle>
      <circle class="ring-fill" id="ring-fill" cx="60" cy="60" r="54" stroke-width="${stroke}"></circle>
    </svg>`;
}

export function setRing(root, percent) {
  const fill = root.querySelector('.ring-fill');
  if (!fill) return;
  const pct = Math.min(100, Math.max(0, percent));
  fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - pct / 100));
}

export function ringColor(root, color) {
  const fill = root.querySelector('.ring-fill');
  if (fill) fill.style.stroke = color;
}

/** Animate a numeric element from 0 (or its current text) to `to`. */
export function animateCount(node, to, opts = {}) {
  const { duration = 700, format = (n) => Math.round(n) } = opts;
  const start = performance.now();
  const from = 0;
  function frame(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    node.textContent = format(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** Animate a progress bar element to a width percentage. */
export function animateBar(node, percent) {
  requestAnimationFrame(() => {
    node.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  });
}

/** Small scale pulse on an element (used after actions). */
export function pulse(node) {
  node.style.transition = 'transform 160ms var(--spring)';
  node.style.transform = 'scale(1.12)';
  setTimeout(() => {
    node.style.transform = 'scale(1)';
  }, 160);
}

// ---------------------------------------------------------------------------
// Event delegation
// ---------------------------------------------------------------------------

/**
 * Binds a click handler map to a root. Buttons declare `data-action` and
 * `data-*` attributes; the handler receives (dataset, event).
 *
 * One delegated listener is attached per root element; calling bindActions
 * again only swaps the action map. This prevents duplicate listeners when a
 * screen re-renders (which would otherwise fire handlers twice).
 */
const actionMaps = new WeakMap();

export function bindActions(root, actions) {
  if (!actionMaps.has(root)) {
    root.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target || !root.contains(target)) return;
      const map = actionMaps.get(root);
      const handler = map && map[target.dataset.action];
      if (handler) handler(target.dataset, e, target);
    });
  }
  actionMaps.set(root, actions);
}

// ---------------------------------------------------------------------------
// Image picking (gallery / camera)
// ---------------------------------------------------------------------------

function pickFile(accept, capture) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, style: { display: 'none' } });
    // Only set capture when a camera pick was requested; forcing the attribute
    // on gallery picks locks Android Chrome to the camera instead of the picker.
    if (capture) input.setAttribute('capture', 'environment');
    document.body.append(input);
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      input.remove();
      resolve(file || null);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}

export function pickFromGallery(accept = 'image/*') {
  return pickFile(accept, false);
}

export function pickFromCamera(accept = 'image/*') {
  return pickFile(accept, true);
}

/** Read a File as a data URL. */
export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

export function emptyState({ iconName, title, sub, actionLabel, action }) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-icon' }, icon(iconName, 30)),
    el('div', { class: 'empty-title' }, title),
    el('div', { class: 'empty-sub' }, sub),
    actionLabel
      ? el('button', { class: 'btn btn-primary', type: 'button', onclick: action }, actionLabel)
      : null,
  ]);
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}