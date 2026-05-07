// Selection state — module singleton.
//
// T3 deliverable. Exposes a single source of truth for "what is selected"
// across the viewer (raycaster), the right-sidebar Inspect tab, the gizmos
// (T4 transforms), and the Delete handler. Other modules read via
// `getSelected()` and listen for changes via `subscribe()`.
//
// Topology vocabulary follows Rhino's 7-tier scheme:
//   vertex | edge | curve | face | mesh | brep | compound
//
// Selection filters (Rhino-style toggle list) live in the same module so the
// scene-panel UI and the viewer raycaster see the same on/off bits.

import * as THREE from "three";

export type Topology =
  | "vertex"
  | "edge"
  | "curve"
  | "face"
  | "mesh"
  | "brep"
  | "compound";

// What can be selected. The Three.js `object` is the picking proxy (the
// vertex sprite, edge tube, face mesh, or the parent mesh). For sub-object
// hits, `parent` points at the owning brep/compound mesh. `index` is the
// triangle/face index inside the geometry (only set for face hits).
export type Selection = {
  topology: Topology;
  uuid: string;             // uuid of the picked object (proxy)
  object: THREE.Object3D;   // the actual picked Object3D (sprite / line / mesh)
  parent?: THREE.Object3D;  // owning brep/compound when this is a sub-object
  parentUuid?: string;      // convenience: parent.uuid
  faceIndex?: number;       // triangle index for face hits
  edgeIndex?: number;       // segment index for edge hits
  vertexIndex?: number;     // vertex index for vertex hits
  // The Three.js object that should host a TransformControls gizmo and
  // receive .translate/.rotate/.scale visual updates. For sub-object hits,
  // this is typically the parent (you can't transform a single face).
  transformTarget: THREE.Object3D;
};

export type SelectionFilters = {
  Points: boolean;
  Curves: boolean;
  Surfaces: boolean;
  Polysurfaces: boolean;
  Meshes: boolean;
  Annotations: boolean;
  Lights: boolean;
  Blocks: boolean;
};

const DEFAULT_FILTERS: SelectionFilters = {
  Points: true,
  Curves: true,
  Surfaces: true,
  Polysurfaces: true,
  Meshes: true,
  Annotations: true,
  Lights: false,
  Blocks: true,
};

let _selection: Selection | null = null;
let _multiSet: Selection[] = [];
let _filters: SelectionFilters = { ...DEFAULT_FILTERS };
const _listeners: Array<(s: Selection | null) => void> = [];
const _multiListeners: Array<(s: Selection[]) => void> = [];
const _filterListeners: Array<(f: SelectionFilters) => void> = [];

export function getSelected(): Selection | null {
  return _selection;
}

export function setSelected(sel: Selection | null): void {
  _selection = sel;
  for (const l of _listeners) {
    try { l(sel); } catch (e) { console.error("[selection-state] listener", e); }
  }
}

export function clearSelected(): void {
  setSelected(null);
}

// Multi-selection set — populated by Ctrl+click in viewer.ts.
// Separate from _selection (last single-clicked). INSPECT branches on this.

export function getMultiSelected(): Selection[] {
  return _multiSet;
}

export function addToMultiSelected(sel: Selection): void {
  const already = _multiSet.findIndex((s) => s.uuid === sel.uuid);
  if (already >= 0) {
    _multiSet.splice(already, 1);
  } else {
    _multiSet.push(sel);
  }
  for (const l of _multiListeners) {
    try { l([..._multiSet]); } catch (e) { console.error("[selection-state] multi listener", e); }
  }
}

export function clearMultiSelected(): void {
  _multiSet = [];
  for (const l of _multiListeners) {
    try { l([]); } catch (e) { console.error("[selection-state] multi listener", e); }
  }
}

export function subscribeMulti(fn: (s: Selection[]) => void): () => void {
  _multiListeners.push(fn);
  return () => {
    const i = _multiListeners.indexOf(fn);
    if (i >= 0) _multiListeners.splice(i, 1);
  };
}

export function subscribe(fn: (s: Selection | null) => void): () => void {
  _listeners.push(fn);
  return () => {
    const i = _listeners.indexOf(fn);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

export function getFilters(): SelectionFilters {
  return { ..._filters };
}

export function setFilter(name: keyof SelectionFilters, on: boolean): void {
  _filters = { ..._filters, [name]: on };
  for (const l of _filterListeners) {
    try { l({ ..._filters }); } catch (e) { console.error("[selection-state] filter listener", e); }
  }
}

export function setFilters(patch: Partial<SelectionFilters>): void {
  _filters = { ..._filters, ...patch };
  for (const l of _filterListeners) {
    try { l({ ..._filters }); } catch (e) { console.error("[selection-state] filter listener", e); }
  }
}

export function subscribeFilters(fn: (f: SelectionFilters) => void): () => void {
  _filterListeners.push(fn);
  return () => {
    const i = _filterListeners.indexOf(fn);
    if (i >= 0) _filterListeners.splice(i, 1);
  };
}

// Topology → which filter category gates it. Used by viewer raycaster to
// decide whether a hit type is currently allowed.
export function topologyAllowed(t: Topology, f: SelectionFilters = _filters): boolean {
  switch (t) {
    case "vertex": return f.Points;
    case "edge":   return f.Curves;
    case "curve":  return f.Curves;
    case "face":   return f.Surfaces;
    case "mesh":   return f.Meshes;
    case "brep":   return f.Polysurfaces;
    case "compound": return f.Blocks;
  }
}

// Reset filters to defaults — primarily for tests.
export function resetFilters(): void {
  _filters = { ...DEFAULT_FILTERS };
}

// Reset all state — primarily for tests.
export function resetSelectionState(): void {
  _selection = null;
  _multiSet = [];
  _filters = { ...DEFAULT_FILTERS };
  _listeners.length = 0;
  _multiListeners.length = 0;
  _filterListeners.length = 0;
}
