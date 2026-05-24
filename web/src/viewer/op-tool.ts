// Op-tool state machine — extrude, boolean, fillet, annotations, selection modes.
// Extracted from create-mode.ts (#723).
// Does NOT import from selection-ops.ts — runPolySel/overlay fns injected via registerOpToolHooks.

import * as THREE from "three";
import { csgUnion, csgDifference, csgIntersection, filletMesh, chamferEdge, getUniqueEdges } from "./csg";
import type { Viewer } from "./viewer";
import { getSnap, makeSnapId } from "./snap-state";
import { nearestSnapVertex, closestPtOnSegToRay } from "./snap-state";
import { projectToScreen, unprojectToXY, snapWorldForView } from "./projection";
import {
  ptGetTarget, ptPrompt, ptClearPrompt,
  ptShowCoordInput, ptHideCoordInput,
} from "./transforms";
import { getChooserEl, opSetHover, setChooserHint } from "./picker-hint";
import { pushAction, pushReplaceAction } from "../history";
import { dispatchSync } from "../commands/dispatch";
import { formatLength, formatArea, formatVolume } from "../units";
import { createCatmullRomAsNurbs, tessellate } from "../nurbs/nurbs-curves.js";

// Creators that are valid extrude profiles (click-select in extrude_select phase).
export const EXTRUDABLE_CREATORS = new Set([
  "rect", "circle", "polygon", "arc", "polyline", "curve", "line",
  "wall", "slab", "column", "box", "beam", "roof", "space",
  "extrude", "boolean-union", "boolean-difference", "boolean-split",
]);

// 2D sketch creators for auto-selection at tool-activation time.
// Narrower than EXTRUDABLE_CREATORS — avoids auto-selecting large 3D solids
// (slabs, roofs, walls) as profiles when the user activates extrude.
const SKETCH_PROFILE_CREATORS = new Set([
  "rect", "circle", "polygon", "arc", "polyline", "curve", "line",
]);

// Closed 2D sketch creators that can be auto-extruded before boolean.
const CLOSED_SKETCH_CREATORS = new Set(["circle", "rect", "polygon"]);

// Creators valid for click-selection as extrude profile.
// Excludes raw 3D primitives (wall, slab, column, box, beam, roof, space)
// to prevent accidentally extruding large structural elements as a profile.
// Includes previous extrude/boolean/CSG results so re-extrusion and surface
// selection work (e.g. extruding a boolean result or a CSG brep surface).
const CLICK_PROFILE_CREATORS = new Set([
  "rect", "circle", "polygon", "arc", "polyline", "curve", "line",
  "extrude", "boolean-union", "boolean-difference", "boolean-split", "brep",
]);

// ── Late-binding hooks ────────────────────────────────────────────────────────
// tools/index.ts registers these during initCreateMode to avoid circular imports.

type OpToolHooks = {
  clearSketchShiftLine: (viewer: Viewer) => void;
  updateSketchShiftLine: (viewer: Viewer, base: THREE.Vector3, axis: "x" | "y" | "z") => void;
  appendToCreateSequence: (chain: string) => void;
  hideCursorDot: () => void;
  runPolySel: (viewer: Viewer, poly: Array<{ x: number; y: number }>, subMode: "crossing" | "window") => void;
  getSelOverlay: (viewer: Viewer) => SVGSVGElement;
  clearSelOverlay: () => void;
  removeSelOverlay: () => void;
};

let _hooks: OpToolHooks = {
  clearSketchShiftLine: () => {},
  updateSketchShiftLine: () => {},
  appendToCreateSequence: () => {},
  hideCursorDot: () => {},
  runPolySel: () => {},
  getSelOverlay: (v) => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    v.getCanvas().parentElement?.appendChild(svg);
    return svg;
  },
  clearSelOverlay: () => {},
  removeSelOverlay: () => {},
};

export function registerOpToolHooks(hooks: OpToolHooks): void {
  _hooks = hooks;
}

// ── State ─────────────────────────────────────────────────────────────────────

export type OpPhase =
  | { kind: "extrude_select" }
  | { kind: "extrude_height"; profile: THREE.Object3D; cx: number; cy: number; w: number; d: number }
  | { kind: "bool_a" }
  | { kind: "bool_b"; objA: THREE.Object3D }
  | { kind: "bool_op"; objA: THREE.Object3D; objB: THREE.Object3D }
  | { kind: "fillet_select" }
  | { kind: "fillet_edge";        target: THREE.Mesh | THREE.Line }
  | { kind: "fillet_edge_radius"; target: THREE.Mesh | THREE.Line; edgeA: THREE.Vector3; edgeB: THREE.Vector3; cornerV?: THREE.Vector3 }
  | { kind: "fillet_radius"; target: THREE.Object3D }
  | { kind: "sel_window_sub" }
  | { kind: "sel_window"; subMode: "crossing" | "window"; startX: number; startY: number }
  | { kind: "sel_lasso_sub" }
  | { kind: "sel_lasso"; subMode: "crossing" | "window"; points: Array<{ x: number; y: number }> }
  | { kind: "sel_boundary_sub" }
  | { kind: "sel_boundary_pick" }
  | { kind: "sel_boundary_draw"; points: Array<{ x: number; y: number }> }
  | { kind: "dim_a";       tool: "aligned-dim" | "angular-dim" | "area-dim" | "volume-dim" }
  | { kind: "dim_b";       tool: "aligned-dim"; ptA: THREE.Vector3 }
  | { kind: "dim_c";       tool: "angular-dim"; ptA: THREE.Vector3; ptB: THREE.Vector3 }
  | { kind: "dim_area";    tool: "area-dim";    pts: THREE.Vector3[] }
  | { kind: "dim_volume";  tool: "volume-dim" }
  | { kind: "label_pick" }
  | { kind: "label_text"; pt: THREE.Vector3 }
  | { kind: "tmeasure_a" }
  | { kind: "tmeasure_b"; ptA: THREE.Vector3 }
  | { kind: "copy_select" }
  | { kind: "copy_place"; source: THREE.Object3D; srcPt: THREE.Vector3 }
  | { kind: "array_select" }
  | { kind: "array_linear_params"; source: THREE.Object3D }
  | { kind: "array_linear_base";   source: THREE.Object3D }
  | { kind: "array_linear_dir";    source: THREE.Object3D; basePt: THREE.Vector3 }
  | { kind: "array_linear_count";  source: THREE.Object3D; dx: number; dy: number; dz: number }
  | { kind: "array_grid_params";   source: THREE.Object3D }
  | { kind: "array_polar_params";  source: THREE.Object3D }
  | { kind: "array_polar_center";  source: THREE.Object3D }
  | { kind: "array_polar_count";   source: THREE.Object3D; cx: number; cy: number }
  | { kind: "array_rect_base";     source: THREE.Object3D }
  | { kind: "array_rect_dir_x";    source: THREE.Object3D; basePt: THREE.Vector3 }
  | { kind: "array_rect_dir_y";    source: THREE.Object3D; basePt: THREE.Vector3; dx: number }
  | { kind: "array_rect_count";    source: THREE.Object3D; dx: number; dy: number }
  | { kind: "array_curve_pick";    source: THREE.Object3D }
  | { kind: "array_curve_count";   source: THREE.Object3D; curvePts: THREE.Vector3[] };

let _opPhase: OpPhase | null = null;
let _opPreview: THREE.Object3D | null = null;
let _opHoverEdgePts: [THREE.Vector3, THREE.Vector3] | null = null;
let _opHoverCornerPts: [THREE.Vector3, THREE.Vector3, THREE.Vector3] | null = null; // [prev, corner, next] for 2D fillet
let _opLabels: HTMLElement[] = [];
let _selectHoverProfile: THREE.Object3D | null = null; // profile hovered during extrude_select
let _rawChooserDefault: (() => void) | null = null;
export let _selDragging = false;

export function getOpPhase(): OpPhase | null { return _opPhase; }
export function setSelDragging(v: boolean): void { _selDragging = v; }

// Timestamp of most recent opFinish call. Used by main.ts view-shortcut handler
// to suppress digit-key shortcuts for 300ms after an op-tool completes (#1186).
let _lastOpFinishMs = 0;
export function getLastOpFinishMs(): number { return _lastOpFinishMs; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function opClearPreview(viewer: Viewer): void {
  if (_opPreview) {
    viewer.getScene().remove(_opPreview);
    _opPreview.traverse((c) => {
      if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
      const mat = (c as THREE.Mesh).material;
      if (mat) { if (Array.isArray(mat)) mat.forEach(m => m.dispose()); else (mat as THREE.Material).dispose(); }
    });
    _opPreview = null;
  }
}

function opClearLabels(): void {
  for (const el of _opLabels) el.remove();
  _opLabels = [];
}

export function opFinish(viewer: Viewer, resetTool = true): void {
  opClearPreview(viewer);
  opSetHover(null);
  _opHoverEdgePts = null;
  _opHoverCornerPts = null;
  _selectHoverProfile = null;
  const _finishedKind = _opPhase?.kind;
  _opPhase = null;
  _lastOpFinishMs = Date.now();
  ptClearPrompt();
  ptHideCoordInput();
  _hooks.hideCursorDot();
  _hooks.clearSketchShiftLine(viewer);
  setChooserHint(null);
  _hooks.removeSelOverlay();
  _rawChooserDefault = null;
  _selDragging = false;
  // sel_window / sel_lasso commit multi-select into state — don't deselect.
  // All other op tools (extrude, boolean, fillet, dim) should clear the active target on finish.
  if (_finishedKind !== "sel_window" && _finishedKind !== "sel_lasso") {
    viewer.deselectCurrent();
  }
  viewer.setOpToolActive(false);
  viewer.setGumballEnabled(true);
  if (resetTool) dispatchSync("setActiveTool", { toolId: "select" });
}

// Clones a mesh's material before setting emissive highlight so shared materials
// (e.g. IFC walls sharing one MeshStandardMaterial) are not globally tinted.
function _applyBoolHighlight(obj: THREE.Object3D, hex: number): void {
  // Line objects (curves, polylines, circles as sketches) use LineBasicMaterial.color
  if (obj instanceof THREE.Line) {
    const lm = obj.material as THREE.LineBasicMaterial;
    obj.userData._savedLineColor = lm.color.getHex();
    lm.color.setHex(hex);
    return;
  }
  // For Groups (e.g. wall with void cuts), apply highlight to first Mesh child.
  if (obj instanceof THREE.Group) {
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh && !(child.userData._boolHighlightDone as boolean)) {
        child.userData._boolHighlightDone = true;
        _applyBoolHighlight(child, hex);
      }
    });
    obj.userData._boolGroupHighlighted = true;
    return;
  }
  const m = obj as THREE.Mesh;
  const mats = Array.isArray(m.material) ? m.material : (m.material ? [m.material] : []);
  const idx = mats.findIndex((mt) => !!(mt as THREE.MeshStandardMaterial).emissive);
  if (idx < 0) return;
  const orig = mats[idx] as THREE.MeshStandardMaterial;
  const cloned = orig.clone();
  cloned.emissive.setHex(hex);
  cloned.emissiveIntensity = 2.5;
  if (Array.isArray(m.material)) {
    const next = [...m.material]; next[idx] = cloned; m.material = next;
  } else {
    m.material = cloned;
  }
  m.userData._savedEmissive = orig.emissive.getHex();
  m.userData._savedMaterial = orig;
  delete m.userData._boolHighlightDone;
}

