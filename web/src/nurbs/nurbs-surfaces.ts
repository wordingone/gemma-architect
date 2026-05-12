// nurbs-surfaces.ts — Surface tagged union + per-kind operations (#78 Tier 3).
//
// Catalog reference: opennurbs §4 (surfaces). Paraphrase of signatures and
// algorithmic notes; no copyrightable code reproduced.

import {
  type Point3, type Vector3, type Plane, type Interval, type Line, type Xform,
  Point3 as Pt3, Vector3 as V3, Interval as Iv, Plane as Pl,
} from "./nurbs-primitives";
import { type Curve, pointAt as curvePointAt, domain as curveDomain } from "./nurbs-curves";

// ── Surface type definitions ──────────────────────────────────────────────────

export interface NurbsSurface {
  kind: "nurbs";
  dim: number;
  isRational: boolean;
  order: [number, number];       // [orderU, orderV] = [degreeU+1, degreeV+1]
  cvCount: [number, number];     // [nU, nV]
  knots: [number[], number[]];   // [knotsU, knotsV] in OpenNURBS convention
  cvs: number[];                 // flat: index = (i * cvCount[1] + j) * cvStride
  cvStride: [number, number];    // [stridePerRow, stridePerCol] — typically [nV*dim, dim]
}

export interface PlaneSurface {
  kind: "plane";
  plane: Plane;
  uDomain: Interval;
  vDomain: Interval;
  uExtent: Interval;
  vExtent: Interval;
}

export interface RevSurface {
  kind: "rev";
  profile: Curve;
  axis: Line;
  angle: Interval;
  transposed: boolean;
}

export interface SumSurface {
  kind: "sum";
  curveU: Curve;
  curveV: Curve;
  basepoint: Point3;
}

export type Surface = NurbsSurface | PlaneSurface | RevSurface | SumSurface;

// ── Domain ────────────────────────────────────────────────────────────────────

export function domainU(s: Surface): Interval {
  switch (s.kind) {
    case "plane": return s.uDomain;
    case "rev": return s.transposed ? s.angle : curveDomain(s.profile);
    case "sum": return curveDomain(s.curveU);
    case "nurbs": {
      const k = s.knots[0];
      return Iv.create(k[0], k[k.length - 1]);
    }
  }
}

export function domainV(s: Surface): Interval {
  switch (s.kind) {
    case "plane": return s.vDomain;
    case "rev": return s.transposed ? curveDomain(s.profile) : s.angle;
    case "sum": return curveDomain(s.curveV);
    case "nurbs": {
      const k = s.knots[1];
      return Iv.create(k[0], k[k.length - 1]);
    }
  }
}

// ── Point evaluation ──────────────────────────────────────────────────────────

export function pointAtUV(s: Surface, u: number, v: number): Point3 {
  switch (s.kind) {
    case "plane": {
      const uf = (u - s.uDomain.min) / (s.uDomain.max - s.uDomain.min || 1);
      const vf = (v - s.vDomain.min) / (s.vDomain.max - s.vDomain.min || 1);
      const uCoord = s.uExtent.min + uf * (s.uExtent.max - s.uExtent.min);
      const vCoord = s.vExtent.min + vf * (s.vExtent.max - s.vExtent.min);
      return Pl.pointAt(s.plane, uCoord, vCoord);
    }
    case "rev": {
      const [pu, pv] = s.transposed ? [v, u] : [u, v];
      return _revolvePoint(s, pu, pv);
    }
    case "sum": {
      const ptU = curvePointAt(s.curveU, u);
      const ptV = curvePointAt(s.curveV, v);
      return {
        x: ptU.x + ptV.x - s.basepoint.x,
        y: ptU.y + ptV.y - s.basepoint.y,
        z: ptU.z + ptV.z - s.basepoint.z,
      };
    }
    case "nurbs":
      return _nurbsPointAtUV(s, u, v);
  }
}

// Rotate profile point at parameter t around the axis by angle theta.
function _revolvePoint(s: RevSurface, profileT: number, theta: number): Point3 {
  const pt = curvePointAt(s.profile, profileT);
  const axisDir = V3.normalize({
    x: s.axis.to.x - s.axis.from.x,
    y: s.axis.to.y - s.axis.from.y,
    z: s.axis.to.z - s.axis.from.z,
  });
  // Vector from axis origin to profile point
  const d = { x: pt.x - s.axis.from.x, y: pt.y - s.axis.from.y, z: pt.z - s.axis.from.z };
  // Axial component (stays fixed)
  const axialLen = V3.dot(d as Vector3, axisDir);
  const axial = V3.scale(axisDir, axialLen);
  // Radial component (gets rotated)
  const radial = { x: d.x - axial.x, y: d.y - axial.y, z: d.z - axial.z };
  // Rodrigues' rotation: r_rot = r*cos(θ) + (k×r)*sin(θ)  [k = axisDir is unit]
  const rCross = V3.cross(axisDir, radial as Vector3);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const rRot = {
    x: radial.x * cos + rCross.x * sin,
    y: radial.y * cos + rCross.y * sin,
    z: radial.z * cos + rCross.z * sin,
  };
  return {
    x: s.axis.from.x + axial.x + rRot.x,
    y: s.axis.from.y + axial.y + rRot.y,
    z: s.axis.from.z + axial.z + rRot.z,
  };
}

