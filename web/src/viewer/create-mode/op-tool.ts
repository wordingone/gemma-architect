// Op-tool state machine — Extrude, Boolean, Fillet, annotation tools, selection modes.

import * as THREE from "three";
import type { Viewer } from "../viewer";
import { dispatchSync } from "../../commands/dispatch";
import { getSnap } from "../snap-state";
import { formatLength, formatArea, formatVolume } from "../../units";
import { pushAction, pushReplaceAction } from "../../history";
import { csgUnion, csgDifference, csgIntersection } from "../csg";
import { projectToScreen } from "./projection";
import { nearestSnapVertex, closestPtOnSegToRay } from "./snap";
import { snapWorldForView, unprojectToXY } from "./projection";
import { opBuildExtrudeMesh, EXTRUDABLE_CREATORS } from "./builders";
import { round } from "./builders";
import {
  _chooserEl, _selOverlaySvg, _selDragging, _rawChooserDefault,
  _multiSelHighlighted, _selHLOwned,
  setSelOverlaySvg, setSelDragging, setRawChooserDefault, setMultiSelHighlighted, setSelHLOwned,
  setPickerHint, opSetHover, setChooserElVar,
  _pickerPromptEl,
} from "./state";
import { ptClearPrompt, ptHideCoordInput, ptPrompt, ptShowCoordInput } from "./precision-transform";
import { getSelected, setSelected, addToMultiSelected, clearMultiSelected, getMultiSelected } from "../selection-state";
import { screenYtoDz } from "./projection";
import { updateSketchShiftLine, clearSketchShiftLine } from "./scene-helpers";

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Module state ─────────────────────────────────────────────────────────────

export let _opPhase: OpPhase | null = null;
export let _opPreview: THREE.Object3D | null = null;
export let _opLabels: HTMLElement[] = [];

export function setOpPhase(v: OpPhase | null): void { _opPhase = v; }

// ─── Phase predicates ─────────────────────────────────────────────────────────

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

// ─── Preview management ───────────────────────────────────────────────────────

