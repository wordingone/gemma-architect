// Pure viewport math — project/unproject helpers extracted from create-mode.ts (#723).
// No imports from create-mode.ts; no circular dependencies.

import * as THREE from "three";
import type { Viewer } from "./viewer";
import { levelStore } from "../geometry/levels";
import { snapPoint, getSnap } from "./snap-state";

// Project a world-space XY point to screen (client) coordinates.
// Returns null when the point is behind the camera.
export function projectToScreen(viewer: Viewer, x: number, y: number, z = 0): { x: number; y: number } | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const camera = viewer.getActiveCamera();
  const v = new THREE.Vector3(x, y, z).project(camera);
  if (v.z > 1) return null; // behind camera
  return {
    x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
  };
}

// Unproject canvas-space (px) to world coords on the view-derived working plane.
// For top/persp views this is the active level's XY plane (Z = active elevation).
// Front/back use Y=0 (XZ plane). Left/right use X=0 (YZ plane).
export function unprojectToXY(viewer: Viewer, clientX: number, clientY: number): THREE.Vector3 | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const camera = viewer.getActiveCamera();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  let planeNormal: THREE.Vector3;
  let planeConstant: number;
  switch (viewer.activeView) {
    case "front": case "back":
      planeNormal = new THREE.Vector3(0, 1, 0);
      planeConstant = 0;
      break;
    case "right": case "left":
      planeNormal = new THREE.Vector3(1, 0, 0);
      planeConstant = 0;
      break;
    default: {
      const elev = levelStore.getActive().elevation;
      planeNormal = new THREE.Vector3(0, 0, 1);
      planeConstant = -elev;
      break;
    }
  }
  const plane = new THREE.Plane(planeNormal, planeConstant);
  const point = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(plane, point);
  if (hit) return point;
  const fallback = new THREE.Vector3();
  plane.projectPoint(camera.position, fallback);
  return fallback;
}

// Unproject for the clip tool — intersects the view-appropriate plane.
export function unprojectForClipTool(viewer: Viewer, clientX: number, clientY: number): THREE.Vector3 | null {
  const av = viewer.activeView;
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const camera = viewer.getActiveCamera();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera as THREE.Camera);
  let plane: THREE.Plane;
  if (av === "front" || av === "back") {
    plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  } else if (av === "right" || av === "left") {
    plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  } else {
    plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  }
  const point = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, point);
}

// View-aware grid snap for the active working plane.
export function snapWorldForView(viewer: Viewer, world: THREE.Vector3): { x: number; y: number; z: number } {
  const av = viewer.activeView;
  if (av === "front" || av === "back") {
    const snap = getSnap();
    const doSnap = snap.snapOn && snap.gridOn;
    const s = snap.step;
    return {
      x: doSnap ? Math.round(world.x / s) * s : world.x,
      y: 0,
      z: doSnap ? Math.round(world.z / s) * s : world.z,
    };
  }
  if (av === "right" || av === "left") {
    const snap = getSnap();
    const doSnap = snap.snapOn && snap.gridOn;
    const s = snap.step;
    return {
      x: 0,
      y: doSnap ? Math.round(world.y / s) * s : world.y,
      z: doSnap ? Math.round(world.z / s) * s : world.z,
    };
  }
  const snapped = snapPoint(world.x, world.y);
  return { x: snapped.x, y: snapped.y, z: levelStore.getActive().elevation };
}

// Raycast against scene geometry to inherit Z elevation.
export function getGeometryZ(viewer: Viewer, clientX: number, clientY: number): number {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());
  const hits = raycaster.intersectObjects(viewer.getScene().children, true);
  return hits.length > 0 ? hits[0].point.z : 0;
}

// Show an inline chip at screen position for editing a newly placed level.
export function showLevelChip(
  viewer: Viewer,
  levelId: string,
  screenX: number,
  screenY: number,
): void {
  const chip = document.createElement("div");
  chip.className = "level-inline-chip";
  chip.style.cssText = [
    "position:fixed",
    `left:${screenX + 12}px`,
    `top:${screenY - 20}px`,
    "display:flex",
    "gap:4px",
    "align-items:center",
    "background:var(--chrome-secondary,#2a2a2a)",
    "border:1px solid var(--hairline,#444)",
    "border-radius:4px",
    "padding:3px 6px",
    "font-size:11px",
    "color:var(--ink-body,#ddd)",
    "z-index:9999",
    "box-shadow:0 2px 8px rgba(0,0,0,0.5)",
  ].join(";");

  const nameIn = document.createElement("input");
  nameIn.type = "text";
  nameIn.placeholder = "Name";
  nameIn.style.cssText = "width:90px; font-size:11px; padding:2px 4px; background:var(--chrome,#1a1a1a); border:1px solid var(--hairline,#444); color:var(--ink-body,#ddd); border-radius:3px;";
  const _chipImperial = (window as unknown as { __appState?: { unitSystem?: string } }).__appState?.unitSystem === "imperial"
    || document.documentElement.dataset.unitSystem === "imperial";
  const _FT = 3.28084;
  const _defaultHtM = 3.0;
  const _defaultHtDisplay = _chipImperial ? (_defaultHtM * _FT).toFixed(1) : _defaultHtM.toFixed(1);
  const _htUnit = _chipImperial ? "ft" : "m";
  const hIn = document.createElement("input");
  hIn.type = "number";
  hIn.step = _chipImperial ? "0.5" : "0.1";
  hIn.placeholder = `Ht (${_htUnit})`;
  hIn.value = _defaultHtDisplay;
  hIn.style.cssText = "width:48px; font-size:11px; padding:2px 4px; background:var(--chrome,#1a1a1a); border:1px solid var(--hairline,#444); color:var(--ink-body,#ddd); border-radius:3px;";
  const htUnitLbl = document.createElement("span");
  htUnitLbl.textContent = _htUnit;
  htUnitLbl.style.cssText = "font-size:10px; color:var(--ink-faint); flex-shrink:0;";

  const commit = () => {
    const name = nameIn.value.trim();
    const rawHt = parseFloat(hIn.value);
    const height = _chipImperial && !isNaN(rawHt) ? rawHt / _FT : rawHt;
    levelStore.update(levelId, {
      ...(name ? { name } : {}),
      ...(!isNaN(height) ? { height } : {}),
    });
    chip.remove();
  };

  nameIn.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") chip.remove(); });
  hIn.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") chip.remove(); });
  hIn.addEventListener("blur", () => setTimeout(commit, 100));

  chip.appendChild(nameIn);
  chip.appendChild(hIn);
  chip.appendChild(htUnitLbl);
  document.body.appendChild(chip);
  setTimeout(() => nameIn.focus(), 10);

  setTimeout(() => {
    const outside = (e: MouseEvent) => { if (!chip.contains(e.target as Node)) { chip.remove(); document.removeEventListener("mousedown", outside); } };
    document.addEventListener("mousedown", outside);
  }, 200);

  void viewer; // viewer reference reserved for future worldToScreen projection
}
