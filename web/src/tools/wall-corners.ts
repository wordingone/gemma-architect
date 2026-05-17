// wall-corners.ts
// Parametric wall corner joining: endpoint-to-endpoint L-junctions and T-junctions
// are solved via 2-D line-line intersection so no CSG patching is needed for wall-wall joins.

import * as THREE from "three";
import type { SnapVertex } from "../viewer/snap-state";

const CORNER_EPS = 0.02; // 2 cm — endpoint proximity / T-junction threshold

export interface WallCorners {
  aL: THREE.Vector2; aR: THREE.Vector2;
  bL: THREE.Vector2; bR: THREE.Vector2;
}

// ── Prism geometry ─────────────────────────────────────────────────────────────

/**
 * Build a quadrilateral-prism BufferGeometry from 4 local-XY base corners + height.
 * Non-indexed geometry with flat per-face normals (no computeVertexNormals smoothing),
 * matching how BoxGeometry handles hard-edged architectural shapes.
 */
export function wallPrism(
  aL: THREE.Vector2, aR: THREE.Vector2,
  bL: THREE.Vector2, bR: THREE.Vector2,
  h: number,
): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];

  type V3 = [number, number, number];
  function quad(v0: V3, v1: V3, v2: V3, v3: V3): void {
    const ex = v1[0] - v0[0], ey = v1[1] - v0[1], ez = v1[2] - v0[2];
    const fx = v2[0] - v0[0], fy = v2[1] - v0[1], fz = v2[2] - v0[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; }
    pos.push(...v0, ...v1, ...v2, ...v0, ...v2, ...v3);
    for (let i = 0; i < 6; i++) nrm.push(nx, ny, nz);
  }

  const aLb: V3 = [aL.x, aL.y, 0], aRb: V3 = [aR.x, aR.y, 0];
  const bRb: V3 = [bR.x, bR.y, 0], bLb: V3 = [bL.x, bL.y, 0];
  const aLt: V3 = [aL.x, aL.y, h], aRt: V3 = [aR.x, aR.y, h];
  const bRt: V3 = [bR.x, bR.y, h], bLt: V3 = [bL.x, bL.y, h];

  quad(aLb, bLb, bRb, aRb);  // bottom
  quad(aLt, aRt, bRt, bLt);  // top
  quad(aLb, aLt, bLt, bLb);  // left  (+Y)
  quad(aRb, bRb, bRt, aRt);  // right (−Y)
  quad(aLb, aRb, aRt, aLt);  // A-end
  quad(bLb, bLt, bRt, bRb);  // B-end

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geom.setAttribute("normal",   new THREE.BufferAttribute(new Float32Array(nrm), 3));
  return geom;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 2-D line-line intersection. Lines: point P + direction D. Returns null if parallel. */
function lineIntersect2D(
  p1: THREE.Vector2, d1: THREE.Vector2,
  p2: THREE.Vector2, d2: THREE.Vector2,
): THREE.Vector2 | null {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / cross;
  return new THREE.Vector2(p1.x + t * d1.x, p1.y + t * d1.y);
}

/** World-XY endpoints from userData.endpoints. */
function wallEndpoints(mesh: THREE.Mesh): [THREE.Vector2, THREE.Vector2] | null {
  const eps = mesh.userData.endpoints as SnapVertex[] | undefined;
  if (!eps || eps.length < 2) return null;
  return [new THREE.Vector2(eps[0].x, eps[0].y), new THREE.Vector2(eps[1].x, eps[1].y)];
}

