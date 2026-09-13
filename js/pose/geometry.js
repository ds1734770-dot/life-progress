/**
 * Pose geometry — pure math over normalized body landmarks.
 *
 * No DOM, no camera, no ML runtime: takes the detector's normalized landmarks
 * (x/y in 0..1 of the source frame) and derives the measurements the alignment
 * engine compares — body box, body center, body scale, framing extents, joint
 * angles, head offset, plus coverage/confidence weighting.
 *
 * Coordinate space note: a pose always keeps the coordinate space of the frame
 * it came from. The camera screen converts a live video pose into the same
 * "viewport space" as the reference profile before comparing (js/camera/
 * coordinates.js), so both sides of a comparison here are already compatible —
 * and mirroring of the front-camera preview is never applied to these numbers
 * (it is presentation-only), which keeps anatomy (left/right landmarks)
 * consistent between a reference photo and a live frame.
 */

/** MediaPipe Pose Landmarker landmark indices (33-point BlazePose topology). */
export const LANDMARK = Object.freeze({
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
});

export const LANDMARK_COUNT = 33;

/**
 * Core landmarks used for alignment. Deliberately limited to landmarks that
 * matter for reproducing a standing progress photo (head, torso, arms, legs) —
 * hands and feet add jitter without adding composition information.
 */
export const CORE_LANDMARKS = Object.freeze([
  LANDMARK.NOSE,
  LANDMARK.LEFT_SHOULDER,
  LANDMARK.RIGHT_SHOULDER,
  LANDMARK.LEFT_ELBOW,
  LANDMARK.RIGHT_ELBOW,
  LANDMARK.LEFT_WRIST,
  LANDMARK.RIGHT_WRIST,
  LANDMARK.LEFT_HIP,
  LANDMARK.RIGHT_HIP,
  LANDMARK.LEFT_KNEE,
  LANDMARK.RIGHT_KNEE,
  LANDMARK.LEFT_ANKLE,
  LANDMARK.RIGHT_ANKLE,
]);

/** index → stable name, so profiles stay readable/serializable. */
export const CORE_LANDMARK_NAMES = Object.freeze({
  [LANDMARK.NOSE]: 'nose',
  [LANDMARK.LEFT_SHOULDER]: 'leftShoulder',
  [LANDMARK.RIGHT_SHOULDER]: 'rightShoulder',
  [LANDMARK.LEFT_ELBOW]: 'leftElbow',
  [LANDMARK.RIGHT_ELBOW]: 'rightElbow',
  [LANDMARK.LEFT_WRIST]: 'leftWrist',
  [LANDMARK.RIGHT_WRIST]: 'rightWrist',
  [LANDMARK.LEFT_HIP]: 'leftHip',
  [LANDMARK.RIGHT_HIP]: 'rightHip',
  [LANDMARK.LEFT_KNEE]: 'leftKnee',
  [LANDMARK.RIGHT_KNEE]: 'rightKnee',
  [LANDMARK.LEFT_ANKLE]: 'leftAnkle',
  [LANDMARK.RIGHT_ANKLE]: 'rightAnkle',
});

/** name → index, for callers that hold profiles keyed by landmark name. */
export const CORE_INDEX_BY_NAME = Object.freeze(
  Object.fromEntries(Object.entries(CORE_LANDMARK_NAMES).map(([index, name]) => [name, Number(index)]))
);

/** Bone pairs used by the skeleton overlay (drawing + posture comparisons). */
export const POSE_CONNECTIONS = Object.freeze([
  [LANDMARK.LEFT_SHOULDER, LANDMARK.RIGHT_SHOULDER],
  [LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_ELBOW],
  [LANDMARK.LEFT_ELBOW, LANDMARK.LEFT_WRIST],
  [LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_ELBOW],
  [LANDMARK.RIGHT_ELBOW, LANDMARK.RIGHT_WRIST],
  [LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_HIP],
  [LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_HIP],
  [LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP],
  [LANDMARK.LEFT_HIP, LANDMARK.LEFT_KNEE],
  [LANDMARK.LEFT_KNEE, LANDMARK.LEFT_ANKLE],
  [LANDMARK.RIGHT_HIP, LANDMARK.RIGHT_KNEE],
  [LANDMARK.RIGHT_KNEE, LANDMARK.RIGHT_ANKLE],
  [LANDMARK.NOSE, LANDMARK.LEFT_SHOULDER],
  [LANDMARK.NOSE, LANDMARK.RIGHT_SHOULDER],
]);

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const num = (n, fallback = 0) => (Number.isFinite(n) ? n : fallback);

