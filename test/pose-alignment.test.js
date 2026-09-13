import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALIGNMENT_CONFIG,
  GUIDANCE,
  GUIDANCE_PRIORITY,
  GUIDANCE_RANK,
  STATUS_LABEL,
  chooseGuidance,
  comparePoses,
  createAlignmentEngine,
  createCaptureController,
  createGuidanceStabilizer,
  createStabilityTracker,
  guidanceText,
  statusFor,
  toleranceScore,
} from '../js/pose/alignment.js';
import { LANDMARK, normalizePose } from '../js/pose/geometry.js';
import { buildReferenceProfile } from '../js/pose/reference.js';
import { sourcePoseToViewport } from '../js/camera/coordinates.js';
import { makePose, makeReference, rawPose, scalePose, shiftPose } from './pose-fixture.js';

const reference = makeReference();
/** Stateless core comparison (no guidance/stability state). */
const compare = (live) => comparePoses(reference, live);
/** Guidance for a pose — the core comparison plus the selection rules. */
const guide = (live, options = {}) => chooseGuidance(reference, live, compare(live), ALIGNMENT_CONFIG, options);

// ---------------------------------------------------------------------------
// Tolerance curve
// ---------------------------------------------------------------------------

test('toleranceScore is full marks inside the tolerance and zero past the hard bound', () => {
  assert.equal(toleranceScore(0, 0.1, 0.5), 1);
  assert.equal(toleranceScore(0.1, 0.1, 0.5), 1);
  assert.equal(toleranceScore(0.5, 0.1, 0.5), 0);
  assert.equal(toleranceScore(2, 0.1, 0.5), 0);
  assert.equal(toleranceScore(-2, 0.1, 0.5), 0);
  assert.ok(Math.abs(toleranceScore(0.3, 0.1, 0.5) - 0.5) < 1e-9);
  assert.equal(toleranceScore(NaN, 0.1, 0.5), null);
});

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

test('an identical pose scores a perfect match', () => {
  const result = compare(makePose());
  assert.equal(result.present, true);
  assert.equal(result.partial, false);
  assert.equal(result.overallScore, 1);
  assert.equal(result.positionScore, 1);
  assert.equal(result.scaleScore, 1);
  assert.equal(result.framingScore, 1);
  assert.equal(result.postureScore, 1);
  assert.equal(result.headScore, 1);
  assert.ok(result.confidence >= 0.9, `confidence ${result.confidence}`);
  assert.equal(result.allComponentsGood, true);
  assert.equal(guide(makePose()).code, GUIDANCE.NONE);
});

test('position score decays with the offset and bottoms out at the hard bound', () => {
  const small = compare(shiftPose(makePose(), { dx: 0.05 }));
  const medium = compare(shiftPose(makePose(), { dx: 0.1 }));
  const extreme = compare(shiftPose(makePose(), { dx: 0.2 }));
  assert.ok(small.positionScore < 1 && small.positionScore > medium.positionScore);
  assert.ok(medium.positionScore > extreme.positionScore);
  // The horizontal axis bottoms out at the hard bound; the vertical axis still
  // matches, so the two-axis average is exactly half.
  assert.equal(extreme.positionScore, 0.5);
  assert.equal(extreme.components.position.score, 0.5);
  assert.ok(Math.abs(small.deltas.x - 0.05) < 0.005, `dx ${small.deltas.x}`);
  assert.ok(small.present);
});

test('a 250% far body reports zero position score rather than a negative one', () => {
  const result = compare(shiftPose(makePose(), { dx: 0.02, dy: 0.02 }));
  assert.ok(result.positionScore === 1, `score ${result.positionScore}`);
  const far = compare(shiftPose(makePose(), { dx: -0.4, dy: -0.4 }));
  assert.equal(far.positionScore, 0);
});

// ---------------------------------------------------------------------------
// Scale / distance
// ---------------------------------------------------------------------------

