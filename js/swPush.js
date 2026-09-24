/**
 * Service-worker push handling — the logic behind the `push` event, written
 * as a pure-ish module so Node tests can drive every branch (§28).
 *
 * The browser pushes arrive with a MINIMAL payload (§14): category + dedup
 * identity + route hint. NO personal data ever travels through the push
 * service — the service worker derives the actual copy locally from the same
 * eligibility engine the in-app sweep uses (privacy + identical wording).
 *
 * Gates, in order (mirrors the in-app engine exactly):
 *   master → category → quiet hours (device tz, at delivery) → dedup →
 *   context eligibility (water target met ⇒ silent, …).
 *
 * "Not useful now" is a SILENT outcome (no OS notification, no dedup marker)
 * — identical to the in-app sweep, which may still deliver later that day if
 * the context changes. Only an infrastructure error falls back to the static
 * category copy, so a broken context read can never swallow a reminder.
 */
import { dateKey } from './utils.js';
// V2.1 — the shared presentation model: category copy, accents, actions and
// deep links come from ONE source (js/notifyContent.js) so the web fallback,
// the settings preview, the iOS content extension copy table and Android all
// agree. The eligibility engine (ELIGIBILITY, via deps) stays the authority
// for personalized copy; this model is the presentation/fallback layer.
import { presentationFor, toStaticCopy, presentationCategory } from './notifyContent.js';

// ---------------------------------------------------------------------------
// Payload validation (§14/§24) — never trust the wire
// ---------------------------------------------------------------------------

export const PUSH_CATEGORIES = ['water', 'gym', 'goals', 'journal', 'streaks', 'achievements', 'test'];

const ROUTES = {
  water: '#/water',
  gym: '#/gym',
  goals: '#/goals',
  journal: '#/journal',
  streaks: '#/dashboard',
  achievements: '#/achievements',
  test: '#/dashboard',
};

/** Deep-link allowlist — a payload can never navigate anywhere else. */
export function routeFor(category, route) {
  if (typeof route === 'string' && /^#\/[a-z]+$/.test(route) && Object.values(ROUTES).includes(route)) {
    return route;
  }
  return ROUTES[category] || '#/dashboard';
}

/**
 * Validate + normalize a raw push payload. Returns
 * { ok: true, value: { type, category, key, period, route, occurrenceId } }
 * or { ok: false }.
 */
export function validatePushPayload(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false };
  const type = raw.type === 'test' ? 'test' : raw.type === 'reminder' ? 'reminder' : null;
  if (!type) return { ok: false };
  if (typeof raw.occurrenceId !== 'string' || raw.occurrenceId.length === 0 || raw.occurrenceId.length > 128) {
    return { ok: false };
  }
  if (typeof raw.serverTime === 'number' && !Number.isFinite(raw.serverTime)) return { ok: false };

  if (type === 'test') {
    return { ok: true, value: { type, category: 'test', key: 'test', period: raw.occurrenceId, route: routeFor('test', raw.route), occurrenceId: raw.occurrenceId } };
  }

  const category = PUSH_CATEGORIES.includes(raw.category) ? raw.category : null;
  if (!category) return { ok: false };
  // Dedup identity: the server pins the occurrence's date IN THE USER'S
  // TIMEZONE so push delivery and in-app sweeps share one dedup space.
  const period = typeof raw.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dateKey)
    ? raw.dateKey
    : dateKey();
  return {
    ok: true,
    value: {
      type,
      category,
      key: `${category}:daily`,
      period,
      route: routeFor(category, raw.route),
      occurrenceId: raw.occurrenceId,
    },
  };
}

/**
 * Static fallback copy (infrastructure-error path only).
 *
 * V2.1 — the table itself is UNCHANGED (it is the §24 fallback level 3/4 and
 * server transports import genericForCategory verbatim), but presentationFor
 * → toStaticCopy provides the category-aware equivalent used when the
 * context read succeeded on the client: same wording family, same tone.
 */
const GENERIC_COPY = {
  water: { title: 'Time for some water 💧', body: 'A quick sip keeps your day on track.' },
  gym: { title: 'Ready for a workout?', body: 'A short session keeps the rhythm going.' },
  goals: { title: 'Your goals are waiting', body: 'A few minutes now moves them forward.' },
  journal: { title: 'Take a minute for yourself', body: 'A short entry keeps your reflection going.' },
  streaks: { title: 'Your streak is alive 🔥', body: 'One quick action today keeps it going.' },
  achievements: { title: 'Life Progress', body: 'You have new progress to celebrate.' },
};

export function genericForCategory(category) {
  return { ...(GENERIC_COPY[category] || { title: 'Life Progress', body: 'Time for a quick check-in.' }), route: routeFor(category), tag: category };
}

