// nurbs-curve-algorithms.test.ts — Tests for Tier 2 curve algorithms (#72).

import { describe, expect, test } from "bun:test";
import {
  nurbsCurveFromArc,
  intersectCurveCurve,
  closestPointOnCurve,
} from "../src/nurbs-curve-algorithms";
import { type NurbsCurve } from "../src/nurbs-curves";
import { pointAt, domain } from "../src/nurbs-curves";
import { Plane, type Arc } from "../src/nurbs-primitives";
import type { LineCurve } from "../src/nurbs-curves";

const EPS = 1e-9;
const close = (a: number, b: number, tol = EPS) => Math.abs(a - b) <= tol;
const closePt = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  tol = EPS,
) => close(a.x, b.x, tol) && close(a.y, b.y, tol) && close(a.z, b.z, tol);

// ── nurbsCurveFromArc ─────────────────────────────────────────────────────────

describe("nurbsCurveFromArc — unit circle", () => {
  const fullCircle: Arc = {
    center: { x: 0, y: 0, z: 0 },
    radius: 1,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: Plane.worldXY(),
  };
  const nc: NurbsCurve = nurbsCurveFromArc(fullCircle);

  test("returns rational quadratic NURBS", () => {
    expect(nc.kind).toBe("nurbs");
    expect(nc.order).toBe(3);
    expect(nc.isRational).toBe(true);
  });

  test("cvCount = 2*numSpans + 1 = 9 (4 spans for full circle)", () => {
    expect(nc.cvCount).toBe(9);
  });

  test("knot vector length = order + cvCount - 2 = 10", () => {
    expect(nc.knots.length).toBe(10);
  });

  test("domain is [0, 2π]", () => {
    const d = domain(nc);
    expect(close(d.min, 0, 1e-12)).toBe(true);
    expect(close(d.max, 2 * Math.PI, 1e-12)).toBe(true);
  });

  // Spec requirement: 5 quadrant points within 1e-12
  test("pointAt 0 → (1,0,0)", () => {
    const p = pointAt(nc, 0);
    expect(closePt(p, { x: 1, y: 0, z: 0 }, 1e-12)).toBe(true);
  });

  test("pointAt π/2 → (0,1,0)", () => {
    const p = pointAt(nc, Math.PI / 2);
    expect(closePt(p, { x: 0, y: 1, z: 0 }, 1e-12)).toBe(true);
  });

  test("pointAt π → (-1,0,0)", () => {
    const p = pointAt(nc, Math.PI);
    expect(closePt(p, { x: -1, y: 0, z: 0 }, 1e-12)).toBe(true);
  });

  test("pointAt 3π/2 → (0,-1,0)", () => {
    const p = pointAt(nc, 3 * Math.PI / 2);
    expect(closePt(p, { x: 0, y: -1, z: 0 }, 1e-12)).toBe(true);
  });

  test("pointAt 2π → (1,0,0)", () => {
    const p = pointAt(nc, 2 * Math.PI);
    expect(closePt(p, { x: 1, y: 0, z: 0 }, 1e-12)).toBe(true);
  });

  test("all quadrant points lie exactly on unit circle (r=1 within 1e-12)", () => {
    for (const t of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 2 * Math.PI]) {
      const p = pointAt(nc, t);
      const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      expect(close(r, 1, 1e-12)).toBe(true);
    }
  });

  test("mid-quadrant points also lie on unit circle (dense sampling)", () => {
    for (let i = 0; i <= 64; i++) {
      const t = (i / 64) * 2 * Math.PI;
      const p = pointAt(nc, t);
      const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      expect(close(r, 1, 1e-10)).toBe(true);
    }
  });
});

describe("nurbsCurveFromArc — quarter arc", () => {
  const quarterArc: Arc = {
    center: { x: 1, y: 1, z: 0 },
    radius: 2,
    startAngle: 0,
    endAngle: Math.PI / 2,
    plane: Plane.worldXY(),
  };
  const nc = nurbsCurveFromArc(quarterArc);

  test("single span: cvCount=3, knots=[0,0,π/2,π/2]", () => {
    expect(nc.cvCount).toBe(3);
    expect(nc.knots.length).toBe(4); // order + cvCount - 2 = 3 + 3 - 2 = 4
  });

  test("pointAt start gives correct point", () => {
    const p = pointAt(nc, 0);
    // center=(1,1,0), r=2, θ=0 → (1+2*1, 1+2*0, 0) = (3,1,0)
    expect(closePt(p, { x: 3, y: 1, z: 0 }, 1e-12)).toBe(true);
  });

  test("pointAt end gives correct point", () => {
    const p = pointAt(nc, Math.PI / 2);
    // center=(1,1,0), r=2, θ=π/2 → (1+2*0, 1+2*1, 0) = (1,3,0)
    expect(closePt(p, { x: 1, y: 3, z: 0 }, 1e-12)).toBe(true);
  });

  test("all sampled points at distance 2 from center", () => {
    for (let i = 0; i <= 32; i++) {
      const t = (i / 32) * (Math.PI / 2);
      const p = pointAt(nc, t);
      const cx = 1, cy = 1, cz = 0;
      const r = Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2);
      expect(close(r, 2, 1e-10)).toBe(true);
    }
  });
});

