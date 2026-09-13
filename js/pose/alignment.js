/**
 * Pose alignment engine — the domain layer behind the smart progress camera.
 *
 *   PhotoReferenceProfile ─┐
 *                          ├─► comparePoses() ─► AlignmentResult
 *   NormalizedPose ────────┘
 *
 * The engine is pure and deterministic: it never reads the clock, the DOM, the
 * camera or the ML runtime. Time is always passed in, which is what makes the
 * stability + auto-capture behaviour unit-testable without a browser.
 *
 * Coordinate space: both sides arrive in the same normalized "composition"
 * space (see js/camera/coordinates.js), so position/scale/framing compare
 * like-for-like. Scores are unitless 0..1; guidance is a short kebab-case code
 * plus non-shaming display copy.
 *
 * Weighting rule (same idea as PROGRESS_WEIGHTS in js/utils.js): components the
 * engine could not reliably measure are dropped from BOTH the numerator and
 * denominator, so one missed fingertip — or a cropped ankle — can never fail
 * the whole match.
 */

import {
  CORE_INDEX_BY_NAME,
  CORE_LANDMARKS,
  bodyCenter,
  bodyScale,
  headOffset,
  jointAngles,
  landmarkConfidence,
  poseMovement,
  shoulderWidth,
} from './geometry.js';

/** All tunable thresholds in one place (§39). Tune here, nowhere else. */
export const ALIGNMENT_CONFIG = Object.freeze({
  /** Normalized body-center offset that still counts as "in place". */
  POSITION_TOLERANCE: 0.035,
  /** Offset at which the position score bottoms out at 0. */
  POSITION_TOLERANCE_HARD: 0.16,

  /** Relative body-height difference that still counts as "same distance". */
  SCALE_TOLERANCE: 0.1,
  SCALE_TOLERANCE_HARD: 0.32,

  /** Normalized framing-extent difference that still counts as "same framing". */
  FRAMING_TOLERANCE: 0.05,
  FRAMING_TOLERANCE_HARD: 0.22,

  /** Degrees of joint-angle difference that still counts as "same posture". */
  POSTURE_TOLERANCE_DEG: 7,
  POSTURE_TOLERANCE_HARD_DEG: 32,

  /** Head offset is measured in shoulder widths (scale invariant). */
  HEAD_TOLERANCE: 0.12,
  HEAD_TOLERANCE_HARD: 0.5,

  /** Landmark visibility below this is ignored rather than guessed at. */
  MIN_LANDMARK_CONFIDENCE: 0.5,
  /** Overall pose confidence below this is treated as unusable. */
  MIN_ALIGNMENT_CONFIDENCE: 0.45,
  /** Share of the core body that must be visible to align at all. */
  MIN_LIVE_COVERAGE: 0.5,
  /**
   * How much less of the body than the reference we may still see before the
   * framing/scale measurements stop being comparable. Without this, a cropped
   * leg would read as "you are much closer than last time".
   */
  COVERAGE_GAP_TOLERANCE: 0.2,

  /** Alignment must hold this long before it counts as stable (§18/§41). */
  STABLE_DURATION_MS: 1000,
  /** Score a "stable" run has to sustain. */
  STABILITY_MIN_SCORE: 0.82,
  /** Mean landmark movement per sample (× body height) allowed while stable. */
  STABILITY_MAX_MOVEMENT: 0.035,
  /** Frame-to-frame score wobble allowed while stable. */
  STABILITY_MAX_SCORE_DELTA: 0.07,
  /** Never call it stable off one or two lucky samples. */
  MIN_STABLE_SAMPLES: 5,

  /** Score at which the status reads PERFECT and auto-capture arms. */
  CAPTURE_SCORE_THRESHOLD: 0.82,
  /** "Good" / "Almost perfect" display bands. */
  GOOD_SCORE_THRESHOLD: 0.62,
  ALMOST_SCORE_THRESHOLD: 0.76,
  /**
   * Every measurable aspect (position / scale / framing / posture / head) must
   * reach this for the state to read PERFECT and for auto-capture to arm. It is
   * what keeps a high average with one clearly wrong aspect (e.g. a badly
   * crooked stance) from silently firing the shutter — and it matches the ✓
   * chips the user is actually looking at.
   */
  GOOD_COMPONENT_THRESHOLD: 0.7,
  /**
   * How much the single worst posture angle is allowed to pull the posture
   * score down. Averaging alone would let six happy joints drown out one
   * badly mismatched limb.
   */
  POSTURE_WORST_BLEND: 0.33,

  /** Dead-zone that keeps "move left/right" from flickering (§40). */
  GUIDANCE_HYSTERESIS: 0.012,
  /** Consecutive samples needed to switch to a less urgent instruction. */
  GUIDANCE_STABLE_FRAMES: 3,

  /** "Perfect — hold still" pause before the countdown starts. */
  HOLD_PROMPT_MS: 450,
  /** Optional 3 → 2 → 1 countdown, and its step length. */
  COUNTDOWN_STEPS: 3,
  COUNTDOWN_STEP_MS: 650,

  /** Component weights — must sum to ~1 (they are renormalized anyway). */
  WEIGHTS: Object.freeze({ POSITION: 0.3, SCALE: 0.22, FRAMING: 0.16, POSTURE: 0.2, HEAD: 0.12 }),

  /** Exponential smoothing for live landmarks / display score (§9). */
  POSE_SMOOTHING_ALPHA: 0.5,
  SCORE_SMOOTHING_ALPHA: 0.3,

  /** Posture angles by importance — the torso matters most. */
  ANGLE_WEIGHTS: Object.freeze({
    torso: 1.4,
    shoulder: 1.1,
    hip: 1,
    elbowLeft: 0.6,
    elbowRight: 0.6,
    kneeLeft: 0.7,
    kneeRight: 0.7,
  }),
});