test('scale score tracks camera distance and ignores small differences', () => {
  const slight = compare(scalePose(makePose(), 1.05));
  assert.equal(slight.scaleScore, 1, 'within tolerance');
  const closer = compare(scalePose(makePose(), 1.2));
  const muchCloser = compare(scalePose(makePose(), 1.35));
  assert.ok(closer.scaleScore < 1 && closer.scaleScore > 0);
  assert.equal(muchCloser.scaleScore, 0);
  assert.ok(Math.abs(closer.deltas.scaleRatio - 1.2) < 0.03, `ratio ${closer.deltas.scaleRatio}`);
});

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

test('framing score reflects where the body sits inside the frame', () => {
  const shifted = compare(shiftPose(makePose(), { dy: 0.08 }));
  assert.ok(shifted.framingScore < 1 && shifted.framingScore > 0, `framing ${shifted.framingScore}`);
  assert.ok(Math.abs(shifted.deltas.framingVertical - 0.08) < 0.01, `vertical ${shifted.deltas.framingVertical}`);
  // Pushed right out of frame: the vertical extents are past the hard bound
  // (so those two score 0) while the horizontal ones still match → ~half. The
  // bottom extent clamps at the frame edge, so it moves less than the top.
  const wayOff = compare(shiftPose(makePose(), { dy: 0.35 }));
  assert.ok(Math.abs(wayOff.framingScore - 0.5) < 0.05, `framing ${wayOff.framingScore}`);
  assert.ok(wayOff.deltas.framing.top > wayOff.deltas.framing.bottom, 'the frame edge clamps the lower extent');
  assert.ok(wayOff.deltas.framingVertical > 0.25);
});

test('framing compares each extent, not just the body centre', () => {
  const result = compare(makePose({ height: 0.55 }));
  assert.ok(result.deltas.framing.top < 0, 'a taller body starts higher');
  assert.ok(result.deltas.framing.bottom > 0, 'and ends lower');
});

// ---------------------------------------------------------------------------
// Posture + head
// ---------------------------------------------------------------------------

test('posture tolerance absorbs small joint differences', () => {
  const minor = compare(makePose({ shoulderTilt: 4 }));
  assert.equal(minor.postureScore, 1);
  const major = compare(makePose({ shoulderTilt: 24 }));
  assert.ok(major.postureScore < 0.8 && major.postureScore > 0.4, `posture ${major.postureScore}`);
  // A joint far past the tolerance pulls the posture score down hard rather
  // than being averaged away by the joints that happen to match.
  const extreme = compare(makePose({ shoulderTilt: 60 }));
  assert.ok(extreme.postureScore < 0.55, `posture ${extreme.postureScore}`);
  assert.ok(extreme.postureScore < major.postureScore);
});

test('one off joint does not fail the whole match', () => {
  const tilted = makePose({ shoulderTilt: 25 });
  const result = compare(tilted);
  assert.ok(result.postureScore < 0.8, `posture ${result.postureScore}`);
  assert.ok(result.overallScore >= 0.82, `overall ${result.overallScore}`);
  assert.equal(result.positionScore, 1);
  assert.equal(result.scaleScore, 1);
  // …but it is reported, and it blocks the PERFECT state so the shutter does
  // not fire on a stance that does not actually match.
  assert.equal(result.allComponentsGood, false);
  assert.equal(guide(tilted).code, GUIDANCE.SHOULDERS);
});

test('the torso and head are measured independently of the shoulders', () => {
  const leaning = compare(makePose({ torsoLean: 14 }));
  assert.ok(leaning.deltas.postureWorst.delta > 10);
  assert.equal(leaning.deltas.postureWorst.angle, 'torso');
  assert.ok(leaning.postureScore < 1);
});

test('head offset ignores camera distance but catches a moved head', () => {
  const scaled = compare(scalePose(makePose(), 1.3));
  assert.equal(scaled.headScore, 1, 'head comparison is scale invariant');

  const raw = rawPose({ centerX: 0.5, centerY: 0.55, height: 0.46 });
  const moved = raw.map((lm, i) => (i === LANDMARK.NOSE ? { ...lm, x: lm.x + 0.06 } : lm));
  const headMoved = compare(normalizePose(moved));
  assert.ok(headMoved.headScore < 1, `head ${headMoved.headScore}`);
  assert.ok(headMoved.deltas.head.dx > 0.1, `dx ${headMoved.deltas.head.dx}`);
});

