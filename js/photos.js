/**
 * Progress photos — image processing (downscale to keep storage/memory sane),
 * object-URL caching, CRUD.
 *
 * Privacy: images live only in local IndexedDB and are never uploaded anywhere.
 */
import { dbDelete, dbGet, dbGetAll, dbPut } from './db.js';
import { makeProgressPhoto } from './models.js';
import { getSettings, saveSettings } from './settings.js';
import { safe } from './utils.js';
import { parseReferenceProfile } from './pose/reference.js';

export async function addPhoto(file, { date, label = '', notes = '' } = {}) {
  const [blob, thumb] = await Promise.all([
    safe(() => processImage(file, 1600, 0.82)),
    safe(() => processImage(file, 360, 0.72)),
  ]);
  const photo = makeProgressPhoto({ blob, thumb, date, label, notes });
  await dbPut('progressPhotos', photo);
  return photo;
}

export async function getAllPhotos() {
  return sortPhotos(await dbGetAll('progressPhotos'));
}

/** Newest day first; same-day photos newest first. */
export function sortPhotos(list) {
  return list.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));
}

// ---------------------------------------------------------------------------
// Blob ↔ data URL — used by settings export/import so photo blobs survive the
// JSON round-trip (JSON.stringify would otherwise turn blobs into "{}").
// ---------------------------------------------------------------------------

export function blobToDataURL(blob) {
  if (!blob) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function dataURLToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function deletePhoto(id) {
  await dbDelete('progressPhotos', id);
  // A deleted photo can no longer be a reference template (§45): drop its
  // derived profile and clear the active pointer so no orphan metadata and no
  // broken template survives the delete.
  await deleteReferenceProfile(id);
  const settings = getSettings();
  if (settings.photoTemplateId === id) {
    await saveSettings({ photoTemplateId: null });
  }
}

// ---------------------------------------------------------------------------
// Reference profiles — pose/composition metadata for the smart camera.
//
// One record per progress photo, keyed by the photo id, containing no image
// data. The photo remains the authoritative entity, so export/import, delete
// and wipe keep working through the exact same paths.
// ---------------------------------------------------------------------------

export async function saveReferenceProfile(profile) {
  const parsed = parseReferenceProfile(profile);
  if (!parsed) throw new Error('Refusing to store an invalid reference profile.');
  await dbPut('photoReferences', parsed);
  return parsed;
}

export async function getReferenceProfile(photoId) {
  if (!photoId) return null;
  return parseReferenceProfile(await dbGet('photoReferences', photoId));
}

export async function getAllReferenceProfiles() {
  const all = await safe(() => dbGetAll('photoReferences'), []) || [];
  return all.map(parseReferenceProfile).filter(Boolean);
}

export async function deleteReferenceProfile(photoId) {
  if (!photoId) return;
  await safe(() => dbDelete('photoReferences', photoId));
}

/**
 * Make a photo the active template. A photo can only become the template once
 * its reference profile exists, so the pointer can never dangle.
 */
export async function setActiveTemplate(photoId) {
  if (!photoId) {
    await saveSettings({ photoTemplateId: null });
    return null;
  }
  const profile = await getReferenceProfile(photoId);
  if (!profile || !profile.quality?.usable) return null;
  await saveSettings({ photoTemplateId: photoId });
  return profile;
}

export async function clearActiveTemplate() {
  await saveSettings({ photoTemplateId: null });
}

/**
 * Load the active template as { photo, profile } — or null when there is none
 * or it no longer resolves. Used by the smart camera and the photos screen.
 */
export async function getActiveTemplate(photoList) {
  const photoTemplateId = getSettings().photoTemplateId;
  if (!photoTemplateId) return null;
  const list = photoList || (await getAllPhotos());
  const photo = list.find((p) => p.id === photoTemplateId);
  if (!photo) return null;
  const profile = await getReferenceProfile(photo.id);
  if (!profile) return null;
  return { photo, profile };
}

/**
 * Reconcile reference metadata with the photos that actually exist: removes
 * profiles whose photo is gone and clears a pointer that no longer resolves.
 * Called after a backup import (where profiles and photos arrive together, or
 * not at all) and defensively when the photos screen mounts.
 */
export async function pruneReferences(photoList) {
  const list = photoList || (await getAllPhotos());
  const photoIds = new Set(list.map((p) => p.id));
  // Deliberately reads the raw store (not getAllReferenceProfiles) so records
  // that no longer parse — a profile from a future/older format, or a partially
  // written record — are cleaned up too instead of lingering invisibly.
  const records = (await safe(() => dbGetAll('photoReferences'), [])) || [];
  let removed = 0;
  for (const record of records) {
    const key = record && (record.photoId || record.id);
    const profile = parseReferenceProfile(record);
    if (profile && photoIds.has(profile.photoId)) continue;
    if (key) await deleteReferenceProfile(key);
    removed += 1;
  }
  const templateId = getSettings().photoTemplateId;
  if (templateId && !photoIds.has(templateId)) {
    await clearActiveTemplate();
  }
  return { removed, profiles: records.length - removed };
}

// ---------------------------------------------------------------------------
// Image processing — decodes, downscales and re-encodes as JPEG.
// ---------------------------------------------------------------------------

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image.'))), 'image/jpeg', quality);
  });
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { width: bmp.width, height: bmp.height, source: bmp };
    } catch {
      /* fall through to <img> path */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight, source: img });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read that image.'));
    };
    img.src = url;
  });
}

export async function processImage(file, maxSize, quality) {
  const { width, height, source } = await decodeImage(file);
  const scale = Math.min(1, maxSize / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, w, h);
  return canvasToBlob(canvas, quality);
}

// ---------------------------------------------------------------------------
// Object-URL cache — created lazily per photo/kind and revoked on unmount so
// large numbers of photos never accumulate live object URLs.
// ---------------------------------------------------------------------------

const urlCache = new Map();

export function photoUrl(photo, kind = 'thumb') {
  if (!photo || !photo[kind]) return null;
  const key = `${photo.id}:${kind}`;
  if (!urlCache.has(key)) urlCache.set(key, URL.createObjectURL(photo[kind]));
  return urlCache.get(key);
}

export function revokePhotoUrls() {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}