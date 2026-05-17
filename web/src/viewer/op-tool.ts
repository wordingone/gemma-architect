// Op-tool state machine — extrude, boolean, fillet, annotations, selection modes.
// Extracted from create-mode.ts (#723).
// Does NOT import from selection-ops.ts — runPolySel/overlay fns injected via registerOpToolHooks.

import * as THREE from "three";
import { csgUnion, csgDifference, csgIntersection } from "./csg";
import type { Viewer } from "./viewer";
import { getSnap } from "./snap-state";
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

// Creators that are valid extrude profiles.
export const EXTRUDABLE_CREATORS = new Set([
  "rect", "circle", "polygon", "polyline", "curve", "line",
  "wall", "slab", "column", "box", "beam", "roof", "space",
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
  | { kind: "dim_volume";  tool: "volume-dim" };

let _opPhase: OpPhase | null = null;
let _opPreview: THREE.Object3D | null = null;
let _opLabels: HTMLElement[] = [];
let _rawChooserDefault: (() => void) | null = null;
export let _selDragging = false;

export function getOpPhase(): OpPhase | null { return _opPhase; }
export function setSelDragging(v: boolean): void { _selDragging = v; }

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

export function opFinish(viewer: Viewer): void {
  opClearPreview(viewer);
  opSetHover(null);
  _opPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  _hooks.hideCursorDot();
  _hooks.clearSketchShiftLine(viewer);
  setChooserHint(null);
  _hooks.removeSelOverlay();
  _rawChooserDefault = null;
  _selDragging = false;
  viewer.setGumballEnabled(true);
  dispatchSync("setActiveTool", { toolId: "select" });
}

export function opCancel(viewer: Viewer): void {
  opSetHover(null);
  const restoreEmissive = (obj: THREE.Object3D) => {
    const m = obj as THREE.Mesh;
    if (m.userData._savedEmissive !== undefined) {
      ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color)
        .setHex(m.userData._savedEmissive as number);
      delete m.userData._savedEmissive;
    }
  };
  if (_opPhase?.kind === "bool_b") restoreEmissive(_opPhase.objA);
  if (_opPhase?.kind === "bool_op") { restoreEmissive(_opPhase.objA); restoreEmissive(_opPhase.objB); }
  opFinish(viewer);
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
  }
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

  const hitThresh = hoverMode ? 20 : 10;
  let thinHit: { obj: THREE.Object3D; point: THREE.Vector3 } | null = null;
  let thinHitD = hitThresh;
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap) return;
    if (profileOnly && !EXTRUDABLE_CREATORS.has(o.userData.creator ?? "")) return;
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

  const meshes: THREE.Mesh[] = [];
  viewer.getScene().traverse((o) => {
    const isDisplay = !!o.userData.isJoinDisplay;
    if (o.userData.noSnap && !isDisplay) return;
    if (!o.visible && !isDisplay) return;
    if (!(o instanceof THREE.Mesh)) return;
    if (!o.geometry?.getAttribute("position")) return;
    if (profileOnly && !EXTRUDABLE_CREATORS.has(o.userData.creator ?? "")) return;
    meshes.push(o);
  });
  const hits = rc.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
  return { obj: hit.object, point: hit.point.clone() };
}

