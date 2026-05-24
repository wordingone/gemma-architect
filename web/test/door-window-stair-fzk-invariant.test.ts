// #1675 — Engine-determinism Phases 4-6: per-element invariant gates for
// buildDoor(), buildWindow(), and buildStair() against FZK KIT Haus references.
//
// Guards: geometry drift, position regression, userData mutation, sill height.
// Tolerance 1e-3 on all float quantities.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildDoor, buildWindow } from "../src/tools/openings";
import { buildStair } from "../src/tools/structural";
import doorTarget from "./fixtures/fzk-haus-door-target.json";
import windowTarget from "./fixtures/fzk-haus-window-target.json";
import stairTarget from "./fixtures/fzk-haus-stair-target.json";

const TOL = 1e-3;

function geomSize(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
}

// ── Door ──────────────────────────────────────────────────────────────────────

describe("SdDoor FZK invariant gate (#1675)", () => {
  const p = doorTarget.params.p;
  const { mesh } = buildDoor(p) as { mesh: THREE.Mesh; chain: string };
  const inv = doorTarget.invariants;

  test("returns a THREE.Mesh", () => {
    expect(mesh).toBeInstanceOf(THREE.Mesh);
  });

  test("geometry x = DEFAULT_DOOR_W (0.914m / IBC 36\")", () => {
    expect(Math.abs(geomSize(mesh).x - inv.geom_x)).toBeLessThan(TOL);
  });

  test("geometry y = DEFAULT_WALL_THICKNESS (0.2m)", () => {
    expect(Math.abs(geomSize(mesh).y - inv.geom_y)).toBeLessThan(TOL);
  });

  test("geometry z = DEFAULT_DOOR_H (2.032m / IBC 80\")", () => {
    expect(Math.abs(geomSize(mesh).z - inv.geom_z)).toBeLessThan(TOL);
  });

  test("position x = 0 (placement point)", () => {
    expect(Math.abs(mesh.position.x - inv.position_x)).toBeLessThan(TOL);
  });

  test("position y = 0 (placement point)", () => {
    expect(Math.abs(mesh.position.y - inv.position_y)).toBeLessThan(TOL);
  });

  test("position z = 0 (door sits at floor level)", () => {
    expect(Math.abs(mesh.position.z - inv.position_z)).toBeLessThan(TOL);
  });

  test("rotation x = 0", () => {
    expect(Math.abs(mesh.rotation.x - inv.rotation_x)).toBeLessThan(TOL);
  });

  test("rotation y = 0", () => {
    expect(Math.abs(mesh.rotation.y - inv.rotation_y)).toBeLessThan(TOL);
  });

  test("rotation z = 0", () => {
    expect(Math.abs(mesh.rotation.z - inv.rotation_z)).toBeLessThan(TOL);
  });

  test("userData.creator = 'door'", () => {
    expect(mesh.userData.creator).toBe(inv.userData_creator);
  });

  test("userData.kind = 'mesh'", () => {
    expect(mesh.userData.kind).toBe(inv.userData_kind);
  });

  test("userData.voidW = DEFAULT_DOOR_W (0.914m)", () => {
    expect(Math.abs(mesh.userData.voidW - inv.userData_voidW)).toBeLessThan(TOL);
  });

  test("userData.voidH = DEFAULT_DOOR_H (2.032m)", () => {
    expect(Math.abs(mesh.userData.voidH - inv.userData_voidH)).toBeLessThan(TOL);
  });

  test("geometry bottom face at z=0 (frame stiles translated by h/2)", () => {
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    expect(Math.abs(bb.min.z)).toBeLessThan(TOL);
    expect(Math.abs(bb.max.z - inv.geom_z)).toBeLessThan(TOL);
  });
});

// ── Window ────────────────────────────────────────────────────────────────────

