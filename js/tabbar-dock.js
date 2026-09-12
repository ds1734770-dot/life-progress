/**
 * Floating navigation dock — Life Progress V1.1.
 *
 * Transforms the existing full-width bottom bar (#tabbar) into a compact
 * floating glass dock with a single translucent active capsule that slides
 * between tabs — and follows the finger during a horizontal drag on the dock
 * itself (WhatsApp/iOS-style focus gesture, release-to-navigate).
 *
 * Design rules:
 *   - The existing .tab-item buttons remain the source of truth: same routes,
 *     same icons, same labels, same tap / click / keyboard behaviour. This
 *     module never handles taps — router.js's native click listeners do.
 *   - ROUTED PAGE (.active + aria-current, owned by router.js) and GESTURE
 *     FOCUS (.drag-focus, owned here) are separate. During a drag only the
 *     capsule moves; the router stays on the current page. On release the
 *     nearest item is resolved and navigated via the existing router
 *     (location.hash → hashchange → updateTabbar → moveCapsule) — no
 *     duplicate routing logic.
 *   - The active capsule is one decorative element (aria-hidden,
 *     pointer-events:none) that physically travels between items. It is a
 *     low-opacity glass tint (never a solid block): the visual hierarchy is
 *     ICON > LABEL > CAPSULE.
 *   - All motion is transform/opacity on composited layers, batched through
 *     rAF while continuous. Geometry is measured once per interaction (or on
 *     resize) — never per frame.
 *   - `prefers-reduced-motion: reduce`: no travel/scale animation, focus
 *     changes instantly; the gesture itself still works and still navigates.
 *
 * The geometry lives in pure, DOM-free helpers (unit-tested in
 * test/tabbar-dock.test.js); `enhanceTabbar` only wires DOM to them.
 */

/** Tuning for the floating dock + active capsule + drag gesture. */
export const DOCK_TUNING = Object.freeze({
  capsulePadX: 6,        // px of horizontal padding inside the capsule
  capsuleMinW: 52,       // px minimum capsule width (compact touch target)
  slideMs: 300,          // capsule travel duration (spec: 200–350ms)
  settleMs: 450,         // extra time the spring settle may take
  entranceDelayMs: 120,  // after renderTabbar, before the dock floats in
  iconScale: 1.08,       // active icon scale (spec: 1.05–1.12)
  pressScale: 0.97,      // touch press scale (spec: 0.96–0.98)
  dragAxisThreshold: 6,  // px of |dx| before a horizontal drag activates (spec: 4–8)
  dragAxisRatio: 1.4,    // |dx| vs |dy| needed to prefer the horizontal axis
  snapHysteresis: 0.34,  // release travel share required to leave the origin item (0..0.5)
  followAlpha60: 0.55,   // capsule-follow strength per 60fps frame while dragging
});

/**
 * Capsule geometry for one item: `{ left, width }` in bar-relative px.
 * `left` is the item's center minus half the capsule width, so the capsule
 * is always centered on its item regardless of item/capsule width mismatch.
 */
export function capsuleFor(itemCenter, itemWidth, tuning = DOCK_TUNING) {
  const width = Math.max(tuning.capsuleMinW, itemWidth + tuning.capsulePadX * 2);
  return { left: itemCenter - width / 2, width };
}

/**
 * Interpolated capsule geometry at progress `t` (0..1) between two items.
 * Position and width animate together, which makes the capsule feel like a
 * single object gliding/resizing between destinations.
 */
export function interpolateCapsule(from, to, t) {
  const k = Math.min(1, Math.max(0, t));
  return {
    left: from.left + (to.left - from.left) * k,
    width: from.width + (to.width - from.width) * k,
  };
}

/**
 * Exponential smoothing factor for one rAF frame — frame-rate-independent:
 * a capsule that moves 55% toward its target per 60fps frame moves the same
 * relative amount per frame at any refresh rate (`dt` in ms).
 */
export function followAlpha(dt, alpha60 = DOCK_TUNING.followAlpha60) {
  if (!Number.isFinite(dt) || dt <= 0) return alpha60;
  const dtSafe = Math.min(dt, 250); // clamp tab-switch gaps
  return 1 - Math.pow(1 - alpha60, dtSafe / (1000 / 60));
}

/** True when a horizontal drag should activate for the given movement. */
export function shouldStartDrag(dx, dy, tuning = DOCK_TUNING) {
  return Math.abs(dx) >= tuning.dragAxisThreshold &&
    Math.abs(dx) > Math.abs(dy) * tuning.dragAxisRatio;
}

/**
 * Index of the item a release at `x` (bar-relative px) snaps to.
 *
 * Deterministic nearest-center resolution: the item whose center is nearest
 * `x` wins; exact ties go to the lower index (stable, direction-free). This
 * inherently carries ~50% hysteresis — a release must travel past the
 * midpoint between two items to switch, so tiny accidental movements from an
 * item's center never change the page. `fromIndex`/`barWidth` are accepted
 * for signature stability and diagnostics; `tuning` is reserved.
 */
