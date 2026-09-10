/**
 * Progress photos — image processing (downscale to keep storage/memory sane),
 * object-URL caching, CRUD.
 *
 * Privacy: images live only in local IndexedDB and are never uploaded anywhere.
 */
import { dbDelete, dbGetAll, dbPut } from './db.js';
import { makeProgressPhoto } from './models.js';
import { safe } from './utils.js';

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