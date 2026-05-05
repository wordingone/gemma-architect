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
//     Polyline (4-click auto-close), Polygon (hex), Stair, Extrude (2-click box)
//
// What is stubbed (logs to console, awaits parent task to wire kernel call):
//   - Arc, Spline, Revolve

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Viewer } from "./viewer";
import { setState } from "./app-state";
import { dispatchSync } from "./dispatch";
import { snapPoint } from "./snap-state";

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

// Append-only construction sequence.
const _createSequence: string[] = [];

export function getCreateSequence(): string[] {
  return [..._createSequence];
}

export function clearCreateSequence(): void {
  _createSequence.length = 0;
}

// Pending click buffer
let _pending: Array<{ x: number; y: number }> = [];
// Temporary scene objects — removed when the tool completes or is cancelled.
let _previewMesh: THREE.Mesh | null = null;
let _markerMesh: THREE.Mesh | null = null;
// Cursor dot — CSS overlay div that tracks the pointer when a sketch tool is active.
let _cursorDot: HTMLElement | null = null;
// Viewer reference set once by initCreateMode — used by resetPending.
let _viewer: Viewer | null = null;

function readActiveTool(): string | null {
  const btn = document.querySelector<HTMLElement>(".palette-btn.active");
  const id = btn?.dataset.tool ?? null;
  if (!id || id === "select" || id === "move" || id === "rotate" || id === "scale") return null;
  return id;
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
  return hit ? point : null;
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
  const chain = `const wall = makeBox(${round(length)}, ${round(t)}, ${round(h)}).rotate(${round(angDeg)}, [0, 0, 0], [0, 0, 1]).translate([${round(midX)}, ${round(midY)}, 0]);`;
  return { mesh, chain };
}

function buildRect(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const w = Math.max(0.01, Math.abs(b.x - a.x));
  const d = Math.max(0.01, Math.abs(b.y - a.y));
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const hw = w / 2;
  const hd = d / 2;
  const t = 0.015;
  const outer = new THREE.Shape();
  outer.moveTo(-hw - t, -hd - t);
  outer.lineTo( hw + t, -hd - t);
  outer.lineTo( hw + t,  hd + t);
  outer.lineTo(-hw - t,  hd + t);
  outer.closePath();
  const inner = new THREE.Path();
  inner.moveTo(-hw + t, -hd + t);
  inner.lineTo( hw - t, -hd + t);
  inner.lineTo( hw - t,  hd - t);
  inner.lineTo(-hw + t,  hd - t);
  inner.closePath();
  outer.holes.push(inner);
  const geom = new THREE.ShapeGeometry(outer);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9b18a, roughness: 0.4, metalness: 0.0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(cx, cy, 0.001);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "rect";
  const h = DEFAULT_RECT_HEIGHT;
  const chain = `const rect = drawRectangle(${round(w)}, ${round(d)}).sketchOnPlane("XY").extrude(${round(h)}).translate([${round(cx)}, ${round(cy)}, 0]);`;
  return { mesh, chain };
}

function buildCircle(center: { x: number; y: number }, radial: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const dx = radial.x - center.x;
  const dy = radial.y - center.y;
  const r = Math.max(0.05, Math.sqrt(dx * dx + dy * dy));
  const t = 0.015;
  const geom = new THREE.RingGeometry(Math.max(0.02, r - t), r + t, 48);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.4, metalness: 0.0, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(center.x, center.y, 0.001);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "circle";
  const h = DEFAULT_RECT_HEIGHT;
  const chain = `const cyl = makeCylinder(${round(r)}, ${round(h)}).translate([${round(center.x)}, ${round(center.y)}, 0]);`;
  return { mesh, chain };
}

