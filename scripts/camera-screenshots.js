/**
 * Captures the smart progress camera UI into /screenshots (V1.3).
 *
 * Uses a synthetic camera device plus the deterministic detector seam (the same
 * one scripts/qa-camera.js drives) so every state — no template, aligning,
 * matched, outline mode, captured result — can be photographed without a human
 * standing in front of the lens.
 *
 * Run: node scripts/camera-screenshots.js
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8097;
const DEBUG_PORT = 9229;
const APP_URL = `http://localhost:${PORT}/`;
const TEST_IMAGE = join(ROOT, 'icons', 'icon-192.png');
const OUT = join(ROOT, 'screenshots');

let ws;
let nextId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connect(url) {
  ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, replMode: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Await an in-page async expression. Runtime.evaluate's awaitPromise is not
 * reliable for module/async work here, so the result is parked on `window` and
 * polled — the same proven pattern the other QA scripts use.
 */
let qaSeq = 0;
async function evalAsync(expression) {
  const seq = ++qaSeq;
  await evaluate(`window.__shotSeq = ${seq}; window.__shotResult = null;`);
  await evaluate(`
    (async () => {
      try {
        window.__shotResult = { seq: window.__shotSeq, value: JSON.stringify(await (${expression})) };
      } catch (err) {
        window.__shotResult = { seq: window.__shotSeq, value: JSON.stringify({ __err: String((err && err.message) || err) }) };
      }
    })()
  `);
  for (let i = 0; i < 400; i++) {
    const raw = await evaluate(`window.__shotResult && window.__shotResult.seq === ${seq} ? window.__shotResult.value : null`);
    if (raw != null) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.__err) throw new Error(parsed.__err);
      return parsed;
    }
    await sleep(50);
  }
  throw new Error('evalAsync timed out: ' + String(expression).slice(0, 60));
}

async function waitFor(expr, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evaluate(expr)) return true;
    } catch {
      /* mid-navigation */
    }
    await sleep(150);
  }
  throw new Error('waitFor timeout: ' + expr);
}