// ---------------------------------------------------------------------------
// Confidence + missing landmarks
// ---------------------------------------------------------------------------

test('a missing limb drops its measurements instead of inventing them', () => {
  const referenceHands = makeReference({ missing: ['LEFT_ANKLE', 'RIGHT_ANKLE', 'LEFT_WRIST', 'RIGHT_WRIST'] });
  const live = makePose({ missing: ['LEFT_ANKLE', 'RIGHT_ANKLE', 'LEFT_WRIST', 'RIGHT_WRIST'] });
  const result = comparePoses(referenceHands, live);
  assert.equal(result.present, true);
  assert.ok(!result.measured.angles.kneeLeft, 'a missing ankle cannot produce a knee angle');
  assert.ok(!result.measured.angles.elbowLeft, 'a missing wrist cannot produce an elbow angle');
  // Still matchable on what is visible.
  assert.ok(result.overallScore > 0.9, `overall ${result.overallScore}`);
});

test('a low-confidence reference caps how much any match is trusted', () => {
  const dimReference = makeReference({ visibility: 0.55 });
  const result = comparePoses(dimReference, makePose());
  assert.ok(result.referenceConfidence < 0.7, `referenceConfidence ${result.referenceConfidence}`);
});

test('a mostly invisible body is detected but not matchable', () => {
  const dim = makePose({ visibility: 0.2 });
  const result = compare(dim);
  assert.equal(result.detected, true);
  assert.equal(result.present, false);
  assert.equal(guide(dim).code, GUIDANCE.LOW_CONFIDENCE);
  const none = comparePoses(reference, null);
  assert.equal(none.detected, false);
  assert.equal(none.overallScore, 0);
  assert.equal(guide(null).code, GUIDANCE.NO_PERSON);
});

test('a cropped body stops the distance measurement from lying', () => {
  const cropped = makePose({ missing: ['LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE'] });
  const result = compare(cropped);
  assert.equal(result.limbsComparable, false);
  assert.equal(result.components.scale.available, false);
  assert.equal(result.components.framing.available, false);
  // Remaining components are re-normalised, so the match is not unfairly zeroed.
  assert.ok(result.overallScore > 0.9, `overall ${result.overallScore}`);
});

// ---------------------------------------------------------------------------
// Guidance
// ---------------------------------------------------------------------------

test('guidance stays empty for a perfect match and reports a plausible next step', () => {
  assert.equal(guide(makePose()).code, GUIDANCE.NONE);

  // The body sits lower in the frame than the reference → move back up.
  assert.equal(guide(shiftPose(makePose(), { dy: 0.07 })).code, GUIDANCE.MOVE_UP);
  assert.equal(guide(shiftPose(makePose(), { dy: -0.07 })).code, GUIDANCE.MOVE_DOWN);
});

test('distance guidance asks the user to move, never to zoom', () => {
  assert.equal(guide(scalePose(makePose(), 0.7)).code, GUIDANCE.MOVE_CLOSER);
  assert.equal(guide(scalePose(makePose(), 1.45)).code, GUIDANCE.MOVE_BACK);
  assert.equal(guidanceText(GUIDANCE.MOVE_CLOSER), 'Move closer');
  assert.equal(guidanceText(GUIDANCE.MOVE_BACK), 'Move back');
});

test('horizontal guidance follows the preview the user is actually watching', () => {
  const movedRight = shiftPose(makePose(), { dx: 0.09 });
  // Unmirrored preview: the body appears to the right of the ghost → move left.
  assert.equal(guide(movedRight, { mirrored: false }).code, GUIDANCE.MOVE_LEFT);
  // Mirrored (front camera) preview: the same body sits on the other side, so
  // the instruction flips — the alignment scores themselves do not.
  assert.equal(guide(movedRight, { mirrored: true }).code, GUIDANCE.MOVE_RIGHT);
  assert.equal(compare(movedRight).positionScore, compare(movedRight).positionScore);

  assert.equal(guide(shiftPose(makePose(), { dx: -0.09 })).code, GUIDANCE.MOVE_RIGHT);
});