function _restoreBoolHighlight(obj: THREE.Object3D): void {
  // Restore Line objects
  if (obj instanceof THREE.Line) {
    if (obj.userData._savedLineColor !== undefined) {
      (obj.material as THREE.LineBasicMaterial).color.setHex(obj.userData._savedLineColor as number);
      delete obj.userData._savedLineColor;
    }
    return;
  }
  // Restore Group children
  if (obj instanceof THREE.Group) {
    if (obj.userData._boolGroupHighlighted) {
      obj.traverse((child) => {
        if (child instanceof THREE.Mesh) _restoreBoolHighlight(child);
      });
      delete obj.userData._boolGroupHighlighted;
    }
    return;
  }
  const m = obj as THREE.Mesh;
  if (m.userData._savedEmissive === undefined) return;
  const orig = m.userData._savedMaterial as THREE.Material | undefined;
  if (orig) {
    if (Array.isArray(m.material)) {
      m.material = m.material.map((mt) =>
        (mt as THREE.MeshStandardMaterial).emissiveIntensity === 1 &&
        (mt as THREE.MeshStandardMaterial).emissive ? orig : mt,
      );
    } else {
      m.material = orig;
    }
    delete m.userData._savedMaterial;
  } else {
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const std = mats.find((mt): mt is THREE.MeshStandardMaterial => !!(mt as THREE.MeshStandardMaterial).emissive);
    if (std) std.emissive.setHex(m.userData._savedEmissive as number);
  }
  delete m.userData._savedEmissive;
}

export function opCancel(viewer: Viewer, resetTool = true): void {
  opSetHover(null);
  if (_opPhase?.kind === "bool_b") _restoreBoolHighlight(_opPhase.objA);
  if (_opPhase?.kind === "bool_op") { _restoreBoolHighlight(_opPhase.objA); _restoreBoolHighlight(_opPhase.objB); }
  opFinish(viewer, resetTool);
}

export function opAddLabel(text: string, worldPt: THREE.Vector3, viewer: Viewer): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "background:rgba(0,0,0,0.72)",
    "color:#fff",
    "padding:2px 6px",
    "border-radius:3px",
    "font-size:11px",
    "font-family:var(--mono,monospace)",
    "pointer-events:none",
    "z-index:9999",
    "white-space:nowrap",
  ].join(";");
  el.textContent = text;
  document.body.appendChild(el);
  _opLabels.push(el);
  const sc = projectToScreen(viewer, worldPt.x, worldPt.y, worldPt.z);
  if (sc) { el.style.left = (sc.x + 8) + "px"; el.style.top = (sc.y - 14) + "px"; }
  return el;
}

function opBuildDimLabel(text: string, worldPt: THREE.Vector3, viewer: Viewer): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "background:rgba(0,0,0,0.72)",
    "color:#fff",
    "padding:2px 6px",
    "border-radius:3px",
    "font-size:11px",
    "font-family:var(--mono,monospace)",
    "pointer-events:none",
    "z-index:9999",
    "white-space:nowrap",
  ].join(";");
  el.textContent = text;
  document.body.appendChild(el);
  const sc = projectToScreen(viewer, worldPt.x, worldPt.y, worldPt.z);
  if (sc) { el.style.left = (sc.x + 8) + "px"; el.style.top = (sc.y - 14) + "px"; }
  return el;
}

export function opBuildAnnotLine(pts: THREE.Vector3[], color = 0x4488ff): THREE.Object3D {
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 100;
  line.userData.noSnap = true;
  return line;
}

export function opUpdateDimPreview(viewer: Viewer, snapped3: THREE.Vector3): void {
  const phase = _opPhase;
  if (!phase) return;
  opClearPreview(viewer);
  if (phase.kind === "dim_b") {
    _opPreview = opBuildAnnotLine([phase.ptA, snapped3]);
    viewer.getScene().add(_opPreview);
  } else if (phase.kind === "dim_c" && !phase.ptA.equals(phase.ptB)) {
    const grp = new THREE.Group();
    grp.add(opBuildAnnotLine([phase.ptA, phase.ptB]));
    grp.add(opBuildAnnotLine([phase.ptA, snapped3]));
    _opPreview = grp;
    viewer.getScene().add(_opPreview);
  } else if (phase.kind === "dim_area" && phase.pts.length >= 1) {
    const pts = [...phase.pts, snapped3];
    const grp = new THREE.Group();
    if (pts.length >= 2) grp.add(opBuildAnnotLine(pts));
    _opPreview = grp;
    viewer.getScene().add(_opPreview);
  } else if (phase.kind === "tmeasure_b") {
    _opPreview = opBuildAnnotLine([phase.ptA, snapped3]);
    viewer.getScene().add(_opPreview);
  }
}

export function opUpdateCopyPreview(viewer: Viewer, clientX: number, clientY: number): void {
  const phase = _opPhase;
  if (phase?.kind !== "copy_place") return;
  opClearPreview(viewer);
  const world = unprojectToXY(viewer, clientX, clientY);
  const sv = nearestSnapVertex(viewer, clientX, clientY);
  const snapped = sv
    ? new THREE.Vector3(sv.x, sv.y, sv.z)
    : world ? new THREE.Vector3(world.x, world.y, world.z ?? 0) : null;
  if (!snapped) return;

  const ghost = phase.source.clone();
  const dx = snapped.x - phase.srcPt.x;
  const dy = snapped.y - phase.srcPt.y;
  ghost.position.x += dx;
  ghost.position.y += dy;
  ghost.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.material) {
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      m.material = mats.map((mat) => {
        const clone = (mat as THREE.Material).clone();
        (clone as THREE.MeshStandardMaterial).transparent = true;
        (clone as THREE.MeshStandardMaterial).opacity = 0.45;
        return clone;
      });
    }
  });
  ghost.userData.noSnap = true;
  _opPreview = ghost;
  viewer.getScene().add(ghost);
}

// ── 2D polyline corner fillet ─────────────────────────────────────────────────

function opApply2DFillet(
  viewer: Viewer,
  line: THREE.Line,
  prevPtWorld: THREE.Vector3,
  cornerPtWorld: THREE.Vector3,
  nextPtWorld: THREE.Vector3,
  r: number,
): void {
  // Directions from corner toward each adjacent vertex
  const d1 = prevPtWorld.clone().sub(cornerPtWorld).normalize();
  const d2 = nextPtWorld.clone().sub(cornerPtWorld).normalize();

  // Dot product → half-angle of the corner opening
  const dotD = Math.max(-1, Math.min(1, d1.dot(d2)));
  const theta = Math.acos(dotD);          // angle at corner (between the two segments)
  const halfAngle = theta / 2;
  if (halfAngle < 1e-4 || Math.PI - halfAngle < 1e-4) return; // collinear — skip

  // Standard arc fillet: tangent distance from corner to each tangent point
  const tanDist = r / Math.tan(halfAngle);
  // Clamp to 90% of the shorter adjacent segment so we don't overshoot
  const maxDist = Math.min(prevPtWorld.distanceTo(cornerPtWorld), nextPtWorld.distanceTo(cornerPtWorld)) * 0.9;
  const td = Math.min(tanDist, maxDist);
  const actualR = td * Math.tan(halfAngle);

  const t1 = cornerPtWorld.clone().add(d1.clone().multiplyScalar(td));
  const t2 = cornerPtWorld.clone().add(d2.clone().multiplyScalar(td));

  // Arc center: along bisector at distance r / sin(halfAngle) from corner
  const bisect = d1.clone().add(d2).normalize();
  const centerDist = actualR / Math.sin(halfAngle);
  const center = cornerPtWorld.clone().add(bisect.clone().multiplyScalar(centerDist));

  // Arc sweep using the cross-product z-sign to determine orientation
  const crossZ = d1.x * d2.y - d1.y * d2.x;
  const arcAngle = Math.PI - theta;
  const sweep    = arcAngle * (crossZ > 0 ? -1 : 1);

  const a1 = Math.atan2(t1.y - center.y, t1.x - center.x);
  const ARC_SEGS = 12;
  const arcPtsWorld: THREE.Vector3[] = [];
  for (let i = 0; i <= ARC_SEGS; i++) {
    const a = a1 + (sweep * i) / ARC_SEGS;
    arcPtsWorld.push(new THREE.Vector3(
      center.x + actualR * Math.cos(a),
      center.y + actualR * Math.sin(a),
      cornerPtWorld.z,
    ));
  }

  // Map world arc points into line-local space
  const invMat = line.matrixWorld.clone().invert();
  const localT1  = t1.clone().applyMatrix4(invMat);
  const localT2  = t2.clone().applyMatrix4(invMat);
  const localCorner = cornerPtWorld.clone().applyMatrix4(invMat);
  const localArcPts = arcPtsWorld.map((p) => p.clone().applyMatrix4(invMat));

  // Find corner vertex index in existing geometry
  const pos = line.geometry.getAttribute("position") as THREE.BufferAttribute;
  const allVerts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    allVerts.push(new THREE.Vector3().fromBufferAttribute(pos, i));
  }
  let cornerIdx = -1;
  let minD = Infinity;
  for (let i = 0; i < allVerts.length; i++) {
    const d = allVerts[i].distanceTo(localCorner);
    if (d < minD) { minD = d; cornerIdx = i; }
  }
  // For a closed LineLoop all corner indices are valid (including 0 and last).
  const isLoop = line instanceof THREE.LineLoop;
  if (!isLoop && (cornerIdx <= 0 || cornerIdx >= allVerts.length - 1)) return;

  // Rebuild vertex array with arc replacing the corner
  const newVerts: THREE.Vector3[] = [
    ...allVerts.slice(0, cornerIdx),
    localT1,
    ...localArcPts,
    localT2,
    ...allVerts.slice(cornerIdx + 1),
  ];

  const lineGeo = new THREE.BufferGeometry().setFromPoints(newVerts);
  const lineMat = (line.material as THREE.LineBasicMaterial).clone();
  const newLine = new THREE.Line(lineGeo, lineMat);
  newLine.position.copy(line.position);
  newLine.rotation.copy(line.rotation);
  newLine.scale.copy(line.scale);
  newLine.userData = { ...line.userData, endpoints: newVerts.map((v) => ({ x: v.x, y: v.y, z: v.z })) };

  viewer.getScene().remove(line);
  viewer.addMesh(newLine as unknown as THREE.Mesh, "line", { noHistory: true });
  pushReplaceAction(newLine as unknown as THREE.Mesh, [line as unknown as THREE.Mesh], "fillet");
}

// ── Fillet edge hover ─────────────────────────────────────────────────────────

