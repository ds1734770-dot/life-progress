import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCK_TUNING,
  dockInfluence,
  dockScaleAt,
  dockScales,
  smoothToward,
} from '../js/tabbar-dock.js';

// ---------------------------------------------------------------------------
// dockInfluence — normalized distance influence
// ---------------------------------------------------------------------------

test('dockInfluence is 1 at the center and 0 at/beyond the radius', () => {
  assert.equal(dockInfluence(0, 60), 1);
  assert.equal(dockInfluence(60, 60), 0);
  assert.equal(dockInfluence(120, 60), 0);
  assert.equal(dockInfluence(-60, 60), 0);
});

test('dockInfluence decreases linearly with distance and is symmetric', () => {
  assert.ok(Math.abs(dockInfluence(30, 60) - 0.5) < 1e-9);
  assert.equal(dockInfluence(-30, 60), dockInfluence(30, 60));
});

test('dockInfluence is 0 for a non-positive radius', () => {
  assert.equal(dockInfluence(0, 0), 0);
  assert.equal(dockInfluence(0, -5), 0);
});

// ---------------------------------------------------------------------------
// dockScaleAt — scale model
// ---------------------------------------------------------------------------

test('dockScaleAt rests at minScale and peaks at maxScale', () => {
  const t = { ...DOCK_TUNING, minScale: 1, maxScale: 1.4 };
  assert.equal(dockScaleAt(0, 60, t), 1.4);
  assert.equal(dockScaleAt(60, 60, t), 1);       // at/beyond radius → rest
  assert.equal(dockScaleAt(120, 60, t), 1);      // far away → rest
  const mid = dockScaleAt(30, 60, t);
  assert.ok(mid > 1 && mid < 1.4, 'between center and radius → between scales');
});

test('dockScaleAt stays within [minScale, maxScale] across the whole bar', () => {
  const centers = [30, 90, 150, 210, 270, 330];
  for (let offset = -40; offset <= 380; offset += 3) {
    for (const s of dockScales(offset, centers).scales) {
      assert.ok(s >= DOCK_TUNING.minScale - 1e-9, `scale ${s} below min at ${offset}`);
      assert.ok(s <= DOCK_TUNING.maxScale + 1e-9, `scale ${s} above max at ${offset}`);
    }
  }
});

// ---------------------------------------------------------------------------
// dockScales — bar-wide geometry
// ---------------------------------------------------------------------------

test('dockScales peaks at the nearest item and responds subtly to neighbours', () => {
  const centers = [36, 90, 144, 198, 252, 306];
  const at = dockScales(90, centers); // exactly on Water
  assert.equal(at.nearest, 1);
  assert.ok(Math.abs(at.scales[1] - DOCK_TUNING.maxScale) < 1e-9);
  assert.ok(at.scales[0] > DOCK_TUNING.minScale + 0.01, 'neighbour responds');
  assert.ok(at.scales[0] < at.scales[1], 'neighbour stays smaller than focus');
  assert.equal(at.scales[4], DOCK_TUNING.minScale, 'far items are untouched');
  assert.equal(at.scales[5], DOCK_TUNING.minScale, 'far items are untouched');
});

test('dockScales focus moves continuously between items (no discrete jumps)', () => {
  const centers = [36, 90, 144, 198, 252, 306];
  let previous = dockScales(centers[1], centers).scales[1];
  for (let x = centers[1]; x <= centers[2]; x += 2) {
    const { scales } = dockScales(x, centers);
    const focusWater = scales[1];
    const focusGym = scales[2];
    assert.ok(focusWater >= previous - 0.015, `water scale must fall monotonically near ${x}`);
    assert.ok(focusGym <= DOCK_TUNING.maxScale + 1e-9);
    assert.ok(focusGym >= Math.min(previous, DOCK_TUNING.minScale) - 1e-9, `gym scale must rise near ${x}`);
    previous = focusWater;
  }
});

test('dockScales handles the first item at the far-left edge', () => {
  const centers = [36, 90, 144, 198, 252, 306];
  const at = dockScales(centers[0], centers); // pointer exactly on Home
  assert.equal(at.nearest, 0);
  assert.ok(Math.abs(at.scales[0] - DOCK_TUNING.maxScale) < 1e-9);
  assert.ok(at.scales[1] > DOCK_TUNING.minScale, 'second item still responds');
  assert.equal(at.scales[5], DOCK_TUNING.minScale);
});

test('dockScales handles the last item at the far-right edge', () => {
  const centers = [36, 90, 144, 198, 252, 306];
  const at = dockScales(centers[5], centers); // pointer exactly on Settings
  assert.equal(at.nearest, 5);
  assert.ok(Math.abs(at.scales[5] - DOCK_TUNING.maxScale) < 1e-9);
  // Home is far outside the influence radius → untouched; the neighbour does.
  assert.equal(at.scales[0], DOCK_TUNING.minScale);
  assert.ok(at.scales[4] > DOCK_TUNING.minScale, 'Journal still responds');
  assert.ok(at.scales[4] < at.scales[5], 'neighbour stays smaller than focus');
});

test('dockScales radius is clamped between min and max', () => {
  const wide = dockScales(50, [50, 200, 350, 500, 650, 800]).radius;
  const narrow = dockScales(50, [10, 20, 30, 40, 50, 60]).radius;
  assert.ok(wide <= DOCK_TUNING.maxRadius);
  assert.ok(narrow >= DOCK_TUNING.minRadius);
});

test('dockScales tolerates an empty and a single-item bar', () => {
  assert.deepEqual(dockScales(0, []), { scales: [], radius: DOCK_TUNING.minRadius, nearest: -1 });
  const single = dockScales(1000, [50]);
  assert.equal(single.nearest, 0);
  assert.equal(single.scales[0], DOCK_TUNING.minScale, 'far focus outside radius → min scale');
  const onIt = dockScales(50, [50]);
  assert.equal(onIt.scales[0], DOCK_TUNING.maxScale);
});

// ---------------------------------------------------------------------------
// smoothToward — frame-rate-independent settle
// ---------------------------------------------------------------------------

test('smoothToward approaches the target without overshooting', () => {
  let v = 1;
  for (let i = 0; i < 200; i++) v = smoothToward(v, 1.3, 1 / 60);
  assert.ok(v > 1.2999, `should approach 1.3, got ${v}`);
  assert.ok(v <= 1.3 + 1e-9, 'must never exceed the target');
});

test('smoothToward is frame-rate independent (2×30fps ≈ 1×60fps)', () => {
  const step = (dt) => {
    let v = 0;
    for (let i = 0; i < 24; i++) v = smoothToward(v, 1, dt); // 400 ms simulated
    return v;
  };
  const at60 = step(1 / 60);
  const at30 = step(1 / 30);
  assert.ok(Math.abs(at60 - at30) < 0.01, `60fps ${at60} vs 30fps ${at30}`);
});

test('smoothToward settles fully given enough time', () => {
  let v = 1.32;
  for (let i = 0; i < 2000; i++) v = smoothToward(v, 1, 1 / 60);
  assert.ok(Math.abs(v - 1) < 1e-6);
});

test('smoothToward never moves backwards on a single step', () => {
  const v = smoothToward(1, 1.3, 1 / 60);
  assert.ok(v > 1 && v < 1.3);
  const back = smoothToward(1.3, 1, 1 / 60);
  assert.ok(back < 1.3 && back > 1);
});
