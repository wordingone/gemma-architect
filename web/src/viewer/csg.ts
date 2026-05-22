// BSP-tree constructive solid geometry — union, difference, intersection.
// Algorithm: Evan Wallace's csg.js (classic BSP approach, MIT License).
// Works for convex solids; approximate for complex concave meshes.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const EPS = 1e-5;
const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

class Polygon {
  plane: THREE.Plane;
  constructor(public vertices: THREE.Vector3[]) {
    this.plane = new THREE.Plane().setFromCoplanarPoints(vertices[0], vertices[1], vertices[2]);
  }
  clone(): Polygon { return new Polygon(this.vertices.map(v => v.clone())); }
  flip(): void { this.vertices.reverse(); this.plane.negate(); }
}

class Node {
  plane: THREE.Plane | null = null;
  front: Node | null = null;
  back:  Node | null = null;
  polygons: Polygon[] = [];

  build(ps: Polygon[]): void {
    if (!ps.length) return;
    if (!this.plane) this.plane = ps[0].plane.clone();
    const f: Polygon[] = [], b: Polygon[] = [];
    for (const p of ps) this._split(p, this.polygons, this.polygons, f, b);
    if (f.length) { this.front ??= new Node(); this.front.build(f); }
    if (b.length) { this.back  ??= new Node(); this.back.build(b);  }
  }

  allPolygons(): Polygon[] {
    let ps = this.polygons.slice();
    if (this.front) ps = ps.concat(this.front.allPolygons());
    if (this.back)  ps = ps.concat(this.back.allPolygons());
    return ps;
  }

  invert(): void {
    for (const p of this.polygons) p.flip();
    if (this.plane) this.plane.negate();
    if (this.front) this.front.invert();
    if (this.back)  this.back.invert();
    [this.front, this.back] = [this.back, this.front];
  }

  clipPolygons(ps: Polygon[]): Polygon[] {
    if (!this.plane) return ps.slice();
    let f: Polygon[] = [], b: Polygon[] = [];
    for (const p of ps) this._split(p, f, b, f, b);
    if (this.front) f = this.front.clipPolygons(f);
    if (this.back)  b = this.back.clipPolygons(b); else b = [];
    return f.concat(b);
  }

  clipTo(bsp: Node): void {
    this.polygons = bsp.clipPolygons(this.polygons);
    if (this.front) this.front.clipTo(bsp);
    if (this.back)  this.back.clipTo(bsp);
  }

  private _split(
    poly: Polygon,
    cf: Polygon[], cb: Polygon[], f: Polygon[], b: Polygon[],
  ): void {
    const pl = this.plane!;
    let type = 0;
    const types = poly.vertices.map(v => {
      const d = pl.distanceToPoint(v);
      const t = d < -EPS ? BACK : d > EPS ? FRONT : COPLANAR;
      type |= t;
      return t;
    });
    switch (type) {
      case COPLANAR:
        (pl.normal.dot(poly.plane.normal) > 0 ? cf : cb).push(poly);
        break;
      case FRONT: f.push(poly); break;
      case BACK:  b.push(poly); break;
      case SPANNING: {
        const fv: THREE.Vector3[] = [], bv: THREE.Vector3[] = [];
        for (let i = 0; i < poly.vertices.length; i++) {
          const j  = (i + 1) % poly.vertices.length;
          const ti = types[i], tj = types[j];
          const vi = poly.vertices[i], vj = poly.vertices[j];
          if (ti !== BACK)  fv.push(vi);
          if (ti !== FRONT) bv.push(vi.clone());
          if ((ti | tj) === SPANNING) {
            const edge  = new THREE.Vector3().subVectors(vj, vi);
            const denom = pl.normal.dot(edge);
            if (Math.abs(denom) > 1e-12) {
              const t = -pl.distanceToPoint(vi) / denom;
              const v = vi.clone().lerp(vj, t);
              fv.push(v.clone()); bv.push(v.clone());
            }
          }
        }
        if (fv.length >= 3) f.push(new Polygon(fv));
        if (bv.length >= 3) b.push(new Polygon(bv));
        break;
      }
    }
  }
}

