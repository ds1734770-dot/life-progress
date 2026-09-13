/**
 * Reference analysis — turn an existing progress photo into a reference pose
 * profile, entirely on this device.
 *
 * Decodes the stored photo blob, runs the (lazily created) pose detector in
 * image mode, derives the compact profile and always releases the decoded
 * bitmap + detector afterwards. The photo itself is never copied or re-encoded:
 * the profile only points at it by id.
 */
import { sourcePoseToViewport, viewportAspectFor } from '../camera/coordinates.js';
import { createPoseDetector, PoseAssetsMissingError } from './detector.js';
import { buildReferenceProfile } from './reference.js';

/** Thrown when the photo contains no usable person. */
export class NoPoseDetectedError extends Error {
  constructor(message = "Couldn't detect a clear pose in this photo.") {
    super(message);
    this.name = 'NoPoseDetectedError';
    this.reason = 'no-pose';
  }
}

/**
 * Analyze a progress photo into a reference profile.
 *
 * @param {{ id: string, blob: Blob, createdAt?: number }} photo
 * @param {object}   options
 *   - onProgress(stage)  'decoding' | 'analyzing' | 'done'
 *   - detector           reuse an existing detector instance (not disposed)
 *   - minConfidence      landmark visibility gate
 * @returns {Promise<{ profile: object }>}
 */
export async function analyzePhotoReference(photo, options = {}) {
  const { onProgress = () => {}, detector } = options;
  if (!photo || !photo.blob) throw new NoPoseDetectedError('That photo has no image data.');

  const ownDetector = !detector;
  const activeDetector = detector || createPoseDetector();
  let bitmap = null;
  let objectUrl = null;
  const image = { close: null, revoke: null };

  try {
    onProgress('decoding');
    const decoded = await decodeBlob(photo.blob);
    bitmap = decoded.source;
    objectUrl = decoded.objectUrl;
    image.close = decoded.close;
    image.revoke = decoded.revoke;

    await activeDetector.initialize();
    onProgress('analyzing');
    const pose = await activeDetector.detectImage(bitmap);
    if (!pose || !pose.landmarks) throw new NoPoseDetectedError();

    // Store the pose in the canonical *composition* space the alignment engine
    // compares in (js/camera/coordinates.js) — identical to the photo's own
    // space unless the aspect had to be clamped for a phone viewport. Without
    // this the engine would compare a clamped viewport against raw image
    // coordinates and report a bogus distance difference.
    const imageAspect = decoded.height / decoded.width;
    const compositionAspect = viewportAspectFor(imageAspect);

    const profile = buildReferenceProfile(sourcePoseToViewport(pose, imageAspect, compositionAspect), {
      photoId: photo.id,
      width: decoded.width,
      height: decoded.height,
      compositionAspect,
      createdAt: Number.isFinite(photo.createdAt) ? photo.createdAt : 0,
      facingMode: null,
      mirrored: false,
      minConfidence: options.minConfidence,
      detector: `${activeDetector.name}:${activeDetector.stats ? activeDetector.stats.model || '' : ''}`.replace(/:$/, ''),
    });

    onProgress('done');
    return { profile };
  } finally {
    // Deterministic cleanup — no retained bitmaps, object URLs or landmarkers.
    if (image.close) image.close();
    if (image.revoke) image.revoke();
    if (ownDetector) activeDetector.dispose();
  }
}

/**
 * Decode a Blob into something the detector can consume. Prefers
 * createImageBitmap (fast, off-thread); falls back to an <img> element, which
 * every browser with a canvas supports.
 */
async function decodeBlob(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close && bitmap.close(),
        revoke: null,
      };
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      close: null,
      revoke: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err instanceof Error ? err : new PoseAssetsMissingError();
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new NoPoseDetectedError('Could not read that photo.'));
    img.src = url;
  });
}
