// clip-plane-handles.ts — Bounds handles for active clip-plane entity (#1849 §5.3).
//
// 4 handle divs (start / end / farClip / height) are absolutely positioned
// inside the viewport via rAF camera reprojection. Pointer drag converts
// screen pixel delta to world delta and calls clippingPlaneStore.updateBounds().

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { clippingPlaneStore, type CPlaneEntity } from "../geometry/clipping-planes";
import { formatLength } from "../units.js";

type BoundsKey = "startOffset" | "endOffset" | "farClip" | "height";
const HANDLE_KEYS: BoundsKey[] = ["startOffset", "endOffset", "farClip", "height"];

const HANDLE_LABEL: Record<BoundsKey, string> = {
  startOffset: "Start",
  endOffset:   "End",
  farClip:     "Depth",
  height:      "Height",
};

const HANDLE_CURSOR: Record<BoundsKey, string> = {
  startOffset: "ew-resize",
  endOffset:   "ew-resize",
  farClip:     "nesw-resize",
  height:      "ns-resize",
};

let _viewer: Viewer | null = null;
let _vpEl: HTMLElement | null = null;
let _container: HTMLElement | null = null;
let _dimChip: HTMLElement | null = null;
let _rafId: number | null = null;
let _activeEntityId: string | null = null;

const _handles = new Map<BoundsKey, HTMLElement>();
let _drag: { key: BoundsKey; entityId: string; prevX: number; prevY: number } | null = null;

/** Compute the world-space axis for dragging this handle. */
function getHandleAxis(entity: CPlaneEntity, key: BoundsKey): THREE.Vector3 {
  const normal = new THREE.Vector3(...entity.normal).normalize();
  // Horizontal tangent perpendicular to normal (in XY plane).
  const tangent = new THREE.Vector3(-normal.y, normal.x, 0);
  if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0); // fallback for vertical normals
  tangent.normalize();
  switch (key) {
    case "startOffset": return tangent.clone();      // start moves along tangent -
    case "endOffset":   return tangent.clone();      // end moves along tangent +
    case "farClip":     return normal.clone();       // depth along normal
    case "height":      return new THREE.Vector3(0, 0, 1); // height along Z
  }
}

/** Compute the world-space position of this handle for the current entity bounds. */
function getHandleWorldPos(entity: CPlaneEntity, key: BoundsKey): THREE.Vector3 {
  const origin = new THREE.Vector3(...entity.origin);
  const normal = new THREE.Vector3(...entity.normal).normalize();
  const tangent = new THREE.Vector3(-normal.y, normal.x, 0);
  if (tangent.lengthSq() < 1e-6) tangent.set(1, 0, 0);
  tangent.normalize();
  const up = new THREE.Vector3(0, 0, 1);
  switch (key) {
    case "startOffset": return origin.clone().addScaledVector(tangent, entity.bounds.startOffset);
    case "endOffset":   return origin.clone().addScaledVector(tangent, entity.bounds.endOffset);
    case "farClip":     return origin.clone().addScaledVector(normal, entity.bounds.farClip);
    case "height":      return origin.clone().addScaledVector(up, entity.bounds.height);
  }
}

/** Convert screen-space drag (pixels) to world-space delta along a handle's axis. */
function pixelDeltaToWorld(
  viewer: Viewer,
  entity: CPlaneEntity,
  key: BoundsKey,
  dxPx: number,
  dyPx: number,
): number {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const camera = viewer.getActiveCamera();
  const center = getHandleWorldPos(entity, key);
  const axis = getHandleAxis(entity, key);

  const p0 = center.clone().project(camera);
  const p1 = center.clone().add(axis).project(camera);

  const sx = (p1.x - p0.x) * 0.5 * rect.width;
  const sy = -(p1.y - p0.y) * 0.5 * rect.height;
  const len2 = sx * sx + sy * sy;
  if (len2 < 0.25) return 0;
  return (dxPx * sx + dyPx * sy) / len2;
}

function getActiveEntity(): CPlaneEntity | null {
  if (!_activeEntityId) return null;
  return clippingPlaneStore.get(_activeEntityId) ?? null;
}

function updateDimChip(entity: CPlaneEntity): void {
  if (!_dimChip) return;
  const b = entity.bounds;
  const span = Math.abs(b.endOffset - b.startOffset);
  _dimChip.textContent = `W ${formatLength(span)}  D ${formatLength(b.farClip)}  H ${formatLength(b.height)}`;
  _dimChip.style.display = "block";
}

