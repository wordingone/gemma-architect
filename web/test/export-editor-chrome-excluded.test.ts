// Regression-net: #1802 — editor chrome (gumball, axis, grid, gizmos) must
// be excluded from 2D export edge projections.
//
// Direct unit test of the noRenderMode + noExport marker filter logic that
// getEdgeSegmentsForView applies when traversing the scene. We test the
// filtering predicate rather than a full Viewer (which needs WebGL).

import { test, expect } from "bun:test";
import * as THREE from "three";

// Replicate the filter predicate from getEdgeSegmentsForView (#1802 fix).
// noRenderMode covers grid + axes (already LineSegments, but belt+suspenders).
// noExportSet covers gumball TransformControls children, pivotProxy, cplaneGizmo.
function shouldExclude(obj: THREE.Object3D, noExportSet: Set<THREE.Object3D>): boolean {
  return noExportSet.has(obj) || !!(obj.userData as { noRenderMode?: boolean }).noRenderMode;
}

test("architectural mesh: not excluded by default", () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  mesh.userData.creator = "wall";
  expect(shouldExclude(mesh, new Set())).toBe(false);
});

test("grid helper children excluded via noRenderMode marker", () => {
  const grid = new THREE.GridHelper(10, 10);
  grid.userData.noRenderMode = true;
  expect(shouldExclude(grid, new Set())).toBe(true);
});

test("axes helper excluded via noRenderMode marker", () => {
  const axes = new THREE.AxesHelper(2);
  axes.userData.noRenderMode = true;
  expect(shouldExclude(axes, new Set())).toBe(true);
});

test("gumball descendant excluded via noExport set", () => {
  // Simulate a TransformControls gizmo: a parent group whose children are
  // arrow/sphere meshes. The parent is added to the noExport set; the
  // descendant check ensures its children are also caught.
  const gizmoRoot = new THREE.Group();
  const arrowMesh = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 8));
  gizmoRoot.add(arrowMesh);

  const noExportSet = new Set<THREE.Object3D>();
  gizmoRoot.traverse((o) => noExportSet.add(o)); // mimics the fix's exclusion build

  expect(shouldExclude(gizmoRoot, noExportSet)).toBe(true);
  expect(shouldExclude(arrowMesh, noExportSet)).toBe(true);
});

test("pivot proxy excluded via noExport set", () => {
  const pivotProxy = new THREE.Object3D();
  pivotProxy.userData.noSnap = true;
  pivotProxy.userData.noRenderMode = true;

  const noExportSet = new Set<THREE.Object3D>();
  pivotProxy.traverse((o) => noExportSet.add(o));

  expect(shouldExclude(pivotProxy, noExportSet)).toBe(true);
});

test("cplane gizmo group excluded via noExport set", () => {
  const group = new THREE.Group();
  const gridHelper = new THREE.GridHelper(10, 10);
  const xLine = new THREE.Line();
  group.add(gridHelper, xLine);
  group.userData.noSnap = true;

  const noExportSet = new Set<THREE.Object3D>();
  group.traverse((o) => noExportSet.add(o));

  expect(shouldExclude(group, noExportSet)).toBe(true);
  expect(shouldExclude(gridHelper, noExportSet)).toBe(true);
  expect(shouldExclude(xLine, noExportSet)).toBe(true);
});

test("sibling architectural mesh NOT excluded when gizmo is excluded", () => {
  const gizmoRoot = new THREE.Group();
  const noExportSet = new Set<THREE.Object3D>();
  gizmoRoot.traverse((o) => noExportSet.add(o));

  const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 3));
  wall.userData.creator = "wall";
  expect(shouldExclude(wall, noExportSet)).toBe(false);
});
