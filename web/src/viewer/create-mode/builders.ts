// Builders — all ~30 buildX factory functions + TOOL_HANDLERS + TOOL_TODOS.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { csgUnion, csgDifference, csgIntersection } from "../csg";
import type { Viewer } from "../viewer";
import { dispatchSync } from "../../commands/dispatch";
import { levelStore } from "../../geometry/levels";
import { refLineStore } from "../../geometry/ref-lines";
import { makeSnapId } from "./snap";
import type { SnapVertex } from "./snap";
import {
  DEFAULT_WALL_HEIGHT, DEFAULT_WALL_THICKNESS, DEFAULT_SLAB_THICKNESS,
  DEFAULT_COLUMN_HEIGHT, DEFAULT_RECT_HEIGHT,
  DEFAULT_DOOR_W, DEFAULT_DOOR_H, DEFAULT_WINDOW_W, DEFAULT_WINDOW_H, DEFAULT_WINDOW_SILL,
  DEFAULT_STAIR_RISE, DEFAULT_STAIR_TREAD, DEFAULT_STAIR_WIDTH,
  DEFAULT_POLYGON_SIDES, DEFAULT_EXTRUDE_HEIGHT, DEFAULT_BEAM_SIZE,
  DEFAULT_FOUNDATION_T, DEFAULT_CEILING_T, DEFAULT_RAMP_WIDTH, DEFAULT_RAILING_H,
  _viewer,
} from "./state";
import { _pendingHostId } from "./snap";

export { csgUnion, csgDifference, csgIntersection };

// ─── Round helper ─────────────────────────────────────────────────────────────

export function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// ─── Tool handler type ────────────────────────────────────────────────────────

export type ToolHandler = {
  clicks: number;
  handler: (pts: Array<{ x: number; y: number; z?: number }>) => {
    mesh: THREE.Object3D;
    chain: string;
    dispatchOnCommit?: { verb: string; args: Record<string, unknown> };
    levelId?: string;
  };
};

// ─── Builders ─────────────────────────────────────────────────────────────────

export function buildWall(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(length, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(midX, midY, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "wall";
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
    { x: midX, y: midY, z: 0, id: makeSnapId(midX, midY, 0) },
  ] as SnapVertex[];
  const chain = `const wall = makeBox(${round(length)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(midX)}, ${round(midY)}, 0]);`;
  return { mesh, chain };
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
    { x: cx, y: cy, z: 0, id: makeSnapId(cx, cy, 0) },
  ] as SnapVertex[];
  const chain = `const line = drawPolyline([[${round(a.x)}, ${round(a.y)}], [${round(b.x)}, ${round(b.y)}]]).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

export function buildDoor(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_DOOR_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_DOOR_H;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5c5c, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "door";
  if (_pendingHostId) mesh.userData.hostExpressID = _pendingHostId;
  const chain = `// door: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]))`;
  return { mesh, chain };
}

export function buildWindow(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_WINDOW_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_WINDOW_H;
  const sill = DEFAULT_WINDOW_SILL;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, sill);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "window";
  if (_pendingHostId) mesh.userData.hostExpressID = _pendingHostId;
  const chain = `// window: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, ${round(sill)}]))`;
  return { mesh, chain };
}

