/**
 * Notification wallpaper registry + selection (master spec §3/§4/§16/§18/§25).
 *
 * Pure module (no I/O) so tests drive every branch in Node:
 *  · the 12 curated built-in wallpapers (identity + labels; assets bundled
 *    under assets/notification-backgrounds/, see §25)
 *  · normalizeNotificationAppearance() — the persisted-shape guard
 *  · pickNotificationWallpaper() — mode-aware selection with a
 *    no-immediate-repeat history for random mode (§18)
 *
 * PRIVACY (§21): the custom user photo NEVER travels anywhere — it is stored
 * locally (IndexedDB) by js/notifications.js and resolved locally. Nothing in
 * this module can serialize the photo; only ids/preferences pass through.
 */

export const WALLPAPER_MODES = ['random', 'builtin', 'custom'];

/** The default appearance: random background, nothing pinned. */
export function defaultNotificationAppearance() {
  return {
    mode: 'random',
    builtinId: null,
    customPhotoId: null,
    crop: null, // { x, y, scale } — normalized 0..1 offsets + zoom ≥ 1
    recent: [], // recently-used built-in ids (random mode, §18)
  };
}

/**
 * The curated built-in library (§4/§25). Portrait-friendly, cinematic, no
 * embedded text/watermarks/brands. `src` paths are bundled with the app and
 * with native builds (cap sync copies www/); `tone` hints the overlay
 * strength the renderer should apply for readable text (§8/§23).
 */
export const BUILTIN_WALLPAPERS = [
  { id: 'sunset_peak',     name: 'Sunset Mountain', src: 'assets/notification-backgrounds/sunset_peak.png',     overlay: 0.42 },
  { id: 'forest_trail',    name: 'Forest Trail',    src: 'assets/notification-backgrounds/forest_trail.png',    overlay: 0.5 },
  { id: 'calm_lake',       name: 'Calm Lake',       src: 'assets/notification-backgrounds/calm_lake.png',       overlay: 0.45 },
  { id: 'mountain_mist',   name: 'Mountain Peaks',  src: 'assets/notification-backgrounds/mountain_mist.png',   overlay: 0.4 },
  { id: 'night_sky',       name: 'Night Sky',       src: 'assets/notification-backgrounds/night_sky.png',       overlay: 0.3 },
  { id: 'ocean_dusk',      name: 'Ocean Dusk',      src: 'assets/notification-backgrounds/ocean_dusk.png',      overlay: 0.42 },
  { id: 'city_night',      name: 'City Night',      src: 'assets/notification-backgrounds/city_night.png',      overlay: 0.45 },
  { id: 'warm_minimal',    name: 'Minimal Warm',    src: 'assets/notification-backgrounds/warm_minimal.png',    overlay: 0.5 },
  { id: 'cozy_room',       name: 'Cozy Room',       src: 'assets/notification-backgrounds/cozy_room.png',       overlay: 0.5 },
  { id: 'sunrise_valley',  name: 'Sunrise Valley',  src: 'assets/notification-backgrounds/sunrise_valley.png',  overlay: 0.45 },
  { id: 'autumn_forest',   name: 'Autumn Forest',   src: 'assets/notification-backgrounds/autumn_forest.png',   overlay: 0.45 },
  { id: 'training_room',   name: 'Training Room',   src: 'assets/notification-backgrounds/training_room.png',   overlay: 0.5 },
];

/** Look up one built-in wallpaper by id. Null when unknown. */
export function builtinWallpaper(id) {
  return BUILTIN_WALLPAPERS.find((w) => w.id === id) || null;
}

/**
 * Guard the persisted appearance. Accepts partial/legacy/invalid records and
 * always returns a complete, valid shape (same philosophy as
 * normalizePrefs in js/notifications.js).
 */
export function normalizeNotificationAppearance(stored) {
  const d = defaultNotificationAppearance();
  const s = stored && typeof stored === 'object' ? stored : {};
  const out = { ...d, ...s };

  if (!WALLPAPER_MODES.includes(out.mode)) out.mode = d.mode;
  // Non-builtin modes must not keep a dangling builtin selection — but keep
  // the id itself so toggling back restores the previous choice.
  if (out.mode !== 'builtin' && !builtinWallpaper(out.builtinId)) out.builtinId = builtinWallpaper(out.builtinId) ? out.builtinId : null;
  if (out.mode !== 'custom' && !out.customPhotoId) out.customPhotoId = null;

  const c = out.crop;
  out.crop = c && typeof c === 'object' && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.scale)
    ? { x: Math.min(1, Math.max(0, c.x)), y: Math.min(1, Math.max(0, c.y)), scale: Math.max(1, Math.min(5, c.scale)) }
    : null;

  // Recent history: only valid builtin ids, deduplicated, newest first,
  // bounded (§18) — a duplicated id would shrink the random pool.
  out.recent = Array.isArray(out.recent)
    ? [...new Set(out.recent.filter((id) => builtinWallpaper(id)))].slice(0, 4)
    : [];

  return out;
}

/**
 * Mode-aware wallpaper selection (§3/§18).
 *
 *  · random  → deterministic per occurrence (occurrenceId/dateKey seed) with
 *              a small recent-history that avoids immediate repeats
 *  · builtin → the pinned wallpaper (falls back to random when invalid)
 *  · custom  → signals the custom photo; callers resolve the local blob via
 *              js/notifications.js#getCustomWallpaperPhoto()
 *
 * Pure: `appearance.recent` is the caller's state; the returned
 * `recent` array must be persisted by the caller afterwards.
 */
export function pickNotificationWallpaper(appearance, { occurrenceId = '', dayKey = '', rand = Math.random } = {}) {
  const a = normalizeNotificationAppearance(appearance);
  if (a.mode === 'builtin') {
    const pinned = builtinWallpaper(a.builtinId);
    if (pinned) return { wallpaper: pinned, recent: a.recent };
    // Invalid/missing pin → degrade to random, never fail the notification.
  }
  if (a.mode === 'custom') {
    return { wallpaper: { id: 'custom', name: 'My Photo', custom: true, overlay: 0.45 }, recent: a.recent };
  }
  // ---- random ----
  const pool = BUILTIN_WALLPAPERS.filter((w) => !a.recent.includes(w.id));
  const candidates = pool.length ? pool : BUILTIN_WALLPAPERS; // history can't starve the pool
  // Deterministic when a seed exists (same occurrence ⇒ same wallpaper), so a
  // re-render of the same notification doesn't flip images; falls back to
  // rand() for previews/tests.
  let index;
  const seed = `${occurrenceId}|${dayKey}`;
  if (seed !== '|') {
    let h = 5381;
    for (let i = 0; i < seed.length; i++) h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
    index = h % candidates.length;
  } else {
    index = Math.floor(rand() * candidates.length) % candidates.length;
  }
  const wallpaper = candidates[index];
  const recent = [wallpaper.id, ...a.recent.filter((id) => id !== wallpaper.id)].slice(0, 4);
  return { wallpaper, recent };
}