test('guidance escalates gently with the size of the correction', () => {
  assert.equal(guide(shiftPose(makePose(), { dx: 0.045 })).text, 'Move slightly left');
  assert.equal(guide(shiftPose(makePose(), { dx: 0.075 })).text, 'Move left');
  assert.equal(guide(shiftPose(makePose(), { dx: 0.13 })).text, 'Move further left');
});

test('posture guidance names one clear correction, in human language', () => {
  assert.equal(guide(makePose({ shoulderTilt: 26 })).code, GUIDANCE.SHOULDERS);
  assert.equal(guide(makePose({ torsoLean: 20 })).code, GUIDANCE.TORSO);
  assert.equal(guide(makePose({ armLift: 1 })).code, GUIDANCE.ARM);
  assert.equal(guidanceText(GUIDANCE.SHOULDERS), 'Level your shoulders');
  assert.equal(guidanceText(GUIDANCE.TORSO), 'Stand a little straighter');
  assert.equal(guidanceText(GUIDANCE.ARM), 'Match your arm position');
});

test('a cropped or unframed body is asked into the frame before anything else', () => {
  const cropped = makePose({ missing: ['LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE'] });
  const result = guide(cropped);
  assert.equal(result.code, GUIDANCE.FRAMING);
  assert.equal(result.priority, GUIDANCE_PRIORITY[GUIDANCE.FRAMING]);
  assert.equal(guide(makePose({ height: 0.25 })).code, GUIDANCE.MOVE_CLOSER);
});

test('guidance priority order matches the documented sequence (§16)', () => {
  const order = [
    GUIDANCE.NO_PERSON,
    GUIDANCE.LOW_CONFIDENCE,
    GUIDANCE.FRAMING,
    GUIDANCE.MOVE_CLOSER,
    GUIDANCE.MOVE_LEFT,
    GUIDANCE.MOVE_UP,
    GUIDANCE.TORSO,
    GUIDANCE.ARM,
    GUIDANCE.HOLD,
    GUIDANCE.CAPTURE,
  ];
  for (let i = 1; i < order.length; i++) {
    assert.ok(GUIDANCE_RANK[order[i]] > GUIDANCE_RANK[order[i - 1]], `${order[i]} should rank after ${order[i - 1]}`);
  }
  assert.equal(GUIDANCE_RANK[GUIDANCE.MOVE_LEFT], GUIDANCE_RANK[GUIDANCE.MOVE_RIGHT], 'left/right share a rank');
  assert.equal(GUIDANCE_PRIORITY[GUIDANCE.MOVE_LEFT], 'position');
  assert.equal(GUIDANCE_PRIORITY[GUIDANCE.MOVE_CLOSER], 'distance');
});

test('guidance copy never shames the user', () => {
  const shameful = /bad|wrong|incorrect|fail|ugly|fat|shame|error/i;
  for (const code of Object.values(GUIDANCE)) {
    for (const strength of ['small', 'medium', 'large']) {
      const text = guidanceText(code, strength);
      assert.ok(!shameful.test(text), `${code} (${strength}) reads "${text}"`);
    }
  }
  assert.equal(guidanceText(GUIDANCE.HOLD), 'Perfect — hold still');
});

// ---------------------------------------------------------------------------
// Hysteresis (§40)
// ---------------------------------------------------------------------------

