/**
 * Pose detector adapter — the ONLY module that knows about MediaPipe.
 *
 * The rest of Life Progress talks to a small, normalized interface:
 *
 *   initialize()                       load the vendored runtime + model
 *   detect(source, timestampMs) →      NormalizedPose | null   (video frames)
 *   detectImage(source)        →      NormalizedPose | null   (still photos)
 *   pause() / resume() / dispose()
 *
 * Swapping the ML backend (TensorFlow.js BlazePose, a newer MediaPipe version,
 * …) means writing one more adapter with this shape — no camera UI or alignment
 * code changes.
 *
 * PRIVACY / OFFLINE (verified, see vendor/mediapipe/README.md)
 * - The runtime bundle and the model are vendored under vendor/mediapipe/ and
 *   served same-origin. The pinned bundle contains no hard-coded external URLs
 *   and no telemetry/analytics code; the only fetches it performs target the
 *   base path handed to it below.
 * - Inference runs entirely in WASM on this device. Camera frames, photos and
 *   landmarks never leave it.
 * - Loading is lazy: nothing here is imported or downloaded until the smart
 *   camera is actually opened (a plain dynamic import at call time).
 */
import { normalizePose } from './geometry.js';

/** Pinned runtime/model location, relative to the project root. */
export const POSE_ASSET_ROOT = new URL('../../vendor/mediapipe/', import.meta.url).href;
export const POSE_ASSET_MANIFEST = `${POSE_ASSET_ROOT}manifest.json`;

/** Default landmarker settings — tuned for a single subject on a phone. */
export const DEFAULT_DETECTOR_OPTIONS = Object.freeze({
  delegate: 'GPU', // falls back to CPU automatically when unavailable
  runningMode: 'VIDEO',
  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  outputSegmentationMasks: false,
});

/** Thrown when the vendored assets are absent/unreadable (→ standard camera). */
export class PoseAssetsMissingError extends Error {
  constructor(message = 'Pose assets are not available.') {
    super(message);
    this.name = 'PoseAssetsMissingError';
    this.reason = 'assets-missing';
  }
}

/** Thrown when the runtime/model fails to initialize. */
export class PoseDetectorInitError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PoseDetectorInitError';
    this.reason = 'init-failed';
    this.cause = cause;
  }
}

let manifestPromise = null;
let detectorFactory = null;

/** Test/QA seam: substitute a deterministic detector (see scripts/qa-camera.js). */
export function setPoseDetectorFactory(factory) {
  detectorFactory = typeof factory === 'function' ? factory : null;
}

export function getPoseDetectorFactory() {
  return detectorFactory;
}

/** WebAssembly SIMD — required by the vendored wasm build. */
export function wasmSimdSupported() {
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.validate !== 'function') return false;
  // Standard feature-detect probe (v128.const + i8x16.add).
  return WebAssembly.validate(
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ])
  );
}

/** Cheap capability gate — mirrors the runtime requirements of the adapter. */
export function isSmartCameraSupported() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return false;
  if (typeof WebAssembly !== 'object') return false;
  return wasmSimdSupported();
}

/**
 * Read (and cache) the vendored asset manifest. A missing manifest means the
 * smart camera is not installed — callers fall back to the standard camera
 * instead of surfacing an error.
 */
export function loadPoseAssetManifest() {
  if (!manifestPromise) {
    manifestPromise = (async () => {
      if (typeof fetch !== 'function') return null;
      try {
        const res = await fetch(POSE_ASSET_MANIFEST, { cache: 'force-cache' });
        if (!res.ok) return null;
        const manifest = await res.json();
        if (!manifest || !manifest.model || !manifest.bundle) return null;
        return manifest;
      } catch {
        return null;
      }
    })();
  }
  return manifestPromise;
}

/** Reset the cached manifest (used by tests / after asset re-fetch). */
export function resetPoseAssetCache() {
  manifestPromise = null;
}

/**
 * Create a detector instance. Nothing is fetched until `initialize()` runs, so
 * calling this during screen setup is free.
 */
