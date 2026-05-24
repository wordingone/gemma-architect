// Structural comparator for buildRoof fixture assertions (#1779 / #1675).
// Collects ALL drift in one pass — no fail-fast — so callers see the full
// failure surface rather than stopping at the first mismatch.
import * as THREE from "three";

export interface PerQuantityEpsilon {
  geometry?: number;
  position?: number;
  rotation?: number;
  dot?: number;
}

export interface ComponentFailure {
  component: string;
  quantity: string;
  expected: number;
  actual: number;
  delta: number;
}

export interface CompareResult {
  pass: boolean;
  failures: ComponentFailure[];
}

export interface FixtureJson {
  params: {
    p0: { x: number; y: number };
    p1: { x: number; y: number };
    pitchDeg: number;
    overhang: number;
  };
  derived: {
    spanHalf: number;
    rH: number;
    rafterLen: number;
    [k: string]: unknown;
  };
  invariants: {
    slabs: {
      count: number; ifcClass: string; name: string;
      geom_x: number; geom_y: number; geom_z: number;
      rotation_x_abs_rad: number; position_y_abs: number; position_z: number;
    };
    ridgeBeam: {
      count: number; ifcClass: string; name: string;
      geom_x: number; position_x: number; position_y: number; position_z: number;
    };
    pfette: {
      count: number; ifcClass: string; name: string;
      geom_x: number; position_y_abs: number; position_z: number;
    };
    rafters: {
      totalCount: number; ifcClass: string;
      geom_x: number; geom_z: number;
    };
    dihedral: { slab_normal_dot: number };
    fascia: {
      count: number; ifcClass: string; name: string;
      geom_x: number; geom_y: number; geom_z: number;
    };
    soffit: {
      count: number; ifcClass: string; name: string;
      geom_x: number; geom_y: number; geom_z: number;
    };
    gable: { standalone_mesh_count: number; ifcClass?: string };
  };
}

function byClass(group: THREE.Group, ifcClass: string, name?: string): THREE.Object3D[] {
  return group.children.filter(
    (c) => c.userData.ifcClass === ifcClass && (name === undefined || c.userData.name === name),
  );
}

function geomSize(obj: THREE.Object3D): THREE.Vector3 {
  const mesh = obj as THREE.Mesh;
  mesh.geometry.computeBoundingBox();
  return mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
}

function check(
  failures: ComponentFailure[],
  component: string,
  quantity: string,
  expected: number,
  actual: number,
  eps: number,
) {
  const delta = Math.abs(actual - expected);
  if (delta > eps) failures.push({ component, quantity, expected, actual, delta });
}

