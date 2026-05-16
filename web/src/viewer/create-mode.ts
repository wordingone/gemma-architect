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
import { csgUnion, csgDifference, csgIntersection } from "./csg";
import type { Viewer } from "./viewer";
import { setState, subscribe } from "../app-state";
import { dispatchSync } from "../commands/dispatch";
import { snapPoint, getSnap } from "./snap-state";
import { pushAction, pushTransformAction, captureTransform, pushReplaceAction } from "../history";
import { getActiveCommandSession, provideSessionPick, provideSessionChoice, clearCommandSession, commitCommandSession } from "../commands/command-session";
import type { ChoiceOption } from "../commands/dictionary";
import { gridStore } from "../geometry/grids";
import { levelStore } from "../geometry/levels";
import { refLineStore } from "../geometry/ref-lines";
import { getSelected, setSelected, addToMultiSelected, clearMultiSelected, getMultiSelected } from "./selection-state";
import { formatLength, formatArea, formatVolume } from "../units";

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
// Viewer reference set once by initCreateMode — used by resetPending.
let _viewer: Viewer | null = null;

// ─── Selection-mode state ─────────────────────────────────────────────────────
let _selOverlaySvg: SVGSVGElement | null = null;
let _selDragging = false;
let _rawChooserDefault: (() => void) | null = null;
let _multiSelHighlighted: THREE.Object3D[] = [];
let _selHLOwned = false; // suppress viewer:select clear while applySelResult is dispatching

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

// Op tools are handled by the opPhase state machine, not the click-to-place pipeline.
const OP_TOOL_IDS = new Set(["extrude", "boolean", "fillet", "aligned-dim", "angular-dim", "area-dim", "volume-dim", "label", "transient-measure", "sel-window", "sel-lasso", "sel-boundary"]);

// Creators that are valid extrude profiles (curves and surfaces).
const EXTRUDABLE_CREATORS = new Set(["rect", "circle", "polygon", "polyline", "curve", "line", "wall", "slab", "column", "box", "beam", "roof", "space"]);

// Object hovered during an op-tool select phase — highlighted with emissive tint.
let _opHoverObj: THREE.Object3D | null = null;
let _opHoverSavedEmissive: number | null = null;
// Highlight color used for both thin geometry (Line, Points) and mesh emissive during hover.
const HOVER_THIN_COLOR  = 0x44aaff; // line / points hover tint
const HOVER_MESH_EMIT   = 0x334455; // mesh emissive hover tint

function opSetHover(obj: THREE.Object3D | null): void {
  if (_opHoverObj === obj) return;
  // Restore previous hover object's original material state.
  if (_opHoverObj && _opHoverSavedEmissive !== null) {
    if (_opHoverObj instanceof THREE.Line) {
      (_opHoverObj.material as THREE.LineBasicMaterial).color.setHex(_opHoverSavedEmissive);
    } else if (_opHoverObj instanceof THREE.Points) {
      (_opHoverObj.material as THREE.PointsMaterial).color.setHex(_opHoverSavedEmissive);
    } else if (_opHoverObj instanceof THREE.Mesh) {
      const m = (_opHoverObj.material as THREE.MeshStandardMaterial);
      if (m?.emissive) m.emissive.setHex(_opHoverSavedEmissive);
    }
    _opHoverSavedEmissive = null;
  }
  _opHoverObj = obj;
  // Apply hover highlight to the new object.
  if (obj) {
    if (obj instanceof THREE.Line) {
      const lm = obj.material as THREE.LineBasicMaterial;
      _opHoverSavedEmissive = lm.color.getHex();
      lm.color.setHex(HOVER_THIN_COLOR);
    } else if (obj instanceof THREE.Points) {
      const pm = obj.material as THREE.PointsMaterial;
      _opHoverSavedEmissive = pm.color.getHex();
      pm.color.setHex(HOVER_THIN_COLOR);
    } else if (obj instanceof THREE.Mesh) {
      const m = obj.material as THREE.MeshStandardMaterial;
      if (m?.emissive) {
        _opHoverSavedEmissive = m.emissive.getHex();
        m.emissive.setHex(HOVER_MESH_EMIT);
      }
    }
  }
}

function readActiveTool(): string | null {
  const btn = document.querySelector<HTMLElement>(".palette-btn.active");
  const id = btn?.dataset.tool ?? null;
  if (!id || id === "select" || id === "move" || id === "rotate" || id === "scale" || id === "scale-1d" || id === "scale-2d") return null;
  if (OP_TOOL_IDS.has(id)) return null; // handled by opPhase, not click-to-place
  return id;
}

// ── Vertex snap ──────────────────────────────────────────────────────────────
// Snap candidates are explicit endpoint lists stored on each geometry mesh as
// userData.endpoints. Builders that set endpoints: buildWall, buildLine,
// buildPolyline. Others fall through to grid-only snap.

type SnapVertex = { x: number; y: number; z: number; id: string; edgeDir?: THREE.Vector3 };
let _snapTarget: SnapVertex | null = null;
export function getSnapTarget(): SnapVertex | null { return _snapTarget; }
// Last edge direction captured from an edge snap — used for smart Shift-lock.
let _lastSnapEdgeDir: THREE.Vector3 | null = null;
// Last mesh surface hit recorded inside nearestSnapVertex section 3.
// When the cursor ray hits geometry before the ground plane and no vertex/edge
// snap fires, callers fall back to this point instead of grid snap.
let _lastSurfaceHit: THREE.Vector3 | null = null;

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
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());
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

// Closest point on a 3-D segment [A,B] to the camera ray. Returns null when
// ray and segment are nearly parallel. Used for edge snap.
function closestPtOnSegToRay(
  viewer: Viewer, clientX: number, clientY: number,
  A: THREE.Vector3, B: THREE.Vector3,
): THREE.Vector3 | null {
  const segDir = B.clone().sub(A);
  const segLen = segDir.length();
  if (segLen < 1e-9) return null;
  const unit = segDir.clone().divideScalar(segLen);
  const pt = unprojectToAxisLine(viewer, clientX, clientY, A, unit);
  if (!pt) return null;
  const t = Math.max(0, Math.min(segLen, pt.clone().sub(A).dot(unit)));
  return A.clone().addScaledVector(unit, t);
}

