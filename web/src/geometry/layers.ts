// layers.ts — Layer data model and in-memory store (#168 Phase A+B).

export type Layer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  color: string;
};

// Canonical built-in layer IDs — never deleted.
export const DEFAULT_LAYER_ID = "0/Default";

const BUILTIN_LAYERS: Layer[] = [
  { id: "0/Default",     name: "Default",      visible: true, locked: false, color: "#9ec5d8" },
  { id: "Walls",         name: "Walls",         visible: true, locked: false, color: "#9ec5d8" },
  { id: "Slabs",         name: "Slabs",         visible: true, locked: false, color: "#a8a097" },
  { id: "Columns",       name: "Columns",       visible: true, locked: false, color: "#d1c5b0" },
  { id: "Annotations",   name: "Annotations",   visible: true, locked: false, color: "#f0d070" },
  { id: "Construction",  name: "Construction",  visible: true, locked: false, color: "#80c080" },
];

// creator-name → layer ID routing table.
const CREATOR_LAYER_MAP: Record<string, string> = {
  IfcWall:        "Walls",
  IfcSlab:        "Slabs",
  IfcColumn:      "Columns",
  IfcBeam:        "Columns",
  IfcFoundation:  "Slabs",
  IfcCeiling:     "Slabs",
  IfcRoof:        "Slabs",
  IfcStair:       "Construction",
  IfcRamp:        "Construction",
  IfcRailing:     "Construction",
  IfcDoor:        "Walls",
  IfcWindow:      "Walls",
  IfcCurtainWall: "Walls",
  IfcSkylight:    "Walls",
  IfcOpening:     "Walls",
  IfcSpace:       "0/Default",
  IfcAnnotationDimension: "Annotations",
  SdLeader:       "Annotations",
  SdText:         "Annotations",
};

type LayerListener = () => void;

class LayerStore {
  private _layers: Map<string, Layer> = new Map();
  private _listeners: Set<LayerListener> = new Set();

  constructor() {
    for (const l of BUILTIN_LAYERS) this._layers.set(l.id, { ...l });
  }

  subscribe(fn: LayerListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  all(): Layer[] {
    return Array.from(this._layers.values());
  }

  get(id: string): Layer | undefined {
    return this._layers.get(id);
  }

  add(layer: Omit<Layer, "id"> & { id?: string }): Layer {
    const id = layer.id ?? `user/${Date.now()}`;
    const entry: Layer = { id, name: layer.name, visible: layer.visible ?? true, locked: layer.locked ?? false, color: layer.color ?? "#cccccc" };
    this._layers.set(id, entry);
    this._notify();
    return entry;
  }

  remove(id: string): boolean {
    if (id === DEFAULT_LAYER_ID) return false;
    const ok = this._layers.delete(id);
    if (ok) this._notify();
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
}

export const layerStore = new LayerStore();

/** Return the canonical layer ID for a given creator tag (IFC class name). */
export function getLayerForCreator(creator: string): string {
  return CREATOR_LAYER_MAP[creator] ?? DEFAULT_LAYER_ID;
}
