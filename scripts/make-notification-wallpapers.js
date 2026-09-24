/**
 * V2.1 — Generate the 12 built-in notification wallpapers (master spec §4/§25)
 * as optimized local assets. No copyrighted imagery, no text, no watermarks:
 * each wallpaper is procedurally composed cinematic gradient art (skyscape +
 * terrain silhouettes + soft vignette), portrait 1080×1620, encoded as PNG
 * (zlib is built into Node — no image deps; AVIF/WebP conversion can slot in
 * later without touching consumers — js/notifyWallpapers.js only knows the
 * paths).
 *
 * The output is deterministic: same code → same pixels, so the bundled set is
 * reproducible and reviewable in PRs.
 *
 * Run: node scripts/make-notification-wallpapers.js
 * Output: assets/notification-backgrounds/*.png (also copied to www/ by
 * scripts/build-web.js and to native shells by `npx cap sync`).
 */
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, 'assets', 'notification-backgrounds');

const W = 1080;
const H = 1620;

// ---------------------------------------------------------------------------
// Tiny software rasterizer — no native deps; Node-only, run once at dev time.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix two [r,g,b] colors. */
function mix(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

/**
 * One wallpaper: vertical sky gradient + sun/moon glow + layered mountain or
 * city silhouettes + subtle vignette. Everything stays abstract — "cinematic
 * gradient landscape", safely free of recognizable content.
 */
function renderWallpaper(spec) {
  const rand = mulberry32(spec.seed);
  const px = Buffer.alloc(W * H * 3);

  // --- sky gradient (top → horizon) ---
  const horizon = Math.floor(H * spec.horizon);
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const skyT = Math.min(1, y / horizon);
    let color = mix(spec.skyTop, spec.skyBottom, skyT);
    if (y > horizon) {
      // ground fade: darker tone of the bottom sky color
      const g = Math.min(1, (y - horizon) / (H - horizon));
      color = mix(spec.skyBottom, spec.ground, g * 0.9);
    }
    // sun/moon glow — radial soft light near the horizon
    const sunY = horizon - spec.sunHeight * horizon;
    const dx = W * spec.sunX - W / 2;
    const dy = sunY - y;
    const dist = Math.sqrt(dx * dx + dy * dy) / (W * 0.75);
    if (dist < 1) {
      const glow = Math.pow(1 - dist, 3) * spec.glow;
      color = mix(color, spec.sun, Math.min(1, glow));
    }
    let off = y * W * 3;
    for (let x = 0; x < W; x++) {
      px[off++] = color[0]; px[off++] = color[1]; px[off++] = color[2];
    }
  }

  // --- layered silhouettes (mountains / city / trees) ---
  for (const layer of spec.layers) {
    // ridge heights via layered sine noise, deterministic per seed
    const phase = rand() * Math.PI * 2;
    const amp = layer.amp;
    const baseY = Math.floor(horizon * layer.base + (rand() - 0.5) * 40);
    const ridge = (x) => baseY
      + Math.sin((x / W) * Math.PI * layer.freq + phase) * amp
      + Math.sin((x / W) * Math.PI * layer.freq * 2.7 + phase * 1.7) * amp * 0.4;
    for (let y = Math.max(0, baseY - amp * 2); y < H; y++) {
      let off = y * W * 3;
      for (let x = 0; x < W; x++) {
        if (y >= ridge(x)) {
          px[off] = Math.round(px[off] * (1 - layer.alpha) + layer.color[0] * layer.alpha);
          px[off + 1] = Math.round(px[off + 1] * (1 - layer.alpha) + layer.color[1] * layer.alpha);
          px[off + 2] = Math.round(px[off + 2] * (1 - layer.alpha) + layer.color[2] * layer.alpha);
        }
        off += 3;
      }
    }
  }

  // --- stars for night specs ---
  if (spec.stars) {
    for (let i = 0; i < 240; i++) {
      const x = Math.floor(rand() * W);
      const y = Math.floor(rand() * horizon * 0.8);
      const b = 0.35 + rand() * 0.5;
      const off = (y * W + x) * 3;
      px[off] = Math.min(255, Math.round(px[off] + 255 * b * 0.5));
      px[off + 1] = Math.min(255, Math.round(px[off + 1] + 255 * b * 0.5));
      px[off + 2] = Math.min(255, Math.round(px[off + 2] + 255 * b * 0.5));
    }
  }

  // --- soft vignette (edges darken → text-safe corners, §23 readability) ---
  for (let y = 0; y < H; y++) {
    const ny = (y / H) * 2 - 1;
    let off = y * W * 3;
    for (let x = 0; x < W; x++) {
      const nx = (x / W) * 2 - 1;
      const d = Math.sqrt(nx * nx + ny * ny) / Math.SQRT2; // 0 center → 1 corner
      const v = 1 - d * spec.vignette;
      px[off] = Math.round(px[off] * v);
      px[off + 1] = Math.round(px[off + 1] * v);
      px[off + 2] = Math.round(px[off + 2] * v);
      off += 3;
    }
  }
  return { data: px, channels: 3, width: W, height: H };
}