export function opUpdateFilletEdge(viewer: Viewer, clientX: number, clientY: number): void {
  const phase = _opPhase;
  if (!phase || phase.kind !== "fillet_edge") { _opHoverEdgePts = null; _opHoverCornerPts = null; return; }

  opSetHover(phase.target);

  // ── 2D fillet: vertex-proximity corner detection for Line/LineLoop objects ──
  if (phase.target instanceof THREE.Line) {
    const pos = phase.target.geometry.getAttribute("position") as THREE.BufferAttribute;
    if (!pos || pos.count < 3) { opClearPreview(viewer); _opHoverEdgePts = null; _opHoverCornerPts = null; return; }
    const mat4 = phase.target.matrixWorld;

    // LineLoop (rect/polygon/circle): every vertex is a corner — include all.
    // Open Line: first and last are endpoints; skip them.
    const isLoop = phase.target instanceof THREE.LineLoop;
    let bestIdx = -1;
    let bestDist = 64; // px — wider search radius than regular snap for corners
    for (let i = (isLoop ? 0 : 1); i < (isLoop ? pos.count : pos.count - 1); i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mat4);
      const sc = projectToScreen(viewer, v.x, v.y, v.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    if (bestIdx < 0) { opClearPreview(viewer); _opHoverEdgePts = null; _opHoverCornerPts = null; return; }

    const prevIdx = isLoop ? (bestIdx - 1 + pos.count) % pos.count : bestIdx - 1;
    const nextIdx = isLoop ? (bestIdx + 1) % pos.count : bestIdx + 1;
    const prev   = new THREE.Vector3().fromBufferAttribute(pos, prevIdx).applyMatrix4(mat4);
    const corner = new THREE.Vector3().fromBufferAttribute(pos, bestIdx).applyMatrix4(mat4);
    const next   = new THREE.Vector3().fromBufferAttribute(pos, nextIdx).applyMatrix4(mat4);

    _opHoverCornerPts = [prev, corner, next];
    _opHoverEdgePts   = [prev, next]; // stored for click handler compatibility

    opClearPreview(viewer);
    const previewGrp = new THREE.Group();
    const previewGeo = new THREE.BufferGeometry().setFromPoints([prev, corner, next]);
    const previewMat = new THREE.LineBasicMaterial({ color: 0xff7700, depthTest: false });
    const previewLine = new THREE.Line(previewGeo, previewMat);
    previewLine.renderOrder = 999;
    previewGrp.add(previewLine);
    const cDotGeo = new THREE.SphereGeometry(0.04, 8, 6);
    const cDotMat = new THREE.MeshBasicMaterial({ color: 0xff7700, depthTest: false });
    for (const pt of [prev, corner, next]) {
      const d = new THREE.Mesh(cDotGeo, cDotMat);
      d.position.copy(pt);
      d.renderOrder = 999;
      previewGrp.add(d);
    }
    _opPreview = previewGrp;
    viewer.getScene().add(previewGrp);
    return;
  }

  // ── 3D fillet: closest logical edge (unique-edge enumeration) ──
  // Use getUniqueEdges so we highlight actual solid edges, not internal triangle
  // diagonals. Transform each local-space edge to world space, find closest to
  // cursor ray within a 60px screen-distance threshold.
  const meshTarget = phase.target as THREE.Mesh;
  const mat4 = meshTarget.matrixWorld;
  const uniqueLocal = getUniqueEdges(meshTarget);

  let bestEdge: [THREE.Vector3, THREE.Vector3] | null = null;
  let bestDist = 60; // px — only highlight if cursor is within this range

  for (const [la, lb] of uniqueLocal) {
    const wa = la.clone().applyMatrix4(mat4);
    const wb = lb.clone().applyMatrix4(mat4);
    const ep = closestPtOnSegToRay(viewer, clientX, clientY, wa, wb);
    if (!ep) continue;
    const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
    if (!sc) continue;
    const d = Math.hypot(sc.x - clientX, sc.y - clientY);
    if (d < bestDist) { bestDist = d; bestEdge = [wa, wb]; }
  }

  if (!bestEdge) { opClearPreview(viewer); _opHoverEdgePts = null; _opHoverCornerPts = null; return; }
  _opHoverEdgePts = bestEdge;
  _opHoverCornerPts = null;

  opClearPreview(viewer);
  // Build a group: line + sphere markers at endpoints so the edge is clearly visible.
  const grp = new THREE.Group();
  const lineGeo = new THREE.BufferGeometry().setFromPoints(bestEdge);
  const lineMat = new THREE.LineBasicMaterial({ color: 0xff7700, depthTest: false });
  const edgeLine = new THREE.Line(lineGeo, lineMat);
  edgeLine.renderOrder = 999;
  grp.add(edgeLine);
  const dotR = 0.04;
  const dotGeo = new THREE.SphereGeometry(dotR, 8, 6);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0xff7700, depthTest: false });
  for (const ep of bestEdge) {
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.copy(ep);
    dot.renderOrder = 999;
    grp.add(dot);
  }
  _opPreview = grp;
  viewer.getScene().add(grp);
}

// Build snap endpoints from a flat list of world-space XY points at z=0 and z=h.
// Stored in mesh.userData.endpoints so section-1a vertex snap finds them.
function snapEndpointsFromProfile(pts: Array<{x: number; y: number}>, h: number) {
  const eps = [];
  for (const p of pts) {
    eps.push({ id: makeSnapId(p.x, p.y, 0), x: p.x, y: p.y, z: 0 });
    eps.push({ id: makeSnapId(p.x, p.y, h), x: p.x, y: p.y, z: h });
  }
  return eps;
}

// Build explicit edge pairs for section-1d snap, avoiding the spurious diagonal
// segments that arise when section-1d iterates the interleaved [z=0,z=h] endpoint array.
// Encodes vertical edges (z=0↔z=h at each profile point) and horizontal ring edges
// (adjacent profile points at z=0 and at z=h).
type EdgePtPair = [{ x: number; y: number; z: number }, { x: number; y: number; z: number }];
function snapEdgePairsFromProfile(pts: Array<{x: number; y: number}>, h: number): EdgePtPair[] {
  const pairs: EdgePtPair[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    // Vertical edge
    pairs.push([{ x: p.x, y: p.y, z: 0 }, { x: p.x, y: p.y, z: h }]);
    // Horizontal ring edges at z=0 and z=h (adjacent profile points)
    if (i < pts.length - 1) {
      const q = pts[i + 1];
      pairs.push([{ x: p.x, y: p.y, z: 0 }, { x: q.x, y: q.y, z: 0 }]);
      pairs.push([{ x: p.x, y: p.y, z: h }, { x: q.x, y: q.y, z: h }]);
    }
  }
  return pairs;
}