export function buildSlab(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x);
  const d = Math.abs(b.y - a.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const t = DEFAULT_SLAB_THICKNESS;
  const geom = new THREE.BoxGeometry(w, d, t);
  geom.translate(0, 0, t / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa8a097, roughness: 0.7, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "slab";
  const chain = `const slab = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(t)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

export function buildColumn(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const s = 0.3;
  const h = DEFAULT_COLUMN_HEIGHT;
  const geom = new THREE.BoxGeometry(s, s, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd1c5b0, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "column";
  const chain = `const col = drawRectangle(${round(s)}, ${round(s)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]);`;
  return { mesh, chain };
}

export function buildStair(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const run = Math.sqrt(dx * dx + dy * dy);
  const tread = DEFAULT_STAIR_TREAD;
  const rise = DEFAULT_STAIR_RISE;
  const width = DEFAULT_STAIR_WIDTH;
  const steps = Math.max(2, Math.floor(run / tread));
  const actualTread = run / steps;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const stepGeoms: THREE.BoxGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const stepH = (i + 1) * rise;
    const g = new THREE.BoxGeometry(actualTread, width, stepH);
    g.translate(i * actualTread + actualTread / 2, 0, stepH / 2);
    stepGeoms.push(g);
  }
  const merged = mergeGeometries(stepGeoms, false);
  stepGeoms.forEach((g) => g.dispose());
  if (!merged) {
    const fallback = new THREE.BoxGeometry(run, width, steps * rise);
    fallback.translate(run / 2, 0, (steps * rise) / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb89968, roughness: 0.6, metalness: 0.05 });
    const mesh = new THREE.Mesh(fallback, mat);
    mesh.position.set(a.x, a.y, 0);
    mesh.rotation.z = (angDeg * Math.PI) / 180;
    mesh.userData.kind = "compound";
    mesh.userData.creator = "stair";
    const chain = `// stair: ${steps} steps, fallback bbox — compound([...risers,...treads])`;
    return { mesh, chain };
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xb89968, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.position.set(a.x, a.y, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "compound";
  mesh.userData.creator = "stair";
  const chain = `const stair = compound([/* ${steps} risers + ${steps} treads — TODO kernel mapping */]).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(a.x)}, ${round(a.y)}, 0]);`;
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
  const worldVerts = corePts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const poly = drawPolyline([${worldVerts}]${isClosed ? ", { close: true }" : ""}).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

export function buildExtrude(base: { x: number; y: number }, top: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = top.x - base.x;
  const dy = top.y - base.y;
  const h = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const s = 1.0;
  const geom = new THREE.BoxGeometry(s, s, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(base.x, base.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "extrude";
  const chain = `const ext = drawRectangle(${round(s)}, ${round(s)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(base.x)}, ${round(base.y)}, 0]);`;
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
  const crCurve = new THREE.CatmullRomCurve3(localVecs, isClosed, "catmullrom", 0.5);
  const sampled3 = crCurve.getPoints(sampleCount);
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
  const worldPts = curvePts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const curv = drawCurve([${worldPts}]${isClosed ? ", { close: true }" : ""}).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

export function makePointMaterial(sizePx = 14): THREE.PointsMaterial {
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

export function buildBox(
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  c3: { x: number; y: number },
): { mesh: THREE.Object3D; chain: string } {
  const w = Math.max(0.05, Math.abs(c2.x - c1.x));
  const d = Math.max(0.05, Math.abs(c2.y - c1.y));
  const cx = (c1.x + c2.x) / 2;
  const cy = (c1.y + c2.y) / 2;
  const distToCenter = Math.sqrt((c3.x - cx) ** 2 + (c3.y - cy) ** 2);
  const h = Math.max(0.05, distToCenter);
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "box";
  const chain = `const box = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

export function buildBeam(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const s = DEFAULT_BEAM_SIZE;
  const h = DEFAULT_COLUMN_HEIGHT;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const geom = new THREE.BoxGeometry(len, s, s);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa0856a, roughness: 0.6, metalness: 0.1 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, h);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "beam";
  const chain = `const beam = makeBox(${round(len)}, ${round(s)}, ${round(s)}).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round((a.x + b.x) / 2)}, ${round((a.y + b.y) / 2)}, ${round(h)}]);`;
  return { mesh, chain };
}

export function buildRoof(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const ridgeH = Math.max(0.5, Math.min(w, d) * 0.3);
  const geom = new THREE.BoxGeometry(w, d, ridgeH);
  geom.translate(0, 0, ridgeH / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a5c4a, roughness: 0.75, metalness: 0.02 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, DEFAULT_WALL_HEIGHT);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "roof";
  const chain = `const roof = makeBox(${round(w)}, ${round(d)}, ${round(ridgeH)}).translate([${round(cx)}, ${round(cy)}, ${round(DEFAULT_WALL_HEIGHT)}]);`;
  return { mesh, chain };
}

export function buildSpace(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const h = DEFAULT_RECT_HEIGHT;
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x90c8ff, transparent: true, opacity: 0.15, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "space";
  const chain = `const space = makeBox(${round(w)}, ${round(d)}, ${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

export function buildFoundation(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const t = DEFAULT_FOUNDATION_T;
  const geom = new THREE.BoxGeometry(w, d, t);
  geom.translate(0, 0, -t / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a7563, roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "foundation";
  const chain = `const foundation = makeBox(${round(w)}, ${round(d)}, ${round(t)}).translate([${round(cx)}, ${round(cy)}, ${round(-t / 2)}]);`;
  return { mesh, chain };
}

export function buildCeiling(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const t = DEFAULT_CEILING_T;
  const elev = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(w, d, t);
  const mat = new THREE.MeshStandardMaterial({ color: 0xfaf5ec, roughness: 0.5, metalness: 0.02 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, elev);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "ceiling";
  const chain = `const ceiling = makeBox(${round(w)}, ${round(d)}, ${round(t)}).translate([${round(cx)}, ${round(cy)}, ${round(elev)}]);`;
  return { mesh, chain };
}

export function buildCurtainWall(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const t = 0.02;
  const h = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(len, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xaadcff, transparent: true, opacity: 0.35 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "curtainwall";
  const chain = `const cw = makeBox(${round(len)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round((a.x + b.x) / 2)}, ${round((a.y + b.y) / 2)}, 0]);`;
  return { mesh, chain };
}

export function buildSkylight(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 0.5;
  const d = Math.abs(b.y - a.y) || 0.5;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const elev = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(w, d, 0.04);
  const mat = new THREE.MeshBasicMaterial({ color: 0xeef5ff, transparent: true, opacity: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, elev);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "skylight";
  const chain = `const skylight = makeBox(${round(w)}, ${round(d)}, 0.04).translate([${round(cx)}, ${round(cy)}, ${round(elev)}]);`;
  return { mesh, chain };
}

export function buildOpening(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = 1, h = 2, t = 0.25;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1, wireframe: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "opening";
  if (_pendingHostId) mesh.userData.hostExpressID = _pendingHostId;
  const chain = `// opening: ${round(w)}×${round(h)} void at [${round(p.x)}, ${round(p.y)}, 0]`;
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

export function buildGridLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const angRad = Math.atan2(dy, dx) - Math.PI / 2;
  const points = [new THREE.Vector3(0, -len / 2, 0), new THREE.Vector3(0, len / 2, 0)];
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineDashedMaterial({ color: 0x1a56cc, dashSize: 0.5, gapSize: 0.15 });
  const line = new THREE.Line(geom, mat);
  line.computeLineDistances();
  line.position.set(cx, cy, 0.001);
  line.rotation.z = angRad;
  const existingCount = _viewer
    ? _viewer.getScene().children.filter((o) => o.userData.creator === "IfcGridLine").length
    : 0;
  const label = String.fromCharCode(65 + existingCount % 26);
  line.userData.kind = "grid-line";
  line.userData.creator = "IfcGridLine";
  line.userData.label = label;
  line.userData.controlPoints = [[a.x, a.y, 0], [b.x, b.y, 0]];
  const chain = `IfcGridLine({origin:[${round(a.x)},${round(a.y)}],end:[${round(b.x)},${round(b.y)}]})`;
  return { mesh: line, chain };
}

export function buildLevel(p: { x: number; y: number; z?: number }): { mesh: THREE.Object3D; chain: string; levelId: string } {
  const elevation = p.z ?? 0;
  const name = `Level ${levelStore.all().length}`;
  const level = levelStore.findOrCreate(name, elevation, 3.0);
  const extent = 20;
  const geom = new THREE.BoxGeometry(extent, extent, 0.02);
  const mat = new THREE.MeshBasicMaterial({ color: 0x44aa88, transparent: true, opacity: 0.15, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, elevation);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcLevel";
  mesh.userData.levelId = level.id;
  const chain = `IfcLevel({elevation:${elevation},name:"${name}",height:3.0})`;
  return { mesh, chain, levelId: level.id };
}

export function buildReferenceLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const angRad = Math.atan2(dy, dx) - Math.PI / 2;
  const points = [new THREE.Vector3(0, -len / 2, 0), new THREE.Vector3(0, len / 2, 0)];
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0xcc1166 });
  const line = new THREE.Line(geom, mat);
  line.position.set(cx, cy, 0.002);
  line.rotation.z = angRad;
  const entry = refLineStore.add({ start: [a.x, a.y], end: [b.x, b.y] });
  line.userData.kind = "reference-line";
  line.userData.creator = "IfcReferenceLine";
  line.userData.refLineId = entry.id;
  line.userData.controlPoints = [[a.x, a.y, 0], [b.x, b.y, 0]];
  const chain = `IfcReferenceLine({origin:[${round(a.x)},${round(a.y)}],end:[${round(b.x)},${round(b.y)}]})`;
  return { mesh: line, chain };
}

export function buildSectionBox(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const minZ = -0.1, maxZ = 6.0;
  const w = maxX - minX || 0.1, d = maxY - minY || 0.1, h = maxZ - minZ;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const geom = new THREE.BoxGeometry(w, d, h);
  const edges = new THREE.EdgesGeometry(geom);
  geom.dispose();
  const mat = new THREE.LineBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.7 });
  const mesh = new THREE.LineSegments(edges, mat);
  mesh.position.set(cx, cy, cz);
  mesh.userData.kind = "section-box";
  mesh.userData.creator = "SdSectionBox";
  mesh.userData.excludeFromClip = true;
  const min: [number, number, number] = [round(minX), round(minY), round(minZ)];
  const max: [number, number, number] = [round(maxX), round(maxY), round(maxZ)];
  return {
    mesh,
    chain: `SdSectionBox({min:[${min}],max:[${max}]})`,
    dispatchOnCommit: { verb: "SdSectionBox", args: { min, max } },
  };
}

export function buildClipPlane(
  a: { x: number; y: number; z?: number },
  b: { x: number; y: number; z?: number },
): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const av = _viewer?.activeView ?? "top";
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const label = `clip-${Date.now()}`;
  let mesh: THREE.Mesh;
  let origin: [number, number, number];
  let normal: [number, number, number];

  if (av === "front" || av === "back") {
    const az = a.z ?? 0, bz = b.z ?? 0;
    const dx = b.x - a.x, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const cx = (a.x + b.x) / 2, cz = (az + bz) / 2;
    origin = [round(cx), 0, round(cz)];
    normal = [round(nx), 0, round(nz)];
    const geom = new THREE.PlaneGeometry(len, 8);
    mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, 0, cz);
    mesh.rotation.set(0, Math.atan2(-dz, dx), 0);
  } else if (av === "right" || av === "left") {
    const az = a.z ?? 0, bz = b.z ?? 0;
    const dy = b.y - a.y, dz = bz - az;
    const len = Math.sqrt(dy * dy + dz * dz) || 1;
    const ny = -dz / len, nz = dy / len;
    const cy = (a.y + b.y) / 2, cz = (az + bz) / 2;
    origin = [0, round(cy), round(cz)];
    normal = [0, round(ny), round(nz)];
    const geom = new THREE.PlaneGeometry(8, len);
    mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(0, cy, cz);
    mesh.rotation.set(Math.atan2(dz, dy), 0, 0);
  } else {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lineLen = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / lineLen, ny = dx / lineLen;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const planeH = 4;
    const geom = new THREE.PlaneGeometry(lineLen, planeH);
    mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, cy, planeH / 2);
    mesh.rotation.set(Math.PI / 2, 0, Math.atan2(dy, dx));
    origin = [round(cx), round(cy), 0];
    normal = [round(nx), round(ny), 0];
  }

  mesh.userData.kind = "clip-plane";
  mesh.userData.creator = "SdClippingPlane";
  mesh.userData.excludeFromClip = true;
  mesh.userData.clipLabel = label;
  return {
    mesh,
    chain: `SdClippingPlane({origin:[${origin}],normal:[${normal}],label:"${label}"})`,
    dispatchOnCommit: { verb: "SdClippingPlane", args: { origin, normal, label } },
  };
}

// ─── TOOL_HANDLERS + TOOL_TODOS ───────────────────────────────────────────────

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  wall:     { clicks: 2, handler: ([a, b]) => buildWall(a, b) },
  rect:     { clicks: 2, handler: ([a, b]) => buildRect(a, b) },
  circle:   { clicks: 2, handler: ([a, b]) => buildCircle(a, b) },
  line:     { clicks: 2, handler: ([a, b]) => buildLine(a, b) },
  slab:     { clicks: 2, handler: ([a, b]) => buildSlab(a, b) },
  door:     { clicks: 1, handler: ([p]) => buildDoor(p) },
  window:   { clicks: 1, handler: ([p]) => buildWindow(p) },
  column:   { clicks: 1, handler: ([p]) => buildColumn(p) },
  stair:    { clicks: 2, handler: ([a, b]) => buildStair(a, b) },
  polygon:  { clicks: 2, handler: ([a, b]) => buildPolygon(a, b) },
  polyline: { clicks: -1, handler: (pts) => buildPolyline(pts) },
  curve:    { clicks: -1, handler: (pts) => buildCurve(pts) },
  point:    { clicks: 1, handler: ([p]) => buildPoint(p) },
  extrude:      { clicks: 3, handler: ([c1, c2, c3]) => buildBox(c1, c2, c3) },
  beam:         { clicks: 2, handler: ([a, b]) => buildBeam(a, b) },
  roof:         { clicks: 2, handler: ([a, b]) => buildRoof(a, b) },
  space:        { clicks: 2, handler: ([a, b]) => buildSpace(a, b) },
  foundation:   { clicks: 2, handler: ([a, b]) => buildFoundation(a, b) },
  ceiling:      { clicks: 2, handler: ([a, b]) => buildCeiling(a, b) },
  curtainwall:  { clicks: 2, handler: ([a, b]) => buildCurtainWall(a, b) },
  skylight:     { clicks: 2, handler: ([a, b]) => buildSkylight(a, b) },
  opening:      { clicks: 1, handler: ([p]) => buildOpening(p) },
  ramp:         { clicks: 2, handler: ([a, b]) => buildRamp(a, b) },
  railing:      { clicks: 2, handler: ([a, b]) => buildRailing(a, b) },
  grid:         { clicks: 2, handler: ([a, b]) => buildGridLine(a, b) },
  level:        { clicks: 1, handler: ([p]) => buildLevel(p) },
  datum:        { clicks: 2, handler: ([a, b]) => buildReferenceLine(a, b) },
  section:      { clicks: 2, handler: ([a, b]) => buildSectionBox(a, b) },
  clip:         { clicks: 2, handler: ([a, b]) => buildClipPlane(a, b) },
};

export const TOOL_TODOS: Record<string, string> = {
  arc:       "draw(start).arcTo(end, [via]).sketchOnPlane('XY').extrude(thickness)",
  spline:    "draw(start).bezierTo(end, [c1], [c2]).sketchOnPlane('XY').extrude(thickness)",
  revolve:   "select profile then axis then angle — TODO 3-step gizmo flow",
  move:      "select then drag — already covered by transform gizmo",
  rotate:    "select then drag — already covered by transform gizmo",
  scale:     "select then drag — already covered by transform gizmo",
};

// ─── Build extrude mesh from profile (for op-tool extrude) ────────────────────

export function opBuildExtrudeMesh(profile: THREE.Object3D, h: number): THREE.Mesh {
  const creator = profile.userData.creator as string | undefined;
  const box = new THREE.Box3().setFromObject(profile);
  const size = new THREE.Vector3(); box.getSize(size);
  const ctr = new THREE.Vector3(); box.getCenter(ctr);

  if (creator === "circle") {
    const r = Math.max(0.05, size.x / 2);
    const geom = new THREE.CylinderGeometry(r, r, h, 64);
    geom.rotateX(Math.PI / 2);
    geom.translate(0, 0, h / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(ctr.x, ctr.y, 0);
    return mesh;
  }

  if (creator === "curve") {
    const cpLocal: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const isClosed = !!(profile.userData.isClosed as boolean | undefined);
    if (cpLocal.length >= 2) {
      profile.updateMatrixWorld();
      const cpWorld = cpLocal.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
      const sampleCt = Math.max(cpLocal.length * 16, 64);
      const crW = new THREE.CatmullRomCurve3(cpWorld, isClosed, "catmullrom", 0.5);
      const samples = crW.getPoints(sampleCt);
      const color = 0x88aacc;
      if (isClosed) {
        const shape = new THREE.Shape();
        shape.moveTo(samples[0].x, samples[0].y);
        for (let i = 1; i < samples.length; i++) shape.lineTo(samples[i].x, samples[i].y);
        shape.closePath();
        const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
        return new THREE.Mesh(geom, mat);
      } else {
        const verts: number[] = [];
        const idxs: number[] = [];
        samples.forEach((p, i) => {
          verts.push(p.x, p.y, 0, p.x, p.y, h);
          if (i < samples.length - 1) {
            const b = i * 2;
            idxs.push(b, b+2, b+1, b+1, b+2, b+3);
          }
        });
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        geom.setIndex(idxs);
        geom.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
        return new THREE.Mesh(geom, mat);
      }
    }
  }

  if (creator === "line" || creator === "polyline") {
    const pts: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const worldPts = pts.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
    if (worldPts.length >= 2) {
      const verts: number[] = [];
      const idxs: number[] = [];
      worldPts.forEach((p, i) => {
        verts.push(p.x, p.y, 0, p.x, p.y, h);
        if (i < worldPts.length - 1) {
          const b = i * 2;
          idxs.push(b, b+2, b+1, b+1, b+2, b+3);
        }
      });
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geom.setIndex(idxs);
      geom.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
      return new THREE.Mesh(geom, mat);
    }
  }

  const w = Math.max(0.05, size.x);
  const d = Math.max(0.05, size.y || size.x);
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(ctr.x, ctr.y, 0);
  return mesh;
}

// Re-export for use in op-tool.ts
export { dispatchSync };