function nearestSnapVertex(viewer: Viewer, clientX: number, clientY: number): SnapVertex | null {
  _lastSurfaceHit = null;
  const snap = getSnap();
  if (!snap.snapOn) return null;

  // ── Occlusion pre-pass ──────────────────────────────────────────────────────
  // Runs unconditionally so callers always know whether geometry blocks the
  // ground plane under the cursor — even when vertex/edge snap is toggled off,
  // or when the hit object is the current transform target (snapExclude).
  // The transform target is intentionally INCLUDED here; it must occlude grid snap
  // even though it is excluded from vertex/edge snap below (self-snap prevention).
  {
    const _occCanvas = viewer.getCanvas();
    const _occRect = _occCanvas.getBoundingClientRect();
    const _occNdc = new THREE.Vector2(
      ((clientX - _occRect.left) / _occRect.width) * 2 - 1,
      -((clientY - _occRect.top) / _occRect.height) * 2 + 1,
    );
    const _occRay = new THREE.Raycaster();
    _occRay.setFromCamera(_occNdc, viewer.getActiveCamera());
    const _occMeshes: THREE.Mesh[] = [];
    viewer.getScene().traverse((o) => {
      if (o.userData.noSnap) return;
      if (!(o instanceof THREE.Mesh)) return;
      if (!o.geometry || !o.geometry.getAttribute("position")) return;
      _occMeshes.push(o);
    });
    const _occHits = _occRay.intersectObjects(_occMeshes, false);
    if (_occHits.length > 0) _lastSurfaceHit = _occHits[0].point.clone();
  }

  // ── 0. Point objects — highest priority: snap to placed point markers ───────
  if (snap.pointSnapOn) {
    let ptBest: SnapVertex | null = null;
    let ptBestD = VERTEX_SNAP_PX;
    viewer.getScene().traverse((obj) => {
      if (obj.userData.noSnap) return;
      if (!(obj instanceof THREE.Points) || obj.userData.kind !== "point") return;
      const wp = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
      const sc = projectToScreen(viewer, wp.x, wp.y, wp.z);
      if (!sc) return;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < ptBestD) { ptBestD = d; ptBest = { id: makeSnapId(wp.x, wp.y, wp.z), x: wp.x, y: wp.y, z: wp.z }; }
    });
    if (ptBest) return ptBest;
  }

  const anyGeomSnap = snap.vertexSnapOn || snap.edgeSnapOn || snap.midpointSnapOn;
  if (!anyGeomSnap) return null;

  // ── 1. Stored endpoint vertices (sketch geometry: wall, line, polyline) ─────
  if (snap.vertexSnapOn) {
    const verts = collectSnapVertices(viewer);
    let best: SnapVertex | null = null;
    let bestD = VERTEX_SNAP_PX;
    for (const v of verts) {
      const sc = projectToScreen(viewer, v.x, v.y, v.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < bestD) { bestD = d; best = v; }
    }
    if (best) return best;

    // Midpoint snap on stored endpoint pairs.
    if (snap.midpointSnapOn) {
      const midState = { best: null as THREE.Vector3 | null, bestD: VERTEX_SNAP_PX };
      viewer.getScene().traverse((obj) => {
        const eps = (obj.userData as { endpoints?: SnapVertex[] }).endpoints;
        if (!eps || eps.length < 2) return;
        for (let i = 0; i < eps.length - 1; i++) {
          const a = eps[i], b = eps[i + 1];
          const mid = new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
          const sc = projectToScreen(viewer, mid.x, mid.y, mid.z);
          if (!sc) return;
          const d = Math.hypot(sc.x - clientX, sc.y - clientY);
          if (d < midState.bestD) { midState.bestD = d; midState.best = mid; }
        }
      });
      if (midState.best) {
        const v = midState.best;
        return { id: makeSnapId(v.x, v.y, v.z), x: v.x, y: v.y, z: v.z };
      }
    }
  }

  // ── 2. Line/curve objects: vertex snap by screen-distance to each control point ──
  // THREE.Raycaster has poor precision against Lines in perspective view (threshold
  // tuning is fiddly). Instead, iterate each vertex of Line/LineLoop/LineSegments
  // objects and snap by screen-distance — same as stored-endpoint snap in section 1.
  // No snapExclude: modification tools (scale/move/rotate) must be able to snap to
  // the transform target's own vertices/edges (Rhino-standard behaviour).
  const snapExclude = null;
  if (snap.vertexSnapOn || snap.edgeSnapOn) {
    let lineVBest: SnapVertex | null = null;
    let lineVBestD = VERTEX_SNAP_PX;
    viewer.getScene().traverse((obj) => {
      if (obj.userData.noSnap) return;
      if (obj === snapExclude) return;
      if (!(obj instanceof THREE.Line)) return; // covers Line, LineLoop, LineSegments
      const posAttr = obj.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
      if (!posAttr) return;
      const count = posAttr.count;
      for (let i = 0; i < count; i++) {
        const lv = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
        const sc = projectToScreen(viewer, lv.x, lv.y, lv.z);
        if (!sc) continue;
        const d = Math.hypot(sc.x - clientX, sc.y - clientY);
        if (d < lineVBestD) {
          lineVBestD = d;
          lineVBest = { id: makeSnapId(lv.x, lv.y, lv.z), x: lv.x, y: lv.y, z: lv.z };
        }
      }
      // Edge snap along segments for Line objects.
      if (snap.edgeSnapOn) {
        const looped = obj instanceof THREE.LineLoop;
        for (let i = 0; i < count - (looped ? 0 : 1); i++) {
          const A = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
          const B = new THREE.Vector3().fromBufferAttribute(posAttr, (i + 1) % count).applyMatrix4(obj.matrixWorld);
          const ep = closestPtOnSegToRay(viewer, clientX, clientY, A, B);
          if (!ep) continue;
          const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
          if (!sc) continue;
          const d = Math.hypot(sc.x - clientX, sc.y - clientY);
          if (d < lineVBestD) {
            lineVBestD = d;
            const edgeDir = B.clone().sub(A).normalize();
            lineVBest = { id: makeSnapId(ep.x, ep.y, ep.z), x: ep.x, y: ep.y, z: ep.z, edgeDir };
          }
        }
      }
    });
    if (lineVBest) {
      if ((lineVBest as SnapVertex).edgeDir) _lastSnapEdgeDir = (lineVBest as SnapVertex).edgeDir!;
      return lineVBest;
    }
  }

  // ── 3. Geometry raycasting — hits a mesh surface ───────────────────────────
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());

  // Filter to real Mesh objects; skip helpers, noSnap-tagged objects, and the
  // object currently being transformed (prevents snapping to itself).
  const meshes: THREE.Mesh[] = [];
  viewer.getScene().traverse((obj) => {
    if (obj.userData.noSnap) return;
    if (obj === snapExclude) return;
    if (!(obj instanceof THREE.Mesh)) return;
    if (!obj.geometry || !obj.geometry.getAttribute("position")) return;
    meshes.push(obj);
  });

  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  const hit = hits[0];
  if (!hit.face) return null;
  const mesh = hit.object as THREE.Mesh;
  const posAttr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const matW = mesh.matrixWorld;
  const faceIdx = [hit.face.a, hit.face.b, hit.face.c];
  const facePts = faceIdx.map(i => new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(matW));

  // Priority: vertex snap > midpoint snap > edge snap.
  let candidate: THREE.Vector3 | null = null;
  let candidateD = VERTEX_SNAP_PX;

  if (snap.vertexSnapOn) {
    for (const fv of facePts) {
      const sc = projectToScreen(viewer, fv.x, fv.y, fv.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < candidateD) { candidateD = d; candidate = fv; }
    }
    if (candidate) return { id: makeSnapId(candidate.x, candidate.y, candidate.z), x: candidate.x, y: candidate.y, z: candidate.z };
  }

  // Note: triangle-face midpoint snap is intentionally omitted here.
  // Snapping to midpoints of invisible internal triangulation edges produces
  // "snaps to unknown point" UX. Midpoint snap applies only to stored endpoint
  // pairs (section 1 above), where the segments are user-visible sketch lines.

  if (snap.edgeSnapOn) {
    // Snap to closest point anywhere along each of the 3 triangle edges.
    let edgeCandidateDir: THREE.Vector3 | null = null;
    for (let i = 0; i < 3; i++) {
      const A = facePts[i], B = facePts[(i + 1) % 3];
      const ep = closestPtOnSegToRay(viewer, clientX, clientY, A, B);
      if (!ep) continue;
      const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < candidateD) {
        candidateD = d;
        candidate = ep;
        edgeCandidateDir = B.clone().sub(A).normalize();
      }
    }
    if (candidate) {
      _lastSnapEdgeDir = edgeCandidateDir;
      return { id: makeSnapId(candidate.x, candidate.y, candidate.z), x: candidate.x, y: candidate.y, z: candidate.z, edgeDir: edgeCandidateDir ?? undefined };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

// Project a world-space XY point to screen (client) coordinates.
// Returns null when the point is behind the camera.
function projectToScreen(viewer: Viewer, x: number, y: number, z = 0): { x: number; y: number } | null {
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
// For top/persp views this is Z=0 (XY plane). Front/back use Y=0 (XZ plane).
// Left/right use X=0 (YZ plane). Uses the active camera so ortho views unproject correctly.
function unprojectToXY(viewer: Viewer, clientX: number, clientY: number): THREE.Vector3 | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const camera = viewer.getActiveCamera();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  // View-derived working plane: XY for top/default, XZ for front/back, YZ for right/left.
  let planeNormal: THREE.Vector3;
  switch (viewer.activeView) {
    case "front": case "back":  planeNormal = new THREE.Vector3(0, 1, 0); break;
    case "right": case "left":  planeNormal = new THREE.Vector3(1, 0, 0); break;
    default:                    planeNormal = new THREE.Vector3(0, 0, 1); break;
  }
  const plane = new THREE.Plane(planeNormal, 0);
  const point = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(plane, point);
  if (hit) return point;
  // Ray parallel to working plane — project camera position onto it as fallback.
  const fallback = new THREE.Vector3();
  plane.projectPoint(camera.position, fallback);
  return fallback;
}

// Unproject for the clip tool — intersects the view-appropriate plane instead of Z=0.
// In ortho elevation views the active camera shoots rays parallel to Z=0, so the ground-plane
// fallback in unprojectToXY produces wrong world coordinates. This function intersects the plane
// that is perpendicular to the view direction and passes through the world origin.
//   top/persp → Z=0 plane (same as unprojectToXY)
//   front/back → Y=0 plane (rays travel ±Y; x,z from screen position)
//   right/left → X=0 plane (rays travel ±X; y,z from screen position)
function unprojectForClipTool(viewer: Viewer, clientX: number, clientY: number): THREE.Vector3 | null {
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

// View-aware grid snap for the active working plane (extends snapPoint to elevation views).
// Top/persp → XY plane: delegates to snapPoint() (preserves grid-origin/rotation support).
// Front/back → XZ plane (Y=0): snaps x and z to the active grid step.
// Right/left → YZ plane (X=0): snaps y and z to the active grid step.
// The fixed-step branch skips grid-origin/rotation because those are defined in XY world space
// and don't apply to elevation cross-sections.
function snapWorldForView(viewer: Viewer, world: THREE.Vector3): { x: number; y: number; z: number } {
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
  // Top / perspective: full XY grid snap with origin+rotation support.
  const snapped = snapPoint(world.x, world.y);
  return { x: snapped.x, y: snapped.y, z: 0 };
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
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());
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
  const first = pts[0], last = pts[pts.length - 1];
  const pdx = last.x - first.x, pdy = last.y - first.y;
  const isClosed = pts.length >= 3 && pdx * pdx + pdy * pdy < 0.25;
  const corePts = isClosed ? pts.slice(0, -1) : pts;
  const drawPts = isClosed ? [...corePts, corePts[0]] : corePts;
  const xs = corePts.map((p) => p.x);
  const ys = corePts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const geom = new THREE.BufferGeometry();
  const flat = drawPts.flatMap((p) => [p.x - cx, p.y - cy, 0]);
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x1565c0 });
  const mesh = new THREE.Line(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "polyline";
  mesh.userData.creator = "polyline";
  mesh.userData.controlPoints = corePts.map((p) => new THREE.Vector3(p.x - cx, p.y - cy, 0));
  const worldVerts = corePts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const poly = drawPolyline([${worldVerts}]${isClosed ? ", { close: true }" : ""}).sketchOnPlane("XY").extrude(0.002);`;
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
  const first = pts[0], last = pts[pts.length - 1];
  const cdx = last.x - first.x, cdy = last.y - first.y;
  const isClosed = pts.length >= 3 && cdx * cdx + cdy * cdy < 0.25;
  const curvePts = isClosed ? pts.slice(0, -1) : pts;
  const xs = curvePts.map((p) => p.x);
  const ys = curvePts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const localVecs = curvePts.map((p) => new THREE.Vector3(p.x - cx, p.y - cy, 0));

  // Catmull-Rom: passes through every clicked point, closure handled natively.
  const sampleCount = Math.max(localVecs.length * 16, 64);
  const crCurve = new THREE.CatmullRomCurve3(localVecs, isClosed, "catmullrom", 0.5);
  const sampled3 = crCurve.getPoints(sampleCount);

  const geom = new THREE.BufferGeometry().setFromPoints(sampled3);
  const mat = new THREE.LineBasicMaterial({ color: 0x1565c0 });
  const mesh = new THREE.Line(geom, mat);
  mesh.position.set(cx, cy, 0);
  mesh.renderOrder = 1;
  mesh.userData.kind = "curve";
  mesh.userData.creator = "curve";
  mesh.userData.isClosed = isClosed;
  mesh.userData.nurbsKind = "catmull-rom";
  mesh.userData.controlPoints = localVecs;
  const worldPts = curvePts.map((p) => `[${round(p.x)}, ${round(p.y)}]`).join(", ");
  const chain = `const curv = drawCurve([${worldPts}]${isClosed ? ", { close: true }" : ""}).sketchOnPlane("XY").extrude(0.002);`;
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

function buildClipPlane(
  a: { x: number; y: number; z?: number },
  b: { x: number; y: number; z?: number },
): { mesh: THREE.Object3D; chain: string; dispatchOnCommit: { verb: string; args: Record<string, unknown> } } {
  const av = _viewer?.activeView ?? "top";
  const mat = new THREE.MeshBasicMaterial({ color: 0xff8800, transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const label = `clip-${Date.now()}`;
  let mesh: THREE.Mesh;
  let origin: [number, number, number];
  let normal: [number, number, number];

  if (av === "front" || av === "back") {
    // Elevation view: line drawn in XZ plane; clip normal is perpendicular in XZ.
    // rotY(atan2(-dz, dx)) aligns normal → (-dz/len, 0, dx/len), width → line dir in XZ.
    const az = a.z ?? 0, bz = b.z ?? 0;
    const dx = b.x - a.x, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const cx = (a.x + b.x) / 2, cz = (az + bz) / 2;
    origin = [round(cx), 0, round(cz)];
    normal = [round(nx), 0, round(nz)];
    const geom = new THREE.PlaneGeometry(len, 8);
    mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, 0, cz);
    mesh.rotation.set(0, Math.atan2(-dz, dx), 0);
  } else if (av === "right" || av === "left") {
    // Side view: line drawn in YZ plane; clip normal is perpendicular in YZ.
    // rotX(atan2(dz, dy)) aligns normal → (0, -dz/len, dy/len), height → line dir in YZ.
    const az = a.z ?? 0, bz = b.z ?? 0;
    const dy = b.y - a.y, dz = bz - az;
    const len = Math.sqrt(dy * dy + dz * dz) || 1;
    const ny = -dz / len, nz = dy / len;
    const cy = (a.y + b.y) / 2, cz = (az + bz) / 2;
    origin = [0, round(cy), round(cz)];
    normal = [0, round(ny), round(nz)];
    const geom = new THREE.PlaneGeometry(8, len);
    mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(0, cy, cz);
    mesh.rotation.set(Math.atan2(dz, dy), 0, 0);
  } else {
    // Top / perspective: line drawn in XY; clip normal is perpendicular in XY; plane is vertical.
    // rotX(PI/2) then rotZ(atan2(dy,dx)) aligns the mesh as a vertical plane.
    const dx = b.x - a.x, dy = b.y - a.y;
    const lineLen = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / lineLen, ny = dx / lineLen;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const planeH = 4;
    const geom = new THREE.PlaneGeometry(lineLen, planeH);
    mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, cy, planeH / 2);
    mesh.rotation.set(Math.PI / 2, 0, Math.atan2(dy, dx));
    origin = [round(cx), round(cy), 0];
    normal = [round(nx), round(ny), 0];
  }

  mesh.userData.kind = "clip-plane";
  mesh.userData.creator = "SdClippingPlane";
  mesh.userData.excludeFromClip = true;
  mesh.userData.clipLabel = label;
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
  // buildExtrude for design notes. polyline/curve: unlimited clicks (-1),
  // committed by Enter or double-click; closed automatically when last click
  // snaps back to the first point.
  stair:    { clicks: 2, handler: ([a, b]) => buildStair(a, b) },
  polygon:  { clicks: 2, handler: ([a, b]) => buildPolygon(a, b) },
  polyline: { clicks: -1, handler: (pts) => buildPolyline(pts) },
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

function clearSketchShiftLine(viewer: Viewer): void {
  if (!_sketchShiftAxisLine) return;
  viewer.getScene().remove(_sketchShiftAxisLine);
  _sketchShiftAxisLine.geometry.dispose();
  (_sketchShiftAxisLine.material as THREE.Material).dispose();
  _sketchShiftAxisLine = null;
}

function updateSketchShiftLine(viewer: Viewer, base: THREE.Vector3, axis: "x" | "y" | "z"): void {
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

function setSmartTrackPt(viewer: Viewer, pt: { x: number; y: number } | null): void {
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

function clearSmartTrack(viewer: Viewer): void {
  if (_smartTrackTimer) { clearTimeout(_smartTrackTimer); _smartTrackTimer = null; }
  _smartTrackCandidate = null;
  setSmartTrackPt(viewer, null);
}

function clearTemporary(viewer: Viewer): void {
  clearPreview(viewer);
  clearMarker(viewer);
  clearSketchShiftLine(viewer);
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

function updateRubberBand(viewer: Viewer, handler: ToolHandler, livePoint: { x: number; y: number; z?: number }): void {
  clearPreview(viewer);
  const isUnlimited = handler.clicks === -1;
  // Fixed-click tools only preview on 1 pending click; unlimited on ≥1.
  if (!isUnlimited && _pending.length !== 1) return;
  if (isUnlimited && _pending.length < 1) return;

  const previewPts = isUnlimited ? [..._pending, livePoint] : [_pending[0], livePoint];

  // Skip degenerate preview (check all three axes so clip tool in ortho elevation views works).
  const last = previewPts[previewPts.length - 1];
  const prev = previewPts[previewPts.length - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const dz = (last.z ?? 0) - (prev.z ?? 0);
  if (dx * dx + dy * dy + dz * dz < 1e-4) return;

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
    // Preview geometry must not become a snap target for its own tool session.
    preview.traverse((c) => { c.userData.noSnap = true; });
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
  clearSmartTrack(viewer);
  const out = handler.handler(_pending);
  _pending = [];
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "mesh");
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
  // Show point marker on first click of multi-click or unlimited tools.
  if (_pending.length === 1 && handler.clicks !== 1) {
    setMarker(viewer, world);
  }
  // Unlimited tools: update hint, never auto-commit; wait for Enter or double-click.
  if (handler.clicks === -1) {
    setPickerHint(`${tool} — ${_pending.length} point${_pending.length > 1 ? "s" : ""}  [double-click, Enter, or Space] commit  [Esc] cancel`);
    return null;
  }
  if (_pending.length < handler.clicks) return null;

  // All clicks collected — build final mesh.
  clearTemporary(viewer);
  clearSmartTrack(viewer);
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
  if (_viewer) { clearTemporary(_viewer); clearSmartTrack(_viewer); }
  hideCursorDot();
  setPickerHint(null);
  _pending = [];
  _shiftAxisChoice = null;
}

// ── Precision Transform state machine ────────────────────────────────────────
// Move:   pick_start → pick_end   → translate by (end - start)
// Rotate: pick_base  → hover/pick → rotate around Z by computed angle
// Scale:  pick_base  → type/pick  → uniform scale

type ScaleMode = "3d" | "1d" | "2d";

type PTPhase =
  | { kind: "start";         tool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d" }
  | { kind: "end_move";      start: THREE.Vector3 }
  | { kind: "rotate_axis_a" }
  | { kind: "rotate_axis_b"; axisA: THREE.Vector3 }
  | { kind: "angle_end";     base: THREE.Vector3; axisA: THREE.Vector3; axisDir: THREE.Vector3 }
  | { kind: "scale_ref";     base: THREE.Vector3; mode: ScaleMode }
  | { kind: "scale_end";     base: THREE.Vector3; refPt: THREE.Vector3; mode: ScaleMode };

let _ptPhase: PTPhase | null = null;
let _ptCoordInputEl: HTMLInputElement | null = null;
let _ptCoordWrapEl: HTMLElement | null = null;
let _ptPreviewLine: THREE.Line | null = null;
let _ptViewer: Viewer | null = null;
let _ptInitPos: THREE.Vector3 | null = null;
let _ptInitQuat: THREE.Quaternion | null = null;
let _ptInitScale: THREE.Vector3 | null = null;
let _ptAxisLock: "x" | "y" | "z" | null = null;
let _ptAxisLockLine: THREE.Line | null = null;
let _lastPtTool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d" | null = null;

function ptGetTarget(): THREE.Object3D | null {
  return getSelected()?.transformTarget ?? null;
}

function ptCentroid(obj: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3();
  box.getCenter(center);
  return center;
}

function ptPrompt(msg: string): void { setPickerHint(msg); }
function ptClearPrompt(): void { setPickerHint(null); }

function ptShowCoordInput(placeholder: string): void {
  if (!_ptCoordWrapEl) return;
  if (_ptCoordInputEl) _ptCoordInputEl.placeholder = placeholder;
  _ptCoordWrapEl.classList.add("visible");
  // Defer focus past the current click event so the viewport doesn't steal it back.
  setTimeout(() => _ptCoordInputEl?.focus(), 30);
}

function ptHideCoordInput(): void {
  if (!_ptCoordWrapEl) return;
  _ptCoordWrapEl.classList.remove("visible");
  if (_ptCoordInputEl) _ptCoordInputEl.value = "";
}

function ptClearPreviewLine(viewer: Viewer): void {
  if (_ptPreviewLine) {
    viewer.getScene().remove(_ptPreviewLine);
    _ptPreviewLine.geometry.dispose();
    (_ptPreviewLine.material as THREE.Material).dispose();
    _ptPreviewLine = null;
  }
}

function ptSetPreviewLine(viewer: Viewer, from: THREE.Vector3, to: THREE.Vector3): void {
  ptClearPreviewLine(viewer);
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({ color: 0x4488ff, depthTest: false });
  _ptPreviewLine = new THREE.Line(geo, mat);
  _ptPreviewLine.renderOrder = 99;
  _ptPreviewLine.userData.noSnap = true;
  viewer.getScene().add(_ptPreviewLine);
}

function ptGetAxisBase(): THREE.Vector3 | null {
  const p = _ptPhase;
  if (!p) return null;
  if (p.kind === "end_move") return p.start;
  if (p.kind === "rotate_axis_b") return p.axisA;
  if (p.kind === "angle_end") return p.base;
  if (p.kind === "scale_ref" || p.kind === "scale_end") return p.base;
  return null;
}

function ptClearAxisLockLine(viewer: Viewer): void {
  if (_ptAxisLockLine) {
    viewer.getScene().remove(_ptAxisLockLine);
    _ptAxisLockLine.geometry.dispose();
    (_ptAxisLockLine.material as THREE.Material).dispose();
    _ptAxisLockLine = null;
  }
}

function ptSetAxisLockLine(viewer: Viewer, basePt: THREE.Vector3): void {
  ptClearAxisLockLine(viewer);
  if (!_ptAxisLock) return;
  const dir = _ptAxisLock === "x" ? new THREE.Vector3(1, 0, 0) :
              _ptAxisLock === "y" ? new THREE.Vector3(0, 1, 0) :
                                    new THREE.Vector3(0, 0, 1);
  const color = _ptAxisLock === "x" ? 0xff3333 : _ptAxisLock === "y" ? 0x33cc33 : 0x3388ff;
  const geo = new THREE.BufferGeometry().setFromPoints([
    basePt.clone().addScaledVector(dir, -1000),
    basePt.clone().addScaledVector(dir,  1000),
  ]);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, opacity: 0.55, transparent: true });
  _ptAxisLockLine = new THREE.Line(geo, mat);
  _ptAxisLockLine.renderOrder = 98;
  _ptAxisLockLine.userData.noSnap = true;
  viewer.getScene().add(_ptAxisLockLine);
}

// Returns the effective axis direction for the current lock state.
// If the last snap was an edge snap and Shift is held, uses that edge direction
// (smart snap / stick-snap). Falls back to the cardinal axis.
function ptEffectiveAxisDir(): THREE.Vector3 {
  if (_lastSnapEdgeDir) return _lastSnapEdgeDir.clone();
  return _ptAxisLock === "x" ? new THREE.Vector3(1, 0, 0) :
         _ptAxisLock === "y" ? new THREE.Vector3(0, 1, 0) :
                               new THREE.Vector3(0, 0, 1);
}

// Closest point on axis line (basePt + t*axisDir) to the camera ray.
// Returns null when ray is nearly parallel to the axis (degenerate).
function unprojectToAxisLine(
  viewer: Viewer, clientX: number, clientY: number,
  basePt: THREE.Vector3, axisDir: THREE.Vector3,
): THREE.Vector3 | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, viewer.getActiveCamera());
  const ro = raycaster.ray.origin.clone();
  const rd = raycaster.ray.direction.clone();
  const w = ro.sub(basePt); // w = rayOrigin - basePt
  const b = rd.dot(axisDir);
  // Closest-point-on-axis formula: t = (b*(rd·w) - (axisDir·w)) / (1 - b²)
  // denom = 1 - b² (NOT b²-1; wrong sign flips t, mirroring the result across basePt)
  const denom = 1 - b * b;
  if (Math.abs(denom) < 1e-8) return null; // ray nearly parallel to axis — degenerate
  const t = (b * w.dot(rd) - w.dot(axisDir)) / denom;
  return basePt.clone().addScaledVector(axisDir, t);
}

// Finalize a PT operation — keep the current object transform, clean up state.
function ptFinish(viewer: Viewer): void {
  _ptInitPos = null; _ptInitQuat = null; _ptInitScale = null;
  _ptAxisLock = null;
  ptClearAxisLockLine(viewer);
  _ptPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  hideCursorDot();
  ptClearPreviewLine(viewer);
  viewer.setGumballEnabled(true);
  dispatchSync("setActiveTool", { toolId: "select" });
}

function ptCancel(viewer: Viewer): void {
  const obj = ptGetTarget();
  if (obj && _ptInitPos) {
    obj.position.copy(_ptInitPos);
    if (_ptInitQuat) obj.quaternion.copy(_ptInitQuat);
    if (_ptInitScale) obj.scale.copy(_ptInitScale);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);
  }
  ptFinish(viewer);
}

function ptCommitMove(obj: THREE.Object3D, delta: THREE.Vector3): void {
  obj.position.add(delta);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

function ptCommitRotate(obj: THREE.Object3D, base: THREE.Vector3, angleDeg: number, axisDir?: THREE.Vector3): void {
  const rad = angleDeg * Math.PI / 180;
  const axis = axisDir ? axisDir.clone().normalize() : new THREE.Vector3(0, 0, 1);
  obj.position.sub(base);
  obj.position.applyAxisAngle(axis, rad);
  obj.position.add(base);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, rad);
  obj.quaternion.premultiply(q);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

function ptCommitScale(obj: THREE.Object3D, base: THREE.Vector3, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  obj.position.sub(base);
  obj.position.multiplyScalar(factor);
  obj.position.add(base);
  obj.scale.multiplyScalar(factor);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

// Scale along the nearest world axis (X, Y, or Z) inferred from `dir`.
function ptCommitScale1D(obj: THREE.Object3D, base: THREE.Vector3, dir: THREE.Vector3, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  const axis: "x" | "y" | "z" = ax >= ay && ax >= az ? "x" : ay >= az ? "y" : "z";
  const offset = obj.position.clone().sub(base);
  offset[axis] *= factor;
  obj.position.copy(base).add(offset);
  obj.scale[axis] *= factor;
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

// Scale uniformly in XY (plan view); Z is preserved.
function ptCommitScale2D(obj: THREE.Object3D, base: THREE.Vector3, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  const offset = obj.position.clone().sub(base);
  offset.x *= factor;
  offset.y *= factor;
  obj.position.copy(base).add(offset);
  obj.scale.x *= factor;
  obj.scale.y *= factor;
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

function ptHandlePoint(viewer: Viewer, worldPt: THREE.Vector3): void {
  const phase = _ptPhase;
  if (!phase) return;
  const obj = ptGetTarget();
  if (!obj) { ptCancel(viewer); return; }

  if (phase.kind === "start") {
    // Save initial transform so cancel can restore it.
    _ptInitPos = obj.position.clone();
    _ptInitQuat = obj.quaternion.clone();
    _ptInitScale = obj.scale.clone();
    const pt = worldPt.clone();
    if (phase.tool === "move") {
      _ptPhase = { kind: "end_move", start: pt };
      ptPrompt("Target point — click, type x,y,z, or Enter for original position  [Shift+X/Y/Z = axis lock]");
      ptShowCoordInput("x, y  or  x, y, z");
    } else if (phase.tool === "rotate") {
      _ptPhase = { kind: "rotate_axis_a" };
      ptPrompt("Rotation axis — click start point of axis");
      ptHideCoordInput();
    } else {
      const scaleMode: ScaleMode = phase.tool === "scale-1d" ? "1d" : phase.tool === "scale-2d" ? "2d" : "3d";
      _ptPhase = { kind: "scale_ref", base: pt, mode: scaleMode };
      const scalePrompt = scaleMode === "1d"
        ? "Scale 1D — type factor or click anchor/origin point"
        : scaleMode === "2d"
        ? "Scale 2D — type factor or click anchor/origin point  [Z height unchanged]"
        : "Scale — type factor (e.g. 2.0) or click reference start point";
      ptPrompt(scalePrompt);
      ptShowCoordInput("scale factor");
    }
    return;
  }

  if (phase.kind === "rotate_axis_a") {
    _ptPhase = { kind: "rotate_axis_b", axisA: worldPt.clone() };
    ptPrompt("Rotation axis — click end point of axis");
    ptSetPreviewLine(viewer, worldPt, worldPt.clone().add(new THREE.Vector3(0, 0, 0.01)));
    // If axis lock was pre-set during rotate_axis_a, show the lock line now that we have a base.
    if (_ptAxisLock) ptSetAxisLockLine(viewer, worldPt);
    return;
  }

  if (phase.kind === "rotate_axis_b") {
    // Apply Shift axis lock to constrain the rotation axis to a cardinal direction.
    let endPt = worldPt.clone();
    if (_ptAxisLock) {
      endPt = phase.axisA.clone().add(ptEffectiveAxisDir());
    }
    const axisDir = endPt.clone().sub(phase.axisA);
    if (axisDir.length() < 1e-6) {
      ptPrompt("Rotation axis — points too close, click a different end point");
      return;
    }
    axisDir.normalize();
    // Save initial transform now that axis is defined.
    _ptInitPos = obj.position.clone();
    _ptInitQuat = obj.quaternion.clone();
    _ptInitScale = obj.scale.clone();
    _ptPhase = { kind: "angle_end", base: phase.axisA.clone(), axisA: phase.axisA.clone(), axisDir };
    ptPrompt("Rotation angle — hover and click, or type degrees");
    ptShowCoordInput("angle in degrees");
    return;
  }

  if (phase.kind === "end_move") {
    if (_ptInitPos) {
      const before = { pos: _ptInitPos.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      obj.position.copy(_ptInitPos).add(worldPt.clone().sub(phase.start));
      obj.updateMatrix(); obj.updateMatrixWorld(true);
      pushTransformAction(obj, before);
    }
    ptFinish(viewer);
    return;
  }

  if (phase.kind === "angle_end") {
    const dx = worldPt.x - phase.base.x;
    const dy = worldPt.y - phase.base.y;
    const raw = Math.atan2(dy, dx) * 180 / Math.PI;
    const snap = getSnap();
    const angleDeg = (snap.snapOn && snap.polarOn)
      ? Math.round(raw / snap.angleStep) * snap.angleStep : raw;
    if (_ptInitPos && _ptInitQuat) {
      const before = { pos: _ptInitPos.clone(), quat: _ptInitQuat.clone(), scale: _ptInitScale!.clone() };
      obj.position.copy(_ptInitPos);
      obj.quaternion.copy(_ptInitQuat);
      ptCommitRotate(obj, phase.base, angleDeg, phase.axisDir);
      pushTransformAction(obj, before);
    }
    ptFinish(viewer);
    return;
  }

  if (phase.kind === "scale_ref") {
    _ptPhase = { kind: "scale_end", base: phase.base, refPt: worldPt.clone(), mode: phase.mode };
    const endPrompt = phase.mode === "1d"
      ? "Scale 1D — click target point  [direction defined by first two clicks]"
      : phase.mode === "2d"
      ? "Scale 2D — click target point  [Z unchanged]"
      : "Scale end — click target point to define scale from reference distance";
    ptPrompt(endPrompt);
    ptHideCoordInput();
    return;
  }

  if (phase.kind === "scale_end") {
    const refDist = phase.refPt.distanceTo(phase.base);
    const newDist = worldPt.distanceTo(phase.base);
    if (refDist > 1e-6 && _ptInitPos && _ptInitScale) {
      const before = { pos: _ptInitPos.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale.clone() };
      obj.position.copy(_ptInitPos);
      obj.scale.copy(_ptInitScale);
      const factor = newDist / refDist;
      if (phase.mode === "1d") {
        ptCommitScale1D(obj, phase.base, phase.refPt.clone().sub(phase.base), factor);
      } else if (phase.mode === "2d") {
        ptCommitScale2D(obj, phase.base, factor);
      } else {
        ptCommitScale(obj, phase.base, factor);
      }
      pushTransformAction(obj, before);
    }
    ptFinish(viewer);
  }
}

function ptHandleCoordSubmit(viewer: Viewer, raw: string): void {
  const phase = _ptPhase;
  if (!phase) return;
  const obj = ptGetTarget();
  if (!obj) { ptCancel(viewer); return; }
  const nonNullObj = obj; // capture for inner function

  const parts = raw.split(/[,\s]+/).map(Number);

  // Reset object to initial transform before applying the typed exact value.
  function resetToInit(): void {
    if (_ptInitPos) nonNullObj.position.copy(_ptInitPos!);
    if (_ptInitQuat) nonNullObj.quaternion.copy(_ptInitQuat!);
    if (_ptInitScale) nonNullObj.scale.copy(_ptInitScale!);
    nonNullObj.updateMatrix(); nonNullObj.updateMatrixWorld(true);
  }

  if (phase.kind === "start" || phase.kind === "end_move") {
    if (parts.length >= 2 && parts.every(Number.isFinite)) {
      const pt = new THREE.Vector3(parts[0], parts[1], parts[2] ?? 0);
      if (phase.kind === "start") {
        ptHandlePoint(viewer, pt);
      } else {
        const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
        resetToInit();
        ptCommitMove(obj, pt.clone().sub(phase.start));
        pushTransformAction(obj, before);
        ptFinish(viewer);
      }
    }
    return;
  }

  if (phase.kind === "rotate_axis_a" || phase.kind === "rotate_axis_b") {
    // Coord input not used for axis picking — ignore.
    return;
  }

  if (phase.kind === "angle_end") {
    const deg = parts[0];
    if (Number.isFinite(deg)) {
      const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      resetToInit();
      ptCommitRotate(obj, phase.base, deg, phase.axisDir);
      pushTransformAction(obj, before);
      ptFinish(viewer);
    }
    return;
  }

  if (phase.kind === "scale_ref") {
    if (parts.length === 1 && Number.isFinite(parts[0]) && parts[0] > 0) {
      // Direct factor: for 1D we need a direction — treat the factor as a scale_end
      // along X (the default dominant axis) if no ref point has been clicked yet.
      const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      resetToInit();
      const f = parts[0];
      if (phase.mode === "1d") {
        ptCommitScale1D(obj, phase.base, new THREE.Vector3(1, 0, 0), f);
      } else if (phase.mode === "2d") {
        ptCommitScale2D(obj, phase.base, f);
      } else {
        ptCommitScale(obj, phase.base, f);
      }
      pushTransformAction(obj, before);
      ptFinish(viewer);
    } else if (parts.length >= 2 && parts.every(Number.isFinite)) {
      ptHandlePoint(viewer, new THREE.Vector3(parts[0], parts[1], parts[2] ?? 0));
    }
    return;
  }

  if (phase.kind === "scale_end") {
    const factor = parts[0];
    if (Number.isFinite(factor) && factor > 0) {
      const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      resetToInit();
      if (phase.mode === "1d") {
        ptCommitScale1D(obj, phase.base, phase.refPt.clone().sub(phase.base), factor);
      } else if (phase.mode === "2d") {
        ptCommitScale2D(obj, phase.base, factor);
      } else {
        ptCommitScale(obj, phase.base, factor);
      }
      pushTransformAction(obj, before);
      ptFinish(viewer);
    }
  }
}

function ptHandleEnter(viewer: Viewer): void {
  const phase = _ptPhase;
  if (!phase) return;
  const obj = ptGetTarget();
  if (!obj) { ptCancel(viewer); return; }

  if (phase.kind === "start") {
    const centroid = ptCentroid(obj);
    ptHandlePoint(viewer, centroid);
  } else if (phase.kind === "rotate_axis_a") {
    // Enter on axis start: use object centroid as axis start point.
    ptHandlePoint(viewer, ptCentroid(obj));
  } else if (phase.kind === "rotate_axis_b") {
    // Enter on axis end: use centroid + Z unit as a default Z axis.
    ptHandlePoint(viewer, phase.axisA.clone().add(new THREE.Vector3(0, 0, 1)));
  } else if (phase.kind === "end_move") {
    // Enter during move: cancel — restore to pre-move position.
    if (_ptInitPos) { obj.position.copy(_ptInitPos); obj.updateMatrix(); obj.updateMatrixWorld(true); }
    ptFinish(viewer);
  }
  // angle_end / scale: Enter does nothing (user must click or type)
}

function ptStartTool(tool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d"): void {
  _lastPtTool = tool;
  _ptPhase = { kind: "start", tool };
  _ptInitPos = null; _ptInitQuat = null; _ptInitScale = null;
  _ptAxisLock = null;
  const toolLabel: Record<string, string> = { move: "Move", rotate: "Rotate", scale: "Scale 3D", "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
  const label = toolLabel[tool] ?? "Scale";
  const obj = ptGetTarget();
  if (!obj) {
    ptPrompt(`${label} — click to select an object`);
    if (tool !== "rotate") ptShowCoordInput("x, y  or  x, y, z");
  } else if (tool === "rotate") {
    _ptPhase = { kind: "rotate_axis_a" };
    ptPrompt("Rotation axis — click start point of axis  (Enter = centroid)");
  } else if (tool === "scale-1d" || tool === "scale-2d") {
    ptPrompt(`${label} — click anchor point, or Enter for centroid`);
    ptShowCoordInput("x, y  or  x, y, z");
  } else {
    ptPrompt(`${label} — reference point: click, type x,y,z, or Enter for centroid`);
    ptShowCoordInput("x, y  or  x, y, z");
  }
}

// ── Op-tool state machine ─────────────────────────────────────────────────────
// Extrude, Boolean, Fillet, and annotation tools (aligned-dim, angular-dim,
// area-dim, volume-dim) share a lightweight multi-phase prompt driver that
// re-uses the existing picker-prompt / coord-input / cursor-dot infrastructure.

type OpPhase =
  | { kind: "extrude_select" }
  | { kind: "extrude_height"; profile: THREE.Object3D; cx: number; cy: number; w: number; d: number }
  | { kind: "bool_a" }
  | { kind: "bool_b"; objA: THREE.Object3D }
  | { kind: "bool_op"; objA: THREE.Object3D; objB: THREE.Object3D }
  | { kind: "fillet_select" }
  | { kind: "fillet_radius"; target: THREE.Object3D }
  | { kind: "sel_window_sub" }
  | { kind: "sel_window"; subMode: "crossing" | "window"; startX: number; startY: number }
  | { kind: "sel_lasso_sub" }
  | { kind: "sel_lasso"; subMode: "crossing" | "window"; points: Array<{ x: number; y: number }> }
  | { kind: "sel_boundary_sub" }
  | { kind: "sel_boundary_pick" }
  | { kind: "sel_boundary_draw"; points: Array<{ x: number; y: number }> }
  | { kind: "dim_a";       tool: "aligned-dim" | "angular-dim" | "area-dim" | "volume-dim" }
  | { kind: "dim_b";       tool: "aligned-dim"; ptA: THREE.Vector3 }
  | { kind: "dim_c";       tool: "angular-dim"; ptA: THREE.Vector3; ptB: THREE.Vector3 }
  | { kind: "dim_area";    tool: "area-dim";    pts: THREE.Vector3[] }
  | { kind: "dim_volume";  tool: "volume-dim" };

let _opPhase: OpPhase | null = null;
let _opPreview: THREE.Object3D | null = null;
let _opLabels: HTMLElement[] = [];

function opClearPreview(viewer: Viewer): void {
  if (_opPreview) {
    viewer.getScene().remove(_opPreview);
    _opPreview.traverse((c) => {
      if ((c as THREE.Mesh).geometry) (c as THREE.Mesh).geometry.dispose();
      const mat = (c as THREE.Mesh).material;
      if (mat) { if (Array.isArray(mat)) mat.forEach(m => m.dispose()); else (mat as THREE.Material).dispose(); }
    });
    _opPreview = null;
  }
}

function opClearLabels(): void {
  for (const el of _opLabels) el.remove();
  _opLabels = [];
}

function opFinish(viewer: Viewer): void {
  opClearPreview(viewer);
  opSetHover(null);
  _opPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  hideCursorDot();
  clearSketchShiftLine(viewer);
  setChooserHint(null);
  removeSelOverlay();
  _rawChooserDefault = null;
  _selDragging = false;
  viewer.setGumballEnabled(true);
  dispatchSync("setActiveTool", { toolId: "select" });
}

function opCancel(viewer: Viewer): void {
  opSetHover(null);
  // Un-highlight any stored boolean selections.
  const restoreEmissive = (obj: THREE.Object3D) => {
    const m = obj as THREE.Mesh;
    if (m.userData._savedEmissive !== undefined) {
      ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color)
        .setHex(m.userData._savedEmissive as number);
      delete m.userData._savedEmissive;
    }
  };
  if (_opPhase?.kind === "bool_b") restoreEmissive(_opPhase.objA);
  if (_opPhase?.kind === "bool_op") { restoreEmissive(_opPhase.objA); restoreEmissive(_opPhase.objB); }
  opFinish(viewer);
}

function opAddLabel(text: string, worldPt: THREE.Vector3, viewer: Viewer): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = [
    "position:fixed",
    "background:rgba(0,0,0,0.72)",
    "color:#fff",
    "padding:2px 6px",
    "border-radius:3px",
    "font-size:11px",
    "font-family:var(--mono,monospace)",
    "pointer-events:none",
    "z-index:9999",
    "white-space:nowrap",
  ].join(";");
  el.textContent = text;
  document.body.appendChild(el);
  _opLabels.push(el);
  const sc = projectToScreen(viewer, worldPt.x, worldPt.y, worldPt.z);
  if (sc) { el.style.left = (sc.x + 8) + "px"; el.style.top = (sc.y - 14) + "px"; }
  return el;
}

function opBuildAnnotLine(pts: THREE.Vector3[], color = 0x4488ff): THREE.Object3D {
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 100;
  line.userData.noSnap = true;
  return line;
}

// Build extrude geometry from a profile object at the given height.
// Returns a THREE.Mesh whose position is already set to world origin.
function opBuildExtrudeMesh(profile: THREE.Object3D, h: number): THREE.Mesh {
  const creator = profile.userData.creator as string | undefined;
  const box = new THREE.Box3().setFromObject(profile);
  const size = new THREE.Vector3(); box.getSize(size);
  const ctr = new THREE.Vector3(); box.getCenter(ctr);

  // Circle → cylinder
  if (creator === "circle") {
    const r = Math.max(0.05, size.x / 2);
    const geom = new THREE.CylinderGeometry(r, r, h, 64);
    // CylinderGeometry is Y-up; rotate so it extrudes along Z.
    geom.rotateX(Math.PI / 2);
    geom.translate(0, 0, h / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(ctr.x, ctr.y, 0);
    return mesh;
  }

  // Curve → Catmull-Rom extrusion. Closed curves get a filled solid;
  // open curves get a ruled surface.
  if (creator === "curve") {
    const cpLocal: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const isClosed = !!(profile.userData.isClosed as boolean | undefined);
    if (cpLocal.length >= 2) {
      profile.updateMatrixWorld();
      const cpWorld = cpLocal.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
      const sampleCt = Math.max(cpLocal.length * 16, 64);
      const crW = new THREE.CatmullRomCurve3(cpWorld, isClosed, "catmullrom", 0.5);
      const samples = crW.getPoints(sampleCt);
      const color = 0x88aacc;
      if (isClosed) {
        // Filled solid: Shape outline → ExtrudeGeometry (caps + side walls).
        const shape = new THREE.Shape();
        shape.moveTo(samples[0].x, samples[0].y);
        for (let i = 1; i < samples.length; i++) shape.lineTo(samples[i].x, samples[i].y);
        shape.closePath();
        const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05 });
        return new THREE.Mesh(geom, mat);
      } else {
        // Open curve → ruled surface swept along Z, using dense samples.
        const verts: number[] = [];
        const idxs: number[] = [];
        samples.forEach((p, i) => {
          verts.push(p.x, p.y, 0, p.x, p.y, h);
          if (i < samples.length - 1) {
            const b = i * 2;
            idxs.push(b, b+2, b+1, b+1, b+2, b+3);
          }
        });
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        geom.setIndex(idxs);
        geom.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
        return new THREE.Mesh(geom, mat);
      }
    }
  }

  // Line / polyline → vertical ruled surface from stored control points
  if (creator === "line" || creator === "polyline") {
    const pts: THREE.Vector3[] = (profile.userData.controlPoints as THREE.Vector3[] | undefined) ?? [];
    const worldPts = pts.map((p) => p.clone().applyMatrix4(profile.matrixWorld));
    if (worldPts.length >= 2) {
      const verts: number[] = [];
      const idxs: number[] = [];
      worldPts.forEach((p, i) => {
        verts.push(p.x, p.y, 0, p.x, p.y, h);
        if (i < worldPts.length - 1) {
          const b = i * 2;
          idxs.push(b, b+2, b+1, b+1, b+2, b+3);
        }
      });
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geom.setIndex(idxs);
      geom.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
      return new THREE.Mesh(geom, mat);
    }
  }

  // Rect or any other 2-D profile → box from bounding rect
  const w = Math.max(0.05, size.x);
  const d = Math.max(0.05, size.y || size.x);
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(ctr.x, ctr.y, 0);
  return mesh;
}

// Raycast scene geometry at clientX/Y, return first hit object.
// For extrude profiles, also checks Line objects by screen-distance to their vertices.
// Returns true for any op phase where the user is clicking to SELECT AN OBJECT
// (not picking a ground-plane point). Used to suppress snap and drive hover highlight.
// Add new object-pick phases here — the hover block and snap suppression both read this.
// PT-phase waiting for object click: "start" phase with no target yet selected.
// In this state the user is hovering to pick an object, not picking a world point.
function ptPhaseIsObjectSelect(): boolean {
  return _ptPhase?.kind === "start" && !ptGetTarget();
}

function opPhaseIsObjectSelect(phase: OpPhase): boolean {
  switch (phase.kind) {
    case "extrude_select":
    case "bool_a":
    case "bool_b":
    case "bool_op":
    case "fillet_select":
      return true;
    case "dim_a":
      return phase.tool === "volume-dim";
    default:
      return false;
  }
}

// Returns true for any op phase that should suppress the snap cursor dot entirely —
// includes object-select phases AND all selection-mode overlay phases (window/lasso/boundary).
function opPhaseSupressesSnap(phase: OpPhase): boolean {
  if (opPhaseIsObjectSelect(phase)) return true;
  switch (phase.kind) {
    case "sel_window_sub":
    case "sel_window":
    case "sel_lasso_sub":
    case "sel_lasso":
    case "sel_boundary_sub":
    case "sel_boundary_pick":
    case "sel_boundary_draw":
      return true;
    default:
      return false;
  }
}

function opRaycastObject(
  viewer: Viewer,
  clientX: number,
  clientY: number,
  profileOnly = false,
  hoverMode = false,
): { obj: THREE.Object3D; point: THREE.Vector3 } | null {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  const rc = new THREE.Raycaster();
  rc.setFromCamera(ndc, viewer.getActiveCamera());

  // Pass 1 — screen-proximity for thin geometry (Lines + Points).
  // Ray intersection misses zero-volume objects; proximity is robust for all view angles.
  // Lines: vertex proximity + segment proximity (catches cursor between sparse vertices).
  // Points: vertex proximity only (each point is a discrete position).
  const hitThresh = hoverMode ? 20 : 10;
  let thinHit: { obj: THREE.Object3D; point: THREE.Vector3 } | null = null;
  let thinHitD = hitThresh;
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap) return;
    if (profileOnly && !EXTRUDABLE_CREATORS.has(o.userData.creator ?? "")) return;
    const isLine = o instanceof THREE.Line;
    const isPts = o instanceof THREE.Points;
    if (!isLine && !isPts) return;
    const posAttr = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!posAttr) return;
    const count = posAttr.count;
    // Vertex proximity (all thin geometry).
    for (let i = 0; i < count; i++) {
      const wp = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
      const sc = projectToScreen(viewer, wp.x, wp.y, wp.z);
      if (!sc) continue;
      const d = Math.hypot(sc.x - clientX, sc.y - clientY);
      if (d < thinHitD) { thinHitD = d; thinHit = { obj: o, point: wp }; }
    }
    // Segment proximity — Lines only, catches cursor between widely-spaced vertices.
    if (isLine) {
      const looped = o instanceof THREE.LineLoop;
      for (let i = 0; i < count - (looped ? 0 : 1); i++) {
        const A = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(o.matrixWorld);
        const B = new THREE.Vector3().fromBufferAttribute(posAttr, (i + 1) % count).applyMatrix4(o.matrixWorld);
        const ep = closestPtOnSegToRay(viewer, clientX, clientY, A, B);
        if (!ep) continue;
        const sc = projectToScreen(viewer, ep.x, ep.y, ep.z);
        if (!sc) continue;
        const d = Math.hypot(sc.x - clientX, sc.y - clientY);
        if (d < thinHitD) { thinHitD = d; thinHit = { obj: o, point: ep }; }
      }
    }
  });
  if (thinHit) return thinHit;

  // Pass 2 — ray intersection for solid meshes.
  const meshes: THREE.Mesh[] = [];
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap) return;
    if (!(o instanceof THREE.Mesh)) return;
    if (!o.geometry?.getAttribute("position")) return;
    if (profileOnly && !EXTRUDABLE_CREATORS.has(o.userData.creator ?? "")) return;
    meshes.push(o);
  });
  const hits = rc.intersectObjects(meshes, false);
  if (!hits.length) return null;
  const hit = hits[0];
  return { obj: hit.object, point: hit.point.clone() };
}

// ─── Inline raw chooser (no command session) ─────────────────────────────────
function showRawChooser(
  label: string,
  options: Array<{ label: string; description: string; onSelect: () => void }>,
  defaultFn: () => void,
): void {
  if (!_chooserEl) return;
  _chooserEl.innerHTML = "";
  const lbl = document.createElement("div");
  lbl.className = "chooser-label";
  lbl.textContent = label;
  _chooserEl.appendChild(lbl);
  for (const opt of options) {
    const chip = document.createElement("button");
    chip.className = "chooser-chip";
    chip.textContent = opt.label;
    chip.title = opt.description;
    chip.addEventListener("click", () => {
      _rawChooserDefault = null;
      _chooserEl!.classList.remove("visible");
      _chooserEl!.innerHTML = "";
      opt.onSelect();
    });
    _chooserEl.appendChild(chip);
  }
  _chooserEl.classList.add("visible");
  _rawChooserDefault = defaultFn;
}

// ─── SVG overlay for drag-select visuals ─────────────────────────────────────
function getSelOverlay(viewer: Viewer): SVGSVGElement {
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
function clearSelOverlay(): void { if (_selOverlaySvg) _selOverlaySvg.innerHTML = ""; }
function removeSelOverlay(): void { if (_selOverlaySvg) { _selOverlaySvg.remove(); _selOverlaySvg = null; } }

// ─── Screen-space bbox ────────────────────────────────────────────────────────
function screenBboxOf(viewer: Viewer, obj: THREE.Object3D): { x1: number; y1: number; x2: number; y2: number; cx: number; cy: number } | null {
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

function pointInPolygon2D(px: number, py: number, poly: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ─── Multi-select highlight ───────────────────────────────────────────────────
function clearMultiSelHighlights(): void {
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
function applyMultiSelHL(obj: THREE.Object3D): void {
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

// ─── Run selection ────────────────────────────────────────────────────────────
function collectSelectable(viewer: Viewer): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap || !o.visible) return;
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.Line) && !(o instanceof THREE.Points)) return;
    // Skip internal marker / overlay objects.
    if (o === _markerMesh || o === _sketchShiftAxisLine) return;
    out.push(o);
  });
  return out;
}
function applySelResult(viewer: Viewer, matches: THREE.Object3D[]): void {
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
function runRectSel(viewer: Viewer, cx1: number, cy1: number, cx2: number, cy2: number, subMode: "crossing" | "window"): void {
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
function runPolySel(viewer: Viewer, poly: Array<{ x: number; y: number }>, subMode: "crossing" | "window"): void {
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

function opStartTool(viewer: Viewer, tool: string): void {
  opClearPreview(viewer);
  opClearLabels();
  opSetHover(null);
  _opPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  viewer.setGumballEnabled(false);

  if (tool === "extrude") {
    const sel = ptGetTarget();
    const selIsProfile = sel && EXTRUDABLE_CREATORS.has(sel.userData.creator ?? "");
    if (selIsProfile) {
      const box = new THREE.Box3().setFromObject(sel!);
      const size = new THREE.Vector3(); box.getSize(size);
      const ctr = new THREE.Vector3(); box.getCenter(ctr);
      _opPhase = { kind: "extrude_height", profile: sel!, cx: ctr.x, cy: ctr.y, w: size.x, d: size.y };
      ptPrompt("Extrude height — move cursor up/down to set height, click to commit  [Escape = cancel]");
    } else {
      _opPhase = { kind: "extrude_select" };
      ptPrompt("Extrude — click a curve, rectangle, circle, or polygon profile");
    }
  } else if (tool === "boolean") {
    _opPhase = { kind: "bool_a" };
    ptPrompt("Boolean — click the first solid");
  } else if (tool === "fillet") {
    _opPhase = { kind: "fillet_select" };
    ptPrompt("Fillet — click an edge, corner, or object");
  } else if (tool === "aligned-dim" || tool === "angular-dim" || tool === "area-dim" || tool === "volume-dim") {
    const t = tool as "aligned-dim" | "angular-dim" | "area-dim" | "volume-dim";
    _opPhase = { kind: "dim_a", tool: t };
    const msg: Record<string, string> = {
      "aligned-dim":  "Aligned dimension — click first point",
      "angular-dim":  "Angular dimension — click vertex point",
      "area-dim":     "Area — click points to define polygon, Enter to compute",
      "volume-dim":   "Volume — click an object to measure",
    };
    ptPrompt(msg[tool] ?? "Click to begin");
  } else if (tool === "sel-window") {
    _opPhase = { kind: "sel_window_sub" };
    const activateWindow = (sub: "crossing" | "window") => {
      _opPhase = { kind: "sel_window", subMode: sub, startX: -1, startY: -1 };
      ptPrompt(`Window Select (${sub === "crossing" ? "Crossing" : "Window"}) — click and drag to define selection window  [Esc] cancel`);
    };
    showRawChooser("Window Select:", [
      { label: "Crossing", description: "Objects that cross or are inside the window", onSelect: () => activateWindow("crossing") },
      { label: "Window",   description: "Objects fully inside the window",              onSelect: () => activateWindow("window") },
    ], () => activateWindow("crossing"));
    ptPrompt("Window Select — choose mode above  [Enter=Crossing]");
  } else if (tool === "sel-lasso") {
    _opPhase = { kind: "sel_lasso_sub" };
    const activateLasso = (sub: "crossing" | "window") => {
      _opPhase = { kind: "sel_lasso", subMode: sub, points: [] };
      ptPrompt(`Lasso Select (${sub === "crossing" ? "Crossing" : "Window"}) — click and drag to draw lasso  [Esc] cancel`);
    };
    showRawChooser("Lasso Select:", [
      { label: "Crossing", description: "Objects that cross or are inside the lasso", onSelect: () => activateLasso("crossing") },
      { label: "Window",   description: "Objects fully inside the lasso",              onSelect: () => activateLasso("window") },
    ], () => activateLasso("crossing"));
    ptPrompt("Lasso Select — choose mode above  [Enter=Crossing]");
  } else if (tool === "sel-boundary") {
    _opPhase = { kind: "sel_boundary_sub" };
    showRawChooser("Boundary input:", [
      { label: "Pick Curve",   description: "Click a closed curve/surface in the scene", onSelect: () => {
        _opPhase = { kind: "sel_boundary_pick" };
        ptPrompt("Boundary Select — click a closed curve in the scene  [Esc] cancel");
      }},
      { label: "Draw Polygon", description: "Click points to define boundary, Enter to close & select", onSelect: () => {
        _opPhase = { kind: "sel_boundary_draw", points: [] };
        ptPrompt("Boundary Select — click points to define polygon  [Enter] close & select  [Esc] cancel");
      }},
    ], () => {
      _opPhase = { kind: "sel_boundary_draw", points: [] };
      ptPrompt("Boundary Select — click points to define polygon  [Enter] close & select  [Esc] cancel");
    });
    ptPrompt("Boundary Select — choose input method above  [Enter=Draw Polygon]");
  }
}

function opExecBoolean(viewer: Viewer, objA: THREE.Object3D, objB: THREE.Object3D, op: "union" | "difference" | "split"): void {
  const restoreEmissive = (obj: THREE.Object3D) => {
    const m = obj as THREE.Mesh;
    if (m.userData._savedEmissive !== undefined) {
      ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color).setHex(m.userData._savedEmissive as number);
      delete m.userData._savedEmissive;
    }
  };
  restoreEmissive(objA); restoreEmissive(objB);

  if (!(objA instanceof THREE.Mesh) || !(objB instanceof THREE.Mesh)) {
    ptPrompt("Boolean — both objects must be solid meshes, not curves or points");
    setTimeout(() => ptClearPrompt(), 2000);
    opFinish(viewer); return;
  }
  const mA = objA as THREE.Mesh;
  const mB = objB as THREE.Mesh;

  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const tags: Record<string, string> = { union: "boolean-union", difference: "boolean-difference", split: "boolean-split" };

  let result: THREE.Mesh;
  try {
    if      (op === "union")      result = csgUnion(mA, mB, mat);
    else if (op === "difference") result = csgDifference(mA, mB, mat);
    else                          result = csgIntersection(mA, mB, mat);
  } catch {
    ptPrompt("Boolean failed — geometry may be degenerate or non-manifold");
    setTimeout(() => ptClearPrompt(), 2500);
    opFinish(viewer); return;
  }

  if (!result.geometry.getAttribute("position") || result.geometry.getAttribute("position").count === 0) {
    ptPrompt("Boolean produced empty result — objects may not overlap");
    setTimeout(() => ptClearPrompt(), 2500);
    opFinish(viewer); return;
  }

  const creator = tags[op];
  result.userData.kind = "brep";
  result.userData.creator = creator;
  viewer.getScene().remove(objA);
  viewer.getScene().remove(objB);
  // noHistory: true — pushReplaceAction below is the single canonical undo entry.
  viewer.addMesh(result, "brep", { noHistory: true });
  pushReplaceAction(result, [objA, objB], creator);
  opFinish(viewer);
}

function opShowBoolChooser(viewer: Viewer, objA: THREE.Object3D, objB: THREE.Object3D): void {
  if (!_chooserEl) return;
  _chooserEl.innerHTML = "";
  const label = document.createElement("div");
  label.className = "chooser-label";
  label.textContent = "Boolean operation:";
  _chooserEl.appendChild(label);
  const ops: Array<["union" | "difference" | "split", string]> = [
    ["union",      "Union"],
    ["difference", "Difference (A − B)"],
    ["split",      "Split (A ∩ B)"],
  ];
  for (const [op, lbl] of ops) {
    const chip = document.createElement("button");
    chip.className = "chooser-chip";
    chip.textContent = lbl;
    chip.addEventListener("click", () => opExecBoolean(viewer, objA, objB, op));
    _chooserEl.appendChild(chip);
  }
  _chooserEl.classList.add("visible");
}

function opHandleClick(viewer: Viewer, clientX: number, clientY: number): boolean {
  const phase = _opPhase;
  if (!phase) return false;

  const world = unprojectToXY(viewer, clientX, clientY);
  const sv = nearestSnapVertex(viewer, clientX, clientY);
  const snapped3 = sv
    ? new THREE.Vector3(sv.x, sv.y, sv.z)
    : world ? (() => { const s = snapWorldForView(viewer, world); return new THREE.Vector3(s.x, s.y, s.z); })()
             : null;
  if (!snapped3 && phase.kind !== "extrude_select" && phase.kind !== "bool_a" && phase.kind !== "bool_b" && phase.kind !== "fillet_select" && phase.kind !== "dim_a" && phase.kind !== "dim_volume") return false;

  // ── Extrude ────────────────────────────────────────────────────────────────
  if (phase.kind === "extrude_select") {
    const hit = opRaycastObject(viewer, clientX, clientY, true);
    if (!hit) { ptPrompt("Extrude — click a curve, rectangle, circle, or polygon profile"); return true; }
    const box = new THREE.Box3().setFromObject(hit.obj);
    const size = new THREE.Vector3(); box.getSize(size);
    const ctr = new THREE.Vector3(); box.getCenter(ctr);
    opSetHover(null);
    _opPhase = { kind: "extrude_height", profile: hit.obj, cx: ctr.x, cy: ctr.y, w: size.x, d: size.y };
    ptPrompt("Extrude height — move cursor up/down to set height, click to commit");
    return true;
  }

  if (phase.kind === "extrude_height") {
    // Commit the current preview height.
    const h = _opPreview ? (new THREE.Box3().setFromObject(_opPreview)).getSize(new THREE.Vector3()).z : 1;
    opClearPreview(viewer);
    const h2 = Math.max(0.05, h);
    const mesh = opBuildExtrudeMesh(phase.profile, h2);
    mesh.userData.kind = "brep";
    mesh.userData.creator = "extrude";
    viewer.addMesh(mesh, "brep");
    _createSequence.push(`// extrude h=${round(h2)} from profile creator=${phase.profile.userData.creator ?? "unknown"}`);
    pushAction(mesh, "extrude");
    opFinish(viewer);
    return true;
  }

  // ── Boolean ─────────────────────────────────────────────────────────────────
  if (phase.kind === "bool_a") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Boolean — click the first solid"); return true; }
    opSetHover(null); // clear hover highlight before locking A
    const m = hit.obj as THREE.Mesh;
    if (m.material && !Array.isArray(m.material) && (m.material as THREE.MeshStandardMaterial).emissive) {
      m.userData._savedEmissive = ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color).getHex();
      ((m.material as THREE.MeshStandardMaterial).emissive as THREE.Color).setHex(0x003399);
    }
    _opPhase = { kind: "bool_b", objA: hit.obj };
    ptPrompt("Boolean — click the second solid (selected: first highlighted)");
    return true;
  }

  if (phase.kind === "bool_b") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit || hit.obj === phase.objA) { ptPrompt("Boolean — click a different second solid"); return true; }
    const objB = hit.obj;
    // Highlight B.
    const mB = objB as THREE.Mesh;
    if (mB.material && !Array.isArray(mB.material) && (mB.material as THREE.MeshStandardMaterial).emissive) {
      mB.userData._savedEmissive = ((mB.material as THREE.MeshStandardMaterial).emissive as THREE.Color).getHex();
      ((mB.material as THREE.MeshStandardMaterial).emissive as THREE.Color).setHex(0x330033);
    }
    _opPhase = { kind: "bool_op", objA: phase.objA, objB };
    // Wire chooser buttons directly to local op executor (not command session).
    opShowBoolChooser(viewer, phase.objA, objB);
    ptPrompt("Boolean — choose operation");
    return true;
  }

  if (phase.kind === "bool_op") {
    // Chooser handles the op — clicks in 3D do nothing.
    return true;
  }

  // ── Fillet ──────────────────────────────────────────────────────────────────
  if (phase.kind === "fillet_select") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Fillet — click an edge, corner, or object"); return true; }
    _opPhase = { kind: "fillet_radius", target: hit.obj };
    ptPrompt("Fillet radius — type a value and press Enter");
    ptShowCoordInput("radius");
    return true;
  }

  // ── Annotations ─────────────────────────────────────────────────────────────
  if (phase.kind === "dim_a") {
    if (!snapped3) return true;
    if (phase.tool === "volume-dim") {
      const hit = opRaycastObject(viewer, clientX, clientY);
      const target = hit?.obj ?? null;
      if (!target) { ptPrompt("Volume — click an object to measure"); return true; }
      const box = new THREE.Box3().setFromObject(target);
      const size = new THREE.Vector3(); box.getSize(size);
      const vol = size.x * size.y * size.z;
      const ctr = new THREE.Vector3(); box.getCenter(ctr);
      opAddLabel(`Vol: ${formatVolume(vol)}`, ctr, viewer);
      opFinish(viewer);
      return true;
    }
    if (phase.tool === "area-dim") {
      _opPhase = { kind: "dim_area", tool: "area-dim", pts: [snapped3] };
      ptPrompt(`Area — click more points  [1 point placed, Enter to compute]`);
      return true;
    }
    if (phase.tool === "aligned-dim") {
      _opPhase = { kind: "dim_b", tool: "aligned-dim", ptA: snapped3 };
      ptPrompt("Aligned dimension — click second point");
      return true;
    }
    if (phase.tool === "angular-dim") {
      _opPhase = { kind: "dim_c", tool: "angular-dim", ptA: snapped3, ptB: snapped3.clone() };
      ptPrompt("Angular dimension — click first ray point");
      return true;
    }
    return true;
  }

  if (phase.kind === "dim_b" && snapped3) {
    const dist = snapped3.distanceTo(phase.ptA);
    const mid = phase.ptA.clone().add(snapped3).multiplyScalar(0.5);
    const lineObj = opBuildAnnotLine([phase.ptA, snapped3]);
    viewer.getScene().add(lineObj);
    opAddLabel(formatLength(dist), mid, viewer);
    opFinish(viewer);
    return true;
  }

  if (phase.kind === "dim_c" && snapped3) {
    // First click after vertex = first ray; second = second ray.
    if (phase.ptA.equals(phase.ptB)) {
      _opPhase = { kind: "dim_c", tool: "angular-dim", ptA: phase.ptA, ptB: snapped3 };
      ptPrompt("Angular dimension — click second ray point");
    } else {
      const v1 = phase.ptB.clone().sub(phase.ptA).normalize();
      const v2 = snapped3.clone().sub(phase.ptA).normalize();
      const angleDeg = Math.acos(Math.max(-1, Math.min(1, v1.dot(v2)))) * 180 / Math.PI;
      opAddLabel(`${angleDeg.toFixed(1)}°`, phase.ptA, viewer);
      opFinish(viewer);
    }
    return true;
  }

  if (phase.kind === "dim_area" && snapped3) {
    phase.pts.push(snapped3);
    ptPrompt(`Area — ${phase.pts.length} points placed, Enter to compute or click more`);
    return true;
  }

  // ── Selection modes (window/lasso sub-phases handled via pointer drag; boundary handled here) ──
  if (phase.kind === "sel_window_sub" || phase.kind === "sel_lasso_sub" || phase.kind === "sel_boundary_sub") {
    // Click on a chooser chip — let the chip's click handler manage it.
    const under = document.elementFromPoint(clientX, clientY);
    if (_chooserEl && _chooserEl.contains(under)) return true;
    // Click elsewhere → trigger the default mode AND start drag from this very click.
    if (_rawChooserDefault) { _rawChooserDefault(); _rawChooserDefault = null; }
    if (_chooserEl) { _chooserEl.classList.remove("visible"); _chooserEl.innerHTML = ""; }
    // Immediately begin the drag from this click position.
    if (_opPhase?.kind === "sel_window") {
      _selDragging = true;
      _opPhase.startX = clientX;
      _opPhase.startY = clientY;
    } else if (_opPhase?.kind === "sel_lasso") {
      _selDragging = true;
      _opPhase.points = [{ x: clientX, y: clientY }];
    }
    return true;
  }

  if (phase.kind === "sel_boundary_pick") {
    const hit = opRaycastObject(viewer, clientX, clientY);
    if (!hit) { ptPrompt("Boundary Select — click a closed curve or shape"); return true; }
    const box = new THREE.Box3().setFromObject(hit.obj);
    const corners: [number, number, number][] = [
      [box.min.x, box.min.y, box.min.z], [box.max.x, box.min.y, box.min.z],
      [box.max.x, box.max.y, box.min.z], [box.min.x, box.max.y, box.min.z],
    ];
    const poly = corners.map(([x, y, z]) => {
      const s = projectToScreen(viewer, x, y, z);
      return s ? { x: s.x, y: s.y } : null;
    }).filter((p): p is { x: number; y: number } => p !== null);
    if (poly.length >= 3) {
      runPolySel(viewer, poly, "crossing");
      setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
    } else {
      ptPrompt("Boundary Select — could not extract boundary; try a different object");
    }
    return true;
  }

  if (phase.kind === "sel_boundary_draw") {
    const world = unprojectToXY(viewer, clientX, clientY);
    if (!world) return true;
    const s = projectToScreen(viewer, world.x, world.y, 0);
    if (!s) return true;
    phase.points.push({ x: s.x, y: s.y });
    // Redraw polygon preview
    const svg = getSelOverlay(viewer);
    clearSelOverlay();
    const canvas = viewer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    if (phase.points.length >= 2) {
      const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      pl.setAttribute("points", phase.points.map(p => `${p.x - rect.left},${p.y - rect.top}`).join(" "));
      pl.setAttribute("fill", "rgba(68,170,255,0.12)");
      pl.setAttribute("stroke", "#4af"); pl.setAttribute("stroke-width", "1.5");
      svg.appendChild(pl);
      if (phase.points.length >= 3) {
        const cl = document.createElementNS("http://www.w3.org/2000/svg", "line");
        const last = phase.points[phase.points.length - 1];
        cl.setAttribute("x1", String(last.x - rect.left)); cl.setAttribute("y1", String(last.y - rect.top));
        cl.setAttribute("x2", String(phase.points[0].x - rect.left)); cl.setAttribute("y2", String(phase.points[0].y - rect.top));
        cl.setAttribute("stroke", "#4af"); cl.setAttribute("stroke-width", "1"); cl.setAttribute("stroke-dasharray", "3 3");
        svg.appendChild(cl);
      }
    }
    ptPrompt(`Boundary Select — ${phase.points.length} point${phase.points.length > 1 ? "s" : ""}  [Enter] close & select`);
    return true;
  }

  return false;
}