function opBuildExtrudeMesh(profile: THREE.Object3D, h: number): THREE.Mesh {
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
    // Cardinal snap points on top + bottom circles (N/S/E/W + center)
    const cx = ctr.x, cy = ctr.y;
    const circlePts = [
      { x: cx, y: cy },
      { x: cx + r, y: cy }, { x: cx - r, y: cy },
      { x: cx, y: cy + r }, { x: cx, y: cy - r },
    ];
    mesh.userData.footprintCircle = { cx, cy, r };
    mesh.userData.endpoints = snapEndpointsFromProfile(circlePts, h);
    mesh.userData.edgePairs = snapEdgePairsFromProfile(circlePts, h);
    return mesh;
  }

  if (creator === "arc") {
    profile.updateMatrixWorld();
    const worldCenter = new THREE.Vector3(0, 0, 0).applyMatrix4(profile.matrixWorld);
    const arcR = (profile.userData.radius as number | undefined) ?? 1;
    const sa = (profile.userData.startAngle as number | undefined) ?? 0;
    const ea = (profile.userData.endAngle as number | undefined) ?? Math.PI / 2;
    const segs = 64;
    const span = ea - sa;
    const worldPts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= segs; i++) {
      const a = sa + (i / segs) * span;
      worldPts.push({ x: worldCenter.x + arcR * Math.cos(a), y: worldCenter.y + arcR * Math.sin(a) });
    }
    // Open arc → ribbon surface
    const verts: number[] = [];
    const idxs: number[] = [];
    worldPts.forEach((p, i) => {
      verts.push(p.x, p.y, 0, p.x, p.y, h);
      if (i < worldPts.length - 1) {
        const b = i * 2;
        idxs.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geom.setIndex(idxs);
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x5585cc, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.endpoints = snapEndpointsFromProfile(worldPts, h);
    mesh.userData.edgePairs = snapEdgePairsFromProfile(worldPts, h);
    return mesh;
  }

  if (creator === "curve") {
    const cpLocal: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const isClosed = !!(profile.userData.isClosed as boolean | undefined);
    if (cpLocal.length >= 2) {
      profile.updateMatrixWorld();
      const cpWorld = cpLocal.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
      const sampleCt = Math.max(cpLocal.length * 16, 64);
      const crWPts = cpWorld.map((v) => ({ x: v.x, y: v.y, z: v.z }));
      const crWNurbs = createCatmullRomAsNurbs(crWPts, { closed: isClosed });
      const samples = tessellate(crWNurbs, sampleCt + 1).map((p) => new THREE.Vector3(p.x, p.y, p.z));
      const color = 0x88aacc;
      const snapPts2d = cpWorld.map((v) => ({ x: v.x, y: v.y }));
      if (isClosed) {
        const shape = new THREE.Shape();
        shape.moveTo(samples[0].x, samples[0].y);
        for (let i = 1; i < samples.length; i++) shape.lineTo(samples[i].x, samples[i].y);
        shape.closePath();
        const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.footprintPts = snapPts2d;
        mesh.userData.endpoints = snapEndpointsFromProfile(snapPts2d, h);
        mesh.userData.edgePairs = snapEdgePairsFromProfile(snapPts2d, h);
        return mesh;
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
        const mesh = new THREE.Mesh(geom, mat);
        mesh.userData.endpoints = snapEndpointsFromProfile(snapPts2d, h);
        mesh.userData.edgePairs = snapEdgePairsFromProfile(snapPts2d, h);
        return mesh;
      }
    }
  }

  if (creator === "polygon") {
    const cpLocal: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    if (cpLocal.length >= 3) {
      profile.updateMatrixWorld();
      const cpWorld = cpLocal.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
      const shape = new THREE.Shape();
      shape.moveTo(cpWorld[0].x, cpWorld[0].y);
      for (let i = 1; i < cpWorld.length; i++) shape.lineTo(cpWorld[i].x, cpWorld[i].y);
      shape.closePath();
      const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      const polPts = cpWorld.map((v) => ({ x: v.x, y: v.y }));
      mesh.userData.footprintPts = polPts;
      mesh.userData.endpoints = snapEndpointsFromProfile(polPts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(polPts, h);
      return mesh;
    }
  }

  if (creator === "line" || creator === "polyline") {
    const pts: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const isClosed = !!(profile.userData.isClosed as boolean | undefined);
    profile.updateMatrixWorld();
    const worldPts = pts.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
    if (worldPts.length >= 2) {
      if (isClosed && worldPts.length >= 3) {
        // Closed polyline → solid extrusion (same as polygon)
        const shape = new THREE.Shape();
        shape.moveTo(worldPts[0].x, worldPts[0].y);
        for (let i = 1; i < worldPts.length; i++) shape.lineTo(worldPts[i].x, worldPts[i].y);
        shape.closePath();
        const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.55, metalness: 0.05 });
        const mesh = new THREE.Mesh(geom, mat);
        const polPts = worldPts.map((v) => ({ x: v.x, y: v.y }));
        mesh.userData.footprintPts = polPts;
        mesh.userData.endpoints = snapEndpointsFromProfile(polPts, h);
        mesh.userData.edgePairs = snapEdgePairsFromProfile(polPts, h);
        return mesh;
      }
      // Open line/polyline → ribbon surface
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
      const mesh = new THREE.Mesh(geom, mat);
      const linPts = worldPts.map((p) => ({ x: p.x, y: p.y }));
      mesh.userData.endpoints = snapEndpointsFromProfile(linPts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(linPts, h);
      return mesh;
    }
  }

  // rect: read corner positions directly from LineLoop geometry buffer for exact world-space shape.
  if (creator === "rect") {
    profile.updateMatrixWorld();
    const profileAsLine = profile as THREE.Object3D & { geometry?: THREE.BufferGeometry };
    const posAttr = profileAsLine.geometry?.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (posAttr && posAttr.count >= 3) {
      const worldPts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < posAttr.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(profile.matrixWorld);
        worldPts.push({ x: v.x, y: v.y });
      }
      const shape = new THREE.Shape();
      shape.moveTo(worldPts[0].x, worldPts[0].y);
      for (let i = 1; i < worldPts.length; i++) shape.lineTo(worldPts[i].x, worldPts[i].y);
      shape.closePath();
      const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.footprintPts = worldPts;
      mesh.userData.endpoints = snapEndpointsFromProfile(worldPts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(worldPts, h);
      return mesh;
    }
  }

  // Solid mesh used as profile: re-extrude from stored footprint or by extracting
  // the bottom-face polygon. Fixes "circle → box" when re-extruding an extrude result.
  if (profile instanceof THREE.Mesh) {
    // 1. Stored footprint circle (cylinders from circle extrusions).
    const fc = profile.userData.footprintCircle as { cx: number; cy: number; r: number } | undefined;
    if (fc) {
      const geom = new THREE.CylinderGeometry(fc.r, fc.r, h, 64);
      geom.rotateX(Math.PI / 2);
      geom.translate(0, 0, h / 2);
      const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(fc.cx, fc.cy, 0);
      const circlePts = [
        { x: fc.cx, y: fc.cy },
        { x: fc.cx + fc.r, y: fc.cy }, { x: fc.cx - fc.r, y: fc.cy },
        { x: fc.cx, y: fc.cy + fc.r }, { x: fc.cx, y: fc.cy - fc.r },
      ];
      mesh.userData.footprintCircle = fc;
      mesh.userData.endpoints = snapEndpointsFromProfile(circlePts, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(circlePts, h);
      return mesh;
    }
    // 2. Stored footprint polygon (polygon/polyline/rect/curve extrusions).
    const fp = profile.userData.footprintPts as Array<{ x: number; y: number }> | undefined;
    if (fp && fp.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(fp[0].x, fp[0].y);
      for (let i = 1; i < fp.length; i++) shape.lineTo(fp[i].x, fp[i].y);
      shape.closePath();
      const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.userData.footprintPts = fp;
      mesh.userData.endpoints = snapEndpointsFromProfile(fp, h);
      mesh.userData.edgePairs = snapEdgePairsFromProfile(fp, h);
      return mesh;
    }
    // 3. Extract bottom-face vertices from world-space geometry (fallback for imported/CSG meshes).
    profile.updateMatrixWorld();
    const posAttr = profile.geometry.getAttribute("position") as THREE.BufferAttribute | null;
    if (posAttr && posAttr.count >= 3) {
      const mat4 = profile.matrixWorld;
      let minZw = Infinity;
      for (let i = 0; i < posAttr.count; i++) {
        const z = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mat4).z;
        if (z < minZw) minZw = z;
      }
      const rawPts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < posAttr.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(mat4);
        if (Math.abs(v.z - minZw) > 0.01) continue;
        rawPts.push({ x: v.x, y: v.y });
      }
      const uniq: Array<{ x: number; y: number }> = [];
      const DEDUP = 0.01;
      for (const p of rawPts) {
        if (!uniq.some(q => Math.hypot(p.x - q.x, p.y - q.y) < DEDUP)) uniq.push(p);
      }
      if (uniq.length >= 3) {
        // Filter out interior points that are near the centroid (e.g. fan-center vertex).
        const fcx = uniq.reduce((s, p) => s + p.x, 0) / uniq.length;
        const fcy = uniq.reduce((s, p) => s + p.y, 0) / uniq.length;
        const dists = uniq.map(p => Math.hypot(p.x - fcx, p.y - fcy));
        const avgDist = dists.reduce((s, d) => s + d, 0) / dists.length;
        const perimeter = avgDist > 0.01 ? uniq.filter((_, i) => dists[i] > avgDist * 0.4) : uniq;
        if (perimeter.length >= 3) {
          const pcx = perimeter.reduce((s, p) => s + p.x, 0) / perimeter.length;
          const pcy = perimeter.reduce((s, p) => s + p.y, 0) / perimeter.length;
          perimeter.sort((a, b) => Math.atan2(a.y - pcy, a.x - pcx) - Math.atan2(b.y - pcy, b.x - pcx));
          const shape = new THREE.Shape();
          shape.moveTo(perimeter[0].x, perimeter[0].y);
          for (let i = 1; i < perimeter.length; i++) shape.lineTo(perimeter[i].x, perimeter[i].y);
          shape.closePath();
          const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
          const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
          const mesh = new THREE.Mesh(geom, mat);
          mesh.userData.footprintPts = perimeter;
          mesh.userData.endpoints = snapEndpointsFromProfile(perimeter, h);
          mesh.userData.edgePairs = snapEdgePairsFromProfile(perimeter, h);
          return mesh;
        }
      }
    }
    // 4. Last resort: bounding box.
    const geom = new THREE.BoxGeometry(Math.max(0.05, size.x), Math.max(0.05, size.y || size.x), h);
    geom.translate(ctr.x, ctr.y, h / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    const hw = size.x / 2, hd = (size.y || size.x) / 2;
    const boxPts = [
      { x: ctr.x - hw, y: ctr.y - hd }, { x: ctr.x + hw, y: ctr.y - hd },
      { x: ctr.x + hw, y: ctr.y + hd }, { x: ctr.x - hw, y: ctr.y + hd },
    ];
    mesh.userData.endpoints = snapEndpointsFromProfile(boxPts, h);
    mesh.userData.edgePairs = snapEdgePairsFromProfile(boxPts, h);
    return mesh;
  }

  const w = Math.max(0.05, size.x);
  const d = Math.max(0.05, size.y || size.x);
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(ctr.x, ctr.y, 0);
  const cx = ctr.x, cy = ctr.y, hw = w / 2, hd = d / 2;
  const boxPts = [
    { x: cx - hw, y: cy - hd }, { x: cx + hw, y: cy - hd },
    { x: cx + hw, y: cy + hd }, { x: cx - hw, y: cy + hd },
    { x: cx, y: cy },
  ];
  mesh.userData.endpoints = snapEndpointsFromProfile(boxPts, h);
  mesh.userData.edgePairs = snapEdgePairsFromProfile(boxPts, h);
  return mesh;
}

export function opRaycastObject(
  viewer: Viewer,
  clientX: number,
  clientY: number,
  profileOnly = false,
  hoverMode = false,
): { obj: THREE.Object3D; point: THREE.Vector3 } | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, viewer.getActiveCamera());

  const hitThresh = hoverMode ? 20 : (profileOnly ? 40 : 10);
  let thinHit: { obj: THREE.Object3D; point: THREE.Vector3 } | null = null;
  let thinHitD = hitThresh;
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap) return;
    if (profileOnly && !CLICK_PROFILE_CREATORS.has(o.userData.creator ?? "")) return;
    const isLine = o instanceof THREE.Line;
    const isPts = o instanceof THREE.Points;
    if (!isLine && !isPts) return;
    const posAttr = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const count = posAttr.count;
    for (let i = 0; i < count; i++) {
      const wp = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
      const sc = projectToScreen(viewer, wp.x, wp.y, wp.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < thinHitD) { thinHitD = d; thinHit = { obj: o, point: wp }; }
    }
    if (isLine) {
      const looped = o instanceof THREE.LineLoop;
      for (let i = 0; i < count - (looped ? 0 : 1); i++) {
        const A = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
        const B = new THREE.Vector3().fromBufferAttribute(posAttr, (i + 1) % count).applyMatrix4(o.matrixWorld);
        const ep = closestPtOnSegToRay(viewer, clientX, clientY, A, B);
        if (!ep) continue;
        const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
        if (!sc) continue;
        const d = Math.hypot(sc.x - clientX, sc.y - clientY);
        if (d < thinHitD) { thinHitD = d; thinHit = { obj: o, point: ep }; }
      }
    }
  });
  if (thinHit) return thinHit;

  // For profile-only selection: also accept clicks inside closed LineLoop shapes
  // (circles, rects, polygons drawn on XY plane) via 2D ray-plane containment.
  if (profileOnly) {
    const rayOrigin = new THREE.Vector3(); const rayDir = new THREE.Vector3();
    rc.ray.origin.clone().copy(rayOrigin); // avoid mutation
    rc.ray.direction.clone().copy(rayDir);
    const rayO = rc.ray.origin, rayD = rc.ray.direction;
    // Intersect the ray with Z=0 plane
    if (Math.abs(rayD.z) > 1e-6) {
      const t = -rayO.z / rayD.z;
      if (t > 0) {
        const hitPt = new THREE.Vector3(rayO.x + t * rayD.x, rayO.y + t * rayD.y, 0);
        let best: { obj: THREE.Object3D; dist: number } | null = null;
        viewer.getScene().traverse((o) => {
          if (o.userData.noSnap) return;
          if (!CLICK_PROFILE_CREATORS.has(o.userData.creator ?? "")) return;
          // Accept LineLoop (circles, rects) and closed Line curves (isClosed=true).
          const isLooped = o instanceof THREE.LineLoop;
          const isClosedLine = o instanceof THREE.Line && !!(o.userData.isClosed as boolean | undefined);
          if (!isLooped && !isClosedLine) return;
          const posAttr = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
          if (!posAttr) return;
          // 2D point-in-polygon using ray-cast method
          const n = posAttr.count;
          let inside = false;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const ai = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
            const aj = new THREE.Vector3().fromBufferAttribute(posAttr, j).applyMatrix4(o.matrixWorld);
            if (((ai.y > hitPt.y) !== (aj.y > hitPt.y)) &&
                hitPt.x < ai.x + (aj.x - ai.x) * (hitPt.y - ai.y) / (aj.y - ai.y)) {
              inside = !inside;
            }
          }
          if (inside) {
            const ctr = new THREE.Vector3(); new THREE.Box3().setFromObject(o).getCenter(ctr);
            const dist = hitPt.distanceTo(ctr);
            if (!best || dist < best.dist) best = { obj: o, dist };
          }
        });
        if (best) return { obj: (best as { obj: THREE.Object3D; dist: number }).obj, point: hitPt };
      }
    }
  }

  const meshes: THREE.Mesh[] = [];
  viewer.getScene().traverse((o) => {
    const isDisplay = !!o.userData.isJoinDisplay;
    if (o.userData.noSnap && !isDisplay) return;
    if (!(o instanceof THREE.Mesh)) return;
    if (!o.geometry?.getAttribute("position")) return;
    if (profileOnly && !CLICK_PROFILE_CREATORS.has(o.userData.creator ?? "")) return;
    // Skip very large flat meshes as extrude profiles (e.g., floor slabs > 50m² footprint)
    // to prevent accidentally extruding the ground plane.
    if (profileOnly) {
      const b = new THREE.Box3().setFromObject(o); const s = new THREE.Vector3(); b.getSize(s);
      if (s.x * s.y > 50) return;
    }
    // #950: skip meshes that are effectively invisible (parent-group visibility).
    if (!isDisplay) {
      let anc: THREE.Object3D | null = o;
      while (anc) { if (!anc.visible) return; anc = anc.parent; }
    }
    meshes.push(o);
  });
  const hits = rc.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
  let hitObj: THREE.Object3D = hit.object;
  // Resolve child mesh of any creator-tagged Group (roof, void-cut wall, etc.) to the Group.
  if (hitObj.parent instanceof THREE.Group && hitObj.parent.userData.creator) hitObj = hitObj.parent;
  return { obj: hitObj, point: hit.point.clone() };
}

