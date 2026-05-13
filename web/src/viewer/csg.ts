// BSP-tree constructive solid geometry — union, difference, intersection.
// Algorithm: Evan Wallace's csg.js (classic BSP approach, MIT License).
// Works for convex solids; approximate for complex concave meshes.

import * as THREE from "three";

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
