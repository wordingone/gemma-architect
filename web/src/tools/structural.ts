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

/** Re-build a wall mesh in-place with new thickness/height/bottom-elevation.
 *  Reads existing controlPoints (local space) to determine wall axis.
 *  Safe to call from inspect-panel onChange or height-handle drag-end. */
export function rebuildWallParams(
  mesh: THREE.Mesh,
  params: { thickness?: number; height?: number; bottomElevation?: number },
): void {
  const t = params.thickness ?? (mesh.userData.wallThickness as number | undefined) ?? DEFAULT_WALL_THICKNESS;
  const h = params.height ?? (mesh.userData.wallHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;

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

  mesh.userData.wallThickness = t;
  mesh.userData.wallHeight = h;
  mesh.userData.endpoints = [
    { x: wA.x, y: wA.y, z: zOff, id: makeSnapId(wA.x, wA.y, zOff) },
    { x: wB.x, y: wB.y, z: zOff, id: makeSnapId(wB.x, wB.y, zOff) },
    { x: cx, y: cy, z: zOff, id: makeSnapId(cx, cy, zOff) },
  ];
}

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
  const pitchDeg = Math.max(5, Math.min(70, params.pitchDeg ?? 30));
  const overhang = params.overhang ?? 0.6;

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

    // Rafters
    for (let i = 0; i < nRafters; i++) {
      const xPos = -hw + i * ((w + 2 * overhang) / (nRafters - 1));
      const rafter = member(rafterW, rafterD, rLen, frameMat.clone());
      rafter.rotation.x = rafterRx;
      rafter.position.set(xPos, 0, shedH / 2);
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
    ridgeBeam.visible = false;
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
    const rafterW = 0.05, rafterD = 0.15;
    const rafterSpacing = 0.5;
    const nRafters = Math.max(4, Math.round(ridgeLenHalf * 2 / rafterSpacing) + 1);

    // Rafter rotation: BoxGeometry local Z aligns with slope direction.
    // For landscape front: local Z → (0, -cos(pitch), -sin(pitch)) via rotation.x = π/2+pitch.
    // This correctly spans from ridge (0, 0, rH) to eave (0, −spanHalf, 0).
    const slopeRx = Math.PI / 2 + pitchRad;  // rafter only — do NOT use for sheathing

    // Ridge beam
    const ridgeBeam = landscape
      ? member(ridgeLenHalf * 2, 0.10, 0.12, frameMat.clone())
      : member(0.10, ridgeLenHalf * 2, 0.12, frameMat.clone());
    ridgeBeam.position.set(0, 0, rH + 0.06);
    ridgeBeam.visible = false;
    group.add(ridgeBeam);

    // Wall plates (at wall-top line, just inside the eaves)
    const wallPlateLen = ridgeLenHalf * 2;
    const wp1 = landscape
      ? member(wallPlateLen, 0.10, 0.10, frameMat.clone())
      : member(0.10, wallPlateLen, 0.10, frameMat.clone());
    wp1.position.set(landscape ? 0 : -spanHalf, landscape ? -spanHalf : 0, 0.05);
    wp1.visible = false;
    group.add(wp1);
    const wp2 = wp1.clone();
    (wp2.material as THREE.Material) = (wp1.material as THREE.Material).clone();
    wp2.position.set(landscape ? 0 : spanHalf, landscape ? spanHalf : 0, 0.05);
    wp2.visible = false;
    group.add(wp2);

    // Fascia boards at eaves (outside face of rafter ends)
    const fW = 0.03, fH = 0.15;
    const fasciaA = landscape
      ? new THREE.Mesh(new THREE.BoxGeometry(ridgeLenHalf * 2, fW, fH), soffitMat.clone())
      : new THREE.Mesh(new THREE.BoxGeometry(fW, ridgeLenHalf * 2, fH), soffitMat.clone());
    fasciaA.userData.ifcClass = "IfcCovering";
    fasciaA.position.set(landscape ? 0 : -spanHalf, landscape ? -spanHalf : 0, -fH / 2);
    fasciaA.visible = false;
    group.add(fasciaA);
    const fasciaB = fasciaA.clone();
    (fasciaB.material as THREE.Material) = (fasciaA.material as THREE.Material).clone();
    fasciaB.position.set(landscape ? 0 : spanHalf, landscape ? spanHalf : 0, -fH / 2);
    fasciaB.visible = false;
    group.add(fasciaB);

    // Soffit under eave overhang (2 sides)
    const soffitDepth = overhang;
    const soffitA = landscape
      ? new THREE.Mesh(new THREE.BoxGeometry(ridgeLenHalf * 2, soffitDepth, 0.02), soffitMat.clone())
      : new THREE.Mesh(new THREE.BoxGeometry(soffitDepth, ridgeLenHalf * 2, 0.02), soffitMat.clone());
    soffitA.userData.ifcClass = "IfcCovering";
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
    for (let i = 0; i < nRafters; i++) {
      const axialPos = -ridgeLenHalf + i * (ridgeLenHalf * 2 / (nRafters - 1));

      // Front slope rafter — hidden by default; visible under section/cutaway only.
      const rfA = member(rafterW, rafterD, rafterLen, frameMat.clone());
      rfA.visible = false;
      if (landscape) {
        rfA.rotation.x = slopeRx;
        rfA.position.set(axialPos, -spanHalf / 2, rH / 2);
      } else {
        rfA.rotation.y = -slopeRx;
        rfA.position.set(-spanHalf / 2, axialPos, rH / 2);
      }
      group.add(rfA);

      // Back slope rafter (mirror) — also hidden.
      const rfB = member(rafterW, rafterD, rafterLen, frameMat.clone());
      rfB.visible = false;
      if (landscape) {
        rfB.rotation.x = -slopeRx;
        rfB.position.set(axialPos, spanHalf / 2, rH / 2);
      } else {
        rfB.rotation.y = slopeRx;
        rfB.position.set(spanHalf / 2, axialPos, rH / 2);
      }
      group.add(rfB);
    }

    // Sheathing: local Y aligns with slope direction → rotation = pitchRad (not slopeRx).
    // slopeRx (π/2+pitch) is correct for rafters (local Z = length) but wrong for
    // sheathing (local Y = slope length). With rotation.x = pitchRad, local Y →
    // (0, cos(pitch), sin(pitch)) = slope direction; eave/ridge endpoints verified.
    const sheathA = landscape
      ? new THREE.Mesh(new THREE.BoxGeometry(ridgeLenHalf * 2, rafterLen, 0.025), sheathMat.clone())
      : new THREE.Mesh(new THREE.BoxGeometry(rafterLen, ridgeLenHalf * 2, 0.025), sheathMat.clone());
    sheathA.userData.ifcClass = "IfcCovering";
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
    if (landscape) {
      sheathB.rotation.x = -pitchRad;
      sheathB.position.set(0, spanHalf / 2, rH / 2);
    } else {
      sheathB.rotation.y = pitchRad;
      sheathB.position.set(spanHalf / 2, 0, rH / 2);
    }
    group.add(sheathB);

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