export function opPhaseIsObjectSelect(phase: OpPhase): boolean {
  switch (phase.kind) {
    case "extrude_select":
    case "bool_a":
    case "bool_b":
    case "bool_op":
    case "fillet_select":
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

// ── Boolean operation ─────────────────────────────────────────────────────────

function opExecBoolean(viewer: Viewer, objA: THREE.Object3D, objB: THREE.Object3D, op: "union" | "difference" | "split"): void {
  const restoreEmissive = (obj: THREE.Object3D) => {
    const m = obj as THREE.Mesh;
    if (m.userData._savedEmissive !== undefined) {
      ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color).setHex(m.userData._savedEmissive as number);
      delete m.userData._savedEmissive;
    }
  };
  restoreEmissive(objA); restoreEmissive(objB);

  if (!(objA instanceof THREE.Mesh) || !(objB instanceof THREE.Mesh)) {
    ptPrompt("Boolean — both objects must be solid meshes, not curves or points");
    setTimeout(() => ptClearPrompt(), 2000);
    opFinish(viewer); return;
  }
  const mA = objA as THREE.Mesh;
  const mB = objB as THREE.Mesh;

  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const tags: Record<string, string> = { union: "boolean-union", difference: "boolean-difference", split: "boolean-split" };

  let result: THREE.Mesh;
  try {
    if      (op === "union")      result = csgUnion(mA, mB, mat);
    else if (op === "difference") result = csgDifference(mA, mB, mat);
    else                          result = csgIntersection(mA, mB, mat);
  } catch {
    ptPrompt("Boolean failed — geometry may be degenerate or non-manifold");
    setTimeout(() => ptClearPrompt(), 2500);
    opFinish(viewer); return;
  }

  if (!result.geometry.getAttribute("position") || result.geometry.getAttribute("position").count === 0) {
    ptPrompt("Boolean produced empty result — objects may not overlap");
    setTimeout(() => ptClearPrompt(), 2500);
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
  if (!snapped3 && phase.kind !== "extrude_select" && phase.kind !== "bool_a" && phase.kind !== "bool_b" && phase.kind !== "fillet_select" && phase.kind !== "dim_a" && phase.kind !== "dim_volume") return false;

  if (phase.kind === "extrude_select") {
    const hit = opRaycastObject(viewer, clientX, clientY, true);
    if (!hit) { ptPrompt("Extrude — click a curve, rectangle, circle, or polygon profile"); return true; }
    const box = new THREE.Box3().setFromObject(hit.obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const ctr = new THREE.Vector3(); box.getCenter(ctr);
    opSetHover(null);
    _opPhase = { kind: "extrude_height", profile: hit.obj, cx: ctr.x, cy: ctr.y, w: size.x, d: size.y };
    ptPrompt("Extrude height — move cursor up/down to set height, click to commit");
    return true;
  }

  if (phase.kind === "extrude_height") {
    const h = _opPreview ? (new THREE.Box3().setFromObject(_opPreview)).getSize(new THREE.Vector3()).z : 1;
    opClearPreview(viewer);
    const h2 = Math.max(0.05, h);
    const mesh = opBuildExtrudeMesh(phase.profile, h2);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "extrude";
    viewer.addMesh(mesh, "brep");
    _hooks.appendToCreateSequence(`// extrude h=${round(h2)} from profile creator=${phase.profile.userData.creator ?? "unknown"}`);
    pushAction(mesh, "extrude");
    opFinish(viewer);
    return true;
  }

  if (phase.kind === "bool_a") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Boolean — click the first solid"); return true; }
    opSetHover(null);
    const m = hit.obj as THREE.Mesh;
    if (m.material && !Array.isArray(m.material) && (m.material as THREE.MeshStandardMaterial).emissive) {
      m.userData._savedEmissive = ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color).getHex();
      ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color).setHex(0x003399);
    }
    _opPhase = { kind: "bool_b", objA: hit.obj };
    ptPrompt("Boolean — click the second solid (selected: first highlighted)");
    return true;
  }

  if (phase.kind === "bool_b") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit || hit.obj === phase.objA) { ptPrompt("Boolean — click a different second solid"); return true; }
    const objB = hit.obj;
    const mB = objB as THREE.Mesh;
    if (mB.material && !Array.isArray(mB.material) && (mB.material as THREE.MeshStandardMaterial).emissive) {
      mB.userData._savedEmissive = ((mB.material as THREE.MeshStandardMaterial).emissive as THREE.Color).getHex();
      ((mB.material as THREE.MeshStandardMaterial).emissive as THREE.Color).setHex(0x330033);
    }
    _opPhase = { kind: "bool_op", objA: phase.objA, objB };
    opShowBoolChooser(viewer, phase.objA, objB);
    ptPrompt("Boolean — choose operation");
    return true;
  }

  if (phase.kind === "bool_op") {
    return true;
  }

  if (phase.kind === "fillet_select") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Fillet — click an edge, corner, or object"); return true; }
    _opPhase = { kind: "fillet_radius", target: hit.obj };
    ptPrompt("Fillet radius — type a value and press Enter");
    ptShowCoordInput("radius");
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

  if (phase.kind === "fillet_radius") {
    ptPrompt("Fillet radius — type a value and press Enter");
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
    ptPrompt(`Fillet r=${formatLength(r)} — select an edge to apply (kernel integration pending)`);
    setTimeout(() => opFinish(viewer), 800);
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
  viewer.setGumballEnabled(false);

  if (tool === "extrude") {
    const sel = ptGetTarget();
    const selIsProfile = sel && EXTRUDABLE_CREATORS.has(sel.userData.creator ?? "");
    if (selIsProfile) {
      const box = new THREE.Box3().setFromObject(sel!);
      const size = new THREE.Vector3(); box.getSize(size);
      const ctr = new THREE.Vector3(); box.getCenter(ctr);
      _opPhase = { kind: "extrude_height", profile: sel!, cx: ctr.x, cy: ctr.y, w: size.x, d: size.y };
      ptPrompt("Extrude height — move cursor up/down to set height, click to commit  [Escape = cancel]");
    } else {
      _opPhase = { kind: "extrude_select" };
      ptPrompt("Extrude — click a curve, rectangle, circle, or polygon profile");
    }
  } else if (tool === "boolean") {
    _opPhase = { kind: "bool_a" };
    ptPrompt("Boolean — click the first solid");
  } else if (tool === "fillet") {
    _opPhase = { kind: "fillet_select" };
    ptPrompt("Fillet — click an edge, corner, or object");
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
  }
}