// Commit area polygon (Enter key).
function opHandleEnter(viewer: Viewer): void {
  const phase = _opPhase;
  if (!phase) return;

  // Raw chooser default (sel sub-phases: Enter = Crossing / Draw Polygon)
  if (phase.kind === "sel_window_sub" || phase.kind === "sel_lasso_sub" || phase.kind === "sel_boundary_sub") {
    if (_rawChooserDefault) { _rawChooserDefault(); _rawChooserDefault = null; }
    if (_chooserEl) { _chooserEl.classList.remove("visible"); _chooserEl.innerHTML = ""; }
    return;
  }

  // Boundary draw: Enter closes the polygon and runs selection
  if (phase.kind === "sel_boundary_draw" && phase.points.length >= 3) {
    removeSelOverlay();
    runPolySel(viewer, phase.points, "crossing");
    setTimeout(() => opFinish(viewer), 600);
    return;
  }

  if (phase.kind === "dim_area" && phase.pts.length >= 3) {
    // Shoelace formula for XY area (ignores Z).
    let area = 0;
    const pts = phase.pts;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      area += pts[i].x * pts[j].y;
      area -= pts[j].x * pts[i].y;
    }
    area = Math.abs(area) / 2;
    const ctr = pts.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const lineObj = opBuildAnnotLine([...pts, pts[0]]);
    viewer.getScene().add(lineObj);
    opAddLabel(`Area: ${formatArea(area)}`, ctr, viewer);
    opFinish(viewer);
    return;
  }

  if (phase.kind === "fillet_radius") {
    // Radius is submitted via coord input's Enter handler — this path handles
    // the case where Enter is pressed without a value in the input.
    ptPrompt("Fillet radius — type a value and press Enter");
    return;
  }
}

