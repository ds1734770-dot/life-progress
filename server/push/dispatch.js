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

/** Typed provider outcomes (§9). Exported for tests and future callers. */
export const OUTCOME = Object.freeze({
  DELIVERED: 'delivered',
  GONE: 'gone', // subscription/token invalid forever (Web Push 404/410, APNs BadDeviceToken, FCM UNREGISTERED)
  TRANSIENT: 'transient_failure', // retry later (network, 429, 5xx)
  PERMANENT: 'permanent_failure', // keep the record, stop retrying until something changes
  NOT_CONFIGURED: 'not_configured', // provider known but credentials/implementation absent
});

export const PLATFORMS = Object.freeze(['web', 'ios', 'android']);

/**
 * Normalize a stored/incoming platform value. Legacy records (and legacy
 * registration bodies) have no platform — they ARE Web Push devices (§4/§7).
 * Unknown values return null so callers can reject explicitly.
 */
export function normalizePlatform(platform) {
  if (platform === undefined || platform === null || platform === '') return 'web';
  return PLATFORMS.includes(platform) ? platform : null;
}

/** Uniform result shape every provider returns. */
export function makeResult(outcome, extra = {}) {
  return { outcome, ...extra };
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
// Providers: ios / android — declared, NOT implemented (Phase 3/4) (§2)
// ---------------------------------------------------------------------------

/** Native providers share one honest "not configured yet" behavior. */
function unconfiguredNativeProvider(platform, transport, phase) {
  return {
    platform,
    transport,
    configured: false,
    async send() {
      return makeResult(OUTCOME.NOT_CONFIGURED, {
        provider: transport,
        reason: `${transport} delivery is not implemented yet (${phase}) — native device NOT sent via Web Push`,
      });
    },
  };
}

const APNS_PROVIDER = unconfiguredNativeProvider('ios', 'apns', 'Phase 3');
const FCM_PROVIDER = unconfiguredNativeProvider('android', 'fcm', 'Phase 4');

/**
 * Explicit provider resolution — the ONLY place platform→provider is decided.
 * Returns null for platforms outside web/ios/android (caller rejects).
 */
export function resolveProvider(platform, deps = {}) {
  switch (platform) {
    case 'web': return webPushProvider(deps);
    case 'ios': return APNS_PROVIDER;
    case 'android': return FCM_PROVIDER;
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