export function opPhaseIsObjectSelect(phase: OpPhase): boolean {
  switch (phase.kind) {
    case "extrude_select":
    case "bool_a":
    case "bool_b":
    case "bool_op":
    case "fillet_select":
    case "copy_select":
    case "array_select":
      return true;
    case "dim_a":
      return phase.tool === "volume-dim";
    default:
      return false;
  }
}

export function opPhaseSupressesSnap(phase: OpPhase): boolean {
  if (opPhaseIsObjectSelect(phase)) return true;
  switch (phase.kind) {
    case "fillet_edge":
    case "sel_window_sub":
    case "sel_window":
    case "sel_lasso_sub":
    case "sel_lasso":
    case "sel_boundary_sub":
    case "sel_boundary_pick":
    case "sel_boundary_draw":
      return true;
    default:
      return false;
  }
}

// ── Inline raw chooser ────────────────────────────────────────────────────────

function showRawChooser(
  label: string,
  options: Array<{ label: string; description: string; onSelect: () => void }>,
  defaultFn: () => void,
): void {
  const chooserEl = getChooserEl();
  if (!chooserEl) return;
  chooserEl.innerHTML = "";
  const lbl = document.createElement("div");
  lbl.className = "chooser-label";
  lbl.textContent = label;
  chooserEl.appendChild(lbl);
  for (const opt of options) {
    const chip = document.createElement("button");
    chip.className = "chooser-chip";
    chip.textContent = opt.label;
    chip.title = opt.description;
    chip.addEventListener("click", () => {
      _rawChooserDefault = null;
      chooserEl.classList.remove("visible");
      chooserEl.innerHTML = "";
      opt.onSelect();
    });
    chooserEl.appendChild(chip);
  }
  chooserEl.classList.add("visible");
  _rawChooserDefault = defaultFn;
}

// ── screenYtoDz ───────────────────────────────────────────────────────────────

function screenYtoDz(viewer: Viewer, screenY: number, base: { x: number; y: number; z?: number }): number {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const cam = viewer.getActiveCamera();
  const baseZ = base.z ?? 0;
  let mPerPx: number;
  if (cam instanceof THREE.OrthographicCamera) {
    mPerPx = (cam.top - cam.bottom) / rect.height;
  } else {
    const fovRad = THREE.MathUtils.degToRad((cam as THREE.PerspectiveCamera).fov);
    const camDist = Math.max(0.5, cam.position.distanceTo(new THREE.Vector3(base.x, base.y, baseZ)));
    mPerPx = 2 * camDist * Math.tan(fovRad / 2) / rect.height;
  }
  const baseScreen = projectToScreen(viewer, base.x, base.y, baseZ);
  const refScreenY = baseScreen?.y ?? (rect.top + rect.height / 2);
  return (refScreenY - screenY) * mPerPx;
}

export function opGetScreenYtoDz(): typeof screenYtoDz { return screenYtoDz; }

// ── Extrude preview ───────────────────────────────────────────────────────────

export function opUpdateExtrudePreview(viewer: Viewer, clientX: number, clientY: number, shiftKey = false): void {
  if (_opPhase?.kind !== "extrude_height") return;
  const { cx, cy } = _opPhase;
  const profileBase = new THREE.Vector3(cx, cy, 0);
  const rawH = screenYtoDz(viewer, clientY, { x: cx, y: cy, z: 0 });
  const step = getSnap().step;
  let h: number;
  if (rawH > 0) {
    h = shiftKey ? Math.max(step, Math.round(rawH / step) * step) : Math.max(0.05, rawH);
  } else {
    h = 0.05;
  }
  if (shiftKey) _hooks.updateSketchShiftLine(viewer, profileBase, "z");
  else _hooks.clearSketchShiftLine(viewer);
  opClearPreview(viewer);
  const mesh = opBuildExtrudeMesh(_opPhase.profile, h);
  mesh.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      const mat = c.material as THREE.MeshStandardMaterial;
      c.material = new THREE.MeshStandardMaterial({
        color: (mat as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0xc9c0a8),
        transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide,
      });
      mat.dispose();
    }
  });
  mesh.traverse((c) => { c.renderOrder = 50; c.userData.noSnap = true; });
  _opPreview = mesh;
  viewer.getScene().add(mesh);
  const snapTag = shiftKey ? `  [grid snap ${formatLength(getSnap().step)}]` : "";
  ptPrompt(`Extrude height — ${formatLength(h)} — click to commit  [Escape = cancel]${snapTag}`);
}

// Ghost preview shown while hovering a profile during extrude_select phase.
// Shows a 1m-tall transparent extrusion so the user can confirm the right shape.
export function opUpdateSelectHoverPreview(viewer: Viewer, profile: THREE.Object3D | null): void {
  if (profile === _selectHoverProfile) return;
  _selectHoverProfile = profile;
  opClearPreview(viewer);
  if (!profile) return;
  const mesh = opBuildExtrudeMesh(profile, 1.0);
  mesh.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      const mat = c.material as THREE.MeshStandardMaterial;
      c.material = new THREE.MeshStandardMaterial({
        color: (mat as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0x44aaff),
        transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide,
      });
      mat.dispose();
    }
    if (c instanceof THREE.Line) {
      (c.material as THREE.LineBasicMaterial).transparent = true;
      (c.material as THREE.LineBasicMaterial).opacity = 0.5;
    }
  });
  mesh.traverse((c) => { c.renderOrder = 48; c.userData.noSnap = true; });
  _opPreview = mesh;
  viewer.getScene().add(mesh);
}

// ── Boolean operation ─────────────────────────────────────────────────────────

function opExecBoolean(viewer: Viewer, objA: THREE.Object3D, objB: THREE.Object3D, op: "union" | "difference" | "split"): void {
  _restoreBoolHighlight(objA); _restoreBoolHighlight(objB);

  if (!(objA instanceof THREE.Mesh) || !(objB instanceof THREE.Mesh)) {
    ptPrompt("Boolean — both objects must be solid meshes, not curves or points");
    setTimeout(() => ptClearPrompt(), 2000);
    opFinish(viewer); return;
  }
  const mA = objA as THREE.Mesh;
  const mB = objB as THREE.Mesh;

  // Force matrix update so world-space geometry is current regardless of render timing.
  mA.updateMatrixWorld(true);
  mB.updateMatrixWorld(true);

  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const tags: Record<string, string> = { union: "boolean-union", difference: "boolean-difference", split: "boolean-split" };

  let result: THREE.Mesh;
  try {
    if      (op === "union")      result = csgUnion(mA, mB, mat);
    else if (op === "difference") result = csgDifference(mA, mB, mat);
    else                          result = csgIntersection(mA, mB, mat);
  } catch {
    ptPrompt("Boolean failed — geometry may be non-manifold. Try extruding simpler profiles.");
    setTimeout(() => ptClearPrompt(), 4000);
    opFinish(viewer); return;
  }

  if (!result.geometry.getAttribute("position") || result.geometry.getAttribute("position").count === 0) {
    ptPrompt("Boolean produced no geometry — ensure the two solids overlap in 3D.");
    setTimeout(() => ptClearPrompt(), 4000);
    opFinish(viewer); return;
  }

  const creator = tags[op];
  result.userData.kind = "brep";
  result.userData.creator = creator;
  viewer.getScene().remove(objA);
  viewer.getScene().remove(objB);
  viewer.addMesh(result, "brep", { noHistory: true });
  pushReplaceAction(result, [objA, objB], creator);
  opFinish(viewer);
}

function opShowBoolChooser(viewer: Viewer, objA: THREE.Object3D, objB: THREE.Object3D): void {
  const chooserEl = getChooserEl();
  if (!chooserEl) return;
  chooserEl.innerHTML = "";
  const label = document.createElement("div");
  label.className = "chooser-label";
  label.textContent = "Boolean operation:";
  chooserEl.appendChild(label);
  const ops: Array<["union" | "difference" | "split", string]> = [
    ["union",      "Union"],
    ["difference", "Difference (A − B)"],
    ["split",      "Split (A ∩ B)"],
  ];
  for (const [op, lbl] of ops) {
    const chip = document.createElement("button");
    chip.className = "chooser-chip";
    chip.textContent = lbl;
    chip.addEventListener("click", () => opExecBoolean(viewer, objA, objB, op));
    chooserEl.appendChild(chip);
  }
  chooserEl.classList.add("visible");
}

// ── Click handler ─────────────────────────────────────────────────────────────

