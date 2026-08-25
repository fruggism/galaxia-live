/*
 * IndexedDB wrapper shared by the page and the worker.
 *
 * Five stores:
 *   projects    the atlases (layers, features)
 *   archiveDocs the Archivio's documents — independent of any atlas, each
 *               entry one immutable, signed version (see app/documents.js)
 *   tiles       rendered map tiles, one WebP blob per tile
 *   handles     the picked world folder, so it reopens next session
 *   meta        render bookkeeping ("this dimension was generated for this area")
 */

const DB_NAME = 'cube-atlas';
const DB_VERSION = 2;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('archiveDocs')) db.createObjectStore('archiveDocs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles');
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB non disponibile'));
    req.onblocked = () => reject(new Error('Database bloccato da un\'altra scheda aperta'));
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const idbGet = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const idbPut = (store, value, key) => run(store, 'readwrite', (s) => s.put(value, key));
export const idbDelete = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const idbGetAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const idbClear = (store) => run(store, 'readwrite', (s) => s.clear());

/** Delete every key of a store that starts with a prefix (a tile namespace). */
export function idbDeletePrefix(store, prefix) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const req = os.openKeyCursor(range);
    let removed = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      os.delete(cursor.key);
      removed++;
      cursor.continue();
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = () => reject(tx.error);
  }));
}

/** Count keys under a prefix, and their rough size. */
export function idbStatsPrefix(store, prefix) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const req = os.openCursor(range);
    let files = 0;
    let bytes = 0;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      files++;
      const v = cursor.value;
      if (v && typeof v.size === 'number') bytes += v.size;
      cursor.continue();
    };
    tx.oncomplete = () => resolve({ files, bytes });
    tx.onerror = () => reject(tx.error);
  }));
}

/** How much room the browser is giving us, for the "cache is full" case. */
export async function storageEstimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}
