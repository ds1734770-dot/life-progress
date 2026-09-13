/**
 * Reference pose profile — the compact, derived description of a progress
 * photo that the smart camera aligns against.
 *
 * A profile is *metadata only*: no pixels, no blobs, no dates, no labels. The
 * progress photo itself stays the single authoritative record (js/photos.js),
 * and the profile simply points at it by id. That keeps export/import,
 * deletion and wipe behavior owned by the existing photo pipeline.
 *
 * The format is versioned: an algorithm change bumps
 * REFERENCE_PROFILE_VERSION, old profiles become unusable (the UI offers
 * "re-analyze") and are never silently compared with different math.
 */
import {
  CORE_LANDMARK_NAMES,
  CORE_LANDMARKS,
  LANDMARK,
  bodyBounds,
  bodyCenter,
  bodyScale,
  headOffset,
  jointAngles,
  landmarkConfidence,
  namedLandmarks,
  shoulderWidth,
} from './geometry.js';

export const REFERENCE_PROFILE_VERSION = 1;

/** Minimum share of core landmarks that must be visible for a usable profile. */
export const MIN_USABLE_COVERAGE = 0.55;

/** Landmarks that a full-body progress photo is expected to show. */
const FULL_BODY_LANDMARKS = [
  LANDMARK.NOSE,
  LANDMARK.LEFT_SHOULDER,
  LANDMARK.RIGHT_SHOULDER,
  LANDMARK.LEFT_HIP,
  LANDMARK.RIGHT_HIP,
  LANDMARK.LEFT_KNEE,
  LANDMARK.RIGHT_KNEE,
  LANDMARK.LEFT_ANKLE,
  LANDMARK.RIGHT_ANKLE,
].map((index) => CORE_LANDMARK_NAMES[index]);

/** A full body should occupy at least this share of the frame height. */
const MIN_FULL_BODY_SCALE = 0.4;

/** Body must sit inside these normalized bounds to count as well framed. */
const FRAME_EDGE_MARGIN = 0.015;

/**
 * Build a reference profile from a detected pose.
 *
 * `pose` must already be expressed in the canonical *composition* space the
 * alignment engine compares in (see js/camera/coordinates.js): the space of the
 * viewport the user actually sees, whose aspect is recorded back as
 * `composition.aspect`. For every normal photo this is the photo's own space;
 * it differs only when the aspect had to be clamped for a phone viewport.
 *
 * `imageMeta` describes the source image: { photoId, width, height, createdAt,
 * facingMode, mirrored, compositionAspect, detector }.
 *
 * Returns the profile (including its `quality` verdict) — callers decide
 * whether `quality.usable` is good enough to become the active template, so
 * this stays a pure data function with no UI policy in it.
 */
export function buildReferenceProfile(pose, imageMeta = {}) {
  const minConfidence = imageMeta.minConfidence ?? 0.5;
  const width = Math.max(1, Math.round(imageMeta.width || pose.imageWidth || 1));
  const height = Math.max(1, Math.round(imageMeta.height || pose.imageHeight || 1));
  const compositionAspect = Number.isFinite(imageMeta.compositionAspect) && imageMeta.compositionAspect > 0
    ? imageMeta.compositionAspect
    : height / width;

  const bounds = bodyBounds(pose, minConfidence);
  const center = bodyCenter(pose, minConfidence);

  const profile = {
    id: imageMeta.photoId || null,
    profileVersion: REFERENCE_PROFILE_VERSION,
    photoId: imageMeta.photoId || null,
    createdAt: imageMeta.createdAt ?? 0,
    image: {
      width,
      height,
      aspect: round4(height / width),
    },
    composition: {
      // The space `pose.landmarks` are stored in — the engine's canonical space.
      aspect: round4(compositionAspect),
      bounds,
      center,
      scale: bodyScale(pose, minConfidence),
      shoulderWidth: shoulderWidth(pose, minConfidence),
      framing: bounds
        ? { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right }
        : null,
    },
    pose: {
      landmarks: namedLandmarks(pose),
      angles: jointAngles(pose, minConfidence),
      head: headOffset(pose, minConfidence),
    },
    cameraProfile: {
      facingMode: imageMeta.facingMode || null,
      mirrored: Boolean(imageMeta.mirrored),
      detector: imageMeta.detector || null,
    },
  };

  profile.quality = assessReferenceQuality(profile, { confidence: pose.confidence, coverage: pose.coverage });
  return profile;
}

/**
 * Quality verdict for a candidate reference. Information only — a partial
 * profile is still usable, it just tells the UI to suggest a fuller photo.
 */