const click = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.click()`);

async function shot(name) {
  await sleep(800); // let the animation settle
  const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
  console.log(`  saved screenshots/${name}.png`);
}

const setViewport = async (width, height) => {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
};

const setTheme = (scheme) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });

// --- Deterministic detector seam (see scripts/qa-camera.js) -----------------
const FAKE_DETECTOR = `(() => {
  const state = { config: { centerX: 0.5, centerY: 0.55, height: 0.46, visibility: 0.95 }, rawFrame: false, calls: 0 };
  window.__poseQA = state;
  const build = (source, ts, kind) => {
    state.calls += 1;
    const w = (source && (source.videoWidth || source.width || source.naturalWidth)) || 192;
    const h = (source && (source.videoHeight || source.height || source.naturalHeight)) || 192;
    let raw = window.__poseRaw(state.config);
    if (kind === 'video') raw = window.__poseFrame(raw, h / w, window.__qaCompositionAspect);
    return window.__normalizePose(raw, { timestamp: ts || 0, imageWidth: w, imageHeight: h, source: kind });
  };
  return function factory() {
    return {
      name: 'shot-detector',
      async initialize() { return { ready: true }; },
      detect(source, ts) { return build(source, ts, 'video'); },
      async detectImage(source) { return build(source, 0, 'image'); },
      pause() {}, resume() {}, dispose() {},
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
  window.__qaCompositionAspect = 1;
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
  const c = await import('/js/screens/camera.js');
  c.disposeCachedDetector();
  return true;
})()`;

const setPose = (config) => evalAsync(`(async () => { window.__poseQA.config = ${JSON.stringify(config)}; return true; })()`);

const CAMERA_READY = `(() => {
  const s = document.getElementById('cam-state');
  return !!document.querySelector('#cam-stage') && (!s || s.hidden);
})()`;

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10000;
    const tryOnce = () => {
      http
        .get(`http://localhost:${PORT}/index.html`, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => (Date.now() > deadline ? reject(new Error('server did not start')) : setTimeout(tryOnce, 200)));
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
}

async function pickFileWith(selector, filePath) {
  await waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  const doc = await send('DOM.getDocument', { depth: 0 });
  const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
}

async function openSmartCamera() {
  await evaluate(`location.hash = '#/photos'; true`);
  await waitFor(`document.querySelector('[data-action="photo-smart"]') !== null`);
  await click('[data-action="photo-smart"]');
  await waitFor(`document.querySelector('#cam-video')?.videoWidth > 0`, 20000);
  await waitFor(CAMERA_READY, 20000);
}

async function closeCamera() {
  await click('[data-action="cam-back"]');
  await waitFor(`document.querySelector('[data-action="photo-smart"]') !== null`);
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profileDir = mkdtempSync(join(tmpdir(), 'life-progress-shots-camera-'));
let chrome;

try {
  console.log('Starting server + Chrome (synthetic camera)…');
  await waitForServer();
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
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
  await setViewport(390, 844);
  await setTheme('dark');

  // Onboarding
  await waitFor(`document.getElementById('onboarding-root').children.length > 0`, 15000);
  for (let i = 0; i < 2; i++) {
    await click('.onboarding #ob-next');
    await sleep(250);
  }
  await evaluate(`document.getElementById('ob-name').value = 'Alex'`);
  await click('.onboarding #ob-next');
  await sleep(200);
  for (let i = 0; i < 3; i++) {
    await click('.onboarding #ob-next');
    await sleep(200);
  }
  await waitFor(`document.querySelector('#dash-hero') !== null`, 15000);

  console.log('\n— No-template state —');
  await evaluate(`location.hash = '#/photos/camera'; true`);
  await waitFor(`document.querySelector('[data-action="cam-standard"]') !== null`);
  await shot('camera-no-template-dark');

  console.log('\n— Template flow —');
  await evaluate(`location.hash = '#/photos'; true`);
  await waitFor(`document.querySelector('[data-action="photo-gallery"]') !== null`);
  await click('[data-action="photo-gallery"]');
  await pickFileWith('input[type=file]', TEST_IMAGE);
  await waitFor(`document.querySelector('.sheet') !== null`);
  await click('.sheet .btn-primary');
  await waitFor(`document.querySelectorAll('.photo-tile').length >= 1`);
  await evalAsync(INSTALL_FAKE);
  await click('.photo-tile');
  await waitFor(`document.querySelector('#photo-template-controls') !== null`);
  const fakeReady = await evalAsync(`(async () => {
    const d = await import('/js/pose/detector.js');
    const det = d.createPoseDetector();
    await det.initialize();
    const pose = await det.detectImage({ width: 192, height: 192 });
    det.dispose();
    return { name: det.name, pose: !!pose };
  })()`);
  console.log('  detector seam:', JSON.stringify(fakeReady));
  await click('#photo-template-controls .btn');
  try {
    await waitFor(`/Full body visible/.test(document.getElementById('photo-template-status')?.textContent || '')`, 15000);
  } catch {
    const diag = await evaluate(`document.getElementById('photo-template-status')?.textContent || 'no status'`);
    console.log('  DIAG analysis status:', diag);
  }
  await shot('camera-template-analysis-dark');
  await click('#photo-template-controls .btn');
  await waitFor(`document.querySelector('.photo-template-bar') !== null`, 10000);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(500);
  await shot('photos-template-bar-dark');

  console.log('\n— Smart camera states (dark) —');
  await setPose({ centerX: 0.34, centerY: 0.55, height: 0.46 });
  await openSmartCamera();
  await sleep(1400);
  await shot('camera-aligning-dark');

  await setPose({ centerX: 0.5, centerY: 0.55, height: 0.46 });
  await waitFor(`['hold','capture'].includes(document.getElementById('cam-guidance').dataset.code)`, 20000);
  await sleep(300);
  await shot('camera-matched-dark');

  await click('[data-action="cam-reference"]');
  await sleep(600);
  await shot('camera-outline-dark');

  console.log('\n— Captured result + save —');
  await click('[data-action="cam-capture"]');
  await waitFor(`document.querySelector('.cam-result') !== null`, 15000);
  await shot('camera-result-dark');
  await click('[data-action="cam-cancel"]');
  await waitFor(`document.querySelector('[data-action="photo-smart"]') !== null`);

  console.log('\n— Light theme + narrow/wide layouts —');
  await setTheme('light');
  await setPose({ centerX: 0.5, centerY: 0.55, height: 0.46 });
  await openSmartCamera();
  await waitFor(`['hold','capture'].includes(document.getElementById('cam-guidance').dataset.code)`, 20000);
  await shot('camera-matched-light');
  await closeCamera();

  await setViewport(320, 640);
  await setTheme('dark');
  await openSmartCamera();
  await setPose({ centerX: 0.62, centerY: 0.55, height: 0.4 });
  await sleep(1400);
  await shot('camera-320-dark');
  await closeCamera();

  await setViewport(768, 900);
  await setPose({ centerX: 0.5, centerY: 0.55, height: 0.46 });
  await openSmartCamera();
  await waitFor(`['hold','capture'].includes(document.getElementById('cam-guidance').dataset.code)`, 20000);
  await shot('camera-768-dark');

  console.log('\n✓ Camera screenshots written to /screenshots');
} catch (err) {
  console.error('SCREENSHOT RUN FAILED:', err.message);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* ignore */
  }
  if (chrome) chrome.kill('SIGKILL');
  server.kill('SIGKILL');
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
