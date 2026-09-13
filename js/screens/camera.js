/**
 * Smart Progress Camera — "match your progress photo".
 *
 * The camera screen closes the loop that the comparison screen exposes: instead
 * of hoping the next photo is framed like the last one, the user is guided into
 * the same body position, distance, framing and posture while the previous
 * photo (ghost) is on screen, and the shutter fires once the position is
 * genuinely stable.
 *
 * Layout: screens → this screen → camera controller / pose detector adapter /
 * alignment engine / overlay. No pose math happens in this file; it owns
 * lifecycle, coordinate projection and DOM updates only.
 *
 * Failure philosophy: the smart camera is an *enhancement*. If the model is
 * missing, the browser is too old, the device is too slow or anything else
 * breaks, the user still takes a normal progress photo through the existing
 * capture path (§35).
 */
import * as ui from '../ui.js';
import * as photos from '../photos.js';
import { go, navigate, registerCleanup } from '../router.js';
import { getSettings, saveSettings } from '../settings.js';
import { formatDate } from '../utils.js';
import { ALIGNMENT_CONFIG, GUIDANCE, STATUS_LABEL, createAlignmentEngine } from '../pose/alignment.js';
import { parseReferenceProfile, referenceCompositionAspect, referenceLandmarkPoints } from '../pose/reference.js';
import { smoothPose, poseMovement } from '../pose/geometry.js';
import {
  aspectOf,
  sourceNormToViewportNorm,
  sourcePoseToViewport,
  viewportAspectFor,
  viewportNormToCss,
} from '../camera/coordinates.js';
import { countCameras, createCameraController, describeCameraError } from '../camera/controller.js';
import { REFERENCE_MODES, createStageOverlay } from '../camera/overlay.js';
import { createPoseDetector, isSmartCameraSupported, loadPoseAssetManifest } from '../pose/detector.js';
import { openSaveSheet } from './photos.js';

/** Inference cadence: 80 ms ≈ 12 poses/second, adapted to the device (§8/§36). */
const INFERENCE_INTERVAL_MS = 80;
const INFERENCE_INTERVAL_SLOW_MS = 200;
const SLOW_INFERENCE_MS = 140;
const VERY_SLOW_INFERENCE_MS = 260;

const REFERENCE_MODE_KEY = 'referenceMode';
const MEASURED_HELP = 'Position, framing and posture compared with your reference.';

/**
 * The detector is expensive to build (WASM + several MB of model), so it is
 * created once per page session, reused across camera opens, paused when the
 * camera closes and closed when the app goes away — never re-initialized per
 * visit (§34/§28).
 */
let cachedDetector = null;
let pagehideBound = false;

function getDetector() {
  if (!cachedDetector) cachedDetector = createPoseDetector();
  if (!pagehideBound && typeof window !== 'undefined') {
    pagehideBound = true;
    window.addEventListener(
      'pagehide',
      () => {
        cachedDetector?.dispose();
        cachedDetector = null;
      },
      { once: true }
    );
  }
  return cachedDetector;
}

/** Dispose the cached detector (used by tests). */
export function disposeCachedDetector() {
  cachedDetector?.dispose();
  cachedDetector = null;
}

export async function mount(root, params = []) {
  photos.revokePhotoUrls();

  const photoList = await photos.getAllPhotos();
  // The active template (settings) is authoritative; the route only decides to
  // open the camera, never which photo is the reference.
  const templateId = getSettings().photoTemplateId || null;
  const referencePhoto = photoList.find((p) => p.id === templateId) || null;
  const storedProfile = referencePhoto ? await photos.getReferenceProfile(referencePhoto.id) : null;
  const reference = parseReferenceProfile(storedProfile);

  // ---- Pre-flight states that never open the camera ------------------------
  if (!referencePhoto || !reference) {
    renderNeedsTemplate(root, { hasPhotos: photoList.length > 0 });
    return;
  }
  if (!isSmartCameraSupported()) {
    renderUnavailable(root, referencePhoto, {
      title: 'Smart camera unavailable',
      message: 'This browser cannot run the on-device pose model, so alignment guidance is off. You can still take a photo — it will be saved exactly as before.',
    });
    return;
  }
  const manifest = await loadPoseAssetManifest();
  if (!manifest) {
    renderUnavailable(root, referencePhoto, {
      title: 'Smart camera not installed',
      message: 'The on-device pose model is missing from this build, so alignment guidance is off. You can still take a photo — it will be saved exactly as before.',
    });
    return;
  }

  await startSmartCamera(root, { reference, referencePhoto });
}