export function assessReferenceQuality(profile, poseStats = {}) {
  const landmarks = (profile.pose && profile.pose.landmarks) || {};
  const confidence = Number.isFinite(poseStats.confidence) ? poseStats.confidence : meanVisibility(landmarks);
  const coverage = Number.isFinite(poseStats.coverage) ? poseStats.coverage : visibleShare(landmarks);
  const bounds = profile.composition && profile.composition.bounds;
  const scale = (profile.composition && profile.composition.scale) || 0;

  const present = Object.values(landmarks).some((lm) => landmarkConfidence(lm) >= 0.5);
  const personDetected = Boolean(present && bounds && confidence >= 0.35);

  const fullBodyVisible = FULL_BODY_LANDMARKS.every((name) => landmarkConfidence(landmarks[name]) >= 0.5);

  const framingGood = Boolean(
    bounds &&
      bounds.top > FRAME_EDGE_MARGIN &&
      bounds.bottom < 1 - FRAME_EDGE_MARGIN &&
      bounds.left > -1 &&
      bounds.right < 2 &&
      bounds.left >= -FRAME_EDGE_MARGIN &&
      bounds.right <= 1 + FRAME_EDGE_MARGIN &&
      scale >= MIN_FULL_BODY_SCALE
  );

  const checks = [
    { id: 'person', ok: personDetected, label: 'Person detected' },
    { id: 'full-body', ok: fullBodyVisible, label: 'Full body visible' },
    { id: 'framing', ok: framingGood, label: 'Good framing' },
    { id: 'confidence', ok: confidence >= 0.6, label: 'Clear pose' },
  ];

  const issues = [];
  if (!personDetected) issues.push('no-person');
  if (!fullBodyVisible) issues.push('partial-body');
  if (scale && scale < MIN_FULL_BODY_SCALE) issues.push('too-far');
  if (bounds && (bounds.top <= FRAME_EDGE_MARGIN || bounds.bottom >= 1 - FRAME_EDGE_MARGIN)) issues.push('cut-off');
  if (confidence < 0.6) issues.push('low-confidence');

  // Weighted: being able to see the person and their whole body matters most.
  const score =
    0.4 * (personDetected ? 1 : 0) +
    0.25 * (fullBodyVisible ? 1 : coverage >= MIN_USABLE_COVERAGE ? 0.6 : 0) +
    0.2 * (framingGood ? 1 : 0.4) +
    0.15 * Math.min(1, confidence);

  return {
    personDetected,
    fullBodyVisible,
    framingGood,
    confidence: round3(confidence),
    coverage: round3(coverage),
    scale: round4(scale),
    score: round3(score),
    usable: personDetected && coverage >= MIN_USABLE_COVERAGE,
    partial: personDetected && !fullBodyVisible,
    checks,
    issues,
  };
}

/**
 * Shape + version guard. Returns null for anything that cannot be compared
 * safely — a corrupt record must never reach the alignment math. Callers treat
 * null as "no reference" and offer to re-analyze the photo.
 */
export function parseReferenceProfile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.profileVersion !== REFERENCE_PROFILE_VERSION) return null;
  if (typeof raw.photoId !== 'string' || !raw.photoId) return null;
  const composition = raw.composition;
  const pose = raw.pose;
  if (!composition || !pose || !pose.landmarks || typeof pose.landmarks !== 'object') return null;
  if (!composition.center && !composition.bounds) return null;
  if (!Number.isFinite(composition.scale) || composition.scale <= 0) return null;
  // Every stored landmark must be numerically sane before it is compared.
  for (const name of Object.values(CORE_LANDMARK_NAMES)) {
    const lm = pose.landmarks[name];
    if (!lm) return null;
    for (const key of ['x', 'y', 'visibility']) {
      if (!Number.isFinite(lm[key])) return null;
    }
  }
  return raw;
}

/** True when the profile's stored landmark set is complete enough to compare. */
export function isUsableReferenceProfile(raw) {
  const profile = parseReferenceProfile(raw);
  if (!profile) return false;
  return Boolean(profile.quality ? profile.quality.usable : visibleShare(profile.pose.landmarks) >= MIN_USABLE_COVERAGE);
}

/**
 * User-facing quality copy (§38). Kept here (data only, no DOM) so the wording
 * is consistent between the photo viewer, the template flow and the tests.
 */
export const REFERENCE_QUALITY_COPY = Object.freeze({
  title: 'Reference ready',
  partialTitle: 'Reference ready — partial body',
  retryTitle: "Couldn't detect a clear pose in this photo.",
  retryHint: 'Try a photo where your full body is visible.',
  partialHint: 'Only part of your body is visible, so alignment will focus on that. A full-body photo gives the best match.',
  confirmLabel: 'Use this as your progress template',
  chooseAnother: 'Choose another photo',
});

/**
 * The canonical composition space a profile's landmarks live in. Falls back to
 * the photo's own aspect (and finally to the caller's default) so profiles
 * written before the field existed are still read in the right space.
 */
export function referenceCompositionAspect(profile, fallback = 1) {
  const stored = profile && profile.composition ? profile.composition.aspect : null;
  if (Number.isFinite(stored) && stored > 0) return stored;
  const image = (profile && profile.image) || {};
  if (Number.isFinite(image.width) && Number.isFinite(image.height) && image.width > 0 && image.height > 0) {
    return image.height / image.width;
  }
  return fallback;
}

/** Normalized reference-frame landmark lookup used by overlays + the engine. */
export function referenceLandmarkPoints(profile) {
  const out = {};
  for (const index of CORE_LANDMARKS) {
    const name = CORE_LANDMARK_NAMES[index];
    const lm = profile.pose.landmarks[name];
    if (lm && lm.visibility >= 0.3) out[index] = { x: lm.x, y: lm.y, visibility: lm.visibility };
  }
  return out;
}

// ---------------------------------------------------------------------------

function visibleShare(landmarks) {
  let visible = 0;
  let total = 0;
  for (const name of Object.values(CORE_LANDMARK_NAMES)) {
    total += 1;
    if (landmarkConfidence(landmarks[name]) > 0) visible += 1;
  }
  return total ? visible / total : 0;
}

function meanVisibility(landmarks) {
  let sum = 0;
  let count = 0;
  for (const name of Object.values(CORE_LANDMARK_NAMES)) {
    const conf = landmarkConfidence(landmarks[name]);
    if (conf > 0) {
      sum += conf;
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

function round4(n) {
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
}