/** Per-landmark visibility (MediaPipe reports `visibility`; `presence` is a fallback). */
export function landmarkConfidence(lm) {
  if (!lm) return 0;
  return clamp01(num(lm.visibility, num(lm.presence, 0)));
}

/**
 * Coerce raw detector output into a stable landmark array. Missing/invalid
 * entries become explicit low-confidence placeholders rather than holes, so
 * downstream math never has to null-check array positions.
 */
export function toLandmarks(raw) {
  const out = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const lm = Array.isArray(raw) ? raw[i] : null;
    out.push(
      lm
        ? { x: clamp01(num(lm.x, 0)), y: clamp01(num(lm.y, 0)), z: num(lm.z, 0), visibility: landmarkConfidence(lm) }
        : { x: 0, y: 0, z: 0, visibility: 0 }
    );
  }
  return out;
}

/**
 * Build the internal NormalizedPose representation every other module speaks:
 *
 *   { landmarks, confidence, coverage, timestamp, imageWidth, imageHeight, source }
 *
 * - `confidence` is how trustworthy the landmarks we can see are (mean
 *   visibility over the present core landmarks) — drives guidance about
 *   lighting/occlusion, never framing.
 * - `coverage` is how much of the body is visible (share of core landmarks
 *   above `minConfidence`) — drives the framing/partial-body checks.
 */
export function normalizePose(raw, meta = {}) {
  const landmarks = toLandmarks(raw);
  const { confidence, coverage } = poseQuality(landmarks, meta.minConfidence ?? 0.5);
  return {
    landmarks,
    confidence,
    coverage,
    timestamp: num(meta.timestamp, 0),
    imageWidth: Math.max(1, Math.round(num(meta.imageWidth, 0))),
    imageHeight: Math.max(1, Math.round(num(meta.imageHeight, 0))),
    source: meta.source || 'video',
  };
}

export function poseQuality(landmarks, minConfidence = 0.5) {
  let visible = 0;
  let sum = 0;
  for (const index of CORE_LANDMARKS) {
    const conf = landmarkConfidence(landmarks[index]);
    if (conf > 0) {
      visible += 1;
      sum += conf;
    }
  }
  const coverage = visible / CORE_LANDMARKS.length;
  // Confidence over visible landmarks only: a cropped leg must not read as
  // "bad lighting", and a shadowed face must not read as "person missing".
  const confidence = visible ? sum / visible : 0;
  return { confidence: round3(confidence), coverage: round3(coverage) };
}

/** Named view of the core landmarks (profiles store this shape). */
export function namedLandmarks(pose) {
  const out = {};
  for (const index of CORE_LANDMARKS) {
    const lm = pose.landmarks[index];
    out[CORE_LANDMARK_NAMES[index]] = { x: round4(lm.x), y: round4(lm.y), visibility: round3(landmarkConfidence(lm)) };
  }
  return out;
}

export function isVisible(lm, minConfidence = 0.5) {
  return landmarkConfidence(lm) >= minConfidence;
}

/**
 * Axis-aligned box around the visible core landmarks, normalized to the frame.
 * `top`/`bottom`/`left`/`right` are the framing extents (head height → lowest
 * visible body landmark, ± body width).
 */
