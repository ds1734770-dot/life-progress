/**
 * App settings — single cached record plus theme handling.
 */
import { dbGet, dbPut } from './db.js';
import { defaultSettings } from './models.js';
import { normalizeAvatar } from './personalization.js';

let settings = null;
// Guarded so the module can be imported in Node (unit tests); in the browser
// this is the normal prefers-color-scheme media query.
const systemDark =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/**
 * Bundled fallback launch background (local asset — works offline, no
 * external image API). Kept as a computed value so module consumers that
 * are deployed under a subpath (GitHub Pages) still resolve correctly.
 */
export const LAUNCH_FALLBACK_BG =
  typeof document !== 'undefined'
    ? new URL('../assets/launch-bg.png', import.meta.url).href
    : '';

/**
 * Merge stored settings with current defaults so records written by older
 * versions (V1) gain the new personalization fields without any migration
 * step or DB version bump. Invalid values fall back to defaults.
 */
function withDefaults(stored) {
  const s = { ...defaultSettings(), ...stored };
  if (typeof s.launchQuote !== 'string' || !s.launchQuote.trim()) {
    s.launchQuote = defaultSettings().launchQuote;
  }
  s.avatar = normalizeAvatar(s.avatar);
  if (!(s.avatarImage instanceof Blob)) s.avatarImage = null;
  return s;
}

export async function loadSettings() {
  settings = withDefaults((await dbGet('settings', 'settings')) || defaultSettings());
  applyTheme();
  return settings;
}

export function getSettings() {
  if (!settings) settings = withDefaults(defaultSettings());
  return settings;
}

export async function saveSettings(patch) {
  settings = { ...getSettings(), ...patch };
  await dbPut('settings', settings);
  applyTheme();
  return settings;
}

export function resolvedTheme() {
  const s = getSettings();
  if (s.theme === 'system') return systemDark && systemDark.matches ? 'dark' : 'light';
  return s.theme === 'light' ? 'light' : 'dark';
}

export function applyTheme() {
  if (typeof document === 'undefined') return;
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.getElementById('meta-theme-color');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0a0e14' : '#f4f6f9');
}

export function onSystemThemeChange(cb) {
  if (!systemDark || !systemDark.addEventListener) return;
  systemDark.addEventListener('change', () => {
    if (getSettings().theme === 'system') {
      applyTheme();
      cb && cb();
    }
  });
}

export function resetSettings() {
  settings = withDefaults(defaultSettings());
  applyTheme();
  return settings;
}