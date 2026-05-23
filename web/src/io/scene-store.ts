const DB_NAME = "gemma-architect-scene";
const DB_VERSION = 1;
const STORE = "autosave";
const KEY = "scene";

function _openDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = (e) => res((e.target as IDBOpenDBRequest).result);
    req.onerror = (e) => rej((e.target as IDBOpenDBRequest).error);
  });
}

export async function sceneStoreSave(data: unknown): Promise<void> {
  const db = await _openDB();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).put(data, KEY);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function sceneStoreLoad(): Promise<unknown | null> {
  const db = await _openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => { db.close(); res(req.result ?? null); };
    req.onerror = () => rej(req.error);
  });
}

export async function sceneStoreClear(): Promise<void> {
  const db = await _openDB();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(KEY);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
    tx.oncomplete = () => db.close();
  });
}
