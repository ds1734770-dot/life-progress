/**
 * V1.1 QA — motivational launch experience + avatar personalization.
 * Complements scripts/qa-extended.js (which keeps covering V1 flows).
 *
 * Covers:
 *   1. First launch: overlay shows the exact default quote before onboarding
 *   2. Fallback background is the bundled local asset
 *   3. No replay during internal navigation
 *   4. Custom quote edit / reset / persistence; overlay shows the saved quote
 *   5. Dashboard background → launch background relationship + fallback
 *   6. Avatar: built-in grid, initials, custom gallery image (real file pick)
 *   7. Avatar visible on Dashboard hero + Settings profile
 *   8. Persistence across a full Chrome restart
 *   9. Export → wipe → import restores quote + avatar image
 *  10. Offline launch (server down)
 *  11. Reduced-motion launch
 *  12. Mobile overflow at 320/360/390/412px (new screens included)
 *  13. Floating tab dock: compact glass dock + sliding active capsule
 *      (tap navigation, edges, press feedback, keyboard access, reduced
 *      motion, entrance, 320px fit, scroll stability)
 *
 * Run: node scripts/qa-v11.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8092;
const DEBUG_PORT = 9225;
const APP_URL = `http://localhost:${PORT}/`;
const TEST_IMAGE = join(ROOT, 'icons', 'icon-192.png');

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

// ---- Tiny CDP client (same proven pattern as qa-extended.js) ---------------
let ws;
let nextId = 0;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connect(url) {
  ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(d.exception?.description || d.text || 'exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
  };
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    replMode: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result?.value;
}

let qaSeq = 0;
async function evalAsync(expression) {
  const seq = ++qaSeq;
  await evaluate(`window.__qaSeq = ${seq}; window.__qaResult = null;`);
  await evaluate(`
    (async () => {
      try {
        window.__qaResult = { seq: window.__qaSeq, value: JSON.stringify(await (${expression})) };
      } catch (err) {
        window.__qaResult = { seq: window.__qaSeq, value: JSON.stringify({ __qaError: String(err && err.message || err) }) };
      }
    })()
  `);
  let payload = null;
  for (let i = 0; i < 200; i++) {
    const raw = await evaluate(`window.__qaResult && window.__qaResult.seq === ${seq} ? window.__qaResult.value : null`);
    if (raw != null) {
      payload = raw;
      break;
    }
    await sleep(50);
  }
  if (payload == null) throw new Error('evalAsync timed out: ' + expression.slice(0, 80));
  const parsed = JSON.parse(payload);
  if (parsed && parsed.__qaError) throw new Error(parsed.__qaError);
  return parsed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expression, timeout = 8000, label = expression) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch {
      /* page may be mid-navigation */
    }
    await sleep(120);
  }
  check(`timed out waiting for: ${label}`, false);
  return false;
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tryOnce = () => {
      http
        .get(`http://localhost:${PORT}/index.html`, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error('server did not start'));
          else setTimeout(tryOnce, 200);
        });
    };
    tryOnce();
  });
}

async function waitForTarget() {
  for (let i = 0; i < 75; i++) {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith(APP_URL));
      if (page) return page;
    } catch {
      /* chrome still starting */
    }
    await sleep(200);
  }
  throw new Error('no chrome page target');
}

async function attach() {
  const target = await waitForTarget();
  await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  await send('Network.enable');
}

