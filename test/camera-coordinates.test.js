import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEWPORT_ASPECT,
  VIEWPORT_ASPECT_LIMITS,
  aspectOf,
  captureSourceRect,
  coverTransform,
  sourceNormToViewportNorm,
  sourcePoseToViewport,
  viewportAspectFor,
  viewportNormToCss,
} from '../js/camera/coordinates.js';
import { normalizePose } from '../js/pose/geometry.js';
import { rawPose } from './pose-fixture.js';

const close = (a, b, epsilon = 1e-9) => Math.abs(a - b) < epsilon;

// ---------------------------------------------------------------------------
// Viewport aspect
// ---------------------------------------------------------------------------

test('viewportAspectFor keeps the reference aspect inside sane phone limits', () => {
  // Regression: a square reference photo collapsed the whole viewport to NaN.
  assert.equal(viewportAspectFor(1), 1, 'a square reference stays square');
  assert.equal(viewportAspectFor(4 / 3), 4 / 3);
  assert.equal(viewportAspectFor(0.75), 0.75);
  assert.equal(viewportAspectFor(3), VIEWPORT_ASPECT_LIMITS.MAX, 'very tall photos are clamped');
  assert.equal(viewportAspectFor(0.2), VIEWPORT_ASPECT_LIMITS.MIN, 'very wide photos are clamped');
  for (const bad of [undefined, null, 0, -1, NaN, 'tall']) {
    assert.equal(viewportAspectFor(bad), DEFAULT_VIEWPORT_ASPECT, `fallback for ${String(bad)}`);
  }
  for (const aspect of [0.5, 0.8, 1, 1.2, 1.333, 1.8, 2]) {
    assert.ok(Number.isFinite(viewportAspectFor(aspect)), `${aspect} must not be NaN`);
  }
});

test('aspectOf reads height/width and falls back for missing sizes', () => {
  assert.equal(aspectOf({ width: 900, height: 1200 }), 1200 / 900);
  assert.equal(aspectOf({ width: 200, height: 200 }), 1);
  assert.equal(aspectOf(null), DEFAULT_VIEWPORT_ASPECT);
  assert.equal(aspectOf({ width: 0, height: 100 }), DEFAULT_VIEWPORT_ASPECT);
});

// ---------------------------------------------------------------------------
// Cover fit
// ---------------------------------------------------------------------------

test('coverTransform matches CSS object-fit: cover', () => {
  // Wider source than destination → crop horizontally, fill vertically.
  const wide = coverTransform(1600, 1200, 300, 400);
  assert.equal(wide.scale, 400 / 1200);
  assert.equal(wide.height, 400);
  assert.ok(wide.width > 300);
  assert.ok(wide.dx < 0 && close(wide.dy, 0));

  // Taller source → crop vertically.
  const tall = coverTransform(600, 1200, 300, 400);
  assert.equal(tall.scale, 300 / 600);
  assert.equal(tall.width, 300);
  assert.ok(tall.height > 400);
  assert.ok(tall.dy < 0 && close(tall.dx, 0));

  // Identical aspect → exact fit, no offsets.
  const exact = coverTransform(900, 1200, 300, 400);
  assert.ok(close(exact.dx, 0) && close(exact.dy, 0));
});

// ---------------------------------------------------------------------------
// Source → viewport projection
// ---------------------------------------------------------------------------

test('matching aspect ratios project 1:1', () => {
  for (const aspect of [0.75, 1, 4 / 3]) {
    for (const point of [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0.32, y: 0.77 },
    ]) {
      const mapped = sourceNormToViewportNorm(point, aspect, aspect);
      assert.ok(close(mapped.x, point.x, 1e-12), `x ${mapped.x} vs ${point.x}`);
      assert.ok(close(mapped.y, point.y, 1e-12), `y ${mapped.y} vs ${point.y}`);
    }
  }
});

test('a square viewport in a landscape frame crops the sides, not the middle', () => {
  // 640×480 video (aspect 0.75) shown in a square stage.
  const mapped = sourceNormToViewportNorm({ x: 0.5, y: 0.5 }, 0.75, 1);
  assert.ok(close(mapped.x, 0.5, 1e-12), `centre x ${mapped.x}`);
  assert.ok(close(mapped.y, 0.5, 1e-12), `centre y ${mapped.y}`);
  const left = sourceNormToViewportNorm({ x: 0, y: 0.5 }, 0.75, 1);
  assert.ok(left.x < 0, 'the left edge of the frame is off-screen');
  const right = sourceNormToViewportNorm({ x: 1, y: 0.5 }, 0.75, 1);
  assert.ok(right.x > 1, 'the right edge of the frame is off-screen');
  // Vertical stays untouched — the crop is horizontal only.
  assert.ok(close(sourceNormToViewportNorm({ x: 0.5, y: 0 }, 0.75, 1).y, 0, 1e-12));
  assert.ok(close(sourceNormToViewportNorm({ x: 0.5, y: 1 }, 0.75, 1).y, 1, 1e-12));
});

test('a tall viewport in a landscape frame fills the height and crops the sides', () => {
  // Cover can only ever crop along the axis the source already overflows, so a
  // wide frame in a tall viewport still crops horizontally.
  const mapped = sourceNormToViewportNorm({ x: 0.5, y: 0.5 }, 0.75, 1.5);
  assert.ok(close(mapped.x, 0.5, 1e-12));
  assert.ok(close(mapped.y, 0.5, 1e-12));
  assert.ok(close(sourceNormToViewportNorm({ x: 0.5, y: 0 }, 0.75, 1.5).y, 0, 1e-12));
  assert.ok(close(sourceNormToViewportNorm({ x: 0.5, y: 1 }, 0.75, 1.5).y, 1, 1e-12));
  assert.ok(sourceNormToViewportNorm({ x: 0, y: 0.5 }, 0.75, 1.5).x < 0, 'the sides crop away');
});

