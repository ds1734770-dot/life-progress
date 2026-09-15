/**
 * V1.6.3 — deployment-readiness tests.
 *
 * Pins the contract a production Node host needs: PORT env support, a safe
 * /health probe, JSON-only API responses, VAPID env precedence with a stable
 * identity, and the split-deployment CORS configuration. The /health and
 * PORT tests spawn the REAL server binary — no mocks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Isolated state/key files: spawned test servers must never read or write
 * the developer's real .push-data.json / .vapid-keys.json.
 */
const ISOLATION_ENV = {
  PUSH_DATA_FILE: join(tmpdir(), `lp-test-push-${process.pid}.json`),
  PUSH_VAPID_FILE: join(tmpdir(), `lp-test-vapid-${process.pid}.json`),
};

/** Poll a base URL until /health answers or the deadline passes. */
async function waitHealthy(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never became healthy at ${base}: ${lastErr?.message || lastErr}`);
}

async function withServerOnPort(port, env, fn) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...ISOLATION_ENV, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    const health = await waitHealthy(`http://localhost:${port}`);
    await fn(health);
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------
// /health — safe operational probe
// ---------------------------------------------------------------------------

test('/health returns ok:true with no secrets or subscription data', async () => {
  await withServerOnPort(18321, {}, async (health) => {
    assert.equal(health.ok, true);
    const raw = JSON.stringify(health);
    assert.doesNotMatch(raw, /privateKey|PRIVATE|durable|endpoint|p256dh|auth/i);
  });
});

test('/health responds 200 with JSON content type', async () => {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...ISOLATION_ENV, PORT: '18322' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitHealthy('http://localhost:18322');
    const res = await fetch('http://localhost:18322/health');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------
// PORT — process.env.PORT must win (host platforms assign it dynamically)
// ---------------------------------------------------------------------------

test('server honors process.env.PORT', async () => {
  await withServerOnPort(18323, {}, async () => {
    const res = await fetch('http://localhost:18323/health');
    assert.equal(res.status, 200);
  });
});

test('server.js derives PORT from env with a development fallback', () => {
  const src = read('server.js');
  assert.match(src, /Number\(process\.env\.PORT\)\s*\|\|\s*\d+/);
});

// ---------------------------------------------------------------------------
// VAPID production configuration — env precedence + stable identity
// ---------------------------------------------------------------------------

test('vapid env vars take precedence over generated keys and stay stable', async () => {
  process.env.VAPID_PUBLIC_KEY = 'BTestPublicKey_env_precedence_check_value_0000';
  process.env.VAPID_PRIVATE_KEY = 'TestPrivateKey_env_precedence_check_value_0000';
  process.env.PUSH_VAPID_FILE = join(ROOT, '.vapid-test-ephemeral.json');
  try {
    const { getVapidConfig, resetVapidCache } = await import('../server/vapid.js');
    resetVapidCache();
    const first = await getVapidConfig();
    assert.equal(first.source, 'env');
    assert.equal(first.publicKey, process.env.VAPID_PUBLIC_KEY);
    resetVapidCache();
    const second = await getVapidConfig();
    assert.equal(second.publicKey, first.publicKey, 'identity must be stable across re-resolve');
    assert.equal(second.source, 'env');
  } finally {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.PUSH_VAPID_FILE;
    const { resetVapidCache } = await import('../server/vapid.js');
    resetVapidCache();
  }
});

test('vapid-public endpoint returns ONLY the public key (never private material)', async () => {
  await withServerOnPort(18324, {}, async () => {
    const res = await fetch('http://localhost:18324/api/push/vapid-public');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.ok(body.publicKey && typeof body.publicKey === 'string');
    assert.equal(JSON.stringify(body).includes('privateKey'), false);
    assert.deepEqual(Object.keys(body).sort(), ['publicKey', 'source', 'subject']);
  });
});

// ---------------------------------------------------------------------------
// Split-deployment CORS — GitHub Pages origin must work, others can be blocked
// ---------------------------------------------------------------------------

test('CORS: GET vapid-public reflects origin and answers preflight for POST', async () => {
  await withServerOnPort(18325, { PUSH_ALLOWED_ORIGINS: 'https://ds1734770-dot.github.io' }, async () => {
    const res = await fetch('http://localhost:18325/api/push/vapid-public', {
      headers: { Origin: 'https://ds1734770-dot.github.io' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://ds1734770-dot.github.io');

    const pre = await fetch('http://localhost:18325/api/push/register', {
      method: 'OPTIONS',
      headers: { Origin: 'https://ds1734770-dot.github.io', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://ds1734770-dot.github.io');
    assert.match(pre.headers.get('access-control-allow-methods') || '', /POST/);
  });
});

// ---------------------------------------------------------------------------
// Persistence requirement — documented, not hidden
// ---------------------------------------------------------------------------

test('README documents ephemeral-filesystem persistence requirement', () => {
  const readme = read('README.md');
  assert.match(readme, /ephemeral/i);
  assert.match(readme, /PUSH_DATA_FILE/);
  assert.match(readme, /persistent/i);
});

test('server startup logs the state file path (visibility for deployers)', () => {
  const src = read('server.js');
  assert.match(src, /dataFilePath\(\)/);
});
