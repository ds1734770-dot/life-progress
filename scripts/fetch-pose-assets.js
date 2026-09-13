/**
 * Fetch the on-device pose-estimation assets into vendor/mediapipe/.
 *
 * Why vendor instead of a runtime CDN:
 *   Life Progress is offline-first and private by design. The smart progress
 *   camera must work with no network at all, and no camera frame, progress
 *   photo or pose landmark may ever leave the device. Serving the runtime from
 *   a third-party CDN at runtime would violate both properties, so the assets
 *   are pinned here, committed, and served same-origin.
 *
 * Verified (see vendor/mediapipe/README.md): the pinned runtime bundle makes
 * no telemetry/analytics requests and contains no hard-coded external URLs —
 * every fetch it performs targets the base paths this app hands it, i.e. this
 * directory.
 *
 * Usage:
 *   node scripts/fetch-pose-assets.js                 # SIMD wasm + lite model
 *   node scripts/fetch-pose-assets.js --nosimd         # also vendor the non-SIMD wasm
 *   node scripts/fetch-pose-assets.js --model=full     # pose_landmarker_full instead
 *   node scripts/fetch-pose-assets.js --model=heavy
 *   node scripts/fetch-pose-assets.js --force          # re-download + re-hash
 *
 * Re-running without --force only verifies what is already on disk (idempotent,
 * no diff churn). The script writes vendor/mediapipe/manifest.json, which the
 * app reads at runtime to decide whether the smart camera is available.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const VENDOR_DIR = join(ROOT, 'vendor', 'mediapipe');

/** Pinned runtime version — bump deliberately, then re-run with --force. */
export const TASKS_VISION_VERSION = '0.10.14';
/** Pinned model version in the MediaPipe model registry. */
export const MODEL_VERSION = '1';
export const MODEL_NAMES = ['pose_landmarker_lite', 'pose_landmarker_full', 'pose_landmarker_heavy'];

const NPM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

const args = process.argv.slice(2);
const force = args.includes('--force');
const withNosimd = args.includes('--nosimd');
const modelArg = args.find((a) => a.startsWith('--model='));
const modelName = modelArg ? modelArg.split('=')[1] : 'pose_landmarker_lite';
if (!MODEL_NAMES.includes(modelName)) {
  console.error(`Unknown model "${modelName}". Choose one of: ${MODEL_NAMES.join(', ')}`);
  process.exit(1);
}

/** Files that make up the vendored runtime + model. */
export function assetFiles({ nosimd = false, model = 'pose_landmarker_lite' } = {}) {
  const files = [
    { path: 'vision_bundle.mjs', url: `${NPM_BASE}/vision_bundle.mjs` },
    { path: 'wasm/vision_wasm_internal.js', url: `${NPM_BASE}/wasm/vision_wasm_internal.js` },
    { path: 'wasm/vision_wasm_internal.wasm', url: `${NPM_BASE}/wasm/vision_wasm_internal.wasm` },
  ];
  if (nosimd) {
    files.push(
      { path: 'wasm/vision_wasm_nosimd_internal.js', url: `${NPM_BASE}/wasm/vision_wasm_nosimd_internal.js` },
      { path: 'wasm/vision_wasm_nosimd_internal.wasm', url: `${NPM_BASE}/wasm/vision_wasm_nosimd_internal.wasm` }
    );
  }
  files.push({
    path: `models/${model}.task`,
    url: `${MODEL_BASE}/${model}/float16/${MODEL_VERSION}/${model}.task`,
  });
  return files;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const files = assetFiles({ nosimd: withNosimd, model: modelName });
  await mkdir(join(VENDOR_DIR, 'wasm'), { recursive: true });
  await mkdir(join(VENDOR_DIR, 'models'), { recursive: true });

  let downloaded = 0;
  let verified = 0;
  let totalBytes = 0;

  for (const file of files) {
    const target = join(VENDOR_DIR, file.path);
    let buf;
    if (!force && existsSync(target)) {
      buf = await readFile(target);
      verified += 1;
      console.log(`• present   ${file.path}  (${buf.length.toLocaleString()} bytes)`);
    } else {
      process.stdout.write(`↓ fetching ${file.path} … `);
      buf = await download(file.url);
      await writeFile(target, buf);
      downloaded += 1;
      console.log(`${buf.length.toLocaleString()} bytes`);
    }
    totalBytes += buf.length;
    file.bytes = buf.length;
    file.sha256 = sha256(buf);
  }

  // Fast sanity check: a truncated download is the classic failure mode, and a
  // corrupt wasm only shows up as a confusing runtime error later.
  for (const file of files) {
    if (!file.bytes || file.bytes < 1024) {
      throw new Error(`${file.path} looks truncated (${file.bytes} bytes)`);
    }
  }

  const manifest = {
    runtime: '@mediapipe/tasks-vision',
    runtimeVersion: TASKS_VISION_VERSION,
    model: {
      name: modelName,
      version: MODEL_VERSION,
      path: `models/${modelName}.task`,
      source: `${MODEL_BASE}/${modelName}/float16/${MODEL_VERSION}/${modelName}.task`,
      license: 'Apache-2.0',
    },
    wasmVariants: withNosimd ? ['simd', 'nosimd'] : ['simd'],
    wasmBase: 'wasm',
    bundle: 'vision_bundle.mjs',
    privacy:
      'Vendored same-origin. Inference runs on-device (WASM). No telemetry, no analytics, ' +
      'no camera frame / progress photo / pose landmark leaves the device.',
    files: files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })),
  };
  await writeFile(join(VENDOR_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nmanifest.json written (${manifest.wasmVariants.join('+')}, ${modelName}).`);
  console.log(`downloaded ${downloaded}, verified ${verified}, total ${(totalBytes / 1048576).toFixed(1)} MB in vendor/mediapipe/`);
  if (!withNosimd) {
    console.log('Note: only the SIMD wasm is vendored. Browsers without WebAssembly SIMD fall back to the standard camera (js/pose/detector.js guards this).');
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/fetch-pose-assets.js')) {
  main().catch((err) => {
    console.error('\nPose asset fetch failed:', err.message);
    process.exit(1);
  });
}
