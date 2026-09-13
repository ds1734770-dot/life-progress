import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_USABLE_COVERAGE,
  REFERENCE_PROFILE_VERSION,
  REFERENCE_QUALITY_COPY,
  buildReferenceProfile,
  isUsableReferenceProfile,
  parseReferenceProfile,
  referenceCompositionAspect,
  referenceLandmarkPoints,
} from '../js/pose/reference.js';
import { CORE_LANDMARK_NAMES, LANDMARK, bodyCenter } from '../js/pose/geometry.js';
import { makePose, makeReference } from './pose-fixture.js';

// ---------------------------------------------------------------------------
// Profile creation
// ---------------------------------------------------------------------------

test('a reference profile captures pose, composition and image metadata', () => {
  const profile = makeReference({ centerX: 0.48, centerY: 0.52, height: 0.5 });
  assert.equal(profile.id, 'photo-1');
  assert.equal(profile.photoId, 'photo-1');
  assert.equal(profile.profileVersion, REFERENCE_PROFILE_VERSION);
  assert.equal(profile.createdAt, 1_700_000_000_000);

  assert.equal(profile.image.width, 900);
  assert.equal(profile.image.height, 1200);
  assert.ok(Math.abs(profile.image.aspect - 1200 / 900) < 0.001, `aspect ${profile.image.aspect}`);

  assert.ok(profile.composition.bounds);
  assert.ok(profile.composition.center);
  assert.ok(profile.composition.scale > 0.4);
  assert.ok(profile.composition.shoulderWidth > 0);
  assert.deepEqual(Object.keys(profile.composition.framing).sort(), ['bottom', 'left', 'right', 'top']);

  assert.deepEqual(Object.keys(profile.pose.landmarks).sort(), Object.values(CORE_LANDMARK_NAMES).sort());
  assert.ok(profile.pose.angles.shoulder != null);
  assert.ok(profile.pose.head != null);
  assert.equal(profile.cameraProfile.detector, 'test-fixture');
});

test('a profile stores metadata only — never image bytes or photo fields', () => {
  const profile = makeReference();
  const json = JSON.stringify(profile);
  assert.ok(!json.includes('blob'), 'no image blob');
  assert.ok(!json.includes('data:'), 'no data URL');
  assert.ok(!json.includes('thumb'), 'no thumbnail');
  assert.equal(profile.blob, undefined);
  assert.equal(profile.date, undefined);
  assert.equal(profile.label, undefined);
  assert.equal(profile.notes, undefined);
  // Everything must survive a JSON round-trip (it is exported with the photo).
  assert.deepEqual(JSON.parse(json), profile);
});

