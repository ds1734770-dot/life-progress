/**
 * V1.4 QA — Gym templates + set-based workout sessions.
 *
 * Real-browser (CDP) verification of the redesigned Gym experience:
 *   1. Gym home renders the template-first hierarchy + honest empty state
 *   2. Create template flow (name → focus → exercises from the library)
 *   3. Template detail (exercises, last workout, management actions)
 *   4. Start session → pre-fill from last workout (history respected)
 *   5. Set-based logging: steppers, tap-to-complete, add/remove set,
 *      add/remove exercise for TODAY only
 *   6. Reload resume: unfinished session survives (active record)
 *   7. Complete → historical workout + summary + PR + streak intact
 *   8. Template deletion never removes history
 *   9. Export contains the new stores; wipe clears them; import restores
 *  10. Overflow-free at 320–1024px, light theme, reduced motion, zero errors
 *
 * Run: node scripts/qa-gym.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8097;
const DEBUG_PORT = 9230;
const APP_URL = `http://localhost:${PORT}/`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

// ---- CDP client -------------------------------------------------------------
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

/**
 * Evaluate with promise support + JSON object returns. The seq/box handshake
 * (per-call key) is required in this CDP setup: plain evaluate drops object
 * results, and awaitPromise alone is unreliable for nested microtasks.
 */
let qaSeq = 0;
async function evaluate(expression) {
  const seq = ++qaSeq;
  const boxKey = `__qaBox${seq}`;
  const wrapped = `
    (async () => {
      try {
        const __v = await (${expression});
        window['${boxKey}'] = JSON.stringify(__v == null ? null : __v);
      } catch (err) {
        window['${boxKey}'] = JSON.stringify('ERR: ' + String(err && err.message || err));
      }
    })()
  `;
  const res = await send('Runtime.evaluate', { expression: wrapped, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  for (let i = 0; i < 100; i++) {
    const check = await send('Runtime.evaluate', { expression: `window['${boxKey}']`, returnByValue: true });
    const v = check.result?.value;
    if (v !== undefined) {
      if (typeof v === 'string' && v.startsWith('ERR: ')) throw new Error(v.slice(5));
      // ALWAYS parse: a raw page-side 'false' string is truthy in Node and
      // would make every boolean check vacuously pass.
      return JSON.parse(v);
    }
    await sleep(25);
  }
  throw new Error('evaluate timed out: ' + expression.slice(0, 70));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(expression, timeout = 8000, label = expression.slice(0, 60)) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(expression)) return true;
    } catch { /* page may be mid-navigation */ }
    await sleep(120);
  }
  console.log(`WARN  timed out waiting for: ${label}`);
  return false;
}

async function click(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
}