// 2D de Boor: apply de Boor row-by-row in u, then in v.
function _nurbsPointAtUV(ns: NurbsSurface, u: number, v: number): Point3 {
  const [nU, nV] = ns.cvCount;
  const [oU, oV] = ns.order;
  const dim = ns.dim;
  const cStride = dim + (ns.isRational ? 1 : 0);

  // Evaluate a 1D NURBS in-place using de Boor.
  function deBoor1D(
    knots: number[], n: number, order: number,
    getCv: (i: number) => number[], t: number,
  ): number[] {
    const full: number[] = new Array(order + n);
    full[0] = knots[0];
    for (let i = 0; i < knots.length; i++) full[i + 1] = knots[i];
    full[order + n - 1] = knots[knots.length - 1];
    const tMin = full[order - 1], tMax = full[n];
    t = Math.max(tMin, Math.min(tMax, t));
    let span = order - 1;
    for (let i = order - 1; i <= n - 1; i++) {
      if (t < full[i + 1]) { span = i; break; }
      span = i;
    }
    const p = order - 1;
    const d: number[][] = Array.from({ length: p + 1 }, (_, i) => getCv(span - p + i).slice());
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const denom = full[span - p + j + r] - full[span - p + j];
        const alpha = denom === 0 ? 0 : (t - full[span - p + j]) / denom;
        for (let c = 0; c < d[j].length; c++) d[j][c] = (1 - alpha) * d[j - 1][c] + alpha * d[j][c];
      }
    }
    const hw = d[p];
    if (ns.isRational && hw.length > dim) {
      const w = hw[dim];
      return w !== 0 ? hw.slice(0, dim).map((c) => c / w) : hw.slice(0, dim);
    }
    return hw.slice(0, dim);
  }

  // Step 1: for each v-row, evaluate in u to get a "column" of interpolated CVs.
  const vCVs: number[][] = [];
  for (let j = 0; j < nV; j++) {
    const pt = deBoor1D(ns.knots[0], nU, oU, (i) => {
      const base = (i * nV + j) * cStride;
      return ns.cvs.slice(base, base + cStride);
    }, u);
    vCVs.push(pt);
  }

  // Step 2: evaluate in v using the interpolated column as CVs.
  const result = deBoor1D(ns.knots[1], nV, oV, (j) => vCVs[j], v);
  return { x: result[0] ?? 0, y: result[1] ?? 0, z: result[2] ?? 0 };
}

// ── Normal evaluation (numerical central difference) ─────────────────────────

export function normalAtUV(s: Surface, u: number, v: number): Vector3 {
  const du = domainU(s);
  const dv = domainV(s);
  const eps = 1e-6;
  const eu = Math.min(eps, (du.max - du.min) * 0.001);
  const ev = Math.min(eps, (dv.max - dv.min) * 0.001);
  const u0 = Math.max(du.min, u - eu), u1 = Math.min(du.max, u + eu);
  const v0 = Math.max(dv.min, v - ev), v1 = Math.min(dv.max, v + ev);
  const du_vec = Pt3.sub(pointAtUV(s, u1, v), pointAtUV(s, u0, v)) as Vector3;
  const dv_vec = Pt3.sub(pointAtUV(s, u, v1), pointAtUV(s, u, v0)) as Vector3;
  return V3.normalize(V3.cross(du_vec, dv_vec));
}

// ── Frame evaluation ──────────────────────────────────────────────────────────

export function frameAtUV(s: Surface, u: number, v: number): {
  origin: Point3; xAxis: Vector3; yAxis: Vector3; normal: Vector3;
} {
  const du = domainU(s);
  const dv = domainV(s);
  const eps = 1e-6;
  const eu = Math.min(eps, (du.max - du.min) * 0.001);
  const ev = Math.min(eps, (dv.max - dv.min) * 0.001);
  const u0 = Math.max(du.min, u - eu), u1 = Math.min(du.max, u + eu);
  const v0 = Math.max(dv.min, v - ev), v1 = Math.min(dv.max, v + ev);
  const xAxis = V3.normalize(Pt3.sub(pointAtUV(s, u1, v), pointAtUV(s, u0, v)) as Vector3);
  const dv_vec = V3.normalize(Pt3.sub(pointAtUV(s, u, v1), pointAtUV(s, u, v0)) as Vector3);
  const normal = V3.normalize(V3.cross(xAxis, dv_vec));
  const yAxis = V3.cross(normal, xAxis);
  return { origin: pointAtUV(s, u, v), xAxis, yAxis, normal };
}

// ── getNurbsForm ──────────────────────────────────────────────────────────────

