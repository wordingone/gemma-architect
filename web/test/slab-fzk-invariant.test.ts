// #1675 — Engine-determinism Phase 3 SLAB: per-element invariant gate.
// Pins buildSlab() output against FZK KIT Haus reference geometry:
// 12×10m footprint, DEFAULT_SLAB_THICKNESS=0.1m (IBC 4" residential floor).
//
// Guards: geometry drift, position regression, zero rotation, userData mutation.
// Tolerance 1e-3 on all float quantities.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildSlab } from "../src/tools/structural";
import target from "./fixtures/fzk-haus-slab-target.json";

const TOL = 1e-3;

function geomSize(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  return bb.getSize(new THREE.Vector3());
}

describe("SdSlab FZK invariant gate (#1675)", () => {
  const { mesh } = buildSlab(target.params.a, target.params.b) as { mesh: THREE.Mesh; chain: string };
  const inv = target.invariants;

  test("returns a THREE.Mesh", () => {
    expect(mesh).toBeInstanceOf(THREE.Mesh);
  });

  test("geometry x = footprint width (12.0m)", () => {
    const sz = geomSize(mesh);
    expect(Math.abs(sz.x - inv.geom_x)).toBeLessThan(TOL);
  });

  test("geometry y = footprint depth (10.0m)", () => {
    const sz = geomSize(mesh);
    expect(Math.abs(sz.y - inv.geom_y)).toBeLessThan(TOL);
  });

  test("geometry z = DEFAULT_SLAB_THICKNESS (0.1m)", () => {
    const sz = geomSize(mesh);
    expect(Math.abs(sz.z - inv.geom_z)).toBeLessThan(TOL);
  });

  test("position x = footprint centre x (0.0m)", () => {
    expect(Math.abs(mesh.position.x - inv.position_x)).toBeLessThan(TOL);
  });

  test("position y = footprint centre y (0.0m)", () => {
    expect(Math.abs(mesh.position.y - inv.position_y)).toBeLessThan(TOL);
  });

  test("position z = 0 (slab sits at origin level)", () => {
    expect(Math.abs(mesh.position.z - inv.position_z)).toBeLessThan(TOL);
  });

  test("rotation x = 0 (flat slab, no tilt)", () => {
    expect(Math.abs(mesh.rotation.x - inv.rotation_x)).toBeLessThan(TOL);
  });

  test("rotation y = 0 (flat slab, no tilt)", () => {
    expect(Math.abs(mesh.rotation.y - inv.rotation_y)).toBeLessThan(TOL);
  });

  test("rotation z = 0 (axis-aligned footprint)", () => {
    expect(Math.abs(mesh.rotation.z - inv.rotation_z)).toBeLessThan(TOL);
  });

  test("userData.creator = 'slab'", () => {
    expect(mesh.userData.creator).toBe(inv.userData_creator);
  });

  test("userData.kind = 'brep'", () => {
    expect(mesh.userData.kind).toBe(inv.userData_kind);
  });

  test("geometry bottom face at z=0 (geom.translate(0,0,t/2) applied)", () => {
    // After geom.translate(0,0,t/2), local bbox z=[0, t] — bottom at z=0, top at t.
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    expect(Math.abs(bb.min.z)).toBeLessThan(TOL);
    expect(Math.abs(bb.max.z - inv.geom_z)).toBeLessThan(TOL);
  });
});
