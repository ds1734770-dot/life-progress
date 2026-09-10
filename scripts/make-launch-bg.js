/**
 * Generates the bundled fallback launch background — assets/launch-bg.png.
 * Zero dependencies: a calm deep-navy → teal gradient with soft light glows,
 * a subtle horizon line and fine vignetting, sized 720x1280 (9:16 portrait).
 * It reads well behind white launch text at any device aspect ratio.
 *
 * Run: node scripts/make-launch-bg.js
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'assets');
mkdirSync(OUT_DIR, { recursive: true });

// --- Tiny PNG encoder (same approach as scripts/make-icons.js) -------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Drawing ---------------------------------------------------------------

const W = 720;
const H = 1280;
const px = new Uint8Array(W * H * 4);

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
/** Smooth 0..1 falloff used for the soft glows. */
function glow(dx, dy, radius) {
  const d = Math.sqrt(dx * dx + dy * dy) / radius;
  return clamp01(1 - d) ** 2;
}

const TOP = [8, 13, 22]; // deep navy
const BOTTOM = [10, 30, 38]; // deep teal
// Accent glow colors.
const TEAL = [24, 96, 96];
const BLUE = [20, 44, 84];

for (let y = 0; y < H; y++) {
  const ty = y / H;
  // Light concentrated in the upper third where the quote sits.
  const vignette = 1 - 0.35 * clamp01((ty - 0.45) / 0.55);
  for (let x = 0; x < W; x++) {
    const tx = x / W;
    const i = (y * W + x) * 4;

    let r = lerp(TOP[0], BOTTOM[0], ty);
    let g = lerp(TOP[1], BOTTOM[1], ty);
    let b = lerp(TOP[2], BOTTOM[2], ty);

    // Diagonal teal glow (upper area, like dawn light).
    const g1 = glow(tx - 0.28, ty - 0.22, 0.75);
    r = lerp(r, TEAL[0], g1 * 0.85);
    g = lerp(g, TEAL[1], g1 * 0.85);
    b = lerp(b, TEAL[2], g1 * 0.85);

    // Cooler blue glow low-right for depth.
    const g2 = glow(tx - 0.85, ty - 0.78, 0.8);
    r = lerp(r, BLUE[0], g2 * 0.8);
    g = lerp(g, BLUE[1], g2 * 0.8);
    b = lerp(b, BLUE[2], g2 * 0.8);

    // Subtle horizontal "horizon" line around 62% height.
    const horizon = Math.exp(-(((((ty - 0.62) * H) / 2.2) ** 2)));
    b = lerp(b, 150, horizon * 0.16);
    g = lerp(g, 130, horizon * 0.1);

    r *= vignette;
    g *= vignette;
    b *= vignette;

    px[i] = Math.round(clamp01(r / 255) * 255);
    px[i + 1] = Math.round(clamp01(g / 255) * 255);
    px[i + 2] = Math.round(clamp01(b / 255) * 255);
    px[i + 3] = 255;
  }
}

// Faint star specks in the upper half.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
for (let s = 0; s < 130; s++) {
  const x = Math.floor(rand() * W);
  const y = Math.floor(rand() * H * 0.55);
  const bright = 0.25 + rand() * 0.5;
  const i = (y * W + x) * 4;
  px[i] = Math.min(255, Math.round(px[i] + 255 * bright));
  px[i + 1] = Math.min(255, Math.round(px[i + 1] + 255 * bright));
  px[i + 2] = Math.min(255, Math.round(px[i + 2] + 255 * bright));
}

const out = join(OUT_DIR, 'launch-bg.png');
writeFileSync(out, encodePng(W, H, Buffer.from(px)));
console.log(`Wrote ${out} (${W}x${H})`);
