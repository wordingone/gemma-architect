// draft-elements.ts — 2D drafting element model + store (#1852).
//
// Implements the LibreCAD entity taxonomy as TypeScript discriminated unions:
//   DRAW:      RS_Line, RS_Arc, RS_Circle, RS_Ellipse, RS_Polyline, RS_Spline, RS_Point
//   ANNOTATE:  RS_Text, RS_MText, RS_Leader, RS_MLeader
//   DIMENSION: RS_DimLinear, RS_DimAligned, RS_DimAngular, RS_DimRadial,
//              RS_DimDiametric, RS_DimArcLength, RS_DimOrdinate
//   FILL:      RS_Hatch, RS_Wipeout
//   REFERENCE: RS_Insert, RS_Image
//
// Elements live in 2D paper-space (mm from sheet top-left). The 3D scene is
// unaffected. Each element carries a `layerId` referencing drawingLayerStore.
// Persistence: IDB, keyed by sheetId:elementId.

// --- Vec2 (paper-space, mm) ------------------------------------------------

export type Vec2 = { x: number; y: number };

// --- Hatch patterns ---------------------------------------------------------

export type HatchPattern = "line" | "dot" | "brick" | "solid";

// --- DRAW entities ----------------------------------------------------------

export type DraftLine = {
  kind: "RS_Line";
  id: string;
  sheetId: string;
  layerId: string;
  p1: Vec2;
  p2: Vec2;
};

export type DraftArc = {
  kind: "RS_Arc";
  id: string;
  sheetId: string;
  layerId: string;
  center: Vec2;
  radius: number;
  startAngle: number; // radians
  endAngle: number;   // radians
  cw: boolean;
};

export type DraftCircle = {
  kind: "RS_Circle";
  id: string;
  sheetId: string;
  layerId: string;
  center: Vec2;
  radius: number;
};

export type DraftEllipse = {
  kind: "RS_Ellipse";
  id: string;
  sheetId: string;
  layerId: string;
  center: Vec2;
  majorRadius: number;
  minorRadius: number;
  rotation: number; // radians
  startAngle?: number;
  endAngle?: number;
};

export type DraftPolyline = {
  kind: "RS_Polyline";
  id: string;
  sheetId: string;
  layerId: string;
  pts: Vec2[];
  closed: boolean;
};

export type DraftSpline = {
  kind: "RS_Spline";
  id: string;
  sheetId: string;
  layerId: string;
  controlPoints: Vec2[];
  degree: number;
  closed: boolean;
};

export type DraftPoint = {
  kind: "RS_Point";
  id: string;
  sheetId: string;
  layerId: string;
  pt: Vec2;
};

// --- ANNOTATE entities ------------------------------------------------------

export type DraftText = {
  kind: "RS_Text";
  id: string;
  sheetId: string;
  layerId: string;
  origin: Vec2;
  content: string;
  height: number; // mm
  angle: number;  // radians
};

export type DraftMText = {
  kind: "RS_MText";
  id: string;
  sheetId: string;
  layerId: string;
  origin: Vec2;
  content: string;
  height: number; // mm
  width: number;  // mm, text wrap width
  angle: number;  // radians
};

export type DraftLeader = {
  kind: "RS_Leader";
  id: string;
  sheetId: string;
  layerId: string;
  pts: Vec2[];       // arrowhead at pts[0], annotation end at pts[last]
  annotation?: string;
};

export type DraftMLeader = {
  kind: "RS_MLeader";
  id: string;
  sheetId: string;
  layerId: string;
  pts: Vec2[];
  annotation: string;
};

// --- DIMENSION entities -----------------------------------------------------

export type DraftDimLinear = {
  kind: "RS_DimLinear";
  id: string;
  sheetId: string;
  layerId: string;
  ext1: Vec2;     // first extension line origin
  ext2: Vec2;     // second extension line origin
  dimLine: Vec2;  // point on the dimension line
  angle: number;  // dimension line angle (0 = horizontal)
};

export type DraftDimAligned = {
  kind: "RS_DimAligned";
  id: string;
  sheetId: string;
  layerId: string;
  ext1: Vec2;
  ext2: Vec2;
  dimLine: Vec2;
};

export type DraftDimAngular = {
  kind: "RS_DimAngular";
  id: string;
  sheetId: string;
  layerId: string;
  center: Vec2;
  ext1: Vec2;
  ext2: Vec2;
  dimArc: Vec2; // point on the arc that the dim arc passes through
};

