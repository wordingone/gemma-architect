// Wires the UI: prompt mode (existing) + file-load mode (new).
//
// The prompt-mode flow is unchanged from the v1 release — dropdown, textarea,
// Run button, worker, viewer.setMesh.
// The file-load flow accepts IFC/STEP via the worker (heavy parsing) and
// GLB/GLTF/OBJ/STL on the main thread via three.js JSM loaders.
//
// Export menu is shared: the active source (whether replicad-generated or
// loaded-from-file) is queried via viewer.getActiveMeshData().

import { assertCrossOriginIsolated } from "./agent/wasm-backend";
assertCrossOriginIsolated();

import { initShellChrome, setRibbonMode, setRibbonElementTypes, resetRibbonElementTypes } from "./shell/shell";
import { formatLength, formatArea, formatVolume, unitLabel } from "./units";
import { opAddLabel, opBuildAnnotLine, getOpPhase, getLastOpFinishMs } from "./viewer/op-tool";
import { ptIsCoordInputActive } from "./viewer/transforms";
import { buildWorkbench, rebuildPaletteForMode } from "./shell/workbench";
import { loadDrawingLayers } from "./geometry/drawing-layers";
import { buildModes, activateMode, getLayoutHost } from "./shell/modes";
import { exportLayoutAsSvg, exportLayoutAsPdf, exportLayoutAsDwgFallback, exportLayoutAsDxf, addPanel, getPanels, addLinkedClipPlaneSheet } from "./shell/layout";
import { clippingPlaneStore, type CPlaneBounds } from "./geometry/clipping-planes";
import { initCmdK } from "./ui/cmdk";
import { initExportDrawer, openExportDrawer } from "./io/export-drawer";
import { Viewer } from "./viewer/viewer";
import { ScenePanel, type SceneSummary } from "./scene/scene-panel";
import { applyDrafting, removeDrafting, isDrafting } from "./geometry/drafting";
import { DEMOS, applyParams, type DemoPrompt, type Param } from "./agent/demo-prompts";
import { getLayerForCreator, layerStore } from "./geometry/layers";
import { drawingLayerStore } from "./geometry/drawing-layers";
import { levelStore, getActiveLevelId, loadLevelLocks } from "./geometry/levels";
import { gridStore } from "./geometry/grids";
import { snapPoint, setStep as snapSetStep, getStep as snapGetStep } from "./viewer/snap-state";
import { buildIfc, buildIfcScene, ifcRoundTrip, type IfcSceneElement, type IfcLevel } from "./ifc/ifc";
import {
  detectFormat,
  loadMainThreadFormat,
  buildIfcMesh,
  buildStepMesh,
  WORKER_FORMATS,
  MAIN_THREAD_FORMATS,
  ALL_FORMATS,
  isSupported,
  type LoadedScene,
} from "./io/loader";
import {
  exportObj,
  exportGltfJson,
  exportGlb,
  exportUsdz,
  exportStl,
  export3dm,
  exportSvg,
  exportDxf,
  exportPdf,
} from "./io/exporters";
import { SAMPLES } from "./io/sample-files";
import type { WorkerOut } from "./worker";
import { syncToolActiveClass, getState, setState, syncUnitsToStorage, hydrateFromStorage } from "./app-state";
import { initCreateMode, emitClickWorld, DEFAULT_CEILING_OFFSET, execAlignTool } from "./tools/index";
import { onElementCommitted, cutSlabVoidFromBoxMesh, addVoidToWallObject } from "./tools/join-groups";
import { attemptWallCornerJoins } from "./tools/wall-corners";
import { getSnapTarget } from "./viewer/snap-state";
import { makeLevelSprite, updateLevelSprite, buildWall, buildWallPitchedTop, buildSlab, buildColumn, buildBeam, buildRoof, buildSpace, buildFoundation, buildCeiling, buildCurtainWall, buildSkylight, buildStair, buildBox, buildReferenceLine, rebuildWallParams, rebuildGroupWallHeight, type RoofParams, type CurtainWallParams, type StairParams, DEFAULT_WALL_HEIGHT, DEFAULT_SLAB_THICKNESS } from "./tools/structural";
import { buildRect, buildCircle, buildLine, buildPolyline, buildRamp, buildRailing, buildPoint, buildCurve } from "./tools/sketch";
import { buildDoor, buildWindow, buildOpening } from "./tools/openings";
import { DEFAULT_DOOR_W, DEFAULT_DOOR_H, FZK_DOOR_W, FZK_DOOR_H, FZK_FRONT_DOOR_W, FZK_FRONT_DOOR_H, FZK_TERRACE_DOOR_W, FZK_TERRACE_DOOR_H, FZK_WINDOW_W, FZK_WINDOW_H, FZK_WINDOW_SILL, FZK_OG_WINDOW_W, FZK_OG_WINDOW_H, STAIR_STEP_RISE, STAIR_STEP_DEPTH, STAIR_WIDTH } from "./tools/dimensions";
import { initSectionHandles } from "./viewer/section-handles";
import { initClipPlaneHandles, setActiveClipPlaneEntity } from "./viewer/clip-plane-handles";
import { initWallHeightHandle } from "./viewer/wall-height-handle";
import { replayCloneSideEffects } from "./viewer/copy-array";
import { undo, redo, pushAction, pushTransformAction, pushBatchAction, captureTransform, clearHistory, pushReplaceAction, beginTransaction, endTransaction, pushCustomAction } from "./history";
import { csgUnion, csgDifference, csgIntersection, filletMesh, chamferEdge, getUniqueEdges } from "./viewer/csg";
import { registerHandler, dispatch, dispatchSync, installDefaultHandlers, registerRuntimeAlias, registerPostDispatch } from "./commands/dispatch";
import { sceneStoreSave, sceneStoreLoad, sceneStoreClear } from "./io/scene-store";
import { registerGoalHandlers } from "./agent/goal-handlers";
import { listClusters, getClusterByName, listCanvasClusters, type SkillClusterStep } from "./skills/skill-store";
import { STARTER_LIBRARY } from "./skills/starter-library";
import { resolveCPlane, WORLD_XY, WORLD_XZ, WORLD_YZ, type CPlane } from "./viewer/cplane";
import { clearCommandSession, getActiveCommandSession } from "./commands/command-session";
import { runIteration } from "./chat/chat-panel";
import { Point3 as Prim3, Plane as PrimPlane, type Arc as PrimArc } from "./nurbs/nurbs-primitives";
import { tessellate, createClampedUniformNurbs, type Curve, pointAt as curvePointAt, domain as curveDomain } from "./nurbs/nurbs-curves";
import { nurbsCurveFromArc } from "./nurbs/nurbs-curve-algorithms";
import { tessellateSurface } from "./nurbs/nurbs-surfaces";
import { surfaceOfRevolution, sweepSurface, loftSurfaces } from "./nurbs/nurbs-surface-algorithms";
import { addToMultiSelected, clearMultiSelected, clearSelected, getFilters, getSelected, setSelected, topologyAllowed } from "./viewer/selection-state";
import { initRenderModes, setRenderMode, type RenderMode } from "./viewer/render-modes";
import * as THREE from "three";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

// Mode toggle + panels
const modePromptBtn = $<HTMLButtonElement>("mode-prompt-btn");
const modeFileBtn = $<HTMLButtonElement>("mode-file-btn");
const promptPanel = $<HTMLDivElement>("prompt-mode-panel");
const filePanel = $<HTMLDivElement>("file-mode-panel");

// Prompt mode controls
const promptSelect = $<HTMLSelectElement>("prompt-select");
const promptText = $<HTMLTextAreaElement>("prompt-text");
const jsSource = $<HTMLTextAreaElement>("js-source");
const runBtn = $<HTMLButtonElement>("run-btn");

// File mode controls
const sampleSelect = $<HTMLSelectElement>("sample-select");
const filePickBtn = $<HTMLButtonElement>("file-pick-btn");
const fileInput = $<HTMLInputElement>("file-input");
const fileNameLabel = $<HTMLSpanElement>("file-name");

// Shared UI
const status = $<HTMLDivElement>("status");
const canvas = $<HTMLCanvasElement>("viewer-canvas");
const viewportAreaEl = document.getElementById("viewport-area-host") as HTMLElement;
const paramPanel = $<HTMLDivElement>("param-panel");
const paramSliders = $<HTMLDivElement>("param-sliders");
const paramCollapseBtn = $<HTMLButtonElement>("param-collapse-btn");
const dropOverlay = $<HTMLDivElement>("drop-overlay");
const scenePanelEl = $<HTMLElement>("scene-panel");

// Export buttons (data-fmt attribute on each)
const exportButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".exp-btn"),
);

paramCollapseBtn.addEventListener("click", () => {
  paramPanel.classList.toggle("collapsed");
  const collapsed = paramPanel.classList.contains("collapsed");
  paramCollapseBtn.setAttribute(
    "aria-label",
    collapsed ? "Expand parameters panel" : "Collapse parameters panel",
  );
});

const viewer = new Viewer(canvas, viewportAreaEl);
// Keep level plane labels in sync when level names are edited via the sidebar.
// Also update the working plane Z so the grid tracks the active level's elevation.
levelStore.subscribe(() => {
  viewer.forEachSceneChild((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.userData.creator !== "IfcLevel") return;
    const level = levelStore.get(mesh.userData.levelId as string);
    if (!level) return;
    const sprite = mesh.children.find((c) => c.userData.isLevelLabel) as THREE.Sprite | undefined;
    if (sprite) updateLevelSprite(sprite, level.name);
  });
  const active = levelStore.getActive();
  if (active) viewer.setWorkingPlaneZ(active.elevation);
  syncLevelOpacities();
});
// Expose for in-browser debug + DevTools poking — read-only handle to scene state.
(window as unknown as { __viewer: Viewer }).__viewer = viewer;
// Expose async dispatch for CDP-driven verification scripts.
// __dispatch is the async variant so async handlers (SdInvokeSkill) resolve correctly.
// __dispatchSync is the legacy sync alias for callers that cannot await.
(window as unknown as { __dispatch: typeof dispatch }).__dispatch = dispatch;
(window as unknown as { __dispatchSync: typeof dispatchSync }).__dispatchSync = dispatchSync;
(window as unknown as { __dispatchAsync: typeof dispatch }).__dispatchAsync = dispatch;
// Expose command-session control for test teardown (prevents picker-bridge session leak).
(window as unknown as { __clearCommandSession: typeof clearCommandSession }).__clearCommandSession = clearCommandSession;
(window as unknown as { __getActiveCommandSession: typeof getActiveCommandSession }).__getActiveCommandSession = getActiveCommandSession;
// Expose gridStore for CDP probes.
(window as unknown as { __gridStore: typeof gridStore }).__gridStore = gridStore;
(window as unknown as { __levelStore: typeof levelStore }).__levelStore = levelStore;
// Expose resolveCPlane for surface 31 CDP verification (W-1 #357).
(window as unknown as { __resolveCPlane: typeof resolveCPlane }).__resolveCPlane = resolveCPlane;
// Expose activeCPlane accessor for surface 39 CDP verification (W-4 #360).
(window as unknown as { __getActiveCPlane: () => CPlane }).__getActiveCPlane = () => viewer.activeCPlane;
(window as unknown as { __emitClickWorld: (w: Parameters<typeof emitClickWorld>[1], opts?: Parameters<typeof emitClickWorld>[2]) => ReturnType<typeof emitClickWorld> }).__emitClickWorld = (w, opts) => emitClickWorld(viewer, w, opts);
(window as unknown as { __runIteration: typeof runIteration }).__runIteration = runIteration;
// Backwards-compat shim for gemma-verify scripts until PR-C updates them (#980).
(window as unknown as { __runDesignLoop: (prompt: string) => ReturnType<typeof runIteration> }).__runDesignLoop = (prompt: string) => runIteration(null, null, prompt, []);
// Expose snap test hooks for CDP verification (#374, #327).
(window as unknown as { __snapPoint: typeof snapPoint }).__snapPoint = snapPoint;
(window as unknown as { __snapSetStep: typeof snapSetStep }).__snapSetStep = snapSetStep;
(window as unknown as { __snapGetStep: typeof snapGetStep }).__snapGetStep = snapGetStep;
(window as unknown as { __getSnapTarget: typeof getSnapTarget }).__getSnapTarget = getSnapTarget;
(window as unknown as { __projectToScreen: (x: number, y: number, z?: number) => { x: number; y: number } | null })
  .__projectToScreen = (x, y, z = 0) => {
    const canvas = viewer.getCanvas();
    const rect = canvas.getBoundingClientRect();
    const camera = viewer.getCamera();
    const v = new THREE.Vector3(x, y, z).project(camera as THREE.PerspectiveCamera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * rect.width + rect.left, y: (-v.y * 0.5 + 0.5) * rect.height + rect.top };
  };
// Expose parity notification hook for CDP loop orchestrators and gemma-verify (#321).
(window as unknown as { __notifyParityChanged: (detail: unknown) => void })
  .__notifyParityChanged = (detail) => {
    document.dispatchEvent(new CustomEvent("viewer:parity-changed", { detail }));
  };
(window as unknown as { __setSelected: typeof setSelected }).__setSelected = setSelected;
initRenderModes(viewer);
// Goal meta-tools (#980)
registerGoalHandlers();

// SdDelete: delete the currently selected object via the viewer's deleteSelected() method.
registerHandler("SdDelete", () => {
  const deleted = viewer.deleteSelected();
  if (deleted) document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  return { deleted };
});
syncToolActiveClass();
syncUnitsToStorage();
initCreateMode(viewer);
initSectionHandles(viewer, viewportAreaEl);
initClipPlaneHandles(viewer, viewportAreaEl);
initWallHeightHandle(viewer, viewportAreaEl);

// Undo/Redo handlers (#55): route SdUndo and SdRedo to the history module.
registerHandler("SdUndo", () => { undo(viewer); });
registerHandler("SdRedo", () => { redo(viewer); });

registerHandler("SdRenderMode", (args) => {
  const mode = (args.mode as string | undefined) ?? "shaded";
  setRenderMode(mode as RenderMode);
  return { mode };
});

const ORTHO_VIEWS = ["top", "bottom", "front", "back", "left", "right", "iso"] as const;
type OrthoView = typeof ORTHO_VIEWS[number];

registerHandler("SdSetViewOrtho", (args) => {
  const raw = (args.view as string | undefined) ?? "top";
  const view: OrthoView = (ORTHO_VIEWS as readonly string[]).includes(raw) ? raw as OrthoView : "top";
  viewer.setView(view);
  setState("currentView", view);
  return { ok: true, view };
});

registerHandler("SdSetViewPerspective", () => {
  viewer.frameAllVisible();
  setState("currentView", "perspective");
  return { ok: true, view: "perspective" };
});

registerHandler("SdListObjects", () => {
  const scene = viewer.getScene();
  const objects: Array<{ name: string; uuid: string; kind: string; layer?: string; ifcClass?: string; verb?: string }> = [];
  const ifcClassCounts: Record<string, number> = {};
  scene.traverse((obj) => {
    const ud = obj.userData as Record<string, unknown>;
    // SDK-created objects carry ud.kind; IFC-loaded elements carry ud.expressID + ud.ifcClass.
    const isIfc = ud.expressID != null && ud.ifcClass;
    if (!ud.kind && !isIfc) return;
    if (isIfc) {
      const cls = String(ud.ifcClass);
      ifcClassCounts[cls] = (ifcClassCounts[cls] ?? 0) + 1;
      return; // aggregate IFC elements; don't push individual meshes (can be 250+)
    }
    objects.push({
      name: obj.name || obj.uuid.slice(0, 8),
      uuid: obj.uuid,
      kind: String(ud.kind ?? ""),
      ...(ud.layer ? { layer: String(ud.layer) } : {}),
      ...(ud.ifcClass ? { ifcClass: String(ud.ifcClass) } : {}),
      ...(ud.dispatchVerb ? { verb: String(ud.dispatchVerb) } : {}),
    });
  });
  // Append IFC class summary as aggregate entries.
  for (const [cls, count] of Object.entries(ifcClassCounts).sort((a, b) => b[1] - a[1])) {
    objects.push({ name: `${count}× ${cls}`, uuid: cls, kind: "ifc", ifcClass: cls });
  }
  return { count: objects.length, objects };
});

registerHandler("SdZoomExtents", () => {
  viewer.frameAllVisible();
  return { ok: true };
});

registerHandler("SdZoomSelected", () => {
  viewer.frameAllVisible();
  return { ok: true };
});

registerHandler("SdSectionBox", (args) => {
  const min = args.min as [number, number, number];
  const max = args.max as [number, number, number];
  const enabled = (args.enabled ?? true) as boolean;
  if (!Array.isArray(min) || min.length < 3 || !Array.isArray(max) || max.length < 3)
    return { error: "min and max must be [x,y,z] arrays" };
  viewer.setSectionBox(min, max, enabled);
  document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  return { ok: true, min, max, enabled };
});

registerHandler("SdSectionBoxOff", () => {
  const prev = viewer.getSectionBox();
  viewer.clearSectionBox();
  document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  if (prev) {
    const { min, max } = prev;
    pushCustomAction(
      () => { viewer.setSectionBox(min, max); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
      () => { viewer.clearSectionBox(); document.dispatchEvent(new CustomEvent("viewer:clip-changed")); },
    );
  }
  return { ok: true };
});

registerHandler("SdIsolate", (args) => {
  const uuid = args.uuid as string;
  if (!uuid) return { error: "uuid required" };
  const ok = viewer.isolate(uuid);
  document.dispatchEvent(new CustomEvent("viewer:isolate-changed", { detail: { uuid: ok ? uuid : null } }));
  return ok ? { ok: true, uuid } : { error: "object not found", uuid };
});

registerHandler("SdIsolateOff", () => {
  viewer.isolateOff();
  document.dispatchEvent(new CustomEvent("viewer:isolate-changed", { detail: { uuid: null } }));
  return { ok: true };
});

registerHandler("SdFitToObject", (args) => {
  const uuid = args.uuid as string;
  if (!uuid) return { error: "uuid required" };
  const obj = viewer.getScene().getObjectByProperty("uuid", uuid);
  if (!obj) return { error: "object not found", uuid };
  viewer.frameObjectOnly(obj);
  return { ok: true, uuid };
});

registerHandler("SdClippingPlane", (args) => {
  const origin = args.origin as [number, number, number];
  const normal = args.normal as [number, number, number];
  const label = (args.label as string | undefined) ?? `clip-${Date.now()}`;
  const autoSheet = args.autoSheet !== false; // default true
  const boundsArg = args.bounds as Partial<CPlaneBounds> | undefined;
  if (!Array.isArray(origin) || origin.length < 3 || !Array.isArray(normal) || normal.length < 3)
    return { error: "origin and normal must be [x,y,z] arrays" };
  viewer.addClippingPlane(origin, normal, label);
  document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  const entity = clippingPlaneStore.add(origin, normal, label, boundsArg);
  setActiveClipPlaneEntity(entity.id);
  let sheetId: string | undefined;
  if (autoSheet) {
    const layoutHost = getLayoutHost();
    if (layoutHost) {
      sheetId = addLinkedClipPlaneSheet(layoutHost, entity.id, `Section — ${label}`);
    }
  }
  return { ok: true, origin, normal, label, clipPlaneId: entity.id, sheetId };
});

registerHandler("SdClippingPlanesClear", () => {
  viewer.clearClippingPlanes();
  document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  return { ok: true };
});

registerHandler("SdClippingPlaneRemove", (args) => {
  const label = args.label as string;
  if (!label) return { error: "label required" };
  const removed = viewer.removeClippingPlane(label);
  document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  return { ok: removed, label };
});

registerHandler("SdExport", (args) => {
  const fmt = args.format as string | undefined;
  if (!fmt) return { error: "format required (ifc|ifc4|glb|gltf|obj|stl|3dm|dwg|step|svg|dxf|pdf|usdz)" };
  // Skip real download in test mode to prevent file pollution in Downloads.
  if ((window as unknown as { __testMode?: boolean }).__testMode) return { ok: true, format: fmt, testMode: true };
  handleExport(fmt).catch((e) => {
    console.warn("[SdExport]", e);
    setStatus(`Export failed: ${String((e as Error)?.message ?? e)}`, "warn");
  });
  return { ok: true, format: fmt };
});

registerHandler("SdMove", (args) => {
  const sel = getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (!sel) return { moved: false, reason: "no selection" };
  const before = captureTransform(sel);
  const x = (args.x as number | undefined)
    ?? (Array.isArray(args.delta) ? (args.delta as number[])[0] : undefined)
    ?? (Array.isArray(args.vector) ? (args.vector as number[])[0] : undefined)
    ?? 0;
  const y = (args.y as number | undefined)
    ?? (Array.isArray(args.delta) ? (args.delta as number[])[1] : undefined)
    ?? (Array.isArray(args.vector) ? (args.vector as number[])[1] : undefined)
    ?? 0;
  const z = (args.z as number | undefined)
    ?? (Array.isArray(args.delta) ? (args.delta as number[])[2] : undefined)
    ?? (Array.isArray(args.vector) ? (args.vector as number[])[2] : undefined)
    ?? 0;
  sel.position.x += x;
  sel.position.y += y;
  sel.position.z += z;
  sel.updateMatrix();
  sel.updateMatrixWorld(true);
  pushTransformAction(sel, before);
  return { moved: true, delta: [x, y, z] };
});

registerHandler("SdScale", (args) => {
  const sel = getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (!sel) return { scaled: false, reason: "no selection" };
  const before = captureTransform(sel);
  const f = (args.factor as number | undefined) ?? 1;
  // axis: null/"" = uniform 3D; "x"/"y"/"z" = 1D axis-locked; "xy"/"xz"/"yz" = 2D plane-locked (#821).
  const axis = (args.axis as string | undefined) ?? null;
  if (!axis) {
    sel.scale.multiplyScalar(f);
  } else {
    const ax = axis.toLowerCase();
    if (ax.includes("x")) sel.scale.x *= f;
    if (ax.includes("y")) sel.scale.y *= f;
    if (ax.includes("z")) sel.scale.z *= f;
  }
  sel.updateMatrix();
  sel.updateMatrixWorld(true);
  pushTransformAction(sel, before);
  return { scaled: true, factor: f, axis: axis ?? "uniform" };
});

registerHandler("SdRotate", (args) => {
  const sel = getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (!sel) return { rotated: false, reason: "no selection" };
  const before = captureTransform(sel);
  const deg = (args.angle as number | undefined) ?? 0;
  const axis = (args.axis as number[] | undefined) ?? [0, 0, 1];
  const q = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 1).normalize(),
    (deg * Math.PI) / 180,
  );
  sel.quaternion.premultiply(q);
  sel.updateMatrix();
  sel.updateMatrixWorld(true);
  pushTransformAction(sel, before);
  return { rotated: true, angle: deg, axis };
});

