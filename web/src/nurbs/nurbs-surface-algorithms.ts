// nurbs-surface-algorithms.ts — Surface construction algorithms (#78 Tier 3).
//
// surfaceOfRevolution: catalog ON_RevSurface (opennurbs_revsurface.h)
// sweepSurface:        catalog ON_SweepSurface (single-rail, opennurbs_brep.h)
// loftSurfaces:        catalog ON_NurbsSurface::CreateLoft (opennurbs_nurbssurface.h)
//
// All implementations are clean-room paraphrases of algorithm descriptions.

import {
  type Point3, type Vector3, type Line, type Interval, type Xform,
  Point3 as Pt3, Vector3 as V3, Interval as Iv,
} from "./nurbs-primitives";
import { type Curve, pointAt as curvePointAt, tangentAt as curveTangentAt, domain as curveDomain, tessellate } from "./nurbs-curves";
import { type RevSurface, type NurbsSurface, type Surface } from "./nurbs-surfaces";

// ── surfaceOfRevolution ───────────────────────────────────────────────────────

export function surfaceOfRevolution(
  profile: Curve,
  axis: Line,
  angleStart: number,
  angleEnd: number,
): RevSurface {
  return {
    kind: "rev",
    profile,
    axis,
    angle: Iv.create(angleStart, angleEnd),
    transposed: false,
  };
}

// ── sweepSurface (single-rail) ────────────────────────────────────────────────

export function sweepSurface(
  profile: Curve,
  rail: Curve,
  options: { keepFrame?: boolean } = {},
): NurbsSurface {
  const keepFrame = options.keepFrame ?? false;

  // Sample rail and profile into point arrays.
  const RAIL_SAMPLES = 32;
  const PROF_SAMPLES = 32;
  const railDom = curveDomain(rail);
  const profDom = curveDomain(profile);

  // Collect rail frames using Bishop parallel-transport (minimum-twist) frame.
  interface Frame { origin: Point3; tangent: Vector3; normal: Vector3; binormal: Vector3; }
  const frames: Frame[] = [];

  // Initial frame at rail start.
  const eps = (railDom.max - railDom.min) * 0.001;
  let prevTangent = V3.normalize(curveTangentAt(rail, railDom.min) as Vector3);
  // Pick initial normal perpendicular to tangent.
  let prevNormal = _perpendicular(prevTangent);
  let prevBinormal = V3.normalize(V3.cross(prevTangent, prevNormal));

  for (let i = 0; i <= RAIL_SAMPLES; i++) {
    const t = railDom.min + (i / RAIL_SAMPLES) * (railDom.max - railDom.min);
    const origin = curvePointAt(rail, t);
    const rawTan = curveTangentAt(rail, Math.min(t + eps, railDom.max));
    const tangent = V3.normalize(rawTan as Vector3);

    let normal: Vector3, binormal: Vector3;
    if (keepFrame || i === 0) {
      normal = prevNormal;
      binormal = prevBinormal;
    } else {
      // Bishop transport: rotate prevNormal to remain perpendicular to new tangent.
      const rotAxis = V3.normalize(V3.cross(prevTangent, tangent));
      const cosA = Math.max(-1, Math.min(1, V3.dot(prevTangent, tangent)));
      if (Math.abs(cosA - 1) < 1e-10) {
        normal = prevNormal;
        binormal = prevBinormal;
      } else {
        const sinA = Math.sqrt(1 - cosA * cosA);
        // Rodrigues rotate prevNormal around rotAxis by the angle between old/new tangent.
        normal = V3.normalize(_rodrigues(prevNormal, rotAxis, cosA, sinA));
        binormal = V3.normalize(V3.cross(tangent, normal));
      }
    }

    frames.push({ origin, tangent, normal, binormal });
    prevTangent = tangent;
    prevNormal = normal;
    prevBinormal = binormal;
  }

  // Sample profile points relative to profile's start frame.
  const profStart = curvePointAt(profile, profDom.min);
  const profTan0  = V3.normalize(curveTangentAt(profile, profDom.min) as Vector3);
  const profNorm0 = _perpendicular(profTan0);
  const profBi0   = V3.normalize(V3.cross(profTan0, profNorm0));

  const profPts: Point3[] = [];
  for (let j = 0; j <= PROF_SAMPLES; j++) {
    const t = profDom.min + (j / PROF_SAMPLES) * (profDom.max - profDom.min);
    const pt = curvePointAt(profile, t);
    profPts.push(Pt3.sub(pt, profStart) as Point3);
  }

  // Build CV grid: for each rail frame, transform each profile point.
  const dim = 3;
  const nU = RAIL_SAMPLES + 1;
  const nV = PROF_SAMPLES + 1;
  const cvs: number[] = new Array(nU * nV * dim);

  for (let i = 0; i < nU; i++) {
    const fr = frames[i];
    for (let j = 0; j < nV; j++) {
      const lp = profPts[j]; // local profile offset
      // Express local offset in frame coordinates.
      const u_comp = V3.dot(lp as unknown as Vector3, profNorm0);
      const v_comp = V3.dot(lp as unknown as Vector3, profBi0);
      const w_comp = V3.dot(lp as unknown as Vector3, profTan0);
      const world: Point3 = {
        x: fr.origin.x + fr.normal.x * u_comp + fr.binormal.x * v_comp + fr.tangent.x * w_comp,
        y: fr.origin.y + fr.normal.y * u_comp + fr.binormal.y * v_comp + fr.tangent.y * w_comp,
        z: fr.origin.z + fr.normal.z * u_comp + fr.binormal.z * v_comp + fr.tangent.z * w_comp,
      };
      const base = (i * nV + j) * dim;
      cvs[base]     = world.x;
      cvs[base + 1] = world.y;
      cvs[base + 2] = world.z;
    }
  }

  // Clamped linear knot vectors.
  const knotsU = _clampedLinearKnots(nU);
  const knotsV = _clampedLinearKnots(nV);

  return {
    kind: "nurbs", dim: 3, isRational: false,
    order: [2, 2], cvCount: [nU, nV],
    knots: [knotsU, knotsV],
    cvs, cvStride: [nV * dim, dim],
  };
}

