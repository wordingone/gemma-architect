// NURBS kernel — WebGPU + verb-nurbs scaffold (T17).
//
// Goal of this scaffold (per gemma-architect zero-stubs plan T17):
//   - Provide a NURBS-native geometry kernel with WebGPU tessellation when
//     available, CPU fallback otherwise.
//   - Hand-rolled Cox-de Boor evaluator so the test path does NOT depend on
//     verb-nurbs (verb-nurbs assumes a browser global in its bundle and
//     blows up under bun test). Browser code paths can opt into the
//     verb-nurbs adaptive tessellator via tessellateWithVerb() once verb is
//     loaded — stubbed below; not required for the round-trip path.
//   - Stub IFC4 IfcAdvancedBrep import/export. Round-trip preserves control
//     points + weights + knots exactly because it is a JSON sidecar; the
//     real STEP-21 path is queued as a follow-up.
//
// NURBS itself is a public-domain mathematical concept (see
// nurbs-kernel.LICENSE.md). The evaluator below is a clean-room
// implementation of the standard Cox-de Boor recurrence and rational
// surface evaluation.
//
// Refs (math is procedure, not copyright — 17 U.S.C. § 102(b)):
//   - Piegl & Tiller, "The NURBS Book" (1997), § 2.1, § 4.4.
//   - ISO 10303-42 (STEP geometric & topological representation).
//   - IFC4: IfcBSplineSurfaceWithKnots / IfcRationalBSplineSurfaceWithKnots.

// ----------------------- Public types ----------------------------------------

export type Vec3 = readonly [number, number, number];

/** Open-form rational NURBS curve. */
export type NurbsCurve = {
  degree: number;
  /** Control points in 3D (w_i NOT pre-multiplied). */
  controlPoints: Vec3[];
  /** Per-control-point weight; same length as controlPoints. */
  weights: number[];
  /** Length = controlPoints.length + degree + 1. */
  knots: number[];
};

/** Open-form rational NURBS surface, control net is row-major: cp[i*nV + j]. */
export type NurbsSurface = {
  degreeU: number;
  degreeV: number;
  /** nU rows × nV cols flat array, row-major. */
  controlPoints: Vec3[];
  /** Same length / layout as controlPoints. */
  weights: number[];
  /** Counts of the control net so we can index without external metadata. */
  countU: number;
  countV: number;
  /** Length = countU + degreeU + 1. */
  knotsU: number[];
  /** Length = countV + degreeV + 1. */
  knotsV: number[];
};

/** Triangle mesh in interleaved-attribute form. */
export type Mesh = {
  /** Flat [x,y,z, ...] positions. */
  vertices: Float32Array;
  /** Flat [nx,ny,nz, ...] normals (same length as vertices). */
  normals: Float32Array;
  /** Flat [u,v, ...] texture coordinates (vertices.length / 3 * 2). */
  uvs: Float32Array;
  /** Flat triangle indices into the vertex array. */
  indices: Uint32Array;
};

// ----------------------- Constructors ----------------------------------------

/**
 * Build an open uniform knot vector of length count + degree + 1, clamped at
 * both ends. This is the standard "open" form used by IFC/STEP/IGES.
 */
export function uniformKnotVector(count: number, degree: number): number[] {
  if (count < degree + 1) {
    throw new Error(`uniformKnotVector: count ${count} < degree+1 ${degree + 1}`);
  }
  const m = count + degree + 1;
  const inner = m - 2 * (degree + 1);
  const out: number[] = [];
  for (let i = 0; i <= degree; i++) out.push(0);
  // inner knots are equally spaced in (0, 1).
  for (let i = 1; i <= inner; i++) out.push(i / (inner + 1));
  for (let i = 0; i <= degree; i++) out.push(1);
  return out;
}

export function nurbsCurveFromControlPoints(
  pts: Vec3[],
  weights?: number[],
  knots?: number[],
  degree: number = 3,
): NurbsCurve {
  if (pts.length < degree + 1) {
    throw new Error(`nurbsCurveFromControlPoints: need at least ${degree + 1} points for degree ${degree}, got ${pts.length}`);
  }
  const w = weights ?? new Array(pts.length).fill(1);
  if (w.length !== pts.length) {
    throw new Error(`weights length ${w.length} != points length ${pts.length}`);
  }
  const k = knots ?? uniformKnotVector(pts.length, degree);
  if (k.length !== pts.length + degree + 1) {
    throw new Error(`knot length ${k.length} != points + degree + 1 = ${pts.length + degree + 1}`);
  }
  return { degree, controlPoints: pts, weights: w, knots: k };
}

export function nurbsSurfaceFromGrid(
  grid: Vec3[][], // grid[i][j] — i in U, j in V
  weights?: number[][],
  knotsU?: number[],
  knotsV?: number[],
  degreeU: number = 3,
  degreeV: number = 3,
): NurbsSurface {
  const countU = grid.length;
  if (countU === 0) throw new Error("nurbsSurfaceFromGrid: empty grid");
  const countV = grid[0].length;
  for (const row of grid) {
    if (row.length !== countV) {
      throw new Error("nurbsSurfaceFromGrid: rows must have equal length");
    }
  }
  const flatPts: Vec3[] = [];
  const flatW: number[] = [];
  for (let i = 0; i < countU; i++) {
    for (let j = 0; j < countV; j++) {
      flatPts.push(grid[i][j]);
      flatW.push(weights?.[i]?.[j] ?? 1);
    }
  }
  const ku = knotsU ?? uniformKnotVector(countU, degreeU);
  const kv = knotsV ?? uniformKnotVector(countV, degreeV);
  if (ku.length !== countU + degreeU + 1) {
    throw new Error(`knotsU length mismatch: got ${ku.length}, expected ${countU + degreeU + 1}`);
  }
  if (kv.length !== countV + degreeV + 1) {
    throw new Error(`knotsV length mismatch: got ${kv.length}, expected ${countV + degreeV + 1}`);
  }
  return {
    degreeU,
    degreeV,
    controlPoints: flatPts,
    weights: flatW,
    countU,
    countV,
    knotsU: ku,
    knotsV: kv,
  };
}

