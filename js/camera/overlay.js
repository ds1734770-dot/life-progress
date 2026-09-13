/**
 * Camera stage overlay — the two canvases that sit over the live preview.
 *
 *   ghost canvas (static)   reference photo at low opacity + its skeleton
 *   live canvas  (dynamic)  the live body skeleton
 *
 * Layering the static guide separately means the reference photo is decoded and
 * drawn once per resize instead of every frame — the per-frame work stays a few
 * dozen line segments, which is what keeps the preview responsive on a phone.
 *
 * The overlay owns zero coordinate math: it is handed a `projector` function
 * that maps viewport-normalized points to CSS pixels (see js/camera/
 * coordinates.js), so mirroring/aspect/crop decisions live in exactly one
 * place.
 */
import { POSE_CONNECTIONS } from '../pose/geometry.js';

export const REFERENCE_MODES = Object.freeze(['ghost', 'outline', 'off']);

/** Reference-image opacity per visibility mode (§10). */
const GHOST_OPACITY = { ghost: 0.22, outline: 0, off: 0 };
const GHOST_SKELETON_ALPHA = { ghost: 0.45, outline: 0.8, off: 0 };

const LIVE_COLOR = { aligned: 'rgba(45, 212, 191, 0.95)', partial: 'rgba(237, 242, 247, 0.85)', matched: 'rgba(52, 211, 153, 1)' };

export function createStageOverlay({ ghostCanvas, liveCanvas, reducedMotion = false }) {
  if (!ghostCanvas || !liveCanvas) return nullOverlay();
  const ghostCtx = ghostCanvas.getContext('2d');
  const liveCtx = liveCanvas.getContext('2d');
  let size = { width: 0, height: 0, dpr: 1 };
  let lastKey = '';

  function resize({ width, height, dpr = 1 }) {
    size = { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), dpr };
    for (const [canvas, ctx] of [
      [ghostCanvas, ghostCtx],
      [liveCanvas, liveCtx],
    ]) {
      canvas.width = Math.round(size.width * dpr);
      canvas.height = Math.round(size.height * dpr);
      canvas.style.width = `${size.width}px`;
      canvas.style.height = `${size.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
    }
    lastKey = '';
  }

  /** Draw the reference photo + skeleton. Static: call on resize/mode change. */
  function drawGhost({ image, points, mode = 'ghost', projector }) {
    const ctx = ghostCtx;
    ctx.clearRect(0, 0, size.width, size.height);
    const opacity = GHOST_OPACITY[mode] ?? 0;
    if (opacity > 0 && image && image.complete !== false && (image.naturalWidth || image.width)) {
      // The reference and the viewport share an aspect ratio, so a cover fit of
      // the reference is also an exact fit of the composition the user sees.
      const scale = Math.max(size.width / (image.naturalWidth || image.width), size.height / (image.naturalHeight || image.height));
      const w = (image.naturalWidth || image.width) * scale;
      const h = (image.naturalHeight || image.height) * scale;
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.drawImage(image, (size.width - w) / 2, (size.height - h) / 2, w, h);
      ctx.restore();
    }
    const alpha = GHOST_SKELETON_ALPHA[mode] ?? 0;
    if (alpha > 0 && points && projector) {
      drawSkeleton(ctx, points, projector, {
        color: `rgba(237, 242, 247, ${alpha})`,
        lineWidth: 2,
        dashed: true,
        dotRadius: 2.5,
        hollow: true,
      });
    }
    lastKey = '';
  }

  /**
   * Draw the live skeleton. Returns false when nothing changed and the canvas
   * was left untouched (cheap guard against redundant repaints).
   */
  function drawLive({ points, projector, state = 'partial', partial = false }) {
    const key = `${state}:${partial}:${points ? Object.entries(points).map(([i, p]) => `${i}${Math.round(p.x * 500)},${Math.round(p.y * 500)}`).join('|') : 'none'}`;
    if (key === lastKey) return false;
    lastKey = key;

    const ctx = liveCtx;
    ctx.clearRect(0, 0, size.width, size.height);
    if (!points || !projector) return true;

    const color = state === 'matched' ? LIVE_COLOR.matched : state === 'aligned' ? LIVE_COLOR.aligned : LIVE_COLOR.partial;
    drawSkeleton(ctx, points, projector, {
      color,
      lineWidth: state === 'matched' && !reducedMotion ? 3.5 : 3,
      dashed: false,
      dotRadius: 3.5,
      hollow: false,
      glow: state === 'matched' && !reducedMotion ? 12 : 0,
    });
    return true;
  }

  function clearLive() {
    lastKey = '';
    liveCtx.clearRect(0, 0, size.width, size.height);
  }

  function dispose() {
    try {
      ghostCtx.setTransform(1, 0, 0, 1, 0, 0);
      liveCtx.setTransform(1, 0, 0, 1, 0, 0);
      ghostCanvas.width = 0;
      ghostCanvas.height = 0;
      liveCanvas.width = 0;
      liveCanvas.height = 0;
    } catch {
      /* the canvases are being torn down with the screen */
    }
    size = { width: 0, height: 0, dpr: 1 };
  }

  return { resize, drawGhost, drawLive, clearLive, dispose, get size() { return size; } };
}

function drawSkeleton(ctx, points, projector, style) {
  const px = new Map();
  for (const [index, point] of Object.entries(points)) {
    px.set(Number(index), projector(point));
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = style.color;
  ctx.fillStyle = style.color;
  ctx.lineWidth = style.lineWidth;
  if (style.glow) {
    ctx.shadowColor = style.color;
    ctx.shadowBlur = style.glow;
  }
  if (style.dashed) {
    ctx.setLineDash([5, 5]);
    if (ctx.setLineDash.length === 0 || typeof ctx.lineDashOffset === 'number') ctx.lineDashOffset = 0;
  }

  for (const [a, b] of POSE_CONNECTIONS) {
    const pa = px.get(a);
    const pb = px.get(b);
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // Joints after the bones so they stay crisp on top.
  ctx.setLineDash([]);
  for (const point of px.values()) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, style.dotRadius, 0, Math.PI * 2);
    if (style.hollow) {
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.fill();
    }
  }
  ctx.restore();
}

function nullOverlay() {
  return {
    resize() {},
    drawGhost() {},
    drawLive() {
      return false;
    },
    clearLive() {},
    dispose() {},
    size: { width: 0, height: 0, dpr: 1 },
  };
}
