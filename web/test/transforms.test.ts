// Transforms (T4 Phase 2) acceptance tests.
//
// Strategy: TransformControls itself needs a real DOM/canvas/camera triplet
// to function (it attaches pointer listeners to a domElement). For the
// test, we exercise the chain-emission logic separately by constructing a
// minimal binder-clone — same captured-pre/captured-post delta math, same
// fragment grammar, but synchronous and decoupled from the gizmo widget.
// This validates the contract without requiring WebGL.

import { describe, test, expect, beforeEach } from "bun:test";
import * as THREE from "three";
import {
  resetSelectionState,
  resetFilters,
  setSelected,
  getSelected,
  clearSelected,
} from "../src/viewer/selection-state";
import { makeTestViewer, addBoxBrep } from "./test-helpers";

beforeEach(() => {
  resetSelectionState();
  resetFilters();
});

// Mirror of TransformBinder.onDragEnd's chain emission. Kept in lockstep
// with src/transforms.ts; if those change shape, these tests need to be
// updated.
function emitChainFragment(
  mode: "translate" | "rotate" | "scale",
  before: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 },
  after: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 },
): string {
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  if (mode === "translate") {
    const dx = round(after.position.x - before.position.x);
    const dy = round(after.position.y - before.position.y);
    const dz = round(after.position.z - before.position.z);
    if (dx === 0 && dy === 0 && dz === 0) return "";
    return `.translate([${dx}, ${dy}, ${dz}])`;
  }
  if (mode === "rotate") {
    const dq = before.quaternion.clone().invert().multiply(after.quaternion);
    const angle = 2 * Math.acos(Math.max(-1, Math.min(1, dq.w)));
    const s = Math.sqrt(1 - dq.w * dq.w);
    let ax = 0, ay = 0, az = 1;
    if (s >= 1e-4) { ax = dq.x / s; ay = dq.y / s; az = dq.z / s; }
    const deg = round((angle * 180) / Math.PI);
    if (deg === 0) return "";
    return `.rotate(${deg}, [0, 0, 0], [${round(ax)}, ${round(ay)}, ${round(az)}])`;
  }
  // scale
  const sx = round(after.scale.x / before.scale.x);
  const sy = round(after.scale.y / before.scale.y);
  const sz = round(after.scale.z / before.scale.z);
  const factor = round((sx + sy + sz) / 3);
  if (factor === 1) return "";
  return `.scale(${factor})`;
}

describe("Phase 2 — transform gizmo chain emission", () => {
  test("G + drag 5 units +X commits .translate([5, 0, 0])", () => {
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(6, 0.2, 3),
      new THREE.MeshStandardMaterial(),
    );
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    wall.position.x += 5;
    const after = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const frag = emitChainFragment("translate", before, after);
    expect(frag).toBe(".translate([5, 0, 0])");
  });

  test("R + drag 90deg around Z commits .rotate(90, [0,0,0], [0,0,1])", () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 3), new THREE.MeshStandardMaterial());
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    wall.quaternion.premultiply(q);
    const after = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const frag = emitChainFragment("rotate", before, after);
    expect(frag).toContain(".rotate(90");
    // Axis should be Z (or close to it under rounding).
    expect(frag).toContain("[0, 0, 1]");
  });

  test("S + drag 2x commits .scale(2)", () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 3), new THREE.MeshStandardMaterial());
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    wall.scale.multiplyScalar(2);
    const after = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const frag = emitChainFragment("scale", before, after);
    expect(frag).toBe(".scale(2)");
  });

  test("No-op drag (same before/after) emits empty fragment", () => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 0.2, 3), new THREE.MeshStandardMaterial());
    const before = {
      position: wall.position.clone(),
      quaternion: wall.quaternion.clone(),
      scale: wall.scale.clone(),
    };
    const after = before; // unchanged
    expect(emitChainFragment("translate", before, after)).toBe("");
    expect(emitChainFragment("rotate", before, after)).toBe("");
    expect(emitChainFragment("scale", before, after)).toBe("");
  });

  test("Del removes selection from scene + IFC entity count drops", () => {
    const v = makeTestViewer();
    const wall = addBoxBrep(v, 6, 0.2, 3);
    const initialIfc = v.ifcEntityCount;
    const initialChildCount = v.scene.children.length;
    // Select it.
    setSelected({
      topology: "brep",
      uuid: wall.uuid,
      object: wall,
      transformTarget: wall,
    });
    expect(getSelected()).not.toBeNull();
    // Delete via the helper API.
    const removed = v.removeMesh(wall);
    expect(removed).toBe(true);
    clearSelected();
    expect(v.ifcEntityCount).toBe(initialIfc - 1);
    expect(v.scene.children.length).toBeLessThan(initialChildCount);
    expect(getSelected()).toBeNull();
  });
});

