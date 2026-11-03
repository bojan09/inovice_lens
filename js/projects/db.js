// db.js - minimal promise wrapper over IndexedDB. The adapter interface (open/run/clear/close) is also implemented by the
// in-memory fake used in unit tests, so repo.js is tested without a browser.
import { DB_NAME, DB_VERSION, STORES } from './schema.js';

export class StorageFullError extends Error {
  constructor(message = 'The browser has no space left for this project.') { super(message); this.name = 'StorageFullError'; }
}
export class StorageUnavailableError extends Error {
  constructor(message = 'Saving is not available in this browser (private mode or blocked storage).') { super(message); this.name = 'StorageUnavailableError'; }
}

const wrap = (err) => {
  if (err && (err.name === 'QuotaExceededError' || err.code === 22)) return new StorageFullError();
  return err instanceof Error ? err : new Error(String(err));
};

export function openDb(idb = globalThis.indexedDB) {
  if (!idb) return Promise.reject(new StorageUnavailableError());
  return new Promise((resolve, reject) => {
    let req;
    try { req = idb.open(DB_NAME, DB_VERSION); } catch (e) { reject(new StorageUnavailableError()); return; }
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const from = ev.oldVersion;
      // v0 -> v1: create the stores. Later versions add `if (from < 2) { ... }` blocks that only ADD; data is never dropped here.
      if (from < 1) {
        const projects = db.createObjectStore(STORES.projects, { keyPath: 'id' });
        projects.createIndex('updatedAt', 'updatedAt');
        const files = db.createObjectStore(STORES.files, { keyPath: 'key' });
        files.createIndex('projectId', 'projectId');
        db.createObjectStore(STORES.blobs, { keyPath: 'key' });
        db.createObjectStore(STORES.thumbs, { keyPath: 'key' });
      }
    };
    req.onblocked = () => reject(new StorageUnavailableError('Close other InvoiceLens tabs and try again.'));
    req.onerror = () => reject(wrap(req.error));
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(makeAdapter(db));
    };
  });
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(wrap(r.error)); });

function makeAdapter(db) {
  return {
    /** run(storeNames, 'readonly'|'readwrite', async tx => ...) - everything inside must only await tx methods. */
    run(names, mode, fn) {
      return new Promise((resolve, reject) => {
        let out;
        let tx;
        try { tx = db.transaction(names, mode); } catch (e) { reject(wrap(e)); return; }
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(wrap(tx.error));
        tx.onabort = () => reject(wrap(tx.error ?? new Error('Transaction aborted')));
        const api = {
          get: (s, k) => req2p(tx.objectStore(s).get(k)),
          put: (s, v) => req2p(tx.objectStore(s).put(v)),
          delete: (s, k) => req2p(tx.objectStore(s).delete(k)),
          getAll: (s) => req2p(tx.objectStore(s).getAll()),
          getAllKeys: (s) => req2p(tx.objectStore(s).getAllKeys()),
          getAllByIndex: (s, idx, v) => req2p(tx.objectStore(s).index(idx).getAll(v)),
          clear: (s) => req2p(tx.objectStore(s).clear()),
        };
        Promise.resolve(fn(api)).then((v) => { out = v; }, (e) => { try { tx.abort(); } catch { /* already finished */ } reject(wrap(e)); });
      });
    },
    close: () => db.close(),
  };
}

/** Delete the whole database (used by "delete all local data" in addition to clearing stores, and by tests). */
export function deleteDb(idb = globalThis.indexedDB) {
  return new Promise((resolve) => {
    if (!idb) return resolve();
    const r = idb.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}