/** Landmarks each posture angle depends on (for reliability weighting). */
const ANGLE_SOURCES = Object.freeze({
  shoulder: ['leftShoulder', 'rightShoulder'],
  hip: ['leftHip', 'rightHip'],
  torso: ['leftShoulder', 'rightShoulder', 'leftHip', 'rightHip'],
  elbowLeft: ['leftShoulder', 'leftElbow', 'leftWrist'],
  elbowRight: ['rightShoulder', 'rightElbow', 'rightWrist'],
  kneeLeft: ['leftHip', 'leftKnee', 'leftAnkle'],
  kneeRight: ['rightHip', 'rightKnee', 'rightAnkle'],
});

/** Guidance codes — stable ids the UI maps to copy/arrows. */
export const GUIDANCE = Object.freeze({
  NONE: 'none',
  NO_PERSON: 'no-person',
  LOW_CONFIDENCE: 'low-confidence',
  FRAMING: 'framing',
  MOVE_CLOSER: 'move-closer',
  MOVE_BACK: 'move-back',
  MOVE_LEFT: 'move-left',
  MOVE_RIGHT: 'move-right',
  MOVE_UP: 'move-up',
  MOVE_DOWN: 'move-down',
  SHOULDERS: 'straighten-shoulders',
  TORSO: 'stand-straight',
  ARM: 'match-arm',
  LEGS: 'match-stance',
  HEAD: 'adjust-head',
  HOLD: 'hold',
  CAPTURE: 'capture',
});

/** Correction order (§16): lower rank wins. */
export const GUIDANCE_RANK = Object.freeze({
  [GUIDANCE.NONE]: 0,
  [GUIDANCE.NO_PERSON]: 1,
  [GUIDANCE.LOW_CONFIDENCE]: 2,
  [GUIDANCE.FRAMING]: 3,
  [GUIDANCE.MOVE_CLOSER]: 4,
  [GUIDANCE.MOVE_BACK]: 4,
  [GUIDANCE.MOVE_LEFT]: 5,
  [GUIDANCE.MOVE_RIGHT]: 5,
  [GUIDANCE.MOVE_UP]: 6,
  [GUIDANCE.MOVE_DOWN]: 6,
  [GUIDANCE.TORSO]: 7,
  [GUIDANCE.SHOULDERS]: 7,
  [GUIDANCE.ARM]: 8,
  [GUIDANCE.LEGS]: 8,
  [GUIDANCE.HEAD]: 8,
  [GUIDANCE.HOLD]: 9,
  [GUIDANCE.CAPTURE]: 10,
});

/** Category of the current instruction — used by the status UI. */
export const GUIDANCE_PRIORITY = Object.freeze({
  [GUIDANCE.NONE]: 'none',
  [GUIDANCE.NO_PERSON]: 'visibility',
  [GUIDANCE.LOW_CONFIDENCE]: 'visibility',
  [GUIDANCE.FRAMING]: 'framing',
  [GUIDANCE.MOVE_CLOSER]: 'distance',
  [GUIDANCE.MOVE_BACK]: 'distance',
  [GUIDANCE.MOVE_LEFT]: 'position',
  [GUIDANCE.MOVE_RIGHT]: 'position',
  [GUIDANCE.MOVE_UP]: 'framing',
  [GUIDANCE.MOVE_DOWN]: 'framing',
  [GUIDANCE.SHOULDERS]: 'posture',
  [GUIDANCE.TORSO]: 'posture',
  [GUIDANCE.ARM]: 'posture',
  [GUIDANCE.LEGS]: 'posture',
  [GUIDANCE.HEAD]: 'posture',
  [GUIDANCE.HOLD]: 'stability',
  [GUIDANCE.CAPTURE]: 'capture',
});

