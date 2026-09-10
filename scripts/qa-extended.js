/**
 * Extended QA verification — covers what the unit tests and smoke test do not:
 *   1. Persistence across a full app restart (Chrome relaunch, same profile)
 *   2. Photo blobs surviving the restart (naturalWidth > 0)
 *   3. Export → wipe → import round-trip (photo blobs included)
 *   4. Offline mode (emulated): reload + navigate + add data with no network
 *   5. Mobile overflow checks at 360px and 320px (incl. long content)
 *   6. Edge-case routes (unknown route fallback, #/photos/add)
 *   7. PWA assets (manifest, icons, service worker, caches)
 *   8. Privacy: journal content never appears in console output
 *
 * Run: node scripts/qa-extended.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8091;
const DEBUG_PORT = 9224;
const APP_URL = `http://localhost:${PORT}/`;
const TEST_IMAGE = join(ROOT, 'icons', 'icon-192.png');

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

// ---- Tiny CDP client -------------------------------------------------------
let ws;
let nextId = 0;
const pending = new Map();
const consoleErrors = [];
const allConsoleText = [];

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
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value || a.description || '').join(' ');
      allConsoleText.push(text);
      if (['error', 'assert'].includes(msg.params.type)) consoleErrors.push(text);
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

/**
 * Async evaluates that need a VALUE back. This headless Chrome build does not
 * reliably honor awaitPromise and only serializes primitives, so the expression
 * stores a JSON string tagged with a sequence number in window.__qaResult and
 * we poll for it with synchronous evaluates (which serialize strings fine).
 */
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
  if (payload == null) throw new Error('evalAsync timed out for: ' + expression.slice(0, 80));
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

async function getFileInputNodeId(selector) {
  const doc = await send('DOM.getDocument', { depth: 0 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  return node.nodeId;
}

async function pickFileWith(selector, filePath) {
  await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, 8000, `file input ${selector}`);
  const nodeId = await getFileInputNodeId(selector);
  await send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
}

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(250);
}

async function overflowOk() {
  const sw = await evaluate(`document.documentElement.scrollWidth`);
  const iw = await evaluate(`window.innerWidth`);
  return { sw, iw };
}

const SCREENS = ['dashboard', 'water', 'goals', 'gym', 'journal', 'photos', 'settings'];

async function checkOverflow(label) {
  for (const screen of SCREENS) {
    await evaluate(`location.hash = '#/${screen}'`);
    await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 6000, `${screen} at ${label}`);
    await sleep(350); // let stagger animations finish
    const { sw, iw } = await overflowOk();
    check(`no horizontal overflow on ${screen} @${label}`, sw <= iw + 1, `scrollWidth=${sw} innerWidth=${iw}`);
  }
}

// ---- Seed data through the real UI -----------------------------------------

async function seedData() {
  // Water
  await evaluate(`location.hash = '#/water'`);
  await waitFor(`document.querySelector('[data-action="water-add"]') !== null`, 8000, 'water screen');
  await click('[data-action="water-add"][data-amount="500"]');
  await sleep(500);

  // Daily goal + complete it
  await evaluate(`location.hash = '#/goals'`);
  await waitFor(`document.querySelector('[data-action="add-goal"]') !== null`, 8000, 'goals screen');
  await click('[data-action="add-goal"]');
  await waitFor(`document.querySelector('.sheet') !== null`, 8000, 'goal sheet');
  await evaluate(`
    const s = document.querySelector('.sheet');
    s.querySelectorAll('input')[0].value = 'Drink water all day';
  `);
  await click('.sheet .btn-primary');
  await waitFor(`document.body.innerText.includes('Drink water all day')`, 6000, 'goal created');
  await click('[data-action="goal-toggle"]');
  await waitFor(`document.querySelector('.goal-card.done') !== null`, 4000, 'goal completed');

  // Workout
  await evaluate(`location.hash = '#/gym/new'`);
  await waitFor(`document.querySelector('.sheet') !== null`, 8000, 'workout sheet');
  await evaluate(`
    const inputs = document.querySelectorAll('.sheet .form-grid input');
    inputs[0].value = 'Deadlift';
    inputs[1].value = '3';
    inputs[2].value = '5';
    inputs[3].value = '100';
  `);
  await click('.sheet .btn-primary');
  await waitFor(`document.body.innerText.includes('Deadlift') || document.body.innerText.includes('Today')`, 6000, 'workout saved');
  await evalAsync(`(async () => { const gym = await import('/js/gym.js'); return { n: (await gym.getAllWorkouts()).length }; })()`).then((r) => check('workout stored', r.n >= 1));

  // Photo (real file through the picker)
  await evaluate(`location.hash = '#/photos'`);
  await waitFor(`document.querySelector('[data-action="photo-gallery"]') !== null`, 8000, 'photos screen');
  await click('[data-action="photo-gallery"]');
  await pickFileWith('input[type=file]', TEST_IMAGE);
  await waitFor(`document.querySelector('.sheet') !== null`, 6000, 'photo confirm sheet');
  await sleep(200);
  await click('.sheet .btn-primary');
  await waitFor(`document.querySelectorAll('.photo-tile').length >= 1`, 8000, 'photo tile');

  // Journal (with a unique marker we later assert never reaches the console)
  await evaluate(`location.hash = '#/journal/edit'`);
  await waitFor(`document.getElementById('j-body') !== null`, 8000, 'journal editor');
  await evaluate(`
    document.getElementById('j-title').value = 'Private thoughts';
    document.getElementById('j-body').value = 'SECRET-JOURNAL-MARKER nobody should see this in a console log.';
  `);
  await click('[data-action="save-entry"]');
  await waitFor(`document.body.innerText.includes('Private thoughts')`, 6000, 'journal saved');
}