export function bodyBounds(pose, minConfidence = 0.5) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  let count = 0;
  for (const index of CORE_LANDMARKS) {
    const lm = pose.landmarks[index];
    if (!isVisible(lm, minConfidence)) continue;
    count += 1;
    left = Math.min(left, lm.x);
    right = Math.max(right, lm.x);
    top = Math.min(top, lm.y);
    bottom = Math.max(bottom, lm.y);
  }
  if (count < 2) return null;
  return {
    left: round4(left),
    right: round4(right),
    top: round4(top),
    bottom: round4(bottom),
    x: round4((left + right) / 2),
    y: round4((top + bottom) / 2),
    width: round4(right - left),
    height: round4(bottom - top),
    count,
  };
}

/** Body height in frame-normalized units — the "how big is the person" scale. */
export function bodyScale(pose, minConfidence = 0.5) {
  const bounds = bodyBounds(pose, minConfidence);
  return bounds ? bounds.height : 0;
}

/**
 * Body center. The hip/shoulder midline is far more stable than the bounding
 * box (which jumps when an arm moves), so prefer it and fall back to the box.
 */
export function bodyCenter(pose, minConfidence = 0.5) {
  const shoulderMid = midpoint(
    get(pose, LANDMARK.LEFT_SHOULDER, minConfidence),
    get(pose, LANDMARK.RIGHT_SHOULDER, minConfidence)
  );
  const hipMid = midpoint(
    get(pose, LANDMARK.LEFT_HIP, minConfidence),
    get(pose, LANDMARK.RIGHT_HIP, minConfidence)
  );
  if (shoulderMid && hipMid) {
    return { x: round4((shoulderMid.x + hipMid.x) / 2), y: round4((shoulderMid.y + hipMid.y) / 2), source: 'torso' };
  }
  const single = shoulderMid || hipMid;
  if (single) return { x: round4(single.x), y: round4(single.y), source: shoulderMid ? 'shoulders' : 'hips' };
  const bounds = bodyBounds(pose, minConfidence);
  if (bounds) return { x: bounds.x, y: bounds.y, source: 'bounds' };
  return null;
}

/** Shoulder width in frame-normalized units — the stable, scale-aware ruler. */
export function shoulderWidth(pose, minConfidence = 0.5) {
  const l = get(pose, LANDMARK.LEFT_SHOULDER, minConfidence);
  const r = get(pose, LANDMARK.RIGHT_SHOULDER, minConfidence);
  return l && r ? round4(distance(l, r)) : 0;
}

/**
 * Head position relative to the shoulders, expressed in shoulder widths so it
 * is invariant to body scale — catches "chin down / head tilted away" drift.
 */
export function headOffset(pose, minConfidence = 0.5) {
  const nose = get(pose, LANDMARK.NOSE, minConfidence);
  const l = get(pose, LANDMARK.LEFT_SHOULDER, minConfidence);
  const r = get(pose, LANDMARK.RIGHT_SHOULDER, minConfidence);
  if (!nose || !l || !r) return null;
  const scale = distance(l, r);
  if (scale <= 1e-6) return null;
  const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
  return { dx: round4((nose.x - mid.x) / scale), dy: round4((nose.y - mid.y) / scale), scale: round4(scale) };
}

/**
 * Joint geometry.
 *
 * - `shoulder` / `hip`: signed slope of the shoulder / hip line in degrees
 *   (0 = level, positive = the right side sits lower in the frame).
 * - `torso`: signed lean of the shoulder-mid → hip-mid axis in degrees off
 *   vertical (0 = upright, positive = leaning toward frame right).
 * - `elbowLeft/Right`, `kneeLeft/Right`: interior joint angle in degrees
 *   (0..180) — 180 = straight limb.
 *
 * Every angle is null when its landmarks are not confidently visible, so the
 * engine can weight what it actually measured instead of guessing.
 */
