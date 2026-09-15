/**
 * Standalone notification worker (§18) — the scheduler without static file
 * serving. Run this when hosting the PWA on a static platform (GitHub Pages,
 * Netlify, …) and keeping the push backend on an always-on machine:
 *
 *   PUSH_DATA_FILE=/data/push.json node server/push-worker.js
 *
 * The worker owns scheduling + delivery only; subscriptions are registered
 * through the main server's API (or this worker's own API when ported).
 */
import { loadState } from './store.js';
import { getVapidConfig } from './vapid.js';
import { runScheduler } from './scheduler.js';

const state = await loadState(); // eslint-disable-line no-unused-vars
const vapid = await getVapidConfig();
console.log('[push-worker] VAPID ready — public key', vapid.publicKey.slice(0, 12) + '…');
await runScheduler(vapid);
