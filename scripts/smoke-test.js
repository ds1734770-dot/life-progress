/**
 * End-to-end smoke test — drives the real app in headless Chrome via CDP.
 * Uses only Node built-ins (http + global WebSocket).
 *
 * Covers: onboarding → dashboard → water → goals → gym → photos (real file
 * upload through the picker) → journal → settings → persistence after reload.
 *
 * Run: node scripts/smoke-test.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8090;
const DEBUG_PORT = 9223;
const APP_URL = `http://localhost:${PORT}/`;
const TEST_IMAGE = join(ROOT, 'icons', 'icon-192.png');

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

// ---- Tiny CDP client ------------------------------------------------------
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
  dumpErrors();
  return false;
}

function dumpErrors() {
  if (consoleErrors.length) {
    console.log('   recent console errors:', consoleErrors.slice(-4).join(' | '));
  }
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
  for (let i = 0; i < 50; i++) {
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

// ---- The test -------------------------------------------------------------

async function main() {
  console.log('Starting server…');
  const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });

  // Fresh profile per run — a reused profile would already be onboarded and
  // make the test fail on its second invocation.
  const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-smoke-'));
  console.log('Starting headless Chrome…');
  const chrome = spawn(
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

  try {
    await waitForServer();
    const target = await waitForTarget();
    await connect(target.webSocketDebuggerUrl);
    await send('Runtime.enable');
    await send('Page.enable');
    await send('DOM.enable');

    console.log('\n— Onboarding —');
    await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 8000, 'onboarding visible');
    check('onboarding shown on first launch', await evaluate(`document.querySelector('.onboarding') !== null`));
    await click('.onboarding #ob-next'); // welcome → name
    await sleep(300);
    await evaluate(`
      const el = document.getElementById('ob-name');
      el.value = 'Alex';
      el.dispatchEvent(new Event('input'));
    `);
    await click('.onboarding #ob-next'); // name → water
    await sleep(300);
    check('name accepted', await evaluate(`document.querySelector('.ob-title').textContent.includes('water')`));
    await click('.onboarding #ob-next'); // water → theme
    await sleep(300);
    await click('.onboarding #ob-next'); // theme → background
    await sleep(300);
    await click('.onboarding #ob-next'); // get started
    await waitFor(`document.getElementById('onboarding-root').children.length === 0`, 8000, 'onboarding closed');

    console.log('\n— Dashboard —');
    await waitFor(`document.querySelector('#dash-hero') !== null`, 8000, 'dashboard hero');
    const greeting = await evaluate(`document.querySelector('.dash-name')?.textContent`);
    check('personalized greeting', /Alex/.test(greeting || ''), greeting);
    check('overall progress card', await evaluate(`document.body.innerText.includes("Today's Progress")`));
    check('honest empty state (no goals)', await evaluate(`document.body.innerText.includes('No goals for today')`));
    check('water summary shows 0', await evaluate(`document.body.innerText.includes('0 ml')`));

    console.log('\n— Water —');
    await evaluate(`location.hash = '#/water'`);
    await waitFor(`document.querySelector('[data-action="water-add"]') !== null`, 8000, 'water screen');
    await click('[data-action="water-add"][data-amount="250"]');
    await sleep(1000); // let the 700ms counter animation finish
    const total1 = await evaluate(`document.getElementById('water-total')?.textContent`);
    check('water +250 ml', total1 === '250 ml', total1);
    await click('[data-action="water-add"][data-amount="250"]');
    await sleep(1000);
    const total2 = await evaluate(`document.getElementById('water-total')?.textContent`);
    check('water +500 ml', total2 === '500 ml', total2);
    check('progress % computed', await evaluate(`document.getElementById('water-pct')?.textContent === '17%'`), await evaluate(`document.getElementById('water-pct')?.textContent`));

    console.log('\n— Goals —');
    await evaluate(`location.hash = '#/goals'`);
    await waitFor(`document.querySelector('[data-action="add-goal"]') !== null`, 8000, 'goals screen');
    check('goals empty state', await evaluate(`document.body.innerText.includes('No goals yet')`));
    await click('[data-action="add-goal"]');
    await waitFor(`document.querySelector('.sheet') !== null`, 8000, 'goal sheet');
    await sleep(300);
    await evaluate(`
      const sheet = document.querySelector('.sheet');
      const inputs = sheet.querySelectorAll('input');
      if (!inputs.length) throw new Error('no inputs in sheet');
      inputs[0].value = 'Read 20 pages';
      inputs[0].dispatchEvent(new Event('input'));
    `);
    await click('.sheet .btn-primary');
    const goalCreated = await waitFor(`document.body.innerText.includes('Read 20 pages')`, 6000, 'goal created');
    check('goal created', goalCreated);
    const toggles = await evaluate(`document.querySelectorAll('[data-action="goal-toggle"]').length`);
    check('goal toggle button present', toggles >= 1, `count=${toggles}`);
    await click('[data-action="goal-toggle"]');
    const done = await waitFor(`document.querySelector('.goal-card.done') !== null`, 4000, 'goal completed');
    if (!done) {
      console.log('   goal card html:', (await evaluate(`document.querySelector('.goal-card')?.outerHTML.slice(0, 300)`)));
    }
    check('goal completion reflected', done);

    console.log('\n— Gym —');
    await evaluate(`location.hash = '#/gym/new'`);
    await waitFor(`document.querySelector('.sheet') !== null`, 8000, 'workout sheet');
    await evaluate(`
      const inputs = document.querySelectorAll('.sheet .form-grid input');
      if (inputs[0]) { inputs[0].value = 'Bench Press'; inputs[0].dispatchEvent(new Event('input')); }
      if (inputs[1]) { inputs[1].value = '4'; inputs[1].dispatchEvent(new Event('input')); }
      if (inputs[2]) { inputs[2].value = '8'; inputs[2].dispatchEvent(new Event('input')); }
      if (inputs[3]) { inputs[3].value = '60'; inputs[3].dispatchEvent(new Event('input')); }
    `);
    await click('.sheet .btn-primary');
    const workoutSaved = await waitFor(`document.body.innerText.includes('Strength')`, 6000, 'workout card');
    check('workout saved', workoutSaved);
    check('stats updated', await evaluate(`document.querySelector('.stat-value')?.textContent === '1'`));

    console.log('\n— Progress photos —');
    await evaluate(`location.hash = '#/photos'`);
    await waitFor(`document.querySelector('[data-action="photo-gallery"]') !== null`, 8000, 'photos screen');
    check('photos empty state', await evaluate(`document.body.innerText.includes('No progress photos yet')`));
    await click('[data-action="photo-gallery"]');
    await waitFor(`document.querySelector('input[type=file]') !== null`, 8000, 'file input');
    const doc = await send('DOM.getDocument', { depth: 0 });
    const inputNode = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
    await send('DOM.setFileInputFiles', { nodeId: inputNode.nodeId, files: [TEST_IMAGE] });
    // The picker consumes the input immediately; the confirm sheet is the proof.
    const confirmShown = await waitFor(`document.querySelector('.sheet') !== null`, 6000, 'photo confirm sheet');
    if (!confirmShown) {
      console.log('   photos page html:', (await evaluate(`document.body.innerText.slice(0, 150)`)));
    }
    await sleep(300);
    await click('.sheet .btn-primary');
    const tileShown = await waitFor(`document.querySelectorAll('.photo-tile').length >= 1`, 8000, 'photo tile');
    if (!tileShown) {
      console.log('   photos in body:', (await evaluate(`document.body.innerText.slice(0, 120)`)));
      dumpErrors();
    }
    check('photo added to grid', tileShown);

    console.log('\n— Journal —');
    await evaluate(`location.hash = '#/journal/edit'`);
    await waitFor(`document.getElementById('j-body') !== null`, 8000, 'journal editor');
    await evaluate(`
      document.getElementById('j-title').value = 'A good day';
      document.getElementById('j-body').value = 'Hit my workout, drank water, stayed focused.';
    `);
    await click('[data-action="save-entry"]');
    await waitFor(`document.body.innerText.includes('A good day')`, 8000, 'journal entry listed');
    check('journal entry listed', await evaluate(`document.body.innerText.includes('A good day')`));
    check('journal stats', await evaluate(`document.body.innerText.includes('Entries')`));

    console.log('\n— Settings —');
    await evaluate(`location.hash = '#/settings'`);
    await waitFor(`document.querySelector('[data-action="export-data"]') !== null`, 8000, 'settings screen');
    check('settings rendered', await evaluate(`document.body.innerText.includes('Theme') && document.body.innerText.includes('Export data')`));

    console.log('\n— Persistence —');
    await send('Page.reload');
    await waitFor(`document.querySelector('.tabbar') !== null`, 10000, 'app after reload');
    // The reload keeps the current hash; go home explicitly.
    await evaluate(`location.hash = '#/dashboard'`);
    await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard after reload');
    await waitFor(`document.body.innerText.includes('Read 20 pages')`, 8000, 'goal persisted');
    const persists = await evaluate(`(document.body.innerText.includes('Read 20 pages') && document.body.innerText.includes('500 ml'))`);
    check('data persists after reload (IndexedDB)', persists);

    console.log('\n— Console errors —');
    const realErrors = consoleErrors.filter(
      (e) => !e.includes('service worker') && !e.includes('favicon') && !e.includes('DOMException')
    );
    check('no unhandled JS errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  } catch (err) {
    console.error('SMOKE TEST CRASHED:', err.message);
    failures += 1;
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    chrome.kill('SIGKILL');
    server.kill('SIGKILL');
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n${failures === 0 ? '✓ ALL SMOKE TESTS PASSED' : `✗ ${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();