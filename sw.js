/**
 * Service worker — offline-first app shell.
 * Precaches the core assets at install time and serves them cache-first.
 * Cross-origin requests and data URLs are never cached or intercepted.
 */
// V2.1: bumped for the notification appearance modules (notifyContent,
// notifyWallpapers, notificationAppearance) joining the precache list.
// V1.18 — bump REQUIRED: the v1.17 cache served a broken module graph
// (notifications.js was rewritten in V2.2 and its missing exports blanked
// every statically-importing page). Cache-first + an UNCHANGED cache name
// would keep serving the poisoned files forever; the bump makes activate()
// delete the stale cache and install() re-precache the corrected graph.
const CACHE = 'life-progress-v1.18';

// V2.1 — the 12 built-in wallpaper files, mirrored from the registry in
// js/notifyWallpapers.js (kept as a literal list here so the precache never
// needs a module import). Parity with the registry is asserted by
// test/notification-experience.test.js.
const NOTIFICATION_WALLPAPERS = [
  'sunset_peak.png', 'forest_trail.png', 'calm_lake.png', 'mountain_mist.png',
  'night_sky.png', 'ocean_dusk.png', 'city_night.png', 'warm_minimal.png',
  'cozy_room.png', 'sunrise_valley.png', 'autumn_forest.png', 'training_room.png',
];

// Relative URLs (no leading slash) so the app deploys at a domain root OR a
// subpath (e.g. GitHub Pages project sites) without changes.
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './push-config.js',
  './css/theme.css',
  './css/base.css',
  './css/components.css',
  './css/screens.css',
  './js/app.js',
  './js/utils.js',
  './js/models.js',
  './js/db.js',
  './js/settings.js',
  './js/ui.js',
  './js/water.js',
  './js/goals.js',
  './js/gym.js',
  './js/photos.js',
  './js/journal.js',
  './js/router.js',
  './js/history.js',
  './js/achievements.js',
  './js/celebration.js',
  './js/tabbar-dock.js',
  './js/onboarding.js',
  './js/launch.js',
  './js/personalization.js',
  './js/notifications.js',
  './js/notifyContent.js',
  './js/notifyWallpapers.js',
  './js/timeCore.js',
  './js/platform.js',
  './js/nativePush.js',
  './js/swPush.js',
  './js/pushClient.js',
  './assets/launch-bg.png',
  './js/screens/notificationsSettings.js',
  './js/screens/notificationAppearance.js',
  './js/screens/dashboard.js',
  './js/screens/water.js',
  './js/screens/goals.js',
  './js/screens/gym.js',
  './js/gymTemplates.js',
  './js/screens/gymTemplate.js',
  './js/screens/gymSession.js',
  './js/screens/photos.js',
  './js/screens/journal.js',
  './js/screens/history.js',
  './js/screens/achievements.js',
  './js/screens/settings.js',
  './js/screens/avatar.js',
  './js/screens/camera.js',
  './js/pose/geometry.js',
  './js/pose/reference.js',
  './js/pose/alignment.js',
  './js/pose/detector.js',
  './js/pose/analyze.js',
  './js/camera/coordinates.js',
  './js/camera/controller.js',
  './js/camera/overlay.js',
  // Vendored pose runtime (V1.3 smart progress camera). Only the ~137 KB JS
  // bundle is precached so app install stays fast; the multi-megabyte WASM +
  // model download once on first use and are then served from this cache by
  // the runtime handler below, so the feature works fully offline afterwards.
  // Nothing here is loaded during normal app startup. See
  // scripts/fetch-pose-assets.js and vendor/mediapipe/README.md.
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // V2.1 — built-in notification wallpapers (bundled, offline): the service
  // worker resolves them at PUSH time, when the network may be gone. The
  // custom user photo is deliberately NOT listed — it lives in IndexedDB and
  // cannot be read in SW context, so custom mode falls back to the standard
  // app-icon notification there (never a failure, §24).
  ...NOTIFICATION_WALLPAPERS.map((f) => `./assets/notification-backgrounds/${f}`),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Path-agnostic icon check (works at root and subpath deployments).
  if (url.pathname.endsWith('.png')) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
    return;
  }
  // App shell: cache-first, refresh cache in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});

// ---------------------------------------------------------------------------
// V1.6 — BACKGROUND PUSH DELIVERY (Web Push).
// The server wakes this service worker at the scheduled moment with a minimal
// payload (category + dedup identity + route hint — never personal data).
// The handler derives the context-aware copy LOCALLY from IndexedDB via the
// same eligibility engine the in-app sweep uses, so background reminders:
//   · fire at the scheduled time with the app fully closed,
//   · suppress themselves when the context says so (water target met ⇒ silent),
//   · dedupe against the in-app sweep through the SAME notificationState
//     records (opening the app can never duplicate a delivered reminder).
// The full logic lives in js/swPush.js (unit-tested). If the module path
// fails (first-start network glitch, exotic environment), an INLINE minimal
// fallback below still shows the reminder with static copy — a broken
// import must never silently swallow a notification.
// ---------------------------------------------------------------------------