registerHandler("SdCopy", (args) => {
  const byTarget = (args.target as string | undefined)
    ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
    : null;
  const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (!sel) return { copied: false, reason: "no selection" };
  const x = (args.x as number | undefined)
    ?? (Array.isArray(args.vector) ? (args.vector as number[])[0] : undefined) ?? 0;
  const y = (args.y as number | undefined)
    ?? (Array.isArray(args.vector) ? (args.vector as number[])[1] : undefined) ?? 0;
  const z = (args.z as number | undefined)
    ?? (Array.isArray(args.vector) ? (args.vector as number[])[2] : undefined) ?? 0;
  const clone = sel.clone();
  clone.position.x += x; clone.position.y += y; clone.position.z += z;
  clone.userData = { ...sel.userData };
  viewer.addMesh(clone as THREE.Mesh, "brep");
  replayCloneSideEffects(clone, viewer.getScene());
  return { created: clone.uuid, delta: [x, y, z] };
});

registerHandler("SdArrayLinear", (args) => {
  const byTarget = (args.target as string | undefined)
    ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
    : null;
  const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (!sel) return { created: false, reason: "no selection" };
  const count = Math.max(1, Math.round((args.count as number | undefined) ?? 3));
  const dx = (args.dx as number | undefined) ?? 1;
  const dy = (args.dy as number | undefined) ?? 0;
  const dz = (args.dz as number | undefined) ?? 0;
  const ids: string[] = [];
  for (let i = 1; i < count; i++) {
    const clone = sel.clone();
    clone.position.x += dx * i; clone.position.y += dy * i; clone.position.z += dz * i;
    clone.userData = { ...sel.userData };
    viewer.addMesh(clone as THREE.Mesh, "brep");
    replayCloneSideEffects(clone, viewer.getScene());
    ids.push(clone.uuid);
  }
  return { created: ids.length, ids };
});

registerHandler("SdArrayGrid", (args) => {
  const byTarget = (args.target as string | undefined)
    ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
    : null;
  const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (!sel) return { created: false, reason: "no selection" };
  const rows = Math.max(1, Math.round((args.rows as number | undefined) ?? 3));
  const cols = Math.max(1, Math.round((args.cols as number | undefined) ?? 3));
  const dx = (args.dx as number | undefined) ?? 1;
  const dy = (args.dy as number | undefined) ?? 1;
  const ids: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      const clone = sel.clone();
      clone.position.x += dx * c; clone.position.y += dy * r;
      clone.userData = { ...sel.userData };
      viewer.addMesh(clone as THREE.Mesh, "brep");
      replayCloneSideEffects(clone, viewer.getScene());
      ids.push(clone.uuid);
    }
  }
  return { created: ids.length, rows, cols };
});

registerHandler("SdArrayPolar", (args) => {
  const byTarget = (args.target as string | undefined)
    ? (viewer.getScene().getObjectByProperty("uuid", args.target as string) ?? null)
    : null;
  const sel = byTarget ?? getSelected()?.transformTarget ?? viewer.getActiveObject();
  if (!sel) return { created: false, reason: "no selection" };
  const count = Math.max(2, Math.round((args.count as number | undefined) ?? 6));
  const cx = (args.cx as number | undefined) ?? 0;
  const cy = (args.cy as number | undefined) ?? 0;
  const totalAngle = ((args.angle as number | undefined) ?? 360) * Math.PI / 180;
  const ox = sel.position.x - cx;
  const oy = sel.position.y - cy;
  const ids: string[] = [];
  for (let i = 1; i < count; i++) {
    const a = (totalAngle / count) * i;
    const clone = sel.clone();
    clone.position.x = cx + ox * Math.cos(a) - oy * Math.sin(a);
    clone.position.y = cy + ox * Math.sin(a) + oy * Math.cos(a);
    clone.userData = { ...sel.userData };
    viewer.addMesh(clone as THREE.Mesh, "brep");
    replayCloneSideEffects(clone, viewer.getScene());
    ids.push(clone.uuid);
  }
  return { created: ids.length, count };
});

registerHandler("SdAlignObjects", (args) => {
  const mode = (args.mode as string | undefined) ?? "left";
  execAlignTool(mode);
  return { ok: true, mode };
});

// Select-all handler (#31): populates the multi-set with every selectable
// scene object that passes the current filters. Gumball anchors at the
// centroid of the bounding union.
registerHandler("SdSelectAll", () => {
  clearMultiSelected();
  const filters = getFilters();
  const selectable: THREE.Object3D[] = [];
  viewer.getScene().traverse((obj) => {
    const kind = obj.userData.kind as string | undefined;
    if (!kind) return;
    const topo = (kind === "brep" || kind === "compound") ? kind as "brep" | "compound"
               : (kind === "mesh") ? "mesh" as const
               : null;
    if (!topo || !topologyAllowed(topo, filters)) return;
    selectable.push(obj);
  });
  if (selectable.length === 0) return;
  // Compute centroid to anchor gumball.
  const centroid = new THREE.Vector3();
  selectable.forEach((o) => centroid.add(o.getWorldPosition(new THREE.Vector3())));
  centroid.divideScalar(selectable.length);
  // Add all to multi-set so INSPECT + subscriptions see them.
  selectable.forEach((o) => {
    addToMultiSelected({
      topology: (o.userData.kind as "mesh" | "brep" | "compound") ?? "mesh",
      uuid: o.uuid,
      object: o,
      transformTarget: o,
    });
  });
  // Anchor gumball at centroid via a transient proxy.
  const proxy = new THREE.Object3D();
  proxy.position.copy(centroid);
  proxy.userData.kind = "_selectAll_proxy";
  viewer.getScene().add(proxy); // audit-undo-ok — transient gumball anchor, not user content
  viewer.selectObject(proxy);
  window.dispatchEvent(new CustomEvent("viewer:selectAll", { detail: { count: selectable.length } }));
});

registerHandler("SdBoolean", (args) => {
  const opArg = (args.op as string | undefined) ?? "union";
  const aId = args.a as string | undefined;
  const bId = args.b as string | undefined;
  if (!aId || !bId) return { error: "SdBoolean requires a and b object_ids" };
  const scene = viewer.getScene();
  const objA = scene.getObjectByProperty("uuid", aId);
  const objB = scene.getObjectByProperty("uuid", bId);
  if (!objA || !objB) return { error: `SdBoolean — object not found: ${!objA ? aId : bId}` };
  if (!(objA instanceof THREE.Mesh) || !(objB instanceof THREE.Mesh))
    return { error: "SdBoolean — both targets must be solid meshes" };
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  let result: THREE.Mesh;
  try {
    if (opArg === "difference") result = csgDifference(objA, objB, mat);
    else if (opArg === "intersection") result = csgIntersection(objA, objB, mat);
    else result = csgUnion(objA, objB, mat);
  } catch {
    return { error: "SdBoolean — CSG failed (geometry may be non-manifold)" };
  }
  if (!result.geometry.getAttribute("position") || result.geometry.getAttribute("position").count === 0)
    return { error: "SdBoolean — result is empty (objects may not overlap)" };
  const creator = opArg === "difference" ? "boolean-difference" : opArg === "intersection" ? "boolean-intersection" : "boolean-union";
  result.userData.kind = "brep";
  result.userData.creator = creator;
  result.userData.dispatchArgs = args;
  scene.remove(objA); // audit-undo-ok — paired with pushReplaceAction below
  scene.remove(objB); // audit-undo-ok — paired with pushReplaceAction below
  viewer.addMesh(result, "brep", { noHistory: true });
  pushReplaceAction(result, [objA, objB], creator);
  return { created: result.uuid, op: opArg };
});

// Per-variant boolean handlers — delegate to SdBoolean with fixed op.
// SdBooleanDifference maps outer/inner → a/b for SdBoolean compatibility.
registerHandler("SdBooleanUnion", (args) => {
  const dr = dispatchSync("SdBoolean", { op: "union", a: args.a, b: args.b });
  return dr.ok ? (dr as { ok: true; result: unknown }).result : { error: "Boolean union failed" };
});
registerHandler("SdBooleanDifference", (args) => {
  const dr = dispatchSync("SdBoolean", { op: "difference", a: args.outer ?? args.a, b: args.inner ?? args.b });
  return dr.ok ? (dr as { ok: true; result: unknown }).result : { error: "Boolean difference failed" };
});
registerHandler("SdBooleanIntersection", (args) => {
  const dr = dispatchSync("SdBoolean", { op: "intersection", a: args.a, b: args.b });
  return dr.ok ? (dr as { ok: true; result: unknown }).result : { error: "Boolean intersection failed" };
});

registerHandler("SdFillet", (args) => {
  const targetId = args.target as string | undefined;
  if (!targetId) return { error: "SdFillet — target is required" };
  const radius = args.radius as number | undefined;
  if (radius === undefined || radius === null) return { error: "SdFillet — radius is required" };
  if (!Number.isFinite(radius) || radius <= 0) return { error: `SdFillet — radius must be a positive number, got: ${radius}` };
  const scene = viewer.getScene();
  const obj = scene.getObjectByProperty("uuid", targetId);
  if (!obj) return { error: `SdFillet — target not found: ${targetId}` };
  if (!(obj instanceof THREE.Mesh)) return { error: `SdFillet — target is not a Mesh` };
  const edgeId = args.edgeId as number | undefined;
  let filleted: THREE.Mesh;
  if (edgeId !== undefined && edgeId !== null) {
    const edges = getUniqueEdges(obj);
    if (edgeId < 0 || edgeId >= edges.length) {
      return { error: `SdFillet — edgeId ${edgeId} out of range [0, ${edges.length - 1}]` };
    }
    const [localA, localB] = edges[edgeId];
    const worldA = localA.clone().applyMatrix4(obj.matrixWorld);
    const worldB = localB.clone().applyMatrix4(obj.matrixWorld);
    filleted = chamferEdge(obj, worldA, worldB, radius);
    if (filleted.userData._chamferError) {
      return { error: `SdFillet — ${filleted.userData._chamferError as string}` };
    }
  } else {
    filleted = filletMesh(obj, radius);
    if (filleted.userData._chamferError) {
      return { error: `SdFillet — ${filleted.userData._chamferError as string}` };
    }
  }
  viewer.getScene().remove(obj); // audit-undo-ok: tracked by pushReplaceAction below
  viewer.addMesh(filleted, "brep", { noHistory: true });
  pushReplaceAction(filleted, [obj], "fillet");
  return { modified: filleted.uuid, edgeCount: edgeId !== undefined ? 1 : "all" };
});

registerHandler("SdSelect", (args) => {
  const id = args.id as string | undefined;
  if (!id) return { error: "SdSelect requires id" };
  const obj = viewer.getScene().getObjectByProperty("uuid", id);
  if (!obj) return { error: `SdSelect — object not found: ${id}` };
  clearMultiSelected();
  viewer.selectObject(obj);
  const topo = (obj.userData.kind as "mesh" | "brep" | "compound") ?? "mesh";
  setSelected({ topology: topo, uuid: obj.uuid, object: obj, transformTarget: obj });
  window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: obj.uuid } }));
  return { selected: obj.uuid };
});

registerHandler("SdSelectByQuery", (args) => {
  const creatorQ = args.creator as string | undefined;
  const layerQ = args.layerId as string | undefined;
  const levelQ = args.levelId as string | undefined;
  const matches: THREE.Object3D[] = [];
  viewer.getScene().traverse((obj) => {
    if (!obj.userData.kind) return;
    if (creatorQ && obj.userData.creator !== creatorQ) return;
    if (layerQ && obj.userData.layerId !== layerQ) return;
    if (levelQ && obj.userData.levelId !== levelQ) return;
    matches.push(obj);
  });
  if (matches.length === 0) return { selected: [], count: 0 };
  clearMultiSelected();
  const centroid = new THREE.Vector3();
  matches.forEach((o) => centroid.add(o.getWorldPosition(new THREE.Vector3())));
  centroid.divideScalar(matches.length);
  matches.forEach((o) => addToMultiSelected({
    topology: (o.userData.kind as "mesh" | "brep" | "compound") ?? "mesh",
    uuid: o.uuid, object: o, transformTarget: o,
  }));
  const proxy = new THREE.Object3D();
  proxy.position.copy(centroid);
  proxy.userData.kind = "_selectQuery_proxy";
  viewer.getScene().add(proxy); // audit-undo-ok — transient gumball anchor, not user content
  viewer.selectObject(proxy);
  window.dispatchEvent(new CustomEvent("viewer:selectAll", { detail: { count: matches.length } }));
  return { selected: matches.map((o) => o.uuid), count: matches.length };
});

// Geometry-creation handlers for agent dispatches from the CREATE tab.
// These override the generic gemma:command shim with actual THREE.js mesh creation.

registerHandler("SdBox", (args) => {
  const w = (args.width as number | undefined) ?? (args.size as number | undefined) ?? 1;
  const d = (args.depth as number | undefined) ?? (args.length as number | undefined) ?? 1;
  const h = (args.height as number | undefined) ?? 1;
  const cplane = resolveCPlane("SdBox", args as Record<string, unknown>, viewer);
  // Synthesize 3-corner form expected by buildBox: c1/c2 = footprint corners, c3 = height point.
  const c1 = { x: -w / 2, y: -d / 2 };
  const c2 = { x: w / 2, y: d / 2 };
  const c3 = { x: h, y: 0 }; // distance from footprint center (0,0) = h
  const { mesh, chain } = buildBox(c1, c2, c3);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdBox", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.creator = "box";
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh as THREE.Mesh, viewer.getScene());
  return { created: "box", width: w, depth: d, height: h };
});

