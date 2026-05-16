// nurbs-curves-interpolating.test.ts — Unit tests for createInterpolatingCubicBSpline (#698).
// Verifies that the curve passes exactly through every data point at its chord-length
// parameter value: pointAt(curve, t[i]) == dataPoints[i] within floating-point tolerance.

import { describe, expect, test } from "bun:test";
import {
  createInterpolatingCubicBSpline,
  pointAt,
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

// ── Closed-curve interpolation ─────────────────────────────────────────────

describe("createInterpolatingCubicBSpline — closed: true", () => {
  const pts: Point3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 1, y: -1, z: 0 },
  ];

  test("closed curve passes through all data points within tolerance", () => {
    const nc = createInterpolatingCubicBSpline(pts, { closed: true });
    // The algorithm receives pts + [pts[0]], so we check the original 4 points.
    // chordParams for the 5-point closed set; we only need the first 4 parameters.
    const allPts = [...pts, pts[0]];
    const chord: number[] = [0];
    for (let i = 1; i < allPts.length; i++) {
      const dx = allPts[i].x - allPts[i-1].x, dy = allPts[i].y - allPts[i-1].y, dz = allPts[i].z - allPts[i-1].z;
      chord.push(chord[i-1] + Math.sqrt(dx*dx + dy*dy + dz*dz));
    }
    const total = chord[allPts.length-1];
    const t = total > 0 ? chord.map(c => c/total) : allPts.map((_, i) => i/(allPts.length-1));
    let maxErr = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pointAt(nc, t[i]);
      const dx = p.x - pts[i].x, dy = p.y - pts[i].y, dz = p.z - pts[i].z;
      maxErr = Math.max(maxErr, Math.sqrt(dx*dx + dy*dy + dz*dz));
    }
    expect(maxErr).toBeLessThan(TOL);
  });

  test("closed curve starts and ends at the same point (no self-intersecting chord)", () => {
    const nc = createInterpolatingCubicBSpline(pts, { closed: true });
    const p0 = pointAt(nc, 0);
    const p1 = pointAt(nc, 1);
    const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
    expect(Math.sqrt(dx*dx + dy*dy + dz*dz)).toBeLessThan(TOL);
  });

  test("closed curve knot length satisfies OpenNURBS convention", () => {
    const nc = createInterpolatingCubicBSpline(pts, { closed: true });
    expect(nc.knots.length).toBe(nc.order + nc.cvCount - 2);
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
