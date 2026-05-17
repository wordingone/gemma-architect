// tools/index.ts — Create-mode coordinator extracted from create-mode.ts (#723).
// Owns: _createSequence, TOOL_HANDLERS, sketch-pipeline state, smart-track, emitClickWorld,
// initCreateMode event wiring.

import * as THREE from "three";
import type { Viewer } from "../viewer/viewer";
import { setState, subscribe } from "../app-state";
import { dispatchSync } from "../commands/dispatch";
import { getSnap, snapPoint } from "../viewer/snap-state";
import { getSnapTarget, setSnapTarget, getLastSnapEdgeDir, getLastSurfaceHit, HOST_TOOL_CREATORS, getPendingHostId, setPendingHostId, findHostMesh, nearestSnapVertex } from "../viewer/snap-state";
import { pushAction } from "../history";
import { getActiveCommandSession, provideSessionPick, provideSessionChoice, clearCommandSession, commitCommandSession } from "../commands/command-session";
import type { ChoiceOption } from "../commands/dictionary";
import { levelStore, getActiveLevelId } from "../geometry/levels";
import { getSelected, setSelected, addToMultiSelected, clearMultiSelected, getMultiSelected } from "../viewer/selection-state";
import { projectToScreen, unprojectToXY, unprojectForClipTool, snapWorldForView, getGeometryZ, showLevelChip } from "../viewer/projection";
import { initPickerHint, setPickerHint, setChooserHint, getChooserEl, readActiveTool, opSetHover, OP_TOOL_IDS } from "../viewer/picker-hint";
import { initPtOverlay, registerHideCursorDot, ptGetTarget, ptPrompt, ptClearPrompt, ptShowCoordInput, ptHideCoordInput, ptStartTool, ptHandlePoint, ptHandleCoordSubmit as _ptHandleCoordSubmit, ptHandleEnter as _ptHandleEnter, ptCancel, ptFinish, ptPhaseIsObjectSelect, _ptPhase, _ptAxisLock, _ptCoordInputEl, ptGetAxisBase, ptEffectiveAxisDir, ptSetAxisLockLine, ptClearAxisLockLine, _ptViewer, _lastPtTool, unprojectToAxisLine } from "../viewer/transforms";
import { registerOpToolHooks, opStartTool, opHandleClick, opHandleEnter as _opHandleEnter, opHandleCoordSubmit as _opHandleCoordSubmit, opCancel, opFinish, opPhaseIsObjectSelect, opPhaseSupressesSnap, opRaycastObject, opUpdateExtrudePreview, getOpPhase, setSelDragging, _selDragging, EXTRUDABLE_CREATORS, opGetScreenYtoDz } from "../viewer/op-tool";
import { registerSelectionOpsMarkers, getSelOverlay, clearSelOverlay, removeSelOverlay, clearMultiSelHighlights, applyMultiSelHL, runRectSel, runPolySel, isSelHLOwned } from "../viewer/selection-ops";
import { setStructuralViewer, buildWall, rebuildWallInPlace, attemptWallJoins, buildSlab, buildColumn, buildStair, buildBeam, buildRoof, buildSpace, buildFoundation, buildCeiling, buildCurtainWall, buildSkylight, buildGridLine, buildLevel, buildReferenceLine, buildSectionBox, buildClipPlane, buildBox, buildExtrude } from "./structural";
import { onElementCommitted, cutRectVoidFromBoxMesh } from "./join-groups";
import { buildRect, buildCircle, buildLine, buildPolygon, buildPolyline, buildCurve, buildRamp, buildRailing, buildPoint } from "./sketch";
import { buildDoor, buildWindow, buildOpening, FZK_DOOR_W, FZK_DOOR_H, FZK_WINDOW_W, FZK_WINDOW_H } from "./openings";

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
  _previewMesh.geometry.dispose();
  const mat = _previewMesh.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else (mat as THREE.Material).dispose();
  _previewMesh = null;
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

