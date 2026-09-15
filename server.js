/**
 * Life Progress server.
 *
 * Two responsibilities, clearly separated:
 *  1. Static file server for the PWA (behavior unchanged).
 *  2. Notification backend (V1.6): push subscription API + Web Push delivery
 *     + the background scheduler loop that delivers reminders while the app
 *     is closed. `node server.js` starts both together for local use; the
 *     scheduler can also run standalone via `node server/push-worker.js`
 *     (see README — Production deployment).
 *
 * Environment variables:
 *   PORT              listen port (default 8080)
 *   VAPID_PUBLIC_KEY  base64url public key   (falls back to generated+persisted)
 *   VAPID_PRIVATE_KEY base64url PKCS#8 key   (SERVER ONLY — never exposed)
 *   VAPID_SUBJECT     mailto: or https: contact for the VAPID JWT
 *   PUSH_DATA_FILE    override the scheduling-state file path
 *   PUSH_VAPID_FILE   override the generated-keys file path
 *   PUSH_WORKER_ONLY  run the scheduler WITHOUT static serving (§18)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePushApi } from './server/api.js';
import { loadState } from './server/store.js';
import { getVapidConfig } from './server/vapid.js';
import { runScheduler, schedulerTick } from './server/scheduler.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  // The vendored pose runtime needs this exact type: WebAssembly.instantiateStreaming
  // refuses anything else and silently falls back to a much slower path.
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);

    // V1.6 — notification backend (mounted before static files).
    if (await handlePushApi(req, res, pathname)) return;

    if (pathname === '/') pathname = '/index.html';

    // Prevent path traversal.
    const filePath = normalize(join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }

    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Life Progress running at http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Notification backend startup
// ---------------------------------------------------------------------------

/** Non-secret startup banner (never logs private material — §24). */
function logVapidInfo(config) {
  console.log(`[push] VAPID ready (${config.source}) — public key ${config.publicKey.slice(0, 12)}…`);
}

const state = await loadState();
const vapid = await getVapidConfig();
logVapidInfo(vapid);

if (process.env.PUSH_WORKER_ONLY) {
  // Standalone scheduler (§18): no static files, just the delivery loop.
  console.log('[push] worker-only mode: scheduler running, static serving disabled');
  await runScheduler(vapid);
} else {
  // Integrated mode: tick-driven loop in the same process. Persisted state
  // makes restarts safe; the first tick after startup only handles
  // occurrences inside the grace window (§11 — no stale flood).
  await schedulerTick(vapid); // catch anything due right now, then idle
  setInterval(() => schedulerTick(vapid), 15 * 1000);
  console.log('[push] scheduler running (15s tick)');
}

// Graceful shutdown — flush the write chain via process exit semantics.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[server] ${sig} received — shutting down`);
    process.exit(0);
  });
}
