/**
 * VAPID configuration — the ONLY place that touches VAPID secrets.
 *
 *  VAPID_PUBLIC_KEY     base64url P-256 public key  (sent to clients — safe)
 *  VAPID_PRIVATE_KEY    base64url PKCS#8 private key (SERVER ONLY, never logged)
 *  VAPID_SUBJECT        "mailto:you@example.com" or "https://yoursite.example"
 *  PUSH_VAPID_FILE      optional path to persist auto-generated keys
 *                       (default: <project>/.vapid-keys.json, git-ignored)
 *
 * If the env vars are absent, a keypair is generated ONCE and persisted to
 * PUSH_VAPID_FILE so restarts reuse it. That keeps local development simple
 * (§17) without ever committing secrets — the file is in .gitignore.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateVapidKeys } from './push/webpush.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_KEY_FILE = join(ROOT, '.vapid-keys.json');

let cached = null;

/**
 * Resolve VAPID credentials. Order: env vars → persisted key file →
 * generate + persist. Returns { publicKey, privateKey, subject, source }.
 */
export async function getVapidConfig() {
  if (cached) return cached;

  const envPub = process.env.VAPID_PUBLIC_KEY?.trim();
  const envPriv = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:life-progress@example.com';
  const keyFile = process.env.PUSH_VAPID_FILE?.trim() || DEFAULT_KEY_FILE;

  let publicKey;
  let privateKey;
  let source;

  if (envPub && envPriv) {
    publicKey = envPub;
    privateKey = envPriv;
    source = 'env';
  } else {
    try {
      const stored = JSON.parse(await readFile(keyFile, 'utf8'));
      if (stored?.publicKey && stored?.privateKey) {
        publicKey = stored.publicKey;
        privateKey = stored.privateKey;
        source = 'file';
      }
    } catch {
      /* no file yet */
    }
    if (!publicKey) {
      const generated = await generateVapidKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      source = 'generated';
      await writeFile(keyFile, JSON.stringify({ publicKey, privateKey, createdAt: new Date().toISOString() }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
  }

  cached = { publicKey, privateKey, subject, source };
  return cached;
}

/** Invalidate the cached config (used by tests). */
export function resetVapidCache() {
  cached = null;
}

/** Non-secret summary safe to log or expose. */
export function vapidPublicInfo(config) {
  return { publicKey: config.publicKey, subject: config.subject, source: config.source };
}
