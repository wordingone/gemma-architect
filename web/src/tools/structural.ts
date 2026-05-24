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
import { STAIR_STEP_RISE as DEFAULT_STAIR_RISE, STAIR_STEP_DEPTH as DEFAULT_STAIR_TREAD, STAIR_WIDTH as DEFAULT_STAIR_WIDTH } from "./dimensions";

// Module-level viewer reference (set during initCreateMode).
let _viewer: Viewer | null = null;
export function setStructuralViewer(v: Viewer | null): void { _viewer = v; }

// Default heights / sizes — IBC residential compliance (R311, R305).
export const DEFAULT_WALL_HEIGHT = 3;
const DEFAULT_WALL_THICKNESS = 0.2;
export const DEFAULT_SLAB_THICKNESS = 0.1;   // IBC 4" residential floor (was 0.2 = 7.87")
const DEFAULT_COLUMN_HEIGHT = 4;
const DEFAULT_RECT_HEIGHT = 2.8;
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

/** Re-build a wall mesh in-place with new thickness/height/bottom-elevation.
 *  Reads existing controlPoints (local space) to determine wall axis.
 *  Safe to call from inspect-panel onChange or height-handle drag-end. */
export function rebuildWallParams(
  mesh: THREE.Mesh,
  params: { thickness?: number; height?: number; bottomElevation?: number },
): void {
  const t = params.thickness ?? (mesh.userData.wallThickness as number | undefined) ?? DEFAULT_WALL_THICKNESS;
  const h = params.height ?? (mesh.userData.wallHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;

  // Write metadata before the controlPoints guard — thickness/height must be
  // persisted even when geometry can't be rebuilt (e.g. wall with no CPs yet).
  mesh.userData.wallThickness = t;
  mesh.userData.wallHeight = h;

  const cps = mesh.userData.controlPoints as THREE.Vector3[] | undefined;
  if (!cps || cps.length < 2) return;

  mesh.updateMatrixWorld(true);
  const wA = cps[0].clone().applyMatrix4(mesh.matrixWorld);
  const wB = cps[1].clone().applyMatrix4(mesh.matrixWorld);
  const len = wA.distanceTo(wB);
  if (len < 0.01) return;

  const cx = (wA.x + wB.x) / 2;
  const cy = (wA.y + wB.y) / 2;
  const zOff = params.bottomElevation ?? mesh.position.z;
  const angRad = Math.atan2(wB.y - wA.y, wB.x - wA.x);

  mesh.geometry.dispose();
  const geom = new THREE.BoxGeometry(len, t, h);
  geom.translate(0, 0, h / 2);
  mesh.geometry = geom;
  mesh.position.set(cx, cy, zOff);
  mesh.rotation.z = angRad;
  mesh.updateMatrixWorld(true);

  cps[0].set(-len / 2, 0, 0);
  cps[1].set(len / 2, 0, 0);

  mesh.userData.endpoints = [
    { x: wA.x, y: wA.y, z: zOff, id: makeSnapId(wA.x, wA.y, zOff) },
    { x: wB.x, y: wB.y, z: zOff, id: makeSnapId(wB.x, wB.y, zOff) },
  ];
}

// Resize a void-cut Group wall's segments to a new height.
// Segments that reach the current wall top are extended/shrunk;
// sill-only segments (below void) are left unchanged.
export function rebuildGroupWallHeight(group: THREE.Group, newHt: number): void {
  const curHt = (group.userData.wallHeight as number | undefined) ?? 3;
  if (Math.abs(newHt - curHt) < 0.001) return;
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const bGeom = child.geometry as THREE.BoxGeometry;
    if (!bGeom?.parameters) continue;
    const segW = bGeom.parameters.width;
    const segD = bGeom.parameters.height; // Y = thickness
    const segH = bGeom.parameters.depth;  // Z = segment height
    const topZ = child.position.z + segH / 2;
    if (Math.abs(topZ - curHt) < 0.05) {
      // Segment extends to wall top → resize.
      const botZ = child.position.z - segH / 2;
      const newSegH = Math.max(0.001, newHt - botZ);
      child.geometry.dispose();
      child.geometry = new THREE.BoxGeometry(segW, segD, newSegH);
      child.position.z = botZ + newSegH / 2;
    }
  }
  group.userData.wallHeight = newHt;
  const dims = group.userData.originalWallDims as { w: number; d: number; h: number } | undefined;
  if (dims) group.userData.originalWallDims = { ...dims, h: newHt };
}

export function buildWall(a: { x: number; y: number }, b: { x: number; y: number }, height?: number): { mesh: THREE.Mesh; chain: string } {
  const t = DEFAULT_WALL_THICKNESS, h = height ?? DEFAULT_WALL_HEIGHT;
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
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
  ] as SnapVertex[];
  // Initialize corners to rectangular defaults; attemptWallCornerJoins will update them.
  initWallCorners(mesh);
  const chain = `const wall = makeBox(${round(len)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(cx)}, ${round(cy)}, 0]);`;

  return { mesh, chain };
}

export function rebuildWallInPlace(mesh: THREE.Mesh, a: { x: number; y: number }, b: { x: number; y: number }, height?: number): void {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.01) return;
  const t = DEFAULT_WALL_THICKNESS, h = height ?? DEFAULT_WALL_HEIGHT;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  mesh.geometry.dispose();
  const geom = new THREE.BoxGeometry(length, t, h);
  geom.translate(0, 0, h / 2);
  mesh.geometry = geom;
  mesh.position.set(cx, cy, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
  ] as SnapVertex[];
}

// Gable-top wall: pentagon profile (level bottom, angled apex).
// Caller supplies world-space endpoints; eaveH is the height to the eave (same as
// a level wall's height); ridgeH is the ADDITIONAL height from eave to ridge apex.
export function buildWallPitchedTop(
  a: { x: number; y: number },
  b: { x: number; y: number },
  eaveH: number,
  ridgeH: number,
  thickness: number = DEFAULT_WALL_THICKNESS,
): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 0.01;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const t = thickness;

  // Pentagon in XY plane (X = wall length, Y = height). Extrude by t in Z.
  const shape = new THREE.Shape();
  shape.moveTo(-len / 2, 0);
  shape.lineTo( len / 2, 0);
  shape.lineTo( len / 2, eaveH);
  shape.lineTo( 0,       eaveH + ridgeH);
  shape.lineTo(-len / 2, eaveH);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false });
  // ExtrudeGeometry: shape in XY, extrudes +Z by t.
  // Rotate +90° around X so that old Y (height) → new +Z (up), old Z (t) → new -Y.
  geom.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  // Center Y so wall face is at y = ±t/2 (same convention as BoxGeometry wall).
  geom.translate(0, t / 2, 0);

  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "wall";
  mesh.userData.wallThickness = t;
  mesh.userData.wallHeight = eaveH;
  mesh.userData.topProfile = "pitched";
  mesh.userData.eaveHeight = eaveH;
  mesh.userData.ridgeHeight = ridgeH;
  mesh.userData.controlPoints = [
    new THREE.Vector3(-len / 2, 0, 0),
    new THREE.Vector3( len / 2, 0, 0),
  ];
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
  ] as SnapVertex[];
  initWallCorners(mesh);
  const chain = `// gable wall len=${round(len)} eave=${round(eaveH)} ridge=${round(eaveH + ridgeH)}`;
  return { mesh, chain };
}

// No-op: universal CSG join (join-groups.ts) handles all structural element joining.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function attemptWallJoins(_newMesh: THREE.Mesh, _viewer: Viewer): void {
  // Intentionally empty — superseded by onElementCommitted in join-groups.ts.
}

