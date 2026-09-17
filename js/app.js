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
import { runReminderSweep, pruneDeliveryState } from './notifications.js';
import { isNative } from './platform.js';

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

  // V1.5 — local reminder sweep. KEPT as a secondary reconciliation layer
  // only (§32): background push is now the primary delivery mechanism. The
  // sweep still runs on boot/foreground while the page is open, deduped
  // against push-delivered notifications through the same notificationState
  // records, so opening the app can never duplicate a reminder.
  scheduleReminders();

  // V1.6 — background push re-sync (§21/§20): reconcile the push subscription
  // with current prefs. Non-blocking, never prompts, never duplicates
  // subscriptions (server upserts by deviceKey). Catches:
  //   · a reminder enabled while the server was unreachable (pending → active)
  //   · prefs changed while the device was offline
  //   · a subscription the browser replaced since last registration
  // V2.0 Phase 1 — WEB ONLY: native shells have no Web Push subscription and
  // get their transport (APNs/FCM) in a later phase; syncing a native shell
  // into the Web Push backend would create a bogus registration.
  if (!isNative()) {
    import('./pushClient.js')
      .then(({ syncPushRegistration }) => syncPushRegistration().catch(() => {}))
      .catch(() => {}); // offline/broken storage — local-only mode keeps working
  }
}

function scheduleReminders() {
  const sweep = () => {
    runReminderSweep().catch(() => { /* never disturb the session */ });
  };
  sweep();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sweep();
  });
  setInterval(sweep, 15 * 60 * 1000); // gentle in-page re-check, dedup gates repeats
  // Housekeeping: drop dedup records older than 30 days (fire-and-forget).
  pruneDeliveryState().catch(() => {});
  // SW notificationclick deep links (§15/§19): the service worker focuses the
  // open app and posts the payload's route; the hash router does the rest.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'notification-route' && typeof event.data.route === 'string') {
        location.hash = event.data.route;
      }
    });
  }
}

function registerServiceWorker() {
  // V2.0 Phase 1 — the web/native boundary (docs/native-push-migration.md).
  // The service worker is the PWA's offline shell + Web Push receiver and
  // stays 100% unchanged for every browser/PWA environment. Native shells
  // bundle the app locally and receive notifications through APNs/FCM in a
  // later phase, so registering a network-first SW here would only add
  // update churn and a WebView-scope footgun (Capacitor serves the app from
  // capacitor://localhost / https://localhost, which the http/https protocol
  // check would NOT catch) without any benefit. Platform detection uses the
  // Capacitor bridge only (js/platform.js) — no user-agent sniffing.
  // TEMPORARY EXPLICIT GATE: native push is a later phase; until then native
  // shells get no push transport at all (honest, not faked).
  if (isNative()) return;
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // Relative URL — the SW controls the whole directory tree, so this works
    // at a domain root and under a subpath (e.g. GitHub Pages project sites).
    // type:'module' — the push handler uses dynamic import() of ES modules;
    // module workers guarantee that works on every engine (some engines,
    // notably iOS WebKit, are strict about classic-worker import rules).
    navigator.serviceWorker.register('./sw.js', { type: 'module' }).catch(() => {
      /* offline support is best-effort */
    });
  }
}

boot();