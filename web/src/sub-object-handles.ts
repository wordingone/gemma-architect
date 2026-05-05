// Sub-object handle system for line / polyline / curve (#32).
// When a parent line/polyline/curve is selected, this module renders small
// sphere handles at each control point. Clicking a handle enters sub-object
// mode: the gumball attaches to the handle and dragging it stretches the
// parent geometry through the new control point position.

import * as THREE from "three";
import type { Viewer } from "./viewer.js";

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
    const h = makeHandleMesh(cps[i].clone(), i, parent.uuid);
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
// Works for line (2 CPs), polyline (N CPs), curve (N CPs via CatmullRom).
export function refitParentGeometry(parent: THREE.Object3D): void {
  const cps = parent.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length < 2) return;
  const creator = parent.userData.creator as string;
  const mesh = parent as THREE.Mesh;
  if (!("geometry" in mesh)) return;

  let newGeom: THREE.BufferGeometry | null = null;
  if (creator === "line" && cps.length === 2) {
    const curve = new THREE.LineCurve3(cps[0], cps[1]);
    newGeom = new THREE.TubeGeometry(curve, 1, 0.012, 6, false);
  } else if (creator === "polyline") {
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < cps.length - 1; i++) {
      path.add(new THREE.LineCurve3(cps[i], cps[i + 1]));
    }
    const segments = Math.max(1, (cps.length - 1) * 4);
    newGeom = new THREE.TubeGeometry(path, segments, 0.012, 6, false);
  } else if (creator === "curve") {
    const curve = new THREE.CatmullRomCurve3(cps, false, "catmullrom", 0.5);
    newGeom = new THREE.TubeGeometry(curve, cps.length * 8, 0.012, 6, false);
  }
  if (!newGeom) return;
  mesh.geometry.dispose();
  mesh.geometry = newGeom;
}