// Real input device events (§23): typing and tapping as a user does, not
// synthetic .value= assignments.
const KEYCODES = { '0': 48, '1': 49, '2': 50, '3': 51, '4': 52, '5': 53, '6': 54, '7': 55, '8': 56, '9': 57, '.': 190 };
async function typeText(text) {
  for (const ch of String(text)) {
    const vk = KEYCODES[ch] || 0;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: vk });
  }
}
async function pressTab() {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', windowsVirtualKeyCode: 9 });
}
/** Real mouse tap at the center of an element matched by a page expression. */
async function tapElement(pageExpr) {
  const box = await evaluate(`(() => { const el = (${pageExpr}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
  if (!box) throw new Error('tapElement: element not found');
  const { x, y } = JSON.parse(box);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** One-line state dump. */
async function dumpState(label) {
  const s = await evaluate(`
    (async () => {
      const gym = await import('/js/gym.js');
      const gt = await import('/js/gymTemplates.js');
      const workouts = await gym.getAllWorkouts();
      const templates = await gt.getTemplates();
      const active = await gt.getActiveWorkout();
      const screenName = document.querySelector('.gym-exercise') ? 'session'
        : document.querySelector('.gym-summary') ? 'summary'
        : document.getElementById('tpl-name') ? 'editor'
        : document.querySelector('.gym-template-card') ? 'home' : 'other';
      return 'hash=' + location.hash + ' | workouts=' + workouts.length
        + ' | templates=' + templates.length
        + ' | active=' + (active ? active.exercises.length + 'ex' : 'none')
        + ' | screen=' + screenName
        + ' | rootKids=' + document.getElementById('screen-root').children.length
        + ' | body=' + JSON.stringify(document.body.innerText.replace(/\\s+/g, ' ').slice(0, 100));
    })()
  `);
  console.log(`  [state] ${label}: ${s}`);
}

// ---- Boot -------------------------------------------------------------------

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((resolve) => {
  const t = () => http.get(`http://localhost:${PORT}/index.html`, (r) => { r.resume(); resolve(); }).on('error', () => setTimeout(t, 200));
  t();
});
// A leftover Chrome from a crashed run would own the debug port and serve
// stale state — fail loudly instead of reporting contradictions.
try {
  await fetch(`http://localhost:${DEBUG_PORT}/json/version`);
  console.error(`FATAL  debug port ${DEBUG_PORT} already in use — kill stale Chrome and re-run.`);
  process.exit(2);
} catch { /* free — good */ }
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-qa-gym-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profileDir}`, '--window-size=412,900', APP_URL], { stdio: 'ignore' });

try {
  let target;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${DEBUG_PORT}/json/list`);
      const targets = await res.json();
      const pages = targets.filter((t) => t.type === 'page');
      if (pages.length > 1) console.log(`WARN  ${pages.length} page targets: ${pages.map((p) => p.url.slice(0, 40)).join(' | ')}`);
      target = pages.find((t) => t.url.startsWith(APP_URL));
      if (target) break;
    } catch {}
    await sleep(200);
  }
  if (!target) throw new Error('app page target not found');
  console.log(`  [cdp] connected to: ${target.url} (${target.id.slice(0, 8)})`);
  await connect(target.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  // Make the page treat itself as focused so synthetic mouse events transfer
  // focus like real user input (headless windows are otherwise unfocused and
  // mousedown-focus silently no-ops).
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true });

  // ---- Onboarding fast-forward (smoke-test pattern: wait for mounts) -------
  await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 15000, 'onboarding mounts');
  await click('.onboarding #ob-next'); // welcome → name
  await sleep(300);
  await evaluate(`(() => { const el = document.getElementById('ob-name'); el.value = 'Alex'; el.dispatchEvent(new Event('input')); })()`);
  await click('.onboarding #ob-next'); // name → water
  await sleep(300);
  await click('.onboarding #ob-next'); // water → theme
  await sleep(300);
  await click('.onboarding #ob-next'); // theme → background
  await sleep(300);
  await click('.onboarding #ob-next'); // get started
  await waitFor(`document.getElementById('onboarding-root').children.length === 0`, 8000, 'onboarding closed');
  await waitFor(`!!document.querySelector('.stat-value')`, 8000, 'dashboard after onboarding');

  // ---- Seed one historical workout (real domain module) --------------------
  await evaluate(`
    (async () => {
      const gym = await import('/js/gym.js');
      await gym.addWorkout({
        date: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10),
        workoutType: 'Strength',
        duration: 42,
        exercises: [
          { exerciseName: 'Bench Press', sets: 3, reps: 8, weight: 60 },
          { exerciseName: 'Lateral Raise', sets: 3, reps: 12, weight: 8 },
        ],
      });
      return true;
    })()
  `);

  // ---- 1. Gym home: empty template state ----------------------------------
  await evaluate(`location.hash = '#/gym'`);
  await sleep(900);
  check('gym home renders', await evaluate(`document.body.innerText.includes('My workouts')`));
  check('template empty state is motivating', await evaluate(`document.body.innerText.includes('gym journey starts here')`));
  check('start empty workout present', await evaluate(`!!document.querySelector('[data-action="start-empty"]')`));
  check('existing workout shown in recent list', await evaluate(`document.body.innerText.includes('Strength')`));

  // ---- 2. Create template flow --------------------------------------------
  await click('[data-action="create-template"]');
  await waitFor(`!!document.getElementById('tpl-name')`, 6000, 'create screen');
  check('create screen opens', await evaluate(`!!document.getElementById('tpl-name')`));
  await evaluate(`(() => { const n = document.getElementById('tpl-name'); n.value = 'Push Day A'; n.dispatchEvent(new Event('input')); })()`);
  await evaluate(`(() => { const f = document.getElementById('tpl-focus'); f.value = 'Chest'; f.dispatchEvent(new Event('change')); })()`);
  await click('[data-action="add-exercise"]');
  await waitFor(`!!document.querySelector('.sheet input[type=search]')`, 6000, 'picker');
  check('exercise picker opens with search', await evaluate(`!!document.querySelector('.sheet input[type=search]')`));
  check('suggested exercises listed', await evaluate(`document.querySelectorAll('.sheet .gym-pick-item').length > 3`));
  await evaluate(`(() => { const s = document.querySelector('.sheet input[type=search]'); s.value = 'Bench'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  await evaluate(`(() => { const i = [...document.querySelectorAll('.sheet .gym-pick-item')].find((b) => b.textContent.includes('Bench Press')); if (i) i.click(); })()`);
  await waitFor(`!!document.getElementById('tpl-name')`, 5000, 'back to editor');
  await click('[data-action="add-exercise"]');
  await waitFor(`!!document.querySelector('.sheet input[type=search]')`, 6000, 'picker 2');
  await evaluate(`(() => { const s = document.querySelector('.sheet input[type=search]'); s.value = 'Shoulder'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  await evaluate(`(() => { const i = [...document.querySelectorAll('.sheet .gym-pick-item')].find((b) => b.textContent.includes('Shoulder Press')); if (i) i.click(); })()`);
  await waitFor(`!!document.getElementById('tpl-name')`, 5000, 'back to editor 2');
  check('second exercise added (count=2)', await evaluate(`document.getElementById('tpl-count')?.textContent === '2'`));
  await click('[data-action="save"]');
  await waitFor(`!!document.querySelector('[data-action="start"]')`, 6000, 'detail after save');
  check('template detail opens after save', await evaluate(`document.body.innerText.includes('Push Day A') && !!document.querySelector('[data-action="start"]')`));
  check('template shows 2 exercises', await evaluate(`document.body.innerText.includes('2 exercises')`));
  check('detail shows last-workout summary', await evaluate(`document.body.innerText.includes('Last workout')`));

  // ---- 3. Rename + duplicate ----------------------------------------------
  await click('[data-action="rename"]');
  await waitFor(`!!document.querySelector('.sheet input')`, 5000, 'rename sheet');
  await evaluate(`(() => { const i = document.querySelector('.sheet input'); i.value = 'Push Day X'; i.dispatchEvent(new Event('input')); })()`);
  await click('.sheet .btn-primary');
  await waitFor(`document.body.innerText.includes('Push Day X')`, 6000, 'rename applied');
  check('rename applies', await evaluate(`document.body.innerText.includes('Push Day X')`));
  await click('[data-action="duplicate"]');
  await waitFor(`document.body.innerText.includes('Push Day X (copy)')`, 6000, 'duplicate');
  check('duplicate creates a copy', await evaluate(`document.body.innerText.includes('Push Day X (copy)')`));

  // ---- 4. Start session → pre-fill from last workout -----------------------
  await evaluate(`location.hash = '#/gym'`);
  await sleep(900);
  check('gym home lists templates', await evaluate(`document.body.innerText.includes('Push Day X')`));
  check('template card shows Start', await evaluate(`document.body.innerText.includes('Start')`));
  await evaluate(`(() => { const c = [...document.querySelectorAll('.gym-template-card')].find((n) => n.textContent.includes('Push Day X')); if (c) c.click(); })()`);
  await waitFor(`!!document.querySelector('[data-action="start"]')`, 6000, 'detail');
  check('template card opens detail', await evaluate(`!!document.querySelector('[data-action="start"]')`));
  await click('[data-action="start"]');
  await waitFor(`document.querySelectorAll('.gym-exercise').length >= 2`, 8000, 'session mounts');
  check('session screen mounts with exercise blocks', await evaluate(`document.querySelectorAll('.gym-exercise').length >= 2`));
  check('PRE-FILL: bench weight 60 from history', await evaluate(`(() => { const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'))?.querySelector('.gym-set-row'); return row?.querySelector('[aria-label^="Weight"]')?.value === '60'; })()`));
  check('PRE-FILL: bench reps 8', await evaluate(`(() => { const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'))?.querySelector('.gym-set-row'); return row?.querySelector('[aria-label^="Reps"]')?.value === '8'; })()`));
  check('PRE-FILL: 3 bench sets', await evaluate(`[...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'))?.querySelectorAll('.gym-set-row').length === 3`));
  check('LAST TIME line shown', await evaluate(`document.body.innerText.includes('Last time')`));

  // ---- 5. Set-based logging ------------------------------------------------
  // Change today's weight; history must stay untouched.
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press')).querySelector('.gym-set-row');
    const w = row.querySelector('[aria-label^="Weight"]');
    w.value = '62.5';
    w.dispatchEvent(new Event('change'));
  })()`);
  await sleep(300);
  check('changed weight stays session-specific (history untouched)', await evaluate(`
    (async () => {
      const gym = await import('/js/gym.js');
      const all = await gym.getAllWorkouts();
      const old = all.find((w) => w.exercises.some((e) => e.exerciseName === 'Bench Press'));
      return old.exercises[0].weight === 60 && old.date !== new Date().toISOString().slice(0, 10);
    })()
  `));
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press')).querySelector('.gym-set-row');
    row.querySelector('[data-dir="1"]').click();
  })()`);
  await sleep(300);
  check('weight stepper +: 62.5 → 65', await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press')).querySelector('.gym-set-row');
    return row.querySelector('[aria-label^="Weight"]').value === '65';
  })()`));
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press')).querySelectorAll('.gym-set-row');
    rows[0].querySelector('.gym-set-toggle').click();
    rows[1].querySelector('.gym-set-toggle').click();
  })()`);
  await sleep(400);
  check('set completion marks rows done', await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press')).querySelectorAll('.gym-set-row');
    return rows[0].classList.contains('done') && rows[1].classList.contains('done') && !rows[2].classList.contains('done');
  })()`));
  check('set toggle aria-pressed communicates state', await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press')).querySelector('.gym-set-row');
    return row.querySelector('.gym-set-toggle').getAttribute('aria-pressed') === 'true' && row.querySelector('.gym-set-toggle').getAttribute('aria-label').includes('completed');
  })()`));
  await evaluate(`(() => { [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press')).querySelector('[data-role="add-set"]').click(); })()`);
  await sleep(300);
  check('add set makes 4', await evaluate(`[...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'))?.querySelectorAll('.gym-set-row').length === 4`));
  await evaluate(`(() => {
    const ex = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'));
    ex.querySelector('[data-role="skip"]').click();
  })()`);
  await sleep(400);
  await evaluate(`(() => { const d = [...document.querySelectorAll('.dialog .btn-ghost')].find((b) => b.textContent === 'Cancel'); d?.click(); })()`);
  await sleep(300);
  check('skip requires confirmation (cancel keeps exercise)', await evaluate(`!![...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'))`));
  await click('[data-action="add-exercise"]');
  await waitFor(`!!document.querySelector('.sheet input[type=search]')`, 6000, 'mid-session picker');
  await evaluate(`(() => { const s = document.querySelector('.sheet input[type=search]'); s.value = 'Lateral'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(300);
  await evaluate(`(() => { const i = [...document.querySelectorAll('.sheet .gym-pick-item')].find((b) => b.textContent.includes('Lateral Raise')); if (i) i.click(); })()`);
  await waitFor(`!![...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'))`, 5000, 'added exercise');
  check('add exercise mid-session (Lateral Raise present)', await evaluate(`!![...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'))`));
  check('mid-session exercise pre-filled from history (8 kg)', await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'))?.querySelector('.gym-set-row');
    return row?.querySelector('[aria-label^="Weight"]')?.value === '8';
  })()`));

  // ---- 5b. Direct typed input (V1.4.1 §2–§4) -------------------------------
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise')).querySelector('.gym-set-row');
    const w = row.querySelector('[aria-label^="Weight"]');
    w.value = '7.5';
    w.dispatchEvent(new Event('change'));
  })()`);
  await sleep(400);
  check('typed decimal weight persists to the session (7.5)', await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      const s = await gt.getActiveWorkout();
      const ex = s.exercises.find((e) => e.exerciseName === 'Lateral Raise');
      return ex?.sets[0].weight === 7.5;
    })()
  `));
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise')).querySelector('.gym-set-row');
    const r = row.querySelector('[aria-label^="Reps"]');
    r.value = '';
    r.dispatchEvent(new Event('change'));
  })()`);
  await sleep(400);
  check('clearing the reps input is safe (persists 0, no crash)', await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      const s = await gt.getActiveWorkout();
      return s.exercises.find((e) => e.exerciseName === 'Lateral Raise')?.sets[0].reps === 0;
    })()
  `));

  // ---- 5c. Set deletion (V1.4.1 §7–§9) --------------------------------------
  await evaluate(`(() => {
    const ex = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'));
    ex.querySelector('[data-role="add-set"]').click();
  })()`);
  await sleep(400);
  await evaluate(`(() => {
    const ex = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'));
    ex.querySelectorAll('.gym-set-remove')[0].click();
  })()`);
  await waitFor(`!!document.querySelector('.dialog')`, 5000, 'remove-set dialog');
  check('set removal asks for confirmation', await evaluate(`!!document.querySelector('.dialog')`));
  console.log('  [remove-dialog]', await evaluate(`JSON.stringify({ title: document.querySelector('.dialog div')?.textContent, buttons: [...document.querySelectorAll('.dialog button')].map((b) => b.textContent) })`));
  await evaluate(`(() => { [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.includes('Remove set'))?.click(); })()`);
  await sleep(500);
  console.log('  [after-confirm]', await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      const s = await gt.getActiveWorkout();
      return JSON.stringify({ dialog: !!document.querySelector('.dialog'), sets: s.exercises.map((e) => e.exerciseName + ':' + e.sets.length) });
    })()
  `));
  // Lateral Raise pre-fills 3 sets from history; add-set → 4, remove → 3.
  check('set deleted (4 → 3 rows)', await evaluate(`
    [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'))?.querySelectorAll('.gym-set-row').length === 3
  `));
  check('renumbering: first row reads Set 1', await evaluate(`
    [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'))?.querySelector('.gym-set-label')?.textContent === 'Set 1'
  `));
  // Min-1 rule: remove down to a single set — Remove must disable there.
  for (let i = 0; i < 3; i++) {
    const gone = await evaluate(`(() => {
      const ex = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'));
      const btn = ex?.querySelector('.gym-set-remove:not([disabled])');
      if (!btn) return 'none-left';
      btn.click();
      return 'clicked';
    })()`);
    if (gone !== 'clicked') break;
    await waitFor(`!!document.querySelector('.dialog')`, 5000, 'remove dialog');
    await evaluate(`(() => { [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.includes('Remove set'))?.click(); })()`);
    await sleep(600);
  }
  check('removing down to one set leaves exactly 1 (min-1 rule)', await evaluate(`
    [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'))?.querySelectorAll('.gym-set-row').length === 1
  `));
  check('single set disables Remove (min-1 rule)', await evaluate(`
    [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Lateral Raise'))?.querySelector('.gym-set-remove')?.disabled === true
  `));

  // ---- 5d. Create New Exercise (V1.4.1 §11–§18) -----------------------------
  await click('[data-action="add-exercise"]');
  await waitFor(`!!document.querySelector('.sheet input[type=search]')`, 6000, 'picker for create');
  check('picker offers Create New Exercise', await evaluate(`
    [...document.querySelectorAll('.sheet button')].some((b) => b.textContent.includes('Create New Exercise'))
  `));
  await evaluate(`(() => { [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.includes('Create New Exercise'))?.click(); })()`);
  await waitFor(`!!document.querySelector('.sheet input[aria-label="Exercise name"]')`, 5000, 'create sheet');
  check('create exercise sheet opens', await evaluate(`!!document.querySelector('.sheet input[aria-label="Exercise name"]')`));
  await evaluate(`(() => { const i = document.querySelector('.sheet input[aria-label="Exercise name"]'); i.value = 'Cable Chest Fly'; i.dispatchEvent(new Event('input')); })()`);
  await evaluate(`(() => { [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.includes('Add Exercise'))?.click(); })()`);
  await waitFor(`!![...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Cable Chest Fly'))`, 6000, 'custom exercise added');
  check('custom exercise lands in the session', await evaluate(`
    !![...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Cable Chest Fly'))
  `));
  check('custom exercise saved to the library store', await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      const lib = await gt.getLibrary();
      return lib.some((e) => e.name === 'Cable Chest Fly');
    })()
  `));
  // Duplicate detection: creating the same name again must not duplicate.
  await click('[data-action="add-exercise"]');
  await waitFor(`!!document.querySelector('.sheet input[type=search]')`, 6000, 'picker for dup');
  await evaluate(`(() => { [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.includes('Create New Exercise'))?.click(); })()`);
  await waitFor(`!!document.querySelector('.sheet input[aria-label="Exercise name"]')`, 5000, 'create sheet 2');
  await evaluate(`(() => { const i = document.querySelector('.sheet input[aria-label="Exercise name"]'); i.value = 'cable chest fly'; i.dispatchEvent(new Event('input')); })()`);
  await evaluate(`(() => { [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.includes('Add Exercise'))?.click(); })()`);
  await sleep(800);
  check('duplicate (case-insensitive) is rejected, library stays single', await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      const lib = await gt.getLibrary();
      return lib.filter((e) => e.name.toLowerCase() === 'cable chest fly').length === 1;
    })()
  `));
  check('adding an exercise already in the session does not duplicate it', await evaluate(`
    [...document.querySelectorAll('.gym-exercise')].filter((n) => n.textContent.includes('Cable Chest Fly')).length === 1
  `));
  await evaluate(`(() => { document.querySelector('.sheet [data-sheet-close]')?.click(); true })()`);
  await sleep(400);

  // ---- 5e. Real input interaction + layout contract (§1–§13, §23) ----------
  // The kg/reps controls are REAL inputs: tap → type via actual key events →
  // value reaches the DOM and the session state, focus never lost mid-edit.
  const benchCard = `[...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'))`;
  /** Page expression selecting a node inside bench's first set row. */
  const benchField = (sel) => `(${benchCard}).querySelector('.gym-set-row').querySelector('${sel}')`;
  // Layout contract first (§2, §14–§18): at scroll-top the footer must be
  // below the fold (in flow, not floating over content); after scrolling to
  // the bottom it must not intersect the fixed dock (viewport-space rects).
  check('no SETKGREPS/debug text anywhere in the UI', await evaluate(
    `!document.body.innerText.replace(/\\s+/g, '').toUpperCase().includes('SETKGREPS')`
  ));
  check('exactly one Complete workout button (plus header Finish)', await evaluate(
    `[...document.querySelectorAll('[data-action="finish"]')].filter((b) => b.textContent.includes('Complete workout')).length === 1`
  ));
  const layout = JSON.parse(await evaluate(`
    (() => {
      const f = document.querySelector('.gym-sticky-actions').getBoundingClientRect();
      const doc = document.documentElement;
      return JSON.stringify({ fTop: f.top, fHeight: f.height, docH: doc.scrollHeight });
    })()
  `));
  check('Complete workout sits in normal flow at the page bottom (not floating over content)',
    layout.fTop > layout.docH - 300 && layout.fHeight < 130, JSON.stringify(layout));
  await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(400);
  const overlap = JSON.parse(await evaluate(`
    (() => {
      const f = document.querySelector('.gym-sticky-actions').getBoundingClientRect();
      const dock = document.querySelector('#tabbar')?.getBoundingClientRect();
      if (!dock) return JSON.stringify({ ok: true });
      return JSON.stringify({ fBottom: f.bottom, dockTop: dock.top });
    })()
  `));
  check('scrolled to bottom: Complete workout does not collide with the bottom dock',
    overlap.ok === true || overlap.fBottom <= overlap.dockTop + 4, JSON.stringify(overlap));

  // Real tap on the weight input, then real keystrokes: 62.5 (§4, §6).
  // The layout checks scrolled the page — bring the bench card back on screen
  // first, or the synthesized tap would land on off-screen coordinates.
  await evaluate(`(${benchCard}).scrollIntoView({ block: 'center' })`);
  await sleep(300);
  // Bench set 1 may already be marked done from the completion section —
  // unmark it so the §12 check below is strict.
  if (await evaluate(`${benchField('.gym-set-toggle')}.getAttribute('aria-pressed') === 'true'`)) {
    await evaluate(`(() => { ${benchField('.gym-set-toggle')}.click(); })()`);
    await sleep(300);
  }
  await tapElement(benchField('.gym-stepper[data-kind="weight"] .gym-step-input'));
  await sleep(200);
  // Verify the field is focusable and becomes the active element. A real
  // mouse tap transfers focus on devices; headless Chrome may skip
  // mousedown-focus entirely (window never has focus), so accept either the
  // tap itself or an explicit .focus() landing on the same input — the point
  // is that the input is real, enabled, and not covered by anything.
  let focused = await evaluate(
    `document.activeElement === ${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')}`
  );
  if (!focused) {
    const hit = await evaluate(`(() => {
      const i = ${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')};
      const r = i.getBoundingClientRect();
      const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      i.focus();
      return JSON.stringify({ coveredBy: at === i || i.contains(at) ? null : (at?.className || at?.tagName || null), becameActive: document.activeElement === i, disabled: i.disabled, readOnly: i.readOnly });
    })()`);
    const H = JSON.parse(hit);
    console.log(`WARN  headless tap-focus skipped (env artifact) — hit-test ok=${H.coveredBy === null}, focusable=${H.becameActive}, disabled=${H.disabled}, readOnly=${H.readOnly}`);
    focused = H.coveredBy === null && H.becameActive && !H.disabled && !H.readOnly;
  }
  check('weight field is typeable: nothing covers it, focus lands on it', focused);
  await evaluate(`(() => { const i = ${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')}; i.value = ''; i.focus(); })()`);
  await typeText('62.5');
  await sleep(150);
  check('typed 62.5 lands in the input (focus preserved, no re-render)', await evaluate(
    `(() => { const i = ${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')}; return i.value === '62.5' && document.activeElement === i; })()`
  ));
  // Move to reps the way a user does: tap it, type 10, Tab to commit.
  await tapElement(benchField('.gym-stepper[data-kind="reps"] .gym-step-input'));
  await sleep(150);
  await evaluate(`(() => { const i = ${benchField('.gym-stepper[data-kind="reps"] .gym-step-input')}; i.value = ''; i.focus(); })()`);
  await typeText('10');
  await pressTab();
  await sleep(400);
  check('typed reps 10 commits (Tab → change → session)', await evaluate(
    `(() => { const i = ${benchField('.gym-stepper[data-kind="reps"] .gym-step-input')}; return i.value === '10'; })()`
  ));
  check('weight 62.5 reached the active session', await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      const s = await gt.getActiveWorkout();
      return s.exercises.find((e) => e.exerciseName === 'Bench Press')?.sets[0].weight === 62.5;
    })()
  `));
  check('reps 10 reached the active session', await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      const s = await gt.getActiveWorkout();
      const set = s.exercises.find((e) => e.exerciseName === 'Bench Press')?.sets[0];
      return set?.reps === 10 && set?.weight === 62.5;
    })()
  `));
  check('typing did not complete the set (§12)', await evaluate(
    `${benchField('.gym-set-toggle')}.getAttribute('aria-pressed') === 'false'`
  ));
  // Steppers and typing drive the SAME value (§9): + → 63, − → 62.5.
  await evaluate(`(() => { ${benchField('.gym-stepper[data-kind="weight"] .gym-step-btn[data-dir="1"]')}.click(); })()`);
  await sleep(250);
  check('stepper + after typed 62.5 gives 65 (same value channel, 2.5 kg gym step)', await evaluate(
    `${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')}.value === '65'`
  ));
  await evaluate(`(() => { ${benchField('.gym-stepper[data-kind="weight"] .gym-step-btn[data-dir="-1"]')}.click(); })()`);
  await sleep(250);
  check('stepper − returns to 62.5', await evaluate(
    `${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')}.value === '62.5'`
  ));
  // §13: delete the MIDDLE set — remaining values + numbering survive.
  const rowsSnapshot = () => evaluate(`
    JSON.stringify([...(${benchCard}).querySelectorAll('.gym-set-row')].map((r) => ({
      label: r.querySelector('.gym-set-label').textContent,
      w: r.querySelector('[aria-label^="Weight"]').value,
      reps: r.querySelector('[aria-label^="Reps"]').value,
    })))
  `);
  const before = JSON.parse(await rowsSnapshot());
  await evaluate(`(() => { (${benchCard}).querySelectorAll('.gym-set-remove')[1].click(); })()`);
  await waitFor(`!!document.querySelector('.dialog')`, 5000, 'middle-set remove dialog');
  await evaluate(`(() => { [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.includes('Remove set'))?.click(); })()`);
  await sleep(600);
  const after = JSON.parse(await rowsSnapshot());
  check('middle set removed (one row fewer)', after.length === before.length - 1, JSON.stringify(before) + ' → ' + JSON.stringify(after));
  check('remaining sets keep their values and renumber',
    after[0].w === before[0].w && after[1].label === 'Set 2' &&
    after[1].w === before[2].w && after[1].reps === before[2].reps,
    JSON.stringify(after));
  // Restore bench set 1 to 65 by TYPING again (double-checks re-editing),
  // so the reload/resume expectation below stays meaningful.
  await evaluate(`(() => { const i = ${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')}; i.value = ''; i.focus(); })()`);
  await typeText('65');
  await pressTab();
  await sleep(400);
  check('re-edit by typing: 62.5 → 65', await evaluate(
    `(() => { const i = ${benchField('.gym-stepper[data-kind="weight"] .gym-step-input')}; return i.value === '65'; })()`
  ));

  // ---- 6. Reload resume (§20) ----------------------------------------------
  await dumpState('before reload');
  // CDP Page.reload (location.reload() never resolves under awaitPromise).
  // renderTabbar only runs after the launch ritual ends, so waiting for the
  // tabbar also absorbs the ~4s boot overlay before judging the screen.
  await send('Page.reload');
  await waitFor(`document.querySelector('#tabbar').children.length > 0`, 20000, 'app after reload');
  await waitFor(`!document.querySelector('.onboarding')`, 8000, 'no onboarding after reload');
  await sleep(800); // navigate() mounts the route from the hash
  await dumpState('after reload');
  // The hash may still be #/gym/workout (session re-mounts from the active
  // record) or #/gym (resume banner). Either proves the session survived.
  const onSession = await evaluate(`!!document.querySelector('.gym-exercise')`);
  const hasBanner = await evaluate(`!!document.querySelector('.gym-resume-card') || document.body.innerText.includes('In progress')`);
  check('after reload: session preserved (banner or session screen)', onSession || hasBanner, onSession ? 'session screen' : hasBanner ? 'banner' : 'neither');
  if (hasBanner && !onSession) {
    await click('[data-action="resume-workout"]');
    await sleep(900);
  }
  await waitFor(`document.querySelectorAll('.gym-exercise').length >= 2`, 6000, 'session after resume');
  check('resume returns to the session with data', await evaluate(`document.querySelectorAll('.gym-exercise').length >= 2`));
  check('resume keeps the 65 kg change', await evaluate(`(() => {
    const row = [...document.querySelectorAll('.gym-exercise')].find((n) => n.textContent.includes('Bench Press'))?.querySelector('.gym-set-row');
    return row?.querySelector('[aria-label^="Weight"]')?.value === '65';
  })()`));

  // ---- 7. Complete workout --------------------------------------------------
  for (let pass = 0; pass < 10; pass++) {
    const remaining = await evaluate(`document.querySelectorAll('.gym-set-row .gym-set-toggle:not([aria-pressed="true"])').length`);
    if (!remaining) break;
    await evaluate(`(() => { const b = document.querySelector('.gym-set-row .gym-set-toggle:not([aria-pressed="true"])'); if (b) b.click(); })()`);
    await sleep(300);
  }
  await dumpState('before finish');
  await evaluate(`(() => { const b = [...document.querySelectorAll('[data-action="finish"]')].find((x) => !x.disabled); if (b) b.click(); })()`);
  await waitFor(`document.body.innerText.includes('Workout complete')`, 8000, 'completion summary');
  await sleep(900);
  await dumpState('after finish');
  check('completion summary shown', await evaluate(`document.body.innerText.includes('Workout complete')`));
  check('summary shows duration + sets', await evaluate(`document.body.innerText.includes('Duration') && document.body.innerText.includes('Sets')`));
  check('bench 65×8 flagged as PR (previous best 60×8)', await evaluate(`document.body.innerText.includes('NEW PERSONAL RECORD') && document.body.innerText.includes('65')`));
  await click('.gym-summary [data-action="done"]');
  await waitFor(`document.querySelector('.stat-value') !== null`, 8000, 'gym home after done');
  check('done returns to gym home with completed workout today', await evaluate(`document.body.innerText.includes('Today')`));
  await dumpState('on gym home after done');
  check('historical workout stored with template provenance', await evaluate(`
    (async () => {
      const gym = await import('/js/gym.js');
      const { todayKey } = await import('/js/utils.js');
      const all = await gym.getAllWorkouts();
      const today = all.find((w) => w.date === todayKey());
      return !!today && today.templateName === 'Push Day X' && today.exercises.some((e) => e.exerciseName === 'Bench Press' && e.weight === 65);
    })()
  `));
  check('active record cleared after completion', await evaluate(`(async () => { const gt = await import('/js/gymTemplates.js'); return (await gt.getActiveWorkout()) === null; })()`));
  check('no leftover active state on dashboard gym card', await evaluate(`
    (async () => {
      location.hash = '#/dashboard';
      await new Promise((r) => setTimeout(r, 900));
      return !document.body.innerText.includes('Workout in progress');
    })()
  `));
  check('streak counts the completed session', await evaluate(`
    (async () => {
      const gym = await import('/js/gym.js');
      const all = await gym.getAllWorkouts();
      return gym.gymStats(all).streak >= 1;
    })()
  `));

  // ---- 8. Template delete preserves history ---------------------------------
  await evaluate(`location.hash = '#/gym'`);
  await sleep(800);
  await evaluate(`(() => { [...document.querySelectorAll('.gym-template-card')].find((n) => n.textContent.includes('Push Day X (copy)'))?.click(); })()`);
  await waitFor(`!!document.querySelector('[data-action="delete"]')`, 6000, 'copy detail');
  await click('[data-action="delete"]');
  await waitFor(`!!document.querySelector('.dialog')`, 5000, 'delete dialog');
  // The destructive confirm renders as btn-danger (§ openDialog danger flag).
  await evaluate(`(() => { const d = [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.includes('Delete plan')); d?.click(); })()`);
  await waitFor(`!document.body.innerText.includes('Push Day X (copy)')`, 6000, 'template gone');
  check('template deleted', await evaluate(`!document.body.innerText.includes('Push Day X (copy)')`));
  check('history intact after template delete', await evaluate(`
    (async () => {
      const gym = await import('/js/gym.js');
      return (await gym.getAllWorkouts()).length >= 2;
    })()
  `));

  // ---- 9. Export / wipe / import --------------------------------------------
  const exportPayload = await evaluate(`
    (async () => {
      const { dbExportAll } = await import('/js/db.js');
      const gym = await import('/js/gym.js');
      const gt = await import('/js/gymTemplates.js');
      const dump = await dbExportAll(null);
      const viaDomain = await gym.getAllWorkouts();
      const activeNow = await gt.getActiveWorkout();
      return {
        href: location.href.slice(-20),
        templates: (dump.data.workoutTemplates || []).length,
        library: (dump.data.exerciseLibrary || []).length,
        active: (dump.data.activeWorkout || []).length,
        workouts: (dump.data.workouts || []).length,
        viaDomainCount: viaDomain.length,
        viaDomainDates: viaDomain.map((w) => w.date).join(','),
        activeNow: activeNow ? 'present' : 'cleared',
      };
    })()
  `);
  console.log('  [export]', JSON.stringify(exportPayload));
  check('export includes workoutTemplates', exportPayload.templates >= 1, JSON.stringify(exportPayload));
  check('export includes exerciseLibrary', exportPayload.library >= 3);
  check('export matches live store (completed workouts included)', exportPayload.workouts === exportPayload.viaDomainCount && exportPayload.workouts >= 2, `dump=${exportPayload.workouts} live=${exportPayload.viaDomainCount} dates=${exportPayload.viaDomainDates}`);

  await evaluate(`
    (async () => {
      const { dbClear } = await import('/js/db.js');
      await dbClear('workoutTemplates');
      await dbClear('exerciseLibrary');
      await dbClear('activeWorkout');
      return true;
    })()
  `);
  // go('gym') (not a same-hash set) so the router actually re-renders.
  await evaluate(`(async () => { const r = await import('/js/router.js'); r.go('gym'); })()`);
  await sleep(900);
  check('wipe of new stores clears templates (empty state returns)', await evaluate(`document.body.innerText.includes('gym journey starts here')`));
  check('wipe of new stores keeps workouts', await evaluate(`
    (async () => {
      const gym = await import('/js/gym.js');
      return (await gym.getAllWorkouts()).length >= 2;
    })()
  `));
  await evaluate(`
    (async () => {
      const { dbBulkPut } = await import('/js/db.js');
      const { makeWorkoutTemplate } = await import('/js/models.js');
      await dbBulkPut('workoutTemplates', [makeWorkoutTemplate({ id: 'tpl-import-1', name: 'Imported Plan', exercises: [{ exerciseName: 'Squat', defaultSets: 3 }] })]);
      return true;
    })()
  `);
  await evaluate(`(async () => { const r = await import('/js/router.js'); r.go('gym'); })()`);
  await sleep(900);
  check('import of templates renders on gym home', await evaluate(`document.body.innerText.includes('Imported Plan')`));

  // ---- 10. Responsive + themes + reduced motion ------------------------------
  for (const width of [320, 360, 390, 412, 768, 1024]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: width >= 768 ? 1 : 2, mobile: width < 768 });
    await evaluate(`location.hash = '#/gym'`);
    await sleep(450);
    const sw = await evaluate(`document.documentElement.scrollWidth`);
    const iw = await evaluate(`window.innerWidth`);
    check(`no overflow on gym home @${width}`, sw <= iw + 1, `scrollWidth=${sw} innerWidth=${iw}`);
    await evaluate(`(() => { [...document.querySelectorAll('.gym-template-card')].find((n) => n.textContent.includes('Imported Plan'))?.click(); })()`);
    await sleep(500);
    await click('[data-action="start"]');
    await sleep(800);
    const sw2 = await evaluate(`document.documentElement.scrollWidth`);
    check(`no overflow on session @${width}`, sw2 <= iw + 1, `scrollWidth=${sw2}`);
    await click('[data-action="back"]');
    await sleep(500);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 900, deviceScaleFactor: 2, mobile: true });
  await evaluate(`(async () => { const gt = await import('/js/gymTemplates.js'); await gt.clearActiveWorkout(); location.hash = '#/gym'; })()`);
  await sleep(600);

  await evaluate(`(async () => { const s = await import('/js/settings.js'); await s.saveSettings({ theme: 'light' }); location.hash = '#/gym'; })()`);
  await sleep(900);
  check('light theme applied', await evaluate(`document.documentElement.dataset.theme === 'light'`));
  check('light theme: gym renders without overflow', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
  await evaluate(`(async () => { const s = await import('/js/settings.js'); await s.saveSettings({ theme: 'dark' }); })()`);
  await sleep(400);

  // Reduced motion: completing a set applies no inline animation.
  await evaluate(`
    (async () => {
      const gt = await import('/js/gymTemplates.js');
      let s = gt.buildEmptySession({ templateName: 'RM Check' });
      s = gt.addSessionExercise(s, 'Plank');
      await gt.persistActiveWorkout(s);
      location.hash = '#/gym/workout';
    })()
  `);
  await sleep(1000);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`(() => { document.querySelector('.gym-set-row .gym-set-toggle')?.click(); })()`);
  await sleep(400);
  check('reduced motion: no inline animation applied', await evaluate(`(() => { const r = document.querySelector('.gym-set-row'); return r && !r.style.animation; })()`));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });
  await evaluate(`(async () => { const gt = await import('/js/gymTemplates.js'); await gt.clearActiveWorkout(); location.hash = '#/gym'; })()`);
  await sleep(500);

  check('no unhandled JS errors during the whole gym QA run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} finally {
  chrome.kill();
  server.kill();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? '\n✓ ALL GYM QA CHECKS PASSED' : `\n✗ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