// ---------------------------------------------------------------------------
// Fallback / pre-flight states
// ---------------------------------------------------------------------------

function renderNeedsTemplate(root, { hasPhotos }) {
  root.innerHTML = `
    <header class="cam-head">
      <button class="btn-icon" data-action="cam-back" aria-label="Back to progress photos">${ui.icon('arrow-left', 18)}</button>
      <div class="cam-head-text">
        <div class="cam-title">Match Your Progress</div>
        <div class="cam-sub">Pick a previous photo to match</div>
      </div>
    </header>
    <section class="section stagger">
      <div class="empty">
        <div class="empty-icon">${ui.icon('sparkles', 30)}</div>
        <div class="empty-title">${hasPhotos ? 'Choose your photo template' : 'Take a first photo'}</div>
        <div class="empty-sub">${
          hasPhotos
            ? 'Pick a progress photo and the camera will help you line up the same position, distance and posture next time.'
            : 'Once you have a progress photo, you can use it as a template and stay framed the same way in every future shot.'
        }</div>
        <div class="cam-fallback-actions">
          <button class="btn btn-primary" data-action="cam-choose">${hasPhotos ? 'Choose a photo' : 'Go to photos'}</button>
          <button class="btn btn-ghost" data-action="cam-standard">Use standard camera</button>
        </div>
      </div>
    </section>`;
  ui.bindActions(root, {
    'cam-back': () => go('photos'),
    'cam-choose': () => go('photos'),
    'cam-standard': () => standardCamera(root),
  });
}

function renderUnavailable(root, referencePhoto, { title, message }) {
  root.innerHTML = `
    <header class="cam-head">
      <button class="btn-icon" data-action="cam-back" aria-label="Back to progress photos">${ui.icon('arrow-left', 18)}</button>
      <div class="cam-head-text">
        <div class="cam-title">Match Your Progress</div>
        <div class="cam-sub">Reference · ${formatDate(referencePhoto.date, { short: true })}</div>
      </div>
    </header>
    <section class="section stagger">
      <div class="empty">
        <div class="empty-icon">${ui.icon('camera', 30)}</div>
        <div class="empty-title">${title}</div>
        <div class="empty-sub">${message}</div>
        <div class="cam-fallback-actions">
          <button class="btn btn-primary" data-action="cam-standard">Use standard camera</button>
          <button class="btn btn-ghost" data-action="cam-gallery">Choose from gallery</button>
        </div>
      </div>
    </section>`;
  ui.bindActions(root, {
    'cam-back': () => go('photos'),
    'cam-standard': () => standardCamera(root),
    'cam-gallery': () => standardCamera(root, 'gallery'),
  });
}

/**
 * The existing capture path, unchanged: system camera (or gallery) → the same
 * "Save photo" sheet the Photos screen uses. This is the guaranteed way to take
 * a progress photo, with or without the smart alignment feature.
 */
async function standardCamera(root, kind = 'camera') {
  const file = kind === 'gallery' ? await ui.pickFromGallery('image/*') : await ui.pickFromCamera('image/*');
  if (!file) {
    go('photos');
    return;
  }
  try {
    const previewUrl = await ui.readFileAsDataURL(file);
    openSaveSheet({
      file,
      previewUrl,
      onSaved: () => go('photos'),
      onCancel: () => go('photos'),
    });
  } catch {
    ui.toast('Could not read that image.', 'danger');
    go('photos');
  }
}

// ---------------------------------------------------------------------------
// The smart camera itself
// ---------------------------------------------------------------------------