function meshToPolygons(mesh: THREE.Mesh): Polygon[] {
  const geo  = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  const flat = geo.index ? geo.toNonIndexed() : geo;
  const pos  = flat.getAttribute("position");
  const polys: Polygon[] = [];
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
    ab.subVectors(b, a); ac.subVectors(c, a);
    if (ab.clone().cross(ac).lengthSq() < 1e-20) continue;
    polys.push(new Polygon([a, b, c]));
  }
  geo.dispose(); if (flat !== geo) flat.dispose();
  return polys;
}

function polygonsToMesh(polys: Polygon[], mat: THREE.Material): THREE.Mesh {
  const positions: number[] = [];
  for (const p of polys) {
    for (let i = 1; i < p.vertices.length - 1; i++) {
      for (const v of [p.vertices[0], p.vertices[i], p.vertices[i + 1]]) {
        positions.push(v.x, v.y, v.z);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, mat);
}

export function csgUnion(a: THREE.Mesh, b: THREE.Mesh, mat: THREE.Material): THREE.Mesh {
  const na = new Node(); na.build(meshToPolygons(a));
  const nb = new Node(); nb.build(meshToPolygons(b));
  na.clipTo(nb); nb.clipTo(na); nb.invert(); nb.clipTo(na); nb.invert();
  na.build(nb.allPolygons());
  return polygonsToMesh(na.allPolygons(), mat);
}

export function csgDifference(a: THREE.Mesh, b: THREE.Mesh, mat: THREE.Material): THREE.Mesh {
  const na = new Node(); na.build(meshToPolygons(a));
  const nb = new Node(); nb.build(meshToPolygons(b));
  na.invert(); na.clipTo(nb); nb.clipTo(na); nb.invert(); nb.clipTo(na); nb.invert();
  na.build(nb.allPolygons()); na.invert();
  return polygonsToMesh(na.allPolygons(), mat);
}

export function csgIntersection(a: THREE.Mesh, b: THREE.Mesh, mat: THREE.Material): THREE.Mesh {
  const na = new Node(); na.build(meshToPolygons(a));
  const nb = new Node(); nb.build(meshToPolygons(b));
  na.invert(); nb.clipTo(na); nb.invert(); na.clipTo(nb); nb.clipTo(na);
  na.build(nb.allPolygons()); na.invert();
  return polygonsToMesh(na.allPolygons(), mat);
}

/**
 * Enumerate unique edges of a mesh in local (object) space, in stable traversal order.
 * Edges are deduplicated by endpoint proximity (EPS=1e-3). The returned index is stable
 * across calls for the same geometry, making it suitable as a persistent `edgeId`.
 */
export function getUniqueEdges(mesh: THREE.Mesh): [THREE.Vector3, THREE.Vector3][] {
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const EPS_SNAP = 1e-3;

  // Build edge → adjacent face normals map using quantised vertex keys.
  const vertKey = (v: THREE.Vector3) =>
    `${Math.round(v.x / EPS_SNAP)},${Math.round(v.y / EPS_SNAP)},${Math.round(v.z / EPS_SNAP)}`;
  const edgeKey = (a: THREE.Vector3, b: THREE.Vector3) => {
    const ka = vertKey(a); const kb = vertKey(b);
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };

  type EdgeEntry = { a: THREE.Vector3; b: THREE.Vector3; normals: THREE.Vector3[] };
  const edgeMap = new Map<string, EdgeEntry>();
  const vA = new THREE.Vector3(); const vB = new THREE.Vector3(); const vC = new THREE.Vector3();

  for (let i = 0; i < pos.count; i += 3) {
    vA.fromBufferAttribute(pos, i);
    vB.fromBufferAttribute(pos, i + 1);
    vC.fromBufferAttribute(pos, i + 2);
    const normal = new THREE.Vector3()
      .crossVectors(new THREE.Vector3().subVectors(vB, vA), new THREE.Vector3().subVectors(vC, vA))
      .normalize();
    for (const [a, b] of [[vA, vB], [vB, vC], [vC, vA]] as [THREE.Vector3, THREE.Vector3][]) {
      const key = edgeKey(a, b);
      if (!edgeMap.has(key)) edgeMap.set(key, { a: a.clone(), b: b.clone(), normals: [] });
      edgeMap.get(key)!.normals.push(normal.clone());
    }
  }
  geo.dispose();

  // Keep only hard edges: boundary (1 adjacent face) or where faces meet at an angle.
  // Coplanar seams (face-split diagonals) have dot ≥ 0.99 → skip.
  const COPLANAR = 0.99;
  const result: [THREE.Vector3, THREE.Vector3][] = [];
  for (const { a, b, normals } of edgeMap.values()) {
    if (normals.length === 1) { result.push([a, b]); }
    else if (normals.length === 2) { if (normals[0].dot(normals[1]) < COPLANAR) result.push([a, b]); }
    else { result.push([a, b]); } // non-manifold — include
  }
  return result;
}

/**
 * Chamfer a single edge of a mesh: `edgeAWorld` and `edgeBWorld` are the two
 * endpoints of the target edge in world space. The two triangles adjacent to
 * that edge are pulled back by `radius` and a bevel strip is inserted between
 * them. Falls back to `filletMesh` (all-edge round) if the geometry does not
 * have exactly 2 adjacent triangles for the given edge.
 *
 * The caller must replace the old mesh in the scene and history.
 */
export function chamferEdge(
  mesh: THREE.Mesh,
  edgeAWorld: THREE.Vector3,
  edgeBWorld: THREE.Vector3,
  radius: number,
): THREE.Mesh {
  const invMat = mesh.matrixWorld.clone().invert();
  const edgeA = edgeAWorld.clone().applyMatrix4(invMat);
  const edgeB = edgeBWorld.clone().applyMatrix4(invMat);

  const srcGeo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  const srcPos = srcGeo.getAttribute("position") as THREE.BufferAttribute;

  const EPS = 1e-3;
  const edgeDir = new THREE.Vector3().subVectors(edgeB, edgeA).normalize();

  type AdjTri = { base: number; other: THREE.Vector3 };
  const adjTris: AdjTri[] = [];

  for (let i = 0; i < srcPos.count; i += 3) {
    const pa = new THREE.Vector3().fromBufferAttribute(srcPos, i);
    const pb = new THREE.Vector3().fromBufferAttribute(srcPos, i + 1);
    const pc = new THREE.Vector3().fromBufferAttribute(srcPos, i + 2);
    const vs = [pa, pb, pc];
    let ai = -1, bi = -1;
    for (let k = 0; k < 3; k++) {
      if (vs[k].distanceTo(edgeA) < EPS) ai = k;
      if (vs[k].distanceTo(edgeB) < EPS) bi = k;
    }
    if (ai >= 0 && bi >= 0 && ai !== bi) {
      const oi = [0, 1, 2].find(k => k !== ai && k !== bi)!;
      adjTris.push({ base: i, other: vs[oi] });
    }
  }

  if (adjTris.length !== 2) {
    srcGeo.dispose();
    // Cannot chamfer: edge shared by ≠2 triangles (curved surface or non-manifold).
    // Return a copy of the original mesh with an error flag so callers can surface
    // a meaningful message instead of silently producing a wrong rounded-box shape.
    const errGeo = mesh.geometry.clone();
    const errMat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const errMesh = new THREE.Mesh(errGeo, errMat);
    errMesh.position.copy(mesh.position);
    errMesh.rotation.copy(mesh.rotation);
    errMesh.scale.copy(mesh.scale);
    errMesh.userData = { ...mesh.userData, _chamferError: `edge has ${adjTris.length} adjacent triangle(s); need exactly 2` };
    return errMesh;
  }

  // Inset direction for each adjacent face (perpendicular to edge, pointing into face).
  const insetDirs = adjTris.map(tri => {
    const toOther = new THREE.Vector3().subVectors(tri.other, edgeA);
    return toOther.sub(edgeDir.clone().multiplyScalar(toOther.dot(edgeDir))).normalize();
  });

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  // Half-lengths along the edge direction for each edge endpoint
  const eLen = edgeA.distanceTo(edgeB);
  const r = clamp(radius, 0.001, eLen / 2);

  const iA0 = edgeA.clone().addScaledVector(insetDirs[0], r);
  const iB0 = edgeB.clone().addScaledVector(insetDirs[0], r);
  const iA1 = edgeA.clone().addScaledVector(insetDirs[1], r);
  const iB1 = edgeB.clone().addScaledVector(insetDirs[1], r);

  const adjBases = new Set(adjTris.map(a => a.base));
  const newPts: number[] = [];

  for (let i = 0; i < srcPos.count; i += 3) {
    const pa = new THREE.Vector3().fromBufferAttribute(srcPos, i);
    const pb = new THREE.Vector3().fromBufferAttribute(srcPos, i + 1);
    const pc = new THREE.Vector3().fromBufferAttribute(srcPos, i + 2);

    if (!adjBases.has(i)) {
      newPts.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z, pc.x, pc.y, pc.z);
      continue;
    }

    const ai = adjTris.findIndex(a => a.base === i);
    const iA = ai === 0 ? iA0 : iA1;
    const iB = ai === 0 ? iB0 : iB1;

    const remap = (v: THREE.Vector3) => {
      if (v.distanceTo(edgeA) < EPS) return iA;
      if (v.distanceTo(edgeB) < EPS) return iB;
      return v;
    };
    const ra = remap(pa), rb = remap(pb), rc = remap(pc);
    newPts.push(ra.x, ra.y, ra.z, rb.x, rb.y, rb.z, rc.x, rc.y, rc.z);
  }

  // Bevel strip: quad (iA0, iB0, iB1, iA1). Determine outward winding via centroid test.
  mesh.geometry.computeBoundingBox();
  const meshCentroid = new THREE.Vector3();
  mesh.geometry.boundingBox!.getCenter(meshCentroid);

  const bevelNormal = new THREE.Vector3()
    .crossVectors(
      new THREE.Vector3().subVectors(iB0, iA0),
      new THREE.Vector3().subVectors(iB1, iA0),
    );
  const bevelCenter = new THREE.Vector3(
    (iA0.x + iB0.x + iA1.x + iB1.x) / 4,
    (iA0.y + iB0.y + iA1.y + iB1.y) / 4,
    (iA0.z + iB0.z + iA1.z + iB1.z) / 4,
  );
  const flip = bevelNormal.dot(new THREE.Vector3().subVectors(meshCentroid, bevelCenter)) > 0;

  if (!flip) {
    newPts.push(iA0.x, iA0.y, iA0.z, iB0.x, iB0.y, iB0.z, iB1.x, iB1.y, iB1.z);
    newPts.push(iA0.x, iA0.y, iA0.z, iB1.x, iB1.y, iB1.z, iA1.x, iA1.y, iA1.z);
  } else {
    newPts.push(iB1.x, iB1.y, iB1.z, iB0.x, iB0.y, iB0.z, iA0.x, iA0.y, iA0.z);
    newPts.push(iA1.x, iA1.y, iA1.z, iB1.x, iB1.y, iB1.z, iA0.x, iA0.y, iA0.z);
  }

  srcGeo.dispose();

  const newGeo = new THREE.BufferGeometry();
  newGeo.setAttribute("position", new THREE.Float32BufferAttribute(newPts, 3));
  newGeo.computeVertexNormals();

  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const result = new THREE.Mesh(newGeo, mat.clone());
  result.position.copy(mesh.position);
  result.rotation.copy(mesh.rotation);
  result.scale.copy(mesh.scale);
  result.userData = { ...mesh.userData };
  return result;
}

/**
 * Return a new Mesh whose geometry has all edges rounded by `radius`.
 * Computes the bounding box in local space and builds a RoundedBoxGeometry
 * centred at the same local origin with matching dimensions. For non-box
 * geometry the bbox approximation is a conservative stand-in that still
 * produces visually recognisable rounded corners.
 *
 * The caller must replace the old mesh in the scene and history.
 */
export function filletMesh(mesh: THREE.Mesh, radius: number): THREE.Mesh {
  const creator = mesh.userData.creator as string | undefined;
  const isBoxLike = !creator || creator === "rect" || creator === "extrude";
  if (!isBoxLike) {
    const err = mesh.clone();
    err.userData._chamferError = `all-edge fillet only supports box/rect profiles; '${creator}' shape requires selecting a specific edge (use edgeId)`;
    return err;
  }

  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  if (!bb) return mesh;

  const w = bb.max.x - bb.min.x;
  const h = bb.max.y - bb.min.y;
  const d = bb.max.z - bb.min.z;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  const cz = (bb.min.z + bb.max.z) / 2;

  const r = Math.min(radius, w / 2, h / 2, d / 2);
  const segs = Math.max(2, Math.ceil(r * 20));

  const geo = new RoundedBoxGeometry(w, h, d, segs, r);
  geo.translate(cx, cy, cz);

  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const result = new THREE.Mesh(geo, mat.clone());
  result.position.copy(mesh.position);
  result.rotation.copy(mesh.rotation);
  result.scale.copy(mesh.scale);
  result.userData = { ...mesh.userData };
  return result;
}
