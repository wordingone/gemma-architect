// levels.ts — Level data model and in-memory store for Phase A (#171).
// Phase B will add grid-snapping; Phase C bench + skill integration.

export type Level = {
  id: string;
  name: string;
  elevation: number;
  height: number;
  visible: boolean;
  active: boolean;
};

const GROUND_LEVEL_ID = "level/0";

const BUILTIN_LEVELS: Level[] = [
  { id: GROUND_LEVEL_ID, name: "Ground",   elevation: 0, height: 3.0, visible: true, active: true },
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
    const id = `level/${Date.now()}`;
    const entry: Level = {
      id,
      name: opts.name,
      elevation: opts.elevation,
      height: opts.height ?? 3.0,
      visible: true,
      active: false,
    };
    this._levels.set(id, entry);
    this._notify();
    return entry;
  }

  /** Find or create a level by name (for IfcLevel dispatch handler). */
  findOrCreate(name: string, elevation: number, height?: number): Level {
    for (const l of this._levels.values()) {
      if (l.name.toLowerCase() === name.toLowerCase()) return l;
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

  setVisible(id: string, visible: boolean): boolean {
    const l = this._levels.get(id);
    if (!l) return false;
    l.visible = visible;
    this._notify();
    return true;
  }
}

export const levelStore = new LevelStore();

/** Return the active level ID for tagging newly dispatched geometry. */
export function getActiveLevelId(): string {
  return levelStore.getActiveId();
}
