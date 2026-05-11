// Create-mode click-to-place pipeline (T4 Phase 3).
//
// When a tool button in the left palette is active (Line / Rect / Circle /
// Wall / Slab / Column / Door / Window / etc.), viewport mousedown becomes a
// sketch event. This module wires the active-tool state, captures clicks,
// unprojects them to world coords on the XY plane (z=0 per
// docs/tier1-conventions.md), runs the per-tool handler, builds the matching
// Three.js mesh, and pushes a replicad-chain string into the construction
// sequence.
//
// What is fully wired (working):
//   - Wall, Rect, Circle, Line, Door, Window, Slab, Column,
//     Polyline (4-click auto-close), Polygon (hex), Stair,
//     Box (3-corner: c1→c2 diagonal base, c3→height), Curve (Enter to commit)
//
// What is stubbed (logs to console, awaits parent task to wire kernel call):
//   - Arc, Spline, Revolve

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Viewer } from "./viewer";
import { setState } from "../app-state";
import { dispatchSync } from "../commands/dispatch";
import { snapPoint, getSnap } from "./snap-state";
import { pushAction } from "../history";
import { getActiveCommandSession, provideSessionPick, provideSessionChoice, clearCommandSession, commitCommandSession } from "../commands/command-session";
import type { ChoiceOption } from "../commands/dictionary";
import { gridStore } from "../grids";
import { levelStore } from "../levels";
import { refLineStore } from "../ref-lines";

// Default heights / sizes from tier1-conventions.
const DEFAULT_WALL_HEIGHT = 3;
const DEFAULT_WALL_THICKNESS = 0.2;
const DEFAULT_SLAB_THICKNESS = 0.2;
const DEFAULT_COLUMN_HEIGHT = 4;
const DEFAULT_RECT_HEIGHT = 2.8;
const DEFAULT_DOOR_W = 0.9;
const DEFAULT_DOOR_H = 2.1;
const DEFAULT_WINDOW_W = 1.2;
const DEFAULT_WINDOW_H = 1.4;
const DEFAULT_WINDOW_SILL = 1.0;
const DEFAULT_STAIR_RISE = 0.18;
const DEFAULT_STAIR_TREAD = 0.28;
const DEFAULT_STAIR_WIDTH = 1.0;
const DEFAULT_POLYGON_SIDES = 6;
const DEFAULT_EXTRUDE_HEIGHT = 2.5;
const DEFAULT_BEAM_SIZE = 0.2;
const DEFAULT_FOUNDATION_T = 0.5;
const DEFAULT_CEILING_T = 0.05;
const DEFAULT_RAMP_WIDTH = 1.2;
const DEFAULT_RAILING_H = 1.0;

// Append-only construction sequence.
const _createSequence: string[] = [];

export function getCreateSequence(): string[] {
  return [..._createSequence];
}

export function clearCreateSequence(): void {
  _createSequence.length = 0;
}

// Pending click buffer — z is only set for the "level" tool (geometry raycast elevation).
let _pending: Array<{ x: number; y: number; z?: number }> = [];
// Last pointer screen position — used by inline chip after level/datum placement.
let _lastPointerClient: { x: number; y: number } = { x: 0, y: 0 };
// Temporary scene objects — removed when the tool completes or is cancelled.
let _previewMesh: THREE.Mesh | null = null;
let _markerMesh: THREE.Points | null = null;
// Cursor dot — CSS overlay div that tracks the pointer when a sketch tool is active.
let _cursorDot: HTMLElement | null = null;
// Viewer reference set once by initCreateMode — used by resetPending.
let _viewer: Viewer | null = null;

let _pickerPromptEl: HTMLElement | null = null;
let _chooserEl: HTMLElement | null = null;

export function setPickerHint(msg: string | null): void {
  if (!_pickerPromptEl) return;
  if (msg) {
    _pickerPromptEl.textContent = msg;
    _pickerPromptEl.classList.add("visible");
  } else {
    _pickerPromptEl.classList.remove("visible");
  }
}

export function setChooserHint(choice: { arg: string; options: ChoiceOption[] } | null): void {
  if (!_chooserEl) return;
  if (!choice) {
    _chooserEl.classList.remove("visible");
    _chooserEl.innerHTML = "";
    return;
  }
  _chooserEl.innerHTML = "";
  const label = document.createElement("div");
  label.className = "chooser-label";
  label.textContent = `Choose ${choice.arg}:`;
  _chooserEl.appendChild(label);
  for (const opt of choice.options) {
    const chip = document.createElement("button");
    chip.className = "chooser-chip";
    chip.textContent = opt.label;
    chip.title = opt.description;
    chip.addEventListener("click", () => {
      void provideSessionChoice(opt.value).then((result) => {
        if (result.status === "needs_choice" && result.awaiting_text_choice) {
          setChooserHint(result.awaiting_text_choice);
        } else {
          setChooserHint(null);
          setPickerHint(result.status === "needs_input" ? (result.summary ?? null) : null);
        }
      });
    });
    _chooserEl.appendChild(chip);
  }
  _chooserEl.classList.add("visible");
}

function readActiveTool(): string | null {
  const btn = document.querySelector<HTMLElement>(".palette-btn.active");
  const id = btn?.dataset.tool ?? null;
  if (!id || id === "select" || id === "move" || id === "rotate" || id === "scale") return null;
  return id;
}

// ── Vertex snap ──────────────────────────────────────────────────────────────
// Snap candidates are explicit endpoint lists stored on each geometry mesh as
// userData.endpoints. Builders that set endpoints: buildWall, buildLine,
// buildPolyline. Others fall through to grid-only snap.

type SnapVertex = { x: number; y: number; z: number; id: string };
let _snapTarget: SnapVertex | null = null;
export function getSnapTarget(): SnapVertex | null { return _snapTarget; }

// ── Host-aware placement (door / window / opening) ───────────────────────────
// On click, raycast against scene objects before committing the tool. If no valid
// host is hit, reject the click and show a prompt. The host object's ID is stored
// in _pendingHostId so builders can stamp it onto userData.hostExpressID.