test('guidance does not flicker between left and right inside the dead zone', () => {
  const nudgedLeft = shiftPose(makePose(), { dx: -0.041 });
  const result = compare(nudgedLeft);
  const held = chooseGuidance(reference, nudgedLeft, result, ALIGNMENT_CONFIG, { previous: GUIDANCE.MOVE_LEFT });
  assert.notEqual(held.code, GUIDANCE.MOVE_RIGHT, 'a marginal opposite offset must not flip the prompt');

  const clearlyRight = shiftPose(makePose(), { dx: -0.075 });
  const flipped = chooseGuidance(reference, clearlyRight, compare(clearlyRight), ALIGNMENT_CONFIG, { previous: GUIDANCE.MOVE_LEFT });
  assert.equal(flipped.code, GUIDANCE.MOVE_RIGHT, 'a clear correction does take over');
});

test('same-rank guidance changes need confirmation, urgent guidance does not', () => {
  const stabilizer = createGuidanceStabilizer();
  const left = { code: GUIDANCE.MOVE_LEFT, text: 'l', strength: 'small', rank: GUIDANCE_RANK[GUIDANCE.MOVE_LEFT], priority: 'position' };
  const right = { code: GUIDANCE.MOVE_RIGHT, text: 'r', strength: 'small', rank: GUIDANCE_RANK[GUIDANCE.MOVE_RIGHT], priority: 'position' };
  const noPerson = { code: GUIDANCE.NO_PERSON, text: 'n', strength: 'small', rank: GUIDANCE_RANK[GUIDANCE.NO_PERSON], priority: 'visibility' };

  assert.equal(stabilizer.update(left).code, GUIDANCE.MOVE_LEFT);
  assert.equal(stabilizer.update(right).code, GUIDANCE.MOVE_LEFT);
  assert.equal(stabilizer.update(right).code, GUIDANCE.MOVE_LEFT);
  assert.equal(stabilizer.update(right).code, GUIDANCE.MOVE_RIGHT, 'after GU…STABLE_FRAMES it switches');
  assert.equal(stabilizer.update(noPerson).code, GUIDANCE.NO_PERSON, 'urgent corrections escalate immediately');
  stabilizer.reset();
  assert.equal(stabilizer.current(), null);
});

// ---------------------------------------------------------------------------
// Stability (§18/§41)
// ---------------------------------------------------------------------------

const stableResult = (extra = {}) => ({
  detected: true,
  present: true,
  partial: false,
  allComponentsGood: true,
  confidence: 0.95,
  smoothedScore: 0.9,
  ...extra,
});

test('stability needs the score held for the full duration over several samples', () => {
  const tracker = createStabilityTracker();
  assert.equal(tracker.push(stableResult(), 0, 0).stable, false, 'one frame is never stable');
  tracker.push(stableResult(), 80, 0);
  tracker.push(stableResult(), 160, 0);
  const mid = tracker.push(stableResult(), 500, 0);
  assert.equal(mid.stable, false, `held ${mid.heldMs}ms`);
  assert.ok(mid.progress > 0.4 && mid.progress < 0.6, `progress ${mid.progress}`);
  for (let t = 580; t <= 1200; t += 80) tracker.push(stableResult(), t, 0);
  const done = tracker.push(stableResult(), 1200, 0);
  assert.equal(done.stable, true);
  assert.equal(done.progress, 1);
});

test('stability resets on a low score, a wobble, movement or a partial body', () => {
  const cases = [
    stableResult({ smoothedScore: 0.5 }),
    stableResult({ smoothedScore: 0.9, partial: true }),
    stableResult({ smoothedScore: 0.9, allComponentsGood: false }),
    stableResult({ confidence: 0.2 }),
    stableResult({ present: false }),
  ];
  for (const bad of cases) {
    const tracker = createStabilityTracker();
    for (let t = 0; t <= 1000; t += 80) tracker.push(stableResult(), t, 0);
    const broke = tracker.push(bad, 1080, 0);
    assert.equal(broke.stable, false, JSON.stringify(bad));
    assert.equal(broke.heldMs, 0);
  }

  const jittery = createStabilityTracker();
  for (let t = 0; t <= 1000; t += 80) jittery.push(stableResult(), t, 0.2);
  assert.equal(jittery.push(stableResult(), 1080, 0.2).stable, false, 'moving is not stable');

  const jumping = createStabilityTracker();
  jumping.push(stableResult({ smoothedScore: 0.9 }), 0, 0);
  jumping.push(stableResult({ smoothedScore: 0.95 }), 80, 0);
  const jump = jumping.push(stableResult({ smoothedScore: 0.2 }), 160, 0);
  assert.equal(jump.stable, false);
});

