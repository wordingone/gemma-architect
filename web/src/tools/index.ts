// tools/index.ts — Create-mode coordinator extracted from create-mode.ts (#723).
// Owns: _createSequence, TOOL_HANDLERS, sketch-pipeline state, smart-track, emitClickWorld,
// initCreateMode event wiring.

import * as THREE from "three";
import type { Viewer } from "../viewer/viewer";
import { getState, setState, subscribe } from "../app-state";
import { dispatchSync } from "../commands/dispatch";
import { getSnap, snapPoint } from "../viewer/snap-state";
import { getSnapTarget, setSnapTarget, getLastSnapEdgeDir, getLastSurfaceHit, HOST_TOOL_CREATORS, getPendingHostId, setPendingHostId, findHostMesh, nearestSnapVertex } from "../viewer/snap-state";
import { pushAction, pushReplaceAction, beginTransaction, endTransaction, pushCustomAction, setOnActionPushed } from "../history";
import { getActiveCommandSession, provideSessionPick, provideSessionChoice, clearCommandSession, commitCommandSession } from "../commands/command-session";
import type { ChoiceOption } from "../commands/dictionary";
import { levelStore, getActiveLevelId } from "../geometry/levels";
import { getSelected, setSelected, addToMultiSelected, clearMultiSelected, getMultiSelected } from "../viewer/selection-state";
import { projectToScreen, unprojectToXY, unprojectForClipTool, snapWorldForView, getGeometryZ, showLevelChip } from "../viewer/projection";
import { initPickerHint, setPickerHint, setChooserHint, getChooserEl, readActiveTool, setSubToolOverride, opSetHover, OP_TOOL_IDS } from "../viewer/picker-hint";
import { initPtOverlay, registerHideCursorDot, ptGetTarget, ptPrompt, ptClearPrompt, ptShowCoordInput, ptHideCoordInput, ptStartTool, ptHandlePoint, ptHandleCoordSubmit as _ptHandleCoordSubmit, ptHandleEnter as _ptHandleEnter, ptCancel, ptFinish, ptPhaseIsObjectSelect, _ptPhase, _ptAxisLock, _ptCoordInputEl, ptGetAxisBase, ptEffectiveAxisDir, ptSetAxisLockLine, ptClearAxisLockLine, _ptViewer, _lastPtTool, unprojectToAxisLine, ptUpdateAnglePreview } from "../viewer/transforms";
import { registerOpToolHooks, opStartTool, opHandleClick, opHandleEnter as _opHandleEnter, opHandleCoordSubmit as _opHandleCoordSubmit, opCancel, opFinish, opPhaseIsObjectSelect, opPhaseSupressesSnap, opRaycastObject, opUpdateExtrudePreview, opUpdateSelectHoverPreview, opUpdateDimPreview, opUpdateCopyPreview, opUpdateFilletEdge, getOpPhase, setSelDragging, _selDragging, opGetScreenYtoDz } from "../viewer/op-tool";
import { registerSelectionOpsMarkers, getSelOverlay, clearSelOverlay, removeSelOverlay, clearMultiSelHighlights, applyMultiSelHL, runRectSel, runPolySel, isSelHLOwned } from "../viewer/selection-ops";
import { setStructuralViewer, buildWall, rebuildWallInPlace, attemptWallJoins, buildSlab, buildColumn, buildStair, buildStairOnPolyline, buildStairOnCurve, buildBeam, buildRoof, buildSpace, buildFoundation, buildCeiling, buildCurtainWall, buildSkylight, buildGridLine, buildLevel, buildReferenceLine, buildSectionBox, buildClipPlane, buildClipPlanePlan, buildClipPlaneSection, buildBox, buildExtrude } from "./structural";
import { onElementCommitted, addVoidToWallObject } from "./join-groups";
import { attemptWallCornerJoins } from "./wall-corners";
import { buildRect, buildCircle, buildArc, buildLine, buildPolygon, buildPolyline, buildCurve, buildRamp, buildRailing, buildPoint } from "./sketch";
import { buildDoor, buildWindow, buildOpening, FZK_DOOR_W, FZK_DOOR_H, FZK_WINDOW_W, FZK_WINDOW_H, FZK_WINDOW_SILL } from "./openings";
import { STAIR_STEP_RISE, STAIR_STEP_DEPTH, STAIR_WIDTH } from "./dimensions";
import { drawingLayerStore, SKETCH_KINDS } from "../geometry/drawing-layers";

// ── Drawing layer assignment ──────────────────────────────────────────────────

function applyDrawingLayer(obj: THREE.Object3D): void {
  const kind = obj.userData.kind as string | undefined;
  if (!kind || !SKETCH_KINDS.has(kind)) return;
  const layer = drawingLayerStore.getActive();
  obj.userData.drawingLayerId = layer.id;
  obj.traverse((child) => {
    const mat = (child as THREE.Mesh).material as THREE.LineBasicMaterial | THREE.MeshStandardMaterial | undefined;
    if (mat && "color" in mat) mat.color.set(layer.color);
  });
}

// ── Append-only construction sequence ────────────────────────────────────────

const _createSequence: string[] = [];

export function getCreateSequence(): string[] {
  return [..._createSequence];
}

export function clearCreateSequence(): void {
  _createSequence.length = 0;
}

// ── Pending click buffer ──────────────────────────────────────────────────────
// z is only set for the "level" tool (geometry raycast elevation).

let _pending: Array<{ x: number; y: number; z?: number }> = [];
// #943: section-box single-drag mode — mousedown sets A, mouseup sets B.
// #951: last non-select tool activated — spacebar re-activates it.
let _lastActivatedTool: string | null = null;
// #951: last tool that COMPLETED (pushed an action) — used by spacebar repeat.
// Cancel paths do NOT update this; only successful pushAction/endTransaction do.
let _lastCompletedTool: string | null = null;
setOnActionPushed(() => {
  const tool = getState("activeTool");
  if (tool && tool !== "select") _lastCompletedTool = tool;
});

// Shift-axis constraint: when Shift is held and ≥1 pending point exists, lock to the
// dominant world axis (X or Y) from the last pending point and grid-snap along it.
function shiftAxisSnap(
  base: { x: number; y: number },
  cur: { x: number; y: number },
  step: number,
): { x: number; y: number } {
  const dx = cur.x - base.x;
  const dy = cur.y - base.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: base.x + Math.round(dx / step) * step, y: base.y };
  } else {
    return { x: base.x, y: base.y + Math.round(dy / step) * step };
  }
}

// Last pointer screen position — used by inline chip after level/datum placement.
let _lastPointerClient: { x: number; y: number } = { x: 0, y: 0 };
let _lastCreateClickTs = 0;
let _lastCreateClickX = 0;
let _lastCreateClickY = 0;

// Temporary scene objects — removed when the tool completes or is cancelled.
let _previewMesh: THREE.Mesh | null = null;
let _markerMesh: THREE.Points | null = null;
let _roofFootprintLine: THREE.Line | null = null;
// Ghost preview mesh for door/window before first click (#845/#846 AC3).
let _openingPreviewMesh: THREE.Mesh | null = null;
// Axis-constraint indicator line shown when Shift is held during sketch drawing.
let _sketchShiftAxisLine: THREE.Line | null = null;
// Cursor dot — CSS overlay div that tracks the pointer when a sketch tool is active.
let _cursorDot: HTMLElement | null = null;

// Smart-track: hovering a snap vertex for SMART_TRACK_MS promotes it to a temporary
// reference point used as the Shift-constraint base even before the first pending click.
const SMART_TRACK_MS = 750;
let _smartTrackPt: { x: number; y: number } | null = null;
let _smartTrackTimer: ReturnType<typeof setTimeout> | null = null;
let _smartTrackCandidate: { x: number; y: number; id: string } | null = null;
let _smartTrackMarker: THREE.Mesh | null = null;
// Sketch shift axis lock — latched on first dominant move, cleared on Shift release or tool change.
let _shiftAxisChoice: "x" | "y" | "z" | null = null;
// Viewer reference set once by initCreateMode.
let _viewer: Viewer | null = null;

// ── Temporary scene object management ────────────────────────────────────────

export function setMarker(viewer: Viewer, pt: { x: number; y: number; z?: number }): void {
  clearMarker(viewer);
  const z = pt.z ?? 0;
  const c = document.createElement("canvas"); c.width = 32; c.height = 32;
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, 32, 32);
  ctx.beginPath(); ctx.arc(16, 16, 10, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.strokeStyle = "#000000"; ctx.lineWidth = 2.5; ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([pt.x, pt.y, z + 0.05], 3));
  const mat = new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, map: tex, transparent: true, alphaTest: 0.01, depthTest: false, depthWrite: false });
  const pts = new THREE.Points(geom, mat);
  pts.renderOrder = 999;
  _markerMesh = pts;
  viewer.getScene().add(pts);
}

export function clearMarker(viewer: Viewer): void {
  if (!_markerMesh) return;
  viewer.getScene().remove(_markerMesh);
  _markerMesh.geometry.dispose();
  const mat = _markerMesh.material as THREE.PointsMaterial;
  mat.map?.dispose();
  mat.dispose();
  _markerMesh = null;
}

export function clearPreview(viewer: Viewer): void {
  if (!_previewMesh) return;
  viewer.getScene().remove(_previewMesh);
  // Traverse handles both THREE.Mesh (2D tools) and THREE.Group (roof, curtain wall)
  // so this never throws on missing .geometry.
  (_previewMesh as THREE.Object3D).traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
    else (child.material as THREE.Material).dispose();
  });
  _previewMesh = null;
}

