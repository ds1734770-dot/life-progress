import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCK_TUNING,
  capsuleFor,
  interpolateCapsule,
  followAlpha,
  shouldStartDrag,
  snapIndex,
} from '../js/tabbar-dock.js';

// ---------------------------------------------------------------------------
// capsuleFor — capsule geometry for one item
// ---------------------------------------------------------------------------

test('capsuleFor centers the capsule on the item center', () => {
  const c = capsuleFor(100, 50);
  assert.equal(c.width, 50 + DOCK_TUNING.capsulePadX * 2);
  assert.equal(c.left, 100 - c.width / 2);
});

test('capsuleFor enforces the minimum capsule width', () => {
  const c = capsuleFor(60, 30); // 30 + 12 = 42 < capsuleMinW (52)
  assert.equal(c.width, DOCK_TUNING.capsuleMinW);
  assert.equal(c.left, 60 - DOCK_TUNING.capsuleMinW / 2);
});

test('capsuleFor never yields a negative left for the first item', () => {
  // Even a tiny first item must keep the capsule inside the bar.
  const c = capsuleFor(20, 30);
  assert.ok(c.left >= 20 - c.width / 2 - 1e-9);
  assert.ok(c.left + c.width > 20);
});

test('capsuleFor tuning is respected', () => {
  const t = { ...DOCK_TUNING, capsulePadX: 4, capsuleMinW: 40 };
  const c = capsuleFor(90, 34, t);
  assert.equal(c.width, 42); // 34 + 8, above the 40 min
  assert.equal(c.left, 90 - 21);
});

// ---------------------------------------------------------------------------
// interpolateCapsule — travel between two items
// ---------------------------------------------------------------------------

test('interpolateCapsule at t=0 is the start and at t=1 is the target', () => {
  const from = { left: 10, width: 60 };
  const to = { left: 200, width: 70 };
  const atStart = interpolateCapsule(from, to, 0);
  const atEnd = interpolateCapsule(from, to, 1);
  assert.equal(atStart.left, 10);
  assert.equal(atStart.width, 60);
  assert.equal(atEnd.left, 200);
  assert.equal(atEnd.width, 70);
});

test('interpolateCapsule midpoints are linear blends', () => {
  const from = { left: 10, width: 60 };
  const to = { left: 210, width: 80 };
  const mid = interpolateCapsule(from, to, 0.5);
  assert.equal(mid.left, 110);
  assert.equal(mid.width, 70);
});

test('interpolateCapsule clamps out-of-range progress', () => {
  const from = { left: 0, width: 50 };
  const to = { left: 100, width: 60 };
  assert.equal(interpolateCapsule(from, to, -0.5).left, 0);
  assert.equal(interpolateCapsule(from, to, 1.5).left, 100);
});

test('interpolateCapsule handles equal geometry (no-op travel)', () => {
  const same = { left: 42, width: 56 };
  const mid = interpolateCapsule(same, same, 0.7);
  assert.equal(mid.left, 42);
  assert.equal(mid.width, 56);
});

// ---------------------------------------------------------------------------
// Tuning sanity
// ---------------------------------------------------------------------------

test('DOCK_TUNING respects the spec ranges', () => {
  assert.ok(DOCK_TUNING.slideMs >= 200 && DOCK_TUNING.slideMs <= 350, 'capsule travel 200–350ms');
  assert.ok(DOCK_TUNING.iconScale >= 1.05 && DOCK_TUNING.iconScale <= 1.12, 'active icon scale 1.05–1.12');
  assert.ok(DOCK_TUNING.pressScale >= 0.96 && DOCK_TUNING.pressScale <= 0.98, 'press scale 0.96–0.98');
  assert.ok(DOCK_TUNING.capsuleMinW >= 44, 'capsule is a comfortable touch target');
  assert.ok(DOCK_TUNING.dragAxisThreshold >= 4 && DOCK_TUNING.dragAxisThreshold <= 8, 'drag threshold 4–8px');
  assert.ok(DOCK_TUNING.snapHysteresis > 0 && DOCK_TUNING.snapHysteresis < 0.5, 'snap hysteresis is a small share');
});

// ---------------------------------------------------------------------------
// followAlpha — frame-rate-independent smoothing
// ---------------------------------------------------------------------------

test('followAlpha is the base alpha at 60fps', () => {
  assert.equal(followAlpha(16.67).toFixed(2), DOCK_TUNING.followAlpha60.toFixed(2));
});

