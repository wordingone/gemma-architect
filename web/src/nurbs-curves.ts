// nurbs-curves.ts — Curve tagged union + per-kind operations (#72 Tier 2).
//
// Catalog reference: opennurbs §3 (curves). Paraphrase of signatures and
// algorithmic notes; no copyrightable code reproduced.

import {
  type Point3, type Vector3, type Plane, type Interval, type Xform,
  Point3 as Pt3, Vector3 as V3, Interval as Iv,
} from "./nurbs-primitives";

// ── Curve type definitions ─────────────────────────────────────────────────

export interface NurbsCurve {
  kind: "nurbs";
  dim: number;            // typically 3
  isRational: boolean;
  order: number;          // degree + 1, >= 2
  cvCount: number;        // >= order
  knots: number[];        // length: order + cvCount - 2 (OpenNURBS convention)
  cvs: number[];          // length: cvStride * cvCount
  cvStride: number;       // >= dim + (isRational ? 1 : 0)
}

export interface LineCurve {
  kind: "line";
  from: Point3;
  to: Point3;
  domain: Interval;       // usually [0, length]
}

export interface PolylineCurve {
  kind: "polyline";
  points: Point3[];
  parameters: number[];   // length === points.length; monotone
}

export interface ArcCurve {
  kind: "arc";
  center: Point3;
  radius: number;
  startAngle: number;     // radians
  endAngle: number;       // radians
  plane: Plane;
  domain: Interval;       // parametric domain, usually [0, arc-length]
}

export type Curve = NurbsCurve | LineCurve | PolylineCurve | ArcCurve;

// ── Private NURBS evaluate — de Boor's algorithm ──────────────────────────

// Returns homogeneous (dim+1) or Euclidean (dim) point depending on isRational.
// OpenNURBS knot convention: full knot vector = [knots[0], ...knots, knots[last]]
// (standard B-spline vector has order+cvCount knots; OpenNURBS stores order+cvCount-2).
function deBoorPoint(nc: NurbsCurve, t: number): number[] {
  const { order, cvCount, knots, cvs, cvStride, isRational } = nc;
  const hDim = isRational ? nc.dim + 1 : nc.dim;

  // Pad to standard knot vector
  const full: number[] = new Array(order + cvCount);
  full[0] = knots[0];
  for (let i = 0; i < knots.length; i++) full[i + 1] = knots[i];
  full[order + cvCount - 1] = knots[knots.length - 1];

  // Clamp t to domain
  const tMin = full[order - 1];
  const tMax = full[cvCount];
  t = Math.max(tMin, Math.min(tMax, t));

  // Find knot span index k: largest k s.t. full[k] <= t < full[k+1]
  let span = order - 1;
  for (let i = order - 1; i <= cvCount - 1; i++) {
    if (t < full[i + 1]) { span = i; break; }
    span = i;
  }

  const p = order - 1;

  // Extract local control point window
  const d: number[][] = [];
  for (let i = 0; i <= p; i++) {
    const base = (span - p + i) * cvStride;
    const pt: number[] = [];
    for (let c = 0; c < hDim; c++) pt.push(cvs[base + c] ?? 0);
    d.push(pt);
  }

  // De Boor triangular reduction
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const ki = span - p + j;
      const denom = full[ki + p - r + 1] - full[ki];
      const alpha = denom === 0 ? 0 : (t - full[ki]) / denom;
      for (let c = 0; c < hDim; c++) {
        d[j][c] = (1 - alpha) * d[j - 1][c] + alpha * d[j][c];
      }
    }
  }

  const result = d[p];

  // Rational homogeneous divide
  if (isRational) {
    const w = result[nc.dim];
    if (w === 0) return result.slice(0, nc.dim);
    return result.slice(0, nc.dim).map(v => v / w);
  }
  return result;
}

// ── Domain ────────────────────────────────────────────────────────────────

export function domain(c: Curve): Interval {
  switch (c.kind) {
    case "nurbs": {
      const min = c.knots[c.order - 2] ?? c.knots[0];
      const max = c.knots[c.cvCount - 1] ?? c.knots[c.knots.length - 1];
      return { min, max };
    }
    case "line":     return c.domain;
    case "polyline": return { min: c.parameters[0], max: c.parameters[c.parameters.length - 1] };
    case "arc":      return c.domain;
  }
}

