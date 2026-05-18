// Snap / constrain state singleton.
// Driven by the snap-dock widget in workbench.ts; consumed by tools/index.ts
// (sketch-click quantising) and viewer.ts (gumball drag quantising).
// Extended with vertex snap runtime (#723).

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { getState, subscribe } from "../app-state";
import { gridStore } from "../geometry/grids";
import { projectToScreen } from "./projection";

export interface SnapState {
  snapOn: boolean;          // master toggle — when off, all other snap flags inert
  orthoOn: boolean;         // axis-only constraint (gumball already does this per-handle)
  gridOn: boolean;          // translate snaps to grid step
  polarOn: boolean;         // rotate snaps to angleStep
  vertexSnapOn: boolean;    // snap to mesh/endpoint vertices
  edgeSnapOn: boolean;      // snap to closest point anywhere along edge
  midpointSnapOn: boolean;  // snap to midpoints of edges
  pointSnapOn: boolean;     // snap to placed point objects
  step: number;             // grid step in meters
  angleStep: number;        // polar snap in degrees
}

const _state: SnapState = {
  snapOn: true, orthoOn: false, gridOn: true, polarOn: false,
  vertexSnapOn: true, edgeSnapOn: true, midpointSnapOn: false, pointSnapOn: true,
  step: getState("unitSystem") === "imperial" ? 0.3048 : 1.0, angleStep: 90,
};

export function getSnap(): Readonly<SnapState> { return _state; }
export function getGridOn(): boolean { return _state.gridOn; }

// Subscribers re-render dependent UI / scene helpers when snap state
// changes. The viewer listens to redraw the grid at the new step; the
// statusbar listens to mirror the visible value.
type Listener = (s: Readonly<SnapState>) => void;
const _listeners = new Set<Listener>();
export function subscribeSnap(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
function emit(): void {
  for (const fn of _listeners) fn(_state);
}

export function setGridOn(on: boolean): void { _state.gridOn = on; emit(); }
export function setSnapOn(on: boolean): void { _state.snapOn = on; emit(); }
export function setOrthoOn(on: boolean): void { _state.orthoOn = on; emit(); }
export function setPolarOn(on: boolean): void { _state.polarOn = on; emit(); }
export function setVertexSnapOn(on: boolean): void { _state.vertexSnapOn = on; emit(); }
export function setEdgeSnapOn(on: boolean): void { _state.edgeSnapOn = on; emit(); }
export function setMidpointSnapOn(on: boolean): void { _state.midpointSnapOn = on; emit(); }
export function setPointSnapOn(on: boolean): void { _state.pointSnapOn = on; emit(); }
export function getStep(): number { return _state.step; }
export function setStep(m: number): void { _state.step = Math.max(0.001, m); emit(); }
export function getAngleStep(): number { return _state.angleStep; }
export function setAngleStep(deg: number): void { _state.angleStep = Math.max(0.1, deg); emit(); }

// Reset step to unit-system default when the unit system toggles, but only if
// the user hasn't customized it away from either default.
subscribe("unitSystem", (sys) => {
  if (_state.step === 0.3048 || _state.step === 1.0) {
    setStep(sys === "imperial" ? 0.3048 : 1.0);
  }
});

// ── Vertex snap types and runtime state ──────────────────────────────────────

export type SnapVertex = { x: number; y: number; z: number; id: string; edgeDir?: THREE.Vector3 };

let _snapTarget: SnapVertex | null = null;
export function getSnapTarget(): SnapVertex | null { return _snapTarget; }
export function setSnapTarget(v: SnapVertex | null): void { _snapTarget = v; }

let _lastSnapEdgeDir: THREE.Vector3 | null = null;
export function getLastSnapEdgeDir(): THREE.Vector3 | null { return _lastSnapEdgeDir; }
export function setLastSnapEdgeDir(v: THREE.Vector3 | null): void { _lastSnapEdgeDir = v; }

let _lastSurfaceHit: THREE.Vector3 | null = null;
export function getLastSurfaceHit(): THREE.Vector3 | null { return _lastSurfaceHit; }

// ── Host-aware placement (door / window / opening) ────────────────────────────

export const HOST_TOOL_CREATORS: Record<string, string[]> = {
  door:    ["wall"],
  window:  ["wall"],
  opening: ["wall", "slab", "ceiling", "roof"],
};

let _pendingHostId: string | null = null;
export function getPendingHostId(): string | null { return _pendingHostId; }
export function setPendingHostId(id: string | null): void { _pendingHostId = id; }

export function findHostMesh(
  viewer: Viewer,
  clientX: number,
  clientY: number,
  validCreators: string[],
): THREE.Object3D | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());
  const hits = raycaster.intersectObjects(viewer.getScene().children, true);
  for (const hit of hits) {
    const obj = hit.object;
    const creator = (obj.userData as { creator?: string }).creator ?? "";
    if (validCreators.includes(creator)) return obj;
    const parent = obj.parent;
    if (parent) {
      const parentCreator = (parent.userData as { creator?: string }).creator ?? "";
      if (validCreators.includes(parentCreator)) return parent;
    }
  }
  return null;
}

