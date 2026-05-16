// Selection UX — window / lasso / boundary select, multi-select highlight.
// Extracted from create-mode.ts (#723).
// screenBboxOf and pointInPolygon2D live here (NOT in op-tool.ts) to avoid circular imports.

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { projectToScreen } from "./projection";
import { ptPrompt, ptClearPrompt } from "./transforms";
import { addToMultiSelected, clearMultiSelected } from "./selection-state";

// ── Late-binding: marker/overlay exclusions ───────────────────────────────────
// tools/index.ts registers these during initCreateMode.
let _getMarkerMesh: () => THREE.Points | null = () => null;
let _getSketchShiftAxisLine: () => THREE.Line | null = () => null;

export function registerSelectionOpsMarkers(hooks: {
  getMarkerMesh: () => THREE.Points | null;
  getSketchShiftAxisLine: () => THREE.Line | null;
}): void {
  _getMarkerMesh = hooks.getMarkerMesh;
  _getSketchShiftAxisLine = hooks.getSketchShiftAxisLine;
}

// ── SVG overlay ───────────────────────────────────────────────────────────────

let _selOverlaySvg: SVGSVGElement | null = null;
let _multiSelHighlighted: THREE.Object3D[] = [];
let _selHLOwned = false;

export function getSelOverlay(viewer: Viewer): SVGSVGElement {
  if (_selOverlaySvg) return _selOverlaySvg;
  const canvas = viewer.getCanvas();
  const parent = canvas.parentElement ?? document.body;
  if (!parent.style.position || parent.style.position === "static") parent.style.position = "relative";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10;overflow:visible";
  parent.appendChild(svg);
  _selOverlaySvg = svg;
  return svg;
}

export function clearSelOverlay(): void {
  if (_selOverlaySvg) _selOverlaySvg.innerHTML = "";
}

export function removeSelOverlay(): void {
  if (_selOverlaySvg) { _selOverlaySvg.remove(); _selOverlaySvg = null; }
}

// ── Screen-space bbox ─────────────────────────────────────────────────────────

export function screenBboxOf(
  viewer: Viewer,
  obj: THREE.Object3D,
): { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number } | null {
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

// ── Multi-select highlight ────────────────────────────────────────────────────

export function clearMultiSelHighlights(): void {
  for (const obj of _multiSelHighlighted) {
    if (obj.userData._selHL === undefined) continue;
    if (obj instanceof THREE.Mesh) {
      (obj.material as THREE.MeshStandardMaterial).emissive?.setHex(obj.userData._selHL as number);
    } else if (obj instanceof THREE.Line) {
      (obj.material as THREE.LineBasicMaterial).color.setHex(obj.userData._selHL as number);
    } else if (obj instanceof THREE.Points) {
      (obj.material as THREE.PointsMaterial).color.setHex(obj.userData._selHL as number);
    }
    delete obj.userData._selHL;
  }
  _multiSelHighlighted = [];
}

export function applyMultiSelHL(obj: THREE.Object3D): void {
  if (obj.userData._selHL !== undefined) return;
  if (obj instanceof THREE.Mesh && (obj.material as THREE.MeshStandardMaterial).emissive) {
    obj.userData._selHL = (obj.material as THREE.MeshStandardMaterial).emissive.getHex();
    (obj.material as THREE.MeshStandardMaterial).emissive.setHex(0x223355);
    _multiSelHighlighted.push(obj);
  } else if (obj instanceof THREE.Line) {
    obj.userData._selHL = (obj.material as THREE.LineBasicMaterial).color.getHex();
    (obj.material as THREE.LineBasicMaterial).color.setHex(0x44aaff);
    _multiSelHighlighted.push(obj);
  } else if (obj instanceof THREE.Points) {
    obj.userData._selHL = (obj.material as THREE.PointsMaterial).color.getHex();
    (obj.material as THREE.PointsMaterial).color.setHex(0x44aaff);
    _multiSelHighlighted.push(obj);
  }
}

// ── Run selection ─────────────────────────────────────────────────────────────

export function collectSelectable(viewer: Viewer): THREE.Object3D[] {
  const markerMesh = _getMarkerMesh();
  const shiftAxisLine = _getSketchShiftAxisLine();
  const out: THREE.Object3D[] = [];
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap || !o.visible) return;
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.Line) && !(o instanceof THREE.Points)) return;
    if (o === markerMesh || o === shiftAxisLine) return;
    out.push(o);
  });
  return out;
}

export function applySelResult(viewer: Viewer, matches: THREE.Object3D[]): void {
  if (!matches.length) {
    ptPrompt("No objects in selection — try again");
    setTimeout(() => ptClearPrompt(), 1500);
    return;
  }
  clearMultiSelHighlights();
  clearMultiSelected();
  if (matches.length === 1) {
    viewer.selectObject(matches[0]);
  } else {
    viewer.setMultiTargets(matches);
  }
  _selHLOwned = true;
  window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: matches[0].uuid } }));
  _selHLOwned = false;
  for (const o of matches) {
    addToMultiSelected({ topology: "mesh", uuid: o.uuid, object: o, transformTarget: o });
    applyMultiSelHL(o);
  }
  ptPrompt(`Selected ${matches.length} object${matches.length > 1 ? "s" : ""}`);
  setTimeout(() => ptClearPrompt(), 1200);
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

// Expose _selHLOwned for the viewer:select listener in tools/index.ts
export function isSelHLOwned(): boolean { return _selHLOwned; }
