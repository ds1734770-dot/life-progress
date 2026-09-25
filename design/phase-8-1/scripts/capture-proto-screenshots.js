/**
 * PHASE 8.1 — PROTOTYPE-ONLY screenshot capture.
 *
 * Renders design/phase-8-1/prototypes/index.html in headless Chrome and
 * saves PNGs into design/phase-8-1/screenshots/. Does NOT touch the
 * production /screenshots folder or any production file. The prototype is
 * loaded directly from the file system (no server, no data persisted).
 *
 * Run: node design/phase-8-1/scripts/capture-proto-screenshots.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'screenshots');
const PROTO = join(HERE, '..', 'prototypes', 'index.html');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.CHROME_BIN,
].filter(Boolean);

const DEBUG_PORT = 9231;
let ws; let nextId = 0; const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function connect(url) {
  ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    }
  };
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(name) {
  await sleep(450); // let the single quiet view transition settle
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
  console.log(`  saved screenshots/${name}.png`);
}
async function waitFor(expr, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(120);
  }
  throw new Error('waitFor timeout: ' + expr);
}

const chromePath = CHROME_CANDIDATES.find((p) => p);
if (!chromePath) {
  console.error('Chrome not found. Set CHROME_PATH and re-run.');
  process.exit(1);
}
const protoUrl = 'file:///' + PROTO.replace(/\\/g, '/');
const profileDir = mkdtempSync(join(tmpdir(), 'lp-proto-shots-'));
const chrome = spawn(chromePath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`,
  '--window-size=420,900', protoUrl + '#/dashboard',
], { stdio: 'ignore' });
mkdirSync(OUT, { recursive: true });

try {
  let target;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      target = targets.find((t) => t.type === 'page' && t.url.startsWith('file://'));
      if (target) break;
    } catch {}
    await sleep(200);
  }
  if (!target) throw new Error('Chrome page target not found');
  await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });

  // Dashboard (hash #/dashboard skips the launch overlay for stable capture)
  await waitFor(`document.querySelector('#view-inner')?.children.length > 0`);
  await shot('proto-ink-dashboard');

  // Water + interactions: add water twice, remove one entry
  await evaluate(`document.querySelector('.tab[data-route=water]').click()`);
  await waitFor(`document.querySelector('.quick-add') !== null`);
  await evaluate(`document.querySelector('[data-act=add-water][data-ml="250"]').click()`);
  await sleep(350);
  await evaluate(`document.querySelector('[data-act=add-water][data-ml="750"]').click()`);
  await sleep(400);
  await shot('proto-ink-water');

  // Gym
  await evaluate(`document.querySelector('.tab[data-route=gym]').click()`);
  await waitFor(`document.querySelector('.stat-line') !== null`);
  await shot('proto-ink-gym');

  // Goals + completion moment
  await evaluate(`document.querySelector('.tab[data-route=goals]').click()`);
  await waitFor(`document.querySelector('#goal-list') !== null`);
  await evaluate(`document.querySelector('.goal-row[data-id="g3"] .goal-check').click()`);
  await sleep(500);
  await shot('proto-ink-goals');

  // Journal
  await evaluate(`document.querySelector('.tab[data-route=journal]').click()`);
  await waitFor(`document.querySelector('.search input') !== null`);
  await shot('proto-ink-journal');

  // History (dashboard header row links to it; hash works the same) + day selection
  await evaluate(`location.hash = '#/history'`);
  await waitFor(`document.querySelector('.hist-grid') !== null`);
  await evaluate(`document.querySelector('.hist-day[data-day="12"]')?.click()`);
  await sleep(400);
  await shot('proto-ink-history');

  // Achievements + badge panel
  await evaluate(`document.querySelector('.tab[data-route=goals]').click()`); // reset to a tab view first
  await evaluate(`location.hash = '#/achievements'`);
  await waitFor(`document.querySelector('.ach-grid') !== null`);
  await evaluate(`document.querySelector('.ach-card[data-i="3"]').click()`);
  await waitFor(`document.querySelector('.sheet-backdrop') !== null`);
  await sleep(300);
  await shot('proto-ink-achievements-badge');
  await evaluate(`document.querySelector('[data-act=close-sheet]').click()`);
  await sleep(250);
  await evaluate(`document.querySelector('.sheet-backdrop') === null ? true : document.querySelector('[data-act=close-sheet]').click()`);
  await sleep(250);
  await shot('proto-ink-achievements');

  // Settings
  await evaluate(`document.querySelector('.tab[data-route=settings]').click()`);
  await waitFor(`document.querySelector('.chip[data-t="ink"]') !== null`);
  await shot('proto-ink-settings');

  // Avatar sheet (representative modal)
  await evaluate(`document.querySelector('[data-act="avatar"]').click()`);
  await waitFor(`document.querySelector('.avatar-grid') !== null`);
  await sleep(250);
  await shot('proto-ink-avatar-sheet');
  await evaluate(`document.querySelector('[data-act=close-sheet]').click()`);
  await sleep(200);

  // Navigation close-up (crop of the bar itself)
  await evaluate(`document.querySelector('.tab[data-route=water]').click()`);
  await sleep(400);
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 320, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await shot('proto-ink-navigation');

  // Full-height phone again
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });

  // Paper (light) theme: switch + capture the same key screens
  await evaluate(`localStorage.setItem('proto-theme','paper')`);
  await evaluate(`document.documentElement.dataset.theme='paper'`);
  await evaluate(`document.querySelector('.tab[data-route=dashboard]').click()`);
  await sleep(500);
  await shot('proto-paper-dashboard');
  await evaluate(`document.querySelector('.tab[data-route=water]').click()`);
  await sleep(500);
  await shot('proto-paper-water');
  await evaluate(`document.querySelector('.tab[data-route=goals]').click()`);
  await sleep(500);
  await shot('proto-paper-goals');

  // Launch view (fresh page, no hash)
  await evaluate(`localStorage.setItem('proto-theme','ink'); location.href = '${protoUrl}'; true;`);
  await waitFor(`document.querySelector('#launch') !== null`);
  await sleep(700);
  await shot('proto-launch');

  console.log('Done.');
} catch (err) {
  console.error('CRASH:', err.message);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