export function jointAngles(pose, minConfidence = 0.5) {
  const p = (index) => get(pose, index, minConfidence);
  const ls = p(LANDMARK.LEFT_SHOULDER);
  const rs = p(LANDMARK.RIGHT_SHOULDER);
  const le = p(LANDMARK.LEFT_ELBOW);
  const re = p(LANDMARK.RIGHT_ELBOW);
  const lw = p(LANDMARK.LEFT_WRIST);
  const rw = p(LANDMARK.RIGHT_WRIST);
  const lh = p(LANDMARK.LEFT_HIP);
  const rh = p(LANDMARK.RIGHT_HIP);
  const lk = p(LANDMARK.LEFT_KNEE);
  const rk = p(LANDMARK.RIGHT_KNEE);
  const la = p(LANDMARK.LEFT_ANKLE);
  const ra = p(LANDMARK.RIGHT_ANKLE);

  return {
    shoulder: ls && rs ? round2(segmentAngle(ls, rs)) : null,
    hip: lh && rh ? round2(segmentAngle(lh, rh)) : null,
    torso: ls && rs && lh && rh ? round2(verticalLean(midpoint(ls, rs), midpoint(lh, rh))) : null,
    elbowLeft: ls && le && lw ? round2(angleAt(ls, le, lw)) : null,
    elbowRight: rs && re && rw ? round2(angleAt(rs, re, rw)) : null,
    kneeLeft: lh && lk && la ? round2(angleAt(lh, lk, la)) : null,
    kneeRight: rh && rk && ra ? round2(angleAt(rh, rk, ra)) : null,
  };
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

export function get(pose, index, minConfidence = 0.5) {
  const lm = pose && pose.landmarks ? pose.landmarks[index] : null;
  return lm && isVisible(lm, minConfidence) ? lm : null;
}

export function midpoint(a, b) {
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function distance(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Interior angle at `b` for the path a→b→c, in degrees (0..180). */
export function angleAt(a, b, c) {
  if (!a || !b || !c) return null;
  const v1x = a.x - b.x;
  const v1y = a.y - b.y;
  const v2x = c.x - b.x;
  const v2y = c.y - b.y;
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-6 || m2 < 1e-6) return null;
  const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Signed slope of a→b in degrees, normalized to (-90, 90]. */
export function segmentAngle(a, b) {
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg <= -90) deg += 180;
  return deg;
}

/** Signed lean of a→b off vertical, in degrees (positive = leaning frame-right). */
export function verticalLean(a, b) {
  if (!a || !b) return null;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return null;
  return (Math.atan2(dx, Math.abs(dy)) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Temporal smoothing + movement
// ---------------------------------------------------------------------------

/**
 * Exponential-moving-average smoothing of live landmarks — the cheap,
 * predictable filter that stops the match score from jittering frame to frame.
 * When the person leaves and re-enters, `prev` is null and the new pose is
 * adopted outright so the UI never lags behind a changed scene.
 */
export function smoothPose(prev, next, alpha = 0.5) {
  if (!prev || !next) return next;
  const a = Math.min(1, Math.max(0, alpha));
  const landmarks = next.landmarks.map((lm, i) => {
    const before = prev.landmarks[i];
    if (!before) return lm;
    return {
      x: before.x + (lm.x - before.x) * a,
      y: before.y + (lm.y - before.y) * a,
      z: before.z + (lm.z - before.z) * a,
      visibility: before.visibility + (lm.visibility - before.visibility) * a,
    };
  });
  const pose = normalizePose(landmarks, { timestamp: next.timestamp, imageWidth: next.imageWidth, imageHeight: next.imageHeight, source: next.source });
  pose.smoothed = true;
  return pose;
}

/**
 * Mean landmark movement between two poses, normalized by body height so it is
 * scale-invariant. Used for the "is the user actually holding still" check.
 * Returns 0 when either pose has no usable body.
 */
export function poseMovement(a, b, minConfidence = 0.5) {
  if (!a || !b) return 0;
  const scale = Math.max(bodyScale(a, minConfidence), bodyScale(b, minConfidence), 0.05);
  let sum = 0;
  let count = 0;
  for (const index of CORE_LANDMARKS) {
    const l = get(a, index, minConfidence);
    const r = get(b, index, minConfidence);
    if (!l || !r) continue;
    sum += distance(l, r);
    count += 1;
  }
  return count ? round4(sum / count / scale) : 0;
}

// ---------------------------------------------------------------------------

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
function round3(n) {
  return n == null ? null : Math.round(n * 1000) / 1000;
}
function round4(n) {
  return n == null ? null : Math.round(n * 10000) / 10000;
}