async function startSmartCamera(root, { reference, referencePhoto }) {
  const settings = getSettings();
  // The stage prefers the reference photo's aspect ratio, so "cover" of the
  // reference is an exact fit of the viewport (§25).
  const preferredAspect = viewportAspectFor(aspectOf(reference.image));
  // Both the reference profile and the live pose are compared in this single
  // canonical composition space (§25/§50). The stage only *displays* it, so a
  // layout rounding difference can never change the alignment result.
  const compositionAspect = referenceCompositionAspect(reference, preferredAspect);
  const reduced = prefersReducedMotion();
  let stageAspect = preferredAspect;
  let referencePoints = {};

  root.innerHTML = cameraMarkup({ referencePhoto, viewportAspect: preferredAspect, reduced });
  const dom = {
    wrap: root.querySelector('.cam-stage-wrap'),
    stage: root.querySelector('#cam-stage'),
    video: root.querySelector('#cam-video'),
    ghost: root.querySelector('#cam-ghost'),
    live: root.querySelector('#cam-live'),
    state: root.querySelector('#cam-state'),
    stateText: root.querySelector('#cam-state-text'),
    stateActions: root.querySelector('#cam-state-actions'),
    spinner: root.querySelector('#cam-spinner'),
    controls: root.querySelector('.cam-controls'),
    meterTitle: root.querySelector('#cam-meter-title'),
    guidance: root.querySelector('#cam-guidance'),
    guidanceText: root.querySelector('#cam-guidance-text'),
    arrow: root.querySelector('#cam-arrow'),
    meter: root.querySelector('#cam-meter'),
    score: root.querySelector('#cam-score'),
    meterFill: root.querySelector('#cam-meter-fill'),
    hold: root.querySelector('#cam-hold'),
    countdown: root.querySelector('#cam-countdown'),
    countdownValue: root.querySelector('#cam-countdown-value'),
    referenceBtn: root.querySelector('#cam-reference-btn'),
    autoBtn: root.querySelector('#cam-auto-btn'),
    flipBtn: root.querySelector('#cam-flip'),
    announce: root.querySelector('#cam-announce'),
    chips: {
      position: root.querySelector('#cam-chip-position'),
      framing: root.querySelector('#cam-chip-framing'),
      posture: root.querySelector('#cam-chip-posture'),
    },
  };

  const overlay = createStageOverlay({ ghostCanvas: dom.ghost, liveCanvas: dom.live, reducedMotion: reduced });
  const camera = createCameraController(dom.video);
  const engine = createAlignmentEngine(ALIGNMENT_CONFIG, { capture: { enabled: settings.photoAutoCapture !== false } });

  let referenceMode = REFERENCE_MODES.includes(settings[REFERENCE_MODE_KEY]) ? settings[REFERENCE_MODE_KEY] : 'ghost';
  let mirrored = true;
  let running = true;
  let rafId = null;
  let inferring = false;
  let lastInferenceAt = 0;
  let inferenceInterval = INFERENCE_INTERVAL_MS;
  let slowNotified = false;
  let smoothed = null;
  let previousViewportPose = null;
  let lastResult = null;
  let lastGuidanceCode = '';
  let lastAnnouncedAt = 0;
  let lastAnnouncedCode = '';
  let finalizing = false;
  let capturedUrl = null;
  let teardownDone = false;
  let ghostImage = null;
  let resizeObserver = null;
  let lastLayoutKey = '';

  const videoAspect = () => {
    const w = dom.video.videoWidth;
    const h = dom.video.videoHeight;
    return w && h ? h / w : stageAspect;
  };

  const projector = () => (point) => viewportNormToCss(point, { width: dom.stage.clientWidth, height: dom.stage.clientHeight, mirrored });

  // ---- Lifecycle ----------------------------------------------------------

  registerCleanup(teardownAll);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);

  // Ghost photo: reuse the object URL cache (revoked by the photos screen on
  // its next mount), then draw the static guide once it decodes.
  const ghostUrl = photos.photoUrl(referencePhoto, 'blob') || photos.photoUrl(referencePhoto, 'thumb');
  if (ghostUrl) {
    ghostImage = new Image();
    ghostImage.decoding = 'async';
    ghostImage.onload = () => drawGhostLayer();
    ghostImage.src = ghostUrl;
  }

  layoutStage();
  observeStage();
  bindControls();

  // ---- Camera -------------------------------------------------------------

  setState({ busy: true, text: 'Starting camera…' });
  try {
    const info = await camera.start({ facingMode: 'user' });
    mirrored = info.facingMode === 'user';
    dom.video.classList.toggle('mirrored', mirrored);
    dom.stage.classList.toggle('mirrored', mirrored);
    drawGhostLayer();
    if (info.width) showState(null);
  } catch (err) {
    const described = describeCameraError(err);
    showCameraError(described);
    return;
  }
  if (!running) return;

  // ---- Pose model ---------------------------------------------------------

  setState({ busy: true, text: 'Preparing smart camera…' });
  try {
    await getDetector().initialize();
    showState(null);
  } catch (err) {
    // The model failed: keep the promise that a photo can still be taken.
    teardownAll();
    renderUnavailable(root, referencePhoto, {
      title: 'Smart camera unavailable',
      message: 'The on-device pose model could not start on this device, so alignment guidance is off. You can still take a photo — it will be saved exactly as before.',
    });
    return;
  }
  if (!running) return;

  const cameras = await countCameras();
  if (cameras > 1 && dom.flipBtn) dom.flipBtn.hidden = false;

  updateReferenceButton();
  updateAutoButton();
  if (reduced) root.querySelector('.cam-screen')?.classList.add('reduced');

  // ---- Loops --------------------------------------------------------------

  rafId = requestAnimationFrame(tick);

  function tick(now) {
    if (!running) return;
    rafId = requestAnimationFrame(tick);
    if (!inferring && now - lastInferenceAt >= inferenceInterval) {
      lastInferenceAt = now;
      runInference(now);
    }
    renderReadouts(now);
  }

  async function runInference(now) {
    inferring = true;
    const started = performance.now();
    try {
      const pose = getDetector().detect(dom.video, Math.round(now));
      handlePose(pose, now);
    } catch (err) {
      console.warn('[LifeProgress] pose detection error', err);
    } finally {
      const latency = performance.now() - started;
      adaptCadence(latency);
      inferring = false;
    }
  }

  function handlePose(pose, now) {
    if (!running) return;
    if (!pose) {
      smoothed = null;
      previousViewportPose = null;
      const result = engine.compare(reference, null, { now, mirrored });
      lastResult = result;
      drawLiveLayer(result);
      return;
    }

    // Video frame space → the reference profile's composition space, then
    // temporally smoothed (§9).
    const viewportPose = sourcePoseToViewport(pose, videoAspect(), compositionAspect);
    viewportPose.confidence = pose.confidence;
    viewportPose.coverage = pose.coverage;
    const movement = previousViewportPose ? poseMovement(previousViewportPose, viewportPose) : 0;
    smoothed = smoothPose(smoothed, viewportPose, ALIGNMENT_CONFIG.POSE_SMOOTHING_ALPHA);
    previousViewportPose = viewportPose;

    const result = engine.compare(reference, smoothed, { now, mirrored, movement });
    lastResult = result;
    drawLiveLayer(result);

    if (result.phase === 'captured' && !finalizing) {
      finalizeCapture({ auto: true });
    }
  }

  function adaptCadence(latency) {
    // Never let inference make the preview unusable (§36): back off instead.
    if (latency > VERY_SLOW_INFERENCE_MS) {
      inferenceInterval = INFERENCE_INTERVAL_SLOW_MS * 1.5;
    } else if (latency > SLOW_INFERENCE_MS) {
      inferenceInterval = INFERENCE_INTERVAL_SLOW_MS;
    } else {
      inferenceInterval = INFERENCE_INTERVAL_MS;
    }
    if (latency > SLOW_INFERENCE_MS && !slowNotified) {
      slowNotified = true;
      root.querySelector('.cam-screen')?.classList.add('slow-device');
    }
  }

  // ---- Rendering (independent of inference cadence) -----------------------

  function renderReadouts() {
    const result = lastResult;
    const status = result ? result.status : 'empty';
    const score = result ? result.smoothedScore : 0;
    const percent = Math.round(score * 100);
    if (dom.score.textContent !== `${percent}%`) dom.score.textContent = `${percent}%`;
    if (result && result.present && dom.meterTitle) {
      const label = STATUS_LABEL[status] || 'Aligning';
      if (dom.meterTitle.textContent !== label) dom.meterTitle.textContent = label;
    }
    dom.meterFill.style.width = `${percent}%`;
    dom.meter.dataset.status = status;
    dom.meter.classList.toggle('matched', status === 'perfect');
    dom.meter.classList.toggle('aligned', status === 'good' || status === 'almost');

    const chipOk = ALIGNMENT_CONFIG.GOOD_COMPONENT_THRESHOLD;
    setChip(dom.chips.position, result && result.positionScore >= chipOk);
    setChip(dom.chips.framing, result && result.framingScore >= chipOk);
    setChip(dom.chips.posture, result && result.postureScore >= chipOk);

    const code = result ? result.guidance : GUIDANCE.NO_PERSON;
    const text = result && result.present ? result.guidanceText : 'Step into the frame';
    if (dom.guidanceText.textContent !== text) dom.guidanceText.textContent = text;
    dom.guidance.dataset.code = code;
    dom.arrow.textContent = arrowFor(code);
    dom.arrow.hidden = !dom.arrow.textContent;

    if (code !== lastGuidanceCode) {
      lastGuidanceCode = code;
      dom.guidance.classList.remove('pulse');
      if (!reduced) {
        void dom.guidance.offsetWidth;
        dom.guidance.classList.add('pulse');
      }
    }
    announce(text, code);

    // Stability prompt: the progress of "hold still".
    const holdText =
      status === 'captured'
        ? ''
        : status === 'perfect'
          ? result && result.guidancePriority === 'stability'
            ? 'Hold still…'
            : 'Perfect'
          : result && result.present && result.smoothedScore >= ALIGNMENT_CONFIG.GOOD_SCORE_THRESHOLD
            ? 'Almost there…'
            : '';
    if (dom.hold.textContent !== holdText) dom.hold.textContent = holdText;

    // Countdown
    const counting = result && result.phase === 'counting';
    dom.countdown.hidden = !counting;
    if (counting && dom.countdownValue.textContent !== String(result.countdown)) {
      dom.countdownValue.textContent = String(result.countdown);
    }

    // Once the very first pose lands, clear the loading overlay — but never
    // wipe a camera error the user still needs to read.
    if (!dom.state.hidden && dom.state.dataset.mode === 'loading') showState(null);
  }

  function drawLiveLayer(result) {
    const state = result && result.status === 'perfect' ? 'matched' : result && result.present ? (result.partial ? 'partial' : 'aligned') : 'partial';
    overlay.drawLive({
      points: smoothed ? smoothed.landmarks : null,
      projector: projector(),
      state: result && result.present ? state : 'partial',
      partial: Boolean(result && result.partial),
    });
  }

  function drawGhostLayer() {
    overlay.drawGhost({
      image: ghostImage && ghostImage.complete ? ghostImage : null,
      points: referencePoints,
      mode: referenceMode,
      projector: projector(),
      mirrored,
    });
  }

  function announce(text, code) {
    if (code === lastAnnouncedCode) return;
    const now = performance.now();
    if (now - lastAnnouncedAt < 1200) return;
    lastAnnouncedCode = code;
    lastAnnouncedAt = now;
    dom.announce.textContent = text;
  }

  // ---- States -------------------------------------------------------------

  function showState(state, { keepOnError = false } = {}) {
    if (!state) {
      if (dom.state.dataset.mode === 'error' && keepOnError) return;
      dom.state.hidden = true;
      dom.state.dataset.mode = '';
      return;
    }
    dom.state.hidden = false;
    dom.state.dataset.mode = state.mode || 'loading';
    if (state.busy) dom.spinner.hidden = false;
    if (state.text) dom.stateText.textContent = state.text;
    dom.stateActions.replaceChildren();
  }

  function setState(state) {
    showState({ mode: 'loading', ...state });
  }

  function showCameraError(described) {
    dom.spinner.hidden = true;
    dom.state.hidden = false;
    dom.state.dataset.mode = 'error';
    dom.stateText.textContent = described.message;
    dom.state.querySelector('#cam-state-title').textContent = described.title;
    dom.stateActions.replaceChildren();
    if (described.retry) {
      const retry = ui.el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Try again');
      retry.addEventListener('click', () => navigate('photos/camera'));
      dom.stateActions.append(retry);
    }
    const fallback = ui.el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Standard camera');
    fallback.addEventListener('click', () => standardCamera(root));
    dom.stateActions.append(fallback);
    dom.controls?.classList.add('disabled');
  }

  // ---- Controls -----------------------------------------------------------

  function bindControls() {
    ui.bindActions(root, {
      'cam-back': () => go('photos'),
      'cam-capture': () => finalizeCapture({ auto: false }),
      'cam-flip': () => flipCamera(),
      'cam-reference': () => cycleReference(),
      'cam-auto': () => toggleAuto(),
      'cam-standard': () => standardCamera(root),
    });
  }

  async function flipCamera() {
    if (finalizing || !running) return;
    try {
      const info = await camera.flip();
      if (!info.flipped) {
        ui.toast('Only one camera available', 'info');
        return;
      }
      mirrored = info.facingMode === 'user';
      dom.video.classList.toggle('mirrored', mirrored);
      dom.stage.classList.toggle('mirrored', mirrored);
      engine.reset();
      smoothed = null;
      previousViewportPose = null;
      drawGhostLayer();
      overlay.clearLive();
    } catch (err) {
      ui.toast(describeCameraError(err).message, 'danger');
    }
  }

  function cycleReference() {
    const index = REFERENCE_MODES.indexOf(referenceMode);
    referenceMode = REFERENCE_MODES[(index + 1) % REFERENCE_MODES.length];
    saveSettings({ [REFERENCE_MODE_KEY]: referenceMode }).catch(() => {});
    updateReferenceButton();
    drawGhostLayer();
  }

  function updateReferenceButton() {
    const label = referenceMode === 'ghost' ? 'Ghost' : referenceMode === 'outline' ? 'Outline' : 'Off';
    dom.referenceBtn.textContent = `Reference: ${label}`;
    dom.referenceBtn.setAttribute('aria-label', `Reference guide: ${label}. Tap to change.`);
  }

  function toggleAuto() {
    const next = !engine.autoCaptureEnabled;
    engine.setAutoCapture(next);
    saveSettings({ photoAutoCapture: next }).catch(() => {});
    updateAutoButton();
    if (next) engine.reset();
  }

  function updateAutoButton() {
    const on = engine.autoCaptureEnabled;
    dom.autoBtn.textContent = on ? 'Auto ✓' : 'Auto';
    dom.autoBtn.setAttribute('aria-pressed', String(on));
    dom.autoBtn.setAttribute('aria-label', `Automatic capture ${on ? 'on' : 'off'}`);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      go('photos');
    }
  }

  function onVisibilityChange() {
    // Stop burning battery (and stop looking at the user) while hidden.
    const detector = cachedDetector;
    if (document.hidden) {
      detector?.pause();
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    } else if (running && !rafId) {
      detector?.resume();
      lastInferenceAt = 0;
      rafId = requestAnimationFrame(tick);
    }
  }

  // ---- Capture ------------------------------------------------------------

  async function finalizeCapture({ auto }) {
    if (finalizing || teardownDone) return;
    if (!camera.isActive()) {
      ui.toast('The camera stopped. Try again.', 'danger');
      return;
    }
    finalizing = true;
    ui.haptic(auto ? 24 : 16);

    let still = null;
    try {
      // Crop to the very composition the user aligned to; saved unmirrored so
      // before/after photos share one orientation convention.
      still = await camera.capture({ dstAspect: stageAspect, mirrored: false });
    } catch (err) {
      finalizing = false;
      ui.toast(describeCameraError(err).message, 'danger');
      return;
    }

    const wasPoor = lastResult ? lastResult.smoothedScore < ALIGNMENT_CONFIG.CAPTURE_SCORE_THRESHOLD : true;
    teardownAll();
    renderConfirmation(still, { auto, wasPoor });
  }

  function renderConfirmation(still, { auto, wasPoor }) {
    capturedUrl = URL.createObjectURL(still.blob);
    root.innerHTML = `
      <header class="cam-head">
        <button class="btn-icon" data-action="cam-cancel" aria-label="Discard photo">${ui.icon('x', 18)}</button>
        <div class="cam-head-text">
          <div class="cam-title">${auto ? 'Perfect — captured' : 'Photo captured'}</div>
          <div class="cam-sub">${auto ? 'Matched to your reference' : 'Ready to save'}</div>
        </div>
      </header>
      <section class="section stagger">
        <div class="cam-result">
          <img src="${capturedUrl}" alt="Your new progress photo" />
        </div>
        ${
          wasPoor && !auto
            ? `<p class="cam-note">For easier comparison later, try matching your previous position next time — the reference guide stays saved for you.</p>`
            : ''
        }
        <div class="cam-result-actions">
          <button class="btn btn-primary btn-block" data-action="cam-use">Use photo</button>
          <button class="btn btn-ghost btn-block" data-action="cam-retake">Retake</button>
        </div>
      </section>`;
    ui.bindActions(root, {
      'cam-use': () =>
        openSaveSheet({
          file: still.blob,
          previewUrl: capturedUrl,
          onSaved: () => go('photos'),
          onCancel: () => {},
        }),
      'cam-retake': () => {
        teardownAll();
        // navigate() (not go()) — the hash is unchanged, so a same-route
        // re-render has to be forced explicitly.
        navigate('photos/camera');
      },
      'cam-cancel': () => {
        teardownAll();
        go('photos');
      },
    });
  }

  // ---- Layout -------------------------------------------------------------

  /**
   * Size the stage so its aspect ratio EXACTLY matches the reference photo —
   * narrowing the stage instead of clamping its height when a photo is very
   * tall. Setting width/height in pixels (rather than relying on CSS
   * aspect-ratio plus a max-height) is what guarantees the ghost photo, the
   * live video, the pose landmarks and the saved crop all share one space
   * (§25/§50).
   */
  function layoutStage() {
    const available = Math.max(160, dom.wrap?.clientWidth || dom.stage.clientWidth || 0);
    const maxHeight = Math.max(200, Math.min(Math.round((window.innerHeight || 800) * 0.58), 560));
    let width = available;
    let height = Math.round(width * preferredAspect);
    if (height > maxHeight) {
      height = maxHeight;
      width = Math.round(height / preferredAspect);
    }
    const key = `${width}x${height}`;
    if (key === lastLayoutKey) return;
    lastLayoutKey = key;
    dom.stage.style.width = `${width}px`;
    dom.stage.style.height = `${height}px`;
    dom.stage.dataset.layout = key;
    stageAspect = dom.stage.clientWidth ? dom.stage.clientHeight / dom.stage.clientWidth : preferredAspect;
    referencePoints = viewportReferencePoints(reference, compositionAspect, stageAspect);
    overlay.resize({ width: dom.stage.clientWidth, height: dom.stage.clientHeight, dpr: Math.min(2, window.devicePixelRatio || 1) });
    drawGhostLayer();
    overlay.clearLive();
  }

  function observeStage() {
    // Observe the wrapper (never the stage we resize here) to avoid a
    // resize-observer feedback loop.
    const target = dom.wrap || dom.stage;
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => layoutStage());
      resizeObserver.observe(target);
    } else {
      window.addEventListener('resize', layoutStage);
    }
  }

  // ---- Teardown -----------------------------------------------------------

  function teardownAll() {
    if (teardownDone) return;
    teardownDone = true;
    running = false;
    finalizing = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    } else {
      window.removeEventListener('resize', layoutStage);
    }
    // Stop every media track and release the stream (§21/§28).
    try {
      camera.stop();
    } catch {
      /* ignore */
    }
    // Pause inference but keep the loaded model for the next visit (§34).
    cachedDetector?.pause();
    engine.reset();
    overlay.dispose();
    ghostImage = null;
    if (dom.video) dom.video.srcObject = null;
    if (dom.controls) dom.controls.classList.remove('disabled');
  }

  // Clean up the captured preview URL when leaving the screen for good.
  registerCleanup(() => {
    if (capturedUrl) {
      URL.revokeObjectURL(capturedUrl);
      capturedUrl = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Markup / small helpers
// ---------------------------------------------------------------------------

function cameraMarkup({ referencePhoto, viewportAspect, reduced }) {
  const aspectCss = `${(1 / viewportAspect).toFixed(4)} / 1`;
  return `
    <div class="cam-screen ${reduced ? 'reduced' : ''}" aria-live="off">
      <header class="cam-head">
        <button class="btn-icon" data-action="cam-back" aria-label="Close camera">${ui.icon('x', 18)}</button>
        <div class="cam-head-text">
          <div class="cam-title">Match Your Progress</div>
          <div class="cam-sub">Reference · ${formatDate(referencePhoto.date, { short: true })}</div>
        </div>
        <button class="btn-icon" id="cam-flip" data-action="cam-flip" aria-label="Switch camera" hidden>${ui.icon('refresh', 18)}</button>
      </header>

      <div class="cam-stage-wrap">
        <div class="cam-stage" id="cam-stage" style="--cam-aspect:${aspectCss}">
          <video class="cam-video" id="cam-video" playsinline muted autoplay aria-label="Camera preview"></video>
          <canvas class="cam-layer" id="cam-ghost" aria-hidden="true"></canvas>
          <canvas class="cam-layer" id="cam-live" aria-hidden="true"></canvas>

          <div class="cam-state" id="cam-state" data-mode="loading" role="status">
            <div class="cam-spinner" id="cam-spinner" aria-hidden="true"></div>
            <div class="cam-state-title" id="cam-state-title"></div>
            <div class="cam-state-text" id="cam-state-text">Preparing smart camera…</div>
            <div class="cam-state-actions" id="cam-state-actions"></div>
          </div>

          <div class="cam-countdown" id="cam-countdown" hidden aria-hidden="true">
            <span id="cam-countdown-value">3</span>
          </div>
        </div>
      </div>

      <p class="cam-guidance" id="cam-guidance" data-code="no-person" role="status">
        <span class="cam-arrow" id="cam-arrow" aria-hidden="true"></span>
        <span id="cam-guidance-text">Step into the frame</span>
      </p>

      <div class="cam-meter" id="cam-meter" aria-hidden="true" title="${MEASURED_HELP}">
        <div class="cam-meter-head">
          <span id="cam-meter-title">Photo match</span>
          <span id="cam-score">0%</span>
        </div>
        <div class="cam-meter-track"><div class="cam-meter-fill" id="cam-meter-fill"></div></div>
        <div class="cam-chips">
          <span class="cam-chip" id="cam-chip-position">Position</span>
          <span class="cam-chip" id="cam-chip-framing">Framing</span>
          <span class="cam-chip" id="cam-chip-posture">Posture</span>
        </div>
        <div class="cam-hold" id="cam-hold"></div>
      </div>

      <div class="cam-controls">
        <button class="cam-shutter" data-action="cam-capture" aria-label="Take photo"><span aria-hidden="true"></span></button>
        <div class="cam-controls-row">
          <button class="cam-chip-btn" id="cam-reference-btn" data-action="cam-reference" type="button">Reference: Ghost</button>
          <button class="cam-chip-btn" id="cam-auto-btn" data-action="cam-auto" type="button" aria-pressed="true">Auto ✓</button>
          <button class="cam-chip-btn" data-action="cam-standard" type="button">Standard camera</button>
        </div>
      </div>

      <span class="visually-hidden" aria-live="polite" id="cam-announce"></span>
    </div>`;
}

function setChip(node, ok) {
  if (!node) return;
  node.classList.toggle('ok', Boolean(ok));
  const base = node.dataset.label || node.textContent.replace(/[✓·]\s*$/, '').trim();
  node.dataset.label = base;
  node.textContent = `${base} ${ok ? '✓' : '·'}`;
}

function arrowFor(code) {
  switch (code) {
    case GUIDANCE.MOVE_LEFT:
      return '←';
    case GUIDANCE.MOVE_RIGHT:
      return '→';
    case GUIDANCE.MOVE_UP:
      return '↑';
    case GUIDANCE.MOVE_DOWN:
      return '↓';
    case GUIDANCE.HOLD:
      return '✓';
    default:
      return '';
  }
}

/**
 * Reference landmarks projected into the on-screen stage. The stored landmarks
 * are already in the profile's composition space, so this is an identity map
 * whenever the stage hosts that space exactly (the normal case) — it only
 * rescales if the stage had to be letterboxed to something else.
 */
function viewportReferencePoints(reference, compositionAspect, stageAspect) {
  const raw = referenceLandmarkPoints(reference);
  const out = {};
  for (const [index, point] of Object.entries(raw)) {
    const mapped = sourceNormToViewportNorm(point, compositionAspect, stageAspect);
    out[index] = { x: mapped.x, y: mapped.y, visibility: point.visibility };
  }
  return out;
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