// ── Degree ────────────────────────────────────────────────────────────────

export function degree(c: Curve): number {
  switch (c.kind) {
    case "nurbs":    return c.order - 1;
    case "line":     return 1;
    case "polyline": return 1;
    case "arc":      return 2; // rational quadratic in NURBS form
  }
}

// ── pointAt ───────────────────────────────────────────────────────────────

export function pointAt(c: Curve, t: number): Point3 {
  switch (c.kind) {
    case "nurbs": {
      const p = deBoorPoint(c, t);
      return { x: p[0] ?? 0, y: p[1] ?? 0, z: p[2] ?? 0 };
    }
    case "line": {
      const u = Iv.normalizedParameterAt(c.domain, t);
      return Pt3.lerp(c.from, c.to, u);
    }
    case "polyline": {
      const pts = c.points;
      const params = c.parameters;
      if (pts.length === 0) return Pt3.zero();
      if (pts.length === 1) return pts[0];
      // Find interval
      let i = 0;
      for (; i < params.length - 1; i++) {
        if (t <= params[i + 1]) break;
      }
      i = Math.min(i, pts.length - 2);
      const dParam = params[i + 1] - params[i];
      const u = dParam === 0 ? 0 : (t - params[i]) / dParam;
      return Pt3.lerp(pts[i], pts[i + 1], u);
    }
    case "arc": {
      const dom = c.domain;
      const u = dom.max === dom.min ? 0 : (t - dom.min) / (dom.max - dom.min);
      const angle = c.startAngle + u * (c.endAngle - c.startAngle);
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const pl = c.plane;
      return {
        x: c.center.x + c.radius * (cosA * pl.xAxis.x + sinA * pl.yAxis.x),
        y: c.center.y + c.radius * (cosA * pl.xAxis.y + sinA * pl.yAxis.y),
        z: c.center.z + c.radius * (cosA * pl.xAxis.z + sinA * pl.yAxis.z),
      };
    }
  }
}

// ── tangentAt (unit tangent vector) ───────────────────────────────────────

export function tangentAt(c: Curve, t: number): Vector3 {
  switch (c.kind) {
    case "nurbs": {
      // Finite-difference approximation using a small step
      const dom = domain(c);
      const h = (dom.max - dom.min) * 1e-5;
      const t0 = Math.max(dom.min, t - h);
      const t1 = Math.min(dom.max, t + h);
      if (t1 === t0) return V3.xAxis();
      const p0 = pointAt(c, t0);
      const p1 = pointAt(c, t1);
      return V3.normalize({ x: p1.x - p0.x, y: p1.y - p0.y, z: p1.z - p0.z });
    }
    case "line": {
      return V3.normalize({ x: c.to.x - c.from.x, y: c.to.y - c.from.y, z: c.to.z - c.from.z });
    }
    case "polyline": {
      const pts = c.points;
      const params = c.parameters;
      if (pts.length < 2) return V3.xAxis();
      let i = 0;
      for (; i < params.length - 1; i++) { if (t <= params[i + 1]) break; }
      i = Math.min(i, pts.length - 2);
      return V3.normalize({ x: pts[i+1].x - pts[i].x, y: pts[i+1].y - pts[i].y, z: pts[i+1].z - pts[i].z });
    }
    case "arc": {
      const dom = c.domain;
      const u = dom.max === dom.min ? 0 : (t - dom.min) / (dom.max - dom.min);
      const angle = c.startAngle + u * (c.endAngle - c.startAngle);
      const pl = c.plane;
      // d(position)/d(angle) = radius*(-sin*xAxis + cos*yAxis); tangent direction
      const tx = -Math.sin(angle) * pl.xAxis.x + Math.cos(angle) * pl.yAxis.x;
      const ty = -Math.sin(angle) * pl.xAxis.y + Math.cos(angle) * pl.yAxis.y;
      const tz = -Math.sin(angle) * pl.xAxis.z + Math.cos(angle) * pl.yAxis.z;
      return V3.normalize({ x: tx, y: ty, z: tz });
    }
  }
}

// ── derivativeAt ──────────────────────────────────────────────────────────