export type DraftDimRadial = {
  kind: "RS_DimRadial";
  id: string;
  sheetId: string;
  layerId: string;
  center: Vec2;
  ref: Vec2; // point on the circle/arc
};

export type DraftDimDiametric = {
  kind: "RS_DimDiametric";
  id: string;
  sheetId: string;
  layerId: string;
  def: Vec2; // first diameter end
  ref: Vec2; // second diameter end (opposite side)
};

export type DraftDimArcLength = {
  kind: "RS_DimArcLength";
  id: string;
  sheetId: string;
  layerId: string;
  center: Vec2;
  p1: Vec2;
  p2: Vec2;
  dimArc: Vec2;
};

export type DraftDimOrdinate = {
  kind: "RS_DimOrdinate";
  id: string;
  sheetId: string;
  layerId: string;
  def: Vec2;     // feature point
  feature: Vec2; // leader endpoint
  direction: "x" | "y";
};

// --- FILL entities ----------------------------------------------------------

export type DraftHatch = {
  kind: "RS_Hatch";
  id: string;
  sheetId: string;
  layerId: string;
  boundary: Vec2[][]; // outer loop + optional holes; each is a closed polygon
  pattern: HatchPattern;
  scale: number;
  angle: number; // radians
};

export type DraftWipeout = {
  kind: "RS_Wipeout";
  id: string;
  sheetId: string;
  layerId: string;
  boundary: Vec2[]; // closed polygon
};

// --- REFERENCE entities -----------------------------------------------------

export type DraftInsert = {
  kind: "RS_Insert";
  id: string;
  sheetId: string;
  layerId: string;
  blockId: string;
  origin: Vec2;
  scale: Vec2; // {x, y} scale factors
  angle: number; // radians
};

export type DraftImage = {
  kind: "RS_Image";
  id: string;
  sheetId: string;
  layerId: string;
  origin: Vec2;
  width: number;  // mm
  height: number; // mm
  url: string;
  angle: number; // radians
};

// --- Union ------------------------------------------------------------------

export type DraftElement =
  | DraftLine | DraftArc | DraftCircle | DraftEllipse | DraftPolyline | DraftSpline | DraftPoint
  | DraftText | DraftMText | DraftLeader | DraftMLeader
  | DraftDimLinear | DraftDimAligned | DraftDimAngular | DraftDimRadial | DraftDimDiametric | DraftDimArcLength | DraftDimOrdinate
  | DraftHatch | DraftWipeout
  | DraftInsert | DraftImage;

// --- Active draft tool state ------------------------------------------------

export type DraftToolId =
  | "line" | "arc" | "circle" | "ellipse" | "polyline" | "spline" | "point"
  | "text" | "mtext" | "leader" | "mleader"
  | "dim-linear" | "dim-aligned" | "dim-angular" | "dim-radial" | "dim-diametric" | "dim-arc-length" | "dim-ordinate"
  | "hatch" | "wipeout"
  | "block-insert" | "image";

let _activeDraftTool: DraftToolId | null = null;
const _draftToolListeners: Set<() => void> = new Set();

export function getActiveDraftTool(): DraftToolId | null {
  return _activeDraftTool;
}

export function setActiveDraftTool(toolId: DraftToolId | null): void {
  _activeDraftTool = toolId;
  for (const fn of _draftToolListeners) fn();
  if (toolId) {
    window.dispatchEvent(new CustomEvent("layout:draft-tool-changed", { detail: { toolId } }));
  }
}

export function subscribeActiveDraftTool(fn: () => void): () => void {
  _draftToolListeners.add(fn);
  return () => _draftToolListeners.delete(fn);
}

// --- 2D snap candidates from projected panel edges --------------------------
//
// The viewer's getClassifiedEdgeSegmentsForView() already returns projected
// 2D segments in panel-pixel space. We extract vertices and midpoints from
// those segments as snap candidates.

export type SnapCandidate2d = {
  kind: "vertex" | "midpoint" | "edge";
  pt: Vec2; // mm in panel space (px converted using scale)
};

