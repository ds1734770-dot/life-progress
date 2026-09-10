/**
 * Life Progress — bootstrap.
 * 1. Load settings + apply theme
 * 2. Render bottom navigation
 * 3. Run onboarding on first launch
 * 4. Navigate to the current route
 * 5. Register the service worker (offline support)
 */
import { loadSettings, getSettings, onSystemThemeChange } from './settings.js';
import { navigate, renderTabbar, currentRouteName } from './router.js';
import { showOnboarding } from './onboarding.js';

async function boot() {
  try {
    await loadSettings();
  } catch (err) {
    console.error('[LifeProgress] Failed to load settings', err);
  }
  onSystemThemeChange(() => {});

  renderTabbar();

  if (!getSettings().onboarded) {
    await showOnboarding();
  }

  await navigate(currentRouteName());
  registerServiceWorker();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // Relative URL — the SW controls the whole directory tree, so this works
    // at a domain root and under a subpath (e.g. GitHub Pages project sites).
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* offline support is best-effort */
    });
  }
}

boot();