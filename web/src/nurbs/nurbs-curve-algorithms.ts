// nurbs-curve-algorithms.ts — Curve algorithm functions (#72 Tier 2).
//
// Catalog reference: opennurbs_nurbscurve.cpp (CreateFromArc),
// opennurbs_intersect.h (ON_IntersectCurveCurve), opennurbs_curve.h (GetClosestPoint).
// Paraphrase of algorithmic notes; no copyrightable code reproduced.

import { type Point3, type Arc, Plane as Pl } from "./nurbs-primitives";
import { type Curve, type NurbsCurve, pointAt, tangentAt, domain, tessellate } from "./nurbs-curves";

// ── nurbsCurveFromArc ─────────────────────────────────────────────────────────
//
// Converts an Arc into a rational quadratic NURBS via the standard 3-CV-per-
// quadrant construction. Each span ≤ 90° is an exact rational quadratic Bézier
// with inner-CV weight = cos(halfAngle). Catalog: ON_NurbsCurve::CreateFromArc.
//
// The resulting NurbsCurve domain is [startAngle, endAngle] (angle-based), so
// pointAt(nurbs, startAngle + fraction * (endAngle - startAngle)) evaluates the
// arc at that fraction.

export function nurbsCurveFromArc(arc: Arc): NurbsCurve {
  const { center, radius, startAngle, plane } = arc;
  let spanAngle = arc.endAngle - arc.startAngle;
  if (spanAngle <= 0) spanAngle += 2 * Math.PI;
  if (spanAngle > 2 * Math.PI) spanAngle = 2 * Math.PI;

  const endAngle = startAngle + spanAngle;
  const { xAxis, yAxis } = plane;

  // Number of spans ≤ π/2 each
  const numSpans = Math.ceil(spanAngle / (Math.PI / 2));
  const halfSpan = spanAngle / (2 * numSpans);
  const cosHalf = Math.cos(halfSpan);
  const w1 = cosHalf; // inner-CV weight per Bézier span

  // Point on the arc at angle θ (measured from the plane origin)
  function arcPt(theta: number): Point3 {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    return {
      x: center.x + radius * (cosT * xAxis.x + sinT * yAxis.x),
      y: center.y + radius * (cosT * xAxis.y + sinT * yAxis.y),
      z: center.z + radius * (cosT * xAxis.z + sinT * yAxis.z),
    };
  }

  // Build homogeneous CVs: (x*w, y*w, z*w, w)
  const cvs: number[] = [];
  for (let i = 0; i < numSpans; i++) {
    const t0 = startAngle + i * 2 * halfSpan;
    const tMid = t0 + halfSpan;
    const t2 = t0 + 2 * halfSpan;

    const P0 = arcPt(t0);
    const Pm = arcPt(tMid); // midpoint on arc
    const P2 = arcPt(t2);

    // P1 = tangent intersection = center + (Pm - center) / cos(halfSpan)
    const scale = 1 / cosHalf;
    const P1: Point3 = {
      x: center.x + (Pm.x - center.x) * scale,
      y: center.y + (Pm.y - center.y) * scale,
      z: center.z + (Pm.z - center.z) * scale,
    };

    if (i === 0) {
      cvs.push(P0.x, P0.y, P0.z, 1);
    }
    cvs.push(P1.x * w1, P1.y * w1, P1.z * w1, w1);
    cvs.push(P2.x, P2.y, P2.z, 1);
  }

  // Knot vector (OpenNURBS convention: length = order + cvCount - 2 = 2*numSpans+2)
  // Values: angle-based double knots at Bézier junctions.
  const knots: number[] = [];
  knots.push(startAngle, startAngle);
  for (let i = 1; i < numSpans; i++) {
    const t = startAngle + i * 2 * halfSpan;
    knots.push(t, t);
  }
  knots.push(endAngle, endAngle);

  const cvCount = 2 * numSpans + 1;
  return {
    kind: "nurbs",
    dim: 3,
    isRational: true,
    order: 3,
    cvCount,
    knots,
    cvs,
    cvStride: 4,
  };
}

