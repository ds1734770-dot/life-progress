/**
 * Life Progress — bootstrap.
 * 1. Load settings + apply theme
 * 2. Cinematic motivational launch experience (once per app session)
 * 3. Render bottom navigation
 * 4. Run onboarding on first launch
 * 5. Navigate to the current route
 * 6. Register the service worker (offline support)
 */
import { loadSettings, getSettings, onSystemThemeChange } from './settings.js';
import { navigate, renderTabbar, currentRouteName } from './router.js';
import { showOnboarding } from './onboarding.js';
import { playLaunchExperience } from './launch.js';
import { checkAchievementsNow } from './celebration.js';

async function boot() {
  try {
    await loadSettings();
  } catch (err) {
    console.error('[LifeProgress] Failed to load settings', err);
  }
  onSystemThemeChange(() => {});

  // V1.1 — motivational launch ritual. Runs only at session start (this
  // function), never during internal navigation. It is bounded and skippable,
  // and cannot block boot: playLaunchExperience always resolves.
  try {
    await playLaunchExperience();
  } catch (err) {
    console.error('[LifeProgress] Launch experience skipped', err);
  }

  renderTabbar();

  if (!getSettings().onboarded) {
    await showOnboarding();
  }

  await navigate(currentRouteName());
  registerServiceWorker();

  // V1.2 Phase 2 — startup achievement evaluation, run AFTER first paint so
  // boot is never delayed. Newly earned badges are persisted (earns are
  // permanent) and celebrated once; unseen celebrations re-queue next start.
  checkAchievementsNow();
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