/**
 * App settings — single cached record plus theme handling.
 */
import { dbGet, dbPut } from './db.js';
import { defaultSettings } from './models.js';

let settings = null;
// Guarded so the module can be imported in Node (unit tests); in the browser
// this is the normal prefers-color-scheme media query.
const systemDark =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export async function loadSettings() {
  settings = (await dbGet('settings', 'settings')) || defaultSettings();
  applyTheme();
  return settings;
}

export function getSettings() {
  if (!settings) settings = defaultSettings();
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
  settings = defaultSettings();
  applyTheme();
  return settings;
}