// ── intersectCurveCurve ────────────────────────────────────────────────────────
//
// Returns intersection points between two curves. Algorithm: segment-level
// bounding-box filter + Newton refinement on the pair (t, s) such that
// ‖C_a(t) − C_b(s)‖ < tol. Catalog: ON_IntersectCurveCurve.

export interface CurveCurveIntersection {
  type: "point" | "overlap";
  pointA: Point3;
  pointB: Point3;
  paramA: number;
  paramB: number;
  overlapA?: { min: number; max: number };
  overlapB?: { min: number; max: number };
}

export function intersectCurveCurve(
  a: Curve,
  b: Curve,
  tol: number,
): CurveCurveIntersection[] {
  const N = 64; // tessellation samples per curve

  const domA = domain(a);
  const domB = domain(b);

  // Sample params + points for each curve
  function sampleCurve(c: Curve, dom: { min: number; max: number }, n: number) {
    const params: number[] = [];
    const pts = tessellate(c, n);
    for (let i = 0; i < n; i++) {
      params.push(dom.min + (i / (n - 1)) * (dom.max - dom.min));
    }
    return { params, pts };
  }

  const sA = sampleCurve(a, domA, N);
  const sB = sampleCurve(b, domB, N);

  // Bounding box of a segment [P0, P1] expanded by tol
  function segBB(p0: Point3, p1: Point3) {
    return {
      xMin: Math.min(p0.x, p1.x) - tol,
      xMax: Math.max(p0.x, p1.x) + tol,
      yMin: Math.min(p0.y, p1.y) - tol,
      yMax: Math.max(p0.y, p1.y) + tol,
      zMin: Math.min(p0.z, p1.z) - tol,
      zMax: Math.max(p0.z, p1.z) + tol,
    };
  }

  function bbOverlap(
    bA: ReturnType<typeof segBB>,
    bB: ReturnType<typeof segBB>,
  ): boolean {
    return (
      bA.xMin <= bB.xMax && bA.xMax >= bB.xMin &&
      bA.yMin <= bB.yMax && bA.yMax >= bB.yMin &&
      bA.zMin <= bB.zMax && bA.zMax >= bB.zMin
    );
  }

  // Newton refinement: find (t, s) such that C_a(t) = C_b(s)
  function refine(
    t0: number,
    s0: number,
  ): { t: number; s: number; dist: number; pa: Point3; pb: Point3 } {
    let t = t0;
    let s = s0;
    for (let iter = 0; iter < 24; iter++) {
      const Ca = pointAt(a, t);
      const Cb = pointAt(b, s);
      const dx = Ca.x - Cb.x;
      const dy = Ca.y - Cb.y;
      const dz = Ca.z - Cb.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < tol * 1e-3) {
        return { t, s, dist, pa: Ca, pb: Cb };
      }

      const ta = tangentAt(a, t);
      const tb = tangentAt(b, s);

      // f1 = ta · (Ca - Cb), f2 = -tb · (Ca - Cb)
      const f1 = ta.x * dx + ta.y * dy + ta.z * dz;
      const f2 = -(tb.x * dx + tb.y * dy + tb.z * dz);

      // Jacobian (near-intersection approximation: drop C'' term)
      const J11 = ta.x * ta.x + ta.y * ta.y + ta.z * ta.z;
      const J12 = -(ta.x * tb.x + ta.y * tb.y + ta.z * tb.z);
      const J22 = tb.x * tb.x + tb.y * tb.y + tb.z * tb.z;
      const det = J11 * J22 - J12 * J12;
      if (Math.abs(det) < 1e-30) break;

      const dt = -(J22 * f1 - J12 * f2) / det;
      const ds = -(J11 * f2 - J12 * f1) / det;

      t = Math.max(domA.min, Math.min(domA.max, t + dt));
      s = Math.max(domB.min, Math.min(domB.max, s + ds));
    }

    const Ca = pointAt(a, t);
    const Cb = pointAt(b, s);
    const dx = Ca.x - Cb.x;
    const dy = Ca.y - Cb.y;
    const dz = Ca.z - Cb.z;
    return { t, s, dist: Math.sqrt(dx * dx + dy * dy + dz * dz), pa: Ca, pb: Cb };
  }

  const candidates: { t: number; s: number; dist: number; pa: Point3; pb: Point3 }[] = [];

  for (let i = 0; i < N - 1; i++) {
    const bbA = segBB(sA.pts[i], sA.pts[i + 1]);
    for (let j = 0; j < N - 1; j++) {
      if (!bbOverlap(bbA, segBB(sB.pts[j], sB.pts[j + 1]))) continue;

      // Initial guess: midpoints of the overlapping segments
      const t0 = (sA.params[i] + sA.params[i + 1]) / 2;
      const s0 = (sB.params[j] + sB.params[j + 1]) / 2;
      const r = refine(t0, s0);
      if (r.dist <= tol) candidates.push(r);
    }
  }

  // Deduplicate by geometric distance: merge candidates whose intersection
  // points are within tol of each other (handles periodic curves where
  // t=0 and t=2π yield the same geometric point).
  const results: CurveCurveIntersection[] = [];
  const used = new Uint8Array(candidates.length);

  for (let i = 0; i < candidates.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    // Keep the representative candidate with the smallest dist in the group
    let best = candidates[i];
    for (let j = i + 1; j < candidates.length; j++) {
      if (used[j]) continue;
      const dx = best.pa.x - candidates[j].pa.x;
      const dy = best.pa.y - candidates[j].pa.y;
      const dz = best.pa.z - candidates[j].pa.z;
      const geomDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (geomDist <= tol * 10) {
        used[j] = 1;
        if (candidates[j].dist < best.dist) best = candidates[j];
      }
    }
    results.push({
      type: "point",
      pointA: best.pa,
      pointB: best.pb,
      paramA: best.t,
      paramB: best.s,
    });
  }

  return results;
}

