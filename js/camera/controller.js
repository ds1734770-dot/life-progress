/**
 * Camera controller — getUserMedia lifecycle plus still capture.
 *
 * Keeps every browser-specific camera concern in one place: constraints,
 * permission/error mapping, mirroring, ImageCapture-vs-canvas capture and
 * guaranteed teardown (every media track is stopped on stop()).
 *
 * The captured still is cropped to the same viewport composition the user
 * aligned to (js/camera/coordinates.js), so what they saw is what gets saved.
 * Mirroring is applied for display only: the saved photo stays in the same
 * "as-saved" orientation the existing progress-photo pipeline produces, which
 * keeps reference profiles and before/after comparisons consistent.
 */
import { captureSourceRect } from './coordinates.js';

/** Capture output size — matches the existing photo pipeline (js/photos.js). */
export const CAPTURE_MAX_SIZE = 1600;
export const CAPTURE_QUALITY = 0.92;

/** Error reasons the UI maps to polished states (§59). */
export const CAMERA_ERROR = Object.freeze({
  UNSUPPORTED: 'unsupported',
  INSECURE: 'insecure',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable',
  BUSY: 'busy',
  STREAM: 'stream-failed',
});

export class CameraError extends Error {
  constructor(reason, message, cause) {
    super(message);
    this.name = 'CameraError';
    this.reason = reason;
    this.cause = cause;
  }
}

export function describeCameraError(err) {
  const reason = err instanceof CameraError ? err.reason : mapReason(err);
  switch (reason) {
    case CAMERA_ERROR.DENIED:
      return {
        reason,
        title: 'Camera access is off',
        message: 'Life Progress needs camera access to take your progress photo. You can allow it in your browser settings and try again.',
        retry: true,
      };
    case CAMERA_ERROR.UNAVAILABLE:
      return {
        reason,
        title: 'No camera found',
        message: 'We could not find a camera on this device. You can still add a progress photo from your gallery.',
        retry: true,
      };
    case CAMERA_ERROR.BUSY:
      return {
        reason,
        title: 'Camera is busy',
        message: 'Another app or tab is using the camera. Close it and try again.',
        retry: true,
      };
    case CAMERA_ERROR.INSECURE:
      return {
        reason,
        title: 'Camera needs a secure connection',
        message: 'Open Life Progress over https:// (or localhost) to use the camera.',
        retry: false,
      };
    case CAMERA_ERROR.UNSUPPORTED:
      return {
        reason,
        title: 'Camera not supported here',
        message: 'This browser does not expose a camera to web apps. You can still add a progress photo from your gallery.',
        retry: false,
      };
    default:
      return {
        reason,
        title: "Couldn't start the camera",
        message: 'Something interrupted the camera. Try again, or add a photo from your gallery instead.',
        retry: true,
      };
  }
}

function mapReason(err) {
  const name = err && err.name ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return CAMERA_ERROR.DENIED;
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return CAMERA_ERROR.UNAVAILABLE;
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return CAMERA_ERROR.BUSY;
  return CAMERA_ERROR.STREAM;
}

/**
 * Video constraints. Everything is an `ideal` preference: phones disagree about
 * what they can deliver, so a strict constraint would break working devices.
 */
function constraintsFor(facingMode) {
  return {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1080 },
      height: { ideal: 1440 },
      aspectRatio: { ideal: 3 / 4 },
      resizeMode: { ideal: 'none' },
    },
  };
}

export function isCameraSupported() {
  return Boolean(
    typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof document !== 'undefined'
  );
}