// ----------------------- Cox-de Boor evaluator (clean-room) -------------------

/**
 * Find the knot span index for a given parameter u.
 * Returns i such that knots[i] <= u < knots[i+1] (or the last span at u=knots[end]).
 * This is the standard FindSpan from Piegl & Tiller §2.1.
 */
function findSpan(n: number, degree: number, u: number, knots: number[]): number {
  if (u >= knots[n + 1]) return n;
  if (u <= knots[degree]) return degree;
  // binary search
  let low = degree;
  let high = n + 1;
  let mid = (low + high) >>> 1;
  while (u < knots[mid] || u >= knots[mid + 1]) {
    if (u < knots[mid]) high = mid;
    else low = mid;
    mid = (low + high) >>> 1;
  }
  return mid;
}

/**
 * Compute the (degree+1) non-zero basis function values N_{i-degree+r,degree}(u)
 * for r in [0, degree]. Standard Cox-de Boor recurrence (Piegl & Tiller §2.2).
 */
function basisFunctions(span: number, degree: number, u: number, knots: number[]): number[] {
  const N = new Array(degree + 1).fill(0);
  const left = new Array(degree + 1).fill(0);
  const right = new Array(degree + 1).fill(0);
  N[0] = 1;
  for (let j = 1; j <= degree; j++) {
    left[j] = u - knots[span + 1 - j];
    right[j] = knots[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom !== 0 ? N[r] / denom : 0;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/** Evaluate a non-rational B-spline curve C(u) at u. */
function bsplineCurvePoint(
  controlPoints: Vec3[],
  degree: number,
  knots: number[],
  u: number,
): Vec3 {
  const n = controlPoints.length - 1;
  const span = findSpan(n, degree, u, knots);
  const N = basisFunctions(span, degree, u, knots);
  let x = 0, y = 0, z = 0;
  for (let i = 0; i <= degree; i++) {
    const cp = controlPoints[span - degree + i];
    x += N[i] * cp[0];
    y += N[i] * cp[1];
    z += N[i] * cp[2];
  }
  return [x, y, z];
}

/** Evaluate a rational NURBS curve C(u) at u. */
export function evalCurve(curve: NurbsCurve, u: number): Vec3 {
  const { controlPoints, weights, knots, degree } = curve;
  const n = controlPoints.length - 1;
  const span = findSpan(n, degree, u, knots);
  const N = basisFunctions(span, degree, u, knots);
  let x = 0, y = 0, z = 0, w = 0;
  for (let i = 0; i <= degree; i++) {
    const idx = span - degree + i;
    const wi = weights[idx];
    const cp = controlPoints[idx];
    const Nw = N[i] * wi;
    x += Nw * cp[0];
    y += Nw * cp[1];
    z += Nw * cp[2];
    w += Nw;
  }
  if (w === 0) return [x, y, z];
  return [x / w, y / w, z / w];
}

/** Evaluate a rational NURBS surface S(u, v). */
export function evalSurface(surface: NurbsSurface, u: number, v: number): Vec3 {
  const { degreeU, degreeV, controlPoints, weights, countU, countV, knotsU, knotsV } = surface;
  const nU = countU - 1;
  const nV = countV - 1;
  const spanU = findSpan(nU, degreeU, u, knotsU);
  const spanV = findSpan(nV, degreeV, v, knotsV);
  const NU = basisFunctions(spanU, degreeU, u, knotsU);
  const NV = basisFunctions(spanV, degreeV, v, knotsV);

  let x = 0, y = 0, z = 0, w = 0;
  for (let i = 0; i <= degreeU; i++) {
    const ui = spanU - degreeU + i;
    for (let j = 0; j <= degreeV; j++) {
      const vj = spanV - degreeV + j;
      const idx = ui * countV + vj;
      const wij = weights[idx];
      const cp = controlPoints[idx];
      const Nw = NU[i] * NV[j] * wij;
      x += Nw * cp[0];
      y += Nw * cp[1];
      z += Nw * cp[2];
      w += Nw;
    }
  }
  if (w === 0) return [x, y, z];
  return [x / w, y / w, z / w];
}

/**
 * Numerical surface normal via central differences.
 * Faster + simpler than building the full derivative tower for a scaffold;
 * accuracy is sufficient for tessellation lighting. A future revision can
 * port Piegl-Tiller §4.4 RationalSurfaceDerivatives for analytic normals.
 */
function evalSurfaceNormal(surface: NurbsSurface, u: number, v: number, h: number = 1e-4): Vec3 {
  const u0 = Math.max(surface.knotsU[0], u - h);
  const u1 = Math.min(surface.knotsU[surface.knotsU.length - 1], u + h);
  const v0 = Math.max(surface.knotsV[0], v - h);
  const v1 = Math.min(surface.knotsV[surface.knotsV.length - 1], v + h);
  const pu0 = evalSurface(surface, u0, v);
  const pu1 = evalSurface(surface, u1, v);
  const pv0 = evalSurface(surface, u, v0);
  const pv1 = evalSurface(surface, u, v1);
  const du: Vec3 = [pu1[0] - pu0[0], pu1[1] - pu0[1], pu1[2] - pu0[2]];
  const dv: Vec3 = [pv1[0] - pv0[0], pv1[1] - pv0[1], pv1[2] - pv0[2]];
  // cross(du, dv)
  const nx = du[1] * dv[2] - du[2] * dv[1];
  const ny = du[2] * dv[0] - du[0] * dv[2];
  const nz = du[0] * dv[1] - du[1] * dv[0];
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return [0, 0, 1];
  return [nx / len, ny / len, nz / len];
}

// ----------------------- CPU tessellation ------------------------------------

/**
 * Uniform-grid tessellation: sample the surface on a (resU+1) × (resV+1)
 * lattice in parameter space and emit two triangles per quad. This is the
 * scaffold-tier path; the WebGPU shader does the same thing in parallel,
 * and a future adaptive subdivision pass (chord-tolerance refinement) can
 * replace this once the kernel is stable.
 *
 * resU, resV are derived from chord tolerance via a coarse heuristic:
 * tighter tolerance → more samples. Concrete adaptive subdivision per
 * Piegl-Tiller §5.6 is queued as a follow-up.
 */
function tessellateSurfaceCPU(surface: NurbsSurface, tol: number): Mesh {
  // Heuristic: bounding box diagonal × 1/tol gives a step-count target,
  // clamped to keep the test fast.
  const bbox = computeBoundingBoxDiag(surface);
  const target = Math.ceil(bbox / Math.max(tol, 1e-6));
  const resU = Math.min(64, Math.max(8, target));
  const resV = Math.min(64, Math.max(8, target));

  const u0 = surface.knotsU[0];
  const u1 = surface.knotsU[surface.knotsU.length - 1];
  const v0 = surface.knotsV[0];
  const v1 = surface.knotsV[surface.knotsV.length - 1];

  const numVerts = (resU + 1) * (resV + 1);
  const vertices = new Float32Array(numVerts * 3);
  const normals = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);

  for (let i = 0; i <= resU; i++) {
    const u = u0 + (u1 - u0) * (i / resU);
    for (let j = 0; j <= resV; j++) {
      const v = v0 + (v1 - v0) * (j / resV);
      const p = evalSurface(surface, u, v);
      const n = evalSurfaceNormal(surface, u, v);
      const idx = i * (resV + 1) + j;
      vertices[idx * 3 + 0] = p[0];
      vertices[idx * 3 + 1] = p[1];
      vertices[idx * 3 + 2] = p[2];
      normals[idx * 3 + 0] = n[0];
      normals[idx * 3 + 1] = n[1];
      normals[idx * 3 + 2] = n[2];
      uvs[idx * 2 + 0] = i / resU;
      uvs[idx * 2 + 1] = j / resV;
    }
  }

  const indices = new Uint32Array(resU * resV * 6);
  let k = 0;
  for (let i = 0; i < resU; i++) {
    for (let j = 0; j < resV; j++) {
      const a = i * (resV + 1) + j;
      const b = a + 1;
      const c = a + (resV + 1);
      const d = c + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = c;
    }
  }
  return { vertices, normals, uvs, indices };
}

function computeBoundingBoxDiag(surface: NurbsSurface): number {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of surface.controlPoints) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ----------------------- WebGPU tessellation ---------------------------------

/**
 * WGSL compute shader: each (u, v) sample point computed by one workgroup
 * thread. Workgroup is 8×8 = 64 threads. Laid out as a separate string so
 * we can also load it from a sibling .wgsl file in a future revision.
 *
 * The shader walks the same Cox-de Boor recurrence as the CPU evaluator
 * above. Documenting the math here for grep-ability — the shader is the
 * same algorithm in WGSL syntax.
 *
 * Cox-de Boor recurrence (Piegl & Tiller §2.2 — public-domain math):
 *
 *   N_{i,0}(u) = 1 if knots[i] <= u < knots[i+1] else 0
 *   N_{i,p}(u) = ((u - knots[i]) / (knots[i+p] - knots[i])) * N_{i,p-1}(u)
 *              + ((knots[i+p+1] - u) / (knots[i+p+1] - knots[i+1])) * N_{i+1,p-1}(u)
 *
 * Rational surface point:
 *
 *   S(u,v) = sum_{i,j} N_{i,p}(u) N_{j,q}(v) w_{ij} P_{ij}
 *            ----------------------------------------------
 *            sum_{i,j} N_{i,p}(u) N_{j,q}(v) w_{ij}
 *
 * Chord-tolerance subdivision strategy (future work — not yet implemented
 * in this scaffold):
 *
 *   For each quad, compute the maximum perpendicular distance from the
 *   line connecting its diagonal corners to S(u,v) at the midpoint. If
 *   that distance > tol, split the quad in 4 and recurse. The current
 *   path tessellates uniformly at a tolerance-derived resolution and
 *   leaves adaptive subdivision queued.
 */
export const NURBS_TESSELLATE_WGSL = /* wgsl */ `
struct SurfaceParams {
  degreeU: u32,
  degreeV: u32,
  countU: u32,
  countV: u32,
  knotsULen: u32,
  knotsVLen: u32,
  resU: u32,
  resV: u32,
};

@group(0) @binding(0) var<uniform> params: SurfaceParams;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec4<f32>>;  // xyz + w_ij weight
@group(0) @binding(2) var<storage, read> knotsU: array<f32>;
@group(0) @binding(3) var<storage, read> knotsV: array<f32>;
@group(0) @binding(4) var<storage, read_write> outPositions: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read_write> outNormals: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> outUVs: array<vec2<f32>>;

const MAX_DEGREE: u32 = 8u;

fn findSpan(n: u32, degree: u32, u: f32, knotsLen: u32, useV: bool) -> u32 {
  // Linear scan — fine for degree < 8 since knot vectors are short. A
  // binary-search variant lives in the CPU evaluator; the GPU side keeps
  // the kernel branch-light.
  if (useV) {
    if (u >= knotsV[n + 1u]) { return n; }
    if (u <= knotsV[degree]) { return degree; }
    var i: u32 = degree;
    loop {
      if (i + 1u >= knotsLen) { break; }
      if (u >= knotsV[i] && u < knotsV[i + 1u]) { return i; }
      i = i + 1u;
    }
    return n;
  } else {
    if (u >= knotsU[n + 1u]) { return n; }
    if (u <= knotsU[degree]) { return degree; }
    var i: u32 = degree;
    loop {
      if (i + 1u >= knotsLen) { break; }
      if (u >= knotsU[i] && u < knotsU[i + 1u]) { return i; }
      i = i + 1u;
    }
    return n;
  }
}

fn basisFunctions(span: u32, degree: u32, u: f32, useV: bool, N: ptr<function, array<f32, 9>>) {
  // Cox-de Boor — see file header comment for math reference.
  var left: array<f32, 9>;
  var right: array<f32, 9>;
  (*N)[0] = 1.0;
  for (var j: u32 = 1u; j <= degree; j = j + 1u) {
    var kLeft: f32;
    var kRight: f32;
    if (useV) {
      kLeft = knotsV[span + 1u - j];
      kRight = knotsV[span + j];
    } else {
      kLeft = knotsU[span + 1u - j];
      kRight = knotsU[span + j];
    }
    left[j] = u - kLeft;
    right[j] = kRight - u;
    var saved: f32 = 0.0;
    for (var r: u32 = 0u; r < j; r = r + 1u) {
      let denom = right[r + 1u] + left[j - r];
      var temp: f32 = 0.0;
      if (denom != 0.0) { temp = (*N)[r] / denom; }
      (*N)[r] = saved + right[r + 1u] * temp;
      saved = left[j - r] * temp;
    }
    (*N)[j] = saved;
  }
}

@compute @workgroup_size(8, 8, 1)
fn tessellate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  let j = gid.y;
  if (i > params.resU || j > params.resV) { return; }

  let u0 = knotsU[0];
  let u1 = knotsU[params.knotsULen - 1u];
  let v0 = knotsV[0];
  let v1 = knotsV[params.knotsVLen - 1u];

  let u = u0 + (u1 - u0) * f32(i) / f32(params.resU);
  let v = v0 + (v1 - v0) * f32(j) / f32(params.resV);

  let nU = params.countU - 1u;
  let nV = params.countV - 1u;
  let spanU = findSpan(nU, params.degreeU, u, params.knotsULen, false);
  let spanV = findSpan(nV, params.degreeV, v, params.knotsVLen, true);

  var NU: array<f32, 9>;
  var NV: array<f32, 9>;
  basisFunctions(spanU, params.degreeU, u, false, &NU);
  basisFunctions(spanV, params.degreeV, v, true, &NV);

  var x: f32 = 0.0;
  var y: f32 = 0.0;
  var z: f32 = 0.0;
  var w: f32 = 0.0;
  for (var a: u32 = 0u; a <= params.degreeU; a = a + 1u) {
    let ui = spanU - params.degreeU + a;
    for (var b: u32 = 0u; b <= params.degreeV; b = b + 1u) {
      let vj = spanV - params.degreeV + b;
      let idx = ui * params.countV + vj;
      let cp = controlPoints[idx];          // cp.xyz = position, cp.w = weight
      let Nw = NU[a] * NV[b] * cp.w;
      x = x + Nw * cp.x;
      y = y + Nw * cp.y;
      z = z + Nw * cp.z;
      w = w + Nw;
    }
  }
  if (w != 0.0) {
    x = x / w;
    y = y / w;
    z = z / w;
  }

  let outIdx = i * (params.resV + 1u) + j;
  outPositions[outIdx] = vec4<f32>(x, y, z, 1.0);
  // Normals computed CPU-side or in a follow-up shader pass; emit zero for
  // now so the buffer is well-formed.
  outNormals[outIdx] = vec4<f32>(0.0, 0.0, 1.0, 0.0);
  outUVs[outIdx] = vec2<f32>(f32(i) / f32(params.resU), f32(j) / f32(params.resV));
}
`;

/**
 * Quick capability probe. Returns true if WebGPU is reachable AND a
 * GPUDevice can be requested. Browsers without WebGPU (older Safari,
 * headless Bun, Node) report false and the kernel falls back to CPU.
 */
export async function isWebGPUAvailable(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined") return false;
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
}

/**
 * Best-effort WebGPU tessellator. Compiles the WGSL shader, dispatches a
 * compute pass for the (resU+1)×(resV+1) sample grid, reads back vertex
 * positions, then triangulates and computes normals on the CPU.
 *
 * If anything in the WebGPU chain fails (no adapter, shader compile error,
 * buffer alloc OOM), throws — caller should fall back to CPU.
 */
async function tessellateSurfaceWebGPU(surface: NurbsSurface, tol: number): Promise<Mesh> {
  // Same heuristic as CPU path so the two outputs are comparable.
  const bbox = computeBoundingBoxDiag(surface);
  const target = Math.ceil(bbox / Math.max(tol, 1e-6));
  const resU = Math.min(64, Math.max(8, target));
  const resV = Math.min(64, Math.max(8, target));

  const gpu = (navigator as Navigator & { gpu?: any }).gpu;
  if (!gpu) throw new Error("navigator.gpu unavailable");
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("requestAdapter returned null");
  const device: any = await adapter.requestDevice();

  const numVerts = (resU + 1) * (resV + 1);

  // Flatten control points to vec4<x,y,z,w> for the storage buffer.
  const cpBuf = new Float32Array(surface.controlPoints.length * 4);
  for (let i = 0; i < surface.controlPoints.length; i++) {
    cpBuf[i * 4 + 0] = surface.controlPoints[i][0];
    cpBuf[i * 4 + 1] = surface.controlPoints[i][1];
    cpBuf[i * 4 + 2] = surface.controlPoints[i][2];
    cpBuf[i * 4 + 3] = surface.weights[i];
  }
  const knotsUBuf = new Float32Array(surface.knotsU);
  const knotsVBuf = new Float32Array(surface.knotsV);
  const paramsBuf = new Uint32Array([
    surface.degreeU,
    surface.degreeV,
    surface.countU,
    surface.countV,
    surface.knotsU.length,
    surface.knotsV.length,
    resU,
    resV,
  ]);

  const mkBuf = (data: ArrayBufferView, usage: number) => {
    const buf = device.createBuffer({
      size: Math.max(16, (data.byteLength + 3) & ~3),
      usage,
      mappedAtCreation: true,
    });
    new Uint8Array(buf.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buf.unmap();
    return buf;
  };

  // GPUBufferUsage flag values per the WebGPU spec — duplicated here to
  // keep the kernel self-contained when GPUBufferUsage is undefined under
  // bun. The numbers are stable in the spec.
  const STORAGE = 0x80;
  const UNIFORM = 0x40;
  const COPY_DST = 0x8;
  const COPY_SRC = 0x4;
  const MAP_READ = 0x1;

  const paramsGpu = mkBuf(paramsBuf, UNIFORM | COPY_DST);
  const cpGpu = mkBuf(cpBuf, STORAGE);
  const knotsUGpu = mkBuf(knotsUBuf, STORAGE);
  const knotsVGpu = mkBuf(knotsVBuf, STORAGE);

  const outPosGpu = device.createBuffer({ size: numVerts * 16, usage: STORAGE | COPY_SRC });
  const outNormGpu = device.createBuffer({ size: numVerts * 16, usage: STORAGE | COPY_SRC });
  const outUVGpu = device.createBuffer({ size: numVerts * 8, usage: STORAGE | COPY_SRC });

  const module = device.createShaderModule({ code: NURBS_TESSELLATE_WGSL });
  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module, entryPoint: "tessellate" },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsGpu } },
      { binding: 1, resource: { buffer: cpGpu } },
      { binding: 2, resource: { buffer: knotsUGpu } },
      { binding: 3, resource: { buffer: knotsVGpu } },
      { binding: 4, resource: { buffer: outPosGpu } },
      { binding: 5, resource: { buffer: outNormGpu } },
      { binding: 6, resource: { buffer: outUVGpu } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil((resU + 1) / 8), Math.ceil((resV + 1) / 8), 1);
  pass.end();

  // Read back positions; normals computed on the CPU below.
  const readBuf = device.createBuffer({ size: numVerts * 16, usage: COPY_DST | MAP_READ });
  encoder.copyBufferToBuffer(outPosGpu, 0, readBuf, 0, numVerts * 16);
  device.queue.submit([encoder.finish()]);

  await readBuf.mapAsync(MAP_READ);
  const posArray = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();

  const vertices = new Float32Array(numVerts * 3);
  for (let i = 0; i < numVerts; i++) {
    vertices[i * 3 + 0] = posArray[i * 4 + 0];
    vertices[i * 3 + 1] = posArray[i * 4 + 1];
    vertices[i * 3 + 2] = posArray[i * 4 + 2];
  }

  // Compute normals via face-area-weighted accumulation on the CPU. The
  // shader currently emits zero-normals; this pass yields visually
  // correct lighting and matches the CPU path's quality.
  const normals = new Float32Array(numVerts * 3);
  const indices = new Uint32Array(resU * resV * 6);
  let k = 0;
  for (let i = 0; i < resU; i++) {
    for (let j = 0; j < resV; j++) {
      const a = i * (resV + 1) + j;
      const b = a + 1;
      const c = a + (resV + 1);
      const d = c + 1;
      indices[k++] = a; indices[k++] = b; indices[k++] = d;
      indices[k++] = a; indices[k++] = d; indices[k++] = c;
    }
  }
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t], ib = indices[t + 1], ic = indices[t + 2];
    const ax = vertices[ia * 3], ay = vertices[ia * 3 + 1], az = vertices[ia * 3 + 2];
    const bx = vertices[ib * 3], by = vertices[ib * 3 + 1], bz = vertices[ib * 3 + 2];
    const cx = vertices[ic * 3], cy = vertices[ic * 3 + 1], cz = vertices[ic * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[ia * 3 + 0] += nx; normals[ia * 3 + 1] += ny; normals[ia * 3 + 2] += nz;
    normals[ib * 3 + 0] += nx; normals[ib * 3 + 1] += ny; normals[ib * 3 + 2] += nz;
    normals[ic * 3 + 0] += nx; normals[ic * 3 + 1] += ny; normals[ic * 3 + 2] += nz;
  }
  for (let i = 0; i < numVerts; i++) {
    const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2];
    const len = Math.sqrt(x * x + y * y + z * z);
    if (len > 0) {
      normals[i * 3 + 0] = x / len;
      normals[i * 3 + 1] = y / len;
      normals[i * 3 + 2] = z / len;
    } else {
      normals[i * 3 + 2] = 1;
    }
  }

  const uvs = new Float32Array(numVerts * 2);
  for (let i = 0; i <= resU; i++) {
    for (let j = 0; j <= resV; j++) {
      const idx = i * (resV + 1) + j;
      uvs[idx * 2 + 0] = i / resU;
      uvs[idx * 2 + 1] = j / resV;
    }
  }

  return { vertices, normals, uvs, indices };
}

