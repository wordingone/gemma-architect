// nurbs-primitives.ts — Clean-room TypeScript primitive value types
// anchored to openNURBS §2 (opennurbs_point.h and companions).
//
// Design: plain structural interfaces + namespace-style factory objects.
// No class inheritance, no virtual methods — idiomatic TypeScript.
// Methods belong to the factory namespace (Point3.add(...)), not instances.
//
// License: paraphrase of openNURBS signatures and algorithmic notes only.
// No source-line reproduction. See web/src/nurbs-kernel.LICENSE.md.
//
// Tier 1 of #58. Curve/surface algorithms land in Tier 2+.

// ── 2D point ─────────────────────────────────────────────────────────────────

export interface Point2 {
  x: number;
  y: number;
}

export const Point2 = {
  create(x: number, y: number): Point2 { return { x, y }; },
  zero(): Point2 { return { x: 0, y: 0 }; },
  add(a: Point2, b: Point2): Point2 { return { x: a.x + b.x, y: a.y + b.y }; },
  sub(a: Point2, b: Point2): Point2 { return { x: a.x - b.x, y: a.y - b.y }; },
  scale(a: Point2, s: number): Point2 { return { x: a.x * s, y: a.y * s }; },
  distance(a: Point2, b: Point2): number {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  },
  lerp(a: Point2, b: Point2, t: number): Point2 {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  },
  equals(a: Point2, b: Point2, tol = 0): boolean {
    return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
  },
};

// ── 3D point ─────────────────────────────────────────────────────────────────

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export const Point3 = {
  create(x: number, y: number, z: number): Point3 { return { x, y, z }; },
  zero(): Point3 { return { x: 0, y: 0, z: 0 }; },
  add(a: Point3, b: Point3): Point3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  },
  sub(a: Point3, b: Point3): Point3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  },
  scale(a: Point3, s: number): Point3 {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
  },
  distance(a: Point3, b: Point3): number {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },
  distanceSq(a: Point3, b: Point3): number {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  },
  lerp(a: Point3, b: Point3, t: number): Point3 {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  },
  equals(a: Point3, b: Point3, tol = 0): boolean {
    return (
      Math.abs(a.x - b.x) <= tol &&
      Math.abs(a.y - b.y) <= tol &&
      Math.abs(a.z - b.z) <= tol
    );
  },
  // Apply an Xform (4×4 row-major) to a point (homogeneous divide included).
  transform(p: Point3, xf: Xform): Point3 {
    const m = xf.m;
    const w = m[12] * p.x + m[13] * p.y + m[14] * p.z + m[15];
    const s = w !== 0 ? 1 / w : 1;
    return {
      x: (m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3]) * s,
      y: (m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7]) * s,
      z: (m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11]) * s,
    };
  },
};

// ── 3D vector (directional — translation does not affect it through xform) ───

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export const Vector3 = {
  create(x: number, y: number, z: number): Vector3 { return { x, y, z }; },
  zero(): Vector3 { return { x: 0, y: 0, z: 0 }; },
  xAxis(): Vector3 { return { x: 1, y: 0, z: 0 }; },
  yAxis(): Vector3 { return { x: 0, y: 1, z: 0 }; },
  zAxis(): Vector3 { return { x: 0, y: 0, z: 1 }; },
  add(a: Vector3, b: Vector3): Vector3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  },
  sub(a: Vector3, b: Vector3): Vector3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  },
  scale(v: Vector3, s: number): Vector3 {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
  },
  negate(v: Vector3): Vector3 {
    return { x: -v.x, y: -v.y, z: -v.z };
  },
  dot(a: Vector3, b: Vector3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },
  cross(a: Vector3, b: Vector3): Vector3 {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  },
  lengthSq(v: Vector3): number {
    return v.x * v.x + v.y * v.y + v.z * v.z;
  },
  length(v: Vector3): number {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  },
  normalize(v: Vector3): Vector3 {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (len === 0) return { x: 0, y: 0, z: 0 };
    return { x: v.x / len, y: v.y / len, z: v.z / len };
  },
  isUnitVector(v: Vector3, tol = 1e-6): boolean {
    return Math.abs(Vector3.lengthSq(v) - 1) <= tol;
  },
  // Apply an Xform to a direction vector (no translation, no homogeneous divide).
  transform(v: Vector3, xf: Xform): Vector3 {
    const m = xf.m;
    return {
      x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
      y: m[4] * v.x + m[5] * v.y + m[6] * v.z,
      z: m[8] * v.x + m[9] * v.y + m[10] * v.z,
    };
  },
};

