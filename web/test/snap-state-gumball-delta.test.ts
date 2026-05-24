// Regression-net for gumball-move snap-endpoint delta correction.
// Each builder stores _snapCreationPos at construction time; when mesh.position
// changes (Gumball move), collectSnapVertices applies the delta so snap targets
// follow the moved object rather than the stale creation position.
//
// 12 surfaces: 7 sketch + 3 structural + 2 datum line builders.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { collectSnapVertices, makeSnapId } from "../src/viewer/snap-state";
import type { Viewer } from "../src/viewer/viewer";
import { buildRect, buildCircle, buildArc, buildLine, buildPolygon, buildPolyline, buildCurve } from "../src/tools/sketch";
import { buildSlab, buildColumn, buildBeam, buildGridLine, buildReferenceLine } from "../src/tools/structural";

const TOL = 1e-3;

function fakeViewer(scene: THREE.Scene): Viewer {
  return { getScene: () => scene } as unknown as Viewer;
}

function sceneWith(mesh: THREE.Object3D): THREE.Scene {
  const s = new THREE.Scene();
  s.add(mesh);
  return s;
}

function assertEndpointAt(eps: ReturnType<typeof collectSnapVertices>, x: number, y: number, z = 0): void {
  const id = makeSnapId(x, y, z);
  const found = eps.find((e) => Math.abs(e.x - x) < TOL && Math.abs(e.y - y) < TOL && Math.abs(e.z - z) < TOL);
  expect(found, `endpoint at (${x},${y},${z}) id=${id}`).toBeTruthy();
}

function assertNoEndpointAt(eps: ReturnType<typeof collectSnapVertices>, x: number, y: number, z = 0): void {
  const found = eps.find((e) => Math.abs(e.x - x) < TOL && Math.abs(e.y - y) < TOL && Math.abs(e.z - z) < TOL);
  expect(found, `stale endpoint (${x},${y},${z}) should not appear after move`).toBeUndefined();
}

const MOVE = { x: 3, y: 4, z: 0 };

describe("snap-state gumball-delta correction", () => {
  test("rect: endpoints follow gumball move", () => {
    const { mesh } = buildRect({ x: 0, y: 0 }, { x: 2, y: 2 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    // Before move: corner at (0,0)
    assertEndpointAt(collectSnapVertices(v), 0, 0);
    // After move: mesh.position shifts by MOVE
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    // Moved corner: (0+3, 0+4) = (3,4)
    assertEndpointAt(after, 3, 4);
    // Stale corner should be gone
    assertNoEndpointAt(after, 0, 0);
  });

  test("circle: endpoints follow gumball move", () => {
    const { mesh } = buildCircle({ x: 1, y: 1 }, { x: 2, y: 1 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    const before = collectSnapVertices(v);
    expect(before.length).toBeGreaterThan(0);
    // All endpoints shift by MOVE
    const refX = before[0].x;
    const refY = before[0].y;
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, refX + MOVE.x, refY + MOVE.y);
    assertNoEndpointAt(after, refX, refY);
  });

  test("arc: endpoints follow gumball move", () => {
    const { mesh } = buildArc({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    const before = collectSnapVertices(v);
    expect(before.length).toBeGreaterThan(0);
    const refX = before[0].x, refY = before[0].y;
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, refX + MOVE.x, refY + MOVE.y);
    assertNoEndpointAt(after, refX, refY);
  });

  test("line: endpoints follow gumball move", () => {
    const { mesh } = buildLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    // Line centroid at (2,0); creation endpoint at (0,0)
    const before = collectSnapVertices(v);
    const a = before.find((e) => Math.abs(e.x - 0) < TOL && Math.abs(e.y - 0) < TOL);
    expect(a).toBeTruthy();
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, 0 + MOVE.x, 0 + MOVE.y);
    assertNoEndpointAt(after, 0, 0);
  });

  test("polygon: endpoints follow gumball move", () => {
    const { mesh } = buildPolygon({ x: 0, y: 0 }, { x: 2, y: 0 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    const before = collectSnapVertices(v);
    expect(before.length).toBeGreaterThan(0);
    const refX = before[0].x, refY = before[0].y;
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, refX + MOVE.x, refY + MOVE.y);
    assertNoEndpointAt(after, refX, refY);
  });

  test("polyline: endpoints follow gumball move", () => {
    const { mesh } = buildPolyline([{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }]);
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    assertEndpointAt(collectSnapVertices(v), 0, 0);
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, 0 + MOVE.x, 0 + MOVE.y);
    assertNoEndpointAt(after, 0, 0);
  });

  test("curve: endpoints follow gumball move", () => {
    const { mesh } = buildCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]);
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    const before = collectSnapVertices(v);
    expect(before.length).toBeGreaterThan(0);
    const refX = before[0].x, refY = before[0].y;
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, refX + MOVE.x, refY + MOVE.y);
    assertNoEndpointAt(after, refX, refY);
  });

  test("slab: 4 footprint corners follow gumball move", () => {
    const { mesh } = buildSlab({ x: 0, y: 0 }, { x: 4, y: 3 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    // Corner (0,0) present before move
    assertEndpointAt(collectSnapVertices(v), 0, 0);
    assertEndpointAt(collectSnapVertices(v), 4, 0);
    assertEndpointAt(collectSnapVertices(v), 4, 3);
    assertEndpointAt(collectSnapVertices(v), 0, 3);
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, 0 + MOVE.x, 0 + MOVE.y);
    assertEndpointAt(after, 4 + MOVE.x, 0 + MOVE.y);
    assertEndpointAt(after, 4 + MOVE.x, 3 + MOVE.y);
    assertEndpointAt(after, 0 + MOVE.x, 3 + MOVE.y);
    assertNoEndpointAt(after, 0, 0);
  });

  test("column: base-centre endpoint follows gumball move", () => {
    const { mesh } = buildColumn({ x: 1, y: 2 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    assertEndpointAt(collectSnapVertices(v), 1, 2);
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, 1 + MOVE.x, 2 + MOVE.y);
    assertNoEndpointAt(after, 1, 2);
  });

  test("beam: both endpoints follow gumball move", () => {
    const h = 4; // DEFAULT_COLUMN_HEIGHT
    const { mesh } = buildBeam({ x: 0, y: 0 }, { x: 4, y: 0 });
    const scene = sceneWith(mesh);
    const v = fakeViewer(scene);
    assertEndpointAt(collectSnapVertices(v), 0, 0, h);
    assertEndpointAt(collectSnapVertices(v), 4, 0, h);
    mesh.position.x += MOVE.x;
    mesh.position.y += MOVE.y;
    const after = collectSnapVertices(v);
    assertEndpointAt(after, 0 + MOVE.x, 0 + MOVE.y, h);
    assertEndpointAt(after, 4 + MOVE.x, 0 + MOVE.y, h);
    assertNoEndpointAt(after, 0, 0, h);
  });

  test("buildGridLine: _snapCreationPos set (gumball-move delta applicable)", () => {
    const { mesh } = buildGridLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    expect((mesh.userData as { _snapCreationPos?: unknown })._snapCreationPos).toBeTruthy();
  });

  test("buildReferenceLine: _snapCreationPos set (gumball-move delta applicable)", () => {
    const { mesh } = buildReferenceLine({ x: 0, y: 0 }, { x: 4, y: 0 });
    expect((mesh.userData as { _snapCreationPos?: unknown })._snapCreationPos).toBeTruthy();
  });
});
