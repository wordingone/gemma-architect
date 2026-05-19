// Op-tool state machine — extrude, boolean, fillet, annotations, selection modes.
// Extracted from create-mode.ts (#723).
// Does NOT import from selection-ops.ts — runPolySel/overlay fns injected via registerOpToolHooks.

import * as THREE from "three";
import { csgUnion, csgDifference, csgIntersection, filletMesh } from "./csg";
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

// Creators that are valid extrude profiles (click-select in extrude_select phase).
export const EXTRUDABLE_CREATORS = new Set([
  "rect", "circle", "polygon", "polyline", "curve", "line",
  "wall", "slab", "column", "box", "beam", "roof", "space",
  "extrude", "boolean-union", "boolean-difference", "boolean-split",
]);

// 2D sketch creators for auto-selection at tool-activation time.
// Narrower than EXTRUDABLE_CREATORS — avoids auto-selecting large 3D solids
// (slabs, roofs, walls) as profiles when the user activates extrude.
const SKETCH_PROFILE_CREATORS = new Set([
  "rect", "circle", "polygon", "polyline", "curve", "line",
]);

// Creators valid for click-selection as extrude profile.
// Excludes raw 3D primitives (wall, slab, column, box, beam, roof, space)
// to prevent accidentally extruding large solids as a profile.
// Includes previous extrude/boolean results so re-extrusion works.
const CLICK_PROFILE_CREATORS = new Set([
  "rect", "circle", "polygon", "polyline", "curve", "line",
  "extrude", "boolean-union", "boolean-difference", "boolean-split",
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
  | { kind: "array_curve_pick";    source: THREE.Object3D }
  | { kind: "array_curve_count";   source: THREE.Object3D; curvePts: THREE.Vector3[] };

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

export function opFinish(viewer: Viewer, resetTool = true): void {
  opClearPreview(viewer);
  opSetHover(null);
  const _finishedKind = _opPhase?.kind;
  _opPhase = null;
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
  viewer.setGumballEnabled(true);
  if (resetTool) dispatchSync("setActiveTool", { toolId: "select" });
}

export function opCancel(viewer: Viewer, resetTool = true): void {
  opSetHover(null);
  const restoreEmissive = (obj: THREE.Object3D) => {
    const m = obj as THREE.Mesh;
    if (m.userData._savedEmissive === undefined) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const firstStd = mats.find((mat): mat is THREE.MeshStandardMaterial =>
      !!(mat as THREE.MeshStandardMaterial).emissive);
    if (firstStd) firstStd.emissive.setHex(m.userData._savedEmissive as number);
    delete m.userData._savedEmissive;
  };
  if (_opPhase?.kind === "bool_b") restoreEmissive(_opPhase.objA);
  if (_opPhase?.kind === "bool_op") { restoreEmissive(_opPhase.objA); restoreEmissive(_opPhase.objB); }
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

  const hitThresh = hoverMode ? 20 : (profileOnly ? 28 : 10);
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
  // #953: resolve roof child to parent Group for group-level operations.
  if (hitObj.parent instanceof THREE.Group && hitObj.parent.userData.creator === "roof") hitObj = hitObj.parent;
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
    if (m.userData._savedEmissive === undefined) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const std = mats.find((mat): mat is THREE.MeshStandardMaterial =>
      !!(mat as THREE.MeshStandardMaterial).emissive);
    if (std) std.emissive.setHex(m.userData._savedEmissive as number);
    delete m.userData._savedEmissive;
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
  if (!snapped3 && phase.kind !== "extrude_select" && phase.kind !== "bool_a" && phase.kind !== "bool_b" && phase.kind !== "fillet_select" && phase.kind !== "dim_a" && phase.kind !== "dim_volume" && phase.kind !== "label_pick" && phase.kind !== "tmeasure_a" && phase.kind !== "copy_select" && phase.kind !== "array_select") return false;

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
    viewer.addMesh(mesh, "brep", { noHistory: true });
    _hooks.appendToCreateSequence(`// extrude h=${round(h2)} from profile creator=${phase.profile.userData.creator ?? "unknown"}`);
    pushAction(mesh, "extrude");
    opFinish(viewer);
    return true;
  }

  if (phase.kind === "bool_a") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Boolean — click the first solid"); return true; }
    if (!(hit.obj instanceof THREE.Mesh)) {
      ptPrompt("Boolean requires solid meshes — extrude your curves first to create a solid");
      return true;
    }
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
    if (!(hit.obj instanceof THREE.Mesh)) {
      ptPrompt("Boolean requires solid meshes — extrude your curves first to create a solid");
      return true;
    }
    opSetHover(null); // clear hover so its saved emissive doesn't overwrite our selection color
    const objB = hit.obj;
    const mB = objB as THREE.Mesh;
    const mats = mB instanceof THREE.Mesh
      ? (Array.isArray(mB.material) ? mB.material : [mB.material])
      : [];
    const firstStd = mats.find((m): m is THREE.MeshStandardMaterial =>
      !!(m as THREE.MeshStandardMaterial).emissive);
    if (firstStd) {
      mB.userData._savedEmissive = firstStd.emissive.getHex();
      firstStd.emissive.setHex(0x883300); // warm orange — distinct from first object's blue
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
    if (!hit) { ptPrompt("Fillet — click a solid mesh to fillet"); return true; }
    if (!(hit.obj instanceof THREE.Mesh)) {
      ptPrompt("Fillet requires a solid mesh — extrude your curves first to create a solid");
      return true;
    }
    _opPhase = { kind: "fillet_radius", target: hit.obj };
    ptPrompt("Fillet radius — type a value and press Enter");
    ptShowCoordInput("radius");
    return true;
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
    ptPrompt(`Linear Array — step (${dx}, ${dy}${dz !== 0 ? `, ${dz}` : ""})  —  type count  [Esc] cancel`);
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
    viewer.addMesh(filleted, "brep", { noHistory: true });
    pushReplaceAction(filleted, [target], "fillet");
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
    const selIsProfile = sel && SKETCH_PROFILE_CREATORS.has(sel.userData.creator ?? "");
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
    const sel = ptGetTarget();
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
    const sel = ptGetTarget();
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
    { label: "Rectangular",  description: "Rows × columns — type rows cols dx dy",
      onSelect: () => {
        _opPhase = { kind: "array_grid_params", source };
        ptPrompt("Rectangular Array — type: rows  cols  dx  dy  then Enter  [Esc] cancel");
        ptShowCoordInput("rows cols dx dy");
      }},
    { label: "Polar",        description: "Circular pattern — type count [cx cy]",
      onSelect: () => {
        _opPhase = { kind: "array_polar_params", source };
        ptPrompt("Polar Array — type: count  [cx  cy]  then Enter  [Esc] cancel");
        ptShowCoordInput("count  or  count cx cy");
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
