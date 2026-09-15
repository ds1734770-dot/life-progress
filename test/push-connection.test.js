/**
 * V1.6.2 — deployment-connection regression tests.
 *
 * Background: the PWA was deployed on a static host (GitHub Pages) while the
 * notification backend lived only in the repo — every /api/push/* request
 * got the host's HTML 404 page, so subscriptions could never be created.
 * These tests pin the client/server connection behavior that prevents that
 * failure class from ever masquerading as "unsupported browser" again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { classifyServerProbe } = await import('../js/pushClient.js');

// ---------------------------------------------------------------------------
// classifyServerProbe — the three failure families must never be conflated
// ---------------------------------------------------------------------------

test('probe: healthy backend reports reachable', () => {
  const r = classifyServerProbe({ gotHttpResponse: true, ok: true, status: 200, contentType: 'application/json' });
  assert.equal(r.vapid, 'reachable');
  assert.equal(r.staticHostSuspected, false);
});

test('probe: HTTP 404 with HTML body is classified as static hosting', () => {
  const r = classifyServerProbe({ gotHttpResponse: true, ok: false, status: 404, contentType: 'text/html; charset=utf-8' });
  assert.equal(r.vapid, 'http 404');
  assert.equal(r.serverHttpStatus, 404);
  assert.equal(r.staticHostSuspected, true);
  assert.match(r.vapidReason, /static hosting/i);
});

test('probe: HTTP error with JSON body is NOT static hosting', () => {
  const r = classifyServerProbe({ gotHttpResponse: true, ok: false, status: 500, contentType: 'application/json' });
  assert.equal(r.staticHostSuspected, false);
  assert.equal(r.vapidReason, null);
});

test('probe: thrown fetch (refused/CORS/DNS) is unreachable, not static hosting', () => {
  const r = classifyServerProbe({ gotHttpResponse: false, errorMessage: 'Failed to fetch' });
  assert.equal(r.vapid, 'unreachable');
  assert.equal(r.serverHttpStatus, null);
  assert.equal(r.staticHostSuspected, false);
  assert.match(r.serverError, /Failed to fetch/);
});

// ---------------------------------------------------------------------------
// Server: API routes must be reachable on the Node server (mounted before
// static files) — curl-verified E2E, pinned here as structural checks.
// ---------------------------------------------------------------------------

test('server.js mounts push API before static file handling', () => {
  const src = readFileSync(join(ROOT, 'server.js'), 'utf8');
  const apiMount = src.indexOf('handlePushApi(req, res, pathname)');
  const staticRead = src.indexOf('await readFile(filePath)');
  assert.ok(apiMount > -1, 'push API not mounted');
  assert.ok(staticRead > -1, 'static handler not found');
  assert.ok(apiMount < staticRead, 'API must be handled BEFORE static/SPA fallback');
});

test('api.js answers unknown /api/push/* routes with JSON 404 (never HTML)', async () => {
  const { handlePushApi } = await import('../server/api.js');
  const calls = [];
  const res = {
    writeHead(code, headers) { calls.push({ code, headers }); return this; },
    end(body) { calls.push({ body }); },
    setHeader(k, v) { calls.push({ header: [k, v] }); },
  };
  const handled = await handlePushApi({ method: 'GET', socket: { remoteAddress: 't' }, headers: {} }, res, '/api/push/nope');
  assert.equal(handled, true);
  const code = calls.find((c) => typeof c.code === 'number')?.code;
  assert.equal(code, 404);
  const body = JSON.parse(calls.find((c) => typeof c.body === 'string')?.body || '{}');
  assert.equal(body.error, 'not found');
});

test('api.js answers non-API paths with false (lets static server run)', async () => {
  const { handlePushApi } = await import('../server/api.js');
  const handled = await handlePushApi({ method: 'GET', socket: { remoteAddress: 't' }, headers: {} }, {}, '/index.html');
  assert.equal(handled, false);
});

// ---------------------------------------------------------------------------
// CORS (split deployments): static app origin ≠ backend origin
// ---------------------------------------------------------------------------

test('CORS: preflight OPTIONS is answered 204 with allowed methods', async () => {
  const { handlePushApi } = await import('../server/api.js');
  const calls = [];
  const res = {
    writeHead(code) { calls.push(code); return this; },
    end() {},
    setHeader() {},
  };
  const handled = await handlePushApi({ method: 'OPTIONS', socket: { remoteAddress: 't' }, headers: {} }, res, '/api/push/register');
  assert.equal(handled, true);
  assert.equal(calls.find((c) => typeof c === 'number'), 204);
});

test('CORS: origin reflected when no allowlist is configured', async () => {
  const { handlePushApi } = await import('../server/api.js');
  const headers = new Map();
  const res = {
    writeHead() { return this; },
    end() {},
    setHeader: (k, v) => headers.set(k, v),
  };
  await handlePushApi(
    { method: 'OPTIONS', socket: { remoteAddress: 't' }, headers: { origin: 'https://user.github.io' } },
    res, '/api/push/register'
  );
  assert.equal(headers.get('Access-Control-Allow-Origin'), 'https://user.github.io');
});

test('CORS: disallowed origin gets NO Access-Control headers (blocked)', async () => {
  const { handlePushApi } = await import('../server/api.js');
  process.env.PUSH_ALLOWED_ORIGINS = 'https://user.github.io';
  const headers = new Map();
  const res = {
    writeHead() { return this; },
    end() {},
    setHeader: (k, v) => headers.set(k, v),
  };
  await handlePushApi(
    { method: 'OPTIONS', socket: { remoteAddress: 't' }, headers: { origin: 'https://evil.example.com' } },
    res, '/api/push/register'
  );
  delete process.env.PUSH_ALLOWED_ORIGINS;
  assert.equal(headers.has('Access-Control-Allow-Origin'), false);
});

// ---------------------------------------------------------------------------
// push-config.js: the injection point for split deployments
// ---------------------------------------------------------------------------

test('push-config.js defines the API origin override and contains no secret-looking values', () => {
  const src = readFileSync(join(ROOT, 'push-config.js'), 'utf8');
  assert.match(src, /window\.LIFE_PROGRESS_PUSH_API\s*=/);
  const values = [...src.matchAll(/=\s*"([^"]+)"/g)].map((m) => m[1]).filter((v) => v.length > 0);
  for (const v of values) {
    assert.doesNotMatch(v, /private|secret|key=/i, 'no credential material in push-config');
    assert.ok(v.length < 200, 'no long opaque values in push-config');
  }
});

test('index.html loads push-config.js BEFORE app.js', () => {
  const src = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const cfg = src.indexOf('push-config.js');
  const app = src.indexOf('js/app.js');
  assert.ok(cfg > -1 && app > -1);
  assert.ok(cfg < app, 'push-config must run before app.js');
});

test('README documents the split deployment requirement for static hosts', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /GitHub Pages/);
  assert.match(readme, /LIFE_PROGRESS_PUSH_API/);
  assert.match(readme, /PUSH_ALLOWED_ORIGINS/);
});