export function buildSlab(a: { x: number; y: number }, b: { x: number; y: number }, thickness?: number): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x);
  const d = Math.abs(b.y - a.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const t = thickness ?? DEFAULT_SLAB_THICKNESS;
  const geom = new THREE.BoxGeometry(w, d, t);
  geom.translate(0, 0, t / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa8a097, roughness: 0.7, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "slab";
  mesh.userData._snapCreationPos = { x: cx, y: cy, z: 0 };
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: a.y, z: 0, id: makeSnapId(b.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
    { x: a.x, y: b.y, z: 0, id: makeSnapId(a.x, b.y, 0) },
  ];
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
  mesh.userData._snapCreationPos = { x: p.x, y: p.y, z: 0 };
  mesh.userData.endpoints = [
    { x: p.x, y: p.y, z: 0, id: makeSnapId(p.x, p.y, 0) },
  ];
  const chain = `const col = drawRectangle(${round(s)}, ${round(s)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]);`;
  return { mesh, chain };
}

export interface StairParams {
  type?: "straight" | "L" | "U";        // primary shape selector
  shape?: "straight" | "L" | "U" | "switchback"; // legacy alias
  count?: number;    // total tread count; takes priority over targetHeight/riserHeight
  rise?: number;     // total storey rise in m; alias for targetHeight
  width?: number;
  riserHeight?: number;
  treadDepth?: number;
  targetHeight?: number;
  landingDepth?: number;
}

// Plan-view footprint bbox (in world XY) — returned so the handler can cut a slab void.
export interface StairFootprint { minX: number; minY: number; maxX: number; maxY: number }

const _stepMat = (): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color: 0xc8b8a2, roughness: 0.7, metalness: 0.0 });

// 2D line intersection. Returns null if lines are parallel (cross product ≈ 0).
function _intersect2D(
  p1: { x: number; y: number }, d1: { x: number; y: number },
  p2: { x: number; y: number }, d2: { x: number; y: number },
): { x: number; y: number } | null {
  const cross = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(cross) < 1e-9) return null;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const t = (dx * d2.y - dy * d2.x) / cross;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

// Build a parametric landing mesh whose plan-shape is a parallelogram aligned to the
// incoming (d1) and outgoing (d2) flight directions. Replaces the fixed square box.
// Falls back to a direction-aligned square when flights are nearly parallel (|sin θ| < 0.1),
// which prevents the intersection points from shooting off to astronomical distances.
function _makeLandingMesh(
  pB: { x: number; y: number },
  d1n: { x: number; y: number }, // normalized incoming direction
  d2n: { x: number; y: number }, // normalized outgoing direction
  stairW: number,
  landingT: number,
  zBase: number,
  stairId: string,
): THREE.Mesh {
  const half = stairW / 2;

  // |cross| = |sin θ| for unit vectors. Below 0.1 (~5.7°) the intersection
  // is unreliably far away (stairW / (2 sin θ) → ∞ on smooth curves).
  const cross = d1n.x * d2n.y - d1n.y * d2n.x;
  let A: { x: number; y: number },
      B: { x: number; y: number },
      C: { x: number; y: number },
      D: { x: number; y: number };

  if (Math.abs(cross) < 0.1) {
    // Nearly parallel — use a direction-aligned square so the landing tracks the stair.
    const avgX = (d1n.x + d2n.x) / 2, avgY = (d1n.y + d2n.y) / 2;
    const avgLen = Math.sqrt(avgX * avgX + avgY * avgY) || 1;
    const fx = avgX / avgLen, fy = avgY / avgLen; // forward
    const lx = -fy, ly = fx; // left-normal
    A = { x: pB.x - fx * half + lx * half, y: pB.y - fy * half + ly * half };
    B = { x: pB.x - fx * half - lx * half, y: pB.y - fy * half - ly * half };
    C = { x: pB.x + fx * half - lx * half, y: pB.y + fy * half - ly * half };
    D = { x: pB.x + fx * half + lx * half, y: pB.y + fy * half + ly * half };
  } else {
    const n1 = { x: -d1n.y, y: d1n.x }; // left-normal of d1
    const n2 = { x: -d2n.y, y: d2n.x }; // left-normal of d2
    // Four bounding edge lines of the landing (pair aligned to each flight direction).
    const pL1 = { x: pB.x + n1.x * half, y: pB.y + n1.y * half };
    const pR1 = { x: pB.x - n1.x * half, y: pB.y - n1.y * half };
    const pL2 = { x: pB.x + n2.x * half, y: pB.y + n2.y * half };
    const pR2 = { x: pB.x - n2.x * half, y: pB.y - n2.y * half };
    const fallback: Array<{ x: number; y: number }> = [
      { x: pB.x - half, y: pB.y + half },
      { x: pB.x - half, y: pB.y - half },
      { x: pB.x + half, y: pB.y - half },
      { x: pB.x + half, y: pB.y + half },
    ];
    A = _intersect2D(pL1, d1n, pL2, d2n) ?? fallback[0];
    B = _intersect2D(pR1, d1n, pL2, d2n) ?? fallback[1];
    C = _intersect2D(pR1, d1n, pR2, d2n) ?? fallback[2];
    D = _intersect2D(pL1, d1n, pR2, d2n) ?? fallback[3];
  }

  const shape = new THREE.Shape();
  shape.moveTo(A.x - pB.x, A.y - pB.y);
  shape.lineTo(B.x - pB.x, B.y - pB.y);
  shape.lineTo(C.x - pB.x, C.y - pB.y);
  shape.lineTo(D.x - pB.x, D.y - pB.y);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, { depth: landingT, bevelEnabled: false });
  const mesh = new THREE.Mesh(geo, _stepMat());
  mesh.position.set(pB.x, pB.y, zBase);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "stair";
  mesh.userData.ifcClass = "IfcSlab";
  mesh.userData.parentId = stairId;
  return mesh;
}

// Single-solid stair flight: stepped top + diagonal underside (stringer) as one ExtrudeGeometry.
// Shape in XY with Y negative = height, so makeRotationX(-PI/2) maps: shape-X→world-X, shape-Y→world-Z.
function _buildFlightSolid(
  n: number, riser: number, tread: number, stairW: number, zBase: number,
): THREE.Mesh {
  // stringerD: vertical depth below nosing line (shape +Y = world -Z = below stair).
  // riser*2 gives a stringer ~14" deep for 7" risers — visually solid, IBC-plausible.
  const stringerD = riser * 2;
  const shape = new THREE.Shape();
  shape.moveTo(0, -zBase);
  for (let i = 0; i < n; i++) {
    shape.lineTo(i * tread, -(zBase + (i + 1) * riser));
    shape.lineTo((i + 1) * tread, -(zBase + (i + 1) * riser));
  }
  // Stringer bottom: two points parallel to nosing line but offset +stringerD in shape-Y
  // (= stringerD lower in world-Z). Creates solid material below the step nosings.
  shape.lineTo(n * tread, -(zBase + n * riser) + stringerD);
  shape.lineTo(0, -zBase + stringerD);
  shape.closePath(); // short left vertical face back to start
  const geom = new THREE.ExtrudeGeometry(shape, { depth: stairW, bevelEnabled: false });
  geom.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
  const mesh = new THREE.Mesh(geom, _stepMat());
  mesh.userData.kind = "brep";
  mesh.userData.creator = "stair";
  mesh.userData.ifcClass = "IfcStairFlight";
  return mesh;
}

function _flightGeoms(nRisers: number, riser: number, tread: number, stairW: number, zBase: number): THREE.BufferGeometry[] {
  const geoms: THREE.BufferGeometry[] = [];
  for (let i = 0; i < nRisers; i++) {
    const cumH = zBase + (i + 1) * riser;
    const g = new THREE.BoxGeometry(tread, stairW, cumH);
    g.translate(i * tread + tread / 2, stairW / 2, cumH / 2);
    geoms.push(g);
  }
  return geoms;
}

