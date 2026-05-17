// Structural buildX functions — extracted from create-mode.ts (#723).
// All geometry builders for structural elements: walls, slabs, columns, etc.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Viewer } from "../viewer/viewer";
import { makeSnapId } from "../viewer/snap-state";
import type { SnapVertex } from "../viewer/snap-state";
import { levelStore } from "../geometry/levels";
import { refLineStore } from "../geometry/ref-lines";

// Module-level viewer reference (set during initCreateMode).
let _viewer: Viewer | null = null;
export function setStructuralViewer(v: Viewer | null): void { _viewer = v; }

// Default heights / sizes from tier1-conventions.
const DEFAULT_WALL_HEIGHT = 3;
const DEFAULT_WALL_THICKNESS = 0.2;
const DEFAULT_SLAB_THICKNESS = 0.2;
const DEFAULT_COLUMN_HEIGHT = 4;
const DEFAULT_RECT_HEIGHT = 2.8;
const DEFAULT_STAIR_RISE = 0.18;
const DEFAULT_STAIR_TREAD = 0.28;
const DEFAULT_STAIR_WIDTH = 1.0;
const DEFAULT_EXTRUDE_HEIGHT = 2.5;
const DEFAULT_BEAM_SIZE = 0.2;
const DEFAULT_FOUNDATION_T = 0.5;
const DEFAULT_CEILING_T = 0.05;
const DEFAULT_RAMP_WIDTH = 1.2;
const DEFAULT_RAILING_H = 1.0;

void DEFAULT_EXTRUDE_HEIGHT; // used by downstream callers

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// ── Wall butt join system ───────────────────────────────────────────────────

type V2 = { x: number; y: number };

interface WallRec {
  a: V2; b: V2;
  aL: V2; aR: V2; // left/right corner at A end (left = looking from A→B)
  bL: V2; bR: V2; // left/right corner at B end
  aOpen: boolean;  // secondary at A-end: end face is hidden inside primary, omit to avoid z-fighting
  bOpen: boolean;  // secondary at B-end
  mesh: THREE.Mesh;
}

const _wallRecs = new Map<string, WallRec>();

function v2Eq(a: V2, b: V2, eps = 0.02): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

function shiftV2(v: V2, d: V2, scale: number, t: number): V2 {
  return { x: v.x + d.x * scale * t / 2, y: v.y + d.y * scale * t / 2 };
}

// Build a wall prism from 4 world-XY base corners. Geometry in local space (offset by ox,oy).
// aOpen/bOpen: secondary wall omits its hidden end face to prevent z-fighting with primary wall.
function wallPrism(aL: V2, aR: V2, bL: V2, bR: V2, h: number, ox: number, oy: number, aOpen = false, bOpen = false): THREE.BufferGeometry {
  const p = [
    aL.x - ox, aL.y - oy, 0,  // 0
    aR.x - ox, aR.y - oy, 0,  // 1
    bR.x - ox, bR.y - oy, 0,  // 2
    bL.x - ox, bL.y - oy, 0,  // 3
    aL.x - ox, aL.y - oy, h,  // 4
    aR.x - ox, aR.y - oy, h,  // 5
    bR.x - ox, bR.y - oy, h,  // 6
    bL.x - ox, bL.y - oy, h,  // 7
  ];
  const idx: number[] = [
    0, 2, 1,  0, 3, 2,   // bottom (-Z)
    4, 5, 6,  4, 6, 7,   // top (+Z)
    1, 2, 6,  1, 6, 5,   // right side
    0, 4, 7,  0, 7, 3,   // left side
  ];
  if (!aOpen) idx.push(0, 1, 5,  0, 5, 4);  // start face (A end)
  if (!bOpen) idx.push(2, 3, 7,  2, 7, 6);  // end face (B end)
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function rebuildWallRec(rec: WallRec): void {
  const ox = rec.mesh.position.x, oy = rec.mesh.position.y;
  rec.mesh.geometry.dispose();
  rec.mesh.geometry = wallPrism(rec.aL, rec.aR, rec.bL, rec.bR, DEFAULT_WALL_HEIGHT, ox, oy, rec.aOpen, rec.bOpen);
}

// ── Public wall API ──────────────────────────────────────────────────────────

export function buildWall(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const t = DEFAULT_WALL_THICKNESS, h = DEFAULT_WALL_HEIGHT;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;

  if (len < 0.01) {
    const geom0 = new THREE.BoxGeometry(0.01, t, h);
    geom0.translate(0, 0, h / 2);
    const mat0 = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
    const m0 = new THREE.Mesh(geom0, mat0);
    m0.position.set(a.x, a.y, 0);
    m0.userData.kind = "brep"; m0.userData.creator = "wall";
    return { mesh: m0, chain: "" };
  }

  // Prune stale records (walls removed from scene).
  for (const [uid, rec] of _wallRecs) {
    if (!rec.mesh.parent) _wallRecs.delete(uid);
  }

  const dAB: V2 = { x: dx / len, y: dy / len };
  const nx = -dy / len, ny = dx / len;

  // Initial corners (rectangular, no join).
  let aL: V2 = { x: a.x + nx * t / 2, y: a.y + ny * t / 2 };
  let aR: V2 = { x: a.x - nx * t / 2, y: a.y - ny * t / 2 };
  let bL: V2 = { x: b.x + nx * t / 2, y: b.y + ny * t / 2 };
  let bR: V2 = { x: b.x - nx * t / 2, y: b.y - ny * t / 2 };
  let aOpen = false, bOpen = false;

  // Butt join: primary (existing) extends its end outward by t/2 to own the corner patch.
  // Secondary (new) retreats its end inward by t/2 so its end face hides inside the primary.
  for (const [, rec] of _wallRecs) {
    const rdx = rec.b.x - rec.a.x, rdy = rec.b.y - rec.a.y;
    const rl = Math.sqrt(rdx * rdx + rdy * rdy);
    const dr: V2 = { x: rdx / rl, y: rdy / rl }; // rec's A→B unit direction

    // --- Neighbors touching A end of new wall ---
    if (v2Eq(rec.a, a)) {
      // Primary rec extends its A-end outward (against dr).
      rec.aL = shiftV2(rec.aL, dr, -1, t); rec.aR = shiftV2(rec.aR, dr, -1, t);
      rebuildWallRec(rec);
      // Secondary new retreats A-end inward (along dAB).
      aL = shiftV2(aL, dAB, +1, t); aR = shiftV2(aR, dAB, +1, t); aOpen = true;
    } else if (v2Eq(rec.b, a)) {
      // Primary rec extends its B-end outward (along dr).
      rec.bL = shiftV2(rec.bL, dr, +1, t); rec.bR = shiftV2(rec.bR, dr, +1, t);
      rebuildWallRec(rec);
      aL = shiftV2(aL, dAB, +1, t); aR = shiftV2(aR, dAB, +1, t); aOpen = true;
    }
    // --- Neighbors touching B end of new wall ---
    if (v2Eq(rec.a, b)) {
      rec.aL = shiftV2(rec.aL, dr, -1, t); rec.aR = shiftV2(rec.aR, dr, -1, t);
      rebuildWallRec(rec);
      // Secondary retreats B-end inward (against dAB).
      bL = shiftV2(bL, dAB, -1, t); bR = shiftV2(bR, dAB, -1, t); bOpen = true;
    } else if (v2Eq(rec.b, b)) {
      rec.bL = shiftV2(rec.bL, dr, +1, t); rec.bR = shiftV2(rec.bR, dr, +1, t);
      rebuildWallRec(rec);
      bL = shiftV2(bL, dAB, -1, t); bR = shiftV2(bR, dAB, -1, t); bOpen = true;
    }
  }

  const geom = wallPrism(aL, aR, bL, bR, h, cx, cy, aOpen, bOpen);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "wall";
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
    { x: cx, y: cy, z: 0, id: makeSnapId(cx, cy, 0) },
  ] as SnapVertex[];
  const chain = `const wall = makeBox(${round(len)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(cx)}, ${round(cy)}, 0]);`;

  _wallRecs.set(mesh.uuid, { a, b, aL, aR, bL, bR, aOpen, bOpen, mesh });
  return { mesh, chain };
}