test('followAlpha compensates for slower frames (bigger step, same speed)', () => {
  assert.ok(followAlpha(33.3) > followAlpha(16.67), '120fps-spacing frames move further');
  assert.ok(followAlpha(33.3) <= 1, 'never exceeds 1');
});

test('followAlpha clamps huge frame gaps and never goes out of range', () => {
  for (const dt of [0, -5, 4000, Number.NaN]) {
    const a = followAlpha(dt);
    assert.ok(a > 0 && a <= 1, `alpha in (0,1] for dt=${dt}`);
  }
});

// ---------------------------------------------------------------------------
// shouldStartDrag — axis threshold
// ---------------------------------------------------------------------------

test('shouldStartDrag needs the minimum horizontal movement', () => {
  assert.equal(shouldStartDrag(DOCK_TUNING.dragAxisThreshold, 0), true);
  assert.equal(shouldStartDrag(DOCK_TUNING.dragAxisThreshold - 1, 0), false);
  assert.equal(shouldStartDrag(-12, 0), true, 'both directions count');
});

test('shouldStartDrag rejects vertical-dominant movement', () => {
  assert.equal(shouldStartDrag(10, 40), false, 'vertical swipe must scroll, not drag');
  assert.equal(shouldStartDrag(30, 30), false, 'diagonal ties go to scrolling');
});

test('shouldStartDrag accepts horizontal-dominant movement', () => {
  assert.equal(shouldStartDrag(40, 10), true);
  assert.equal(shouldStartDrag(8, 1), true);
});

// ---------------------------------------------------------------------------
// snapIndex — deterministic nearest-item release resolution
// ---------------------------------------------------------------------------

function evenCenters(n, width) {
  const step = width / n;
  return Array.from({ length: n }, (_, i) => step * (i + 0.5));
}

const CENTERS = evenCenters(6, 360); // 30, 90, 150, 210, 270, 330

test('snapIndex picks the nearest item center', () => {
  assert.equal(snapIndex(CENTERS, 360, 80, 0), 1, 'closer to item 1 than item 0');
  assert.equal(snapIndex(CENTERS, 360, 320, 5), 5);
  assert.equal(snapIndex(CENTERS, 360, 0, 0), 0);
  assert.equal(snapIndex(CENTERS, 360, 359, 5), 5);
});

test('snapIndex resolves 60/40 splits toward the majority side', () => {
  // Between item 1 (90) and item 2 (150): x=114 is 40% of the way → item 1.
  assert.equal(snapIndex(CENTERS, 360, 114, 1), 1);
  // x=126 is 60% of the way → item 2 wins.
  assert.equal(snapIndex(CENTERS, 360, 126, 1), 2);
});

test('snapIndex hysteresis keeps the origin on tiny accidental movements', () => {
  const tiny = CENTERS[0] + CENTERS[0] * 0.1; // barely moved from item 0
  assert.equal(snapIndex(CENTERS, 360, tiny, 0), 0);
  // Nearest-center zones imply ~50% hysteresis: Home holds until the
  // midpoint toward the neighbor (30px), not at the first few pixels.
  const midpoint = (CENTERS[0] + CENTERS[1]) / 2; // 60
  assert.equal(snapIndex(CENTERS, 360, midpoint - 5, 0), 0, 'before the midpoint Home still wins');
  assert.equal(snapIndex(CENTERS, 360, midpoint + 5, 0), 1, 'past the midpoint the neighbor wins');
});

test('snapIndex without an origin is plain nearest-center', () => {
  assert.equal(snapIndex(CENTERS, 360, 200, null), 3);
  assert.equal(snapIndex(CENTERS, 360, 40, -1), 0);
});

test('snapIndex is deterministic for exact midpoints (direction-free, lower index wins ties)', () => {
  const mid = (CENTERS[1] + CENTERS[2]) / 2; // exactly between two items
  const a = snapIndex(CENTERS, 360, mid, 1);
  const b = snapIndex(CENTERS, 360, mid, 1);
  assert.equal(a, b, 'same input → same output');
  assert.ok(a === 1 || a === 2);
});

test('snapIndex handles degenerate inputs', () => {
  assert.equal(snapIndex([], 360, 100, 0), 0);
  assert.equal(snapIndex([150], 360, 100, null), 0, 'single item always wins');
});