// ----------------------- Kernel class ----------------------------------------

/**
 * Top-level NURBS kernel — picks WebGPU when available, falls back to CPU.
 *
 * The kernel is stateless across calls; instances exist for testability
 * (mocking) and so a future revision can pin a single GPUDevice across
 * tessellations to avoid the requestAdapter/requestDevice setup cost.
 */
export class NurbsKernel {
  private webgpuChecked = false;
  private webgpuOk = false;

  /** Override capability detection — used in tests to force CPU path. */
  forceCpu: boolean = false;

  async tessellateSurface(surface: NurbsSurface, tol: number = 0.01): Promise<Mesh> {
    if (this.forceCpu) {
      return tessellateSurfaceCPU(surface, tol);
    }
    if (!this.webgpuChecked) {
      this.webgpuOk = await isWebGPUAvailable();
      this.webgpuChecked = true;
    }
    if (this.webgpuOk) {
      try {
        return await tessellateSurfaceWebGPU(surface, tol);
      } catch (e) {
        // Compile errors / buffer alloc failures fall back to CPU. The
        // ifc-build / round-trip path needs the geometry regardless of
        // which backend produced it.
        // eslint-disable-next-line no-console
        console.warn("[NurbsKernel] WebGPU tessellation failed, falling back to CPU:", e);
        this.webgpuOk = false;
      }
    }
    return tessellateSurfaceCPU(surface, tol);
  }

