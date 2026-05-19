// Sketch buildX functions — extracted from create-mode.ts (#723).

import * as THREE from "three";
import { makeSnapId } from "../viewer/snap-state";
import type { SnapVertex } from "../viewer/snap-state";
import { createCatmullRomAsNurbs, tessellate } from "../nurbs/nurbs-curves.js";

const DEFAULT_RECT_HEIGHT = 2.8;
const DEFAULT_POLYGON_SIDES = 6;
const DEFAULT_EXTRUDE_HEIGHT = 2.5;
const DEFAULT_RAMP_WIDTH = 1.2;
const DEFAULT_RAILING_H = 1.0;

void DEFAULT_EXTRUDE_HEIGHT;

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

export function buildRect(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.max(0.01, Math.abs(b.x - a.x));
  const d = Math.max(0.01, Math.abs(b.y - a.y));
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const x0 = -w / 2, x1 = w / 2;
  const y0 = -d / 2, y1 = d / 2;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([
    x0, y0, 0,
    x1, y0, 0,
    x1, y1, 0,
    x0, y1, 0,
  ], 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xc9b18a });
  const mesh = new THREE.LineLoop(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "rectangle";
  mesh.userData.creator = "rect";
  const h = DEFAULT_RECT_HEIGHT;
  const chain = `const rect = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh: mesh as unknown as THREE.Mesh, chain };
}

export function buildCircle(center: { x: number; y: number }, radial: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = radial.x - center.x;
  const dy = radial.y - center.y;
  const r = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const segs = 64;
  const pts: number[] = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    pts.push(r * Math.cos(t), r * Math.sin(t), 0);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xb6d59a });
  const mesh = new THREE.LineLoop(geom, mat);
  mesh.position.set(center.x, center.y, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "circle";
  mesh.userData.creator = "circle";
  const h = DEFAULT_RECT_HEIGHT;
  const chain = `const cyl = makeCylinder(${round(r)}, ${round(h)}).translate([${round(center.x)}, ${round(center.y)}, 0]);`;
  return { mesh: mesh as unknown as THREE.Mesh, chain };
}

export function buildLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([
    a.x - cx, a.y - cy, 0,
    b.x - cx, b.y - cy, 0,
  ], 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x2d2d35 });
  const mesh = new THREE.LineSegments(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "line";
  mesh.userData.creator = "line";
  mesh.userData.controlPoints = [new THREE.Vector3(a.x - cx, a.y - cy, 0), new THREE.Vector3(b.x - cx, b.y - cy, 0)];
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
  ] as SnapVertex[];
  const chain = `const line = drawPolyline([[${round(a.x)}, ${round(a.y)}], [${round(b.x)}, ${round(b.y)}]]).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

export function buildPolygon(center: { x: number; y: number }, radial: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = radial.x - center.x;
  const dy = radial.y - center.y;
  const r = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const sides = DEFAULT_POLYGON_SIDES;
  const h = DEFAULT_EXTRUDE_HEIGHT;
  const startAng = Math.atan2(dy, dx);
  const shape = new THREE.Shape();
  const verts: Array<[number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const ang = startAng + (i * 2 * Math.PI) / sides;
    const x = r * Math.cos(ang);
    const y = r * Math.sin(ang);
    verts.push([x, y]);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(center.x, center.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "polygon";
  mesh.userData.controlPoints = verts.map(([x, y]) => new THREE.Vector3(x, y, 0));
  mesh.userData.isClosed = true;
  const worldVerts = verts.map(([x, y]) => `[${round(center.x + x)}, ${round(center.y + y)}]`).join(", ");
  const chain = `const poly = drawPolyline([${worldVerts}], { close: true }).sketchOnPlane("XY").extrude(${round(h)});`;
  return { mesh, chain };
}

export function buildPolyline(pts: Array<{ x: number; y: number }>): { mesh: THREE.Object3D; chain: string } {
  const first = pts[0], last = pts[pts.length - 1];
  const pdx = last.x - first.x, pdy = last.y - first.y;
  const isClosed = pts.length >= 3 && pdx * pdx + pdy * pdy < 0.25;
  const corePts = isClosed ? pts.slice(0, -1) : pts;
  const drawPts = isClosed ? [...corePts, corePts[0]] : corePts;
  const xs = corePts.map((p) => p.x);
  const ys = corePts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const geom = new THREE.BufferGeometry();
  const flat = drawPts.flatMap((p) => [p.x - cx, p.y - cy, 0]);
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x1565c0 });
  const mesh = new THREE.Line(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "polyline";
  mesh.userData.creator = "polyline";
  mesh.userData.controlPoints = corePts.map((p) => new THREE.Vector3(p.x - cx, p.y - cy, 0));
  mesh.userData.endpoints = corePts.map((p) => ({ x: p.x, y: p.y, z: 0, id: makeSnapId(p.x, p.y, 0) })) as SnapVertex[];
  const worldVerts = corePts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const poly = drawPolyline([${worldVerts}]${isClosed ? ", { close: true }" : ""}).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

export function buildCurve(pts: Array<{ x: number; y: number }>): { mesh: THREE.Object3D; chain: string } {
  const first = pts[0], last = pts[pts.length - 1];
  const cdx = last.x - first.x, cdy = last.y - first.y;
  const isClosed = pts.length >= 3 && cdx * cdx + cdy * cdy < 0.25;
  const curvePts = isClosed ? pts.slice(0, -1) : pts;
  const xs = curvePts.map((p) => p.x);
  const ys = curvePts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const localVecs = curvePts.map((p) => new THREE.Vector3(p.x - cx, p.y - cy, 0));
  const sampleCount = Math.max(localVecs.length * 16, 64);
  const dataPts = localVecs.map((v) => ({ x: v.x, y: v.y, z: v.z }));
  const crNurbs = createCatmullRomAsNurbs(dataPts, { closed: isClosed });
  const sampled3 = tessellate(crNurbs, sampleCount + 1).map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const geom = new THREE.BufferGeometry().setFromPoints(sampled3);
  const mat = new THREE.LineBasicMaterial({ color: 0x1565c0 });
  const mesh = new THREE.Line(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "curve";
  mesh.userData.creator = "curve";
  mesh.userData.isClosed = isClosed;
  mesh.userData.nurbsKind = "catmull-rom";
  mesh.userData.controlPoints = localVecs;
  mesh.userData.nurbsCVs = crNurbs.cvs;
  mesh.userData.endpoints = curvePts.map((p) => ({ x: p.x, y: p.y, z: 0, id: makeSnapId(p.x, p.y, 0) })) as SnapVertex[];
  const worldPts = curvePts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const curv = drawCurve([${worldPts}]${isClosed ? ", { close: true }" : ""}).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

export function buildRamp(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const run = Math.sqrt(dx * dx + dy * dy) || 1;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const w = DEFAULT_RAMP_WIDTH;
  const totalH = run / 12;
  const geom = new THREE.BoxGeometry(run, w, 0.15);
  geom.translate(run / 2, 0, totalH / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc4a882, roughness: 0.65, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(a.x, a.y, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "ramp";
  const chain = `const ramp = makeBox(${round(run)}, ${round(w)}, 0.15).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round(a.x)}, ${round(a.y)}, 0]);`;
  return { mesh, chain };
}

export function buildRailing(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const h = DEFAULT_RAILING_H;
  const geom = new THREE.BoxGeometry(len, 0.05, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x555566, roughness: 0.4, metalness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "railing";
  const chain = `const railing = makeBox(${round(len)}, 0.05, ${round(h)}).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round((a.x + b.x) / 2)}, ${round((a.y + b.y) / 2)}, 0]);`;
  return { mesh, chain };
}

function makePointMaterial(sizePx = 14): THREE.PointsMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(16, 16, 12, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 3;
  ctx.stroke();
  return new THREE.PointsMaterial({
    size: sizePx, sizeAttenuation: false,
    map: new THREE.CanvasTexture(canvas),
    transparent: true, alphaTest: 0.1, depthTest: false,
  });
}

export function buildPoint(p: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const r = 0.06;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const group = new THREE.Points(geom, makePointMaterial());
  group.position.set(p.x, p.y, 0);
  group.renderOrder = 1;
  group.userData.kind = "point";
  group.userData.creator = "point";
  const chain = `const pt = makeCylinder(${round(r)}, ${round(r * 2)}).translate([${round(p.x)}, ${round(p.y)}, 0]);`;
  return { mesh: group, chain };
}