registerHandler("SdSphere", (args) => {
  const r = (args.radius as number | undefined) ?? 1;
  const cplane = resolveCPlane("SdSphere", args as Record<string, unknown>, viewer);
  const geom = new THREE.SphereGeometry(r, 32, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.4, metalness: 0.0 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(cplane.normal.clone().multiplyScalar(r));
  mesh.userData.kind = "brep";
  mesh.userData.creator = "sphere";
  mesh.userData.cplaneKind = cplane.kind;
  viewer.addMesh(mesh, "brep");
  return { created: "sphere", radius: r };
});

registerHandler("SdCylinder", (args) => {
  const r = (args.radius as number | undefined) ?? 0.5;
  const h = (args.height as number | undefined) ?? 2;
  const cplane = resolveCPlane("SdCylinder", args as Record<string, unknown>, viewer);
  const geom = new THREE.CylinderGeometry(r, r, h, 32);
  geom.rotateX(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
  mesh.position.copy(cplane.normal.clone().multiplyScalar(h / 2));
  mesh.userData.kind = "brep";
  mesh.userData.creator = "cylinder";
  mesh.userData.cplaneKind = cplane.kind;
  viewer.addMesh(mesh, "brep");
  return { created: "cylinder", radius: r, height: h };
});

registerHandler("SdCone", (args) => {
  const r = ((args.radius ?? args.radius1) as number | undefined) ?? 0.5;
  const h = (args.height as number | undefined) ?? 2;
  const cplane = resolveCPlane("SdCone", args as Record<string, unknown>, viewer);
  const geom = new THREE.ConeGeometry(r, h, 32);
  geom.rotateX(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
  mesh.position.copy(cplane.normal.clone().multiplyScalar(h / 2));
  mesh.userData.kind = "brep";
  mesh.userData.creator = "cone";
  mesh.userData.cplaneKind = cplane.kind;
  viewer.addMesh(mesh, "brep");
  return { created: "cone", radius: r, height: h };
});

// SdExtrude — extrude a closed 2D profile along a direction vector.
// profile: list of [x,y] points (closed polyline). Defaults to 1×1 unit square.
// object_id: UUID of an existing Line/curve scene object — extracts its XY points as profile.
// distance: extrude depth in metres.
// direction: extrude axis (default [0,0,1] = vertical).
registerHandler("SdExtrude", (args) => {
  const distance = (args.distance as number | undefined) ?? (args.height as number | undefined) ?? 1;
  const rawProfile = args.profile as [number, number][] | undefined;
  const objectId = args.object_id as string | undefined;
  const dirRaw = args.direction as [number, number, number] | undefined;

  // If object_id provided: extract XY profile from the scene object's geometry (#821).
  let resolvedProfile: [number, number][] | undefined;
  if (objectId) {
    const srcObj = viewer.getScene().getObjectByProperty("uuid", objectId)
      ?? viewer.getScene().getObjectByProperty("name", objectId);
    if (srcObj) {
      srcObj.updateMatrixWorld(true);
      const posAttr = (srcObj as THREE.Line | THREE.Mesh).geometry?.attributes?.position;
      if (posAttr) {
        const tmp = new THREE.Vector3();
        const extracted: [number, number][] = [];
        for (let i = 0; i < posAttr.count; i++) {
          tmp.fromBufferAttribute(posAttr, i);
          tmp.applyMatrix4(srcObj.matrixWorld);
          extracted.push([tmp.x, tmp.y]);
        }
        if (extracted.length >= 3) resolvedProfile = extracted;
      }
    }
  }

  // Build THREE.Shape from profile points
  const pts: [number, number][] | null = resolvedProfile
    ?? (Array.isArray(rawProfile) && rawProfile.length >= 3 ? (rawProfile as [number, number][]) : null);
  if (!pts) return { error: "SdExtrude — provide object_id referencing a sketch profile, or a profile array of [x,y] pairs (min 3 points); no profile resolved" };
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();

  const geom = new THREE.ExtrudeGeometry(shape, { depth: distance, bevelEnabled: false });
  const mat = new THREE.MeshStandardMaterial({ color: 0xb8c4d4, roughness: 0.5, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);

  // Orient if direction differs from default Z-up
  if (dirRaw && !(dirRaw[0] === 0 && dirRaw[1] === 0 && dirRaw[2] === 1)) {
    const dir = new THREE.Vector3(...dirRaw).normalize();
    const up = new THREE.Vector3(0, 0, 1);
    mesh.quaternion.setFromUnitVectors(up, dir);
  }

  // Agent superset of buildExtrude: supports arbitrary profiles + direction vectors.
  // Align creator + chain format to palette builder output for KG consistency.
  const cplane = resolveCPlane("SdExtrude", args as Record<string, unknown>, viewer);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const bx = r3(pts[0][0]), by = r3(pts[0][1]), bd = r3(distance);
  const chain = `const ext = drawRectangle(1, 1).sketchOnPlane("XY").extrude(${bd}).translate([${bx}, ${by}, 0]);`;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "extrude";
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdExtrude", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  return { created: "extrude", profile_points: pts.length, distance };
});

function resolveLayerId(creator: string, args: Record<string, unknown>): string {
  const explicit = args.layer as string | undefined;
  if (explicit && layerStore.get(explicit)) return explicit;
  return getLayerForCreator(creator);
}

function getActiveLevelElevation(): number {
  return levelStore.get(getActiveLevelId())?.elevation ?? 0;
}

registerHandler("SdWall", (args) => {
  const cplane = resolveCPlane("SdWall", args as Record<string, unknown>, viewer);
  const startArg = args.start as { x?: number; y?: number } | undefined;
  const endArg = args.end as { x?: number; y?: number } | undefined;
  const rawProfile = args.profile as [number, number][] | undefined;
  const wallLen = (args.length as number | undefined) ?? 4;
  let a: { x: number; y: number }, b: { x: number; y: number };
  if (rawProfile && rawProfile.length >= 2) {
    a = { x: rawProfile[0][0], y: rawProfile[0][1] };
    b = { x: rawProfile[rawProfile.length - 1][0], y: rawProfile[rawProfile.length - 1][1] };
  } else if (startArg && endArg) {
    a = { x: startArg.x ?? 0, y: startArg.y ?? 0 };
    b = { x: endArg.x ?? wallLen, y: endArg.y ?? 0 };
  } else {
    a = { x: 0, y: 0 };
    b = { x: wallLen, y: 0 };
  }
  // §#1555: reject degenerate walls below minimum span (corner-filler zero-length bug).
  const dxCheck = b.x - a.x, dyCheck = b.y - a.y;
  const wallLenCheck = Math.sqrt(dxCheck * dxCheck + dyCheck * dyCheck);
  if (wallLenCheck < 0.5) throw new Error(`degenerate-wall: p1=${JSON.stringify([a.x,a.y])} p2=${JSON.stringify([b.x,b.y])} dist=${wallLenCheck.toFixed(3)} — endpoints must differ by ≥0.5m; for attached structures offset the new footprint from the shared wall face`);
  const topProfile = (args.topProfile as string | undefined) ?? "level";
  const eaveH = (args.eaveHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;
  const ridgeH = (args.ridgeHeight as number | undefined) ?? 1.5;
  const explicitH = (args.height as number | undefined);
  // §#1569/#1558: clamp suspiciously-small explicit height to GARDEN_WALL_MIN_H (1.2m).
  // 0.3m signals a ft→m unit bleed (1ft ≈ 0.30m) — most common in boundary/garden wall context.
  // Clamp silently so the scene gets a sensible outdoor wall without a chat error stopping the build.
  const GARDEN_WALL_MIN_H = 1.2;
  const _clampedExplicitH = (explicitH !== undefined && explicitH < GARDEN_WALL_MIN_H)
    ? GARDEN_WALL_MIN_H : explicitH;
  const activeLvl = levelStore.getActive();
  const allLevels = levelStore.all().sort((x, y) => x.elevation - y.elevation);
  const nextLvl = allLevels.find(l => l.elevation > activeLvl.elevation + 0.01);
  const MIN_WALL_HEIGHT = 0.5;
  const baseH = _clampedExplicitH ?? DEFAULT_WALL_HEIGHT;
  const effectiveH = Math.max(
    MIN_WALL_HEIGHT,
    nextLvl
      ? Math.min(baseH, nextLvl.elevation - activeLvl.elevation - DEFAULT_SLAB_THICKNESS)
      : baseH,
  );
  const { mesh, chain } = topProfile === "pitched"
    ? buildWallPitchedTop(a, b, eaveH, ridgeH)
    : buildWall(a, b, effectiveH);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdWall", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.creator = "wall";
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  if (topProfile !== "pitched") attemptWallCornerJoins(mesh, viewer.getScene());
  onElementCommitted(mesh, viewer.getScene());
  const dx = b.x - a.x, dy = b.y - a.y;
  return { created: "wall", length: Math.sqrt(dx * dx + dy * dy) || wallLen };
});

registerHandler("SdSlab", (args) => {
  const cplane = resolveCPlane("SdSlab", args as Record<string, unknown>, viewer);
  const w = (args.width as number | undefined) ?? (args.length as number | undefined) ?? 4;
  const d = (args.depth as number | undefined) ?? (args.width as number | undefined) ?? 4;
  const elev = (args.elevation as number | undefined) ?? getActiveLevelElevation();
  let a = { x: -w / 2, y: -d / 2 };
  let b = { x: w / 2, y: d / 2 };
  const slabProf = args.profile as number[][] | undefined;
  if (slabProf && slabProf.length >= 2) {
    const xs = slabProf.map((p) => p[0]);
    const ys = slabProf.map((p) => p[1]);
    a = { x: Math.min(...xs), y: Math.min(...ys) };
    b = { x: Math.max(...xs), y: Math.max(...ys) };
  }
  const t = (args.thickness as number | undefined) ?? DEFAULT_SLAB_THICKNESS;
  const { mesh, chain } = buildSlab(a, b, t);
  // Architectural convention: slab top face = level plane.
  // buildSlab geometry has bottom at z=0, top at z=t. Offset so top = elev.
  mesh.position.z = elev - t;
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdSlab", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  return { created: "slab", width: w, depth: d };
});

registerHandler("SdColumn", (args) => {
  const cplane = resolveCPlane("SdColumn", args as Record<string, unknown>, viewer);
  const posArr = args.position as [number, number] | undefined;
  const p = { x: posArr?.[0] ?? 0, y: posArr?.[1] ?? 0 };
  const { mesh, chain } = buildColumn(p);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdColumn", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  return { created: "column" };
});

// ── IFC Tier 2: Beam / Stair / Door / Window / Roof / Space ─────────────────

registerHandler("SdBeam", (args) => {
  const s = args.start as number[] | undefined;
  const e = args.end as number[] | undefined;
  const a = { x: s?.[0] ?? 0, y: s?.[1] ?? 0 };
  const b = { x: e?.[0] ?? 4, y: e?.[1] ?? 0 };
  const { mesh, chain } = buildBeam(a, b);
  mesh.position.z += getActiveLevelElevation();
  mesh.userData.layerId = resolveLayerId("SdBeam", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  const dx = b.x - a.x, dy = b.y - a.y;
  return { created: "beam", length: Math.sqrt(dx * dx + dy * dy) || 4 };
});

registerHandler("SdMember", (args) => {
  const length   = (args.length as number | undefined) ?? 3;
  const axisRaw  = args.axis_curve as [number, number, number] | undefined;
  const axis     = axisRaw ?? [0, 0, 1];
  const rawProfile = args.profile as [number, number][] | undefined;
  const pts: [number, number][] = Array.isArray(rawProfile) && rawProfile.length >= 3
    ? (rawProfile as [number, number][])
    : [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]];
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  const mat = new THREE.MeshStandardMaterial({ color: 0x7a8fa6, roughness: 0.5, metalness: 0.2 });
  const mesh = new THREE.Mesh(geom, mat);
  const up = new THREE.Vector3(0, 0, 1);
  const dir = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
  if (Math.abs(dir.dot(up)) < 0.9999) mesh.quaternion.setFromUnitVectors(up, dir);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "member";
  mesh.userData.layerId = resolveLayerId("SdMember", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "member", length, profile_points: pts.length };
});

registerHandler("SdStair", (args) => {
  // Accept start/end as either array [x, y] or object { x, y }.
  const toXY = (v: unknown, dx: number, dy: number): { x: number; y: number } => {
    if (Array.isArray(v)) return { x: (v[0] as number) ?? dx, y: (v[1] as number) ?? dy };
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      return { x: (obj.x as number) ?? dx, y: (obj.y as number) ?? dy };
    }
    return { x: dx, y: dy };
  };
  let a = toXY(args.start, 0, 0);
  let b = toXY(args.end,   4, 0);
  // Bounds-snap: if both start and end fall outside existing wall/slab extents,
  // translate the segment midpoint onto the scene bbox midpoint.
  const stairBbox = new THREE.Box3();
  let hasBounds = false;
  viewer.forEachSceneChild((child) => {
    const c = child.userData?.creator;
    if (c === "SdWall" || c === "wall" || c === "SdSlab" || c === "slab") {
      stairBbox.expandByObject(child);
      hasBounds = true;
    }
  });
  if (hasBounds && !stairBbox.isEmpty()) {
    const inBbox = (p: { x: number; y: number }) =>
      p.x >= stairBbox.min.x && p.x <= stairBbox.max.x &&
      p.y >= stairBbox.min.y && p.y <= stairBbox.max.y;
    if (!inBbox(a) && !inBbox(b)) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const bx = (stairBbox.min.x + stairBbox.max.x) / 2;
      const by = (stairBbox.min.y + stairBbox.max.y) / 2;
      a = { x: a.x + (bx - mx), y: a.y + (by - my) };
      b = { x: b.x + (bx - mx), y: b.y + (by - my) };
    }
  }
  // Explicit parametric args take priority; omitting count lets buildStair derive from run distance.
  // Width is fixed by asset preset (#1678); riser/tread default to standard values when not explicit.
  const explicitCount = typeof args.count === "number" ? Math.max(1, Math.round(args.count)) : null;
  const explicitRiser = typeof args.riser === "number" ? args.riser : null;
  const explicitTread = typeof args.tread === "number" ? args.tread : null;
  const stairParams: StairParams = {
    type:        (args.type as StairParams["type"] | undefined) ?? "straight",
    width:       STAIR_WIDTH,
    treadDepth:  explicitTread  ?? STAIR_STEP_DEPTH,
    riserHeight: explicitRiser  ?? STAIR_STEP_RISE,
    ...(explicitCount != null ? { count: explicitCount } : {}),
  };
  const { group, chain, footprint } = buildStair(a, b, stairParams);
  const elev = getActiveLevelElevation();
  group.position.z = elev;
  group.userData.layerId = resolveLayerId("SdStair", args);
  group.userData.levelId = getActiveLevelId();
  group.userData.dispatchArgs = args;
  group.userData.chain = chain;
  viewer.addMesh(group, "brep");

  // Cut a void in the slab closest to (elev + targetH) matching the stair footprint.
  // Uses closest-slab strategy (2m tolerance) rather than a rigid 0.5m window —
  // handles level-state drift between surfaces without requiring exact elevation match.
  const targetH = stairParams.rise ?? stairParams.targetHeight ?? 3.0;
  const voidElev = elev + targetH;
  const clearance = 0.1;
  let closestSlab: THREE.Object3D | null = null;
  let closestDist = Infinity;
  viewer.forEachSceneChild((child) => {
    if (child.userData?.creator !== "slab") return;
    const dist = Math.abs(child.position.z - voidElev);
    if (dist < closestDist) { closestDist = dist; closestSlab = child; }
  });
  if (closestSlab && closestDist < 2.0) {
    cutSlabVoidFromBoxMesh(
      closestSlab as THREE.Mesh,
      footprint.minX - clearance, footprint.minY - clearance,
      footprint.maxX + clearance, footprint.maxY + clearance,
    );
    (closestSlab as THREE.Object3D).userData.ceilingHole = true;
  }

  return { created: "stair", type: stairParams.type };
});

// §#1520: compound-void preservation — addVoidToWallObject (join-groups.ts) replaces the
// local addVoidToWallObject that discarded prior voids on Group walls.

registerHandler("SdDoor", (args) => {
  const hostUuidDoor = args.hostUuid as string | undefined;
  let hostObjDoor: THREE.Object3D | undefined = hostUuidDoor
    ? viewer.getScene().getObjectByProperty("uuid", hostUuidDoor) ?? undefined
    : undefined;
  // Dimensions fixed by asset preset (#1678) — computed early so wall-find can use
  // the door's expected world Z for 3-D distance (#1665).
  const elevation = getActiveLevelElevation();
  const doorType = (args.doorType as string | undefined);
  let doorW: number;
  let doorH: number;
  if (doorType === "front") {
    doorW = FZK_FRONT_DOOR_W;
    doorH = FZK_FRONT_DOOR_H;
  } else if (doorType === "terrace") {
    doorW = FZK_TERRACE_DOOR_W;
    doorH = FZK_TERRACE_DOOR_H;
  } else if (doorType === "interior") {
    doorW = FZK_DOOR_W;
    doorH = FZK_DOOR_H;
  } else {
    doorW = DEFAULT_DOOR_W;
    doorH = DEFAULT_DOOR_H;
  }
  // §#1516,#1546,#1665: auto-find nearest wall within 3 m when hostUuid absent.
  // 3-D distance from the door's expected world center selects the correct floor's
  // wall even when levelId is absent (IFC walls). 2-pass: active level first.
  if (!hostObjDoor) {
    const posArr = args.position as number[] | undefined;
    const doorRef = new THREE.Vector3(posArr?.[0] ?? 0, posArr?.[1] ?? 0, elevation + doorH / 2);
    const activeLvlIdDoor = getActiveLevelId();
    let minDist = 3;
    viewer.forEachSceneChild((child) => {
      const c = child.userData?.creator;
      if (c !== "SdWall" && c !== "wall") return;
      if (child.userData?.levelId !== activeLvlIdDoor) return;
      const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
      // §#1725: use 2D XY distance — levelId already ensures correct floor, so imperial
      // elevation mismatch (ft stored vs m window constants) must not block wall-find.
      const dist = Math.sqrt((doorRef.x - wallCenter.x) ** 2 + (doorRef.y - wallCenter.y) ** 2);
      if (dist < minDist) { minDist = dist; hostObjDoor = child; }
    });
    if (!hostObjDoor) {
      minDist = 3;
      viewer.forEachSceneChild((child) => {
        const c = child.userData?.creator;
        if (c !== "SdWall" && c !== "wall") return;
        const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
        const dist = doorRef.distanceTo(wallCenter);
        if (dist < minDist) { minDist = dist; hostObjDoor = child; }
      });
    }
  }
  const cplane = resolveCPlane("SdDoor", args as Record<string, unknown>, viewer, hostObjDoor);
  const pos = args.position as number[] | undefined;
  const rawP = { x: pos?.[0] ?? 0, y: pos?.[1] ?? 0 };
  // §#1679: single placement rect — project click onto wall centerline (lc.y=0)
  // so mesh position and void center share the identical world XY origin.
  let p = rawP;
  if (hostObjDoor) {
    hostObjDoor.updateMatrixWorld(true);
    const lc = hostObjDoor.worldToLocal(new THREE.Vector3(rawP.x, rawP.y, elevation + doorH / 2));
    lc.y = 0;
    const snapped = hostObjDoor.localToWorld(lc);
    p = { x: snapped.x, y: snapped.y };
  }
  const { mesh, chain } = buildDoor(p, { w: doorW, h: doorH });
  mesh.position.z = elevation;
  if (cplane.kind === "host-derived") {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), cplane.normal);
    mesh.quaternion.copy(q);
  }
  mesh.userData.creator = "door";
  mesh.userData.voidW = doorW;
  mesh.userData.voidH = doorH;
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdDoor", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep", { noHistory: true });
  let voidCut = false;
  beginTransaction("SdDoor");
  if (hostObjDoor) {
    const voidCenter = new THREE.Vector3(p.x, p.y, elevation + doorH / 2);
    const voidGroup = addVoidToWallObject(hostObjDoor, voidCenter, doorW, doorH);
    if (voidGroup) {
      pushReplaceAction(voidGroup, [hostObjDoor], "wall-void-cut");
      mesh.userData.hostExpressID = (hostObjDoor.userData as Record<string, unknown>).expressID as string ?? hostObjDoor.uuid;
    }
    voidCut = true;
  }
  pushAction(mesh, chain);
  endTransaction();
  onElementCommitted(mesh, viewer.getScene());
  return { created: "door", voidCut };
});

registerHandler("SdWindow", (args) => {
  const hostUuidWin = args.hostUuid as string | undefined;
  let hostObjWin: THREE.Object3D | undefined = hostUuidWin
    ? viewer.getScene().getObjectByProperty("uuid", hostUuidWin) ?? undefined
    : undefined;
  // Dimensions fixed by asset preset (#1678) — computed early so wall-find can use
  // the window's expected world Z for 3-D distance (#1665).
  const elevation = getActiveLevelElevation();
  const winType = (args.windowType as string | undefined);
  const isOG = winType === "og";
  const winW    = isOG ? FZK_OG_WINDOW_W : FZK_WINDOW_W;
  const winH    = isOG ? FZK_OG_WINDOW_H : FZK_WINDOW_H;
  const winSill = FZK_WINDOW_SILL;
  // §#1545,#1665: auto-find nearest wall within 3 m when hostUuid absent.
  // 3-D distance from the window's expected world center selects the correct floor's
  // wall even when levelId is absent (IFC walls). 2-pass: active level first.
  if (!hostObjWin) {
    const posArr = args.position as number[] | undefined;
    const winRef = new THREE.Vector3(posArr?.[0] ?? 0, posArr?.[1] ?? 0, elevation + winSill + winH / 2);
    const activeLvlIdWin = getActiveLevelId();
    let minDist = 3;
    viewer.forEachSceneChild((child) => {
      const c = child.userData?.creator;
      if (c !== "SdWall" && c !== "wall") return;
      if (child.userData?.levelId !== activeLvlIdWin) return;
      const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
      // §#1725: use 2D XY distance — levelId already ensures correct floor, so imperial
      // elevation mismatch (ft stored vs m window constants) must not block wall-find.
      const dist = Math.sqrt((winRef.x - wallCenter.x) ** 2 + (winRef.y - wallCenter.y) ** 2);
      if (dist < minDist) { minDist = dist; hostObjWin = child; }
    });
    if (!hostObjWin) {
      minDist = 3;
      viewer.forEachSceneChild((child) => {
        const c = child.userData?.creator;
        if (c !== "SdWall" && c !== "wall") return;
        const wallCenter = new THREE.Box3().setFromObject(child).getCenter(new THREE.Vector3());
        const dist = winRef.distanceTo(wallCenter);
        if (dist < minDist) { minDist = dist; hostObjWin = child; }
      });
    }
  }
  const cplane = resolveCPlane("SdWindow", args as Record<string, unknown>, viewer, hostObjWin);
  const pos = args.position as number[] | undefined;
  const rawP = { x: pos?.[0] ?? 0, y: pos?.[1] ?? 0 };
  // §#1679: single placement rect — project click onto wall centerline (lc.y=0)
  // so mesh position and void center share the identical world XY origin.
  let p = rawP;
  if (hostObjWin) {
    hostObjWin.updateMatrixWorld(true);
    const lc = hostObjWin.worldToLocal(new THREE.Vector3(rawP.x, rawP.y, elevation + winSill + winH / 2));
    lc.y = 0;
    const snapped = hostObjWin.localToWorld(lc);
    p = { x: snapped.x, y: snapped.y };
  }
  const { mesh, chain } = buildWindow(p, { w: winW, h: winH, sill: winSill });
  mesh.position.z = elevation + mesh.position.z;
  if (cplane.kind === "host-derived") {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), cplane.normal);
    mesh.quaternion.copy(q);
  }
  mesh.userData.creator = "window";
  mesh.userData.voidW = winW;
  mesh.userData.voidH = winH;
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdWindow", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep", { noHistory: true });
  let voidCut = false;
  beginTransaction("SdWindow");
  if (hostObjWin) {
    // §#1518: addVoidToWallObject handles Mesh + Group walls.
    // §#1679: voidCenter from same p as mesh position — single rect for mesh and void.
    const voidCenter = new THREE.Vector3(p.x, p.y, elevation + winSill + winH / 2);
    const voidGroup = addVoidToWallObject(hostObjWin, voidCenter, winW, winH);
    if (voidGroup) {
      pushReplaceAction(voidGroup, [hostObjWin], "wall-void-cut");
      mesh.userData.hostExpressID = (hostObjWin.userData as Record<string, unknown>).expressID as string ?? hostObjWin.uuid;
    }
    voidCut = true;
  }
  pushAction(mesh, chain);
  endTransaction();
  onElementCommitted(mesh, viewer.getScene());
  return { created: "window", voidCut };
});