/** Rectangular default corners for a wall from centerline endpoint A to B. */
function defaultCorners(a: THREE.Vector2, b: THREE.Vector2, t: number): WallCorners {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return { aL: a.clone(), aR: a.clone(), bL: b.clone(), bR: b.clone() };
  const nx = -dy / len, ny = dx / len; // CCW perpendicular (left of A→B)
  return {
    aL: new THREE.Vector2(a.x + nx * t / 2, a.y + ny * t / 2),
    aR: new THREE.Vector2(a.x - nx * t / 2, a.y - ny * t / 2),
    bL: new THREE.Vector2(b.x + nx * t / 2, b.y + ny * t / 2),
    bR: new THREE.Vector2(b.x - nx * t / 2, b.y - ny * t / 2),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Initialize a wall's corner data to its rectangular defaults. Call in buildWall. */
export function initWallCorners(mesh: THREE.Mesh): void {
  const eps = wallEndpoints(mesh);
  if (!eps) return;
  const t = (mesh.userData.wallThickness as number | undefined) ?? 0.2;
  mesh.userData.corners = defaultCorners(eps[0], eps[1], t);
}

/** Rebuild a wall mesh's geometry from updated world-XY corners. */
export function rebuildWallFromCorners(mesh: THREE.Mesh, corners: WallCorners): void {
  const h = (mesh.userData.wallHeight as number | undefined) ?? 3;
  mesh.updateMatrixWorld(true);
  const inv = mesh.matrixWorld.clone().invert();

  function toLocal(v: THREE.Vector2): THREE.Vector2 {
    const v3 = new THREE.Vector3(v.x, v.y, 0).applyMatrix4(inv);
    return new THREE.Vector2(v3.x, v3.y);
  }

  mesh.geometry.dispose();
  mesh.geometry = wallPrism(
    toLocal(corners.aL), toLocal(corners.aR),
    toLocal(corners.bL), toLocal(corners.bR),
    h,
  );
  mesh.userData.corners = corners;
}

/** Reset a wall to rectangular corners. Call on drag-start so moved wall has clean geometry. */
export function resetWallCorners(mesh: THREE.Mesh): void {
  if (mesh.userData?.creator !== "wall") return;
  const eps = wallEndpoints(mesh);
  if (!eps) return;
  const t = (mesh.userData.wallThickness as number | undefined) ?? 0.2;
  rebuildWallFromCorners(mesh, defaultCorners(eps[0], eps[1], t));
}

/**
 * Recompute userData.endpoints from the mesh's current world transform.
 * Call after a drag-move so attemptWallCornerJoins works with up-to-date positions.
 */
export function recomputeWallEndpoints(mesh: THREE.Mesh): void {
  if (mesh.userData?.creator !== "wall") return;
  const cps = mesh.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length < 2) return;
  mesh.updateMatrixWorld(true);
  const wA = cps[0].clone().applyMatrix4(mesh.matrixWorld);
  const wB = cps[1].clone().applyMatrix4(mesh.matrixWorld);
  const wC = new THREE.Vector3().applyMatrix4(mesh.matrixWorld);
  const eps = mesh.userData.endpoints as SnapVertex[] | undefined;
  if (!eps || eps.length < 2) return;
  eps[0].x = wA.x; eps[0].y = wA.y; eps[0].z = wA.z;
  eps[1].x = wB.x; eps[1].y = wB.y; eps[1].z = wB.z;
  if (eps[2]) { eps[2].x = wC.x; eps[2].y = wC.y; eps[2].z = wC.z; }
}

/**
 * Detect and solve wall-wall corner junctions for a newly placed wall.
 * Modifies geometry of newMesh AND neighboring walls in-place.
 * Call after newMesh is added to the scene, before onElementCommitted.
 */
export function attemptWallCornerJoins(newMesh: THREE.Mesh, scene: THREE.Scene): void {
  if (newMesh.userData?.creator !== "wall") return;

  const newEps = wallEndpoints(newMesh);
  if (!newEps) return;
  const [pA, pB] = newEps;
  const t = (newMesh.userData.wallThickness as number | undefined) ?? 0.2;

  // Always reinitialize to rectangular defaults — clears stale corners from previous joins.
  initWallCorners(newMesh);
  rebuildWallFromCorners(newMesh, newMesh.userData.corners as WallCorners);

  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh) || obj === newMesh) return;
    if (obj.userData?.creator !== "wall" || obj.userData?.isJoinDisplay) return;

    const otherEps = wallEndpoints(obj);
    if (!otherEps) return;
    const [eA, eB] = otherEps;
    const tOther = (obj.userData.wallThickness as number | undefined) ?? 0.2;

    // Ensure existing wall has corners
    if (!obj.userData.corners) {
      obj.userData.corners = defaultCorners(eA, eB, tOther);
    }

    // Case 1: endpoint-to-endpoint (L-junction at any angle)
    const pairs: Array<[THREE.Vector2, 0|1, THREE.Vector2, 0|1]> = [
      [pA, 0, eA, 0], [pA, 0, eB, 1],
      [pB, 1, eA, 0], [pB, 1, eB, 1],
    ];
    for (const [pN, iN, pO, iO] of pairs) {
      if (pN.distanceTo(pO) < CORNER_EPS) {
        _solveL(newMesh, obj, iN, iO, pA, pB, eA, eB, t, tOther);
        return; // one junction per wall pair
      }
    }

    // Case 2: T-junctions
    _checkT(newMesh, pA, 0, obj, eA, eB, t, tOther);
    _checkT(newMesh, pB, 1, obj, eA, eB, t, tOther);
    _checkT(obj, eA, 0, newMesh, pA, pB, tOther, t);
    _checkT(obj, eB, 1, newMesh, pA, pB, tOther, t);
  });
}

