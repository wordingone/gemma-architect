// nurbs-curves.test.ts — Unit tests for Tier 2 curve representation (#72).

import { describe, expect, test } from "bun:test";
import {
  type NurbsCurve,
  type LineCurve,
  type PolylineCurve,
  type ArcCurve,
  domain,
  degree,
  pointAt,
  tangentAt,
  isClosed,
  reverse,
  transform,
  trim,
  split,
  tessellate,
  createClampedUniformNurbs,
} from "../src/nurbs/nurbs-curves";
import { Plane, Point3, Xform } from "../src/nurbs/nurbs-primitives";

const EPS = 1e-9;
const close = (a: number, b: number, tol = EPS) => Math.abs(a - b) <= tol;
const closePt = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, tol = EPS) =>
  close(a.x, b.x, tol) && close(a.y, b.y, tol) && close(a.z, b.z, tol);

// ── LineCurve ────────────────────────────────────────────────────────────────

describe("LineCurve", () => {
  const line: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 4, y: 0, z: 0 },
    domain: { min: 0, max: 4 },
  };

  test("domain", () => {
    const d = domain(line);
    expect(d.min).toBe(0);
    expect(d.max).toBe(4);
  });

  test("degree is 1", () => {
    expect(degree(line)).toBe(1);
  });

  test("pointAt endpoints", () => {
    expect(closePt(pointAt(line, 0), { x: 0, y: 0, z: 0 })).toBe(true);
    expect(closePt(pointAt(line, 4), { x: 4, y: 0, z: 0 })).toBe(true);
  });

  test("pointAt midpoint", () => {
    expect(closePt(pointAt(line, 2), { x: 2, y: 0, z: 0 })).toBe(true);
  });

  test("tangentAt is constant unit +X", () => {
    const t = tangentAt(line, 2);
    expect(close(t.x, 1)).toBe(true);
    expect(close(t.y, 0)).toBe(true);
    expect(close(t.z, 0)).toBe(true);
  });

  test("isClosed is false", () => {
    expect(isClosed(line)).toBe(false);
  });

  test("reverse swaps endpoints", () => {
    const r = reverse(line);
    if (r.kind !== "line") throw new Error("expected line");
    expect(closePt(r.from, line.to)).toBe(true);
    expect(closePt(r.to, line.from)).toBe(true);
  });

  test("tessellate samples endpoints", () => {
    const pts = tessellate(line, 3);
    expect(pts.length).toBe(3);
    expect(closePt(pts[0], line.from)).toBe(true);
    expect(closePt(pts[2], line.to)).toBe(true);
  });
});

// ── PolylineCurve ────────────────────────────────────────────────────────────

describe("PolylineCurve", () => {
  const poly: PolylineCurve = {
    kind: "polyline",
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 2, y: 0, z: 0 },
    ],
    parameters: [0, Math.SQRT2, 2 * Math.SQRT2],
  };

  test("domain endpoints", () => {
    const d = domain(poly);
    expect(d.min).toBe(0);
    expect(close(d.max, 2 * Math.SQRT2)).toBe(true);
  });

  test("pointAt at first parameter is first point", () => {
    expect(closePt(pointAt(poly, 0), poly.points[0])).toBe(true);
  });

  test("pointAt at last parameter is last point", () => {
    expect(closePt(pointAt(poly, 2 * Math.SQRT2), poly.points[2])).toBe(true);
  });

  test("pointAt at middle parameter is middle point", () => {
    expect(closePt(pointAt(poly, Math.SQRT2), poly.points[1])).toBe(true);
  });
});

// ── ArcCurve (quarter circle) ────────────────────────────────────────────────

describe("ArcCurve (quarter circle)", () => {
  const arc: ArcCurve = {
    kind: "arc",
    center: { x: 0, y: 0, z: 0 },
    radius: 1,
    startAngle: 0,
    endAngle: Math.PI / 2,
    plane: Plane.worldXY(),
    domain: { min: 0, max: Math.PI / 2 },
  };

  test("domain", () => {
    const d = domain(arc);
    expect(d.min).toBe(0);
    expect(close(d.max, Math.PI / 2)).toBe(true);
  });

  test("degree is 2 (rational quadratic in NURBS form)", () => {
    expect(degree(arc)).toBe(2);
  });

  test("pointAt start gives (1,0,0)", () => {
    const p = pointAt(arc, 0);
    expect(closePt(p, { x: 1, y: 0, z: 0 }, 1e-12)).toBe(true);
  });

  test("pointAt end gives (0,1,0)", () => {
    const p = pointAt(arc, Math.PI / 2);
    expect(closePt(p, { x: 0, y: 1, z: 0 }, 1e-12)).toBe(true);
  });

  test("pointAt midpoint gives (cos(π/4), sin(π/4), 0)", () => {
    const p = pointAt(arc, Math.PI / 4);
    const expected = Math.SQRT2 / 2;
    expect(closePt(p, { x: expected, y: expected, z: 0 }, 1e-12)).toBe(true);
  });

  test("isClosed is false", () => {
    expect(isClosed(arc)).toBe(false);
  });

  test("tessellate produces N points on the unit circle", () => {
    const pts = tessellate(arc, 9);
    for (const p of pts) {
      const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
      expect(close(r, 1, 1e-12)).toBe(true);
    }
  });
});