export function opHandleClick(viewer: Viewer, clientX: number, clientY: number): boolean {
  const phase = _opPhase;
  if (!phase) return false;

  const world = unprojectToXY(viewer, clientX, clientY);
  const sv = nearestSnapVertex(viewer, clientX, clientY);
  const snapped3 = sv
    ? new THREE.Vector3(sv.x, sv.y, sv.z)
    : world ? (() => { const s = snapWorldForView(viewer, world); return new THREE.Vector3(s.x, s.y, s.z); })()
             : null;
  if (!snapped3 && phase.kind !== "extrude_select" && phase.kind !== "bool_a" && phase.kind !== "bool_b" && phase.kind !== "fillet_select" && phase.kind !== "fillet_edge" && phase.kind !== "fillet_edge_radius" && phase.kind !== "dim_a" && phase.kind !== "dim_volume" && phase.kind !== "label_pick" && phase.kind !== "tmeasure_a" && phase.kind !== "copy_select" && phase.kind !== "array_select") return false;

  if (phase.kind === "extrude_select") {
    // profileOnly=true limits raycast to CLICK_PROFILE_CREATORS (sketch curves +
    // extrude/boolean/brep results). Prevents accidentally extruding large structural
    // elements (walls, slabs) that share the scene floor level.
    const hit = opRaycastObject(viewer, clientX, clientY, true);
    if (!hit) { ptPrompt("Extrude — click a profile curve, solid, or surface  [Escape = cancel]"); return true; }
    const creator = (hit.obj.userData.creator as string | undefined) ?? "";
    const box = new THREE.Box3().setFromObject(hit.obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const ctr = new THREE.Vector3(); box.getCenter(ctr);
    opClearPreview(viewer);
    _selectHoverProfile = null;
    // Keep the profile visually highlighted during the height-setting phase so
    // the user can confirm which object was selected.
    opSetHover(hit.obj);
    _opPhase = { kind: "extrude_height", profile: hit.obj, cx: ctr.x, cy: ctr.y, w: size.x, d: size.y };
    ptPrompt(`Extrude height — profile: ${creator} — move cursor up/down to set height, click to commit  [Escape = cancel]`);
    return true;
  }

  if (phase.kind === "extrude_height") {
    const h = _opPreview ? (new THREE.Box3().setFromObject(_opPreview)).getSize(new THREE.Vector3()).z : 1;
    opClearPreview(viewer);
    const h2 = Math.max(0.05, h);
    const mesh = opBuildExtrudeMesh(phase.profile, h2);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "extrude";
    viewer.addMesh(mesh, "brep", { noHistory: true });
    _hooks.appendToCreateSequence(`// extrude h=${round(h2)} from profile creator=${phase.profile.userData.creator ?? "unknown"}`);
    pushAction(mesh, "extrude");
    opFinish(viewer);
    return true;
  }

  if (phase.kind === "bool_a") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Boolean — click first solid  (2D closed sketches auto-extrude to 3 m)"); return true; }
    let objA: THREE.Object3D = hit.obj;
    if (!(objA instanceof THREE.Mesh)) {
      const cr = objA.userData.creator as string | undefined;
      const isClosed = !!(objA.userData.isClosed as boolean | undefined);
      if (cr && (CLOSED_SKETCH_CREATORS.has(cr) || (cr === "curve" && isClosed))) {
        const extruded = opBuildExtrudeMesh(objA, 3.0);
        extruded.userData.creator = "extrude"; extruded.userData.kind = "brep";
        extruded.userData.autoExtrudedForBoolean = true;
        viewer.getScene().remove(objA);
        viewer.getScene().add(extruded);
        extruded.updateMatrixWorld(true);
        pushReplaceAction(extruded, [objA], "extrude");
        objA = extruded;
      } else {
        ptPrompt("Boolean needs 3D solids — open curves/lines can't be auto-extruded. Close the profile first or use a closed shape.");
        return true;
      }
    }
    opSetHover(null);
    const mA = objA as THREE.Mesh;
    _applyBoolHighlight(mA, 0x003399);
    _opPhase = { kind: "bool_b", objA };
    ptPrompt("Boolean — click the second solid (first highlighted in blue)");
    return true;
  }

  if (phase.kind === "bool_b") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit || hit.obj === phase.objA) { ptPrompt("Boolean — click a different second solid"); return true; }
    let objB: THREE.Object3D = hit.obj;
    if (!(objB instanceof THREE.Mesh)) {
      const cr = objB.userData.creator as string | undefined;
      const isClosed = !!(objB.userData.isClosed as boolean | undefined);
      if (cr && (CLOSED_SKETCH_CREATORS.has(cr) || (cr === "curve" && isClosed))) {
        const extruded = opBuildExtrudeMesh(objB, 3.0);
        extruded.userData.creator = "extrude"; extruded.userData.kind = "brep";
        extruded.userData.autoExtrudedForBoolean = true;
        viewer.getScene().remove(objB);
        viewer.getScene().add(extruded);
        extruded.updateMatrixWorld(true);
        pushReplaceAction(extruded, [objB], "extrude");
        objB = extruded;
      } else {
        ptPrompt("Boolean needs 3D solids — open curves/lines can't be auto-extruded. Close the profile first or use a closed shape.");
        return true;
      }
    }
    opSetHover(null);
    const mB = objB as THREE.Mesh;
    _applyBoolHighlight(mB, 0xcc6600);
    _opPhase = { kind: "bool_op", objA: phase.objA, objB };
    opShowBoolChooser(viewer, phase.objA, objB);
    ptPrompt("Boolean — choose operation");
    return true;
  }

  if (phase.kind === "bool_op") {
    return true;
  }

  if (phase.kind === "fillet_select") {
    const hit = opRaycastObject(viewer, clientX, clientY, false);
    if (!hit) { ptPrompt("Fillet — click a solid or a polyline/curve"); return true; }
    if (!(hit.obj instanceof THREE.Mesh) && !(hit.obj instanceof THREE.Line)) {
      ptPrompt("Fillet — click a solid mesh or 2D polyline/curve");
      return true;
    }
    opSetHover(null);
    if (hit.obj instanceof THREE.Mesh) {
      _opPhase = { kind: "fillet_edge", target: hit.obj as THREE.Mesh };
      ptPrompt("Fillet — hover an edge to highlight it, click to select");
    } else {
      _opPhase = { kind: "fillet_edge", target: hit.obj as THREE.Line };
      ptPrompt("Fillet — hover a corner vertex to highlight it, click to select");
    }
    return true;
  }

  if (phase.kind === "fillet_edge") {
    if (!_opHoverEdgePts) {
      ptPrompt(phase.target instanceof THREE.Line
        ? "Fillet — move cursor over a corner vertex first, then click"
        : "Fillet — move cursor over an edge first, then click");
      return true;
    }
    const [edgeA, edgeB] = _opHoverEdgePts;
    const cornerV = _opHoverCornerPts ? _opHoverCornerPts[1] : undefined;
    opClearPreview(viewer);
    _opHoverEdgePts = null;
    _opHoverCornerPts = null;
    opSetHover(null);
    _opPhase = { kind: "fillet_edge_radius", target: phase.target, edgeA, edgeB, cornerV };
    ptPrompt("Fillet radius — type a value and press Enter");
    ptShowCoordInput("radius");
    return true;
  }

  if (phase.kind === "fillet_edge_radius") {
    return true; // consume click; user should be typing in coord input
  }

  if (phase.kind === "label_pick") {
    if (!snapped3) return true;
    _opPhase = { kind: "label_text", pt: snapped3 };
    ptPrompt("Label — type text and press Enter");
    ptShowCoordInput("label text");
    return true;
  }

  if (phase.kind === "tmeasure_a") {
    if (!snapped3) return true;
    _opPhase = { kind: "tmeasure_b", ptA: snapped3 };
    ptPrompt("Transient Measure — click second point");
    return true;
  }

  if (phase.kind === "tmeasure_b" && snapped3) {
    const dist = snapped3.distanceTo(phase.ptA);
    const mid = phase.ptA.clone().add(snapped3).multiplyScalar(0.5);
    opClearPreview(viewer);
    _opPreview = opBuildAnnotLine([phase.ptA, snapped3]);
    viewer.getScene().add(_opPreview);
    opAddLabel(`${formatLength(dist)}`, mid, viewer);
    opFinish(viewer);
    return true;
  }

  if (phase.kind === "dim_a") {
    if (!snapped3) return true;
    if (phase.tool === "volume-dim") {
      const hit = opRaycastObject(viewer, clientX, clientY);
      const target = hit?.obj ?? null;
      if (!target) { ptPrompt("Volume — click an object to measure"); return true; }
      const box = new THREE.Box3().setFromObject(target);
      const size = new THREE.Vector3(); box.getSize(size);
      const vol = size.x * size.y * size.z;
      const ctr = new THREE.Vector3(); box.getCenter(ctr);
      opAddLabel(`Vol: ${formatVolume(vol)}`, ctr, viewer);
      opFinish(viewer);
      return true;
    }
    if (phase.tool === "area-dim") {
      _opPhase = { kind: "dim_area", tool: "area-dim", pts: [snapped3] };
      ptPrompt(`Area — click more points  [1 point placed, Enter to compute]`);
      return true;
    }
    if (phase.tool === "aligned-dim") {
      _opPhase = { kind: "dim_b", tool: "aligned-dim", ptA: snapped3 };
      ptPrompt("Aligned dimension — click second point");
      return true;
    }
    if (phase.tool === "angular-dim") {
      _opPhase = { kind: "dim_c", tool: "angular-dim", ptA: snapped3, ptB: snapped3.clone() };
      ptPrompt("Angular dimension — click first ray point");
      return true;
    }
    return true;
  }

  if (phase.kind === "dim_b" && snapped3) {
    const dist = snapped3.distanceTo(phase.ptA);
    const mid = phase.ptA.clone().add(snapped3).multiplyScalar(0.5);
    const grp = new THREE.Group();
    grp.add(opBuildAnnotLine([phase.ptA, snapped3]));
    grp.userData.creator = "IfcAnnotationDimension";
    const labelEl = opBuildDimLabel(formatLength(dist), mid, viewer);
    grp.userData.dimLabelEls = [labelEl];
    viewer.addMesh(grp, "dim");
    opFinish(viewer);
    return true;
  }

  if (phase.kind === "dim_c" && snapped3) {
    if (phase.ptA.equals(phase.ptB)) {
      _opPhase = { kind: "dim_c", tool: "angular-dim", ptA: phase.ptA, ptB: snapped3 };
      ptPrompt("Angular dimension — click second ray point");
    } else {
      const v1 = phase.ptB.clone().sub(phase.ptA).normalize();
      const v2 = snapped3.clone().sub(phase.ptA).normalize();
      const angleDeg = Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))) * 180 / Math.PI;
      const grp = new THREE.Group();
      grp.add(opBuildAnnotLine([phase.ptA, phase.ptB]));
      grp.add(opBuildAnnotLine([phase.ptA, snapped3]));
      grp.userData.creator = "IfcAnnotationDimension";
      const labelEl = opBuildDimLabel(`${angleDeg.toFixed(1)}°`, phase.ptA, viewer);
      grp.userData.dimLabelEls = [labelEl];
      viewer.addMesh(grp, "dim");
      opFinish(viewer);
    }
    return true;
  }

  if (phase.kind === "dim_area" && snapped3) {
    phase.pts.push(snapped3);
    ptPrompt(`Area — ${phase.pts.length} points placed, Enter to compute or click more`);
    return true;
  }

  if (phase.kind === "sel_window_sub" || phase.kind === "sel_lasso_sub" || phase.kind === "sel_boundary_sub") {
    const chooserEl = getChooserEl();
    const under = document.elementFromPoint(clientX, clientY);
    if (chooserEl && chooserEl.contains(under)) return true;
    if (_rawChooserDefault) { _rawChooserDefault(); _rawChooserDefault = null; }
    if (chooserEl) { chooserEl.classList.remove("visible"); chooserEl.innerHTML = ""; }
    if (_opPhase?.kind === "sel_window") {
      _selDragging = true;
      _opPhase.startX = clientX;
      _opPhase.startY = clientY;
    } else if (_opPhase?.kind === "sel_lasso") {
      _selDragging = true;
      _opPhase.points = [{ x: clientX, y: clientY }];
    }
    return true;
  }

  if (phase.kind === "sel_boundary_pick") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Boundary Select — click a closed curve or shape"); return true; }
    const box = new THREE.Box3().setFromObject(hit.obj);
    const corners: [number, number, number][] = [
      [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
      [box.max.x, box.max.y, box.min.z], [box.min.x, box.max.y, box.min.z],
    ];
    const poly = corners.map(([x, y, z]) => {
      const s = projectToScreen(viewer, x, y, z);
      return s ? { x: s.x, y: s.y } : null;
    }).filter((p): p is { x: number; y: number } => p !== null);
    if (poly.length >= 3) {
      _hooks.runPolySel(viewer, poly, "crossing");
      setTimeout(() => { _hooks.removeSelOverlay(); opFinish(viewer); }, 600);
    } else {
      ptPrompt("Boundary Select — could not extract boundary; try a different object");
    }
    return true;
  }

  if (phase.kind === "sel_boundary_draw") {
    const world2 = unprojectToXY(viewer, clientX, clientY);
    if (!world2) return true;
    const s = projectToScreen(viewer, world2.x, world2.y, 0);
    if (!s) return true;
    phase.points.push({ x: s.x, y: s.y });
    const svg = _hooks.getSelOverlay(viewer);
    _hooks.clearSelOverlay();
    const canvas = viewer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    if (phase.points.length >= 2) {
      const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("points", phase.points.map(p => `${p.x - rect.left},${p.y - rect.top}`).join(" "));
      pl.setAttribute("fill", "rgba(68,170,255,0.12)");
      pl.setAttribute("stroke", "#4af"); pl.setAttribute("stroke-width", "1.5");
      svg.appendChild(pl);
      if (phase.points.length >= 3) {
        const cl = document.createElementNS("http://www.w3.org/2000/svg", "line");
        const last = phase.points[phase.points.length - 1];
        cl.setAttribute("x1", String(last.x - rect.left)); cl.setAttribute("y1", String(last.y - rect.top));
        cl.setAttribute("x2", String(phase.points[0].x - rect.left)); cl.setAttribute("y2", String(phase.points[0].y - rect.top));
        cl.setAttribute("stroke", "#4af"); cl.setAttribute("stroke-width", "1"); cl.setAttribute("stroke-dasharray", "3 3");
        svg.appendChild(cl);
      }
    }
    ptPrompt(`Boundary Select — ${phase.points.length} point${phase.points.length > 1 ? "s" : ""}  [Enter] close & select`);
    return true;
  }

  if (phase.kind === "copy_select") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Copy — click an object to copy"); return true; }
    opSetHover(null);
    viewer.selectObject(hit.obj);
    const ctr = new THREE.Vector3(); new THREE.Box3().setFromObject(hit.obj).getCenter(ctr);
    _opPhase = { kind: "copy_place", source: hit.obj, srcPt: ctr };
    ptPrompt("Copy — click destination point  or type  dx dy [dz]  [Esc] cancel");
    ptShowCoordInput("dx dy  or  dx dy dz");
    return true;
  }

  if (phase.kind === "copy_place") {
    if (!snapped3) return true;
    opClearPreview(viewer);
    const dx = round(snapped3.x - phase.srcPt.x);
    const dy = round(snapped3.y - phase.srcPt.y);
    const dz = round(snapped3.z - phase.srcPt.z);
    dispatchSync("SdCopy", { target: phase.source.uuid, x: dx, y: dy, z: dz });
    opFinish(viewer);
    return true;
  }

  if (phase.kind === "array_select") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Array — click an object to array"); return true; }
    opSetHover(null);
    viewer.selectObject(hit.obj);
    _opPhaseStartArray(hit.obj);
    return true;
  }

  if (phase.kind === "array_linear_base") {
    if (!snapped3) return true;
    _opPhase = { kind: "array_linear_dir", source: phase.source, basePt: snapped3.clone() };
    ptPrompt("Linear Array — click direction + distance endpoint  [Esc] cancel");
    return true;
  }

  if (phase.kind === "array_linear_dir") {
    if (!snapped3) return true;
    const dx = round(snapped3.x - phase.basePt.x);
    const dy = round(snapped3.y - phase.basePt.y);
    const dz = round(snapped3.z - phase.basePt.z);
    if (dx === 0 && dy === 0 && dz === 0) { ptPrompt("Linear Array — endpoint must differ from base point"); return true; }
    _opPhase = { kind: "array_linear_count", source: phase.source, dx, dy, dz };
    ptPrompt(`Linear Array — step (${dx}, ${dy}${dz !== 0 ? `, ${dz}` : ""})  —  type total count  [Esc] cancel`);
    ptShowCoordInput("count");
    return true;
  }

  if (phase.kind === "array_curve_pick") {
    const hit = opRaycastObject(viewer, clientX, clientY, false);
    if (!hit) { ptPrompt("Along Curve — click a curve or polyline  [Esc] cancel"); return true; }
    const curvePts = _extractCurvePoints(hit.obj);
    if (!curvePts) {
      ptPrompt("Along Curve — click a line, polyline, or curve object  [Esc] cancel");
      return true;
    }
    _opPhase = { kind: "array_curve_count", source: phase.source, curvePts };
    const len = round(_curveLength(curvePts));
    ptPrompt(`Along Curve — path ${len}m — type count  [Esc] cancel`);
    ptShowCoordInput("count");
    return true;
  }

  if (phase.kind === "array_polar_center") {
    if (!snapped3) return true;
    _opPhase = { kind: "array_polar_count", source: phase.source, cx: round(snapped3.x), cy: round(snapped3.y) };
    ptPrompt(`Polar Array — center (${round(snapped3.x)}, ${round(snapped3.y)})  —  type: count  [angle°]  [Esc] cancel`);
    ptShowCoordInput("count  or  count angle°");
    return true;
  }

  if (phase.kind === "array_polar_count") {
    return true; // waiting for coord input — ignore clicks
  }

  if (phase.kind === "array_rect_base") {
    if (!snapped3) return true;
    _opPhase = { kind: "array_rect_dir_x", source: phase.source, basePt: snapped3.clone() };
    ptPrompt("Rectangular Array — click X-direction endpoint  [Esc] cancel");
    return true;
  }

  if (phase.kind === "array_rect_dir_x") {
    if (!snapped3) return true;
    const dx = round(snapped3.x - phase.basePt.x);
    if (dx === 0) { ptPrompt("Rectangular Array — X-step cannot be zero, click a point along X  [Esc] cancel"); return true; }
    _opPhase = { kind: "array_rect_dir_y", source: phase.source, basePt: phase.basePt, dx };
    ptPrompt(`Rectangular Array — X-step ${dx}  —  click Y-direction endpoint  [Esc] cancel`);
    return true;
  }

  if (phase.kind === "array_rect_dir_y") {
    if (!snapped3) return true;
    const dy = round(snapped3.y - phase.basePt.y);
    if (dy === 0) { ptPrompt("Rectangular Array — Y-step cannot be zero, click a point along Y  [Esc] cancel"); return true; }
    _opPhase = { kind: "array_rect_count", source: phase.source, dx: phase.dx, dy };
    ptPrompt(`Rectangular Array — X-step ${phase.dx}, Y-step ${dy}  —  type: rows  cols  [Esc] cancel`);
    ptShowCoordInput("rows cols");
    return true;
  }

  if (phase.kind === "array_rect_count") {
    return true; // waiting for coord input — ignore clicks
  }

  return false;
}