function _mergeFlight(geoms: THREE.BufferGeometry[]): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color: 0xc8b8a2, roughness: 0.7, metalness: 0.0 });
  const merged = mergeGeometries(geoms, false);
  geoms.forEach((g) => g.dispose());
  if (!merged) {
    const fb = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    return new THREE.Mesh(fb, mat);
  }
  return new THREE.Mesh(merged, mat);
}

export function buildStair(
  a: { x: number; y: number },
  b: { x: number; y: number },
  params?: StairParams,
): { group: THREE.Group; chain: string; footprint: StairFootprint } {
  const shape    = params?.type ?? params?.shape ?? "straight";
  const stairW   = params?.width       ?? DEFAULT_STAIR_WIDTH;
  const tread    = params?.treadDepth  ?? DEFAULT_STAIR_TREAD;
  const landingD = params?.landingDepth ?? 1.0;

  const dx = b.x - a.x, dy = b.y - a.y;
  const totalRun = Math.sqrt(dx * dx + dy * dy) || tread * 2;
  const angDeg   = (Math.atan2(dy, dx) * 180) / Math.PI;
  const stairId  = THREE.MathUtils.generateUUID();

  // Parametric step count: derive from actual click distance for straight mode.
  // Explicit count or total-rise override the distance-based default.
  // Min = 1 (porch/threshold steps are valid — Math.max(2,...) was too aggressive per #1680).
  let nRisers: number, actualRiser: number, actualTread: number;
  if (params?.count != null) {
    nRisers = Math.max(1, params.count);
    actualRiser = params?.riserHeight ?? DEFAULT_STAIR_RISE;
    actualTread = tread;
  } else if (params?.rise != null || params?.targetHeight != null) {
    // Rise-first (Revit-style): step count from total rise; tread fits the run for straight flights.
    const targetH = (params.rise ?? params.targetHeight)!;
    nRisers = Math.max(1, Math.ceil(targetH / (params?.riserHeight ?? DEFAULT_STAIR_RISE)));
    actualRiser = targetH / nRisers;
    actualTread = shape === "straight" && totalRun > tread ? totalRun / nRisers : tread;
  } else if (shape === "straight") {
    // Run-derived fallback: step count from distance; tread fits exactly.
    nRisers = Math.max(1, Math.round(totalRun / tread));
    actualRiser = params?.riserHeight ?? DEFAULT_STAIR_RISE;
    actualTread = totalRun / nRisers;
  } else {
    // L / U: height-based default (one full storey).
    const targetH = DEFAULT_WALL_HEIGHT;
    nRisers = Math.max(1, Math.ceil(targetH / (params?.riserHeight ?? DEFAULT_STAIR_RISE)));
    actualRiser = targetH / nRisers;
    actualTread = tread;
  }
  const totalRise = nRisers * actualRiser;

  const mat = new THREE.MeshStandardMaterial({ color: 0xc8b8a2, roughness: 0.7, metalness: 0.0 });
  const group = new THREE.Group();
  group.position.set(a.x, a.y, 0);
  group.rotation.z = (angDeg * Math.PI) / 180;
  group.userData.kind = "compound";
  group.userData.creator = "stair";
  group.userData.stairId = stairId;
  group.userData.stairParams = { shape, nRisers, actualRiser, actualTread, stairW, totalRise };

  let footLocal: { minX: number; minY: number; maxX: number; maxY: number };
  let chainDesc: string;

  if (shape === "U" || shape === "switchback") {
    // 3-flight U-stair with 2 quarter-landings (common case):
    //   Flight 1: +Y direction (y=0 → y=f1Run), x=0..stairW
    //   Landing 1: square platform at corner
    //   Flight 2: +X direction (x=0 → x=f2Run), y=f1Run..f1Run+stairW
    //   Landing 2: square platform at far corner
    //   Flight 3: -Y direction (y=f1Run → y=0), x=f2Run..f2Run+stairW
    // Plan view: open U shape with legs at x=0 and x=f2Run+stairW, closed at y=f1Run.
    const n1 = Math.floor(nRisers / 3);
    const n2 = Math.floor(nRisers / 3);
    const n3 = nRisers - n1 - n2;
    const f1Run = n1 * actualTread;   // leg 1 depth (in Y)
    const f2Run = n2 * actualTread;   // bridge width (in X)

    // Flight 1: +Y direction (x=0..stairW). Wrap _buildFlightSolid (+X) with +90° Z rotation.
    const f1u = _buildFlightSolid(n1, actualRiser, actualTread, stairW, 0);
    f1u.userData.parentId = stairId;
    const f1uWrapper = new THREE.Group();
    f1uWrapper.position.set(stairW, 0, 0);
    f1uWrapper.rotation.z = Math.PI / 2;
    f1uWrapper.add(f1u);
    group.add(f1uWrapper);

    // Landing 1 at corner (y=f1Run, x=0..stairW)
    const ldg1Geo = new THREE.BoxGeometry(stairW, landingD, DEFAULT_SLAB_THICKNESS);
    ldg1Geo.translate(stairW / 2, f1Run + landingD / 2, n1 * actualRiser + DEFAULT_SLAB_THICKNESS / 2);
    group.add(new THREE.Mesh(ldg1Geo, mat));

    // Flight 2: +X direction at y=f1Run+landingD..f1Run+landingD+stairW.
    const f2u = _buildFlightSolid(n2, actualRiser, actualTread, stairW, n1 * actualRiser);
    f2u.userData.parentId = stairId;
    f2u.position.set(0, f1Run + landingD, 0);
    group.add(f2u);

    // Landing 2 at far corner (x=f2Run, y=f1Run+landingD..f1Run+landingD+stairW)
    const ldg2Geo = new THREE.BoxGeometry(landingD, stairW, DEFAULT_SLAB_THICKNESS);
    ldg2Geo.translate(f2Run + landingD / 2, f1Run + landingD + stairW / 2, (n1 + n2) * actualRiser + DEFAULT_SLAB_THICKNESS / 2);
    group.add(new THREE.Mesh(ldg2Geo, mat));

    // Flight 3: -Y direction. Wrap with -90° Z rotation, positioned at far corner.
    const f3u = _buildFlightSolid(n3, actualRiser, actualTread, stairW, (n1 + n2) * actualRiser);
    f3u.userData.parentId = stairId;
    const f3uWrapper = new THREE.Group();
    f3uWrapper.position.set(f2Run + landingD, f1Run + landingD, 0);
    f3uWrapper.rotation.z = -Math.PI / 2;
    f3uWrapper.add(f3u);
    group.add(f3uWrapper);
    const totalX = f2Run + landingD + stairW;
    const totalY = f1Run + landingD + stairW;
    footLocal = { minX: 0, minY: 0, maxX: totalX, maxY: totalY };
    chainDesc = `U(flights:${n1}+${n2}+${n3},tread:${round(actualTread)},riser:${round(actualRiser)},w:${round(stairW)})`;

  } else if (shape === "L") {
    // L-shape: flight 1 goes +X, landing, flight 2 goes +Y (perpendicular).
    // Both flights use _buildFlightSolid for proper stepped profile with stringer.
    const n1 = Math.floor(nRisers / 2);
    const n2 = nRisers - n1;
    const f1Run = n1 * actualTread;
    const f2Run = n2 * actualTread;

    // Flight 1: +X direction, width in +Y (0..stairW)
    const f1 = _buildFlightSolid(n1, actualRiser, actualTread, stairW, 0);
    f1.userData.parentId = stairId;
    group.add(f1);

    // Landing at the L corner
    const landingGeo = new THREE.BoxGeometry(stairW, stairW, DEFAULT_SLAB_THICKNESS);
    landingGeo.translate(f1Run + stairW / 2, stairW / 2, n1 * actualRiser + DEFAULT_SLAB_THICKNESS / 2);
    group.add(new THREE.Mesh(landingGeo, mat));

    // Flight 2: +Y direction. Wrap _buildFlightSolid (runs +X) with a +90° Z rotation.
    // Wrapper at (f1Run+stairW, 0, 0) so that run goes from y=0 to y=f2Run,
    // width goes from x=f1Run to x=f1Run+stairW.
    const f2 = _buildFlightSolid(n2, actualRiser, actualTread, stairW, n1 * actualRiser);
    f2.userData.parentId = stairId;
    const f2Wrapper = new THREE.Group();
    f2Wrapper.position.set(f1Run + stairW, 0, 0);
    f2Wrapper.rotation.z = Math.PI / 2;
    f2Wrapper.add(f2);
    group.add(f2Wrapper);

    footLocal = { minX: 0, minY: 0, maxX: f1Run + stairW, maxY: f2Run };
    chainDesc = `L(flights:${n1}+${n2},tread:${round(actualTread)},riser:${round(actualRiser)},w:${round(stairW)})`;

  } else {
    // Straight: single solid with stepped top + diagonal stringer underside.
    const run = nRisers * actualTread;
    const flight = _buildFlightSolid(nRisers, actualRiser, actualTread, stairW, 0);
    flight.userData.parentId = stairId;
    group.add(flight);
    footLocal = { minX: 0, minY: 0, maxX: run, maxY: stairW };
    chainDesc = `straight(n:${nRisers},tread:${round(actualTread)},riser:${round(actualRiser)},w:${round(stairW)})`;
  }

  // World-space footprint (for slab void cut). Approximated from local bbox + group position/rotation.
  // For now, use axis-aligned bbox of the local footprint rotated by angDeg.
  const rad = (angDeg * Math.PI) / 180;
  const corners = [
    [footLocal.minX, footLocal.minY],
    [footLocal.maxX, footLocal.minY],
    [footLocal.maxX, footLocal.maxY],
    [footLocal.minX, footLocal.maxY],
  ].map(([lx, ly]) => ({
    x: a.x + lx * Math.cos(rad) - ly * Math.sin(rad),
    y: a.y + lx * Math.sin(rad) + ly * Math.cos(rad),
  }));
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  const footprint: StairFootprint = {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };

  const chain = `IfcStair({shape:"${shape}",start:[${round(a.x)},${round(a.y)}],end:[${round(b.x)},${round(b.y)}],steps:${nRisers},riserHeight:${round(actualRiser)},treadDepth:${round(actualTread)},totalRise:${round(totalRise)},width:${round(stairW)}})`;
  return { group, chain, footprint };
}

