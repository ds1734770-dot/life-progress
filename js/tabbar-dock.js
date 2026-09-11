/**
 * Floating navigation dock — Life Progress V1.1.
 *
 * Transforms the existing full-width bottom bar (#tabbar) into a compact
 * floating glass dock with a single active capsule that slides between tabs.
 *
 * Design rules:
 *   - The existing .tab-item buttons remain the source of truth: same routes,
 *     same icons, same labels, same tap / click / keyboard behaviour. This
 *     module never handles taps — router.js's native click listeners do.
 *   - ACTIVE ROUTE (`.active` + aria-current, owned by router.js) and
 *     INTERACTION (press feedback, focus ring) stay independent.
 *   - The active capsule is one element that physically travels between
 *     items (transform + width), exactly like the WhatsApp-style model.
 *     router.js calls `moveCapsule()` after updating `.active`.
 *   - All motion is transform/opacity/width-on-one-layer, batched through
 *     rAF where continuous. Layout is measured once per change, not per frame.
 *   - `prefers-reduced-motion: reduce`: capsule jumps without animation,
 *     entrance and spring settle are disabled.
 *
 * The geometry lives in pure, DOM-free helpers (unit-tested in
 * test/tabbar-dock.test.js); `enhanceTabbar` only wires DOM to it.
 */

/** Tuning for the floating dock + active capsule. */
export const DOCK_TUNING = Object.freeze({
  capsulePadX: 6,        // px of horizontal padding inside the capsule
  capsuleMinW: 52,       // px minimum capsule width (compact touch target)
  slideMs: 300,          // capsule travel duration (spec: 200–350ms)
  settleMs: 450,         // extra time the spring settle may take
  entranceDelayMs: 120,  // after renderTabbar, before the dock floats in
  iconScale: 1.08,       // active icon scale (spec: 1.05–1.12)
  pressScale: 0.97,      // touch press scale (spec: 0.96–0.98)
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
  if (!bar || typeof window === 'undefined' || typeof document === 'undefined') {
    return { destroy() {}, moveCapsule() {}, primeEntrance() {}, playEntrance() {} };
  }
  if (bar.dataset.dockEnhanced === '1') {
    return { destroy() {}, moveCapsule() {}, primeEntrance() {}, playEntrance() {} };
  }
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

  let rafId = 0;
  let animation = null; // { from, to, start } while the capsule travels

  const queryItems = () => Array.from(bar.querySelectorAll('.tab-item'));

  /** Measure one item's geometry (bar-relative). */
  function measureItem(item) {
    const barRect = bar.getBoundingClientRect();
    const r = item.getBoundingClientRect();
    return capsuleFor(r.left + r.width / 2 - barRect.left, r.width);
  }

  function findActive() {
    return queryItems().find((item) => item.classList.contains('active')) || null;
  }

  /** Current capsule position from its inline transform, or null. */
  function currentCapsule() {
    const m = capsule.style.transform.match(/translate3d\((-?[\d.]+)px/);
    if (!m) return null;
    return { left: parseFloat(m[1]), width: parseFloat(capsule.style.width) || DOCK_TUNING.capsuleMinW };
  }

  /** Frame-rate-independent ease-out for the travel animation. */
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  /**
   * Move the capsule to the current active item. When `animate` is true and
   * motion is allowed, the capsule glides from its current position — a
   * single object travelling between destinations, ~300ms.
   */
  function moveCapsule({ animate = true } = {}) {
    const active = findActive();
    if (!active) {
      capsule.style.opacity = '0';
      return;
    }
    // rAF stepping drives the travel; any stale inline transition (e.g. left
    // over from a reduced-motion jump) must not fight it.
    capsule.style.transition = '';
    const target = measureItem(active);
    const reduced = reducedMotion();

    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    animation = null;

    if (reduced || !animate) {
      // No transition on the capsule element → setting these jumps instantly.
      capsule.style.width = `${target.width.toFixed(2)}px`;
      capsule.style.transform = `translate3d(${target.left.toFixed(2)}px, 0, 0)`;
      capsule.style.opacity = '1';
      return;
    }

    const start = currentCapsule() || { left: target.left, width: target.width };
    const distance = Math.abs(target.left - start.left);
    if (distance < 0.5 && Math.abs(target.width - start.width) < 0.5) {
      // Already (essentially) there — just make sure it's visible.
      capsule.style.width = `${target.width.toFixed(2)}px`;
      capsule.style.transform = `translate3d(${target.left.toFixed(2)}px, 0, 0)`;
      capsule.style.opacity = '1';
      return;
    }

    const begin = performance.now();
    const apply = (geo) => {
      capsule.style.width = `${geo.width.toFixed(2)}px`;
      capsule.style.transform = `translate3d(${geo.left.toFixed(2)}px, 0, 0)`;
    };
    const step = (now) => {
      const t = Math.min(1, (now - begin) / DOCK_TUNING.slideMs);
      apply(interpolateCapsule(start, target, easeOutCubic(t)));
      if (t < 1) rafId = requestAnimationFrame(step);
      else rafId = 0;
    };
    rafId = requestAnimationFrame(step);
  }

  // ---- One-time entrance (float up + fade in) ------------------------------

  let entranceArmed = false;

  function primeEntrance() {
    if (reducedMotion()) return;
    entranceArmed = true;
    bar.classList.add('dock-hidden');
  }

  function playEntrance() {
    if (!entranceArmed) return;
    entranceArmed = false;
    bar.classList.remove('dock-hidden');
    bar.classList.add('dock-enter');
    setTimeout(() => bar.classList.remove('dock-enter'), DOCK_TUNING.entranceDelayMs + DOCK_TUNING.settleMs);
  }

  // ---- Press feedback (subtle scale-down while touching) -------------------

  function onPressStart(e) {
    const item = e.target && e.target.closest ? e.target.closest('.tab-item') : null;
    if (!item) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    item.classList.add('tab-pressed');
  }

  function onPressEnd(e) {
    const item = e.target && e.target.closest ? e.target.closest('.tab-item') : null;
    if (item) item.classList.remove('tab-pressed');
  }

  bar.addEventListener('pointerdown', onPressStart);
  bar.addEventListener('pointerup', onPressEnd);
  bar.addEventListener('pointercancel', onPressEnd);
  bar.addEventListener('pointerleave', onPressEnd);

  // Initial sync: place the capsule on the active item without animation.
  requestAnimationFrame(() => moveCapsule({ animate: false }));

  return {
    destroy() {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      bar.removeEventListener('pointerdown', onPressStart);
      bar.removeEventListener('pointerup', onPressEnd);
      bar.removeEventListener('pointercancel', onPressEnd);
      bar.removeEventListener('pointerleave', onPressEnd);
      capsule.remove();
      bar.classList.remove('dock-hidden', 'dock-enter');
      delete bar.dataset.dockEnhanced;
    },
    moveCapsule,
    primeEntrance,
    playEntrance,
  };
}
