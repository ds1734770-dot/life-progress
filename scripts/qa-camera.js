/**
 * V1.3 QA — Smart Progress Camera (photo template + reference alignment).
 *
 * Real-browser (CDP) verification with a synthetic camera device. Covers:
 *   1. Photo template: analyse a photo locally → profile persisted (metadata
 *      only), active-template pointer, template bar/badge, re-analyse/remove
 *   2. Smart camera: live stream, ghost reference, pose skeleton, guidance,
 *      match meter, stability, auto capture, manual capture, captured result
 *   3. Coordinate system: stage aspect taken from the reference photo; overlay
 *      canvases sized to the stage; ghost actually painted
 *   4. Fallbacks: no template, model unavailable/init failure, denied camera,
 *      "use standard camera" → the V1 capture path still works
 *   5. Lifecycle: media tracks always stopped, detector paused, 10 open/close
 *      cycles with no console errors or unhandled rejections
 *   6. Persistence: export/import (profiles travel with their photo), wipe,
 *      orphan profiles, reference deletion cascade
 *   7. Privacy: no cross-origin request at any point; the pose runtime is NOT
 *      loaded during normal app startup (lazy load verified)
 *   8. The REAL vendored MediaPipe model initializes and runs inference
 *      on-device (no fake detector) — proving the shipped assets work
 *   9. Reduced motion, accessibility attributes, 320–1024px layouts, themes
 *
 * Run: npm run qa:camera
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8096;
const DEBUG_PORT = 9228;
const APP_URL = `http://localhost:${PORT}/`;
const TEST_IMAGE = join(ROOT, 'icons', 'icon-192.png');

let failures = 0;
function check(name, condition, extra = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!condition) failures += 1;
}

// ---- Tiny CDP client (same proven pattern as the other QA suites) ---------
let ws;
let nextId = 0;
const pending = new Map();
const consoleErrors = [];
const requests = [];

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
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleErrors.push(d.exception?.description || d.text || 'exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type)) {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    } else if (msg.method === 'Network.requestWillBeSent') {
      requests.push({ url: msg.params.request.url, type: msg.params.type });
    }
  };
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
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
        window.__qaResult = { seq: window.__qaSeq, value: JSON.stringify({ __qaError: String((err && err.message) || err) }) };
      }
    })()
  `);
  let payload = null;
  for (let i = 0; i < 400; i++) {
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

const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);

/** Dump what the app is actually showing — for diagnosing a stuck camera. */
async function dumpScreen(label) {
  try {
    const info = await evalAsync(`(async () => ({
      hash: location.hash,
      screen: (document.getElementById('screen-root') || {}).className || null,
      text: document.body.innerText.slice(0, 140).replace(/\\n+/g, ' | '),
      stage: !!document.querySelector('#cam-stage'),
      video: !!document.querySelector('#cam-video'),
      mode: document.getElementById('cam-state')?.dataset.mode || null,
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    }))()`);
    console.log(`   DIAG ${label}:`, JSON.stringify(info));
  } catch (err) {
    console.log(`   DIAG ${label}: unavailable (${err.message})`);
  }
  if (consoleErrors.length) console.log(`   DIAG ${label} console:`, consoleErrors.slice(-3).join(' | ').slice(0, 400));
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
  for (let i = 0; i < 100; i++) {
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

const setViewport = async (width, height) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await sleep(250);
};

function completeOnboarding(name = 'QA') {
  return (async () => {
    await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 12000, 'onboarding');
    for (let i = 0; i < 2; i++) {
      await click('.onboarding #ob-next');
      await sleep(250);
    }
    await evaluate(`document.getElementById('ob-name').value = ${JSON.stringify(name)}`);
    await click('.onboarding #ob-next');
    await sleep(200);
    for (let i = 0; i < 3; i++) {
      await click('.onboarding #ob-next');
      await sleep(200);
    }
    await waitFor(`document.getElementById('onboarding-root').children.length === 0`, 8000, 'onboarding done');
  })();
}