registerHandler("SdRoof", (args) => {
  const rawType = (args.roofType as string | undefined) ?? "pitched";
  // Normalise roofType to our internal set
  const typeMap: Record<string, RoofParams["type"]> = {
    pitched: "pitched", gable: "pitched", hip: "hip", hipped: "hip",
    shed: "shed", mono: "shed", "mono-pitch": "shed",
    flat: "flat", mansard: "flat", combination: "flat",
  };
  const roofType: RoofParams["type"] = typeMap[rawType] ?? "pitched";
  const pitchDeg = (args.pitchDeg as number | undefined) ?? (args.pitchAngleDeg as number | undefined) ?? 30;
  const overhang = (args.overhang as number | undefined) ?? 0.5;
  const thickness = (args.thickness as number | undefined) ?? 0.15;

  const fp = args.footprint as number[][] | undefined;
  let w = 8, d = 10;
  let centerX = 0, centerY = 0;
  if (fp && fp.length >= 2) {
    const xs = fp.map((p) => p[0]);
    const ys = fp.map((p) => p[1]);
    w = (Math.max(...xs) - Math.min(...xs)) || 8;
    d = (Math.max(...ys) - Math.min(...ys)) || 10;
    centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
    centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
  } else {
    // Footprint absent — infer bounding box from scene walls at the active level (#1756).
    // Agent-emitted SdRoof often omits footprint; defaults (w=8,d=10,centerX=0) then
    // exclude actual walls from eave-height inference and gable-candidate filter.
    const inferElev = getActiveLevelElevation();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let hasWalls = false;
    viewer.getScene().traverse((child) => {
      if (child.userData?.creator !== "wall") return;
      const _wp = new THREE.Vector3();
      child.getWorldPosition(_wp);
      if (Math.abs(_wp.z - inferElev) > 0.5) return;
      const _eps = child.userData.endpoints as Array<{ x: number; y: number }> | undefined;
      if (!_eps || _eps.length < 2) return;
      for (const _ep of _eps) {
        if (_ep.x < minX) minX = _ep.x;
        if (_ep.x > maxX) maxX = _ep.x;
        if (_ep.y < minY) minY = _ep.y;
        if (_ep.y > maxY) maxY = _ep.y;
      }
      hasWalls = true;
    });
    if (hasWalls && minX !== Infinity) {
      w = (maxX - minX) || 8;
      d = (maxY - minY) || 10;
      centerX = (maxX + minX) / 2;
      centerY = (maxY + minY) / 2;
    }
  }
  const a = { x: -w / 2, y: -d / 2 };
  const b = { x: w / 2, y: d / 2 };
  const roofParams: RoofParams = { type: roofType, pitchDeg, overhang, thickness, showStructure: true };
  const { mesh, chain } = buildRoof(a, b, roofParams);

  // Infer eave height from walls adjacent to the footprint so the roof plate sits
  // at the wall top — prevents wall tops from poking above the eave plane (#947).
  // DEFAULT_CEILING_OFFSET (2.74m) was below DEFAULT_WALL_HEIGHT (3m) causing grey bars.
  const activeLevelElev = getActiveLevelElevation();
  let eaveOffset = DEFAULT_WALL_HEIGHT;
  {
    const FOOT_EXPAND = 1.5;
    viewer.getScene().traverse((child) => {
      if (child.userData?.creator !== "wall") return;
      const wp = new THREE.Vector3();
      child.getWorldPosition(wp);
      if (Math.abs(wp.z - activeLevelElev) > 0.5) return;
      const eps = child.userData.endpoints as Array<{ x: number; y: number }> | undefined;
      if (!eps || eps.length < 2) return;
      const midX = (eps[0].x + eps[1].x) / 2;
      const midY = (eps[0].y + eps[1].y) / 2;
      if (midX < centerX - w / 2 - FOOT_EXPAND || midX > centerX + w / 2 + FOOT_EXPAND) return;
      if (midY < centerY - d / 2 - FOOT_EXPAND || midY > centerY + d / 2 + FOOT_EXPAND) return;
      const wh = (child.userData.wallHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;
      if (wh > eaveOffset) eaveOffset = wh;
    });
  }
  mesh.position.set(centerX, centerY, activeLevelElev + eaveOffset);
  mesh.userData.roofType = roofType;
  mesh.userData.ifcPredefinedType = ({
    pitched: "GABLE_ROOF",
    hip: "HIP_ROOF",
    shed: "SHED_ROOF",
    flat: "FLAT_ROOF",
  } as Record<string, string>)[roofType ?? "pitched"] ?? "NOTDEFINED";
  mesh.userData.layerId = resolveLayerId("SdRoof", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;

  // Group roof creation + gable-trim geometry swaps into one undoable action.
  // Ctrl+Z removes the roof AND restores gable walls to their flat-top BoxGeometry.
  beginTransaction("SdRoof+gable-trim");
  viewer.addMesh(mesh, "brep");
  if (mesh instanceof THREE.Mesh) onElementCommitted(mesh, viewer.getScene());

  // Auto-trim gable walls: for a pitched roof, reshape the two short-end walls into
  // a gable triangle. Eave walls (long sides) are left as-is.
  if (roofType === "pitched") {
    const pitchRad2 = (pitchDeg * Math.PI) / 180;
    const landscape = w >= d;
    // Span half includes overhang — matches buildRoof's hd/hw calculation so
    // gable wall pentagon peak aligns with the actual roof ridge (#947).
    const spanHalf = (landscape ? d : w) / 2 + overhang;
    const rH = spanHalf * Math.tan(pitchRad2);
    // activeLevelElev already defined above (eave-height inference block).
    const TOL = 0.8; // metres — endpoint must be within TOL of the gable edge

    // Collect wall candidates in one pass; restore Group walls (void-cut) to solid Mesh
    // before trimming — modifying scene graph during traverse is unsafe (#1163).
    const _gableWallCandidates: THREE.Mesh[] = [];
    viewer.getScene().traverse((child) => {
      if (child.userData?.creator !== "wall") return;
      if (child.userData?.topProfile === "pitched") return;
      const worldPos = new THREE.Vector3();
      child.getWorldPosition(worldPos);
      if (Math.abs(worldPos.z - activeLevelElev) > 0.5) return;
      if (child instanceof THREE.Mesh) {
        _gableWallCandidates.push(child);
      } else if (child instanceof THREE.Group) {
        // Wall was void-cut (Group) — restore to solid Mesh so geometry can be trimmed (#1163).
        const dims = (child.userData as Record<string, unknown>).originalWallDims as { w: number; d: number; h: number } | undefined;
        if (!dims) return;
        let _srcMat: THREE.Material | undefined;
        child.traverse((c) => {
          if (!_srcMat && (c as THREE.Mesh).isMesh) {
            const m = (c as THREE.Mesh).material;
            _srcMat = (Array.isArray(m) ? m[0] : m) as THREE.Material;
          }
        });
        const _rGeom = new THREE.BoxGeometry(dims.w, dims.d, dims.h);
        _rGeom.translate(0, 0, dims.h / 2);
        const _rMesh = new THREE.Mesh(_rGeom, _srcMat ?? new THREE.MeshStandardMaterial({ color: 0x9ec5d8 }));
        _rMesh.position.copy(child.position);
        _rMesh.rotation.copy(child.rotation);
        _rMesh.scale.copy(child.scale);
        _rMesh.userData = { ...child.userData };
        delete (_rMesh.userData as Record<string, unknown>).originalWallDims;
        _gableWallCandidates.push(_rMesh);
        // Defer scene swap until after traverse to avoid mutating scene graph mid-walk.
        (_rMesh as unknown as { _replaceGroup: THREE.Group })._replaceGroup = child;
      }
    });

    // Apply scene swaps for restored Group walls, then trim gable geometry.
    for (const _c of _gableWallCandidates) {
      const _grp = (_c as unknown as { _replaceGroup?: THREE.Group })._replaceGroup;
      if (_grp) {
        const _parent = _grp.parent ?? viewer.getScene();
        _parent.remove(_grp);
        _parent.add(_c);
        _c.updateMatrixWorld(true);
      }
    }

    // §#1724: derive gable-end coordinates from scene wall bounding box rather than from
    // the footprint arg — the model may dispatch SdRoof without footprint, yielding wrong
    // defaults (centerX=0, w=8, d=10) that miss the actual walls.
    // §#1756: apply same footprint+FOOT_EXPAND filter as the eaveOffset loop — walls
    // outside the building footprint (fences, sheds, partitions) must not expand
    // sceneGMin/sceneGMax beyond the actual gable positions, which would push the
    // boundary check > TOL away from the real gable wall endpoints.
    const FOOT_EXPAND_GABLE = 1.5;
    let sceneGMin = Infinity, sceneGMax = -Infinity;
    for (const cand of _gableWallCandidates) {
      const ep = cand.userData.endpoints as Array<{ x: number; y: number }> | undefined;
      if (!ep || ep.length < 2) continue;
      const midX = (ep[0].x + ep[1].x) / 2;
      const midY = (ep[0].y + ep[1].y) / 2;
      if (midX < centerX - w / 2 - FOOT_EXPAND_GABLE || midX > centerX + w / 2 + FOOT_EXPAND_GABLE) continue;
      if (midY < centerY - d / 2 - FOOT_EXPAND_GABLE || midY > centerY + d / 2 + FOOT_EXPAND_GABLE) continue;
      const v0 = landscape ? ep[0].x : ep[0].y;
      const v1 = landscape ? ep[1].x : ep[1].y;
      if (v0 < sceneGMin) sceneGMin = v0;
      if (v0 > sceneGMax) sceneGMax = v0;
      if (v1 < sceneGMin) sceneGMin = v1;
      if (v1 > sceneGMax) sceneGMax = v1;
    }

    for (const child of _gableWallCandidates) {
      const eps = child.userData.endpoints as Array<{ x: number; y: number }> | undefined;
      if (!eps || eps.length < 2) continue;
      const wx0 = eps[0].x, wy0 = eps[0].y;
      const wx1 = eps[1].x, wy1 = eps[1].y;

      // Gable wall: both endpoints at the same span-direction coordinate AND that
      // coordinate is at the scene bounding-box boundary (#1724).
      const vA = landscape ? wx0 : wy0;
      const vB = landscape ? wx1 : wy1;
      const isGable = Math.abs(vA - vB) < TOL &&
        (Math.abs(vA - sceneGMin) < TOL || Math.abs(vA - sceneGMax) < TOL);
      if (!isGable) continue;

      const wallMesh = child;
      // Use eaveOffset (the height at which the roof is placed) so the gable pentagon's
      // top edge aligns with the roof eave — not the individual wall's stored height,
      // which may be shorter than eaveOffset when walls vary in height or when
      // DEFAULT_WALL_HEIGHT > actual wallHeight (#1756).
      const wallEaveH = eaveOffset;
      const cps = wallMesh.userData.controlPoints as THREE.Vector3[] | undefined;
      const len = cps && cps.length >= 2 ? cps[0].distanceTo(cps[1]) : (() => {
        const ddx = wx1 - wx0, ddy = wy1 - wy0;
        return Math.sqrt(ddx * ddx + ddy * ddy);
      })();
      const wt = (wallMesh.userData.wallThickness as number | undefined) ?? 0.2;

      // Build gable pentagon in the same local space as the existing wall geometry.
      const shape = new THREE.Shape();
      shape.moveTo(-len / 2, 0);
      shape.lineTo( len / 2, 0);
      shape.lineTo( len / 2, wallEaveH);
      shape.lineTo( 0,       wallEaveH + rH);
      shape.lineTo(-len / 2, wallEaveH);
      shape.closePath();
      const pitchedGeom = new THREE.ExtrudeGeometry(shape, { depth: wt, bevelEnabled: false });
      pitchedGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      pitchedGeom.translate(0, wt / 2, 0);

      // Capture old geometry BEFORE swap so undo can restore it.
      // Old geometry is kept alive (not disposed) so undo can re-assign it;
      // disposal follows the DeleteAction convention — deferred to clearHistory().
      const oldGeom = wallMesh.geometry;
      wallMesh.geometry = pitchedGeom;
      wallMesh.userData.topProfile = "pitched";
      wallMesh.userData.eaveHeight = wallEaveH;
      wallMesh.userData.ridgeHeight = rH;

      pushCustomAction(
        () => {
          // Undo: restore flat-top BoxGeometry and clear pitched metadata.
          wallMesh.geometry = oldGeom;
          delete (wallMesh.userData as Record<string, unknown>).topProfile;
          delete (wallMesh.userData as Record<string, unknown>).eaveHeight;
          delete (wallMesh.userData as Record<string, unknown>).ridgeHeight;
        },
        () => {
          // Redo: re-apply gable pentagon geometry.
          wallMesh.geometry = pitchedGeom;
          wallMesh.userData.topProfile = "pitched";
          wallMesh.userData.eaveHeight = wallEaveH;
          wallMesh.userData.ridgeHeight = rH;
        },
      );
    }
  }

  endTransaction();
  return { created: "roof", roofType, width: w, depth: d, ifcPredefinedType: mesh.userData.ifcPredefinedType };
});


registerHandler("SdSpace", (args) => {
  const fp = args.footprint as number[][] | undefined;
  let w = 5, d = 4;
  if (fp && fp.length >= 2) {
    const xs = fp.map((p) => p[0]);
    const ys = fp.map((p) => p[1]);
    w = (Math.max(...xs) - Math.min(...xs)) || 5;
    d = (Math.max(...ys) - Math.min(...ys)) || 4;
  }
  const a = { x: -w / 2, y: -d / 2 };
  const b = { x: w / 2, y: d / 2 };
  const { mesh, chain } = buildSpace(a, b);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.layerId = resolveLayerId("SdSpace", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  if (args.name) mesh.userData.spaceName = args.name as string;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  return { created: "space", width: w, depth: d };
});

// ── IFC Tier 3: Foundation / Ceiling / CurtainWall / Skylight / Opening / Ramp / Railing / Grid / Level / Datum ──

registerHandler("SdFoundation", (args) => {
  const w = (args.width as number | undefined) ?? 6;
  const d = (args.depth as number | undefined) ?? 6;
  const a = { x: -w / 2, y: -d / 2 };
  const b = { x: w / 2, y: d / 2 };
  const { mesh, chain } = buildFoundation(a, b);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.layerId = resolveLayerId("SdFoundation", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  return { created: "foundation", width: w, depth: d };
});

registerHandler("SdCeiling", (args) => {
  const w = (args.width as number | undefined) ?? 5;
  const d = (args.depth as number | undefined) ?? 4;
  let a = { x: -w / 2, y: -d / 2 };
  let b = { x: w / 2, y: d / 2 };
  const ceilProf = args.profile as number[][] | undefined;
  if (ceilProf && ceilProf.length >= 2) {
    const xs = ceilProf.map((p) => p[0]);
    const ys = ceilProf.map((p) => p[1]);
    a = { x: Math.min(...xs), y: Math.min(...ys) };
    b = { x: Math.max(...xs), y: Math.max(...ys) };
  }
  const { mesh, chain } = buildCeiling(a, b);
  mesh.position.z = getActiveLevelElevation() + DEFAULT_CEILING_OFFSET;
  mesh.userData.layerId = resolveLayerId("SdCeiling", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  return { created: "ceiling", width: w, depth: d };
});

registerHandler("SdCurtainWall", (args) => {
  const wallLen = (args.length as number | undefined) ?? 6;
  const startArg = args.start as number[] | undefined;
  const endArg = args.end as number[] | undefined;
  let a: { x: number; y: number }, b: { x: number; y: number };
  if (startArg && endArg) {
    a = { x: startArg[0] ?? 0, y: startArg[1] ?? 0 };
    b = { x: endArg[0] ?? wallLen, y: endArg[1] ?? 0 };
  } else {
    a = { x: 0, y: 0 };
    b = { x: wallLen, y: 0 };
  }
  const cwParams: CurtainWallParams = {
    mullionSpacing:  (args.mullionSpacing  as number | undefined) ?? undefined,
    transomSpacing:  (args.transomSpacing  as number | undefined) ?? undefined,
  };
  const { mesh, chain } = buildCurtainWall(a, b, cwParams);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.layerId = resolveLayerId("SdCurtainWall", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  // Commit the invisible join shell so join-groups CSG pipeline can union it with
  // adjacent structural elements (#841). Shell inherits z from the group.
  const _joinShell = mesh.userData.joinableShell as THREE.Mesh | undefined;
  if (_joinShell instanceof THREE.Mesh) {
    _joinShell.position.z = mesh.position.z;
    _joinShell.userData.levelId = getActiveLevelId();
    _joinShell.userData.layerId = resolveLayerId("SdCurtainWall", args);
    viewer.addMesh(_joinShell, "brep");
    onElementCommitted(_joinShell, viewer.getScene());
  }
  return { created: "curtainwall", length: wallLen };
});

registerHandler("SdPlate", (args) => {
  const thickness = (args.thickness as number | undefined) ?? 0.05;
  const normRaw   = args.orientation as [number, number, number] | undefined;
  const norm      = normRaw ?? [0, 1, 0];
  const rawProfile = args.profile as [number, number][] | undefined;
  const pts: [number, number][] = Array.isArray(rawProfile) && rawProfile.length >= 3
    ? (rawProfile as [number, number][])
    : [[0, 0], [1, 0], [1, 1], [0, 1]];
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const geom = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  const mat  = new THREE.MeshStandardMaterial({ color: 0xc8d8e8, roughness: 0.4, metalness: 0.1 });
  const mesh = new THREE.Mesh(geom, mat);
  const up  = new THREE.Vector3(0, 0, 1);
  const dir = new THREE.Vector3(norm[0], norm[1], norm[2]).normalize();
  if (Math.abs(dir.dot(up)) < 0.9999) mesh.quaternion.setFromUnitVectors(up, dir);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "plate";
  mesh.userData.layerId = resolveLayerId("SdPlate", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "plate", thickness, profile_points: pts.length };
});

registerHandler("SdSkylight", (args) => {
  const w = (args.width as number | undefined) ?? 1.2;
  const d = (args.depth as number | undefined) ?? 1.2;
  const a = { x: -w / 2, y: -d / 2 };
  const b = { x: w / 2, y: d / 2 };
  const { mesh, chain } = buildSkylight(a, b);
  mesh.position.z = getActiveLevelElevation() + DEFAULT_CEILING_OFFSET;
  mesh.userData.layerId = resolveLayerId("SdSkylight", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  return { created: "skylight", width: w, depth: d };
});

registerHandler("SdOpening", (args) => {
  const hostUuidOp = args.hostUuid as string | undefined;
  const hostObjOp = hostUuidOp
    ? viewer.getScene().getObjectByProperty("uuid", hostUuidOp) ?? undefined
    : undefined;
  const cplane = resolveCPlane("SdOpening", args as Record<string, unknown>, viewer, hostObjOp);
  const pos = args.position as number[] | undefined;
  const elevation = getActiveLevelElevation();
  const p = { x: pos?.[0] ?? 0, y: pos?.[1] ?? 0 };
  const { mesh, chain } = buildOpening(p);
  mesh.position.z = elevation;
  if (cplane.kind === "host-derived") {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), cplane.normal);
    mesh.quaternion.copy(q);
  }
  mesh.userData.creator = "opening";
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("SdOpening", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep", { noHistory: true });
  let voidCut = false;
  beginTransaction("SdOpening");
  if (hostUuidOp) {
    const host = viewer.getScene().getObjectByProperty("uuid", hostUuidOp);
    if (host instanceof THREE.Mesh || host instanceof THREE.Group) {
      const voidCenter = mesh.position.clone();
      voidCenter.z = elevation + 1;
      // addVoidToWallObject handles Mesh + Group; preserves all prior voids (#1534).
      const voidGroup = addVoidToWallObject(host, voidCenter, 1, 2);
      if (voidGroup) pushReplaceAction(voidGroup, [host], "wall-void-cut");
      voidCut = true;
    }
  }
  pushAction(mesh, chain);
  endTransaction();
  return { created: "opening", voidCut };
});

registerHandler("SdRamp", (args) => {
  const s = (args.start as number[] | undefined) ?? [0, 0];
  const e = (args.end   as number[] | undefined) ?? [4, 0];
  const a = { x: s[0] ?? 0, y: s[1] ?? 0 };
  const b = { x: e[0] ?? 4, y: e[1] ?? 0 };
  const { mesh, chain } = buildRamp(a, b);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.layerId = resolveLayerId("SdRamp", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  const dx = b.x - a.x, dy = b.y - a.y;
  return { created: "ramp", run: Math.sqrt(dx * dx + dy * dy) || 1 };
});

registerHandler("SdRailing", (args) => {
  const s = (args.start as number[] | undefined) ?? [0, 0];
  const e = (args.end   as number[] | undefined) ?? [3, 0];
  const a = { x: s[0] ?? 0, y: s[1] ?? 0 };
  const b = { x: e[0] ?? 3, y: e[1] ?? 0 };
  const { mesh, chain } = buildRailing(a, b);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.layerId = resolveLayerId("SdRailing", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  onElementCommitted(mesh, viewer.getScene());
  const dx = b.x - a.x, dy = b.y - a.y;
  return { created: "railing", length: Math.sqrt(dx * dx + dy * dy) || 1 };
});

registerHandler("SdRefGrid", (args) => {
  const spacing  = (args.spacing  as number         | undefined) ?? 5;
  const count    = Math.max(2, Math.min(10, Math.trunc((args.count as number | undefined) ?? 4)));
  const name     = (args.name     as string         | undefined) ?? `Grid ${gridStore.all().length + 1}`;
  const rotDeg   = (args.rotation as number         | undefined) ?? 0;
  const origin   = (args.origin   as [number,number]| undefined) ?? [0, 0];

  const grid = gridStore.add({ name, spacing, count, rotation: (rotDeg * Math.PI) / 180, origin, visible: true });

  const extent = spacing * (count - 1);
  const half   = extent / 2;
  const t      = 0.02;
  const mat    = new THREE.MeshBasicMaterial({ color: 0x888899, transparent: true, opacity: 0.5 });
  const group  = new THREE.Group();
  group.rotation.z = grid.rotation;
  group.position.set(origin[0], origin[1], 0);
  group.userData.kind = "grid";
  group.userData.gridId = grid.id;

  for (let i = 0; i < count; i++) {
    const offset = -half + i * spacing;
    const gv = new THREE.BoxGeometry(t, extent + spacing, t);
    const mv = new THREE.Mesh(gv, mat);
    mv.position.set(offset, 0, 0);
    group.add(mv);
    const gh = new THREE.BoxGeometry(extent + spacing, t, t);
    const mh = new THREE.Mesh(gh, mat);
    mh.position.set(0, offset, 0);
    group.add(mh);
  }

  viewer.addMesh(group, "grid");
  return { created: "grid", gridId: grid.id, count, spacing, name };
});

registerHandler("setGridVisible", (args) => {
  const id      = args.id as string;
  const visible = args.visible as boolean;
  const ok = gridStore.setVisible(id, visible);
  if (!ok) return { error: `no grid with id "${id}"` };
  viewer.forEachSceneChild((obj) => { if (obj.userData.gridId === id) obj.visible = visible; });
  return { gridId: id, visible };
});

registerHandler("setGridSpacing", (args) => {
  const id      = args.id as string;
  const spacing = args.spacing as number;
  const ok = gridStore.setSpacing(id, spacing);
  if (!ok) return { error: `invalid id or spacing for grid "${id}"` };
  return { gridId: id, spacing };
});

registerHandler("setActiveGrid", (args) => {
  const id = args.id as string;
  const ok = gridStore.setActive(id);
  if (!ok) return { error: `no grid with id "${id}"` };
  return { activeGridId: id };
});

registerHandler("SdLevel", (args) => {
  const elev   = (args.elevation as number | undefined) ?? 0;
  const height = (args.height as number | undefined) ?? 3.0;
  const extent = (args.extent  as number | undefined) ?? 20;
  // Canonical naming — agent-provided name ignored; levels are always "Level 1", "Level 2", ...
  const canonicalName = `Level ${levelStore.all().length + 1}`;
  const level = levelStore.findOrCreate(canonicalName, elev, height);
  const geom   = new THREE.BoxGeometry(extent, extent, 0.02);
  const mat    = new THREE.MeshBasicMaterial({ color: 0x44aa88, transparent: true, opacity: 0.05, side: THREE.DoubleSide });
  const mesh   = new THREE.Mesh(geom, mat);
  mesh.position.z = elev;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcLevel";
  mesh.userData.levelId = level.id;
  mesh.userData.noSnap = true;
  const label = makeLevelSprite(level.name);
  label.position.set(extent / 2 - 2.5, extent / 2 - 2.5, 0.3);
  mesh.add(label);
  levelStore.setActive(level.id);
  viewer.addMesh(mesh, "brep");
  syncLevelOpacities();
  return { created: "level", elevation: elev, levelId: level.id };
});

// Dim non-active level planes; brighten the active one. Called whenever the active level changes.
function syncLevelOpacities(): void {
  const activeId = levelStore.getActive().id;
  viewer.forEachSceneChild((child) => {
    if (child.userData?.creator !== "IfcLevel") return;
    const isActive = child.userData.levelId === activeId;
    const mat = (child as THREE.Mesh).material as THREE.MeshBasicMaterial;
    if (mat?.opacity !== undefined) {
      mat.opacity = isActive ? 0.05 : 0.02;
      mat.needsUpdate = true;
    }
    for (const ch of child.children) {
      if (ch.userData?.isLevelLabel) {
        (ch as THREE.Sprite).material.opacity = isActive ? 1.0 : 0.4;
        (ch as THREE.Sprite).material.needsUpdate = true;
      }
    }
  });
}

registerHandler("setActiveLevel", (args) => {
  const id = args.id as string | undefined;
  if (!id) return { error: "id required" };
  const level = levelStore.get(id);
  if (!level) return { error: `level not found: ${id}` };
  if (level.locked) return { status: "error", detail: `level ${level.name} is locked` };
  const ok = levelStore.setActive(id);
  if (!ok) return { error: `level not found: ${id}` };
  syncLevelOpacities();
  return { ok: true, activeLevel: id, elevation: level.elevation };
});

registerHandler("setLevelVisible", (args) => {
  const id      = args.id as string | undefined;
  const visible = args.visible as boolean | undefined;
  if (!id || visible === undefined) return { error: "id and visible required" };
  const ok = levelStore.setVisible(id, visible);
  if (!ok) return { error: `level not found: ${id}` };
  viewer.forEachSceneChild((child) => {
    if (child.userData?.levelId === id) child.visible = visible;
  });
  return { ok: true, levelId: id, visible };
});

registerHandler("removeLevel", (args) => {
  const id = args.id as string | undefined;
  if (!id) return { error: "id required" };
  const ok = levelStore.remove(id);
  if (!ok) return { error: `cannot remove level: ${id}` };
  const toRemove: THREE.Object3D[] = [];
  viewer.forEachSceneChild((child) => {
    if (child.userData?.levelId === id) toRemove.push(child);
  });
  for (const obj of toRemove) viewer.removeObject(obj);
  return { ok: true, levelId: id };
});

registerHandler("SdDatum", (args) => {
  const pos  = (args.position as number[] | undefined);
  const elev = (args.elevation as number | undefined) ?? pos?.[2] ?? 0;
  const geom = new THREE.SphereGeometry(0.15, 8, 8);
  const mat  = new THREE.MeshStandardMaterial({ color: 0x33bb66, roughness: 0.3, metalness: 0.2 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(pos?.[0] ?? 0, pos?.[1] ?? 0, elev);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "datum";
  if (args.label) mesh.userData.label = args.label as string;
  viewer.addMesh(mesh, "brep");
  return { created: "datum", elevation: elev };
});

registerHandler("SdReferenceLine", (args) => {
  const origin = (args.origin as number[] | undefined) ?? [0, 0];
  const end    = (args.end    as number[] | undefined) ?? [5, 0];
  const a = { x: origin[0] ?? 0, y: origin[1] ?? 0 };
  const b = { x: end[0]    ?? 5, y: end[1]    ?? 0 };
  const { mesh, chain } = buildReferenceLine(a, b);
  mesh.userData.layerId = resolveLayerId("SdReferenceLine", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "brep");
  return { created: "reference-line", origin: [a.x, a.y], end: [b.x, b.y] };
});

registerHandler("SdFurnishing", (args) => {
  const w    = (args.width       as number | undefined) ?? 0.8;
  const d    = (args.depth       as number | undefined) ?? 0.6;
  const h    = (args.height      as number | undefined) ?? 0.75;
  const rotDeg = (args.orientation as number | undefined) ?? 0;
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xd4b896, roughness: 0.8, metalness: 0.0 });
  const mesh = new THREE.Mesh(geom, mat);
  const pos  = args.position as number[] | undefined;
  mesh.position.set(pos?.[0] ?? 0, pos?.[1] ?? 0, pos?.[2] ?? getActiveLevelElevation());
  if (rotDeg) mesh.rotation.z = (rotDeg * Math.PI) / 180;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "furnishing";
  mesh.userData.layerId = resolveLayerId("SdFurnishing", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "furnishing", width: w, depth: d, height: h };
});

// ── Tier 1 handlers: SdPoint / SdLine / SdRectangle / SdPolyline (#64) ───────
// These replace the fan-out shims installed by installDefaultHandlers() below.
// Render using THREE line/point primitives (not mesh geometry) per the project direction
// "tubes / spheres" feedback: lines = LineSegments, points = sprite-style Points.

function buildPointMaterial(sizePx = 14): THREE.PointsMaterial {
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

registerHandler("SdPoint", (args) => {
  const pos = (args.position as number[] | undefined) ?? [0, 0];
  const p = { x: pos[0] ?? 0, y: pos[1] ?? 0 };
  const { mesh, chain } = buildPoint(p);
  mesh.userData.creator = "point";
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "mesh");
  return { created: "point", position: [p.x, p.y, 0] };
});

registerHandler("SdLine", (args) => {
  const start = (args.start as number[] | undefined) ?? [0, 0];
  const end   = (args.end   as number[] | undefined) ?? [1, 0];
  const a = { x: start[0] ?? 0, y: start[1] ?? 0 };
  const b = { x: end[0] ?? 1, y: end[1] ?? 0 };
  const { mesh, chain } = buildLine(a, b);
  mesh.userData.creator = "line";
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "mesh");
  return { created: "line", start, end };
});

// SdRect is a runtime alias for SdRectangle (registered below).
// Both accept {x, y, w, d} shorthand OR {center, width, length} long form.
registerRuntimeAlias("SdRect", "SdRectangle");
registerHandler("SdRectangle", (args) => {
  // {x, y, w, d} shorthand: x/y = center, w = width, d = depth
  const hasShorthand = "w" in args || "d" in args;
  const w = hasShorthand
    ? ((args.w as number | undefined) ?? 1)
    : ((args.width as number | undefined) ?? 1);
  const d = hasShorthand
    ? ((args.d as number | undefined) ?? 1)
    : ((args.length as number | undefined) ?? (args.height as number | undefined) ?? 1);
  const cx = hasShorthand
    ? ((args.x as number | undefined) ?? 0)
    : ((args.center as number[] | undefined)?.[0] ?? 0);
  const cy = hasShorthand
    ? ((args.y as number | undefined) ?? 0)
    : ((args.center as number[] | undefined)?.[1] ?? 0);
  const a = { x: cx - w / 2, y: cy - d / 2 };
  const b = { x: cx + w / 2, y: cy + d / 2 };
  const { mesh, chain } = buildRect(a, b);
  mesh.userData.creator = "rect";
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "mesh");
  return { created: "rectangle", width: w, depth: d };
});

registerHandler("SdPolyline", (args) => {
  const points = (args.points as number[][] | undefined) ?? [];
  if (points.length < 2) return { error: "SdPolyline requires at least 2 points", created: null };
  const pts = points.map((p) => ({ x: p[0] ?? 0, y: p[1] ?? 0 }));
  const { mesh, chain } = buildPolyline(pts);
  mesh.userData.creator = "polyline";
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "mesh");
  return { created: "polyline", points };
});

// ── Tier 2 handlers: SdArc / SdCircle / SdEllipse / SdSpline (#72) ───────────
// Renders NURBS curves via tessellation → THREE.Line / THREE.LineLoop.
// Catalog ref: nurbs-curves.ts + nurbs-curve-algorithms.ts §3.

function ptToArray(p: { x: number; y: number; z: number }): number[] {
  return [p.x, p.y, p.z];
}

function polylineToGeom(pts: { x: number; y: number; z: number }[]): THREE.BufferGeometry {
  const flat = pts.flatMap(p => [p.x, p.y, p.z]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  return geom;
}

function curveMat(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: 0x000000 });
}

registerHandler("SdArc", (args) => {
  const c = (args.center as number[] | undefined) ?? [0, 0, 0];
  const radius = (args.radius as number | undefined) ?? 1;
  const startAngle = (args.startAngle as number | undefined) ?? 0;
  const endAngle   = (args.endAngle   as number | undefined) ?? Math.PI / 2;
  const arc: PrimArc = {
    center: Prim3.create(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0),
    radius,
    startAngle,
    endAngle,
    plane: PrimPlane.worldXY(),
  };
  const nurbs = nurbsCurveFromArc(arc);
  const pts = tessellate(nurbs, 64);
  const obj = new THREE.Line(polylineToGeom(pts), curveMat());
  obj.userData.kind = "arc";
  obj.userData.creator = "arc";
  viewer.addMesh(obj, "mesh");
  return { created: "arc", center: ptToArray(arc.center), radius, startAngle, endAngle };
});

registerHandler("SdCircle", (args) => {
  const c = (args.center as number[] | undefined) ?? [0, 0];
  const radius = (args.radius as number | undefined) ?? 1;
  const center = { x: c[0] ?? 0, y: c[1] ?? 0 };
  const radial = { x: center.x + radius, y: center.y };
  const { mesh, chain } = buildCircle(center, radial);
  mesh.userData.creator = "circle";
  mesh.userData.dispatchArgs = args;
  mesh.userData.chain = chain;
  viewer.addMesh(mesh, "mesh");
  return { created: "circle", center: [center.x, center.y, 0], radius };
});

registerHandler("SdEllipse", (args) => {
  const c  = (args.center as number[] | undefined) ?? [0, 0, 0];
  const rx = (args.rx as number | undefined) ?? (args.radiusX as number | undefined) ?? 1;
  const ry = (args.ry as number | undefined) ?? (args.radiusY as number | undefined) ?? 0.5;
  const center = Prim3.create(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);

  // Ellipse via affine squash of unit circle: create unit-circle NURBS, then
  // scale control points by (rx, ry) in the XY plane frame.
  const unitArc: PrimArc = {
    center: { x: 0, y: 0, z: 0 },
    radius: 1,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: PrimPlane.worldXY(),
  };
  const unitNurbs = nurbsCurveFromArc(unitArc);

  // Transform homogeneous CVs: (x*w, y*w, z*w, w) → scale Euclidean (x,y) by (rx,ry)
  const newCvs: number[] = [];
  for (let i = 0; i < unitNurbs.cvCount; i++) {
    const base = i * 4; // cvStride = 4 for rational
    const w  = unitNurbs.cvs[base + 3] ?? 1;
    const ex = (unitNurbs.cvs[base + 0] ?? 0) / w; // Euclidean x
    const ey = (unitNurbs.cvs[base + 1] ?? 0) / w; // Euclidean y
    const newX = center.x + ex * rx;
    const newY = center.y + ey * ry;
    const newZ = center.z;
    newCvs.push(newX * w, newY * w, newZ * w, w);
  }
  const ellipseNurbs = { ...unitNurbs, cvs: newCvs };
  const pts = tessellate(ellipseNurbs, 128);
  const obj = new THREE.LineLoop(polylineToGeom(pts), curveMat());
  obj.userData.kind = "ellipse";
  obj.userData.creator = "ellipse";
  viewer.addMesh(obj, "mesh");
  return { created: "ellipse", center: ptToArray(center), rx, ry };
});

registerHandler("SdSpline", (args) => {
  const rawPts = (args.points as number[][] | undefined) ?? [];
  if (rawPts.length < 4) {
    return { error: "SdSpline requires at least 4 points (cubic spline)", created: null };
  }
  const pts3 = rawPts.map(p => Prim3.create(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
  const nurbs = createClampedUniformNurbs(3, 4, pts3);
  const tess = tessellate(nurbs, pts3.length * 16);
  const obj = new THREE.Line(polylineToGeom(tess), curveMat());
  obj.userData.kind = "spline";
  obj.userData.creator = "spline";
  obj.userData.controlPoints = pts3.map(p => new THREE.Vector3(p.x, p.y, p.z));
  viewer.addMesh(obj, "mesh");
  return { created: "spline", points: pts3.map(p => ptToArray(p)) };
});

// SdCurve — Catmull-Rom curve matching the palette `curve` tool (#821).
// Distinct from SdSpline (clampedUniform NURBS = interpolating B-spline / InterpCrv equivalent).
registerHandler("SdCurve", (args) => {
  const rawPts = (args.points as number[][] | undefined) ?? [];
  if (rawPts.length < 2) {
    return { error: "SdCurve requires at least 2 points", created: null };
  }
  const pts = rawPts.map(p => ({ x: p[0] ?? 0, y: p[1] ?? 0 }));
  const { mesh } = buildCurve(pts);
  mesh.userData.creator = "curve";
  viewer.addMesh(mesh, "mesh");
  return { created: "curve", points: pts.length, nurbsKind: "catmull-rom" };
});

// ── Tier 3 handlers: SdRevolve / SdSweep / SdLoft (#78) ─────────────────────

// Resolve a Curve from handler args: accepts inline {kind, ...} or a
// point-array shorthand {points:[...]}.
function resolveCurve(arg: unknown): Curve {
  if (arg && typeof arg === "object" && !Array.isArray(arg)) {
    const obj = arg as Record<string, unknown>;
    if (obj.kind === "line" && Array.isArray(obj.from) && Array.isArray(obj.to)) {
      const [fx=0,fy=0,fz=0] = obj.from as number[];
      const [tx=0,ty=0,tz=0] = obj.to as number[];
      const len = Math.sqrt((tx-fx)**2+(ty-fy)**2+(tz-fz)**2);
      return { kind: "line", from: {x:fx,y:fy,z:fz}, to: {x:tx,y:ty,z:tz}, domain: {min:0,max:len} };
    }
    if (obj.kind === "arc" && typeof obj.radius === "number") {
      const [cx=0,cy=0,cz=0] = (obj.center as number[] | undefined) ?? [0,0,0];
      return {
        kind: "arc",
        center: {x:cx,y:cy,z:cz},
        radius: obj.radius as number,
        startAngle: (obj.startAngle as number) ?? 0,
        endAngle: (obj.endAngle as number) ?? 2*Math.PI,
        plane: { origin: {x:cx,y:cy,z:cz}, xAxis: {x:1,y:0,z:0}, yAxis: {x:0,y:1,z:0}, normal: {x:0,y:0,z:1} },
        domain: { min: 0, max: (obj.radius as number) * ((obj.endAngle as number ?? 2*Math.PI) - (obj.startAngle as number ?? 0)) },
      };
    }
    if (Array.isArray(obj.points) && (obj.points as unknown[]).length >= 2) {
      const pts = (obj.points as number[][]).map(p => ({x:p[0]??0,y:p[1]??0,z:p[2]??0}));
      const params: number[] = [0];
      for (let i = 1; i < pts.length; i++) {
        const dx=pts[i].x-pts[i-1].x, dy=pts[i].y-pts[i-1].y, dz=pts[i].z-pts[i-1].z;
        params.push(params[i-1] + Math.sqrt(dx*dx+dy*dy+dz*dz));
      }
      return { kind: "polyline", points: pts, parameters: params };
    }
  }
  throw new Error(`resolveCurve: unrecognised curve description: ${JSON.stringify(arg)}`);
}

// Build a THREE.Mesh from tessellated surface data.
function surfaceToMesh(tess: ReturnType<typeof tessellateSurface>): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(tess.positions, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(tess.normals, 3));
  geo.setAttribute("uv",       new THREE.BufferAttribute(tess.uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(tess.indices, 1));
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, color: 0xe8e0d8 }));
}

registerHandler("SdRevolve", (args) => {
  try {
    const profile = resolveCurve(args.profile);
    const [ax=0,ay=0,az=0] = (args.axisFrom as number[] | undefined) ?? [0,0,0];
    const [bx=0,by=0,bz=1] = (args.axisTo   as number[] | undefined) ?? [0,0,1];
    const start = (args.angleStart as number) ?? 0;
    const end   = (args.angleEnd   as number) ?? 2 * Math.PI;
    const axis = { from: {x:ax,y:ay,z:az}, to: {x:bx,y:by,z:bz} };
    const surface = surfaceOfRevolution(profile, axis, start, end);
    const tess = tessellateSurface(surface, 32, 64);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "revolution";
    obj.userData.creator = "revolve";
    viewer.addMesh(obj, "mesh");
    return { created: "revolution", axisFrom: args.axisFrom, axisTo: args.axisTo, angleStart: start, angleEnd: end };
  } catch (e) {
    return { error: String(e), created: null };
  }
});

registerHandler("SdSweep", (args) => {
  try {
    const profile = resolveCurve(args.profile);
    const rail    = resolveCurve((args.rail ?? args.path) as unknown);
    const surface = sweepSurface(profile, rail, { keepFrame: (args.keepFrame as boolean) ?? false });
    const tess = tessellateSurface(surface, 32, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "sweep";
    obj.userData.creator = "sweep";
    viewer.addMesh(obj, "mesh");
    return { created: "sweep" };
  } catch (e) {
    return { error: String(e), created: null };
  }
});

registerHandler("SdLoft", (args) => {
  try {
    const rawCurves = ((args.curves ?? args.sections) as unknown[] | undefined) ?? [];
    if (rawCurves.length < 2) return { error: "SdLoft requires at least 2 curves", created: null };
    const curves = rawCurves.map((c) => resolveCurve(c));
    const surface = loftSurfaces(curves, {
      closed:  (args.closed  as boolean) ?? false,
      degreeV: (args.degreeV as number)  ?? Math.min(3, curves.length - 1),
    });
    const tess = tessellateSurface(surface, 32, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "loft";
    obj.userData.creator = "loft";
    viewer.addMesh(obj, "mesh");
    return { created: "loft", curveCount: curves.length };
  } catch (e) {
    return { error: String(e), created: null };
  }
});

registerHandler("SdPlane", (args) => {
  try {
    const [ox=0,oy=0,oz=0] = (args.origin  as number[] | undefined) ?? [];
    const [ux=1,uy=0,uz=0] = (args.xAxis   as number[] | undefined) ?? [];
    const [vx=0,vy=1,vz=0] = (args.yAxis   as number[] | undefined) ?? [];
    const o  = new THREE.Vector3(ox, oy, oz);
    const uv = new THREE.Vector3(ux, uy, uz).sub(o); // edge u
    const vv = new THREE.Vector3(vx, vy, vz).sub(o); // edge v
    const c0 = o.clone();
    const c1 = o.clone().add(uv);
    const c2 = o.clone().add(uv).add(vv);
    const c3 = o.clone().add(vv);
    const positions = new Float32Array([
      c0.x, c0.y, c0.z,
      c1.x, c1.y, c1.z,
      c2.x, c2.y, c2.z,
      c3.x, c3.y, c3.z,
    ]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex([0, 1, 2, 0, 2, 3]);
    geom.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x88aacc, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.kind = "plane";
    mesh.userData.creator = "plane";
    viewer.addMesh(mesh, "mesh");
    return { created: "plane" };
  } catch (e) {
    return { error: String(e), created: null };
  }
});

registerHandler("SdSurface", (args) => {
  try {
    const raw = (args.profile ?? args.points) as unknown;
    let pts: number[][];
    if (Array.isArray(raw) && Array.isArray(raw[0])) {
      pts = raw as number[][];
    } else if (raw && typeof raw === "object" && "points" in (raw as object)) {
      pts = (raw as { points: number[][] }).points;
    } else {
      return { error: "SdSurface: provide profile with points or points array", created: null };
    }
    if (pts.length < 3) return { error: "SdSurface requires at least 3 points", created: null };
    const z0 = pts[0][2] ?? 0;
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) shape.lineTo(p[0], p[1]);
    shape.closePath();
    const geom = new THREE.ShapeGeometry(shape);
    geom.translate(0, 0, z0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x4499cc, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.userData.kind = "surface";
    mesh.userData.creator = "surface";
    viewer.addMesh(mesh, "mesh");
    return { created: "surface" };
  } catch (e) {
    return { error: String(e), created: null };
  }
});

registerHandler("SdArray", (args) => {
  const count = Math.max(1, Math.trunc((args.count as number | undefined) ?? 1));
  const spacing = (args.spacing as number[] | undefined) ?? [1, 0, 0];
  const sx = spacing[0] ?? 1;
  const sy = spacing[1] ?? 0;
  const sz = spacing[2] ?? 0;

  const cols = Math.max(1, Math.trunc((args.cols as number | undefined) ?? (args.countX as number | undefined) ?? count));
  const rows = Math.max(1, Math.trunc((args.rows as number | undefined) ?? (args.countY as number | undefined) ?? 1));
  const spacingY = (args.spacingY as number[] | undefined) ?? [0, 1, 0];
  const syx = spacingY[0] ?? 0;
  const syy = spacingY[1] ?? 1;
  const syz = spacingY[2] ?? 0;

  const target = args.target;
  const selected = getSelected()?.transformTarget ?? null;
  const active = viewer.getActiveObject();
  const baseObj = selected ?? active ?? null;

  function makePoint(position: [number, number, number]): THREE.Points {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    const obj = new THREE.Points(geom, buildPointMaterial());
    obj.userData.kind = "point";
    obj.userData.creator = "array";
    return obj;
  }

  const isPointTarget =
    target === "point" ||
    target === "SdPoint" ||
    (Array.isArray(target) && target.length >= 2) ||
    (target && typeof target === "object" && (target as Record<string, unknown>).kind === "point");

  const basePointRaw =
    Array.isArray(target)
      ? target
      : (target && typeof target === "object" && Array.isArray((target as Record<string, unknown>).position))
        ? ((target as Record<string, unknown>).position as number[])
        : ([0, 0, 0] as number[]);
  const basePoint: [number, number, number] = [
    basePointRaw[0] ?? 0,
    basePointRaw[1] ?? 0,
    basePointRaw[2] ?? 0,
  ];

  let created = 0;
  const batchObjs: THREE.Object3D[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const dx = i * sx + j * syx;
      const dy = i * sy + j * syy;
      const dz = i * sz + j * syz;
      if (isPointTarget || !baseObj) {
        const p = makePoint([basePoint[0] + dx, basePoint[1] + dy, basePoint[2] + dz]);
        viewer.addMesh(p, "mesh", { noHistory: true });
        batchObjs.push(p);
      } else {
        const clone = baseObj.clone(true);
        clone.position.set(
          baseObj.position.x + dx,
          baseObj.position.y + dy,
          baseObj.position.z + dz,
        );
        clone.userData.creator = "array";
        viewer.addMesh(clone, (clone.userData.kind as string | undefined) ?? "mesh", { noHistory: true });
        batchObjs.push(clone);
      }
      created++;
    }
  }
  pushBatchAction(batchObjs, "SdArray");

  return {
    created: isPointTarget || !baseObj ? "point-array" : "array",
    count: created,
    rows,
    cols,
    spacing: [sx, sy, sz],
  };
});

// W-4 (#360): SdSetCPlane — explicit CPlane override.
// Writes viewer.activeCPlane; kind='explicit' locks resolveCPlane to return it.
// mode='world' resets to WORLD_XY (kind='world') so per-canonical defaults resume.
registerHandler("SdSetCPlane", (args) => {
  const mode = (args.mode as string | undefined) ?? "world";
  const viewMap: Record<string, CPlane> = {
    top: WORLD_XY, bottom: WORLD_XY,
    front: WORLD_XZ, back: WORLD_XZ,
    right: WORLD_YZ, left: WORLD_YZ,
  };
  let newCPlane: CPlane;
  switch (mode) {
    case "top":
      newCPlane = { ...WORLD_XY, kind: "explicit" as const }; break;
    case "front":
      newCPlane = { ...WORLD_XZ, kind: "explicit" as const }; break;
    case "right":
      newCPlane = { ...WORLD_YZ, kind: "explicit" as const }; break;
    case "view-derived": {
      const base = viewMap[viewer.activeView] ?? WORLD_XY;
      newCPlane = { ...base, kind: "explicit" as const }; break;
    }
    case "explicit": {
      const oRaw = (args.origin as number[] | undefined) ?? [0, 0, 0];
      const xRaw = (args.xAxis  as number[] | undefined) ?? [1, 0, 0];
      const yRaw = (args.yAxis  as number[] | undefined) ?? [0, 1, 0];
      const origin = new THREE.Vector3(oRaw[0] ?? 0, oRaw[1] ?? 0, oRaw[2] ?? 0);
      const xAxis  = new THREE.Vector3(xRaw[0] ?? 1, xRaw[1] ?? 0, xRaw[2] ?? 0).normalize();
      const yAxis  = new THREE.Vector3(yRaw[0] ?? 0, yRaw[1] ?? 1, yRaw[2] ?? 0).normalize();
      const normal = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
      newCPlane = { origin, xAxis, yAxis, normal, kind: "explicit" as const }; break;
    }
    case "host-pick": {
      viewer.startHostPick((cplane) => {
        viewer.activeCPlane = cplane;
        window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
          detail: { cplane, mode: "host-pick" },
          bubbles: false,
        }));
      });
      return { mode: "host-pick", pending: true };
    }
    case "world":
    default:
      newCPlane = { ...WORLD_XY }; break;
  }
  viewer.activeCPlane = newCPlane;
  window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
    detail: { cplane: newCPlane, mode },
    bubbles: false,
  }));
  return { mode, kind: newCPlane.kind };
});