type ToolHandler = {
  clicks: number;
  handler: (pts: Array<{ x: number; y: number; z?: number }>) => {
    mesh: THREE.Object3D;
    chain: string;
    dispatchOnCommit?: { verb: string; args: Record<string, unknown> };
  };
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
  wall:        { clicks: 2, handler: atZ(([a, b]) => buildWall(a, b)) },
  rect:        { clicks: 2, handler: atZ(([a, b]) => buildRect(a, b)) },
  circle:      { clicks: 2, handler: atZ(([a, b]) => buildCircle(a, b)) },
  line:        { clicks: 2, handler: atZ(([a, b]) => buildLine(a, b)) },
  slab:        { clicks: 2, handler: atZ(([a, b]) => buildSlab(a, b)) },
  door:        { clicks: 1, handler: atZ(([p]) => buildDoor(p)) },
  window:      { clicks: 1, handler: atZ(([p]) => buildWindow(p)) },
  column:      { clicks: 1, handler: atZ(([p]) => buildColumn(p)) },
  stair:       { clicks: 2, handler: atZ(([a, b]) => buildStair(a, b)) },
  polygon:     { clicks: 2, handler: atZ(([a, b]) => buildPolygon(a, b)) },
  polyline:    { clicks: -1, handler: atZ((pts) => buildPolyline(pts)) },
  curve:       { clicks: -1, handler: atZ((pts) => buildCurve(pts)) },
  point:       { clicks: 1, handler: atZ(([p]) => buildPoint(p)) },
  extrude:     { clicks: 3, handler: atZ(([c1, c2, c3]) => buildBox(c1, c2, c3)) },
  beam:        { clicks: 2, handler: atZ(([a, b]) => buildBeam(a, b)) },
  roof:        { clicks: 2, handler: atTopOfLevel(([a, b]) => buildRoof(a, b), DEFAULT_CEILING_OFFSET) },
  space:       { clicks: 2, handler: atZ(([a, b]) => buildSpace(a, b)) },
  foundation:  { clicks: 2, handler: atZ(([a, b]) => buildFoundation(a, b)) },
  ceiling:     { clicks: 2, handler: atTopOfLevel(([a, b]) => buildCeiling(a, b), DEFAULT_CEILING_OFFSET) },
  curtainwall: { clicks: 2, handler: atZ(([a, b]) => buildCurtainWall(a, b)) },
  skylight:    { clicks: 2, handler: atZ(([a, b]) => buildSkylight(a, b)) },
  opening:     { clicks: 1, handler: atZ(([p]) => buildOpening(p)) },
  ramp:        { clicks: 2, handler: atZ(([a, b]) => buildRamp(a, b)) },
  railing:     { clicks: 2, handler: atZ(([a, b]) => buildRailing(a, b)) },
  grid:        { clicks: 2, handler: ([a, b]) => buildGridLine(a, b) },          // grid always at Z=0
  level:       { clicks: 1, handler: ([p]) => buildLevel(p) },                   // level uses getGeometryZ
  datum:       { clicks: 2, handler: ([a, b]) => buildReferenceLine(a, b) },     // datum always at Z=0
  section:     { clicks: 2, handler: ([a, b]) => buildSectionBox(a, b) },
  clip:        { clicks: 2, handler: ([a, b]) => buildClipPlane(a, b, _viewer?.activeView ?? "top") },
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

// ── commitUnlimited & emitClickWorld ─────────────────────────────────────────

function commitUnlimited(viewer: Viewer): { mesh: THREE.Object3D; chain: string } | null {
  const tool = readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler || handler.clicks !== -1 || _pending.length < 2) return null;
  clearTemporary(viewer);
  clearSmartTrack(viewer);
  const out = handler.handler(_pending);
  _pending = [];
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "mesh");
  if (out.mesh instanceof THREE.Mesh) onElementCommitted(out.mesh, viewer.getScene());
  _createSequence.push(out.chain);
  pushAction(out.mesh, out.chain);
  hideCursorDot();
  setPickerHint(null);
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
  if (_pending.length === 1 && handler.clicks !== 1) {
    setMarker(viewer, world);
  }
  if (handler.clicks === -1) {
    setPickerHint(`${tool} — ${_pending.length} point${_pending.length > 1 ? "s" : ""}  [double-click, Enter, or Space] commit  [Esc] cancel`);
    return null;
  }
  if (_pending.length < handler.clicks) return null;

  clearTemporary(viewer);
  clearSmartTrack(viewer);
  const out = handler.handler(_pending);
  _pending = [];
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "brep");
  if (out.mesh instanceof THREE.Mesh) onElementCommitted(out.mesh, viewer.getScene());
  // Void cut for door/window placed interactively (#754)
  if (out.mesh instanceof THREE.Mesh) {
    const _creator = out.mesh.userData.creator as string | undefined;
    if (_creator === "door" || _creator === "window") {
      const _hostId = out.mesh.userData.hostExpressID as string | undefined;
      if (_hostId) {
        let _host: THREE.Object3D | undefined;
        viewer.getScene().traverse((obj) => {
          if (_host || obj === out.mesh) return;
          if (obj.uuid === _hostId || (obj.userData as Record<string, unknown>).expressID === _hostId) _host = obj;
        });
        if (_host instanceof THREE.Mesh) {
          const _isWin = _creator === "window";
          const _vW = _isWin ? FZK_WINDOW_W : FZK_DOOR_W;
          const _vH = _isWin ? FZK_WINDOW_H : FZK_DOOR_H;
          const _vc = out.mesh.position.clone();
          _vc.z += _vH / 2;
          cutRectVoidFromBoxMesh(_host, _vc, _vW, _vH);
        }
      }
    }
  }
  if (out.mesh.userData.creator === "wall") attemptWallJoins(out.mesh as THREE.Mesh, viewer);
  _createSequence.push(out.chain);
  pushAction(out.mesh, out.chain);
  if (out.dispatchOnCommit) {
    dispatchSync(out.dispatchOnCommit.verb, out.dispatchOnCommit.args);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  }
  dispatchSync("setActiveTool", { toolId: "select" });

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

  const OP_TOOLS = new Set(["extrude", "boolean", "fillet", "aligned-dim", "angular-dim", "area-dim", "volume-dim", "sel-window", "sel-lasso", "sel-boundary"]);

  // Clear multi-select highlights when the viewer performs a normal single-object selection.
  window.addEventListener("viewer:select", () => {
    if (!isSelHLOwned()) { clearMultiSelHighlights(); clearMultiSelected(); }
  });

  // When activeTool changes to a PT or op tool, start the state machine.
  subscribe("activeTool", (tool) => {
    if (tool === "move" || tool === "rotate" || tool === "scale" || tool === "scale-1d" || tool === "scale-2d") {
      if (_ptPhase) ptCancel(viewer);
      if (getOpPhase()) opCancel(viewer);
      viewer.setGumballEnabled(false);
      ptStartTool(tool as "move" | "rotate" | "scale" | "scale-1d" | "scale-2d");
    } else if (OP_TOOLS.has(tool)) {
      if (_ptPhase) ptCancel(viewer);
      opStartTool(viewer, tool);
    } else {
      if (_ptPhase) ptCancel(viewer);
      if (getOpPhase()) opCancel(viewer);
      const h = tool ? TOOL_HANDLERS[tool] : null;
      if (h?.clicks === -1) {
        setPickerHint(`${tool} — click points  [double-click or Enter] commit  [Esc] cancel`);
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

    const world = (tool === "clip" ? unprojectForClipTool : unprojectToXY)(viewer, ev.clientX, ev.clientY);
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
    if (tool === "clip" && !vertex) {
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
    if (opPhase && opPhaseIsObjectSelect(opPhase)) {
      const profileOnly = opPhase.kind === "extrude_select";
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, profileOnly, true);
      if (opPhase.kind === "bool_b") {
        opSetHover(hit && hit.obj !== opPhase.objA ? hit.obj : null);
      } else {
        opSetHover(hit ? hit.obj : null);
      }
    } else if (ptPhaseIsObjectSelect()) {
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, false, true);
      opSetHover(hit ? hit.obj : null);
    } else {
      opSetHover(null);
    }

    if ((opPhase && opPhaseSupressesSnap(opPhase)) || ptPhaseIsObjectSelect()) {
      hideCursorDot();
      setSnapTarget(null);
      return;
    }

    const world = (tool === "clip" ? unprojectForClipTool : unprojectToXY)(viewer, ev.clientX, ev.clientY);
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
        snapped = getLastSurfaceHit()
          ? { x: getLastSurfaceHit()!.x, y: getLastSurfaceHit()!.y, z: getLastSurfaceHit()!.z }
          : snapWorldForView(viewer, world);
      }
    }
    if (tool === "clip") {
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

    // Shift-hold axis constraint for sketch draw tools.
    const shiftBase: { x: number; y: number; z?: number } | null =
      _pending.length > 0 ? _pending[_pending.length - 1]
      : _smartTrackPt ?? null;
    if (ev.shiftKey && !ev.altKey && !_ptPhase && !opPhase && tool && shiftBase) {
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
    // (remaining PT live-preview phases are handled inside transforms.ts ptHandlePoint)

    if (!tool) return;
    if (_pending.length === 0) return;
    const handler = TOOL_HANDLERS[tool];
    if (!handler || (handler.clicks > 0 && handler.clicks < 2)) return;
    updateRubberBand(viewer, handler, snapped);
  });

  // ── pointerleave ──────────────────────────────────────────────────────────────
  vpBody.addEventListener("pointerleave", () => {
    hideCursorDot();
    opSetHover(null);
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
        if (!_ptPhase && !getOpPhase() && !readActiveTool() && _lastPtTool) {
          ev.preventDefault();
          dispatchSync("setActiveTool", { toolId: _lastPtTool });
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
