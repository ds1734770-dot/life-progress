/**
 * Captures screenshots of every screen (dark + light) into /screenshots.
 * Seeds a little real data through the UI first so the app looks alive.
 * Run: node scripts/screenshots.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8093;
const DEBUG_PORT = 9226;
const APP_URL = `http://localhost:${PORT}/`;
const TEST_IMAGE = ROOT + '\\icons\\icon-192.png';

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
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(expr, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expr)) return true; } catch {}
    await sleep(150);
  }
  throw new Error('waitFor timeout: ' + expr);
}
async function click(sel) { await evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`); }
async function shot(name) {
  await sleep(700); // let animations settle
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`${ROOT}/screenshots/${name}.png`, Buffer.from(res.data, 'base64'));
  console.log(`  saved screenshots/${name}.png`);
}

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((resolve) => {
  const t = () => http.get(`http://localhost:${PORT}/index.html`, (r) => { r.resume(); resolve(); }).on('error', () => setTimeout(t, 200));
  t();
});
// Fresh profile per run — a reused profile would already be onboarded and
// would double-seed data on every run.
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-shots-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, '--window-size=420,900', APP_URL], { stdio: 'ignore' });
mkdirSync(`${ROOT}/screenshots`, { recursive: true });

try {
  let target;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      target = targets.find((t) => t.type === 'page' && t.url.startsWith(APP_URL));
      if (target) break;
    } catch {}
    await sleep(200);
  }
  await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');

  // Onboarding (the V1.1 launch overlay is up during the first seconds —
  // capture it before it auto-dismisses).
  await waitFor(`document.getElementById('launch-screen') !== null || document.querySelector('.onboarding') !== null`, 8000, 'boot visuals');
  if (await evaluate(`document.getElementById('launch-screen') !== null`)) {
    await shot('00-launch');
    await waitFor(`document.getElementById('launch-screen') === null`, 8000, 'launch overlay done');
  }
  await waitFor(`document.querySelector('.onboarding') !== null`);
  await shot('01-onboarding');
  await click('.onboarding #ob-next');
  await waitFor(`!!document.getElementById('ob-name')`);
  await evaluate(`{ const el = document.getElementById('ob-name'); el.value = 'Alex'; }`);
  await click('.onboarding #ob-next');
  await waitFor(`document.querySelector('.ob-title').textContent.includes('water')`);
  await shot('02-onboarding-water');
  await click('.onboarding #ob-next');
  await waitFor(`document.querySelector('.ob-title').textContent.includes('look')`);
  await click('.onboarding #ob-next');
  await waitFor(`document.querySelector('.ob-title').textContent.includes('vibe')`);
  await shot('03-onboarding-background');
  await click('.onboarding #ob-next');
  await waitFor(`document.getElementById('onboarding-root').children.length === 0`);

  // Seed data
  await evaluate(`location.hash = '#/water'`);
  await waitFor(`!!document.querySelector('[data-action="water-add"]')`);
  for (const amount of [250, 500, 750, 250]) {
    await click(`[data-action="water-add"][data-amount="${amount}"]`);
    await sleep(400);
  }
  await evaluate(`location.hash = '#/goals'`);
  await waitFor(`!!document.querySelector('[data-action="add-goal"]')`);
  await click('[data-action="add-goal"]');
  await waitFor(`!!document.querySelector('.sheet')`);
  await evaluate(`{ const s = document.querySelector('.sheet'); const i = s.querySelectorAll('input'); i[0].value = 'Complete DSA practice'; }`);
  await click('.sheet .btn-primary');
  await waitFor(`document.body.innerText.includes('Complete DSA practice')`);
  await click('[data-action="add-goal"]');
  await waitFor(`!!document.querySelector('.sheet')`);
  await evaluate(`{ const s = document.querySelector('.sheet'); const i = s.querySelectorAll('input'); i[0].value = 'Read 20 pages'; const sel = s.querySelectorAll('select')[1]; sel.value = 'weekly'; }`);
  await click('.sheet .btn-primary');

  await evaluate(`location.hash = '#/gym/new'`);
  await waitFor(`!!document.querySelector('.sheet')`);
  await evaluate(`{
    const inputs = document.querySelectorAll('.sheet .form-grid input');
    inputs[0].value = 'Bench Press'; inputs[1].value = '4'; inputs[2].value = '8'; inputs[3].value = '60';
    const type = document.querySelector('.sheet select'); type.value = 'Strength';
  }`);
  await click('.sheet .btn-primary');
  await waitFor(`document.body.innerText.includes('Strength')`);

  await evaluate(`location.hash = '#/journal/edit'`);
  await waitFor(`!!document.getElementById('j-body')`);
  await evaluate(`{
    document.getElementById('j-title').value = 'A focused day';
    document.getElementById('j-body').value = 'Woke up early, hit the gym, finished the DSA problem set. Hydration was on point today.';
  }`);
  await click('[data-action="save-entry"]');
  await waitFor(`document.body.innerText.includes('A focused day')`);

  // Dark theme screenshots
  const darkScreens = [
    ['dashboard', 'dashboard'],
    ['water', 'water'],
    ['goals', 'goals'],
    ['gym', 'gym'],
    ['photos', 'photos'],
    ['journal', 'journal'],
    ['settings', 'settings'],
    ['avatar', 'avatar'],
  ];
  for (const [route, name] of darkScreens) {
    await evaluate(`location.hash = '#/${route}'`);
    await waitFor(`document.querySelector('.screen-root')?.children.length > 0`);
    await shot(`dark-${name}`);
  }

  // Floating dock + active capsule states (V1.1) — capsule travels with the
  // active route, so we capture it on several different destinations.
  await evaluate(`location.hash = '#/gym'`);
  await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 8000);
  await sleep(500); // capsule travel (~300ms) settles
  await shot('dock-focus-gym');
  await evaluate(`location.hash = '#/journal'`);
  await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 8000);
  await sleep(500);
  await shot('dock-focus-journal');
  await evaluate(`location.hash = '#/water'`);
  await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 8000);
  await sleep(500);
  await shot('dock-focus-water');
  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 8000);
  await sleep(500);
  await shot('dock-focus-settings');

  // History (V1.2): category views + streak card states.
  await evaluate(`location.hash = '#/history'`);
  await waitFor(`document.querySelector('.hist-grid') !== null`, 8000);
  await sleep(500);
  await shot('history-all');
  await evaluate(`document.querySelector('.hist-chip[data-category="water"]')?.click(); true`);
  await sleep(400);
  await shot('history-water');
  await evaluate(`document.querySelector('.hist-chip[data-category="gym"]')?.click(); true`);
  await sleep(400);
  await shot('history-gym');
  await evaluate(`document.querySelector('.hist-chip[data-category="all"]')?.click(); true`);
  await sleep(400);
  await evaluate(`document.querySelector('.hist-grid .hist-day[data-state="completed"]')?.click(); true`);
  await sleep(400);
  await shot('history-day-details');

  // Achievements (V1.2 Phase 2): cabinet, detail sheet, unlock celebration.
  await evaluate(`location.hash = '#/achievements'`);
  await waitFor(`document.querySelector('.ach-grid') !== null`, 8000);
  await sleep(500);
  await shot('achievements-cabinet');
  await evaluate(`document.querySelector('.ach-card.unlocked')?.click(); true`);
  await waitFor(`document.querySelector('.ach-detail .ach-detail-title') !== null`, 6000);
  await sleep(400);
  await shot('achievements-badge-detail');
  await evaluate(`document.querySelector('.ach-detail [data-detail-close]')?.click(); true`);
  await sleep(400);
  await evaluate(`document.querySelector('.ach-card.locked')?.click(); true`);
  await waitFor(`document.querySelector('.ach-detail .ach-detail-title') !== null`, 6000);
  await sleep(400);
  await shot('achievements-badge-locked');
  await evaluate(`document.querySelector('.ach-detail [data-detail-close]')?.click(); true`);
  await sleep(400);
  // Celebration replay: clear the seen-set, then queue the first badge the
  // seeded data has ACTUALLY earned — the captured moment stays honest.
  await evaluate(`(async () => {
    const A = await import('/js/achievements.js');
    const c = await import('/js/celebration.js');
    localStorage.removeItem('achievements-celebrated');
    const data = await (await import('/js/history.js')).loadHistoryData();
    const { earnedNew, progress } = A.evaluateAchievements(data, []);
    const target = earnedNew[0] || A.ACHIEVEMENTS[0];
    c.queueCelebration({ achievement: target, progress: progress.get(target.id), next: A.nextMilestone(target.id, progress), earnedAt: Date.now() });
    return { queued: c.pendingCelebrationCount(), badge: target.id };
  })()`);
  await waitFor(`!!document.querySelector('.celebration-backdrop')`, 8000);
  await sleep(1200); // let the reveal animation reach its settled state
  await shot('achievements-celebration');
  await evaluate(`document.querySelector('.celebration-backdrop [data-celebration="close"]')?.click(); true`);
  await sleep(400);

  // Narrow-viewport dock (320px) — compact fit, no clipping.
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 8000);
  await sleep(700);
  await shot('dock-320-dashboard');
  await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true });
  await sleep(400);

  // Light theme
  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`!!document.querySelector('[data-action="theme"]')`);
  await evaluate(`document.querySelector('[data-action="theme"][data-theme="light"]').click()`);
  await shot('light-settings');
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`!!document.querySelector('#dash-hero')`);
  await shot('light-dashboard');
  await evaluate(`location.hash = '#/water'`);
  await waitFor(`!!document.querySelector('#water-ring-wrap')`);
  await shot('light-water');
  await evaluate(`location.hash = '#/journal'`);
  await waitFor(`document.querySelector('.screen-root')?.children.length > 0`);
  await shot('light-journal');
} catch (err) {
  console.error('CRASH:', err.message);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}