  /** Synchronous CPU-only path. Useful for unit tests + Node scripts. */
  tessellateSurfaceSync(surface: NurbsSurface, tol: number = 0.01): Mesh {
    return tessellateSurfaceCPU(surface, tol);
  }
}

// ----------------------- IFC4 import/export (sidecar) ------------------------

/**
 * Sample NURBS surface used by tests + by the dual-kernel router as a
 * canned smoke fixture. A degree-2 cylindrical patch built by hand —
 * standard textbook construction (Piegl & Tiller §7.5).
 *
 * 9 control points (3×3), with the middle column weighted at sqrt(2)/2
 * to make the patch an exact circular quarter-arc when projected to XY.
 */
export function buildSampleNurbsSurface(): NurbsSurface {
  const r = 1;
  const h = 1;
  const w = Math.SQRT1_2;
  // 3×3 net: 3 columns sweep a quarter arc in XY, 3 rows extrude along Z.
  const grid: Vec3[][] = [
    [[r, 0, 0], [r, r, 0], [0, r, 0]],
    [[r, 0, h / 2], [r, r, h / 2], [0, r, h / 2]],
    [[r, 0, h], [r, r, h], [0, r, h]],
  ];
  const weights: number[][] = [
    [1, w, 1],
    [1, w, 1],
    [1, w, 1],
  ];
  // Quadratic in V (the arc), linear in U (the height).
  return nurbsSurfaceFromGrid(grid, weights, undefined, undefined, /*degU*/ 2, /*degV*/ 2);
}

