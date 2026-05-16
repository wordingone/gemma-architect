// Snap — vertex snap + host-aware placement.

import * as THREE from "three";
import type { Viewer } from "../viewer";
import { getSnap } from "../snap-state";
import { projectToScreen } from "./projection";
import { _lastSurfaceHit, setLastSurfaceHit, _lastSnapEdgeDir, setLastSnapEdgeDir } from "./snap-internal";
export { _lastSurfaceHit, _lastSnapEdgeDir };

// ─── Shared snap internals (re-exported from snap-internal for other modules) ─

// Re-export the mutable state accessors used by other modules.
export { setLastSurfaceHit, setLastSnapEdgeDir };

// ─── Types ────────────────────────────────────────────────────────────────────

export type SnapVertex = { x: number; y: number; z: number; id: string; edgeDir?: THREE.Vector3 };

let _snapTargetInternal: SnapVertex | null = null;
export function getSnapTarget(): SnapVertex | null { return _snapTargetInternal; }
export function setSnapTarget(v: SnapVertex | null): void { _snapTargetInternal = v; }

// ─── Host-aware placement ─────────────────────────────────────────────────────

export const HOST_TOOL_CREATORS: Record<string, string[]> = {
  door:    ["wall"],
  window:  ["wall"],
  opening: ["wall", "slab", "ceiling", "roof"],
};

export let _pendingHostId: string | null = null;
export function setPendingHostId(v: string | null): void { _pendingHostId = v; }

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

// ─── Snap helpers ─────────────────────────────────────────────────────────────

export function makeSnapId(x: number, y: number, z = 0): string {
  return `v:${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
}

export function collectSnapVertices(viewer: Viewer): SnapVertex[] {
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

// Closest point on a 3-D segment [A,B] to the camera ray.
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

// Closest point on axis line (basePt + t*axisDir) to the camera ray.
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

export function nearestSnapVertex(viewer: Viewer, clientX: number, clientY: number): SnapVertex | null {
  setLastSurfaceHit(null);
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
    if (_occHits.length > 0) setLastSurfaceHit(_occHits[0].point.clone());
  }

  // ── 0. Point objects ─────────────────────────────────────────────────────────
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

  // ── 1. Stored endpoint vertices ──────────────────────────────────────────────
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

  // ── 2. Line/curve objects: vertex snap by screen-distance ───────────────────
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
      if ((lineVBest as SnapVertex).edgeDir) setLastSnapEdgeDir((lineVBest as SnapVertex).edgeDir!);
      return lineVBest;
    }
  }

  // ── 3. Geometry raycasting — hits a mesh surface ────────────────────────────
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

  if (snap.edgeSnapOn) {
    let edgeCandidateDir: THREE.Vector3 | null = null;
    for (let i = 0; i < 3; i++) {
      const A = facePts[i], B = facePts[(i + 1) % 3];
      const ep = closestPtOnSegToRay(viewer, clientX, clientY, A, B);
      if (!ep) continue;
      const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < candidateD) {
        candidateD = d;
        candidate = ep;
        edgeCandidateDir = B.clone().sub(A).normalize();
      }
    }
    if (candidate) {
      setLastSnapEdgeDir(edgeCandidateDir);
      return { id: makeSnapId(candidate.x, candidate.y, candidate.z), x: candidate.x, y: candidate.y, z: candidate.z, edgeDir: edgeCandidateDir ?? undefined };
    }
  }

  return null;
}