// ── closestPointOnCurve ───────────────────────────────────────────────────────
//
// Finds the parameter t* that minimizes ‖P − C(t)‖. Algorithm: coarse scan over
// N samples followed by Newton refinement on g(t) = (P − C(t)) · C′(t) = 0.
// Catalog: ON_Curve::GetClosestPoint.

export function closestPointOnCurve(
  c: Curve,
  p: Point3,
): { point: Point3; param: number; distance: number } {
  const N = 128;
  const dom = domain(c);

  // Coarse scan
  let bestT = dom.min;
  let bestDist = Infinity;
  for (let i = 0; i < N; i++) {
    const t = dom.min + (i / (N - 1)) * (dom.max - dom.min);
    const pt = pointAt(c, t);
    const dx = pt.x - p.x;
    const dy = pt.y - p.y;
    const dz = pt.z - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < bestDist) { bestDist = d; bestT = t; }
  }

  // Newton refinement on g(t) = (P - C(t)) · C'(t) = 0
  // g'(t) ≈ -|C'(t)|²  (dominant term near minimum)
  const h = (dom.max - dom.min) * 1e-5;
  let t = bestT;
  for (let iter = 0; iter < 32; iter++) {
    const pt = pointAt(c, t);
    const tan = tangentAt(c, t);  // unit tangent
    const diff = { x: p.x - pt.x, y: p.y - pt.y, z: p.z - pt.z };
    const g = tan.x * diff.x + tan.y * diff.y + tan.z * diff.z;
    if (Math.abs(g) < 1e-14) break;

    // Estimate |C'(t)|: difference quotient
    const t1 = Math.min(dom.max, t + h);
    const t0 = Math.max(dom.min, t - h);
    const step = t1 - t0;
    if (step === 0) break;
    const p1 = pointAt(c, t1);
    const p0 = pointAt(c, t0);
    const vx = (p1.x - p0.x) / step;
    const vy = (p1.y - p0.y) / step;
    const vz = (p1.z - p0.z) / step;
    const speed2 = vx * vx + vy * vy + vz * vz;
    if (speed2 === 0) break;

    // g'(t) ≈ -speed²  (ignoring C'' contribution)
    const dt = g / speed2;
    const tNew = Math.max(dom.min, Math.min(dom.max, t + dt));
    if (Math.abs(tNew - t) < 1e-14) break;
    t = tNew;
  }

  const pt = pointAt(c, t);
  const dx = pt.x - p.x;
  const dy = pt.y - p.y;
  const dz = pt.z - p.z;
  return { point: pt, param: t, distance: Math.sqrt(dx * dx + dy * dy + dz * dz) };
}