// ── Junction solvers ──────────────────────────────────────────────────────────

/** Solve endpoint-to-endpoint L-junction: compute corner via line-line intersection. */
function _solveL(
  meshA: THREE.Mesh, meshB: THREE.Mesh,
  endIdxA: 0|1, endIdxB: 0|1,
  pA0: THREE.Vector2, pA1: THREE.Vector2,
  pB0: THREE.Vector2, pB1: THREE.Vector2,
  tA: number, tB: number,
): void {
  const pJunct = endIdxA === 0 ? pA0 : pA1;

  // Unit vectors pointing AWAY from junction along each wall's body
  const outA = (endIdxA === 0
    ? new THREE.Vector2().subVectors(pA1, pA0)
    : new THREE.Vector2().subVectors(pA0, pA1)
  ).normalize();
  const outB = (endIdxB === 0
    ? new THREE.Vector2().subVectors(pB1, pB0)
    : new THREE.Vector2().subVectors(pB0, pB1)
  ).normalize();

  // Cross product Z-component: positive = B turns left of A, negative = right
  const cross = outA.x * outB.y - outA.y * outB.x;
  if (Math.abs(cross) < 0.05) return; // collinear — no corner geometry

  // CCW perpendiculars (left-normal of each wall's outward direction)
  const normA = new THREE.Vector2(-outA.y, outA.x);
  const normB = new THREE.Vector2(-outB.y, outB.x);

  // Edge base points at junction for each wall's left/right edges
  const aLBase = new THREE.Vector2(pJunct.x + normA.x * tA / 2, pJunct.y + normA.y * tA / 2);
  const aRBase = new THREE.Vector2(pJunct.x - normA.x * tA / 2, pJunct.y - normA.y * tA / 2);
  const bLBase = new THREE.Vector2(pJunct.x + normB.x * tB / 2, pJunct.y + normB.y * tB / 2);
  const bRBase = new THREE.Vector2(pJunct.x - normB.x * tB / 2, pJunct.y - normB.y * tB / 2);

  // cross > 0: B is left of A → A's right meets B's left at outside corner
  // cross < 0: B is right of A → A's left meets B's right at outside corner
  let outsideCorner: THREE.Vector2 | null;
  let insideCorner: THREE.Vector2 | null;

  if (cross > 0) {
    outsideCorner = lineIntersect2D(aRBase, outA, bLBase, outB);
    insideCorner  = lineIntersect2D(aLBase, outA, bRBase, outB);
  } else {
    outsideCorner = lineIntersect2D(aLBase, outA, bRBase, outB);
    insideCorner  = lineIntersect2D(aRBase, outA, bLBase, outB);
  }
  if (!outsideCorner || !insideCorner) return;

  const cornersA = meshA.userData.corners as WallCorners;
  const cornersB = meshB.userData.corners as WallCorners;

  // When a junction is at the B-end (endIdx=1), the solver's outward direction is the
  // reverse of the mesh's natural A→B direction, which inverts the solver's L/R relative
  // to the mesh's corner convention.  Compensate by swapping solverL and solverR before
  // writing to the corner slots.
  function applyEnd(
    corners: WallCorners, endIdx: 0|1,
    solverL: THREE.Vector2, solverR: THREE.Vector2,
  ): void {
    const [l, r] = endIdx === 1 ? [solverR, solverL] : [solverL, solverR];
    if (endIdx === 0) { corners.aL = l.clone(); corners.aR = r.clone(); }
    else              { corners.bL = l.clone(); corners.bR = r.clone(); }
  }

  if (cross > 0) {
    // meshA: solver-right=outside, solver-left=inside
    applyEnd(cornersA, endIdxA, /*solverL=*/insideCorner, /*solverR=*/outsideCorner);
    // meshB: solver-left=outside, solver-right=inside
    applyEnd(cornersB, endIdxB, /*solverL=*/outsideCorner, /*solverR=*/insideCorner);
  } else {
    // meshA: solver-left=outside, solver-right=inside
    applyEnd(cornersA, endIdxA, /*solverL=*/outsideCorner, /*solverR=*/insideCorner);
    // meshB: solver-right=outside, solver-left=inside
    applyEnd(cornersB, endIdxB, /*solverL=*/insideCorner, /*solverR=*/outsideCorner);
  }

  rebuildWallFromCorners(meshA, cornersA);
  rebuildWallFromCorners(meshB, cornersB);
}

