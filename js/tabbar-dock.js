/**
 * Tab-bar dock — fluid, distance-based magnification for the existing bottom
 * navigation (#tabbar). Apple-inspired, deliberately subtle.
 *
 * Design rules (V1.1 enhancement — nothing else in the app changes):
 *   - The existing .tab-item buttons stay the source of truth: same routes,
 *     same icons, same labels, same tap / click / keyboard behaviour. Taps are
 *     never intercepted — the native click handler in router.js keeps working.
 *   - Pointer position continuously drives a distance-based scale per icon.
 *     No discrete states while dragging; focus is a point, not a tab.
 *   - ACTIVE ROUTE (`.active`, owned by router.js) and INTERACTION FOCUS
 *     (`.dock-active`, owned here) are fully independent.
 *   - Animation is transform/opacity only, batched in one requestAnimationFrame
 *     loop. Layout is measured once per interaction, never per frame.
 *   - `prefers-reduced-motion: reduce` disables magnification entirely; a
 *     static focus pill remains for keyboard users.
 *
 * The math lives in pure, DOM-free helpers (unit-tested in
 * test/tabbar-dock.test.js); `enhanceTabbar` only wires DOM events to it.
 */

/** Tuning for the distance-based magnification model. */
export const DOCK_TUNING = Object.freeze({
  minScale: 1,           // resting icon scale
  maxScale: 1.32,        // focused icon scale (subtle, premium)
  radiusFactor: 1.35,    // interaction radius = average item spacing × this
  minRadius: 44,         // px — keeps edge items responsive on narrow screens
  maxRadius: 76,         // px — keeps neighbour response subtle on wide ones
  smoothHalflife: 0.045, // s — smoothing half-life (soft settle, no bounce)
  settleEpsilon: 0.002,  // scale delta below which the dock is "at rest"
  dragActivatePx: 4,     // px of finger travel before drag mode engages
  pillWidth: 46,         // px — focus pill width (mirrors the CSS)
});

/**
 * Normalized influence (0..1) of a focus point at `distance` px from an item
 * center: 1 at the center, 0 at (and beyond) the interaction radius.
 */
export function dockInfluence(distance, radius) {
  if (!(radius > 0)) return 0;
  const d = Math.abs(distance);
  if (d >= radius) return 0;
  return 1 - d / radius;
}

/** Icon scale for an item whose center is `distance` px from the focus. */
export function dockScaleAt(distance, radius, tuning = DOCK_TUNING) {
  return tuning.minScale + dockInfluence(distance, radius) * (tuning.maxScale - tuning.minScale);
}

/**
 * Scales for every item given a focus offset (px, bar-relative) and the item
 * center positions. The interaction radius is derived from the average item
 * spacing and clamped so the first/last items behave well at any width.
 * Returns `{ scales, radius, nearest }`.
 */
export function dockScales(offset, centers, tuning = DOCK_TUNING) {
  if (!centers.length) return { scales: [], radius: tuning.minRadius, nearest: -1 };
  let spacing = 0;
  for (let i = 1; i < centers.length; i++) spacing += centers[i] - centers[i - 1];
  spacing = spacing / (centers.length - 1) || 56;
  const radius = Math.min(tuning.maxRadius, Math.max(tuning.minRadius, spacing * tuning.radiusFactor));
  let nearest = 0;
  for (let i = 1; i < centers.length; i++) {
    if (Math.abs(offset - centers[i]) < Math.abs(offset - centers[nearest])) nearest = i;
  }
  const scales = centers.map((c) => dockScaleAt(offset - c, radius, tuning));
  return { scales, radius, nearest };
}

/**
 * Frame-rate-independent exponential smoothing (critically damped — no
 * overshoot). `halflife` is the time in seconds to close half of the
 * remaining distance, which gives the release animation its soft,
 * spring-like settle without any bounce.
 */
export function smoothToward(current, target, dtSeconds, halflife = DOCK_TUNING.smoothHalflife) {
  const dt = Math.max(0, dtSeconds);
  const h = Math.max(0.001, halflife);
  const factor = 1 - Math.exp(-(Math.LN2 * dt) / h);
  return current + (target - current) * factor;
}

/**
 * Wires the fluid dock behaviour onto the existing tab bar element.
 * Safe to call once per bar (guarded); returns `{ destroy }` for cleanup.
 */
