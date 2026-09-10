/**
 * Generates the PWA icons (192px + 512px PNG) with zero dependencies.
 * Uses Node's built-in zlib to write a real PNG file, drawing a rounded
 * gradient tile with a white droplet + progress ring programmatically.
 *
 * Run: node scripts/make-icons.js
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'icons');
mkdirSync(OUT_DIR, { recursive: true });

// --- Tiny PNG encoder -----------------------------------------------------

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

// --- Drawing --------------------------------------------------------------

function roundedRectCover(x, y, w, h, r) {
  return (px, py) => {
    if (px < x || px >= x + w || py < y || py >= y + h) return false;
    const cx = Math.min(Math.max(px - x, r - 1), w - r);
    const cy = Math.min(Math.max(py - y, r - 1), h - r);
    const dx = px - (x + cx);
    const dy = py - (y + cy);
    return dx * dx + dy * dy <= r * r;
  };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function makeIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const s = size / 512;
  const inside = roundedRectCover(0, 0, size, size, 112 * s);

  // Vertical gradient background (deep navy -> teal tint).
  const top = [11, 18, 26];
  const bottom = [10, 45, 44];

  for (let y = 0; y < size; y++) {
    const t = y / size;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inside(x, y)) {
        px[i + 3] = 0;
        continue;
      }
      const r = lerp(top[0], bottom[0], t);
      const g = lerp(top[1], bottom[1], t);
      const b = lerp(top[2], bottom[2], t);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }

  // Progress ring (white with teal fill on the right side).
  const cx = size / 2;
  const cy = size / 2;
  const ringR = 172 * s;
  const ringW = 26 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > ringR || d < ringR - ringW) continue;
      let angle = Math.atan2(dy, dx); // -PI..PI
      const frac = (angle + Math.PI) / (2 * Math.PI);
      const i = (y * size + x) * 4;
      const filled = frac > 0.22 && frac < 0.72;
      px[i] = filled ? 45 : 245;
      px[i + 1] = filled ? 212 : 250;
      px[i + 2] = filled ? 191 : 252;
      px[i + 3] = 255;
    }
  }

  // Droplet in the center.
  const dropY = 272 * s;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (px[i + 3] === 0) continue;
      const dx = (x - cx) / s;
      const dy = (y - dropY) / s;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= 68) {
        // Circle body (bottom) with a point at the top (teardrop shape).
        const point = dx * dx + (dy + 30) * (dy + 30) < 78 * 78 && dy < 0;
        if (d <= 68 || point) {
          px[i] = 255;
          px[i + 1] = 255;
          px[i + 2] = 255;
          px[i + 3] = 255;
        }
      }
    }
  }

  return encodePng(size, size, Buffer.from(px));
}

for (const size of [192, 512]) {
  const out = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(out, makeIcon(size));
  console.log(`Wrote ${out} (${size}x${size})`);
}