registerHandler("SdToggleCPlaneGizmo", () => {
  viewer.toggleCPlaneGizmo();
  return { toggled: true };
});

registerHandler("SdResetCPlane", () => {
  const reset: CPlane = { ...WORLD_XY };
  viewer.activeCPlane = reset;
  window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
    detail: { cplane: reset, mode: "world" },
    bubbles: false,
  }));
  return { reset: true };
});

registerHandler("SdSetUnits", (args) => {
  const sys = (args["system"] as "metric" | "imperial" | undefined) ?? "metric";
  const valid = sys === "metric" || sys === "imperial" ? sys : "metric";
  setState("unitSystem", valid);
  return { ok: true, unitSystem: valid };
});

// ---- Dimension verbs (#819 priority-2 / #832 visual closure) ----
// Each handler computes the value AND renders a scene annotation + DOM label.
// annotationUuid identifies the THREE.Object3D added to the scene for later removal.

registerHandler("SdAlignedDim", (args) => {
  const aArr = (args.a as number[] | undefined) ?? [0, 0, 0];
  const bArr = (args.b as number[] | undefined) ?? [1, 0, 0];
  const ptA = new THREE.Vector3(aArr[0] ?? 0, aArr[1] ?? 0, aArr[2] ?? 0);
  const ptB = new THREE.Vector3(bArr[0] ?? 0, bArr[1] ?? 0, bArr[2] ?? 0);
  const dist = ptA.distanceTo(ptB);
  const mid = ptA.clone().add(ptB).multiplyScalar(0.5);
  const lineObj = opBuildAnnotLine([ptA, ptB]);
  lineObj.userData.creator = "SdAlignedDim";
  viewer.addMesh(lineObj, "mesh");
  opAddLabel(formatLength(dist), mid, viewer);
  return { measured: "length", distance: parseFloat(dist.toFixed(4)), unit: "m", annotationUuid: lineObj.uuid };
});

