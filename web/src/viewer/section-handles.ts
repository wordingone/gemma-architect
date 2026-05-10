// section-handles.ts — Viewport face handles for section box drag (#347).
//
// 6 handle divs (one per face: +x/-x/+y/-y/+z/-z) are absolutely positioned
// inside the viewport via rAF camera reprojection. Pointer drag on a handle
// converts screen pixel delta to world delta and calls viewer.pushSectionFace().

import * as THREE from "three";
import type { Viewer } from "./viewer";

type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

const FACES: Face[] = ['+x', '-x', '+y', '-y', '+z', '-z'];

const FACE_AXIS: Record<Face, THREE.Vector3> = {
  '+x': new THREE.Vector3(1, 0, 0),
  '-x': new THREE.Vector3(-1, 0, 0),
  '+y': new THREE.Vector3(0, 1, 0),
  '-y': new THREE.Vector3(0, -1, 0),
  '+z': new THREE.Vector3(0, 0, 1),
  '-z': new THREE.Vector3(0, 0, -1),
};

const FACE_CURSOR: Record<Face, string> = {
  '+x': 'ew-resize', '-x': 'ew-resize',
  '+y': 'ns-resize', '-y': 'ns-resize',
  '+z': 'nesw-resize', '-z': 'nesw-resize',
};

let _viewer: Viewer | null = null;
let _vpEl: HTMLElement | null = null;
let _container: HTMLElement | null = null;
const _handles = new Map<Face, HTMLElement>();
let _rafId: number | null = null;
let _drag: { face: Face; prevX: number; prevY: number } | null = null;

function getFaceCenter(
  box: { min: [number, number, number]; max: [number, number, number] },
  face: Face,
): THREE.Vector3 {
  const [x0, y0, z0] = box.min;
  const [x1, y1, z1] = box.max;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const cz = (z0 + z1) / 2;
  switch (face) {
    case '+x': return new THREE.Vector3(x1, cy, cz);
    case '-x': return new THREE.Vector3(x0, cy, cz);
    case '+y': return new THREE.Vector3(cx, y1, cz);
    case '-y': return new THREE.Vector3(cx, y0, cz);
    case '+z': return new THREE.Vector3(cx, cy, z1);
    case '-z': return new THREE.Vector3(cx, cy, z0);
  }
}

// Convert a screen-space drag (pixels) to world-space delta along the face axis.
// Projects face center + 1 world unit onto screen to derive a pixels-per-world-unit
// scale, then projects the pixel drag onto that screen direction.
function pixelDeltaToWorld(viewer: Viewer, face: Face, dxPx: number, dyPx: number): number {
  const box = viewer.getSectionBox();
  if (!box) return 0;
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const camera = viewer.getCamera() as THREE.Camera;
  const center = getFaceCenter(box, face);
  const axis = FACE_AXIS[face];

  const p0 = center.clone().project(camera);
  const p1 = center.clone().add(axis).project(camera);

  const sx = (p1.x - p0.x) * 0.5 * rect.width;
  const sy = -(p1.y - p0.y) * 0.5 * rect.height; // flip: screen Y+ = down
  const len2 = sx * sx + sy * sy;
  if (len2 < 0.25) return 0; // axis nearly perpendicular to view
  return (dxPx * sx + dyPx * sy) / len2;
}

function updatePositions(): void {
  if (!_viewer || !_container || !_vpEl) return;
  const box = _viewer.getSectionBox();
  if (!box) {
    _container.style.display = "none";
    return;
  }
  _container.style.display = "block";

  const canvas = _viewer.getCanvas();
  const canvasRect = canvas.getBoundingClientRect();
  const vpRect = _vpEl.getBoundingClientRect();
  const camera = _viewer.getCamera() as THREE.Camera;
  const offsetX = canvasRect.left - vpRect.left;
  const offsetY = canvasRect.top - vpRect.top;

  for (const face of FACES) {
    const el = _handles.get(face)!;
    const center = getFaceCenter(box, face);
    const v = center.clone().project(camera);
    if (v.z > 1) {
      el.style.display = "none";
      continue;
    }
    const sx = (v.x * 0.5 + 0.5) * canvasRect.width + offsetX;
    const sy = (-v.y * 0.5 + 0.5) * canvasRect.height + offsetY;
    el.style.display = "block";
    el.style.left = `${sx}px`;
    el.style.top = `${sy}px`;
  }
}

function rafLoop(): void {
  updatePositions();
  _rafId = requestAnimationFrame(rafLoop);
}

export function initSectionHandles(viewer: Viewer, vpEl: HTMLElement): void {
  _viewer = viewer;
  _vpEl = vpEl;

  _container = document.createElement("div");
  _container.className = "section-handles-overlay";
  _container.style.display = "none";
  vpEl.appendChild(_container);

  for (const face of FACES) {
    const el = document.createElement("div");
    el.className = "section-handle";
    el.dataset.face = face;
    el.style.cursor = FACE_CURSOR[face];
    el.title = `Drag ${face} face`;
    _container.appendChild(el);
    _handles.set(face, el);

    el.addEventListener("pointerdown", (ev: PointerEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      _drag = { face, prevX: ev.clientX, prevY: ev.clientY };
    });
  }

  vpEl.addEventListener("pointermove", (ev: PointerEvent) => {
    if (!_drag) return;
    const dxPx = ev.clientX - _drag.prevX;
    const dyPx = ev.clientY - _drag.prevY;
    const delta = pixelDeltaToWorld(viewer, _drag.face, dxPx, dyPx);
    if (Math.abs(delta) > 1e-4) {
      viewer.pushSectionFace(_drag.face, delta);
      document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
    }
    _drag.prevX = ev.clientX;
    _drag.prevY = ev.clientY;
  });

  vpEl.addEventListener("pointerup", () => { _drag = null; });
  vpEl.addEventListener("pointercancel", () => { _drag = null; });

  rafLoop();
}
