/**
 * Push backend configuration — the ONLY place a non-same-origin API is set.
 *
 * The static site (GitHub Pages / Netlify / …) cannot run the Node backend,
 * so background reminders need the notification backend deployed on an
 * always-on host and the client pointed at it:
 *
 *   window.LIFE_PROGRESS_PUSH_API = "https://your-push-backend.example.com";
 *
 * · Use the ORIGIN only (no trailing slash, no path) — the client appends
 *   /api/push/* itself.
 * · The backend must serve HTTPS and allow CORS from this site's origin
 *   (server/api.js does).
 * · Leave "" when the app is served by `node server.js` itself — the client
 *   then uses same-origin /api/push/*.
 *
 * PRODUCTION: the notification backend is the deployed Cloudflare Worker
 * (split deployment — static site on GitHub Pages, backend on Workers).
 * For local development against `node server.js`, set this back to "".
 *
 * This file contains NO secrets: the VAPID *public* key is fetched from the
 * backend at runtime; the private key lives only on the backend host.
 */
window.LIFE_PROGRESS_PUSH_API = "https://life-progress.ds1734770.workers.dev";