/**
 * IFC4 IfcAdvancedBrep export — sidecar form.
 *
 * The gemma-architect production path will emit STEP-21 IfcAdvancedBrep
 * with IfcRationalBSplineSurfaceWithKnots entities; that requires extending
 * ifc-build.ts with the ~12 IfcBSpline* entity emitters and is queued as a
 * follow-up. For T17 round-trip parity we serialize a compact JSON
 * sidecar ("AVIR-NURBS/v0") containing every geometric input verbatim.
 *
 * A future revision should:
 *   1. Emit IFCBSPLINESURFACEWITHKNOTS / IFCRATIONALBSPLINESURFACEWITHKNOTS.
 *   2. Reference IfcCartesianPoint arrays for the control net.
 *   3. Encode knot multiplicities + types per IFC4 schema.
 *   4. Wrap the surface in an IfcAdvancedFace + IfcAdvancedBrep shell.
 *
 * See: ISO 10303-42, IFC4 schema appendix C.6 "B-spline surface".
 */
export function exportNurbsToIfc(surface: NurbsSurface): Uint8Array {
  const sidecar = {
    format: "AVIR-NURBS",
    version: 0,
    surface: {
      degreeU: surface.degreeU,
      degreeV: surface.degreeV,
      countU: surface.countU,
      countV: surface.countV,
      controlPoints: surface.controlPoints.map((p) => [p[0], p[1], p[2]]),
      weights: surface.weights,
      knotsU: surface.knotsU,
      knotsV: surface.knotsV,
    },
  };
  return new TextEncoder().encode(JSON.stringify(sidecar));
}