// Coord-input submit for op tools.
function opHandleCoordSubmit(viewer: Viewer, raw: string): void {
  const phase = _opPhase;
  if (!phase) return;
  if (phase.kind === "fillet_radius") {
    const r = parseFloat(raw);
    if (!Number.isFinite(r) || r <= 0) { ptPrompt("Fillet radius — enter a positive number"); return; }
    // Fillet geometry not yet wired to kernel — display the radius and finish.
    ptPrompt(`Fillet r=${formatLength(r)} — select an edge to apply (kernel integration pending)`);
    setTimeout(() => opFinish(viewer), 800);
  }
}

// Map cursor screen-Y to a world-space Z delta relative to a base point.
// Positive = cursor above base's projected screen position = moving upward in world space.
// Scale is derived from camera FOV and distance for a natural "1 pixel ≈ N metres" feel
// that is consistent regardless of camera angle or zoom.
function screenYtoDz(viewer: Viewer, screenY: number, base: { x: number; y: number; z?: number }): number {
  const canvas = viewer.getCanvas();
  const rect = canvas.getBoundingClientRect();
  const cam = viewer.getActiveCamera();
  const baseZ = base.z ?? 0;
  // Ortho: world-units per pixel = frustum height / screen height.
  // Persp: use FOV + distance formula.
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

// Live preview for extrude height.
// Height = cursor screen-Y displacement above the profile base's projected position,
// scaled by camera perspective. Shift grid-snaps the result.
function opUpdateExtrudePreview(viewer: Viewer, clientX: number, clientY: number, shiftKey = false): void {
  if (_opPhase?.kind !== "extrude_height") return;
  const { cx, cy } = _opPhase;
  const profileBase = new THREE.Vector3(cx, cy, 0);
  const rawH = screenYtoDz(viewer, clientY, { x: cx, y: cy, z: 0 });
  const step = getSnap().step;
  let h: number;
  if (rawH > 0) {
    h = shiftKey ? Math.max(step, Math.round(rawH / step) * step) : Math.max(0.05, rawH);
  } else {
    h = 0.05;
  }
  if (shiftKey) updateSketchShiftLine(viewer, profileBase, "z");
  else clearSketchShiftLine(viewer);
  opClearPreview(viewer);
  const mesh = opBuildExtrudeMesh(_opPhase.profile, h);
  mesh.traverse((c) => {
    if (c instanceof THREE.Mesh) {
      const mat = c.material as THREE.MeshStandardMaterial;
      c.material = new THREE.MeshStandardMaterial({
        color: (mat as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0xc9c0a8),
        transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide,
      });
      mat.dispose();
    }
  });
  mesh.traverse((c) => { c.renderOrder = 50; c.userData.noSnap = true; });
  _opPreview = mesh;
  viewer.getScene().add(mesh);
  const snapTag = shiftKey ? `  [grid snap ${formatLength(getSnap().step)}]` : "";
  ptPrompt(`Extrude height — ${formatLength(h)} — click to commit  [Escape = cancel]${snapTag}`);
}

// Bind the create-mode pipeline to viewport mousedown. Coexists with the
// selection raycaster — when no create-tool is active, mousedown just falls
// through to viewer.onPointerDown for selection.
export function initCreateMode(viewer: Viewer): void {
  _viewer = viewer;
  _ptViewer = viewer;
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
  _ptCoordWrapEl = ptWrap;
  _ptCoordInputEl = ptInput;

  ptInput.addEventListener("keydown", (ev) => {
    // Axis lock: Shift+X/Y/Z must work even when the coord input has focus.
    // Handle it here before stopPropagation so the window listener isn't needed.
    if (_ptPhase && _ptPhase.kind !== "start" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === "x" || k === "y" || k === "z") {
        ev.preventDefault();
        _ptAxisLock = k as "x" | "y" | "z";
        const basePt = ptGetAxisBase();
        if (basePt) ptSetAxisLockLine(viewer, basePt);
      }
    }
    ev.stopPropagation();
    if (ev.key === "Enter" || ev.key === " ") {
      const raw = ptInput.value.trim();
      if (raw) {
        if (_opPhase) opHandleCoordSubmit(viewer, raw);
        else ptHandleCoordSubmit(viewer, raw);
      } else {
        if (_opPhase) opHandleEnter(viewer);
        else ptHandleEnter(viewer);
      }
      ptInput.value = "";
      if (ev.key === " ") ev.preventDefault();
    } else if (ev.key === "Escape") {
      if (_ptPhase) ptCancel(viewer);
    }
  });

  const OP_TOOLS = new Set(["extrude", "boolean", "fillet", "aligned-dim", "angular-dim", "area-dim", "volume-dim", "sel-window", "sel-lasso", "sel-boundary"]);

  // Clear multi-select highlights when the viewer performs a normal single-object selection.
  // Skips when applySelResult owns the dispatch (_selHLOwned prevents double-clear).
  window.addEventListener("viewer:select", () => {
    if (!_selHLOwned) { clearMultiSelHighlights(); clearMultiSelected(); }
  });

  // When activeTool changes to a PT or op tool, start the state machine.
  subscribe("activeTool", (tool) => {
    if (tool === "move" || tool === "rotate" || tool === "scale" || tool === "scale-1d" || tool === "scale-2d") {
      if (_ptPhase) ptCancel(viewer); // restore any live-preview transform before switching
      if (_opPhase) opCancel(viewer);
      viewer.setGumballEnabled(false);
      ptStartTool(tool as "move" | "rotate" | "scale" | "scale-1d" | "scale-2d");
    } else if (OP_TOOLS.has(tool)) {
      if (_ptPhase) ptCancel(viewer);
      opStartTool(viewer, tool);
    } else {
      if (_ptPhase) ptCancel(viewer);
      if (_opPhase) opCancel(viewer);
      // Unlimited-click tools: show entry hint immediately on activation.
      const h = tool ? TOOL_HANDLERS[tool] : null;
      if (h?.clicks === -1) {
        setPickerHint(`${tool} — click points  [double-click or Enter] commit  [Esc] cancel`);
      }
    }
  });

  // Capture-phase listener — runs before the viewer's own pointerdown so we
  // can swallow the event when a create-tool is active or a session needs picks.
  vpBody.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const tool = readActiveTool();
    if (!tool) {
      // Precision transform click — intercept when PT is active.
      if (_ptPhase) {
        const obj = ptGetTarget();
        if (!obj) {
          // No selection yet — explicitly pick the hit object using our raycaster
          // so we own the selection and can update the prompt immediately.
          const hit = opRaycastObject(viewer, ev.clientX, ev.clientY);
          if (hit) {
            ev.stopImmediatePropagation();
            viewer.selectObject(hit.obj);
            // Mirror what viewer's own click handler does: update the selection-state
            // singleton so ptGetTarget() → getSelected() returns the object on the
            // very next click (viewer.selectObject alone only updates viewer.targetObject).
            setSelected({ topology: "mesh", uuid: hit.obj.uuid, object: hit.obj, transformTarget: hit.obj });
            window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: hit.obj.uuid } }));
            opSetHover(null);
            // Transition prompt now that target is set.
            const ptTool = (_ptPhase as { kind: "start"; tool: string }).tool;
            if (ptTool === "rotate") {
              _ptPhase = { kind: "rotate_axis_a" };
              ptPrompt("Rotation axis — click start point of axis  (Enter = centroid)");
              ptHideCoordInput();
            } else if (ptTool === "scale-1d" || ptTool === "scale-2d") {
              const lbl: Record<string, string> = { "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
              ptPrompt(`${lbl[ptTool]} — click anchor point, or Enter for centroid`);
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
          // Try geometry vertex/edge snap first.
          const sv = nearestSnapVertex(viewer, ev.clientX, ev.clientY);
          if (sv) {
            clickPt = new THREE.Vector3(sv.x, sv.y, sv.z);
          } else if (_lastSurfaceHit) {
            clickPt = _lastSurfaceHit.clone();
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
      // Shift+click standard select: toggle object in multi-select; reposition unified gumball.
      if (ev.shiftKey && !_ptPhase && !_opPhase) {
        const hit = opRaycastObject(viewer, ev.clientX, ev.clientY);
        if (hit) {
          ev.stopImmediatePropagation();
          // If the multi-set is empty, seed it with the current single selection
          // so the first shift+click accumulates two objects (not just the new one).
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
      if (_opPhase) {
        ev.stopImmediatePropagation();
        if (_opPhase.kind === "sel_window") {
          _selDragging = true;
          _opPhase.startX = ev.clientX;
          _opPhase.startY = ev.clientY;
        } else if (_opPhase.kind === "sel_lasso") {
          _selDragging = true;
          _opPhase.points = [{ x: ev.clientX, y: ev.clientY }];
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
    } else if (!ev.altKey && _lastSurfaceHit) {
      snapped = { x: _lastSurfaceHit.x, y: _lastSurfaceHit.y, z: _lastSurfaceHit.z };
    } else {
      snapped = snapWorldForView(viewer, world);
    }
    // For clip tool in top/perspective: carry the un-snapped view-plane z (snap resolves XY only).
    // In elevation views snapWorldForView already snaps z; overriding degrades snap to 1D (grid lines).
    if (tool === "clip" && !vertex) {
      const av = viewer.activeView;
      const isElevation = av === "front" || av === "back" || av === "left" || av === "right";
      if (!isElevation) snapped = { ...snapped, z: world.z };
    }
    // Shift-hold: axis-lock from last pending point, or smart-track reference if no pending.
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
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: baseZ }; // lock Z to base
      }
      _shiftAxisChoice = null; // clear after click so next segment can pick a new axis
    }
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
    // For shift-Z-locked clicks, preserve the locked Z; level tool always overrides.
    const z = tool === "level" ? getGeometryZ(viewer, ev.clientX, ev.clientY) : snapped.z;
    // Double-click to commit unlimited-click tools (polyline/curve).
    const clickHandler = TOOL_HANDLERS[tool];
    if (clickHandler?.clicks === -1 && _pending.length >= 2) {
      const now = performance.now();
      const ddx = ev.clientX - _lastCreateClickX, ddy = ev.clientY - _lastCreateClickY;
      if (now - _lastCreateClickTs < 500 && ddx * ddx + ddy * ddy < 100) {
        _lastCreateClickTs = 0;
        commitUnlimited(viewer);
        _pendingHostId = null;
        return;
      }
    }
    _lastCreateClickTs = performance.now();
    _lastCreateClickX = ev.clientX;
    _lastCreateClickY = ev.clientY;
    emitClickWorld(viewer, { ...snapped, z }, { tool });
    _pendingHostId = null;
  }, { capture: true });

  // Cursor dot + rubber-band preview on every pointer move.
  vpBody.addEventListener("pointermove", (ev) => {
    const tool = readActiveTool();
    if (!tool && !_ptPhase && !_opPhase) {
      // Standard select-tool: highlight hovered object, suppress snap cursor.
      const activeBtn = document.querySelector<HTMLElement>(".palette-btn.active");
      if (activeBtn?.dataset.tool === "select") {
        const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, false, true);
        opSetHover(hit ? hit.obj : null);
      } else {
        opSetHover(null);
      }
      hideCursorDot();
      _snapTarget = null;
      return;
    }

    // Op-tool preview + hover — runs independent of ground-plane availability.
    // (readActiveTool() returns null for op tools, so this must run before the world check.)

    // Selection drag overlay updates.
    if (_selDragging && _opPhase?.kind === "sel_window") {
      const svg = getSelOverlay(viewer);
      clearSelOverlay();
      const canvas = viewer.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const x1 = Math.min(_opPhase.startX, ev.clientX) - rect.left;
      const y1 = Math.min(_opPhase.startY, ev.clientY) - rect.top;
      const w = Math.abs(ev.clientX - _opPhase.startX);
      const h = Math.abs(ev.clientY - _opPhase.startY);
      const isWindow = _opPhase.subMode === "window";
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", String(x1)); r.setAttribute("y", String(y1));
      r.setAttribute("width", String(w)); r.setAttribute("height", String(h));
      r.setAttribute("fill", isWindow ? "rgba(68,170,255,0.10)" : "rgba(68,255,170,0.10)");
      r.setAttribute("stroke", isWindow ? "#4af" : "#4fa");
      r.setAttribute("stroke-width", "1.5");
      r.setAttribute("stroke-dasharray", isWindow ? "none" : "4 3");
      svg.appendChild(r);
    } else if (_selDragging && _opPhase?.kind === "sel_lasso") {
      _opPhase.points.push({ x: ev.clientX, y: ev.clientY });
      const svg = getSelOverlay(viewer);
      clearSelOverlay();
      const canvas = viewer.getCanvas();
      const rect = canvas.getBoundingClientRect();
      if (_opPhase.points.length >= 2) {
        const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        pl.setAttribute("points", _opPhase.points.map(p => `${p.x - rect.left},${p.y - rect.top}`).join(" "));
        pl.setAttribute("fill", "rgba(68,170,255,0.10)");
        pl.setAttribute("stroke", "#4af"); pl.setAttribute("stroke-width", "1.5");
        svg.appendChild(pl);
      }
    }

    if (_opPhase?.kind === "extrude_height") {
      opUpdateExtrudePreview(viewer, ev.clientX, ev.clientY, ev.shiftKey);
    }
    if (_opPhase && opPhaseIsObjectSelect(_opPhase)) {
      const profileOnly = _opPhase.kind === "extrude_select";
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, profileOnly, true);
      if (_opPhase.kind === "bool_b") {
        opSetHover(hit && hit.obj !== _opPhase.objA ? hit.obj : null);
      } else {
        opSetHover(hit ? hit.obj : null);
      }
    } else if (ptPhaseIsObjectSelect()) {
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, false, true);
      opSetHover(hit ? hit.obj : null);
    } else {
      opSetHover(null);
    }

    // Snap cursor suppressed during any object-selection phase and all selection-mode overlays.
    if ((_opPhase && opPhaseSupressesSnap(_opPhase)) || ptPhaseIsObjectSelect()) {
      hideCursorDot();
      _snapTarget = null;
      return;
    }

    const world = (tool === "clip" ? unprojectForClipTool : unprojectToXY)(viewer, ev.clientX, ev.clientY);
    if (!world) {
      // No ground-plane hit (near-horizontal camera).
      // PT axis lock may still resolve a constrained position along the locked axis.
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
    // Alt key bypasses snap (raw mouse position). Otherwise: vertex/edge snap first,
    // fall back to grid snap.
    let snapped: { x: number; y: number; z?: number };
    if (ev.altKey) {
      _snapTarget = null;
      _lastSnapEdgeDir = null;
      snapped = world;
    } else {
      const vertex = nearestSnapVertex(viewer, ev.clientX, ev.clientY);
      if (vertex) {
        _snapTarget = vertex;
        if (!vertex.edgeDir) _lastSnapEdgeDir = null;
        snapped = vertex;
      } else {
        _snapTarget = null;
        // Geometry between cursor and ground plane — use surface hit; skip grid snap.
        snapped = _lastSurfaceHit
          ? { x: _lastSurfaceHit.x, y: _lastSurfaceHit.y, z: _lastSurfaceHit.z }
          : snapWorldForView(viewer, world);
      }
    }
    // Carry view-plane z for clip tool in top/perspective only.
    // In elevation views (front/back/left/right) snapWorldForView already snaps z to the grid;
    // overriding with world.z would reduce snap to 1D (grid lines instead of intersections).
    if (tool === "clip") {
      const av = viewer.activeView;
      const isElevation = av === "front" || av === "back" || av === "left" || av === "right";
      if (!isElevation) snapped = { ...snapped, z: world.z };
    }

    // Smart-track: promote a hovered point (vertex snap OR grid intersection) to a reference
    // point after SMART_TRACK_MS dwell. Reference acts as Shift-constraint base before first click.
    if (!ev.altKey && tool && !_ptPhase && !_opPhase) {
      const trackId = _snapTarget
        ? _snapTarget.id
        : (getSnap().snapOn && getSnap().gridOn)
          ? `g:${Math.round(snapped.x * 1000)},${Math.round(snapped.y * 1000)}`
          : null;
      if (trackId) {
        const trackPt = _snapTarget ?? snapped;
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

    // Shift-hold axis constraint for sketch draw tools (not PT / op tools).
    // Base: last pending point if one exists, otherwise the smart-track reference.
    const shiftBase: { x: number; y: number; z?: number } | null =
      _pending.length > 0 ? _pending[_pending.length - 1]
      : _smartTrackPt ?? null;
    if (ev.shiftKey && !ev.altKey && !_ptPhase && !_opPhase && tool && shiftBase) {
      const dx = snapped.x - shiftBase.x;
      const dy = snapped.y - shiftBase.y;
      // Z from cursor screen-Y relative to the base point's projected screen position.
      const dz = screenYtoDz(viewer, ev.clientY, shiftBase);
      const baseZ = shiftBase.z ?? 0;
      // Latch axis choice on first dominant movement — prevents oscillation between X/Y/Z.
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
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: baseZ }; // lock Z to base
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
          // Grid-snap the locked coordinate only; perpendicular coords are already
          // fixed to axisBase by the axis projection.
          if (getSnap().snapOn && getSnap().gridOn) {
            const step = getSnap().step;
            if (_ptAxisLock === "x") constrained.x = Math.round(constrained.x / step) * step;
            else if (_ptAxisLock === "y") constrained.y = Math.round(constrained.y / step) * step;
            else constrained.z = Math.round(constrained.z / step) * step;
          }
          _snapTarget = null;
          snapped = { x: constrained.x, y: constrained.y, z: constrained.z };
        }
      }
    }
    // Project snapped world position back to screen so the dot visually snaps (#327).
    const screen = projectToScreen(viewer, snapped.x, snapped.y, snapped.z ?? 0);
    moveCursorDot(viewer, snapped, screen?.x ?? ev.clientX, screen?.y ?? ev.clientY, _snapTarget !== null);

    // PT preview: live transform + readout for each active phase.
    if (_ptPhase?.kind === "start") {
      // Update prompt when selection state may have changed.
      const ptObj = ptGetTarget();
      const tlMap2: Record<string, string> = { move: "Move", rotate: "Rotate", scale: "Scale 3D", "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
      const tl = tlMap2[_ptPhase.tool] ?? _ptPhase.tool;
      if (!ptObj) ptPrompt(`${tl} — click to select an object`);
      else ptPrompt(`${tl} — reference point: click, type x,y,z, or Enter for centroid`);
    } else if (_ptPhase?.kind === "end_move") {
      // Compute axis-constrained cursor world point.
      let cursorPt: THREE.Vector3;
      if (_ptAxisLock) {
        const rawPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.start, ptEffectiveAxisDir());
        if (rawPt) {
          if (getSnap().snapOn && getSnap().gridOn) {
            const step = getSnap().step;
            if (_ptAxisLock === "x") rawPt.x = Math.round(rawPt.x / step) * step;
            else if (_ptAxisLock === "y") rawPt.y = Math.round(rawPt.y / step) * step;
            else rawPt.z = Math.round(rawPt.z / step) * step;
          }
          cursorPt = rawPt;
        } else {
          cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
        }
      } else {
        cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      }
      // Live preview: move object.
      const ptObj = ptGetTarget();
      if (ptObj && _ptInitPos) {
        ptObj.position.copy(_ptInitPos).add(cursorPt.clone().sub(_ptPhase.start));
        ptObj.updateMatrix(); ptObj.updateMatrixWorld(true);
      }
      ptSetPreviewLine(viewer, _ptPhase.start, cursorPt);
      const delta = cursorPt.clone().sub(_ptPhase.start);
      const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} LOCK]` : "";
      ptPrompt(`Target point — click, type x,y,z  [Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)}, ${delta.z.toFixed(2)}]${lockTag}`);
    } else if (_ptPhase?.kind === "rotate_axis_a") {
      const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      ptPrompt(`Rotation axis — click start point  [${cursorPt.x.toFixed(2)}, ${cursorPt.y.toFixed(2)}, ${cursorPt.z.toFixed(2)}]`);
    } else if (_ptPhase?.kind === "rotate_axis_b") {
      let cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      // If Shift+axis-lock: constrain to that cardinal direction from axisA.
      if (_ptAxisLock) {
        const axisDir = ptEffectiveAxisDir();
        const projected = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.axisA, axisDir);
        if (projected) cursorPt = projected;
      }
      ptSetPreviewLine(viewer, _ptPhase.axisA, cursorPt);
      const dir = cursorPt.clone().sub(_ptPhase.axisA).normalize();
      const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} AXIS]` : "";
      ptPrompt(`Rotation axis — click end point  [dir ${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)}]${lockTag}`);
    } else if (_ptPhase?.kind === "angle_end") {
      const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      // Use raw ground-plane XY for angle — axis-lock may have zeroed dx/dy if Z-locked.
      const dx = world.x - _ptPhase.base.x;
      const dy = world.y - _ptPhase.base.y;
      const raw = Math.atan2(dy, dx) * 180 / Math.PI;
      const snap2 = getSnap();
      const deg = (snap2.snapOn && snap2.polarOn)
        ? Math.round(raw / snap2.angleStep) * snap2.angleStep : raw;
      // Live preview: rotate object.
      const ptObj = ptGetTarget();
      if (ptObj && _ptInitPos && _ptInitQuat) {
        ptObj.position.copy(_ptInitPos);
        ptObj.quaternion.copy(_ptInitQuat);
        ptCommitRotate(ptObj, _ptPhase.base, deg, _ptPhase.axisDir);
      }
      ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
      ptPrompt(`Rotation angle — hover and click  [${Math.round(deg)}°]  or type degrees`);
    } else if (_ptPhase?.kind === "scale_ref") {
      const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
      const dist = cursorPt.distanceTo(_ptPhase.base);
      ptPrompt(`Scale — click reference start point  [dist from anchor: ${formatLength(dist)}]`);
    } else if (_ptPhase?.kind === "scale_end") {
      let cursorPt: THREE.Vector3;
      if (_ptAxisLock) {
        cursorPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.base, ptEffectiveAxisDir())
          ?? new THREE.Vector3(snapped.x, snapped.y, 0);
      } else {
        cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      }
      const refDist = _ptPhase.refPt.distanceTo(_ptPhase.base);
      const newDist = cursorPt.distanceTo(_ptPhase.base);
      const factor = refDist > 1e-6 ? newDist / refDist : 1;
      // Live preview: scale object.
      const ptObj = ptGetTarget();
      if (ptObj && _ptInitPos && _ptInitScale) {
        ptObj.position.copy(_ptInitPos);
        ptObj.scale.copy(_ptInitScale);
        if (_ptPhase.mode === "1d") {
          ptCommitScale1D(ptObj, _ptPhase.base, _ptPhase.refPt.clone().sub(_ptPhase.base), factor);
        } else if (_ptPhase.mode === "2d") {
          ptCommitScale2D(ptObj, _ptPhase.base, factor);
        } else {
          ptCommitScale(ptObj, _ptPhase.base, factor);
        }
      }
      ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
      const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} LOCK]` : "";
      const modeTag = _ptPhase.mode === "1d" ? " [1D]" : _ptPhase.mode === "2d" ? " [2D]" : "";
      ptPrompt(`Scale${modeTag} end — click  [factor: ${factor.toFixed(3)}]${lockTag}`);
    }

    if (!tool) return;
    if (_pending.length === 0) return;
    const handler = TOOL_HANDLERS[tool];
    // Show rubber band for multi-click tools (clicks≥2) and unlimited tools (clicks=-1).
    if (!handler || (handler.clicks > 0 && handler.clicks < 2)) return;
    updateRubberBand(viewer, handler, snapped);
  });

  vpBody.addEventListener("pointerleave", () => {
    hideCursorDot();
    opSetHover(null);
  });

  // Finalize window / lasso drag selection on mouse-up.
  vpBody.addEventListener("pointerup", (ev) => {
    if (!_selDragging) return;
    _selDragging = false;
    if (_opPhase?.kind === "sel_window") {
      const x1 = Math.min(_opPhase.startX, ev.clientX);
      const y1 = Math.min(_opPhase.startY, ev.clientY);
      const x2 = Math.max(_opPhase.startX, ev.clientX);
      const y2 = Math.max(_opPhase.startY, ev.clientY);
      if (x2 - x1 > 4 || y2 - y1 > 4) {
        runRectSel(viewer, x1, y1, x2, y2, _opPhase.subMode);
        setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
      } else {
        removeSelOverlay();
      }
    } else if (_opPhase?.kind === "sel_lasso" && _opPhase.points.length >= 3) {
      runPolySel(viewer, _opPhase.points, _opPhase.subMode);
      setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
    } else {
      removeSelOverlay();
    }
  });

  // Shift+X/Y/Z = hold-to-constrain axis lock. Release Shift to unlock.
  // Smart snap: if the last snap was an edge snap, Shift uses that edge direction.
  // Also constrains the rotation axis direction during rotate_axis_b.
  window.addEventListener("keydown", (ev) => {
    const _tgt = ev.target as HTMLElement | null;
    if (_tgt && (_tgt.tagName === "INPUT" || _tgt.tagName === "TEXTAREA" || _tgt.isContentEditable)) return;
    if (_ptPhase && _ptPhase.kind !== "start"
        && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey
        && document.activeElement !== _ptCoordInputEl) {
      const key = ev.key.toLowerCase();
      if (key === "x" || key === "y" || key === "z") {
        ev.preventDefault();
        _ptAxisLock = key as "x" | "y" | "z";
        // Cardinal key lock — discard any stale edge direction so ptEffectiveAxisDir
        // returns the cardinal axis, not a previous snap-edge direction.
        _lastSnapEdgeDir = null;
        // For rotate_axis_a we don't have a base point yet — latch the lock so it's
        // immediately applied when the user clicks and transitions to rotate_axis_b.
        const basePt = _ptPhase.kind === "rotate_axis_b" ? _ptPhase.axisA : ptGetAxisBase();
        if (basePt) ptSetAxisLockLine(viewer, basePt);
        return;
      }
    }
    if (ev.key === "Escape") {
      if (_ptPhase) { ptCancel(viewer); return; }
      if (_opPhase) { opCancel(viewer); return; }
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
    if (ev.key === "Enter" || (ev.key === " " && document.activeElement !== _ptCoordInputEl)) {
      if (ev.key === " ") {
        // Spacebar with no active PT/op and no create tool: repeat last PT tool.
        if (!_ptPhase && !_opPhase && !readActiveTool() && _lastPtTool) {
          ev.preventDefault();
          dispatchSync("setActiveTool", { toolId: _lastPtTool });
          return;
        }
        ev.preventDefault();
      }
      if (_opPhase) {
        opHandleEnter(viewer);
        return;
      }
      if (_ptPhase && document.activeElement !== _ptCoordInputEl) {
        ptHandleEnter(viewer);
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

  // Release axis lock when Shift is released.
  window.addEventListener("keyup", (ev) => {
    if (ev.key === "Shift") {
      if (_ptAxisLock && _ptViewer) {
        _ptAxisLock = null;
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

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}
