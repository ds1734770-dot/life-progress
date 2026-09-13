/**
 * Coordinate system — one canonical space for the reference image, the live
 * camera frame, the pose landmarks and the skeleton overlay.
 *
 * THE PROBLEM
 * The reference photo, the camera video and the on-screen viewport all have
 * different sizes, aspect ratios and crops. Drawing a ghost photo and a live
 * skeleton on top of each other only works if every one of them is mapped
 * through the *same* transform. Getting this wrong makes the whole feature
 * useless, so it lives here as small pure functions with unit tests.
 *
 * THE MODEL
 *   aspect      = height / width  (portrait > 1, landscape < 1)
 *   source      = any frame (reference image OR video frame), normalized 0..1
 *   viewport    = the on-screen camera stage, whose aspect is taken FROM the
 *                 reference photo so that "cover" of the reference is an exact
 *                 fit — the user reproduces the reference composition rather
 *                 than a crop of it
 *
 *   source normal ──sourceNormToViewportNorm()──► viewport normal ──► CSS px
 *
 * Both the ghost image and the live skeleton are drawn with "cover" (identical
 * to CSS `object-fit: cover`), and the live video is cropped to the same
 * viewport on capture — so what the user aligns to is exactly what gets saved.
 *
 * MIRRORING is deliberately NOT part of this math. Pose comparison happens in
 * unmirrored (as-saved) image space so left/right landmarks stay anatomic and a
 * match never depends on which camera is in use. The front-camera preview is
 * mirrored for display only, and the guidance wording is flipped in display
 * space (see chooseGuidance in js/pose/alignment.js).
 */

/** Viewport aspect limits — keeps a panorama/very tall photo usable on a phone. */
export const VIEWPORT_ASPECT_LIMITS = Object.freeze({ MIN: 0.5, MAX: 2.0 });

/** Aspect used when there is no reference photo (plain 3:4 portrait stage). */
export const DEFAULT_VIEWPORT_ASPECT = 4 / 3;

/**
 * Clamp a reference photo's aspect into something a phone viewport can host.
 * Applied BEFORE the viewport is laid out, so the ghost always fits exactly.
 */
export function viewportAspectFor(imageAspect, { MIN, MAX } = VIEWPORT_ASPECT_LIMITS) {
  const aspect = Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : DEFAULT_VIEWPORT_ASPECT;
  return Math.min(MAX, Math.max(MIN, aspect));
}

/**
 * `object-fit: cover` solved explicitly.
 * Returns the drawn size and top-left offset of the source inside the
 * destination rectangle (all in destination units).
 */
export function coverTransform(srcW, srcH, dstW, dstH) {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const dw = Math.max(1, dstW);
  const dh = Math.max(1, dstH);
  const scale = Math.max(dw / sw, dh / sh);
  const width = sw * scale;
  const height = sh * scale;
  return { scale, width, height, dx: (dw - width) / 2, dy: (dh - height) / 2 };
}

/**
 * Map a normalized point from a source frame (reference image or video frame)
 * into viewport-normalized coordinates, using the same cover fit the pixels use.
 *
 * `dstAspect` is the viewport's height/width and `srcAspect` the source's.
 */
export function sourceNormToViewportNorm(point, srcAspect, dstAspect) {
  const a = Number.isFinite(srcAspect) && srcAspect > 0 ? srcAspect : DEFAULT_VIEWPORT_ASPECT;
  const b = Number.isFinite(dstAspect) && dstAspect > 0 ? dstAspect : DEFAULT_VIEWPORT_ASPECT;
  // With width normalized to 1, the source is (1 × a) and the viewport (1 × b).
  const scale = Math.max(1, b / a);
  const dx = (1 - scale) / 2;
  const dy = (b - a * scale) / 2;
  return {
    x: point.x * scale + dx,
    y: (point.y * a * scale + dy) / b,
  };
}

/** Convenience: map a whole landmark array (keeps visibility/z). */
export function sourcePoseToViewport(pose, srcAspect, dstAspect) {
  const landmarks = pose.landmarks.map((lm) => {
    const p = sourceNormToViewportNorm(lm, srcAspect, dstAspect);
    return { x: p.x, y: p.y, z: lm.z, visibility: lm.visibility };
  });
  return {
    ...pose,
    landmarks,
    imageWidth: 0,
    imageHeight: 0,
    space: 'viewport',
  };
}

/** Viewport-normalized → CSS pixels, with optional horizontal mirroring. */
export function viewportNormToCss(point, { width, height, mirrored = false }) {
  const x = point.x * width;
  return { x: mirrored ? width - x : x, y: point.y * height };
}

/**
 * The source rectangle to cut out of a frame so it matches the viewport's
 * composition — the crop used when saving a captured photo. Mirrors the cover
 * fit, so the saved photo shows exactly what the user aligned to.
 */
export function captureSourceRect({ srcW, srcH, dstAspect }) {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const srcAspect = sh / sw;
  const dst = Number.isFinite(dstAspect) && dstAspect > 0 ? dstAspect : srcAspect;
  if (dst <= srcAspect) {
    // Viewport is wider than the source → keep full width, crop vertically.
    const h = Math.round(sw * dst);
    return { sx: 0, sy: Math.max(0, Math.round((sh - h) / 2)), sw: Math.round(sw), sh: h };
  }
  // Viewport is taller than the source → keep full height, crop horizontally.
  const w = Math.round(sh / dst);
  return { sx: Math.max(0, Math.round((sw - w) / 2)), sy: 0, sw: w, sh: Math.round(sh) };
}

/** Aspect (h/w) of an arbitrary { width, height }-shaped object. */
export function aspectOf(size) {
  if (!size || !size.width || !size.height) return DEFAULT_VIEWPORT_ASPECT;
  return size.height / size.width;
}