function clearRoofFootprint(viewer: Viewer): void {
  if (!_roofFootprintLine) return;
  viewer.getScene().remove(_roofFootprintLine);
  _roofFootprintLine.geometry.dispose();
  (_roofFootprintLine.material as THREE.Material).dispose();
  _roofFootprintLine = null;
}

function clearOpeningPreview(viewer: Viewer): void {
  if (!_openingPreviewMesh) return;
  viewer.getScene().remove(_openingPreviewMesh);
  (_openingPreviewMesh.geometry as THREE.BufferGeometry).dispose();
  (_openingPreviewMesh.material as THREE.MeshBasicMaterial).dispose();
  _openingPreviewMesh = null;
}

function updateOpeningPreview(
  viewer: Viewer,
  tool: "door" | "window",
  snapped: { x: number; y: number; z?: number },
  clientX: number,
  clientY: number,
): void {
  const elev = levelStore.getActive().elevation;
  const w = tool === "door" ? FZK_DOOR_W : FZK_WINDOW_W;
  const h = tool === "door" ? FZK_DOOR_H : FZK_WINDOW_H;
  const zOff = tool === "door" ? 0 : FZK_WINDOW_SILL;
  const color = tool === "door" ? 0xaa6633 : 0x88c4e8;

  clearOpeningPreview(viewer);

  const geom = new THREE.BoxGeometry(w, 0.2, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35 });
  _openingPreviewMesh = new THREE.Mesh(geom, mat);
  _openingPreviewMesh.position.set(snapped.x, snapped.y, elev + zOff);
  _openingPreviewMesh.userData.noSnap = true;
  _openingPreviewMesh.userData.isPreview = true;

  const host = findHostMesh(viewer, clientX, clientY, ["wall"]);
  if (host) {
    _openingPreviewMesh.rotation.copy(host.rotation);
    host.updateMatrixWorld(true);
    const local = host.worldToLocal(_openingPreviewMesh.position.clone());
    local.y = 0;
    _openingPreviewMesh.position.copy(host.localToWorld(local));
  }

  viewer.getScene().add(_openingPreviewMesh);
}

export function clearSketchShiftLine(viewer: Viewer): void {
  if (!_sketchShiftAxisLine) return;
  viewer.getScene().remove(_sketchShiftAxisLine);
  _sketchShiftAxisLine.geometry.dispose();
  (_sketchShiftAxisLine.material as THREE.Material).dispose();
  _sketchShiftAxisLine = null;
}

export function updateSketchShiftLine(viewer: Viewer, base: THREE.Vector3, axis: "x" | "y" | "z"): void {
  clearSketchShiftLine(viewer);
  const dir = axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const color = axis === "x" ? 0xff4444 : axis === "y" ? 0x44cc44 : 0x4488ff;
  const geo = new THREE.BufferGeometry().setFromPoints([
    base.clone().addScaledVector(dir, -1000),
    base.clone().addScaledVector(dir, 1000),
  ]);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, opacity: 0.5, transparent: true });
  _sketchShiftAxisLine = new THREE.Line(geo, mat);
  _sketchShiftAxisLine.renderOrder = 98;
  _sketchShiftAxisLine.userData.noSnap = true;
  viewer.getScene().add(_sketchShiftAxisLine);
}

export function setSmartTrackPt(viewer: Viewer, pt: { x: number; y: number } | null): void {
  if (_smartTrackMarker) {
    viewer.getScene().remove(_smartTrackMarker);
    (_smartTrackMarker.geometry as THREE.BufferGeometry).dispose();
    (_smartTrackMarker.material as THREE.Material).dispose();
    _smartTrackMarker = null;
  }
  _smartTrackPt = pt;
  if (pt) {
    const geo = new THREE.SphereGeometry(0.05, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ccff, depthTest: false, transparent: true, opacity: 0.85 });
    _smartTrackMarker = new THREE.Mesh(geo, mat);
    _smartTrackMarker.position.set(pt.x, pt.y, 0.01);
    _smartTrackMarker.renderOrder = 99;
    _smartTrackMarker.userData.noSnap = true;
    viewer.getScene().add(_smartTrackMarker);
  }
}

export function clearSmartTrack(viewer: Viewer): void {
  if (_smartTrackTimer) { clearTimeout(_smartTrackTimer); _smartTrackTimer = null; }
  _smartTrackCandidate = null;
  setSmartTrackPt(viewer, null);
}

export function clearTemporary(viewer: Viewer): void {
  clearPreview(viewer);
  clearMarker(viewer);
  clearSketchShiftLine(viewer);
  clearRoofFootprint(viewer);
  clearOpeningPreview(viewer);
}

// ── Cursor dot ────────────────────────────────────────────────────────────────