export function get2dSnapCandidates(
  segments: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  pxToMm: number,
): SnapCandidate2d[] {
  const candidates: SnapCandidate2d[] = [];
  for (const s of segments) {
    candidates.push({ kind: "vertex",   pt: { x: s.x1 * pxToMm, y: s.y1 * pxToMm } });
    candidates.push({ kind: "vertex",   pt: { x: s.x2 * pxToMm, y: s.y2 * pxToMm } });
    candidates.push({ kind: "midpoint", pt: { x: ((s.x1 + s.x2) / 2) * pxToMm, y: ((s.y1 + s.y2) / 2) * pxToMm } });
  }
  return candidates;
}

// Given a query point and a list of candidates, return the nearest candidate
// within `threshold` mm (paper space), or null.
export function nearestSnapCandidate(
  query: Vec2,
  candidates: SnapCandidate2d[],
  threshold: number,
): SnapCandidate2d | null {
  let best: SnapCandidate2d | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const dx = c.pt.x - query.x;
    const dy = c.pt.y - query.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

// --- DraftElementStore ------------------------------------------------------

type Listener = () => void;

let _uid = 0;
export function newDraftElementId(): string {
  return `de/${Date.now()}_${++_uid}`;
}

class DraftElementStore {
  // sheetId → (elementId → element)
  private _bySheet: Map<string, Map<string, DraftElement>> = new Map();
  private _listeners: Set<Listener> = new Set();

  subscribe(fn: Listener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  private _sheetMap(sheetId: string): Map<string, DraftElement> {
    let m = this._bySheet.get(sheetId);
    if (!m) { m = new Map(); this._bySheet.set(sheetId, m); }
    return m;
  }

  add(el: DraftElement): DraftElement {
    this._sheetMap(el.sheetId).set(el.id, el);
    this._notify();
    _schedSave(el.sheetId, el.id, el);
    return el;
  }

  update(sheetId: string, id: string, patch: Partial<DraftElement>): boolean {
    const m = this._bySheet.get(sheetId);
    const existing = m?.get(id);
    if (!existing) return false;
    const updated = { ...existing, ...patch } as DraftElement;
    m!.set(id, updated);
    this._notify();
    _schedSave(sheetId, id, updated);
    return true;
  }

  remove(sheetId: string, id: string): boolean {
    const m = this._bySheet.get(sheetId);
    if (!m?.has(id)) return false;
    m.delete(id);
    this._notify();
    _schedDelete(sheetId, id);
    return true;
  }

  getBySheet(sheetId: string): DraftElement[] {
    const m = this._bySheet.get(sheetId);
    return m ? Array.from(m.values()) : [];
  }

  get(sheetId: string, id: string): DraftElement | undefined {
    return this._bySheet.get(sheetId)?.get(id);
  }

  _restore(items: DraftElement[]): void {
    for (const el of items) {
      this._sheetMap(el.sheetId).set(el.id, el);
    }
    this._notify();
  }
}

export const draftElementStore = new DraftElementStore();

// --- IDB persistence --------------------------------------------------------
//
// Object store: one record per element, keyed by "sheetId:elementId".

const IDB_NAME    = "gemma-draft-elements";
const IDB_STORE   = "elements";
const IDB_VERSION = 1;
let _db: IDBDatabase | null = null;

function _openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = (e) => { _db = (e.target as IDBOpenDBRequest).result; res(_db); };
    req.onerror   = () => rej(req.error);
  });
}

function _idbKey(sheetId: string, elementId: string): string {
  return `${sheetId}:${elementId}`;
}

function _schedSave(sheetId: string, elementId: string, el: DraftElement): void {
  _openDb().then(db => {
    db.transaction(IDB_STORE, "readwrite")
      .objectStore(IDB_STORE)
      .put(el, _idbKey(sheetId, elementId));
  }).catch(() => {/* ignore */});
}

function _schedDelete(sheetId: string, elementId: string): void {
  _openDb().then(db => {
    db.transaction(IDB_STORE, "readwrite")
      .objectStore(IDB_STORE)
      .delete(_idbKey(sheetId, elementId));
  }).catch(() => {/* ignore */});
}

export async function loadDraftElements(): Promise<void> {
  try {
    const db = await _openDb();
    const items = await new Promise<DraftElement[]>((res, rej) => {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll();
      req.onsuccess = () => res((req.result as DraftElement[]) ?? []);
      req.onerror   = () => rej(req.error);
    });
    if (items.length) draftElementStore._restore(items);
  } catch { /* use empty store on error */ }
}
