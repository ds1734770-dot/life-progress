/**
 * V1.1 personalization — motivational launch quote + avatar system.
 *
 * Pure helpers live here (no storage, no DOM rendering beyond tiny markup
 * builders) so they can be unit-tested in Node. Persistence goes through the
 * existing settings record; images through the existing photos utilities.
 */
import { escapeHtml } from './ui.js';

// ---------------------------------------------------------------------------
// Motivational launch quote
// ---------------------------------------------------------------------------

export const DEFAULT_LAUNCH_QUOTE = "Don't forget why u started.";
export const LAUNCH_QUOTE_MAX = 120; // sensible ceiling for a phone screen

/**
 * Normalize a user-supplied quote: trim, collapse whitespace/newlines,
 * hard-cap length. Empty input falls back to the default so the launch
 * screen can never render blank.
 */
export function sanitizeLaunchQuote(raw) {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return DEFAULT_LAUNCH_QUOTE;
  return text.length <= LAUNCH_QUOTE_MAX ? text : text.slice(0, LAUNCH_QUOTE_MAX).trim();
}

/** The quote to show at launch — sanitized, defaulting when unset. */
export function launchQuote(settings) {
  const stored = settings && settings.launchQuote;
  if (typeof stored !== 'string' || !stored.trim()) return DEFAULT_LAUNCH_QUOTE;
  return sanitizeLaunchQuote(stored);
}

// ---------------------------------------------------------------------------
// Initials
// ---------------------------------------------------------------------------

/**
 * Initials from a name: first letter of the first two words, uppercased.
 * Non-Latin scripts and single names work too; empty → ''.
 */
