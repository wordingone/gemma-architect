// Structural buildX functions — extracted from create-mode.ts (#723).
// All geometry builders for structural elements: walls, slabs, columns, etc.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Viewer } from "../viewer/viewer";
import { makeSnapId } from "../viewer/snap-state";
import type { SnapVertex } from "../viewer/snap-state";
import { initWallCorners } from "./wall-corners";
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

  const geom = new THREE.BoxGeometry(len, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "wall";
  mesh.userData.wallThickness = t;
  mesh.userData.wallHeight = h;
  // CPs in local space: wall X-axis runs from -halfLen to +halfLen.
  mesh.userData.controlPoints = [
    new THREE.Vector3(-len / 2, 0, 0),
    new THREE.Vector3(len / 2, 0, 0),
  ];
  // Initialize corners to rectangular defaults; attemptWallCornerJoins will update them.
  initWallCorners(mesh);
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
    { x: cx, y: cy, z: 0, id: makeSnapId(cx, cy, 0) },
  ] as SnapVertex[];
  const chain = `const wall = makeBox(${round(len)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(cx)}, ${round(cy)}, 0]);`;

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

export type RoofParams = {
  type?: "pitched" | "hip" | "shed" | "flat";
  pitchDeg?: number;
  overhang?: number;
  thickness?: number;
};