/** Reciprocal of exportNurbsToIfc — the round-trip target for tests. */
export async function importNurbsFromIfc(bytes: Uint8Array): Promise<NurbsSurface> {
  const text = new TextDecoder().decode(bytes);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`importNurbsFromIfc: not parseable as AVIR-NURBS sidecar: ${(e as Error).message}`);
  }
  if (parsed.format !== "AVIR-NURBS") {
    throw new Error(`importNurbsFromIfc: format mismatch (got '${parsed.format}', want 'AVIR-NURBS'). STEP-21 IfcAdvancedBrep parsing is the queued follow-up; for now use the sidecar form from exportNurbsToIfc.`);
  }
  const s = parsed.surface;
  const cps = s.controlPoints.map((p: number[]) => [p[0], p[1], p[2]] as Vec3);
  return {
    degreeU: s.degreeU,
    degreeV: s.degreeV,
    countU: s.countU,
    countV: s.countV,
    controlPoints: cps,
    weights: s.weights,
    knotsU: s.knotsU,
    knotsV: s.knotsV,
  };
}

// ----------------------- STEP / 3DM export -----------------------------------

/**
 * Convert a verb-style "open" knot vector (length n+p+1, full multiplicities at
 * the ends) into the (knots, multiplicities) pair that STEP / IFC schemas use.
 * STEP B_SPLINE_SURFACE_WITH_KNOTS lists each distinct knot once with its
 * multiplicity. ISO 10303-42 §6.4.39.
 */
function compressKnots(knots: number[]): { distinct: number[]; mults: number[] } {
  const distinct: number[] = [];
  const mults: number[] = [];
  let i = 0;
  while (i < knots.length) {
    const v = knots[i]!;
    let m = 1;
    while (i + m < knots.length && knots[i + m] === v) m++;
    distinct.push(v);
    mults.push(m);
    i += m;
  }
  return { distinct, mults };
}

/** Format a JS number as a STEP REAL literal (must contain a `.`). */
function stepReal(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`exportNurbsToStep: non-finite coord/knot/weight: ${n}`);
  }
  // STEP requires a decimal point. Use exponential when |x| is huge/tiny;
  // toString often drops the dot for integers ("1" → must be "1.").
  if (Number.isInteger(n)) return `${n}.`;
  let s = n.toString();
  if (!/[.eE]/.test(s)) s += ".";
  return s;
}

/**
 * STEP-21 (ISO 10303-21) NURBS surface export.
 *
 * Emits a self-contained STEP file containing one
 * (RATIONAL_)?B_SPLINE_SURFACE_WITH_KNOTS entity. ISO 10303-42 §6.4.39 wire
 * format. Header complies with ISO 10303-21 §5.1; uses AP242 schema id since
 * downstream consumers (Rhino, FreeCAD, OpenCascade) accept it for raw NURBS.
 *
 * Control-point grid layout: our row-major `cp[i*countV + j]` matches
 * STEP's `LIST OF LIST OF CARTESIAN_POINT` where the outer dimension is U.
 */
