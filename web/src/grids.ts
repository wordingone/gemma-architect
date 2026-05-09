// grids.ts — Grid data model and in-memory store (#171 Phase B).

export type Grid = {
  id: string;
  name: string;
  spacing: number;    // metres between grid lines
  count: number;      // lines per axis
  rotation: number;   // radians, applied to the whole grid
  origin: [number, number];
  visible: boolean;
};

const DEFAULT_GRID_ID = "grid/primary";

const BUILTIN_GRIDS: Grid[] = [
  { id: DEFAULT_GRID_ID, name: "Primary", spacing: 5, count: 4, rotation: 0, origin: [0, 0], visible: true },
];

type GridListener = () => void;

class GridStore {
  private _grids: Map<string, Grid> = new Map();
  private _listeners: Set<GridListener> = new Set();
  private _activeId: string = DEFAULT_GRID_ID;

  constructor() {
    for (const g of BUILTIN_GRIDS) this._grids.set(g.id, { ...g });
  }

  subscribe(fn: GridListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  all(): Grid[] {
    return Array.from(this._grids.values());
  }

  get(id: string): Grid | undefined {
    return this._grids.get(id);
  }

  getActive(): Grid | undefined {
    return this._grids.get(this._activeId);
  }

  getActiveId(): string {
    return this._activeId;
  }

  setActive(id: string): boolean {
    if (!this._grids.has(id)) return false;
    this._activeId = id;
    this._notify();
    return true;
  }

  add(grid: Omit<Grid, "id"> & { id?: string }): Grid {
    const id = grid.id ?? `grid/${Date.now()}`;
    const entry: Grid = {
      id,
      name: grid.name ?? id,
      spacing: grid.spacing ?? 5,
      count: grid.count ?? 4,
      rotation: grid.rotation ?? 0,
      origin: grid.origin ?? [0, 0],
      visible: grid.visible ?? true,
    };
    this._grids.set(id, entry);
    this._notify();
    return entry;
  }

  remove(id: string): boolean {
    if (id === DEFAULT_GRID_ID) return false;
    const ok = this._grids.delete(id);
    if (ok) {
      if (this._activeId === id) this._activeId = DEFAULT_GRID_ID;
      this._notify();
    }
    return ok;
  }

  setVisible(id: string, visible: boolean): boolean {
    const g = this._grids.get(id);
    if (!g) return false;
    g.visible = visible;
    this._notify();
    return true;
  }

  setSpacing(id: string, spacing: number): boolean {
    if (spacing <= 0) return false;
    const g = this._grids.get(id);
    if (!g) return false;
    g.spacing = spacing;
    this._notify();
    return true;
  }

  setRotation(id: string, rotation: number): boolean {
    const g = this._grids.get(id);
    if (!g) return false;
    g.rotation = rotation;
    this._notify();
    return true;
  }

  setOrigin(id: string, origin: [number, number]): boolean {
    const g = this._grids.get(id);
    if (!g) return false;
    g.origin = origin;
    this._notify();
    return true;
  }
}

export const gridStore = new GridStore();