export function createPoseDetector(options = {}) {
  if (detectorFactory) return detectorFactory(options);

  const opts = { ...DEFAULT_DETECTOR_OPTIONS, ...options };
  let landmarker = null;
  let vision = null;
  let manifest = null;
  let runningMode = opts.runningMode;
  let paused = false;
  let disposed = false;
  const stats = { frames: 0, nullFrames: 0, lastLatencyMs: 0, averageLatencyMs: 0, delegate: null, model: null };

  async function initialize() {
    if (landmarker) return stats;
    if (!wasmSimdSupported()) {
      throw new PoseAssetsMissingError('This browser does not support the WebAssembly features the on-device model needs.');
    }
    manifest = await loadPoseAssetManifest();
    if (!manifest) {
      throw new PoseAssetsMissingError('The on-device pose model is not installed.');
    }

    try {
      // Lazy, same-origin dynamic import — never loaded during app startup.
      vision = await import(`${POSE_ASSET_ROOT}${manifest.bundle}`);
    } catch (err) {
      throw new PoseDetectorInitError('Could not load the pose runtime.', err);
    }

    const wasmBase = `${POSE_ASSET_ROOT}${manifest.wasmBase || 'wasm'}`;
    const modelPath = `${POSE_ASSET_ROOT}${manifest.model.path}`;
    const landmarkerOptions = {
      baseOptions: { modelAssetPath: modelPath, delegate: opts.delegate },
      runningMode,
      numPoses: opts.numPoses,
      minPoseDetectionConfidence: opts.minPoseDetectionConfidence,
      minPosePresenceConfidence: opts.minPosePresenceConfidence,
      minTrackingConfidence: opts.minTrackingConfidence,
      outputSegmentationMasks: opts.outputSegmentationMasks,
    };

    try {
      const fileset = await vision.FilesetResolver.forVisionTasks(wasmBase);
      landmarker = await createWithFallback(landmarkerOptions, fileset);
    } catch (err) {
      throw new PoseDetectorInitError('Could not start the on-device pose model.', err);
    }

    stats.model = manifest.model.name;
    return stats;
  }

  /**
   * Prefer GPU (much faster on phones) but never fail over a delegate — a GPU
   * context can be unavailable on low-memory devices or in some browsers.
   */
  async function createWithFallback(baseOptions, fileset) {
    try {
      const instance = await vision.PoseLandmarker.createFromOptions(fileset, baseOptions);
      stats.delegate = opts.delegate;
      return instance;
    } catch (err) {
      if (baseOptions.baseOptions.delegate !== 'GPU') throw err;
      const instance = await vision.PoseLandmarker.createFromOptions(fileset, {
        ...baseOptions,
        baseOptions: { ...baseOptions.baseOptions, delegate: 'CPU' },
      });
      stats.delegate = 'CPU';
      return instance;
    }
  }

  function readResult(result, meta) {
    const landmarkSets = result && result.landmarks;
    if (!landmarkSets || !landmarkSets.length || !landmarkSets[0] || !landmarkSets[0].length) return null;
    return normalizePose(landmarkSets[0], meta);
  }

  function detect(source, timestampMs = 0) {
    if (!landmarker || paused || disposed || !source) return null;
    const started = now();
    try {
      const result = landmarker.detectForVideo(source, timestampMs);
      const pose = readResult(result, {
        timestamp: timestampMs,
        imageWidth: source.videoWidth || source.width || 0,
        imageHeight: source.videoHeight || source.height || 0,
        source: 'video',
      });
      recordLatency(started, pose);
      return pose;
    } catch (err) {
      recordLatency(started, null);
      console.warn('[LifeProgress] pose inference failed', err);
      return null;
    }
  }

  /** Analyze a still image (reference photo). Switches running mode and back. */
  async function detectImage(source) {
    if (!landmarker || disposed || !source) return null;
    const previous = runningMode;
    try {
      if (previous !== 'IMAGE') {
        await landmarker.setOptions({ runningMode: 'IMAGE' });
        runningMode = 'IMAGE';
      }
      const started = now();
      const result = landmarker.detect(source);
      const pose = readResult(result, {
        timestamp: 0,
        imageWidth: source.width || source.naturalWidth || 0,
        imageHeight: source.height || source.naturalHeight || 0,
        source: 'image',
      });
      recordLatency(started, pose);
      return pose;
    } catch (err) {
      console.warn('[LifeProgress] pose image inference failed', err);
      return null;
    } finally {
      if (previous === 'VIDEO') {
        try {
          await landmarker.setOptions({ runningMode: 'VIDEO' });
          runningMode = 'VIDEO';
        } catch {
          /* the landmarker is unusable now; callers fall back to the standard camera */
        }
      }
    }
  }

  function recordLatency(started, pose) {
    const elapsed = now() - started;
    stats.frames += 1;
    if (!pose) stats.nullFrames += 1;
    stats.lastLatencyMs = Math.round(elapsed);
    stats.averageLatencyMs = Math.round(stats.averageLatencyMs ? stats.averageLatencyMs * 0.8 + elapsed * 0.2 : elapsed);
  }

  return {
    name: 'mediapipe-pose-landmarker',
    initialize,
    detect,
    detectImage,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    dispose() {
      disposed = true;
      paused = true;
      try {
        landmarker?.close?.();
      } catch {
        /* already gone */
      }
      landmarker = null;
      vision = null;
    },
    get stats() {
      return { ...stats, ready: Boolean(landmarker), manifestVersion: manifest ? manifest.runtimeVersion : null };
    },
    get ready() {
      return Boolean(landmarker) && !disposed;
    },
  };
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
