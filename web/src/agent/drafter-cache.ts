// drafter-cache.ts — IndexedDB-backed fetch for drafter ONNX binary (#738).
//
// Stores the 158 MB fp16 drafter under a version-keyed IDB entry so users
// only pay the download cost once per model version. Bump DRAFTER_CACHE_KEY
// in agent-harness.ts to invalidate cached bytes.

const DB_NAME = "gemma-architect-models";
const STORE_NAME = "models";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as Uint8Array | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Fetch drafter ONNX bytes with IndexedDB caching.
 *
 * @param url       Remote URL — e.g. "/models/.../drafter-fp16.onnx"
 * @param cacheKey  IDB key — bump to bust cache, e.g. "mtp-drafter-fp16-v1"
 * @returns         ArrayBuffer suitable for ort.InferenceSession.create(buf, opts)
 */
export async function fetchDrafterCached(url: string, cacheKey: string): Promise<ArrayBuffer> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const cached = await idbGet(db, cacheKey);
    if (cached) {
      console.info(`[drafter-cache] IDB hit for ${cacheKey} (${(cached.byteLength / 1e6).toFixed(1)} MB)`);
      return cached.buffer.slice(0) as ArrayBuffer;
    }
  } catch {
    // IDB unavailable (private browsing, storage quota exceeded) — fall through to fetch.
  }

  console.info(`[drafter-cache] IDB miss — fetching ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`drafter fetch failed: ${resp.status} ${url}`);
  const buf = await resp.arrayBuffer();

  if (db) {
    try {
      await idbPut(db, cacheKey, new Uint8Array(buf));
      console.info(`[drafter-cache] stored ${cacheKey} (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
    } catch {
      // Non-fatal — store failure means next reload re-fetches, which is fine.
    }
  }

  return buf;
}
