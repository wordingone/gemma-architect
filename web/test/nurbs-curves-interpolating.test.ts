// nurbs-curves-interpolating.test.ts — Unit tests for createInterpolatingCubicBSpline (#698).
// Verifies that the curve passes exactly through every data point at its chord-length
// parameter value: pointAt(curve, t[i]) == dataPoints[i] within floating-point tolerance.

import { describe, expect, test } from "bun:test";
import {
  createInterpolatingCubicBSpline,
  createClampedUniformNurbs,
  pointAt,
  tessellate,
} from "../src/nurbs/nurbs-curves";
import type { Point3 } from "../src/nurbs/nurbs-primitives";

const TOL = 1e-8;

// Replicates the chord-length parameterization used internally by createInterpolatingCubicBSpline.
function chordParams(pts: Point3[]): number[] {
  const chord: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i-1].x, dy = pts[i].y - pts[i-1].y, dz = pts[i].z - pts[i-1].z;
    chord.push(chord[i-1] + Math.sqrt(dx*dx + dy*dy + dz*dz));
  }
  const total = chord[pts.length-1];
  return total > 0 ? chord.map(c => c/total) : pts.map((_, i) => i/(pts.length-1));
}

// Max geometric error when evaluating the curve at each data point's exact parameter.
function interpolationError(dataPts: Point3[]): number {
  const nurbs = createInterpolatingCubicBSpline(dataPts);
  const t = chordParams(dataPts);
  return Math.max(...dataPts.map((dp, i) => {
    const p = pointAt(nurbs, t[i]);
    const dx = p.x - dp.x, dy = p.y - dp.y, dz = p.z - dp.z;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  }));
}

// ── N=2 (linear — minimum valid input) ───────────────────────────────────────

describe("createInterpolatingCubicBSpline N=2 (linear)", () => {
  const pts: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 3, y: 4, z: 0 },
  ];

  test("returns a NurbsCurve", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.kind).toBe("nurbs");
  });

  test("passes through both endpoints within tolerance", () => {
    expect(interpolationError(pts)).toBeLessThan(TOL);
  });

  test("knot vector length satisfies OpenNURBS convention", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.knots.length).toBe(nc.order + nc.cvCount - 2);
  });
});

// ── N=3 (quadratic interpolating — degree adapts to numPts-1) ────────────────

describe("createInterpolatingCubicBSpline N=3 (quadratic interpolating)", () => {
  const pts: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 2, z: 0 },
    { x: 2, y: 0, z: 0 },
  ];

  test("returns a NurbsCurve", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.kind).toBe("nurbs");
  });

  test("passes through all three data points within tolerance", () => {
    expect(interpolationError(pts)).toBeLessThan(TOL);
  });

  test("uses degree 2 (quadratic) for 3 points", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.order).toBe(3);
  });

  test("knot vector length satisfies OpenNURBS convention", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.knots.length).toBe(nc.order + nc.cvCount - 2);
  });
});

// ── N=4 (first cubic case — no degree reduction) ──────────────────────────────

describe("createInterpolatingCubicBSpline N=4 (cubic)", () => {
  const pts: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 2, z: 0 },
    { x: 2, y: -1, z: 0 },
    { x: 3, y: 1, z: 0 },
  ];

  test("returns a cubic NurbsCurve (order=4)", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.kind).toBe("nurbs");
    expect(nc.order).toBe(4);
  });

  test("passes through all four data points within tolerance", () => {
    expect(interpolationError(pts)).toBeLessThan(TOL);
  });

  test("knot vector length satisfies OpenNURBS convention", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.knots.length).toBe(nc.order + nc.cvCount - 2);
  });

  test("domain is [0, 1]", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.knots[0]).toBe(0);
    expect(nc.knots[nc.knots.length - 1]).toBe(1);
  });
});

// ── N=6 (confirms linear solve scales to larger sets) ─────────────────────────

describe("createInterpolatingCubicBSpline N=6 (larger dataset)", () => {
  const pts: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 3, z: 1 },
    { x: 2, y: 1, z: 2 },
    { x: 3, y: -1, z: 1 },
    { x: 4, y: 2, z: 0 },
    { x: 5, y: 0, z: 0 },
  ];

  test("passes through all six data points within tolerance", () => {
    expect(interpolationError(pts)).toBeLessThan(TOL);
  });

  test("returns a cubic NurbsCurve", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.order).toBe(4);
    expect(nc.cvCount).toBe(pts.length);
  });
});

// ── Collinear points (degenerate-but-valid) ───────────────────────────────────

describe("createInterpolatingCubicBSpline — collinear points", () => {
  const pts: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
  ];

  test("passes through all collinear points within tolerance", () => {
    expect(interpolationError(pts)).toBeLessThan(TOL);
  });

  test("produces a valid NurbsCurve for degenerate input", () => {
    const nc = createInterpolatingCubicBSpline(pts);
    expect(nc.kind).toBe("nurbs");
    expect(nc.cvCount).toBe(pts.length);
  });
});

// ── Closed-curve path stays approximating (not interpolating) ─────────────────

describe("closed-curve path uses approximating spline (createClampedUniformNurbs)", () => {
  const pts: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 1, y: -1, z: 0 },
  ];
  const degree = 3;
  const order = degree + 1;
  const wrapped = [...pts, ...pts.slice(0, degree)];
  const approxNurbs = createClampedUniformNurbs(3, order, wrapped);

  test("approximating closed spline knot length satisfies OpenNURBS convention", () => {
    expect(approxNurbs.knots.length).toBe(approxNurbs.order + approxNurbs.cvCount - 2);
  });

  test("approximating closed spline does NOT pass through interior control points", () => {
    // Approximating NURBS only gets pulled toward interior control points, does not pass through.
    // Verify interior point at index 1 is NOT on the tessellated curve (dist > 1e-6).
    const tess = tessellate(approxNurbs, 512);
    const interior = pts[1];
    let best = Infinity;
    for (const p of tess) {
      const dx = p.x - interior.x, dy = p.y - interior.y, dz = p.z - interior.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (d < best) best = d;
    }
    expect(best).toBeGreaterThan(1e-6);
  });
});

// ── Error thrown for degenerate inputs ───────────────────────────────────────

describe("createInterpolatingCubicBSpline — error cases", () => {
  test("throws for fewer than 2 points", () => {
    expect(() => createInterpolatingCubicBSpline([{ x: 0, y: 0, z: 0 }])).toThrow();
  });

  test("throws for empty array", () => {
    expect(() => createInterpolatingCubicBSpline([])).toThrow();
  });
});