// Polyline stair: multi-segment flight with landings at polyline vertices.
// Each segment is rendered using _buildFlightSolid (proper stepped profile with stringer).
export function buildStairOnPolyline(
  pts: Array<{ x: number; y: number }>,
  params?: StairParams,
): { group: THREE.Group; chain: string; footprint: StairFootprint } {
  const stairW   = params?.width       ?? DEFAULT_STAIR_WIDTH;
  const tread    = params?.treadDepth  ?? DEFAULT_STAIR_TREAD;
  const landingT = DEFAULT_SLAB_THICKNESS;
  const stairId  = THREE.MathUtils.generateUUID();

  // Total arc length for rise-first riser computation.
  let totalLen = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const dx = pts[s + 1].x - pts[s].x, dy = pts[s + 1].y - pts[s].y;
    totalLen += Math.sqrt(dx * dx + dy * dy);
  }
  const totalN = Math.max(2, Math.round(totalLen / tread));
  const targetH = params?.rise ?? params?.targetHeight ?? (totalN * (params?.riserHeight ?? DEFAULT_STAIR_RISE));
  const riser = targetH / totalN;

  const group = new THREE.Group();
  group.userData.kind = "compound";
  group.userData.creator = "stair";
  group.userData.stairId = stairId;

  let zCurrent = 0;
  let totalSteps = 0;

  for (let seg = 0; seg < pts.length - 1; seg++) {
    const pA = pts[seg], pB = pts[seg + 1];
    const dx = pB.x - pA.x, dy = pB.y - pA.y;
    const segLen = Math.sqrt(dx * dx + dy * dy) || tread;
    const angRad = Math.atan2(dy, dx);
    const n = Math.max(1, Math.round(segLen / tread));
    const actualT = segLen / n;

    // Build flight solid for this segment, rotate to match segment direction.
    const flight = _buildFlightSolid(n, riser, actualT, stairW, zCurrent);
    flight.userData.kind = "brep";
    flight.userData.creator = "stair";
    flight.userData.ifcClass = "IfcStairFlight";
    flight.userData.parentId = stairId;
    flight.userData.stepIndex = totalSteps;
    totalSteps += n;

    // Position at segment start, rotate so run direction matches segment.
    const flightWrapper = new THREE.Group();
    flightWrapper.position.set(pA.x, pA.y, 0);
    flightWrapper.rotation.z = angRad;
    flightWrapper.add(flight);
    group.add(flightWrapper);

    zCurrent += n * riser;

    if (seg < pts.length - 2) {
      const pC = pts[seg + 2];
      const dx2 = pC.x - pB.x, dy2 = pC.y - pB.y;
      const segLen2 = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1;
      const d1n = { x: dx / segLen, y: dy / segLen };
      const d2n = { x: dx2 / segLen2, y: dy2 / segLen2 };
      const landing = _makeLandingMesh(pB, d1n, d2n, stairW, landingT, zCurrent, stairId);
      group.add(landing);
      zCurrent += landingT; // next flight starts above the landing
    }
  }

  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const footprint: StairFootprint = {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };
  const chain = `IfcStairPolyline({pts:[${pts.map((p) => `[${round(p.x)},${round(p.y)}]`).join(",")}],steps:${totalSteps},riserHeight:${round(riser)},width:${round(stairW)}})`;
  return { group, chain, footprint };
}