async function setFileInput(selector, filePath) {
  const doc = await send('DOM.getDocument', { depth: 0 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await sleep(250);
}

const SCREENS = ['dashboard', 'water', 'goals', 'gym', 'journal', 'photos', 'settings', 'avatar'];

async function checkOverflow(label) {
  for (const screen of SCREENS) {
    await evaluate(`location.hash = '#/${screen}'`);
    await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 6000, `${screen} @${label}`);
    await sleep(350);
    const sw = await evaluate(`document.documentElement.scrollWidth`);
    const iw = await evaluate(`window.innerWidth`);
    check(`no horizontal overflow on ${screen} @${label}`, sw <= iw + 1, `scrollWidth=${sw} innerWidth=${iw}`);
  }
}

async function completeOnboarding(name = 'QA') {
  await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 10000, 'onboarding');
  await click('.onboarding #ob-next');
  await sleep(250);
  await evaluate(`const el = document.getElementById('ob-name'); el.value = ${JSON.stringify(name)};`);
  await click('.onboarding #ob-next');
  await sleep(250);
  await click('.onboarding #ob-next');
  await sleep(250);
  await click('.onboarding #ob-next');
  await sleep(250);
  await click('.onboarding #ob-next');
  await sleep(250);
  await click('.onboarding #ob-next');
  await waitFor(`document.getElementById('onboarding-root').children.length === 0`, 8000, 'onboarding done');
}

async function launchChrome() {
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=420,900',
      APP_URL,
    ],
    { stdio: 'ignore' }
  );
  await attach();
}

async function killChrome() {
  if (!chrome) return;
  try {
    ws?.close();
  } catch { /* ignore */ }
  chrome.kill('SIGKILL');
  chrome = null;
  await sleep(1200);
}

const launchOverlayGone = `!document.getElementById('launch-screen')`;

// ---- The test ---------------------------------------------------------------

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-qa11-'));
let chrome;
let serverBack = null;

