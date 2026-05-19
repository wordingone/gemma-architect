// wall-height-handle.ts — Drag handle at the top-center of a selected wall.
// An HTML div absolutely positioned over the viewport via rAF projection.
// Dragging it vertically changes wall height live.
// Dispatches "wall:params-changed" on window so the inspect tab can refresh.

import * as THREE from "three";
import type { Viewer } from "./viewer.js";
import { rebuildWallParams, rebuildGroupWallHeight } from "../tools/structural.js";
import { attemptWallCornerJoins } from "../tools/wall-corners.js";

let _viewer: Viewer | null = null;
let _vpEl: HTMLElement | null = null;
let _handleEl: HTMLElement | null = null;
let _rafId: number | null = null;

let _targetMesh: THREE.Mesh | THREE.Group | null = null;
let _drag: { prevY: number } | null = null;

export function initWallHeightHandle(viewer: Viewer, vpEl: HTMLElement): void {
  _viewer = viewer;
  _vpEl = vpEl;

  const container = document.createElement("div");
  container.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:40";
  vpEl.appendChild(container);

  const div = document.createElement("div");
  div.className = "wall-height-handle";
  div.title = "Drag to change wall height";
  div.style.cssText = [
    "position:absolute",
    "width:18px", "height:18px",
    "background:var(--sanguine,#c0392b)",
    "border:2px solid #fff",
    "border-radius:2px",
    "cursor:ns-resize",
    "display:none",
    "transform:translate(-50%,-50%)",
    "pointer-events:auto",
    "box-shadow:0 1px 4px rgba(0,0,0,.4)",
  ].join(";");

  div.addEventListener("pointerdown", (e) => {
    if (!_targetMesh) return;
    e.stopPropagation();
    div.setPointerCapture(e.pointerId);
    _drag = { prevY: e.clientY };
  });

  div.addEventListener("pointermove", (e) => {
    if (!_drag || !_targetMesh || !_viewer) return;
    const dy = _drag.prevY - e.clientY; // screen-up = taller
    _drag.prevY = e.clientY;

    const canvas = _viewer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const camera = _viewer.getActiveCamera();
    const center = new THREE.Vector3();
    new THREE.Box3().setFromObject(_targetMesh).getCenter(center);
    const p0 = center.clone().project(camera);
    const p1 = center.clone().add(new THREE.Vector3(0, 0, 1)).project(camera);
    const sy = -(p1.y - p0.y) * 0.5 * rect.height;
    const worldPerPx = Math.abs(sy) > 0.1 ? 1 / Math.abs(sy) : 0.01;

    const curH = (_targetMesh.userData.wallHeight as number | undefined) ?? 3;
    const newH = Math.max(0.1, curH + dy * worldPerPx);
    if (_targetMesh instanceof THREE.Group) {
      rebuildGroupWallHeight(_targetMesh, parseFloat(newH.toFixed(3)));
    } else {
      rebuildWallParams(_targetMesh, { height: parseFloat(newH.toFixed(3)) });
    }
    window.dispatchEvent(new CustomEvent("wall:params-changed", { detail: { mesh: _targetMesh } }));
  });

  div.addEventListener("pointerup", () => {
    _drag = null;
    // Re-apply corner joins after height drag — rebuildWallParams resets geometry.
    // Skip for Group (void-cut) walls; their segments don't participate in miter joins.
    if (_targetMesh instanceof THREE.Mesh && _viewer) {
      attemptWallCornerJoins(_targetMesh, _viewer.getScene());
    }
  });

  container.appendChild(div);
  _handleEl = div;

  _rafId = requestAnimationFrame(_tick);
}

function _tick(): void {
  _rafId = requestAnimationFrame(_tick);
  if (!_handleEl || !_viewer || !_targetMesh || !_vpEl) {
    if (_handleEl) _handleEl.style.display = "none";
    return;
  }

  const box = new THREE.Box3().setFromObject(_targetMesh);
  if (!isFinite(box.min.x)) { _handleEl.style.display = "none"; return; }

  const topCenter = new THREE.Vector3(
    (box.min.x + box.max.x) / 2,
    (box.min.y + box.max.y) / 2,
    box.max.z,
  );
  const camera = _viewer.getActiveCamera();
  const ndc = topCenter.clone().project(camera);
  const rect = _vpEl.getBoundingClientRect();
  const sx = ((ndc.x + 1) / 2) * rect.width;
  const sy = ((-ndc.y + 1) / 2) * rect.height;

  _handleEl.style.display = "block";
  _handleEl.style.left = `${sx}px`;
  _handleEl.style.top = `${sy}px`;
}

export function showWallHeightHandle(mesh: THREE.Mesh | THREE.Group): void { _targetMesh = mesh; }
export function hideWallHeightHandle(): void {
  _targetMesh = null;
  if (_handleEl) _handleEl.style.display = "none";
}

export function destroyWallHeightHandle(): void {
  if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
  _handleEl?.remove();
  _handleEl = null;
  _targetMesh = null;
}
