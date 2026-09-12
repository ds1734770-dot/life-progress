/**
 * V1.2 Phase 2 QA — Achievements & Badges.
 *
 * Real-browser (CDP) verification that:
 *   1. Settings → "Achievements & Badges" row exists and deep-links #/achievements
 *   2. Trophy cabinet: progress ring, 6 category filters (tablist), unlocked /
 *      locked sections, honest progress bars on locked cards
 *   3. Earning a badge triggers the full-screen celebration (dialog semantics,
 *      SVG badge art, next-milestone bridge, Escape/Continue dismiss)
 *   4. Celebrations happen ONCE per badge (seen-state), survive reload quietly
 *   5. Badge detail: requirement, earned date, evidence, next milestone
 *   6. Reduced motion: identical info, minimal animation
 *   7. Export → wipe → import: records persist / vanish / restore, and a
 *      record-less import is reconstructed by the evaluator
 *   8. Layouts 320/360/390/412/1024 px, dark/light, offline, console-clean
 *
 * Run: node scripts/qa-v12-achievements.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8095;
const DEBUG_PORT = 9227;
const APP_URL = `http://localhost:${PORT}/`;

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

// ---- Tiny CDP client (same proven pattern as qa-v11.js / qa-v12-history.js) --
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

/** Dismiss the celebration queue until nothing is left. */
async function drainCelebrations(max = 8) {
  for (let i = 0; i < max; i++) {
    if (!(await evaluate(`!!document.querySelector('.celebration-backdrop')`))) return i;
    await click('.celebration-backdrop [data-celebration="close"]');
    await sleep(350);
  }
  return max;
}

const launchOverlayGone = `!document.getElementById('launch-screen')`;

