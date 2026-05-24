// clipping-planes.ts — Entity store for named clipping planes (#1849 Step 2).
// Tracks origin/normal/bounds so the Layout tab can auto-link section sheets.

export interface CPlaneEntity {
  id: string;
  label: string;
  origin: [number, number, number];
  normal: [number, number, number];
  /** Crop-region extents for the linked Layout sheet. */
  bounds: CPlaneBounds;
}

export interface CPlaneBounds {
  startOffset: number;  // left edge offset from origin (m)
  endOffset: number;    // right edge offset from origin (m)
  farClip: number;      // depth behind cut plane (m)
  height: number;       // view height (m)
}

export const DEFAULT_CPLANE_BOUNDS: CPlaneBounds = {
  startOffset: -10,
  endOffset: 10,
  farClip: 40,
  height: 10,
};

let _seq = 0;
const _entities = new Map<string, CPlaneEntity>();
const _subs: Array<() => void> = [];

function _notify(): void {
  for (const fn of _subs) fn();
}

export const clippingPlaneStore = {
  all(): CPlaneEntity[] { return [..._entities.values()]; },

  get(id: string): CPlaneEntity | undefined { return _entities.get(id); },

  getByLabel(label: string): CPlaneEntity | undefined {
    for (const e of _entities.values()) if (e.label === label) return e;
    return undefined;
  },

  add(
    origin: [number, number, number],
    normal: [number, number, number],
    label: string,
    bounds?: Partial<CPlaneBounds>,
  ): CPlaneEntity {
    const id = `cplane-${++_seq}`;
    const entity: CPlaneEntity = {
      id,
      label,
      origin,
      normal,
      bounds: { ...DEFAULT_CPLANE_BOUNDS, ...bounds },
    };
    _entities.set(id, entity);
    _notify();
    return entity;
  },

  remove(id: string): boolean {
    const had = _entities.delete(id);
    if (had) _notify();
    return had;
  },

  removeByLabel(label: string): boolean {
    const e = clippingPlaneStore.getByLabel(label);
    if (!e) return false;
    return clippingPlaneStore.remove(e.id);
  },

  clear(): void {
    _entities.clear();
    _notify();
  },

  updateBounds(id: string, bounds: Partial<CPlaneBounds>): boolean {
    const e = _entities.get(id);
    if (!e) return false;
    e.bounds = { ...e.bounds, ...bounds };
    _notify();
    return true;
  },

  subscribe(fn: () => void): () => void {
    _subs.push(fn);
    return () => { const i = _subs.indexOf(fn); if (i !== -1) _subs.splice(i, 1); };
  },
};