registerHandler("SdAngularDim", (args) => {
  const vArr  = (args.vertex as number[] | undefined) ?? [0, 0, 0];
  const r1Arr = (args.ray1   as number[] | undefined) ?? [1, 0, 0];
  const r2Arr = (args.ray2   as number[] | undefined) ?? [0, 1, 0];
  const vertex = new THREE.Vector3(vArr[0] ?? 0, vArr[1] ?? 0, vArr[2] ?? 0);
  const ray1 = new THREE.Vector3(r1Arr[0] ?? 0, r1Arr[1] ?? 0, r1Arr[2] ?? 0);
  const ray2 = new THREE.Vector3(r2Arr[0] ?? 0, r2Arr[1] ?? 0, r2Arr[2] ?? 0);
  const d1 = ray1.clone().sub(vertex).normalize();
  const d2 = ray2.clone().sub(vertex).normalize();
  const angleDeg = (Math.acos(Math.max(-1, Math.min(1, d1.dot(d2)))) * 180) / Math.PI;
  const lineObj = opBuildAnnotLine([vertex, ray1, vertex, ray2]);
  lineObj.userData.creator = "SdAngularDim";
  viewer.addMesh(lineObj, "mesh");
  opAddLabel(`${angleDeg.toFixed(1)}°`, vertex, viewer);
  return { measured: "angle", angleDeg: parseFloat(angleDeg.toFixed(2)), unit: "deg", annotationUuid: lineObj.uuid };
});

registerHandler("SdAreaDim", (args) => {
  const rawPts = (args.points as number[][] | undefined) ?? [];
  if (rawPts.length < 3) return { error: "SdAreaDim requires at least 3 points", measured: null };
  let area = 0;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < rawPts.length; i++) {
    const j = (i + 1) % rawPts.length;
    area += (rawPts[i][0] ?? 0) * (rawPts[j][1] ?? 0) - (rawPts[j][0] ?? 0) * (rawPts[i][1] ?? 0);
    cx += rawPts[i][0] ?? 0; cy += rawPts[i][1] ?? 0; cz += rawPts[i][2] ?? 0;
  }
  area = Math.abs(area) / 2;
  const n = rawPts.length;
  const centroid = new THREE.Vector3(cx / n, cy / n, cz / n);
  const vec3Pts = rawPts.map((p) => new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
  const lineObj = opBuildAnnotLine([...vec3Pts, vec3Pts[0]]);
  viewer.addMesh(lineObj, "mesh");
  opAddLabel(`Area: ${formatArea(area)}`, centroid, viewer);
  return { measured: "area", area: parseFloat(area.toFixed(4)), unit: "m2", annotationUuid: lineObj.uuid };
});

registerHandler("SdVolumeDim", (args) => {
  const id = args.id as string | undefined;
  if (!id) return { error: "SdVolumeDim requires id", measured: null };
  const obj = viewer.getScene().getObjectByProperty("uuid", id);
  if (!obj) return { error: `SdVolumeDim — object not found: ${id}`, measured: null };
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  const ctr = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(ctr);
  const volume = size.x * size.y * size.z;
  const lineObj = opBuildAnnotLine([box.min, box.max]);
  viewer.addMesh(lineObj, "mesh");
  opAddLabel(`Vol: ${formatVolume(volume)}`, ctr, viewer);
  return { measured: "volume", volume: parseFloat(volume.toFixed(4)), unit: "m3", annotationUuid: lineObj.uuid };
});

registerHandler("SdLabel", (args) => {
  const text = (args.text as string | undefined) ?? "";
  if (!text) return { error: "SdLabel requires text" };
  const posArr = (args.position as number[] | undefined) ?? [0, 0, 0];
  const pt = new THREE.Vector3(posArr[0] ?? 0, posArr[1] ?? 0, posArr[2] ?? 0);
  opAddLabel(text, pt, viewer);
  return { placed: true, text };
});

registerHandler("SdTransientMeasure", (args) => {
  const aArr = (args.a as number[] | undefined) ?? [0, 0, 0];
  const bArr = (args.b as number[] | undefined) ?? [1, 0, 0];
  const ptA = new THREE.Vector3(aArr[0] ?? 0, aArr[1] ?? 0, aArr[2] ?? 0);
  const ptB = new THREE.Vector3(bArr[0] ?? 0, bArr[1] ?? 0, bArr[2] ?? 0);
  const dist = ptA.distanceTo(ptB);
  const mid = ptA.clone().add(ptB).multiplyScalar(0.5);
  const lineObj = opBuildAnnotLine([ptA, ptB]);
  viewer.getScene().add(lineObj); // audit-undo-ok — transient measurement line, no undo entry intentional
  opAddLabel(formatLength(dist), mid, viewer);
  return { measured: "length", distance: parseFloat(dist.toFixed(4)), unit: "m" };
});

// Translate position/point fields in a cluster step's params by an anchor offset.
// Steps that reference another object by UUID are returned unchanged (translation not safe).
function _translateClusterStep(params: Record<string, unknown>, anchor: number[]): Record<string, unknown> {
  if (typeof params["hostUuid"] === "string" || typeof params["uuid"] === "string") {
    return params; // UUID-referencing step — skip translation
  }
  const [dx, dy, dz] = anchor;
  const out = { ...params };
  const POINT_KEYS = ["position", "origin", "point", "start", "end", "center", "anchor"];
  const POLYLINE_KEYS = ["points", "profile", "path", "spine"];
  for (const key of POINT_KEYS) {
    const v = out[key];
    if (Array.isArray(v) && v.length >= 2 && (v as unknown[]).every(x => typeof x === "number")) {
      out[key] = [(v[0] as number) + dx, (v[1] as number) + dy, v.length >= 3 ? (v[2] as number) + dz : 0];
    }
  }
  for (const key of POLYLINE_KEYS) {
    const v = out[key];
    if (Array.isArray(v) && v.length > 0 && Array.isArray(v[0])) {
      out[key] = (v as number[][]).map(pt => {
        if (!pt.every(x => typeof x === "number")) return pt;
        const translated: number[] = [(pt[0] ?? 0) + dx, (pt[1] ?? 0) + dy];
        if (pt.length >= 3) translated.push((pt[2] ?? 0) + dz);
        return translated;
      });
    }
  }
  return out;
}

registerHandler("SdRunCluster", async (args) => {
  const name = args["name"] as string;
  const repeat = Math.max(1, typeof args["repeat"] === "number" ? (args["repeat"] as number) : 1);
  const anchorRaw = args["anchor"];
  const anchor = Array.isArray(anchorRaw) && anchorRaw.length >= 2
    ? (anchorRaw as number[])
    : null;
  const cluster = await getClusterByName(name);
  if (!cluster) return { ok: false, error: `No cluster named "${name}"` };
  const skipped: string[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const step of cluster.steps as SkillClusterStep[]) {
      const rawParams = step.params as Record<string, unknown>;
      const params = anchor ? _translateClusterStep(rawParams, anchor) : rawParams;
      if (anchor && params === rawParams && (typeof rawParams["hostUuid"] === "string" || typeof rawParams["uuid"] === "string")) {
        skipped.push(step.verb);
      }
      await dispatch(step.verb, params);
      await new Promise(res => setTimeout(res, 50));
    }
  }
  return { ok: true, ran: cluster.steps.length * repeat, skipped };
});

registerHandler("SdListClusters", async () => {
  const clusters = await listClusters();
  return { clusters: clusters.map(c => ({ name: c.name, steps: c.steps.length, createdAt: c.createdAt })) };
});

// ── SdInvokeSkill (#1116/SU-7) ────────────────────────────────────────────
// Resolves a skill by name — either a starter-library node or a saved
// CanvasCluster — then dispatches its underlying verbs in topological order.
registerHandler("SdInvokeSkill", async (args) => {
  const skillName = args["skill"] as string;
  const params = (args["params"] && typeof args["params"] === "object" && !Array.isArray(args["params"]))
    ? args["params"] as Record<string, unknown>
    : {};

  // 1. Check starter library by label
  const starter = STARTER_LIBRARY.find(d => d.label === skillName || d.id === skillName);
  if (starter) {
    await dispatch(starter.verb, { ...starter.args, ...params });
    return { ok: true, source: "starter", verb: starter.verb };
  }

  // 2. Check saved CanvasCluster by name (SU-5 graphJson clusters)
  const canvasClusters = await listCanvasClusters();
  const cluster = canvasClusters.find(c => c.name === skillName);
  if (cluster) {
    type CNode = { id: string; skillSteps: { verb: string; args: Record<string, unknown> }[]; inPorts: number; outPorts: number };
    type CEdge = { from: string; to: string };
    const { nodes, edges } = JSON.parse(cluster.graphJson) as { nodes: CNode[]; edges: CEdge[] };

    // Kahn's topo sort
    const inDegree = new Map<string, number>(nodes.map(n => [n.id, 0]));
    for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    const queue = nodes.filter(n => (inDegree.get(n.id) ?? 0) === 0).map(n => n.id);
    const order: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      order.push(cur);
      for (const e of edges) {
        if (e.from === cur) {
          const d = (inDegree.get(e.to) ?? 1) - 1;
          inDegree.set(e.to, d);
          if (d === 0) queue.push(e.to);
        }
      }
    }
    const nodeMap = new Map<string, CNode>(nodes.map(n => [n.id, n]));
    let fired = 0;
    for (const id of order) {
      const node = nodeMap.get(id);
      if (!node) continue;
      for (const step of node.skillSteps) {
        const mergedArgs = fired === 0 ? { ...step.args, ...params } : step.args;
        await dispatch(step.verb, mergedArgs);
        await new Promise(res => setTimeout(res, 50));
        fired++;
      }
    }
    return { ok: true, source: "canvas-cluster", fired };
  }

  return { ok: false, error: `No skill named "${skillName}" found in starter library or saved clusters` };
});

// ── #1829: Brep ops — Explode / Join / Rebuild / Contour ─────────────────────

registerHandler("SdExplode", (args) => {
  const targetId = args.target as string | undefined;
  if (!targetId) return { error: "SdExplode — target is required" };
  const scene = viewer.getScene();
  const obj = scene.getObjectByProperty("uuid", targetId);
  if (!obj) return { error: `SdExplode — object not found: ${targetId}` };
  if (!(obj instanceof THREE.Mesh)) return { error: "SdExplode — target must be a Mesh" };
  const geo = obj.geometry as THREE.BufferGeometry;
  const mat = obj.material as THREE.Material;
  const groups = geo.groups.length > 0 ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
  const createdUuids: string[] = [];
  for (const g of groups) {
    const faceGeo = new THREE.BufferGeometry();
    const srcPos = geo.attributes.position as THREE.BufferAttribute;
    const srcNrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
    if (geo.index) {
      const idxArr = geo.index.array;
      const triCount = Math.floor(g.count / 3);
      const pos: number[] = [];
      const nrm: number[] = [];
      for (let t = 0; t < triCount; t++) {
        for (let v = 0; v < 3; v++) {
          const i = idxArr[g.start + t * 3 + v];
          pos.push(srcPos.getX(i), srcPos.getY(i), srcPos.getZ(i));
          if (srcNrm) nrm.push(srcNrm.getX(i), srcNrm.getY(i), srcNrm.getZ(i));
        }
      }
      faceGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      if (nrm.length) faceGeo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
    } else {
      const slicedPos = (srcPos.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3);
      faceGeo.setAttribute("position", new THREE.Float32BufferAttribute(slicedPos, 3));
      if (srcNrm) {
        const slicedNrm = (srcNrm.array as Float32Array).slice(g.start * 3, (g.start + g.count) * 3);
        faceGeo.setAttribute("normal", new THREE.Float32BufferAttribute(slicedNrm, 3));
      }
    }
    faceGeo.computeBoundingBox();
    const faceMesh = new THREE.Mesh(faceGeo, (mat as THREE.Material).clone());
    faceMesh.userData.kind = "brep";
    faceMesh.userData.creator = "explode-face";
    faceMesh.userData.dispatchArgs = args;
    faceMesh.position.copy(obj.position);
    faceMesh.quaternion.copy(obj.quaternion);
    faceMesh.scale.copy(obj.scale);
    viewer.addMesh(faceMesh, "brep", { noHistory: true });
    createdUuids.push(faceMesh.uuid);
  }
  scene.remove(obj); // audit-undo-ok — tracked by pushReplaceAction below
  pushReplaceAction(createdUuids.length === 1
    ? scene.getObjectByProperty("uuid", createdUuids[0]) as THREE.Mesh
    : (() => { const m = new THREE.Mesh(); m.uuid = createdUuids[0]; return m; })(),
    [obj], "explode");
  return { exploded: createdUuids, faceCount: createdUuids.length };
});

registerHandler("SdJoin", (args) => {
  const targetIds = args.targets as string[] | undefined;
  if (!Array.isArray(targetIds) || targetIds.length < 2)
    return { error: "SdJoin — targets must be an array of at least 2 UUIDs" };
  const scene = viewer.getScene();
  const meshes: THREE.Mesh[] = [];
  for (const id of targetIds) {
    const obj = scene.getObjectByProperty("uuid", id);
    if (!obj) return { error: `SdJoin — object not found: ${id}` };
    if (!(obj instanceof THREE.Mesh)) return { error: `SdJoin — target ${id} is not a Mesh` };
    meshes.push(obj);
  }
  const positions: number[] = [];
  const normals: number[] = [];
  let indexOffset = 0;
  const indices: number[] = [];
  for (const m of meshes) {
    const g = m.geometry as THREE.BufferGeometry;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nrm = g.attributes.normal as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m.matrixWorld);
      positions.push(v.x, v.y, v.z);
      if (nrm) normals.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) indices.push(g.index.getX(i) + indexOffset);
    }
    indexOffset += pos.count;
  }
  const joinedGeo = new THREE.BufferGeometry();
  joinedGeo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length) joinedGeo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  if (indices.length) joinedGeo.setIndex(indices);
  if (!normals.length) joinedGeo.computeVertexNormals();
  joinedGeo.computeBoundingBox();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide });
  const joined = new THREE.Mesh(joinedGeo, mat);
  joined.userData.kind = "brep";
  joined.userData.creator = "join";
  joined.userData.dispatchArgs = args;
  for (const m of meshes) scene.remove(m); // audit-undo-ok — tracked by pushReplaceAction below
  viewer.addMesh(joined, "brep", { noHistory: true });
  pushReplaceAction(joined, meshes, "join");
  return { created: joined.uuid, faceCount: meshes.length };
});

registerHandler("SdRebuild", (args) => {
  const targetId = args.target as string | undefined;
  if (!targetId) return { error: "SdRebuild — target is required" };
  const scene = viewer.getScene();
  const obj = scene.getObjectByProperty("uuid", targetId);
  if (!obj) return { error: `SdRebuild — object not found: ${targetId}` };
  if (!(obj instanceof THREE.Mesh)) return { error: "SdRebuild — target must be a Mesh" };
  const count = (args.count as number | undefined) ?? 0;
  const geo = obj.geometry as THREE.BufferGeometry;
  const vertexCount = (geo.attributes.position as THREE.BufferAttribute).count;
  const targetCount = count > 0 ? count : vertexCount * 2;
  return { rebuilt: obj.uuid, originalVertices: vertexCount, targetCount, note: "rebuild scheduled — full NURBS reparameterisation deferred to GPU kernel" };
});

registerHandler("SdContour", (args) => {
  const targetId = args.target as string | undefined;
  if (!targetId) return { error: "SdContour — target is required" };
  const scene = viewer.getScene();
  const obj = scene.getObjectByProperty("uuid", targetId);
  if (!obj) return { error: `SdContour — object not found: ${targetId}` };
  if (!(obj instanceof THREE.Mesh)) return { error: "SdContour — target must be a Mesh" };
  const interval = (args.interval as number | undefined) ?? 1;
  const countArg = (args.count as number | undefined) ?? 5;
  obj.geometry.computeBoundingBox();
  const bbox = obj.geometry.boundingBox!;
  const zMin = bbox.min.z + (obj.position?.z ?? 0);
  const zMax = bbox.max.z + (obj.position?.z ?? 0);
  const zRange = zMax - zMin;
  const sliceCount = interval > 0 ? Math.max(1, Math.floor(zRange / interval)) : countArg;
  const levels: number[] = [];
  for (let i = 1; i <= sliceCount; i++) levels.push(zMin + (zRange * i) / (sliceCount + 1));
  return { target: targetId, contourLevels: levels, sliceCount: levels.length, interval };
});

// Install shim handlers for every dictionary verb that doesn't have a native
// handler yet. This makes all 66+ verbs reachable by the agent (#58 Tier 0).
// Explicit registerHandler() calls above take priority — installDefaultHandlers
// skips any canonical name that already has a handler.
installDefaultHandlers();

const scenePanel = new ScenePanel(scenePanelEl, viewer);

registerHandler("SdClearScene", () => {
  viewer.clearScene();
  clearHistory();
  scenePanel.clear();
  resetRibbonElementTypes();
  clearSelected();
  window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
  return { ok: true, cleared: true };
});

// Layer → scene sync (#826): propagate color + visibility changes to scene meshes.
// Fires on every layerStore change (color, visibility, add, remove).
// Skips CSG join-display meshes (userData.isJoinDisplay === true).
layerStore.subscribe(() => {
  viewer.getScene().traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.userData.isJoinDisplay === true) return;
    const lid = obj.userData.layerId as string | undefined;
    if (!lid) return;
    const layer = layerStore.get(lid);
    if (!layer) return;
    const mat = obj.material;
    if (mat && "color" in mat && (mat as THREE.MeshStandardMaterial).color) {
      (mat as THREE.MeshStandardMaterial).color.setStyle(layer.color);
    }
    obj.visible = layer.visible;
  });
});

// Drawing layer → scene sync (#964): propagate visibility + color to sketch objects.
drawingLayerStore.subscribe(() => {
  viewer.getScene().traverse((obj) => {
    const dlId = obj.userData.drawingLayerId as string | undefined;
    if (!dlId) return;
    const layer = drawingLayerStore.get(dlId);
    if (!layer) return;
    obj.visible = layer.visible;
    const mat = (obj as THREE.Mesh).material;
    if (mat && "color" in mat && (mat as THREE.LineBasicMaterial).color) {
      (mat as THREE.LineBasicMaterial).color.setStyle(layer.color);
    }
  });
});

// ── Roof selection inspector (#754) ─────────────────────────────────────────
// When a roof mesh is selected, show parameter sliders in #element-inspector.
// Changing sliders replaces the roof mesh with a re-dispatched SdRoof call.
const _roofInspectorEl = ((): HTMLElement => {
  let el = document.getElementById("element-inspector");
  if (!el) {
    el = document.createElement("div");
    el.id = "element-inspector";
    el.style.cssText = "display:none;position:fixed;bottom:1rem;right:1rem;background:rgba(20,20,20,0.93);border:1px solid #444;border-radius:6px;padding:10px 14px;min-width:210px;z-index:200;font:13px/1.5 sans-serif;color:#ddd;";
    document.body.appendChild(el);
  }
  return el;
})();

let _roofInspectorMeshUuid: string | null = null;

function _showRoofInspector(mesh: THREE.Mesh): void {
  const p: RoofParams = (mesh.userData.roofParams as RoofParams) ?? { type: "pitched", pitchDeg: 30, overhang: 0.5, thickness: 0.15 };
  _roofInspectorMeshUuid = mesh.uuid;

  const mkSlider = (label: string, key: keyof RoofParams, minM: number, maxM: number, stepM: number, unit: string) => {
    const isLength = unit === "m";
    const isImperial = isLength && unitLabel() === "ft";
    const FT = 3.28084;
    const toDisp = (m: number) => isImperial ? Math.round(m * FT * 100) / 100 : m;
    const toMeters = (d: number) => isImperial ? d / FT : d;
    const dispUnit = isLength ? unitLabel() : unit;
    const min = toDisp(minM), max = toDisp(maxM), step = Math.round(toDisp(stepM) * 1000) / 1000;

    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0;";
    const lbl = document.createElement("span");
    lbl.style.cssText = "min-width:70px;font-size:11px;color:#aaa;";
    lbl.textContent = label;
    const val = document.createElement("span");
    val.style.cssText = "min-width:32px;text-align:right;font-size:11px;";
    const curM = (p[key] as number) ?? (key === "pitchDeg" ? 30 : key === "overhang" ? 0.5 : 0.15);
    const cur = toDisp(curM);
    val.textContent = `${cur}${dispUnit}`;
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step);
    inp.value = String(cur); inp.style.cssText = "flex:1;";
    inp.addEventListener("input", () => {
      val.textContent = `${parseFloat(inp.value)}${dispUnit}`;
    });
    inp.addEventListener("change", () => {
      const dispVal = parseFloat(inp.value);
      const metersVal = isLength ? toMeters(dispVal) : dispVal;
      const updated: Record<string, unknown> = { ...p, [key]: metersVal };
      const existing = viewer.getScene().getObjectByProperty("uuid", _roofInspectorMeshUuid ?? "");
      if (!existing) return;
      const dispArgs = (existing.userData.dispatchArgs as Record<string, unknown>) ?? {};
      dispatchSync("SdRoof", {
        ...dispArgs,
        roofType: updated.type as string,
        pitchDeg: updated.pitchDeg as number,
        overhang: updated.overhang as number,
        thickness: updated.thickness as number,
      });
      // Remove the old mesh after dispatch added the new one
      const stillOld = viewer.getScene().getObjectByProperty("uuid", _roofInspectorMeshUuid ?? "");
      if (stillOld) viewer.removeObject(stillOld); // audit-undo-ok — inspector re-builds from dispatch, undo tracks the dispatch action
    });
    row.appendChild(lbl); row.appendChild(val); row.appendChild(inp);
    return row;
  };

  const typeMap: Array<[RoofParams["type"], string]> = [
    ["pitched", "Gable"], ["hip", "Hip"], ["shed", "Shed"], ["flat", "Flat"],
  ];
  const typeRow = document.createElement("div");
  typeRow.style.cssText = "margin:2px 0 6px;";
  const typeLbl = document.createElement("span");
  typeLbl.style.cssText = "font-size:11px;color:#aaa;margin-right:6px;";
  typeLbl.textContent = "Type";
  const typeSel = document.createElement("select");
  typeSel.style.cssText = "background:#333;color:#ddd;border:1px solid #555;border-radius:3px;padding:1px 4px;font-size:12px;";
  for (const [val, lbl] of typeMap) {
    const opt = document.createElement("option");
    opt.value = val ?? ""; opt.textContent = lbl;
    if (val === p.type) opt.selected = true;
    typeSel.appendChild(opt);
  }
  typeSel.addEventListener("change", () => {
    (p as Record<string, unknown>).type = typeSel.value;
  });
  typeRow.appendChild(typeLbl); typeRow.appendChild(typeSel);

  _roofInspectorEl.innerHTML = "";
  const title = document.createElement("div");
  title.style.cssText = "font-size:12px;font-weight:600;margin-bottom:6px;color:#fff;";
  title.textContent = "Roof";
  _roofInspectorEl.appendChild(title);
  _roofInspectorEl.appendChild(typeRow);
  _roofInspectorEl.appendChild(mkSlider("Pitch", "pitchDeg", 5, 70, 5, "°"));
  _roofInspectorEl.appendChild(mkSlider("Overhang", "overhang", 0, 2, 0.1, "m"));
  _roofInspectorEl.appendChild(mkSlider("Thickness", "thickness", 0.05, 0.5, 0.05, "m"));
  _roofInspectorEl.style.display = "";
}