// ── Line ─────────────────────────────────────────────────────────────────────

export interface Line {
  from: Point3;
  to: Point3;
}

export const Line = {
  create(from: Point3, to: Point3): Line { return { from, to }; },
  fromCoords(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Line {
    return { from: { x: x0, y: y0, z: z0 }, to: { x: x1, y: y1, z: z1 } };
  },
  length(l: Line): number {
    return Point3.distance(l.from, l.to);
  },
  direction(l: Line): Vector3 {
    return Point3.sub(l.to, l.from) as Vector3;
  },
  tangent(l: Line): Vector3 {
    return Vector3.normalize(Line.direction(l));
  },
  midpoint(l: Line): Point3 {
    return Point3.lerp(l.from, l.to, 0.5);
  },
  // Parameter t in [0,1] maps to from..to.
  pointAt(l: Line, t: number): Point3 {
    return Point3.lerp(l.from, l.to, t);
  },
  // Closest point on finite segment (t clamped to [0,1]).
  closestPoint(l: Line, p: Point3): Point3 {
    const d = Line.direction(l);
    const lenSq = Vector3.lengthSq(d);
    if (lenSq === 0) return { ...l.from };
    const t = Math.max(0, Math.min(1, Vector3.dot(Point3.sub(p, l.from) as Vector3, d) / lenSq));
    return Line.pointAt(l, t);
  },
  transform(l: Line, xf: Xform): Line {
    return { from: Point3.transform(l.from, xf), to: Point3.transform(l.to, xf) };
  },
  reverse(l: Line): Line {
    return { from: l.to, to: l.from };
  },
};

// ── Polyline ──────────────────────────────────────────────────────────────────

export interface Polyline {
  points: Point3[];
  closed: boolean;
}

export const Polyline = {
  create(points: Point3[], closed = false): Polyline { return { points, closed }; },
  length(pl: Polyline): number {
    let len = 0;
    const n = pl.points.length;
    for (let i = 1; i < n; i++) len += Point3.distance(pl.points[i - 1], pl.points[i]);
    if (pl.closed && n > 1) len += Point3.distance(pl.points[n - 1], pl.points[0]);
    return len;
  },
  segmentCount(pl: Polyline): number {
    const n = pl.points.length;
    if (n < 2) return 0;
    return pl.closed ? n : n - 1;
  },
  transform(pl: Polyline, xf: Xform): Polyline {
    return { points: pl.points.map((p) => Point3.transform(p, xf)), closed: pl.closed };
  },
};

// ── Rectangle (2D center-based, XY plane) ─────────────────────────────────────

export interface Rectangle {
  center: Point2;
  width: number;
  height: number;
  rotation?: number; // radians about Z, default 0
}

export const Rectangle = {
  create(center: Point2, width: number, height: number, rotation = 0): Rectangle {
    return { center, width, height, rotation };
  },
  area(r: Rectangle): number { return r.width * r.height; },
  perimeter(r: Rectangle): number { return 2 * (r.width + r.height); },
  corners(r: Rectangle): Point2[] {
    const cos = Math.cos(r.rotation ?? 0), sin = Math.sin(r.rotation ?? 0);
    const hw = r.width / 2, hh = r.height / 2;
    const pts: Point2[] = [
      { x: -hw, y: -hh }, { x:  hw, y: -hh },
      { x:  hw, y:  hh }, { x: -hw, y:  hh },
    ];
    return pts.map(({ x, y }) => ({
      x: r.center.x + x * cos - y * sin,
      y: r.center.y + x * sin + y * cos,
    }));
  },
};

// ── Plane ────────────────────────────────────────────────────────────────────

export interface Plane {
  origin: Point3;
  xAxis: Vector3;
  yAxis: Vector3;
  normal: Vector3; // = xAxis × yAxis (unit length, maintained by callers)
}

export const Plane = {
  worldXY(): Plane {
    return {
      origin: Point3.zero(),
      xAxis: Vector3.xAxis(),
      yAxis: Vector3.yAxis(),
      normal: Vector3.zAxis(),
    };
  },
  create(origin: Point3, xAxis: Vector3, yAxis: Vector3): Plane {
    return { origin, xAxis: Vector3.normalize(xAxis), yAxis: Vector3.normalize(yAxis), normal: Vector3.normalize(Vector3.cross(xAxis, yAxis)) };
  },
  fromPointNormal(origin: Point3, normal: Vector3): Plane {
    const n = Vector3.normalize(normal);
    // Pick an arbitrary perpendicular vector for xAxis.
    const arb = Math.abs(n.x) < 0.9 ? Vector3.xAxis() : Vector3.yAxis();
    const x = Vector3.normalize(Vector3.cross(arb, n));
    const y = Vector3.cross(n, x);
    return { origin, xAxis: x, yAxis: y, normal: n };
  },
  // Evaluate a point in the plane at (u, v) parameter coordinates.
  pointAt(pl: Plane, u: number, v: number): Point3 {
    return {
      x: pl.origin.x + pl.xAxis.x * u + pl.yAxis.x * v,
      y: pl.origin.y + pl.xAxis.y * u + pl.yAxis.y * v,
      z: pl.origin.z + pl.xAxis.z * u + pl.yAxis.z * v,
    };
  },
  // Signed distance from point to plane (positive = in direction of normal).
  distanceTo(pl: Plane, p: Point3): number {
    const d = Point3.sub(p, pl.origin) as Vector3;
    return Vector3.dot(d, pl.normal);
  },
  // Project a 3D point onto the plane — returns the closest point in 3D.
  projectPoint(pl: Plane, p: Point3): Point3 {
    const dist = Plane.distanceTo(pl, p);
    return {
      x: p.x - pl.normal.x * dist,
      y: p.y - pl.normal.y * dist,
      z: p.z - pl.normal.z * dist,
    };
  },
};

// ── BoundingBox (axis-aligned) ────────────────────────────────────────────────

export interface BoundingBox {
  min: Point3;
  max: Point3;
}

export const BoundingBox = {
  create(min: Point3, max: Point3): BoundingBox { return { min, max }; },
  empty(): BoundingBox {
    return {
      min: Point3.create( Infinity,  Infinity,  Infinity),
      max: Point3.create(-Infinity, -Infinity, -Infinity),
    };
  },
  isValid(bb: BoundingBox): boolean {
    return bb.min.x <= bb.max.x && bb.min.y <= bb.max.y && bb.min.z <= bb.max.z;
  },
  center(bb: BoundingBox): Point3 {
    return {
      x: (bb.min.x + bb.max.x) / 2,
      y: (bb.min.y + bb.max.y) / 2,
      z: (bb.min.z + bb.max.z) / 2,
    };
  },
  diagonal(bb: BoundingBox): Vector3 {
    return { x: bb.max.x - bb.min.x, y: bb.max.y - bb.min.y, z: bb.max.z - bb.min.z };
  },
  volume(bb: BoundingBox): number {
    if (!BoundingBox.isValid(bb)) return 0;
    const d = BoundingBox.diagonal(bb);
    return d.x * d.y * d.z;
  },
  contains(bb: BoundingBox, p: Point3): boolean {
    return (
      p.x >= bb.min.x && p.x <= bb.max.x &&
      p.y >= bb.min.y && p.y <= bb.max.y &&
      p.z >= bb.min.z && p.z <= bb.max.z
    );
  },
  intersects(a: BoundingBox, b: BoundingBox): boolean {
    return (
      a.min.x <= b.max.x && a.max.x >= b.min.x &&
      a.min.y <= b.max.y && a.max.y >= b.min.y &&
      a.min.z <= b.max.z && a.max.z >= b.min.z
    );
  },
  expand(bb: BoundingBox, p: Point3): BoundingBox {
    return {
      min: Point3.create(Math.min(bb.min.x, p.x), Math.min(bb.min.y, p.y), Math.min(bb.min.z, p.z)),
      max: Point3.create(Math.max(bb.max.x, p.x), Math.max(bb.max.y, p.y), Math.max(bb.max.z, p.z)),
    };
  },
  union(a: BoundingBox, b: BoundingBox): BoundingBox {
    return {
      min: Point3.create(Math.min(a.min.x, b.min.x), Math.min(a.min.y, b.min.y), Math.min(a.min.z, b.min.z)),
      max: Point3.create(Math.max(a.max.x, b.max.x), Math.max(a.max.y, b.max.y), Math.max(a.max.z, b.max.z)),
    };
  },
  fromPoints(pts: Point3[]): BoundingBox {
    return pts.reduce((bb, p) => BoundingBox.expand(bb, p), BoundingBox.empty());
  },
};

// ── Interval ─────────────────────────────────────────────────────────────────

export interface Interval {
  min: number;
  max: number;
}

export const Interval = {
  create(min: number, max: number): Interval { return { min, max }; },
  length(iv: Interval): number { return iv.max - iv.min; },
  mid(iv: Interval): number { return (iv.min + iv.max) / 2; },
  isIncreasing(iv: Interval): boolean { return iv.min < iv.max; },
  isSingleton(iv: Interval): boolean { return iv.min === iv.max; },
  includes(iv: Interval, t: number, strict = false): boolean {
    return strict ? t > iv.min && t < iv.max : t >= iv.min && t <= iv.max;
  },
  // Map t from [0,1] to [min,max].
  parameterAt(iv: Interval, s: number): number {
    return iv.min + s * (iv.max - iv.min);
  },
  // Map t from [min,max] to [0,1].
  normalizedParameterAt(iv: Interval, t: number): number {
    const len = iv.max - iv.min;
    return len === 0 ? 0 : (t - iv.min) / len;
  },
  intersection(a: Interval, b: Interval): Interval | null {
    const lo = Math.max(a.min, b.min), hi = Math.min(a.max, b.max);
    return lo <= hi ? { min: lo, max: hi } : null;
  },
  union(a: Interval, b: Interval): Interval {
    return { min: Math.min(a.min, b.min), max: Math.max(a.max, b.max) };
  },
};

// ── Xform (4×4 affine transform, row-major flat array of 16 numbers) ─────────

export interface Xform {
  m: number[]; // length 16: row 0 = m[0..3], row 1 = m[4..7], row 2 = m[8..11], row 3 = m[12..15]
}

export const Xform = {
  identity(): Xform {
    return { m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  },
  zero(): Xform {
    return { m: new Array(16).fill(0) };
  },
  fromRows(r0: number[], r1: number[], r2: number[], r3: number[]): Xform {
    return { m: [...r0, ...r1, ...r2, ...r3] };
  },
  translation(v: Vector3): Xform {
    return { m: [1, 0, 0, v.x, 0, 1, 0, v.y, 0, 0, 1, v.z, 0, 0, 0, 1] };
  },
  uniformScale(s: number): Xform {
    return { m: [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1] };
  },
  scale(sx: number, sy: number, sz: number): Xform {
    return { m: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, 0, 0, 0, 1] };
  },
  // Rotation by angle (radians) about an axis through the origin.
  rotationAboutAxis(axis: Vector3, angle: number): Xform {
    const { x, y, z } = Vector3.normalize(axis);
    const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
    return { m: [
      t*x*x+c,   t*x*y-s*z, t*x*z+s*y, 0,
      t*x*y+s*z, t*y*y+c,   t*y*z-s*x, 0,
      t*x*z-s*y, t*y*z+s*x, t*z*z+c,   0,
      0,         0,         0,          1,
    ]};
  },
  // Matrix multiplication: a × b.
  multiply(a: Xform, b: Xform): Xform {
    const [A, B] = [a.m, b.m];
    const r = new Array(16).fill(0);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += A[row * 4 + k] * B[k * 4 + col];
        r[row * 4 + col] = sum;
      }
    }
    return { m: r };
  },
  isIdentity(xf: Xform, tol = 1e-10): boolean {
    const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    return xf.m.every((v, i) => Math.abs(v - id[i]) <= tol);
  },
};

// ── Conic / quadric primitive types — Tier 1 type-only; algorithms in Tier 2+ ─

export interface Arc {
  center: Point3;
  radius: number;
  startAngle: number; // radians
  endAngle: number;   // radians
  plane: Plane;
}

export interface Circle {
  center: Point3;
  radius: number;
  plane: Plane;
}

export interface Ellipse {
  center: Point3;
  rx: number; // semi-major
  ry: number; // semi-minor
  plane: Plane;
}

export interface Sphere {
  center: Point3;
  radius: number;
}

export interface Cylinder {
  axis: Line;
  radius: number;
}

export interface Cone {
  apex: Point3;
  axis: Vector3;  // unit direction from apex toward base
  halfAngle: number; // radians
  height: number;
}

export interface Box {
  center: Point3;
  xAxis: Vector3;
  yAxis: Vector3;
  zAxis: Vector3;
  halfWidth: number;
  halfDepth: number;
  halfHeight: number;
}
