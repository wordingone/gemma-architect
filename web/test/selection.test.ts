// Selection (T3) acceptance tests.
//
// Strategy: build a deterministic Three.js scene via the Viewer's helper
// graph builders directly (we can't spin up a real WebGL renderer under bun
// without a DOM/canvas), then exercise pickRay() with hand-aimed rays that
// hit known features (corners, faces). Tests verify topology + filter
// behavior end-to-end without needing real cursor events.

import { describe, test, expect, beforeEach } from "bun:test";
import * as THREE from "three";
import {
  resetSelectionState,
  resetFilters,
  getSelected,
  setFilter,
  getFilters,
} from "../src/viewer/selection-state";
import { makeTestViewer, addBoxBrep } from "./test-helpers";

beforeEach(() => {
  resetSelectionState();
  resetFilters();
});

describe("Phase 1 — 7-topology selection + filters + Ctrl+Shift drill-down", () => {
  test("vertex pick on brep with Points filter ON", () => {
    const v = makeTestViewer();
    // Wall-shaped brep at origin, base z=0 per tier1-conventions.
    const wall = addBoxBrep(v, 6, 0.2, 3); // x=[-3,3] y=[-0.1,0.1] z=[0,3]
    // Aim a ray straight at the (3, 0.1, 3) corner from the +Y +X +Z direction.
    const corner = new THREE.Vector3(3, 0.1, 3);
    const dir = new THREE.Vector3(-1, -1, -1).normalize();
    const origin = corner.clone().sub(dir.clone().multiplyScalar(2));
    const sel = v.pickRay(origin, dir);
    expect(sel).not.toBeNull();
    expect(sel!.topology).toBe("vertex");
    expect(sel!.parentUuid).toBe(wall.uuid);
  });

  test("Ctrl+Shift+click on brep returns face sub-object", () => {
    const v = makeTestViewer();
    const wall = addBoxBrep(v, 6, 0.2, 3);
    // Disable Points so vertex sprites near the surface don't intercept.
    setFilter("Points", false);
    setFilter("Curves", false);
    // Aim at the face center (top face at z=3).
    const origin = new THREE.Vector3(0, 0, 10);
    const dir = new THREE.Vector3(0, 0, -1);
    const sel = v.pickRay(origin, dir, { drilldown: true });
    expect(sel).not.toBeNull();
    expect(sel!.topology).toBe("face");
    expect(sel!.parentUuid).toBe(wall.uuid);
    expect(sel!.faceIndex).toBeGreaterThanOrEqual(0);
  });

  test("Default click on brep returns full brep (no drilldown)", () => {
    const v = makeTestViewer();
    const wall = addBoxBrep(v, 6, 0.2, 3);
    setFilter("Points", false);
    setFilter("Curves", false);
    const origin = new THREE.Vector3(0, 0, 10);
    const dir = new THREE.Vector3(0, 0, -1);
    const sel = v.pickRay(origin, dir, { drilldown: false });
    expect(sel).not.toBeNull();
    expect(sel!.topology).toBe("brep");
    expect(sel!.uuid).toBe(wall.uuid);
  });

  test("Points filter OFF prevents vertex hit (falls through to face)", () => {
    const v = makeTestViewer();
    const wall = addBoxBrep(v, 6, 0.2, 3);
    setFilter("Points", false);
    setFilter("Curves", false);
    const corner = new THREE.Vector3(3, 0.1, 3);
    const dir = new THREE.Vector3(-1, -1, -1).normalize();
    const origin = corner.clone().sub(dir.clone().multiplyScalar(2));
    const sel = v.pickRay(origin, dir);
    expect(sel).not.toBeNull();
    expect(sel!.topology).not.toBe("vertex");
    // Should still hit the wall (as brep/mesh/face), not nothing.
    expect(sel!.uuid === wall.uuid || sel!.parentUuid === wall.uuid).toBe(true);
  });

  test("Polysurfaces OFF + Surfaces ON falls through to face", () => {
    const v = makeTestViewer();
    const wall = addBoxBrep(v, 6, 0.2, 3);
    setFilter("Points", false);
    setFilter("Curves", false);
    setFilter("Polysurfaces", false);
    setFilter("Surfaces", true);
    const origin = new THREE.Vector3(0, 0, 10);
    const dir = new THREE.Vector3(0, 0, -1);
    const sel = v.pickRay(origin, dir, { drilldown: false });
    expect(sel).not.toBeNull();
    expect(sel!.topology).toBe("face");
    expect(sel!.parentUuid).toBe(wall.uuid);
  });

  test("Selection persists in selection-state singleton", () => {
    const v = makeTestViewer();
    const wall = addBoxBrep(v, 6, 0.2, 3);
    setFilter("Points", false);
    setFilter("Curves", false);
    const origin = new THREE.Vector3(0, 0, 10);
    const dir = new THREE.Vector3(0, 0, -1);
    v.pickRay(origin, dir);
    const stored = getSelected();
    expect(stored).not.toBeNull();
    expect(stored!.uuid).toBe(wall.uuid);
  });

  test("Default filters: Points/Curves/Surfaces/Polysurfaces/Meshes/Annotations/Blocks ON, Lights OFF", () => {
    resetFilters();
    const f = getFilters();
    expect(f.Points).toBe(true);
    expect(f.Curves).toBe(true);
    expect(f.Surfaces).toBe(true);
    expect(f.Polysurfaces).toBe(true);
    expect(f.Meshes).toBe(true);
    expect(f.Annotations).toBe(true);
    expect(f.Lights).toBe(false);
    expect(f.Blocks).toBe(true);
  });
});
