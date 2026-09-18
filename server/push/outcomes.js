/**
 * Typed provider outcomes (V2.0 Phase 2) — extracted into a LEAF module in
 * Phase 3 so the APNs provider and the dispatcher can share one definition
 * without an import cycle. Values and semantics are UNCHANGED from Phase 2:
 *   delivered | gone | transient_failure | permanent_failure | not_configured
 */

export const OUTCOME = Object.freeze({
  DELIVERED: 'delivered',
  GONE: 'gone', // subscription/token invalid forever (Web Push 404/410, APNs BadDeviceToken, FCM UNREGISTERED)
  TRANSIENT: 'transient_failure', // retry later (network, 429, 5xx)
  PERMANENT: 'permanent_failure', // keep the record, stop retrying until something changes
  NOT_CONFIGURED: 'not_configured', // provider known but credentials/implementation absent
});

/** Uniform result shape every provider returns. */
export function makeResult(outcome, extra = {}) {
  return { outcome, ...extra };
}

export const PLATFORMS = Object.freeze(['web', 'ios', 'android']);