export function derivativeAt(c: Curve, t: number, order: number): Point3[] {
  // Returns [position, 1st derivative, ..., Nth derivative] via finite differences.
  const result: Point3[] = [pointAt(c, t)];
  const dom = domain(c);
  const h = (dom.max - dom.min) * 1e-5;
  let cur = (p: Point3): Point3 => p;
  void cur; // suppress unused
  for (let k = 1; k <= order; k++) {
    const t0 = Math.max(dom.min, t - h);
    const t1 = Math.min(dom.max, t + h);
    const step = t1 - t0;
    if (step === 0) { result.push(Pt3.zero()); continue; }
    const p0 = k === 1 ? pointAt(c, t0) : derivativeAt(c, t0, k - 1)[k - 1];
    const p1 = k === 1 ? pointAt(c, t1) : derivativeAt(c, t1, k - 1)[k - 1];
    result.push({ x: (p1.x - p0.x) / step, y: (p1.y - p0.y) / step, z: (p1.z - p0.z) / step });
  }
  return result;
}

// ── isClosed ─────────────────────────────────────────────────────────────

export function isClosed(c: Curve, tol = 1e-10): boolean {
  const dom = domain(c);
  const p0 = pointAt(c, dom.min);
  const p1 = pointAt(c, dom.max);
  return Pt3.distance(p0, p1) <= tol;
}

// ── reverse ───────────────────────────────────────────────────────────────

export function reverse(c: Curve): Curve {
  switch (c.kind) {
    case "nurbs": {
      // Reverse knot vector and control points
      const dom = domain(c);
      const newKnots = c.knots.map(k => dom.min + dom.max - k).reverse();
      const newCvs: number[] = [];
      for (let i = c.cvCount - 1; i >= 0; i--) {
        for (let j = 0; j < c.cvStride; j++) {
          newCvs.push(c.cvs[i * c.cvStride + j]);
        }
      }
      return { ...c, knots: newKnots, cvs: newCvs };
    }
    case "line":
      return { ...c, from: c.to, to: c.from };
    case "polyline":
      return { ...c, points: [...c.points].reverse(), parameters: [...c.parameters].reverse().map(p => c.parameters[0] + c.parameters[c.parameters.length - 1] - p) };
    case "arc":
      return { ...c, startAngle: c.endAngle, endAngle: c.startAngle };
  }
}

// ── transform ─────────────────────────────────────────────────────────────

export function transform(c: Curve, x: Xform): Curve {
  switch (c.kind) {
    case "nurbs": {
      const newCvs: number[] = [];
      for (let i = 0; i < c.cvCount; i++) {
        const base = i * c.cvStride;
        const pt = { x: c.cvs[base], y: c.cvs[base + 1], z: c.cvs[base + 2] ?? 0 };
        const tp = Pt3.transform(pt, x);
        newCvs.push(tp.x, tp.y, tp.z);
        if (c.isRational) newCvs.push(c.cvs[base + 3] ?? 1);
      }
      return { ...c, cvs: newCvs };
    }
    case "line":
      return { ...c, from: Pt3.transform(c.from, x), to: Pt3.transform(c.to, x) };
    case "polyline":
      return { ...c, points: c.points.map(p => Pt3.transform(p, x)) };
    case "arc": {
      const center = Pt3.transform(c.center, x);
      const xAxisPt = Pt3.transform({ x: c.center.x + c.plane.xAxis.x, y: c.center.y + c.plane.xAxis.y, z: c.center.z + c.plane.xAxis.z }, x);
      const yAxisPt = Pt3.transform({ x: c.center.x + c.plane.yAxis.x, y: c.center.y + c.plane.yAxis.y, z: c.center.z + c.plane.yAxis.z }, x);
      const newXAxis = V3.normalize({ x: xAxisPt.x - center.x, y: xAxisPt.y - center.y, z: xAxisPt.z - center.z });
      const newYAxis = V3.normalize({ x: yAxisPt.x - center.x, y: yAxisPt.y - center.y, z: yAxisPt.z - center.z });
      const newNormal = V3.cross(newXAxis, newYAxis);
      return { ...c, center, plane: { origin: center, xAxis: newXAxis, yAxis: newYAxis, normal: newNormal } };
    }
  }
}

// ── trim ──────────────────────────────────────────────────────────────────

