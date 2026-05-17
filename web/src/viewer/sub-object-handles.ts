// Sub-object handle system for line / polyline / curve (#32).
// When a parent line/polyline/curve is selected, this module renders small
// sphere handles at each control point. Clicking a handle enters sub-object
// mode: the gumball attaches to the handle and dragging it stretches the
// parent geometry through the new control point position.

import * as THREE from "three";
import type { Viewer } from "./viewer.js";
import { createClampedUniformNurbs, createCatmullRomAsNurbs, tessellate } from "../nurbs/nurbs-curves.js";
import { makeSnapId } from "./snap-state.js";

const HANDLE_RADIUS = 0.07;

let _handles: THREE.Mesh[] = [];
let _parentObj: THREE.Object3D | null = null;

function makeHandleMesh(pos: THREE.Vector3, index: number, parentUuid: string): THREE.Mesh {
  const geom = new THREE.SphereGeometry(HANDLE_RADIUS, 10, 7);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2979ff,
    roughness: 0.3,
    metalness: 0.1,
    depthTest: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(pos);
  mesh.renderOrder = 10;
  mesh.userData.isSubObjectHandle = true;
  mesh.userData.cpIndex = index;
  mesh.userData.parentUuid = parentUuid;
  return mesh;
}

export function showHandlesFor(parent: THREE.Object3D, viewer: Viewer): void {
  clearHandles(viewer);
  const cps = parent.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length === 0) return;
  _parentObj = parent;
  for (let i = 0; i < cps.length; i++) {
    const wp = parent.localToWorld(cps[i].clone());
    const h = makeHandleMesh(wp, i, parent.uuid);
    viewer.getScene().add(h);
    _handles.push(h);
  }
}

export function clearHandles(viewer: Viewer): void {
  for (const h of _handles) {
    viewer.getScene().remove(h);
    h.geometry.dispose();
    (h.material as THREE.Material).dispose();
  }
  _handles = [];
  _parentObj = null;
}

export function getHandles(): THREE.Mesh[] { return _handles; }

export function getHandleParent(): THREE.Object3D | null { return _parentObj; }

export function isSubObjectHandle(obj: THREE.Object3D): boolean {
  return !!obj.userData.isSubObjectHandle;
}

// Rebuild the parent mesh's geometry in-place after a control point has moved.
// Works for line (2 CPs), polyline (N CPs), curve/spline (N CPs via B-spline).
export function refitParentGeometry(parent: THREE.Object3D): void {
  const cps = parent.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length < 2) return;
  const creator = parent.userData.creator as string;
  const obj = parent as THREE.Object3D & { geometry?: THREE.BufferGeometry };
  if (!obj.geometry) return;

  let newGeom: THREE.BufferGeometry | null = null;
  if (creator === "line" && cps.length === 2) {
    newGeom = new THREE.BufferGeometry().setFromPoints([cps[0], cps[1]]);
  } else if (creator === "polyline") {
    newGeom = new THREE.BufferGeometry().setFromPoints(cps);
  } else if (creator === "curve") {
    // Curve tool: Catmull-Rom — handle positions ARE the data points.
    const isClosed = !!(parent.userData.isClosed as boolean | undefined);
    const sampleCount = Math.max(cps.length * 16, 64);
    const dataPts = cps.map((v) => ({ x: v.x, y: v.y, z: v.z }));
    const nurbs = createCatmullRomAsNurbs(dataPts, { closed: isClosed });
    const raw = tessellate(nurbs, sampleCount + 1);
    newGeom = new THREE.BufferGeometry().setFromPoints(raw.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
  } else if (creator === "spline") {
    // Spline tool: approximating — handles are NURBS control points (curve pulled toward them).
    const isClosed = !!(parent.userData.isClosed as boolean | undefined);
    const degree = Math.min((parent.userData.nurbsDegree as number | undefined) ?? 3, cps.length - 1);
    const order = degree + 1;
    const wrapped = isClosed && cps.length >= order ? [...cps, ...cps.slice(0, degree)] : cps;
    const nurbsPts = wrapped.map((v) => ({ x: v.x, y: v.y, z: v.z }));
    const nurbs = createClampedUniformNurbs(3, order, nurbsPts);
    const sampleCount = Math.max(cps.length * 16, 64);
    const raw = tessellate(nurbs, sampleCount);
    const sampled = raw.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    if (isClosed && sampled.length > 1) sampled[sampled.length - 1].copy(sampled[0]);
    newGeom = new THREE.BufferGeometry().setFromPoints(sampled);
  }
  if (creator === "wall" && cps.length >= 2) {
    const parentMesh = parent as THREE.Mesh;
    // Convert local-space CPs to world space, then refit geometry + transform.
    const wA = cps[0].clone().applyMatrix4(parent.matrixWorld);
    const wB = cps[1].clone().applyMatrix4(parent.matrixWorld);
    const len = wA.distanceTo(wB);
    if (len < 0.01) return;
    const t = (parent.userData.wallThickness as number | undefined) ?? 0.2;
    const h = (parent.userData.wallHeight as number | undefined) ?? 3;
    const cx = (wA.x + wB.x) / 2, cy = (wA.y + wB.y) / 2;
    const angRad = Math.atan2(wB.y - wA.y, wB.x - wA.x);
    const wallGeom = new THREE.BoxGeometry(len, t, h);
    wallGeom.translate(0, 0, h / 2);
    parentMesh.geometry.dispose();
    parentMesh.geometry = wallGeom;
    parentMesh.position.set(cx, cy, 0);
    parentMesh.rotation.z = angRad;
    parentMesh.updateMatrixWorld(true);
    // Re-anchor CPs in new local space.
    cps[0].set(wA.x - cx, wA.y - cy, 0);
    cps[1].set(wB.x - cx, wB.y - cy, 0);
    // Refresh snap endpoints.
    parentMesh.userData.endpoints = [
      { x: wA.x, y: wA.y, z: 0, id: makeSnapId(wA.x, wA.y, 0) },
      { x: wB.x, y: wB.y, z: 0, id: makeSnapId(wB.x, wB.y, 0) },
      { x: cx, y: cy, z: 0, id: makeSnapId(cx, cy, 0) },
    ];
    return;
  }

  if (!newGeom) return;
  obj.geometry.dispose();
  obj.geometry = newGeom;
}
