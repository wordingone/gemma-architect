// Sub-object handle system for line / polyline / curve (#32).
// When a parent line/polyline/curve is selected, this module renders small
// sphere handles at each control point. Clicking a handle enters sub-object
// mode: the gumball attaches to the handle and dragging it stretches the
// parent geometry through the new control point position.

import * as THREE from "three";
import type { Viewer } from "./viewer.js";
import { createClampedUniformNurbs, createCatmullRomAsNurbs, tessellate } from "../nurbs/nurbs-curves.js";
import { makeSnapId } from "./snap-state.js";

const HANDLE_RADIUS = 0.06;

let _handles: THREE.Object3D[] = [];
let _parentObj: THREE.Object3D | null = null;

// Returns a group: outer dark sphere (outline) + inner white sphere (fill),
// matching the sketch cursor-dot visual (black outline + white fill).
function makeHandleMesh(pos: THREE.Vector3, index: number, parentUuid: string): THREE.Object3D {
  const group = new THREE.Group();
  group.position.copy(pos);
  group.renderOrder = 10;
  group.userData.isSubObjectHandle = true;
  group.userData.cpIndex = index;
  group.userData.parentUuid = parentUuid;

  const outerGeom = new THREE.SphereGeometry(HANDLE_RADIUS * 1.5, 10, 7);
  const outerMat = new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false });
  const outerMesh = new THREE.Mesh(outerGeom, outerMat);
  outerMesh.renderOrder = 10;

  const innerGeom = new THREE.SphereGeometry(HANDLE_RADIUS, 10, 7);
  const innerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const innerMesh = new THREE.Mesh(innerGeom, innerMat);
  innerMesh.renderOrder = 11;

  group.add(outerMesh, innerMesh);
  return group;
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
    h.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    });
  }
  _handles = [];
  _parentObj = null;
}

export function getHandles(): THREE.Object3D[] { return _handles; }

export function getHandleParent(): THREE.Object3D | null { return _parentObj; }

export function isSubObjectHandle(obj: THREE.Object3D): boolean {
  return !!obj.userData.isSubObjectHandle;
}

// Rebuild the parent mesh's geometry in-place after a control point has moved.
// Works for line (2 CPs), polyline (N CPs), curve/spline (N CPs via B-spline),
// and wall Mesh/Group (Group = void-cut wall: only transform updates, no segment rebuild).
export function refitParentGeometry(parent: THREE.Object3D): void {
  const cps = parent.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length < 2) return;
  const creator = parent.userData.creator as string;

  // Wall branch — handled before the geometry guard so Group (void-cut) walls work too.
  if (creator === "wall" && cps.length >= 2) {
    const t = (parent.userData.wallThickness as number | undefined) ?? 0.2;
    const h = (parent.userData.wallHeight as number | undefined) ?? 3;
    parent.updateMatrixWorld(true);
    const wA = cps[0].clone().applyMatrix4(parent.matrixWorld);
    const wB = cps[1].clone().applyMatrix4(parent.matrixWorld);
    const len = wA.distanceTo(wB);
    if (len < 0.01) return;
    const cx = (wA.x + wB.x) / 2, cy = (wA.y + wB.y) / 2;
    const angRad = Math.atan2(wB.y - wA.y, wB.x - wA.x);
    if (parent instanceof THREE.Mesh) {
      const wallGeom = new THREE.BoxGeometry(len, t, h);
      wallGeom.translate(0, 0, h / 2);
      parent.geometry.dispose();
      parent.geometry = wallGeom;
    }
    // Both Mesh and Group: update transform + snap data.
    parent.position.set(cx, cy, 0);
    parent.rotation.z = angRad;
    parent.updateMatrixWorld(true);
    cps[0].set(-len / 2, 0, 0);
    cps[1].set(len / 2, 0, 0);
    parent.userData.endpoints = [
      { x: wA.x, y: wA.y, z: 0, id: makeSnapId(wA.x, wA.y, 0) },
      { x: wB.x, y: wB.y, z: 0, id: makeSnapId(wB.x, wB.y, 0) },
    ];
    return;
  }

  // Non-wall curves: require a geometry object.
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

  if (!newGeom) return;
  obj.geometry.dispose();
  obj.geometry = newGeom;
}