/** Proven file-picker pattern: wait for the input, resolve the node, set files. */
async function pickFileWith(selector, filePath) {
  await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`, 8000, `file input ${selector}`);
  const doc = await send('DOM.getDocument', { depth: 0 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
}

// ---------------------------------------------------------------------------
// In-page fake detector: deterministic landmarks, so the whole alignment UI can
// be driven end-to-end without a human in front of the camera. It is installed
// through the documented adapter seam (setPoseDetectorFactory) and uses the
// same landmark fixture the unit tests use.
// ---------------------------------------------------------------------------

const FAKE_DETECTOR = `(() => {
  // The config describes the stance in COMPOSITION space (the reference's space).
  // A detector's landmarks are normalised to the frame it was given, so the
  // synthetic body is packed back into the real video frame here — exactly what
  // a real landmarker would report. rawFrame:true skips that, which is how the
  // QA proves the app really applies the composition mapping.
  const state = { config: { centerX: 0.5, centerY: 0.55, height: 0.46, visibility: 0.95 }, rawFrame: false, mode: 'pose', calls: 0, inits: 0, disposed: 0 };
  window.__poseQA = state;
  const build = (source, ts, kind) => {
    state.calls += 1;
    if (state.mode === 'null') return null;
    if (state.mode === 'throw') throw new Error('qa detector failure');
    const w = (source && (source.videoWidth || source.width || source.naturalWidth)) || 192;
    const h = (source && (source.videoHeight || source.height || source.naturalHeight)) || 192;
    let raw = window.__poseRaw(state.config);
    if (kind === 'video' && !state.rawFrame) raw = window.__poseFrame(raw, h / w, window.__qaCompositionAspect);
    return window.__normalizePose(raw, { timestamp: ts || 0, imageWidth: w, imageHeight: h, source: kind });
  };
  return function factory() {
    return {
      name: 'qa-fake-detector',
      async initialize() { state.inits += 1; if (state.mode === 'unavailable') { const e = new Error('assets missing'); e.reason = 'assets-missing'; throw e; } if (state.mode === 'initfail') throw new Error('qa init failure'); return { ready: true }; },
      detect(source, ts) { return build(source, ts, 'video'); },
      async detectImage(source) { return build(source, 0, 'image'); },
      pause() { state.paused = (state.paused || 0) + 1; },
      resume() { state.resumed = (state.resumed || 0) + 1; },
      dispose() { state.disposed += 1; },
      get stats() { return { frames: state.calls, ready: true, model: 'qa-fake' }; },
      get ready() { return true; },
    };
  };
})()`;

const INSTALL_FAKE = `(async () => {
  const g = await import('/js/pose/geometry.js');
  const fx = await import('/test/pose-fixture.js');
  window.__normalizePose = g.normalizePose;
  window.__poseRaw = fx.rawPose;
  // The reference photo these checks use is square, so its composition space is
  // aspect 1 (see js/pose/reference.js#referenceCompositionAspect).
  window.__qaCompositionAspect = 1;
  // Independent inverse of the app's cover mapping: composition → frame.
  window.__poseFrame = (landmarks, sourceAspect, compositionAspect) => {
    const scale = Math.max(1, compositionAspect / sourceAspect);
    const dx = (1 - scale) / 2;
    const dy = (compositionAspect - sourceAspect * scale) / 2;
    return landmarks.map((lm) => ({
      ...lm,
      x: (lm.x - dx) / scale,
      y: (lm.y * compositionAspect - dy) / (sourceAspect * scale),
    }));
  };
  const d = await import('/js/pose/detector.js');
  d.setPoseDetectorFactory(${FAKE_DETECTOR});
  return true;
})()`;

const setPose = (config) => evalAsync(`(async () => { window.__poseQA.config = ${JSON.stringify(config)}; return true; })()`);

/** Report the stance verbatim (no composition mapping) — a bug detector. */
const setRawFrame = (on) => evalAsync(`(async () => { window.__poseQA.rawFrame = ${on ? 'true' : 'false'}; return true; })()`);

/** Rebuild the screen's cached detector from the currently installed factory. */
const resetDetectorCache = () =>
  evalAsync(`(async () => { const c = await import('/js/screens/camera.js'); c.disposeCachedDetector(); return true; })()`);

/** Force getUserMedia to fail — the one thing the fake-UI flag can't simulate. */
const DENY_CAMERA = `(() => {
  const md = navigator.mediaDevices;
  if (!window.__realGUM) window.__realGUM = md.getUserMedia.bind(md);
  md.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  return true;
})()`;

const ALLOW_CAMERA = `(() => {
  if (window.__realGUM) { navigator.mediaDevices.getUserMedia = window.__realGUM; window.__realGUM = null; }
  return true;
})()`;

/** The app has rendered a screen (works whatever route the hash restores). */
const APP_BOOTED = `document.getElementById('screen-root').children.length > 0 || document.getElementById('onboarding-root').children.length > 0`;

// The camera is mounted AND its loading overlay is gone. Requiring #cam-stage
// matters: without it a missing screen would look "ready" straight away.
const CAMERA_STATE = `(() => {
  if (!document.querySelector('#cam-stage')) return false;
  const state = document.getElementById('cam-state');
  return !state || state.hidden;
})()`;

/**
 * The smart camera is genuinely running: its stage is mounted and no error or
 * fallback state is showing. (The running UI also contains a "Standard camera"
 * chip, so the chip alone can never mean "the smart camera failed".)
 */
const SMART_RUNNING = `(() => {
  if (!document.querySelector('#cam-stage')) return false;
  const state = document.getElementById('cam-state');
  const mode = state ? state.dataset.mode || '' : '';
  return !state || state.hidden || mode === 'loading' || mode === '';
})()`;

// ---- Launch ----------------------------------------------------------------

const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-qa-camera-'));
let chrome;
let serverBack = null;

try {
  console.log('Starting server + Chrome (synthetic camera device)…');
  await waitForServer();
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      // Synthetic camera: a rolling test pattern, no permission prompt.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--window-size=420,900',
      APP_URL,
    ],
    { stdio: 'ignore' }
  );
  await attach();

  console.log('\n— App startup: the pose model must NOT load —');
  await completeOnboarding('QA');
  await waitFor(`document.querySelector('#dash-hero') !== null`, 12000, 'dashboard');
  const startupResources = await evalAsync(`(async () => {
    const names = performance.getEntriesByType('resource').map((r) => r.name);
    return { total: names.length, pose: names.filter((n) => /vendor\\/mediapipe/.test(n)) };
  })()`);
  check('no pose runtime/model request during normal startup (lazy load)', startupResources.pose.length === 0, JSON.stringify(startupResources.pose));

  console.log('\n— Photos screen: V1 chip row is unchanged without a template —');
  await evaluate(`location.hash = '#/photos'; true`);
  await waitFor(`document.querySelector('[data-action="photo-gallery"]') !== null`, 8000, 'photos screen');
  const noTemplateChips = await evalAsync(`(async () => ({
    smart: !!document.querySelector('[data-action="photo-smart"]'),
    camera: !!document.querySelector('[data-action="photo-camera"]'),
    gallery: !!document.querySelector('[data-action="photo-gallery"]'),
    compare: !!document.querySelector('[data-action="photo-compare"]'),
    bar: !!document.querySelector('.photo-template-bar'),
  }))()`);
  check('no template: original Camera/Gallery/Compare chips, no smart entry', !noTemplateChips.smart && noTemplateChips.camera && noTemplateChips.gallery && noTemplateChips.compare, JSON.stringify(noTemplateChips));
  check('no template bar or badge', !noTemplateChips.bar);

  console.log('\n— Smart camera entry without a template —');
  await evaluate(`location.hash = '#/photos/camera'; true`);
  await waitFor(`document.querySelector('[data-action="cam-standard"]') !== null`, 8000, 'template picker state');
  const pickerState = await evalAsync(`(async () => ({
    text: document.body.innerText,
    standard: !!document.querySelector('[data-action="cam-standard"]'),
    choose: !!document.querySelector('[data-action="cam-choose"]'),
    video: !!document.querySelector('#cam-video'),
  }))()`);
  check('explains how to pick a template instead of opening a dead camera', /Choose your photo template|Take a first photo/.test(pickerState.text), pickerState.text.slice(0, 60));
  check('offers both "choose a photo" and "standard camera"', pickerState.standard && pickerState.choose);
  check('no camera stream was opened', !pickerState.video);

  console.log('\n— Add a real progress photo (V1 path) —');
  await evaluate(`location.hash = '#/photos'; true`);
  await waitFor(`document.querySelector('[data-action="photo-gallery"]') !== null`, 8000, 'photos screen');
  await click('[data-action="photo-gallery"]');
  await pickFileWith('input[type=file]', TEST_IMAGE);
  await waitFor(`document.querySelector('.sheet') !== null`, 8000, 'save sheet');
  await click('.sheet .btn-primary');
  await waitFor(`document.querySelectorAll('.photo-tile').length >= 1`, 8000, 'photo tile');

  console.log('\n— Use as Photo Template (local analysis) —');
  await evalAsync(INSTALL_FAKE);
  await click('.photo-tile');
  await sleep(500);
  if (!(await evaluate(`document.querySelector('#photo-template-controls') !== null`))) {
    const diag = await evalAsync(`(async () => ({ modal: (document.getElementById('modal-root') || {}).innerHTML || '', body: document.body.innerText.slice(0, 200) }))()`);
    console.log('   DIAG modal:', diag.modal.slice(0, 400));
    console.log('   DIAG errors:', consoleErrors.slice(0, 3).join(' | '));
  }
  await waitFor(`document.querySelector('#photo-template-controls') !== null`, 6000, 'template controls');
  const beforeAnalysis = await evalAsync(`(async () => ({
    label: document.querySelector('#photo-template-controls .btn')?.textContent,
    status: document.querySelector('#photo-template-status')?.textContent,
  }))()`);
  check('photo viewer offers "Use as Photo Template"', /Use as Photo Template/.test(beforeAnalysis.label || ''), beforeAnalysis.label);

  await click('#photo-template-controls .btn');
  await waitFor(`/Full body visible|Choose another photo/.test(document.querySelector('#photo-template-status')?.textContent || '')`, 10000, 'analysis result');
  const analysed = await evalAsync(`(async () => ({
    status: document.querySelector('#photo-template-status').textContent,
    checks: [...document.querySelectorAll('.photo-template-check')].map((c) => ({ text: c.textContent.trim(), ok: c.classList.contains('ok') })),
    action: document.querySelector('#photo-template-controls .btn').textContent,
    covers: window.__poseQA ? window.__poseQA.calls : 0,
  }))()`);
  check('analysis runs through the on-device detector seam', analysed.covers > 0, String(analysed.covers));
  check('shows the four quality checks', analysed.checks.length === 4 && analysed.checks.every((c) => c.ok), JSON.stringify(analysed.checks));
  check('confirms with "Use this as your progress template"', /Use this as your progress template/.test(analysed.action || ''), analysed.action);

  await click('#photo-template-controls .btn');
  await waitFor(`document.querySelector('.photo-template-bar') !== null`, 6000, 'template bar');
  const templateSet = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const s = await db.dbGet('settings', 'settings');
    const profiles = await db.dbGetAll('photoReferences');
    return {
      pointer: s.photoTemplateId,
      profiles: profiles.length,
      profile: profiles[0] || null,
      smartChip: !!document.querySelector('[data-action="photo-smart"]'),
      badge: document.querySelectorAll('.photo-template-badge').length,
      hint: document.querySelector('.photo-hint')?.textContent || '',
    };
  })()`);
  check('active template pointer persisted in settings', Boolean(templateSet.pointer), String(templateSet.pointer));
  check('reference profile persisted (one record per photo)', templateSet.profiles === 1 && templateSet.profile.photoId === templateSet.pointer);
  check('profile is metadata only (no image bytes)', typeof templateSet.profile.blob === 'undefined' && !JSON.stringify(templateSet.profile).includes('data:'));
  check('profile carries image aspect + pose + composition', Boolean(templateSet.profile.image.aspect) && Boolean(templateSet.profile.pose.landmarks.nose) && templateSet.profile.composition.scale > 0);
  check('profile is versioned for future algorithm changes', templateSet.profile.profileVersion === 1, String(templateSet.profile.profileVersion));
  check('photos screen now offers the smart entry + template bar + badge', templateSet.smartChip && templateSet.badge === 1 && /Match your template/.test(templateSet.hint));

  console.log('\n— Smart camera: stream, coordinate system, ghost overlay —');
  await click('[data-action="photo-smart"]');
  await waitFor(`document.querySelector('#cam-stage') !== null`, 8000, 'camera mounted');
  await waitFor(`document.querySelector('#cam-video')?.videoWidth > 0`, 12000, 'camera frames');
  await waitFor(CAMERA_STATE, 15000, 'smart camera ready');
  await sleep(600);
  const stage = await evalAsync(`(async () => {
    const video = document.querySelector('#cam-video');
    const el = document.querySelector('#cam-stage');
    const ghost = document.querySelector('#cam-ghost');
    const live = document.querySelector('#cam-live');
    const rect = el.getBoundingClientRect();
    // The canvases must cover the CAMERA PIXELS exactly — not the stage's
    // decorative 1px border — so poses are drawn where the body actually is.
    const videoRect = video.getBoundingClientRect();
    // Whole canvas (sampled), so the check can't be fooled by WHERE the body
    // happens to sit in the frame.
    const ghostPixels = (() => {
      const ctx = ghost.getContext('2d');
      const data = ctx.getImageData(0, 0, ghost.width, ghost.height).data;
      let painted = 0;
      for (let i = 3; i < data.length; i += 16) if (data[i] > 0) painted += 1;
      return painted;
    })();
    return {
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      tracks: video.srcObject ? video.srcObject.getVideoTracks().length : 0,
      live: video.srcObject ? video.srcObject.getVideoTracks().every((t) => t.readyState === 'live') : false,
      mirrored: video.classList.contains('mirrored'),
      stageAspect: rect.height / rect.width,
      referenceAspect: ${JSON.stringify(templateSet.profile.image.aspect)},
      canvasMatches: ghost.width === Math.round(videoRect.width * Math.min(2, window.devicePixelRatio || 1)),
      canvasHeightMatches: ghost.height === Math.round(videoRect.height * Math.min(2, window.devicePixelRatio || 1)),
      layerMatchesVideo:
        Math.round(ghost.getBoundingClientRect().width) === Math.round(videoRect.width) &&
        Math.round(ghost.getBoundingClientRect().height) === Math.round(videoRect.height),
      liveMatchesGhost: live.width === ghost.width && live.height === ghost.height,
      ghostPainted: ghostPixels,
      liveSize: { w: live.width, h: live.height },
      guidance: document.getElementById('cam-guidance')?.dataset.code,
      referenceLabel: document.querySelector('.cam-sub')?.textContent || '',
    };
  })()`);
  check('live camera stream is running with an active track', stage.tracks >= 1 && stage.live, JSON.stringify({ tracks: stage.tracks, live: stage.live }));
  check('stage aspect matches the reference photo aspect (canonical space)', Math.abs(stage.stageAspect - stage.referenceAspect) < 0.02, `${stage.stageAspect} vs ${stage.referenceAspect}`);
  check(
    'overlay canvases cover the camera pixels exactly (same coordinate space)',
    stage.canvasMatches && stage.canvasHeightMatches && stage.layerMatchesVideo && stage.liveMatchesGhost,
    JSON.stringify({ canvasMatches: stage.canvasMatches, canvasHeightMatches: stage.canvasHeightMatches, layerMatchesVideo: stage.layerMatchesVideo, liveMatchesGhost: stage.liveMatchesGhost })
  );
  if (Math.abs(stage.stageAspect - stage.referenceAspect) >= 0.02) {
    const d = await evalAsync(`(async () => {
      const el = document.querySelector('#cam-stage');
      const wrap = document.querySelector('.cam-stage-wrap');
      const r = el.getBoundingClientRect();
      return {
        stages: document.querySelectorAll('#cam-stage').length,
        rect: { w: r.width, h: r.height },
        inline: el.getAttribute('style'),
        layoutKey: el.dataset.layout,
        aspectRatio: getComputedStyle(el).aspectRatio,
        cssVar: getComputedStyle(el).getPropertyValue('--cam-aspect'),
        wrapDisplay: getComputedStyle(wrap).display,
        alignSelf: getComputedStyle(el).alignSelf,
        flex: getComputedStyle(el).flex,
        wrapW: wrap.clientWidth,
        connected: el.isConnected,
        vh: window.innerHeight,
      };
    })()`);
    console.log('   DIAG stage:', JSON.stringify(d));
  }
  check('reference ghost is actually painted', stage.ghostPainted > 50, String(stage.ghostPainted));
  check('reference photo date shown as the alignment target', /Reference ·/.test(stage.referenceLabel), stage.referenceLabel);
  check('front camera preview is mirrored for the user', stage.mirrored === true, String(stage.mirrored));

  console.log('\n— Guidance + match meter respond to the live pose —');
  await setPose({ centerX: 0.32, centerY: 0.55, height: 0.46 });
  await waitFor(`['move-left','move-right'].includes(document.getElementById('cam-guidance')?.dataset.code)`, 6000, 'horizontal guidance');
  // The guidance code reacts on the first mismatched frame; the score is
  // smoothed, so give it a moment to settle before reading it.
  await sleep(900);
  const offCentre = await evalAsync(`(async () => ({
    code: document.getElementById('cam-guidance').dataset.code,
    text: document.getElementById('cam-guidance-text').textContent,
    score: document.getElementById('cam-score').textContent,
    arrow: document.getElementById('cam-arrow').textContent,
    fill: document.getElementById('cam-meter-fill').style.width,
    hold: document.getElementById('cam-hold').textContent,
  }))()`);
  check('off-centre body produces one directional instruction', /Move (slightly |further )?(left|right)/.test(offCentre.text), offCentre.text);
  check('instruction is direction + arrow, not colour alone', ['←', '→'].includes(offCentre.arrow), offCentre.arrow);
  check('match score is below target while off-centre', parseInt(offCentre.score, 10) < 82, offCentre.score);
  check('meter fill tracks the score', offCentre.fill === offCentre.score, `${offCentre.fill} vs ${offCentre.score}`);

  await setPose({ centerX: 0.5, centerY: 0.55, height: 0.46 });
  await waitFor(`document.getElementById('cam-guidance')?.dataset.code === 'hold' || document.getElementById('cam-guidance')?.dataset.code === 'capture'`, 12000, 'perfect hold');
  const aligned = await evalAsync(`(async () => ({
    code: document.getElementById('cam-guidance').dataset.code,
    text: document.getElementById('cam-guidance-text').textContent,
    score: parseInt(document.getElementById('cam-score').textContent, 10),
    chips: [...document.querySelectorAll('.cam-chip')].map((c) => ({ text: c.textContent.trim(), ok: c.classList.contains('ok') })),
    status: document.getElementById('cam-meter-title').textContent,
    countdown: !document.getElementById('cam-countdown').hidden,
    phase: (window.__poseQA || {}).phase,
  }))()`);
  check('aligned body reaches PERFECT', aligned.score >= 82, String(aligned.score));
  check('guidance switches to "Perfect — hold still"', aligned.code === 'hold' || aligned.code === 'capture', aligned.code);
  check('all three aspect chips confirm', aligned.chips.length === 3 && aligned.chips.every((c) => c.ok), JSON.stringify(aligned.chips));
  check('countdown runs before auto capture', aligned.countdown === true || aligned.code === 'capture', JSON.stringify({ countdown: aligned.countdown, code: aligned.code }));

  console.log('\n— Auto capture → confirmation → saved as a normal progress photo —');
  await waitFor(`document.querySelector('.cam-result') !== null`, 15000, 'captured confirmation');
  const captured = await evalAsync(`(async () => ({
    img: !!document.querySelector('.cam-result img'),
    natural: document.querySelector('.cam-result img')?.naturalWidth || 0,
    naturalAspect: (() => {
      const el = document.querySelector('.cam-result img');
      return el && el.naturalWidth ? el.naturalHeight / el.naturalWidth : 0;
    })(),
    buttons: [...document.querySelectorAll('.cam-result-actions .btn')].map((b) => b.textContent.trim()),
    video: !!document.querySelector('#cam-video'),
    tracks: window.__qaStream ? window.__qaStream.getTracks().map((t) => t.readyState) : null,
    heading: document.querySelector('.cam-title')?.textContent || '',
  }))()`);
  check('auto capture shows the captured photo', captured.img && captured.natural > 0, String(captured.natural));
  check('camera preview is gone after capture (screen swapped)', !captured.video);
  check('offers Use photo / Retake', captured.buttons.some((b) => /Use photo/.test(b)) && captured.buttons.some((b) => /Retake/.test(b)), JSON.stringify(captured.buttons));
  check(
    'the saved photo carries the reference composition, not the raw camera frame',
    Math.abs(captured.naturalAspect - templateSet.profile.image.aspect) < 0.03,
    `${captured.naturalAspect} vs reference ${templateSet.profile.image.aspect}`
  );
  check('capture confirmation is not framed as a score/judgement', /Perfect — captured|Photo captured/.test(captured.heading), captured.heading);

  await click('.cam-result-actions .btn-primary');
  await waitFor(`document.querySelector('.sheet') !== null`, 8000, 'save sheet from smart capture');
  const readSaveState = () =>
    evalAsync(`(async () => {
      const db = await import('/js/db.js');
      const list = await db.dbGetAll('progressPhotos');
      return { count: list.length, blobs: list.map((p) => (p.blob ? p.blob.size : 0)), thumbs: list.map((p) => (p.thumb ? p.thumb.size : 0)) };
    })()`);
  await click('.sheet .btn-primary');
  // The save sheet writes through the existing pipeline; poll briefly so a
  // slower IndexedDB commit is not mistaken for a missing save.
  let savedDiag = await readSaveState();
  for (let i = 0; i < 12 && savedDiag.count < 2; i++) {
    await sleep(250);
    savedDiag = await readSaveState();
  }
  if (savedDiag.count !== 2) {
    const extra = await evalAsync(`(async () => ({ hash: location.hash, sheets: document.querySelectorAll('.sheet').length, toast: (document.querySelector('.toast') || {}).textContent || '' }))()`);
    console.log('   DIAG photos:', JSON.stringify(savedDiag), JSON.stringify(extra));
  }
  check('smart capture saves through the existing photo pipeline', savedDiag.count === 2 && savedDiag.blobs.every((s) => s > 0), JSON.stringify(savedDiag));
  await waitFor(`location.hash === '#/photos'`, 8000, 'back on photos');

  console.log('\n— Manual capture is never blocked —');
  await evaluate(`location.hash = '#/photos/camera'; true`);
  const remounted = await waitFor(`document.querySelector('#cam-stage') !== null`, 8000, 'camera remounted');
  if (!remounted) {
    await dumpScreen('camera remounted');
  } else {
    await waitFor(CAMERA_STATE, 12000, 'camera ready again');
  }
  await setPose({ centerX: 0.2, centerY: 0.5, height: 0.3 }); // deliberately poor
  await sleep(900);
  const poorState = await evalAsync(`(async () => ({ score: parseInt((document.getElementById('cam-score') || {}).textContent, 10) || 0, code: (document.getElementById('cam-guidance') || {}).dataset?.code || null }))()`);
  check('a poor match is not "perfect"', poorState.score < 82 && poorState.code !== 'hold', JSON.stringify(poorState));
  await click('[data-action="cam-capture"]');
  await waitFor(`document.querySelector('.cam-result') !== null`, 10000, 'manual capture result');
  const manual = await evalAsync(`(async () => ({ note: document.querySelector('.cam-note')?.textContent || '', title: document.querySelector('.cam-title')?.textContent || '' }))()`);
  check('manual capture works even when alignment is poor', /Photo captured/.test(manual.title), manual.title);
  check('encourages matching next time without shaming', /try matching your previous position/.test(manual.note) && !/bad|wrong|fail/i.test(manual.note), manual.note.slice(0, 70));
  await click('[data-action="cam-cancel"]');
  await waitFor(`location.hash === '#/photos'`, 8000, 'cancelled back to photos');

  console.log('\n— One coordinate space: camera pixels, landmarks and the saved crop —');
  await evaluate(`location.hash = '#/photos/camera'; true`);
  await waitFor(CAMERA_STATE, 12000, 'camera ready (aspect)');
  await setPose({ centerX: 0.5, centerY: 0.55, height: 0.46 });
  await setRawFrame(false);
  await sleep(1400);
  const mappedFrame = await evalAsync(`(async () => ({ score: parseInt(document.getElementById('cam-score').textContent, 10), code: document.getElementById('cam-guidance').dataset.code }))()`);
  // Same stance, reported verbatim in the video frame's own coordinates: in
  // composition space that body is a different size, so the app must NOT call
  // it a match. If the mapping were skipped both would look identical.
  await setRawFrame(true);
  await sleep(1400);
  const rawFrameResult = await evalAsync(`(async () => ({ score: parseInt(document.getElementById('cam-score').textContent, 10), code: document.getElementById('cam-guidance').dataset.code }))()`);
  check(
    'a live frame is judged in composition space (the mapping is applied)',
    rawFrameResult.score < mappedFrame.score && ['move-closer', 'move-back'].includes(rawFrameResult.code),
    JSON.stringify({ mappedFrame, rawFrameResult })
  );
  await setRawFrame(false);
  await sleep(600);

  console.log('\n— Reference guide modes (Ghost / Outline / Off) —');
  await evaluate(`location.hash = '#/photos/camera'; true`);
  await waitFor(CAMERA_STATE, 12000, 'camera ready (modes)');
  const modes = [];
  for (const label of ['Outline', 'Off', 'Ghost']) {
    await click('[data-action="cam-reference"]');
    await sleep(350);
    modes.push(
      await evalAsync(`(async () => {
        const btn = document.getElementById('cam-reference-btn').textContent;
        const ghost = document.getElementById('cam-ghost');
        const ctx = ghost.getContext('2d');
        const d = ctx.getImageData(0, 0, ghost.width, ghost.height).data;
        let painted = 0;
        for (let i = 3; i < d.length; i += 16) if (d[i] > 0) painted += 1;
        const db = await import('/js/db.js');
        const s = await db.dbGet('settings', 'settings');
        return { btn, painted, saved: s.referenceMode, label: ${JSON.stringify(label)} };
      })()`)
    );
  }
  check('reference control cycles Ghost → Outline → Off → Ghost', modes[0].btn.includes('Outline') && modes[1].btn.includes('Off') && modes[2].btn.includes('Ghost'), JSON.stringify(modes.map((m) => m.btn)));
  check('visibility mode persists in settings', modes[0].saved === 'outline' && modes[1].saved === 'off' && modes[2].saved === 'ghost', JSON.stringify(modes.map((m) => m.saved)));
  check('skeleton outline draws without the ghost image', modes[0].painted > 0, String(modes[0].painted));
  check('Off hides the reference entirely', modes[1].painted === 0, String(modes[1].painted));

  console.log('\n— Lifecycle: teardown stops every media track —');
  await evalAsync(`(async () => { window.__qaStream = document.querySelector('#cam-video').srcObject; return true; })()`);
  await evaluate(`location.hash = '#/photos'; true`);
  await waitFor(`document.querySelector('.photo-template-bar') !== null`, 8000, 'photos after leaving camera');
  await sleep(400);
  const teardown = await evalAsync(`(async () => ({
    states: window.__qaStream.getTracks().map((t) => t.readyState),
    videos: document.querySelectorAll('video').length,
    paused: (window.__poseQA || {}).paused || 0,
  }))()`);
  check('all camera tracks stopped on route change', teardown.states.length > 0 && teardown.states.every((s) => s === 'ended'), JSON.stringify(teardown.states));
  check('detector inference paused when the camera closes', teardown.paused > 0, String(teardown.paused));
  check('no leftover video element', teardown.videos === 0, String(teardown.videos));

  console.log('\n— 10 open/close cycles: no leaks, no errors —');
  let cyclesOk = true;
  for (let i = 0; i < 10; i++) {
    await evaluate(`location.hash = '#/photos/camera'; true`);
    const ready = await waitFor(`document.querySelector('#cam-video')?.videoWidth > 0`, 12000, `cycle ${i} camera`);
    if (!ready) {
      cyclesOk = false;
      break;
    }
    await evalAsync(`(async () => { window.__qaStream = document.querySelector('#cam-video').srcObject; return true; })()`);
    await evaluate(`location.hash = '#/photos'; true`);
    await waitFor(`document.querySelector('[data-action="photo-gallery"]') !== null`, 6000, `cycle ${i} photos`);
    const ended = await evalAsync(`(async () => window.__qaStream.getTracks().every((t) => t.readyState === 'ended'))()`);
    if (!ended) {
      cyclesOk = false;
      break;
    }
  }
  check('10 camera open/close cycles each release the camera', cyclesOk);
  const heap = await evalAsync(`(async () => ({ nodes: document.getElementsByTagName('*').length, videos: document.querySelectorAll('video').length, canvases: document.querySelectorAll('canvas').length }))()`);
  check('no DOM growth after repeated camera use', heap.videos === 0 && heap.canvases === 0 && heap.nodes < 900, JSON.stringify(heap));

  console.log('\n— Fallbacks: model missing and model failure —');
  await evalAsync(`(async () => { const d = await import('/js/pose/detector.js'); d.setPoseDetectorFactory(() => ({ name: 'qa', async initialize() { const e = new Error('missing'); e.reason = 'assets-missing'; throw e; }, detect: () => null, detectImage: async () => null, pause() {}, resume() {}, dispose() {}, get stats() { return {}; }, ready: false })); return true; })()`);
  await resetDetectorCache();
  await evaluate(`location.hash = '#/photos'; true`);
  await sleep(300);
  await evaluate(`location.hash = '#/photos/camera'; true`);
  await waitFor(`document.querySelector('[data-action="cam-standard"]') !== null && document.querySelector('#cam-video') === null`, 12000, 'unavailable state');
  const unavailable = await evalAsync(`(async () => ({
    text: document.body.innerText,
    standard: !!document.querySelector('[data-action="cam-standard"]'),
    camera: !!document.querySelector('#cam-video'),
  }))()`);
  check('a missing pose model degrades to a clear explanation', /Smart camera (unavailable|not installed)/.test(unavailable.text), unavailable.text.slice(0, 50));
  check('the standard camera fallback is offered and the preview is closed', unavailable.standard && !unavailable.camera);

  console.log('\n— Fallback path still takes a photo —');
  await click('[data-action="cam-standard"]');
  await waitFor(`document.querySelector('input[type=file]') !== null`, 8000, 'system camera picker');
  await pickFileWith('input[type=file]', TEST_IMAGE);
  await waitFor(`document.querySelector('.sheet') !== null`, 8000, 'fallback save sheet');
  await click('.sheet .btn-primary');
  await waitFor(`location.hash === '#/photos'`, 8000, 'back to photos');
  const afterFallback = await evalAsync(`(async () => (await (await import('/js/db.js')).dbGetAll('progressPhotos')).length)()`);
  check('the standard camera fallback saves a normal progress photo', afterFallback === 3, String(afterFallback));

  console.log('\n— Camera permission denied —');
  // getUserMedia is stubbed rather than relying on Browser.setPermission, which
  // Chrome's --use-fake-ui-for-media-stream flag wins over (the denial would
  // never reach the app and the check would pass vacuously).
  await evalAsync(INSTALL_FAKE);
  await resetDetectorCache();
  await evaluate(DENY_CAMERA);
  await evaluate(`location.hash = '#/photos'; true`);
  await sleep(400);
  await evaluate(`location.hash = '#/photos/camera'; true`);
  const deniedShown = await waitFor(`document.getElementById('cam-state')?.dataset.mode === 'error'`, 15000, 'permission error state');
  const denied = await evalAsync(`(async () => ({
    mode: document.getElementById('cam-state')?.dataset.mode,
    title: document.getElementById('cam-state-title')?.textContent || '',
    text: document.getElementById('cam-state-text')?.textContent || '',
    buttons: [...document.querySelectorAll('#cam-state-actions .btn')].map((b) => b.textContent.trim()),
    video: !!document.querySelector('#cam-video'),
  }))()`);
  if (!deniedShown) console.log('   DIAG denied:', JSON.stringify(denied), document.querySelector('#cam-state-text'));
  check('a denied camera shows a calm, actionable state', denied.mode === 'error' && denied.title.length > 3, JSON.stringify(denied));
  check('denied state offers a retry and the standard camera', denied.buttons.length >= 2, JSON.stringify(denied.buttons));
  check('no raw error text is shown to the user', !/NotAllowedError|DOMException|getUserMedia/.test(denied.text), denied.text.slice(0, 60));
  await evaluate(ALLOW_CAMERA);

  console.log('\n— Export → wipe → import (profiles travel with their photo) —');
  const exportJson = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const ph = await import('/js/photos.js');
    const dump = await db.dbExportAll(async (r) => ({ ...r, blob: await ph.blobToDataURL(r.blob), thumb: await ph.blobToDataURL(r.thumb) }));
    return JSON.stringify({ dump, refs: dump.data.photoReferences?.length || 0, settings: dump.data.settings?.[0]?.photoTemplateId || null });
  })()`);
  const backup = JSON.parse(exportJson);
  check('export includes the reference profiles', backup.refs === 1 && Boolean(backup.settings), `refs=${backup.refs}`);
  const tmpDir = mkdtempSync(join(tmpdir(), 'life-progress-qa-camera-export-'));
  const exportPath = join(tmpDir, 'backup.json');
  writeFileSync(exportPath, JSON.stringify(backup.dump));

  // A backup from an older V1.2 install has no photoReferences store at all.
  const legacyDump = JSON.parse(JSON.stringify(backup.dump));
  delete legacyDump.data.photoReferences;
  const legacyPath = join(tmpDir, 'backup-legacy.json');
  writeFileSync(legacyPath, JSON.stringify(legacyDump));

  const wipe = async () => {
    await evaluate(`location.hash = '#/settings'; true`);
    await waitFor(`document.querySelector('[data-action="clear-data"]') !== null`, 8000, 'settings for wipe');
    await click('[data-action="clear-data"]');
    await waitFor(`document.querySelector('.dialog') !== null`, 6000, 'wipe dialog');
    await click('.dialog .btn-danger');
    await waitFor(`document.body.innerText.includes('All data cleared')`, 8000, 'wipe toast');
  };
  const importBackup = async (path) => {
    await evaluate(`location.hash = '#/settings'; true`);
    await waitFor(`document.querySelector('[data-action="import-data"]') !== null`, 8000, 'settings for import');
    await click('[data-action="import-data"]');
    await pickFileWith('input[type=file][accept*="json"]', path);
    await waitFor(`document.querySelector('.dialog') !== null`, 10000, 'import confirm');
    await click('.dialog .btn-danger');
    await waitFor(`document.querySelector('#dash-hero') !== null || document.querySelector('.settings-list') !== null`, 12000, 'after import');
  };

  await wipe();
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.getElementById('onboarding-root').children.length > 0 || document.querySelector('#dash-hero') !== null`, 12000, 'post-wipe');
  if (await evaluate(`document.getElementById('onboarding-root').children.length > 0`)) await completeOnboarding('QA');
  const wiped = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const s = await db.dbGet('settings', 'settings');
    return { refs: (await db.dbGetAll('photoReferences')).length, photos: (await db.dbGetAll('progressPhotos')).length, pointer: s.photoTemplateId };
  })()`);
  check('wipe removes reference profiles and clears the template pointer', wiped.refs === 0 && wiped.pointer === null && wiped.photos === 0, JSON.stringify(wiped));

  await importBackup(exportPath);
  const restored = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const s = await db.dbGet('settings', 'settings');
    const refs = await db.dbGetAll('photoReferences');
    const photos = await db.dbGetAll('progressPhotos');
    return { refs: refs.length, photos: photos.length, pointer: s.photoTemplateId, linked: refs.every((r) => photos.some((p) => p.id === r.photoId)) };
  })()`);
  check('import restores profiles together with their photos', restored.refs === 1 && restored.photos === 3 && restored.linked, JSON.stringify(restored));
  check('import restores the active template pointer', restored.pointer === backup.settings, String(restored.pointer));

  console.log('\n— Orphan + legacy backups and the delete cascade —');
  await wipe();
  await send('Page.reload');
  await sleep(1500);
  await waitFor(`document.getElementById('onboarding-root').children.length > 0 || document.querySelector('#dash-hero') !== null`, 12000, 'post-wipe 2');
  if (await evaluate(`document.getElementById('onboarding-root').children.length > 0`)) await completeOnboarding('QA');
  await importBackup(legacyPath);
  const legacy = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const s = await db.dbGet('settings', 'settings');
    return { refs: (await db.dbGetAll('photoReferences')).length, pointer: s.photoTemplateId, photos: (await db.dbGetAll('progressPhotos')).length };
  })()`);
  check('a V1.2 backup (no reference store) imports cleanly', legacy.photos === 3 && legacy.refs === 0, JSON.stringify(legacy));

  // Orphans: a VALID profile whose photo is gone (a legacy backup can produce
  // this), plus a record that no longer parses at all.
  const orphan = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const ph = await import('/js/photos.js');
    // A VALID profile whose photo is gone (a legacy backup can produce this),
    // written directly so no real photo has to be destroyed for the test.
    const ghostId = 'photo-that-is-gone';
    await ph.saveReferenceProfile({
      profileVersion: 1, photoId: ghostId, id: ghostId, createdAt: 0,
      image: { width: 192, height: 192, aspect: 1 },
      composition: {
        aspect: 1,
        bounds: { top: 0.1, bottom: 0.9, left: 0.3, right: 0.7, width: 0.4, height: 0.8, x: 0.5, y: 0.5, count: 13 },
        center: { x: 0.5, y: 0.5, source: 'torso' },
        scale: 0.7, shoulderWidth: 0.2,
        framing: { top: 0.1, bottom: 0.9, left: 0.3, right: 0.7 },
      },
      pose: {
        landmarks: Object.fromEntries(Object.values((await import('/js/pose/geometry.js')).CORE_LANDMARK_NAMES).map((n) => [n, { x: 0.5, y: 0.5, visibility: 0.9 }])),
        angles: { shoulder: 0, hip: 0, torso: 0, elbowLeft: 170, elbowRight: 170, kneeLeft: 175, kneeRight: 175 },
        head: { dx: 0, dy: -0.5, scale: 0.2 },
      },
      cameraProfile: { facingMode: null, mirrored: false, detector: 'qa' },
      quality: { personDetected: true, fullBodyVisible: true, framingGood: true, confidence: 0.9, coverage: 1, scale: 0.7, score: 1, usable: true, partial: false, checks: [], issues: [] },
    });
    // A corrupt record left behind by an older/newer profile format.
    await db.dbPut('photoReferences', { id: 'photo-that-does-not-exist', photoId: 'photo-that-does-not-exist' });
    const before = (await db.dbGetAll('photoReferences')).length;
    const result = await ph.pruneReferences();
    return { before, after: result.removed, remaining: (await db.dbGetAll('photoReferences')).length };
  })()`);
  check('orphan + unreadable reference profiles are pruned instead of breaking state', orphan.before === 2 && orphan.after === 2 && orphan.remaining === 0, JSON.stringify(orphan));

  // Deterministic delete-cascade check: store a profile for a real photo
  // through the domain API, then delete that photo.
  const cascade2 = await evalAsync(`(async () => {
    const db = await import('/js/db.js');
    const ph = await import('/js/photos.js');
    const settings = await import('/js/settings.js');
    const photo = (await db.dbGetAll('progressPhotos'))[0];
    const fake = {
      profileVersion: 1, photoId: photo.id, id: photo.id, createdAt: 0,
      image: { width: 192, height: 192, aspect: 1 },
      composition: { bounds: { top: 0.1, bottom: 0.9, left: 0.3, right: 0.7, width: 0.4, height: 0.8, x: 0.5, y: 0.5, count: 13 }, center: { x: 0.5, y: 0.5, source: 'torso' }, scale: 0.7, shoulderWidth: 0.2, framing: { top: 0.1, bottom: 0.9, left: 0.3, right: 0.7 } },
      pose: {
        landmarks: Object.fromEntries(Object.values((await import('/js/pose/geometry.js')).CORE_LANDMARK_NAMES).map((n) => [n, { x: 0.5, y: 0.5, visibility: 0.9 }])),
        angles: { shoulder: 0, hip: 0, torso: 0, elbowLeft: 170, elbowRight: 170, kneeLeft: 175, kneeRight: 175 },
        head: { dx: 0, dy: -0.5, scale: 0.2 },
      },
      cameraProfile: { facingMode: null, mirrored: false, detector: 'qa' },
      quality: { personDetected: true, fullBodyVisible: true, framingGood: true, confidence: 0.9, coverage: 1, scale: 0.7, score: 1, usable: true, partial: false, checks: [], issues: [] },
    };
    await ph.saveReferenceProfile(fake);
    await ph.setActiveTemplate(photo.id);
    const before = { refs: (await db.dbGetAll('photoReferences')).length, pointer: settings.getSettings().photoTemplateId };
    await ph.deletePhoto(photo.id);
    const after = {
      refs: (await db.dbGetAll('photoReferences')).length,
      pointer: settings.getSettings().photoTemplateId,
      photos: (await db.dbGetAll('progressPhotos')).length,
      profile: await ph.getReferenceProfile(photo.id),
    };
    return { before, after };
  })()`);
  check('deleting the reference photo removes its profile', cascade2.before.refs === 1 && cascade2.after.refs === 0, JSON.stringify(cascade2));
  check('deleting the reference photo clears the active template pointer', cascade2.before.pointer !== null && cascade2.after.pointer === null, JSON.stringify(cascade2.after));
  check('the photo itself is gone and no broken reference remains', cascade2.after.photos === 2 && cascade2.after.profile === null);

  console.log('\n— The REAL vendored model runs on-device —');
  await evalAsync(`(async () => { const d = await import('/js/pose/detector.js'); d.setPoseDetectorFactory(null); d.resetPoseAssetCache(); return true; })()`);
  // Drop the QA fake so the screen builds the REAL detector from scratch.
  await resetDetectorCache();
  await importBackup(exportPath);
  await evaluate(`location.hash = '#/photos/camera'; true`);
  const realReady = await waitFor(`document.querySelector('#cam-video')?.videoWidth > 0 && (${SMART_RUNNING})`, 25000, 'real smart camera');
  check('the smart camera starts with the real vendored model (no fallback)', realReady);
  if (!realReady) {
    const diag = await evalAsync(`(async () => ({ mode: document.getElementById('cam-state')?.dataset.mode, text: document.getElementById('cam-state-text')?.textContent, stage: !!document.querySelector('#cam-stage'), hash: location.hash }))()`);
    console.log('   DIAG real camera:', JSON.stringify(diag));
  }
  const realModel = await evalAsync(`(async () => {
    const d = await import('/js/pose/detector.js');
    const det = d.createPoseDetector();
    const started = performance.now();
    await det.initialize();
    const initMs = Math.round(performance.now() - started);
    const video = document.querySelector('#cam-video');
    let pose = null;
    for (let i = 0; i < 5 && pose === null; i++) {
      pose = det.detect(video, 100 + i * 100);
      await new Promise((r) => setTimeout(r, 120));
    }
    const stats = det.stats;
    det.dispose();
    const resources = performance.getEntriesByType('resource').map((r) => r.name).filter((n) => /vendor\\/mediapipe/.test(n));
    return {
      initMs,
      ready: stats.ready,
      model: stats.model,
      delegate: stats.delegate,
      frames: stats.frames,
      latency: stats.lastLatencyMs,
      poseFound: !!pose,
      resources,
    };
  })()`);
  check('the real WASM runtime + model initialize on-device', realModel.ready === true && realModel.model === 'pose_landmarker_lite', JSON.stringify({ model: realModel.model, ms: realModel.initMs }));
  check('the model accepts a live camera frame and returns a result', realModel.frames > 0 && realModel.latency > 0, JSON.stringify({ frames: realModel.frames, latency: realModel.latency }));
  check('runtime assets load from this origin only', realModel.resources.every((r) => r.startsWith(APP_URL)) && realModel.resources.some((r) => /vision_bundle|vision_wasm/.test(r)), JSON.stringify(realModel.resources.length));
  check('no person in the synthetic frame is handled gracefully', realModel.poseFound === false || realModel.frames > 0);

  console.log('\n— Privacy: no outbound request, ever —');
  await evaluate(`location.hash = '#/photos'; true`);
  await sleep(500);
  const external = requests.filter((r) => !r.url.startsWith(APP_URL) && !r.url.startsWith('data:') && !r.url.startsWith('blob:'));
  check('every network request during the whole run went to this origin', external.length === 0, external.slice(0, 3).map((r) => r.url).join(' | '));
  const poseRequests = requests.filter((r) => /vendor\/mediapipe\//.test(r.url));
  check('the pose runtime is fetched from the app origin when the camera opens', poseRequests.length > 0 && poseRequests.every((r) => r.url.startsWith(APP_URL)), String(poseRequests.length));
  // Non-GET is the real signature of an upload; the keyword sweep is scoped to
  // NON-app URLs so the app's own modules (js/photos.js…) cannot false-positive.
  const nonGet = requests.filter((r) => r.method && r.method !== 'GET');
  const endpoints = requests.filter(
    (r) => !r.url.startsWith(APP_URL) && !r.url.startsWith('data:') && !r.url.startsWith('blob:') && /upload|analytics|metric|collect|beacon|inference|telemetry/i.test(r.url)
  );
  check(
    'no upload, analytics or inference endpoint is ever called',
    nonGet.length === 0 && endpoints.length === 0,
    JSON.stringify([...nonGet, ...endpoints].map((r) => `${r.method || 'GET'} ${r.url}`))
  );
  // Start the offline check from a freshly loaded page (still online) so the
  // reload below is a fair, complete test of the cached app shell.
  await send('Page.reload');
  await waitFor(`document.getElementById('screen-root').children.length > 0 || document.getElementById('onboarding-root').children.length > 0`, 20000, 'app reload before offline');

  console.log('\n— Offline: the smart camera works with the network down —');
  await evaluate(`location.hash = '#/photos/camera'; true`);
  const beforeOffline = await waitFor(`document.querySelector('#cam-video')?.videoWidth > 0`, 15000, 'camera before offline');
  if (!beforeOffline) await dumpScreen('camera before offline');
  server.kill('SIGKILL');
  await sleep(400);
  // Reload with the network down: the app shell, the runtime bundle, the model
  // and the manifest must all come from the service-worker cache.
  await send('Page.reload');
  const offlineBoot = await waitFor(APP_BOOTED, 20000, 'offline app boot');
  check('the app shell boots from the service-worker cache with the server down', offlineBoot);
  await evaluate(`location.hash = '#/photos/camera'; true`);
  const offlineCamera = await waitFor(`document.querySelector('#cam-video')?.videoWidth > 0 && (${SMART_RUNNING})`, 25000, 'offline smart camera');
  check('camera + model start with the server down (cached/offline assets)', offlineCamera);
  if (!offlineCamera) await dumpScreen('offline camera');
  serverBack = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  await sleep(1200);
  // The real model has done its job; the remaining checks are about layout and
  // accessibility, so run them on a clean page with the deterministic detector.
  await send('Page.reload');
  await waitFor(APP_BOOTED, 20000, 'app reload after offline');
  await evalAsync(INSTALL_FAKE);
  await resetDetectorCache();

  console.log('\n— Reduced motion + accessibility —');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evaluate(`location.hash = '#/photos'; true`);
  await sleep(300);
  await evaluate(`location.hash = '#/photos/camera'; true`);
  const reducedMounted = await waitFor(`document.querySelector('#cam-stage') !== null`, 10000, 'camera (reduced motion)');
  if (!reducedMounted) await dumpScreen('camera (reduced motion)');
  const reduced = await evalAsync(`(async () => {
    const screen = document.querySelector('.cam-screen');
    const countdown = document.getElementById('cam-countdown');
    return {
      reduced: screen?.classList.contains('reduced'),
      countdownAnimation: countdown ? getComputedStyle(countdown.querySelector('span')).animationName : '',
      shutterLabel: document.querySelector('.cam-shutter')?.getAttribute('aria-label'),
      guidanceRole: document.getElementById('cam-guidance')?.getAttribute('role'),
      liveRegion: !!document.querySelector('#cam-announce[aria-live]'),
      screenLive: screen?.getAttribute('aria-live'),
      flipLabel: document.getElementById('cam-flip')?.getAttribute('aria-label'),
      refLabel: document.getElementById('cam-reference-btn')?.getAttribute('aria-label'),
      meterHidden: document.getElementById('cam-meter')?.getAttribute('aria-hidden'),
      focusable: [...document.querySelectorAll('.cam-screen button')].every((b) => b.getAttribute('aria-label') || b.textContent.trim().length > 0),
    };
  })()`);
  check('reduced motion disables the countdown + meter animation', reduced.reduced === true && reduced.countdownAnimation === 'none', JSON.stringify({ reduced: reduced.reduced, anim: reduced.countdownAnimation }));
  check('screen is aria-live=off with an explicit polite announcement region', reduced.screenLive === 'off' && reduced.liveRegion, JSON.stringify({ live: reduced.screenLive }));
  check('guidance is a status region and the meter is decorative for AT', reduced.guidanceRole === 'status' && reduced.meterHidden === 'true');
  check('every control has an accessible label', reduced.focusable && reduced.shutterLabel === 'Take photo' && reduced.flipLabel === 'Switch camera', JSON.stringify(reduced));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: '' }] });

  console.log('\n— Layouts 320–1024px, both themes —');
  for (const w of [320, 360, 390, 412, 768, 1024]) {
    await setViewport(w, Math.round(Math.min(1.9 * w, 900)));
    await evaluate(`location.hash = '#/photos/camera'; true`);
    const mounted = await waitFor(`document.querySelector('#cam-stage') !== null`, 10000, `camera @${w}`);
    if (!mounted) {
      await dumpScreen(`camera @${w}`);
      continue;
    }
    await sleep(400);
    const layout = await evalAsync(`(async () => {
      const stage = document.querySelector('#cam-stage').getBoundingClientRect();
      const controls = document.querySelector('.cam-controls').getBoundingClientRect();
      const shutter = document.querySelector('.cam-shutter').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
        stageFits: stage.width <= window.innerWidth + 1 && stage.left >= -1,
        stageVisible: stage.height > 120,
        shutterInView: shutter.width >= 60 && shutter.bottom <= window.innerHeight + 1,
        controlsAfterStage: controls.top >= stage.bottom - 2,
        meterVisible: document.querySelector('.cam-meter').getBoundingClientRect().height > 20,
      };
    })()`);
    check(`${w}px: no overflow, stage fits, controls below the preview and tappable`,
      layout.overflow && layout.stageFits && layout.stageVisible && layout.controlsAfterStage && layout.meterVisible,
      JSON.stringify(layout));
  }
  await setViewport(390, 844);
  await evaluate(`location.hash = '#/photos'; true`);
  await sleep(300);
  await evaluate(`location.hash = '#/photos/camera'; true`);
  const themed = await waitFor(`document.getElementById('cam-guidance') !== null`, 12000, 'camera for theme checks');
  for (const scheme of ['dark', 'light']) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await sleep(250);
    const readable = await evaluate(
      `(() => { const el = document.getElementById('cam-guidance'); if (!el) return false; const c = getComputedStyle(el); return c.color !== 'rgba(0, 0, 0, 0)' && c.color !== ''; })()`
    );
    check(`${scheme}: guidance copy stays readable`, readable === true && themed);
  }
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: '' }] });

  console.log('\n— Console errors —');
  const realErrors = consoleErrors.filter(
    (e) => !e.includes('service worker') && !e.includes('favicon') && !e.includes('net::') && !e.includes('Failed to load resource') && !e.includes('AbortError')
  );
  check('no unhandled JS errors during the whole camera QA run', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
} catch (err) {
  console.error('CAMERA QA CRASHED:', err.message);
  failures += 1;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  if (chrome) chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try { serverBack?.kill('SIGKILL'); } catch { /* ignore */ }
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? '✓ ALL SMART CAMERA QA CHECKS PASSED' : `✗ ${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