const HOST_TOOL_CREATORS: Record<string, string[]> = {
  door:    ["wall"],
  window:  ["wall"],
  opening: ["wall", "slab", "ceiling", "roof"],
};

let _pendingHostId: string | null = null;

function findHostMesh(
  viewer: Viewer,
  clientX: number,
  clientY: number,
  validCreators: string[],
): THREE.Object3D | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getCamera() as THREE.PerspectiveCamera);
  const hits = raycaster.intersectObjects(viewer.getScene().children, true);
  for (const hit of hits) {
    const obj = hit.object;
    const creator = (obj.userData as { creator?: string }).creator ?? "";
    if (validCreators.includes(creator)) return obj;
    // Also check parent (some builders wrap geometry in a Group)
    const parent = obj.parent;
    if (parent) {
      const parentCreator = (parent.userData as { creator?: string }).creator ?? "";
      if (validCreators.includes(parentCreator)) return parent;
    }
  }
  return null;
}

function makeSnapId(x: number, y: number, z = 0): string {
  return `v:${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`;
}

function collectSnapVertices(viewer: Viewer): SnapVertex[] {
  const scene = viewer.getScene();
  const out: SnapVertex[] = [];
  const seen = new Set<string>();
  scene.traverse((obj) => {
    const eps = (obj.userData as { endpoints?: SnapVertex[] }).endpoints;
    if (!eps) return;
    for (const ep of eps) {
      if (!seen.has(ep.id)) { seen.add(ep.id); out.push(ep); }
    }
  });
  return out;
}

const VERTEX_SNAP_PX = 20;
function nearestSnapVertex(viewer: Viewer, clientX: number, clientY: number): SnapVertex | null {
  const snap = getSnap();
  if (!snap.snapOn || !snap.vertexSnapOn) return null;
  const verts = collectSnapVertices(viewer);
  let best: SnapVertex | null = null;
  let bestD = VERTEX_SNAP_PX;
  for (const v of verts) {
    const sc = projectToScreen(viewer, v.x, v.y, v.z);
    if (!sc) continue;
    const d = Math.hypot(sc.x - clientX, sc.y - clientY);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────

// Project a world-space XY point to screen (client) coordinates.
// Returns null when the point is behind the camera.
function projectToScreen(viewer: Viewer, x: number, y: number, z = 0): { x: number; y: number } | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const camera = viewer.getCamera();
  const v = new THREE.Vector3(x, y, z).project(camera as THREE.PerspectiveCamera);
  if (v.z > 1) return null; // behind camera
  return {
    x: (v.x * 0.5 + 0.5) * rect.width + rect.left,
    y: (-v.y * 0.5 + 0.5) * rect.height + rect.top,
  };
}

// Unproject canvas-space (px) to world coords on the XY plane (z=0).
function unprojectToXY(viewer: Viewer, clientX: number, clientY: number): THREE.Vector3 | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const camera = viewer.getCamera();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera as THREE.PerspectiveCamera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const point = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(plane, point);
  if (hit) return point;
  // Ray nearly parallel to Z=0 (near-horizontal camera) — fall back to camera XY projected onto Z=0.
  return new THREE.Vector3(camera.position.x, camera.position.y, 0);
}

// Raycast against scene geometry to inherit Z elevation (for level placement, AC B.1).
// Falls back to 0 when no geometry is hit (e.g. empty scene or top-down view hitting ground).
function getGeometryZ(viewer: Viewer, clientX: number, clientY: number): number {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getCamera() as THREE.PerspectiveCamera);
  const hits = raycaster.intersectObjects(viewer.getScene().children, true);
  return hits.length > 0 ? hits[0].point.z : 0;
}

