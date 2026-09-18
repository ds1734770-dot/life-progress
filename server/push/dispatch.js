/**
 * Delivery dispatcher — the platform seam of the notification backend (V2.0 Phase 2).
 *
 * ONE platform-neutral entry point between the scheduler and the transports:
 *
 *   scheduler → occurrence → dispatchNotification(device, payload, deps)
 *                                                 ├─ web     → Web Push (RFC 8291/8292, live)
 *                                                 ├─ ios     → APNs   (Phase 3 — not configured)
 *                                                 └─ android → FCM    (Phase 4 — not configured)
 *
 * RUNTIME-NEUTRAL (same convention as server/push/http.js): no node: imports,
 * no Workers-only globals — the module runs unchanged on Node and inside the
 * Durable Object, so provider logic is never duplicated between backends.
 *
 * Phase 2 rules (§2/§9):
 *  · Provider selection is EXPLICIT — a native device is never silently sent
 *    through Web Push; `ios`/`android` resolve to their own providers, which
 *    are registered as not-configured until their phases land.
 *  · Outcomes are TYPED so the scheduler can react uniformly without knowing
 *    provider internals: delivered | gone | transient_failure |
 *    permanent_failure | not_configured.
 *  · The Web Push path wraps the EXISTING server/push/webpush.js unchanged —
 *    encryption, VAPID, fresh salt and ephemeral keys stay byte-compatible.
 */
import { sendPushMessage } from './webpush.js';
import { apnsProvider } from './apns.js';
import { fcmProvider } from './fcm.js';
import { OUTCOME, makeResult, PLATFORMS } from './outcomes.js';

// Phase 2 compatibility: OUTCOME/makeResult/PLATFORMS moved to the leaf
// module server/push/outcomes.js (Phase 3) so providers can share them
// without an import cycle. Re-exports keep every existing import working.
export { OUTCOME, makeResult, PLATFORMS };

/**
 * Normalize a stored/incoming platform value. Legacy records (and legacy
 * registration bodies) have no platform — they ARE Web Push devices (§4/§7).
 * Unknown values return null so callers can reject explicitly.
 */
export function normalizePlatform(platform) {
  if (platform === undefined || platform === null || platform === '') return 'web';
  return PLATFORMS.includes(platform) ? platform : null;
}

// ---------------------------------------------------------------------------
// Provider: web — wraps the existing Web Push implementation UNCHANGED (§3)
// ---------------------------------------------------------------------------

/**
 * deps.sendPushMessage defaults to the real RFC 8291/8292 sender; tests
 * inject a mock. deps.vapid is the VAPID config the sender requires.
 */
export function webPushProvider(deps = {}) {
  const send = deps.sendPushMessage || sendPushMessage;
  return {
    platform: 'web',
    transport: 'web-push',
    async send(device, payload) {
      if (!deps.vapid) {
        return makeResult(OUTCOME.NOT_CONFIGURED, {
          provider: 'web-push',
          reason: 'VAPID not configured',
        });
      }
      const result = await send(
        { endpoint: device.endpoint, keys: device.keys },
        payload,
        deps.vapid
      );
      if (result.ok) return makeResult(OUTCOME.DELIVERED, { status: result.status });
      const gone = result.status === 404 || result.status === 410;
      const transient = result.transient === true;
      return makeResult(
        gone ? OUTCOME.GONE : transient ? OUTCOME.TRANSIENT : OUTCOME.PERMANENT,
        { status: result.status, error: result.error || `status ${result.status}`, retryAfter: result.retryAfter ?? null }
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Provider: ios — APNs (V2.0 Phase 3)
// ---------------------------------------------------------------------------

/**
 * deps.apns overrides the APNs provider wholesale (tests inject mocks).
 * deps.apnsConfig / deps.apnsTransport / deps.now flow into apnsProvider()
 * (transport injection: Workers → global fetch, Node → node:http2 adapter).
 * Without overrides the REAL provider is used and reads its credentials
 * from the runtime environment — never from code (§3/§17).
 */
function apnsProviderFor(deps = {}) {
  if (deps.apns) return deps.apns;
  return apnsProvider({
    configSource: deps.env,
    transport: deps.apnsTransport,
    now: deps.now,
  });
}

// ---------------------------------------------------------------------------
// Providers: android — declared, NOT implemented (Phase 4) (§2/§18)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Providers: android — FCM (V2.0 Phase 5)
// ---------------------------------------------------------------------------

/**
 * deps.fcm overrides the FCM provider wholesale (tests inject mocks).
 * deps.fcmConfig / deps.fcmTransport / deps.now flow into fcmProvider().
 * Unlike APNs, no separate Node transport adapter is needed: Google's
 * endpoint accepts HTTP/1.1, so BOTH runtimes use global fetch. Without
 * overrides the REAL provider is used and reads its credentials from the
 * runtime environment — never from code (§5.2/§17).
 */
function fcmProviderFor(deps = {}) {
  if (deps.fcm) return deps.fcm;
  return fcmProvider({
    configSource: deps.env,
    transport: deps.fcmTransport,
    now: deps.now,
  });
}

/**
 * Explicit provider resolution — the ONLY place platform→provider is decided.
 * Returns null for platforms outside web/ios/android (caller rejects).
 */
export function resolveProvider(platform, deps = {}) {
  switch (platform) {
    case 'web': return webPushProvider(deps);
    case 'ios': return apnsProviderFor(deps);
    case 'android': return fcmProviderFor(deps);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// The one entry point the scheduler calls
// ---------------------------------------------------------------------------

/**
 * Dispatch one notification payload to one device via its platform provider.
 *
 * @param {{ platform?: string, endpoint?: string, keys?: object, token?: string }} device
 *        The stored subscription record (platform optional → legacy web).
 * @param {string} payload  Minimal JSON payload (buildPushPayload output).
 * @param {{ vapid?: object, sendPushMessage?: Function }} deps
 * @returns {Promise<{ outcome: string, provider?: string, reason?: string,
 *                     status?: number|null, error?: string, retryAfter?: number|null }>}
 */
export async function dispatchNotification(device, payload, deps = {}) {
  const platform = normalizePlatform(device?.platform);
  if (platform === null) {
    return makeResult(OUTCOME.PERMANENT, {
      provider: null,
      reason: `unknown platform: ${String(device?.platform)}`,
    });
  }
  const provider = resolveProvider(platform, deps);
  // resolveProvider is total over PLATFORMS, so this is unreachable today;
  // kept as a hard guard so a future platform typo can NEVER fall through
  // to the wrong transport.
  if (!provider) {
    return makeResult(OUTCOME.PERMANENT, { provider: null, reason: `no provider for platform: ${platform}` });
  }
  try {
    return await provider.send(device, payload);
  } catch (err) {
    // A provider throwing must never crash the scheduler tick — treat like
    // a transient failure so the occurrence/record state stays consistent.
    return makeResult(OUTCOME.TRANSIENT, {
      provider: provider.transport,
      error: `provider error: ${err?.message || err}`,
    });
  }
}
