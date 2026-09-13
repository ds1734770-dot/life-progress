import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_LANDMARK_NAMES,
  CORE_LANDMARKS,
  LANDMARK,
  angleAt,
  bodyBounds,
  bodyCenter,
  bodyScale,
  headOffset,
  jointAngles,
  landmarkConfidence,
  namedLandmarks,
  normalizePose,
  poseMovement,
  segmentAngle,
  shoulderWidth,
  smoothPose,
  toLandmarks,
} from '../js/pose/geometry.js';
import { makePose, rawPose, scalePose, shiftPose } from './pose-fixture.js';

// ---------------------------------------------------------------------------
// Landmark normalization
// ---------------------------------------------------------------------------

test('normalizePose always yields a full, clamped landmark array', () => {
  const pose = normalizePose([{ x: -0.4, y: 1.7, z: 0, visibility: 2 }], { imageWidth: 100, imageHeight: 200 });
  assert.equal(pose.landmarks.length, 33);
  assert.equal(pose.landmarks[0].x, 0); // clamped into the frame
  assert.equal(pose.landmarks[0].y, 1);
  assert.equal(pose.landmarks[0].visibility, 1);
  assert.equal(pose.landmarks[31].visibility, 0); // absent landmarks are explicit
  assert.equal(pose.imageWidth, 100);
  assert.equal(pose.imageHeight, 200);
});

test('toLandmarks survives null / malformed detector output', () => {
  assert.equal(toLandmarks(null).length, 33);
  assert.equal(toLandmarks([null, undefined, 'nope']).length, 33);
  assert.equal(landmarkConfidence(null), 0);
  assert.equal(landmarkConfidence({ presence: 0.7 }), 0.7);
});

test('pose quality separates "can we see well" from "can we see enough"', () => {
  const full = makePose();
  assert.ok(full.confidence > 0.9, `confidence ${full.confidence}`);
  assert.equal(full.coverage, 1);

  const cropped = makePose({ missing: ['LEFT_ANKLE', 'RIGHT_ANKLE', 'LEFT_KNEE', 'RIGHT_KNEE'] });
  assert.ok(Math.abs(cropped.coverage - 9 / 13) < 0.001, `coverage ${cropped.coverage}`);
  assert.ok(cropped.confidence > 0.9, 'a cropped leg is not a lighting problem');

  const dark = makePose({ visibility: 0.2 });
  assert.ok(dark.confidence < 0.3, `dark confidence ${dark.confidence}`);
});

// ---------------------------------------------------------------------------
// Body box / center / scale
// ---------------------------------------------------------------------------

test('bodyBounds covers the visible body and reports framing extents', () => {
  const pose = makePose({ centerX: 0.5, centerY: 0.55, height: 0.5 });
  const bounds = bodyBounds(pose);
  assert.ok(bounds);
  // Nose (top) → ankles (bottom) ≈ 0.92 of the requested body height.
  assert.ok(Math.abs(bounds.height - 0.46) < 0.02, `height ${bounds.height}`);
  assert.ok(bounds.left < 0.5 && bounds.right > 0.5, 'spans the centre');
  assert.equal(bounds.top, Math.min(...[bounds.top, pose.landmarks[LANDMARK.NOSE].y]));
  assert.ok(bounds.count >= 13);
});

test('bodyBounds ignores low-confidence landmarks and reports nothing without a body', () => {
  const pose = makePose({
    missing: ['NOSE', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'LEFT_ELBOW', 'RIGHT_ELBOW', 'LEFT_WRIST', 'RIGHT_WRIST', 'LEFT_HIP', 'RIGHT_HIP', 'LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE'],
  });
  assert.equal(bodyBounds(pose), null);
  assert.equal(bodyScale(pose), 0);
  assert.equal(bodyCenter(pose), null);

  // A low-confidence landmark must be ignored, not guessed at.
  const dim = makePose({ missing: ['NOSE'], lowConfidence: { RIGHT_ANKLE: 0.2 } });
  const bounds = bodyBounds(dim);
  assert.ok(bounds.bottom <= dim.landmarks[LANDMARK.LEFT_ANKLE].y + 1e-6, 'the dim ankle is excluded');

  // Two visible landmarks is the floor; a degenerate (height 0) box must not
  // read as a measurable body, which is what keeps a stray detection from
  // producing a confident match.
  const hipsOnly = makePose({
    missing: ['NOSE', 'LEFT_SHOULDER', 'RIGHT_SHOULDER', 'LEFT_ELBOW', 'RIGHT_ELBOW', 'LEFT_WRIST', 'RIGHT_WRIST', 'LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE'],
  });
  assert.equal(bodyScale(hipsOnly), 0);
  assert.equal(bodyCenter(hipsOnly).source, 'hips');
});

