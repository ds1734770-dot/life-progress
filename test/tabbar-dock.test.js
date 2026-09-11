import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCK_TUNING,
  capsuleFor,
  interpolateCapsule,
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
});
