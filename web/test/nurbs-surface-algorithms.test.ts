// nurbs-surface-algorithms.test.ts — Unit tests for Tier 3 algorithms (#78).

import { describe, expect, test } from "bun:test";
import { surfaceOfRevolution, sweepSurface, loftSurfaces } from "../src/nurbs/nurbs-surface-algorithms";
import { pointAtUV, tessellateSurface } from "../src/nurbs/nurbs-surfaces";
import { type LineCurve, type ArcCurve } from "../src/nurbs/nurbs-curves";
import { Plane, Point3 } from "../src/nurbs/nurbs-primitives";

const EPS = 1e-6;
const close = (a: number, b: number, tol = EPS) => Math.abs(a - b) <= tol;
const closePt = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tol = EPS) =>
  close(a.x, b.x, tol) && close(a.y, b.y, tol) && close(a.z, b.z, tol);

// ── surfaceOfRevolution ───────────────────────────────────────────────────────

describe("surfaceOfRevolution — cylinder", () => {
  // Revolve vertical line (1,0,0)→(1,0,1) about Z through full circle → unit cylinder.
  const profLine: LineCurve = {
    kind: "line",
    from: { x: 1, y: 0, z: 0 }, to: { x: 1, y: 0, z: 1 },
    domain: { min: 0, max: 1 },
  };
  const axis = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } };
  const cyl = surfaceOfRevolution(profLine, axis, 0, 2 * Math.PI);

  test("kind is rev", () => expect(cyl.kind).toBe("rev"));

  test("pointAtUV(0.5, 0) = (1, 0, 0.5)", () => {
    expect(closePt(pointAtUV(cyl, 0.5, 0), { x: 1, y: 0, z: 0.5 }, 1e-9)).toBe(true);
  });

  test("pointAtUV(0.5, π/2) = (0, 1, 0.5)", () => {
    const pt = pointAtUV(cyl, 0.5, Math.PI / 2);
    expect(close(pt.x, 0, 1e-9)).toBe(true);
    expect(close(pt.y, 1, 1e-9)).toBe(true);
    expect(close(pt.z, 0.5, 1e-9)).toBe(true);
  });

  test("radius is constant = 1", () => {
    for (const theta of [0, Math.PI / 3, Math.PI, 4.5]) {
      const pt = pointAtUV(cyl, 0.5, theta);
      const r = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
      expect(close(r, 1, 1e-9)).toBe(true);
    }
  });
});

describe("surfaceOfRevolution — half-circle profile produces torus-like", () => {
  // Revolve a half-circle arc in the XZ plane about Z → partial sphere-like.
  const arc: ArcCurve = {
    kind: "arc",
    center: { x: 0, y: 0, z: 0.5 },
    radius: 0.5,
    startAngle: -Math.PI / 2,
    endAngle:    Math.PI / 2,
    plane: Plane.worldXY(),
    domain: { min: 0, max: Math.PI * 0.5 },
  };
  const axis = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } };
  const surf = surfaceOfRevolution(arc, axis, 0, 2 * Math.PI);

  test("kind is rev", () => expect(surf.kind).toBe("rev"));
  test("tessellate succeeds", () => {
    const mesh = tessellateSurface(surf, 8, 8);
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });
});

// ── sweepSurface ──────────────────────────────────────────────────────────────