test('body center comes from the hip/shoulder midline, not the bounding box', () => {
  const pose = makePose({ centerX: 0.42, centerY: 0.6 });
  const center = bodyCenter(pose);
  const bounds = bodyBounds(pose);
  assert.equal(center.source, 'torso');
  assert.ok(Math.abs(center.x - 0.42) < 0.001, `center x ${center.x}`);
  // The torso midline centre: the mean of the shoulder and hip midpoints,
  // i.e. a quarter of the shoulder→hip span ABOVE the hip line (0.26H/2) —
  // deliberately a different (and much steadier) point than the box centre.
  assert.ok(Math.abs(center.y - (0.6 - 0.13 * 0.46)) < 0.001, `center y ${center.y}`);
  // For a standing figure the box centre sits LOWER than the torso midline
  // (the legs reach further down than the head reaches up) — proving these are
  // genuinely different measurements, and why the steady midline is the one
  // that gets compared.
  assert.ok(bounds.y > center.y);
});

test('scale is the body height in frame units and follows camera distance', () => {
  const near = makePose({ height: 0.5 });
  const far = scalePose(makePose({ height: 0.5 }), 0.6);
  assert.ok(bodyScale(near) > bodyScale(far));
  assert.ok(Math.abs(bodyScale(far) / bodyScale(near) - 0.6) < 0.02);
});

test('shoulder width is a scale-aware ruler for the head offset', () => {
  const pose = makePose({ height: 0.46 });
  const width = shoulderWidth(pose);
  assert.ok(Math.abs(width - 0.26 * 0.46) < 0.01, `shoulder width ${width}`);
  const offset = headOffset(pose);
  // The nose sits above the shoulder midline: dy = (noseY - shoulderY) /
  // shoulderWidth = 0.14H / 0.26H ≈ -0.54, and dead centre horizontally.
  assert.ok(offset.dy < -0.3 && offset.dy > -0.9, `dy ${offset.dy}`);
  assert.ok(Math.abs(offset.dx) < 0.15, `dx ${offset.dx}`);
});

test('head offset is scale invariant (moving closer does not change it)', () => {
  const a = makePose({ height: 0.4 });
  const b = scalePose(a, 1.4);
  const offA = headOffset(a);
  const offB = headOffset(b);
  assert.ok(Math.abs(offA.dx - offB.dx) < 0.02);
  assert.ok(Math.abs(offA.dy - offB.dy) < 0.02);
});

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

