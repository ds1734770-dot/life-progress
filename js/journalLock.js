/**
 * Journal PIN lock. A 4–8 digit PIN hides the Journal screens behind a
 * keypad. Only a salted SHA-256 hash is stored. This is a privacy screen for
 * people glancing at your phone; it does NOT encrypt the stored entries.
 */
import { getSettings, saveSettings } from './settings.js';

const SESSION_KEY = 'journal-unlocked';

export const PIN_MIN = 4;
export const PIN_MAX = 8;

export const isValidPin = (pin) => new RegExp(`^\\d{${PIN_MIN},${PIN_MAX}}$`).test(String(pin));

function randomSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin, salt) {
  const data = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const hasPin = () => !!getSettings().journalLock?.hash;

export async function setPin(pin) {
  if (!isValidPin(pin)) throw new Error(`PIN must be ${PIN_MIN}–${PIN_MAX} digits.`);
  const salt = randomSalt();
  await saveSettings({ journalLock: { salt, hash: await hashPin(pin, salt) } });
  markUnlocked();
}

export async function verifyPin(pin) {
  const lock = getSettings().journalLock;
  if (!lock?.hash) return true;
  return (await hashPin(String(pin), lock.salt)) === lock.hash;
}

export async function removePin() {
  await saveSettings({ journalLock: null });
  clearUnlocked();
}

export function isLocked() {
  if (!hasPin()) return false;
  try {
    return sessionStorage.getItem(SESSION_KEY) !== '1';
  } catch {
    return true;
  }
}

export function markUnlocked() {
  try {
    sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    /* session storage unavailable: stays locked per mount */
  }
}

export function clearUnlocked() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Re-lock whenever the app goes to the background. Call once at boot. */
export function installAutoRelock() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearUnlocked();
  });
}