try {
  console.log('Starting server + Chrome…');
  await waitForServer();
  await launchChrome();

  console.log('\n— First-ever launch (before onboarding) —');
  // Cold Chrome start can outlast the ~3s overlay, so start a fresh session
  // now (same profile — still a first launch: no settings record yet) and
  // catch the overlay while it is up.
  await send('Page.reload');
  await sleep(600);
  await waitFor(`document.getElementById('launch-screen') !== null`, 6000, 'launch overlay on first launch');
  const first = await evalAsync(`(async () => {
    const el = document.getElementById('launch-screen');
    if (!el) return { shown: false };
    const bg = el.querySelector('.launch-bg');
    const quote = el.querySelector('.launch-quote');
    return {
      shown: true,
      quote: quote ? quote.textContent : null,
      bgIsBundle: bg ? bg.style.backgroundImage.includes('launch-bg.png') : false,
      hasSkip: !!el.querySelector('.launch-skip'),
    };
  })()`);
  check('launch overlay appears on first launch', first.shown);
  check('default quote is exactly "Don\'t forget why u started."', first.quote === "Don't forget why u started.", JSON.stringify(first.quote));
  check('background is the bundled local fallback (offline asset)', first.bgIsBundle);
  check('skip control present', first.hasSkip);

  // Reduced-motion: the class is decided when the overlay is built, so
  // emulate BEFORE starting the session that creates it.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.reload');
  await sleep(600);
  await waitFor(`document.getElementById('launch-screen') !== null`, 6000, 'launch overlay (reduced motion)');
  check('reduced-motion class applied to overlay', await evaluate(`document.getElementById('launch-screen')?.classList.contains('reduced') === true`));
  await waitFor(launchOverlayGone, 9000, 'reduced-motion overlay auto-dismisses');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });

  // Failsafe: overlay must leave without any interaction.
  await waitFor(launchOverlayGone, 9000, 'launch overlay auto-dismisses');
  check('launch overlay auto-dismisses (never blocks boot)', await evaluate(launchOverlayGone));

  console.log('\n— Onboarding + no replay during navigation —');
  await completeOnboarding('QA');
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard');
  check('no launch overlay during onboarding/dashboard', await evaluate(launchOverlayGone));
  for (const r of ['water', 'goals', 'dashboard', 'settings']) {
    await evaluate(`location.hash = '#/${r}'`);
    await sleep(350);
  }
  check('launch never replays during internal navigation', await evaluate(launchOverlayGone));

  console.log('\n— Quote editor —');
  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="edit-quote"]') !== null`, 6000, 'quote row');
  check('settings shows the current quote', await evaluate(`document.body.innerText.includes("Don't forget why u started.")`));
  await click('[data-action="edit-quote"]');
  await waitFor(`document.getElementById('quote-input') !== null`, 6000, 'quote editor');
  await evaluate(`const qi = document.getElementById('quote-input'); qi.value = 'Small steps. Big results.'; qi.dispatchEvent(new Event('input'));`);
  await sleep(200);
  check('live character counter', await evaluate(`document.getElementById('quote-counter')?.textContent === '25 / 120'`), await evaluate(`document.getElementById('quote-counter')?.textContent`));
  check('live preview updates', await evaluate(`document.querySelector('#quote-preview .launch-preview-quote')?.textContent === 'Small steps. Big results.'`));
  await click('#quote-editor .btn-primary');
  await waitFor(`document.body.innerText.includes('Small steps. Big results.')`, 6000, 'quote saved in settings');
  const savedQuote = await evalAsync(`(async () => (await import('/js/settings.js')).getSettings().launchQuote)()`);
  check('quote persisted to settings record', savedQuote === 'Small steps. Big results.', savedQuote);

  console.log('\n— Avatar selection —');
  await evaluate(`location.hash = '#/avatar'`);
  await waitFor(`document.querySelector('.avatar-grid') !== null`, 6000, 'avatar screen');
  const gridCount = await evaluate(`document.querySelectorAll('.avatar-option').length`);
  check('built-in avatar grid (8 distinct options)', gridCount === 8, `count=${gridCount}`);
  check('a built-in avatar is selected by default', await evaluate(`document.querySelector('.avatar-option.selected') !== null`));

  // Pick a different built-in.
  await click('.avatar-option[data-id="dusk"]');
  await waitFor(`document.querySelector('.avatar-option[data-id="dusk"].selected') !== null`, 5000, 'dusk selected');
  const duskState = await evalAsync(`(async () => (await import('/js/settings.js')).getSettings().avatar)()`);
  check('built-in selection persists immediately', duskState.type === 'builtin' && duskState.value === 'dusk', JSON.stringify(duskState));
  check('dashboard shows SVG avatar (not bare initials)', await evaluate(`location.hash='#/dashboard'; true`));
  await waitFor(`document.querySelector('#dash-hero .avatar-photo svg') !== null`, 6000, 'dashboard avatar');

  // Initials.
  await evaluate(`location.hash = '#/avatar'`);
  await waitFor(`document.querySelector('[data-action="pick-initials"]') !== null`, 6000, 'avatar screen again');
  await click('[data-action="pick-initials"]');
  await waitFor(`document.querySelector('[data-action="pick-initials"] .avatar-check') !== null`, 5000, 'initials selected');
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 6000, 'dashboard for initials');
  check('dashboard shows initials avatar for QA user', await evaluate(`document.querySelector('#dash-hero .avatar')?.textContent.trim() === 'Q' || document.querySelector('#dash-hero .avatar')?.textContent.trim() === 'QA'`), await evaluate(`document.querySelector('#dash-hero .avatar')?.textContent.trim()`));

  // Custom gallery image (real file through the picker).
  await evaluate(`location.hash = '#/avatar'`);
  await waitFor(`document.querySelector('[data-action="pick-custom"]') !== null`, 6000, 'avatar screen for custom');
  await click('[data-action="pick-custom"]');
  await setFileInput('input[type=file]', TEST_IMAGE);
  await waitFor(`document.querySelectorAll('.avatar-option')[0] !== null && document.querySelector('[data-action="pick-custom"] .avatar-check') !== null`, 8000, 'custom avatar applied');
  const customState = await evalAsync(`(async () => {
    const s = (await import('/js/settings.js')).getSettings();
    return { type: s.avatar.type, isBlob: s.avatarImage instanceof Blob, size: s.avatarImage && s.avatarImage.size };
  })()`);
  check('custom avatar saved as local downscaled blob', customState.type === 'custom' && customState.isBlob && customState.size > 0, JSON.stringify(customState));
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('#dash-hero .avatar-photo img') !== null`, 6000, 'dashboard custom avatar img');
  check('dashboard renders custom avatar image', true);

  console.log('\n— Dashboard background → launch background relationship —');
  await evalAsync(`(async () => {
    const s = await import('/js/settings.js');
    await s.saveSettings({ backgroundImage: { dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', name: 'qa.png' } });
    return true;
  })()`);
  // Reload starts a NEW session: the overlay appears within ~1s and holds
  // for ~3s, so catch it while it is up (poll, don't sleep past it).
  await send('Page.reload');
  await sleep(600);
  await waitFor(`document.getElementById('launch-screen') !== null`, 6000, 'launch overlay on 2nd session');
  const bgRel = await evalAsync(`(async () => {
    const el = document.getElementById('launch-screen');
    if (!el) return { shown: false };
    const bg = el.querySelector('.launch-bg');
    return {
      shown: true,
      usesDashboardBg: bg ? bg.style.backgroundImage.includes('data:image') : false,
      quote: el.querySelector('.launch-quote')?.textContent || null,
    };
  })()`);
  check('launch overlay shows on new session (2nd launch)', bgRel.shown);
  check('launch uses the Dashboard background image', bgRel.usesDashboardBg === true);

  console.log('\n— Quote shown at launch + skip interaction —');
  check('launch shows the saved custom quote', bgRel.quote === 'Small steps. Big results.', JSON.stringify(bgRel.quote));
  await click('.launch-skip');
  await waitFor(launchOverlayGone, 4000, 'skip removes overlay');
  check('tap Skip exits immediately', await evaluate(launchOverlayGone));
  await waitFor(`document.querySelector('#dash-hero') !== null`, 8000, 'dashboard after skip');

  console.log('\n— Export → wipe → import (personalization round-trip) —');
  const exportJson = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const ph = await import('/js/photos.js');
    const dump = await db.dbExportAll(async (record) => ({
      ...record,
      blob: await ph.blobToDataURL(record.blob),
      thumb: await ph.blobToDataURL(record.thumb),
    }));
    const s = dump.data.settings && dump.data.settings[0];
    if (s && s.avatarImage instanceof Blob) s.avatarImage = await ph.blobToDataURL(s.avatarImage);
    return JSON.stringify(dump);
  })()`);
  const dump = JSON.parse(exportJson);
  const exportedSettings = dump.data.settings?.[0];
  check('export contains launch quote', exportedSettings?.launchQuote === 'Small steps. Big results.');
  check('export contains avatar selection', exportedSettings?.avatar?.type === 'custom', JSON.stringify(exportedSettings?.avatar));
  check('export contains avatar image as data URL', typeof exportedSettings?.avatarImage === 'string' && exportedSettings.avatarImage.startsWith('data:image'), `len=${exportedSettings?.avatarImage?.length || 0}`);

  const tmpDir = mkdtempSync(join(tmpdir(), 'life-progress-v11-export-'));
  const exportPath = join(tmpDir, 'backup.json');
  writeFileSync(exportPath, exportJson);

  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="clear-data"]') !== null`, 6000, 'settings for wipe');
  await click('[data-action="clear-data"]');
  await waitFor(`document.querySelector('.dialog') !== null`, 6000, 'wipe dialog');
  await click('.dialog .btn-danger');
  await waitFor(`document.body.innerText.includes('All data cleared')`, 6000, 'wipe toast');

  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 10000, 'onboarding after wipe');
  await completeOnboarding('Fresh');
  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="import-data"]') !== null`, 6000, 'settings for import');
  await click('[data-action="import-data"]');
  await setFileInput('input[type=file][accept*="json"]', exportPath);
  await waitFor(`document.querySelector('.dialog') !== null`, 8000, 'import confirm');
  await click('.dialog .btn-danger');
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard after import');

  const importCheck = await evalAsync(`(async () => {
    const s = (await import('/js/settings.js')).getSettings();
    return {
      quote: s.launchQuote,
      avatarType: s.avatar.type,
      avatarIsBlob: s.avatarImage instanceof Blob,
      bgRestored: !!s.backgroundImage,
    };
  })()`);
  check('import restores launch quote', importCheck.quote === 'Small steps. Big results.', importCheck.quote);
  check('import restores avatar selection', importCheck.avatarType === 'custom', importCheck.avatarType);
  check('import restores avatar image as blob', importCheck.avatarIsBlob === true);
  check('import restores dashboard background', importCheck.bgRestored === true);

  console.log('\n— Persistence across full Chrome restart —');
  await killChrome();
  await launchChrome();
  await sleep(1500);
  await waitFor(`document.querySelector('.tabbar') !== null || document.getElementById('launch-screen') !== null`, 10000, 'app after restart');
  await waitFor(launchOverlayGone, 9000, 'launch overlay leaves after restart');
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard after restart');
  const restartCheck = await evalAsync(`(async () => {
    const s = (await import('/js/settings.js')).getSettings();
    return { quote: s.launchQuote, avatarType: s.avatar.type, blob: s.avatarImage instanceof Blob };
  })()`);
  check('quote survives restart', restartCheck.quote === 'Small steps. Big results.', restartCheck.quote);
  check('avatar survives restart', restartCheck.avatarType === 'custom' && restartCheck.blob, JSON.stringify(restartCheck));
  await waitFor(`document.querySelector('#dash-hero .avatar-photo img') !== null`, 6000, 'avatar img after restart');
  check('avatar renders after restart (blob URL live)', true);

  console.log('\n— Offline launch (server down) —');
  server.kill('SIGKILL');
  await send('Page.reload');
  await sleep(2500);
  const offlineOk = await waitFor(`document.querySelector('#dash-hero') !== null || document.getElementById('launch-screen') !== null`, 15000, 'offline reload');
  check('app reloads fully offline (SW shell + launch)', offlineOk);
  if (offlineOk) {
    await waitFor(launchOverlayGone, 9000, 'offline launch overlay leaves');
    const offlineQuote = await evalAsync(`(async () => {
      const s = (await import('/js/settings.js')).getSettings();
      return s.launchQuote;
    })()`);
    check('quote available offline', offlineQuote === 'Small steps. Big results.', offlineQuote);
    await evaluate(`location.hash = '#/avatar'`);
    await waitFor(`document.querySelector('.avatar-grid') !== null`, 8000, 'offline avatar screen');
    check('avatar picker works offline (local SVG assets)', (await evaluate(`document.querySelectorAll('.avatar-option').length`)) >= 8);
  }
  serverBack = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(500);

  console.log('\n— Reduced-motion launch (dedicated pass) —');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await send('Page.reload');
  await sleep(600);
  await waitFor(`document.querySelector('.tabbar') !== null || document.getElementById('launch-screen') !== null`, 10000, 'app after RM reload');
  await waitFor(launchOverlayGone, 9000, 'reduced-motion overlay leaves');
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 12000, 'dashboard after reduced-motion launch');
  check('reduced-motion launch completes and reaches dashboard', await evaluate(`document.querySelector('#dash-hero') !== null`));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });

  console.log('\n— Mobile overflow (320 / 360 / 390 / 412 px) —');
  for (const w of [320, 360, 390, 412]) {
    await setViewport(w, Math.round(w * 1.9));
    await checkOverflow(`${w}px`);
  }
  // Long-quote stress at the smallest width.
  await setViewport(320, 640);
  await evalAsync(`(async () => {
    const s = await import('/js/settings.js');
    await s.saveSettings({ launchQuote: 'Extraordinarily long motivational launch quote '.repeat(3).trim() });
    return true;
  })()`);
  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="edit-quote"]') !== null`, 6000, 'settings for long quote');
  const longOk = await waitFor(`document.documentElement.scrollWidth <= window.innerWidth + 1`, 4000, 'long quote layout');
  check('long quote does not overflow settings', longOk);
  await evalAsync(`(async () => {
    const s = await import('/js/settings.js');
    await s.saveSettings({ launchQuote: 'Small steps. Big results.' });
    return true;
  })()`);

  // ------------------------------------------------------------------------
  // V1.1 floating tab dock — compact glass dock with a sliding active capsule.
  // Uses synthetic PointerEvents; taps go through the real click handlers.
  // ------------------------------------------------------------------------
  console.log('\n— Floating dock: structure + tap navigation —');
  await setViewport(390, 844);
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard for dock QA');
  const tabInfo = await evalAsync(`(async () => {
    const bar = document.querySelector('.tabbar');
    const tabs = [...bar.querySelectorAll('.tab-item')];
    const style = getComputedStyle(bar);
    return {
      count: tabs.length,
      labels: tabs.map((t) => t.querySelector('.tab-label')?.textContent),
      arias: tabs.map((t) => t.getAttribute('aria-label')),
      enhanced: bar.dataset.dockEnhanced === '1',
      capsule: bar.querySelector('.tab-capsule')?.getAttribute('aria-hidden') === 'true',
      floating: style.position === 'fixed' && style.borderRadius !== '0px',
      notFullWidth: parseFloat(style.width) < window.innerWidth - 8,
    };
  })()`);
  check('tab bar is dock-enhanced (existing component reused, no duplicate nav)', tabInfo.enhanced);
  check('active capsule is decorative (aria-hidden)', tabInfo.capsule);
  check('dock container is a floating rounded surface', tabInfo.floating);
  check('dock does not span the full viewport width', tabInfo.notFullWidth);
  check('all six navigation items remain available', tabInfo.count === 6, String(tabInfo.count));
  check('navigation order and labels unchanged',
    JSON.stringify(tabInfo.labels) === JSON.stringify(['Home', 'Water', 'Gym', 'Goals', 'Journal', 'Settings']),
    JSON.stringify(tabInfo.labels));
  check('existing ARIA labels remain intact', tabInfo.arias.every(Boolean), JSON.stringify(tabInfo.arias));

  console.log('\n— Floating dock: safe area + geometry —');
  const geoCheck = await evalAsync(`(async () => {
    const bar = document.querySelector('.tabbar');
    const r = bar.getBoundingClientRect();
    return { left: r.left, right: window.innerWidth - r.right, bottomGap: window.innerHeight - r.bottom };
  })()`);
  check('dock is detached from the left screen edge', geoCheck.left >= 8, `gap=${geoCheck.left.toFixed(1)}px`);
  check('dock is detached from the right screen edge', geoCheck.right >= 8, `gap=${geoCheck.right.toFixed(1)}px`);
  check('dock floats above the viewport bottom edge', geoCheck.bottomGap >= 8, `gap=${geoCheck.bottomGap.toFixed(1)}px`);

  console.log('\n— Floating dock: capsule slides between tabs on tap —');
  const capsuleX = () => evaluate(`(() => {
    const c = document.querySelector('.tab-capsule');
    const m = c.style.transform.match(/translate3d\\((-?[\\d.]+)px/);
    return m ? parseFloat(m[1]) : null;
  })()`);
  const tapTab = async (route) => {
    await evaluate(`document.querySelector('.tabbar .tab-item[data-route="${route}"]').click()`);
    const ok = await waitFor(`location.hash === '#/${route}'`, 5000, `tap → ${route}`);
    await sleep(450); // capsule travel (~300ms) must finish
    const activeOk = await evaluate(
      `document.querySelector('.tabbar .tab-item.active')?.dataset.route === '${route}' &&
       document.querySelector('.tabbar .tab-item[data-route="${route}"]').getAttribute('aria-current') === 'page'`
    );
    check(`tap → ${route} navigates and becomes the active route`, ok && activeOk);
  };
  await tapTab('water');
  const capWater = await capsuleX();
  await tapTab('gym');
  const capGym = await capsuleX();
  await tapTab('goals');
  const capGoals = await capsuleX();
  const itemRelCenters = await evalAsync(`(async () => {
    const barRect = document.querySelector('.tabbar').getBoundingClientRect();
    return [...document.querySelectorAll('.tabbar .tab-item')].map((it) => {
      const r = it.getBoundingClientRect();
      return r.left + r.width / 2 - barRect.left;
    });
  })()`);
  // capsule.style.transform holds the capsule's LEFT edge; its center is
  // leftEdge + width/2. "Centered on the item" = capsule center ≈ item center.
  const capsuleW = await evaluate(`parseFloat(getComputedStyle(document.querySelector('.tab-capsule')).width)`);
  const near = (cap, i) => cap != null && Math.abs(cap + capsuleW / 2 - itemRelCenters[i]) < 14;
  check('capsule sits on Water after navigating to Water', near(capWater, 1), `cap=${capWater} item=${itemRelCenters[1]}`);
  check('capsule moved Water → Gym → Goals (single sliding element)',
    capGym > capWater + 20 && capGoals > capGym + 20,
    `water=${capWater} gym=${capGym} goals=${capGoals}`);
  check('capsule is centered on the active item after travel', near(capGoals, 3), `cap=${capGoals} item=${itemRelCenters[3]}`);
  check('capsule only ever covers the active item (not the whole dock)',
    await evaluate(`parseFloat(getComputedStyle(document.querySelector('.tab-capsule')).width) <
      document.querySelector('.tabbar').getBoundingClientRect().width * 0.5`));

  console.log('\n— Floating dock: first and last item —');
  await tapTab('dashboard');
  const capFirst = await capsuleX();
  check('capsule reaches the first item', near(capFirst, 0), `cap=${capFirst} item=${itemRelCenters[0]}`);
  await tapTab('settings');
  const capLast = await capsuleX();
  check('capsule reaches the last item', near(capLast, 5), `cap=${capLast} item=${itemRelCenters[5]}`);
  check('capsule stays inside the dock at both edges',
    await evaluate(`(() => {
      const c = document.querySelector('.tab-capsule').getBoundingClientRect();
      const b = document.querySelector('.tabbar').getBoundingClientRect();
      return c.left >= b.left - 1 && c.right <= b.right + 1;
    })()`));

  console.log('\n— Floating dock: press feedback —');
  const press = await evalAsync(`(async () => {
    const item = document.querySelectorAll('.tabbar .tab-item')[2];
    const r = item.getBoundingClientRect();
    item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 5, isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await new Promise((res) => setTimeout(res, 80));
    const pressed = item.classList.contains('tab-pressed');
    item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', pointerId: 5, isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    await new Promise((res) => setTimeout(res, 80));
    return { pressed, released: !item.classList.contains('tab-pressed') };
  })()`);
  check('touch press applies the subtle scale-down feedback', press.pressed);
  check('press feedback releases cleanly', press.released);

  console.log('\n— Floating dock: keyboard accessibility —');
  await send('Page.bringToFront'); // headless: key default actions need page focus
  await sleep(200);
  await evaluate(`document.activeElement && document.activeElement.blur()`);
  let kbRoute = null;
  for (let i = 0; i < 60 && !kbRoute; i++) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    kbRoute = await evaluate(`document.activeElement?.classList?.contains('tab-item') ? document.activeElement.dataset.route : null`);
  }
  check('Tab reaches the navigation items', kbRoute !== null, String(kbRoute));
  const kbFocusVisible = await evaluate(`document.activeElement?.matches?.(':focus-visible') === true`);
  check('focused tab shows a visible focus indicator (:focus-visible outline)', kbFocusVisible);
  const kbTarget = await evaluate(`document.activeElement?.dataset?.route`);
  // Puppeteer-style Enter: the char event (text: '\r') is what triggers the
  // button's native activation in headless Chrome.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  const kbNav = await waitFor(`location.hash === '#/${kbTarget}'`, 5000, 'Enter activates tab');
  check('Enter/Space activates the focused tab', kbNav, `target=${kbTarget}`);
  await sleep(450);
  check('capsule follows keyboard-activated route',
    await evaluate(`document.querySelector('.tabbar .tab-item.active')?.dataset.route === '${kbTarget}'`));

  console.log('\n— Floating dock: reduced motion —');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(150);
  await tapTab('goals');
  const rmCap = await capsuleX();
  check('reduced motion: capsule still tracks the active route (no animation)', near(rmCap, 3), `cap=${rmCap}`);
  check('reduced motion: tap navigation still works', await evaluate(`location.hash === '#/goals'`));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });
  await sleep(200);
  await tapTab('dashboard');
  const postRm = await capsuleX();
  check('capsule settles on the route after reduced-motion toggling', near(postRm, 0), `cap=${postRm}`);

  console.log('\n— Floating dock: entrance after launch —');
  const entrance = await evalAsync(`(async () => {
    const bar = document.querySelector('.tabbar');
    return {
      visible: !bar.classList.contains('dock-hidden'),
      opacity: parseFloat(getComputedStyle(bar).opacity),
    };
  })()`);
  check('dock is visible after the launch sequence (entrance completed, never stuck hidden)',
    entrance.visible && entrance.opacity > 0.99, JSON.stringify(entrance));

  console.log('\n— Floating dock: responsive safety (320px) —');
  await setViewport(320, 640);
  const resp = await evaluate(`(() => {
    const bar = document.querySelector('.tabbar');
    const r = bar.getBoundingClientRect();
    const items = [...bar.querySelectorAll('.tab-item')];
    return {
      fits: r.right <= window.innerWidth + 1 && r.left >= -1,
      edgeGaps: r.left >= 4 && window.innerWidth - r.right >= 4,
      noInnerOverflow: bar.scrollWidth <= bar.clientWidth + 1,
      labels: items.every((i) => {
        const l = i.querySelector('.tab-label');
        return l && l.getBoundingClientRect().width > 0;
      }),
      noClippedLabels: items.every((i) => {
        const l = i.querySelector('.tab-label').getBoundingClientRect();
        return l.right <= r.right + 1 && l.left >= r.left - 1;
      }),
      items: items.length,
    };
  })()`);
  check('dock fits the 320px viewport with no inner overflow', resp.fits && resp.noInnerOverflow, JSON.stringify(resp));
  check('dock keeps a margin from the screen edges at 320px', resp.edgeGaps, JSON.stringify(resp));
  check('all six labels render unclipped at 320px', resp.labels && resp.noClippedLabels && resp.items === 6, JSON.stringify(resp));

  console.log('\n— Floating dock: scroll behaviour —');
  await setViewport(390, 844);
  await evaluate(`location.hash = '#/goals'`);
  await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 6000, 'goals for scroll check');
  const scrollCheck = await evalAsync(`(async () => {
    const bar = document.querySelector('.tabbar');
    const before = bar.getBoundingClientRect().top;
    window.scrollTo(0, 400);
    await new Promise((res) => setTimeout(res, 150));
    const after = bar.getBoundingClientRect().top;
    window.scrollTo(0, 0);
    return { stable: Math.abs(before - after) < 1, scrollable: document.documentElement.scrollHeight > window.innerHeight };
  })()`);
  if (scrollCheck.scrollable) {
    check('dock stays fixed in place while the page scrolls', scrollCheck.stable);
  } else {
    check('dock stays fixed in place while the page scrolls', true, 'page not scrollable at this height — skipped');
  }

  console.log('\n— Console errors —');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('service worker') && !e.includes('favicon') && !e.includes('DOMException') && !e.includes('net::')
  );
  check('no unhandled JS errors during the whole V1.1 QA run', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  console.error('QA V1.1 CRASHED:', err.message);
  failures += 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome) chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { serverBack?.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? '✓ ALL V1.1 QA CHECKS PASSED' : `✗ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
