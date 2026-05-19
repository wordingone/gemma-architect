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
 * @param url        Remote URL — e.g. "/models/.../drafter-fp16.onnx"
 * @param cacheKey   IDB key — bump to bust cache, e.g. "mtp-drafter-fp16-v1"
 * @param onProgress Called with (loaded, total) during network fetch. total=0 means
 *                   Content-Length unavailable (indeterminate). On IDB hit, called
 *                   once with (byteLength, byteLength) to signal immediate completion.
 * @returns          ArrayBuffer suitable for ort.InferenceSession.create(buf, opts)
 */
export async function fetchDrafterCached(
  url: string,
  cacheKey: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    const cached = await idbGet(db, cacheKey);
    if (cached) {
      console.info(`[drafter-cache] IDB hit for ${cacheKey} (${(cached.byteLength / 1e6).toFixed(1)} MB)`);
      // Signal immediate completion — IDB read takes <100ms, no incremental progress.
      onProgress?.(cached.byteLength, cached.byteLength);
      return cached.buffer.slice(0) as ArrayBuffer;
    }
  } catch {
    // IDB unavailable (private browsing, storage quota exceeded) — fall through to fetch.
  }

  console.info(`[drafter-cache] IDB miss — fetching ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`drafter fetch failed: ${resp.status} ${url}`);

  // Stream the response body so we can report real byte progress.
  const contentLength = Number(resp.headers.get("Content-Length") ?? 0);
  let loaded = 0;
  const chunks: Uint8Array[] = [];

  if (resp.body) {
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, contentLength);
    }
  } else {
    // Fallback: no ReadableStream (shouldn't happen in modern browsers).
    const fallback = new Uint8Array(await resp.arrayBuffer());
    chunks.push(fallback);
    loaded = fallback.byteLength;
    onProgress?.(loaded, loaded);
  }

  // Concatenate chunks into a single contiguous buffer.
  const buf = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (db) {
    try {
      // §C-idb (#990): guard 158 MB write — skip if storage is ≥85% full.
      let canStore = true;
      if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        if (quota > 0 && usage / quota >= 0.85) {
          console.warn(`[drafter-cache] IDB quota at ${((usage / quota) * 100).toFixed(0)}% — skipping drafter store (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
          canStore = false;
        }
      }
      if (canStore) {
        await idbPut(db, cacheKey, buf);
        console.info(`[drafter-cache] stored ${cacheKey} (${(buf.byteLength / 1e6).toFixed(1)} MB)`);
      }
    } catch {
      // Non-fatal — store failure means next reload re-fetches, which is fine.
    }
  }

  return buf.buffer;
}
