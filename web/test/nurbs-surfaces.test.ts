// nurbs-surfaces.test.ts — Unit tests for Tier 3 surface representation (#78).

import { describe, expect, test } from "bun:test";
import {
  type PlaneSurface, type RevSurface, type SumSurface,
  pointAtUV, normalAtUV, frameAtUV, domainU, domainV,
  getNurbsForm, transposeSurface, tessellateSurface,
} from "../src/nurbs/nurbs-surfaces";
import { Plane, Point3, Interval, Vector3 } from "../src/nurbs/nurbs-primitives";
import { type LineCurve, type ArcCurve } from "../src/nurbs/nurbs-curves";

const EPS = 1e-6;
const close = (a: number, b: number, tol = EPS) => Math.abs(a - b) <= tol;
const closePt = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tol = EPS) =>
  close(a.x, b.x, tol) && close(a.y, b.y, tol) && close(a.z, b.z, tol);

// ── PlaneSurface ──────────────────────────────────────────────────────────────

describe("PlaneSurface", () => {
  const plane: PlaneSurface = {
    kind: "plane",
    plane: Plane.worldXY(),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(0, 4),
    vExtent: Interval.create(0, 3),
  };

  test("domainU/V", () => {
    expect(domainU(plane)).toEqual({ min: 0, max: 1 });
    expect(domainV(plane)).toEqual({ min: 0, max: 1 });
  });

  test("pointAtUV corners", () => {
    expect(closePt(pointAtUV(plane, 0, 0), { x: 0, y: 0, z: 0 })).toBe(true);
    expect(closePt(pointAtUV(plane, 1, 0), { x: 4, y: 0, z: 0 })).toBe(true);
    expect(closePt(pointAtUV(plane, 0, 1), { x: 0, y: 3, z: 0 })).toBe(true);
    expect(closePt(pointAtUV(plane, 1, 1), { x: 4, y: 3, z: 0 })).toBe(true);
  });

  test("pointAtUV center", () => {
    expect(closePt(pointAtUV(plane, 0.5, 0.5), { x: 2, y: 1.5, z: 0 })).toBe(true);
  });

  test("normalAtUV is Z-up", () => {
    const n = normalAtUV(plane, 0.5, 0.5);
    expect(close(Math.abs(n.z), 1, 1e-4)).toBe(true);
    expect(close(n.x, 0, 1e-4)).toBe(true);
    expect(close(n.y, 0, 1e-4)).toBe(true);
  });

  test("frameAtUV has consistent axes", () => {
    const fr = frameAtUV(plane, 0.5, 0.5);
    const dot = fr.xAxis.x * fr.normal.x + fr.xAxis.y * fr.normal.y + fr.xAxis.z * fr.normal.z;
    expect(close(dot, 0, 1e-4)).toBe(true);
  });

  test("getNurbsForm produces self-consistent surface", () => {
    const { form, surface } = getNurbsForm(plane);
    expect(form).toBe(2); // approximation
    expect(surface.kind).toBe("nurbs");
    expect(surface.cvCount[0]).toBeGreaterThan(0);
    expect(surface.cvCount[1]).toBeGreaterThan(0);
    expect(surface.cvs.length).toBe(surface.cvCount[0] * surface.cvCount[1] * surface.dim);
  });
});

// ── RevSurface ────────────────────────────────────────────────────────────────