// In-page seed: same activity shape as the Phase 1 suite (proven semantics).
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
  const prevMonthDay = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 10));

  const TARGET = 3000;
  const waterEntries = [
    makeWaterEntry(500, at(today, 8)), makeWaterEntry(250, at(today, 9)),
    makeWaterEntry(750, at(shift(-1), 10)), makeWaterEntry(TARGET, at(shift(-1), 11)),
    makeWaterEntry(300, at(prevMonthDay, 11)), makeWaterEntry(TARGET, at(prevMonthDay, 12)),
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
    makeGoal({ title: 'Read a book', type: 'custom', status: 'completed', startDate: shift(-5), endDate: shift(30), completedDays: [shift(-3)] }),
  ];

  await dbBulkPut('waterEntries', waterEntries);
  await dbBulkPut('workouts', workouts);
  await dbBulkPut('journalEntries', journalEntries);
  await dbBulkPut('goals', goalList);
  try { await water.getAllEntries(); } catch {}
  return { today };
})()`;

// What the evaluator SHOULD award for the current data — computed from the
// domain layer itself so the QA never hardcodes seed semantics.
const EXPECTED = `(async () => {
  const A = await import('/js/achievements.js');
  const h = await import('/js/history.js');
  const data = await h.loadHistoryData();
  const { earnedNew } = A.evaluateAchievements(data, []);
  return {
    ids: earnedNew.map((a) => a.id),
    total: A.ACHIEVEMENTS.length,
    first: earnedNew[0] ? { id: earnedNew[0].id, title: earnedNew[0].title } : null,
  };
})()`;

// ---- The test ---------------------------------------------------------------

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-qa12b-'));
let chrome;
let serverBack = null;

try {
  console.log('Starting server + Chrome…');
  await waitForServer();
  await launchChrome();

  console.log('\n— Onboarding → Settings → Achievements entry point —');
  await completeOnboarding('QA');
  await waitFor(`document.querySelector('#dash-hero') !== null`, 10000, 'dashboard');
  await evaluate(`location.hash = '#/settings'; true`);
  await waitFor(`document.querySelector('[data-action="open-achievements"]') !== null`, 8000, 'settings row');
  check('Settings shows the Achievements & Badges row', true);
  await waitFor(`(() => { const s = document.getElementById('ach-settings-sub'); return s && s.textContent.includes('unlocked'); })()`, 6000, 'settings sub refresh');
  check('settings sub shows the live unlocked count (0 of N initially)',
    await evaluate(`(() => { const s = document.getElementById('ach-settings-sub'); return s && /0 of \\d+/.test(s.textContent); })()`));
  await click('[data-action="open-achievements"]');
  await waitFor(`location.hash === '#/achievements' && document.querySelector('.ach-grid') !== null`, 8000, 'achievements route');
  check('settings row navigates to #/achievements and mounts the cabinet', true);
  check('browser history back leaves the screen (route is real)',
    await evaluate(`history.back(); true`));
  await waitFor(`location.hash !== '#/achievements'`, 6000, 'back navigation');
  await evaluate(`location.hash = '#/achievements'; true`);
  await waitFor(`document.querySelector('.ach-grid') !== null`, 8000, 'achievements mounted again');

  console.log('\n— Empty cabinet —');
  const emptyCab = await evalAsync(`(async () => ({
    ring: document.querySelector('.ring-center')?.textContent?.replace(/\\s+/g, ' ').trim(),
    filters: document.querySelectorAll('.ach-filter').length,
    tablist: document.querySelector('.ach-filters')?.getAttribute('role'),
    allSelected: document.querySelector('.ach-filter[data-filter="all"]')?.getAttribute('aria-selected'),
    lockedCards: document.querySelectorAll('.ach-card.locked').length,
    unlockedCards: document.querySelectorAll('.ach-card.unlocked').length,
    emptyState: document.body.innerText.includes('No badges here yet'),
  }))()`);
  check('progress ring shows 0 of the full registry', /^0/.test(emptyCab.ring || ''), emptyCab.ring);
  check('six category filters render as an accessible tablist (All + 5 categories)',
    emptyCab.filters === 6 && emptyCab.tablist === 'tablist', JSON.stringify(emptyCab));
  check('All filter is selected by default', emptyCab.allSelected === 'true');
  check('every badge starts locked with no unlocked cards',
    emptyCab.lockedCards === (await evalAsync(`(await import('/js/achievements.js')).ACHIEVEMENTS.length`)) && emptyCab.unlockedCards === 0,
    `locked=${emptyCab.lockedCards}`);
  check('locked-only state shows an encouraging empty state, not a dead grid', emptyCab.emptyState);

  console.log('\n— Seeding activity + earning badges —');
  await evalAsync(SEED);
  const expected = await evalAsync(EXPECTED);
  check('evaluator derives the expected badge set from real data', expected.ids.length >= 4, JSON.stringify(expected.ids));

  await evaluate(`location.hash = '#/dashboard'; true`);
  await waitFor(`document.querySelector('#dash-hero') !== null`, 8000, 'dashboard after seed');
  await evalAsync(`(async () => { const { checkAchievementsNow } = await import('/js/celebration.js'); return checkAchievementsNow(); })()`);
  await waitFor(`!!document.querySelector('.celebration-backdrop')`, 8000, 'celebration appears');
  const celeb = await evalAsync(`(async () => ({
    role: document.querySelector('.celebration-backdrop')?.getAttribute('role'),
    modal: document.querySelector('.celebration-backdrop')?.getAttribute('aria-modal'),
    kicker: document.querySelector('.celebration-unlocked')?.textContent,
    title: document.getElementById('celebration-title')?.textContent,
    requirement: document.querySelector('.celebration-requirement')?.textContent,
    svg: !!document.querySelector('.celebration-badge svg'),
    earned: document.querySelector('.celebration-earned')?.textContent || '',
    nextTitle: document.querySelector('.celebration-next-title')?.textContent || null,
    nextSub: document.querySelector('.celebration-next-sub')?.textContent || '',
    continueBtn: !!document.querySelector('[data-celebration="close"]'),
  }))()`);
  check('celebration is a modal dialog (role=dialog, aria-modal)', celeb.role === 'dialog' && celeb.modal === 'true', JSON.stringify(celeb));
  check('celebration announces the unlock with badge title', celeb.kicker?.toLowerCase().includes('unlocked') && celeb.title === expected.first.title, `${celeb.kicker} / ${celeb.title}`);
  check('celebration shows the requirement + earned date', (celeb.requirement || '').length > 3 && celeb.earned.includes('Earned'), JSON.stringify({ requirement: celeb.requirement, earned: celeb.earned }));
  check('badge artwork is real SVG (not an emoji)', celeb.svg);
  check('celebration bridges to the next milestone', !!celeb.nextTitle && celeb.nextSub.length > 3, `${celeb.nextTitle} — ${celeb.nextSub}`);
  check('Continue button is present for dismissal', celeb.continueBtn);

  console.log('\n— Dismissal + celebrate-once semantics —');
  // Escape consumes the CURRENT panel; the queue then auto-advances to the
  // next badge (one celebration at a time, never stacked).
  const q1 = await evalAsync(`(async () => {
    const c = await import('/js/celebration.js');
    const before = c.pendingCelebrationCount();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { before, after: c.pendingCelebrationCount(), advanced: !!document.querySelector('.celebration-backdrop') };
  })()`);
  check('Escape consumes exactly one queued celebration', q1.before === q1.after + 1 && q1.before > 0, JSON.stringify(q1));
  check('queue auto-advances to the next badge (never stacked)', q1.advanced && q1.after > 0, JSON.stringify(q1));
  const drained = await evalAsync(`(async () => {
    const c = await import('/js/celebration.js');
    let guard = 0;
    while (c.pendingCelebrationCount() > 0 && guard++ < 12) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
    }
    return { pending: c.pendingCelebrationCount(), backdrop: !!document.querySelector('.celebration-backdrop') };
  })()`);
  check('queue drains fully, one celebration at a time', drained.pending === 0 && !drained.backdrop, JSON.stringify(drained));
  const secondRun = await evalAsync(`(async () => {
    const c = await import('/js/celebration.js');
    const earned = await c.checkAchievementsNow();
    await new Promise((r) => setTimeout(r, 400));
    return { earned, remaining: document.querySelectorAll('.celebration-backdrop').length };
  })()`);
  check('re-evaluation earns nothing new and re-celebrates nothing', secondRun.earned.length === 0 && secondRun.remaining === 0, JSON.stringify(secondRun));

  console.log('\n— Reload: records persist, startup stays quiet (all seen) —');
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.querySelector('#dash-hero') !== null || document.getElementById('launch-screen') !== null`, 12000, 'reload');
  await waitFor(launchOverlayGone, 9000, 'launch overlay leaves');
  await sleep(800); // startup evaluation would fire any pending celebration
  check('no celebration re-appears after reload (celebrated once, ever)',
    !(await evaluate(`!!document.querySelector('.celebration-backdrop')`)));
  await evaluate(`location.hash = '#/achievements'; true`);
  await waitFor(`document.querySelector('.ach-grid') !== null`, 8000, 'cabinet after reload');
  const persisted = await evalAsync(`(async () => ({
    unlocked: document.querySelectorAll('.ach-card.unlocked').length,
    ring: document.querySelector('.ring-center')?.textContent?.replace(/\\s+/g, ' ').trim(),
    records: (await (await import('/js/db.js')).dbGetAll('achievementRecords')).length,
  }))()`);
  check('unlocked badges persist across reload', persisted.unlocked === expected.ids.length && persisted.records === expected.ids.length, JSON.stringify(persisted));

  console.log('\n— Cabinet sections, filters, progress —');
  const cab = await evalAsync(`(async () => ({
    unlockedCards: [...document.querySelectorAll('.ach-card.unlocked')].map((c) => c.dataset.id),
    lockedCards: document.querySelectorAll('.ach-card.locked').length,
    lockedWithBar: [...document.querySelectorAll('.ach-card.locked')].filter((c) => c.querySelector('.ach-progress-fill')).length,
    unlockedAria: document.querySelector('.ach-card.unlocked')?.getAttribute('aria-label') || '',
    lockedAria: document.querySelector('.ach-card.locked')?.getAttribute('aria-label') || '',
  }))()`);
  check('unlocked section lists exactly the earned badges', cab.unlockedCards.length === expected.ids.length && expected.ids.every((id) => cab.unlockedCards.includes(id)), JSON.stringify(cab.unlockedCards));
  check('locked badges show progress bars (never a bare "Locked")', cab.lockedWithBar === cab.lockedCards && cab.lockedCards > 0);
  check('unlocked card label names title + Unlocked state', cab.unlockedAria.includes('Unlocked') && cab.unlockedAria.includes('Earned'), cab.unlockedAria);
  check('locked card label exposes the progress numbers', /Locked/.test(cab.lockedAria) && /Progress \d+ of \d+/.test(cab.lockedAria), cab.lockedAria);

  await click('.ach-filter[data-filter="water"]');
  await sleep(300);
  const waterFilter = await evalAsync(`(async () => ({
    selected: document.querySelector('.ach-filter[data-filter="water"]')?.getAttribute('aria-selected'),
    unlocked: [...document.querySelectorAll('.ach-card.unlocked')].map((c) => c.dataset.id),
    locked: document.querySelectorAll('.ach-card.locked').length,
  }))()`);
  check('water filter selects itself and narrows to water badges',
    waterFilter.selected === 'true' && waterFilter.unlocked.every((id) => id.startsWith('water-')) && waterFilter.unlocked.length > 0,
    JSON.stringify(waterFilter));
  await click('.ach-filter[data-filter="all"]');
  await sleep(250);

  console.log('\n— Badge detail (unlocked + locked) —');
  await click(`.ach-card.unlocked[data-id="${expected.first.id}"]`);
  await waitFor(`!!document.querySelector('.ach-detail .ach-detail-title')`, 6000, 'badge detail opens');
  const detail = await evalAsync(`(async () => {
    const sheet = document.querySelector('.ach-detail');
    const t = (sel) => sheet?.querySelector(sel)?.textContent || '';
    return {
      title: t('.ach-detail-title'),
      stateTag: t('.ach-detail-head div.muted'),
      earned: t('.ach-detail-earned'),
      evidence: sheet?.querySelectorAll('.ach-evidence-day, .ach-evidence-note').length || 0,
      evidenceLabel: t('.ach-detail-label').includes('Your achievement'),
      nextTitle: t('.ach-next-title'),
      stat: t('.ach-detail-stat'),
    };
  })()`);
  check('unlocked detail shows the badge title + Unlocked state', detail.title === expected.first.title && detail.stateTag.includes('Unlocked'), JSON.stringify(detail));
  check('unlocked detail shows the earned date', detail.earned.includes('Earned'), detail.earned);
  check('unlocked detail shows derived evidence', detail.evidenceLabel && detail.evidence > 0, String(detail.evidence));
  check('unlocked detail bridges to the next milestone', !!detail.nextTitle, detail.nextTitle);
  await click('.ach-detail [data-detail-close]');
  await sleep(350);

  await click('.ach-card.locked[data-id="water-7"]');
  await waitFor(`!!document.querySelector('.ach-detail .ach-detail-title')`, 6000, 'locked detail opens');
  const lockedDetail = await evalAsync(`(async () => {
    const sheet = document.querySelector('.ach-detail');
    return {
      title: sheet?.querySelector('.ach-detail-title')?.textContent || '',
      stateTag: sheet?.querySelector('.ach-detail-head div.muted')?.textContent || '',
      progress: sheet?.textContent.match(/\\d+ \\/ \\d+ days/)?.[0] || '',
    };
  })()`);
  check('locked detail keeps an encouraging progress readout', lockedDetail.title === 'Hydration Habit' && lockedDetail.stateTag.includes('Locked') && /2 \/ 7/.test(lockedDetail.progress), JSON.stringify(lockedDetail));
  await click('.ach-detail [data-detail-close]');
  await sleep(350);

  console.log('\n— Settings sub reflects the earned count —');
  await evaluate(`location.hash = '#/settings'; true`);
  await waitFor(`(() => { const s = document.getElementById('ach-settings-sub'); return s && s.textContent.includes('unlocked'); })()`, 6000, 'settings sub refresh');
  const sub = await evaluate(`document.getElementById('ach-settings-sub')?.textContent || ''`);
  check(`settings row reads "${expected.ids.length} of ${expected.total} unlocked"`,
    sub.includes(`${expected.ids.length} of ${expected.total} unlocked`), sub);

  console.log('\n— Reduced motion: same information, minimal animation —');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  // Reload so the seen-set cache is fresh, then clear it and re-queue from
  // the persisted records (checkAchievementsNow only queues NEWLY earned).
  await evaluate(`localStorage.removeItem('achievements-celebrated'); true`);
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.querySelector('.ach-grid') !== null || document.getElementById('launch-screen') !== null`, 12000, 'reload (reduced motion)');
  await waitFor(launchOverlayGone, 9000, 'launch overlay leaves');
  await evaluate(`location.hash = '#/achievements'; true`);
  await waitFor(`document.querySelector('.ach-grid') !== null`, 8000, 'cabinet (reduced motion)');
  await evalAsync(`(async () => {
    const A = await import('/js/achievements.js');
    const c = await import('/js/celebration.js');
    const records = await A.loadAchievementRecords();
    const data = await (await import('/js/history.js')).loadHistoryData();
    const { progress } = A.evaluateAchievements(data, records);
    c.resetCelebrationQueue();
    c.queueUnseenCelebrations(records.map((r) => ({
      achievement: A.getAchievement(r.id), progress: progress.get(r.id), earnedAt: r.earnedAt,
    })).filter((p) => p.achievement));
    return c.pendingCelebrationCount();
  })()`);
  await waitFor(`!!document.querySelector('.celebration-backdrop')`, 8000, 'reduced-motion celebration');
  const reduced = await evalAsync(`(async () => ({
    reducedClass: document.querySelector('.celebration-panel')?.classList.contains('reduced'),
    title: document.getElementById('celebration-title')?.textContent,
    svg: !!document.querySelector('.celebration-badge svg'),
  }))()`);
  check('reduced motion celebration still shows full information', reduced.reducedClass === true && !!reduced.title && reduced.svg, JSON.stringify(reduced));
  const rmDrained = await drainCelebrations();
  check('queue drains sequentially with one celebration at a time', rmDrained === expected.ids.length, `dismissed=${rmDrained}`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });

  console.log('\n— Export → wipe → import (records follow the store) —');
  const exportJson = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const ph = await import('/js/photos.js');
    return JSON.stringify(await db.dbExportAll(async (record) => ({ ...record, blob: await ph.blobToDataURL(record.blob), thumb: await ph.blobToDataURL(record.thumb) })));
  })()`);
  const tmpDir = mkdtempSync(join(tmpdir(), 'life-progress-v12b-export-'));
  const exportPath = join(tmpDir, 'backup.json');
  writeFileSync(exportPath, exportJson);
  const strippedDump = JSON.parse(exportJson);
  delete strippedDump.data.achievementRecords;
  const strippedPath = join(tmpDir, 'backup-no-achievements.json');
  writeFileSync(strippedPath, JSON.stringify(strippedDump));

  const runWipe = async () => {
    await evaluate(`location.hash = '#/settings'; true`);
    await waitFor(`document.querySelector('[data-action="clear-data"]') !== null`, 6000, 'settings for wipe');
    await click('[data-action="clear-data"]');
    await waitFor(`document.querySelector('.dialog') !== null`, 6000, 'wipe dialog');
    await click('.dialog .btn-danger');
    await waitFor(`document.body.innerText.includes('All data cleared')`, 6000, 'wipe toast');
  };
  const runImport = async (path) => {
    await evaluate(`location.hash = '#/settings'; true`);
    await waitFor(`document.querySelector('[data-action="import-data"]') !== null`, 6000, 'settings for import');
    await click('[data-action="import-data"]');
    await pickFileWith('input[type=file][accept*="json"]', path);
    await waitFor(`document.querySelector('.dialog') !== null`, 8000, 'import confirm');
    await click('.dialog .btn-danger');
    await waitFor(`document.querySelector('#dash-hero') !== null || document.querySelector('.settings-list') !== null`, 10000, 'after import');
  };

  await runWipe();
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.getElementById('onboarding-root').children.length > 0 || document.querySelector('#dash-hero') !== null`, 10000, 'post-wipe state');
  if (await evaluate(`document.getElementById('onboarding-root').children.length > 0`)) await completeOnboarding('QA');
  await evaluate(`location.hash = '#/achievements'; true`);
  await waitFor(`document.querySelector('.ach-grid') !== null`, 8000, 'cabinet after wipe');
  const wiped = await evalAsync(`(async () => ({
    unlocked: document.querySelectorAll('.ach-card.unlocked').length,
    records: (await (await import('/js/db.js')).dbGetAll('achievementRecords')).length,
  }))()`);
  check('wipe clears earned badges AND their records', wiped.unlocked === 0 && wiped.records === 0, JSON.stringify(wiped));

  await runImport(exportPath);
  await evaluate(`location.hash = '#/achievements'; true`);
  await waitFor(`document.querySelector('.ach-grid') !== null`, 8000, 'cabinet after import');
  const restored = await evalAsync(`(async () => ({
    unlocked: document.querySelectorAll('.ach-card.unlocked').length,
    records: (await (await import('/js/db.js')).dbGetAll('achievementRecords')).length,
  }))()`);
  check('import restores the achievement records', restored.unlocked === expected.ids.length && restored.records === expected.ids.length, JSON.stringify(restored));

  // Reconstruction: activity data without records → evaluator re-awards once.
  await runWipe();
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.getElementById('onboarding-root').children.length > 0 || document.querySelector('#dash-hero') !== null`, 10000, 'post-wipe state 2');
  if (await evaluate(`document.getElementById('onboarding-root').children.length > 0`)) await completeOnboarding('QA');
  await runImport(strippedPath);
  await evalAsync(`(async () => { const c = await import('/js/celebration.js'); return c.checkAchievementsNow(); })()`);
  await drainCelebrations();
  await evaluate(`location.hash = '#/achievements'; true`);
  await waitFor(`document.querySelector('.ach-grid') !== null`, 8000, 'cabinet after reconstruction');
  const reconstructed = await evalAsync(`(async () => ({
    unlocked: document.querySelectorAll('.ach-card.unlocked').length,
    records: (await (await import('/js/db.js')).dbGetAll('achievementRecords')).length,
  }))()`);
  check('record-less import: evaluator reconstructs earned badges exactly once',
    reconstructed.unlocked === expected.ids.length && reconstructed.records === expected.ids.length, JSON.stringify(reconstructed));

  console.log('\n— Layout: widths, themes, console —');
  for (const w of [320, 360, 390, 412, 1024]) {
    await setViewport(w, Math.round(Math.min(1.9 * w, 900)));
    await evaluate(`location.hash = '#/achievements'; true`);
    await waitFor(`document.querySelector('.ach-grid') !== null`, 8000, `cabinet @${w}`);
    await sleep(300);
    const layout = await evalAsync(`(async () => {
      const cards = [...document.querySelectorAll('.ach-card')];
      const filters = document.querySelector('.ach-filters');
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        cardMin: cards.length ? Math.min(...cards.map((c) => c.getBoundingClientRect().width)) : 0,
        filterFits: filters ? filters.getBoundingClientRect().right <= window.innerWidth + 1 : true,
        cols: getComputedStyle(document.querySelector('.ach-grid')).gridTemplateColumns.split(' ').length,
        cards: cards.length,
      };
    })()`);
    check(`${w}px: no overflow, filter row inside viewport, ≥2-column grid, ≥130px cards`,
      layout.overflow && layout.filterFits && layout.cols >= 2 && layout.cardMin >= 130, JSON.stringify(layout));
  }
  await setViewport(390, 844);

  for (const scheme of ['dark', 'light']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(200);
    check(`${scheme} mode: badge titles readable (non-transparent text)`,
      await evaluate(`(() => { const c = getComputedStyle(document.querySelector('.ach-card-title')); return c.color !== 'rgba(0, 0, 0, 0)'; })()`));
  }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] });

  console.log('\n— Offline reload (server down) —');
  server.kill('SIGKILL');
  await send('Page.reload');
  await sleep(2500);
  const offlineOk = await waitFor(`document.querySelector('.ach-grid') !== null || document.getElementById('launch-screen') !== null`, 15000, 'offline reload');
  check('app reloads fully offline', offlineOk);
  if (offlineOk) {
    await waitFor(launchOverlayGone, 9000, 'offline launch overlay leaves');
    await evaluate(`location.hash = '#/achievements'; true`);
    await waitFor(`document.querySelector('.ach-grid') !== null`, 10000, 'cabinet offline');
    const offlineUnlocked = await evaluate(`document.querySelectorAll('.ach-card.unlocked').length`);
    check('achievements render offline from IndexedDB', offlineUnlocked === expected.ids.length, String(offlineUnlocked));
  }
  serverBack = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(500);

  console.log('\n— Console errors —');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('service worker') && !e.includes('favicon') && !e.includes('DOMException') && !e.includes('net::')
  );
  check('no unhandled JS errors during the whole Phase 2 QA run', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  console.error('QA V1.2 PHASE 2 CRASHED:', err.message);
  failures += 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome) chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { serverBack?.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? '✓ ALL V1.2 PHASE 2 QA CHECKS PASSED' : `✗ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);

// ---------------------------------------------------------------------------
// Pure (Node-side) helpers.
// ---------------------------------------------------------------------------

/** Proven file-picker pattern from qa-extended.js: wait, resolve, set. */
async function pickFileWith(selector, filePath) {
  await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, 8000, `file input ${selector}`);
  const doc = await send('DOM.getDocument', { depth: 0 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
}