const DIRECTION_WORD = Object.freeze({ left: 'left', right: 'right', up: 'up', down: 'down' });

/** Non-shaming display copy (§60). `strength` picks the gentle escalation. */
export function guidanceText(code, strength = 'small') {
  const move = (dir) =>
    strength === 'large' ? `Move further ${DIRECTION_WORD[dir]}` : strength === 'medium' ? `Move ${DIRECTION_WORD[dir]}` : `Move slightly ${DIRECTION_WORD[dir]}`;
  switch (code) {
    case GUIDANCE.NO_PERSON:
      return 'Step into the frame';
    case GUIDANCE.LOW_CONFIDENCE:
      return 'Move into better light';
    case GUIDANCE.FRAMING:
      return 'Step back so your whole body fits';
    case GUIDANCE.MOVE_CLOSER:
      return 'Move closer';
    case GUIDANCE.MOVE_BACK:
      return 'Move back';
    case GUIDANCE.MOVE_LEFT:
      return move('left');
    case GUIDANCE.MOVE_RIGHT:
      return move('right');
    case GUIDANCE.MOVE_UP:
      return move('up');
    case GUIDANCE.MOVE_DOWN:
      return move('down');
    case GUIDANCE.SHOULDERS:
      return 'Level your shoulders';
    case GUIDANCE.TORSO:
      return 'Stand a little straighter';
    case GUIDANCE.ARM:
      return 'Match your arm position';
    case GUIDANCE.LEGS:
      return 'Match your stance';
    case GUIDANCE.HEAD:
      return 'Adjust your head';
    case GUIDANCE.HOLD:
      return 'Perfect — hold still';
    case GUIDANCE.CAPTURE:
      return 'Captured';
    default:
      return 'Hold your position';
  }
}

/** Strength bucket from a normalized correction magnitude. */
function strengthFor(magnitude, tolerance) {
  if (magnitude >= tolerance * 3) return 'large';
  if (magnitude >= tolerance * 1.8) return 'medium';
  return 'small';
}

// ---------------------------------------------------------------------------
// Scoring primitives
// ---------------------------------------------------------------------------

/**
 * Full marks inside `tolerance`, decaying linearly to 0 at `hard`. Shared by
 * every component so all scores mean the same thing (1 = same as the
 * reference, 0 = far off) regardless of the unit behind it.
 */
export function toleranceScore(delta, tolerance, hard) {
  if (!Number.isFinite(delta)) return null;
  const magnitude = Math.abs(delta);
  if (magnitude <= tolerance) return 1;
  if (magnitude >= hard) return 0;
  return 1 - (magnitude - tolerance) / (hard - tolerance);
}