export function snapIndex(itemCenters, barWidth, x, fromIndex, tuning = DOCK_TUNING) {
  void barWidth;
  void fromIndex;
  void tuning;
  if (!itemCenters.length) return 0;
  let nearest = 0;
  for (let i = 1; i < itemCenters.length; i++) {
    if (Math.abs(itemCenters[i] - x) < Math.abs(itemCenters[nearest] - x)) nearest = i;
  }
  return nearest;
}

/**
 * Wires the floating dock behaviour onto the existing tab bar.
 * Safe to call once per bar (guarded); returns `{ destroy }`.
 *
 * Returned handle:
 *   - `moveCapsule({ animate = true })` — re-syncs the capsule with the
 *     current `.active` item (called by router.js after route changes).
 *   - `primeEntrance()` — arms the one-time float-in animation.
 *   - `playEntrance()` — plays the float-in if armed.
 */
export function enhanceTabbar(bar) {
  const detached = { destroy() {}, moveCapsule() {}, primeEntrance() {}, playEntrance() {} };
  if (!bar || typeof window === 'undefined' || typeof document === 'undefined') return detached;
  if (bar.dataset.dockEnhanced === '1') return detached;
  bar.dataset.dockEnhanced = '1';

  const reduceQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  const reducedMotion = () => Boolean(reduceQuery && reduceQuery.matches);

  // The sliding active capsule — purely decorative, pointer-events: none.
  const capsule = document.createElement('div');
  capsule.className = 'tab-capsule';
  capsule.setAttribute('aria-hidden', 'true');
  bar.append(capsule);

  let rafId = 0;          // capsule travel animation
  let followRafId = 0;    // continuous follow loop while dragging
  let resizeRaf = 0;
  let followTarget = null; // { left, width } the capsule chases while dragging
  let geometry = null;     // cached { barWidth, centers[], widths[] }

  const queryItems = () => Array.from(bar.querySelectorAll('.tab-item'));

  /**
   * Measure all items ONCE (bar-relative centers/widths + bar width) and
   * cache. Re-measured on drag start, on resize, and whenever the cache is
   * invalid — never per frame.
   */
  function measureGeometry() {
    const barRect = bar.getBoundingClientRect();
    const items = queryItems();
    geometry = {
      barWidth: barRect.width,
      centers: items.map((item) => {
        const r = item.getBoundingClientRect();
        return r.left + r.width / 2 - barRect.left;
      }),
      widths: items.map((item) => item.getBoundingClientRect().width),
    };
    return geometry;
  }

  function findActive() {
    return queryItems().find((item) => item.classList.contains('active')) || null;
  }

  /** Current capsule geometry from its inline transform, or null. */
  function currentCapsule() {
    const m = capsule.style.transform.match(/translate3d\((-?[\d.]+)px/);
    if (!m) return null;
    return { left: parseFloat(m[1]), width: parseFloat(capsule.style.width) || DOCK_TUNING.capsuleMinW };
  }

  /** Apply capsule geometry directly (no transition on this element). */
  function applyCapsule(geo) {
    capsule.style.width = `${geo.width.toFixed(2)}px`;
    capsule.style.transform = `translate3d(${geo.left.toFixed(2)}px, 0, 0)`;
  }

  /** Frame-rate-independent ease-out for the travel animation. */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function stopTravel() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function stopFollow() {
    if (followRafId) cancelAnimationFrame(followRafId);
    followRafId = 0;
    followTarget = null;
  }

  function clearFocusClasses() {
    queryItems().forEach((item) => item.classList.remove('drag-focus'));
  }

  /**
   * Move the capsule to the current active item. When `animate` is true and
   * motion is allowed, the capsule glides from its current position — a
   * single object travelling between destinations, ~300ms. Always ends any
   * gesture: the router is the final authority on where the capsule rests.
   */
  function moveCapsule({ animate = true } = {}) {
    const active = findActive();
    stopFollow();
    clearFocusClasses();
    if (!active) {
      capsule.style.opacity = '0';
      return;
    }
    capsule.style.opacity = '1';
    // rAF stepping drives the travel; stale inline transitions must not fight it.
    capsule.style.transition = '';
    let target;
    if (geometry && geometry.centers.length) {
      const idx = queryItems().indexOf(active);
      if (idx >= 0) {
        target = capsuleFor(geometry.centers[idx], geometry.widths[idx]);
      }
    }
    if (!target) {
      const barRect = bar.getBoundingClientRect();
      const r = active.getBoundingClientRect();
      target = capsuleFor(r.left + r.width / 2 - barRect.left, r.width);
    }
    const reduced = reducedMotion();

    if (reduced || !animate) {
      stopTravel();
      applyCapsule(target);
      return;
    }

    stopTravel();
    const start = currentCapsule() || { left: target.left, width: target.width };
    if (Math.abs(target.left - start.left) < 0.5 && Math.abs(target.width - start.width) < 0.5) {
      // Already (essentially) there — just make sure it's exact and visible.
      applyCapsule(target);
      return;
    }

    const begin = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - begin) / DOCK_TUNING.slideMs);
      applyCapsule(interpolateCapsule(start, target, easeOutCubic(t)));
      if (t < 1) rafId = requestAnimationFrame(step);
      else rafId = 0;
    };
    rafId = requestAnimationFrame(step);
  }

  // ---- Gesture focus emphasis ----------------------------------------------

  function setFocusClasses(idx) {
    queryItems().forEach((item, i) => item.classList.toggle('drag-focus', i === idx));
  }

  // ---- Continuous follow loop (drag) ----------------------------------------

  function followStep(now) {
    if (!followTarget) {
      followRafId = 0;
      return;
    }
    const cur = currentCapsule() || followTarget;
    const dt = now - (followStep.last || now);
    followStep.last = now;
    const a = followAlpha(dt);
    applyCapsule({
      left: cur.left + (followTarget.left - cur.left) * a,
      width: cur.width + (followTarget.width - cur.width) * a,
    });
    followRafId = requestAnimationFrame(followStep);
  }

  /**
   * Aim the capsule at bar-relative position `x`. The target interpolates
   * between the two surrounding items so position AND width both track the
   * finger continuously — never a discrete jump; the rAF loop chases the
   * target with exponential smoothing so fast drags stay fluid.
   */
  function capsuleFollowX(x) {
    const geo = geometry || measureGeometry();
    if (!geo.centers.length) return;
    let i = 0;
    while (i < geo.centers.length - 1 && x > geo.centers[i + 1]) i++;
    const j = Math.min(i + 1, geo.centers.length - 1);
    const leftG = capsuleFor(geo.centers[i], geo.widths[i]);
    const rightG = capsuleFor(geo.centers[j], geo.widths[j]);
    const span = geo.centers[j] - geo.centers[i];
    const t = span > 0 ? Math.min(1, Math.max(0, (x - geo.centers[i]) / span)) : 0;
    followTarget = interpolateCapsule(leftG, rightG, t);

    const capsuleCenter = followTarget.left + followTarget.width / 2;
    setFocusClasses(Math.abs(capsuleCenter - geo.centers[i]) <= Math.abs(capsuleCenter - geo.centers[j]) ? i : j);

    if (!followRafId) {
      followStep.last = 0;
      followRafId = requestAnimationFrame(followStep);
    }
  }

  // ---- Drag gesture (Pointer Events on the dock surface) ---------------------

  const drag = {
    active: false,   // horizontal drag confirmed (past the axis threshold)
    decided: false,  // axis decided for the current pointer
    pointerId: null,
    startX: 0,
    startY: 0,
    fromIndex: -1,   // item the capsule started from (capsule fallback)
  };

  /** Bar-relative x for a pointer event, clamped to the dock's bounds. */
  function clampX(clientX) {
    const geo = geometry || measureGeometry();
    const left = bar.getBoundingClientRect().left;
    return Math.min(geo.barWidth, Math.max(0, clientX - left));
  }

  function onPointerDown(e) {
    if (drag.pointerId !== null) return; // one gesture at a time
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.pointerId = e.pointerId;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    drag.decided = false;
    drag.active = false;
  }

  function startDrag(e) {
    const geo = measureGeometry();
    if (!geo.centers.length) return;
    stopTravel();
    stopFollow();
    drag.active = true;
    drag.fromIndex = Math.max(0, queryItems().findIndex((item) => item.classList.contains('active')));
    bar.classList.add('dock-dragging');
    capsuleFollowX(clampX(e.clientX));
    if (bar.setPointerCapture) {
      try { bar.setPointerCapture(e.pointerId); } catch { /* best-effort */ }
    }
  }

  function onPointerMove(e) {
    if (e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (!drag.decided && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        if (shouldStartDrag(dx, dy)) {
          drag.decided = true;
          startDrag(e);
        } else if (Math.abs(dy) > Math.abs(dx) * DOCK_TUNING.dragAxisRatio) {
          drag.decided = true; // vertical intent → never hijack, page scrolls
        }
      }
      return;
    }
    capsuleFollowX(clampX(e.clientX));
  }

  function endDragState() {
    drag.pointerId = null;
    drag.decided = false;
    drag.active = false;
    bar.classList.remove('dock-dragging');
  }

  function onPointerUp(e) {
    if (e.pointerId !== drag.pointerId) return;
    const wasDragging = drag.active;
    const fromIdx = drag.fromIndex;
    endDragState();
    if (!wasDragging) return;
    try { if (bar.hasPointerCapture?.(e.pointerId)) bar.releasePointerCapture(e.pointerId); } catch { /* best-effort */ }

    // Resolve the item nearest the capsule's CURRENT center (hysteresis
    // relative to where the drag began) and navigate via the router.
    const geo = geometry || measureGeometry();
    const cur = currentCapsule();
    const x = cur ? cur.left + cur.width / 2 : geo.centers[Math.max(0, fromIdx)];
    const targetIdx = snapIndex(geo.centers, geo.barWidth, x, fromIdx);
    finishGesture(targetIdx);
  }

  function finishGesture(targetIdx) {
    stopFollow();
    clearFocusClasses();
    const targetItem = queryItems()[targetIdx];
    if (!targetItem) {
      moveCapsule(); // settle back on the router's active item
      return;
    }
    if (targetItem.classList.contains('active')) {
      // Same item → no navigation; settle the capsule smoothly back home.
      moveCapsule();
      return;
    }
    // Release-to-navigate: the router stays the single authority. Setting
    // the hash fires hashchange → navigate() → updateTabbar() → moveCapsule(),
    // which settles the capsule onto the new item (animated ~300ms, instant
    // under reduced motion). The synthetic click that browsers dispatch
    // after the pointerup is harmless: the hash is already updated, so the
    // router's same-route guard turns it into a no-op — no click
    // suppression needed, and ordinary taps are never affected.
    try { if (navigator.vibrate) navigator.vibrate(8); } catch { /* ignore */ }
    window.location.hash = `#/${targetItem.dataset.route}`;
  }

  function onPointerCancel(e) {
    if (e.pointerId !== drag.pointerId) return;
    endDragState();
    stopFollow();
    clearFocusClasses();
    moveCapsule(); // settle back on the router's active item
  }

  // Press feedback stays for taps; a confirmed drag suppresses it so the
  // capsule, not a pressed tile, is the visual story.
  function onPressStart(e) {
    if (drag.active) return;
    const item = e.target && e.target.closest ? e.target.closest('.tab-item') : null;
    if (!item) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    item.classList.add('tab-pressed');
  }

  function onPressEnd(e) {
    const item = e.target && e.target.closest ? e.target.closest('.tab-item') : null;
    if (item) item.classList.remove('tab-pressed');
  }

  function onResize() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      geometry = null;
      moveCapsule({ animate: false });
    });
  }

  bar.addEventListener('pointerdown', onPointerDown);
  bar.addEventListener('pointermove', onPointerMove);
  bar.addEventListener('pointerup', onPointerUp);
  bar.addEventListener('pointercancel', onPointerCancel);
  bar.addEventListener('lostpointercapture', onPointerCancel);
  bar.addEventListener('pointerdown', onPressStart);
  bar.addEventListener('pointerup', onPressEnd);
  bar.addEventListener('pointercancel', onPressEnd);
  bar.addEventListener('pointerleave', onPressEnd);
  window.addEventListener('resize', onResize);

  // Initial sync: place the capsule on the active item without animation.
  requestAnimationFrame(() => moveCapsule({ animate: false }));

  return {
    destroy() {
      stopTravel();
      stopFollow();
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = 0;
      bar.removeEventListener('pointerdown', onPointerDown);
      bar.removeEventListener('pointermove', onPointerMove);
      bar.removeEventListener('pointerup', onPointerUp);
      bar.removeEventListener('pointercancel', onPointerCancel);
      bar.removeEventListener('lostpointercapture', onPointerCancel);
      bar.removeEventListener('pointerdown', onPressStart);
      bar.removeEventListener('pointerup', onPressEnd);
      bar.removeEventListener('pointercancel', onPressEnd);
      bar.removeEventListener('pointerleave', onPressEnd);
      window.removeEventListener('resize', onResize);
      capsule.remove();
      clearFocusClasses();
      bar.classList.remove('dock-hidden', 'dock-enter', 'dock-dragging');
      delete bar.dataset.dockEnhanced;
    },
    moveCapsule,
    primeEntrance,
    playEntrance,
  };

  // ---- One-time entrance (float up + fade in) --------------------------------

  function primeEntrance() {
    if (reducedMotion()) return;
    bar.dataset.dockEntranceArmed = '1';
    bar.classList.add('dock-hidden');
  }

  function playEntrance() {
    if (bar.dataset.dockEntranceArmed !== '1') return;
    delete bar.dataset.dockEntranceArmed;
    bar.classList.remove('dock-hidden');
    bar.classList.add('dock-enter');
    setTimeout(() => bar.classList.remove('dock-enter'), DOCK_TUNING.entranceDelayMs + DOCK_TUNING.settleMs);
  }
}