export function ensureCursorDot(): HTMLElement {
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

export function moveCursorDot(_v: Viewer, _pt: { x: number; y: number }, clientX: number, clientY: number, vertexSnap = false): void {
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

export function hideCursorDot(): void {
  if (_cursorDot) _cursorDot.style.display = "none";
}

export function destroyCursorDot(): void {
  if (!_cursorDot) return;
  _cursorDot.remove();
  _cursorDot = null;
}

// ── Tool handler types & atZ wrapper ─────────────────────────────────────────

type SingleResult = { mesh: THREE.Object3D; chain: string; dispatchOnCommit?: { verb: string; args: Record<string, unknown> } };
type ToolHandler = {
  clicks: number;
  handler: (pts: Array<{ x: number; y: number; z?: number }>) => SingleResult;
  chain?: boolean;
  commitMulti?: (pts: Array<{ x: number; y: number; z?: number }>) => SingleResult[];
};

// 9 ft above the active level — canonical offset for ceiling and roof placement.
export const DEFAULT_CEILING_OFFSET = 2.7432;

// Inject the clicked Z into the mesh after the builder returns.
// All XY-plane builders hardcode position.z=0; this wrapper lifts them to the
// active level elevation using the first clicked point's z.
function atZ<T extends { mesh: THREE.Object3D; chain: string }>(
  fn: (pts: Array<{ x: number; y: number; z?: number }>) => T,
): (pts: Array<{ x: number; y: number; z?: number }>) => T {
  return (pts) => {
    const r = fn(pts);
    r.mesh.position.z = pts[0]?.z ?? 0;
    return r;
  };
}

// Position mesh at the top of the active level (elevation + offset) regardless
// of click-point Z. Used for ceiling and roof — elements that float above the
// floor, not on it.
function atTopOfLevel<T extends { mesh: THREE.Object3D; chain: string }>(
  fn: (pts: Array<{ x: number; y: number; z?: number }>) => T,
  offset: number,
): (pts: Array<{ x: number; y: number; z?: number }>) => T {
  return (pts) => {
    const r = fn(pts);
    const elev = levelStore.get(getActiveLevelId())?.elevation ?? 0;
    r.mesh.position.z = elev + offset;
    return r;
  };
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  wall:          { clicks: 2, handler: atZ(([a, b]) => buildWall(a, b)) },
  "wall-polyline": { clicks: 2, chain: true, handler: atZ(([a, b]) => buildWall(a, b)) },
  "wall-curve":    {
    clicks: -1,
    handler: atZ((pts) => pts.length >= 2 ? buildSplinePreview(pts) : buildSplinePreview([pts[0], pts[0]])),
    commitMulti: (pts) => pts.length >= 2 ? [buildCurveWall(pts)] : [],
  },
  rect:        { clicks: 2, handler: atZ(([a, b]) => buildRect(a, b)) },
  circle:      { clicks: 2, handler: atZ(([a, b]) => buildCircle(a, b)) },
  line:        { clicks: 2, handler: atZ(([a, b]) => buildLine(a, b)) },
  slab:        { clicks: 2, handler: atZ(([a, b]) => buildSlab(a, b)) },
  door:        { clicks: 1, handler: atTopOfLevel(([p]) => buildDoor(p), 0) },
  window:      { clicks: 1, handler: atTopOfLevel(([p]) => buildWindow(p), FZK_WINDOW_SILL) },
  column:      { clicks: 1, handler: atZ(([p]) => buildColumn(p)) },
  stair:           { clicks: 2,  handler: atZ(([a, b]) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const totalRun = Math.sqrt(dx * dx + dy * dy) || STAIR_STEP_DEPTH;
    // Run-derived count from fixed 11" tread — allows any count >= 1 (3-step porch stairs work).
    const count = Math.max(1, Math.round(totalRun / STAIR_STEP_DEPTH));
    const { group, chain } = buildStair(a, b, { count, riserHeight: STAIR_STEP_RISE, treadDepth: STAIR_STEP_DEPTH, width: STAIR_WIDTH });
    return { mesh: group, chain };
  }) },
  "stair-polyline": { clicks: -1, handler: atZ((pts) => { const lvl = levelStore.get(getActiveLevelId()); const rise = lvl?.height ?? 3.0; const { group, chain } = buildStairOnPolyline(pts, { rise }); return { mesh: group, chain }; }) },
  "stair-curve":    { clicks: -1, handler: atZ((pts) => { const lvl = levelStore.get(getActiveLevelId()); const rise = lvl?.height ?? 3.0; const { group, chain } = buildStairOnCurve(pts, { rise }); return { mesh: group, chain }; }) },
  polygon:     { clicks: 2, handler: atZ(([a, b]) => buildPolygon(a, b)) },
  arc:         { clicks: 3, handler: atZ(([c, s, e]) => buildArc(c, s, e)) },
  polyline:    { clicks: -1, handler: atZ((pts) => buildPolyline(pts)) },
  curve:       { clicks: -1, handler: atZ((pts) => buildCurve(pts)) },
  point:       { clicks: 1, handler: atZ(([p]) => buildPoint(p)) },
  extrude:     { clicks: 3, handler: atZ(([c1, c2, c3]) => buildBox(c1, c2, c3)) },
  beam:        { clicks: 2, handler: atZ(([a, b]) => buildBeam(a, b)) },
  roof:        { clicks: 2, handler: atTopOfLevel(([a, b]) => buildRoof(a, b), DEFAULT_CEILING_OFFSET) },
  space:       { clicks: 2, handler: atZ(([a, b]) => buildSpace(a, b)) },
  foundation:  { clicks: 2, handler: atZ(([a, b]) => buildFoundation(a, b)) },
  ceiling:     { clicks: 2, handler: atTopOfLevel(([a, b]) => buildCeiling(a, b), DEFAULT_CEILING_OFFSET) },
  curtainwall: { clicks: 2, handler: atTopOfLevel(([a, b]) => buildCurtainWall(a, b), 0) },
  skylight:    { clicks: 2, handler: atZ(([a, b]) => buildSkylight(a, b)) },
  opening:     { clicks: 1, handler: atZ(([p]) => buildOpening(p)) },
  ramp:        { clicks: 2, handler: atZ(([a, b]) => buildRamp(a, b)) },
  railing:     { clicks: 2, handler: atZ(([a, b]) => buildRailing(a, b)) },
  grid:        { clicks: 2, handler: ([a, b]) => buildGridLine(a, b) },          // grid always at Z=0
  level:       { clicks: 1, handler: ([p]) => buildLevel(p) },                   // level uses getGeometryZ
  datum:       { clicks: 2, handler: ([a, b]) => buildReferenceLine(a, b) },     // datum always at Z=0
  section:      { clicks: 2, handler: ([a, b]) => buildSectionBox(a, b, _viewer?.getSceneBounds()) },
  clip:         { clicks: 1, handler: ([p]) => buildClipPlanePlan(p) },
  "clip-section": { clicks: 2, handler: ([a, b]) => buildClipPlaneSection(a, b) },
};

const TOOL_TODOS: Record<string, string> = {
  arc:     "draw(start).arcTo(end, [via]).sketchOnPlane('XY').extrude(thickness)",
  spline:  "draw(start).bezierTo(end, [c1], [c2]).sketchOnPlane('XY').extrude(thickness)",
  revolve: "select profile then axis then angle — TODO 3-step gizmo flow",
  move:    "select then drag — already covered by transform gizmo",
  rotate:  "select then drag — already covered by transform gizmo",
  scale:   "select then drag — already covered by transform gizmo",
};

// ── Rubber-band preview ───────────────────────────────────────────────────────

function updateRubberBand(viewer: Viewer, handler: ToolHandler, livePoint: { x: number; y: number; z?: number }): void {
  clearPreview(viewer);
  const isUnlimited = handler.clicks === -1;
  if (!isUnlimited && _pending.length !== 1) return;
  if (isUnlimited && _pending.length < 1) return;

  const previewPts = isUnlimited ? [..._pending, livePoint] : [_pending[0], livePoint];

  const last = previewPts[previewPts.length - 1];
  const prev = previewPts[previewPts.length - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const dz = (last.z ?? 0) - (prev.z ?? 0);
  if (dx * dx + dy * dy + dz * dz < 1e-4) return;

  if (isUnlimited && previewPts.length < 2) return;

  try {
    const out = handler.handler(previewPts);
    const preview = out.mesh;
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
      preview.traverse((child) => { if (child instanceof THREE.Mesh) applyPreviewMat(child); });
      _previewMesh = preview as unknown as THREE.Mesh;
    }
    preview.traverse((c) => { c.userData.noSnap = true; });
    viewer.getScene().add(preview);
  } catch {
    // Degenerate geometry — skip preview
  }
}

// ── Roof footprint preview ────────────────────────────────────────────────────

function updateRoofFootprint(
  viewer: Viewer,
  anchor: { x: number; y: number },
  live: { x: number; y: number },
): void {
  clearRoofFootprint(viewer);
  const overhang = 0.5;  // FZK-derived default (#1161)
  const elev = levelStore.getActive().elevation;
  const minX = Math.min(anchor.x, live.x) - overhang;
  const maxX = Math.max(anchor.x, live.x) + overhang;
  const minY = Math.min(anchor.y, live.y) - overhang;
  const maxY = Math.max(anchor.y, live.y) + overhang;
  if (maxX - minX < 0.01 || maxY - minY < 0.01) return;
  const pts = [
    new THREE.Vector3(minX, minY, elev),
    new THREE.Vector3(maxX, minY, elev),
    new THREE.Vector3(maxX, maxY, elev),
    new THREE.Vector3(minX, maxY, elev),
    new THREE.Vector3(minX, minY, elev),
  ];
  const geom = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineDashedMaterial({ color: 0x4488ff, dashSize: 0.3, gapSize: 0.15, depthTest: false, transparent: true, opacity: 0.8 });
  _roofFootprintLine = new THREE.Line(geom, mat);
  _roofFootprintLine.computeLineDistances();
  _roofFootprintLine.renderOrder = 2;
  _roofFootprintLine.userData.noSnap = true;
  viewer.getScene().add(_roofFootprintLine);
}

// ── Wall sub-mode helpers ─────────────────────────────────────────────────────

function buildSplinePreview(pts: Array<{x: number; y: number; z?: number}>): { mesh: THREE.Object3D; chain: string } {
  const vecs = pts.map(p => new THREE.Vector3(p.x, p.y, 0));
  const curve = new THREE.CatmullRomCurve3(vecs);
  const N = Math.max((pts.length - 1) * 12, 24);
  const sampled = curve.getPoints(N);
  const cx = sampled.reduce((s, p) => s + p.x, 0) / sampled.length;
  const cy = sampled.reduce((s, p) => s + p.y, 0) / sampled.length;
  const geom = new THREE.BufferGeometry().setFromPoints(
    sampled.map(p => new THREE.Vector3(p.x - cx, p.y - cy, 0))
  );
  const mat = new THREE.LineBasicMaterial({ color: 0x9ec5d8 });
  const mesh = new THREE.Line(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.noSnap = true;
  return { mesh, chain: "" };
}

function buildCurveWall(pts: Array<{x: number; y: number; z?: number}>): SingleResult {
  const t = 0.2, h = 3.0;
  const z0 = pts[0]?.z ?? 0;
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p.x, p.y, 0)));
  const N = Math.max((pts.length - 1) * 16, 32);
  const cPts = curve.getPoints(N); // N+1 points
  const M = cPts.length;
  const hw = t / 2;

  // Per-sample tangent via central differences
  const tangs = cPts.map((_, i) => {
    const prev = cPts[Math.max(0, i - 1)];
    const next = cPts[Math.min(M - 1, i + 1)];
    const dx = next.x - prev.x, dy = next.y - prev.y;
    const l = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / l, y: dy / l };
  });

  // 4 vertices per sample: outer-bottom[4i], outer-top[4i+1], inner-bottom[4i+2], inner-top[4i+3]
  const pos: number[] = [];
  for (let i = 0; i < M; i++) {
    const p = cPts[i], tg = tangs[i];
    const nx = -tg.y, ny = tg.x; // XY normal (90° CCW from tangent)
    pos.push(p.x + hw * nx, p.y + hw * ny, z0);      // outer bottom
    pos.push(p.x + hw * nx, p.y + hw * ny, z0 + h);  // outer top
    pos.push(p.x - hw * nx, p.y - hw * ny, z0);      // inner bottom
    pos.push(p.x - hw * nx, p.y - hw * ny, z0 + h);  // inner top
  }

  const idx: number[] = [];
  for (let i = 0; i < M - 1; i++) {
    const ob0 = 4*i, ot0 = 4*i+1, ib0 = 4*i+2, it0 = 4*i+3;
    const ob1 = 4*(i+1), ot1 = 4*(i+1)+1, ib1 = 4*(i+1)+2, it1 = 4*(i+1)+3;
    idx.push(ob0, ot0, ob1,  ob1, ot0, ot1); // outer (+n normal)
    idx.push(ib0, ib1, it0,  ib1, it1, it0); // inner (-n normal)
    idx.push(ot0, it0, ot1,  ot1, it0, it1); // top (+z normal)
    idx.push(ob0, ob1, ib0,  ob1, ib1, ib0); // bottom (-z normal)
  }
  idx.push(0, 2, 1,  1, 2, 3); // start cap (-tangent normal)
  const e = M - 1;
  idx.push(4*e, 4*e+1, 4*e+2,  4*e+1, 4*e+3, 4*e+2); // end cap (+tangent normal)

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "wall";
  mesh.userData.isCurveWall = true;
  mesh.userData.wallThickness = t;
  mesh.userData.wallHeight = h;
  mesh.userData.controlPoints = pts.map(p => ({ x: p.x, y: p.y, z: p.z ?? z0 }));
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const pStr = pts.map(p => `[${r4(p.x)},${r4(p.y)}]`).join(",");
  const chain = `curveWall: spline(${pStr}) t(${t}) h(${h})`;
  return { mesh, chain };
}

function commitMultiWalls(viewer: Viewer, results: SingleResult[]): void {
  for (const r of results) {
    viewer.addMesh(r.mesh, r.mesh.userData.kind ?? "brep", { noHistory: true });
    if (r.mesh instanceof THREE.Mesh && r.mesh.userData.creator === "wall" && !r.mesh.userData.isCurveWall) {
      attemptWallCornerJoins(r.mesh, viewer.getScene());
    }
    if (r.mesh instanceof THREE.Mesh) onElementCommitted(r.mesh, viewer.getScene());
    _createSequence.push(r.chain);
    pushAction(r.mesh, r.chain);
  }
}