describe("SdWindow FZK invariant gate (#1675)", () => {
  const p = windowTarget.params.p;
  const { mesh } = buildWindow(p) as { mesh: THREE.Mesh; chain: string };
  const inv = windowTarget.invariants;

  test("returns a THREE.Mesh", () => {
    expect(mesh).toBeInstanceOf(THREE.Mesh);
  });

  test("geometry x = FZK_WINDOW_W (2.0m)", () => {
    expect(Math.abs(geomSize(mesh).x - inv.geom_x)).toBeLessThan(TOL);
  });

  test("geometry y = DEFAULT_WALL_THICKNESS (0.2m)", () => {
    expect(Math.abs(geomSize(mesh).y - inv.geom_y)).toBeLessThan(TOL);
  });

  test("geometry z = FZK_WINDOW_H (1.2m)", () => {
    expect(Math.abs(geomSize(mesh).z - inv.geom_z)).toBeLessThan(TOL);
  });

  test("position x = 0 (placement point)", () => {
    expect(Math.abs(mesh.position.x - inv.position_x)).toBeLessThan(TOL);
  });

  test("position y = 0 (placement point)", () => {
    expect(Math.abs(mesh.position.y - inv.position_y)).toBeLessThan(TOL);
  });

  test("position z = FZK_WINDOW_SILL (0.8m / IFC Brüstungshöhe #23241)", () => {
    // mesh.position.z = sill: window bottom is lifted to sill height above floor.
    expect(Math.abs(mesh.position.z - inv.position_z)).toBeLessThan(TOL);
  });

  test("rotation x = 0", () => {
    expect(Math.abs(mesh.rotation.x - inv.rotation_x)).toBeLessThan(TOL);
  });

  test("rotation y = 0", () => {
    expect(Math.abs(mesh.rotation.y - inv.rotation_y)).toBeLessThan(TOL);
  });

  test("rotation z = 0", () => {
    expect(Math.abs(mesh.rotation.z - inv.rotation_z)).toBeLessThan(TOL);
  });

  test("userData.creator = 'window'", () => {
    expect(mesh.userData.creator).toBe(inv.userData_creator);
  });

  test("userData.kind = 'mesh'", () => {
    expect(mesh.userData.kind).toBe(inv.userData_kind);
  });

  test("userData.voidW = FZK_WINDOW_W (2.0m)", () => {
    expect(Math.abs(mesh.userData.voidW - inv.userData_voidW)).toBeLessThan(TOL);
  });

  test("userData.voidH = FZK_WINDOW_H (1.2m)", () => {
    expect(Math.abs(mesh.userData.voidH - inv.userData_voidH)).toBeLessThan(TOL);
  });

  test("geometry bottom face at z=0 in local space (frame sill at bottom)", () => {
    // After mergeGeometries, local bbox z_min should be 0; window sits at sill in world space.
    mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox!;
    expect(Math.abs(bb.min.z)).toBeLessThan(TOL);
    expect(Math.abs(bb.max.z - inv.geom_z)).toBeLessThan(TOL);
  });
});

// ── Stair ─────────────────────────────────────────────────────────────────────

describe("SdStair FZK invariant gate (#1675)", () => {
  const { a, b } = stairTarget.params;
  const { group } = buildStair(a, b) as { group: THREE.Group; chain: string };
  const inv = stairTarget.invariants;

  test("returns a THREE.Group", () => {
    expect(group).toBeInstanceOf(THREE.Group);
  });

  test("userData.creator = 'stair'", () => {
    expect(group.userData.creator).toBe(inv.userData_creator);
  });

  test("userData.kind = 'compound'", () => {
    expect(group.userData.kind).toBe(inv.userData_kind);
  });

  test("stairParams.nRisers = 10 (2.794m run / 0.2794m tread)", () => {
    expect(group.userData.stairParams.nRisers).toBe(inv.stairParams_nRisers);
  });

  test("stairParams.stairW = DEFAULT_STAIR_WIDTH (1.0m)", () => {
    expect(Math.abs(group.userData.stairParams.stairW - inv.stairParams_stairW)).toBeLessThan(TOL);
  });

  test("stairParams.totalRise = 10 × 0.1778 = 1.778m (~5'-10\")", () => {
    expect(Math.abs(group.userData.stairParams.totalRise - inv.stairParams_totalRise)).toBeLessThan(TOL);
  });

  test("position x = a.x (0.0)", () => {
    expect(Math.abs(group.position.x - inv.position_x)).toBeLessThan(TOL);
  });

  test("position y = a.y (0.0)", () => {
    expect(Math.abs(group.position.y - inv.position_y)).toBeLessThan(TOL);
  });

  test("position z = 0 (stair at eave level)", () => {
    expect(Math.abs(group.position.z - inv.position_z)).toBeLessThan(TOL);
  });

  test("rotation z = 0 (east direction, atan2(0, 2.794) = 0)", () => {
    expect(Math.abs(group.rotation.z - inv.rotation_z)).toBeLessThan(TOL);
  });

  test("group has at least 1 child (flight solid)", () => {
    expect(group.children.length).toBeGreaterThanOrEqual(inv.children_min);
  });
});