// ── intersectCurveCurve ───────────────────────────────────────────────────────

describe("intersectCurveCurve — unit circle and line y=0", () => {
  const circleArc: Arc = {
    center: { x: 0, y: 0, z: 0 },
    radius: 1,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: Plane.worldXY(),
  };
  const circleNurbs = nurbsCurveFromArc(circleArc);

  const xLine: LineCurve = {
    kind: "line",
    from: { x: -2, y: 0, z: 0 },
    to: { x: 2, y: 0, z: 0 },
    domain: { min: 0, max: 4 },
  };

  const intersections = intersectCurveCurve(circleNurbs, xLine, 1e-4);

  test("finds exactly 2 intersections", () => {
    expect(intersections.length).toBe(2);
  });

  test("intersection points lie on the unit circle", () => {
    for (const ix of intersections) {
      const r = Math.sqrt(ix.pointA.x ** 2 + ix.pointA.y ** 2 + ix.pointA.z ** 2);
      expect(close(r, 1, 1e-4)).toBe(true);
    }
  });

  test("intersection points have y ≈ 0 (on the x-axis)", () => {
    for (const ix of intersections) {
      expect(close(ix.pointA.y, 0, 1e-4)).toBe(true);
    }
  });

  test("both x=+1 and x=-1 are found", () => {
    const xs = intersections.map(ix => ix.pointA.x).sort((a, b) => a - b);
    expect(close(xs[0], -1, 1e-4)).toBe(true);
    expect(close(xs[1], 1, 1e-4)).toBe(true);
  });
});

describe("intersectCurveCurve — parallel lines → 0 intersections", () => {
  const line1: LineCurve = {
    kind: "line",
    from: { x: -2, y: 0, z: 0 },
    to: { x: 2, y: 0, z: 0 },
    domain: { min: 0, max: 4 },
  };
  const line2: LineCurve = {
    kind: "line",
    from: { x: -2, y: 1, z: 0 },
    to: { x: 2, y: 1, z: 0 },
    domain: { min: 0, max: 4 },
  };

  test("returns 0 intersections for parallel lines", () => {
    const ix = intersectCurveCurve(line1, line2, 1e-4);
    expect(ix.length).toBe(0);
  });
});

describe("intersectCurveCurve — perpendicular lines → 1 intersection", () => {
  const line1: LineCurve = {
    kind: "line",
    from: { x: -2, y: 0, z: 0 },
    to: { x: 2, y: 0, z: 0 },
    domain: { min: 0, max: 4 },
  };
  const line2: LineCurve = {
    kind: "line",
    from: { x: 0, y: -2, z: 0 },
    to: { x: 0, y: 2, z: 0 },
    domain: { min: 0, max: 4 },
  };

  const ix = intersectCurveCurve(line1, line2, 1e-4);

  test("finds exactly 1 intersection at origin", () => {
    expect(ix.length).toBe(1);
    expect(closePt(ix[0].pointA, { x: 0, y: 0, z: 0 }, 1e-4)).toBe(true);
  });
});

// ── closestPointOnCurve ───────────────────────────────────────────────────────

describe("closestPointOnCurve — unit circle, query (2,0,0)", () => {
  const circleArc: Arc = {
    center: { x: 0, y: 0, z: 0 },
    radius: 1,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: Plane.worldXY(),
  };
  const nc = nurbsCurveFromArc(circleArc);
  const result = closestPointOnCurve(nc, { x: 2, y: 0, z: 0 });

  test("closest point is (1,0,0)", () => {
    expect(closePt(result.point, { x: 1, y: 0, z: 0 }, 1e-6)).toBe(true);
  });

  test("distance is 1", () => {
    expect(close(result.distance, 1, 1e-6)).toBe(true);
  });

  test("param is near 0 or 2π", () => {
    const t = result.param;
    const ok = t <= 1e-6 || Math.abs(t - 2 * Math.PI) <= 1e-6;
    expect(ok).toBe(true);
  });
});

describe("closestPointOnCurve — line segment, query off midpoint", () => {
  const line: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 4, y: 0, z: 0 },
    domain: { min: 0, max: 4 },
  };

  test("closest point from (2,3,0) is (2,0,0)", () => {
    const result = closestPointOnCurve(line, { x: 2, y: 3, z: 0 });
    expect(closePt(result.point, { x: 2, y: 0, z: 0 }, 1e-6)).toBe(true);
    expect(close(result.distance, 3, 1e-6)).toBe(true);
  });

  test("closest point from (-1,0,0) (before start) clamps to start", () => {
    const result = closestPointOnCurve(line, { x: -1, y: 0, z: 0 });
    expect(closePt(result.point, { x: 0, y: 0, z: 0 }, 1e-6)).toBe(true);
    expect(close(result.distance, 1, 1e-6)).toBe(true);
  });
});