// Last-resort static copy + route allowlist (duplicated here on purpose: this
// fallback must work even when NO module can be imported).
const PUSH_FALLBACK_COPY = {
  water: ['Time for some water 💧', 'A quick sip keeps your day on track.', '#/water'],
  gym: ['Ready for a workout?', 'A short session keeps the rhythm going.', '#/gym'],
  goals: ['Your goals are waiting', 'A few minutes now moves them forward.', '#/goals'],
  journal: ['Take a minute for yourself', 'A short entry keeps your reflection going.', '#/journal'],
  streaks: ['Your streak is alive 🔥', 'One quick action today keeps it going.', '#/dashboard'],
  achievements: ['Life Progress', 'You have new progress to celebrate.', '#/achievements'],
  test: ['Life Progress', 'Notifications are working 🔔 Background reminders are active.', '#/dashboard'],
};

function showFallbackNotification(raw) {
  const entry = raw && typeof raw === 'object' ? PUSH_FALLBACK_COPY[raw.type === 'test' ? 'test' : raw.category] : null;
  if (!entry) return false;
  const [title, body, route] = entry;
  return self.registration
    .showNotification(title, {
      tag: raw.type === 'test' ? 'test' : String(raw.category),
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { route, app: 'life-progress' },
    })
    .then(() => true)
    .catch(() => false);
}

async function handlePushEvent(event) {
  let raw = null;
  try {
    raw = event.data ? await event.data.json() : null;
  } catch {
    raw = null; // unparseable → nothing safe to show
  }
  // Primary path: full context-aware handling (dedup, gates, local copy).
  try {
    const notif = await import('./js/notifications.js');
    const { processPush } = await import('./js/swPush.js');
    const result = await processPush(raw, {
      getNotificationPrefs: notif.getNotificationPrefs,
      reminderBlocked: notif.reminderBlocked,
      wasDelivered: notif.wasDelivered,
      markDelivered: notif.markDelivered,
      buildReminderContext: notif.buildReminderContext,
      ELIGIBILITY: notif.ELIGIBILITY,
      // V2.1 — resolve the notification wallpaper locally (bundled asset or
      // random pick per occurrence). Custom photos cannot be read in SW
      // context (IndexedDB only) → the resolver returns null there and the
      // display degrades to the standard app icon, never suppressing the
      // reminder (§24 fallback hierarchy).
      resolveWallpaper: notif.resolveNotificationWallpaper,
      show: (n) => self.registration.showNotification(n.title, n.options),
      // V2.2 — occurrence ownership: after the OS displays a reminder push,
      // ACK the occurrence so the server never re-sends it. Reuses the same
      // helper the in-app sweep uses; it reads deviceKey + API base from the
      // persisted push registration (IndexedDB), which the SW can access.
      ackOccurrence: (occurrenceId) => notif.ackPushOccurrence(occurrenceId),
    });
    // Deliberately silent outcomes (invalid payload, gates, "not useful now")
    // must NOT fall back — suppressing IS the correct behavior there. Only an
    // exception above reaches the fallback.
    return result;
  } catch (err) {
    // Module path failed — show the static copy so the reminder survives.
    const shown = await showFallbackNotification(raw);
    return { shown, reason: shown ? 'fallback' : `error: ${err?.message || err}` };
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePushEvent(event));
});

// §20 — subscription rotated/expired while the app was closed: re-subscribe
// with the cached VAPID key and re-register with the server. Best-effort;
// the next app boot re-syncs anything this couldn't finish.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const notif = await import('./js/notifications.js');
        const pushClient = await import('./js/pushClient.js');
        const prefs = await notif.getNotificationPrefs();
        if (!prefs.enabled) return;
        const reg = await pushClient.syncPushRegistration(prefs);
        return reg;
      } catch { /* next boot reconciles */ }
    })()
  );
});

// ---------------------------------------------------------------------------
// V1.5 — Notifications: display + click deep links.
// The page shows notifications via the Notification API while it is open;
// this handler takes over when the page is closed (and for future push).
// Every payload carries data.route — the SAME hash routes the in-app router
// uses, so clicking a notification lands on the right screen with no
// parallel navigation system.
// ---------------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const route = (event.notification.data && event.notification.data.route) || '#/dashboard';
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const target = clientList.find((c) => c.url.startsWith(self.registration.scope));
      if (target) {
        // App is open: focus it and navigate via the hash (router picks up).
        await target.focus();
        target.postMessage({ type: 'notification-route', route });
        return;
      }
      // App closed: open it directly on the deep-linked screen.
      await self.clients.openWindow(route);
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});