function commitWallPick(viewer: Viewer, obj: THREE.Object3D): void {
  const creator = obj.userData.creator as string | undefined;
  const z0 = obj instanceof THREE.Mesh ? (obj as THREE.Mesh).position.z : 0;
  const pos = obj.position;

  // Circle reference → smooth cylindrical wall ring (32-segment arc).
  if (creator === "circle") {
    const box = new THREE.Box3().setFromObject(obj);
    const r = (box.max.x - box.min.x) / 2;
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const N = 32;
    const arcPts: Array<{x: number; y: number; z?: number}> = [];
    for (let i = 0; i <= N; i++) {
      const ang = (i / N) * Math.PI * 2;
      arcPts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang), z: z0 });
    }
    const result = buildCurveWall(arcPts);
    commitMultiWalls(viewer, [result]);
    hideCursorDot();
    setPickerHint(null);
    dispatchSync("setActiveTool", { toolId: "select" });
    return;
  }

  // Curve reference → smooth spline wall; controlPoints are mesh-local, convert to world.
  if (creator === "curve") {
    const cps = obj.userData.controlPoints as Array<{x: number; y: number; z?: number}> | undefined;
    if (cps && cps.length >= 2) {
      const isClosed = obj.userData.isClosed as boolean ?? false;
      const worldPts = cps.map(p => ({ x: p.x + pos.x, y: p.y + pos.y, z: z0 }));
      if (isClosed) worldPts.push({ x: worldPts[0].x, y: worldPts[0].y, z: z0 });
      const result = buildCurveWall(worldPts);
      commitMultiWalls(viewer, [result]);
      hideCursorDot();
      setPickerHint(null);
      dispatchSync("setActiveTool", { toolId: "select" });
      return;
    }
  }

  // Polyline/line and all other types: controlPoints are local-space, convert to world;
  // straight wall segments between consecutive points.
  const cps = obj.userData.controlPoints as Array<{x: number; y: number; z?: number}> | undefined;
  let pts: Array<{x: number; y: number; z?: number}>;
  if (cps && cps.length >= 2) {
    pts = cps.map(p => ({ x: p.x + pos.x, y: p.y + pos.y, z: z0 }));
  } else {
    const box = new THREE.Box3().setFromObject(obj);
    const mn = box.min, mx = box.max;
    pts = [
      { x: mn.x, y: mn.y, z: z0 }, { x: mx.x, y: mn.y, z: z0 },
      { x: mx.x, y: mx.y, z: z0 }, { x: mn.x, y: mx.y, z: z0 },
    ];
  }
  if (pts.length < 2) {
    setPickerHint("wall-pick — no usable geometry on that object");
    return;
  }
  const closedKinds = new Set(["rectangle", "polygon", "circle", "slab"]);
  const closed = closedKinds.has(obj.userData.kind as string ?? "");
  const n = pts.length;
  const results: SingleResult[] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const r = buildWall(pts[i], pts[(i + 1) % n]);
    r.mesh.position.z = z0;
    results.push(r);
  }
  commitMultiWalls(viewer, results);
  hideCursorDot();
  setPickerHint(null);
  dispatchSync("setActiveTool", { toolId: "select" });
}

// ── commitUnlimited & emitClickWorld ─────────────────────────────────────────

function commitUnlimited(viewer: Viewer): { mesh: THREE.Object3D; chain: string } | null {
  const tool = readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler || handler.clicks !== -1 || _pending.length < 2) return null;
  clearTemporary(viewer);
  clearSmartTrack(viewer);
  const pts = [..._pending];
  _pending = [];
  hideCursorDot();
  setPickerHint(null);

  if (handler.commitMulti) {
    const results = handler.commitMulti(pts);
    commitMultiWalls(viewer, results);
    dispatchSync("setActiveTool", { toolId: "select" });
    return results[0] ?? null;
  }

  const out = handler.handler(pts);
  if (!out.mesh.userData.levelId) out.mesh.userData.levelId = getActiveLevelId();
  applyDrawingLayer(out.mesh);
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "mesh", { noHistory: true });
  if (out.mesh instanceof THREE.Mesh) onElementCommitted(out.mesh, viewer.getScene());
  _createSequence.push(out.chain);
  pushAction(out.mesh, out.chain);
  dispatchSync("setActiveTool", { toolId: "select" });
  return out;
}

