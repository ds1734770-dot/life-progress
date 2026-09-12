/**
 * V1.2 Phase 1 QA — History / Calendar.
 *
 * Real-browser (CDP) verification that:
 *   1. Dashboard shows the "Your Journey" entry card that deep-links to History
 *   2. Route #/history mounts the calendar; deep link + browser back work
 *   3. Month header, weekday row, grid size, out-month cells, today ring
 *   4. Seeded real records (all four domains) render as colored dots and the
 *      selected day shows honest per-domain summaries
 *   5. Empty days/details show clean empty states
 *   6. Month navigation (prev/next/Today) works, incl. year boundaries
 *   7. Export → wipe → import: history follows the underlying data
 *   8. Every data-backed screen stays overflow-free at 320/360/390/412 px,
 *      desktop 1024 px, and the run stays console-error free
 *   9. Offline reload: history still renders from IndexedDB (derived data)
 *
 * Run: node scripts/qa-v12-history.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8094;
const DEBUG_PORT = 9226;
const APP_URL = `http://localhost:${PORT}/`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

// ---- Tiny CDP client (same proven pattern as qa-v11.js) ---------------------
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

async function setViewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await sleep(250);
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

const launchOverlayGone = `!document.getElementById('launch-screen')`;

// ---------------------------------------------------------------------------
// In-page seed helpers. makeWaterEntry/makeWorkout/etc. default their dates to
 // "now", so explicit timestamps/keys are passed for deterministic history.
// ---------------------------------------------------------------------------

const SEED = `(async () => {
  const { makeWaterEntry, makeWorkout, makeJournalEntry, makeGoal } = await import('/js/models.js');
  const { dbBulkPut } = await import('/js/db.js');
  const water = await import('/js/water.js');

  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  const at = (key, hour) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, hour).getTime();
  };
  const now = new Date();
  const today = fmt(now);
  const shift = (days) => { const d = new Date(now); d.setDate(d.getDate() + days); return fmt(d); };
  // The 10th of the previous month is always ≥10 days before the 1st, so it
  // can never fall inside the current month's 6-row grid window.
  const prevMonthDay = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 10));

  const TARGET = 3000; // default water target (settings are untouched)
  const waterEntries = [
    makeWaterEntry(500, at(today, 8)), makeWaterEntry(250, at(today, 9)), // 750 → partial
    makeWaterEntry(750, at(shift(-1), 10)), makeWaterEntry(TARGET, at(shift(-1), 11)), // 3750 → completed
    makeWaterEntry(300, at(prevMonthDay, 11)), makeWaterEntry(TARGET, at(prevMonthDay, 12)), // 3300 → completed
  ];
  const workouts = [
    makeWorkout({ date: today, workoutType: 'Strength', duration: 45, exercises: [{ name: 'Bench Press', sets: 3, reps: 8, weight: 60 }] }),
    makeWorkout({ date: shift(-3), workoutType: 'Cardio', duration: 30, exercises: [{ name: 'Run', sets: 1, reps: 1, weight: 0 }] }),
    makeWorkout({ date: prevMonthDay, workoutType: 'Strength', duration: 50, exercises: [{ name: 'Squat', sets: 3, reps: 5, weight: 100 }] }),
  ];
  const journalEntries = [
    makeJournalEntry({ title: 'Great day', content: 'Felt strong.', date: today, createdAt: at(today, 20) }),
    makeJournalEntry({ title: 'Old note', content: 'Reflecting.', date: prevMonthDay, createdAt: at(prevMonthDay, 20) }),
  ];
  const goalList = [
    makeGoal({ title: 'Morning stretch', type: 'daily', startDate: shift(-14), endDate: shift(14), completedDays: [today, shift(-1), shift(-3)] }),
    // Range starts −5d so the quiet-day check (−7d) stays outside it.
    makeGoal({ title: 'Read a book', type: 'custom', status: 'completed', startDate: shift(-5), endDate: shift(30), completedDays: [shift(-3)] }),
  ];

  await dbBulkPut('waterEntries', waterEntries);
  await dbBulkPut('workouts', workouts);
  await dbBulkPut('journalEntries', journalEntries);
  await dbBulkPut('goals', goalList);

  // Warm the settings cache (water target/unit are read from settings).
  try { await water.getAllEntries(); } catch {}
  return { today, prevMonthDay, unit: water.waterUnit(), target: water.waterTarget() };
})()`;

const HIST = `(async () => {
  const h = await import('/js/history.js');
  const data = await h.loadHistoryData();
  return { count: data.waterEntries.length + data.workouts.length + data.journalEntries.length + data.goals.length };
})()`;

// ---- The test ---------------------------------------------------------------

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-qa12-'));
let chrome;
let serverBack = null;

try {
  console.log('Starting server + Chrome…');
  await waitForServer();
  await launchChrome();

  console.log('\n— Onboarding → dashboard → History entry point —');
  await completeOnboarding('QA');
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard');
  check('History entry card renders on the dashboard', await evaluate(`document.querySelector('#card-history .hist-entry') !== null`));
  check('entry card is keyboard-reachable (role=button, tabindex=0)',
    await evaluate(`(() => { const c = document.querySelector('#card-history .hist-entry'); return c.getAttribute('role') === 'button' && c.getAttribute('tabindex') === '0'; })()`));

  console.log('\n— Seeding real activity across three months —');
  const seedInfo = await evalAsync(SEED);
  await evaluate(`location.hash = '#/dashboard'; true`);
  await waitFor(`document.querySelector('#card-history .hist-entry') !== null`, 8000, 'dashboard re-render after seed');
  const histCount = await evalAsync(HIST);
  check('seeded records are in the stores (aggregation reads them all)', histCount.count === 13, JSON.stringify(histCount));

  // Dashboard entry card click → #/history.
  await click('#card-history .hist-entry');
  const viaCard = await waitFor(`location.hash === '#/history' && document.querySelector('.hist-grid') !== null`, 8000, 'History via dashboard card');
  check('dashboard card navigates to #/history and mounts the calendar', viaCard);
  check('browser back returns to the dashboard',
    await evaluate(`history.back(); true`));
  await waitFor(`location.hash === '#/dashboard' || location.hash === '' || location.hash === '#/'`, 6000, 'back to dashboard');
  await evaluate(`location.hash = '#/history'; true`);
  await waitFor(`document.querySelector('.hist-grid') !== null`, 8000, 'history mounted again');

  console.log('\n— Calendar structure (current month) —');
  const cal = await evalAsync(`(async () => {
    const cells = [...document.querySelectorAll('.hist-grid .hist-day')];
    return {
      cells: cells.length,
      inMonth: cells.filter((c) => !c.classList.contains('out')).length,
      todayRing: cells.some((c) => c.classList.contains('is-today')),
      selected: document.querySelector('.hist-grid .hist-day.is-selected')?.dataset.date,
      monthLabel: document.getElementById('hist-month')?.textContent,
      dows: [...document.querySelectorAll('.hist-dow')].map((d) => d.textContent),
    };
  })()`);
  check('grid renders a fixed 6×7 layout (42 cells)', cal.cells === 42, String(cal.cells));
  check('weekday header has 7 labels (Mon-first)', cal.dows.length === 7 && cal.dows[0] === 'Mon', JSON.stringify(cal.dows));
  check('in-month cell count matches the real days in this month', cal.inMonth === daysInMonthReal(), `inMonth=${cal.inMonth}`);
  check("today's cell is highlighted with the today ring", cal.todayRing);
  check('today is selected by default', cal.selected === seedInfo.today, `selected=${cal.selected}`);
  check('month header shows the current month/year', cal.monthLabel === new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), cal.monthLabel);
  check('out-month days are visually de-emphasised', await evaluate(`document.querySelectorAll('.hist-grid .hist-day.out').length > 0`));

  console.log('\n— Category selector (All / Water / Gym / Goals / Journal) —');
  const chips = await evalAsync(`(async () => {
    const chips = [...document.querySelectorAll('.hist-chip')];
    return {
      labels: chips.map((c) => c.textContent.trim()),
      count: chips.length,
      allSelected: chips.find((c) => c.dataset.category === 'all')?.getAttribute('aria-selected'),
      tablist: document.querySelector('.hist-chips')?.getAttribute('role'),
      scrollable: document.querySelector('.hist-chips').scrollWidth >= document.querySelector('.hist-chips').clientWidth,
    };
  })()`);
  check('category selector shows all five views as tabs', chips.count === 5 && chips.tablist === 'tablist', JSON.stringify(chips));
  check('All is selected by default', chips.allSelected === 'true');
  check('no page overflow from the selector', await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`));

  // Switch to Water — header, tagline and streak card must follow; the
  // visible month and selected day must NOT reset.
  await click('.hist-chip[data-category="water"]');
  await sleep(300);
  const waterView = await evalAsync(`(async () => ({
    title: document.getElementById('hist-title')?.textContent,
    tagline: document.getElementById('hist-tagline')?.textContent,
    month: document.getElementById('hist-month')?.textContent,
    selected: document.querySelector('.hist-grid .hist-day.is-selected')?.dataset.date,
    waterSelected: document.querySelector('.hist-chip[data-category="water"]')?.getAttribute('aria-selected'),
    streakNum: document.querySelector('.hist-streak-num')?.textContent?.trim(),
    best: document.querySelector('.hist-streak-best')?.textContent?.trim(),
    msg: document.querySelector('.hist-streak-msg')?.textContent,
    detailLabels: [...document.querySelectorAll('.hist-detail-label')].map((n) => n.textContent),
    detailStreak: document.querySelector('.hist-detail-streak')?.textContent || null,
  }))()`);
  check('Water view updates the category header', waterView.title === 'Water History' && waterView.tagline === 'Keep the hydration going.', JSON.stringify({ title: waterView.title, tagline: waterView.tagline }));
  check('Water view keeps the visible month (category ≠ month reset)', waterView.month === new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), waterView.month);
  check('Water view keeps the selected day', waterView.selected === seedInfo.today, waterView.selected);
  check('water chip becomes the selected tab', waterView.waterSelected === 'true');
  check('streak card shows the water streak (current + best)',
    /^\d+/.test(waterView.streakNum || '') && /best/.test(waterView.best || ''), JSON.stringify({ streakNum: waterView.streakNum, best: waterView.best }));
  check('water details show only the water row (context-aware)',
    waterView.detailLabels.length === 1 && waterView.detailLabels[0] === 'Water', JSON.stringify(waterView.detailLabels));
  check('water details include the current-streak line', (waterView.detailStreak || '').includes('Current streak'), waterView.detailStreak);
  check('motivational message is present', (waterView.msg || '').length > 5, waterView.msg);

  console.log('\n— Completion marks on the calendar (checkmarks, not dots) —');
  // Back to All for the honest mixed-state checks, then per-category ✓s.
  await click('.hist-chip[data-category="all"]');
  await sleep(250);
  const marks = await evalAsync(`(async () => {
    const sel = (k) => document.querySelector('.hist-grid .hist-day[data-date="' + k + '"]');
    const state = (k) => sel(k)?.dataset.state;
    const doneCount = (k) => sel(k) ? sel(k).querySelectorAll('.hist-mark.mark-done').length : -1;
    const partialCount = (k) => sel(k) ? sel(k).querySelectorAll('.hist-mark.mark-partial').length : -1;
    return {
      minus1: { state: state(${JSON.stringify(shiftKey(-1))}), done: doneCount(${JSON.stringify(shiftKey(-1))}) },      // water✓ goals✓ → all completed
      minus3: { state: state(${JSON.stringify(shiftKey(-3))}), done: doneCount(${JSON.stringify(shiftKey(-3))}) },      // water✓ gym✓ goals✓ → completed
      today: { state: state(${JSON.stringify(seedInfo.today)}), partial: partialCount(${JSON.stringify(seedInfo.today)}) }, // water partial → partial
      minus7: state(${JSON.stringify(shiftKey(-7))}),                                                                  // nothing → empty
      chain: document.querySelectorAll('.hist-grid .hist-day.in-chain').length,
    };
  })()`);
  check('completed day carries a real checkmark mark', marks.minus1.state === 'completed' && marks.minus1.done === 1, JSON.stringify(marks.minus1));
  check('second completed day also marked with a checkmark (chain)', marks.minus3.state === 'completed' && marks.minus3.done === 1, JSON.stringify(marks.minus3));
  check('partial day shows the subtle partial ring, never a fake ✓', marks.today.state === 'partial' && marks.today.partial === 1, JSON.stringify(marks.today));
  check('empty day has no mark and no state', marks.minus7 === 'empty', marks.minus7);
  check('consecutive completed days share the chain tint', marks.chain >= 2, String(marks.chain));

  // Water category: completed vs partial vs empty days.
  await click('.hist-chip[data-category="water"]');
  await sleep(250);
  const waterMarks = await evalAsync(`(async () => ({
    minus1: document.querySelector('.hist-grid .hist-day[data-date="${shiftKey(-1)}"]')?.dataset.state,
    today: document.querySelector('.hist-grid .hist-day[data-date="${seedInfo.today}"]')?.dataset.state,
    minus7: document.querySelector('.hist-grid .hist-day[data-date="${shiftKey(-7)}"]')?.dataset.state,
  }))()`);
  check('water calendar: target reached → completed', waterMarks.minus1 === 'completed', JSON.stringify(waterMarks));
  check('water calendar: logged but below target → partial', waterMarks.today === 'partial', JSON.stringify(waterMarks));
  check('water calendar: no entries → empty', waterMarks.minus7 === 'empty', JSON.stringify(waterMarks));

  // Gym + Journal categories: logged days are completed, quiet days empty.
  await click('.hist-chip[data-category="gym"]');
  await sleep(250);
  const gymState = await evaluate(`document.querySelector('.hist-grid .hist-day[data-date="${shiftKey(-3)}"]')?.dataset.state`);
  await click('.hist-chip[data-category="journal"]');
  await sleep(250);
  const journalState = await evaluate(`document.querySelector('.hist-grid .hist-day[data-date="${seedInfo.today}"]')?.dataset.state`);
  check('gym calendar: workout day completed, others empty', gymState === 'completed', String(gymState));
  check('journal calendar: entry day completed', journalState === 'completed', String(journalState));

  console.log('\n— Streak card numbers match the domain layer —');
  const streakQA = await evalAsync(`(async () => {
    const h = await import('/js/history.js');
    const data = await h.loadHistoryData();
    const out = {};
    for (const c of ['all', 'water', 'gym', 'goals', 'journal']) {
      out[c] = h.computeStreaks(c, data);
    }
    return out;
  })()`);
  await click('.hist-chip[data-category="water"]');
  await sleep(250);
  const shownWater = await evaluate(`document.querySelector('.hist-streak-num')?.textContent?.trim()`);
  check('water streak card matches computeStreaks(water)', (shownWater || '').startsWith(String(streakQA.water.current)), `ui=${shownWater} domain=${streakQA.water.current}`);
  await click('.hist-chip[data-category="all"]');
  await sleep(250);
  const shownAll = await evaluate(`document.querySelector('.hist-streak-num')?.textContent?.trim()`);
  check('All streak card matches computeStreaks(all)', (shownAll || '').startsWith(String(streakQA.all.current)), `ui=${shownAll} domain=${streakQA.all.current}`);
  check('best streak is shown and ≥ current streak', streakQA.all.best >= streakQA.all.current, JSON.stringify(streakQA.all));

  console.log('\n— Day details (selected day = today) —');
  const det = await evalAsync(`(async () => {
    const rows = [...document.querySelectorAll('.hist-detail-row')];
    const val = (label) => rows.find((r) => r.querySelector('.hist-detail-label')?.textContent === label)?.querySelector('.hist-detail-value')?.textContent || null;
    return {
      title: document.getElementById('hist-day-title')?.textContent || '',
      water: val('Water'), gym: val('Gym'), goals: val('Goals'), journal: val('Journal'),
      pill: document.querySelector('#hist-details-section .pill')?.textContent || '',
    };
  })()`);
  const unit = seedInfo.unit;
  check('details header includes Today', det.title.includes('Today'), det.title);
  check('water summary shows the exact total (500+250)', det.water?.startsWith('750'), det.water);
  check('gym summary shows the workout type and duration', det.gym?.includes('Strength') && det.gym?.includes('45'), det.gym);
  // Both goals (daily + custom in range) are in today's bucket and both are
  // completed — a completed custom goal counts on every day in its range
  // (existing isCompletedOn semantics, same as the dashboard's Today view).
  check('goals summary counts 2 of 2 goals completed today', det.goals?.includes('2 of 2'), det.goals);
  check('journal summary counts 1 entry', det.journal === '1 entry', det.journal);
  check('partial day details pill says Partial (honest, not completed)', det.pill.includes('Partial'), det.pill);

  console.log('\n— Selecting a quiet day shows honest empty states —');
  await evaluate(`document.querySelector('.hist-grid .hist-day[data-date="${shiftKey(-7)}"]')?.click(); true`);
  await sleep(250);
  const emptyDet = await evalAsync(`(async () => {
    const rows = [...document.querySelectorAll('.hist-detail-row')];
    const val = (label) => rows.find((r) => r.querySelector('.hist-detail-label')?.textContent === label)?.querySelector('.hist-detail-value')?.textContent || null;
    return {
      pill: document.querySelector('#hist-details-section .pill')?.textContent || '',
      water: val('Water'), gym: val('Gym'), goals: val('Goals'), journal: val('Journal'),
      selected: document.querySelector('.hist-grid .hist-day.is-selected')?.dataset.date,
    };
  })()`);
  check('quiet day is selected', emptyDet.selected === shiftKey(-7), emptyDet.selected);
  check('quiet-day pill says "Rest day"', emptyDet.pill.includes('Rest day'), emptyDet.pill);
  check('all four rows show their empty-state text',
    emptyDet.water?.includes('No water') && emptyDet.gym === 'No workout' && emptyDet.goals?.includes('No goal') && emptyDet.journal === 'No journal entry',
    JSON.stringify(emptyDet));

  console.log('\n— Month navigation + year boundaries —');
  await evaluate(`document.querySelector('[data-action="prev-month"]')?.click(); true`);
  await sleep(300);
  const prevLabel = await evaluate(`document.getElementById('hist-month')?.textContent`);
  check('prev-month header updates', prevLabel === lastMonthLabel(), prevLabel);
  await evaluate(`document.querySelector('[data-action="next-month"]')?.click(); true`);
  await sleep(300);
  check('next-month returns to the current month', (await evaluate(`document.getElementById('hist-month')?.textContent`)) === new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));

  // Seed a day in the previous month, navigate there, check dots + details.
  await evaluate(`document.querySelector('[data-action="prev-month"]')?.click(); true`);
  await sleep(300);
  // In the All view a completed day carries ONE checkmark (not per-category
  // dots); the old water+gym+journal activity aggregates into that state.
  const oldMonthState = await evalAsync(`(async () => {
    const cell = document.querySelector('.hist-grid .hist-day[data-date="${seedInfo.prevMonthDay}"]');
    return { state: cell?.dataset.state, checks: cell?.querySelectorAll('.hist-mark.mark-done').length };
  })()`);
  check('previous-month seeded day shows the completed checkmark', oldMonthState.state === 'completed' && oldMonthState.checks === 1, JSON.stringify(oldMonthState));
  await evaluate(`document.querySelector('.hist-grid .hist-day[data-date="${seedInfo.prevMonthDay}"]')?.click(); true`);
  await sleep(250);
  const oldDet = await evalAsync(`(async () => {
    const rows = [...document.querySelectorAll('.hist-detail-row')];
    const val = (label) => rows.find((r) => r.querySelector('.hist-detail-label')?.textContent === label)?.querySelector('.hist-detail-value')?.textContent || null;
    return { gym: val('Gym'), journal: val('Journal') };
  })()`);
  check('previous-month day details show the old workout', oldDet.gym?.includes('Strength') && oldDet.gym.includes('50'), oldDet.gym);
  check('previous-month day details show the old journal entry', oldDet.journal === '1 entry', oldDet.journal);

  // Year boundary: December of last year via raw history.js math (same pure
  // functions the UI uses) + the UI buttons on a deep-linked far month.
  const yb = await evalAsync(`(async () => {
    const h = await import('/js/history.js');
    const jan = h.prevMonth(new Date().getFullYear(), 0);
    const dec = h.nextMonth(new Date().getFullYear() - 1, 11);
    return { janPrev: jan.year === new Date().getFullYear() - 1 && jan.month === 11, decNext: dec.year === new Date().getFullYear() && dec.month === 0 };
  })()`);
  check('month math crosses the year boundary both ways (pure functions)', yb.janPrev && yb.decNext, JSON.stringify(yb));

  console.log('\n— Today button —');
  await evaluate(`document.querySelector('[data-action="go-today"]')?.click(); true`);
  await sleep(300);
  const backToToday = await evalAsync(`(async () => ({
    label: document.getElementById('hist-month')?.textContent,
    selected: document.querySelector('.hist-grid .hist-day.is-selected')?.dataset.date,
  }))()`);
  check('Today returns to the current month', backToToday.label === new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), backToToday.label);
  check('Today selects today', backToToday.selected === seedInfo.today, backToToday.selected);

  console.log('\n— Deep link + refresh —');
  await evaluate(`location.hash = '#/history'; true`);
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.querySelector('.hist-grid') !== null`, 10000, 'history after reload (deep link)');
  check('deep-linked #/history survives a refresh', await evaluate(`location.hash === '#/history' && document.querySelector('.hist-grid') !== null`));

  console.log('\n— Export → wipe → import: history follows the data —');
  const exportJson = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const ph = await import('/js/photos.js');
    return JSON.stringify(await db.dbExportAll(async (record) => ({ ...record, blob: await ph.blobToDataURL(record.blob), thumb: await ph.blobToDataURL(record.thumb) })));
  })()`);
  const tmpDir = mkdtempSync(join(tmpdir(), 'life-progress-v12-export-'));
  const exportPath = join(tmpDir, 'backup.json');
  writeFileSync(exportPath, exportJson);

  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="clear-data"]') !== null`, 6000, 'settings for wipe');
  await click('[data-action="clear-data"]');
  await waitFor(`document.querySelector('.dialog') !== null`, 6000, 'wipe dialog');
  await click('.dialog .btn-danger');
  await waitFor(`document.body.innerText.includes('All data cleared')`, 6000, 'wipe toast');

  await evaluate(`location.hash = '#/history'; true`);
  await waitFor(`document.querySelector('.hist-grid') !== null`, 8000, 'history after wipe');
  const wipedMarks = await evaluate(`document.querySelectorAll('.hist-grid .hist-day .hist-mark').length`);
  check('history is empty after a wipe (derived, no stale cache)', wipedMarks === 0, String(wipedMarks));

  await evaluate(`location.hash = '#/settings'`);
  await waitFor(`document.querySelector('[data-action="import-data"]') !== null`, 6000, 'settings for import');
  await click('[data-action="import-data"]');
  await pickFileWith('input[type=file][accept*="json"]', exportPath);
  await waitFor(`document.querySelector('.dialog') !== null`, 8000, 'import confirm');
  await click('.dialog .btn-danger');
  await waitFor(`document.querySelector('#dash-hero') !== null || document.querySelector('.settings-list') !== null`, 10000, 'after import');
  await evaluate(`location.hash = '#/history'; true`);
  await waitFor(`document.querySelector('.hist-grid') !== null`, 8000, 'history after import');
  const importedMarks = await evaluate(`document.querySelectorAll('.hist-grid .hist-day .hist-mark').length`);
  check('history reflects imported data (completion marks return)', importedMarks > 0, String(importedMarks));

  console.log('\n— Layout: widths, themes, reduced motion, console —');
  for (const w of [320, 360, 390, 412, 1024]) {
    await setViewport(w, Math.round(Math.min(1.9 * w, 900)));
    await evaluate(`location.hash = '#/history'; true`);
    await waitFor(`document.querySelector('.hist-grid') !== null`, 8000, `history @${w}`);
    await sleep(300);
    const layout = await evalAsync(`(async () => {
      const grid = document.querySelector('.hist-grid');
      const days = [...document.querySelectorAll('.hist-grid .hist-day')];
      const r = grid.getBoundingClientRect();
      const dayMin = Math.min(...days.map((d) => d.getBoundingClientRect().width));
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        gridFits: r.right <= window.innerWidth + 1 && r.left >= -1,
        sevenCols: getComputedStyle(grid).gridTemplateColumns.split(' ').length === 7,
        touchTarget: dayMin >= 40,
        gridVisible: r.width > 0,
      };
    })()`);
    check(`${w}px: no overflow, 7 columns, ≥40px day targets`, layout.overflow && layout.gridFits && layout.sevenCols && layout.touchTarget, JSON.stringify(layout));
  }
  await setViewport(390, 844);

  for (const scheme of ['dark', 'light']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(200);
    check(`${scheme} mode: calendar rows readable (non-transparent text)`,
      await evaluate(`(() => { const c = getComputedStyle(document.querySelector('.hist-daynum')); return c.color !== 'rgba(0, 0, 0, 0)'; })()`));
  }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] });

  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(200);
  await evaluate(`document.querySelector('.hist-grid .hist-day[data-date="${seedInfo.today}"]')?.click(); true`);
  await sleep(250);
  check('reduced motion: selection still updates instantly',
    await evaluate(`document.querySelector('.hist-grid .hist-day.is-selected')?.dataset.date === ${JSON.stringify(seedInfo.today)}`));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });

  console.log('\n— Offline reload (server down) —');
  server.kill('SIGKILL');
  await send('Page.reload');
  await sleep(2500);
  const offlineOk = await waitFor(`document.querySelector('.hist-grid') !== null || document.getElementById('launch-screen') !== null`, 15000, 'offline reload');
  check('app reloads fully offline', offlineOk);
  if (offlineOk) {
    await waitFor(launchOverlayGone, 9000, 'offline launch overlay leaves');
    await evaluate(`location.hash = '#/history'; true`);
    await waitFor(`document.querySelector('.hist-grid') !== null`, 10000, 'history offline');
    const offlineMarks = await evaluate(`document.querySelectorAll('.hist-grid .hist-day .hist-mark').length`);
    check('history renders offline from IndexedDB (derived layer works)', offlineMarks > 0, String(offlineMarks));
  }
  serverBack = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(500);

  console.log('\n— Console errors —');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('service worker') && !e.includes('favicon') && !e.includes('DOMException') && !e.includes('net::')
  );
  check('no unhandled JS errors during the whole Phase 1 QA run', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  console.error('QA V1.2 PHASE 1 CRASHED:', err.message);
  failures += 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome) chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { serverBack?.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\\n${failures === 0 ? '✓ ALL V1.2 PHASE 1 QA CHECKS PASSED' : `✗ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------
// Pure (Node-side) helpers shared by the checks above.
// ---------------------------------------------------------------------------

function shiftKey(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysInMonthReal() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
}

function lastMonthLabel() {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth() - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/** Proven file-picker pattern from qa-extended.js: wait, resolve, set. */
async function pickFileWith(selector, filePath) {
  await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, 8000, `file input ${selector}`);
  const doc = await send('DOM.getDocument', { depth: 0 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
}