// Curve stair: stair following arc-length parameterisation of a Catmull-Rom spline.
export function buildStairOnCurve(
  ctrlPts: Array<{ x: number; y: number }>,
  params?: StairParams,
): { group: THREE.Group; chain: string; footprint: StairFootprint } {
  const stairW   = params?.width       ?? DEFAULT_STAIR_WIDTH;
  const stairId  = THREE.MathUtils.generateUUID();

  const group = new THREE.Group();
  group.userData.kind = "compound";
  group.userData.creator = "stair";
  group.userData.stairId = stairId;

  // Tessellate the curve via Catmull-Rom spline so flights actually arc.
  const sampleCount = Math.max(ctrlPts.length * 32, 128);
  const sampled: Array<{ x: number; y: number }> = [];
  if (ctrlPts.length >= 2) {
    const crCurve = new THREE.CatmullRomCurve3(
      ctrlPts.map(p => new THREE.Vector3(p.x, p.y, 0)),
      false, "catmullrom", 0.5,
    );
    crCurve.getPoints(sampleCount).forEach(v => sampled.push({ x: v.x, y: v.y }));
  }

  // Arc lengths.
  const arcLens: number[] = [0];
  for (let i = 1; i < sampled.length; i++) {
    const dx = sampled[i].x - sampled[i - 1].x;
    const dy = sampled[i].y - sampled[i - 1].y;
    arcLens.push(arcLens[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalArcLen = arcLens[arcLens.length - 1] || 1;
  const tread = params?.treadDepth ?? DEFAULT_STAIR_TREAD;
  const nRisers = Math.max(2, Math.round(totalArcLen / tread));
  const actualT = totalArcLen / nRisers;
  // Rise-first riser: use level height if provided, else default.
  const targetH = params?.rise ?? params?.targetHeight ?? (nRisers * (params?.riserHeight ?? DEFAULT_STAIR_RISE));
  const riser = targetH / nRisers;

  // Sample curve at each step arc-length.
  function sampleAt(arcLen: number): { x: number; y: number; angRad: number } {
    let idx = arcLens.findIndex((l) => l >= arcLen);
    if (idx <= 0) idx = 1;
    const frac = (arcLen - arcLens[idx - 1]) / (arcLens[idx] - arcLens[idx - 1] + 1e-9);
    const px = sampled[idx - 1].x * (1 - frac) + sampled[idx].x * frac;
    const py = sampled[idx - 1].y * (1 - frac) + sampled[idx].y * frac;
    const nxt = Math.min(idx, sampled.length - 1);
    const prev = Math.max(idx - 1, 0);
    const angRad = Math.atan2(sampled[nxt].y - sampled[prev].y, sampled[nxt].x - sampled[prev].x);
    return { x: px, y: py, angRad };
  }

  // Landings at each intermediate control point arc position.
  const landingT = DEFAULT_SLAB_THICKNESS;
  const _ctrlArcLens: number[] = [];
  for (let k = 0; k < ctrlPts.length; k++) {
    const ctrlSampleIdx = Math.min(Math.round((k / (ctrlPts.length - 1)) * sampleCount), arcLens.length - 1);
    _ctrlArcLens.push(arcLens[ctrlSampleIdx]);
  }
  const _landingStepIndices = new Set<number>();

  const _placeLanding = (stepIdx: number, arcLen: number) => {
    const clamped = Math.min(stepIdx, nRisers - 1);
    if (_landingStepIndices.has(clamped)) return;
    _landingStepIndices.add(clamped);
    const pos = sampleAt(arcLen);
    const zLanding = clamped * riser;
    const prevPos = sampleAt(Math.max(0, arcLen - actualT * 0.5));
    const nextPos = sampleAt(Math.min(totalArcLen, arcLen + actualT * 0.5));
    const d1Len = Math.sqrt((pos.x - prevPos.x) ** 2 + (pos.y - prevPos.y) ** 2) || 1;
    const d2Len = Math.sqrt((nextPos.x - pos.x) ** 2 + (nextPos.y - pos.y) ** 2) || 1;
    const d1n = { x: (pos.x - prevPos.x) / d1Len, y: (pos.y - prevPos.y) / d1Len };
    const d2n = { x: (nextPos.x - pos.x) / d2Len, y: (nextPos.y - pos.y) / d2Len };
    group.add(_makeLandingMesh(pos, d1n, d2n, stairW, landingT, zLanding, stairId));
  };

  // Ctrl-point landings.
  for (let k = 1; k < ctrlPts.length - 1; k++) {
    const stepIdx = Math.round(_ctrlArcLens[k] / actualT);
    _placeLanding(stepIdx, _ctrlArcLens[k]);
  }

  // IBC 2018 §1011.5.2 — max vertical rise per flight = 144 in (3.66 m, rounded).
  // Insert intermediate landings wherever cumulative rise between existing landings exceeds limit.
  // Epsilon in ceil prevents spurious split at the exact boundary (e.g. 3.66m / 3.66 = 1.0 → ceil = 1 → 0 landings).
  const IBC_MAX_RISE = 3.66;
  const _boundaries = [0, ...[..._landingStepIndices].sort((a, b) => a - b), nRisers];
  for (let si = 0; si < _boundaries.length - 1; si++) {
    const segStart = _boundaries[si];
    const segEnd   = _boundaries[si + 1];
    const segRise  = (segEnd - segStart) * riser;
    if (segRise <= IBC_MAX_RISE) continue;
    const nInter = Math.ceil(segRise / IBC_MAX_RISE - 1e-9) - 1;
    if (nInter <= 0) continue;
    const stepsPerSub = (segEnd - segStart) / (nInter + 1);
    for (let li = 1; li <= nInter; li++) {
      const insertAt = Math.round(segStart + li * stepsPerSub);
      if (insertAt > segStart && insertAt < segEnd) {
        _placeLanding(insertAt, insertAt * actualT);
      }
    }
  }

  // Each step is a single-riser box at its correct height (not cumulative).
  // Skip steps whose index matches a landing position to avoid Z-overlap.
  for (let i = 0; i < nRisers; i++) {
    if (_landingStepIndices.has(i)) continue;
    const s = sampleAt((i + 0.5) * actualT);
    const stepBot = i * riser;
    const step = new THREE.Mesh(new THREE.BoxGeometry(actualT, stairW, riser), _stepMat());
    step.position.set(s.x, s.y, stepBot + riser / 2);
    step.rotation.z = s.angRad;
    step.userData.kind = "brep";
    step.userData.creator = "stair";
    step.userData.ifcClass = "IfcStairFlight";
    step.userData.parentId = stairId;
    step.userData.stepIndex = i;
    group.add(step);
  }

  const xs = ctrlPts.map((p) => p.x), ys = ctrlPts.map((p) => p.y);
  const footprint: StairFootprint = {
    minX: Math.min(...xs), minY: Math.min(...ys),
    maxX: Math.max(...xs), maxY: Math.max(...ys),
  };
  const chain = `IfcStairCurve({pts:[${ctrlPts.map((p) => `[${round(p.x)},${round(p.y)}]`).join(",")}],steps:${nRisers},riserHeight:${round(riser)},width:${round(stairW)}})`;
  return { group, chain, footprint };
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
  mesh.userData._snapCreationPos = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: h };
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: h, id: makeSnapId(a.x, a.y, h) },
    { x: b.x, y: b.y, z: h, id: makeSnapId(b.x, b.y, h) },
  ];
  const chain = `const beam = makeBox(${round(len)}, ${round(s)}, ${round(s)}).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round((a.x + b.x) / 2)}, ${round((a.y + b.y) / 2)}, ${round(h)}]);`;
  return { mesh, chain };
}

export type RoofParams = {
  type?: "pitched" | "hip" | "shed" | "flat";
  pitchDeg?: number;
  overhang?: number;
  thickness?: number;
  showStructure?: boolean; // default true — shows rafters, ridge beam, wall plates
};