// ── loftSurfaces ──────────────────────────────────────────────────────────────

export function loftSurfaces(
  curves: Curve[],
  options: { closed?: boolean; degreeV?: number } = {},
): NurbsSurface {
  if (curves.length < 2) throw new Error("loftSurfaces requires at least 2 curves");
  const closed   = options.closed  ?? false;
  const degreeV  = options.degreeV ?? Math.min(3, curves.length - 1);
  const PROF_SAMPLES = 32;
  const dim = 3;

  // Sample each profile curve uniformly.
  const nU = PROF_SAMPLES + 1;
  const nV = curves.length;
  const cvs: number[] = new Array(nU * nV * dim);

  for (let j = 0; j < nV; j++) {
    const c = curves[j];
    const dom = curveDomain(c);
    for (let i = 0; i <= PROF_SAMPLES; i++) {
      const t = dom.min + (i / PROF_SAMPLES) * (dom.max - dom.min);
      const pt = curvePointAt(c, t);
      const base = (i * nV + j) * dim;
      cvs[base]     = pt.x;
      cvs[base + 1] = pt.y;
      cvs[base + 2] = pt.z;
    }
  }

  // Clamped uniform knot vectors.
  const knotsU = _clampedLinearKnots(nU);
  const knotsV = _clampedKnots(nV, degreeV + 1);

  return {
    kind: "nurbs", dim: 3, isRational: false,
    order: [2, degreeV + 1], cvCount: [nU, nV],
    knots: [knotsU, knotsV],
    cvs, cvStride: [nV * dim, dim],
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _perpendicular(v: Vector3): Vector3 {
  const arb = Math.abs(v.x) < 0.9 ? V3.xAxis() : V3.yAxis();
  return V3.normalize(V3.cross(arb, v));
}

function _rodrigues(v: Vector3, k: Vector3, cos: number, sin: number): Vector3 {
  // v_rot = v*cos + (k×v)*sin + k*(k·v)*(1-cos)
  const kv = V3.dot(k, v);
  const cross = V3.cross(k, v);
  return {
    x: v.x * cos + cross.x * sin + k.x * kv * (1 - cos),
    y: v.y * cos + cross.y * sin + k.y * kv * (1 - cos),
    z: v.z * cos + cross.z * sin + k.z * kv * (1 - cos),
  };
}

function _clampedLinearKnots(n: number): number[] {
  const knots = [0];
  for (let i = 1; i < n - 1; i++) knots.push(i / (n - 1));
  knots.push(1);
  return knots;
}

function _clampedKnots(n: number, order: number): number[] {
  // Clamped uniform B-spline knot vector for n CVs, given order.
  // OpenNURBS convention: n + order - 2 knots.
  const degree = order - 1;
  const innerCount = n - order;
  const knots: number[] = [];
  for (let i = 0; i < degree; i++) knots.push(0);
  for (let i = 0; i <= innerCount; i++) knots.push(i / (innerCount + 1));
  for (let i = 0; i < degree; i++) knots.push(1);
  return knots;
}