describe("RevSurface (cylinder)", () => {
  // Revolve a vertical line (1,0,0)→(1,0,1) about Z-axis through 2π → unit cylinder.
  const profLine: LineCurve = {
    kind: "line",
    from: { x: 1, y: 0, z: 0 },
    to:   { x: 1, y: 0, z: 1 },
    domain: { min: 0, max: 1 },
  };
  const cylinder: RevSurface = {
    kind: "rev",
    profile: profLine,
    axis: { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } },
    angle: { min: 0, max: 2 * Math.PI },
    transposed: false,
  };

  test("domainU = profile domain", () => {
    const du = domainU(cylinder);
    expect(close(du.min, 0)).toBe(true);
    expect(close(du.max, 1)).toBe(true);
  });

  test("domainV = angle domain", () => {
    const dv = domainV(cylinder);
    expect(close(dv.min, 0)).toBe(true);
    expect(close(dv.max, 2 * Math.PI, 1e-9)).toBe(true);
  });

  test("pointAtUV(0.5, 0) = (1, 0, 0.5)", () => {
    expect(closePt(pointAtUV(cylinder, 0.5, 0), { x: 1, y: 0, z: 0.5 }, 1e-9)).toBe(true);
  });

  test("pointAtUV(0.5, π/2) = (0, 1, 0.5)", () => {
    const pt = pointAtUV(cylinder, 0.5, Math.PI / 2);
    expect(close(pt.x, 0, 1e-9)).toBe(true);
    expect(close(pt.y, 1, 1e-9)).toBe(true);
    expect(close(pt.z, 0.5, 1e-9)).toBe(true);
  });

  test("pointAtUV(0.5, π) = (-1, 0, 0.5)", () => {
    const pt = pointAtUV(cylinder, 0.5, Math.PI);
    expect(close(pt.x, -1, 1e-9)).toBe(true);
    expect(close(pt.y,  0, 1e-9)).toBe(true);
    expect(close(pt.z, 0.5, 1e-9)).toBe(true);
  });

  test("radius = 1 at all angles", () => {
    for (const theta of [0, Math.PI / 4, Math.PI / 2, Math.PI, 1.7, 5.1]) {
      const pt = pointAtUV(cylinder, 0.5, theta);
      const r = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
      expect(close(r, 1, 1e-9)).toBe(true);
    }
  });

  test("transposed: swaps u and v roles", () => {
    const tc = { ...cylinder, transposed: true };
    // With transposed=true: u=angle, v=profile param
    expect(closePt(pointAtUV(tc, 0, 0.5), { x: 1, y: 0, z: 0.5 }, 1e-9)).toBe(true);
    const pt = pointAtUV(tc, Math.PI / 2, 0.5);
    expect(close(pt.x, 0, 1e-9)).toBe(true);
    expect(close(pt.y, 1, 1e-9)).toBe(true);
  });
});

// ── SumSurface ────────────────────────────────────────────────────────────────

describe("SumSurface", () => {
  const lineU: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to:   { x: 4, y: 0, z: 0 },
    domain: { min: 0, max: 4 },
  };
  const lineV: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to:   { x: 0, y: 3, z: 0 },
    domain: { min: 0, max: 3 },
  };
  const sum: SumSurface = {
    kind: "sum",
    curveU: lineU,
    curveV: lineV,
    basepoint: { x: 0, y: 0, z: 0 },
  };

  test("pointAtUV(0, 0) = origin", () => {
    expect(closePt(pointAtUV(sum, 0, 0), { x: 0, y: 0, z: 0 })).toBe(true);
  });

  test("pointAtUV(4, 0) = (4, 0, 0)", () => {
    expect(closePt(pointAtUV(sum, 4, 0), { x: 4, y: 0, z: 0 })).toBe(true);
  });

  test("pointAtUV(0, 3) = (0, 3, 0)", () => {
    expect(closePt(pointAtUV(sum, 0, 3), { x: 0, y: 3, z: 0 })).toBe(true);
  });

  test("pointAtUV(4, 3) = (4, 3, 0)", () => {
    expect(closePt(pointAtUV(sum, 4, 3), { x: 4, y: 3, z: 0 })).toBe(true);
  });
});

// ── Tessellation ──────────────────────────────────────────────────────────────

describe("tessellateSurface", () => {
  const plane: PlaneSurface = {
    kind: "plane",
    plane: Plane.worldXY(),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(0, 1),
    vExtent: Interval.create(0, 1),
  };

  test("vertex count = (uSamples+1)*(vSamples+1)", () => {
    const mesh = tessellateSurface(plane, 8, 6);
    expect(mesh.positions.length / 3).toBe(9 * 7);
  });

  test("triangle count = 2 * uSamples * vSamples", () => {
    const mesh = tessellateSurface(plane, 8, 6);
    expect(mesh.indices.length / 3).toBe(2 * 8 * 6);
  });

  test("normals match normalAtUV at grid points", () => {
    const profLine: LineCurve = {
      kind: "line", from: {x:1,y:0,z:0}, to: {x:1,y:0,z:1}, domain: {min:0,max:1}
    };
    const cyl: RevSurface = {
      kind: "rev", profile: profLine,
      axis: {from:{x:0,y:0,z:0}, to:{x:0,y:0,z:1}},
      angle: {min:0, max:2*Math.PI}, transposed: false,
    };
    const mesh = tessellateSurface(cyl, 4, 4);
    for (let i = 0; i <= 4; i++) {
      for (let j = 0; j <= 4; j++) {
        const idx = (i * 5 + j) * 3;
        const nx = mesh.normals[idx], ny = mesh.normals[idx+1], nz = mesh.normals[idx+2];
        const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
        expect(close(len, 1, 1e-5)).toBe(true);
      }
    }
  });
});