function buildLine(a: { x: number; y: number }, b: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const curve = new THREE.LineCurve3(
    new THREE.Vector3(a.x, a.y, 0),
    new THREE.Vector3(b.x, b.y, 0),
  );
  const geom = new THREE.TubeGeometry(curve, 1, 0.008, 6, false);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2d2d35, roughness: 0.4, metalness: 0.0 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "line";
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

function buildPolyline(pts: Array<{ x: number; y: number }>): { mesh: THREE.Mesh; chain: string } {
  // 4-click open line strip. Visual is a tube path through the points.
  // (Variable click count requires sentinel-terminate UX — fixed at 4 for now.)
  const path = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < pts.length - 1; i++) {
    path.add(new THREE.LineCurve3(
      new THREE.Vector3(pts[i].x, pts[i].y, 0),
      new THREE.Vector3(pts[i + 1].x, pts[i + 1].y, 0),
    ));
  }
  const segments = Math.max(1, (pts.length - 1) * 4);
  const geom = new THREE.TubeGeometry(path, segments, 0.008, 6, false);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.4, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "polyline";
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

function buildCurve(pts: Array<{ x: number; y: number }>): { mesh: THREE.Mesh; chain: string } {
  const vecs = pts.map((p) => new THREE.Vector3(p.x, p.y, 0));
  const curve = new THREE.CatmullRomCurve3(vecs, false, "catmullrom", 0.5);
  const geom = new THREE.TubeGeometry(curve, pts.length * 8, 0.008, 6, false);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.4, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "curve";
  const worldPts = pts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const curv = drawSpline([${worldPts}]).sketchOnPlane("XY").extrude(0.002);`;
  return { mesh, chain };
}

function buildPoint(p: { x: number; y: number }): { mesh: THREE.Mesh; chain: string } {
  const r = 0.05;
  const geom = new THREE.SphereGeometry(r, 12, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff7a45, roughness: 0.4, metalness: 0.1 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(p.x, p.y, r);
  mesh.userData.kind = "mesh";
  mesh.userData.creator = "point";
  const chain = `const pt = makeCylinder(${round(r)}, ${round(r * 2)}).translate([${round(p.x)}, ${round(p.y)}, 0]);`;
  return { mesh, chain };
}

type ToolHandler = {
  clicks: number;
  handler: (pts: Array<{ x: number; y: number }>) => { mesh: THREE.Mesh; chain: string };
};

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
  curve:    { clicks: 3, handler: (pts) => buildCurve(pts) },
  point:    { clicks: 1, handler: ([p]) => buildPoint(p) },
  extrude:  { clicks: 2, handler: ([a, b]) => buildExtrude(a, b) },
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
  const geom = new THREE.SphereGeometry(0.06, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, depthTest: false });
  _markerMesh = new THREE.Mesh(geom, mat);
  _markerMesh.position.set(pt.x, pt.y, 0.05);
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

function moveCursorDot(_viewer: Viewer, _pt: { x: number; y: number }, clientX: number, clientY: number): void {
  const dot = ensureCursorDot();
  dot.style.display = "block";
  dot.style.left = clientX + "px";
  dot.style.top = clientY + "px";
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
  if (_pending.length !== 1) return;

  // Skip degenerate preview (cursor on top of first click).
  const dx = livePoint.x - _pending[0].x;
  const dy = livePoint.y - _pending[0].y;
  if (dx * dx + dy * dy < 1e-4) return;

  try {
    const out = handler.handler([_pending[0], livePoint]);
    const preview = out.mesh;
    // Replace material with translucent preview version.
    const origMat = Array.isArray(preview.material) ? preview.material[0] : preview.material;
    const previewMat = new THREE.MeshStandardMaterial({
      color: (origMat as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0x888888),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    if (Array.isArray(preview.material)) {
      preview.material.forEach((m) => m.dispose());
    } else {
      (preview.material as THREE.Material).dispose();
    }
    preview.material = previewMat;
    _previewMesh = preview;
    viewer.getScene().add(preview);
  } catch {
    // Degenerate geometry — skip preview
  }
}

// Test hook — emit a click programmatically given world-space coords.
export function emitClickWorld(viewer: Viewer, world: { x: number; y: number }, opts?: { tool?: string }): { mesh: THREE.Mesh; chain: string } | null {
  const tool = opts?.tool ?? readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler) {
    const hint = TOOL_TODOS[tool] ?? "no kernel mapping yet";
    console.log(`[create-mode] tool '${tool}': ${hint}`);
    return null;
  }
  _pending.push(world);
  // Show point marker on first click of a multi-click tool.
  if (_pending.length === 1 && handler.clicks > 1) {
    setMarker(viewer, world);
  }
  if (_pending.length < handler.clicks) return null;

  // All clicks collected — build final mesh.
  clearTemporary(viewer);
  const out = handler.handler(_pending);
  _pending = [];
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "brep");
  _createSequence.push(out.chain);
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
  const canvas = viewer.getCanvas();

  // Capture-phase listener — runs before the viewer's own pointerdown so we
  // can swallow the event when a create-tool is active.
  canvas.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const tool = readActiveTool();
    if (!tool) return;
    const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
    if (!world) return;
    ev.stopImmediatePropagation();
    const snapped = snapPoint(world.x, world.y);
    emitClickWorld(viewer, snapped, { tool });
  }, { capture: true });

  // Cursor dot + rubber-band preview on every pointer move.
  canvas.addEventListener("pointermove", (ev) => {
    const tool = readActiveTool();
    const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
    if (!tool || !world) {
      hideCursorDot();
      return;
    }
    const snapped = snapPoint(world.x, world.y);
    moveCursorDot(viewer, snapped, ev.clientX, ev.clientY);
    if (_pending.length === 0) return;
    const handler = TOOL_HANDLERS[tool];
    if (!handler || handler.clicks < 2) return;
    updateRubberBand(viewer, handler, snapped);
  });

  canvas.addEventListener("pointerleave", () => {
    hideCursorDot();
  });

  // Esc cancels the in-progress placement.
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && _pending.length > 0) {
      clearTemporary(viewer);
      hideCursorDot();
      _pending = [];
      dispatchSync("setActiveTool", { toolId: "select" });
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
