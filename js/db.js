/**
 * Storage layer — IndexedDB wrapped in promises.
 *
 * All app data lives in one local database; no backend is required.
 * This module is the ONLY place that touches IndexedDB, so swapping in a
 * cloud-sync adapter later means replacing just this file.
 */

const DB_NAME = 'life-progress-db';
// V2: adds achievementRecords (V1.2 Phase 2).
// V3: adds photoReferences (smart progress camera) — derived pose/composition
// metadata keyed by the progress photo it belongs to. Older databases upgrade
// in place via onupgradeneeded; existing stores and their data are untouched.
// V4: adds workoutTemplates, exerciseLibrary and activeWorkout stores (V1.4
// gym templates). The legacy `workouts` store is NOT touched — completed
// sessions keep their exact historical shape and ids.
// V5: adds notificationState (V1.5 notifications) — notification preferences
// (singleton 'prefs') plus one dedup record per delivered logical reminder.
const DB_VERSION = 5;

export const STORES = Object.freeze({
  settings: 'settings',
  waterEntries: 'waterEntries',
  goals: 'goals',
  workouts: 'workouts',
  progressPhotos: 'progressPhotos',
  // Derived reference profiles for the smart progress camera. Each record is
  // keyed by its progress photo id and holds pose/composition metadata only —
  // never image data — so the photo stays the single authoritative record.
  photoReferences: 'photoReferences',
  journalEntries: 'journalEntries',
  achievementRecords: 'achievementRecords',
  // V1.4 gym templates — reusable workout plans (structure only, no history).
  workoutTemplates: 'workoutTemplates',
  // Every exercise name the user has logged, for pickers (selection not typing).
  exerciseLibrary: 'exerciseLibrary',
  // Singleton record (id 'active') holding the in-progress workout, so an
  // unfinished session survives reload/offline. Deleted on complete/discard.
  activeWorkout: 'activeWorkout',
  // V1.5 notifications — preferences (id 'prefs') and delivery/dedup records
  // (id `${type}:${periodKey}`). Eligibility is always DERIVED from the
  // authoritative activity stores; nothing here duplicates user data.
  notificationState: 'notificationState',
});

export const ALL_STORES = Object.values(STORES);

let dbPromise = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'id' });
      }
      for (const store of ALL_STORES) {
        if (store === STORES.settings) continue;
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getDB() {
  if (!dbPromise) dbPromise = openDB();
  return dbPromise;
}

function run(storeName, mode, fn) {
  return getDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = fn(store);
        // IDBRequest exposes its resolved value only after the transaction
        // completes; resolve with request.result (or the return value for
        // non-request callers).
        tx.oncomplete = () => resolve(request instanceof IDBRequest ? request.result : request);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      })
  );
}

export function dbGetAll(storeName) {
  return run(storeName, 'readonly', (store) => store.getAll());
}

export function dbGet(storeName, id) {
  return run(storeName, 'readonly', (store) => store.get(id));
}

export function dbPut(storeName, value) {
  return run(storeName, 'readwrite', (store) => store.put(value));
}

export function dbDelete(storeName, id) {
  return run(storeName, 'readwrite', (store) => store.delete(id));
}

export function dbClear(storeName) {
  return run(storeName, 'readwrite', (store) => store.clear());
}

/** Persist several records atomically in one transaction. */
export function dbBulkPut(storeName, values) {
  return run(storeName, 'readwrite', (store) => {
    for (const value of values) store.put(value);
  });
}

/** Wipe every store. Returns the list of stores cleared. */
export async function dbResetAll() {
  const cleared = [];
  for (const store of ALL_STORES) {
    await dbClear(store);
    cleared.push(store);
  }
  return cleared;
}

/**
 * Dump every store as a plain object for export.
 * Photo blobs cannot survive JSON.stringify, so progressPhotos records are
 * serialized with blob/thumb as base64 data URLs (restored on import).
 */
export async function dbExportAll(serializeRecord) {
  const dump = { app: 'life-progress', version: 1, exportedAt: new Date().toISOString(), data: {} };
  for (const store of ALL_STORES) {
    const values = await dbGetAll(store);
    dump.data[store] = store === STORES.progressPhotos && serializeRecord ? await Promise.all(values.map(serializeRecord)) : values;
  }
  return dump;
}

/**
 * Replace all data with an exported dump. deserializeRecord reverses the
 * export-time serialization for progressPhotos (data URL → Blob).
 *
 * Dumps written before V3 simply have no `photoReferences` key — the store is
 * then cleared rather than treated as an error, so importing an old backup
 * keeps working. Orphaned reference profiles (and a dangling active-template
 * pointer) are reconciled by js/photos.js#pruneReferences after the import.
 */
export async function dbImportAll(dump, deserializeRecord) {
  if (!dump || dump.data == null) throw new Error('Invalid backup file.');
  for (const store of ALL_STORES) {
    const values = Array.isArray(dump.data[store]) ? dump.data[store] : [];
    await dbClear(store);
    if (values.length) {
      const restored = store === STORES.progressPhotos && deserializeRecord ? await Promise.all(values.map(deserializeRecord)) : values;
      await dbBulkPut(store, restored);
    }
  }
}