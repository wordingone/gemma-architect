// drawing-layers.ts — 2D drawing layer model and store (#964, extended #1854).

export type Linetype = "Continuous" | "Hidden" | "Dashed" | "Dashdot" | "Center" | "Phantom";

// AutoCAD-canonical lineweight ramp (mm).
export const LINEWEIGHTS = [0, 0.05, 0.09, 0.13, 0.20, 0.30, 0.40, 0.50, 0.70, 1.00, 1.40, 2.00];
export const LINETYPES: Linetype[] = ["Continuous", "Hidden", "Dashed", "Dashdot", "Center", "Phantom"];

export type DrawingLayer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  color: string;
  lineweight: number;  // mm
  linetype: Linetype;
  printWidth: number;  // mm (separate from on-screen lineweight)
};

// AutoCAD-canonical starter set (#1854).
const DEFAULT_LAYERS: DrawingLayer[] = [
  { id: "default", name: "0",            visible: true, locked: false, color: "#9ec5d8", lineweight: 0.25, linetype: "Continuous", printWidth: 0.25 },
  { id: "defpoints",    name: "Defpoints",    visible: true, locked: false, color: "#808080", lineweight: 0.09, linetype: "Continuous", printWidth: 0 },
  { id: "annotations",  name: "Annotations",  visible: true, locked: false, color: "#f0d070", lineweight: 0.18, linetype: "Continuous", printWidth: 0.18 },
  { id: "dimensions",   name: "Dimensions",   visible: true, locked: false, color: "#4a9eca", lineweight: 0.13, linetype: "Continuous", printWidth: 0.13 },
  { id: "hatches",      name: "Hatches",      visible: true, locked: false, color: "#888888", lineweight: 0.09, linetype: "Continuous", printWidth: 0.09 },
  { id: "construction", name: "Construction", visible: true, locked: false, color: "#ff8000", lineweight: 0.09, linetype: "Dashed",     printWidth: 0.09 },
];

type DLListener = () => void;

class DrawingLayerStore {
  private _layers: Map<string, DrawingLayer> = new Map();
  private _activeId: string = "default";
  private _listeners: Set<DLListener> = new Set();

  constructor() {
    for (const l of DEFAULT_LAYERS) this._layers.set(l.id, { ...l });
  }

  subscribe(fn: DLListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  all(): DrawingLayer[] {
    return Array.from(this._layers.values());
  }

  get(id: string): DrawingLayer | undefined {
    return this._layers.get(id);
  }

  getActiveId(): string {
    return this._activeId;
  }

  getActive(): DrawingLayer {
    return this._layers.get(this._activeId) ?? this._layers.get("default")!;
  }

  setActive(id: string): void {
    if (this._layers.has(id)) this._activeId = id;
    this._notify();
    _save(this);
  }

  add(name: string, color = "#cccccc"): DrawingLayer {
    const id = `user/${Date.now()}`;
    const layer: DrawingLayer = { id, name, visible: true, locked: false, color, lineweight: 0.25, linetype: "Continuous", printWidth: 0.25 };
    this._layers.set(id, layer);
    this._activeId = id;
    this._notify();
    _save(this);
    return layer;
  }

  remove(id: string): boolean {
    if (id === "default") return false;
    const ok = this._layers.delete(id);
    if (ok) {
      if (this._activeId === id) this._activeId = "default";
      this._notify();
      _save(this);
    }
    return ok;
  }

  setVisible(id: string, visible: boolean): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.visible = visible;
    this._notify();
    _save(this);
    return true;
  }

  setLocked(id: string, locked: boolean): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.locked = locked;
    this._notify();
    _save(this);
    return true;
  }

  setColor(id: string, color: string): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.color = color;
    this._notify();
    _save(this);
    return true;
  }

  setLineweight(id: string, lw: number): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.lineweight = lw;
    this._notify();
    _save(this);
    return true;
  }

  setLinetype(id: string, lt: Linetype): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.linetype = lt;
    this._notify();
    _save(this);
    return true;
  }

  setPrintWidth(id: string, pw: number): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.printWidth = pw;
    this._notify();
    _save(this);
    return true;
  }

  rename(id: string, name: string): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.name = name.trim() || l.name;
    this._notify();
    _save(this);
    return true;
  }

  _snapshot(): { layers: DrawingLayer[]; activeId: string } {
    return { layers: Array.from(this._layers.values()), activeId: this._activeId };
  }

  _restore(layers: DrawingLayer[], activeId: string): void {
    this._layers.clear();
    for (const l of layers) this._layers.set(l.id, l);
    this._activeId = this._layers.has(activeId) ? activeId : "default";
    this._notify();
  }
}

export const drawingLayerStore = new DrawingLayerStore();

export const SKETCH_KINDS = new Set(["rectangle", "circle", "line", "polyline", "curve", "point", "polygon"]);

// IDB persistence.
const IDB_NAME = "gemma-drawing-layers";
const IDB_STORE = "state";
const IDB_VERSION = 1;
let _db: IDBDatabase | null = null;

function _openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess  = (e) => { _db = (e.target as IDBOpenDBRequest).result; res(_db); };
    req.onerror    = () => rej(req.error);
  });
}

function _save(store: DrawingLayerStore): void {
  _openDb().then(db => {
    const snap = store._snapshot();
    db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(snap, "v1");
  }).catch(() => {/* ignore */});
}

export async function loadDrawingLayers(): Promise<void> {
  try {
    const db = await _openDb();
    const data = await new Promise<{ layers: DrawingLayer[]; activeId: string } | undefined>((res, rej) => {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get("v1");
      req.onsuccess = () => res(req.result as { layers: DrawingLayer[]; activeId: string } | undefined);
      req.onerror = () => rej(req.error);
    });
    if (data?.layers?.length) {
      // Merge persisted data: ensure lineweight/linetype/printWidth exist (migration from old format).
      const migrated = data.layers.map(l => ({
        ...l,
        lineweight: l.lineweight ?? 0.25,
        linetype: (l.linetype as Linetype) ?? "Continuous",
        printWidth: l.printWidth ?? 0.25,
      }));
      drawingLayerStore._restore(migrated, data.activeId ?? "default");
    }
  } catch { /* use defaults on error */ }
}