export function getNurbsForm(s: Surface): { form: 1 | 2; surface: NurbsSurface } {
  if (s.kind === "nurbs") return { form: 1, surface: s };

  // Tessellate into a linear NURBS surface (form 2 = approximation).
  const M = 16, N = 16;
  const du = domainU(s), dv = domainV(s);
  const cvs: number[] = [];
  for (let i = 0; i < N; i++) {
    const u = du.min + (i / (N - 1)) * (du.max - du.min);
    for (let j = 0; j < M; j++) {
      const v = dv.min + (j / (M - 1)) * (dv.max - dv.min);
      const pt = pointAtUV(s, u, v);
      cvs.push(pt.x, pt.y, pt.z);
    }
  }
  // Build clamped uniform linear knot vectors.
  const knotsU = _clampedLinearKnots(N);
  const knotsV = _clampedLinearKnots(M);
  const surf: NurbsSurface = {
    kind: "nurbs", dim: 3, isRational: false,
    order: [2, 2], cvCount: [N, M],
    knots: [knotsU, knotsV],
    cvs, cvStride: [M * 3, 3],
  };
  return { form: 2, surface: surf };
}

function _clampedLinearKnots(n: number): number[] {
  // OpenNURBS convention: order+n-2 knots, clamped at ends.
  // For degree 1 (order 2), n control points → n knots: [0,0, 1/(n-1), ..., 1, 1]
  const knots = [0];
  for (let i = 1; i < n - 1; i++) knots.push(i / (n - 1));
  knots.push(1);
  return knots;
}

// ── Transformations ───────────────────────────────────────────────────────────

export function transposeSurface(s: Surface): Surface {
  if (s.kind === "rev") return { ...s, transposed: !s.transposed };
  if (s.kind === "nurbs") {
    const [nU, nV] = s.cvCount;
    const [oU, oV] = s.order;
    const dim = s.dim + (s.isRational ? 1 : 0);
    const newCvs = new Array(s.cvs.length);
    for (let i = 0; i < nU; i++) {
      for (let j = 0; j < nV; j++) {
        for (let c = 0; c < dim; c++) {
          newCvs[(j * nU + i) * dim + c] = s.cvs[(i * nV + j) * dim + c];
        }
      }
    }
    return {
      ...s,
      order: [oV, oU], cvCount: [nV, nU],
      knots: [s.knots[1], s.knots[0]],
      cvs: newCvs, cvStride: [nU * dim, dim],
    };
  }
  // For plane + sum: approximate via getNurbsForm, then transpose.
  return transposeSurface(getNurbsForm(s).surface);
}

export function reverseSurface(s: Surface, dir: 0 | 1): Surface {
  if (s.kind === "rev") {
    if (dir === 1) return { ...s, angle: Iv.create(s.angle.max, s.angle.min) };
    // Reverse profile direction: not directly representable; approximate.
    return reverseSurface(getNurbsForm(s).surface, dir);
  }
  return reverseSurface(getNurbsForm(s).surface, dir);
}

export function transformSurface(s: Surface, x: Xform): Surface {
  return transformSurface(getNurbsForm(s).surface, x);
}

// ── Tessellation ──────────────────────────────────────────────────────────────

export interface SurfaceMesh {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  uvs: Float32Array;
}

export function tessellateSurface(s: Surface, uSamples = 32, vSamples = 32): SurfaceMesh {
  const nu = uSamples + 1, nv = vSamples + 1;
  const vertCount = nu * nv;
  const triCount = 2 * uSamples * vSamples;
  const positions = new Float32Array(vertCount * 3);
  const normals   = new Float32Array(vertCount * 3);
  const uvs       = new Float32Array(vertCount * 2);
  const indices   = new Uint32Array(triCount * 3);

  const du = domainU(s), dv = domainV(s);

  for (let i = 0; i < nu; i++) {
    const u = du.min + (i / uSamples) * (du.max - du.min);
    for (let j = 0; j < nv; j++) {
      const v = dv.min + (j / vSamples) * (dv.max - dv.min);
      const idx = i * nv + j;
      const pt = pointAtUV(s, u, v);
      const n  = normalAtUV(s, u, v);
      positions[idx * 3]     = pt.x;
      positions[idx * 3 + 1] = pt.y;
      positions[idx * 3 + 2] = pt.z;
      normals[idx * 3]     = n.x;
      normals[idx * 3 + 1] = n.y;
      normals[idx * 3 + 2] = n.z;
      uvs[idx * 2]     = i / uSamples;
      uvs[idx * 2 + 1] = j / vSamples;
    }
  }

  let t = 0;
  for (let i = 0; i < uSamples; i++) {
    for (let j = 0; j < vSamples; j++) {
      const a = i * nv + j, b = a + 1, c = a + nv, d = c + 1;
      indices[t++] = a; indices[t++] = b; indices[t++] = c;
      indices[t++] = b; indices[t++] = d; indices[t++] = c;
    }
  }

  return { positions, indices, normals, uvs };
}