export function initialsFor(name) {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  return words
    .slice(0, 2)
    .map((w) => Array.from(w)[0])
    .join('')
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Built-in avatars — locally bundled inline SVG (no external API, offline).
// Varied appearances: skin tones, hairstyles, facial hair, glasses, clothing.
// ---------------------------------------------------------------------------

const TONES = {
  deep: '#5b3a29',
  brown: '#8a5a3b',
  tan: '#c68642',
  light: '#e8b98d',
  fair: '#f2c9a5',
};
const BG = ['#0f766e', '#155e75', '#4c1d95', '#9d174d', '#92400e', '#166534', '#1e3a8a', '#7c2d12'];

function head(cx, skin, hairPath, hairColor) {
  return `
    <circle cx="${cx}" cy="34" r="16" fill="${skin}"/>
    <path d="${hairPath}" fill="${hairColor}"/>`;
}

/** Each builder draws within a 96x96 viewBox: head + shoulders portrait. */
const BUILT_INS = [
  {
    id: 'sunrise',
    bg: BG[0],
    label: 'Sunrise',
    draw: () =>
      head(48, TONES.tan, 'M32 30 a16 16 0 0 1 32 0 l0 -6 a16 16 0 0 0 -32 0 z', '#2c1b10') +
      '<path d="M22 92 a26 26 0 0 1 52 0 z" fill="#0ea5e9"/>',
  },
  {
    id: 'dusk',
    bg: BG[1],
    label: 'Dusk',
    draw: () =>
      head(48, TONES.deep, 'M32 32 a16 16 0 0 1 32 0 q-4 -10 -16 -10 t-16 10 z', '#111111') +
      '<path d="M22 92 a26 26 0 0 1 52 0 z" fill="#f59e0b"/>',
  },
  {
    id: 'violet',
    bg: BG[2],
    label: 'Violet',
    draw: () =>
      head(48, TONES.light, 'M30 36 a18 18 0 0 1 36 0 l0 12 q-6 -14 -18 -14 t-18 14 z', '#7c2d12') +
      '<path d="M20 92 a28 28 0 0 1 56 0 z" fill="#a78bfa"/>',
  },
  {
    id: 'rose',
    bg: BG[3],
    label: 'Rose',
    draw: () =>
      head(48, TONES.fair, 'M30 34 a18 18 0 0 1 36 0 l0 16 a6 6 0 0 1 -6 -6 l0 -6 q-6 -8 -12 -8 t-12 8 l0 6 a6 6 0 0 1 -6 6 z', '#3f2412') +
      '<path d="M20 92 a28 28 0 0 1 56 0 z" fill="#fb7185"/>',
  },
  {
    id: 'ember',
    bg: BG[4],
    label: 'Ember',
    draw: () =>
      head(48, TONES.brown, 'M34 26 a14 14 0 0 1 28 0 l0 4 a20 20 0 0 0 -28 0 z', '#1c1917') +
      '<path d="M40 44 q8 6 16 0 l0 4 q-8 5 -16 0 z" fill="#1c1917" opacity="0.85"/>' +
      '<path d="M22 92 a26 26 0 0 1 52 0 z" fill="#fbbf24"/>',
  },
  {
    id: 'forest',
    bg: BG[5],
    label: 'Forest',
    draw: () =>
      head(48, TONES.tan, 'M32 30 a16 16 0 0 1 32 0 l0 -4 a16 16 0 0 0 -32 0 z', '#4a2c17') +
      '<circle cx="40" cy="34" r="5" fill="none" stroke="#1f2937" stroke-width="1.6"/>' +
      '<circle cx="56" cy="34" r="5" fill="none" stroke="#1f2937" stroke-width="1.6"/>' +
      '<path d="M45 34 h6" stroke="#1f2937" stroke-width="1.6"/>' +
      '<path d="M20 92 a28 28 0 0 1 56 0 z" fill="#34d399"/>',
  },
  {
    id: 'ocean',
    bg: BG[6],
    label: 'Ocean',
    draw: () =>
      head(48, TONES.deep, 'M32 32 a16 16 0 0 1 32 0 l0 -8 a16 16 0 0 0 -32 0 z', '#0b0b0b') +
      '<path d="M40 45 q8 -4 16 0" fill="none" stroke="#0b0b0b" stroke-width="2"/>' +
      '<path d="M22 92 a26 26 0 0 1 52 0 z" fill="#93c5fd"/>',
  },
  {
    id: 'clay',
    bg: BG[7],
    label: 'Clay',
    draw: () =>
      head(48, TONES.fair, 'M31 33 a17 17 0 0 1 34 0 l0 -9 a17 17 0 0 0 -34 0 z', '#b45309') +
      '<path d="M20 92 a28 28 0 0 1 56 0 z" fill="#f87171"/>',
  },
];

export function builtinAvatarList() {
  return BUILT_INS.map(({ id, label }) => ({ id, label }));
}

export function isBuiltinAvatar(id) {
  return BUILT_INS.some((a) => a.id === id);
}

function builtinSvg(id) {
  const a = BUILT_INS.find((x) => x.id === id) || BUILT_INS[0];
  return `<svg viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="96" height="96" rx="48" fill="${a.bg}"/>${a.draw()}</svg>`;
}

// ---------------------------------------------------------------------------
// Avatar selection model — mirrors the settings record shape.
//   { type: 'builtin', value: '<builtin id>' }
//   { type: 'initials', value: '' }
//   { type: 'custom', value: '' } (image bytes live in settings.avatarImage)
// ---------------------------------------------------------------------------

export function defaultAvatar() {
  return { type: 'builtin', value: 'sunrise' };
}

/** Coerce any stored/imported value into a valid avatar selection. */
export function normalizeAvatar(raw) {
  if (!raw || typeof raw !== 'object') return defaultAvatar();
  const { type, value } = raw;
  if (type === 'builtin' && isBuiltinAvatar(value)) return { type, value };
  if (type === 'initials') return { type, value: '' };
  if (type === 'custom') return { type, value: '' };
  return defaultAvatar();
}

// ---------------------------------------------------------------------------
// Rendering — one markup builder used by Dashboard, Settings and the picker.
// Blob object URLs are cached per image and revoked centrally.
// ---------------------------------------------------------------------------

const urlCache = new Map();

function customAvatarUrl(settings) {
  const blob = settings && settings.avatarImage;
  if (!(blob instanceof Blob)) return null;
  if (!urlCache.has('custom')) urlCache.set('custom', URL.createObjectURL(blob));
  return urlCache.get('custom');
}

/** Revoke cached avatar object URLs (called on screen unmount / wipe). */
export function revokeAvatarUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/** Tiny initials tile with the standard gradient used across V1. */
export function initialsAvatarMarkup(text, size = 42) {
  return `<span class="avatar avatar-svg" style="width:${size}px;height:${size}px;font-size:${Math.round(size / 2.4)}px">${escapeHtml(text)}</span>`;
}

export function builtinAvatarMarkup(id, size = 42) {
  return `<span class="avatar avatar-svg avatar-photo" style="width:${size}px;height:${size}px">${builtinSvg(id)}</span>`;
}

/**
 * Markup for the user's currently selected avatar at any size.
 * Falls back gracefully: custom without image → initials → builtin default.
 */
export function avatarMarkup(settings, size = 42) {
  const avatar = normalizeAvatar(settings && settings.avatar);
  if (avatar.type === 'custom') {
    const url = customAvatarUrl(settings);
    if (url) {
      return `<span class="avatar avatar-photo" style="width:${size}px;height:${size}px"><img src="${url}" alt=""></span>`;
    }
    const text = initialsFor(settings && settings.name);
    if (text) return initialsAvatarMarkup(text, size);
  }
  if (avatar.type === 'initials') {
    const text = initialsFor(settings && settings.name) || 'LP';
    return initialsAvatarMarkup(text, size);
  }
  return builtinAvatarMarkup(avatar.value, size);
}

/**
 * Full-screen launch uses the same identity logic at hero size.
 * (Kept separate from avatarMarkup only for the img/alt nuance.)
 */
export function heroAvatarMarkup(settings) {
  return avatarMarkup(settings, 84);
}

// ---------------------------------------------------------------------------
// Custom avatar image pipeline (gallery pick → downscaled local blob)
// ---------------------------------------------------------------------------

/**
 * Downscale a picked image to an avatar-sized JPEG blob (256px, 0.85).
 * Throws on unreadable/corrupt input — callers show a friendly message.
 */
export async function processAvatarImage(file, maxSize, quality, processImage) {
  return processImage(file, maxSize, quality);
}

export const AVATAR_SIZE = 256;
export const AVATAR_QUALITY = 0.85;
