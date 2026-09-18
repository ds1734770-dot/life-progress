/**
 * Node transport for the APNs provider (V2.0 Phase 3).
 *
 * APNs requires HTTP/2. Cloudflare Workers' global fetch negotiates HTTP/2
 * and is used directly by the provider there; Node's global fetch speaks
 * HTTP/1.1 by default, which api.push.apple.com refuses. This adapter wraps
 * `node:http2` into the exact transport contract the provider expects:
 *
 *   transport({ host, path, headers, body }) → { status, reason? }
 *   throws on network failure (mapped to transient_failure by the provider).
 *
 * NODE-ONLY: imported exclusively by server.js and server/push-worker.js so
 * `node:http2` never reaches the Workers bundle (§5). The DO's alarm →
 * dispatch → APNs path uses the same provider with the runtime's own fetch.
 */
import http2 from 'node:http2';

const TIMEOUT_MS = 10_000;

/** One APNs request over node:http2. Resolves { status, reason }; throws on
 * connect/network errors (the provider classifies those as transient). */
export function apnsNodeTransport({ host, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const authority = `https://${host}`;
    const session = http2.connect(authority);
    session.setDefaultEncoding('utf8');

    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      session.close();
      reject(err);
    };
    const done = (result) => {
      if (settled) return;
      settled = true;
      session.close();
      resolve(result);
    };

    session.on('error', fail);

    session.setTimeout(TIMEOUT_MS, () => fail(new Error('apns transport timeout')));

    const req = session.request({
      ...headers,
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    req.on('error', fail);
    req.setTimeout(TIMEOUT_MS, () => fail(new Error('apns request timeout')));

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('response', (responseHeaders) => {
      const status = responseHeaders[':status'];
      if (typeof status !== 'number') fail(new Error('apns: missing :status'));
    });
    req.on('end', () => {
      const status = req.response?.[':status'] ?? 0;
      let reason = null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.reason === 'string') reason = parsed.reason;
      } catch { /* empty or non-JSON body — status-only mapping */ }
      done({ status, reason });
    });

    req.end(body);
  });
}