export function opClearPreview(viewer: Viewer): void {
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

export function opClearLabels(): void {
  for (const el of _opLabels) el.remove();
  _opLabels = [];
}

export function opFinish(viewer: Viewer): void {
  opClearPreview(viewer);
  opSetHover(null);
  _opPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  hideCursorDotFn?.();
  clearSketchShiftLine(viewer);
  setPickerHint(null);
  removeSelOverlay();
  setRawChooserDefault(null);
  setSelDragging(false);
  viewer.setGumballEnabled(true);
  dispatchSync("setActiveTool", { toolId: "select" });
}

let hideCursorDotFn: (() => void) | null = null;
export function registerOpHideCursorDot(fn: () => void): void { hideCursorDotFn = fn; }

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

// ─── Labels ───────────────────────────────────────────────────────────────────

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

export function opBuildAnnotLine(pts: THREE.Vector3[], color = 0x4488ff): THREE.Object3D {
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 100;
  line.userData.noSnap = true;
  return line;
}

// ─── Raycast helper ───────────────────────────────────────────────────────────

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
    if (o.userData.noSnap) return;
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

// ─── Raw chooser ──────────────────────────────────────────────────────────────

export function showRawChooser(
  label: string,
  options: Array<{ label: string; description: string; onSelect: () => void }>,
  defaultFn: () => void,
): void {
  if (!_chooserEl) return;
  _chooserEl.innerHTML = "";
  const lbl = document.createElement("div");
  lbl.className = "chooser-label";
  lbl.textContent = label;
  _chooserEl.appendChild(lbl);
  for (const opt of options) {
    const chip = document.createElement("button");
    chip.className = "chooser-chip";
    chip.textContent = opt.label;
    chip.title = opt.description;
    chip.addEventListener("click", () => {
      setRawChooserDefault(null);
      _chooserEl!.classList.remove("visible");
      _chooserEl!.innerHTML = "";
      opt.onSelect();
    });
    _chooserEl.appendChild(chip);
  }
  _chooserEl.classList.add("visible");
  setRawChooserDefault(defaultFn);
}

// ─── Boolean ──────────────────────────────────────────────────────────────────

export function opExecBoolean(viewer: Viewer, objA: THREE.Object3D, objB: THREE.Object3D, op: "union" | "difference" | "split"): void {
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

export function opShowBoolChooser(viewer: Viewer, objA: THREE.Object3D, objB: THREE.Object3D): void {
  if (!_chooserEl) return;
  _chooserEl.innerHTML = "";
  const label = document.createElement("div");
  label.className = "chooser-label";
  label.textContent = "Boolean operation:";
  _chooserEl.appendChild(label);
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
    _chooserEl.appendChild(chip);
  }
  _chooserEl.classList.add("visible");
}

// ─── Extrude preview ──────────────────────────────────────────────────────────

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
  if (shiftKey) updateSketchShiftLine(viewer, profileBase, "z");
  else clearSketchShiftLine(viewer);
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

// ─── Selection overlays ───────────────────────────────────────────────────────

export function getSelOverlay(viewer: Viewer): SVGSVGElement {
  if (_selOverlaySvg) return _selOverlaySvg;
  const canvas = viewer.getCanvas();
  const parent = canvas.parentElement ?? document.body;
  if (!parent.style.position || parent.style.position === "static") parent.style.position = "relative";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;overflow:visible";
  parent.appendChild(svg);
  setSelOverlaySvg(svg);
  return svg;
}

export function clearSelOverlay(): void { if (_selOverlaySvg) _selOverlaySvg.innerHTML = ""; }
export function removeSelOverlay(): void { if (_selOverlaySvg) { _selOverlaySvg.remove(); setSelOverlaySvg(null); } }

// ─── Screen bbox ──────────────────────────────────────────────────────────────

export function screenBboxOf(viewer: Viewer, obj: THREE.Object3D): { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number } | null {
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return null;
  const corners: [number, number, number][] = [
    [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
    [box.min.x, box.max.y, box.min.z], [box.max.x, box.max.y, box.min.z],
    [box.min.x, box.min.y, box.max.z], [box.max.x, box.min.y, box.max.z],
    [box.min.x, box.max.y, box.max.z], [box.max.x, box.max.y, box.max.z],
  ];
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y, z] of corners) {
    const s = projectToScreen(viewer, x, y, z);
    if (!s) continue;
    if (s.x < x1) x1 = s.x; if (s.x > x2) x2 = s.x;
    if (s.y < y1) y1 = s.y; if (s.y > y2) y2 = s.y;
  }
  if (!isFinite(x1)) return null;
  return { x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
}

export function pointInPolygon2D(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ─── opStartTool ──────────────────────────────────────────────────────────────

export function opStartTool(viewer: Viewer, tool: string): void {
  opClearPreview(viewer);
  opClearLabels();
  opSetHover(null);
  _opPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  viewer.setGumballEnabled(false);

  if (tool === "extrude") {
    const sel = getSelected()?.transformTarget ?? null;
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

// ─── opHandleClick ────────────────────────────────────────────────────────────

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
    // createSequence push done in caller (index.ts)
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
    const lineObj = opBuildAnnotLine([phase.ptA, snapped3]);
    viewer.getScene().add(lineObj);
    opAddLabel(formatLength(dist), mid, viewer);
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
      opAddLabel(`${angleDeg.toFixed(1)}°`, phase.ptA, viewer);
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
    const under = document.elementFromPoint(clientX, clientY);
    if (_chooserEl && _chooserEl.contains(under)) return true;
    if (_rawChooserDefault) { _rawChooserDefault(); setRawChooserDefault(null); }
    if (_chooserEl) { _chooserEl.classList.remove("visible"); _chooserEl.innerHTML = ""; }
    if (_opPhase?.kind === "sel_window") {
      setSelDragging(true);
      _opPhase.startX = clientX;
      _opPhase.startY = clientY;
    } else if (_opPhase?.kind === "sel_lasso") {
      setSelDragging(true);
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
      runPolySel(viewer, poly, "crossing");
      setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
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
    const svg = getSelOverlay(viewer);
    clearSelOverlay();
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

// ─── opHandleEnter ────────────────────────────────────────────────────────────

export function opHandleEnter(viewer: Viewer): void {
  const phase = _opPhase;
  if (!phase) return;

  if (phase.kind === "sel_window_sub" || phase.kind === "sel_lasso_sub" || phase.kind === "sel_boundary_sub") {
    if (_rawChooserDefault) { _rawChooserDefault(); setRawChooserDefault(null); }
    if (_chooserEl) { _chooserEl.classList.remove("visible"); _chooserEl.innerHTML = ""; }
    return;
  }

  if (phase.kind === "sel_boundary_draw" && phase.points.length >= 3) {
    removeSelOverlay();
    runPolySel(viewer, phase.points, "crossing");
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
    const lineObj = opBuildAnnotLine([...pts, pts[0]]);
    viewer.getScene().add(lineObj);
    opAddLabel(`Area: ${formatArea(area)}`, ctr, viewer);
    opFinish(viewer);
    return;
  }

  if (phase.kind === "fillet_radius") {
    ptPrompt("Fillet radius — type a value and press Enter");
    return;
  }
}

// ─── opHandleCoordSubmit ──────────────────────────────────────────────────────

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

// ─── Selection helpers ────────────────────────────────────────────────────────

function collectSelectable(viewer: Viewer): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  // Import _markerMesh and _sketchShiftAxisLine lazily to avoid circular dep
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap || !o.visible) return;
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.Line) && !(o instanceof THREE.Points)) return;
    out.push(o);
  });
  return out;
}