test('a tall frame in a wide viewport crops vertically and keeps the scale', () => {
  // 3:4 portrait video in a squat landscape stage.
  const src = 4 / 3;
  const dst = 0.6;
  assert.ok(close(sourceNormToViewportNorm({ x: 0.5, y: 0.5 }, src, dst).y, 0.5, 1e-12));
  assert.ok(sourceNormToViewportNorm({ x: 0.5, y: 0 }, src, dst).y < 0, 'the top of the frame is cropped away');
  assert.ok(sourceNormToViewportNorm({ x: 0.5, y: 1 }, src, dst).y > 1, 'the bottom of the frame is cropped away');
  // The full width is visible — the crop is vertical only.
  assert.ok(close(sourceNormToViewportNorm({ x: 0, y: 0.5 }, src, dst).x, 0, 1e-12));
  assert.ok(close(sourceNormToViewportNorm({ x: 1, y: 0.5 }, src, dst).x, 1, 1e-12));
});

test('the projection always keeps the frame centre in the viewport centre', () => {
  for (const src of [0.5, 0.75, 1, 1.33, 1.8]) {
    for (const dst of [0.5, 0.75, 1, 1.33, 1.8]) {
      const mapped = sourceNormToViewportNorm({ x: 0.5, y: 0.5 }, src, dst);
      assert.ok(close(mapped.x, 0.5, 1e-12) && close(mapped.y, 0.5, 1e-12), `${src}→${dst}`);
    }
  }
});

/**
 * The invariant that makes the whole feature trustworthy: the crop used to save
 * the photo must show EXACTLY what the projection says is on screen. If these
 * two ever disagree, the user aligns to one composition and saves another.
 */
test('the saved crop is exactly the region the projection shows', () => {
  const cases = [
    { srcW: 640, srcH: 480, dstAspect: 1 },
    { srcW: 640, srcH: 480, dstAspect: 4 / 3 },
    { srcW: 480, srcH: 640, dstAspect: 4 / 3 },
    { srcW: 1080, srcH: 1440, dstAspect: 1.2 },
    { srcW: 1920, srcH: 1080, dstAspect: 3 },
  ];
  for (const { srcW, srcH, dstAspect } of cases) {
    const rect = captureSourceRect({ srcW, srcH, dstAspect });
    const srcAspect = srcH / srcW;
    // Corners of the crop, in source-normalized space.
    const topLeft = sourceNormToViewportNorm({ x: rect.sx / srcW, y: rect.sy / srcH }, srcAspect, dstAspect);
    const bottomRight = sourceNormToViewportNorm({
      x: (rect.sx + rect.sw) / srcW,
      y: (rect.sy + rect.sh) / srcH,
    }, srcAspect, dstAspect);
    assert.ok(close(topLeft.x, 0, 0.01) && close(topLeft.y, 0, 0.01), `${srcW}x${srcH}@${dstAspect} top-left ${JSON.stringify(topLeft)}`);
    assert.ok(close(bottomRight.x, 1, 0.01) && close(bottomRight.y, 1, 0.01), `${srcW}x${srcH}@${dstAspect} bottom-right ${JSON.stringify(bottomRight)}`);
    // The crop must never exceed the frame.
    assert.ok(rect.sx >= 0 && rect.sy >= 0 && rect.sw > 0 && rect.sh > 0);
    assert.ok(rect.sx + rect.sw <= srcW + 1 && rect.sy + rect.sh <= srcH + 1, 'crop stays inside the frame');
    // …and it keeps the requested composition aspect.
    assert.ok(Math.abs(rect.sh / rect.sw - dstAspect) < 0.02, `crop aspect ${rect.sh / rect.sw} vs ${dstAspect}`);
  }
});

// ---------------------------------------------------------------------------
// Pose + CSS conversion
// ---------------------------------------------------------------------------

test('sourcePoseToViewport moves every landmark into the viewport space', () => {
  const pose = normalizePose(rawPose({ centerX: 0.5, centerY: 0.55, height: 0.46 }), { imageWidth: 640, imageHeight: 480 });
  const mapped = sourcePoseToViewport(pose, 0.75, 1);
  assert.equal(mapped.space, 'viewport');
  assert.equal(mapped.landmarks.length, pose.landmarks.length);
  assert.ok(close(mapped.landmarks[0].x, 0.5, 1e-9), `nose x ${mapped.landmarks[0].x}`);
  assert.ok(close(mapped.landmarks[0].y, pose.landmarks[0].y, 1e-9), 'vertical is unchanged by a horizontal crop');
  // Visibility is carried through, so confidence weighting still works.
  assert.equal(mapped.landmarks[0].visibility, pose.landmarks[0].visibility);
});

test('viewportNormToCss mirrors horizontally without moving vertically', () => {
  const size = { width: 400, height: 500 };
  assert.deepEqual(viewportNormToCss({ x: 0.25, y: 0.5 }, size), { x: 100, y: 250 });
  assert.deepEqual(viewportNormToCss({ x: 0.25, y: 0.5 }, { ...size, mirrored: true }), { x: 300, y: 250 });
  assert.deepEqual(viewportNormToCss({ x: 0.5, y: 0.1 }, { ...size, mirrored: true }), { x: 200, y: 50 });
});