test('profile creation is deterministic (no clock or randomness in the math)', () => {
  const a = makeReference({ centerX: 0.44 });
  const b = makeReference({ centerX: 0.44 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('the composition centre is the torso midline of the detected pose', () => {
  const pose = makePose({ centerX: 0.42, centerY: 0.6 });
  const profile = buildReferenceProfile(pose, { photoId: 'p', width: 900, height: 1200, createdAt: 0 });
  const center = bodyCenter(pose);
  assert.equal(profile.composition.center.x, center.x);
  assert.equal(profile.composition.center.y, center.y);
});

// ---------------------------------------------------------------------------
// Composition space (§25 — the space the alignment engine compares in)
// ---------------------------------------------------------------------------

test('a profile records the composition space its landmarks were measured in', () => {
  const pose = makePose();
  const clamped = buildReferenceProfile(pose, { photoId: 'p', width: 900, height: 1200, compositionAspect: 1 });
  assert.equal(clamped.composition.aspect, 1, 'the clamped viewport aspect wins over the photo aspect');
  assert.ok(Math.abs(clamped.image.aspect - 1200 / 900) < 0.001, 'the photo aspect is still recorded');

  const natural = buildReferenceProfile(pose, { photoId: 'p', width: 900, height: 1200 });
  assert.ok(Math.abs(natural.composition.aspect - 1200 / 900) < 0.001, 'defaults to the photo aspect');
});

test('referenceCompositionAspect reads the stored space and degrades safely', () => {
  const profile = makeReference();
  assert.ok(Math.abs(referenceCompositionAspect(profile) - 1200 / 900) < 0.001);
  // Profiles written before the field existed fall back to the photo aspect…
  const legacy = { ...profile, composition: { ...profile.composition } };
  delete legacy.composition.aspect;
  assert.ok(Math.abs(referenceCompositionAspect(legacy, 1) - 1200 / 900) < 0.001);
  // …and anything unusable falls back to the caller's default.
  assert.equal(referenceCompositionAspect({}, 0.75), 0.75);
  assert.equal(referenceCompositionAspect(null, 0.75), 0.75);
  assert.equal(referenceCompositionAspect({ composition: { aspect: 0 }, image: { width: 0, height: 0 } }, 0.75), 0.75);
});

// ---------------------------------------------------------------------------
// Quality assessment (§37/§38)
// ---------------------------------------------------------------------------

test('a full-body photo produces a clean, usable reference', () => {
  const profile = makeReference();
  assert.equal(profile.quality.personDetected, true);
  assert.equal(profile.quality.fullBodyVisible, true);
  assert.equal(profile.quality.framingGood, true);
  assert.equal(profile.quality.partial, false);
  assert.equal(profile.quality.usable, true);
  assert.deepEqual(profile.quality.issues, []);
  assert.equal(profile.quality.checks.length, 4);
  assert.ok(profile.quality.checks.every((c) => c.ok));
  assert.ok(profile.quality.score > 0.9, `score ${profile.quality.score}`);
  assert.equal(isUsableReferenceProfile(profile), true);
});

test('a partial-body photo stays usable but is flagged as partial', () => {
  const profile = makeReference({ missing: ['LEFT_ANKLE', 'RIGHT_ANKLE'] });
  assert.equal(profile.quality.personDetected, true);
  assert.equal(profile.quality.fullBodyVisible, false);
  assert.equal(profile.quality.partial, true);
  assert.equal(profile.quality.usable, true);
  assert.ok(profile.quality.issues.includes('partial-body'));
  assert.equal(profile.quality.checks.find((c) => c.id === 'full-body').ok, false);
  assert.ok(REFERENCE_QUALITY_COPY.partialHint.length > 0);
});

test('a photo with almost no body is not usable', () => {
  const profile = makeReference({
    missing: ['NOSE', 'LEFT_ELBOW', 'RIGHT_ELBOW', 'LEFT_WRIST', 'RIGHT_WRIST', 'LEFT_KNEE', 'RIGHT_KNEE', 'LEFT_ANKLE', 'RIGHT_ANKLE'],
  });
  assert.ok(profile.quality.coverage < MIN_USABLE_COVERAGE, `coverage ${profile.quality.coverage}`);
  assert.equal(profile.quality.usable, false);
  assert.equal(isUsableReferenceProfile(profile), false);
});

test('a too-dark photo reports no reliable person', () => {
  const profile = makeReference({ visibility: 0.2 });
  assert.equal(profile.quality.personDetected, false);
  assert.equal(profile.quality.usable, false);
  assert.ok(profile.quality.issues.includes('no-person'));
  assert.ok(profile.quality.issues.includes('low-confidence'));
  assert.equal(REFERENCE_QUALITY_COPY.retryHint.length > 0, true);
});

test('a person very far away is flagged for framing, not rejected outright', () => {
  const profile = makeReference({ height: 0.2 });
  assert.equal(profile.quality.framingGood, false);
  assert.ok(profile.quality.issues.includes('too-far'));
  assert.equal(profile.quality.personDetected, true);
});

test('a body touching the frame edge is flagged as cut off', () => {
  const profile = makeReference({ centerY: 0.12 });
  assert.equal(profile.quality.framingGood, false);
  assert.ok(profile.quality.issues.includes('cut-off'));
});

// ---------------------------------------------------------------------------
// Version + shape guards (§43)
// ---------------------------------------------------------------------------

test('REFERENCE_PROFILE_VERSION is a stable, explicit integer', () => {
  assert.equal(REFERENCE_PROFILE_VERSION, 1);
  assert.equal(Number.isInteger(REFERENCE_PROFILE_VERSION), true);
});

test('parseReferenceProfile rejects profiles written by another algorithm version', () => {
  const profile = makeReference();
  assert.equal(parseReferenceProfile(profile), profile);
  assert.equal(parseReferenceProfile({ ...profile, profileVersion: REFERENCE_PROFILE_VERSION + 1 }), null);
  assert.equal(parseReferenceProfile({ ...profile, profileVersion: undefined }), null);
  assert.equal(parseReferenceProfile({ ...profile, profileVersion: '1' }), null);
});

test('parseReferenceProfile rejects malformed records instead of guessing', () => {
  const profile = makeReference();
  assert.equal(parseReferenceProfile(null), null);
  assert.equal(parseReferenceProfile('nope'), null);
  assert.equal(parseReferenceProfile({}), null);
  assert.equal(parseReferenceProfile({ ...profile, photoId: '' }), null);
  assert.equal(parseReferenceProfile({ ...profile, composition: null }), null);
  assert.equal(parseReferenceProfile({ ...profile, composition: { ...profile.composition, scale: 0 } }), null);
  const missingLandmark = JSON.parse(JSON.stringify(profile));
  delete missingLandmark.pose.landmarks.nose;
  assert.equal(parseReferenceProfile(missingLandmark), null);
  const nan = JSON.parse(JSON.stringify(profile));
  nan.pose.landmarks.nose.x = null;
  assert.equal(parseReferenceProfile(nan), null);
});

test('isUsableReferenceProfile handles missing and low-quality records', () => {
  assert.equal(isUsableReferenceProfile(null), false);
  assert.equal(isUsableReferenceProfile({ profileVersion: 99 }), false);
  const partial = makeReference({ missing: ['LEFT_ANKLE', 'RIGHT_ANKLE'] });
  assert.equal(isUsableReferenceProfile(partial), true);
});

// ---------------------------------------------------------------------------
// Overlay landmark lookup
// ---------------------------------------------------------------------------

test('referenceLandmarkPoints exposes visible core landmarks by index', () => {
  const profile = makeReference({ lowConfidence: { RIGHT_WRIST: 0.1 } });
  const points = referenceLandmarkPoints(profile);
  assert.ok(points[LANDMARK.NOSE]);
  assert.ok(points[LANDMARK.LEFT_SHOULDER]);
  assert.equal(points[LANDMARK.RIGHT_WRIST], undefined, 'a low-confidence landmark is not drawn');
  assert.ok(Object.keys(points).length >= 12);
  for (const point of Object.values(points)) {
    assert.ok(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
  }
});