export function buildRoof(
  a: { x: number; y: number },
  b: { x: number; y: number },
  params: RoofParams = {},
): { mesh: THREE.Mesh; chain: string } {
  const w  = Math.abs(b.x - a.x) || 6;
  const d  = Math.abs(b.y - a.y) || 8;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;

  const roofType  = params.type ?? "pitched";
  const pitchDeg  = Math.max(5, Math.min(70, params.pitchDeg ?? 30));
  const overhang  = params.overhang ?? 0.4;
  const thickness = params.thickness ?? 0.15;

  const pitchRad = (pitchDeg * Math.PI) / 180;
  const ew = w + 2 * overhang;
  const ed = d + 2 * overhang;
  const hw = ew / 2;
  const hd = ed / 2;
  const ridgeH = Math.min(hw, hd) * Math.tan(pitchRad);

  let geom: THREE.BufferGeometry;

  if (roofType === "flat" || ridgeH < 0.05) {
    geom = new THREE.BoxGeometry(ew, ed, thickness);
    geom.translate(0, 0, thickness / 2);
  } else if (roofType === "shed") {
    // Mono-pitch: low at -y, high at +y
    const verts = new Float32Array([
      -hw, -hd,           0,   // 0 front-left low
       hw, -hd,           0,   // 1 front-right low
       hw,  hd,      ridgeH,   // 2 back-right high
      -hw,  hd,      ridgeH,   // 3 back-left high
      -hw, -hd,   -thickness,  // 4
       hw, -hd,   -thickness,  // 5
       hw,  hd, ridgeH - thickness, // 6
      -hw,  hd, ridgeH - thickness, // 7
    ]);
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geom.setIndex([
      0,1,2, 0,2,3,    // top slope
      0,5,1, 0,4,5,    // front
      1,5,6, 1,6,2,    // right
      3,2,6, 3,6,7,    // back
      0,3,7, 0,7,4,    // left
      4,7,6, 4,6,5,    // bottom
    ]);
    geom.computeVertexNormals();
  } else if (roofType === "hip") {
    // Hip: 4 sloped faces meeting at a ridge shorter than the footprint
    const hipSetback = Math.min(hw, hd) / Math.tan(pitchRad);
    // Ridge along the longer axis; setback from each end
    const landscape = hw >= hd;
    const ridgeHalfLen = landscape
      ? Math.max(0.2, hw - hipSetback)
      : Math.max(0.2, hd - hipSetback);
    const verts = landscape
      ? new Float32Array([
          -hw, -hd, 0,               // 0 base corners
           hw, -hd, 0,               // 1
           hw,  hd, 0,               // 2
          -hw,  hd, 0,               // 3
          -ridgeHalfLen, 0, ridgeH,  // 4 ridge left
           ridgeHalfLen, 0, ridgeH,  // 5 ridge right
        ])
      : new Float32Array([
          -hw, -hd, 0,               // 0
           hw, -hd, 0,               // 1
           hw,  hd, 0,               // 2
          -hw,  hd, 0,               // 3
          0, -ridgeHalfLen, ridgeH,  // 4 ridge front
          0,  ridgeHalfLen, ridgeH,  // 5 ridge back
        ]);
    const idxLandscape = [
      0,1,5, 0,5,4,   // front slope
      3,4,5, 3,5,2,   // back slope
      0,4,3,          // left hip
      1,2,5,          // right hip
      0,3,2, 0,2,1,   // bottom
    ];
    const idxPortrait = [
      0,1,4,          // front hip
      2,3,5,          // back hip
      0,4,5, 0,5,3,   // left slope
      1,5,4, 1,2,5,   // right slope
      0,3,2, 0,2,1,   // bottom
    ];
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geom.setIndex(landscape ? idxLandscape : idxPortrait);
    geom.computeVertexNormals();
  } else {
    // pitched (gable): ridge along longer axis
    const landscape = w >= d;
    let verts: Float32Array;
    let idx: number[];
    if (landscape) {
      // Ridge along x
      verts = new Float32Array([
        -hw, -hd, 0,       // 0
         hw, -hd, 0,       // 1
         hw,  hd, 0,       // 2
        -hw,  hd, 0,       // 3
        -hw,   0, ridgeH,  // 4 left gable peak
         hw,   0, ridgeH,  // 5 right gable peak
      ]);
      idx = [
        0,1,5, 0,5,4,   // front slope
        3,4,5, 3,5,2,   // back slope
        0,4,3,          // left gable
        1,2,5,          // right gable
        0,3,2, 0,2,1,   // bottom
      ];
    } else {
      // Ridge along y
      verts = new Float32Array([
        -hw, -hd, 0,       // 0
         hw, -hd, 0,       // 1
         hw,  hd, 0,       // 2
        -hw,  hd, 0,       // 3
          0, -hd, ridgeH,  // 4 front gable peak
          0,  hd, ridgeH,  // 5 back gable peak
      ]);
      idx = [
        0,1,4,          // front gable
        2,3,5,          // back gable
        0,4,5, 0,5,3,   // left slope
        1,5,4, 1,2,5,   // right slope
        0,3,2, 0,2,1,   // bottom
      ];
    }
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geom.setIndex(idx);
    geom.computeVertexNormals();
  }

  const mat = new THREE.MeshStandardMaterial({ color: 0x7a5c4a, roughness: 0.75, metalness: 0.02 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "roof";
  mesh.userData.roofParams = { type: roofType, pitchDeg, overhang, thickness };

  const chain = `const roof = buildParametricRoof(${round(w)}, ${round(d)}, { type:"${roofType}", pitchDeg:${round(pitchDeg)}, overhang:${round(overhang)}, thickness:${round(thickness)} }).translate([${round(cx)}, ${round(cy)}, 0]);`;
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

export type CurtainWallParams = {
  mullionSpacing?: number;
  transomSpacing?: number;
};

export function buildCurtainWall(
  a: { x: number; y: number },
  b: { x: number; y: number },
  params: CurtainWallParams = {},
): { mesh: THREE.Group; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const h    = DEFAULT_WALL_HEIGHT;
  const fp   = 0.05;   // frame profile: 50 mm square
  const fd   = 0.10;   // frame depth: 100 mm (Y axis)
  const mSp  = params.mullionSpacing  ?? 1.5;
  const tSp  = params.transomSpacing  ?? 1.0;
  const cols = Math.max(1, Math.ceil(len / mSp));
  const rows = Math.max(1, Math.ceil(h   / tSp));
  const colW = len / cols;
  const rowH = h   / rows;

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.4, metalness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x88ccee, transparent: true, opacity: 0.35, roughness: 0.05 });

  const group = new THREE.Group();

  // Helper: add a frame bar. bx = X width, bz = Z height, x/z = local center position.
  const bar = (bx: number, bz: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bx, fd, bz), frameMat);
    m.position.set(x, 0, z);
    group.add(m);
  };

  // Perimeter rails + stiles
  bar(len, fp, 0,             fp / 2);           // bottom rail
  bar(len, fp, 0,             h - fp / 2);        // top rail
  bar(fp,  h,  -len/2 + fp/2, h / 2);             // left stile
  bar(fp,  h,   len/2 - fp/2, h / 2);             // right stile

  // Interior mullions (vertical)
  for (let c = 1; c < cols; c++) {
    bar(fp, h - 2 * fp, c * colW - len / 2, h / 2);
  }
  // Interior transoms (horizontal)
  for (let r = 1; r < rows; r++) {
    bar(len - 2 * fp, fp, 0, r * rowH);
  }

  // Glass panels (one per cell)
  const glassW = colW - fp;
  const glassH = rowH - fp;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const xPos = (c + 0.5) * colW - len / 2;
      const zPos = (r + 0.5) * rowH;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(glassW, fd * 0.3, glassH), glassMat);
      panel.position.set(xPos, 0, zPos);
      group.add(panel);
    }
  }

  group.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
  group.rotation.z = (angDeg * Math.PI) / 180;
  group.userData.kind = "brep";
  group.userData.creator = "curtainwall";
  group.userData.curtainWallParams = { mullionSpacing: mSp, transomSpacing: tSp };

  // Invisible join shell: BoxGeometry brush representing the structural wall envelope.
  // join-groups CSG pipeline uses this instead of trying to handle the THREE.Group directly.
  // The visible composite group remains shown independently; the shell participates in CSG.
  const shellGeom = new THREE.BoxGeometry(len, fd, h);
  shellGeom.translate(0, 0, h / 2);  // base at z=0, top at z=h
  const shellMat = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.4, metalness: 0.8 });
  const joinableShell = new THREE.Mesh(shellGeom, shellMat);
  joinableShell.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
  joinableShell.rotation.z = (angDeg * Math.PI) / 180;
  joinableShell.visible = false;
  joinableShell.userData.kind = "brep";
  joinableShell.userData.creator = "curtainwall";
  joinableShell.userData.isJoinShell = true;
  group.userData.joinableShell = joinableShell;

  const chain = `// curtainwall: ${round(len)}m × ${round(h)}m, ${cols} cols × ${rows} rows (mullion ${mSp}m, transom ${tSp}m)`;
  return { mesh: group, chain };
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