function applySelResult(viewer: Viewer, matches: THREE.Object3D[]): void {
  if (!matches.length) {
    ptPrompt("No objects in selection — try again");
    setTimeout(() => ptClearPrompt(), 1500);
    return;
  }
  clearMultiSelHighlightsFn?.();
  clearMultiSelected();
  if (matches.length === 1) {
    viewer.selectObject(matches[0]);
  } else {
    viewer.setMultiTargets(matches);
  }
  setSelHLOwned(true);
  window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: matches[0].uuid } }));
  setSelHLOwned(false);
  for (const o of matches) {
    addToMultiSelected({ topology: "mesh", uuid: o.uuid, object: o, transformTarget: o });
    applyMultiSelHLFn?.(o);
  }
  ptPrompt(`Selected ${matches.length} object${matches.length > 1 ? "s" : ""}`);
  setTimeout(() => ptClearPrompt(), 1200);
}

let clearMultiSelHighlightsFn: (() => void) | null = null;
let applyMultiSelHLFn: ((obj: THREE.Object3D) => void) | null = null;
export function registerSelHelpers(
  clearHL: () => void,
  applyHL: (obj: THREE.Object3D) => void,
): void {
  clearMultiSelHighlightsFn = clearHL;
  applyMultiSelHLFn = applyHL;
}

export function runRectSel(viewer: Viewer, cx1: number, cy1: number, cx2: number, cy2: number, subMode: "crossing" | "window"): void {
  const rx1 = Math.min(cx1, cx2), ry1 = Math.min(cy1, cy2);
  const rx2 = Math.max(cx1, cx2), ry2 = Math.max(cy1, cy2);
  if (rx2 - rx1 < 5 && ry2 - ry1 < 5) return;
  const matches = collectSelectable(viewer).filter((o) => {
    const bb = screenBboxOf(viewer, o);
    if (!bb) return false;
    return subMode === "crossing"
      ? bb.x2 >= rx1 && bb.x1 <= rx2 && bb.y2 >= ry1 && bb.y1 <= ry2
      : bb.x1 >= rx1 && bb.x2 <= rx2 && bb.y1 >= ry1 && bb.y2 <= ry2;
  });
  applySelResult(viewer, matches);
}

export function runPolySel(viewer: Viewer, poly: Array<{ x: number; y: number }>, subMode: "crossing" | "window"): void {
  if (poly.length < 3) return;
  const matches = collectSelectable(viewer).filter((o) => {
    const bb = screenBboxOf(viewer, o);
    if (!bb) return false;
    if (subMode === "crossing") {
      const pb = poly.reduce((a, p) => ({ x1: Math.min(a.x1, p.x), y1: Math.min(a.y1, p.y), x2: Math.max(a.x2, p.x), y2: Math.max(a.y2, p.y) }), { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity });
      return bb.x2 >= pb.x1 && bb.x1 <= pb.x2 && bb.y2 >= pb.y1 && bb.y1 <= pb.y2 && pointInPolygon2D(bb.cx, bb.cy, poly);
    }
    return pointInPolygon2D(bb.cx, bb.cy, poly);
  });
  applySelResult(viewer, matches);
}
