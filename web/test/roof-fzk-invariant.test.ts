// #1675 — Engine-determinism Phase 1 ROOF: per-element invariant gate.
// Pins SdRoof buildRoof output against FZK KIT Haus reference geometry
// (12×10m footprint, 30° pitch, 0.5m overhang — correct dimensions per
// docs/canonical-roof-fzk-haus.md §A).
//
// Guards the recurring bug class: gable-end / pitch-deg / pfette-position
// regressions introduced by refactors. Tolerance 1e-3 on float quantities.
import { describe, test, expect } from "bun:test";
import * as THREE from "three";
import { buildRoof } from "../src/tools/structural";
import target from "./fixtures/fzk-haus-roof-target.json";

const TOL = 1e-3; // 1mm geometric tolerance

// Extract group children matching ifcClass + optional name filter.
function byClass(group: THREE.Group, ifcClass: string, name?: string): THREE.Object3D[] {
  return group.children.filter(
    (c) => c.userData.ifcClass === ifcClass && (name === undefined || c.userData.name === name),
  );
}

// Local geometry dimensions from BoxGeometry (children of the group).
function localGeomSize(obj: THREE.Object3D): THREE.Vector3 {
  const mesh = obj as THREE.Mesh;
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox!;
  return bb.getSize(new THREE.Vector3());
}

// Absolute value of a rotation angle (handles ±).
const absRot = (v: number) => Math.abs(v);

