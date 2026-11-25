const DB_NAME = "svt-gallery";
const STORE = "items";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function runStore(mode, task) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const request = task(store);
    tx.oncomplete = () => {
      db.close();
      resolve(request?.result);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  }));
}

export function loadGalleryRecords() {
  return runStore("readonly", (store) => store.getAll()).then((rows) => rows || []);
}

export function saveGalleryRecord(record) {
  return runStore("readwrite", (store) => store.put(record));
}

export function deleteGalleryRecord(id) {
  return runStore("readwrite", (store) => store.delete(id));
}

export function clearGalleryRecords() {
  return runStore("readwrite", (store) => store.clear());
}