// ── Enter handler ─────────────────────────────────────────────────────────────

export function opHandleEnter(viewer: Viewer): void {
  const phase = _opPhase;
  if (!phase) return;

  if (phase.kind === "sel_window_sub" || phase.kind === "sel_lasso_sub" || phase.kind === "sel_boundary_sub") {
    const chooserEl = getChooserEl();
    if (_rawChooserDefault) { _rawChooserDefault(); _rawChooserDefault = null; }
    if (chooserEl) { chooserEl.classList.remove("visible"); chooserEl.innerHTML = ""; }
    return;
  }

  if (phase.kind === "sel_boundary_draw" && phase.points.length >= 3) {
    _hooks.removeSelOverlay();
    _hooks.runPolySel(viewer, phase.points, "crossing");
    setTimeout(() => opFinish(viewer), 600);
    return;
  }

  if (phase.kind === "dim_area" && phase.pts.length >= 3) {
    let area = 0;
    const pts = phase.pts;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y;
      area -= pts[j].x * pts[i].y;
    }
    area = Math.abs(area) / 2;
    const ctr = pts.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const grp = new THREE.Group();
    grp.add(opBuildAnnotLine([...pts, pts[0]]));
    grp.userData.creator = "IfcAnnotationDimension";
    const labelEl = opBuildDimLabel(`Area: ${formatArea(area)}`, ctr, viewer);
    grp.userData.dimLabelEls = [labelEl];
    viewer.addMesh(grp, "dim");
    opFinish(viewer);
    return;
  }

  if (phase.kind === "fillet_radius" || phase.kind === "fillet_edge_radius") {
    ptPrompt("Fillet radius — type a value and press Enter");
    return;
  }

  if (phase.kind === "label_text") {
    ptPrompt("Label — type text and press Enter");
    return;
  }
}

// ── Coord-input submit ────────────────────────────────────────────────────────

export function opHandleCoordSubmit(viewer: Viewer, raw: string): void {
  const phase = _opPhase;
  if (!phase) return;
  if (phase.kind === "fillet_radius") {
    const r = parseFloat(raw);
    if (!Number.isFinite(r) || r <= 0) { ptPrompt("Fillet radius — enter a positive number"); return; }
    const target = phase.target;
    if (!(target instanceof THREE.Mesh)) {
      ptPrompt("Fillet — selected object is not a mesh");
      setTimeout(() => opFinish(viewer), 800);
      return;
    }
    const filleted = filletMesh(target, r);
    viewer.getScene().remove(target); // audit-undo-ok: tracked by pushReplaceAction below
    viewer.addMesh(filleted, "brep", { noHistory: true });
    pushReplaceAction(filleted, [target], "fillet");
    ptPrompt(`Fillet r=${formatLength(r)} applied`);
    setTimeout(() => opFinish(viewer), 400);
  }

  if (phase.kind === "fillet_edge_radius") {
    const r = parseFloat(raw);
    if (!Number.isFinite(r) || r <= 0) { ptPrompt("Fillet radius — enter a positive number"); return; }

    if (phase.target instanceof THREE.Line && phase.cornerV) {
      // 2D polyline corner fillet
      opApply2DFillet(viewer, phase.target, phase.edgeA, phase.cornerV, phase.edgeB, r);
      ptPrompt(`Fillet r=${formatLength(r)} applied`);
      setTimeout(() => opFinish(viewer), 400);
      return;
    }

    // 3D solid edge fillet — resolve edgeId from world-space endpoints.
    const meshTarget = phase.target as THREE.Mesh;
    const invMat = meshTarget.matrixWorld.clone().invert();
    const localA = phase.edgeA.clone().applyMatrix4(invMat);
    const localB = phase.edgeB.clone().applyMatrix4(invMat);
    const edges = getUniqueEdges(meshTarget);
    const EPS_ID = 1e-3;
    const edgeId = edges.findIndex(([ea, eb]) =>
      (ea.distanceTo(localA) < EPS_ID && eb.distanceTo(localB) < EPS_ID) ||
      (ea.distanceTo(localB) < EPS_ID && eb.distanceTo(localA) < EPS_ID),
    );
    if (edgeId >= 0) {
      const res = dispatchSync("SdFillet", { target: meshTarget.uuid, edgeId, radius: r }) as { error?: string } | null;
      if (res?.error) {
        ptPrompt(`Fillet — ${res.error.replace(/^SdFillet — /, "")}`);
        setTimeout(() => opFinish(viewer), 1400);
        return;
      }
    } else {
      // Fallback: direct chamfer when edge not found in enumeration.
      const filleted = chamferEdge(meshTarget, phase.edgeA, phase.edgeB, r);
      if (filleted.userData._chamferError) {
        ptPrompt("Fillet — edge cannot be chamfered (curved or non-manifold surface); select a straight edge on a flat face");
        setTimeout(() => opFinish(viewer), 1600);
        return;
      }
      viewer.getScene().remove(meshTarget); // audit-undo-ok: tracked by pushReplaceAction below
      viewer.addMesh(filleted, "brep", { noHistory: true });
      pushReplaceAction(filleted, [meshTarget], "fillet");
    }
    ptPrompt(`Fillet r=${formatLength(r)} applied`);
    setTimeout(() => opFinish(viewer), 400);
  }

  if (phase.kind === "label_text") {
    const text = raw.trim();
    if (!text) { ptPrompt("Label — type text for the label"); return; }
    opAddLabel(text, phase.pt, viewer);
    opFinish(viewer);
  }

  if (phase.kind === "copy_place") {
    const nums = raw.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    if (nums.length < 2) { ptPrompt("Copy — type: dx dy [dz]"); return; }
    const [dx, dy, dz = 0] = nums;
    opClearPreview(viewer);
    dispatchSync("SdCopy", { target: phase.source.uuid, x: round(dx), y: round(dy), z: round(dz) });
    opFinish(viewer);
  }

  if (phase.kind === "array_linear_params") {
    const nums = raw.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    if (nums.length < 3) { ptPrompt("Linear Array — type: count  dx  dy  [dz]"); return; }
    const [count, dx, dy, dz = 0] = nums;
    dispatchSync("SdArrayLinear", { target: phase.source.uuid, count: Math.max(1, Math.round(count)), dx: round(dx), dy: round(dy), dz: round(dz) });
    opFinish(viewer);
  }

  if (phase.kind === "array_grid_params") {
    const nums = raw.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    if (nums.length < 4) { ptPrompt("Grid Array — type: rows  cols  dx  dy"); return; }
    const [rows, cols, dx, dy] = nums;
    dispatchSync("SdArrayGrid", { target: phase.source.uuid, rows: Math.max(1, Math.round(rows)), cols: Math.max(1, Math.round(cols)), dx: round(dx), dy: round(dy) });
    opFinish(viewer);
  }

  if (phase.kind === "array_polar_params") {
    const nums = raw.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    if (nums.length < 1) { ptPrompt("Polar Array — type: count  [cx  cy]"); return; }
    const [count, cx = 0, cy = 0] = nums;
    dispatchSync("SdArrayPolar", { target: phase.source.uuid, count: Math.max(2, Math.round(count)), cx: round(cx), cy: round(cy) });
    opFinish(viewer);
  }

  if (phase.kind === "array_linear_count") {
    const n = Math.round(Number(raw.trim()));
    if (isNaN(n) || n < 1) { ptPrompt("Linear Array — type a positive count number"); return; }
    dispatchSync("SdArrayLinear", { target: phase.source.uuid, count: n, dx: phase.dx, dy: phase.dy, dz: phase.dz });
    opFinish(viewer);
  }

  if (phase.kind === "array_curve_count") {
    const n = Math.round(Number(raw.trim()));
    if (isNaN(n) || n < 2) { ptPrompt("Along Curve — type count (min 2)"); return; }
    const src = phase.source;
    const srcCtr = new THREE.Vector3();
    new THREE.Box3().setFromObject(src).getCenter(srcCtr);
    const positions = _sampleAlongCurve(phase.curvePts, n);
    for (const pos of positions) {
      dispatchSync("SdCopy", {
        target: src.uuid,
        x: round(pos.x - srcCtr.x),
        y: round(pos.y - srcCtr.y),
        z: round(pos.z - srcCtr.z),
      });
    }
    opFinish(viewer);
  }

  if (phase.kind === "array_polar_count") {
    const nums = raw.trim().split(/[\s,]+/).map(Number).filter(x => !isNaN(x));
    const n = Math.round(nums[0] ?? NaN);
    const angle = nums[1] ?? 360;
    if (isNaN(n) || n < 2) { ptPrompt("Polar Array — type total count (min 2)"); return; }
    dispatchSync("SdArrayPolar", { target: phase.source.uuid, count: n, cx: phase.cx, cy: phase.cy, angle });
    opFinish(viewer);
  }

  if (phase.kind === "array_rect_count") {
    const nums = raw.trim().split(/[\s,]+/).map(Number).filter(n => !isNaN(n));
    if (nums.length < 2) { ptPrompt("Rectangular Array — type: rows  cols"); return; }
    const [rows, cols] = nums;
    dispatchSync("SdArrayGrid", { target: phase.source.uuid, rows: Math.max(1, Math.round(rows)), cols: Math.max(1, Math.round(cols)), dx: phase.dx, dy: phase.dy });
    opFinish(viewer);
  }
}