// Test hook — emit a click programmatically given world-space coords.
export function emitClickWorld(viewer: Viewer, world: { x: number; y: number; z?: number }, opts?: { tool?: string; commit?: boolean }): { mesh: THREE.Object3D; chain: string } | null {
  const tool = opts?.tool ?? readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler) {
    const hint = TOOL_TODOS[tool] ?? "no kernel mapping yet";
    console.log(`[create-mode] tool '${tool}': ${hint}`);
    return null;
  }
  _pending.push(world);
  if (_pending.length === 1 && handler.clicks !== 1) {
    setMarker(viewer, world);
  }
  if (handler.clicks === -1) {
    setPickerHint(`${tool} — ${_pending.length} point${_pending.length > 1 ? "s" : ""}  [double-click, Enter, or Space] commit  [Esc] cancel`);
    if (opts?.commit && _pending.length >= 2) {
      clearTemporary(viewer);
      clearSmartTrack(viewer);
      const pts = [..._pending];
      _pending = [];
      hideCursorDot();
      setPickerHint(null);
      if (handler.commitMulti) {
        const results = handler.commitMulti(pts);
        commitMultiWalls(viewer, results);
        dispatchSync("setActiveTool", { toolId: "select" });
        return results[0] ?? null;
      }
      const out = handler.handler(pts);
      if (!out.mesh.userData.levelId) out.mesh.userData.levelId = getActiveLevelId();
      applyDrawingLayer(out.mesh);
      viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "mesh", { noHistory: true });
      if (out.mesh instanceof THREE.Mesh) onElementCommitted(out.mesh, viewer.getScene());
      _createSequence.push(out.chain);
      pushAction(out.mesh, out.chain);
      dispatchSync("setActiveTool", { toolId: "select" });
      return out;
    }
    return null;
  }
  if (_pending.length < handler.clicks) return null;

  clearTemporary(viewer);
  clearSmartTrack(viewer);
  const out = handler.handler(_pending);
  if (!out.mesh.userData.levelId) out.mesh.userData.levelId = getActiveLevelId();
  if (handler.chain) {
    const newStart = { ..._pending[_pending.length - 1] };
    _pending = [newStart];
    setMarker(viewer, newStart);
  } else {
    _pending = [];
  }
  // noHistory: true — undo managed via explicit push / transaction below.
  applyDrawingLayer(out.mesh);
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "brep", { noHistory: true });
  if (out.mesh instanceof THREE.Mesh && out.mesh.userData.creator === "wall") {
    attemptWallCornerJoins(out.mesh, viewer.getScene());
  }
  if (out.mesh instanceof THREE.Mesh) onElementCommitted(out.mesh, viewer.getScene());
  // Curtain wall join shell: commit the invisible proxy brush so join-groups CSG pipeline
  // can union it with adjacent structural elements (#841).
  const _cwJoinShell = out.mesh.userData.joinableShell as THREE.Mesh | undefined;
  if (_cwJoinShell instanceof THREE.Mesh) {
    _cwJoinShell.position.z = out.mesh.position.z;
    viewer.addMesh(_cwJoinShell, "brep", { noHistory: true });
    onElementCommitted(_cwJoinShell, viewer.getScene());
  }

  // Void cut for door/window placed interactively (#754).
  // Group door-add + wall-void-cut into one undo transaction (#850).
  let _voidCutGroup: THREE.Object3D | null = null;
  let _voidCutHost: THREE.Mesh | null = null;
  if (out.mesh instanceof THREE.Object3D) {
    const _creator = out.mesh.userData.creator as string | undefined;
    if (_creator === "door" || _creator === "window") {
      const _hostId = out.mesh.userData.hostExpressID as string | undefined;
      if (_hostId) {
        let _host: THREE.Object3D | undefined;
        viewer.getScene().traverse((obj) => {
          if (_host || obj === out.mesh) return;
          if (obj.uuid === _hostId || (obj.userData as Record<string, unknown>).expressID === _hostId) _host = obj;
        });
        if (_host) {
          // Snap to host wall centerline (local Y=0) — embeds opening in wall, not floating on surface.
          _host.updateMatrixWorld(true);
          const _snapPt = _host.worldToLocal(out.mesh.position.clone());
          _snapPt.y = 0;
          out.mesh.position.copy(_host.localToWorld(_snapPt));
          // Match wall orientation so door/window plane is parallel to wall face (#845 AC1).
          out.mesh.rotation.copy(_host.rotation);

          const _isWin = _creator === "window";
          // Read actual dims from the builder (set in openings.ts); fall back to FZK
          // constants only if missing so void size/position matches the visual mesh.
          const _vW = (out.mesh.userData.voidW as number | undefined) ?? (_isWin ? FZK_WINDOW_W : FZK_DOOR_W);
          const _vH = (out.mesh.userData.voidH as number | undefined) ?? (_isWin ? FZK_WINDOW_H : FZK_DOOR_H);
          const _vc = out.mesh.position.clone();
          _vc.z += _vH / 2;
          // addVoidToWallObject handles Mesh + Group; preserves all prior voids (#1520).
          if (_host instanceof THREE.Mesh || _host instanceof THREE.Group) {
            _voidCutHost  = _host as THREE.Mesh;
            _voidCutGroup = addVoidToWallObject(_host, _vc, _vW, _vH);
          }
        }
      }
    }
  }

  _createSequence.push(out.chain);
  beginTransaction(out.mesh.userData.creator as string ?? "place");
  if (_voidCutHost && _voidCutGroup) {
    // Wall mesh was replaced by void-cut Group — record the swap.
    pushReplaceAction(_voidCutGroup, [_voidCutHost], "wall-void-cut");
  }
  pushAction(out.mesh, out.chain);
  if (out.dispatchOnCommit?.verb === "SdSectionBox") {
    // Clip-plane state lives outside the scene graph — capture it in the transaction
    // so Ctrl+Z reverses both the outline mesh and the active clipping planes.
    const { min, max } = out.dispatchOnCommit.args as { min: [number,number,number]; max: [number,number,number] };
    pushCustomAction(
      () => { _viewer?.clearSectionBox(); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
      () => { _viewer?.setSectionBox(min, max); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
    );
  }
  endTransaction();
  if (out.dispatchOnCommit) {
    dispatchSync(out.dispatchOnCommit.verb, out.dispatchOnCommit.args);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  }
  if (handler.chain) {
    setPickerHint(`wall-polyline — click next wall endpoint  [Enter] finish  [Esc] cancel`);
  } else {
    dispatchSync("setActiveTool", { toolId: "select" });
  }

  if (tool === "level") {
    const levelId = (out as { levelId?: string }).levelId;
    if (levelId) showLevelChip(viewer, levelId, _lastPointerClient.x, _lastPointerClient.y);
  }

  return out;
}

// Reset pending click buffer — used when switching tools.
export function resetPending(): void {
  if (_viewer) { clearTemporary(_viewer); clearSmartTrack(_viewer); }
  hideCursorDot();
  setPickerHint(null);
  _pending = [];
  _shiftAxisChoice = null;
}

// ── screenYtoDz (local, needed by pointer handlers) ──────────────────────────

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

// ── initCreateMode ────────────────────────────────────────────────────────────

export function initCreateMode(viewer: Viewer): void {
  _viewer = viewer;

  // Register viewer in structural module (needs it for buildGridLine etc.).
  setStructuralViewer(viewer);

  const vpBody =
    document.getElementById("viewport-area-host") ??
    document.querySelector<HTMLElement>("#viewport-2 .vp-body") ??
    viewer.getCanvas();

  // Initialize picker-hint module (creates DOM elements).
  initPickerHint(vpBody);

  // Precision transform coord input overlay.
  const ptWrap = document.createElement("div");
  ptWrap.className = "pt-coord-wrap";
  const ptInput = document.createElement("input");
  ptInput.type = "text";
  ptInput.className = "pt-coord-input";
  ptInput.setAttribute("autocomplete", "off");
  ptInput.setAttribute("spellcheck", "false");
  ptWrap.appendChild(ptInput);
  vpBody.appendChild(ptWrap);
  initPtOverlay(ptWrap, ptInput);

  // Wire late-binding hooks to avoid circular imports.
  registerHideCursorDot(hideCursorDot);

  registerOpToolHooks({
    clearSketchShiftLine,
    updateSketchShiftLine,
    appendToCreateSequence: (chain) => _createSequence.push(chain),
    hideCursorDot,
    runPolySel,
    getSelOverlay,
    clearSelOverlay,
    removeSelOverlay,
  });

  registerSelectionOpsMarkers({
    getMarkerMesh: () => _markerMesh,
    getSketchShiftAxisLine: () => _sketchShiftAxisLine,
  });

  // ── Coord input keydown ──────────────────────────────────────────────────────
  ptInput.addEventListener("keydown", (ev) => {
    // Axis lock: Shift+X/Y/Z must work even when the coord input has focus.
    if (_ptPhase && _ptPhase.kind !== "start" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === "x" || k === "y" || k === "z") {
        ev.preventDefault();
        (_ptAxisLock as unknown as { value: string }).value = k; // module-level var
        const basePt = ptGetAxisBase();
        if (basePt) ptSetAxisLockLine(viewer, basePt);
      }
    }
    ev.stopPropagation();
    if (ev.key === "Enter" || ev.key === " ") {
      const raw = ptInput.value.trim();
      if (raw) {
        const opPhase = getOpPhase();
        if (opPhase) _opHandleCoordSubmit(viewer, raw);
        else _ptHandleCoordSubmit(viewer, raw);
      } else {
        const opPhase = getOpPhase();
        if (opPhase) _opHandleEnter(viewer);
        else _ptHandleEnter(viewer);
      }
      ptInput.value = "";
      if (ev.key === " ") ev.preventDefault();
    } else if (ev.key === "Escape") {
      if (_ptPhase) ptCancel(viewer);
    }
  });

  const OP_TOOLS = new Set(["extrude", "boolean", "fillet", "aligned-dim", "angular-dim", "area-dim", "volume-dim", "label", "transient-measure", "sel-window", "sel-lasso", "sel-boundary", "copy", "array"]);

  // Clear multi-select highlights when the viewer performs a normal single-object selection.
  window.addEventListener("viewer:select", () => {
    if (!isSelHLOwned()) { clearMultiSelHighlights(); clearMultiSelected(); }
  });

  const WALL_SUB_TOOLS = new Set(["wall-polyline", "wall-curve", "wall-pick", "stair-polyline", "stair-curve", "clip-section"]);

  // When activeTool changes to a PT or op tool, start the state machine.
  subscribe("activeTool", (tool) => {
    // #951: record last non-select tool for spacebar repeat.
    if (tool && tool !== "select") _lastActivatedTool = tool;
    // Sub-tools with no palette button; override readActiveTool() so the
    // pointer-event pipeline sees the correct tool ID instead of null.
    setSubToolOverride(WALL_SUB_TOOLS.has(tool) ? tool : null);

    if (tool === "move" || tool === "rotate" || tool === "scale" || tool === "scale-1d" || tool === "scale-2d") {
      if (_ptPhase) ptCancel(viewer, false);
      if (getOpPhase()) opCancel(viewer, false);
      viewer.setGumballEnabled(false);
      ptStartTool(tool as "move" | "rotate" | "scale" | "scale-1d" | "scale-2d");
    } else if (OP_TOOLS.has(tool)) {
      if (_ptPhase) ptCancel(viewer, false);
      if (getOpPhase()) opCancel(viewer, false);
      opStartTool(viewer, tool);
    } else {
      if (_ptPhase) ptCancel(viewer, false);
      if (getOpPhase()) opCancel(viewer, false);
      const h = tool ? TOOL_HANDLERS[tool] : null;
      if (h?.clicks === -1) {
        const label = tool === "wall-curve"
          ? "wall-curve — click control points  [Enter] build spline walls  [Esc] cancel"
          : tool === "stair-curve"
          ? "stair-curve — click control points  [Enter] build curved stair  [Esc] cancel"
          : tool === "stair-polyline"
          ? "stair-polyline — click points  [Enter] build polyline stair  [Esc] cancel"
          : `${tool} — click points  [double-click or Enter] commit  [Esc] cancel`;
        setPickerHint(label);
      } else if (h?.chain) {
        setPickerHint(`wall-polyline — click first wall start point  [Esc] cancel`);
      } else if (tool === "wall-pick") {
        setPickerHint("wall-pick — click a polygon, polyline, circle, or line to trace walls");
      } else if (tool === "clip-section") {
        setPickerHint("Clip Section — click point A then point B to define section line  [Esc] cancel");
      } else if (tool === "section") {
        setPickerHint("Section Box — click corner A then corner B to define box footprint  [Esc] cancel");
      }
    }
  });

  // ── pointerdown ──────────────────────────────────────────────────────────────
  vpBody.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const tool = readActiveTool();
    if (!tool) {
      // Precision transform click — intercept when PT is active.
      if (_ptPhase) {
        const obj = ptGetTarget();
        if (!obj) {
          const hit = opRaycastObject(viewer, ev.clientX, ev.clientY);
          if (hit) {
            ev.stopImmediatePropagation();
            viewer.selectObject(hit.obj);
            setSelected({ topology: "mesh", uuid: hit.obj.uuid, object: hit.obj, transformTarget: hit.obj });
            window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: hit.obj.uuid } }));
            opSetHover(null);
            const ptTool = (_ptPhase as { kind: "start"; tool: string }).tool;
            if (ptTool === "rotate") {
              // transition to rotate_axis_a — ptStartTool already set kind="rotate_axis_a" when no selection
              // but here we need to re-trigger the phase since we just set the selection
              ptStartTool("rotate"); // re-enter to get correct phase now that target is set
            } else if (ptTool === "scale-1d" || ptTool === "scale-2d") {
              ptPrompt(`${ptTool === "scale-1d" ? "Scale 1D" : "Scale 2D"} — click anchor point, or Enter for centroid`);
              ptShowCoordInput("x, y  or  x, y, z");
            } else {
              const lbl: Record<string, string> = { move: "Move", scale: "Scale 3D" };
              ptPrompt(`${lbl[ptTool] ?? ptTool} — reference point: click, type x,y,z, or Enter for centroid`);
              ptShowCoordInput("x, y  or  x, y, z");
            }
          }
          return;
        }
        // Axis-constrained or XY-plane cursor position.
        const axisBase = _ptPhase.kind === "rotate_axis_b" ? _ptPhase.axisA : ptGetAxisBase();
        let clickPt: THREE.Vector3 | null = null;
        if (_ptAxisLock && axisBase) {
          const rawPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, axisBase, ptEffectiveAxisDir());
          if (rawPt) {
            if (getSnap().snapOn && getSnap().gridOn) {
              const step = getSnap().step;
              if (_ptAxisLock === "x") rawPt.x = Math.round(rawPt.x / step) * step;
              else if (_ptAxisLock === "y") rawPt.y = Math.round(rawPt.y / step) * step;
              else rawPt.z = Math.round(rawPt.z / step) * step;
            }
            clickPt = rawPt;
          }
        }
        if (!clickPt) {
          const sv = nearestSnapVertex(viewer, ev.clientX, ev.clientY);
          if (sv) {
            clickPt = new THREE.Vector3(sv.x, sv.y, sv.z);
          } else if (getLastSurfaceHit()) {
            clickPt = getLastSurfaceHit()!.clone();
          } else {
            const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
            if (!world) return;
            const snapped = snapWorldForView(viewer, world);
            clickPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z);
          }
        }
        // Apply shift-axis constraint at click commit for rotate_axis_b.
        if (ev.shiftKey && !_ptAxisLock && _ptPhase?.kind === "rotate_axis_b" && _shiftAxisChoice) {
          const base = _ptPhase.axisA;
          const constrained = shiftAxisSnap(base, { x: clickPt.x, y: clickPt.y }, getSnap().step);
          clickPt = new THREE.Vector3(constrained.x, constrained.y, clickPt.z);
        }
        // Apply shift-axis constraint at click commit for end_move.
        if (ev.shiftKey && !_ptAxisLock && _ptPhase?.kind === "end_move" && _shiftAxisChoice) {
          const base = _ptPhase.start;
          if (_shiftAxisChoice === "z") {
            const dz = screenYtoDz(viewer, ev.clientY, base);
            const baseZ = base.z ?? 0;
            const step = getSnap().step;
            const rawZ = baseZ + dz;
            const lockedZ = getSnap().snapOn && getSnap().gridOn
              ? Math.round(rawZ / step) * step : Math.round(rawZ * 1000) / 1000;
            clickPt = new THREE.Vector3(base.x, base.y, lockedZ);
          } else {
            const constrained = shiftAxisSnap(base, { x: clickPt.x, y: clickPt.y }, getSnap().step);
            clickPt = new THREE.Vector3(constrained.x, constrained.y, base.z ?? 0);
          }
        }
        // Shift-snap for angle_end: snap commit angle to 15° increments.
        if (ev.shiftKey && _ptPhase?.kind === "angle_end") {
          const dx = clickPt.x - _ptPhase.base.x;
          const dy = clickPt.y - _ptPhase.base.y;
          const raw = Math.atan2(dy, dx) * 180 / Math.PI;
          const snapped15 = Math.round(raw / 15) * 15;
          const r = Math.hypot(dx, dy) || 1;
          const rad = snapped15 * Math.PI / 180;
          clickPt = new THREE.Vector3(
            _ptPhase.base.x + r * Math.cos(rad),
            _ptPhase.base.y + r * Math.sin(rad),
            clickPt.z,
          );
        }
        ev.stopImmediatePropagation();
        ptHandlePoint(viewer, clickPt);
        return;
      }

      // Shift+click standard select: toggle object in multi-select.
      if (ev.shiftKey && !_ptPhase && !getOpPhase()) {
        const hit = opRaycastObject(viewer, ev.clientX, ev.clientY);
        if (hit) {
          ev.stopImmediatePropagation();
          if (getMultiSelected().length === 0) {
            const cur = viewer.getTargetObject();
            if (cur) {
              addToMultiSelected({ topology: "mesh", uuid: cur.uuid, object: cur, transformTarget: cur });
            }
          }
          addToMultiSelected({ topology: "mesh", uuid: hit.obj.uuid, object: hit.obj, transformTarget: hit.obj });
          clearMultiSelHighlights();
          const multiSet = getMultiSelected();
          for (const s of multiSet) applyMultiSelHL(s.object);
          if (multiSet.length > 1) {
            viewer.setMultiTargets(multiSet.map(s => s.object));
          } else if (multiSet.length === 1) {
            viewer.selectObject(multiSet[0].object);
          }
        }
        return;
      }

      // Op-tool click (extrude, boolean, fillet, annotations, selection modes).
      const opPhase = getOpPhase();
      if (opPhase) {
        // Let clicks on the chooser overlay (bool_op/fillet chips) pass through unblocked.
        const _chooserEl = getChooserEl();
        if (_chooserEl && _chooserEl.contains(ev.target as Node)) return;
        ev.stopImmediatePropagation();
        if (opPhase.kind === "sel_window") {
          setSelDragging(true);
          opPhase.startX = ev.clientX;
          opPhase.startY = ev.clientY;
        } else if (opPhase.kind === "sel_lasso") {
          setSelDragging(true);
          opPhase.points = [{ x: ev.clientX, y: ev.clientY }];
        } else {
          opHandleClick(viewer, ev.clientX, ev.clientY);
        }
        return;
      }

      const session = getActiveCommandSession();
      if (session?.state === "collecting_args") {
        const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
        if (!world) return;
        ev.stopImmediatePropagation();
        const snapped = snapWorldForView(viewer, world);
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

    if (tool === "wall-pick") {
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, true);
      if (!hit) {
        setPickerHint("wall-pick — click a polygon, polyline, circle, or line to trace walls");
        return;
      }
      ev.stopImmediatePropagation();
      commitWallPick(viewer, hit.obj);
      return;
    }

    const world = (tool === "clip-section" ? unprojectForClipTool : unprojectToXY)(viewer, ev.clientX, ev.clientY);
    if (!world) return;
    ev.stopImmediatePropagation();
    _lastPointerClient = { x: ev.clientX, y: ev.clientY };
    const vertex = !ev.altKey ? nearestSnapVertex(viewer, ev.clientX, ev.clientY) : null;
    let snapped: { x: number; y: number; z?: number };
    if (vertex) {
      snapped = vertex;
    } else if (!ev.altKey && getLastSurfaceHit()) {
      const s = getLastSurfaceHit()!;
      snapped = { x: s.x, y: s.y, z: s.z };
    } else {
      snapped = snapWorldForView(viewer, world);
    }
    if (tool === "clip-section" && !vertex) {
      const av = viewer.activeView;
      const isElevation = av === "front" || av === "back" || av === "left" || av === "right";
      if (!isElevation) snapped = { ...snapped, z: world.z };
    }
    const clickShiftBase: { x: number; y: number; z?: number } | null =
      _pending.length > 0 ? _pending[_pending.length - 1] : _smartTrackPt ?? null;
    if (ev.shiftKey && !ev.altKey && clickShiftBase) {
      const baseZ = clickShiftBase.z ?? 0;
      if (_shiftAxisChoice === "z") {
        const dz = screenYtoDz(viewer, ev.clientY, clickShiftBase);
        const step = getSnap().step;
        const rawZ = baseZ + dz;
        const lockedZ = getSnap().snapOn && getSnap().gridOn
          ? Math.round(rawZ / step) * step : Math.round(rawZ * 1000) / 1000;
        snapped = { x: clickShiftBase.x, y: clickShiftBase.y, z: lockedZ };
      } else {
        const axisSnapped = shiftAxisSnap(clickShiftBase, snapped, getSnap().step);
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: baseZ };
      }
      _shiftAxisChoice = null;
    }
    const hostCreators = HOST_TOOL_CREATORS[tool];
    if (hostCreators) {
      const host = findHostMesh(viewer, ev.clientX, ev.clientY, hostCreators);
      if (!host) {
        const label = hostCreators.length === 1 ? hostCreators[0] : hostCreators.join(" or ");
        setPickerHint(`click a ${label} to place`);
        return;
      }
      setPendingHostId((host.userData as { expressID?: string; uuid?: string }).expressID ?? host.uuid);
      setPickerHint(null);
    }
    const z = tool === "level" ? getGeometryZ(viewer, ev.clientX, ev.clientY) : snapped.z;
    const clickHandler = TOOL_HANDLERS[tool];
    if (clickHandler?.clicks === -1 && _pending.length >= 2) {
      const now = performance.now();
      const ddx = ev.clientX - _lastCreateClickX, ddy = ev.clientY - _lastCreateClickY;
      if (now - _lastCreateClickTs < 500 && ddx * ddx + ddy * ddy < 100) {
        _lastCreateClickTs = 0;
        commitUnlimited(viewer);
        setPendingHostId(null);
        return;
      }
    }
    _lastCreateClickTs = performance.now();
    _lastCreateClickX = ev.clientX;
    _lastCreateClickY = ev.clientY;
    emitClickWorld(viewer, { ...snapped, z }, { tool });
    setPendingHostId(null);
  }, { capture: true });

  // ── pointermove ───────────────────────────────────────────────────────────────
  vpBody.addEventListener("pointermove", (ev) => {
    const tool = readActiveTool();
    const opPhase = getOpPhase();
    if (!tool && !_ptPhase && !opPhase) {
      const activeBtn = document.querySelector<HTMLElement>(".palette-btn.active");
      if (activeBtn?.dataset.tool === "select") {
        // Use viewer's pane-rect raycaster (same path as selection) so CSG display
        // meshes and regular structural elements are both detected correctly.
        const hoverObj = viewer.raycastForHover(ev.clientX, ev.clientY);
        opSetHover(hoverObj);
      } else {
        opSetHover(null);
      }
      hideCursorDot();
      setSnapTarget(null);
      return;
    }

    // Selection drag overlay updates.
    if (_selDragging && opPhase?.kind === "sel_window") {
      const svg = getSelOverlay(viewer);
      clearSelOverlay();
      const canvas = viewer.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const x1 = Math.min(opPhase.startX, ev.clientX) - rect.left;
      const y1 = Math.min(opPhase.startY, ev.clientY) - rect.top;
      const w = Math.abs(ev.clientX - opPhase.startX);
      const h = Math.abs(ev.clientY - opPhase.startY);
      const isWindow = opPhase.subMode === "window";
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", String(x1)); r.setAttribute("y", String(y1));
      r.setAttribute("width", String(w)); r.setAttribute("height", String(h));
      r.setAttribute("fill", isWindow ? "rgba(68,170,255,0.10)" : "rgba(68,255,170,0.10)");
      r.setAttribute("stroke", isWindow ? "#4af" : "#4fa");
      r.setAttribute("stroke-width", "1.5");
      r.setAttribute("stroke-dasharray", isWindow ? "none" : "4 3");
      svg.appendChild(r);
    } else if (_selDragging && opPhase?.kind === "sel_lasso") {
      opPhase.points.push({ x: ev.clientX, y: ev.clientY });
      const svg = getSelOverlay(viewer);
      clearSelOverlay();
      const canvas = viewer.getCanvas();
      const rect = canvas.getBoundingClientRect();
      if (opPhase.points.length >= 2) {
        const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        pl.setAttribute("points", opPhase.points.map(p => `${p.x - rect.left},${p.y - rect.top}`).join(" "));
        pl.setAttribute("fill", "rgba(68,170,255,0.10)");
        pl.setAttribute("stroke", "#4af"); pl.setAttribute("stroke-width", "1.5");
        svg.appendChild(pl);
      }
    }

    if (opPhase?.kind === "extrude_height") {
      opUpdateExtrudePreview(viewer, ev.clientX, ev.clientY, ev.shiftKey);
    }
    if (opPhase?.kind === "copy_place") {
      opUpdateCopyPreview(viewer, ev.clientX, ev.clientY);
    }
    if (opPhase?.kind === "fillet_edge") {
      opUpdateFilletEdge(viewer, ev.clientX, ev.clientY);
    }
    if (opPhase?.kind === "dim_b" || opPhase?.kind === "dim_c" || opPhase?.kind === "dim_area") {
      const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
      if (world) opUpdateDimPreview(viewer, new THREE.Vector3(world.x, world.y, world.z ?? 0));
    }
    if (opPhase && opPhaseIsObjectSelect(opPhase)) {
      // extrude_select uses profileOnly=true so hover matches what is clickable.
      const extrudeHover = opPhase.kind === "extrude_select";
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, extrudeHover, true);
      if (opPhase.kind === "bool_b") {
        opSetHover(hit && hit.obj !== opPhase.objA ? hit.obj : null);
      } else if (opPhase.kind === "bool_op") {
        opSetHover(null); // preserve selection highlights on objA (blue) and objB (orange)
      } else if (opPhase.kind === "extrude_select") {
        opSetHover(hit ? hit.obj : null);
        opUpdateSelectHoverPreview(viewer, hit ? hit.obj : null);
      } else {
        opSetHover(hit ? hit.obj : null);
      }
    } else if (ptPhaseIsObjectSelect()) {
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, false, true);
      opSetHover(hit ? hit.obj : null);
    } else if (tool === "wall-pick") {
      // #952: wall-pick is a pure mesh-click mode — hover highlight, no cursor dot.
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, true, true);
      opSetHover(hit ? hit.obj : null);
    } else {
      opSetHover(null);
    }

    if ((opPhase && opPhaseSupressesSnap(opPhase)) || ptPhaseIsObjectSelect() || tool === "wall-pick") {
      // During explicit object-select phases (extrude_select, bool_a/b, fillet_select),
      // keep the cursor visible so the user knows where they are clicking.
      // Only hide cursor for non-select snap-suppressed phases (fillet_edge, lasso, window).
      if (opPhase && opPhaseIsObjectSelect(opPhase)) {
        moveCursorDot(viewer, { x: ev.clientX, y: ev.clientY }, ev.clientX, ev.clientY, false);
      } else {
        hideCursorDot();
      }
      setSnapTarget(null);
      return;
    }

    const world = (tool === "clip-section" ? unprojectForClipTool : unprojectToXY)(viewer, ev.clientX, ev.clientY);
    if (!world) {
      if (_ptAxisLock && _ptPhase && _ptPhase.kind !== "start") {
        const axisBase = ptGetAxisBase();
        if (axisBase) {
          const constrained = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, axisBase, ptEffectiveAxisDir());
          if (constrained) {
            const screen = projectToScreen(viewer, constrained.x, constrained.y, constrained.z);
            moveCursorDot(viewer, constrained, screen?.x ?? ev.clientX, screen?.y ?? ev.clientY, false);
            return;
          }
        }
      }
      moveCursorDot(viewer, { x: 0, y: 0 }, ev.clientX, ev.clientY);
      return;
    }

    let snapped: { x: number; y: number; z?: number };
    if (ev.altKey) {
      setSnapTarget(null);
      snapped = world;
    } else {
      const vertex = nearestSnapVertex(viewer, ev.clientX, ev.clientY);
      if (vertex) {
        setSnapTarget(vertex);
        snapped = vertex;
      } else {
        setSnapTarget(null);
        // Use grid/floor-plane XY always; inherit Z from surface hit when available.
        // Previously used surface-hit XY, which caused cursor to jump to mesh-face
        // positions (e.g. wall faces) rather than the floor plane — "snap to unknown."
        const _sfcHit = getLastSurfaceHit();
        const _gs = snapWorldForView(viewer, world);
        snapped = _sfcHit ? { x: _gs.x, y: _gs.y, z: _sfcHit.z } : _gs;
      }
    }
    if (tool === "clip-section") {
      const av = viewer.activeView;
      const isElevation = av === "front" || av === "back" || av === "left" || av === "right";
      if (!isElevation) snapped = { ...snapped, z: world.z };
    }

    // Smart-track: promote hovered point to reference point after SMART_TRACK_MS dwell.
    if (!ev.altKey && tool && !_ptPhase && !opPhase) {
      const snapTgt = getSnapTarget();
      const trackId = snapTgt
        ? snapTgt.id
        : (getSnap().snapOn && getSnap().gridOn)
          ? `g:${Math.round(snapped.x * 1000)},${Math.round(snapped.y * 1000)}`
          : null;
      if (trackId) {
        const trackPt = snapTgt ?? snapped;
        if (_smartTrackCandidate?.id !== trackId) {
          if (_smartTrackTimer) clearTimeout(_smartTrackTimer);
          _smartTrackCandidate = { x: trackPt.x, y: trackPt.y, id: trackId };
          _smartTrackTimer = setTimeout(() => {
            if (_smartTrackCandidate) setSmartTrackPt(viewer, _smartTrackCandidate);
            _smartTrackTimer = null;
          }, SMART_TRACK_MS);
        }
      } else if (!ev.shiftKey) {
        if (_smartTrackTimer) { clearTimeout(_smartTrackTimer); _smartTrackTimer = null; _smartTrackCandidate = null; }
      }
    }

    // Shift-hold axis constraint — merged if/else-if so all arms share one cleanup else.
    const shiftBase: { x: number; y: number; z?: number } | null =
      _pending.length > 0 ? _pending[_pending.length - 1]
      : _smartTrackPt ?? null;
    if (ev.shiftKey && !ev.altKey && _ptPhase?.kind === "rotate_axis_b") {
      // Constrain rotate axis direction to X/Y from axisA.
      const base = _ptPhase.axisA;
      const dx = snapped.x - base.x;
      const dy = snapped.y - base.y;
      if (!_shiftAxisChoice) {
        const moved = Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4;
        if (moved) _shiftAxisChoice = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      }
      if (_shiftAxisChoice) {
        const axisSnapped = shiftAxisSnap(base, snapped, getSnap().step);
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: snapped.z };
        updateSketchShiftLine(viewer, base, _shiftAxisChoice);
      }
    } else if (ev.shiftKey && !ev.altKey && _ptPhase?.kind === "end_move") {
      // Constrain move delta to nearest cardinal axis (X/Y/Z) from reference start point.
      const base = _ptPhase.start;
      const dx = snapped.x - base.x;
      const dy = snapped.y - base.y;
      const dz = screenYtoDz(viewer, ev.clientY, base);
      const baseZ = base.z ?? 0;
      if (!_shiftAxisChoice) {
        const moved = Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4 || Math.abs(dz) > 1e-4;
        if (moved) {
          _shiftAxisChoice = (Math.abs(dz) > Math.abs(dx) && Math.abs(dz) > Math.abs(dy)) ? "z"
            : Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        }
      }
      if (_shiftAxisChoice === "z") {
        const step = getSnap().step;
        const rawZ = baseZ + dz;
        const lockedZ = getSnap().snapOn && getSnap().gridOn
          ? Math.round(rawZ / step) * step : Math.round(rawZ * 1000) / 1000;
        snapped = { x: base.x, y: base.y, z: lockedZ };
        updateSketchShiftLine(viewer, new THREE.Vector3(base.x, base.y, baseZ), "z");
      } else if (_shiftAxisChoice) {
        const axisSnapped = shiftAxisSnap(base, snapped, getSnap().step);
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: baseZ };
        updateSketchShiftLine(viewer, new THREE.Vector3(base.x, base.y, baseZ), _shiftAxisChoice);
      } else {
        clearSketchShiftLine(viewer);
      }
    } else if (ev.shiftKey && !ev.altKey && !_ptPhase && !opPhase && tool && shiftBase) {
      // Constrain sketch draw tools to X/Y/Z from last pending point or smart-track.
      const dx = snapped.x - shiftBase.x;
      const dy = snapped.y - shiftBase.y;
      const dz = screenYtoDz(viewer, ev.clientY, shiftBase);
      const baseZ = shiftBase.z ?? 0;
      if (!_shiftAxisChoice) {
        const moved = Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4 || Math.abs(dz) > 1e-4;
        if (moved) {
          _shiftAxisChoice = (Math.abs(dz) > Math.abs(dx) && Math.abs(dz) > Math.abs(dy)) ? "z"
            : Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        }
      }
      if (_shiftAxisChoice === "z") {
        const step = getSnap().step;
        const rawZ = baseZ + dz;
        const lockedZ = getSnap().snapOn && getSnap().gridOn
          ? Math.round(rawZ / step) * step : Math.round(rawZ * 1000) / 1000;
        snapped = { x: shiftBase.x, y: shiftBase.y, z: lockedZ };
        updateSketchShiftLine(viewer, new THREE.Vector3(shiftBase.x, shiftBase.y, baseZ), "z");
      } else if (_shiftAxisChoice) {
        const axisSnapped = shiftAxisSnap(shiftBase, snapped, getSnap().step);
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: baseZ };
        updateSketchShiftLine(viewer, new THREE.Vector3(shiftBase.x, shiftBase.y, baseZ), _shiftAxisChoice);
      } else {
        clearSketchShiftLine(viewer);
      }
    } else {
      _shiftAxisChoice = null;
      clearSketchShiftLine(viewer);
    }

    // PT axis lock: override cursor dot + snapped position to the constrained axis point.
    if (_ptAxisLock && _ptPhase && _ptPhase.kind !== "start") {
      const axisBase = _ptPhase.kind === "rotate_axis_b" ? _ptPhase.axisA : ptGetAxisBase();
      if (axisBase) {
        const axisDir = ptEffectiveAxisDir();
        const constrained = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, axisBase, axisDir);
        if (constrained) {
          if (getSnap().snapOn && getSnap().gridOn) {
            const step = getSnap().step;
            if (_ptAxisLock === "x") constrained.x = Math.round(constrained.x / step) * step;
            else if (_ptAxisLock === "y") constrained.y = Math.round(constrained.y / step) * step;
            else constrained.z = Math.round(constrained.z / step) * step;
          }
          setSnapTarget(null);
          snapped = { x: constrained.x, y: constrained.y, z: constrained.z };
        }
      }
    }

    const screen = projectToScreen(viewer, snapped.x, snapped.y, snapped.z ?? 0);
    moveCursorDot(viewer, snapped, screen?.x ?? ev.clientX, screen?.y ?? ev.clientY, getSnapTarget() !== null);

    // PT preview: live transform + readout.
    if (_ptPhase?.kind === "start") {
      const ptObj = ptGetTarget();
      const tlMap: Record<string, string> = { move: "Move", rotate: "Rotate", scale: "Scale 3D", "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
      const tl = tlMap[_ptPhase.tool] ?? _ptPhase.tool;
      if (!ptObj) ptPrompt(`${tl} — click to select an object`);
      else ptPrompt(`${tl} — reference point: click, type x,y,z, or Enter for centroid`);
    }
    // Live rotate preview: object turns in real time; Shift snaps to 15° increments.
    if (_ptPhase?.kind === "angle_end") {
      const angleDeg = ptUpdateAnglePreview(snapped.x, snapped.y, ev.shiftKey);
      if (angleDeg !== null) {
        const snapTag = ev.shiftKey ? "  [Shift: 15°]" : "";
        ptPrompt(`Rotate — ${Math.round(angleDeg * 10) / 10}°  [click to commit]${snapTag}`);
      }
    }
    // (remaining PT live-preview phases are handled inside transforms.ts ptHandlePoint)

    if (!tool) return;

    // Door/window ghost preview — runs before any click (#845/#846 AC3).
    if (tool === "door" || tool === "window") {
      updateOpeningPreview(viewer, tool as "door" | "window", snapped, ev.clientX, ev.clientY);
    } else {
      clearOpeningPreview(viewer);
    }

    if (_pending.length === 0) return;
    const handler = TOOL_HANDLERS[tool];
    if (!handler || (handler.clicks > 0 && handler.clicks < 2)) return;
    updateRubberBand(viewer, handler, snapped);
    if (tool === "roof" && _pending.length === 1) {
      updateRoofFootprint(viewer, _pending[0], snapped);
    }
  });

  // ── pointerleave ──────────────────────────────────────────────────────────────
  vpBody.addEventListener("pointerleave", () => {
    hideCursorDot();
    opSetHover(null);
    clearOpeningPreview(viewer);
  });

  // ── pointerup ─────────────────────────────────────────────────────────────────
  vpBody.addEventListener("pointerup", (ev) => {
    if (!_selDragging) return;
    setSelDragging(false);
    const opPhase = getOpPhase();
    if (opPhase?.kind === "sel_window") {
      const x1 = Math.min(opPhase.startX, ev.clientX);
      const y1 = Math.min(opPhase.startY, ev.clientY);
      const x2 = Math.max(opPhase.startX, ev.clientX);
      const y2 = Math.max(opPhase.startY, ev.clientY);
      if (x2 - x1 > 4 || y2 - y1 > 4) {
        runRectSel(viewer, x1, y1, x2, y2, opPhase.subMode);
        setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
      } else {
        removeSelOverlay();
      }
    } else if (opPhase?.kind === "sel_lasso" && opPhase.points.length >= 3) {
      runPolySel(viewer, opPhase.points, opPhase.subMode);
      setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
    } else {
      removeSelOverlay();
    }
  });

  // ── keydown ───────────────────────────────────────────────────────────────────
  window.addEventListener("keydown", (ev) => {
    const _tgt = ev.target as HTMLElement | null;
    if (_tgt && (_tgt.tagName === "INPUT" || _tgt.tagName === "TEXTAREA" || _tgt.isContentEditable)) return;
    if (_ptPhase && _ptPhase.kind !== "start"
        && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey
        && document.activeElement !== ptInput) {
      const key = ev.key.toLowerCase();
      if (key === "x" || key === "y" || key === "z") {
        ev.preventDefault();
        // Direct module-level mutation via re-export
        (_ptPhase as { kind: string }).kind; // access to confirm non-null
        const basePt = _ptPhase.kind === "rotate_axis_b" ? _ptPhase.axisA : ptGetAxisBase();
        if (basePt) ptSetAxisLockLine(viewer, basePt);
        return;
      }
    }
    // Ctrl+Z during in-progress draw/op: cancel the active state first, don't
    // undo the last placed object. Matches Rhino/Blender cancel-before-undo convention.
    if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && (ev.key === "z" || ev.key === "Z")) {
      if (_ptPhase) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        ptCancel(viewer);
        return;
      }
      if (getOpPhase()) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        opCancel(viewer);
        return;
      }
      if (_pending.length > 0) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        clearTemporary(viewer);
        clearSmartTrack(viewer);
        hideCursorDot();
        setPickerHint(null);
        _pending = [];
        dispatchSync("setActiveTool", { toolId: "select" });
        return;
      }
    }
    if (ev.key === "Escape") {
      if (_ptPhase) { ptCancel(viewer); return; }
      if (getOpPhase()) { opCancel(viewer); return; }
      if (_pending.length > 0) {
        clearTemporary(viewer);
        clearSmartTrack(viewer);
        hideCursorDot();
        setPickerHint(null);
        _pending = [];
        dispatchSync("setActiveTool", { toolId: "select" });
      } else {
        // ESC deactivates an active tool even before the first click (#844).
        const _escTool = readActiveTool();
        if (_escTool) {
          hideCursorDot();
          setPickerHint(null);
          dispatchSync("setActiveTool", { toolId: "select" });
        }
      }
      if (getActiveCommandSession()?.state === "collecting_args") {
        clearCommandSession();
        setPickerHint(null);
        setChooserHint(null);
      }
      return;
    }
    if (ev.key === "Enter" || (ev.key === " " && document.activeElement !== ptInput)) {
      if (ev.key === " ") {
        const repeatTool = _lastPtTool ?? _lastCompletedTool;
        if (!_ptPhase && !getOpPhase() && !readActiveTool() && repeatTool) {
          ev.preventDefault();
          dispatchSync("setActiveTool", { toolId: repeatTool });
          return;
        }
        ev.preventDefault();
      }
      if (getOpPhase()) {
        _opHandleEnter(viewer);
        return;
      }
      if (_ptPhase && document.activeElement !== ptInput) {
        _ptHandleEnter(viewer);
        return;
      }
      // Exit chain-mode tools (wall-polyline) on Enter
      const chainTool = readActiveTool();
      const chainHandler = chainTool ? TOOL_HANDLERS[chainTool] : null;
      if (chainHandler?.chain && _pending.length > 0) {
        clearTemporary(viewer);
        clearSmartTrack(viewer);
        hideCursorDot();
        setPickerHint(null);
        _pending = [];
        dispatchSync("setActiveTool", { toolId: "select" });
        return;
      }
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

  // ── keyup ─────────────────────────────────────────────────────────────────────
  window.addEventListener("keyup", (ev) => {
    if (ev.key === "Shift") {
      if (_ptAxisLock && _ptViewer) {
        ptClearAxisLockLine(_ptViewer);
      }
      if (_viewer) clearSketchShiftLine(_viewer);
      _shiftAxisChoice = null;
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