// ---------------------------------------------------------------------------
// Auto capture (§18/§19)
// ---------------------------------------------------------------------------

test('auto capture holds, counts down and fires on its own', () => {
  const capture = createCaptureController();
  const stable = { stable: true };
  const unstable = { stable: false };

  assert.equal(capture.snapshot().phase, 'aligning');
  capture.update(null, unstable, 0);
  assert.equal(capture.snapshot().phase, 'aligning');

  capture.update(null, stable, 1000);
  assert.equal(capture.snapshot().phase, 'holding', 'stability starts the hold prompt');
  capture.update(null, stable, 1000 + ALIGNMENT_CONFIG.HOLD_PROMPT_MS);
  const counting = capture.snapshot();
  assert.equal(counting.phase, 'counting');
  assert.equal(counting.countdown, ALIGNMENT_CONFIG.COUNTDOWN_STEPS);

  const step = ALIGNMENT_CONFIG.COUNTDOWN_STEP_MS;
  let phase = capture.snapshot();
  let t = 1000 + ALIGNMENT_CONFIG.HOLD_PROMPT_MS;
  for (let i = 0; i < ALIGNMENT_CONFIG.COUNTDOWN_STEPS + 1 && !phase.captured; i++) {
    t += step;
    phase = capture.update(null, stable, t).captured ? capture.snapshot() : capture.snapshot();
    capture.update(null, stable, t);
    phase = capture.snapshot();
  }
  assert.equal(phase.phase, 'captured');
  assert.equal(phase.countdown, 0);
});

test('auto capture never fires from a momentary wobble and restarts after moving', () => {
  const capture = createCaptureController();
  capture.update(null, { stable: true }, 0);
  capture.update(null, { stable: true }, 500);
  capture.update(null, { stable: false }, 800);
  assert.equal(capture.snapshot().phase, 'aligning', 'losing stability aborts the countdown');
  capture.update(null, { stable: true }, 900);
  assert.equal(capture.snapshot().phase, 'holding');
});

test('auto capture can be switched off; manual capture is always allowed', () => {
  const capture = createCaptureController();
  capture.setAutoEnabled(false);
  for (let t = 0; t <= 5000; t += 100) capture.update(null, { stable: true }, t);
  assert.equal(capture.snapshot().phase, 'aligning', 'no auto capture while disabled');
  assert.equal(capture.requestCapture().captured, true, 'the shutter is never blocked');
  assert.equal(capture.retake().phase, 'aligning');
  capture.setAutoEnabled(true);
  capture.reset();
  assert.equal(capture.snapshot().phase, 'aligning');
});

// ---------------------------------------------------------------------------
// Engine facade
// ---------------------------------------------------------------------------

const feed = (engine, live, { from = 0, to = 1400, step = 80, movement = 0, mirrored = false } = {}) => {
  let result = null;
  for (let t = from; t <= to; t += step) {
    result = engine.compare(reference, live, { now: t, movement, mirrored });
    result.at = t;
  }
  return result;
};

test('the engine reaches a stable, capturable state from a good pose', () => {
  const engine = createAlignmentEngine();
  const live = makePose({ centerX: 0.505, centerY: 0.548 });
  // Long enough for the hold prompt plus the full 3-2-1 countdown.
  const result = feed(engine, live, { to: 4000 });
  assert.equal(result.stable, true, `stable ${result.stable} score ${result.smoothedScore} movement used 0`);
  assert.ok(result.smoothedScore >= ALIGNMENT_CONFIG.CAPTURE_SCORE_THRESHOLD);
  assert.ok(['perfect', 'captured'].includes(result.status), `status ${result.status}`);
  assert.equal(result.phase, 'captured', 'auto capture completes on its own');
  assert.equal(result.guidance, GUIDANCE.CAPTURE);
});