function round3(n) {
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------------------
// Core comparison (stateless)
// ---------------------------------------------------------------------------

/**
 * Compare a live pose against a reference profile.
 *
 * Returns an AlignmentResult without stability/guidance state — those are added
 * by createAlignmentEngine(). Every component carries `available`, so callers
 * (and tests) can see exactly which parts were measurable.
 */
export function comparePoses(reference, livePose, cfg = ALIGNMENT_CONFIG) {
  const empty = {
    detected: Boolean(livePose && livePose.landmarks),
    present: false,
    partial: false,
    limbsComparable: false,
    confidence: 0,
    coverage: 0,
    positionScore: 0,
    scaleScore: 0,
    framingScore: 0,
    postureScore: 0,
    headScore: 0,
    overallScore: 0,
    components: {},
    deltas: {},
    measured: {},
  };
  if (!reference || !livePose || !livePose.landmarks) return empty;

  const minConfidence = cfg.MIN_LANDMARK_CONFIDENCE;
  const confidence = round3(livePose.confidence ?? 0);
  const coverage = round3(livePose.coverage ?? 0);
  const referenceConfidence = reference.quality ? reference.quality.confidence : 1;

  const liveCenter = bodyCenter(livePose, minConfidence);
  const liveScale = bodyScale(livePose, minConfidence);
  const refCenter = reference.composition.center;
  const refScale = reference.composition.scale;
  const present = Boolean(liveCenter && liveScale > 0);
  // Framing and scale are only comparable when we can see roughly as much of
  // the live body as the reference showed.
  const referenceCoverage = reference.quality ? reference.quality.coverage ?? 1 : 1;
  const limbsComparable = coverage >= referenceCoverage - cfg.COVERAGE_GAP_TOLERANCE;

  const deltas = {};
  const components = {};

  // ---- Position -----------------------------------------------------------
  if (present && refCenter) {
    deltas.x = round3(liveCenter.x - refCenter.x);
    deltas.y = round3(liveCenter.y - refCenter.y);
    components.position = {
      available: true,
      weight: cfg.WEIGHTS.POSITION,
      score: round3(
        (toleranceScore(deltas.x, cfg.POSITION_TOLERANCE, cfg.POSITION_TOLERANCE_HARD) +
          toleranceScore(deltas.y, cfg.POSITION_TOLERANCE, cfg.POSITION_TOLERANCE_HARD)) /
          2
      ),
    };
  } else {
    components.position = { available: false, weight: cfg.WEIGHTS.POSITION, score: 0 };
  }

  // ---- Scale / camera distance -------------------------------------------
  if (present && refScale > 0 && limbsComparable) {
    deltas.scaleRatio = round3(liveScale / refScale);
    components.scale = {
      available: true,
      weight: cfg.WEIGHTS.SCALE,
      score: round3(toleranceScore(deltas.scaleRatio - 1, cfg.SCALE_TOLERANCE, cfg.SCALE_TOLERANCE_HARD)),
    };
  } else {
    components.scale = { available: false, weight: cfg.WEIGHTS.SCALE, score: 0 };
  }

  // ---- Framing ------------------------------------------------------------
  const refFraming = reference.composition.framing;
  const liveFraming = framingOf(livePose, minConfidence);
  if (refFraming && liveFraming) {
    const keys = ['top', 'bottom', 'left', 'right'];
    const framingDeltas = {};
    const scores = [];
    for (const key of keys) {
      if (!Number.isFinite(refFraming[key]) || !Number.isFinite(liveFraming[key])) continue;
      framingDeltas[key] = round3(liveFraming[key] - refFraming[key]);
      scores.push(toleranceScore(framingDeltas[key], cfg.FRAMING_TOLERANCE, cfg.FRAMING_TOLERANCE_HARD));
    }
    deltas.framing = framingDeltas;
    deltas.framingVertical = round3(((framingDeltas.top || 0) + (framingDeltas.bottom || 0)) / 2);
    components.framing = {
      available: scores.length > 0 && limbsComparable,
      weight: cfg.WEIGHTS.FRAMING,
      score: scores.length ? round3(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
    };
  } else {
    components.framing = { available: false, weight: cfg.WEIGHTS.FRAMING, score: 0 };
  }

  // ---- Posture ------------------------------------------------------------
  const posture = postureComparison(reference, livePose, minConfidence, cfg);
  deltas.posture = posture.deltas;
  deltas.postureWorst = posture.worst;
  components.posture = { available: posture.available, weight: cfg.WEIGHTS.POSTURE, score: posture.score };

  // ---- Head ---------------------------------------------------------------
  const head = headComparison(reference, livePose, minConfidence, cfg);
  deltas.head = head.deltas;
  components.head = { available: head.available, weight: cfg.WEIGHTS.HEAD, score: head.score };

  // ---- Overall ------------------------------------------------------------
  let weighted = 0;
  let weightSum = 0;
  for (const component of Object.values(components)) {
    if (!component.available) continue;
    weighted += component.score * component.weight;
    weightSum += component.weight;
  }
  const overallScore = weightSum > 0 ? round3(weighted / weightSum) : 0;

  // A high average with one clearly wrong aspect is not a match: the status
  // band, the auto-capture arms and the ✓ chips all read this flag (§17/§18).
  const allComponentsGood = Object.values(components).every(
    (component) => !component.available || component.score >= cfg.GOOD_COMPONENT_THRESHOLD
  );

  return {
    detected: true,
    present,
    limbsComparable,
    allComponentsGood,
    partial: present && coverage < cfg.MIN_LIVE_COVERAGE,
    confidence,
    coverage,
    // A low-confidence reference caps how much we trust any match against it.
    referenceConfidence: round3(referenceConfidence ?? 1),
    positionScore: components.position.score,
    scaleScore: components.scale.score,
    framingScore: components.framing.score,
    postureScore: components.posture.score,
    headScore: components.head.score,
    overallScore,
    components,
    deltas,
    measured: {
      liveScale: round3(liveScale),
      referenceScale: round3(refScale),
      liveCenter,
      referenceCenter: refCenter ? { x: refCenter.x, y: refCenter.y } : null,
      shoulderWidth: round3(shoulderWidth(livePose, minConfidence)),
      angles: posture.liveAngles,
      referenceAngles: posture.referenceAngles,
    },
  };
}

function framingOf(pose, minConfidence) {
  const mins = { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity };
  let any = false;
  for (const index of CORE_LANDMARKS) {
    const lm = pose.landmarks[index];
    if (!lm || landmarkConfidence(lm) < minConfidence) continue;
    any = true;
    mins.top = Math.min(mins.top, lm.y);
    mins.bottom = Math.max(mins.bottom, lm.y);
    mins.left = Math.min(mins.left, lm.x);
    mins.right = Math.max(mins.right, lm.x);
  }
  return any ? mins : null;
}

function postureComparison(reference, livePose, minConfidence, cfg) {
  const referenceAngles = (reference.pose && reference.pose.angles) || {};
  const liveAngles = {}; // filled with the angles that are actually comparable
  const angles = jointAngles(livePose, minConfidence);
  const referenceLandmarks = (reference.pose && reference.pose.landmarks) || {};

  let weighted = 0;
  let weightSum = 0;
  const deltas = {};
  let worst = null;

  for (const [angle, weight] of Object.entries(cfg.ANGLE_WEIGHTS)) {
    const refValue = referenceAngles[angle];
    const liveValue = angles[angle];
    if (!Number.isFinite(refValue) || !Number.isFinite(liveValue)) continue;
    const reliability = Math.min(angleReliability(referenceLandmarks, angle), angleReliabilityLive(livePose, angle, minConfidence));
    if (reliability < 0.5) continue; // low-confidence landmarks must not dominate
    const delta = Math.abs(liveValue - refValue);
    const score = toleranceScore(delta, cfg.POSTURE_TOLERANCE_DEG, cfg.POSTURE_TOLERANCE_HARD_DEG);
    deltas[angle] = round3(liveValue - refValue);
    weighted += score * weight * reliability;
    weightSum += weight * reliability;
    if (!worst || delta > worst.delta) worst = { angle, delta: round3(delta), score };
    liveAngles[angle] = liveValue;
  }

  if (!weightSum) {
    return { available: false, score: 0, deltas: {}, worst: null, liveAngles: {}, referenceAngles };
  }
  const mean = weighted / weightSum;
  const blended = worst
    ? mean + (worst.score - mean) * cfg.POSTURE_WORST_BLEND
    : mean;
  return {
    available: true,
    score: round3(blended),
    mean: round3(mean),
    deltas,
    worst,
    liveAngles,
    referenceAngles,
  };
}

function angleReliability(referenceLandmarks, angle) {
  const names = ANGLE_SOURCES[angle] || [];
  let min = 1;
  for (const name of names) {
    const lm = referenceLandmarks[name];
    min = Math.min(min, lm ? landmarkConfidence(lm) : 0);
  }
  return names.length ? min : 0;
}

function angleReliabilityLive(pose, angle, minConfidence) {
  const names = ANGLE_SOURCES[angle] || [];
  let min = 1;
  for (const name of names) {
    const index = CORE_INDEX_BY_NAME[name];
    const lm = index == null ? null : pose.landmarks[index];
    min = Math.min(min, lm ? landmarkConfidence(lm) : 0);
  }
  return names.length ? min : 0;
}

function headComparison(reference, livePose, minConfidence, cfg) {
  const refHead = reference.pose && reference.pose.head;
  const liveHead = headOffset(livePose, minConfidence);
  if (!refHead || !liveHead) return { available: false, score: 0, deltas: {} };
  const dx = liveHead.dx - refHead.dx;
  const dy = liveHead.dy - refHead.dy;
  return {
    available: true,
    score: round3(
      (toleranceScore(dx, cfg.HEAD_TOLERANCE, cfg.HEAD_TOLERANCE_HARD) +
        toleranceScore(dy, cfg.HEAD_TOLERANCE, cfg.HEAD_TOLERANCE_HARD)) /
        2
    ),
    deltas: { dx: round3(dx), dy: round3(dy) },
  };
}

// ---------------------------------------------------------------------------
// Guidance selection
// ---------------------------------------------------------------------------

/**
 * Pick the single most valuable correction (§16) plus its display copy.
 *
 * `options.mirrored` expresses the horizontal instruction in *display* space:
 * a front-camera preview is mirrored, so "move left" must mean "left as you
 * see it on screen" — the same direction the body should physically travel.
 * The alignment scores themselves are mirror-agnostic.
 */
export function chooseGuidance(reference, livePose, result, cfg = ALIGNMENT_CONFIG, options = {}) {
  const mirrored = Boolean(options.mirrored);
  const previous = options.previous || null;

  // Nothing detected at all is different from "detected but unusable": the
  // first asks the user to step in, the second to find better light.
  if (!result.detected) {
    return make(GUIDANCE.NO_PERSON, 'small');
  }
  if (result.confidence < cfg.MIN_ALIGNMENT_CONFIDENCE) {
    return make(GUIDANCE.LOW_CONFIDENCE, 'small');
  }
  if (!result.present) {
    return make(GUIDANCE.NO_PERSON, 'small');
  }
  // Not enough of the body visible (or far less than the reference showed):
  // no distance/position advice can be trusted yet, so ask for the whole body.
  if (result.coverage < cfg.MIN_LIVE_COVERAGE || result.limbsComparable === false) {
    return make(GUIDANCE.FRAMING, 'small');
  }

  // Framing first: vertical placement inside the frame, then body extents.
  const framingVertical = result.deltas.framingVertical;
  if (Number.isFinite(framingVertical) && Math.abs(framingVertical) > cfg.FRAMING_TOLERANCE) {
    if (result.deltas.framing && (result.deltas.framing.top || 0) > cfg.FRAMING_TOLERANCE_HARD / 2) {
      return make(GUIDANCE.FRAMING, 'small');
    }
    // Live body sits lower in the frame than the reference → move up.
    return framingVertical > 0 ? make(GUIDANCE.MOVE_UP, strengthFor(framingVertical, cfg.FRAMING_TOLERANCE)) : make(
      GUIDANCE.MOVE_DOWN,
      strengthFor(framingVertical, cfg.FRAMING_TOLERANCE)
    );
  }

  // Distance (§14) — physical movement only, never digital scaling.
  const scaleDelta = Number.isFinite(result.deltas.scaleRatio) ? result.deltas.scaleRatio - 1 : 0;
  if (Math.abs(scaleDelta) > cfg.SCALE_TOLERANCE) {
    return scaleDelta < 0
      ? make(GUIDANCE.MOVE_CLOSER, strengthFor(scaleDelta, cfg.SCALE_TOLERANCE))
      : make(GUIDANCE.MOVE_BACK, strengthFor(scaleDelta, cfg.SCALE_TOLERANCE));
  }

  // Horizontal (§13), with the anti-flicker dead zone applied to the direction
  // opposite the one currently displayed.
  const displayX = mirrored ? -(result.deltas.x || 0) : result.deltas.x || 0;
  const horizontalDeadZone =
    cfg.POSITION_TOLERANCE + (previous === GUIDANCE.MOVE_LEFT || previous === GUIDANCE.MOVE_RIGHT ? cfg.GUIDANCE_HYSTERESIS : 0);
  if (Math.abs(displayX) > horizontalDeadZone) {
    return displayX > 0 ? make(GUIDANCE.MOVE_LEFT, strengthFor(displayX, cfg.POSITION_TOLERANCE)) : make(
      GUIDANCE.MOVE_RIGHT,
      strengthFor(displayX, cfg.POSITION_TOLERANCE)
    );
  }

  // Vertical body position.
  const displayY = result.deltas.y || 0;
  if (Math.abs(displayY) > cfg.POSITION_TOLERANCE) {
    return displayY > 0 ? make(GUIDANCE.MOVE_UP, strengthFor(displayY, cfg.POSITION_TOLERANCE)) : make(
      GUIDANCE.MOVE_DOWN,
      strengthFor(displayY, cfg.POSITION_TOLERANCE)
    );
  }

  // Posture (§15) — worst offender only.
  const worst = result.deltas.postureWorst;
  if (worst && worst.delta > cfg.POSTURE_TOLERANCE_DEG) {
    const code =
      worst.angle === 'torso' || worst.angle === 'hip'
        ? GUIDANCE.TORSO
        : worst.angle === 'shoulder'
          ? GUIDANCE.SHOULDERS
          : worst.angle.startsWith('elbow')
            ? GUIDANCE.ARM
            : GUIDANCE.LEGS;
    return make(code, strengthFor(worst.delta, cfg.POSTURE_TOLERANCE_DEG));
  }

  const headDeltas = result.deltas.head || {};
  const headMagnitude = Math.max(Math.abs(headDeltas.dx || 0), Math.abs(headDeltas.dy || 0));
  if (headMagnitude > cfg.HEAD_TOLERANCE) {
    return make(GUIDANCE.HEAD, strengthFor(headMagnitude, cfg.HEAD_TOLERANCE));
  }

  return make(GUIDANCE.NONE, 'small');

  function make(code, strength) {
    return {
      code,
      text: guidanceText(code, strength),
      strength,
      rank: GUIDANCE_RANK[code] ?? 0,
      priority: GUIDANCE_PRIORITY[code] || 'none',
    };
  }
}

/**
 * Guidance stabilizer (§40): holds the current instruction until it is either
 * satisfied or clearly replaced, so the prompt never flickers between
 * "move left" / "move right" while the user is standing still.
 */
export function createGuidanceStabilizer(cfg = ALIGNMENT_CONFIG) {
  let current = null;
  let candidate = null;
  let candidateCount = 0;

  return {
    update(next) {
      if (!next) return null;
      if (!current || next.code === current.code) {
        current = next;
        candidate = null;
        candidateCount = 0;
        return current;
      }
      // A more urgent correction takes over immediately (§16 priority order);
      // anything else has to persist for a few samples first.
      const urgent = next.rank < current.rank;
      candidate = candidate && candidate.code === next.code ? candidate : next;
      candidateCount = candidate.code === next.code ? candidateCount + 1 : 1;
      if (urgent || candidateCount >= cfg.GUIDANCE_STABLE_FRAMES) {
        current = next;
        candidate = null;
        candidateCount = 0;
      }
      return current;
    },
    current() {
      return current;
    },
    reset() {
      current = null;
      candidate = null;
      candidateCount = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Stability (§18 / §41)
// ---------------------------------------------------------------------------

/**
 * Tracks how long the alignment has been continuously good AND still.
 *
 * Requires: high smoothed score, sufficient confidence, a visible body, low
 * landmark movement and a consistent score — sustained for STABLE_DURATION_MS,
 * over a minimum number of samples. Any precondition failing resets the run.
 */
export function createStabilityTracker(cfg = ALIGNMENT_CONFIG) {
  let heldSince = null;
  let samples = 0;
  let previousScore = null;
  let bestHeld = 0;

  return {
    push(result, now, movement = 0) {
      const good =
        result &&
        result.present &&
        !result.partial &&
        // "position, scale and posture stable" — a high average with one
        // clearly wrong aspect is not a stable match (§18).
        result.allComponentsGood !== false &&
        result.confidence >= cfg.MIN_ALIGNMENT_CONFIDENCE &&
        result.smoothedScore >= cfg.STABILITY_MIN_SCORE &&
        movement <= cfg.STABILITY_MAX_MOVEMENT &&
        (previousScore == null || Math.abs(result.smoothedScore - previousScore) <= cfg.STABILITY_MAX_SCORE_DELTA);

      previousScore = result ? result.smoothedScore : null;

      if (!good) {
        heldSince = null;
        samples = 0;
        return { stable: false, heldMs: 0, progress: 0, bestHeld };
      }
      samples += 1;
      if (heldSince == null) heldSince = now;
      const heldMs = samples >= 2 ? Math.max(0, now - heldSince) : 0;
      const stable = heldMs >= cfg.STABLE_DURATION_MS && samples >= cfg.MIN_STABLE_SAMPLES;
      if (heldMs > bestHeld) bestHeld = heldMs;
      return {
        stable,
        heldMs,
        progress: round3(Math.min(1, heldMs / cfg.STABLE_DURATION_MS)),
        bestHeld,
      };
    },
    reset() {
      heldSince = null;
      samples = 0;
      previousScore = null;
      bestHeld = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Auto capture (§18 / §19)
// ---------------------------------------------------------------------------

/**
 * Pure capture state machine.
 *
 *   aligning ──stable──► holding ──pause──► counting(3,2,1) ──► captured
 *      ▲                    │                    │
 *      └──── destabilised ──┴────────────────────┘
 *
 * Auto-capture is opt-out: `enabled: false` keeps the machine in `aligning`
 * and the UI offers the manual shutter instead. Manual capture always wins.
 */
export function createCaptureController(cfg = ALIGNMENT_CONFIG, options = {}) {
  let phase = 'aligning';
  let holdStartedAt = null;
  let countdownStartedAt = null;
  let countdownValue = 0;
  let autoEnabled = options.enabled !== false;

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    if (next !== 'holding') holdStartedAt = null;
    if (next !== 'counting') countdownStartedAt = null;
    countdownValue = next === 'counting' ? cfg.COUNTDOWN_STEPS : 0;
  }

  return {
    update(result, stability, now) {
      if (phase === 'captured') return snapshot();
      if (!autoEnabled || !stability || !stability.stable) {
        if (phase === 'counting' || phase === 'holding') setPhase('aligning');
        return snapshot();
      }
      if (phase === 'aligning') {
        holdStartedAt = now;
        phase = 'holding';
        return snapshot();
      }
      if (phase === 'holding') {
        if (now - holdStartedAt >= cfg.HOLD_PROMPT_MS) {
          countdownStartedAt = now;
          countdownValue = cfg.COUNTDOWN_STEPS;
          phase = 'counting';
        }
        return snapshot();
      }
      if (phase === 'counting') {
        const elapsed = now - countdownStartedAt;
        const step = Math.floor(elapsed / cfg.COUNTDOWN_STEP_MS);
        const remaining = cfg.COUNTDOWN_STEPS - step;
        if (remaining <= 0) {
          setPhase('captured');
          return snapshot();
        }
        countdownValue = remaining;
        return snapshot();
      }
      return snapshot();
    },
    /** Manual shutter — never blocked by thresholds (§19). */
    requestCapture() {
      phase = 'captured';
      countdownValue = 0;
      return snapshot();
    },
    setAutoEnabled(enabled) {
      autoEnabled = Boolean(enabled);
      if (!autoEnabled) setPhase('aligning');
      return snapshot();
    },
    get autoEnabled() {
      return autoEnabled;
    },
    retake() {
      setPhase('aligning');
      return snapshot();
    },
    reset() {
      phase = 'aligning';
      holdStartedAt = null;
      countdownStartedAt = null;
      countdownValue = 0;
    },
    get phase() {
      return phase;
    },
    snapshot,
  };

  function snapshot() {
    return { phase, countdown: countdownValue, captured: phase === 'captured', holding: phase === 'holding', counting: phase === 'counting' };
  }
}

// ---------------------------------------------------------------------------
// Engine facade
// ---------------------------------------------------------------------------

/**
 * The engine the camera screen talks to: comparison + smoothing + guidance +
 * stability + capture in one lifecycle-managed object.
 *
 *   const engine = createAlignmentEngine();
 *   const result = engine.compare(profile, livePose, { now, mirrored, movement });
 *   engine.reset();
 */
export function createAlignmentEngine(cfg = ALIGNMENT_CONFIG, options = {}) {
  const stability = createStabilityTracker(cfg);
  const guidance = createGuidanceStabilizer(cfg);
  const capture = createCaptureController(cfg, options.capture || {});
  let smoothedScore = null;

  function compare(reference, livePose, opts = {}) {
    const now = Number.isFinite(opts.now) ? opts.now : 0;
    const movement = opts.movement ?? 0;
    const core = comparePoses(reference, livePose, cfg);

    // Display + stability both read the smoothed score so what the user sees is
    // what gates auto-capture (§9 / §17).
    if (core.present) {
      smoothedScore =
        smoothedScore == null
          ? core.overallScore
          : smoothedScore + (core.overallScore - smoothedScore) * cfg.SCORE_SMOOTHING_ALPHA;
    } else {
      smoothedScore = null;
    }

    const result = { ...core, smoothedScore: round3(smoothedScore ?? 0) };

    const stabilityState = stability.push(result, now, movement);
    result.stable = stabilityState.stable;
    result.stableProgress = stabilityState.progress;
    result.heldMs = stabilityState.heldMs;

    const captureState = capture.update(result, stabilityState, now);
    result.phase = captureState.phase;
    result.countdown = captureState.countdown;

    const nextGuidance = chooseGuidance(reference, livePose, result, cfg, {
      mirrored: opts.mirrored,
      previous: guidance.current() ? guidance.current().code : null,
    });
    result.guidanceObject = guidance.update(nextGuidance);
    result.guidance = result.guidanceObject ? result.guidanceObject.code : GUIDANCE.NONE;
    result.guidanceText = result.guidanceObject ? result.guidanceObject.text : '';
    result.guidancePriority = result.guidanceObject ? result.guidanceObject.priority : 'none';
    result.guidanceRank = result.guidanceObject ? result.guidanceObject.rank : 0;

    // The capture phases own the prompt once they take over.
    if (captureState.phase === 'counting') {
      result.guidance = GUIDANCE.HOLD;
      result.guidanceText = guidanceText(GUIDANCE.HOLD);
      result.guidancePriority = 'stability';
    } else if (captureState.phase === 'captured') {
      result.guidance = GUIDANCE.CAPTURE;
      result.guidanceText = guidanceText(GUIDANCE.CAPTURE);
      result.guidancePriority = 'capture';
    }

    result.status = statusFor(result, cfg);
    return result;
  }

  return {
    config: cfg,
    compare,
    /** Explicit manual shutter request — always allowed. */
    requestCapture() {
      return capture.requestCapture();
    },
    setAutoCapture(enabled) {
      return capture.setAutoEnabled(enabled);
    },
    get autoCaptureEnabled() {
      return capture.autoEnabled;
    },
    retake() {
      stability.reset();
      guidance.reset();
      smoothedScore = null;
      return capture.retake();
    },
    reset() {
      stability.reset();
      guidance.reset();
      capture.reset();
      smoothedScore = null;
    },
    get phase() {
      return capture.phase;
    },
  };
}

/** Display band for the status UI (§17). Never negative, never shaming. */
export function statusFor(result, cfg = ALIGNMENT_CONFIG) {
  if (!result.present) return 'empty';
  if (result.guidance === GUIDANCE.CAPTURE) return 'captured';
  if (result.phase === 'counting') return 'perfect';
  if (result.allComponentsGood !== false && (result.stable || result.smoothedScore >= cfg.CAPTURE_SCORE_THRESHOLD)) return 'perfect';
  if (result.smoothedScore >= cfg.ALMOST_SCORE_THRESHOLD) return 'almost';
  if (result.smoothedScore >= cfg.GOOD_SCORE_THRESHOLD) return 'good';
  return 'aligning';
}

export const STATUS_LABEL = Object.freeze({
  empty: 'Aligning',
  aligning: 'Aligning',
  good: 'Good',
  almost: 'Almost perfect',
  perfect: 'Perfect',
  captured: 'Captured',
});

/**
 * Movement between consecutive live poses, used by the stability check. Kept
 * as a re-export so the camera screen has one import for the "is the user
 * holding still" question.
 */
export { poseMovement };