export function compareFixture(
  group: THREE.Group,
  fixture: FixtureJson,
  opts: { epsilon: PerQuantityEpsilon },
): CompareResult {
  const geoEps = opts.epsilon.geometry ?? 1e-3;
  const posEps = opts.epsilon.position ?? 1e-3;
  const rotEps = opts.epsilon.rotation ?? 1e-3;
  const dotEps = opts.epsilon.dot ?? 1e-3;
  const failures: ComponentFailure[] = [];
  const { slabs, ridgeBeam, pfette, rafters, dihedral, fascia, soffit, gable } = fixture.invariants;

  // ── Slabs ──────────────────────────────────────────────────────────────────
  const slabObjs = byClass(group, slabs.ifcClass, slabs.name) as THREE.Mesh[];
  if (slabObjs.length !== slabs.count) {
    failures.push({ component: "slabs", quantity: "count", expected: slabs.count, actual: slabObjs.length, delta: Math.abs(slabObjs.length - slabs.count) });
  }
  for (let i = 0; i < slabObjs.length; i++) {
    const sz = geomSize(slabObjs[i]);
    check(failures, `slabs[${i}]`, "geom_x", slabs.geom_x, sz.x, geoEps);
    check(failures, `slabs[${i}]`, "geom_y", slabs.geom_y, sz.y, geoEps);
    check(failures, `slabs[${i}]`, "geom_z", slabs.geom_z, sz.z, geoEps);
    check(failures, `slabs[${i}]`, "rotation_x_abs", slabs.rotation_x_abs_rad, Math.abs(slabObjs[i].rotation.x), rotEps);
    check(failures, `slabs[${i}]`, "position_z", slabs.position_z, slabObjs[i].position.z, posEps);
    check(failures, `slabs[${i}]`, "position_y_abs", slabs.position_y_abs, Math.abs(slabObjs[i].position.y), posEps);
  }
  if (slabObjs.length === 2) {
    const normals = slabObjs.map((s) => new THREE.Vector3(0, 0, 1).applyEuler(s.rotation));
    check(failures, "dihedral", "slab_normal_dot", dihedral.slab_normal_dot, normals[0].dot(normals[1]), dotEps);
    const yVals = slabObjs.map((s) => s.position.y).sort((a, b) => a - b);
    if (!(yVals[0] < 0))
      failures.push({ component: "slabs", quantity: "position_y_symmetric_negative", expected: -1, actual: Math.sign(yVals[0]), delta: 1 });
    if (!(yVals[1] > 0))
      failures.push({ component: "slabs", quantity: "position_y_symmetric_positive", expected: 1, actual: Math.sign(yVals[1]), delta: 1 });
    const rots = slabObjs.map((s) => s.rotation.x);
    if (!((rots[0] < 0 && rots[1] > 0) || (rots[0] > 0 && rots[1] < 0)))
      failures.push({ component: "slabs", quantity: "rotation_x_symmetric", expected: 0, actual: rots[0] * rots[1], delta: Math.abs(rots[0] * rots[1]) });
  }

  // ── Ridge beam ─────────────────────────────────────────────────────────────
  const ridgeObjs = byClass(group, ridgeBeam.ifcClass, ridgeBeam.name) as THREE.Mesh[];
  if (ridgeObjs.length !== ridgeBeam.count) {
    failures.push({ component: "ridgeBeam", quantity: "count", expected: ridgeBeam.count, actual: ridgeObjs.length, delta: Math.abs(ridgeObjs.length - ridgeBeam.count) });
  }
  if (ridgeObjs.length >= 1) {
    const sz = geomSize(ridgeObjs[0]);
    check(failures, "ridgeBeam", "geom_x", ridgeBeam.geom_x, sz.x, geoEps);
    check(failures, "ridgeBeam", "position_x", ridgeBeam.position_x, ridgeObjs[0].position.x, posEps);
    check(failures, "ridgeBeam", "position_y", ridgeBeam.position_y, ridgeObjs[0].position.y, posEps);
    check(failures, "ridgeBeam", "position_z", ridgeBeam.position_z, ridgeObjs[0].position.z, posEps);
  }

  // ── Pfette ─────────────────────────────────────────────────────────────────
  const pfetteObjs = byClass(group, pfette.ifcClass, pfette.name) as THREE.Mesh[];
  if (pfetteObjs.length !== pfette.count) {
    failures.push({ component: "pfette", quantity: "count", expected: pfette.count, actual: pfetteObjs.length, delta: Math.abs(pfetteObjs.length - pfette.count) });
  }
  for (let i = 0; i < pfetteObjs.length; i++) {
    const sz = geomSize(pfetteObjs[i]);
    check(failures, `pfette[${i}]`, "geom_x", pfette.geom_x, sz.x, geoEps);
    check(failures, `pfette[${i}]`, "position_z", pfette.position_z, pfetteObjs[i].position.z, posEps);
    check(failures, `pfette[${i}]`, "position_y_abs", pfette.position_y_abs, Math.abs(pfetteObjs[i].position.y), posEps);
  }
  if (pfetteObjs.length >= 2) {
    const yVals = pfetteObjs.map((p) => p.position.y).sort((a, b) => a - b);
    if (!(yVals[0] < 0))
      failures.push({ component: "pfette", quantity: "position_y_symmetric_negative", expected: -1, actual: Math.sign(yVals[0]), delta: 1 });
    if (!(yVals[1] > 0))
      failures.push({ component: "pfette", quantity: "position_y_symmetric_positive", expected: 1, actual: Math.sign(yVals[1]), delta: 1 });
  }

  // ── Rafters ────────────────────────────────────────────────────────────────
  const rafterObjs = byClass(group, rafters.ifcClass);
  if (rafterObjs.length !== rafters.totalCount) {
    failures.push({ component: "rafters", quantity: "totalCount", expected: rafters.totalCount, actual: rafterObjs.length, delta: Math.abs(rafterObjs.length - rafters.totalCount) });
  }
  for (let i = 0; i < rafterObjs.length; i++) {
    const sz = geomSize(rafterObjs[i]);
    check(failures, `rafters[${i}]`, "geom_x", rafters.geom_x, sz.x, geoEps);
    check(failures, `rafters[${i}]`, "geom_z", rafters.geom_z, sz.z, geoEps);
  }

  // ── Fascia ─────────────────────────────────────────────────────────────────
  const fasciaObjs = byClass(group, fascia.ifcClass, fascia.name) as THREE.Mesh[];
  if (fasciaObjs.length !== fascia.count) {
    failures.push({ component: "fascia", quantity: "count", expected: fascia.count, actual: fasciaObjs.length, delta: Math.abs(fasciaObjs.length - fascia.count) });
  }
  for (let i = 0; i < fasciaObjs.length; i++) {
    const sz = geomSize(fasciaObjs[i]);
    check(failures, `fascia[${i}]`, "geom_x", fascia.geom_x, sz.x, geoEps);
    check(failures, `fascia[${i}]`, "geom_y", fascia.geom_y, sz.y, geoEps);
    check(failures, `fascia[${i}]`, "geom_z", fascia.geom_z, sz.z, geoEps);
  }

  // ── Soffit ─────────────────────────────────────────────────────────────────
  const soffitObjs = byClass(group, soffit.ifcClass, soffit.name) as THREE.Mesh[];
  if (soffitObjs.length !== soffit.count) {
    failures.push({ component: "soffit", quantity: "count", expected: soffit.count, actual: soffitObjs.length, delta: Math.abs(soffitObjs.length - soffit.count) });
  }
  for (let i = 0; i < soffitObjs.length; i++) {
    const sz = geomSize(soffitObjs[i]);
    check(failures, `soffit[${i}]`, "geom_x", soffit.geom_x, sz.x, geoEps);
    check(failures, `soffit[${i}]`, "geom_y", soffit.geom_y, sz.y, geoEps);
    check(failures, `soffit[${i}]`, "geom_z", soffit.geom_z, sz.z, geoEps);
  }

  // ── Total IfcCovering ──────────────────────────────────────────────────────
  const totalCoverings = byClass(group, fascia.ifcClass).length;
  const expectedTotal = fascia.count + soffit.count;
  if (totalCoverings !== expectedTotal) {
    failures.push({ component: "coverings", quantity: "total_count", expected: expectedTotal, actual: totalCoverings, delta: Math.abs(totalCoverings - expectedTotal) });
  }

  // ── Gable ──────────────────────────────────────────────────────────────────
  const gableClass = gable.ifcClass ?? "IfcRoof";
  const gableCount = byClass(group, gableClass).length;
  if (gableCount !== gable.standalone_mesh_count) {
    failures.push({ component: "gable", quantity: "standalone_mesh_count", expected: gable.standalone_mesh_count, actual: gableCount, delta: Math.abs(gableCount - gable.standalone_mesh_count) });
  }

  return { pass: failures.length === 0, failures };
}