function updatePositions(): void {
  if (!_viewer || !_container || !_vpEl) return;
  const entity = getActiveEntity();
  if (!entity) {
    _container.style.display = "none";
    if (_dimChip) _dimChip.style.display = "none";
    return;
  }
  _container.style.display = "block";
  updateDimChip(entity);

  const canvas = _viewer.getCanvas();
  const canvasRect = canvas.getBoundingClientRect();
  const vpRect = _vpEl.getBoundingClientRect();
  const camera = _viewer.getActiveCamera();
  const offsetX = canvasRect.left - vpRect.left;
  const offsetY = canvasRect.top - vpRect.top;

  for (const key of HANDLE_KEYS) {
    const el = _handles.get(key)!;
    const worldPos = getHandleWorldPos(entity, key);
    const v = worldPos.project(camera);
    if (v.z > 1) {
      el.style.display = "none";
      continue;
    }
    const sx = (v.x * 0.5 + 0.5) * canvasRect.width + offsetX;
    const sy = (-v.y * 0.5 + 0.5) * canvasRect.height + offsetY;
    el.style.display = "flex";
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
  }
}

function rafLoop(): void {
  updatePositions();
  _rafId = requestAnimationFrame(rafLoop);
}

/** Initialize the clip-plane handle overlay. Call once after viewer init. */
export function initClipPlaneHandles(viewer: Viewer, vpEl: HTMLElement): void {
  _viewer = viewer;
  _vpEl = vpEl;

  _container = document.createElement("div");
  _container.className = "cplane-handles-overlay";
  _container.style.cssText = "display:none; position:absolute; inset:0; pointer-events:none;";
  vpEl.appendChild(_container);

  _dimChip = document.createElement("div");
  _dimChip.className = "cplane-dim-chip";
  _dimChip.style.cssText = [
    "display:none", "position:absolute", "bottom:32px", "left:50%",
    "transform:translateX(-50%)", "background:rgba(0,0,0,0.65)", "color:#fff",
    "font-size:10px", "padding:2px 8px", "border-radius:3px",
    "pointer-events:none", "white-space:nowrap", "z-index:100",
  ].join(";");
  vpEl.appendChild(_dimChip);

  for (const key of HANDLE_KEYS) {
    const el = document.createElement("div");
    el.className = "cplane-handle";
    el.dataset.boundsKey = key;
    el.style.cssText = [
      "display:none", "position:absolute",
      "width:14px", "height:14px",
      "transform:translate(-50%,-50%)",
      "background:var(--sanguine,#c0392b)", "border:2px solid #fff",
      "border-radius:50%", "pointer-events:auto",
      `cursor:${HANDLE_CURSOR[key]}`, "z-index:50",
      "align-items:center", "justify-content:center",
    ].join(";");
    el.title = `Drag to adjust ${HANDLE_LABEL[key]}`;
    _container.appendChild(el);
    _handles.set(key, el);

    el.addEventListener("pointerdown", (ev: PointerEvent) => {
      const entity = getActiveEntity();
      if (!entity) return;
      ev.stopPropagation();
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      _drag = { key, entityId: entity.id, prevX: ev.clientX, prevY: ev.clientY };
    });
  }

  vpEl.addEventListener("pointermove", (ev: PointerEvent) => {
    if (!_drag) return;
    const entity = clippingPlaneStore.get(_drag.entityId);
    if (!entity) { _drag = null; return; }
    const dxPx = ev.clientX - _drag.prevX;
    const dyPx = ev.clientY - _drag.prevY;
    const delta = pixelDeltaToWorld(viewer, entity, _drag.key, dxPx, dyPx);
    if (Math.abs(delta) > 1e-4) {
      const cur = entity.bounds[_drag.key];
      clippingPlaneStore.updateBounds(entity.id, { [_drag.key]: cur + delta });
      document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
      updatePositions();
    }
    _drag.prevX = ev.clientX;
    _drag.prevY = ev.clientY;
  });

  vpEl.addEventListener("pointerup", () => { _drag = null; });
  vpEl.addEventListener("pointercancel", () => { _drag = null; });

  rafLoop();
}

/** Set the active clip-plane entity whose bounds handles are shown. Pass null to hide. */
export function setActiveClipPlaneEntity(entityId: string | null): void {
  _activeEntityId = entityId;
}
