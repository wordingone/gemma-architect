// levels.ts — Level data model and in-memory store for Phase A (#171).
// Phase B will add grid-snapping; Phase C bench + skill integration.

export type Level = {
  id: string;
  name: string;
  elevation: number;
  height: number;
  visible: boolean;
  active: boolean;
  locked: boolean;
};

// IDB persistence for level lock state (#1752).
// Separate DB so it doesn't interfere with scene auto-save versioning.
const _META_DB = "gemma-level-meta";
const _META_STORE = "meta";
const _LOCKS_KEY = "locks";

function _openMetaDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(_META_DB, 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(_META_STORE)) db.createObjectStore(_META_STORE);
    };
    req.onsuccess = (e) => res((e.target as IDBOpenDBRequest).result);
    req.onerror = (e) => rej((e.target as IDBOpenDBRequest).error);
  });
}

async function _saveLocks(locks: Record<string, boolean>): Promise<void> {
  try {
    const db = await _openMetaDB();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(_META_STORE, "readwrite");
      tx.objectStore(_META_STORE).put(locks, _LOCKS_KEY);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => { db.close(); rej(tx.error); };
    });
  } catch { /* non-fatal — lock state is a UX hint, not safety-critical */ }
}

export async function loadLevelLocks(): Promise<void> {
  try {
    const db = await _openMetaDB();
    const locks: Record<string, boolean> | undefined = await new Promise((res, rej) => {
      const tx = db.transaction(_META_STORE, "readonly");
      const req = tx.objectStore(_META_STORE).get(_LOCKS_KEY);
      req.onsuccess = () => { db.close(); res(req.result as Record<string, boolean> | undefined); };
      req.onerror = () => rej(req.error);
    });
    if (locks) levelStore.applyLocks(locks);
  } catch { /* IDB unavailable — non-fatal */ }
}

const GROUND_LEVEL_ID = "level/0";

const BUILTIN_LEVELS: Level[] = [
  { id: GROUND_LEVEL_ID, name: "Level 1",  elevation: 0, height: 3.0, visible: true, active: true, locked: false },
];

type LevelListener = () => void;

class LevelStore {
  private _levels: Map<string, Level> = new Map();
  private _activeId: string = GROUND_LEVEL_ID;
  private _listeners: Set<LevelListener> = new Set();

  constructor() {
    for (const l of BUILTIN_LEVELS) this._levels.set(l.id, { ...l });
  }

  subscribe(fn: LevelListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() {
    for (const fn of this._listeners) fn();
  }

  all(): Level[] {
    return Array.from(this._levels.values());
  }

  get(id: string): Level | undefined {
    return this._levels.get(id);
  }

  getActive(): Level {
    return this._levels.get(this._activeId) ?? this._levels.get(GROUND_LEVEL_ID)!;
  }

  getActiveId(): string {
    return this._activeId;
  }

  add(opts: { name: string; elevation: number; height?: number }): Level {
    const id = `level/${this._levels.size}`;
    const entry: Level = {
      id,
      name: opts.name,
      elevation: opts.elevation,
      height: opts.height ?? 3.0,
      visible: true,
      active: false,
      locked: false,
    };
    this._levels.set(id, entry);
    this._notify();
    return entry;
  }

  /** Find or create a level, matching by elevation first (avoids duplicating built-in ground level). */
  findOrCreate(name: string, elevation: number, height?: number): Level {
    for (const l of this._levels.values()) {
      if (Math.abs(l.elevation - elevation) < 0.01) return l;
    }
    return this.add({ name, elevation, height });
  }

  setActive(id: string): boolean {
    if (!this._levels.has(id)) return false;
    for (const l of this._levels.values()) l.active = l.id === id;
    this._activeId = id;
    this._notify();
    return true;
  }

  update(id: string, opts: { name?: string; elevation?: number; height?: number }): boolean {
    const l = this._levels.get(id);
    if (!l) return false;
    if (opts.name !== undefined) l.name = opts.name;
    if (opts.elevation !== undefined) l.elevation = opts.elevation;
    if (opts.height !== undefined) l.height = opts.height;
    this._notify();
    return true;
  }

  setVisible(id: string, visible: boolean): boolean {
    const l = this._levels.get(id);
    if (!l) return false;
    l.visible = visible;
    this._notify();
    return true;
  }

  setLocked(id: string, locked: boolean): boolean {
    const l = this._levels.get(id);
    if (!l) return false;
    l.locked = locked;
    this._notify();
    // Persist lock state to IDB (fire-and-forget).
    const snapshot: Record<string, boolean> = {};
    for (const [lid, lvl] of this._levels) if (lvl.locked) snapshot[lid] = true;
    _saveLocks(snapshot);
    return true;
  }

  /** Apply persisted lock state (called once on app init after IDB load). */
  applyLocks(locks: Record<string, boolean>): void {
    for (const [id, lvl] of this._levels) lvl.locked = locks[id] === true;
    this._notify();
  }

  remove(id: string): boolean {
    if (id === GROUND_LEVEL_ID) return false; // Level 1 is permanent
    if (!this._levels.has(id)) return false;
    this._levels.delete(id);
    if (this._activeId === id) {
      this._activeId = GROUND_LEVEL_ID;
      for (const l of this._levels.values()) l.active = l.id === GROUND_LEVEL_ID;
    }
    this._notify();
    return true;
  }
}

export const levelStore = new LevelStore();

/** Return the active level ID for tagging newly dispatched geometry. */
export function getActiveLevelId(): string {
  return levelStore.getActiveId();
}