describe("SdRoof FZK invariant gate (#1675)", () => {
  let group: THREE.Group;

  // Build once; share across all tests in this suite.
  group = buildRoof(
    { x: target.params.p0.x, y: target.params.p0.y },
    { x: target.params.p1.x, y: target.params.p1.y },
    { type: "pitched", pitchDeg: target.params.pitchDeg, overhang: target.params.overhang },
  ).mesh;

  // ── Derived quantities ───────────────────────────────────────────────────────

  test("derived: rH = spanHalf × tan(pitchRad)", () => {
    const { spanHalf, rH, derived } = {
      spanHalf: target.derived.spanHalf,
      rH: target.derived.rH,
      derived: target.derived,
    };
    void derived;
    const pitchRad = (target.params.pitchDeg * Math.PI) / 180;
    expect(Math.abs(rH - spanHalf * Math.tan(pitchRad))).toBeLessThan(TOL);
  });

  test("derived: rafterLen = spanHalf / cos(pitchRad)", () => {
    const pitchRad = (target.params.pitchDeg * Math.PI) / 180;
    const expected = target.derived.spanHalf / Math.cos(pitchRad);
    expect(Math.abs(target.derived.rafterLen - expected)).toBeLessThan(TOL);
  });

  // ── IfcSlab "Dach" — slope deck panels ──────────────────────────────────────

  test("slabs: count = 2", () => {
    const slabs = byClass(group, "IfcSlab", "Dach");
    expect(slabs.length).toBe(target.invariants.slabs.count);
  });

  test("slabs: local geometry X = ridgeLen (13.0m)", () => {
    const slabs = byClass(group, "IfcSlab", "Dach");
    for (const s of slabs) {
      const sz = localGeomSize(s);
      expect(Math.abs(sz.x - target.invariants.slabs.geom_x)).toBeLessThan(TOL);
    }
  });

  test("slabs: local geometry Y = rafterLen", () => {
    const slabs = byClass(group, "IfcSlab", "Dach");
    for (const s of slabs) {
      const sz = localGeomSize(s);
      expect(Math.abs(sz.y - target.invariants.slabs.geom_y)).toBeLessThan(TOL);
    }
  });

  test("slabs: local geometry Z = sheathThick (0.20m)", () => {
    const slabs = byClass(group, "IfcSlab", "Dach");
    for (const s of slabs) {
      const sz = localGeomSize(s);
      expect(Math.abs(sz.z - target.invariants.slabs.geom_z)).toBeLessThan(TOL);
    }
  });

  test("slabs: rotation |x| = pitchRad (30°), symmetric (±)", () => {
    const slabs = byClass(group, "IfcSlab", "Dach") as THREE.Mesh[];
    const rotations = slabs.map((s) => s.rotation.x).sort();
    expect(absRot(rotations[0]) - target.invariants.slabs.rotation_x_abs_rad).toBeLessThan(TOL);
    expect(absRot(rotations[1]) - target.invariants.slabs.rotation_x_abs_rad).toBeLessThan(TOL);
    // Must be opposite sign (symmetric ridge)
    expect(rotations[0]).toBeLessThan(0);
    expect(rotations[1]).toBeGreaterThan(0);
  });

  test("slabs: position z = rH/2", () => {
    const slabs = byClass(group, "IfcSlab", "Dach") as THREE.Mesh[];
    for (const s of slabs) {
      expect(Math.abs(s.position.z - target.invariants.slabs.position_z)).toBeLessThan(TOL);
    }
  });

  test("slabs: position |y| = spanHalf/2 (2.75m) — symmetric eave centroid", () => {
    const slabs = byClass(group, "IfcSlab", "Dach") as THREE.Mesh[];
    for (const s of slabs) {
      expect(Math.abs(Math.abs(s.position.y) - target.invariants.slabs.position_y_abs)).toBeLessThan(TOL);
    }
  });

  test("slabs: normal dot product = cos(2×pitchRad) — dihedral 120°", () => {
    const slabs = byClass(group, "IfcSlab", "Dach") as THREE.Mesh[];
    const normals = slabs.map((s) => {
      // Local normal = (0,0,1); rotate by mesh rotation to get world-space normal.
      const n = new THREE.Vector3(0, 0, 1).applyEuler(s.rotation);
      return n;
    });
    expect(normals.length).toBe(2);
    const dot = normals[0].dot(normals[1]);
    expect(Math.abs(dot - target.invariants.dihedral.slab_normal_dot)).toBeLessThan(TOL);
  });

  // ── IfcBeam "First" — ridge beam ────────────────────────────────────────────

  test("ridge beam: count = 1", () => {
    const beams = byClass(group, "IfcBeam", "First");
    expect(beams.length).toBe(target.invariants.ridgeBeam.count);
  });

  test("ridge beam: geometry X = ridgeLen (13.0m)", () => {
    const beam = byClass(group, "IfcBeam", "First")[0];
    const sz = localGeomSize(beam);
    expect(Math.abs(sz.x - target.invariants.ridgeBeam.geom_x)).toBeLessThan(TOL);
  });

  test("ridge beam: position z = rH - 0.08 (apex, inside sheathing)", () => {
    const beam = byClass(group, "IfcBeam", "First")[0] as THREE.Mesh;
    expect(Math.abs(beam.position.z - target.invariants.ridgeBeam.position_z)).toBeLessThan(TOL);
  });

  test("ridge beam: position x=0, y=0 (centre of ridge)", () => {
    const beam = byClass(group, "IfcBeam", "First")[0] as THREE.Mesh;
    expect(Math.abs(beam.position.x)).toBeLessThan(TOL);
    expect(Math.abs(beam.position.y)).toBeLessThan(TOL);
  });

  // ── IfcBeam "Pfette" — eave purlins ─────────────────────────────────────────

  test("pfette: count = 2 (one per eave)", () => {
    const pfettes = byClass(group, "IfcBeam", "Pfette");
    expect(pfettes.length).toBe(target.invariants.pfette.count);
  });

  test("pfette: geometry X = ridgeLen (13.0m)", () => {
    const pfettes = byClass(group, "IfcBeam", "Pfette");
    for (const p of pfettes) {
      const sz = localGeomSize(p);
      expect(Math.abs(sz.x - target.invariants.pfette.geom_x)).toBeLessThan(TOL);
    }
  });

  test("pfette: position z = 0.08m (80mm above eave) — §B deferral", () => {
    const pfettes = byClass(group, "IfcBeam", "Pfette") as THREE.Mesh[];
    for (const p of pfettes) {
      expect(Math.abs(p.position.z - target.invariants.pfette.position_z)).toBeLessThan(TOL);
    }
  });

  test("pfette: position |y| = spanHalf (5.5m) — at eave edge", () => {
    const pfettes = byClass(group, "IfcBeam", "Pfette") as THREE.Mesh[];
    for (const p of pfettes) {
      expect(Math.abs(Math.abs(p.position.y) - target.invariants.pfette.position_y_abs)).toBeLessThan(TOL);
    }
    // Must be symmetric (one on each side)
    const yVals = pfettes.map((p) => p.position.y).sort();
    expect(yVals[0]).toBeLessThan(0);
    expect(yVals[1]).toBeGreaterThan(0);
  });

  // ── IfcMember — rafters ──────────────────────────────────────────────────────

  test("rafters: total count = 42 (21 per slope)", () => {
    // All IfcMember children are rafters in the pitched roof.
    const members = byClass(group, "IfcMember");
    expect(members.length).toBe(target.invariants.rafters.totalCount);
  });

  test("rafters: geometry Z = rafterLen (spans from eave to ridge)", () => {
    const members = byClass(group, "IfcMember");
    for (const m of members) {
      const sz = localGeomSize(m);
      expect(Math.abs(sz.z - target.invariants.rafters.geom_z)).toBeLessThan(TOL);
    }
  });

  test("rafters: geometry X = 0.08m (80mm width)", () => {
    const members = byClass(group, "IfcMember");
    for (const m of members) {
      const sz = localGeomSize(m);
      expect(Math.abs(sz.x - target.invariants.rafters.geom_x)).toBeLessThan(TOL);
    }
  });

  // ── §C — no standalone gable mesh (sub-fix 3) ────────────────────────────────
  // Wall auto-trim provides the gable face; buildRoof emits no separate IfcRoof child.

  test("gable: no standalone IfcRoof mesh in group children", () => {
    const gableMeshes = byClass(group, "IfcRoof");
    expect(gableMeshes.length).toBe(target.invariants.gable.standalone_mesh_count);
  });

  // ── §D — IfcCovering fascia + soffit codified (sub-fix 4) ────────────────────
  // 4 pieces retained for eave closure: 2 fascia boards + 2 soffits.

  test("fascia: count = 2 IfcCovering at eave edges", () => {
    const coverings = byClass(group, "IfcCovering");
    // Fascia: geom_y = 0.03 (30mm board)
    const fascia = coverings.filter((c) => {
      const sz = localGeomSize(c);
      return Math.abs(sz.y - target.invariants.fascia.geom_y) < TOL;
    });
    expect(fascia.length).toBe(target.invariants.fascia.count);
  });

  test("fascia: geometry X = ridgeLen (13.0m)", () => {
    const coverings = byClass(group, "IfcCovering");
    const fascia = coverings.filter((c) => {
      const sz = localGeomSize(c);
      return Math.abs(sz.y - target.invariants.fascia.geom_y) < TOL;
    });
    for (const f of fascia) {
      const sz = localGeomSize(f);
      expect(Math.abs(sz.x - target.invariants.fascia.geom_x)).toBeLessThan(TOL);
    }
  });

  test("soffit: count = 2 IfcCovering under eave overhang", () => {
    const coverings = byClass(group, "IfcCovering");
    // Soffit: geom_z = 0.02 (20mm panel)
    const soffit = coverings.filter((c) => {
      const sz = localGeomSize(c);
      return Math.abs(sz.z - target.invariants.soffit.geom_z) < TOL;
    });
    expect(soffit.length).toBe(target.invariants.soffit.count);
  });

  test("soffit: geometry Y = overhang (0.5m)", () => {
    const coverings = byClass(group, "IfcCovering");
    const soffit = coverings.filter((c) => {
      const sz = localGeomSize(c);
      return Math.abs(sz.z - target.invariants.soffit.geom_z) < TOL;
    });
    for (const s of soffit) {
      const sz = localGeomSize(s);
      expect(Math.abs(sz.y - target.invariants.soffit.geom_y)).toBeLessThan(TOL);
    }
  });

  test("IfcCovering total = 4 (2 fascia + 2 soffit)", () => {
    const coverings = byClass(group, "IfcCovering");
    expect(coverings.length).toBe(
      target.invariants.fascia.count + target.invariants.soffit.count,
    );
  });
});
