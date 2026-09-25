/**
 * Boot-safety regression test — the browser module graph must stay LINKABLE.
 *
 * Root cause this pins (2026-09-25 blank-screen incident): the V2.2 rewrite
 * of js/notifications.js dropped 8 named exports that
 * js/screens/notificationAppearance.js (and others) statically import. One
 * missing named export makes EVERY static importer of that module fail at
 * module-graph LINK time — before any code runs — so the app rendered an
 * empty #screen-root and nothing else (blank screen). The unit suites never
 * noticed because no test imported the page module graph.
 *
 * Strategy (no source-text sniffing — real graph analysis):
 *   1. Parse index.html for module <script src> entries (the graph roots).
 *   2. Recursively parse ES module `import ... from '...'` and
 *      `import('...')` edges with a regex that understands the actual
 *      import syntax used in this codebase (ES modules, relative paths).
 *   3. Assert every referenced file EXISTS (base-path regressions, 404s).
 *   4. Extract each import clause's NAMED bindings and assert the target
 *      module actually EXPORTS them (the exact failure mode that blanked
 *      the app). Namespace imports (`* as x`) and default imports are
 *      structure-only and cannot fail at link time, so they are skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Cache of parsed export-name sets, keyed by repo-relative module path. */
const exportCache = new Map();
/** Every edge visited so far (module graph is a cycle-rich DAG). */
const visited = new Set();
/** Collected failures: [fromModule, specifier, problem]. */
const problems = [];

/** Relative specifier ('./x.js', '../y/z.js') → repo-relative POSIX path. */
function resolveSpec(fromModule, spec) {
  if (!spec.startsWith('.')) return null; // bare specifier — none exist in this app; skip
  return normalize(join(dirname(fromModule), spec)).replace(/\\/g, '/');
}

/** Extract a module's exported names (declarative + re-export clauses). */
function exportsOf(modPath) {
  if (exportCache.has(modPath)) return exportCache.get(modPath);
  const names = new Set();
  if (!existsSync(join(ROOT, modPath))) {
    exportCache.set(modPath, names);
    return names;
  }
  const src = readFileSync(join(ROOT, modPath), 'utf8');
  // export function|async function|const|let|var|class NAME
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  // export { a, b as c }  (single-line clauses only — matches this codebase)
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  // export * from './x.js' → union the target's names (one level; handles timeCore re-exports)
  for (const m of src.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) {
    const target = resolveSpec(modPath, m[1]);
    if (target) for (const n of exportsOf(target)) names.add(n);
  }
  exportCache.set(modPath, names);
  return names;
}

/**
 * Walk one module: record missing files, verify named imports, recurse.
 * `dynamic` edges are import('...') calls — they cannot break page LINK
 * time, but a missing file or missing named destructure still breaks at
 * runtime, so they are checked too and reported with their kind.
 */
function walk(fromModule, dynamic = false) {
  if (visited.has(fromModule)) return;
  visited.add(fromModule);
  const abs = join(ROOT, fromModule);
  if (!existsSync(abs)) {
    problems.push([fromModule, '(self)', 'module file does not exist']);
    return;
  }
  const src = readFileSync(abs, 'utf8');
  const specKind = dynamic ? 'dynamic import' : 'static import';

  // Static: import { a, b as c } from './x.js'  /  import * as ns from '...'  /  import def from '...'
  for (const m of src.matchAll(/^import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = m[1].trim();
    const target = resolveSpec(fromModule, m[2]);
    if (!target) continue;
    if (!existsSync(join(ROOT, target))) {
      problems.push([fromModule, m[2], `${specKind} target missing on disk`]);
      continue;
    }
    if (clause.startsWith('*')) continue; // namespace import — link-safe
    const named = clause.startsWith('{')
      ? clause
      : clause.includes('{')
        ? clause.slice(clause.indexOf('{')) // default + named mix
        : null;
    if (!named) continue; // default-only — link-safe
    for (const part of named.replace(/[{}]/g, '').split(',')) {
      const binding = part.trim().split(/\s+as\s+/)[0].trim();
      if (!binding) continue;
      if (!exportsOf(target).has(binding)) {
        problems.push([fromModule, m[2], `imports missing name '${binding}'`]);
      }
    }
    walk(target);
  }
  // Also bare `import './x.js';` side-effect modules
  for (const m of src.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) {
    const target = resolveSpec(fromModule, m[1]);
    if (target && !existsSync(join(ROOT, target))) {
      problems.push([fromModule, m[1], `${specKind} target missing on disk`]);
    } else if (target) walk(target);
  }

  // Dynamic: import('./x.js') / import('./x.js').then(...)
  for (const m of src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = resolveSpec(fromModule, m[1]);
    if (!target) continue;
    if (!existsSync(join(ROOT, target))) {
      problems.push([fromModule, m[1], 'dynamic import target missing on disk']);
      continue;
    }
    walk(target, true);
  }
}

// Graph roots: every script index.html loads (module AND classic — a missing
// or unresolvable boot script of either kind is a broken page).
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const roots = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)]
  .map((m) => m[1].replace(/^\.?\//, ''));
// The service worker is a root of its own graph (checked identically).
roots.push('sw.js');

test('module graph roots are discovered from index.html', () => {
  assert.ok(roots.includes('js/app.js'), 'app.js must be a module root of index.html');
  assert.ok(roots.includes('push-config.js'), 'push-config.js must be loaded by index.html');
});

test('every browser module resolves and every named import exists (link-time safety)', () => {
  for (const root of roots) walk(root);
  assert.deepEqual(
    problems,
    [],
    `broken module-graph edges (would blank the app at link time):\n` +
      problems.map(([from, spec, why]) => `  ${from}  →  ${spec}  ${why}`).join('\n')
  );
});

test('the blank-screen regression surface: notification appearance exports exist', () => {
  // Pinned exactly: the 8 exports the V2.2 rewrite dropped. If any export
  // disappears again, the first assertion above already fails — this one
  // names them for a clear failure message.
  const names = exportsOf('js/notifications.js');
  for (const required of [
    'getNotificationAppearance',
    'saveNotificationAppearance',
    'defaultNotificationAppearancePrefs',
    'resolveNotificationWallpaper',
    'getCustomWallpaperPhoto',
    'saveCustomWallpaperPhoto',
    'removeCustomWallpaperPhoto',
    'resetNotificationAppearance',
  ]) {
    assert.ok(names.has(required), `js/notifications.js must keep exporting ${required}()`);
  }
});