// Section-drawing-quality roof (#847). Returns a Group of named sub-elements:
// ridge beam, rafters (IfcMember), wall plates, fascia, soffit, sheathing (IfcCovering).
export function buildRoof(
  a: { x: number; y: number },
  b: { x: number; y: number },
  params: RoofParams = {},
): { mesh: THREE.Group; chain: string } {
  const w  = Math.abs(b.x - a.x) || 6;
  const d  = Math.abs(b.y - a.y) || 8;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;

  const roofType = params.type ?? "pitched";
  // FZK-Haus reference: 30° pitch (IFCPLANEANGLEMEASURE(30.) Dach-1/Dach-2 #59605/#59805), 0.5m overhang per side.
  const pitchDeg = Math.max(5, Math.min(70, params.pitchDeg ?? 30));
  const overhang = params.overhang ?? 0.5;

  const pitchRad = (pitchDeg * Math.PI) / 180;
  // Eave half-extents include overhang.
  const hw = (w + 2 * overhang) / 2;
  const hd = (d + 2 * overhang) / 2;
  // Ridge height above wall plate level.
  const ridgeH = hd * Math.tan(pitchRad);

  const group = new THREE.Group();
  group.position.set(cx, cy, 0);
  group.userData.kind = "brep";
  group.userData.creator = "roof";
  group.userData.ifcClass = "IfcRoof";
  group.userData.roofParams = { type: roofType, pitchDeg, overhang };

  const frameMat  = new THREE.MeshStandardMaterial({ color: 0x7a5c4a, roughness: 0.80, metalness: 0.01 });
  const sheathMat = new THREE.MeshStandardMaterial({ color: 0x5a3a2a, roughness: 0.85, metalness: 0.00 });
  const soffitMat = new THREE.MeshStandardMaterial({ color: 0xede8e0, roughness: 0.60, metalness: 0.00 });

  const member = (sx: number, sy: number, sz: number, mat: THREE.Material): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.userData.ifcClass = "IfcMember";
    return m;
  };

  if (roofType === "flat" || ridgeH < 0.05) {
    // Flat: perimeter beams + regular joists + deck slab.
    const joistH = 0.20, joistW = 0.05;
    const deckT  = 0.12;
    const nJoists = Math.max(2, Math.round((w + 2 * overhang) / 0.6));
    const joistSpan = (w + 2 * overhang) / nJoists;

    const perimFront = member(w + 2 * overhang, joistW, joistH, frameMat.clone());
    perimFront.position.set(0, -hd + joistW / 2, joistH / 2);
    group.add(perimFront);

    const perimBack = member(w + 2 * overhang, joistW, joistH, frameMat.clone());
    perimBack.position.set(0,  hd - joistW / 2, joistH / 2);
    group.add(perimBack);

    for (let i = 0; i < nJoists; i++) {
      const xPos = -hw + (i + 0.5) * joistSpan;
      const joist = member(joistW, d + 2 * overhang, joistH, frameMat.clone());
      joist.position.set(xPos, 0, joistH / 2);
      group.add(joist);
    }

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(w + 2 * overhang, d + 2 * overhang, deckT),
      sheathMat.clone(),
    );
    deck.userData.ifcClass = "IfcCovering";
    deck.position.set(0, 0, joistH + deckT / 2);
    group.add(deck);

  } else if (roofType === "shed") {
    // Shed: mono-pitch, low at front (−y), high at back (+y).
    const shedH  = (d + 2 * overhang) * Math.tan(pitchRad);
    const rLen   = Math.sqrt((d + 2 * overhang) ** 2 + shedH ** 2);
    const rafterW = 0.05, rafterD = 0.15;
    const nRafters = Math.max(3, Math.round((w + 2 * overhang) / 0.5) + 1);
    const rafterRx = Math.atan2(shedH, d + 2 * overhang) - Math.PI / 2;

    // High-end wall plate (back)
    const plateback = member(w + 2 * overhang, 0.1, 0.1, frameMat.clone());
    plateback.position.set(0, hd, 0.05);
    group.add(plateback);

    // Low-end wall plate (front)
    const plateFront = member(w + 2 * overhang, 0.1, 0.1, frameMat.clone());
    plateFront.position.set(0, -hd, 0.05);
    group.add(plateFront);

    // Fascia at low eave
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * overhang, 0.03, 0.15), soffitMat.clone());
    fascia.userData.ifcClass = "IfcCovering";
    fascia.position.set(0, -hd, -0.075);
    group.add(fascia);

    // Soffit under low eave overhang
    const soffit = new THREE.Mesh(
      new THREE.BoxGeometry(w + 2 * overhang, overhang, 0.02),
      soffitMat.clone(),
    );
    soffit.userData.ifcClass = "IfcCovering";
    soffit.position.set(0, -hd + overhang / 2, -0.01);
    group.add(soffit);

    // Rafters — offset to interior face of sheathing (25mm deck sits on top of 150mm rafter).
    const shedRafterInset = 0.025 / 2 + rafterD / 2; // 0.0875m along slope interior normal
    for (let i = 0; i < nRafters; i++) {
      const xPos = -hw + i * ((w + 2 * overhang) / (nRafters - 1));
      const rafter = member(rafterW, rafterD, rLen, frameMat.clone());
      rafter.rotation.x = rafterRx;
      rafter.position.set(xPos, shedRafterInset * Math.sin(pitchRad), shedH / 2 - shedRafterInset * Math.cos(pitchRad));
      group.add(rafter);
    }

    // Sheathing
    const sheath = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * overhang, rLen, 0.025), sheathMat.clone());
    sheath.userData.ifcClass = "IfcCovering";
    sheath.rotation.x = rafterRx;
    sheath.position.set(0, 0, shedH / 2);
    group.add(sheath);

  } else if (roofType === "hip") {
    // Hip: 4 sloped faces. Ridge shorter than footprint. Hip rafters at corners.
    const isLandscape = w >= d;
    const shortHalf  = isLandscape ? hd : hw;
    const longHalf   = isLandscape ? hw : hd;
    const hipRidgeH  = shortHalf * Math.tan(pitchRad);
    const ridgeHL    = Math.max(0.3, longHalf - shortHalf);

    // Ridge beam along long axis
    const ridgeBeam = isLandscape
      ? member(ridgeHL * 2, 0.10, 0.12, frameMat.clone())
      : member(0.10, ridgeHL * 2, 0.12, frameMat.clone());
    ridgeBeam.position.set(0, 0, hipRidgeH + 0.06);
    ridgeBeam.visible = params.showStructure !== false;
    group.add(ridgeBeam);

    // Perimeter fascia (4 sides) — hidden; part of wall envelope, not roof silhouette
    const fW = 0.03, fH = 0.15;
    const fasciaFront = new THREE.Mesh(new THREE.BoxGeometry(hw * 2, fW, fH), soffitMat.clone());
    fasciaFront.userData.ifcClass = "IfcCovering";
    fasciaFront.position.set(0, -hd, -fH / 2);
    fasciaFront.visible = false;
    group.add(fasciaFront);
    const fasciaBack = fasciaFront.clone();
    fasciaBack.position.set(0, hd, -fH / 2);
    group.add(fasciaBack);
    const fasciaLeft = new THREE.Mesh(new THREE.BoxGeometry(fW, hd * 2, fH), soffitMat.clone());
    fasciaLeft.userData.ifcClass = "IfcCovering";
    fasciaLeft.position.set(-hw, 0, -fH / 2);
    fasciaLeft.visible = false;
    group.add(fasciaLeft);
    const fasciaRight = fasciaLeft.clone();
    fasciaRight.position.set(hw, 0, -fH / 2);
    group.add(fasciaRight);

    // 4 hip rafters (corner diagonals)
    const hipLen = Math.sqrt(shortHalf ** 2 + shortHalf ** 2 + hipRidgeH ** 2);
    const hipRx = Math.atan2(hipRidgeH, Math.sqrt(shortHalf ** 2 + shortHalf ** 2)) - Math.PI / 2;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
    for (const [sx, sy] of corners) {
      const hr = member(0.06, 0.12, hipLen, frameMat.clone());
      hr.rotation.z = Math.atan2(sy * shortHalf, sx * shortHalf);
      hr.rotation.x = hipRx;
      hr.position.set(sx * longHalf / 2, sy * shortHalf / 2, hipRidgeH / 2);
      group.add(hr);
    }

    // Sheathing planes for front/back slopes.
    // frontRx = pitch of the front face; local Y aligns with slope → rotation.x = frontRx.
    const frontSlopeLen = Math.sqrt(hd ** 2 + hipRidgeH ** 2);
    const frontRx = Math.atan2(hipRidgeH, hd);  // was wrongly Math.PI/2 + atan2
    const sheathFront = new THREE.Mesh(
      new THREE.BoxGeometry(hw * 2, frontSlopeLen, 0.025), sheathMat.clone());
    sheathFront.userData.ifcClass = "IfcCovering";
    sheathFront.rotation.x = frontRx;
    sheathFront.position.set(0, -hd / 2, hipRidgeH / 2);
    group.add(sheathFront);
    const sheathBack = sheathFront.clone();
    (sheathBack.material as THREE.Material) = (sheathFront.material as THREE.Material).clone();
    sheathBack.rotation.x = -frontRx;
    sheathBack.position.set(0, hd / 2, hipRidgeH / 2);
    group.add(sheathBack);

    // Sheathing for side slopes (left/right): slope in X-Z plane → pure rotation.y.
    // Local X aligns with slope direction (hw, 0, hipRidgeH)/sideSlopeLen.
    // rotation.y = -sidePitch for left (eave at x=-hw→ridge at x=0).
    const sideSlopeLen = Math.sqrt(hw ** 2 + hipRidgeH ** 2);
    const sidePitch = Math.atan2(hipRidgeH, hw);
    const sheathLeft = new THREE.Mesh(
      new THREE.BoxGeometry(sideSlopeLen, hd * 2, 0.025), sheathMat.clone());
    sheathLeft.userData.ifcClass = "IfcCovering";
    sheathLeft.rotation.y = -sidePitch;
    sheathLeft.position.set(-hw / 2, 0, hipRidgeH / 2);
    group.add(sheathLeft);
    const sheathRight = new THREE.Mesh(
      new THREE.BoxGeometry(sideSlopeLen, hd * 2, 0.025), sheathMat.clone());
    sheathRight.userData.ifcClass = "IfcCovering";
    sheathRight.rotation.y = Math.PI + sidePitch;  // mirror: eave at x=+hw→ridge at x=0
    sheathRight.position.set(hw / 2, 0, hipRidgeH / 2);
    group.add(sheathRight);

  } else {
    // Pitched (gabled) — full section-drawing-quality structure (#847).
    // Ridge runs along the longer plan axis.
    const landscape = w >= d;
    // For the slope span dimension: hd (landscape) or hw (portrait).
    const spanHalf = landscape ? hd : hw;
    // For the ridge length dimension: hw (landscape) or hd (portrait).
    const ridgeLenHalf = landscape ? hw : hd;
    // ridgeH scoped to the actual span (portrait uses hw, not hd).
    const rH = spanHalf * Math.tan(pitchRad);
    const rafterLen = Math.sqrt(spanHalf ** 2 + rH ** 2);
    // FZK-Haus reference: 0.08m rafter width, ~0.65m on-centre spacing (#1161).
    const rafterW = 0.08, rafterD = 0.15;
    const rafterSpacing = 0.65;
    const nRafters = Math.max(4, Math.round(ridgeLenHalf * 2 / rafterSpacing) + 1);

    // Rafter rotation: BoxGeometry local Z aligns with slope direction.
    // For landscape front: local Z → (0, -cos(pitch), -sin(pitch)) via rotation.x = π/2+pitch.
    // This correctly spans from ridge (0, 0, rH) to eave (0, −spanHalf, 0).
    const slopeRx = Math.PI / 2 + pitchRad;  // rafter only — do NOT use for sheathing

    // Ridge beam — sits on the INSIDE of the sheathing at the apex.
    // Position at rH − 0.06 (half beam height) so the beam top aligns with
    // the inner sheathing face; putting it at rH + 0.06 placed it above
    // the panels (#1136 / #1161).
    // FZK First (ridge): 80mm × 160mm cross-section (IFC #40532 BoundingBox).
    const ridgeBeam = landscape
      ? member(ridgeLenHalf * 2, 0.08, 0.16, frameMat.clone())
      : member(0.08, ridgeLenHalf * 2, 0.16, frameMat.clone());
    ridgeBeam.position.set(0, 0, rH - 0.08);
    ridgeBeam.userData.ifcClass = "IfcBeam";
    ridgeBeam.userData.name = "First";
    ridgeBeam.visible = params.showStructure !== false;
    group.add(ridgeBeam);

    // Pfette (eave purlins) — FZK Pfette-1-1 and Pfette-2-1: 80mm × 160mm cross-section.
    // Positioned at eave edge (bottom of slope deck) for visibility. FZK mid-slope
    // enclosure relationship deferred to #1639 slope-deck slab work.
    const wallPlateLen = ridgeLenHalf * 2;
    const pfetteZ = 0.08; // member center 80mm above eave
    const wp1 = landscape
      ? member(wallPlateLen, 0.08, 0.16, frameMat.clone())
      : member(0.08, wallPlateLen, 0.16, frameMat.clone());
    wp1.position.set(
      landscape ? 0 : -spanHalf,
      landscape ? -spanHalf : 0,
      pfetteZ,
    );
    wp1.userData.ifcClass = "IfcBeam";
    wp1.userData.name = "Pfette";
    wp1.visible = params.showStructure !== false;
    group.add(wp1);
    const wp2 = wp1.clone();
    (wp2.material as THREE.Material) = (wp1.material as THREE.Material).clone();
    wp2.position.set(
      landscape ? 0 : spanHalf,
      landscape ? spanHalf : 0,
      pfetteZ,
    );
    wp2.userData.ifcClass = "IfcBeam";
    wp2.userData.name = "Pfette";
    wp2.visible = params.showStructure !== false;
    group.add(wp2);

    // Fascia boards at eaves (outside face of rafter ends)
    const fW = 0.03, fH = 0.15;
    const fasciaA = landscape
      ? new THREE.Mesh(new THREE.BoxGeometry(ridgeLenHalf * 2, fW, fH), soffitMat.clone())
      : new THREE.Mesh(new THREE.BoxGeometry(fW, ridgeLenHalf * 2, fH), soffitMat.clone());
    fasciaA.userData.ifcClass = "IfcCovering";
    fasciaA.userData.name = "Fascia";
    fasciaA.position.set(landscape ? 0 : -spanHalf, landscape ? -spanHalf : 0, -fH / 2);
    group.add(fasciaA);
    const fasciaB = fasciaA.clone();
    (fasciaB.material as THREE.Material) = (fasciaA.material as THREE.Material).clone();
    fasciaB.userData.name = "Fascia";
    fasciaB.position.set(landscape ? 0 : spanHalf, landscape ? spanHalf : 0, -fH / 2);
    group.add(fasciaB);

    // Soffit under eave overhang (2 sides)
    const soffitDepth = overhang;
    const soffitA = landscape
      ? new THREE.Mesh(new THREE.BoxGeometry(ridgeLenHalf * 2, soffitDepth, 0.02), soffitMat.clone())
      : new THREE.Mesh(new THREE.BoxGeometry(soffitDepth, ridgeLenHalf * 2, 0.02), soffitMat.clone());
    soffitA.userData.ifcClass = "IfcCovering";
    soffitA.userData.name = "Soffit";
    soffitA.position.set(
      landscape ? 0 : -(spanHalf - overhang / 2),
      landscape ? -(spanHalf - overhang / 2) : 0,
      -0.01,
    );
    group.add(soffitA);
    const soffitB = soffitA.clone();
    (soffitB.material as THREE.Material) = (soffitA.material as THREE.Material).clone();
    soffitB.position.set(
      landscape ? 0 : (spanHalf - overhang / 2),
      landscape ? (spanHalf - overhang / 2) : 0,
      -0.01,
    );
    group.add(soffitB);

    // Rafters — two slopes
    // Interior-side offset: slope deck (IfcSlab "Dach", 200mm) sits on top of rafter (150mm deep).
    // Rafter center must be inward from slab center by sheathThick/2 + rafterD/2
    // along the slope's interior normal: (sin(pitch), -cos(pitch)) in (span, Z) axes.
    const sheathThick = 0.20; // 200mm — matches FZK Dach-1/Dach-2 IFC slab thickness (#1639-E)
    const rafterInset = sheathThick / 2 + rafterD / 2; // 0.175m
    for (let i = 0; i < nRafters; i++) {
      const axialPos = -ridgeLenHalf + i * (ridgeLenHalf * 2 / (nRafters - 1));

      // Front slope rafter.
      const rfA = member(rafterW, rafterD, rafterLen, frameMat.clone());
      rfA.visible = params.showStructure !== false;
      if (landscape) {
        rfA.rotation.x = slopeRx;
        rfA.position.set(axialPos, -spanHalf / 2 + rafterInset * Math.sin(pitchRad), rH / 2 - rafterInset * Math.cos(pitchRad));
      } else {
        rfA.rotation.y = -slopeRx;
        rfA.position.set(-spanHalf / 2 + rafterInset * Math.sin(pitchRad), axialPos, rH / 2 - rafterInset * Math.cos(pitchRad));
      }
      group.add(rfA);

      // Back slope rafter (mirror).
      const rfB = member(rafterW, rafterD, rafterLen, frameMat.clone());
      rfB.visible = params.showStructure !== false;
      if (landscape) {
        rfB.rotation.x = -slopeRx;
        rfB.position.set(axialPos, spanHalf / 2 - rafterInset * Math.sin(pitchRad), rH / 2 - rafterInset * Math.cos(pitchRad));
      } else {
        rfB.rotation.y = slopeRx;
        rfB.position.set(spanHalf / 2 - rafterInset * Math.sin(pitchRad), axialPos, rH / 2 - rafterInset * Math.cos(pitchRad));
      }
      group.add(rfB);
    }

    // Slope deck panels (IfcSlab "Dach") — FZK reference: 2× IFCSLAB enclosing Pfette + Sparren (#1639).
    // local Y aligns with slope direction → rotation = pitchRad (not slopeRx).
    // slopeRx (π/2+pitch) is correct for rafters (local Z = length) but wrong for
    // the slab (local Y = slope length). With rotation.x = pitchRad, local Y →
    // (0, cos(pitch), sin(pitch)) = slope direction; eave/ridge endpoints verified.
    const sheathA = landscape
      ? new THREE.Mesh(new THREE.BoxGeometry(ridgeLenHalf * 2, rafterLen, sheathThick), sheathMat.clone())
      : new THREE.Mesh(new THREE.BoxGeometry(rafterLen, ridgeLenHalf * 2, sheathThick), sheathMat.clone());
    sheathA.userData.ifcClass = "IfcSlab";
    sheathA.userData.name = "Dach";
    if (landscape) {
      sheathA.rotation.x = pitchRad;
      sheathA.position.set(0, -spanHalf / 2, rH / 2);
    } else {
      sheathA.rotation.y = -pitchRad;
      sheathA.position.set(-spanHalf / 2, 0, rH / 2);
    }
    group.add(sheathA);

    const sheathB = sheathA.clone();
    (sheathB.material as THREE.Material) = (sheathA.material as THREE.Material).clone();
    sheathB.userData.name = "Dach";
    if (landscape) {
      sheathB.rotation.x = -pitchRad;
      sheathB.position.set(0, spanHalf / 2, rH / 2);
    } else {
      sheathB.rotation.y = pitchRad;
      sheathB.position.set(spanHalf / 2, 0, rH / 2);
    }
    group.add(sheathB);

    // Gable end triangular cap panels (#1651): explicit triangles at each short end
    // so the gable face is visually distinct from the slope sheathing regardless of
    // whether adjacent wall meshes are present or successfully modified.
    // Wall material (0x9ec5d8) vs sheathing material (0x5a3a2a) gives clear contrast.
    // 0.01 m outward offset prevents z-fighting with the wall pentagon (see SdRoof handler).
    const gableCapMat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    for (const sign of [-1, 1] as const) {
      const offset = sign * 0.01;
      const verts = landscape
        ? new Float32Array([
            sign * ridgeLenHalf + offset, -spanHalf, 0,
            sign * ridgeLenHalf + offset,  spanHalf, 0,
            sign * ridgeLenHalf + offset,  0,        rH,
          ])
        : new Float32Array([
            -spanHalf, sign * ridgeLenHalf + offset, 0,
             spanHalf, sign * ridgeLenHalf + offset, 0,
             0,        sign * ridgeLenHalf + offset, rH,
          ]);
      const capGeom = new THREE.BufferGeometry();
      capGeom.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      capGeom.setIndex([0, 1, 2]);
      capGeom.computeVertexNormals();
      const capMesh = new THREE.Mesh(capGeom, gableCapMat.clone());
      capMesh.userData.name = "GableCap";
      group.add(capMesh);
    }

  }

  const chain = `const roof = buildSectionRoof(${round(w)}, ${round(d)}, { type:"${roofType}", pitchDeg:${round(pitchDeg)}, overhang:${round(overhang)} }).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh: group, chain };
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

export function buildSectionBox(a: { x: number; y: number }, b: { x: number; y: number }, sceneBounds?: THREE.Box3 | null): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const margin = sceneBounds ? Math.max((sceneBounds.max.z - sceneBounds.min.z) * 0.05, 0.3) : 0.3;
  const minZ = sceneBounds ? sceneBounds.min.z - margin : -0.1;
  const maxZ = sceneBounds ? sceneBounds.max.z + margin : 6.0;
  const w = maxX - minX || 0.1, d = maxY - minY || 0.1, h = maxZ - minZ;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  // Unit cube geometry + scale lets pushSectionFace update the visual without
  // rebuilding EdgesGeometry on every pointer-move drag event.
  const unitGeom = new THREE.BoxGeometry(1, 1, 1);
  const edges = new THREE.EdgesGeometry(unitGeom);
  unitGeom.dispose();
  const mat = new THREE.LineBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.85, depthTest: false });
  const mesh = new THREE.LineSegments(edges, mat);
  mesh.renderOrder = 999;
  mesh.position.set(cx, cy, cz);
  mesh.scale.set(w, d, h);
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

export function buildClipPlanePlan(
  p: { x: number; y: number; z?: number },
): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const label = `clip-${Date.now()}`;
  // Standard plan-cut height 1.2m above the clicked floor level (#1729-A).
  const PLAN_CUT_HEIGHT = 1.2;
  const planZ = (p.z ?? 0) + PLAN_CUT_HEIGHT;
  const size = 5;
  const geom = new THREE.PlaneGeometry(size, size);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, planZ);
  // Rotate 180° around X so mesh world-normal = -Z, matching clip normal [0,0,-1].
  // Required for updateClippingPlane() to read the correct direction during gumball drags.
  mesh.rotation.x = Math.PI;
  const origin: [number, number, number] = [round(p.x), round(p.y), round(planZ)];
  const normal: [number, number, number] = [0, 0, -1]; // clip z > planZ — floor-plan below cut remains visible
  mesh.userData.kind = "clip-plane";
  mesh.userData.creator = "SdClippingPlane";
  mesh.userData.excludeFromClip = true;
  mesh.userData.clipLabel = label;
  mesh.userData.clipLocalNormal = new THREE.Vector3(0, 0, 1); // local +Z after π-X rotation = world -Z
  return {
    mesh,
    chain: `SdClippingPlane({origin:[${origin}],normal:[${normal}],label:"${label}"})`,
    dispatchOnCommit: { verb: "SdClippingPlane", args: { origin, normal, label } },
  };
}

export function buildClipPlaneSection(
  a: { x: number; y: number; z?: number },
  b: { x: number; y: number; z?: number },
): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const label = `clip-${Date.now()}`;
  const dx = b.x - a.x, dy = b.y - a.y;
  const lineLen = Math.sqrt(dx * dx + dy * dy) || 1;
  // Normal points toward the conventional "near" side of the section (#1729-A):
  // for a left-to-right line, (dy/len, -dx/len) = (0,-1) = south — the reader-facing side.
  // Mesh rotation Euler(π/2,0,atan2(dy,dx)) maps local +Z to world (sinα,-cosα,0) which
  // equals (dy/len,-dx/len,0), matching this normal so updateClippingPlane stays consistent.
  const nx = dy / lineLen, ny = -dx / lineLen;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const planeH = 5;
  const geom = new THREE.PlaneGeometry(lineLen, planeH);
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, planeH / 2);
  mesh.rotation.set(Math.PI / 2, 0, Math.atan2(dy, dx));
  const origin: [number, number, number] = [round(cx), round(cy), 0];
  const normal: [number, number, number] = [round(nx), round(ny), 0];
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
