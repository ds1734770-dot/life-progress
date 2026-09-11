/**
 * Service worker — offline-first app shell.
 * Precaches the core assets at install time and serves them cache-first.
 * Cross-origin requests and data URLs are never cached or intercepted.
 */
const CACHE = 'life-progress-v1.3';

// Relative URLs (no leading slash) so the app deploys at a domain root OR a
// subpath (e.g. GitHub Pages project sites) without changes.
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
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
  './js/tabbar-dock.js',
  './js/onboarding.js',
  './js/launch.js',
  './js/personalization.js',
  './assets/launch-bg.png',
  './js/screens/dashboard.js',
  './js/screens/water.js',
  './js/screens/goals.js',
  './js/screens/gym.js',
  './js/screens/photos.js',
  './js/screens/journal.js',
  './js/screens/settings.js',
  './js/screens/avatar.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
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