test('the engine never reports stable while the user is moving', () => {
  const engine = createAlignmentEngine();
  const live = makePose();
  const result = feed(engine, live, { to: 4000, movement: ALIGNMENT_CONFIG.STABILITY_MAX_MOVEMENT * 3 });
  assert.equal(result.stable, false, 'a moving body is never stable');
  assert.equal(result.phase, 'aligning', 'and auto-capture never fires');
  assert.notEqual(result.phase, 'captured');
});

test('a realistic slightly-off pose still reaches PERFECT (tunable, not impossible)', () => {
  const engine = createAlignmentEngine();
  // 4.5% off centre, 12% larger, shoulders 12° off — all plausible hand-held.
  const live = shiftPose(scalePose(makePose({ shoulderTilt: 12 }), 1.12), { dx: 0.045 });
  const result = feed(engine, live, { movement: 0 });
  assert.ok(result.smoothedScore >= ALIGNMENT_CONFIG.CAPTURE_SCORE_THRESHOLD, `score ${result.smoothedScore}`);
  assert.equal(result.status, 'perfect');
});

test('the engine display score is smoothed rather than raw', () => {
  const engine = createAlignmentEngine();
  const first = engine.compare(reference, makePose(), { now: 0 });
  assert.equal(first.smoothedScore, first.overallScore, 'the first frame seeds the average');
  const worse = shiftPose(makePose(), { dx: 0.12 });
  const second = engine.compare(reference, worse, { now: 80 });
  assert.ok(second.smoothedScore > second.overallScore, 'the display lags the raw dip');
  assert.ok(second.smoothedScore < first.smoothedScore);
});

test('the engine resets cleanly between sessions', () => {
  const engine = createAlignmentEngine();
  feed(engine, makePose(), { to: 4000 });
  assert.equal(engine.phase, 'captured');
  engine.reset();
  assert.equal(engine.phase, 'aligning');
  const after = engine.compare(reference, makePose(), { now: 2000 });
  assert.equal(after.stable, false);
  assert.equal(after.phase, 'aligning');
});

test('status bands and labels are consistent', () => {
  assert.equal(statusFor({ detected: false, present: false, guidance: GUIDANCE.NO_PERSON, smoothedScore: 0 }), 'empty');
  assert.equal(statusFor({ detected: true, present: true, guidance: GUIDANCE.MOVE_LEFT, smoothedScore: 0.3 }), 'aligning');
  assert.equal(statusFor({ detected: true, present: true, guidance: GUIDANCE.MOVE_LEFT, smoothedScore: 0.7 }), 'good');
  assert.equal(statusFor({ detected: true, present: true, guidance: GUIDANCE.MOVE_LEFT, smoothedScore: 0.8 }), 'almost');
  assert.equal(statusFor({ detected: true, present: true, guidance: GUIDANCE.HOLD, smoothedScore: 0.85 }), 'perfect');
  assert.equal(statusFor({ detected: true, present: true, guidance: GUIDANCE.CAPTURE, smoothedScore: 1 }), 'captured');
  for (const key of Object.keys(STATUS_LABEL)) assert.ok(STATUS_LABEL[key].length > 0);
});