// ── Start tool ────────────────────────────────────────────────────────────────

export function opStartTool(viewer: Viewer, tool: string): void {
  opClearPreview(viewer);
  opClearLabels();
  opSetHover(null);
  _opPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  viewer.setOpToolActive(true);
  viewer.setGumballEnabled(false);
  // Clear any prior selection so the gumball doesn't persist into the op phase.
  // Skip for copy/array which need the current selection as their source object.
  if (tool !== "copy" && tool !== "array") viewer.deselectCurrent();

  if (tool === "extrude") {
    _opPhase = { kind: "extrude_select" };
    ptPrompt("Extrude — click a profile curve, solid, or surface  [Escape = cancel]");
  } else if (tool === "boolean") {
    _opPhase = { kind: "bool_a" };
    ptPrompt("Boolean — click first solid  (2D closed sketches auto-extrude to 3 m)");
  } else if (tool === "fillet") {
    _opPhase = { kind: "fillet_select" };
    ptPrompt("Fillet — click a solid mesh or a polyline/curve corner  [Escape = cancel]");
  } else if (tool === "aligned-dim" || tool === "angular-dim" || tool === "area-dim" || tool === "volume-dim") {
    const t = tool as "aligned-dim" | "angular-dim" | "area-dim" | "volume-dim";
    _opPhase = { kind: "dim_a", tool: t };
    const msg: Record<string, string> = {
      "aligned-dim":  "Aligned dimension — click first point",
      "angular-dim":  "Angular dimension — click vertex point",
      "area-dim":     "Area — click points to define polygon, Enter to compute",
      "volume-dim":   "Volume — click an object to measure",
    };
    ptPrompt(msg[tool] ?? "Click to begin");
  } else if (tool === "sel-window") {
    _opPhase = { kind: "sel_window_sub" };
    const activateWindow = (sub: "crossing" | "window") => {
      _opPhase = { kind: "sel_window", subMode: sub, startX: -1, startY: -1 };
      ptPrompt(`Window Select (${sub === "crossing" ? "Crossing" : "Window"}) — click and drag to define selection window  [Esc] cancel`);
    };
    showRawChooser("Window Select:", [
      { label: "Crossing", description: "Objects that cross or are inside the window", onSelect: () => activateWindow("crossing") },
      { label: "Window",   description: "Objects fully inside the window",              onSelect: () => activateWindow("window") },
    ], () => activateWindow("crossing"));
    ptPrompt("Window Select — choose mode above  [Enter=Crossing]");
  } else if (tool === "sel-lasso") {
    _opPhase = { kind: "sel_lasso_sub" };
    const activateLasso = (sub: "crossing" | "window") => {
      _opPhase = { kind: "sel_lasso", subMode: sub, points: [] };
      ptPrompt(`Lasso Select (${sub === "crossing" ? "Crossing" : "Window"}) — click and drag to draw lasso  [Esc] cancel`);
    };
    showRawChooser("Lasso Select:", [
      { label: "Crossing", description: "Objects that cross or are inside the lasso", onSelect: () => activateLasso("crossing") },
      { label: "Window",   description: "Objects fully inside the lasso",              onSelect: () => activateLasso("window") },
    ], () => activateLasso("crossing"));
    ptPrompt("Lasso Select — choose mode above  [Enter=Crossing]");
  } else if (tool === "label") {
    _opPhase = { kind: "label_pick" };
    ptPrompt("Label — click a point in the scene");
  } else if (tool === "transient-measure") {
    _opPhase = { kind: "tmeasure_a" };
    ptPrompt("Transient Measure — click first point");
  } else if (tool === "sel-boundary") {
    _opPhase = { kind: "sel_boundary_sub" };
    showRawChooser("Boundary input:", [
      { label: "Pick Curve",   description: "Click a closed curve/surface in the scene", onSelect: () => {
        _opPhase = { kind: "sel_boundary_pick" };
        ptPrompt("Boundary Select — click a closed curve in the scene  [Esc] cancel");
      }},
      { label: "Draw Polygon", description: "Click points to define boundary, Enter to close & select", onSelect: () => {
        _opPhase = { kind: "sel_boundary_draw", points: [] };
        ptPrompt("Boundary Select — click points to define polygon  [Enter] close & select  [Esc] cancel");
      }},
    ], () => {
      _opPhase = { kind: "sel_boundary_draw", points: [] };
      ptPrompt("Boundary Select — click points to define polygon  [Enter] close & select  [Esc] cancel");
    });
    ptPrompt("Boundary Select — choose input method above  [Enter=Draw Polygon]");
  } else if (tool === "copy") {
    const sel = ptGetTarget() ?? viewer.getTargetObject();
    if (sel) {
      const ctr = new THREE.Vector3(); new THREE.Box3().setFromObject(sel).getCenter(ctr);
      _opPhase = { kind: "copy_place", source: sel, srcPt: ctr };
      ptPrompt("Copy — click destination point  or type  dx dy [dz]  [Esc] cancel");
      ptShowCoordInput("dx dy  or  dx dy dz");
    } else {
      _opPhase = { kind: "copy_select" };
      ptPrompt("Copy — click an object to copy");
    }
  } else if (tool === "array") {
    const sel = ptGetTarget() ?? viewer.getTargetObject();
    if (sel) {
      _opPhaseStartArray(sel);
    } else {
      _opPhase = { kind: "array_select" };
      ptPrompt("Array — click an object to array");
    }
  }
}

function _extractCurvePoints(obj: THREE.Object3D): THREE.Vector3[] | null {
  if (!(obj instanceof THREE.Line)) return null;
  const pos = obj.geometry.attributes["position"] as THREE.BufferAttribute | undefined;
  if (!pos) return null;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld));
  }
  return pts.length >= 2 ? pts : null;
}

function _curveLength(pts: THREE.Vector3[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  return len;
}

function _sampleAlongCurve(pts: THREE.Vector3[], count: number): THREE.Vector3[] {
  const segs: number[] = [0];
  for (let i = 1; i < pts.length; i++) segs.push(segs[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = segs[segs.length - 1];
  const result: THREE.Vector3[] = [];
  const n = Math.max(2, count);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * total;
    let si = 0;
    while (si < segs.length - 2 && segs[si + 1] < t) si++;
    const segLen = segs[si + 1] - segs[si];
    const alpha = segLen > 0 ? (t - segs[si]) / segLen : 0;
    result.push(pts[si].clone().lerp(pts[Math.min(si + 1, pts.length - 1)], Math.min(1, alpha)));
  }
  return result;
}

function _opPhaseStartArray(source: THREE.Object3D): void {
  showRawChooser("Array mode:", [
    { label: "Linear",       description: "Repeat along direction — pick base + endpoint + count",
      onSelect: () => {
        _opPhase = { kind: "array_linear_base", source };
        ptPrompt("Linear Array — click base point  [Esc] cancel");
      }},
    { label: "Rectangular",  description: "Rows × columns — click base, X-dir, Y-dir, then type rows cols",
      onSelect: () => {
        _opPhase = { kind: "array_rect_base", source };
        ptPrompt("Rectangular Array — click base point  [Esc] cancel");
      }},
    { label: "Polar",        description: "Circular pattern — click center, then type total count",
      onSelect: () => {
        _opPhase = { kind: "array_polar_center", source };
        ptPrompt("Polar Array — click center of rotation  [Esc] cancel");
      }},
    { label: "Along Curve",  description: "Distribute along an existing curve — click curve + count",
      onSelect: () => {
        _opPhase = { kind: "array_curve_pick", source };
        ptPrompt("Along Curve — click a curve or polyline  [Esc] cancel");
      }},
  ], () => {
    _opPhase = { kind: "array_linear_base", source };
    ptPrompt("Linear Array — click base point  [Esc] cancel");
  });
  ptPrompt("Array — choose mode  [Enter = Linear]");
}