// Show an inline chip at screen position (x, y) for editing a newly placed level.
function showLevelChip(
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
  const hIn = document.createElement("input");
  hIn.type = "number";
  hIn.step = "0.1";
  hIn.placeholder = "Ht (m)";
  hIn.value = "3.0";
  hIn.style.cssText = "width:58px; font-size:11px; padding:2px 4px; background:var(--chrome,#1a1a1a); border:1px solid var(--hairline,#444); color:var(--ink-body,#ddd); border-radius:3px;";

  const commit = () => {
    const name = nameIn.value.trim();
    const height = parseFloat(hIn.value);
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
  document.body.appendChild(chip);
  setTimeout(() => nameIn.focus(), 10);

  // Auto-remove if user clicks elsewhere (after a tick so the placement click doesn't immediately close it).
  setTimeout(() => {
    const outside = (e: MouseEvent) => { if (!chip.contains(e.target as Node)) { chip.remove(); document.removeEventListener("mousedown", outside); } };
    document.addEventListener("mousedown", outside);
  }, 200);

  void viewer; // viewer reference reserved for future worldToScreen projection
}

// --- Tool handlers ---

function buildWall(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  const midX = (a.x + b.x) / 2;
  const midY = (a.y + b.y) / 2;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(length, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(midX, midY, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "wall";
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
    { x: midX, y: midY, z: 0, id: makeSnapId(midX, midY, 0) },
  ] as SnapVertex[];
  const chain = `const wall = makeBox(${round(length)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(midX)}, ${round(midY)}, 0]);`;
  return { mesh, chain };
}

function buildRect(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.max(0.01, Math.abs(b.x - a.x));
  const d = Math.max(0.01, Math.abs(b.y - a.y));
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const x0 = -w / 2, x1 = w / 2;
  const y0 = -d / 2, y1 = d / 2;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([
    x0, y0, 0,
    x1, y0, 0,
    x1, y1, 0,
    x0, y1, 0,
  ], 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xc9b18a });
  const mesh = new THREE.LineLoop(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "rectangle";
  mesh.userData.creator = "rect";
  const h = DEFAULT_RECT_HEIGHT;
  const chain = `const rect = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh: mesh as unknown as THREE.Mesh, chain };
}

function buildCircle(center: { x: number; y: number }, radial: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = radial.x - center.x;
  const dy = radial.y - center.y;
  const r = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const segs = 64;
  const pts: number[] = [];
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    pts.push(r * Math.cos(t), r * Math.sin(t), 0);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xb6d59a });
  const mesh = new THREE.LineLoop(geom, mat);
  mesh.position.set(center.x, center.y, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "circle";
  mesh.userData.creator = "circle";
  const h = DEFAULT_RECT_HEIGHT;
  const chain = `const cyl = makeCylinder(${round(r)}, ${round(h)}).translate([${round(center.x)}, ${round(center.y)}, 0]);`;
  return { mesh: mesh as unknown as THREE.Mesh, chain };
}

function buildLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([
    a.x - cx, a.y - cy, 0,
    b.x - cx, b.y - cy, 0,
  ], 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x2d2d35 });
  const mesh = new THREE.LineSegments(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "line";
  mesh.userData.creator = "line";
  mesh.userData.controlPoints = [new THREE.Vector3(a.x - cx, a.y - cy, 0), new THREE.Vector3(b.x - cx, b.y - cy, 0)];
  mesh.userData.endpoints = [
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
    { x: cx, y: cy, z: 0, id: makeSnapId(cx, cy, 0) },
  ] as SnapVertex[];
  const chain = `const line = drawPolyline([[${round(a.x)}, ${round(a.y)}], [${round(b.x)}, ${round(b.y)}]]).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

function buildDoor(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_DOOR_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_DOOR_H;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff5c5c, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "door";
  if (_pendingHostId) mesh.userData.hostExpressID = _pendingHostId;
  const chain = `// door: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]))`;
  return { mesh, chain };
}

function buildWindow(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = DEFAULT_WINDOW_W;
  const t = DEFAULT_WALL_THICKNESS;
  const h = DEFAULT_WINDOW_H;
  const sill = DEFAULT_WINDOW_SILL;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.4 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, sill);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "window";
  if (_pendingHostId) mesh.userData.hostExpressID = _pendingHostId;
  const chain = `// window: cut against host wall — wall.cut(makeBox(${round(w)}, ${round(t)}, ${round(h)}).translate([${round(p.x)}, ${round(p.y)}, ${round(sill)}]))`;
  return { mesh, chain };
}

function buildSlab(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x);
  const d = Math.abs(b.y - a.y);
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const t = DEFAULT_SLAB_THICKNESS;
  const geom = new THREE.BoxGeometry(w, d, t);
  geom.translate(0, 0, t / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa8a097, roughness: 0.7, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "slab";
  const chain = `const slab = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(t)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

function buildColumn(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const s = 0.3;
  const h = DEFAULT_COLUMN_HEIGHT;
  const geom = new THREE.BoxGeometry(s, s, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd1c5b0, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "column";
  const chain = `const col = drawRectangle(${round(s)}, ${round(s)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(p.x)}, ${round(p.y)}, 0]);`;
  return { mesh, chain };
}

function buildStair(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const run = Math.sqrt(dx * dx + dy * dy);
  const tread = DEFAULT_STAIR_TREAD;
  const rise = DEFAULT_STAIR_RISE;
  const width = DEFAULT_STAIR_WIDTH;
  // At least 2 steps for any non-degenerate input.
  const steps = Math.max(2, Math.floor(run / tread));
  const actualTread = run / steps;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  // Build each step as a Box centered along stair-local +X.
  // Step i (0-indexed): bottom-front face at x=i*tread, height (i+1)*rise.
  const stepGeoms: THREE.BoxGeometry[] = [];
  for (let i = 0; i < steps; i++) {
    const stepH = (i + 1) * rise;
    const g = new THREE.BoxGeometry(actualTread, width, stepH);
    // Position: center at (i*tread + tread/2, 0, stepH/2).
    g.translate(i * actualTread + actualTread / 2, 0, stepH / 2);
    stepGeoms.push(g);
  }
  const merged = mergeGeometries(stepGeoms, false);
  // Dispose the per-step geoms — merged owns the buffer now.
  stepGeoms.forEach((g) => g.dispose());
  if (!merged) {
    // mergeGeometries returns null on attribute mismatch — fall back to a single bbox.
    const fallback = new THREE.BoxGeometry(run, width, steps * rise);
    fallback.translate(run / 2, 0, (steps * rise) / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb89968, roughness: 0.6, metalness: 0.05 });
    const mesh = new THREE.Mesh(fallback, mat);
    mesh.position.set(a.x, a.y, 0);
    mesh.rotation.z = (angDeg * Math.PI) / 180;
    mesh.userData.kind = "compound";
    mesh.userData.creator = "stair";
    const chain = `// stair: ${steps} steps, fallback bbox — compound([...risers,...treads])`;
    return { mesh, chain };
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xb89968, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.position.set(a.x, a.y, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "compound";
  mesh.userData.creator = "stair";
  // Chain string is display-only — kernel doesn't natively support `compound([...])`,
  // so emit a sensible-looking call. TODO is intentional — see TOOL_TODOS.
  const chain = `const stair = compound([/* ${steps} risers + ${steps} treads — TODO kernel mapping */]).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(a.x)}, ${round(a.y)}, 0]);`;
  return { mesh, chain };
}

function buildPolygon(center: { x: number; y: number }, radial: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = radial.x - center.x;
  const dy = radial.y - center.y;
  const r = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const sides = DEFAULT_POLYGON_SIDES;
  const h = DEFAULT_EXTRUDE_HEIGHT;
  // Build hex Shape in local XY centered at origin, starting angle aligned with radial click.
  const startAng = Math.atan2(dy, dx);
  const shape = new THREE.Shape();
  const verts: Array<[number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const ang = startAng + (i * 2 * Math.PI) / sides;
    const x = r * Math.cos(ang);
    const y = r * Math.sin(ang);
    verts.push([x, y]);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
  const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(center.x, center.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "polygon";
  // Chain: drawPolyline of N world-space vertices, then extrude.
  const worldVerts = verts.map(([x, y]) => `[${round(center.x + x)}, ${round(center.y + y)}]`).join(", ");
  const chain = `const poly = drawPolyline([${worldVerts}], { close: true }).sketchOnPlane("XY").extrude(${round(h)});`;
  return { mesh, chain };
}

function buildPolyline(pts: Array<{ x: number; y: number }>): { mesh: THREE.Object3D; chain: string } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const geom = new THREE.BufferGeometry();
  const flat = pts.flatMap((p) => [p.x - cx, p.y - cy, 0]);
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x1565c0 });
  const mesh = new THREE.Line(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "polyline";
  mesh.userData.creator = "polyline";
  mesh.userData.controlPoints = pts.map((p) => new THREE.Vector3(p.x - cx, p.y - cy, 0));
  const worldVerts = pts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const poly = drawPolyline([${worldVerts}]).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

function buildExtrude(base: { x: number; y: number }, top: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  // Simplified 2-click extrude: click1 = base point, click2 = "top" point.
  // The horizontal distance between the two clicks defines the height of a
  // unit-square (1m × 1m) extrusion centered at the base point. Real
  // profile-selection extrude is gated on TransformControls + selection state
  // (see TOOL_TODOS["extrude"]).
  const dx = top.x - base.x;
  const dy = top.y - base.y;
  const h = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const s = 1.0; // unit square footprint
  const geom = new THREE.BoxGeometry(s, s, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(base.x, base.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "extrude";
  const chain = `const ext = drawRectangle(${round(s)}, ${round(s)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(base.x)}, ${round(base.y)}, 0]);`;
  return { mesh, chain };
}

function buildCurve(pts: Array<{ x: number; y: number }>): { mesh: THREE.Object3D; chain: string } {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const vecs = pts.map((p) => new THREE.Vector3(p.x - cx, p.y - cy, 0));
  const curve = new THREE.CatmullRomCurve3(vecs, false, "catmullrom", 0.5);
  const sampled = curve.getPoints(Math.max(pts.length * 16, 64));
  const geom = new THREE.BufferGeometry().setFromPoints(sampled);
  const mat = new THREE.LineBasicMaterial({ color: 0x1565c0 });
  const mesh = new THREE.Line(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "curve";
  mesh.userData.creator = "curve";
  mesh.userData.controlPoints = vecs;
  const worldPts = pts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const curv = drawSpline([${worldPts}]).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

function makePointMaterial(sizePx = 14): THREE.PointsMaterial {
  const canvas = document.createElement("canvas");
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(16, 16, 12, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 3;
  ctx.stroke();
  return new THREE.PointsMaterial({
    size: sizePx, sizeAttenuation: false,
    map: new THREE.CanvasTexture(canvas),
    transparent: true, alphaTest: 0.1, depthTest: false,
  });
}

function buildPoint(p: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const r = 0.06;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const group = new THREE.Points(geom, makePointMaterial());
  group.position.set(p.x, p.y, 0);
  group.renderOrder = 1;
  group.userData.kind = "point";
  group.userData.creator = "point";
  const chain = `const pt = makeCylinder(${round(r)}, ${round(r * 2)}).translate([${round(p.x)}, ${round(p.y)}, 0]);`;
  return { mesh: group, chain };
}

// 3-corner box (#30): c1 + c2 define the base rectangle as a diagonal pair;
// c3's distance from the base center determines the extrusion height.
function buildBox(
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  c3: { x: number; y: number },
): { mesh: THREE.Object3D; chain: string } {
  const w = Math.max(0.05, Math.abs(c2.x - c1.x));
  const d = Math.max(0.05, Math.abs(c2.y - c1.y));
  const cx = (c1.x + c2.x) / 2;
  const cy = (c1.y + c2.y) / 2;
  const distToCenter = Math.sqrt((c3.x - cx) ** 2 + (c3.y - cy) ** 2);
  const h = Math.max(0.05, distToCenter);
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "box";
  const chain = `const box = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

function buildBeam(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const s = DEFAULT_BEAM_SIZE;
  const h = DEFAULT_COLUMN_HEIGHT;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const geom = new THREE.BoxGeometry(len, s, s);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa0856a, roughness: 0.6, metalness: 0.1 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, h);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "beam";
  const chain = `const beam = makeBox(${round(len)}, ${round(s)}, ${round(s)}).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round((a.x + b.x) / 2)}, ${round((a.y + b.y) / 2)}, ${round(h)}]);`;
  return { mesh, chain };
}

function buildRoof(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const ridgeH = Math.max(0.5, Math.min(w, d) * 0.3);
  const geom = new THREE.BoxGeometry(w, d, ridgeH);
  geom.translate(0, 0, ridgeH / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a5c4a, roughness: 0.75, metalness: 0.02 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, DEFAULT_WALL_HEIGHT);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "roof";
  const chain = `const roof = makeBox(${round(w)}, ${round(d)}, ${round(ridgeH)}).translate([${round(cx)}, ${round(cy)}, ${round(DEFAULT_WALL_HEIGHT)}]);`;
  return { mesh, chain };
}

function buildSpace(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const h = DEFAULT_RECT_HEIGHT;
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x90c8ff, transparent: true, opacity: 0.15, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "space";
  const chain = `const space = makeBox(${round(w)}, ${round(d)}, ${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

function buildFoundation(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const t = DEFAULT_FOUNDATION_T;
  const geom = new THREE.BoxGeometry(w, d, t);
  geom.translate(0, 0, -t / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x8a7563, roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "foundation";
  const chain = `const foundation = makeBox(${round(w)}, ${round(d)}, ${round(t)}).translate([${round(cx)}, ${round(cy)}, ${round(-t / 2)}]);`;
  return { mesh, chain };
}

function buildCeiling(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 1;
  const d = Math.abs(b.y - a.y) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const t = DEFAULT_CEILING_T;
  const elev = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(w, d, t);
  const mat = new THREE.MeshStandardMaterial({ color: 0xfaf5ec, roughness: 0.5, metalness: 0.02 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, elev);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "ceiling";
  const chain = `const ceiling = makeBox(${round(w)}, ${round(d)}, ${round(t)}).translate([${round(cx)}, ${round(cy)}, ${round(elev)}]);`;
  return { mesh, chain };
}

function buildCurtainWall(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const t = 0.02;
  const h = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(len, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0xaadcff, transparent: true, opacity: 0.35 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "curtainwall";
  const chain = `const cw = makeBox(${round(len)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round((a.x + b.x) / 2)}, ${round((a.y + b.y) / 2)}, 0]);`;
  return { mesh, chain };
}

function buildSkylight(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.abs(b.x - a.x) || 0.5;
  const d = Math.abs(b.y - a.y) || 0.5;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const elev = DEFAULT_WALL_HEIGHT;
  const geom = new THREE.BoxGeometry(w, d, 0.04);
  const mat = new THREE.MeshBasicMaterial({ color: 0xeef5ff, transparent: true, opacity: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, elev);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "skylight";
  const chain = `const skylight = makeBox(${round(w)}, ${round(d)}, 0.04).translate([${round(cx)}, ${round(cy)}, ${round(elev)}]);`;
  return { mesh, chain };
}

function buildOpening(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = 1, h = 2, t = 0.25;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1, wireframe: true });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "opening";
  if (_pendingHostId) mesh.userData.hostExpressID = _pendingHostId;
  const chain = `// opening: ${round(w)}×${round(h)} void at [${round(p.x)}, ${round(p.y)}, 0]`;
  return { mesh, chain };
}

function buildRamp(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const run = Math.sqrt(dx * dx + dy * dy) || 1;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const w = DEFAULT_RAMP_WIDTH;
  const totalH = run / 12;
  const geom = new THREE.BoxGeometry(run, w, 0.15);
  geom.translate(run / 2, 0, totalH / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc4a882, roughness: 0.65, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(a.x, a.y, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "ramp";
  const chain = `const ramp = makeBox(${round(run)}, ${round(w)}, 0.15).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round(a.x)}, ${round(a.y)}, 0]);`;
  return { mesh, chain };
}

function buildRailing(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const h = DEFAULT_RAILING_H;
  const geom = new THREE.BoxGeometry(len, 0.05, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x555566, roughness: 0.4, metalness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0);
  mesh.rotation.z = (angDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "railing";
  const chain = `const railing = makeBox(${round(len)}, 0.05, ${round(h)}).rotate(${round(angDeg)}, [0,0,0], [0,0,1]).translate([${round((a.x + b.x) / 2)}, ${round((a.y + b.y) / 2)}, 0]);`;
  return { mesh, chain };
}

function buildGridLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const angRad = Math.atan2(dy, dx) - Math.PI / 2;

  // Architectural dash-dot-dash: alternating long dash / short dot segments.
  // LineDashedMaterial only supports uniform patterns, so use dashSize + gapSize
  // tuned to approximate the standard grid-line style.
  const points = [new THREE.Vector3(0, -len / 2, 0), new THREE.Vector3(0, len / 2, 0)];
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineDashedMaterial({ color: 0x1a56cc, dashSize: 0.5, gapSize: 0.15 });
  const line = new THREE.Line(geom, mat);
  line.computeLineDistances();
  line.position.set(cx, cy, 0.001);
  line.rotation.z = angRad;

  // Auto-label: count existing IfcGridLine objects in scene
  const existingCount = _viewer
    ? _viewer.getScene().children.filter((o) => o.userData.creator === "IfcGridLine").length
    : 0;
  const label = String.fromCharCode(65 + existingCount % 26); // A, B, C…

  line.userData.kind = "grid-line";
  line.userData.creator = "IfcGridLine";
  line.userData.label = label;
  line.userData.controlPoints = [[a.x, a.y, 0], [b.x, b.y, 0]];

  const chain = `IfcGridLine({origin:[${round(a.x)},${round(a.y)}],end:[${round(b.x)},${round(b.y)}]})`;
  return { mesh: line, chain };
}

function buildLevel(p: { x: number; y: number; z?: number }): { mesh: THREE.Object3D; chain: string; levelId: string } {
  const elevation = p.z ?? 0;
  const name = `Level ${levelStore.all().length}`;
  const level = levelStore.findOrCreate(name, elevation, 3.0);
  const extent = 10;
  const geom = new THREE.BoxGeometry(extent, extent, 0.02);
  const mat = new THREE.MeshBasicMaterial({ color: 0x44aa88, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, elevation);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcLevel";
  mesh.userData.levelId = level.id;
  const chain = `IfcLevel({elevation:${elevation},name:"${name}",height:3.0})`;
  return { mesh, chain, levelId: level.id };
}

function buildReferenceLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const angRad = Math.atan2(dy, dx) - Math.PI / 2;
  const points = [new THREE.Vector3(0, -len / 2, 0), new THREE.Vector3(0, len / 2, 0)];
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0xcc1166 });
  const line = new THREE.Line(geom, mat);
  line.position.set(cx, cy, 0.002);
  line.rotation.z = angRad;
  const entry = refLineStore.add({ start: [a.x, a.y], end: [b.x, b.y] });
  line.userData.kind = "reference-line";
  line.userData.creator = "IfcReferenceLine";
  line.userData.refLineId = entry.id;
  line.userData.controlPoints = [[a.x, a.y, 0], [b.x, b.y, 0]];
  const chain = `IfcReferenceLine({origin:[${round(a.x)},${round(a.y)}],end:[${round(b.x)},${round(b.y)}]})`;
  return { mesh: line, chain };
}

type ToolHandler = {
  // Number of clicks to auto-commit. -1 = unlimited: collect until Enter.
  clicks: number;
  handler: (pts: Array<{ x: number; y: number; z?: number }>) => {
    mesh: THREE.Object3D;
    chain: string;
    // If set, fired via dispatchSync on commit (not during rubber-band preview).
    dispatchOnCommit?: { verb: string; args: Record<string, unknown> };
  };
};

function buildSectionBox(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const minZ = -0.1, maxZ = 6.0;
  const w = maxX - minX || 0.1, d = maxY - minY || 0.1, h = maxZ - minZ;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
  const geom = new THREE.BoxGeometry(w, d, h);
  const edges = new THREE.EdgesGeometry(geom);
  geom.dispose();
  const mat = new THREE.LineBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.7 });
  const mesh = new THREE.LineSegments(edges, mat);
  mesh.position.set(cx, cy, cz);
  mesh.userData.kind = "section-box";
  mesh.userData.creator = "SdSectionBox";
  mesh.userData.excludeFromClip = true;
  const min: [number, number, number] = [round(minX), round(minY), round(minZ)];
  const max: [number, number, number] = [round(maxX), round(maxY), round(maxZ)];
  return {
    mesh,
    chain: `SdSectionBox({min:[${min}],max:[${max}]})`,
    dispatchOnCommit: { verb: "SdSectionBox", args: { min, max } },
  };
}

function buildClipPlane(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lineLen = Math.sqrt(dx * dx + dy * dy) || 1;
  // Normal perpendicular to line direction, pointing to the "right" of a→b
  const nx = -dy / lineLen, ny = dx / lineLen;
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const planeH = 4;
  const geom = new THREE.PlaneGeometry(lineLen, planeH);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, planeH / 2);
  mesh.rotation.set(Math.PI / 2, 0, Math.atan2(dy, dx));
  mesh.userData.kind = "clip-plane";
  mesh.userData.creator = "SdClippingPlane";
  mesh.userData.excludeFromClip = true;
  const label = `clip-${Date.now()}`;
  mesh.userData.clipLabel = label;
  const origin: [number, number, number] = [round(cx), round(cy), 0];
  const normal: [number, number, number] = [round(nx), round(ny), 0];
  return {
    mesh,
    chain: `SdClippingPlane({origin:[${origin}],normal:[${normal}],label:"${label}"})`,
    dispatchOnCommit: { verb: "SdClippingPlane", args: { origin, normal, label } },
  };
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  wall:     { clicks: 2, handler: ([a, b]) => buildWall(a, b) },
  rect:     { clicks: 2, handler: ([a, b]) => buildRect(a, b) },
  circle:   { clicks: 2, handler: ([a, b]) => buildCircle(a, b) },
  line:     { clicks: 2, handler: ([a, b]) => buildLine(a, b) },
  slab:     { clicks: 2, handler: ([a, b]) => buildSlab(a, b) },
  door:     { clicks: 1, handler: ([p]) => buildDoor(p) },
  window:   { clicks: 1, handler: ([p]) => buildWindow(p) },
  column:   { clicks: 1, handler: ([p]) => buildColumn(p) },
  // T4 tool implementations — see buildStair / buildPolygon / buildPolyline /
  // buildExtrude for design notes. polyline is fixed at 4 clicks for the demo
  // (variable click-count would require a sentinel-terminate UX change to the
  // emitClickWorld pipeline).
  stair:    { clicks: 2, handler: ([a, b]) => buildStair(a, b) },
  polygon:  { clicks: 2, handler: ([a, b]) => buildPolygon(a, b) },
  polyline: { clicks: 4, handler: (pts) => buildPolyline(pts) },
  curve:    { clicks: -1, handler: (pts) => buildCurve(pts) },
  point:    { clicks: 1, handler: ([p]) => buildPoint(p) },
  extrude:      { clicks: 3, handler: ([c1, c2, c3]) => buildBox(c1, c2, c3) },
  beam:         { clicks: 2, handler: ([a, b]) => buildBeam(a, b) },
  roof:         { clicks: 2, handler: ([a, b]) => buildRoof(a, b) },
  space:        { clicks: 2, handler: ([a, b]) => buildSpace(a, b) },
  foundation:   { clicks: 2, handler: ([a, b]) => buildFoundation(a, b) },
  ceiling:      { clicks: 2, handler: ([a, b]) => buildCeiling(a, b) },
  curtainwall:  { clicks: 2, handler: ([a, b]) => buildCurtainWall(a, b) },
  skylight:     { clicks: 2, handler: ([a, b]) => buildSkylight(a, b) },
  opening:      { clicks: 1, handler: ([p]) => buildOpening(p) },
  ramp:         { clicks: 2, handler: ([a, b]) => buildRamp(a, b) },
  railing:      { clicks: 2, handler: ([a, b]) => buildRailing(a, b) },
  grid:         { clicks: 2, handler: ([a, b]) => buildGridLine(a, b) },
  level:        { clicks: 1, handler: ([p]) => buildLevel(p) },
  datum:        { clicks: 2, handler: ([a, b]) => buildReferenceLine(a, b) },
  section:      { clicks: 2, handler: ([a, b]) => buildSectionBox(a, b) },
  clip:         { clicks: 2, handler: ([a, b]) => buildClipPlane(a, b) },
};

const TOOL_TODOS: Record<string, string> = {
  arc:       "draw(start).arcTo(end, [via]).sketchOnPlane('XY').extrude(thickness)",
  spline:    "draw(start).bezierTo(end, [c1], [c2]).sketchOnPlane('XY').extrude(thickness)",
  revolve:   "select profile then axis then angle — TODO 3-step gizmo flow",
  fillet:    "select edges, set radius — TODO post-selection edit op",
  boolean:   "select two solids, choose op (fuse/cut/intersect)",
  move:      "select then drag — already covered by transform gizmo",
  rotate:    "select then drag — already covered by transform gizmo",
  scale:     "select then drag — already covered by transform gizmo",
};

// --- Temporary scene object management ---

function setMarker(viewer: Viewer, pt: { x: number; y: number }): void {
  clearMarker(viewer);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([pt.x, pt.y, 0.05], 3));
  const mat = new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, color: 0xff8800, depthTest: false });
  _markerMesh = new THREE.Points(geom, mat);
  _markerMesh.renderOrder = 999;
  viewer.getScene().add(_markerMesh);
}

function clearMarker(viewer: Viewer): void {
  if (!_markerMesh) return;
  viewer.getScene().remove(_markerMesh);
  _markerMesh.geometry.dispose();
  (_markerMesh.material as THREE.Material).dispose();
  _markerMesh = null;
}

function clearPreview(viewer: Viewer): void {
  if (!_previewMesh) return;
  viewer.getScene().remove(_previewMesh);
  _previewMesh.geometry.dispose();
  const mat = _previewMesh.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else (mat as THREE.Material).dispose();
  _previewMesh = null;
}

function clearTemporary(viewer: Viewer): void {
  clearPreview(viewer);
  clearMarker(viewer);
}

function ensureCursorDot(): HTMLElement {
  if (_cursorDot) return _cursorDot;
  const el = document.createElement("div");
  el.id = "sketch-cursor-dot";
  el.style.cssText = [
    "position:fixed",
    "width:12px",
    "height:12px",
    "border-radius:50%",
    "background:#ffffff",
    "border:2px solid #111111",
    "box-shadow:0 0 0 1px #ffffff",
    "pointer-events:none",
    "display:none",
    "transform:translate(-50%,-50%)",
    "z-index:9999",
  ].join(";");
  document.body.appendChild(el);
  _cursorDot = el;
  return el;
}

function moveCursorDot(_viewer: Viewer, _pt: { x: number; y: number }, clientX: number, clientY: number, vertexSnap = false): void {
  const dot = ensureCursorDot();
  dot.style.display = "block";
  dot.style.left = clientX + "px";
  dot.style.top = clientY + "px";
  if (vertexSnap) {
    dot.style.background = "#4caf50";
    dot.style.border = "2px solid #1b5e20";
    dot.style.boxShadow = "0 0 0 1px #4caf50,0 0 8px rgba(76,175,80,0.5)";
    dot.style.width = "14px";
    dot.style.height = "14px";
  } else {
    dot.style.background = "#ffffff";
    dot.style.border = "2px solid #111111";
    dot.style.boxShadow = "0 0 0 1px #ffffff";
    dot.style.width = "12px";
    dot.style.height = "12px";
  }
}

function hideCursorDot(): void {
  if (_cursorDot) _cursorDot.style.display = "none";
}

function destroyCursorDot(): void {
  if (!_cursorDot) return;
  _cursorDot.remove();
  _cursorDot = null;
}

function updateRubberBand(viewer: Viewer, handler: ToolHandler, livePoint: { x: number; y: number }): void {
  clearPreview(viewer);
  const isUnlimited = handler.clicks === -1;
  // Fixed-click tools only preview on 1 pending click; unlimited on ≥1.
  if (!isUnlimited && _pending.length !== 1) return;
  if (isUnlimited && _pending.length < 1) return;

  const previewPts = isUnlimited ? [..._pending, livePoint] : [_pending[0], livePoint];

  // Skip degenerate preview.
  const last = previewPts[previewPts.length - 1];
  const prev = previewPts[previewPts.length - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  if (dx * dx + dy * dy < 1e-4) return;

  // Unlimited tools need ≥2 pts to build geometry.
  if (isUnlimited && previewPts.length < 2) return;

  try {
    const out = handler.handler(previewPts);
    const preview = out.mesh;
    // Replace material(s) with a translucent preview version.
    const applyPreviewMat = (m: THREE.Mesh) => {
      const origMat = Array.isArray(m.material) ? m.material[0] : m.material;
      const previewMat = new THREE.MeshStandardMaterial({
        color: (origMat as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0x888888),
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        depthTest: false,
      });
      if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
      else (m.material as THREE.Material).dispose();
      m.material = previewMat;
      m.renderOrder = 1;
    };
    if (preview instanceof THREE.Mesh) {
      applyPreviewMat(preview);
      _previewMesh = preview;
    } else {
      // Group (e.g. point) — apply to all mesh children.
      preview.traverse((child) => { if (child instanceof THREE.Mesh) applyPreviewMat(child); });
      _previewMesh = preview as unknown as THREE.Mesh;
    }
    viewer.getScene().add(preview);
  } catch {
    // Degenerate geometry — skip preview
  }
}

// Commit the current unlimited-click tool (curve). Called by Enter key.
function commitUnlimited(viewer: Viewer): { mesh: THREE.Object3D; chain: string } | null {
  const tool = readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler || handler.clicks !== -1 || _pending.length < 2) return null;
  clearTemporary(viewer);
  const out = handler.handler(_pending);
  _pending = [];
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "mesh");
  _createSequence.push(out.chain);
  pushAction(out.mesh, out.chain);
  hideCursorDot();
  dispatchSync("setActiveTool", { toolId: "select" });
  return out;
}

// Test hook — emit a click programmatically given world-space coords.
export function emitClickWorld(viewer: Viewer, world: { x: number; y: number; z?: number }, opts?: { tool?: string }): { mesh: THREE.Object3D; chain: string } | null {
  const tool = opts?.tool ?? readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler) {
    const hint = TOOL_TODOS[tool] ?? "no kernel mapping yet";
    console.log(`[create-mode] tool '${tool}': ${hint}`);
    return null;
  }
  _pending.push(world);
  // Show point marker on first click of multi-click or unlimited tools.
  if (_pending.length === 1 && handler.clicks !== 1) {
    setMarker(viewer, world);
  }
  // Unlimited tools: never auto-commit; wait for Enter.
  if (handler.clicks === -1) return null;
  if (_pending.length < handler.clicks) return null;

  // All clicks collected — build final mesh.
  clearTemporary(viewer);
  const out = handler.handler(_pending);
  _pending = [];
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "brep");
  _createSequence.push(out.chain);
  pushAction(out.mesh, out.chain);
  if (out.dispatchOnCommit) {
    dispatchSync(out.dispatchOnCommit.verb, out.dispatchOnCommit.args);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  }
  // After committing a create operation, return to Select so transform-gizmo
  // interactions are not swallowed by create-mode capture listeners.
  dispatchSync("setActiveTool", { toolId: "select" });

  // Show inline chip for level placement (AC B.2) so the user can immediately
  // set name and storey height without opening the BUILDING LEVELS sidebar.
  if (tool === "level") {
    const levelId = (out as { levelId?: string }).levelId;
    if (levelId) showLevelChip(viewer, levelId, _lastPointerClient.x, _lastPointerClient.y);
  }

  return out;
}

// Reset pending click buffer — used when switching tools.
export function resetPending(): void {
  if (_viewer) clearTemporary(_viewer);
  hideCursorDot();
  _pending = [];
}

// Bind the create-mode pipeline to viewport mousedown. Coexists with the
// selection raycaster — when no create-tool is active, mousedown just falls
// through to viewer.onPointerDown for selection.
export function initCreateMode(viewer: Viewer): void {
  _viewer = viewer;
  // The THREE.js canvas has pointer-events:none — clicks land on .vp-body
  // children of the viewport area. Register on the viewport-area-host ancestor
  // (always present in static HTML) so the capture listener fires before any
  // .vp-body listeners registered during buildWorkbench/buildModes.
  const vpBody =
    document.getElementById("viewport-area-host") ??
    document.querySelector<HTMLElement>("#viewport-2 .vp-body") ??
    viewer.getCanvas();

  _pickerPromptEl = document.createElement("div");
  _pickerPromptEl.className = "picker-prompt";
  vpBody.appendChild(_pickerPromptEl);

  _chooserEl = document.createElement("div");
  _chooserEl.className = "chooser-overlay";
  vpBody.appendChild(_chooserEl);

  // Capture-phase listener — runs before the viewer's own pointerdown so we
  // can swallow the event when a create-tool is active or a session needs picks.
  vpBody.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const tool = readActiveTool();
    if (!tool) {
      const session = getActiveCommandSession();
      if (session?.state === "collecting_args") {
        const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
        if (!world) return;
        ev.stopImmediatePropagation();
        const snapped = snapPoint(world.x, world.y);
        void provideSessionPick([snapped.x, snapped.y]).then((result) => {
          if (result.status === "needs_choice" && result.awaiting_text_choice) {
            setChooserHint(result.awaiting_text_choice);
          } else {
            setChooserHint(null);
            setPickerHint(result.status === "needs_input" ? (result.summary ?? null) : null);
          }
        });
      }
      return;
    }
    const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
    if (!world) return;
    ev.stopImmediatePropagation();
    _lastPointerClient = { x: ev.clientX, y: ev.clientY };
    const vertex = !ev.altKey ? nearestSnapVertex(viewer, ev.clientX, ev.clientY) : null;
    const snapped = vertex ?? snapPoint(world.x, world.y);
    // For host-placement tools (door/window/opening) raycast to find a valid host.
    // Reject the click and prompt if no host is found.
    const hostCreators = HOST_TOOL_CREATORS[tool];
    if (hostCreators) {
      const host = findHostMesh(viewer, ev.clientX, ev.clientY, hostCreators);
      if (!host) {
        const label = hostCreators.length === 1 ? hostCreators[0] : hostCreators.join(" or ");
        setPickerHint(`click a ${label} to place`);
        return;
      }
      _pendingHostId = (host.userData as { expressID?: string; uuid?: string }).expressID ?? host.uuid;
      setPickerHint(null);
    }
    // For level placement, raycast against scene geometry to inherit Z elevation (AC B.1).
    const z = tool === "level" ? getGeometryZ(viewer, ev.clientX, ev.clientY) : undefined;
    emitClickWorld(viewer, { ...snapped, z }, { tool });
    _pendingHostId = null;
  }, { capture: true });

  // Cursor dot + rubber-band preview on every pointer move.
  vpBody.addEventListener("pointermove", (ev) => {
    const tool = readActiveTool();
    if (!tool) { hideCursorDot(); _snapTarget = null; return; }
    const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
    if (!world) {
      // No ground-plane hit (near-horizontal camera) — show dot at raw mouse position.
      moveCursorDot(viewer, { x: 0, y: 0 }, ev.clientX, ev.clientY);
      return;
    }
    // Alt key bypasses snap (raw mouse position). Otherwise: vertex snap first,
    // fall back to grid snap.
    let snapped: { x: number; y: number };
    if (ev.altKey) {
      _snapTarget = null;
      snapped = world;
    } else {
      const vertex = nearestSnapVertex(viewer, ev.clientX, ev.clientY);
      if (vertex) {
        _snapTarget = vertex;
        snapped = vertex;
      } else {
        _snapTarget = null;
        snapped = snapPoint(world.x, world.y);
      }
    }
    // Project snapped world position back to screen so the dot visually snaps (#327).
    const screen = projectToScreen(viewer, snapped.x, snapped.y, 0);
    moveCursorDot(viewer, snapped, screen?.x ?? ev.clientX, screen?.y ?? ev.clientY, _snapTarget !== null);
    if (_pending.length === 0) return;
    const handler = TOOL_HANDLERS[tool];
    // Show rubber band for multi-click tools (clicks≥2) and unlimited tools (clicks=-1).
    if (!handler || (handler.clicks > 0 && handler.clicks < 2)) return;
    updateRubberBand(viewer, handler, snapped);
  });

  vpBody.addEventListener("pointerleave", () => {
    hideCursorDot();
  });

  // Esc cancels; Enter commits unlimited tools (curve).
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (_pending.length > 0) {
        clearTemporary(viewer);
        hideCursorDot();
        _pending = [];
        dispatchSync("setActiveTool", { toolId: "select" });
      }
      if (getActiveCommandSession()?.state === "collecting_args") {
        clearCommandSession();
        setPickerHint(null);
        setChooserHint(null);
      }
      return;
    }
    if (ev.key === "Enter") {
      commitUnlimited(viewer);
      void commitCommandSession().then((r) => {
        if (r) {
          if (r.status === "needs_choice" && r.awaiting_text_choice) {
            setChooserHint(r.awaiting_text_choice);
          } else {
            setChooserHint(null);
            setPickerHint(r.status === "needs_input" ? (r.summary ?? null) : null);
          }
        }
      });
    }
  });

  // Reset pending buffer when palette tool changes.
  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    if (t.closest(".palette-btn")) {
      resetPending();
    }
  }, { capture: true });
}

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