test('angleAt measures the interior angle of a joint', () => {
  assert.equal(angleAt({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }), 90);
  assert.equal(angleAt({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 0, y: -1 }), 180);
  assert.equal(angleAt(null, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
});

test('segmentAngle is a signed slope normalised to (-90, 90]', () => {
  assert.equal(segmentAngle({ x: 0, y: 0 }, { x: 1, y: 0 }), 0);
  assert.ok(Math.abs(segmentAngle({ x: 0, y: 0 }, { x: 1, y: 1 }) - 45) < 1e-9);
  assert.ok(Math.abs(segmentAngle({ x: 0, y: 0 }, { x: 1, y: -1 }) + 45) < 1e-9);
  assert.equal(segmentAngle({ x: 0, y: 0 }, { x: 0, y: 0 }), null);
});

test('joint angles describe a level, upright, straight stance', () => {
  const angles = jointAngles(makePose());
  assert.ok(Math.abs(angles.shoulder) < 0.001, `shoulder ${angles.shoulder}`);
  assert.ok(Math.abs(angles.hip) < 0.001, `hip ${angles.hip}`);
  assert.ok(Math.abs(angles.torso) < 0.001, `torso ${angles.torso}`);
  assert.ok(angles.elbowLeft > 150 && angles.elbowLeft <= 180, `elbow ${angles.elbowLeft}`);
  assert.ok(angles.kneeLeft > 150, `knee ${angles.kneeLeft}`);
});

test('joint angles respond to real posture changes', () => {
  const tilted = jointAngles(makePose({ shoulderTilt: 12 }));
  assert.ok(Math.abs(tilted.shoulder - 12) < 1.5, `tilted shoulder ${tilted.shoulder}`);
  // A positive torsoLean shifts the shoulders toward frame right, so the
  // shoulder→hip axis leans the other way in signed terms.
  const leaning = jointAngles(makePose({ torsoLean: 10 }));
  assert.ok(leaning.torso < -5, `lean torso ${leaning.torso}`);
  assert.ok(Math.abs(jointAngles(makePose({ torsoLean: -10 })).torso) > 5);
  const bent = jointAngles(makePose({ kneeBend: 2 }));
  assert.ok(bent.kneeLeft < 179, `bent knee ${bent.kneeLeft}`);
});

test('angles are null (not guessed) when their landmarks are missing', () => {
  const angles = jointAngles(makePose({ missing: ['LEFT_ANKLE'] }));
  assert.equal(angles.kneeLeft, null);
  assert.ok(angles.kneeRight != null);
});

// ---------------------------------------------------------------------------
// Smoothing + movement
// ---------------------------------------------------------------------------

test('smoothPose blends toward the new pose and adopts it outright when new', () => {
  const previous = makePose({ centerX: 0.4 });
  const next = makePose({ centerX: 0.6 });
  assert.equal(smoothPose(null, next).landmarks[0].x, next.landmarks[0].x);
  const blended = smoothPose(previous, next, 0.5);
  const expected = previous.landmarks[LANDMARK.NOSE].x + (next.landmarks[LANDMARK.NOSE].x - previous.landmarks[LANDMARK.NOSE].x) * 0.5;
  assert.ok(Math.abs(blended.landmarks[LANDMARK.NOSE].x - expected) < 1e-9);
  assert.ok(blended.landmarks[LANDMARK.NOSE].x > previous.landmarks[LANDMARK.NOSE].x);
});

test('poseMovement is scale-invariant and zero for identical poses', () => {
  const pose = makePose();
  assert.equal(poseMovement(pose, pose), 0);
  const shifted = shiftPose(pose, { dx: 0.05 });
  const small = poseMovement(pose, shifted);
  const big = poseMovement(pose, shiftPose(pose, { dx: 0.1 }));
  assert.ok(small > 0 && big > small * 1.5, `${small} vs ${big}`);
  // Same relative movement, different body size → comparable number.
  const near = scalePose(pose, 1.3);
  const nearShifted = shiftPose(near, { dx: 0.065 });
  assert.ok(Math.abs(poseMovement(near, nearShifted) - small) < 0.03);
});

// ---------------------------------------------------------------------------
// Named landmark view used by profiles
// ---------------------------------------------------------------------------

test('namedLandmarks exposes the core set with confidence', () => {
  const pose = makePose({ lowConfidence: { RIGHT_WRIST: 0.2 } });
  const named = namedLandmarks(pose);
  assert.deepEqual(Object.keys(named).sort(), Object.values(CORE_LANDMARK_NAMES).sort());
  assert.equal(landmarkConfidence(named.rightWrist), 0.2);
  assert.equal(Object.keys(named).length, CORE_LANDMARKS.length);
  assert.ok(named.nose.x > 0 && named.nose.y > 0);
});

test('the fixture body is well framed and confidently detected', () => {
  const pose = makePose();
  const bounds = bodyBounds(pose);
  assert.ok(bounds.top > 0.02 && bounds.bottom < 0.98, 'body sits inside the frame');
  assert.ok(bounds.left > 0 && bounds.right < 1, 'body sits inside the frame horizontally');
  assert.ok(pose.confidence > 0.9);
  assert.equal(rawPose().length, 33);
});