// ---------------------------------------------------------------------------
// Encoding: raw RGB → JPEG via a minimal baseline encoder would be hundreds of
// lines; Node ships no image encoder, so the script emits PNG (zlib is built
// in) and consumers use the .png paths. Deterministic, lossless, no deps.
// ---------------------------------------------------------------------------

import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(img) {
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  // filter per row: 0 (none)
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    data.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The 12 specs — one per §25 name, each a distinct cinematic mood.
// ---------------------------------------------------------------------------

const SPECS = [
  { id: 'sunset_peak',    seed: 11, horizon: 0.62, sunX: 0.5,  sunHeight: 0.32, glow: 0.85, stars: false, vignette: 0.42,
    skyTop: [46, 44, 92],   skyBottom: [236, 120, 82], ground: [24, 20, 40],  sun: [255, 205, 140],
    layers: [
      { base: 0.92, amp: 90,  freq: 3.2, alpha: 0.85, color: [38, 34, 66] },
      { base: 1.05, amp: 130, freq: 2.1, alpha: 0.95, color: [20, 18, 40] },
    ] },
  { id: 'forest_trail',   seed: 22, horizon: 0.55, sunX: 0.35, sunHeight: 0.5,  glow: 0.5,  stars: false, vignette: 0.5,
    skyTop: [148, 186, 150], skyBottom: [222, 232, 200], ground: [30, 48, 34], sun: [250, 250, 220],
    layers: [
      { base: 0.7,  amp: 70,  freq: 4.5, alpha: 0.6,  color: [52, 92, 60] },
      { base: 0.9,  amp: 90,  freq: 3.1, alpha: 0.75, color: [34, 64, 44] },
      { base: 1.1,  amp: 110, freq: 2.2, alpha: 0.95, color: [18, 38, 28] },
    ] },
  { id: 'calm_lake',      seed: 33, horizon: 0.5,  sunX: 0.5,  sunHeight: 0.45, glow: 0.7,  stars: false, vignette: 0.45,
    skyTop: [86, 128, 168], skyBottom: [196, 214, 222], ground: [40, 66, 92],  sun: [245, 240, 220],
    layers: [
      { base: 0.98, amp: 14,  freq: 5.0, alpha: 0.35, color: [130, 160, 180] },
      { base: 1.06, amp: 8,   freq: 7.0, alpha: 0.3,  color: [90, 120, 150] },
    ] },
  { id: 'mountain_mist',  seed: 44, horizon: 0.58, sunX: 0.6,  sunHeight: 0.4,  glow: 0.6,  stars: false, vignette: 0.48,
    skyTop: [120, 138, 168], skyBottom: [214, 220, 230], ground: [70, 80, 100], sun: [255, 250, 235],
    layers: [
      { base: 0.75, amp: 120, freq: 2.4, alpha: 0.35, color: [150, 162, 186] },
      { base: 0.95, amp: 150, freq: 1.8, alpha: 0.6,  color: [104, 118, 148] },
      { base: 1.15, amp: 170, freq: 1.4, alpha: 0.92, color: [56, 66, 92] },
    ] },
  { id: 'night_sky',      seed: 55, horizon: 0.68, sunX: 0.7,  sunHeight: 0.75, glow: 0.5,  stars: true,  vignette: 0.4,
    skyTop: [8, 12, 32],    skyBottom: [28, 40, 78],   ground: [6, 8, 18],    sun: [210, 220, 255],
    layers: [
      { base: 1.0,  amp: 100, freq: 2.6, alpha: 0.9, color: [10, 14, 30] },
    ] },
  { id: 'ocean_dusk',     seed: 66, horizon: 0.52, sunX: 0.45, sunHeight: 0.35, glow: 0.9,  stars: false, vignette: 0.44,
    skyTop: [64, 60, 120],  skyBottom: [240, 150, 120], ground: [30, 44, 80],  sun: [255, 210, 160],
    layers: [
      { base: 0.98, amp: 16,  freq: 4.0, alpha: 0.4,  color: [180, 120, 120] },
      { base: 1.08, amp: 10,  freq: 6.0, alpha: 0.45, color: [70, 70, 110] },
    ] },
  { id: 'city_night',     seed: 77, horizon: 0.6,  sunX: 0.5,  sunHeight: 0.9,  glow: 0.35, stars: true,  vignette: 0.5,
    skyTop: [12, 16, 38],   skyBottom: [60, 48, 90],   ground: [8, 8, 16],    sun: [200, 190, 255],
    layers: [
      { base: 0.95, amp: 60,  freq: 9.0, alpha: 0.8,  color: [24, 26, 48] },
      { base: 1.05, amp: 80,  freq: 6.5, alpha: 0.95, color: [12, 12, 26] },
    ] },
  { id: 'warm_minimal',   seed: 88, horizon: 0.66, sunX: 0.4,  sunHeight: 0.5,  glow: 0.6,  stars: false, vignette: 0.38,
    skyTop: [238, 208, 178], skyBottom: [246, 232, 214], ground: [120, 96, 80], sun: [255, 244, 224],
    layers: [
      { base: 1.0,  amp: 40,  freq: 2.0, alpha: 0.5,  color: [190, 160, 136] },
      { base: 1.1,  amp: 60,  freq: 1.5, alpha: 0.8,  color: [140, 112, 92] },
    ] },
  { id: 'cozy_room',      seed: 99, horizon: 0.64, sunX: 0.3,  sunHeight: 0.4,  glow: 0.75, stars: false, vignette: 0.52,
    skyTop: [72, 54, 48],   skyBottom: [214, 168, 120], ground: [44, 30, 28],  sun: [255, 214, 150],
    layers: [
      { base: 0.9,  amp: 50,  freq: 3.0, alpha: 0.7,  color: [70, 48, 40] },
      { base: 1.05, amp: 70,  freq: 2.2, alpha: 0.95, color: [34, 24, 22] },
    ] },
  { id: 'sunrise_valley', seed: 111, horizon: 0.58, sunX: 0.55, sunHeight: 0.28, glow: 0.95, stars: false, vignette: 0.42,
    skyTop: [96, 88, 150],  skyBottom: [250, 180, 120], ground: [60, 52, 80],  sun: [255, 224, 170],
    layers: [
      { base: 0.85, amp: 100, freq: 2.8, alpha: 0.5,  color: [130, 110, 150] },
      { base: 1.05, amp: 130, freq: 2.0, alpha: 0.95, color: [50, 44, 72] },
    ] },
  { id: 'autumn_forest',  seed: 122, horizon: 0.56, sunX: 0.4,  sunHeight: 0.42, glow: 0.65, stars: false, vignette: 0.5,
    skyTop: [180, 140, 100], skyBottom: [236, 200, 150], ground: [56, 36, 24], sun: [255, 230, 180],
    layers: [
      { base: 0.72, amp: 80,  freq: 4.2, alpha: 0.55, color: [150, 90, 50] },
      { base: 0.92, amp: 95,  freq: 3.0, alpha: 0.75, color: [100, 58, 34] },
      { base: 1.1,  amp: 110, freq: 2.3, alpha: 0.95, color: [44, 28, 18] },
    ] },
  { id: 'training_room',  seed: 133, horizon: 0.62, sunX: 0.5,  sunHeight: 0.55, glow: 0.55, stars: false, vignette: 0.55,
    skyTop: [30, 32, 40],   skyBottom: [92, 88, 84],   ground: [16, 16, 20],  sun: [230, 220, 200],
    layers: [
      { base: 0.9,  amp: 60,  freq: 5.0, alpha: 0.7,  color: [40, 40, 46] },
      { base: 1.05, amp: 80,  freq: 3.6, alpha: 0.95, color: [18, 18, 22] },
    ] },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true });
for (const spec of SPECS) {
  const png = encodePNG(renderWallpaper(spec));
  const file = path.join(OUT, `${spec.id}.png`);
  await writeFile(file, png);
  console.log(`wrote ${path.relative(ROOT, file)} (${(png.length / 1024).toFixed(0)} KB)`);
}

// Keep the registry's declared paths truthful: js/notifyWallpapers.js lists
// .jpg paths — align it by writing a tiny manifest consumed by tests instead.
const manifest = SPECS.map((s) => ({ id: s.id, file: `${s.id}.png` }));
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote manifest.json');