// ── ArcCurve (full circle — isClosed) ────────────────────────────────────────

describe("ArcCurve (full circle)", () => {
  const circle: ArcCurve = {
    kind: "arc",
    center: { x: 0, y: 0, z: 0 },
    radius: 2,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: Plane.worldXY(),
    domain: { min: 0, max: 2 * Math.PI },
  };

  test("isClosed", () => {
    expect(isClosed(circle, 1e-12)).toBe(true);
  });

  test("pointAt midpoint (π) gives (-2,0,0)", () => {
    const p = pointAt(circle, Math.PI);
    expect(closePt(p, { x: -2, y: 0, z: 0 }, 1e-12)).toBe(true);
  });
});

// ── NurbsCurve (line as degree-1 NURBS) ──────────────────────────────────────

describe("NurbsCurve (degree-1 line)", () => {
  // Degree-1 NURBS = linear segment from (0,0,0) to (1,0,0)
  // order=2, cvCount=2, OpenNURBS knots: [0, 1] (length = 2+2-2 = 2)
  const nc: NurbsCurve = {
    kind: "nurbs",
    dim: 3,
    isRational: false,
    order: 2,
    cvCount: 2,
    knots: [0, 1],
    cvs: [0, 0, 0, 1, 0, 0],
    cvStride: 3,
  };

  test("domain is [0,1]", () => {
    const d = domain(nc);
    expect(d.min).toBe(0);
    expect(d.max).toBe(1);
  });

  test("pointAt 0 gives origin", () => {
    expect(closePt(pointAt(nc, 0), { x: 0, y: 0, z: 0 })).toBe(true);
  });

  test("pointAt 1 gives (1,0,0)", () => {
    expect(closePt(pointAt(nc, 1), { x: 1, y: 0, z: 0 })).toBe(true);
  });

  test("pointAt 0.5 gives midpoint", () => {
    expect(closePt(pointAt(nc, 0.5), { x: 0.5, y: 0, z: 0 }, 1e-9)).toBe(true);
  });

  test("degree is 1", () => {
    expect(degree(nc)).toBe(1);
  });

  test("reverse flips", () => {
    const r = reverse(nc);
    expect(closePt(pointAt(r, 0), { x: 1, y: 0, z: 0 }, 1e-9)).toBe(true);
    expect(closePt(pointAt(r, 1), { x: 0, y: 0, z: 0 }, 1e-9)).toBe(true);
  });
});

// ── createClampedUniformNurbs ─────────────────────────────────────────────────

describe("createClampedUniformNurbs (cubic spline)", () => {
  // 5 collinear control points along X axis → cubic spline should pass through endpoints
  const pts = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
    { x: 4, y: 0, z: 0 },
  ];
  const nc = createClampedUniformNurbs(3, 4, pts);

  test("returns NurbsCurve", () => {
    expect(nc.kind).toBe("nurbs");
    expect(nc.order).toBe(4);
    expect(nc.cvCount).toBe(5);
  });

  test("knot vector length = order + cvCount - 2", () => {
    expect(nc.knots.length).toBe(nc.order + nc.cvCount - 2);
  });

  test("pointAt domain min gives first control point", () => {
    const d = domain(nc);
    expect(closePt(pointAt(nc, d.min), pts[0], 1e-10)).toBe(true);
  });

  test("pointAt domain max gives last control point", () => {
    const d = domain(nc);
    expect(closePt(pointAt(nc, d.max), pts[4], 1e-10)).toBe(true);
  });

  test("throws for too few points", () => {
    expect(() => createClampedUniformNurbs(3, 4, [pts[0], pts[1]])).toThrow();
  });
});

// ── transform ────────────────────────────────────────────────────────────────

describe("transform", () => {
  const line: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 1, y: 0, z: 0 },
    domain: { min: 0, max: 1 },
  };

  test("identity leaves line unchanged", () => {
    const t = transform(line, Xform.identity());
    if (t.kind !== "line") throw new Error("expected line");
    expect(closePt(t.from, line.from)).toBe(true);
    expect(closePt(t.to, line.to)).toBe(true);
  });

  test("translation moves line", () => {
    const xf = Xform.translation({ x: 5, y: 3, z: 1 });
    const t = transform(line, xf);
    if (t.kind !== "line") throw new Error("expected line");
    expect(closePt(t.from, { x: 5, y: 3, z: 1 }, 1e-9)).toBe(true);
    expect(closePt(t.to, { x: 6, y: 3, z: 1 }, 1e-9)).toBe(true);
  });
});

// ── trim / split ─────────────────────────────────────────────────────────────

describe("trim and split", () => {
  const line: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to: { x: 4, y: 0, z: 0 },
    domain: { min: 0, max: 4 },
  };

  test("trim restricts domain", () => {
    const tr = trim(line, { min: 1, max: 3 });
    const d = domain(tr);
    expect(d.min).toBe(1);
    expect(d.max).toBe(3);
  });

  test("split produces two non-overlapping pieces", () => {
    const [left, right] = split(line, 2);
    const dl = domain(left);
    const dr = domain(right);
    expect(dl.min).toBe(0);
    expect(close(dl.max, 2)).toBe(true);
    expect(close(dr.min, 2)).toBe(true);
    expect(close(dr.max, 4)).toBe(true);
  });
});