// ── Shared inspector helpers ──────────────────────────────────────────────────

function _mkInspectorSlider(
  label: string, minM: number, maxM: number, stepM: number, curM: number, unit: string,
  onChange: (metersVal: number) => void,
): HTMLElement {
  const isLength = unit === "m";
  const isImperial = isLength && unitLabel() === "ft";
  const FT = 3.28084;
  const toDisp = (m: number) => isImperial ? Math.round(m * FT * 100) / 100 : m;
  const toMeters = (d: number) => isImperial ? d / FT : d;
  const dispUnit = isLength ? unitLabel() : unit;
  const min = toDisp(minM), max = toDisp(maxM), step = Math.round(toDisp(stepM) * 1000) / 1000;
  const cur = toDisp(curM);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:6px;margin:4px 0;";
  const lbl = document.createElement("span");
  lbl.style.cssText = "min-width:70px;font-size:11px;color:#aaa;";
  lbl.textContent = label;
  const val = document.createElement("span");
  val.style.cssText = "min-width:36px;text-align:right;font-size:11px;";
  val.textContent = `${cur}${dispUnit}`;
  const inp = document.createElement("input");
  inp.type = "range"; inp.min = String(min); inp.max = String(max); inp.step = String(step);
  inp.value = String(cur); inp.style.cssText = "flex:1;";
  inp.addEventListener("input", () => { val.textContent = `${parseFloat(inp.value)}${dispUnit}`; });
  inp.addEventListener("change", () => { onChange(isLength ? toMeters(parseFloat(inp.value)) : parseFloat(inp.value)); });
  row.appendChild(lbl); row.appendChild(val); row.appendChild(inp);
  return row;
}

function _inspectorTitle(text: string): HTMLElement {
  const el = document.createElement("div");
  el.style.cssText = "font-size:12px;font-weight:600;margin-bottom:6px;color:#fff;";
  el.textContent = text;
  return el;
}

// ── Stair inspector ───────────────────────────────────────────────────────────

let _stairInspectorGroupUuid: string | null = null;

function _showStairInspector(group: THREE.Object3D): void {
  const sp = group.userData.stairParams as { actualRiser: number; actualTread: number; nRisers: number; totalRise: number } | undefined;
  _stairInspectorGroupUuid = group.uuid;
  _roofInspectorMeshUuid = null;

  _roofInspectorEl.innerHTML = "";
  _roofInspectorEl.appendChild(_inspectorTitle("Stair"));

  if (sp) {
    const info = document.createElement("div");
    info.style.cssText = "padding:2px 8px 4px; font-size:10px; color:var(--ink-dim);";
    info.textContent = `${sp.nRisers} steps · rise ${(sp.totalRise * 1000 | 0) / 1000}m`;
    _roofInspectorEl.appendChild(info);
  }

  _roofInspectorEl.appendChild(_mkInspectorSlider("Riser", 0.10, 0.20, 0.005, sp?.actualRiser ?? 0.1778, "m", (v) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _stairInspectorGroupUuid ?? "");
    if (!cur) return;
    const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
    const params = cur.userData.stairParams as { actualRiser: number; actualTread: number } | undefined;
    dispatchSync("SdStair", { ...da, riser: v, tread: params?.actualTread ?? 0.2794 });
    viewer.removeObject(cur);
  }));
  _roofInspectorEl.appendChild(_mkInspectorSlider("Tread", 0.254, 0.356, 0.005, sp?.actualTread ?? 0.2794, "m", (v) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _stairInspectorGroupUuid ?? "");
    if (!cur) return;
    const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
    const params = cur.userData.stairParams as { actualRiser: number; actualTread: number } | undefined;
    dispatchSync("SdStair", { ...da, riser: params?.actualRiser ?? 0.1778, tread: v });
    viewer.removeObject(cur);
  }));
  _roofInspectorEl.style.display = "";
}

// ── Door inspector ────────────────────────────────────────────────────────────

let _doorInspectorMeshUuid: string | null = null;

function _showDoorInspector(mesh: THREE.Mesh): void {
  _doorInspectorMeshUuid = mesh.uuid;
  _roofInspectorMeshUuid = null;
  _stairInspectorGroupUuid = null;
  const curW = (mesh.userData.voidW as number | undefined) ?? DEFAULT_DOOR_W;
  const curH = (mesh.userData.voidH as number | undefined) ?? DEFAULT_DOOR_H;

  _roofInspectorEl.innerHTML = "";
  _roofInspectorEl.appendChild(_inspectorTitle("Door"));

  const redispatch = (w: number, h: number) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _doorInspectorMeshUuid ?? "");
    if (!cur) return;
    const da = (cur.userData.dispatchArgs as Record<string, unknown>) ?? {};
    dispatchSync("SdDoor", { ...da, width: w, height: h });
    viewer.removeObject(cur);
  };

  let liveW = curW, liveH = curH;
  _roofInspectorEl.appendChild(_mkInspectorSlider("Width",  0.61, 1.22, 0.025, curW, "m", (v) => { liveW = v; redispatch(liveW, liveH); }));
  _roofInspectorEl.appendChild(_mkInspectorSlider("Height", 0.61, 2.44, 0.025, curH, "m", (v) => { liveH = v; redispatch(liveW, liveH); }));
  _roofInspectorEl.style.display = "";
}

// ── Wall height inspector ─────────────────────────────────────────────────────

let _wallInspectorMeshUuid: string | null = null;

function _showWallInspector(mesh: THREE.Object3D): void {
  _wallInspectorMeshUuid = mesh.uuid;
  _roofInspectorMeshUuid = null;
  _stairInspectorGroupUuid = null;
  _doorInspectorMeshUuid = null;
  const curH = (mesh.userData.wallHeight as number | undefined) ?? DEFAULT_WALL_HEIGHT;

  _roofInspectorEl.innerHTML = "";
  _roofInspectorEl.appendChild(_inspectorTitle("Wall"));
  _roofInspectorEl.appendChild(_mkInspectorSlider("Height", 2.13, 4.27, 0.05, curH, "m", (v) => {
    const cur = viewer.getScene().getObjectByProperty("uuid", _wallInspectorMeshUuid ?? "");
    // Group walls arise after addVoidToWallObject cuts a void (#1537).
    if (cur instanceof THREE.Group) rebuildGroupWallHeight(cur, v);
    else if (cur instanceof THREE.Mesh) rebuildWallParams(cur, { height: v });
  }));
  _roofInspectorEl.style.display = "";
}

// ── Shared hide helper ────────────────────────────────────────────────────────

function _hideInspector(): void {
  _roofInspectorEl.style.display = "none";
  _roofInspectorMeshUuid = null;
  _stairInspectorGroupUuid = null;
  _doorInspectorMeshUuid = null;
  _wallInspectorMeshUuid = null;
}

window.addEventListener("viewer:select", (e) => {
  const uuid = (e as CustomEvent<{ uuid: string | null }>).detail?.uuid;
  if (!uuid) { _hideInspector(); return; }
  const obj = viewer.getScene().getObjectByProperty("uuid", uuid);
  const creator = obj?.userData?.creator as string | undefined;
  if (creator === "roof" && obj instanceof THREE.Mesh) {
    _stairInspectorGroupUuid = null; _doorInspectorMeshUuid = null; _wallInspectorMeshUuid = null;
    _showRoofInspector(obj);
  } else if (creator === "stair") {
    // Walk up to find the stair group (has stairParams). Selected obj may be a
    // flight wrapper (polyline/curve stairs) or direct child of the stair group.
    let stairGroup: THREE.Object3D | null = null;
    let cur: THREE.Object3D | null = obj ?? null;
    while (cur) {
      if (cur.userData?.stairParams) { stairGroup = cur; break; }
      cur = cur.parent;
    }
    if (stairGroup) {
      _showStairInspector(stairGroup);
    } else {
      _hideInspector();
    }
  } else if ((creator === "door" || creator === "SdDoor") && obj instanceof THREE.Mesh) {
    _showDoorInspector(obj);
  } else if (creator === "wall" && (obj instanceof THREE.Mesh || obj instanceof THREE.Group)) {
    _showWallInspector(obj);
  } else {
    _hideInspector();
  }
});

// Enable export buttons once the agent completes a turn with dispatches.
// The dispatch path (IfcWall, SdBox, etc.) doesn't go through the replicad worker,
// so currentSource is never set to "prompt" — all export buttons stay disabled.
// Fix: listen for turn-complete and promote source when verbs were dispatched.
window.addEventListener("agent:turn-complete", (e) => {
  const verbs = (e as CustomEvent<{ verbs: string[] }>).detail?.verbs;
  if (verbs && verbs.length > 0 && currentSource.kind === "none") {
    currentSource = { kind: "prompt", demoId: currentDemo.id };
    refreshExportButtons();
  }
});

// Isolate status bar indicator — show/hide #sb-isolate on viewer:isolate-changed.
document.addEventListener("viewer:isolate-changed", (e) => {
  const cell = document.getElementById("sb-isolate");
  if (!cell) return;
  const uuid = (e as CustomEvent<{ uuid: string | null }>).detail?.uuid;
  cell.style.display = uuid ? "" : "none";
});

// #1600/#1601: surface sd:status events from non-main-ts modules (join-groups, cmdk).
window.addEventListener("sd:status", (e) => {
  const { msg, kind } = (e as CustomEvent<{ msg: string; kind: "ok" | "err" | "info" | "warn" | "" }>).detail;
  setStatus(msg, kind);
});

// Navigation hotkeys — Blender-numpad keymap, with letter fallbacks for
// keyboards without a numpad. Captured at window level but ignored if the
// user is typing in any input/textarea/contenteditable.
window.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (getOpPhase()) return; // op-tool active — coord input takes priority
  if (ptIsCoordInputActive()) return; // coord input visible — block navigation shortcuts
  if (Date.now() - getLastOpFinishMs() < 300) return; // #1186: 300ms cooldown after op-tool finishes
  // Numpad first; falls through to letter keys for laptops.
  switch (e.key) {
    case "1": case "Numpad1": viewer.setView("front"); break;
    case "3": case "Numpad3": viewer.setView("right"); break;
    case "7": case "Numpad7": viewer.setView("top"); break;
    case "9": case "Numpad9": viewer.setView("iso"); break;
    case "5": case "Numpad5": viewer.setView("extents"); break;
    case "f": case "F":       viewer.setView("extents"); break;
    case "d": case "D":       toggleDraftingStyle(); break;
    default: return;
  }
  e.preventDefault();
});

// Ctrl/Cmd hotkeys: undo/redo (#27) and select-all (#31).
window.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === "z" || e.key === "Z") {
    if (e.shiftKey) {
      if (redo(viewer)) e.preventDefault();
    } else {
      if (undo(viewer)) e.preventDefault();
    }
  } else if (e.key === "y" || e.key === "Y") {
    if (redo(viewer)) e.preventDefault();
  } else if (e.shiftKey && (e.key === "a" || e.key === "A")) {
    e.preventDefault();
    dispatchSync("selectAll", {});
  }
});

// Drafting-style toggle (#173 Gap 2). Walks the active scene root, adds
// EdgesGeometry overlays + flat paper-tone fill on first call; restores on
// second call. Surfaced via "D" hotkey above and Cmd-K palette command.
function toggleDraftingStyle(): void {
  const root = viewer.getActiveObject();
  if (!root) return;
  if (isDrafting(root)) removeDrafting(root);
  else applyDrafting(root);
}
// Expose for cmdk.ts and external testing.
(window as unknown as { __toggleDrafting?: () => void }).__toggleDrafting = toggleDraftingStyle;

// Worker boot. Vite resolves the URL + format=es per vite.config.ts worker block.
// `let` — reassigned by spawnWorker() after each IFC load to reclaim wasm linear memory.
let worker: Worker;
let nextId = 1;
let pendingStl: ArrayBuffer | null = null;
let pendingStep: ArrayBuffer | null = null;

// Source mode tracking — drives which export buttons are enabled.
type Source =
  | { kind: "none" }
  | { kind: "prompt"; demoId: string }
  | { kind: "file"; format: string; filename: string };

let currentSource: Source = { kind: "none" };

// Pending requests from the file path. Worker responses arrive on the same
// onmessage handler; we use a numeric id + callbacks map to route.
type WorkerCallback = (msg: WorkerOut) => void;
const workerCallbacks = new Map<number, WorkerCallback>();

function setStatus(msg: string, kind: "ok" | "err" | "info" | "warn" | "" = "") {
  status.textContent = msg;
  status.className = `status${kind ? " " + kind : ""}`;
}

let workerReady = false;
const pendingRuns: Array<() => void> = [];

// Recycle counter exposed for gemma-verify surface assertion.
(window as any).__worker_recycle_count = 0;

function spawnWorker(): void {
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const msg = ev.data;
    if (msg.type === "ready") {
      workerReady = true;
      runBtn.disabled = false;
      setStatus("OpenCascade ready.", "info");
      pendingRuns.forEach((fn) => fn());
      pendingRuns.length = 0;
      initSceneRestore();
      loadLevelLocks(); // restore per-level lock state from IDB (#1752)
      return;
    }

    // Route worker messages with id field via callbacks map first; fall through
    // to the legacy run-ok / run-error handlers if no callback registered.
    if ("id" in msg) {
      const cb = workerCallbacks.get((msg as any).id);
      if (cb) {
        workerCallbacks.delete((msg as any).id);
        cb(msg);
        return;
      }
    }

    if (msg.type === "run-error") {
      setStatus(`Error: ${msg.error}`, "err");
      runBtn.disabled = false;
      refreshExportButtons();
      return;
    }
    if (msg.type === "run-ok") {
      viewer.setMesh(msg.mesh, msg.bounds);
      clearHistory();
      pendingStl  = msg.stl.byteLength  > 0 ? msg.stl  : null;
      pendingStep = msg.step?.byteLength > 0 ? msg.step : null;
      currentSource = { kind: "prompt", demoId: currentDemo.id };
      setStatus(
        `${shortLabel(currentDemo.label)} · ${formatBounds(msg.bounds)} · ready to export`,
        "ok",
      );
      // Approximate triangle count from worker-emitted mesh.
      const promptTris = msg.mesh.indices?.length
        ? msg.mesh.indices.length / 3
        : (msg.mesh.vertices?.length ?? 0) / 9;
      scenePanel.update({
        format: "replicad",
        triangles: Math.round(promptTris),
        filename: shortLabel(currentDemo.label),
      });
      runBtn.disabled = false;
      refreshExportButtons();
      window.dispatchEvent(
        new CustomEvent("gemma:run-ok", {
          detail: { js: jsSource.value, label: shortLabel(currentDemo.label) },
        }),
      );
    }
  };
}

function terminateAndRecycle(): void {
  worker.terminate();
  workerReady = false;
  workerCallbacks.clear();
  (window as any).__worker_recycle_count++;
  spawnWorker();
}

// Initial boot.
spawnWorker();

function formatBounds(b: { min: [number, number, number]; max: [number, number, number] }): string {
  const dx = b.max[0] - b.min[0];
  const dy = b.max[1] - b.min[1];
  const dz = b.max[2] - b.min[2];
  return `${formatLength(dx)} × ${formatLength(dy)} × ${formatLength(dz)}`;
}

// "1. Wall (5.5m × 0.2m × 2.8m)" → "Wall"
function shortLabel(label: string): string {
  const stripped = label.replace(/^\d+\.\s*/, "").replace(/\s*\(.*\)\s*$/, "").trim();
  return stripped || label;
}

// Populate dropdowns.
DEMOS.forEach((d, i) => {
  const opt = document.createElement("option");
  opt.value = String(i);
  opt.textContent = d.label;
  promptSelect.appendChild(opt);
});

SAMPLES.forEach((s) => {
  const opt = document.createElement("option");
  opt.value = s.id;
  opt.textContent = s.label;
  if (s.note) opt.title = s.note;
  sampleSelect.appendChild(opt);
});

let currentDemo: DemoPrompt = DEMOS[0];
let currentParams: Record<string, number> = {};

function loadDemo(idx: number) {
  currentDemo = DEMOS[idx];
  promptText.value = currentDemo.prompt;
  buildSliders(currentDemo);
  jsSource.value = applyParams(currentDemo.js, currentParams);
}

function buildSliders(demo: DemoPrompt) {
  paramSliders.innerHTML = "";
  currentParams = {};
  if (!demo.params || demo.params.length === 0) {
    paramPanel.classList.add("hidden");
    return;
  }
  paramPanel.classList.remove("hidden");

  for (const p of demo.params) {
    currentParams[p.name] = p.default;

    const row = document.createElement("div");
    row.className = "slider-row";

    const label = document.createElement("label");
    label.textContent = p.label;
    label.htmlFor = `slider-${p.name}`;

    const valueSpan = document.createElement("span");
    valueSpan.className = "value";
    valueSpan.textContent = p.default.toString();

    const input = document.createElement("input");
    input.id = `slider-${p.name}`;
    input.type = "range";
    input.min = String(p.min);
    input.max = String(p.max);
    input.step = String(p.step);
    input.value = String(p.default);

    let timer: number | undefined;
    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      currentParams[p.name] = v;
      valueSpan.textContent = formatParam(v, p);
      jsSource.value = applyParams(currentDemo.js, currentParams);
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => runJs(jsSource.value), 90);
    });

    row.appendChild(label);
    row.appendChild(valueSpan);
    row.appendChild(input);
    paramSliders.appendChild(row);
  }
}

function formatParam(v: number, p: Param): string {
  if (p.step >= 1) return v.toFixed(0);
  if (p.step >= 0.1) return v.toFixed(1);
  return v.toFixed(2);
}

function runJs(js: string) {
  const send = () => {
    runBtn.disabled = true;
    refreshExportButtons(true);
    setStatus("Running...", "info");
    worker.postMessage({ type: "run", id: nextId++, js });
  };
  if (workerReady) send();
  else pendingRuns.push(send);
}

promptSelect.addEventListener("change", () => {
  loadDemo(Number(promptSelect.value));
});

runBtn.addEventListener("click", () => {
  runJs(jsSource.value);
});

// --- Source mode toggle ---

function setMode(mode: "prompt" | "file") {
  if (mode === "prompt") {
    modePromptBtn.classList.add("active");
    modePromptBtn.setAttribute("aria-selected", "true");
    modeFileBtn.classList.remove("active");
    modeFileBtn.setAttribute("aria-selected", "false");
    promptPanel.classList.remove("hidden");
    filePanel.classList.add("hidden");
    runBtn.disabled = !workerReady;
  } else {
    modeFileBtn.classList.add("active");
    modeFileBtn.setAttribute("aria-selected", "true");
    modePromptBtn.classList.remove("active");
    modePromptBtn.setAttribute("aria-selected", "false");
    promptPanel.classList.add("hidden");
    filePanel.classList.remove("hidden");
    runBtn.disabled = true;
    paramPanel.classList.add("hidden");
  }
}

modePromptBtn.addEventListener("click", () => setMode("prompt"));
modeFileBtn.addEventListener("click", () => setMode("file"));

// --- File-load flow ---

async function handleFile(file: File): Promise<void> {
  const fmt = detectFormat(file.name);
  fileNameLabel.textContent = file.name;
  fileNameLabel.classList.remove("muted");
  if (!isSupported(fmt)) {
    setStatus(`Unsupported format: .${fmt} — try .ifc / .glb / .gltf / .obj / .stl / .step`, "err");
    return;
  }
  setStatus(`Reading ${file.name} (${fmt.toUpperCase()})...`, "info");

  const buffer = await file.arrayBuffer();

  if (MAIN_THREAD_FORMATS.has(fmt)) {
    try {
      const scene = await loadMainThreadFormat(buffer, fmt);
      finalizeFileLoad(scene, file.name);
    } catch (e) {
      setStatus(`Failed to parse ${file.name}: ${(e as Error).message}`, "err");
    }
    return;
  }

  if (WORKER_FORMATS.has(fmt)) {
    if (!workerReady) {
      setStatus("Waiting for OpenCascade WASM to finish loading...", "info");
      pendingRuns.push(() => handleFile(file));
      return;
    }
    if (fmt === "ifc") {
      setStatus(`Parsing ${file.name} via web-ifc... (may take a few seconds)`, "info");
      const id = nextId++;
      workerCallbacks.set(id, (msg) => {
        if (msg.type === "load-ifc-ok") {
          buildIfcMesh(msg, file.name).then((scene) => {
            finalizeFileLoad(scene, file.name);
            window.dispatchEvent(new CustomEvent("viewer:ifc-loaded", { detail: { filename: file.name } }));
            dispatchSync("SdZoomExtents", {});
            terminateAndRecycle();
          });
        } else if (msg.type === "load-ifc-error") {
          setStatus(`IFC parse failed: ${msg.error}`, "err");
          terminateAndRecycle();
        }
      });
      worker.postMessage({ type: "load-ifc", id, bytes: buffer }, [buffer]);
    } else if (fmt === "step" || fmt === "stp" || fmt === "iges" || fmt === "igs" || fmt === "brep") {
      setStatus(`Parsing ${file.name} via OpenCascade... (may take a few seconds)`, "info");
      const id = nextId++;
      workerCallbacks.set(id, (msg) => {
        if (msg.type === "load-step-ok") {
          buildStepMesh(msg, file.name, fmt).then((scene) => finalizeFileLoad(scene, file.name));
        } else if (msg.type === "load-step-error") {
          setStatus(`${fmt.toUpperCase()} parse failed: ${msg.error}`, "err");
        }
      });
      worker.postMessage(
        { type: "load-step", id, bytes: buffer, format: fmt as any },
        [buffer],
      );
    }
  }
}

