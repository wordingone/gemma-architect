// Drafting-style line renderer (#173 Gap 2).
//
// Additive overlay: walks any THREE.Object3D root, generates EdgesGeometry
// for every Mesh found, and adds LineSegments as children of those meshes
// so the overlays transform with their parent. Two passes per mesh:
//   - "object" lines at the 30° crease threshold (medium ink)
//   - "silhouette" lines at the 70° threshold (heavy ink)
// EdgesGeometry only emits hard creases and outline edges — co-planar tris
// are skipped — so this matches the bundle's drafting aesthetic out of the box.
//
// linewidth is browser-clamped to 1px on WebGL1 LineBasicMaterial; we
// differentiate the two passes by opacity instead. A future revision can
// swap to three/examples/jsm/lines/Line2 for true thickness, but for the
// visual gap closure this is sufficient.
//
// Designed to land independently of any viewer.ts refactor — no changes
// to viewer.ts required. Wiring after Eli's quad-split PR is a 5-line diff.
//
// Usage:
//   applyDrafting(viewer.getActiveObject()!);   // turn on
//   removeDrafting(viewer.getActiveObject()!);  // turn off

import * as THREE from "three";

const TAG = "__drafting_overlay__";
const TAG_FLAT_BACKUP = "__drafting_material_backup__";

const INK = 0x0e0e10;       // matches bundle --ink
const PAPER = 0xffffff;     // pure white for technical mode
const ANGLE_OBJECT = 30;
const ANGLE_SILHOUETTE = 70;
const OPACITY_OBJECT = 0.55;
const OPACITY_SILHOUETTE = 0.95;

export type DraftingOpts = {
  // When true (default), also flattens MeshStandardMaterial → MeshBasicMaterial
  // with paper-tone fill. Original materials are stashed on userData and
  // restored by removeDrafting.
  flatten?: boolean;
  // Optional override of the ink hex.
  ink?: number;
  // Optional override of the paper-fill hex.
  paper?: number;
};

export function applyDrafting(root: THREE.Object3D, opts: DraftingOpts = {}): void {
  const ink = opts.ink ?? INK;
  const paper = opts.paper ?? PAPER;
  const flatten = opts.flatten !== false;

  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData?.noRenderMode) return;
    if (mesh.userData?.[TAG] === "overlay") return; // skip our own line overlays

    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geom) return;

    // Skip if we already attached overlays.
    let alreadyHas = false;
    mesh.children.forEach((c) => {
      if (c.userData?.[TAG] === "overlay") alreadyHas = true;
    });
    if (alreadyHas) return;

    // Object-line pass — 30° crease threshold.
    const eGeoObj = new THREE.EdgesGeometry(geom, ANGLE_OBJECT);
    const matObj = new THREE.LineBasicMaterial({
      color: ink,
      linewidth: 1,
      opacity: OPACITY_OBJECT,
      transparent: true,
      depthWrite: false,
    });
    const linesObj = new THREE.LineSegments(eGeoObj, matObj);
    linesObj.userData[TAG] = "overlay";
    linesObj.renderOrder = 1; // above shaded fill
    mesh.add(linesObj);

    // Silhouette pass — 70° threshold (heavier creases / hard breaks).
    const eGeoSil = new THREE.EdgesGeometry(geom, ANGLE_SILHOUETTE);
    const matSil = new THREE.LineBasicMaterial({
      color: ink,
      linewidth: 1,
      opacity: OPACITY_SILHOUETTE,
      transparent: true,
      depthWrite: false,
    });
    const linesSil = new THREE.LineSegments(eGeoSil, matSil);
    linesSil.userData[TAG] = "overlay";
    linesSil.renderOrder = 2;
    mesh.add(linesSil);

    if (flatten) {
      const original = mesh.material;
      mesh.userData[TAG_FLAT_BACKUP] = original;
      const flat = new THREE.MeshBasicMaterial({
        color: paper,
        transparent: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      mesh.material = flat;
    }
  });
}

export function removeDrafting(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;

    // Remove overlay children.
    const toRemove: THREE.Object3D[] = [];
    mesh.children.forEach((c) => {
      if (c.userData?.[TAG] === "overlay") toRemove.push(c);
    });
    for (const c of toRemove) {
      mesh.remove(c);
      const ls = c as THREE.LineSegments;
      ls.geometry?.dispose();
      const m = ls.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else if (m) (m as THREE.Material).dispose();
    }

    // Restore original material if we flattened.
    const backup = mesh.userData[TAG_FLAT_BACKUP];
    if (backup) {
      const flat = mesh.material;
      if (Array.isArray(flat)) flat.forEach((m) => m.dispose());
      else if (flat) (flat as THREE.Material).dispose();
      mesh.material = backup;
      delete mesh.userData[TAG_FLAT_BACKUP];
    }
  });
}

// Convenience — read the toggle state of a root (true = drafting applied).
export function isDrafting(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((child) => {
    if (found) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.children.forEach((c) => {
      if (c.userData?.[TAG] === "overlay") found = true;
    });
  });
  return found;
}