describe("sweepSurface — linear rail + circle profile → cylinder", () => {
  // Linear rail along Z from 0 to 1.
  const rail: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 },
    domain: { min: 0, max: 1 },
  };
  // Circle profile of radius 0.5 in XY plane.
  const circle: ArcCurve = {
    kind: "arc",
    center: { x: 0, y: 0, z: 0 },
    radius: 0.5,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: Plane.worldXY(),
    domain: { min: 0, max: Math.PI },
  };
  const surf = sweepSurface(circle, rail, { keepFrame: false });

  test("kind is nurbs", () => expect(surf.kind).toBe("nurbs"));

  test("tessellate vertex count correct", () => {
    const mesh = tessellateSurface(surf, 8, 8);
    expect(mesh.positions.length / 3).toBe(9 * 9);
  });

  test("tessellate triangle count correct", () => {
    const mesh = tessellateSurface(surf, 8, 8);
    expect(mesh.indices.length / 3).toBe(2 * 8 * 8);
  });

  test("all normals are unit length", () => {
    const mesh = tessellateSurface(surf, 6, 6);
    for (let i = 0; i < mesh.normals.length / 3; i++) {
      const nx = mesh.normals[i*3], ny = mesh.normals[i*3+1], nz = mesh.normals[i*3+2];
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
      expect(close(len, 1, 1e-4)).toBe(true);
    }
  });
});

// ── loftSurfaces ─────────────────────────────────────────────────────────────

describe("loftSurfaces — 2 line profiles → planar surface", () => {
  // Two identical horizontal line segments, offset by 1 along Z → planar quad.
  const line0: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 },
    domain: { min: 0, max: 1 },
  };
  const line1: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 1 }, to: { x: 1, y: 0, z: 1 },
    domain: { min: 0, max: 1 },
  };
  const surf = loftSurfaces([line0, line1]);

  test("kind is nurbs", () => expect(surf.kind).toBe("nurbs"));
  test("cvCount[1] = 2 (one per profile)", () => expect(surf.cvCount[1]).toBe(2));

  test("tessellate succeeds with correct geometry counts", () => {
    const mesh = tessellateSurface(surf, 4, 4);
    expect(mesh.positions.length / 3).toBe(25);
    expect(mesh.indices.length / 3).toBe(32);
  });

  test("surface lies in the y=0 plane", () => {
    const mesh = tessellateSurface(surf, 4, 4);
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      expect(close(mesh.positions[i*3+1], 0, 1e-4)).toBe(true);
    }
  });
});

describe("loftSurfaces — 3 circles → frustum-like", () => {
  const makeCircle = (r: number, z: number): ArcCurve => ({
    kind: "arc",
    center: { x: 0, y: 0, z },
    radius: r,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: {
      origin: { x: 0, y: 0, z },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
    },
    domain: { min: 0, max: Math.PI },
  });
  const surf = loftSurfaces([makeCircle(2, 0), makeCircle(1.5, 1), makeCircle(1, 2)]);

  test("kind is nurbs", () => expect(surf.kind).toBe("nurbs"));
  test("cvCount[1] = 3", () => expect(surf.cvCount[1]).toBe(3));

  test("tessellate produces valid mesh", () => {
    const mesh = tessellateSurface(surf, 8, 8);
    expect(mesh.positions.length / 3).toBe(81);
    expect(mesh.indices.length / 3).toBe(128);
  });
});

describe("loftSurfaces — degreeV clamped to curves.length - 1", () => {
  const makeHorizontalLine = (z: number): LineCurve => ({
    kind: "line",
    from: { x: 0, y: 0, z }, to: { x: 1, y: 0, z },
    domain: { min: 0, max: 1 },
  });
  test("2 curves → degreeV=1 (linear)", () => {
    const surf = loftSurfaces([makeHorizontalLine(0), makeHorizontalLine(1)]);
    expect(surf.order[1]).toBe(2); // degreeV=1 → order=2
  });
  test("3 curves → degreeV=2 (quadratic)", () => {
    const surf = loftSurfaces([makeHorizontalLine(0), makeHorizontalLine(1), makeHorizontalLine(2)]);
    expect(surf.order[1]).toBe(3); // degreeV=2 → order=3
  });
  test("4+ curves → degreeV capped at 3 (cubic)", () => {
    const surf = loftSurfaces([
      makeHorizontalLine(0), makeHorizontalLine(1),
      makeHorizontalLine(2), makeHorizontalLine(3), makeHorizontalLine(4),
    ]);
    expect(surf.order[1]).toBe(4); // degreeV=3 → order=4
  });
});