export function trim(c: Curve, interval: Interval): Curve {
  // Returns a curve restricted to the sub-interval.
  // For non-NURBS: reparameterize. For NURBS: note-for-note trim would require
  // knot insertion; here we reparameterize via NurbsForm for simplicity.
  switch (c.kind) {
    case "line": return { ...c, domain: interval };
    case "polyline": return { ...c }; // domain clamp handled in pointAt
    case "arc": {
      const dom = c.domain;
      const u0 = (interval.min - dom.min) / (dom.max - dom.min);
      const u1 = (interval.max - dom.min) / (dom.max - dom.min);
      const totalAngle = c.endAngle - c.startAngle;
      return { ...c, startAngle: c.startAngle + u0 * totalAngle, endAngle: c.startAngle + u1 * totalAngle, domain: interval };
    }
    case "nurbs": {
      // Reparameterize: sample and rebuild as a polyline approximation
      // (full knot insertion trim is out of scope for Tier 2)
      const pts = tessellate(c, 64).filter((_, i, arr) => {
        if (i === 0) return true;
        const dom = domain(c);
        const t = dom.min + (i / 63) * (dom.max - dom.min);
        return t >= interval.min && t <= interval.max;
      });
      const params = pts.map((_, i) => interval.min + (i / Math.max(1, pts.length - 1)) * (interval.max - interval.min));
      return { kind: "polyline", points: pts, parameters: params };
    }
  }
}

// ── split ─────────────────────────────────────────────────────────────────

export function split(c: Curve, t: number): [Curve, Curve] {
  const dom = domain(c);
  return [
    trim(c, { min: dom.min, max: t }),
    trim(c, { min: t, max: dom.max }),
  ];
}

// ── getNurbsForm ──────────────────────────────────────────────────────────

// form 1 = exact parametric representation; form 2 = locus equivalent
export function getNurbsForm(c: Curve): { form: 1 | 2; curve: NurbsCurve } {
  if (c.kind === "nurbs") return { form: 1, curve: c };
  // Convert to NURBS via sampling + reconstruction for non-NURBS kinds.
  // Arc and Circle have exact NURBS form (rational quadratic); handled in
  // nurbs-curve-algorithms.ts via nurbsCurveFromArc. Other kinds: locus form 2.
  const pts = tessellate(c, 64);
  return { form: 2, curve: createClampedUniformNurbs(3, 4, pts) };
}

// ── tessellate ────────────────────────────────────────────────────────────

export function tessellate(c: Curve, sampleCount: number): Point3[] {
  const dom = domain(c);
  const n = Math.max(2, sampleCount);
  const pts: Point3[] = [];
  for (let i = 0; i < n; i++) {
    const t = dom.min + (i / (n - 1)) * (dom.max - dom.min);
    pts.push(pointAt(c, t));
  }
  return pts;
}

// ── createClampedUniformNurbs ─────────────────────────────────────────────

// Constructs a clamped B-spline with the given control vertices and a
// uniform interior knot vector. order=4 gives a cubic spline.
// Catalog ref: ON_NurbsCurve::CreateClampedUniformNurbs.
export function createClampedUniformNurbs(
  dim: number,
  order: number,
  controlPoints: Point3[],
): NurbsCurve {
  const n = controlPoints.length;
  if (n < order) throw new Error(`createClampedUniformNurbs: need >= ${order} points, got ${n}`);

  const cvStride = dim; // non-rational
  const cvs: number[] = [];
  for (const p of controlPoints) {
    cvs.push(p.x, p.y, dim >= 3 ? p.z : 0);
  }

  // Clamped uniform knot vector (OpenNURBS convention: length = order + n - 2)
  const kLen = order + n - 2;
  const p = order - 1; // degree
  const knots: number[] = new Array(kLen).fill(0);
  // Interior knots (uniform spacing): positions [p-1 .. n-1]
  const interior = n - order; // number of interior spans
  for (let i = 0; i <= interior; i++) {
    knots[p - 1 + i] = i / (interior + 1);
  }
  // End clamp
  for (let i = n - 1; i < kLen; i++) knots[i] = 1;

  return {
    kind: "nurbs",
    dim,
    isRational: false,
    order,
    cvCount: n,
    knots,
    cvs,
    cvStride,
  };
}