async function completeOnboarding() {
  await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 10000, 'onboarding');
  await click('.onboarding #ob-next');
  await sleep(250);
  await evaluate(`const el = document.getElementById('ob-name'); el.value = 'QA';`);
  await click('.onboarding #ob-next');
  await sleep(250);
  await click('.onboarding #ob-next');
  await sleep(250);
  await click('.onboarding #ob-next'); // welcome → name
  await sleep(250);
  await click('.onboarding #ob-next'); // name → water
  await sleep(250);
  await click('.onboarding #ob-next'); // water → theme
  await sleep(250);
  await click('.onboarding #ob-next'); // theme → background
  await sleep(250);
  await click('.onboarding #ob-next'); // background → get started
  await waitFor(`document.getElementById('onboarding-root').children.length === 0`, 8000, 'onboarding done');
}

// ---- The test ---------------------------------------------------------------

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-qa-'));
let chrome;

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
  await sleep(1200); // let the profile flush to disk
}

try {
  console.log('Starting server + Chrome…');
  await waitForServer();
  await launchChrome();

  console.log('\n— Seed data through the UI —');
  await completeOnboarding();
  await seedData();

  console.log('\n— Edge-case routes —');
  await evaluate(`location.hash = '#/photos/add'`);
  await waitFor(`document.querySelector('.sheet') !== null`, 6000, 'photos/add sheet');
  check('#/photos/add opens the add sheet (dashboard Photo action)', await evaluate(`document.body.innerText.includes('Take a photo')`));
  await click('.modal-backdrop'); // close via backdrop
  await sleep(300);
  await evaluate(`location.hash = '#/totally/unknown'`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 6000, 'unknown route fallback');
  check('unknown route falls back to dashboard without crashing', true);

  console.log('\n— Daily goal semantics (per-day completion) —');
  const goalSemantics = await evalAsync(`
    (async () => {
      const g = await import('/js/goals.js');
      const u = await import('/js/utils.js');
      const goals = await g.getAllGoals();
      const daily = goals.find((x) => x.type === 'daily');
      if (!daily) return { found: false };
      const today = u.todayKey();
      const tomorrow = u.addDays(today, 1);
      return {
        found: true,
        historyHasToday: (daily.completedDays || []).includes(today),
        pendingTomorrow: g.isCompletedOn(daily, tomorrow) === false,
      };
    })()
  `);
  check('daily goal stores per-day completion', goalSemantics.found && goalSemantics.historyHasToday);
  check('daily goal reads pending for tomorrow (reset semantics)', goalSemantics.pendingTomorrow);

  console.log('\n— PWA assets —');
  const pwa = await evalAsync(`
    (async () => {
      const [manifestRes, iconRes] = await Promise.all([
        fetch('/manifest.webmanifest'),
        fetch('/icons/icon-192.png'),
      ]);
      const manifest = await manifestRes.json();
      const swRegistered = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
      const cacheNames = await caches.keys();
      return {
        manifestOk: manifestRes.ok && !!manifest.icons && manifest.icons.length >= 2,
        iconOk: iconRes.ok && (iconRes.headers.get('content-type') || '').includes('png'),
        swRegistered,
        caches: cacheNames,
      };
    })()
  `);
  check('manifest valid with 2+ icons', pwa.manifestOk);
  check('icon-192.png served as PNG', pwa.iconOk);
  check('service worker registered and controlling the page', pwa.swRegistered);
  check('offline cache created', Array.isArray(pwa.caches) && pwa.caches.length > 0, pwa.caches?.join(','));

  console.log('\n— Mobile overflow (360px & 320px) —');
  await setViewport(360, 740);
  await checkOverflow('360px');
  await setViewport(320, 640);
  await checkOverflow('320px');
  // Long-content stress: long goal title + long journal word + long workout name
  await setViewport(360, 740);
  await evaluate(`
    (async () => {
      const g = await import('/js/goals.js');
      await g.addGoal({ title: 'X'.repeat(140), type: 'daily' });
      const j = await import('/js/journal.js');
      await j.saveEntry({ title: 'Long', content: 'Supercalifragilisticexpialidocious'.repeat(8) });
      const gym = await import('/js/gym.js');
      await gym.addWorkout({ date: new Date().toISOString().slice(0,10), workoutType: 'Strength', duration: 30, exercises: [{ exerciseName: 'Y'.repeat(90), sets: 1, reps: 1, weight: 0 }] });
    })()
  `);
  await checkOverflow('360px-long-content');
  await evaluate(`
    (async () => {
      const g = await import('/js/goals.js');
      const goals = await g.getAllGoals();
      const long = goals.find((x) => x.title.length > 100);
      if (long) await g.deleteGoal(long.id);
      const j = await import('/js/journal.js');
      const entries = await j.getAllEntries();
      const longEntry = entries.find((e) => e.content.length > 300);
      if (longEntry) await j.deleteEntry(longEntry.id);
    })()
  `);

  console.log('\n— Export → wipe → import (photos included) —');
  // Export using the same serialization path Settings uses.
  const exportJson = await evalAsync(`
    (async () => {
      const db = await import('/js/db.js');
      const ph = await import('/js/photos.js');
      const dump = await db.dbExportAll(async (record) => ({
        ...record,
        blob: await ph.blobToDataURL(record.blob),
        thumb: await ph.blobToDataURL(record.thumb),
      }));
      return JSON.stringify(dump);
    })()
  `);
  const dump = JSON.parse(exportJson);
  const exportedPhoto = (dump.data.progressPhotos || [])[0];
  check('export contains photo as data URL', Boolean(exportedPhoto?.blob?.startsWith('data:image')), `blob len=${exportedPhoto?.blob?.length || 0}`);
  check('export contains water/goals/workouts/journal', ['waterEntries', 'goals', 'workouts', 'journalEntries'].every((k) => (dump.data[k] || []).length > 0));

  const tmpDir = mkdtempSync(join(tmpdir(), 'life-progress-export-'));
  const exportPath = join(tmpDir, 'backup.json');
  writeFileSync(exportPath, exportJson);

  // Wipe through the real UI.
  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="clear-data"]') !== null`, 6000, 'settings');
  await click('[data-action="clear-data"]');
  await waitFor(`document.querySelector('.dialog') !== null`, 6000, 'wipe dialog');
  await click('.dialog .btn-danger');
  await waitFor(`document.body.innerText.includes('All data cleared')`, 6000, 'wipe toast');

  // Reload: onboarding must reappear (full wipe confirmed).
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 10000, 'onboarding after wipe');
  check('wipe resets onboarding state', await evaluate(`document.querySelector('.onboarding') !== null`));
  await completeOnboarding();

  // Import through the real file picker.
  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="import-data"]') !== null`, 6000, 'settings for import');
  await click('[data-action="import-data"]');
  await pickFileWith('input[type=file][accept*="json"]', exportPath);
  await waitFor(`document.querySelector('.dialog') !== null`, 8000, 'import confirm dialog');
  await click('.dialog .btn-danger');
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard after import');

  const importVerify = await evalAsync(`
    (async () => {
      const water = await import('/js/water.js');
      const entries = await water.getAllEntries();
      return { waterCount: entries.length };
    })()
  `);
  check('import restores water entries', importVerify.waterCount >= 1, `count=${importVerify.waterCount}`);
  await evaluate(`location.hash = '#/photos'`);
  await waitFor(`document.querySelectorAll('.photo-tile').length >= 1`, 8000, 'photo tile after import');
  const photoRestored = await evalAsync(`
    (async () => {
      const img = document.querySelector('.photo-tile img');
      if (!img) return { ok: false };
      await new Promise((r) => { if (img.complete) r(); else { img.onload = r; img.onerror = r; } });
      return { ok: img.naturalWidth > 0, w: img.naturalWidth };
    })()
  `);
  check('imported photo blob renders (naturalWidth > 0)', photoRestored.ok, `w=${photoRestored.w}`);
  await evaluate(`location.hash = '#/journal'`);
  await waitFor(`document.body.innerText.includes('Private thoughts')`, 6000, 'journal after import');
  check('import restores journal entries', true);

  console.log('\n— Persistence across full app restart —');
  await killChrome();
  await launchChrome();
  await sleep(1500);
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard after restart');
  // The dashboard summarizes (workout TYPE, journal status) — it never lists
  // exercise names or entry titles, so wait for a summary string instead.
  await waitFor(`document.body.innerText.includes('Strength')`, 6000, 'restart data');
  const restartCheck = await evalAsync(`
    (async () => {
      const water = await import('/js/water.js');
      const goals = await import('/js/goals.js');
      const gym = await import('/js/gym.js');
      const journal = await import('/js/journal.js');
      const photos = await import('/js/photos.js');
      const [w, g, wo, j, p] = await Promise.all([
        water.getAllEntries(), goals.getAllGoals(), gym.getAllWorkouts(), journal.getAllEntries(), photos.getAllPhotos(),
      ]);
      return { water: w.length, goals: g.length, workouts: wo.length, journal: j.length, photos: p.length };
    })()
  `);
  check('water entries survive restart', restartCheck.water >= 1, JSON.stringify(restartCheck));
  check('goals survive restart', restartCheck.goals >= 1);
  check('workouts survive restart', restartCheck.workouts >= 1);
  check('journal survives restart', restartCheck.journal >= 1);
  check('photos survive restart', restartCheck.photos >= 1);
  // Photo blob still decodes after the restart.
  await evaluate(`location.hash = '#/photos'`);
  await waitFor(`document.querySelectorAll('.photo-tile').length >= 1`, 8000, 'photo tile after restart');
  const photoAfterRestart = await evalAsync(`
    (async () => {
      const img = document.querySelector('.photo-tile img');
      if (!img) return { ok: false };
      await new Promise((r) => { if (img.complete) r(); else { img.onload = r; img.onerror = r; } });
      return { ok: img.naturalWidth > 0, w: img.naturalWidth };
    })()
  `);
  check('photo blob decodes after restart', photoAfterRestart.ok, `w=${photoAfterRestart.w}`);

  console.log('\n— Offline mode (server down, service worker active) —');
  // Land on the dashboard first so the post-reload wait below is meaningful
  // (the journal screen has no hero).
  await evaluate(`location.hash = '#/dashboard'`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 8000, 'dashboard before offline reload');
  // Kill the static server: a genuine full-offline scenario (no fetch can
  // succeed). The SW cache-first handler must serve the whole shell.
  server.kill('SIGKILL');
  await send('Page.reload');
  await sleep(2500);
  const offlineLoaded = await waitFor(`document.querySelector('#dash-hero') !== null`, 15000, 'offline reload');
  check('app reloads with the network down (service worker shell)', offlineLoaded);
  if (offlineLoaded) {
    // Navigate all core pages offline.
    let allNav = true;
    for (const screen of SCREENS) {
      await evaluate(`location.hash = '#/${screen}'`);
      const ok = await waitFor(`document.querySelector('.screen-root')?.children.length > 0`, 6000, `offline nav ${screen}`);
      if (!ok) allNav = false;
    }
    check('all core screens open offline', allNav);
    // Add data offline.
    await evaluate(`location.hash = '#/water'`);
    await waitFor(`document.querySelector('[data-action="water-add"]') !== null`, 6000, 'offline water');
    await click('[data-action="water-add"][data-amount="250"]');
    await sleep(600);
    const offlineWater = await evaluate(`document.getElementById('water-total')?.textContent`);
    check('water can be added offline', /\d/.test(offlineWater || ''), offlineWater);
    await evaluate(`location.hash = '#/journal/edit'`);
    await waitFor(`document.getElementById('j-body') !== null`, 6000, 'offline editor');
    await evaluate(`
      document.getElementById('j-title').value = 'Offline entry';
      document.getElementById('j-body').value = 'Written with no network at all.';
    `);
    await click('[data-action="save-entry"]');
    const offlineJournal = await waitFor(`document.body.innerText.includes('Offline entry')`, 6000, 'offline journal saved');
    check('journal entry can be saved offline', offlineJournal);
    await evaluate(`location.hash = '#/goals'`);
    await waitFor(`document.querySelector('[data-action="add-goal"]') !== null`, 6000, 'offline goals');
    await click('[data-action="add-goal"]');
    await waitFor(`document.querySelector('.sheet') !== null`, 6000, 'offline goal sheet');
    await evaluate(`document.querySelector('.sheet input').value = 'Offline goal';`);
    await click('.sheet .btn-primary');
    const offlineGoal = await waitFor(`document.body.innerText.includes('Offline goal')`, 6000, 'offline goal saved');
    check('goal can be created offline', offlineGoal);
  }
  // Bring the server back for any later checks.
  const serverBack = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(500);

  console.log('\n— Privacy: no journal content in console output —');
  const leaked = allConsoleText.some((t) => t.includes('SECRET-JOURNAL-MARKER') || t.includes('nobody should see this'));
  check('journal content never appears in console logs', !leaked);

  console.log('\n— Console errors —');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('service worker') && !e.includes('favicon') && !e.includes('DOMException') && !e.includes('net::')
  );
  check('no unhandled JS errors during the whole QA run', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  console.error('QA EXTENDED CRASHED:', err.message);
  failures += 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome) chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { serverBack?.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? '✓ ALL EXTENDED QA CHECKS PASSED' : `✗ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