export function rebuildWallInPlace(mesh: THREE.Mesh, a: { x: number; y: number }, b: { x: number; y: number }): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.01) return;
  const t = DEFAULT_WALL_THICKNESS, h = DEFAULT_WALL_HEIGHT;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  mesh.geometry.dispose();
  const geom = new THREE.BoxGeometry(length, t, h);
  geom.translate(0, 0, h / 2);
  mesh.geometry = geom;
  mesh.position.set(cx, cy, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  const midX = cx, midY = cy;
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
    { x: midX, y: midY, z: 0, id: makeSnapId(midX, midY, 0) },
  ] as SnapVertex[];
}

// No-op: universal CSG join (join-groups.ts) handles all structural element joining.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function attemptWallJoins(_newMesh: THREE.Mesh, _viewer: Viewer): void {
  // Intentionally empty — superseded by onElementCommitted in join-groups.ts.
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

function _drawLevelCanvas(name: string): HTMLCanvasElement {
  const W = 192, H = 48;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  ctx.font = "500 20px system-ui,sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(255,255,255,0.7)";
  ctx.shadowBlur = 5;
  ctx.fillStyle = "#6b9a80";
  ctx.fillText(name, W / 2, H / 2);
  ctx.shadowBlur = 0;
  ctx.fillText(name, W / 2, H / 2);
  return canvas;
}

export function makeLevelSprite(name: string): THREE.Sprite {
  const tex = new THREE.CanvasTexture(_drawLevelCanvas(name));
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, alphaTest: 0.01, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4, 1, 1);
  sprite.userData.isLevelLabel = true;
  return sprite;
}

export function updateLevelSprite(sprite: THREE.Sprite, name: string): void {
  const mat = sprite.material as THREE.SpriteMaterial;
  if (mat.map) mat.map.dispose();
  mat.map = new THREE.CanvasTexture(_drawLevelCanvas(name));
  mat.needsUpdate = true;
}

export function buildLevel(p: { x: number; y: number; z?: number }): { mesh: THREE.Object3D; chain: string; levelId: string } {
  const elevation = p.z ?? 0;
  const name = `Level ${levelStore.all().length}`;
  const level = levelStore.findOrCreate(name, elevation, 3.0);
  const extent = 20;
  const geom = new THREE.BoxGeometry(extent, extent, 0.02);
  const mat = new THREE.MeshBasicMaterial({ color: 0x44aa88, transparent: true, opacity: 0.04, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, elevation);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcLevel";
  mesh.userData.levelId = level.id;
  mesh.userData.noSnap = true;
  const label = makeLevelSprite(level.name);
  label.position.set(extent / 2 - 2.5, extent / 2 - 2.5, 0.3);
  mesh.add(label);
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
  activeView: string,
): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const av = activeView;
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