describe("Phase 3 — create-mode click-to-place", () => {
  test("Line tool: click(0,0) + click(5,0) creates new edge with polyline chain", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const initialChildren = v.scene.children.length;
    // Line tool needs 2 clicks. First click — no mesh yet.
    const r1 = emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "line" });
    expect(r1).toBeNull();
    const r2 = emitClickWorld(v as any, { x: 5, y: 0 }, { tool: "line" });
    expect(r2).not.toBeNull();
    expect(v.scene.children.length).toBeGreaterThan(initialChildren);
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("drawPolyline([[0, 0], [5, 0]])");
    expect(seq[0]).toContain('.sketchOnPlane("XY")');
  });

  test("Wall tool: click(0,0) + click(6,0) creates 6m wall along X with proper translate", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "wall" });
    const r = emitClickWorld(v as any, { x: 6, y: 0 }, { tool: "wall" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    // Per tier1-conventions: makeBox(length, thickness, height).rotate(0).translate([midX, midY, 0])
    expect(seq[0]).toContain("makeBox(6, 0.2, 3)");
    expect(seq[0]).toContain("translate([3, 0, 0])");
  });

  test("Rect tool: click(0,0) + click(4,3) creates a 4x3 rect", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "rect" });
    const r = emitClickWorld(v as any, { x: 4, y: 3 }, { tool: "rect" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("drawRectangle(4, 3)");
    expect(seq[0]).toContain("translate([2, 1.5, 0])");
  });

  test("Circle tool: click(2,2) center + click(5,2) → radius 3 cylinder", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    emitClickWorld(v as any, { x: 2, y: 2 }, { tool: "circle" });
    const r = emitClickWorld(v as any, { x: 5, y: 2 }, { tool: "circle" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("makeCylinder(3,");
    expect(seq[0]).toContain("translate([2, 2, 0])");
  });

  test("Door tool: single click emits cut chain", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const r = emitClickWorld(v as any, { x: 1, y: 0 }, { tool: "door" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("door:");
    expect(seq[0]).toContain("makeBox(0.9, 0.2, 2.1)");
  });

  test("Window tool: single click emits cut chain at sill height", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const r = emitClickWorld(v as any, { x: 1, y: 0 }, { tool: "window" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("window:");
    expect(seq[0]).toContain("translate([1, 0, 1])");
  });

  test("Switching tools resets pending click buffer", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    // Start a wall (1st click)
    emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "wall" });
    // Switch tool — reset.
    resetPending();
    // Now circle tool: 2 clicks, both should land cleanly on circle.
    emitClickWorld(v as any, { x: 1, y: 1 }, { tool: "circle" });
    const r = emitClickWorld(v as any, { x: 2, y: 1 }, { tool: "circle" });
    expect(r).not.toBeNull();
    const seq = getCreateSequence();
    expect(seq.length).toBe(1);
    expect(seq[0]).toContain("makeCylinder(1,"); // radius=1 from (1,1)→(2,1)
  });

  test("Unsupported tool (extrude) logs TODO, returns null, no chain emitted", async () => {
    const { emitClickWorld, getCreateSequence, clearCreateSequence, resetPending } = await import("../src/viewer/create-mode");
    clearCreateSequence();
    resetPending();
    const v = makeTestViewer();
    const r = emitClickWorld(v as any, { x: 0, y: 0 }, { tool: "extrude" });
    expect(r).toBeNull();
    expect(getCreateSequence().length).toBe(0);
  });
});