export function isSecureCameraContext() {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

export function imageCaptureSupported() {
  return typeof window !== 'undefined' && typeof window.ImageCapture === 'function';
}

/** How many cameras this device reports (used to decide if flip is offered). */
export async function countCameras() {
  try {
    if (!navigator.mediaDevices.enumerateDevices) return 0;
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').length;
  } catch {
    return 0;
  }
}

/**
 * Create a camera controller bound to a <video> element.
 *
 * The element is only touched inside start()/stop(), so constructing the
 * controller (or the screen that owns it) never touches the camera.
 */
export function createCameraController(video, options = {}) {
  let stream = null;
  let facingMode = options.facingMode || 'user';
  let started = false;
  let onEnded = options.onEnded || null;
  let trackEndedHandler = null;

  async function start({ facingMode: nextFacing } = {}) {
    if (nextFacing) facingMode = nextFacing;
    if (!isCameraSupported()) {
      throw new CameraError(isSecureCameraContext() ? CAMERA_ERROR.UNSUPPORTED : CAMERA_ERROR.INSECURE, 'Camera is not available in this browser.');
    }
    if (!isSecureCameraContext()) {
      throw new CameraError(CAMERA_ERROR.INSECURE, 'Camera requires a secure context.');
    }

    stop();

    let nextStream;
    try {
      nextStream = await navigator.mediaDevices.getUserMedia(constraintsFor(facingMode));
    } catch (err) {
      // A device that cannot honour the ideal request at all: retry plainly.
      try {
        nextStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        facingMode = 'user';
      } catch (retryErr) {
        throw new CameraError(mapReason(retryErr), 'Could not start the camera.', retryErr);
      }
    }

    stream = nextStream;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');

    await waitForVideoReady(video);

    // Autoplay policies can reject play() before a gesture; frames still render.
    try {
      await video.play();
    } catch {
      /* ignored — the preview works regardless */
    }

    const track = stream.getVideoTracks()[0] || null;
    trackEndedHandler = () => {
      if (started && onEnded) onEnded();
    };
    track?.addEventListener('ended', trackEndedHandler);
    started = true;

    return {
      width: video.videoWidth,
      height: video.videoHeight,
      facingMode,
      label: track ? track.label : '',
    };
  }

  /** Flip front/back when the device actually has more than one camera. */
  async function flip() {
    const next = facingMode === 'user' ? 'environment' : 'user';
    const cameras = await countCameras();
    if (cameras < 2) return { flipped: false, facingMode };
    await start({ facingMode: next });
    return { flipped: true, facingMode };
  }

  function isActive() {
    return Boolean(stream) && stream.getVideoTracks().some((t) => t.readyState === 'live');
  }

  function stop() {
    started = false;
    if (trackEndedHandler && stream) {
      for (const track of stream.getVideoTracks()) track.removeEventListener('ended', trackEndedHandler);
    }
    trackEndedHandler = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* already stopped */
        }
      }
      stream = null;
    }
    if (video) {
      try {
        video.pause?.();
      } catch {
        /* ignore */
      }
      video.srcObject = null;
    }
  }

  /**
   * Capture a still, cropped to the viewport composition.
   * Returns { blob, width, height, source } where `source` records which path
   * produced it — useful in QA and for diagnosing device-specific behavior.
   */
  async function capture({ dstAspect, mirrored = false, maxSize = CAPTURE_MAX_SIZE, quality = CAPTURE_QUALITY } = {}) {
    if (!isActive()) throw new CameraError(CAMERA_ERROR.STREAM, 'The camera is not running.');
    const srcW = video.videoWidth;
    const srcH = video.videoHeight;
    if (!srcW || !srcH) throw new CameraError(CAMERA_ERROR.STREAM, 'The camera has not produced a frame yet.');

    const rect = captureSourceRect({ srcW, srcH, dstAspect });
    let source = 'video-frame';
    let drawable = null;

    if (imageCaptureSupported()) {
      const track = stream.getVideoTracks()[0];
      try {
        const capture = new window.ImageCapture(track);
        if (typeof capture.takePhoto === 'function') {
          const photoBlob = await capture.takePhoto();
          drawable = await createImageBitmap(photoBlob);
          source = 'image-capture';
        } else if (typeof capture.grabFrame === 'function') {
          drawable = await capture.grabFrame();
          source = 'image-capture-frame';
        }
      } catch {
        drawable = null; // fall through to the canvas path
      }
    }

    // The ImageCapture still has its own dimensions; recompute the crop for it.
    const useElement = !drawable;
    const frameW = useElement ? srcW : drawable.width;
    const frameH = useElement ? srcH : drawable.height;
    const frameRect = useElement ? rect : captureSourceRect({ srcW: frameW, srcH: frameH, dstAspect });
    const scale = Math.min(1, maxSize / Math.max(frameRect.sw, frameRect.sh));
    const outW = Math.max(1, Math.round(frameRect.sw * scale));
    const outH = Math.max(1, Math.round(frameRect.sh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    // Mirror at the last step only, so the saved pixels match the preview the
    // user aligned to when the (front-camera) preview is mirrored.
    ctx.save();
    if (mirrored) {
      ctx.translate(outW, 0);
      ctx.scale(-1, 1);
    }
    try {
      ctx.drawImage(useElement ? video : drawable, frameRect.sx, frameRect.sy, frameRect.sw, frameRect.sh, 0, 0, outW, outH);
    } finally {
      ctx.restore();
      if (!useElement && drawable && drawable.close) drawable.close();
    }

    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    // Release the backing store immediately — big canvases are the easiest way
    // to balloon memory on a phone.
    canvas.width = 0;
    canvas.height = 0;
    return { blob, width: outW, height: outH, source };
  }

  return {
    start,
    stop,
    flip,
    capture,
    isActive,
    get facingMode() {
      return facingMode;
    },
    get stream() {
      return stream;
    },
    get video() {
      return video;
    },
    set onEnded(handler) {
      onEnded = handler;
    },
  };
}

function waitForVideoReady(video, timeoutMs = 8000) {
  if (video.videoWidth && video.videoHeight) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('error', onError);
      fn(arg);
    };
    const onReady = () => done(resolve);
    const onError = () => done(reject, new CameraError(CAMERA_ERROR.STREAM, 'The camera stream failed.'));
    const timer = setTimeout(
      () => done(reject, new CameraError(CAMERA_ERROR.STREAM, 'The camera took too long to start.')),
      timeoutMs
    );
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('error', onError);
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new CameraError(CAMERA_ERROR.STREAM, 'Could not encode the photo.'))), type, quality);
  });
}