export function makeSnapId(x: number, y: number, z = 0): string {
  return `v:${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
}

// ── Vertex snap runtime ───────────────────────────────────────────────────────

function collectSnapVertices(viewer: Viewer): SnapVertex[] {
  const scene = viewer.getScene();
  const out: SnapVertex[] = [];
  const seen = new Set<string>();
  scene.traverse((obj) => {
    const eps = (obj.userData as { endpoints?: SnapVertex[] }).endpoints;
    if (!eps) return;
    for (const ep of eps) {
      if (!seen.has(ep.id)) { seen.add(ep.id); out.push(ep); }
    }
  });
  return out;
}

const VERTEX_SNAP_PX = 20;

// Closest point on the axis line (basePt + t*axisDir) to the camera ray.
// Returns null when ray is nearly parallel to the axis (degenerate).
export function unprojectToAxisLine(
  viewer: Viewer, clientX: number, clientY: number,
  basePt: THREE.Vector3, axisDir: THREE.Vector3,
): THREE.Vector3 | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());
  const ro = raycaster.ray.origin.clone();
  const rd = raycaster.ray.direction.clone();
  const w = ro.sub(basePt);
  const b = rd.dot(axisDir);
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-8) return null;
  const t = (b * w.dot(rd) - w.dot(axisDir)) / denom;
  return basePt.clone().addScaledVector(axisDir, t);
}

// Closest point on a 3-D segment [A,B] to the camera ray.
// Returns null when ray and segment are nearly parallel.
export function closestPtOnSegToRay(
  viewer: Viewer, clientX: number, clientY: number,
  A: THREE.Vector3, B: THREE.Vector3,
): THREE.Vector3 | null {
  const segDir = B.clone().sub(A);
  const segLen = segDir.length();
  if (segLen < 1e-9) return null;
  const unit = segDir.clone().divideScalar(segLen);
  const pt = unprojectToAxisLine(viewer, clientX, clientY, A, unit);
  if (!pt) return null;
  const t = Math.max(0, Math.min(segLen, pt.clone().sub(A).dot(unit)));
  return A.clone().addScaledVector(unit, t);
}

export function nearestSnapVertex(viewer: Viewer, clientX: number, clientY: number): SnapVertex | null {
  _lastSurfaceHit = null;
  const snap = getSnap();
  if (!snap.snapOn) return null;

  // ── Occlusion pre-pass ──────────────────────────────────────────────────────
  {
    const _occCanvas = viewer.getCanvas();
    const _occRect = _occCanvas.getBoundingClientRect();
    const _occNdc = new THREE.Vector2(
      ((clientX - _occRect.left) / _occRect.width) * 2 - 1,
      -((clientY - _occRect.top) / _occRect.height) * 2 + 1,
    );
    const _occRay = new THREE.Raycaster();
    _occRay.setFromCamera(_occNdc, viewer.getActiveCamera());
    const _occMeshes: THREE.Mesh[] = [];
    viewer.getScene().traverse((o) => {
      if (o.userData.noSnap) return;
      if (!(o instanceof THREE.Mesh)) return;
      if (!o.geometry || !o.geometry.getAttribute("position")) return;
      _occMeshes.push(o);
    });
    const _occHits = _occRay.intersectObjects(_occMeshes, false);
    if (_occHits.length > 0) _lastSurfaceHit = _occHits[0].point.clone();
  }

  // ── 0. Point objects ────────────────────────────────────────────────────────
  if (snap.pointSnapOn) {
    let ptBest: SnapVertex | null = null;
    let ptBestD = VERTEX_SNAP_PX;
    viewer.getScene().traverse((obj) => {
      if (obj.userData.noSnap) return;
      if (!(obj instanceof THREE.Points) || obj.userData.kind !== "point") return;
      const wp = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
      const sc = projectToScreen(viewer, wp.x, wp.y, wp.z);
      if (!sc) return;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < ptBestD) { ptBestD = d; ptBest = { id: makeSnapId(wp.x, wp.y, wp.z), x: wp.x, y: wp.y, z: wp.z }; }
    });
    if (ptBest) return ptBest;
  }

  const anyGeomSnap = snap.vertexSnapOn || snap.edgeSnapOn || snap.midpointSnapOn;
  if (!anyGeomSnap) return null;

  // ── 1. Stored endpoint vertices ─────────────────────────────────────────────
  if (snap.vertexSnapOn) {
    const verts = collectSnapVertices(viewer);
    let best: SnapVertex | null = null;
    let bestD = VERTEX_SNAP_PX;
    for (const v of verts) {
      const sc = projectToScreen(viewer, v.x, v.y, v.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return best;

    if (snap.midpointSnapOn) {
      const midState = { best: null as THREE.Vector3 | null, bestD: VERTEX_SNAP_PX };
      viewer.getScene().traverse((obj) => {
        const eps = (obj.userData as { endpoints?: SnapVertex[] }).endpoints;
        if (!eps || eps.length < 2) return;
        for (let i = 0; i < eps.length - 1; i++) {
          const a = eps[i], b = eps[i + 1];
          const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
          const sc = projectToScreen(viewer, mid.x, mid.y, mid.z);
          if (!sc) return;
          const d = Math.hypot(sc.x - clientX, sc.y - clientY);
          if (d < midState.bestD) { midState.bestD = d; midState.best = mid; }
        }
      });
      if (midState.best) {
        const v = midState.best;
        return { id: makeSnapId(v.x, v.y, v.z), x: v.x, y: v.y, z: v.z };
      }
    }
  }

  // ── 2. Line/curve vertex + edge snap ────────────────────────────────────────
  const snapExclude = null;
  if (snap.vertexSnapOn || snap.edgeSnapOn) {
    let lineVBest: SnapVertex | null = null;
    let lineVBestD = VERTEX_SNAP_PX;
    viewer.getScene().traverse((obj) => {
      if (obj.userData.noSnap) return;
      if (obj === snapExclude) return;
      if (!(obj instanceof THREE.Line)) return;
      const posAttr = obj.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!posAttr) return;
      const count = posAttr.count;
      for (let i = 0; i < count; i++) {
        const lv = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
        const sc = projectToScreen(viewer, lv.x, lv.y, lv.z);
        if (!sc) continue;
        const d = Math.hypot(sc.x - clientX, sc.y - clientY);
        if (d < lineVBestD) {
          lineVBestD = d;
          lineVBest = { id: makeSnapId(lv.x, lv.y, lv.z), x: lv.x, y: lv.y, z: lv.z };
        }
      }
      if (snap.edgeSnapOn) {
        const looped = obj instanceof THREE.LineLoop;
        for (let i = 0; i < count - (looped ? 0 : 1); i++) {
          const A = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
          const B = new THREE.Vector3().fromBufferAttribute(posAttr, (i + 1) % count).applyMatrix4(obj.matrixWorld);
          const ep = closestPtOnSegToRay(viewer, clientX, clientY, A, B);
          if (!ep) continue;
          const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
          if (!sc) continue;
          const d = Math.hypot(sc.x - clientX, sc.y - clientY);
          if (d < lineVBestD) {
            lineVBestD = d;
            const edgeDir = B.clone().sub(A).normalize();
            lineVBest = { id: makeSnapId(ep.x, ep.y, ep.z), x: ep.x, y: ep.y, z: ep.z, edgeDir };
          }
        }
      }
    });
    if (lineVBest) {
      if ((lineVBest as SnapVertex).edgeDir) _lastSnapEdgeDir = (lineVBest as SnapVertex).edgeDir!;
      return lineVBest;
    }
  }

  // ── 3. Geometry raycasting ───────────────────────────────────────────────────
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());

  const meshes: THREE.Mesh[] = [];
  viewer.getScene().traverse((obj) => {
    if (obj.userData.noSnap) return;
    if (obj === snapExclude) return;
    if (!(obj instanceof THREE.Mesh)) return;
    if (!obj.geometry || !obj.geometry.getAttribute("position")) return;
    meshes.push(obj);
  });

  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  const hit = hits[0];
  if (!hit.face) return null;
  const mesh = hit.object as THREE.Mesh;
  const posAttr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const matW = mesh.matrixWorld;
  const faceIdx = [hit.face.a, hit.face.b, hit.face.c];
  const facePts = faceIdx.map(i => new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(matW));

  let candidate: THREE.Vector3 | null = null;
  let candidateD = VERTEX_SNAP_PX;

  if (snap.vertexSnapOn) {
    for (const fv of facePts) {
      const sc = projectToScreen(viewer, fv.x, fv.y, fv.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < candidateD) { candidateD = d; candidate = fv; }
    }
    if (candidate) return { id: makeSnapId(candidate.x, candidate.y, candidate.z), x: candidate.x, y: candidate.y, z: candidate.z };
  }

  // Face-edge snap intentionally omitted here: mesh faces contain internal
  // triangulation diagonals that are not visible to the user, so snapping to
  // arbitrary face-edge midpoints produces confusing "snaps to unknown location"
  // behaviour. Visible edge snap on Line/curve geometry is handled in section 2.

  return null;
}

// ── Quantise a world-space XY point ─────────────────────────────────────────
// When master snap + grid both on: snaps to the active GridStore grid's
// intersection; falls back to the fixed step when no active grid exists.
// Applies grid origin offset and rotation. Snap radius ~0.15 m.
export function snapPoint(x: number, y: number): { x: number; y: number } {
  if (_state.snapOn && _state.gridOn) {
    const activeGrid = gridStore.getActive();
    // User step always governs precision; active grid provides origin/rotation frame only.
    const s = _state.step;

    if (activeGrid && activeGrid.visible) {
      // Transform point into grid-local space (subtract origin, un-rotate).
      const ox = activeGrid.origin[0], oy = activeGrid.origin[1];
      const cos = Math.cos(-activeGrid.rotation), sin = Math.sin(-activeGrid.rotation);
      const lx = (x - ox) * cos - (y - oy) * sin;
      const ly = (x - ox) * sin + (y - oy) * cos;
      // Snap in grid-local space.
      const snappedLx = Math.round(lx / s) * s;
      const snappedLy = Math.round(ly / s) * s;
      // Transform back to world space.
      const cos2 = Math.cos(activeGrid.rotation), sin2 = Math.sin(activeGrid.rotation);
      return {
        x: ox + snappedLx * cos2 - snappedLy * sin2,
        y: oy + snappedLx * sin2 + snappedLy * cos2,
      };
    }

    return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
  }
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
}