export function exportNurbsToStep(surface: NurbsSurface): Uint8Array {
  const { degreeU, degreeV, countU, countV, controlPoints, weights, knotsU, knotsV } = surface;

  if (controlPoints.length !== countU * countV) {
    throw new Error(`exportNurbsToStep: controlPoints length ${controlPoints.length} != countU*countV ${countU * countV}`);
  }
  if (weights.length !== controlPoints.length) {
    throw new Error(`exportNurbsToStep: weights length ${weights.length} != controlPoints length ${controlPoints.length}`);
  }
  if (knotsU.length !== countU + degreeU + 1) {
    throw new Error(`exportNurbsToStep: knotsU length ${knotsU.length} != countU+degreeU+1 ${countU + degreeU + 1}`);
  }
  if (knotsV.length !== countV + degreeV + 1) {
    throw new Error(`exportNurbsToStep: knotsV length ${knotsV.length} != countV+degreeV+1 ${countV + degreeV + 1}`);
  }

  const isRational = weights.some((w) => w !== 1);

  // ---- Build entities. Sequential numbering #1, #2, ... ----
  const lines: string[] = [];
  let next = 1;
  const id = () => next++;

  // CARTESIAN_POINTs — one per control point, row-major (i in U, j in V).
  // We collect row IDs so we can emit the LIST OF LIST in U-major order.
  const cpIds: number[][] = [];
  for (let i = 0; i < countU; i++) {
    const row: number[] = [];
    for (let j = 0; j < countV; j++) {
      const p = controlPoints[i * countV + j]!;
      const cid = id();
      lines.push(`#${cid}=CARTESIAN_POINT('',(${stepReal(p[0])},${stepReal(p[1])},${stepReal(p[2])}));`);
      row.push(cid);
    }
    cpIds.push(row);
  }

  const cpListLiteral = "(" + cpIds.map((row) => "(" + row.map((c) => `#${c}`).join(",") + ")").join(",") + ")";

  const u = compressKnots(knotsU);
  const v = compressKnots(knotsV);
  const uMultsLit = "(" + u.mults.join(",") + ")";
  const vMultsLit = "(" + v.mults.join(",") + ")";
  const uKnotsLit = "(" + u.distinct.map(stepReal).join(",") + ")";
  const vKnotsLit = "(" + v.distinct.map(stepReal).join(",") + ")";

  // u_closed=.U., v_closed=.U., self_intersect=.U., knot_spec=.UNSPECIFIED.
  // Per ISO 10303-42, B_SPLINE_SURFACE_WITH_KNOTS is the supertype; the
  // RATIONAL flavor adds a `weights_data` LIST OF LIST OF REAL.
  const surfaceId = id();
  if (!isRational) {
    lines.push(
      `#${surfaceId}=B_SPLINE_SURFACE_WITH_KNOTS('avir-nurbs-surface',` +
        `${degreeU},${degreeV},${cpListLiteral},.UNSPECIFIED.,.U.,.U.,.U.,` +
        `${uMultsLit},${vMultsLit},${uKnotsLit},${vKnotsLit},.UNSPECIFIED.);`,
    );
  } else {
    // RATIONAL_B_SPLINE_SURFACE: complex entity instance combining
    // BOUNDED_SURFACE, B_SPLINE_SURFACE, B_SPLINE_SURFACE_WITH_KNOTS,
    // GEOMETRIC_REPRESENTATION_ITEM, RATIONAL_B_SPLINE_SURFACE,
    // REPRESENTATION_ITEM, SURFACE. The standard short form per ISO 10303-21
    // §11.5.2 is the parenthesized "&" complex form below.
    const wRows: string[] = [];
    for (let i = 0; i < countU; i++) {
      const row: number[] = [];
      for (let j = 0; j < countV; j++) row.push(weights[i * countV + j]!);
      wRows.push("(" + row.map(stepReal).join(",") + ")");
    }
    const wListLit = "(" + wRows.join(",") + ")";

    lines.push(
      `#${surfaceId}=(` +
        `BOUNDED_SURFACE()` +
        `B_SPLINE_SURFACE(${degreeU},${degreeV},${cpListLiteral},.UNSPECIFIED.,.U.,.U.,.U.)` +
        `B_SPLINE_SURFACE_WITH_KNOTS(${uMultsLit},${vMultsLit},${uKnotsLit},${vKnotsLit},.UNSPECIFIED.)` +
        `GEOMETRIC_REPRESENTATION_ITEM()` +
        `RATIONAL_B_SPLINE_SURFACE(${wListLit})` +
        `REPRESENTATION_ITEM('avir-nurbs-surface')` +
        `SURFACE()` +
        `);`,
    );
  }

  const ts = new Date().toISOString();
  const header =
    `ISO-10303-21;\n` +
    `HEADER;\n` +
    `FILE_DESCRIPTION(('AVIR NURBS surface export'),'2;1');\n` +
    `FILE_NAME('avir-nurbs.step','${ts}',(''),(''),'gemma-architect','nurbs-kernel.ts','');\n` +
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n` +
    `ENDSEC;\n`;
  const data = `DATA;\n${lines.join("\n")}\nENDSEC;\n`;
  const footer = `END-ISO-10303-21;\n`;

  return new TextEncoder().encode(header + data + footer);
}

/**
 * Rhino .3dm export via rhino3dm.js (mcneel/rhino3dm@^8.17).
 *
 * The rhino3dm module is a WASM bundle that requires async init. We hot-load
 * it on first call to keep the module's startup cost out of the hot path for
 * users that never export 3DM. OpenNURBS's knot convention drops the boundary
 * knots that verb-nurbs/STEP/IFC carry (length n+p-1 vs n+p+1) — we slice the
 * leading/trailing knot off when copying.
 *
 * Returns the binary 3DM payload.
 */
export async function exportNurbsTo3dm(surface: NurbsSurface): Promise<Uint8Array> {
  // Lazy-load: rhino3dm is a WASM bundle and we don't want to pay its
  // load cost for callers that never reach this path.
  const rhino3dmInit = (await import("rhino3dm")).default;
  const RhinoModule = await rhino3dmInit();

  const { degreeU, degreeV, countU, countV, controlPoints, weights, knotsU, knotsV } = surface;

  const isRational = weights.some((w) => w !== 1);
  // OpenNURBS NurbsSurface.create takes ORDER (= degree + 1).
  const orderU = degreeU + 1;
  const orderV = degreeV + 1;

  const ns = RhinoModule.NurbsSurface.create(3, isRational, orderU, orderV, countU, countV);
  if (!ns) {
    throw new Error("exportNurbsTo3dm: RhinoModule.NurbsSurface.create returned null");
  }

  // ---- Control points ----
  // OpenNURBS rational points are 4D (x*w, y*w, z*w, w); non-rational are 3D.
  const pts = ns.points();
  for (let i = 0; i < countU; i++) {
    for (let j = 0; j < countV; j++) {
      const p = controlPoints[i * countV + j]!;
      const w = weights[i * countV + j]!;
      if (isRational) {
        pts.set(i, j, [p[0] * w, p[1] * w, p[2] * w, w]);
      } else {
        pts.set(i, j, [p[0], p[1], p[2]]);
      }
    }
  }

  // ---- Knots ----
  // OpenNURBS knot vector is length count + degree - 1 (no boundary
  // duplicates), while verb-nurbs / STEP / IFC use count + degree + 1. We
  // slice the first and last knot off.
  const ku = ns.knotsU();
  const kv = ns.knotsV();
  const truncU = knotsU.slice(1, knotsU.length - 1);
  const truncV = knotsV.slice(1, knotsV.length - 1);
  if (truncU.length !== ku.count) {
    throw new Error(`exportNurbsTo3dm: U-knot length mismatch ${truncU.length} vs OpenNURBS ${ku.count}`);
  }
  if (truncV.length !== kv.count) {
    throw new Error(`exportNurbsTo3dm: V-knot length mismatch ${truncV.length} vs OpenNURBS ${kv.count}`);
  }
  for (let i = 0; i < truncU.length; i++) ku.set(i, truncU[i]!);
  for (let i = 0; i < truncV.length; i++) kv.set(i, truncV[i]!);

  // ---- File3dm ----
  const file = new RhinoModule.File3dm();
  file.applicationName = "gemma-architect";
  file.applicationDetails = "AVIR NURBS export via rhino3dm";
  file.objects().addSurface(ns);

  return file.toByteArray();
}

// ----------------------- verb-nurbs interop ---------------------------------

/**
 * Browser-side high-quality adaptive tessellator via verb-nurbs. Loaded
 * lazily because the verb-nurbs bundle assumes a browser global and breaks
 * under bun. Only call this when you know you're in a Vite-served browser
 * context (e.g. inside the worker or main thread, NOT inside bun test).
 *
 * Returns null if verb-nurbs cannot be loaded — caller falls back to the
 * CPU path. The signature converts our Mesh shape to/from verb's MeshData.
 */
export async function tessellateWithVerb(surface: NurbsSurface): Promise<Mesh | null> {
  try {
    // @ts-ignore — runtime dynamic import; Vite resolves verb-nurbs on the browser side.
    const mod: any = await import("verb-nurbs/build/js/verb.es.js");
    const verb = mod.default ?? mod;
    const NurbsSurfaceCtor = verb?.geom?.NurbsSurface;
    if (!NurbsSurfaceCtor) return null;
    // verb wants control points as a 2D array of [x,y,z] and weights as a 2D array.
    const cp2d: number[][][] = [];
    const w2d: number[][] = [];
    for (let i = 0; i < surface.countU; i++) {
      const row: number[][] = [];
      const wrow: number[] = [];
      for (let j = 0; j < surface.countV; j++) {
        const idx = i * surface.countV + j;
        const p = surface.controlPoints[idx];
        row.push([p[0], p[1], p[2]]);
        wrow.push(surface.weights[idx]);
      }
      cp2d.push(row);
      w2d.push(wrow);
    }
    const verbSurf = NurbsSurfaceCtor.byKnotsControlPointsWeights(
      surface.degreeU,
      surface.degreeV,
      surface.knotsU,
      surface.knotsV,
      cp2d,
      w2d,
    );
    const tessData: { points: number[][]; faces: number[][]; normals: number[][]; uvs: number[][] } = verbSurf.tessellate();
    const numVerts = tessData.points.length;
    const vertices = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);
    const uvs = new Float32Array(numVerts * 2);
    for (let i = 0; i < numVerts; i++) {
      vertices[i * 3 + 0] = tessData.points[i][0];
      vertices[i * 3 + 1] = tessData.points[i][1];
      vertices[i * 3 + 2] = tessData.points[i][2];
      const n = tessData.normals?.[i] ?? [0, 0, 1];
      normals[i * 3 + 0] = n[0];
      normals[i * 3 + 1] = n[1];
      normals[i * 3 + 2] = n[2];
      const uv = tessData.uvs?.[i] ?? [0, 0];
      uvs[i * 2 + 0] = uv[0];
      uvs[i * 2 + 1] = uv[1];
    }
    const indices = new Uint32Array(tessData.faces.length * 3);
    for (let t = 0; t < tessData.faces.length; t++) {
      indices[t * 3 + 0] = tessData.faces[t][0];
      indices[t * 3 + 1] = tessData.faces[t][1];
      indices[t * 3 + 2] = tessData.faces[t][2];
    }
    return { vertices, normals, uvs, indices };
  } catch {
    return null;
  }
}
