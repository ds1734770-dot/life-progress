/**
 * Shared test fixture — NOT a test file.
 *
 * Builds deterministic synthetic standing poses so the pose geometry, reference
 * profile and alignment engine can be tested without a camera, a model or a
 * browser. No clocks, no randomness: every value is derived from the options.
 *
 * Frame space matches the app: x/y are normalized 0..1 with y growing down, so
 * a smaller `y` means "higher in the frame".
 */
import { LANDMARK, LANDMARK_COUNT, normalizePose } from '../js/pose/geometry.js';
import { buildReferenceProfile } from '../js/pose/reference.js';

/** Body proportions relative to the requested body height (nose → ankles). */
const PROPORTION = {
  noseY: -0.4,
  shoulderY: -0.26,
  hipY: 0,
  kneeY: 0.26,
  ankleY: 0.52,
  shoulderHalf: 0.13,
  hipHalf: 0.1,
  kneeHalf: 0.055,
  ankleHalf: 0.05,
  armY: 0.16,
};

/**
 * Raw landmark array for a standing figure.
 *
 * options: centerX, centerY, height, visibility, shoulderTilt (deg, right side
 * lower when positive), torsoLean (deg, shoulders shifted toward frame right),
 * armLift (0 = arms at sides), elbowBendLeft/Right, kneeBend, missing[],
 * lowConfidence{name: visibility}
 */
export function rawPose(options = {}) {
  const {
    centerX = 0.5,
    centerY = 0.55,
    height = 0.46,
    visibility = 0.95,
    shoulderTilt = 0,
    torsoLean = 0,
    armLift = 0,
    elbowBendLeft = 0,
    elbowBendRight = 0,
    kneeBend = 0,
    missing = [],
    lowConfidence = {},
  } = options;

  const H = height;
  const rad = (deg) => (deg * Math.PI) / 180;
  const landmarks = new Array(LANDMARK_COUNT).fill(null).map(() => ({ x: 0, y: 0, z: 0, visibility: 0 }));

  const lean = Math.tan(rad(torsoLean)) * Math.abs(PROPORTION.shoulderY) * H;
  const shoulderMidX = centerX + lean;
  const shoulderMidY = centerY + PROPORTION.shoulderY * H;
  const tilt = Math.tan(rad(shoulderTilt)) * PROPORTION.shoulderHalf * H;

  const set = (index, x, y, conf = visibility) => {
    landmarks[index] = { x, y, z: 0, visibility: conf };
  };

  // Head
  set(LANDMARK.NOSE, shoulderMidX + tilt * 0.2, centerY + PROPORTION.noseY * H);

  // Shoulders (right side lower for a positive tilt)
  set(LANDMARK.LEFT_SHOULDER, shoulderMidX - PROPORTION.shoulderHalf * H, shoulderMidY - tilt);
  set(LANDMARK.RIGHT_SHOULDER, shoulderMidX + PROPORTION.shoulderHalf * H, shoulderMidY + tilt);

  // Arms: elbow/wrist drop from the shoulder, lifted by armLift.
  const elbowConf = visibility;
  const armDrop = (1 - armLift) * PROPORTION.armY * H;
  set(LANDMARK.LEFT_ELBOW, shoulderMidX - (PROPORTION.shoulderHalf + 0.01 + elbowBendLeft * 0.02) * H, shoulderMidY - tilt + armDrop);
  set(LANDMARK.RIGHT_ELBOW, shoulderMidX + (PROPORTION.shoulderHalf + 0.01 + elbowBendRight * 0.02) * H, shoulderMidY + tilt + armDrop);
  set(LANDMARK.LEFT_WRIST, shoulderMidX - (PROPORTION.shoulderHalf - 0.01) * H, shoulderMidY - tilt + armDrop * 2, elbowConf);
  set(LANDMARK.RIGHT_WRIST, shoulderMidX + (PROPORTION.shoulderHalf - 0.01) * H, shoulderMidY + tilt + armDrop * 2, elbowConf);

  // Hips / legs
  set(LANDMARK.LEFT_HIP, centerX - PROPORTION.hipHalf * H, centerY);
  set(LANDMARK.RIGHT_HIP, centerX + PROPORTION.hipHalf * H, centerY);
  const kneeShift = kneeBend * 0.05 * H;
  set(LANDMARK.LEFT_KNEE, centerX - PROPORTION.kneeHalf * H - kneeShift, centerY + PROPORTION.kneeY * H);
  set(LANDMARK.RIGHT_KNEE, centerX + PROPORTION.kneeHalf * H + kneeShift, centerY + PROPORTION.kneeY * H);
  set(LANDMARK.LEFT_ANKLE, centerX - PROPORTION.ankleHalf * H, centerY + PROPORTION.ankleY * H);
  set(LANDMARK.RIGHT_ANKLE, centerX + PROPORTION.ankleHalf * H, centerY + PROPORTION.ankleY * H);

  for (const name of missing) {
    const index = LANDMARK[name];
    if (index != null) landmarks[index] = { x: 0, y: 0, z: 0, visibility: 0 };
  }
  for (const [name, conf] of Object.entries(lowConfidence)) {
    const index = LANDMARK[name];
    if (index != null && landmarks[index]) landmarks[index].visibility = conf;
  }
  return landmarks;
}

/** Normalized pose (the internal representation) for the options above. */
export function makePose(options = {}, meta = {}) {
  return normalizePose(rawPose(options), {
    timestamp: meta.timestamp ?? 0,
    imageWidth: meta.imageWidth ?? 900,
    imageHeight: meta.imageHeight ?? 1200,
    source: meta.source || 'video',
    minConfidence: meta.minConfidence ?? 0.5,
  });
}

/** Translate every landmark (simulates the user stepping sideways/up-down). */
export function shiftPose(pose, { dx = 0, dy = 0 } = {}) {
  return normalizePose(
    pose.landmarks.map((lm) => ({ ...lm, x: lm.x + dx, y: lm.y + dy })),
    { imageWidth: pose.imageWidth, imageHeight: pose.imageHeight }
  );
}

/** Scale the body about its center (simulates moving closer/further away). */
export function scalePose(pose, factor, { anchorX = 0.5, anchorY = 0.55 } = {}) {
  return normalizePose(
    pose.landmarks.map((lm) => ({
      ...lm,
      x: anchorX + (lm.x - anchorX) * factor,
      y: anchorY + (lm.y - anchorY) * factor,
    })),
    { imageWidth: pose.imageWidth, imageHeight: pose.imageHeight }
  );
}

/** Reference profile built from a synthetic photo (default 900×1200 → 4:3). */
export function makeReference(options = {}, photoId = 'photo-1') {
  const pose = makePose(options, { source: 'image' });
  return buildReferenceProfile(pose, {
    photoId,
    width: 900,
    height: 1200,
    createdAt: 1_700_000_000_000,
    detector: 'test-fixture',
  });
}
