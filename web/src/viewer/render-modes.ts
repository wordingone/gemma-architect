// Render mode switcher (#95 P3).
//
// Five modes: shaded (default) / wireframe / ghosted / realistic (stub) / technical.
// Technical = applyDrafting overlay from drafting.ts with California-arch line types.
// Ghosted = semi-transparent fill + edge highlight overlay.
// Wireframe = flat wireframe material.
// Realistic = stub (PBR/WebGPU path — same visual as shaded until WebGPU research landed).
//
// All material swaps use a per-mesh userData tag for backup/restore so the
// viewer's own material management isn't disrupted.
//
// Call initRenderModes(viewer) once after the viewer is ready, then call
// setRenderMode / setLineType / setLineWeight from the UI layer.

import * as THREE from "three";
import { applyDrafting, removeDrafting, type DraftingOpts } from "../geometry/drafting";
import type { Viewer } from "./viewer";

export type RenderMode   = "shaded" | "wireframe" | "ghosted" | "realistic" | "technical";
export type LineType     = "solid" | "dashed" | "hidden" | "centerline" | "gridline" | "dotted";
export type LineWeight   = "thin" | "medium" | "thick";

const RM_BACKUP  = "__render_mode_backup__";
const RM_OVERLAY = "__render_mode_overlay__";
const DRAFT_TAG  = "__drafting_overlay__";

let _viewer: Viewer | null = null;
let _mode: RenderMode  = "shaded";
let _lt:   LineType    = "solid";
let _lw:   LineWeight  = "medium";

export function initRenderModes(viewer: Viewer): void { _viewer = viewer; }
export function getRenderMode(): RenderMode   { return _mode; }
export function getLineType():   LineType     { return _lt; }
export function getLineWeight(): LineWeight   { return _lw; }

const WEIGHT_OP: Record<LineWeight, number> = { thin: 0.38, medium: 0.75, thick: 1.0 };

function solidMat(ink: number, lw: LineWeight): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: ink, linewidth: 1, opacity: WEIGHT_OP[lw], transparent: WEIGHT_OP[lw] < 1 });
}

function dashMat(ink: number, lw: LineWeight, dashSize: number, gapSize: number): THREE.LineDashedMaterial {
  return new THREE.LineDashedMaterial({ color: ink, linewidth: 1, opacity: WEIGHT_OP[lw], transparent: true, dashSize, gapSize });
}

function lineMat(ink: number, lt: LineType, lw: LineWeight): THREE.LineBasicMaterial | THREE.LineDashedMaterial {
  switch (lt) {
    case "dashed":     return dashMat(ink, lw, 0.25, 0.12);
    case "hidden":     return dashMat(ink, lw, 0.08, 0.08);
    case "centerline": return dashMat(ink, lw, 0.45, 0.10);
    case "gridline":   return dashMat(ink, lw, 0.60, 0.15);
    case "dotted":     return dashMat(ink, lw, 0.02, 0.10);
    default:           return solidMat(ink, lw);
  }
}

function _refreshDraftingLines(): void {
  if (!_viewer) return;
  const INK = 0x0e0e10;
  _viewer.getScene().traverse((obj) => {
    const ls = obj as THREE.LineSegments;
    if (!ls.isLineSegments) return;
    if (obj.userData[DRAFT_TAG] !== "overlay") return;
    if (obj.parent?.userData?.noRenderMode) return;
    const newMat = lineMat(INK, _lt, _lw);
    (ls.material as THREE.Material).dispose();
    ls.material = newMat;
    if (newMat instanceof THREE.LineDashedMaterial) ls.computeLineDistances();
  });
}

function _restoreAll(): void {
  if (!_viewer) return;
  const scene = _viewer.getScene();

  // Remove technical (drafting) overlays.
  removeDrafting(scene);

  // Remove ghosted edge overlays.
  const toRemove: Array<{ parent: THREE.Object3D; child: THREE.Object3D }> = [];
  scene.traverse((obj) => {
    if (obj.userData[RM_OVERLAY] && obj.parent) toRemove.push({ parent: obj.parent, child: obj });
  });
  for (const { parent, child } of toRemove) {
    parent.remove(child);
    const ls = child as THREE.LineSegments;
    ls.geometry?.dispose();
    const m = ls.material;
    if (Array.isArray(m)) m.forEach((mm) => (mm as THREE.Material).dispose());
    else (m as THREE.Material)?.dispose();
  }

  // Restore wireframe/ghosted material backups.
  scene.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const backup = mesh.userData[RM_BACKUP];
    if (!backup) return;
    const cur = mesh.material;
    if (Array.isArray(cur)) cur.forEach((m) => (m as THREE.Material).dispose());
    else (cur as THREE.Material)?.dispose();
    mesh.material = backup;
    delete mesh.userData[RM_BACKUP];
  });
}

export function setRenderMode(mode: RenderMode): void {
  if (!_viewer) return;
  _mode = mode;
  _restoreAll();

  const scene = _viewer.getScene();
  const INK = 0x0e0e10;

  if (mode === "wireframe") {
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      if (mesh.userData[DRAFT_TAG] === "overlay") return;
      if (mesh.userData[RM_OVERLAY]) return;
      if (mesh.userData.creator === "IfcLevel") return;
      mesh.userData[RM_BACKUP] = mesh.material;
      mesh.material = new THREE.MeshBasicMaterial({ color: 0x2a2a3a, wireframe: true });
    });
  } else if (mode === "ghosted") {
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      if (mesh.userData[DRAFT_TAG] === "overlay") return;
      if (mesh.userData[RM_OVERLAY]) return;
      if (mesh.userData.creator === "IfcLevel") return;
      const orig = mesh.material;
      const srcMat = Array.isArray(orig) ? orig[0] : orig;
      const srcCol = (srcMat as THREE.MeshStandardMaterial).color;
      mesh.userData[RM_BACKUP] = orig;
      mesh.material = new THREE.MeshBasicMaterial({
        color: srcCol ? srcCol.clone() : new THREE.Color(0x9ec5d8),
        transparent: true, opacity: 0.22, side: THREE.DoubleSide,
      });
      const eGeom = new THREE.EdgesGeometry(mesh.geometry, 20);
      const eMat  = new THREE.LineBasicMaterial({ color: INK, opacity: 0.70, transparent: true });
      const lines = new THREE.LineSegments(eGeom, eMat);
      lines.userData[RM_OVERLAY] = true;
      lines.renderOrder = 1;
      mesh.add(lines);
    });
  } else if (mode === "technical") {
    const opts: DraftingOpts = {};
    applyDrafting(scene, opts);
    if (_lt !== "solid") _refreshDraftingLines();
  }
  // shaded / realistic: _restoreAll() already did the work.

  window.dispatchEvent(new CustomEvent("render-mode-changed", { detail: { mode, lineType: _lt, lineWeight: _lw } }));
}

export function setLineType(lt: LineType): void {
  _lt = lt;
  if (_mode === "technical") _refreshDraftingLines();
  window.dispatchEvent(new CustomEvent("render-mode-changed", { detail: { mode: _mode, lineType: lt, lineWeight: _lw } }));
}

export function setLineWeight(lw: LineWeight): void {
  _lw = lw;
  if (_mode === "technical") _refreshDraftingLines();
  window.dispatchEvent(new CustomEvent("render-mode-changed", { detail: { mode: _mode, lineType: _lt, lineWeight: lw } }));
}