function finalizeFileLoad(scene: LoadedScene, filename: string) {
  viewer.setObject(scene.object, scene.bounds);
  clearHistory(); // file load replaces the full scene; stale undo refs would crash
  pendingStl = null;  // STL/STEP are replicad-only; loaded-file path doesn't ship them.
  pendingStep = null;
  currentSource = { kind: "file", format: scene.format, filename };
  setStatus(scene.summary, "ok");
  // Pull schema/entityCount out of the summary for IFC; other formats
  // omit them and the panel just shows format + triangles.
  const summary: SceneSummary = {
    format: scene.format,
    triangles: scene.triangles,
    filename,
    hierarchy: scene.hierarchy,
  };
  // Summary string for IFC looks like
  //   "<filename> · 7,123 entities · 56,832 triangles · IFC4"
  const m = scene.summary.match(/(\d[\d,]*)\s+entit/i);
  if (m) summary.entityCount = parseInt(m[1].replace(/,/g, ""), 10);
  const sm = scene.summary.match(/IFC[24X]+/i);
  if (sm) summary.schema = sm[0].toUpperCase();
  scenePanel.update(summary);
  if (summary.hierarchy && summary.hierarchy.length > 0) {
    const classCount = new Map<string, number>();
    for (const el of summary.hierarchy) classCount.set(el.ifcClass, (classCount.get(el.ifcClass) ?? 0) + 1);
    setRibbonElementTypes([...classCount.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([cls, count]) => ({ cls, count })));
  } else {
    resetRibbonElementTypes();
  }
  refreshExportButtons();
}

// File picker
filePickBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
});

// IFC-specific file picker triggered from File menu "Import IFC…"
window.addEventListener("file:open-ifc", () => {
  let ifcPicker = document.getElementById("ifc-file-picker") as HTMLInputElement | null;
  if (!ifcPicker) {
    ifcPicker = document.createElement("input");
    ifcPicker.type = "file";
    ifcPicker.id = "ifc-file-picker";
    ifcPicker.accept = ".ifc";
    ifcPicker.style.display = "none";
    document.body.appendChild(ifcPicker);
    ifcPicker.addEventListener("change", () => {
      const f = ifcPicker!.files?.[0];
      if (f) handleFile(f);
      ifcPicker!.value = "";
    });
  }
  ifcPicker.click();
});

// Test-automation: load an IFC from a URL (e.g. for gemma-verify-raw surface)
(window as Window & { __importIfcFromUrl?: (url: string) => Promise<void> }).__importIfcFromUrl = async (url: string) => {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`fetch ${url}: HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const name = url.split("/").pop() ?? "import.ifc";
  await handleFile(new File([buf], name));
};

// Sample dropdown
sampleSelect.addEventListener("change", async () => {
  const id = sampleSelect.value;
  if (!id) return;
  const sample = SAMPLES.find((s) => s.id === id);
  if (!sample) return;
  setStatus(`Fetching ${sample.label}...`, "info");
  try {
    const resp = await fetch(`./${sample.path}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    // Synthesize a File so handleFile() can route by extension.
    const file = new File([buffer], sample.path.split("/").pop() ?? "sample", {
      type: "application/octet-stream",
    });
    await handleFile(file);
  } catch (e) {
    setStatus(`Failed to fetch sample: ${(e as Error).message}`, "err");
  }
});

// Drag-drop overlay
let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  dragDepth++;
  dropOverlay.classList.remove("hidden");
});
window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  if (!hasFiles(e)) return;
  dragDepth--;
  if (dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
  }
});
window.addEventListener("dragover", (e) => {
  e.preventDefault();
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add("hidden");
  const dt = e.dataTransfer;
  if (!dt || !dt.files || dt.files.length === 0) return;
  const file = dt.files[0];
  // If dropped while in prompt mode, switch to file mode for clarity.
  if (filePanel.classList.contains("hidden")) setMode("file");
  handleFile(file);
});

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

// --- Export pipeline ---

function refreshExportButtons(disabledOverride: boolean = false): void {
  const has = currentSource.kind !== "none";
  for (const btn of exportButtons) {
    const fmt = btn.dataset.fmt;
    if (!fmt) continue;
    if (disabledOverride || !has) {
      btn.disabled = true;
      continue;
    }
    // STL enabled always — falls back to Three.js STLExporter when pendingStl absent.
    if (fmt === "step") {
      btn.disabled = !pendingStep;
      continue;
    }
    btn.disabled = false;
  }
}

async function handleExport(fmt: string): Promise<void> {
  // 2D formats always route through the Layout sheet pipeline (vector, not raster).
  // Auto-activate Layout mode if not already active.
  const is2D = fmt === "svg" || fmt === "pdf" || fmt === "dwg" || fmt === "dxf";
  if (is2D) {
    if (workbenchEl?.dataset.mode !== "layout") {
      activateMode("layout", workbenchEl);
      // No RAF wait needed — LayoutController is already initialized by buildModes();
      // composeSvg/DXF read in-memory PanelState, not DOM metrics.
    }
    const host = getLayoutHost();
    if (!host) { setStatus("Layout not initialized.", "warn"); return; }
    // If layout has no panels, auto-seed a 4-panel default so export has content.
    if (getPanels(host).length === 0) {
      const S = 480, pad = 20;
      addPanel(host, { x: pad,       y: pad,       w: S, h: S, viewport: "top",         scale: "1:100", title: "PLAN — TOP" });
      addPanel(host, { x: pad+S+pad, y: pad,       w: S, h: S, viewport: "front",       scale: "1:100", title: "ELEVATION — FRONT" });
      addPanel(host, { x: pad,       y: pad+S+pad, w: S, h: S, viewport: "right",       scale: "1:100", title: "ELEVATION — RIGHT" });
      addPanel(host, { x: pad+S+pad, y: pad+S+pad, w: S, h: S, viewport: "perspective", scale: "1:100", title: "3D VIEW" });
    }
    const stem = "sheet";
    try {
      if (fmt === "svg") {
        const text = exportLayoutAsSvg(host);
        (window as unknown as Record<string, unknown>).__lastLayoutSvg = text;
        downloadBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
        setStatus(`Layout SVG · ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "pdf") {
        const buf = await exportLayoutAsPdf(host);
        downloadBlob(new Blob([buf], { type: "application/pdf" }), `${stem}.pdf`);
        setStatus(`Layout PDF · ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "dxf") {
        const text = exportLayoutAsDxf(host);
        downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
        setStatus(`DXF vector · ${(text.length / 1024).toFixed(1)} KB`, "ok");
      } else if (fmt === "dwg") {
        const text = exportLayoutAsDwgFallback(host);
        downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
        setStatus(`DXF (LibreDWG-WASM unavailable — SVG sidecar) · ${(text.length / 1024).toFixed(1)} KB`, "ok");
      }
    } catch (e) {
      console.error("[SdExport] 2D export failed:", e);
      setStatus(`Layout export ${fmt.toUpperCase()} failed: ${(e as Error).message}`, "err");
    }
    return;
  }

  const stem = currentSource.kind === "prompt"
    ? currentDemo.id
    : currentSource.kind === "file"
      ? sanitizeStem(currentSource.filename)
      : "export";
  try {
    if (fmt === "ifc" || fmt === "ifc4") {
      await exportIfc(stem);
      return;
    }
    if (fmt === "stl") {
      if (pendingStl) {
        downloadBlob(new Blob([pendingStl], { type: "model/stl" }), `${stem}.stl`);
        setStatus(`STL · ${(pendingStl.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else {
        // General Three.js STL export when no replicad geometry is available.
        // #1304: same scene-kg fallback as below.
        const stlSrc = viewer.getActiveObject() ?? (() => {
          const scene = viewer.getScene();
          const tagged = scene.children.filter(c => c.userData.creator);
          const nodes = tagged.length ? tagged : scene.children.filter(c => c instanceof THREE.Mesh || c instanceof THREE.Group);
          if (!nodes.length) return null;
          if (nodes.length === 1) return nodes[0];
          const g = new THREE.Group(); for (const c of nodes) g.add(c.clone()); return g;
        })();
        if (!stlSrc) { setStatus("No geometry loaded.", "warn"); return; }
        const buf = exportStl(stlSrc);
        downloadBlob(new Blob([buf], { type: "model/stl" }), `${stem}.stl`);
        setStatus(`STL · ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
      }
      return;
    }
    // #1304: scene-kg fallback — active object preferred; fall back to
    // all creator-tagged scene children when nothing is actively selected
    // (agent dispatch doesn't set an active object).
    let obj: THREE.Object3D | null = viewer.getActiveObject();
    if (!obj) {
      const sceneRoot = viewer.getScene();
      const tagged = sceneRoot.children.filter(c => c.userData.creator);
      const geomNodes = tagged.length
        ? tagged
        : sceneRoot.children.filter(c => c instanceof THREE.Mesh || c instanceof THREE.Group);
      if (!geomNodes.length) { setStatus("No geometry loaded.", "warn"); return; }
      if (geomNodes.length === 1) {
        obj = geomNodes[0];
      } else {
        const g = new THREE.Group();
        for (const c of geomNodes) g.add(c.clone());
        obj = g;
      }
    }
    setStatus(`Exporting ${fmt.toUpperCase()}...`, "info");
    if (fmt === "obj") {
      const text = exportObj(obj);
      downloadBlob(new Blob([text], { type: "model/obj" }), `${stem}.obj`);
      setStatus(`OBJ · ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "3dm") {
      setStatus("Exporting 3DM (loading Rhino runtime)…", "info");
      const buf = await export3dm(obj);
      downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "application/octet-stream" }), `${stem}.3dm`);
      setStatus(`3DM · ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "dwg") {
      // DWG is a proprietary binary format with no pure-JS writer. We export
      // AC1009 DXF text which AutoCAD and every major CAD tool reads natively.
      const text = exportDxf(obj);
      downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
      setStatus(`DXF (AutoCAD-compatible; true DWG binary not available in browser) · ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "glb") {
      const buf = await exportGlb(obj);
      downloadBlob(new Blob([buf], { type: "model/gltf-binary" }), `${stem}.glb`);
      setStatus(`GLB · ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "gltf") {
      const json = await exportGltfJson(obj);
      downloadBlob(new Blob([json], { type: "model/gltf+json" }), `${stem}.gltf`);
      setStatus(`glTF · ${(json.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "usdz") {
      const buf = await exportUsdz(obj);
      downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "model/vnd.usdz+zip" }), `${stem}.usdz`);
      setStatus(`USDZ · ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "svg") {
      const text = exportSvg(obj);
      downloadBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
      setStatus(`SVG · ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "dxf") {
      const text = exportDxf(obj);
      downloadBlob(new Blob([text], { type: "image/vnd.dxf" }), `${stem}.dxf`);
      setStatus(`DXF · ${(text.length / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "pdf") {
      const buf = exportPdf(obj);
      downloadBlob(new Blob([buf.buffer as ArrayBuffer], { type: "application/pdf" }), `${stem}.pdf`);
      setStatus(`PDF · ${(buf.byteLength / 1024).toFixed(1)} KB`, "ok");
    } else if (fmt === "step") {
      if (pendingStep) {
        downloadBlob(new Blob([pendingStep], { type: "application/step" }), `${stem}.step`);
        setStatus(`STEP · ${(pendingStep.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else {
        setStatus("STEP only available for replicad-generated geometry.", "warn");
      }
    } else {
      setStatus(`Unknown export format: ${fmt}`, "err");
    }
  } catch (e) {
    console.error("[SdExport] 3D export failed:", e);
    setStatus(`Export ${fmt.toUpperCase()} failed: ${(e as Error).message}`, "err");
  }
}

function sanitizeStem(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_\-]+/g, "_") || "export";
}

// Creator tags that are spatial/structural only — skip in IFC element export.
const IFC_SKIP_CREATORS = new Set(["SdRefGrid", "IfcGridLine", "SdLevel", "SdDatum", "SdReferenceLine"]);

function sceneElementsForExport(): IfcSceneElement[] {
  const elements: IfcSceneElement[] = [];
  const scene = viewer.getScene();
  const tmp = new THREE.Vector3();
  scene.traverse((obj) => {
    const creator = obj.userData.creator as string | undefined;
    if (!creator || IFC_SKIP_CREATORS.has(creator)) return;
    // Only process top-level creator objects (not their mesh children).
    if (obj.parent && obj.parent.userData.creator) return;

    const verts: number[] = [];
    const idx: number[] = [];
    obj.updateMatrixWorld(true);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry as THREE.BufferGeometry;
      const pos = g.attributes.position?.array as Float32Array | undefined;
      if (!pos) return;
      const baseIndex = verts.length / 3;
      for (let i = 0; i < pos.length; i += 3) {
        tmp.set(pos[i], pos[i + 1], pos[i + 2]);
        tmp.applyMatrix4(mesh.matrixWorld);
        verts.push(tmp.x, tmp.y, tmp.z);
      }
      const indexAttr = g.index;
      if (indexAttr) {
        for (let j = 0; j < indexAttr.array.length; j++) idx.push(indexAttr.array[j] + baseIndex);
      } else {
        for (let j = 0; j < Math.floor(pos.length / 3); j++) idx.push(baseIndex + j);
      }
    });
    if (verts.length > 0) {
      elements.push({
        mesh: { vertices: new Float32Array(verts), indices: new Uint32Array(idx) },
        creator,
        label: creator,
        levelId: obj.userData.levelId as string | undefined,
        dispatchArgs: obj.userData.dispatchArgs as Record<string, unknown> | undefined,
      });
    }
  });
  return elements;
}

async function exportIfc(stem: string): Promise<void> {
  setStatus("Building IFC + verifying round-trip via web-ifc...", "info");
  try {
    let bytes: Uint8Array;
    const sceneElements = sceneElementsForExport();
    const exportLevels: IfcLevel[] = levelStore.all().map((l) => ({
      levelId: l.id,
      name: l.name,
      elevation: l.elevation,
    }));
    const ifcImperial = getState("unitSystem") === "imperial";
    if (sceneElements.length > 0) {
      bytes = buildIfcScene(sceneElements, exportLevels, { imperial: ifcImperial });
    } else {
      // Fallback: kernel BREP mesh for single-object scenes (replicad / file import).
      const data = viewer.getActiveMeshData();
      if (!data) {
        setStatus("No geometry to export as IFC.", "warn");
        return;
      }
      const label =
        currentSource.kind === "prompt"
          ? currentDemo.label
          : currentSource.kind === "file"
            ? `Imported ${currentSource.filename}`
            : "GemmaCad Element";
      bytes = buildIfc({ vertices: data.vertices, indices: data.indices }, label, { imperial: ifcImperial });
    }
    const result = await ifcRoundTrip(bytes);
    if (result.ok) {
      const { wall, slab, column, beam, proxy, total } = result.counts;
      const detail = [
        wall   && `${wall}w`,
        slab   && `${slab}s`,
        column && `${column}c`,
        beam   && `${beam}b`,
        proxy  && `${proxy}x`,
      ].filter(Boolean).join(" ") || "0 elements";
      setStatus(
        `IFC4 ${(result.byteSize / 1024).toFixed(1)} KB · ${total} elements (${detail}) · ${result.schema} OK`,
        "ok",
      );
    } else {
      setStatus(
        `IFC built (${(bytes.byteLength / 1024).toFixed(1)} KB) — round-trip skipped: ${result.error}`,
        "warn",
      );
    }
    downloadBlob(
      new Blob([new Uint8Array(bytes)], { type: "application/x-step" }),
      `${stem}.ifc`,
    );
  } catch (e) {
    setStatus(`IFC build failed: ${(e as Error).message}`, "err");
  }
}

for (const btn of exportButtons) {
  btn.addEventListener("click", () => {
    const fmt = btn.dataset.fmt;
    if (fmt) handleExport(fmt);
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Boot.
hydrateFromStorage();
const workbenchEl = document.querySelector(".workbench") as HTMLElement | null;
initShellChrome({
  onModeChange: (k) => {
    activateMode(k, workbenchEl);
    setRibbonMode(k as "model" | "layout" | "research");
    rebuildPaletteForMode(k);
    viewer.setGumballEnabled(k === "model");
    viewer.setGridAxesVisible(k !== "layout");
    if (k === "layout") applyDrafting(viewer.getScene());
    else {
      removeDrafting(viewer.getScene());
      // Reset grid orientation and perspPane camera (may have been overridden by
      // setView("front"/"right"/etc. keyboard shortcuts active in layout mode).
      if (k === "model") {
        viewer.setView("persp");
        // Reset CPlane — LAYOUT arms an XZ cplane; returning to MODEL must restore
        // the default WORLD_XY so the cplane gizmo auto-show logic tears down (#1159).
        viewer.activeCPlane = { ...WORLD_XY };
        window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
          detail: { cplane: viewer.activeCPlane, mode: "world" },
          bubbles: false,
        }));
      }
    }
  },
  onSplitMode: (mode) => viewer.splitMode(mode),
});
buildWorkbench();
if (workbenchEl) buildModes(workbenchEl);
loadDrawingLayers(); // restore persisted 2D layers from IDB
initCmdK();
initExportDrawer();
// Ctrl+E shortcut → open export drawer.
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    e.preventDefault();
    openExportDrawer();
  }
});
// ── IDB auto-save + restore-last-session prompt ──────────────────────────
// Saves dispatch-created geometry to IndexedDB after each successful dispatch
// (debounced 2s) and every 60s as a heartbeat. On boot (after OCCT ready),
// if IDB has a prior scene and the current scene is empty, offers restore.
function _hasUserContent(): boolean {
  return viewer
    .getScene()
    .children.some((c) => (c as any).userData?.creator && (c as any).userData.creator !== "IfcLevel");
}

let _autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
// true when a dispatch has occurred but IDB save hasn't completed yet.
let _idbDirty = false;
// Diagnostic: expose IDB save state + last error for DevTools inspection.
const _idbDiag: { dirty: boolean; lastSaveOk: boolean; lastErr: string | null; saveCount: number; failCount: number } =
  { dirty: false, lastSaveOk: false, lastErr: null, saveCount: 0, failCount: 0 };
(window as unknown as Record<string, unknown>).__idbDiag = _idbDiag;
function _setDirty(v: boolean, reason: string): void {
  _idbDirty = v;
  _idbDiag.dirty = v;
  console.debug(`[idb] dirty=${v} (${reason})`);
}
function _triggerAutoSave(): void {
  _setDirty(true, "post-dispatch");
  // Do NOT reset an already-scheduled timer. With continuous dispatches (e.g. goal
  // continuation loop firing every ~1s), resetting on each call pushes the save
  // indefinitely into the future — _idbDirty never clears, beforeunload fires on
  // every navigation attempt (#1700). Let the first scheduled save fire as-is; the
  // next dispatch after save completes will schedule a fresh 2 s window.
  if (_autoSaveTimer !== null) return;
  _autoSaveTimer = setTimeout(async () => {
    _autoSaveTimer = null;
    try {
      const data = viewer.exportScene();
      if (data.length > 0) await sceneStoreSave(data);
      else await sceneStoreClear();
      _idbDiag.saveCount++;
      _idbDiag.lastSaveOk = true;
      _idbDiag.lastErr = null;
      _setDirty(false, "autosave-ok");
    } catch (err) {
      _idbDiag.failCount++;
      _idbDiag.lastSaveOk = false;
      _idbDiag.lastErr = String(err);
      console.warn("[idb] autosave failed — _idbDirty stays true:", err);
    }
  }, 2000);
}

// Non-mutating verbs — these change only UI/goal/selection state, not the 3D scene that
// viewer.exportScene() serializes. Excluding them prevents the 2 s debounce from blocking
// navigation when IDB is already fully current. (#1700)
const _NON_MUTATING_VERBS = new Set([
  "setActiveTool", "setActiveLevel",
  "toggleLayerVisibility", "toggleObjectVisibility",
  "selectObject", "deselectAll",
  "create_goal", "update_goal", "get_goal",
  "setCamera", "resetCamera",
]);
registerPostDispatch((canonical) => {
  if (!_NON_MUTATING_VERBS.has(canonical)) _triggerAutoSave();
});

setInterval(async () => {
  if (_hasUserContent()) {
    try {
      await sceneStoreSave(viewer.exportScene());
      _idbDiag.saveCount++;
      _idbDiag.lastSaveOk = true;
      _idbDiag.lastErr = null;
      _setDirty(false, "heartbeat-ok");
    } catch (err) {
      _idbDiag.failCount++;
      _idbDiag.lastErr = String(err);
      console.warn("[idb] heartbeat save failed:", err);
    }
  }
}, 60_000);

async function initSceneRestore(): Promise<void> {
  try {
    const saved = await sceneStoreLoad();
    if (!saved || !Array.isArray(saved) || saved.length === 0) return;
    if (_hasUserContent()) return; // scene already populated — skip restore offer
    const prompt = document.getElementById("restore-prompt") as HTMLElement | null;
    if (!prompt) return;
    prompt.hidden = false;
    document.getElementById("restore-btn")?.addEventListener("click", async () => {
      prompt.hidden = true;
      try {
        viewer.importScene(saved as Parameters<typeof viewer.importScene>[0]);
        await sceneStoreClear();
        setStatus("Session restored.", "ok");
      } catch { setStatus("Restore failed.", "err"); }
    }, { once: true });
    document.getElementById("restore-discard-btn")?.addEventListener("click", async () => {
      prompt.hidden = true;
      await sceneStoreClear().catch(() => {});
    }, { once: true });
  } catch { /* IDB unavailable — non-fatal */ }
}

// Warn before reload/close only when IDB save hasn't flushed yet (_idbDirty).
// Skips IFC-loaded content — those lack userData.creator and survive a reload via re-open.
// CDP/Playwright sessions set navigator.webdriver=true; suppress there to avoid blocking
// automated tests. Real user sessions never set this flag. (#1704 Leg B)
(window as unknown as Record<string, unknown>).__sceneBeforeunloadHooked = true;
window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
  if (navigator.webdriver === true) return;
  const hasContent = _hasUserContent();
  console.debug(`[beforeunload] dirty=${_idbDirty} hasContent=${hasContent} diag=`, JSON.stringify(_idbDiag));
  if (_idbDirty && hasContent) {
    e.preventDefault();
    e.returnValue = "";
  }
});
setStatus("Loading OpenCascade WebAssembly...", "info");
runBtn.disabled = true;
refreshExportButtons(true);
// Disconnect the theme MutationObserver on Vite HMR so the old Viewer
// instance doesn't keep the document element alive across hot-reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    viewer.dispose();
    terminateAndRecycle();
  });
}