test('every threshold is a named, positive constant in one place', () => {
  const numeric = [
    'POSITION_TOLERANCE',
    'POSITION_TOLERANCE_HARD',
    'SCALE_TOLERANCE',
    'SCALE_TOLERANCE_HARD',
    'FRAMING_TOLERANCE',
    'POSTURE_TOLERANCE_DEG',
    'MIN_LANDMARK_CONFIDENCE',
    'STABLE_DURATION_MS',
    'CAPTURE_SCORE_THRESHOLD',
  ];
  for (const key of numeric) {
    assert.ok(Number.isFinite(ALIGNMENT_CONFIG[key]) && ALIGNMENT_CONFIG[key] > 0, `${key} must be a positive number`);
  }
  assert.ok(ALIGNMENT_CONFIG.POSITION_TOLERANCE < ALIGNMENT_CONFIG.POSITION_TOLERANCE_HARD, 'hard bound is wider than the tolerance');
  assert.ok(ALIGNMENT_CONFIG.GOOD_SCORE_THRESHOLD < ALIGNMENT_CONFIG.ALMOST_SCORE_THRESHOLD, 'bands are ordered');
  assert.ok(ALIGNMENT_CONFIG.ALMOST_SCORE_THRESHOLD <= ALIGNMENT_CONFIG.CAPTURE_SCORE_THRESHOLD, 'perfect is the strictest band');
  assert.ok(ALIGNMENT_CONFIG.STABLE_DURATION_MS >= 800 && ALIGNMENT_CONFIG.STABLE_DURATION_MS <= 1200, 'stable duration sits in the documented range');
  const weights = Object.values(ALIGNMENT_CONFIG.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(weights - 1) < 1e-9, `weights sum to ${weights}`);
});

// ---------------------------------------------------------------------------
// Canonical composition space (§25/§50)
//
// The engine's contract is that BOTH sides arrive in one normalised
// composition space. The smart camera maps the live video frame into the
// reference profile's space before comparing (js/screens/camera.js). These
// tests pin that contract down with the documented cover transform, because
// getting it wrong silently turns "same stance" into "move back".
// ---------------------------------------------------------------------------

/** The phone frame these tests simulate: 4:3 portrait (height / width). */
const FRAME_ASPECT = 4 / 3;

/** Exact inverse of sourceNormToViewportNorm — builds a frame for a target pose. */
function poseInFrame(pose, sourceAspect, compositionAspect) {
  const scale = Math.max(1, compositionAspect / sourceAspect);
  const dx = (1 - scale) / 2;
  const dy = (compositionAspect - sourceAspect * scale) / 2;
  return normalizePose(
    pose.landmarks.map((lm) => ({
      ...lm,
      x: (lm.x - dx) / scale,
      y: (lm.y * compositionAspect - dy) / (sourceAspect * scale),
    })),
    { imageWidth: 900, imageHeight: Math.round(900 * sourceAspect) }
  );
}

test('a live pose is judged in the reference composition space, not the raw frame', () => {
  // A square reference photo: composition space aspect 1.
  const square = makePose({ centerX: 0.5, centerY: 0.55, height: 0.5 }, { source: 'image', imageWidth: 1000, imageHeight: 1000 });
  const ref = buildReferenceProfile(square, { photoId: 'p', width: 1000, height: 1000, compositionAspect: 1 });

  // The same stance captured on a 4:3 sensor. Mapped into the profile's space
  // it still reads as the same composition.
  const inFrame = poseInFrame(square, FRAME_ASPECT, 1);
  const mapped = sourcePoseToViewport(inFrame, FRAME_ASPECT, 1);
  const matched = comparePoses(ref, mapped);
  assert.ok(matched.overallScore > 0.9, `mapped score ${matched.overallScore}`);
  assert.ok(matched.scaleScore > 0.95, `mapped scale ${matched.scaleScore}`);
  assert.ok(matched.positionScore > 0.95, `mapped position ${matched.positionScore}`);

  // Comparing the raw frame instead (the bug this guards against) reports a
  // genuine distance difference: the 4:3 frame is zoomed by "cover" into the
  // square viewport, so its raw coordinates describe a smaller body.
  const naive = comparePoses(ref, inFrame);
  assert.ok(naive.scaleScore < matched.scaleScore, `${naive.scaleScore} should be worse than ${matched.scaleScore}`);
  assert.equal(chooseGuidance(ref, inFrame, naive, ALIGNMENT_CONFIG).code, GUIDANCE.MOVE_CLOSER);
});

test('the composition space is a no-op when the frame already matches the reference', () => {
  const reference = makeReference();
  const live = makePose({ source: 'video' });
  const direct = comparePoses(reference, live);
  const throughMapping = comparePoses(reference, sourcePoseToViewport(live, 1200 / 900, reference.composition.aspect));
  assert.equal(throughMapping.overallScore, direct.overallScore);
});
