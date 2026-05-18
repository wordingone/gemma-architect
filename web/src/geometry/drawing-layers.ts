// drawing-layers.ts — 2D drawing layer model and store (#964).

export type DrawingLayer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  color: string;
};

const DEFAULT_DL: DrawingLayer = { id: "default", name: "Default", visible: true, locked: false, color: "#4a9eca" };

type DLListener = () => void;

class DrawingLayerStore {
  private _layers: Map<string, DrawingLayer> = new Map();
  private _activeId: string = "default";
  private _listeners: Set<DLListener> = new Set();

  constructor() {
    this._layers.set(DEFAULT_DL.id, { ...DEFAULT_DL });
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
  }

  add(name: string, color = "#cccccc"): DrawingLayer {
    const id = `user/${Date.now()}`;
    const layer: DrawingLayer = { id, name, visible: true, locked: false, color };
    this._layers.set(id, layer);
    this._activeId = id;
    this._notify();
    return layer;
  }

  remove(id: string): boolean {
    if (id === "default") return false;
    const ok = this._layers.delete(id);
    if (ok) {
      if (this._activeId === id) this._activeId = "default";
      this._notify();
    }
    return ok;
  }

  setVisible(id: string, visible: boolean): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.visible = visible;
    this._notify();
    return true;
  }

  setLocked(id: string, locked: boolean): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.locked = locked;
    this._notify();
    return true;
  }

  setColor(id: string, color: string): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.color = color;
    this._notify();
    return true;
  }

  rename(id: string, name: string): boolean {
    const l = this._layers.get(id);
    if (!l) return false;
    l.name = name.trim() || l.name;
    this._notify();
    return true;
  }
}

export const drawingLayerStore = new DrawingLayerStore();

export const SKETCH_KINDS = new Set(["rectangle", "circle", "line", "polyline", "curve", "point", "polygon"]);
