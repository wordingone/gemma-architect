// #1675 — Engine-determinism Phase 2 WALLS: per-element invariant gate.
// Pins buildWall() output against FZK KIT Haus reference geometry:
// 12×10m exterior wall envelope, default height=3m, default thickness=0.2m.
//
// Guards: geometry drift, position regression, rotation mismatch, userData mutation.
// Tolerance 1e-3 on all float quantities.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildWall } from "../src/tools/structural";
import target from "./fixtures/fzk-haus-wall-target.json";

const TOL = 1e-3;

function geomSize(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  return bb.getSize(new THREE.Vector3());
}

const WALLS = target.params.walls as Array<{
  id: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
}>;

describe("SdWall FZK invariant gate (#1675)", () => {
  // Build all 4 walls once; share across tests.
  const built = Object.fromEntries(
    WALLS.map((w) => [w.id, buildWall(w.a, w.b)]),
  );

  for (const w of WALLS) {
    const inv = target.invariants[w.id as keyof typeof target.invariants];
    const mesh = built[w.id].mesh as THREE.Mesh;

    describe(`wall: ${w.id}`, () => {
      test("geometry x = wall length", () => {
        const sz = geomSize(mesh);
        expect(Math.abs(sz.x - inv.geom_x)).toBeLessThan(TOL);
      });

      test("geometry y = DEFAULT_WALL_THICKNESS (0.2m)", () => {
        const sz = geomSize(mesh);
        expect(Math.abs(sz.y - inv.geom_y)).toBeLessThan(TOL);
      });

      test("geometry z = DEFAULT_WALL_HEIGHT (3.0m)", () => {
        const sz = geomSize(mesh);
        expect(Math.abs(sz.z - inv.geom_z)).toBeLessThan(TOL);
      });

      test("position x = endpoint midpoint x", () => {
        expect(Math.abs(mesh.position.x - inv.position_x)).toBeLessThan(TOL);
      });

      test("position y = endpoint midpoint y", () => {
        expect(Math.abs(mesh.position.y - inv.position_y)).toBeLessThan(TOL);
      });

      test("position z = 0 (wall sits at eave level)", () => {
        expect(Math.abs(mesh.position.z - inv.position_z)).toBeLessThan(TOL);
      });

      test("rotation z = atan2(dy, dx) deg", () => {
        const actualDeg = (mesh.rotation.z * 180) / Math.PI;
        // Normalize both to [-180,180] before comparing (handles ±180° equivalence)
        const normalise = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
        expect(Math.abs(normalise(actualDeg) - normalise(inv.rotation_z_deg))).toBeLessThan(
          TOL,
        );
      });

      test("userData.creator = 'wall'", () => {
        expect(mesh.userData.creator).toBe(inv.userData_creator);
      });

      test("userData.wallThickness = 0.2", () => {
        expect(Math.abs(mesh.userData.wallThickness - inv.userData_wallThickness)).toBeLessThan(
          TOL,
        );
      });

      test("userData.wallHeight = 3.0", () => {
        expect(Math.abs(mesh.userData.wallHeight - inv.userData_wallHeight)).toBeLessThan(TOL);
      });
    });
  }

  // Cross-wall: all 4 built without error and returned valid meshes
  test("all 4 exterior walls build without throwing", () => {
    for (const w of WALLS) {
      expect(built[w.id].mesh).toBeInstanceOf(THREE.Mesh);
    }
  });

  // Cross-wall: unique positions (no two walls at the same midpoint)
  test("all 4 wall midpoints are distinct (no degenerate overlap)", () => {
    const positions = WALLS.map((w) => built[w.id].mesh.position);
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const d = positions[i].distanceTo(positions[j]);
        expect(d).toBeGreaterThan(TOL);
      }
    }
  });
});
