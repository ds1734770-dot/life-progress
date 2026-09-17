/**
 * Native web-asset build (V2.0 Phase 1) — prepares www/ for Capacitor.
 *
 * Pipeline:  source web app → scripts/build-web.js → www/ → npx cap sync
 *            → iOS / Android WebView (fully local, offline-first).
 *
 * DESIGN (docs/native-push-migration.md):
 *  · WHITELIST copy — only the frontend runtime is listed, so server-only or
 *    development-only material can never drift into the native bundle. The
 *    app is intentionally static ES modules with relative paths (it already
 *    deploys at a domain root OR subpath), so no bundler and no transform is
 *    needed: what GitHub Pages serves is exactly what the WebView gets.
 *  · SECRET GUARD — every copied path is checked against a denylist of
 *    credential patterns (.p8, .pem, .env, VAPID/push state, Firebase
 *    service account, google-services.json). A match FAILS the build loudly
 *    rather than silently shipping a secret into an app package.
 *  · VERIFY — after copying, required runtime assets are asserted present
 *    (app shell, camera controller, pose runtime, WASM, model files, icons).
 *    A missing camera/MediaPipe asset must break the build, not the camera.
 *
 * EXCLUDED BY DESIGN: server/ (Node backend), cloudflare/ (Worker + DO),
 * test/, scripts/, docs/, node_modules/, native projects, package files,
 * generated screenshots, and every secret/state file the backend uses.
 * The frontend contains NO secrets: push-config.js only names the backend
 * origin, and the VAPID public key is fetched at runtime.
 *
 * Usage:  npm run build:web      (idempotent — www/ is rebuilt fresh)
 */
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WWW = join(ROOT, 'www');

/** Frontend runtime entries copied into www/ — everything else is excluded. */
const INCLUDE = [
  'index.html',
  'manifest.webmanifest',
  'push-config.js',
  'sw.js',
  'css',
  'js',
  'assets',
  'icons',
  'vendor',
];

/** Files that must NEVER appear in a native bundle (fail loudly, don't copy). */
const SECRET_PATTERNS = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.dev\.vars$/,
  /(^|\/)\.vapid-keys\.json$/,
  /(^|\/)\.push-data\.json(\.tmp)?$/,
  /(^|\/)google-services\.json$/,
  /(^|\/)service-account[^/]*\.json$/i,
  /\.p8$/,
  /\.pem$/,
];

/** Asserted after the copy — the minimum the app shell + camera need. */
const REQUIRED_FILES = [
  'index.html',
  'manifest.webmanifest',
  'push-config.js',
  'sw.js',
  'css/theme.css',
  'js/app.js',
  'js/platform.js',
  'js/db.js',
  'js/router.js',
  'js/notifications.js',
  'js/pushClient.js',
  'js/camera/controller.js',
  'js/pose/detector.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'assets/launch-bg.png',
  'vendor/mediapipe/vision_bundle.mjs',
  'vendor/mediapipe/manifest.json',
];

function assertNoSecrets(relPath) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(relPath)) {
      throw new Error(`build-web: refusing to bundle secret-like file "${relPath}" — check scripts/build-web.js INCLUDE list`);
    }
  }
}

async function copyEntry(entry) {
  const src = join(ROOT, entry);
  if (!existsSync(src)) throw new Error(`build-web: required source "${entry}" is missing`);
  const info = await stat(src);
  const dest = join(WWW, entry);
  if (info.isDirectory()) {
    await cp(src, dest, { recursive: true, filter: (s) => {
      const rel = relative(ROOT, s).replace(/\\/g, '/');
      assertNoSecrets(rel);
      return true;
    } });
  } else {
    await cp(src, dest);
  }
}

async function countFiles(dir) {
  let files = 0;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, item.name);
    if (item.isDirectory()) files += await countFiles(p);
    else files += 1;
  }
  return files;
}

async function dirSize(dir) {
  let total = 0;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, item.name);
    if (item.isDirectory()) total += await dirSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

/** Verify the copied bundle can actually boot: shell, camera and pose assets. */
async function verifyBundle() {
  const missing = [];
  for (const rel of REQUIRED_FILES) {
    if (!existsSync(join(WWW, rel))) missing.push(rel);
  }
  // MediaPipe manifest is the runtime contract for the pose stack: every file
  // it lists (WASM JS + .wasm + .task model) must exist in www/.
  try {
    const manifest = JSON.parse(await readFile(join(WWW, 'vendor/mediapipe/manifest.json'), 'utf8'));
    for (const file of manifest.files || []) {
      if (!existsSync(join(WWW, 'vendor/mediapipe', file.path))) missing.push(`vendor/mediapipe/${file.path}`);
    }
  } catch (err) {
    missing.push(`vendor/mediapipe/manifest.json unreadable: ${err?.message || err}`);
  }
  if (missing.length) {
    throw new Error(`build-web: www/ is incomplete, missing:\n  - ${missing.join('\n  - ')}`);
  }
}

async function main() {
  if (!existsSync(join(ROOT, 'js/platform.js'))) {
    throw new Error('build-web: js/platform.js not found — run from the repository root');
  }
  await rm(WWW, { recursive: true, force: true }); // fresh, deterministic bundle
  await mkdir(WWW, { recursive: true });
  for (const entry of INCLUDE) await copyEntry(entry);
  await verifyBundle();
  const files = await countFiles(WWW);
  const mb = ((await dirSize(WWW)) / 1048576).toFixed(1);
  console.log(`build-web: www/ ready — ${files} files, ${mb} MB (index.html, app shell, camera + MediaPipe assets, icons)`);
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