/**
 * V2.1 — category-aware static copy built from the shared presentation model
 * (js/notifyContent.js). Used by the settings test path and any surface that
 * needs the immersive-experience wording in plain { title, body } shape.
 * Pure and dependency-free so every transport can call it.
 */
export function categoryStaticCopy(category, ctx = {}) {
  const p = presentationFor(presentationCategory(category), ctx);
  return toStaticCopy(p) || genericForCategory(category);
}

/**
 * Notification options for the SW display path (mirrors buildPayload).
 * V2.1 — `icon` optionally carries the locally-resolved notification
 * wallpaper (bundled asset path or blob URL); platforms that support a
 * notification image render it, everything else falls back to the app icon.
 */
export function notificationOptions({ title, body, route, tag, icon }) {
  return {
    title,
    body,
    options: {
      tag: tag || 'life-progress',
      icon: icon || './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { route: route || '#/dashboard', app: 'life-progress' },
    },
  };
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/**
 * Process one validated push. `deps` injects the notification domain + a
 * `show` function (the SW passes self.registration.showNotification; tests
 * pass a spy).
 *
 * Returns { shown, reason, personalized } — the full decision audit trail.
 */
export async function processPush(raw, deps) {
  const {
    getNotificationPrefs,
    reminderBlocked,
    wasDelivered,
    markDelivered,
    buildReminderContext,
    ELIGIBILITY,
    show,
    now = new Date(),
    // V2.1 — optional wallpaper resolution (SW passes the real one; server
    // side and unit tests omit it and stay notification-icon-only).
    resolveWallpaper = null,
  } = deps;

  const parsed = validatePushPayload(raw);
  if (!parsed.ok) return { shown: false, reason: 'invalid-payload' };
  const p = parsed.value;

  if (p.type === 'test') {
    await show(notificationOptions({
      title: 'Life Progress',
      body: 'Notifications are working 🔔 Background reminders are active.',
      route: p.route,
      tag: 'test',
    }));
    return { shown: true, reason: 'test' };
  }

  // ---- Gate 1-3: master → category → quiet hours (at delivery, device tz) --
  const prefs = await getNotificationPrefs();
  const blocked = reminderBlocked(prefs, { category: p.category, key: p.key, period: p.period, now });
  if (blocked) return { shown: false, reason: blocked };

  // ---- Gate 4: cross-mechanism dedup (§13) --------------------------------
  if (await wasDelivered(p.key, p.period)) return { shown: false, reason: 'already-delivered' };

  // ---- Gate 5: context-derived usefulness, from LOCAL data (§ privacy) ----
  let copy = null;
  let contextFailed = false;
  try {
    const ctx = await buildReminderContext();
    copy = ELIGIBILITY[p.category] ? ELIGIBILITY[p.category](ctx) : null;
  } catch {
    contextFailed = true;
  }

  // Not useful right now (e.g. water target already met) → stay SILENT and
  // leave the dedup marker unwritten, exactly like the in-app sweep — the
  // reminder may still fire later today if the context changes.
  if (!copy && !contextFailed) return { shown: false, reason: 'not-useful-now' };

  // Context read failure → static copy so a broken read can't swallow the
  // reminder the user asked for. Rare, honest, and never personalized.
  // V2.1 — the personalized path wraps its copy with the presentation model's
  // route/tag (identical values — the eligibility engine and the model share
  // the same allowlisted routes), keeping the display call single-shaped.
  // Wallpaper resolution is failure-safe (§24): any error degrades to the
  // standard app-icon notification, never suppressing the reminder.
  let wallpaperIcon = null;
  if (resolveWallpaper) {
    try {
      const resolved = await resolveWallpaper(p.category, { occurrenceId: p.occurrenceId, dayKey: p.period });
      wallpaperIcon = resolved?.wallpaper?.custom
        ? resolved.url || null // caller resolved the local blob to a URL
        : resolved?.wallpaper?.src || null;
    } catch {
      wallpaperIcon = null; // fallback level 3: standard notification
    }
  }
  const final = copy || genericForCategory(p.category);
  const presented = presentationFor(presentationCategory(p.category), copy ? copy : {});
  const shownRoute = final.route || presented.route || p.route;
  await show(notificationOptions({ title: final.title, body: final.body, route: shownRoute, tag: final.tag || p.category, icon: wallpaperIcon }));

  // Dedup marker written only AFTER a real display (V1.5 invariant).
  await markDelivered(p.key, p.period, { route: final.route || p.route, source: 'push' });
  return { shown: true, reason: 'reminder', category: p.category, personalized: Boolean(copy) };
}
