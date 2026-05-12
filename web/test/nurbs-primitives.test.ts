// nurbs-primitives.test.ts — Unit tests for §2 primitive value types (#64 Tier 1).

import { describe, expect, test } from "bun:test";
import {
  Point2, Point3, Vector3,
  Line, Polyline, Rectangle, Plane, BoundingBox, Interval, Xform,
} from "../src/nurbs/nurbs-primitives";

// ── Point2 ──────────────────────────────────────────────────────────────────

describe("Point2", () => {
  test("create returns correct shape", () => {
    expect(Point2.create(3, 4)).toEqual({ x: 3, y: 4 });
  });
  test("zero returns origin", () => {
    expect(Point2.zero()).toEqual({ x: 0, y: 0 });
  });
  test("add", () => {
    expect(Point2.add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
  });
  test("sub", () => {
    expect(Point2.sub({ x: 5, y: 3 }, { x: 2, y: 1 })).toEqual({ x: 3, y: 2 });
  });
  test("scale", () => {
    expect(Point2.scale({ x: 2, y: 3 }, 2)).toEqual({ x: 4, y: 6 });
  });
  test("distance — 3-4-5 triangle", () => {
    expect(Point2.distance(Point2.zero(), { x: 3, y: 4 })).toBeCloseTo(5);
  });
  test("lerp midpoint", () => {
    expect(Point2.lerp({ x: 0, y: 0 }, { x: 2, y: 4 }, 0.5)).toEqual({ x: 1, y: 2 });
  });
  test("equals with tolerance", () => {
    expect(Point2.equals({ x: 0, y: 0 }, { x: 1e-7, y: 0 }, 1e-6)).toBe(true);
    expect(Point2.equals({ x: 0, y: 0 }, { x: 1e-5, y: 0 }, 1e-6)).toBe(false);
  });
});

// ── Point3 ──────────────────────────────────────────────────────────────────

describe("Point3", () => {
  test("create returns correct shape", () => {
    expect(Point3.create(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
  });
  test("zero", () => {
    expect(Point3.zero()).toEqual({ x: 0, y: 0, z: 0 });
  });
  test("add", () => {
    expect(Point3.add(Point3.create(1, 2, 3), Point3.create(4, 5, 6))).toEqual({ x: 5, y: 7, z: 9 });
  });
  test("sub", () => {
    expect(Point3.sub(Point3.create(5, 5, 5), Point3.create(1, 2, 3))).toEqual({ x: 4, y: 3, z: 2 });
  });
  test("scale", () => {
    expect(Point3.scale(Point3.create(1, 2, 3), 3)).toEqual({ x: 3, y: 6, z: 9 });
  });
  test("distance — 3-4-5 in XY", () => {
    expect(Point3.distance(Point3.zero(), Point3.create(3, 4, 0))).toBeCloseTo(5);
  });
  test("distanceSq", () => {
    expect(Point3.distanceSq(Point3.zero(), Point3.create(1, 2, 2))).toBeCloseTo(9);
  });
  test("lerp endpoint t=0 and t=1", () => {
    const a = Point3.create(1, 1, 1), b = Point3.create(3, 3, 3);
    expect(Point3.lerp(a, b, 0)).toEqual(a);
    expect(Point3.lerp(a, b, 1)).toEqual(b);
  });
  test("lerp midpoint", () => {
    expect(Point3.lerp(Point3.zero(), Point3.create(2, 4, 6), 0.5)).toEqual({ x: 1, y: 2, z: 3 });
  });
  test("equals exact", () => {
    expect(Point3.equals(Point3.create(1, 2, 3), Point3.create(1, 2, 3))).toBe(true);
  });
  test("equals with tolerance", () => {
    expect(Point3.equals(Point3.create(0, 0, 0), Point3.create(1e-7, 0, 0), 1e-6)).toBe(true);
  });
  test("transform — identity leaves point unchanged", () => {
    const p = Point3.create(1, 2, 3);
    expect(Point3.transform(p, Xform.identity())).toEqual(p);
  });
  test("transform — translation", () => {
    const p = Point3.create(0, 0, 0);
    const xf = Xform.translation(Vector3.create(5, 6, 7));
    const r = Point3.transform(p, xf);
    expect(r.x).toBeCloseTo(5);
    expect(r.y).toBeCloseTo(6);
    expect(r.z).toBeCloseTo(7);
  });
});

// ── Vector3 ─────────────────────────────────────────────────────────────────

describe("Vector3", () => {
  test("create", () => {
    expect(Vector3.create(1, 2, 3)).toEqual({ x: 1, y: 2, z: 3 });
  });
  test("axis helpers", () => {
    expect(Vector3.xAxis()).toEqual({ x: 1, y: 0, z: 0 });
    expect(Vector3.yAxis()).toEqual({ x: 0, y: 1, z: 0 });
    expect(Vector3.zAxis()).toEqual({ x: 0, y: 0, z: 1 });
  });
  test("dot product", () => {
    expect(Vector3.dot(Vector3.xAxis(), Vector3.yAxis())).toBeCloseTo(0);
    expect(Vector3.dot(Vector3.xAxis(), Vector3.xAxis())).toBeCloseTo(1);
  });
  test("cross product X×Y=Z", () => {
    const c = Vector3.cross(Vector3.xAxis(), Vector3.yAxis());
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(0);
    expect(c.z).toBeCloseTo(1);
  });
  test("length of unit axes", () => {
    expect(Vector3.length(Vector3.xAxis())).toBeCloseTo(1);
  });
  test("length of (3,4,0)", () => {
    expect(Vector3.length(Vector3.create(3, 4, 0))).toBeCloseTo(5);
  });
  test("normalize produces unit vector", () => {
    const v = Vector3.normalize(Vector3.create(3, 4, 0));
    expect(Vector3.length(v)).toBeCloseTo(1);
    expect(v.x).toBeCloseTo(0.6);
    expect(v.y).toBeCloseTo(0.8);
  });
  test("normalize zero vector returns zero", () => {
    expect(Vector3.normalize(Vector3.zero())).toEqual({ x: 0, y: 0, z: 0 });
  });
  test("isUnitVector", () => {
    expect(Vector3.isUnitVector(Vector3.xAxis())).toBe(true);
    expect(Vector3.isUnitVector(Vector3.create(3, 4, 0))).toBe(false);
  });
  test("negate", () => {
    expect(Vector3.negate(Vector3.create(1, -2, 3))).toEqual({ x: -1, y: 2, z: -3 });
  });
  test("transform — identity preserves direction", () => {
    const v = Vector3.create(1, 0, 0);
    expect(Vector3.transform(v, Xform.identity())).toEqual(v);
  });
  test("transform — translation does NOT affect vector", () => {
    const v = Vector3.create(1, 0, 0);
    const xf = Xform.translation(Vector3.create(100, 100, 100));
    const r = Vector3.transform(v, xf);
    expect(r.x).toBeCloseTo(1);
    expect(r.y).toBeCloseTo(0);
    expect(r.z).toBeCloseTo(0);
  });
});

// ── Line ─────────────────────────────────────────────────────────────────────

describe("Line", () => {
  const l = Line.create(Point3.zero(), Point3.create(1, 0, 0));

  test("create", () => {
    expect(l.from).toEqual({ x: 0, y: 0, z: 0 });
    expect(l.to).toEqual({ x: 1, y: 0, z: 0 });
  });
  test("fromCoords", () => {
    const l2 = Line.fromCoords(0, 0, 0, 1, 0, 0);
    expect(l2.from).toEqual(l.from);
    expect(l2.to).toEqual(l.to);
  });
  test("length", () => {
    expect(Line.length(l)).toBeCloseTo(1);
    expect(Line.length(Line.create(Point3.zero(), Point3.create(3, 4, 0)))).toBeCloseTo(5);
  });
  test("midpoint", () => {
    expect(Line.midpoint(l)).toEqual({ x: 0.5, y: 0, z: 0 });
  });
  test("direction", () => {
    expect(Line.direction(l)).toEqual({ x: 1, y: 0, z: 0 });
  });
  test("tangent is normalized", () => {
    const t = Line.tangent(Line.create(Point3.zero(), Point3.create(3, 4, 0)));
    expect(Vector3.length(t)).toBeCloseTo(1);
  });
  test("pointAt t=0 and t=1", () => {
    expect(Line.pointAt(l, 0)).toEqual(l.from);
    expect(Line.pointAt(l, 1)).toEqual(l.to);
  });
  test("pointAt t=0.5 midpoint", () => {
    expect(Line.pointAt(l, 0.5)).toEqual({ x: 0.5, y: 0, z: 0 });
  });
  test("closestPoint clamps to segment", () => {
    const p = Point3.create(2, 1, 0);
    const cp = Line.closestPoint(l, p);
    expect(cp.x).toBeCloseTo(1); // clamped to endpoint
    expect(cp.y).toBeCloseTo(0);
  });
  test("closestPoint on midpoint perpendicular", () => {
    const p = Point3.create(0.5, 5, 0);
    const cp = Line.closestPoint(l, p);
    expect(cp.x).toBeCloseTo(0.5);
    expect(cp.y).toBeCloseTo(0);
  });
  test("reverse swaps endpoints", () => {
    const r = Line.reverse(l);
    expect(r.from).toEqual(l.to);
    expect(r.to).toEqual(l.from);
  });
  test("transform — identity", () => {
    const t = Line.transform(l, Xform.identity());
    expect(t.from).toEqual(l.from);
    expect(t.to).toEqual(l.to);
  });
});

// ── Polyline ─────────────────────────────────────────────────────────────────

describe("Polyline", () => {
  const pts = [Point3.zero(), Point3.create(1, 0, 0), Point3.create(1, 1, 0)];

  test("create", () => {
    const pl = Polyline.create(pts);
    expect(pl.closed).toBe(false);
    expect(pl.points.length).toBe(3);
  });
  test("length open", () => {
    const pl = Polyline.create(pts);
    expect(Polyline.length(pl)).toBeCloseTo(2);
  });
  test("length closed", () => {
    const pl = Polyline.create(pts, true);
    expect(Polyline.length(pl)).toBeCloseTo(2 + Math.sqrt(2));
  });
  test("segmentCount open", () => {
    expect(Polyline.segmentCount(Polyline.create(pts))).toBe(2);
  });
  test("segmentCount closed", () => {
    expect(Polyline.segmentCount(Polyline.create(pts, true))).toBe(3);
  });
  test("segmentCount empty", () => {
    expect(Polyline.segmentCount(Polyline.create([]))).toBe(0);
  });
  test("transform — identity", () => {
    const pl = Polyline.create(pts);
    const t = Polyline.transform(pl, Xform.identity());
    expect(t.points[0]).toEqual(pts[0]);
    expect(t.closed).toBe(false);
  });
});

// ── Rectangle ────────────────────────────────────────────────────────────────

describe("Rectangle", () => {
  const r = Rectangle.create(Point2.zero(), 4, 2);

  test("area", () => {
    expect(Rectangle.area(r)).toBeCloseTo(8);
  });
  test("perimeter", () => {
    expect(Rectangle.perimeter(r)).toBeCloseTo(12);
  });
  test("corners count", () => {
    expect(Rectangle.corners(r).length).toBe(4);
  });
  test("corners unrotated", () => {
    const c = Rectangle.corners(r);
    expect(c[0]).toEqual({ x: -2, y: -1 });
    expect(c[1]).toEqual({ x:  2, y: -1 });
    expect(c[2]).toEqual({ x:  2, y:  1 });
    expect(c[3]).toEqual({ x: -2, y:  1 });
  });
  test("corners rotated 90° — x extends along y", () => {
    const r90 = Rectangle.create(Point2.zero(), 4, 2, Math.PI / 2);
    const c = Rectangle.corners(r90);
    expect(c[0].x).toBeCloseTo(1);
    expect(c[0].y).toBeCloseTo(-2);
  });
});

// ── Plane ────────────────────────────────────────────────────────────────────

describe("Plane", () => {
  const xy = Plane.worldXY();

  test("worldXY normal is Z", () => {
    expect(xy.normal).toEqual({ x: 0, y: 0, z: 1 });
  });
  test("pointAt", () => {
    const p = Plane.pointAt(xy, 3, 4);
    expect(p).toEqual({ x: 3, y: 4, z: 0 });
  });
  test("distanceTo from above", () => {
    expect(Plane.distanceTo(xy, Point3.create(0, 0, 5))).toBeCloseTo(5);
  });
  test("distanceTo from below is negative", () => {
    expect(Plane.distanceTo(xy, Point3.create(0, 0, -3))).toBeCloseTo(-3);
  });
  test("projectPoint onto xy-plane", () => {
    const projected = Plane.projectPoint(xy, Point3.create(1, 2, 7));
    expect(projected.x).toBeCloseTo(1);
    expect(projected.y).toBeCloseTo(2);
    expect(projected.z).toBeCloseTo(0);
  });
  test("fromPointNormal — normal is unit length", () => {
    const pl = Plane.fromPointNormal(Point3.create(0, 0, 5), Vector3.create(0, 0, 1));
    expect(Vector3.length(pl.normal)).toBeCloseTo(1);
    expect(Plane.distanceTo(pl, Point3.create(0, 0, 7))).toBeCloseTo(2);
  });
});

// ── BoundingBox ──────────────────────────────────────────────────────────────

describe("BoundingBox", () => {
  const bb = BoundingBox.create(Point3.zero(), Point3.create(2, 3, 4));

  test("center", () => {
    expect(BoundingBox.center(bb)).toEqual({ x: 1, y: 1.5, z: 2 });
  });
  test("diagonal", () => {
    expect(BoundingBox.diagonal(bb)).toEqual({ x: 2, y: 3, z: 4 });
  });
  test("volume", () => {
    expect(BoundingBox.volume(bb)).toBeCloseTo(24);
  });
  test("contains — inside", () => {
    expect(BoundingBox.contains(bb, Point3.create(1, 1, 1))).toBe(true);
  });
  test("contains — on boundary", () => {
    expect(BoundingBox.contains(bb, Point3.zero())).toBe(true);
  });
  test("contains — outside", () => {
    expect(BoundingBox.contains(bb, Point3.create(3, 3, 3))).toBe(false);
  });
  test("intersects — overlapping", () => {
    const b2 = BoundingBox.create(Point3.create(1, 1, 1), Point3.create(3, 3, 3));
    expect(BoundingBox.intersects(bb, b2)).toBe(true);
  });
  test("intersects — non-overlapping", () => {
    const b2 = BoundingBox.create(Point3.create(5, 5, 5), Point3.create(7, 7, 7));
    expect(BoundingBox.intersects(bb, b2)).toBe(false);
  });
  test("expand grows to include point", () => {
    const expanded = BoundingBox.expand(bb, Point3.create(10, 10, 10));
    expect(expanded.max).toEqual({ x: 10, y: 10, z: 10 });
  });
  test("fromPoints", () => {
    const pts = [Point3.create(1, 2, 3), Point3.create(-1, 5, 0)];
    const b = BoundingBox.fromPoints(pts);
    expect(b.min).toEqual({ x: -1, y: 2, z: 0 });
    expect(b.max).toEqual({ x: 1, y: 5, z: 3 });
  });
  test("empty isValid returns false", () => {
    expect(BoundingBox.isValid(BoundingBox.empty())).toBe(false);
  });
});

// ── Interval ─────────────────────────────────────────────────────────────────

describe("Interval", () => {
  const iv = Interval.create(2, 8);

  test("length", () => {
    expect(Interval.length(iv)).toBeCloseTo(6);
  });
  test("mid", () => {
    expect(Interval.mid(iv)).toBeCloseTo(5);
  });
  test("isIncreasing", () => {
    expect(Interval.isIncreasing(iv)).toBe(true);
    expect(Interval.isIncreasing(Interval.create(3, 3))).toBe(false);
  });
  test("includes", () => {
    expect(Interval.includes(iv, 5)).toBe(true);
    expect(Interval.includes(iv, 2)).toBe(true);
    expect(Interval.includes(iv, 9)).toBe(false);
  });
  test("includes strict excludes endpoints", () => {
    expect(Interval.includes(iv, 2, true)).toBe(false);
    expect(Interval.includes(iv, 8, true)).toBe(false);
    expect(Interval.includes(iv, 5, true)).toBe(true);
  });
  test("parameterAt", () => {
    expect(Interval.parameterAt(iv, 0)).toBeCloseTo(2);
    expect(Interval.parameterAt(iv, 1)).toBeCloseTo(8);
    expect(Interval.parameterAt(iv, 0.5)).toBeCloseTo(5);
  });
  test("normalizedParameterAt", () => {
    expect(Interval.normalizedParameterAt(iv, 5)).toBeCloseTo(0.5);
    expect(Interval.normalizedParameterAt(iv, 2)).toBeCloseTo(0);
    expect(Interval.normalizedParameterAt(iv, 8)).toBeCloseTo(1);
  });
  test("intersection", () => {
    const r = Interval.intersection(iv, Interval.create(5, 10));
    expect(r).not.toBeNull();
    expect(r!.min).toBeCloseTo(5);
    expect(r!.max).toBeCloseTo(8);
  });
  test("intersection non-overlapping returns null", () => {
    expect(Interval.intersection(iv, Interval.create(10, 20))).toBeNull();
  });
  test("union", () => {
    const u = Interval.union(iv, Interval.create(5, 15));
    expect(u.min).toBeCloseTo(2);
    expect(u.max).toBeCloseTo(15);
  });
});

// ── Xform ─────────────────────────────────────────────────────────────────────

describe("Xform", () => {
  test("identity is identity", () => {
    expect(Xform.isIdentity(Xform.identity())).toBe(true);
  });
  test("zero is not identity", () => {
    expect(Xform.isIdentity(Xform.zero())).toBe(false);
  });
  test("multiply identity × identity = identity", () => {
    const r = Xform.multiply(Xform.identity(), Xform.identity());
    expect(Xform.isIdentity(r)).toBe(true);
  });
  test("translation applies to point", () => {
    const xf = Xform.translation(Vector3.create(1, 2, 3));
    const p = Point3.transform(Point3.zero(), xf);
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(2);
    expect(p.z).toBeCloseTo(3);
  });
  test("uniformScale scales point", () => {
    const xf = Xform.uniformScale(3);
    const p = Point3.transform(Point3.create(1, 2, 3), xf);
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(6);
    expect(p.z).toBeCloseTo(9);
  });
  test("scale per-axis", () => {
    const xf = Xform.scale(2, 3, 4);
    const p = Point3.transform(Point3.create(1, 1, 1), xf);
    expect(p.x).toBeCloseTo(2);
    expect(p.y).toBeCloseTo(3);
    expect(p.z).toBeCloseTo(4);
  });
  test("rotationAboutAxis — 90° about Z rotates X to Y", () => {
    const xf = Xform.rotationAboutAxis(Vector3.zAxis(), Math.PI / 2);
    const p = Point3.transform(Point3.create(1, 0, 0), xf);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
    expect(p.z).toBeCloseTo(0);
  });
  test("rotationAboutAxis — 360° returns to start", () => {
    const xf = Xform.rotationAboutAxis(Vector3.zAxis(), 2 * Math.PI);
    const p = Point3.transform(Point3.create(3, 4, 5), xf);
    expect(p.x).toBeCloseTo(3);
    expect(p.y).toBeCloseTo(4);
    expect(p.z).toBeCloseTo(5);
  });
  test("multiply compose: translate then scale", () => {
    const t = Xform.translation(Vector3.create(1, 0, 0));
    const s = Xform.uniformScale(2);
    // scale(translate(p)) = scale(p + (1,0,0)) = 2*(p+(1,0,0))
    const composed = Xform.multiply(s, t);
    const p = Point3.transform(Point3.create(0, 0, 0), composed);
    expect(p.x).toBeCloseTo(2);
    expect(p.y).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
  });
});