export function enhanceTabbar(bar) {
  if (!bar || typeof window === 'undefined' || typeof document === 'undefined') {
    return { destroy() {} };
  }
  if (bar.dataset.dockEnhanced === '1') return { destroy() {} };
  bar.dataset.dockEnhanced = '1';

  const reduceQuery = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
  const reducedMotion = () => Boolean(reduceQuery && reduceQuery.matches);

  // Focus pill — a restrained accent tint trailing the interaction focus.
  // Purely decorative; pointer-events: none keeps taps untouched.
  const pill = document.createElement('div');
  pill.className = 'tab-dock-pill';
  pill.setAttribute('aria-hidden', 'true');
  bar.append(pill);

  let itemList = [];      // cached .tab-item elements (refreshed on measure/rest)
  let centers = [];       // icon centers, bar-relative px (measured lazily)
  let barLeft = 0;        // bar viewport x at measure time
  let pillW = DOCK_TUNING.pillWidth;
  let scales = [];        // current animated icon scales
  let pillX = null;       // current animated pill center x
  let pointerX = null;    // latest focus x, bar-relative
  let pointerId = null;   // active touch/pen pointer (null = not dragging)
  let pendingDrag = null; // { id, startX } until the drag threshold is crossed
  let hover = false;      // mouse is over the bar
  let kbIndex = -1;       // keyboard-focused item index
  let rafId = 0;
  let lastTime = 0;

  const queryItems = () => Array.from(bar.querySelectorAll('.tab-item'));

  /** Re-measure geometry. Called once per interaction start, never per frame. */
  function measure() {
    itemList = queryItems();
    const barRect = bar.getBoundingClientRect();
    barLeft = barRect.left;
    centers = itemList.map((item) => {
      const iconEl = item.querySelector('.tab-icon') || item;
      const r = iconEl.getBoundingClientRect();
      return r.left + r.width / 2 - barRect.left;
    });
    if (!centers.length) centers = [barRect.width / 2];
    pillW = pill.getBoundingClientRect().width || DOCK_TUNING.pillWidth;
  }

  /** Current focus point (bar-relative x) or null when fully at rest. */
  function focusX() {
    if (pointerId !== null || hover) return pointerX;
    if (kbIndex >= 0) return centers[kbIndex] ?? null;
    return null;
  }

  function engaged() {
    return pointerId !== null || hover || kbIndex >= 0;
  }

  /**
   * Writes the animated transforms. At rest (scale ≈ 1) the inline transform
   * is removed so the stylesheet fully owns the resting state — including the
   * active tab's own `translateY(-1px) scale(1.08)` emphasis.
   */
  function applyFrame() {
    for (let i = 0; i < itemList.length; i++) {
      const item = itemList[i];
      const iconEl = item.querySelector('.tab-icon');
      if (!iconEl) continue;
      const s = scales[i] ?? 1;
      if (s <= 1.001) {
        iconEl.style.removeProperty('transform');
        continue;
      }
      // Active icons rest at translateY(-1px) scale(1.08): keep that base and
      // multiply, so focus magnification never replaces the active styling.
      if (item.classList.contains('active')) {
        iconEl.style.transform = `translateY(-1px) scale(${(1.08 * s).toFixed(4)})`;
      } else {
        iconEl.style.transform = `scale(${s.toFixed(4)})`;
      }
    }
    if (pillX != null) {
      pill.style.transform = `translate3d(${(pillX - pillW / 2).toFixed(2)}px, 0, 0)`;
    }
  }

  /** Clears all inline transforms so CSS owns the resting state again. */
  function rest() {
    scales = [];
    pillX = null;
    pointerX = null;
    itemList = queryItems();
    for (const item of itemList) {
      const iconEl = item.querySelector('.tab-icon');
      if (iconEl) iconEl.style.removeProperty('transform');
    }
    bar.classList.remove('dock-active');
    bar.classList.remove('dock-live');
  }

  function frame(now) {
    rafId = 0;
    const dt = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0.016;
    lastTime = now;

    const fx = focusX();
    let settled = true;
    if (fx != null && centers.length) {
      const { scales: targets, nearest } = dockScales(fx, centers);
      if (scales.length !== targets.length) scales = targets.map(() => 1);
      for (let i = 0; i < targets.length; i++) {
        const next = smoothToward(scales[i] ?? 1, targets[i], dt);
        if (Math.abs(targets[i] - next) > DOCK_TUNING.settleEpsilon) settled = false;
        scales[i] = next;
      }
      const targetPillX = centers[nearest];
      pillX = pillX == null ? targetPillX : smoothToward(pillX, targetPillX, dt);
    } else {
      // Released: everything eases back to the resting state.
      for (let i = 0; i < scales.length; i++) {
        const next = smoothToward(scales[i], 1, dt);
        if (Math.abs(1 - next) > DOCK_TUNING.settleEpsilon) settled = false;
        scales[i] = next;
      }
    }
    applyFrame();

    if (settled) {
      if (!engaged()) rest(); // loop parks; CSS owns the resting state again
      return;                 // parked — the next event calls ensureLoop()
    }
    rafId = requestAnimationFrame(frame);
  }

  function ensureLoop() {
    if (rafId) return;
    bar.classList.add('dock-live');
    if (!itemList.length) measure();
    if (!scales.length) scales = centers.map(() => 1);
    lastTime = 0;
    rafId = requestAnimationFrame(frame);
  }

  // ---- Mouse (hover → magnification, leave → settle) -----------------------

  function onBarPointerMove(e) {
    if (reducedMotion()) return;
    if (e.pointerType && e.pointerType !== 'mouse') return; // touch has its own path
    if (pointerId !== null) return;
    if (!centers.length) measure();
    hover = true;
    pointerX = e.clientX - barLeft;
    bar.classList.add('dock-active');
    ensureLoop();
  }

  function onBarPointerLeave(e) {
    if (reducedMotion()) return;
    if (e.pointerType && e.pointerType !== 'mouse') return;
    if (pointerId !== null) return; // a drag is in progress; its up/cancel settles
    hover = false;
    ensureLoop();
  }

  // ---- Touch / pen (drag across the bar; taps stay native) -----------------

  function onBarPointerDown(e) {
    if (reducedMotion()) return; // taps keep working; no magnification
    if (e.pointerType === 'mouse') return; // mouse uses hover
    if (pendingDrag !== null || pointerId !== null) return; // single-pointer only
    pendingDrag = { id: e.pointerId, startX: e.clientX };
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerEnd);
    window.addEventListener('pointercancel', onWindowPointerEnd);
  }

  function onWindowPointerMove(e) {
    const isDrag = pointerId !== null && e.pointerId === pointerId;
    const isPending = pendingDrag !== null && e.pointerId === pendingDrag.id;
    if (!isDrag && !isPending) return;
    if (isPending) {
      // Small movements stay a tap — the native :active press feedback and
      // click behaviour are left completely untouched.
      const dx = e.clientX - pendingDrag.startX;
      if (Math.abs(dx) < DOCK_TUNING.dragActivatePx) return;
      pointerId = pendingDrag.id;
      pendingDrag = null;
      measure();
      bar.classList.add('dock-active');
    }
    pointerX = e.clientX - barLeft;
    ensureLoop();
  }

  function onWindowPointerEnd(e) {
    const wasDrag = pointerId !== null && e.pointerId === pointerId;
    const wasPending = pendingDrag !== null && e.pointerId === pendingDrag.id;
    if (!wasDrag && !wasPending) return;
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerEnd);
    window.removeEventListener('pointercancel', onWindowPointerEnd);
    pointerId = null;
    pendingDrag = null;
    if (wasDrag) ensureLoop(); // ease back to rest (hover=false, kb handles itself)
  }

  // ---- Keyboard (subtle equivalent treatment via :focus-visible) -----------

  function onFocusIn(e) {
    const item = e.target && e.target.closest ? e.target.closest('.tab-item') : null;
    if (!item || !item.matches(':focus-visible')) return; // mouse/touch focus
    kbIndex = Math.max(0, queryItems().indexOf(item));
    bar.classList.add('dock-focus');
    if (reducedMotion()) {
      // Static indicator only — no animation of any kind.
      measure();
      pillX = centers[kbIndex] ?? centers[0];
      pill.style.transform = `translate3d(${(pillX - pillW / 2).toFixed(2)}px, 0, 0)`;
      return;
    }
    measure();
    ensureLoop();
  }

  function onFocusOut() {
    if (kbIndex < 0) return;
    kbIndex = -1;
    bar.classList.remove('dock-focus');
    if (!reducedMotion()) ensureLoop();
  }

  function onResize() {
    centers = []; // geometry is re-measured on the next interaction
  }

  /**
   * Accessibility first: if reduced motion turns on mid-interaction (or while
   * a keyboard focus holds magnification), stop and hand the resting state
   * back to CSS immediately. A keyboard focus keeps only the static pill.
   */
  function onReduceChange() {
    if (!reducedMotion()) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    scales = [];
    pillX = null;
    pointerX = null;
    itemList = queryItems();
    for (const item of itemList) {
      const iconEl = item.querySelector('.tab-icon');
      if (iconEl) iconEl.style.removeProperty('transform');
    }
    bar.classList.remove('dock-active');
    bar.classList.remove('dock-live');
    if (kbIndex >= 0) {
      measure();
      pillX = centers[kbIndex] ?? centers[0];
      pill.style.transform = `translate3d(${(pillX - pillW / 2).toFixed(2)}px, 0, 0)`;
    }
  }

  if (reduceQuery) {
    if (typeof reduceQuery.addEventListener === 'function') {
      reduceQuery.addEventListener('change', onReduceChange);
    } else if (typeof reduceQuery.addListener === 'function') {
      reduceQuery.addListener(onReduceChange); // older Safari
    }
  }

  bar.addEventListener('pointermove', onBarPointerMove);
  bar.addEventListener('pointerdown', onBarPointerDown);
  bar.addEventListener('pointerleave', onBarPointerLeave);
  bar.addEventListener('focusin', onFocusIn);
  bar.addEventListener('focusout', onFocusOut);
  window.addEventListener('resize', onResize);

  return {
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      bar.removeEventListener('pointermove', onBarPointerMove);
      bar.removeEventListener('pointerdown', onBarPointerDown);
      bar.removeEventListener('pointerleave', onBarPointerLeave);
      bar.removeEventListener('focusin', onFocusIn);
      bar.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerEnd);
      window.removeEventListener('pointercancel', onWindowPointerEnd);
      if (reduceQuery) {
        if (typeof reduceQuery.removeEventListener === 'function') {
          reduceQuery.removeEventListener('change', onReduceChange);
        } else if (typeof reduceQuery.removeListener === 'function') {
          reduceQuery.removeListener(onReduceChange);
        }
      }
      rest();
      bar.classList.remove('dock-focus');
      pill.remove();
      delete bar.dataset.dockEnhanced;
    },
  };
}