/** Solve T-junction: extendMesh's endpoint hits bodyMesh's mid-body segment. */
function _checkT(
  extendMesh: THREE.Mesh, extendPt: THREE.Vector2, extendIdx: 0|1,
  bodyMesh: THREE.Mesh, bodyA: THREE.Vector2, bodyB: THREE.Vector2,
  tExtend: number, tBody: number,
): void {
  const ab = new THREE.Vector2().subVectors(bodyB, bodyA);
  const len = ab.length();
  if (len < 0.01) return;
  const abUnit = ab.clone().divideScalar(len);
  const proj = new THREE.Vector2().subVectors(extendPt, bodyA).dot(abUnit);

  // Must project strictly inside the body segment (not near body endpoints)
  if (proj < tBody / 2 + CORNER_EPS || proj > len - tBody / 2 - CORNER_EPS) return;

  const foot = new THREE.Vector2(bodyA.x + abUnit.x * proj, bodyA.y + abUnit.y * proj);
  if (extendPt.distanceTo(foot) > tBody / 2 + CORNER_EPS) return;

  // Which face of bodyMesh is extendPt approaching?
  const bodyNorm = new THREE.Vector2(-abUnit.y, abUnit.x);
  const side = new THREE.Vector2().subVectors(extendPt, foot).dot(bodyNorm);
  const faceOffset = side >= 0 ? tBody / 2 : -tBody / 2;
  const faceBase = new THREE.Vector2(foot.x + bodyNorm.x * faceOffset, foot.y + bodyNorm.y * faceOffset);

  // extendMesh's direction and normal at the T-end
  const extEps = wallEndpoints(extendMesh);
  if (!extEps) return;
  const otherPt = extendIdx === 0 ? extEps[1] : extEps[0];
  const toExt = new THREE.Vector2().subVectors(extendPt, otherPt).normalize();
  const extNorm = new THREE.Vector2(-toExt.y, toExt.x);

  // Intersect extendMesh's left/right edge lines with bodyMesh's face line
  const extLBase = new THREE.Vector2(extendPt.x + extNorm.x * tExtend / 2, extendPt.y + extNorm.y * tExtend / 2);
  const extRBase = new THREE.Vector2(extendPt.x - extNorm.x * tExtend / 2, extendPt.y - extNorm.y * tExtend / 2);
  const newL = lineIntersect2D(extLBase, toExt, faceBase, abUnit);
  const newR = lineIntersect2D(extRBase, toExt, faceBase, abUnit);
  if (!newL || !newR) return;

  const corners = extendMesh.userData.corners as WallCorners;
  if (extendIdx === 0) { corners.aL = newL; corners.aR = newR; }
  else                 { corners.bL = newL; corners.bR = newR; }
  rebuildWallFromCorners(extendMesh, corners);
}
