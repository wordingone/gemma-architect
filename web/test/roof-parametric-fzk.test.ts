// #1640 — Programmatic gate: SdRoof pitched builder IfcSlab "Dach" bbox.
// Verifies that the 150mm slope deck has slope-like world dimensions (not flat board).
// Reference: FZK-Haus CDP dump 2026-05-23 (fixtures/fzk-roof-reference.json).
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildRoof } from "../src/tools/structural";

// World-space bounding box SIZE of a mesh, accounting for rotation + position.
// Returns size vector (width, height, depth) after all transforms applied.
function worldBBoxSize(mesh: THREE.Mesh): THREE.Vector3 {
  mesh.geometry.computeBoundingBox();
  const local = mesh.geometry.boundingBox!;
  const rot = new THREE.Matrix4().makeRotationFromEuler(mesh.rotation);
  const corners = [
    new THREE.Vector3(local.min.x, local.min.y, local.min.z),
    new THREE.Vector3(local.max.x, local.min.y, local.min.z),
    new THREE.Vector3(local.min.x, local.max.y, local.min.z),
    new THREE.Vector3(local.max.x, local.max.y, local.min.z),
    new THREE.Vector3(local.min.x, local.min.y, local.max.z),
    new THREE.Vector3(local.max.x, local.min.y, local.max.z),
    new THREE.Vector3(local.min.x, local.max.y, local.max.z),
    new THREE.Vector3(local.max.x, local.max.y, local.max.z),
  ];
  const rotated = corners.map((v) => v.clone().applyMatrix4(rot));
  const world = new THREE.Box3().setFromPoints(rotated);
  const size = new THREE.Vector3();
  world.getSize(size);
  return size;
}

function getSlabs(group: THREE.Group): THREE.Mesh[] {
  return group.children.filter(
    (c) => c.userData.ifcClass === "IfcSlab" && c.userData.name === "Dach",
  ) as THREE.Mesh[];
}

describe("SdRoof parametric gate — IfcSlab 'Dach' geometry (#1640)", () => {
  test("FZK metric: 12×6m, 30° pitch, 0.5m overhang — 2 slabs, slope-like world bbox", () => {
    const { mesh } = buildRoof(
      { x: -6, y: -3 },
      { x: 6, y: 3 },
      { type: "pitched", pitchDeg: 30, overhang: 0.5 },
    );
    const slabs = getSlabs(mesh);
    expect(slabs.length).toBe(2);

    for (const slab of slabs) {
      const size = worldBBoxSize(slab);
      // Ridge direction: 12m + 2×0.5m overhang = 13m
      expect(size.x).toBeCloseTo(13.0, 1);
      // Horizontal projection of slope (eave→ridge in plan) ≈ spanHalf + thick×sin(pitch)/2
      // For spanHalf=3.5m, 30°: ~3.575m
      expect(size.y).toBeGreaterThan(3.0);
      expect(size.y).toBeLessThan(4.5);
      // Vertical rise of slope deck ≈ rH + thick×cos(pitch)
      // For spanHalf=3.5m, 30°: ~2.15m
      expect(size.z).toBeGreaterThan(1.5);
      expect(size.z).toBeLessThan(3.5);
      // Slope deck is NOT a flat board: Y >> sheathThick (0.15m)
      expect(size.y).toBeGreaterThan(size.z * 0.5);
    }
  });

  test("FZK imperial: 39.4ft×19ft (≈12×5.8m), 30° pitch, 0.5m overhang — slabs slope-like", () => {
    const w = 39.4 * 0.3048; // 12.008m
    const d = 19.0 * 0.3048; // 5.791m
    const { mesh } = buildRoof(
      { x: -w / 2, y: -d / 2 },
      { x: w / 2, y: d / 2 },
      { type: "pitched", pitchDeg: 30, overhang: 0.5 },
    );
    const slabs = getSlabs(mesh);
    expect(slabs.length).toBe(2);

    for (const slab of slabs) {
      const size = worldBBoxSize(slab);
      // X = w + 2×overhang ≈ 13.008m
      expect(size.x).toBeCloseTo(w + 1.0, 1);
      // Y > 3m (slope projection for ~3.4m spanHalf at 30°)
      expect(size.y).toBeGreaterThan(3.0);
      // Z > 1m (vertical rise)
      expect(size.z).toBeGreaterThan(1.0);
      // Not flat board
      expect(size.y / size.z).toBeGreaterThan(1.0);
    }
  });

  test("Demo-house: 26ft×20ft (≈7.9×6.1m), 30° pitch — slabs present and slope-like", () => {
    const w = 26 * 0.3048; // 7.925m
    const d = 20 * 0.3048; // 6.096m
    const { mesh } = buildRoof(
      { x: -w / 2, y: -d / 2 },
      { x: w / 2, y: d / 2 },
      { type: "pitched", pitchDeg: 30 },
    );
    const slabs = getSlabs(mesh);
    expect(slabs.length).toBe(2);

    for (const slab of slabs) {
      const size = worldBBoxSize(slab);
      // X = w + 2×0.5m overhang
      expect(size.x).toBeCloseTo(w + 1.0, 1);
      // Slope-like: Y and Z both substantial
      expect(size.y).toBeGreaterThan(2.0);
      expect(size.z).toBeGreaterThan(1.0);
    }
  });

  test("Edge case: 50×5m, 15° pitch — shallow slope, slabs still slope-like", () => {
    const { mesh } = buildRoof(
      { x: -25, y: -2.5 },
      { x: 25, y: 2.5 },
      { type: "pitched", pitchDeg: 15, overhang: 0.5 },
    );
    const slabs = getSlabs(mesh);
    expect(slabs.length).toBe(2);

    for (const slab of slabs) {
      const size = worldBBoxSize(slab);
      // X = 50m + 2×0.5m overhang = 51m
      expect(size.x).toBeCloseTo(51.0, 1);
      // spanHalf = 3.0m, 15°: rafterLen ≈ 3.106m
      expect(size.y).toBeGreaterThan(2.5);
      // Z ≈ rH + thick correction; at 15°, rH = 3.0×tan(15°) ≈ 0.804m
      expect(size.z).toBeGreaterThan(0.5);
    }
  });

  test("userData: IfcSlab 'Dach' present, no IfcCovering named 'Dach'", () => {
    const { mesh } = buildRoof(
      { x: -6, y: -3 },
      { x: 6, y: 3 },
      { type: "pitched", pitchDeg: 30 },
    );
    const slabs = mesh.children.filter((c) => c.userData.ifcClass === "IfcSlab");
    const wrongClass = mesh.children.filter(
      (c) => c.userData.ifcClass === "IfcCovering" && c.userData.name === "Dach",
    );
    expect(slabs.length).toBe(2);
    expect(slabs.every((s) => s.userData.name === "Dach")).toBe(true);
    expect(wrongClass.length).toBe(0);
  });

  test("sheathThick = 0.15m: local bbox Z is 0.15 (not 0.025 IfcCovering sheathing)", () => {
    const { mesh } = buildRoof(
      { x: -6, y: -3 },
      { x: 6, y: 3 },
      { type: "pitched", pitchDeg: 30 },
    );
    const slabs = getSlabs(mesh);
    expect(slabs.length).toBe(2);
    for (const slab of slabs) {
      slab.geometry.computeBoundingBox();
      const local = slab.geometry.boundingBox!;
      const localZ = local.max.z - local.min.z;
      // 150mm structural slab, not 25mm sheathing
      expect(localZ).toBeCloseTo(0.15, 3);
    }
  });
});
