// Wires the UI: prompt mode (existing) + file-load mode (new).
//
// The prompt-mode flow is unchanged from the v1 release — dropdown, textarea,
// Run button, worker, viewer.setMesh.
// The file-load flow accepts IFC/STEP via the worker (heavy parsing) and
// GLB/GLTF/OBJ/STL on the main thread via three.js JSM loaders.
//
// Export menu is shared: the active source (whether replicad-generated or
// loaded-from-file) is queried via viewer.getActiveMeshData().

import { initShellChrome, setRibbonMode, setRibbonElementTypes, resetRibbonElementTypes } from "./shell";
import { buildWorkbench } from "./workbench";
import { buildModes, activateMode } from "./modes";
import { initCmdK } from "./cmdk";
import { initExportDrawer, openExportDrawer } from "./export-drawer";
import { Viewer } from "./viewer/viewer";
import { ScenePanel, type SceneSummary } from "./scene-panel";
import { applyDrafting, removeDrafting, isDrafting } from "./drafting";
import { DEMOS, applyParams, type DemoPrompt, type Param } from "./demo-prompts";
import { getLayerForCreator, layerStore } from "./layers";
import { levelStore, getActiveLevelId } from "./levels";
import { gridStore } from "./grids";
import { snapPoint, setStep as snapSetStep, getStep as snapGetStep } from "./viewer/snap-state";
import { buildIfc, buildIfcScene, ifcRoundTrip, type IfcSceneElement, type IfcLevel } from "./ifc";
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
} from "./loader";
import {
  exportObj,
  exportGltfJson,
  exportGlb,
  exportUsdz,
  exportSvg,
  exportDxf,
  exportPdf,
} from "./exporters";
import { SAMPLES } from "./sample-files";
import type { WorkerOut } from "./worker";
import { syncToolActiveClass, getState, setState } from "./app-state";
import { initCreateMode, emitClickWorld, getSnapTarget } from "./viewer/create-mode";
import { initSectionHandles } from "./viewer/section-handles";
import { undo, redo, pushAction, pushTransformAction, pushBatchAction, captureTransform } from "./history";
import { registerHandler, dispatchSync, installDefaultHandlers } from "./commands/dispatch";
import { resolveCPlane, WORLD_XY, WORLD_XZ, WORLD_YZ, type CPlane } from "./viewer/cplane";
import { clearCommandSession, getActiveCommandSession } from "./commands/command-session";
import { runIteration, runDesignLoop } from "./chat-panel";
import { Point3 as Prim3, Plane as PrimPlane, type Arc as PrimArc } from "./nurbs-primitives";
import { tessellate, createClampedUniformNurbs, type Curve, pointAt as curvePointAt, domain as curveDomain } from "./nurbs-curves";
import { nurbsCurveFromArc } from "./nurbs-curve-algorithms";
import { tessellateSurface } from "./nurbs-surfaces";
import { surfaceOfRevolution, sweepSurface, loftSurfaces } from "./nurbs-surface-algorithms";
import { addToMultiSelected, clearMultiSelected, clearSelected, getFilters, getSelected, setSelected, topologyAllowed } from "./viewer/selection-state";
import { initRenderModes, setRenderMode, type RenderMode } from "./render-modes";
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
// Expose for in-browser debug + DevTools poking — read-only handle to scene state.
(window as unknown as { __viewer: Viewer }).__viewer = viewer;
// Expose dispatchSync for CDP-driven verification scripts.
(window as unknown as { __dispatch: typeof dispatchSync }).__dispatch = dispatchSync;
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
(window as unknown as { __runDesignLoop: typeof runDesignLoop }).__runDesignLoop = runDesignLoop;
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
// SdDelete: delete the currently selected object via the viewer's deleteSelected() method.
registerHandler("SdDelete", () => {
  const deleted = viewer.deleteSelected();
  return { deleted };
});
syncToolActiveClass();
initCreateMode(viewer);
initSectionHandles(viewer, viewportAreaEl);

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
  viewer.clearSectionBox();
  document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
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
  const label = args.label as string | undefined;
  if (!Array.isArray(origin) || origin.length < 3 || !Array.isArray(normal) || normal.length < 3)
    return { error: "origin and normal must be [x,y,z] arrays" };
  viewer.addClippingPlane(origin, normal, label);
  document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  return { ok: true, origin, normal, label };
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
  if (!fmt) return { error: "format required (ifc|glb|gltf|obj|stl|step|svg|dxf|pdf|usdz)" };
  // Skip real download in test mode to prevent file pollution in Downloads.
  if ((window as unknown as { __testMode?: boolean }).__testMode) return { ok: true, format: fmt, testMode: true };
  handleExport(fmt).catch((e) => console.warn("[SdExport]", e));
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
  sel.scale.multiplyScalar(f);
  sel.updateMatrix();
  sel.updateMatrixWorld(true);
  pushTransformAction(sel, before);
  return { scaled: true, factor: f };
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
  viewer.getScene().add(proxy);
  viewer.selectObject(proxy);
  window.dispatchEvent(new CustomEvent("viewer:selectAll", { detail: { count: selectable.length } }));
});

// Geometry-creation handlers for agent dispatches from the CREATE tab.
// These override the generic gemma:command shim with actual THREE.js mesh creation.

registerHandler("SdBox", (args) => {
  const w = (args.width as number | undefined) ?? (args.size as number | undefined) ?? 1;
  const d = (args.depth as number | undefined) ?? (args.length as number | undefined) ?? 1;
  const h = (args.height as number | undefined) ?? 1;
  const cplane = resolveCPlane("SdBox", args as Record<string, unknown>, viewer);
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "SdBox";
  mesh.userData.cplaneKind = cplane.kind;
  viewer.addMesh(mesh, "brep");
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
  mesh.userData.creator = "SdSphere";
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
  mesh.userData.creator = "SdCylinder";
  mesh.userData.cplaneKind = cplane.kind;
  viewer.addMesh(mesh, "brep");
  return { created: "cylinder", radius: r, height: h };
});

registerHandler("SdCone", (args) => {
  const r = (args.radius as number | undefined) ?? 0.5;
  const h = (args.height as number | undefined) ?? 2;
  const cplane = resolveCPlane("SdCone", args as Record<string, unknown>, viewer);
  const geom = new THREE.ConeGeometry(r, h, 32);
  geom.rotateX(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), cplane.normal);
  mesh.position.copy(cplane.normal.clone().multiplyScalar(h / 2));
  mesh.userData.kind = "brep";
  mesh.userData.creator = "SdCone";
  mesh.userData.cplaneKind = cplane.kind;
  viewer.addMesh(mesh, "brep");
  return { created: "cone", radius: r, height: h };
});

// SdExtrude — extrude a closed 2D profile along a direction vector.
// profile: list of [x,y] points (closed polyline). Defaults to 1×1 unit square.
// distance: extrude depth in metres.
// direction: extrude axis (default [0,0,1] = vertical).
registerHandler("SdExtrude", (args) => {
  const distance = (args.distance as number | undefined) ?? (args.height as number | undefined) ?? 1;
  const rawProfile = args.profile as [number, number][] | undefined;
  const dirRaw = args.direction as [number, number, number] | undefined;

  // Build THREE.Shape from profile points
  const pts: [number, number][] = Array.isArray(rawProfile) && rawProfile.length >= 3
    ? (rawProfile as [number, number][])
    : [[0, 0], [1, 0], [1, 1], [0, 1]];
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

  mesh.userData.kind = "brep";
  mesh.userData.creator = "SdExtrude";
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

registerHandler("IfcWall", (args) => {
  const cplane = resolveCPlane("IfcWall", args as Record<string, unknown>, viewer);
  const rawProfile = args.profile as [number, number][] | undefined;
  const wallLen = (args.length as number | undefined) ?? 4;
  const profile: [number, number][] = rawProfile ?? [[0, 0], [wallLen, 0]];
  const t = (args.thickness as number | undefined) ?? 0.2;
  const wallH = (args.height as number | undefined) ?? 3;
  // Compute total polyline length
  let len = 0;
  let cx = 0, cy = 0;
  for (let i = 0; i < profile.length - 1; i++) {
    const dx = profile[i + 1][0] - profile[i][0];
    const dy = profile[i + 1][1] - profile[i][1];
    len += Math.sqrt(dx * dx + dy * dy);
    cx += (profile[i][0] + profile[i + 1][0]) / 2;
    cy += (profile[i][1] + profile[i + 1][1]) / 2;
  }
  if (len < 0.01) len = 4;
  const geom = new THREE.BoxGeometry(len, t, wallH);
  geom.translate(0, 0, wallH / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  if (profile.length >= 2) {
    const dx = profile[profile.length - 1][0] - profile[0][0];
    const dy = profile[profile.length - 1][1] - profile[0][1];
    mesh.position.set((profile[0][0] + profile[profile.length - 1][0]) / 2, (profile[0][1] + profile[profile.length - 1][1]) / 2, getActiveLevelElevation());
    mesh.rotation.z = Math.atan2(dy, dx);
  }
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcWall";
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("IfcWall", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  pushAction(mesh, "IfcWall");
  return { created: "wall", length: len, thickness: t, height: wallH };
});

registerHandler("IfcSlab", (args) => {
  const cplane = resolveCPlane("IfcSlab", args as Record<string, unknown>, viewer);
  const w = (args.width as number | undefined) ?? (args.length as number | undefined) ?? 4;
  const d = (args.depth as number | undefined) ?? (args.width as number | undefined) ?? 4;
  const t = (args.thickness as number | undefined) ?? 0.2;
  const elev = (args.elevation as number | undefined) ?? getActiveLevelElevation();
  const geom = new THREE.BoxGeometry(w, d, t);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa8a097, roughness: 0.7, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.z = elev;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcSlab";
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("IfcSlab", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  pushAction(mesh, "IfcSlab");
  return { created: "slab", width: w, depth: d };
});

registerHandler("IfcColumn", (args) => {
  const cplane = resolveCPlane("IfcColumn", args as Record<string, unknown>, viewer);
  const s = (args.size as number | undefined) ?? 0.3;
  const h = (args.height as number | undefined) ?? 4;
  const geom = new THREE.BoxGeometry(s, s, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd1c5b0, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  const p = args.position as [number, number] | undefined;
  if (p) mesh.position.set(p[0], p[1], getActiveLevelElevation());
  else mesh.position.z = getActiveLevelElevation();
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcColumn";
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("IfcColumn", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  pushAction(mesh, "IfcColumn");
  return { created: "column", height: h };
});

// ── IFC Tier 2: Beam / Stair / Door / Window / Roof / Space ─────────────────

registerHandler("IfcBeam", (args) => {
  const s  = (args.start as number[] | undefined) ?? [0, 0, 3];
  const e  = (args.end   as number[] | undefined) ?? [4, 0, 3];
  const dx = e[0] - s[0], dy = e[1] - s[1], dz = (e[2] ?? 0) - (s[2] ?? 0);
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 4;
  const bw = (args.size as number | undefined) ?? 0.2;
  const geom = new THREE.BoxGeometry(len, bw, bw);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa0856a, roughness: 0.6, metalness: 0.1 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((s[0] + e[0]) / 2, (s[1] + e[1]) / 2, (s[2] + e[2]) / 2 || 3);
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcBeam";
  mesh.userData.layerId = resolveLayerId("IfcBeam", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "beam", length: len };
});

registerHandler("IfcMember", (args) => {
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
  mesh.userData.creator = "IfcMember";
  mesh.userData.layerId = resolveLayerId("IfcMember", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "member", length, profile_points: pts.length };
});

registerHandler("IfcStair", (args) => {
  const s    = (args.start as number[] | undefined) ?? [0, 0, 0];
  const e    = (args.end   as number[] | undefined) ?? [3, 0, 0];
  const w    = (args.width as number | undefined) ?? 1;
  const rise = (args.riser as number | undefined) ?? 0.18;
  const tread = (args.tread as number | undefined) ?? 0.27;
  const dx   = e[0] - s[0], dy = e[1] - s[1];
  const run  = Math.sqrt(dx * dx + dy * dy) || 3;
  const steps = Math.max(2, Math.round(run / tread));
  const totalH = steps * rise;
  const geom = new THREE.BoxGeometry(run, w, totalH);
  geom.translate(run / 2, 0, totalH / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb89968, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(s[0], s[1], (s[2] as number | undefined) ?? getActiveLevelElevation());
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcStair";
  mesh.userData.layerId = resolveLayerId("IfcStair", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "stair", steps, run, height: totalH };
});

// ── Boolean void cut for box-geometry walls/slabs (#324) ─────────────────────
// Decomposes a BoxGeometry host into segments, replacing it with a Group that
// has a rectangular void at voidWorldCenter. Operates in the host's local space
// so works for any wall rotation. Silently skips if geometry is not a box.
function cutRectVoidFromBoxMesh(
  host: THREE.Mesh,
  voidWorldCenter: THREE.Vector3,
  voidW: number,
  voidH: number,
): THREE.Group | null {
  host.updateMatrixWorld(true);
  const geom = host.geometry as THREE.BufferGeometry;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return null;
  const wallLen   = bb.max.x - bb.min.x;
  const wallThick = bb.max.y - bb.min.y;
  const wallHt    = bb.max.z - bb.min.z;
  const wallZMin  = bb.min.z;

  // Void center in wall local space — only X and Z matter for a box wall.
  const localCenter = host.worldToLocal(voidWorldCenter.clone());
  const vX = localCenter.x;   // x-center of void on wall length axis
  const vZBot = localCenter.z - voidH / 2;
  const vZTop = localCenter.z + voidH / 2;

  const mat = (Array.isArray(host.material) ? host.material[0] : host.material) as THREE.Material;
  const seg = (segW: number, segH: number, ox: number, oz: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(segW, wallThick, segH), mat);
    m.position.set(bb.min.x + ox + segW / 2, 0, wallZMin + oz + segH / 2);
    return m;
  };

  const group = new THREE.Group();

  // Left of void
  const leftW = (vX - voidW / 2) - bb.min.x;
  if (leftW > 0.001) group.add(seg(leftW, wallHt, 0, 0));

  // Right of void
  const rightX = vX + voidW / 2;
  const rightW = bb.max.x - rightX;
  if (rightW > 0.001) group.add(seg(rightW, wallHt, rightX - bb.min.x, 0));

  // Below void (sill — for windows)
  const belowH = Math.max(0, vZBot - wallZMin);
  if (belowH > 0.001) group.add(seg(voidW, belowH, vX - voidW / 2 - bb.min.x, 0));

  // Above void
  const aboveBot = Math.min(vZTop, wallZMin + wallHt) - wallZMin;
  const aboveH   = (wallZMin + wallHt) - (wallZMin + aboveBot);
  if (aboveH > 0.001) group.add(seg(voidW, aboveH, vX - voidW / 2 - bb.min.x, aboveBot));

  // Copy host transform + metadata
  group.position.copy(host.position);
  group.rotation.copy(host.rotation);
  group.scale.copy(host.scale);
  group.userData = { ...host.userData };

  // Swap host with group in parent
  const parent = host.parent;
  if (!parent) return null;
  parent.remove(host);
  geom.dispose();
  parent.add(group);
  return group;
}

// ── Realistic door geometry: frame (jambs + head) + panel leaf ───────────────
function buildDoorGroup(w: number, h: number, wallT: number): THREE.Group {
  const fw = 0.05;  // 50mm frame width
  const pt = 0.04;  // 40mm panel thickness
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xa09080, roughness: 0.8, metalness: 0.0 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0xc4a06a, roughness: 0.65, metalness: 0.0 });
  const group = new THREE.Group();

  // Left jamb
  const lj = new THREE.Mesh(new THREE.BoxGeometry(fw, wallT, h), frameMat);
  lj.position.set(-fw / 2, 0, h / 2);
  group.add(lj);

  // Right jamb
  const rj = new THREE.Mesh(new THREE.BoxGeometry(fw, wallT, h), frameMat);
  rj.position.set(w + fw / 2, 0, h / 2);
  group.add(rj);

  // Head rail
  const head = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * fw, wallT, fw), frameMat);
  head.position.set(w / 2, 0, h + fw / 2);
  group.add(head);

  // Panel leaf (single-swing-left default: IfcDoorTypeOperationEnum.SINGLE_SWING_LEFT)
  const panel = new THREE.Mesh(new THREE.BoxGeometry(w, pt, h - fw), panelMat);
  panel.position.set(w / 2, 0, (h - fw) / 2);
  group.add(panel);

  // Mid-rail detail at ~1/3 height
  const rail = new THREE.Mesh(new THREE.BoxGeometry(w, pt + 0.005, fw * 0.6), panelMat);
  rail.position.set(w / 2, 0, h / 3);
  group.add(rail);

  return group;
}

// ── Realistic window geometry: frame (4 rails) + translucent pane ────────────
function buildWindowGroup(w: number, h: number, wallT: number): THREE.Group {
  const fw = 0.04;  // 40mm frame rail width
  const paneT = 0.006;  // 6mm glass pane
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x909090, roughness: 0.4, metalness: 0.2 });
  const paneMat  = new THREE.MeshStandardMaterial({ color: 0xadd8e6, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.35 });
  const group = new THREE.Group();

  const lRail = new THREE.Mesh(new THREE.BoxGeometry(fw, wallT, h), frameMat);
  lRail.position.set(-fw / 2, 0, h / 2);
  group.add(lRail);
  const rRail = new THREE.Mesh(new THREE.BoxGeometry(fw, wallT, h), frameMat);
  rRail.position.set(w + fw / 2, 0, h / 2);
  group.add(rRail);
  const bRail = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * fw, wallT, fw), frameMat);
  bRail.position.set(w / 2, 0, -fw / 2);
  group.add(bRail);
  const tRail = new THREE.Mesh(new THREE.BoxGeometry(w + 2 * fw, wallT, fw), frameMat);
  tRail.position.set(w / 2, 0, h + fw / 2);
  group.add(tRail);

  // Glass pane (single panel — IfcWindowTypePartitioningEnum.SINGLE_PANEL)
  const pane = new THREE.Mesh(new THREE.BoxGeometry(w, paneT, h), paneMat);
  pane.position.set(w / 2, 0, h / 2);
  group.add(pane);

  return group;
}

registerHandler("IfcDoor", (args) => {
  const hostUuidDoor = args.hostUuid as string | undefined;
  const hostObjDoor = hostUuidDoor
    ? viewer.getScene().getObjectByProperty("uuid", hostUuidDoor) ?? undefined
    : undefined;
  const cplane = resolveCPlane("IfcDoor", args as Record<string, unknown>, viewer, hostObjDoor);
  const w     = (args.width  as number | undefined) ?? 0.9;
  const h     = (args.height as number | undefined) ?? 2.1;
  const wallT = (args.wallThickness as number | undefined) ?? 0.2;
  const group = buildDoorGroup(w, h, wallT);
  const pos = args.position as number[] | undefined;
  const elevation = getActiveLevelElevation();
  if (pos) group.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? elevation);
  else group.position.z = elevation;
  // Align door to host wall normal (W-2).
  if (cplane.kind === "host-derived") {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), cplane.normal,
    );
    group.quaternion.copy(q);
  }
  group.userData.kind = "brep";
  group.userData.creator = "IfcDoor";
  group.userData.cplaneKind = cplane.kind;
  group.userData.layerId = resolveLayerId("IfcDoor", args);
  group.userData.levelId = getActiveLevelId();
  group.userData.dispatchArgs = args;
  viewer.addMesh(group, "brep");
  pushAction(group, "IfcDoor");
  let voidCut = false;
  const hostUuid = args.hostUuid as string | undefined;
  if (hostUuid) {
    const host = viewer.getScene().getObjectByProperty("uuid", hostUuid);
    if (host instanceof THREE.Mesh) {
      const voidCenter = group.position.clone();
      voidCenter.z = elevation + h / 2;
      cutRectVoidFromBoxMesh(host, voidCenter, w, h);
      voidCut = true;
    }
  }
  return { created: "door", width: w, height: h, submeshes: group.children.length, voidCut };
});

registerHandler("IfcWindow", (args) => {
  const hostUuidWin = args.hostUuid as string | undefined;
  const hostObjWin = hostUuidWin
    ? viewer.getScene().getObjectByProperty("uuid", hostUuidWin) ?? undefined
    : undefined;
  const cplane = resolveCPlane("IfcWindow", args as Record<string, unknown>, viewer, hostObjWin);
  const w     = (args.width  as number | undefined) ?? 1.2;
  const h     = (args.height as number | undefined) ?? 1.5;
  const sill  = (args.sillH  as number | undefined) ?? 0.9;
  const wallT = (args.wallThickness as number | undefined) ?? 0.2;
  const group = buildWindowGroup(w, h, wallT);
  const pos = args.position as number[] | undefined;
  const elevation = getActiveLevelElevation();
  if (pos) group.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? (elevation + sill));
  else group.position.z = elevation + sill;
  // Align window to host wall normal (W-2).
  if (cplane.kind === "host-derived") {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), cplane.normal,
    );
    group.quaternion.copy(q);
  }
  group.userData.kind = "brep";
  group.userData.creator = "IfcWindow";
  group.userData.cplaneKind = cplane.kind;
  group.userData.layerId = resolveLayerId("IfcWindow", args);
  group.userData.levelId = getActiveLevelId();
  group.userData.dispatchArgs = args;
  viewer.addMesh(group, "brep");
  pushAction(group, "IfcWindow");
  let voidCut = false;
  const hostUuid = args.hostUuid as string | undefined;
  if (hostUuid) {
    const host = viewer.getScene().getObjectByProperty("uuid", hostUuid);
    if (host instanceof THREE.Mesh) {
      const voidCenter = group.position.clone();
      cutRectVoidFromBoxMesh(host, voidCenter, w, h);
      voidCut = true;
    }
  }
  return { created: "window", width: w, height: h, sillH: sill, submeshes: group.children.length, voidCut };
});

function buildRoofGeometry(
  type: string, w: number, d: number, ridgeH: number,
): THREE.BufferGeometry {
  switch (type) {
    case "pitched": {
      // Gable roof: triangular cross-section extruded along depth.
      // Ridge runs along Y. Vertices: 4 base corners + 2 ridge points.
      const v = new Float32Array([
        -w/2, -d/2, 0,      // 0 front-left
         w/2, -d/2, 0,      // 1 front-right
         w/2,  d/2, 0,      // 2 back-right
        -w/2,  d/2, 0,      // 3 back-left
           0, -d/2, ridgeH, // 4 front ridge
           0,  d/2, ridgeH, // 5 back ridge
      ]);
      const idx = new Uint16Array([
        0,1,4,  3,5,2,       // gable ends
        0,4,5, 0,5,3,        // left slope
        1,2,5, 1,5,4,        // right slope
        0,2,1, 0,3,2,        // floor
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      return geo;
    }
    case "hipped": {
      // Hip roof: ridge runs along long axis (Y if d>w), set back w/2 from each end.
      const setback = Math.min(w / 2, d / 2);
      const v = new Float32Array([
        -w/2, -d/2, 0,                       // 0
         w/2, -d/2, 0,                       // 1
         w/2,  d/2, 0,                       // 2
        -w/2,  d/2, 0,                       // 3
           0, -(d/2 - setback), ridgeH,      // 4 near ridge pt
           0,  (d/2 - setback), ridgeH,      // 5 far ridge pt
      ]);
      const idx = new Uint16Array([
        // Near hip: 0,1,4
        0,1,4,
        // Far hip: 2,3,5
        2,3,5,
        // Left slopes: 0,4,5, 0,5,3
        0,4,5, 0,5,3,
        // Right slopes: 1,2,5, 1,5,4
        1,2,5, 1,5,4,
        // Floor
        0,2,1, 0,3,2,
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      return geo;
    }
    case "curved": {
      // Barrel vault: half-cylinder, radius=w/2, length=d, axis=Y.
      const segs = 24;
      const positions: number[] = [];
      const indices: number[] = [];
      // Build top half-circle cross-section (theta 0..PI) × 2 depth positions.
      for (let si = 0; si <= segs; si++) {
        const t = (si / segs) * Math.PI; // 0..PI gives top half
        const x = (w / 2) * Math.cos(Math.PI - t); // -w/2 .. +w/2
        const z = (w / 2) * Math.sin(Math.PI - t); // 0 .. ridgeH-approx
        positions.push(x, -d/2, z, x, d/2, z);
      }
      for (let si = 0; si < segs; si++) {
        const a = si * 2, b = si * 2 + 1, c = si * 2 + 2, e = si * 2 + 3;
        indices.push(a, c, b, b, c, e);
      }
      // End caps
      const nv = (segs + 1) * 2;
      // Front cap: fan from (0, -d/2, 0)
      positions.push(0, -d/2, 0); const fc = nv;
      for (let si = 0; si < segs; si++) indices.push(fc, si * 2, si * 2 + 2);
      // Back cap: fan from (0, +d/2, 0)
      positions.push(0, d/2, 0); const bc = nv + 1;
      for (let si = 0; si < segs; si++) indices.push(bc, si * 2 + 3, si * 2 + 1);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }
    case "combination": {
      // Flat centre slab + pitched ends (L-wing approach).
      // Centre: flat slab w × d/2 (middle third)
      // Ends: two smaller pitched roofs.
      const geo = new THREE.BufferGeometry();
      const hw = w / 2, hd = d / 2, wh = Math.max(0.15, ridgeH * 0.4);
      const v = new Float32Array([
        // Flat centre (z = wh)
        -hw, -hd/2, wh,  hw, -hd/2, wh,  hw, hd/2, wh,  -hw, hd/2, wh,
        // Front pitched end (below centre)
        -hw, -hd, 0,  hw, -hd, 0,  0, -hd, ridgeH,  0, -hd/2, ridgeH,
        // Back pitched end
        -hw, hd, 0,   hw, hd, 0,   0, hd, ridgeH,   0, hd/2, ridgeH,
      ]);
      const idx = new Uint16Array([
        // Flat slab (4 verts 0-3)
        0,2,1, 0,3,2,
        // Front end: verts 4,5,6,7
        4,6,5, 4,7,6, 4,0,7, 5,6,7, // approximate
        // Back end: verts 8,9,10,11
        8,9,10, 8,10,11, 8,11,3, 9,10,11,
      ]);
      geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      return geo;
    }
    case "shed": {
      // Mono-pitched (lean-to): front edge low, back edge at ridgeH.
      const v = new Float32Array([
        -w/2, -d/2, 0,       // 0 front-left (low)
         w/2, -d/2, 0,       // 1 front-right (low)
         w/2,  d/2, ridgeH,  // 2 back-right (high)
        -w/2,  d/2, ridgeH,  // 3 back-left (high)
        -w/2,  d/2, 0,       // 4 back-left (base)
         w/2,  d/2, 0,       // 5 back-right (base)
      ]);
      const idx = new Uint16Array([
        0,1,2, 0,2,3,   // slope surface
        0,3,4,          // left gable end
        1,5,2,          // right gable end
        0,4,5, 0,5,1,   // floor
      ]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(v, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.computeVertexNormals();
      return geo;
    }
    default: {
      // flat: low box slab
      const geo = new THREE.BoxGeometry(w, d, Math.max(0.15, ridgeH * 0.3));
      geo.translate(0, 0, Math.max(0.15, ridgeH * 0.3) / 2);
      return geo;
    }
  }
}

registerHandler("IfcRoof", (args) => {
  const roofType = (args.roofType as string | undefined) ?? "flat";
  const pitch   = (args.pitchDeg    as number | undefined) ?? 30;
  const fp      = args.footprint as number[][] | undefined;
  let w = 8, d = 10;
  if (fp && fp.length >= 2) {
    const xs = fp.map((p) => p[0]);
    const ys = fp.map((p) => p[1]);
    w = (Math.max(...xs) - Math.min(...xs)) || 8;
    d = (Math.max(...ys) - Math.min(...ys)) || 10;
  }
  const ridgeH = (args.ridgeHeight as number | undefined) ?? (Math.min(w, d) / 2 * Math.tan((pitch * Math.PI) / 180));
  const geom   = buildRoofGeometry(roofType, w, d, ridgeH);
  const mat  = new THREE.MeshStandardMaterial({ color: 0x7a5c4a, roughness: 0.75, metalness: 0.02, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  const elev = (args.elevation as number | undefined) ?? (getActiveLevelElevation() + 3);
  mesh.position.z = elev;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcRoof";
  mesh.userData.roofType = roofType;
  mesh.userData.ifcPredefinedType = ({
    flat: "FLAT_ROOF",
    pitched: "GABLE_ROOF",
    hipped: "HIP_ROOF",
    shed: "SHED_ROOF",
    curved: "BARREL_ROOF",
    combination: "MANSARD_ROOF",
  } as Record<string, string>)[roofType] ?? "NOTDEFINED";
  mesh.userData.layerId = resolveLayerId("IfcRoof", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "roof", roofType, width: w, depth: d, ridgeHeight: ridgeH, ifcPredefinedType: mesh.userData.ifcPredefinedType };
});

registerHandler("IfcSpace", (args) => {
  const h  = (args.height as number | undefined) ?? 2.8;
  const fp = args.footprint as number[][] | undefined;
  let w = 5, d = 4;
  if (fp && fp.length >= 2) {
    const xs = fp.map((p) => p[0]);
    const ys = fp.map((p) => p[1]);
    w = (Math.max(...xs) - Math.min(...xs)) || 5;
    d = (Math.max(...ys) - Math.min(...ys)) || 4;
  }
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat  = new THREE.MeshBasicMaterial({ color: 0x90c8ff, transparent: true, opacity: 0.15, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.z = getActiveLevelElevation();
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcSpace";
  mesh.userData.layerId = resolveLayerId("IfcSpace", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  if (args.name) mesh.userData.spaceName = args.name as string;
  viewer.addMesh(mesh, "brep");
  return { created: "space", width: w, depth: d, height: h };
});

// ── IFC Tier 3: Foundation / Ceiling / CurtainWall / Skylight / Opening / Ramp / Railing / Grid / Level / Datum ──

registerHandler("IfcFoundation", (args) => {
  const w = (args.width     as number | undefined) ?? 6;
  const d = (args.depth     as number | undefined) ?? 6;
  const t = (args.thickness as number | undefined) ?? 0.5;
  const geom = new THREE.BoxGeometry(w, d, t);
  geom.translate(0, 0, -t / 2);
  const mat  = new THREE.MeshStandardMaterial({ color: 0x8a7563, roughness: 0.85, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  const pos  = args.position as number[] | undefined;
  if (pos) mesh.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? getActiveLevelElevation());
  else mesh.position.z = getActiveLevelElevation();
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcFoundation";
  mesh.userData.layerId = resolveLayerId("IfcFoundation", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "foundation", width: w, depth: d };
});

registerHandler("IfcCeiling", (args) => {
  const w    = (args.width     as number | undefined) ?? 5;
  const d    = (args.depth     as number | undefined) ?? 4;
  const t    = (args.thickness as number | undefined) ?? 0.05;
  const elev = (args.elevation as number | undefined) ?? (getActiveLevelElevation() + 2.8);
  const geom = new THREE.BoxGeometry(w, d, t);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xfaf5ec, roughness: 0.5, metalness: 0.02 });
  const mesh = new THREE.Mesh(geom, mat);
  const pos  = args.position as number[] | undefined;
  mesh.position.set(pos?.[0] ?? 0, pos?.[1] ?? 0, elev);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcCeiling";
  mesh.userData.layerId = resolveLayerId("IfcCeiling", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "ceiling", width: w, depth: d, elevation: elev };
});

registerHandler("IfcCurtainWall", (args) => {
  const wallLen = (args.length as number | undefined) ?? 6;
  const h  = (args.height as number | undefined) ?? 3;
  const t  = 0.02;
  const geom = new THREE.BoxGeometry(wallLen, t, h);
  geom.translate(0, 0, h / 2);
  const mat  = new THREE.MeshBasicMaterial({ color: 0xaadcff, transparent: true, opacity: 0.35 });
  const mesh = new THREE.Mesh(geom, mat);
  const pos  = args.position as number[] | undefined;
  if (pos) mesh.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? getActiveLevelElevation());
  else mesh.position.z = getActiveLevelElevation();
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcCurtainWall";
  mesh.userData.layerId = resolveLayerId("IfcCurtainWall", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "curtainwall", length: wallLen, height: h };
});

registerHandler("IfcPlate", (args) => {
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
  mesh.userData.creator = "IfcPlate";
  mesh.userData.layerId = resolveLayerId("IfcPlate", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "plate", thickness, profile_points: pts.length };
});

registerHandler("IfcSkylight", (args) => {
  const w    = (args.width     as number | undefined) ?? 1.2;
  const d    = (args.depth     as number | undefined) ?? 1.2;
  const elev = (args.elevation as number | undefined) ?? (getActiveLevelElevation() + 3);
  const geom = new THREE.BoxGeometry(w, d, 0.04);
  const mat  = new THREE.MeshBasicMaterial({ color: 0xeef5ff, transparent: true, opacity: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  const pos  = args.position as number[] | undefined;
  if (pos) mesh.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? elev);
  else mesh.position.z = elev;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcSkylight";
  mesh.userData.layerId = resolveLayerId("IfcSkylight", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "skylight", width: w, depth: d };
});

registerHandler("IfcOpening", (args) => {
  const hostUuidOp = args.hostUuid as string | undefined;
  const hostObjOp = hostUuidOp
    ? viewer.getScene().getObjectByProperty("uuid", hostUuidOp) ?? undefined
    : undefined;
  const cplane = resolveCPlane("IfcOpening", args as Record<string, unknown>, viewer, hostObjOp);
  const w = (args.width  as number | undefined) ?? 1;
  const h = (args.height as number | undefined) ?? 2;
  const t = 0.25;
  const geom = new THREE.BoxGeometry(w, t, h);
  geom.translate(0, 0, h / 2);
  const mat  = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.1, wireframe: true });
  const mesh = new THREE.Mesh(geom, mat);
  const pos  = args.position as number[] | undefined;
  const elevation = getActiveLevelElevation();
  if (pos) mesh.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? elevation);
  else mesh.position.z = elevation;
  // Align opening marker to host wall normal (W-2).
  if (cplane.kind === "host-derived") {
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), cplane.normal,
    );
    mesh.quaternion.copy(q);
  }
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcOpening";
  mesh.userData.cplaneKind = cplane.kind;
  mesh.userData.layerId = resolveLayerId("IfcOpening", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  let voidCut = false;
  const hostUuid = args.hostUuid as string | undefined;
  if (hostUuid) {
    const host = viewer.getScene().getObjectByProperty("uuid", hostUuid);
    if (host instanceof THREE.Mesh) {
      const voidCenter = mesh.position.clone();
      voidCenter.z = elevation + h / 2;
      cutRectVoidFromBoxMesh(host, voidCenter, w, h);
      voidCut = true;
    }
  }
  return { created: "opening", width: w, height: h, voidCut };
});

registerHandler("IfcRamp", (args) => {
  const s   = (args.start as number[] | undefined) ?? [0, 0, 0];
  const e   = (args.end   as number[] | undefined) ?? [4, 0, 0];
  const w   = (args.width as number | undefined) ?? 1.2;
  const dx  = e[0] - s[0], dy = e[1] - s[1];
  const run = Math.sqrt(dx * dx + dy * dy) || 4;
  const geom = new THREE.BoxGeometry(run, w, 0.15);
  geom.translate(run / 2, 0, 0);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xc4a882, roughness: 0.65, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(s[0], s[1], (s[2] as number | undefined) ?? getActiveLevelElevation());
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcRamp";
  mesh.userData.layerId = resolveLayerId("IfcRamp", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "ramp", run, width: w };
});

registerHandler("IfcRailing", (args) => {
  const s   = (args.start  as number[] | undefined) ?? [0, 0, 0];
  const e   = (args.end    as number[] | undefined) ?? [3, 0, 0];
  const h   = (args.height as number | undefined) ?? 1;
  const dx  = e[0] - s[0], dy = e[1] - s[1];
  const len = Math.sqrt(dx * dx + dy * dy) || 3;
  const geom = new THREE.BoxGeometry(len, 0.05, h);
  geom.translate(0, 0, h / 2);
  const mat  = new THREE.MeshStandardMaterial({ color: 0x555566, roughness: 0.4, metalness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set((s[0] + e[0]) / 2, (s[1] + e[1]) / 2, (s[2] as number | undefined) ?? getActiveLevelElevation());
  mesh.rotation.z = Math.atan2(dy, dx);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcRailing";
  mesh.userData.layerId = resolveLayerId("IfcRailing", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "railing", length: len, height: h };
});

registerHandler("IfcGrid", (args) => {
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

registerHandler("IfcLevel", (args) => {
  const elev   = (args.elevation as number | undefined) ?? 0;
  const name   = (args.name as string | undefined) ?? `Level ${levelStore.all().length}`;
  const height = (args.height as number | undefined) ?? 3.0;
  const extent = (args.extent  as number | undefined) ?? 10;
  // Register in levelStore so UI panel + active-level routing knows about it.
  const level = levelStore.findOrCreate(name, elev, height);
  const geom   = new THREE.BoxGeometry(extent, extent, 0.02);
  const mat    = new THREE.MeshBasicMaterial({ color: 0x44aa88, transparent: true, opacity: 0.2, side: THREE.DoubleSide });
  const mesh   = new THREE.Mesh(geom, mat);
  mesh.position.z = elev;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcLevel";
  mesh.userData.levelId = level.id;
  viewer.addMesh(mesh, "brep");
  return { created: "level", elevation: elev, levelId: level.id };
});

registerHandler("setActiveLevel", (args) => {
  const id = args.id as string | undefined;
  if (!id) return { error: "id required" };
  const ok = levelStore.setActive(id);
  if (!ok) return { error: `level not found: ${id}` };
  const level = levelStore.get(id);
  if (level) viewer.setTargetElevation(level.elevation);
  return { ok: true, activeLevel: id, elevation: level?.elevation };
});

registerHandler("setLevelVisible", (args) => {
  const id      = args.id as string | undefined;
  const visible = args.visible as boolean | undefined;
  if (!id || visible === undefined) return { error: "id and visible required" };
  const ok = levelStore.setVisible(id, visible);
  if (!ok) return { error: `level not found: ${id}` };
  // Toggle THREE.js meshes tagged with this levelId.
  viewer.forEachSceneChild((child) => {
    if (child.userData?.levelId === id) child.visible = visible;
  });
  return { ok: true, levelId: id, visible };
});

registerHandler("IfcDatum", (args) => {
  const pos  = (args.position as number[] | undefined);
  const elev = (args.elevation as number | undefined) ?? pos?.[2] ?? 0;
  const geom = new THREE.SphereGeometry(0.15, 8, 8);
  const mat  = new THREE.MeshStandardMaterial({ color: 0x33bb66, roughness: 0.3, metalness: 0.2 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(pos?.[0] ?? 0, pos?.[1] ?? 0, elev);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcDatum";
  if (args.label) mesh.userData.label = args.label as string;
  viewer.addMesh(mesh, "brep");
  return { created: "datum", elevation: elev };
});

registerHandler("IfcReferenceLine", (args) => {
  const origin = (args.origin as number[] | undefined) ?? [0, 0];
  const end    = (args.end    as number[] | undefined) ?? [5, 0];
  const ax = origin[0] ?? 0, ay = origin[1] ?? 0;
  const bx = end[0]    ?? 5, by = end[1]    ?? 0;
  const dx = bx - ax, dy = by - ay;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const cx = (ax + bx) / 2, cy = (ay + by) / 2;
  const angRad = Math.atan2(dy, dx) - Math.PI / 2;
  const points = [new THREE.Vector3(0, -len / 2, 0), new THREE.Vector3(0, len / 2, 0)];
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0xcc1166 });
  const line = new THREE.Line(geom, mat);
  line.position.set(cx, cy, 0.002);
  line.rotation.z = angRad;
  line.userData.kind = "reference-line";
  line.userData.creator = "IfcReferenceLine";
  line.userData.controlPoints = [[ax, ay, 0], [bx, by, 0]];
  viewer.addMesh(line, "brep");
  return { created: "reference-line", origin: [ax, ay], end: [bx, by] };
});

registerHandler("IfcFurnishingElement", (args) => {
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
  mesh.userData.creator = "IfcFurnishingElement";
  mesh.userData.layerId = resolveLayerId("IfcFurnishingElement", args);
  mesh.userData.levelId = getActiveLevelId();
  mesh.userData.dispatchArgs = args;
  viewer.addMesh(mesh, "brep");
  return { created: "furnishing", width: w, depth: d, height: h };
});

// ── Tier 1 handlers: SdPoint / SdLine / SdRectangle / SdPolyline (#64) ───────
// These replace the fan-out shims installed by installDefaultHandlers() below.
// Render using THREE line/point primitives (not mesh geometry) per Jun's
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
  const pos = (args.position as number[] | undefined) ?? [0, 0, 0];
  const p = Prim3.create(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([p.x, p.y, p.z], 3));
  const obj = new THREE.Points(geom, buildPointMaterial());
  obj.userData.kind = "point";
  obj.userData.creator = "SdPoint";
  viewer.addMesh(obj, "mesh");
  return { created: "point", position: [p.x, p.y, p.z] };
});

registerHandler("SdLine", (args) => {
  const start = (args.start as number[] | undefined) ?? [0, 0, 0];
  const end   = (args.end   as number[] | undefined) ?? [1, 0, 0];
  const sx = start[0] ?? 0, sy = start[1] ?? 0, sz = start[2] ?? 0;
  const ex = end[0] ?? 1, ey = end[1] ?? 0, ez = end[2] ?? 0;
  const cx = (sx + ex) / 2, cy = (sy + ey) / 2, cz = (sz + ez) / 2;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([
    sx - cx, sy - cy, sz - cz,
    ex - cx, ey - cy, ez - cz,
  ], 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 });
  const obj = new THREE.LineSegments(geom, mat);
  obj.position.set(cx, cy, cz);
  obj.userData.kind = "line";
  obj.userData.creator = "line";
  obj.userData.controlPoints = [new THREE.Vector3(sx, sy, sz), new THREE.Vector3(ex, ey, ez)];
  viewer.addMesh(obj, "mesh");
  return { created: "line", start, end };
});

registerHandler("SdRectangle", (args) => {
  const w = (args.width  as number | undefined) ?? 1;
  const h = (args.depth  as number | undefined) ?? (args.height as number | undefined) ?? 1;
  const c = (args.center as number[] | undefined) ?? [0, 0, 0];
  const x0 = (c[0] ?? 0) - w / 2, x1 = (c[0] ?? 0) + w / 2;
  const y0 = (c[1] ?? 0) - h / 2, y1 = (c[1] ?? 0) + h / 2;
  const z  =  c[2] ?? 0;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([
    x0, y0, z,  x1, y0, z,  x1, y1, z,  x0, y1, z,
  ], 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x000000 });
  const obj = new THREE.LineLoop(geom, mat);
  obj.userData.kind = "rectangle";
  obj.userData.creator = "SdRectangle";
  viewer.addMesh(obj, "mesh");
  return { created: "rectangle", width: w, depth: h, center: c };
});

registerHandler("SdPolyline", (args) => {
  const points = (args.points as number[][] | undefined) ?? [];
  if (points.length < 2) return { error: "SdPolyline requires at least 2 points", created: null };
  const closed = (args.closed as boolean | undefined) ?? false;
  const flat = points.flatMap((p) => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x000000 });
  const obj = closed ? new THREE.LineLoop(geom, mat) : new THREE.Line(geom, mat);
  obj.userData.kind = "polyline";
  obj.userData.creator = "polyline";
  obj.userData.controlPoints = points.map((p) => new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0));
  viewer.addMesh(obj, "mesh");
  return { created: "polyline", points, closed };
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
  obj.userData.creator = "SdArc";
  viewer.addMesh(obj, "mesh");
  return { created: "arc", center: ptToArray(arc.center), radius, startAngle, endAngle };
});

registerHandler("SdCircle", (args) => {
  const c = (args.center as number[] | undefined) ?? [0, 0, 0];
  const radius = (args.radius as number | undefined) ?? 1;
  const arc: PrimArc = {
    center: Prim3.create(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0),
    radius,
    startAngle: 0,
    endAngle: 2 * Math.PI,
    plane: PrimPlane.worldXY(),
  };
  const nurbs = nurbsCurveFromArc(arc);
  const pts = tessellate(nurbs, 128);
  const obj = new THREE.LineLoop(polylineToGeom(pts), curveMat());
  obj.userData.kind = "circle";
  obj.userData.creator = "SdCircle";
  viewer.addMesh(obj, "mesh");
  return { created: "circle", center: ptToArray(arc.center), radius };
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
  obj.userData.creator = "SdEllipse";
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
  obj.userData.creator = "SdSpline";
  obj.userData.controlPoints = pts3.map(p => new THREE.Vector3(p.x, p.y, p.z));
  viewer.addMesh(obj, "mesh");
  return { created: "spline", points: pts3.map(p => ptToArray(p)) };
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
    obj.userData.creator = "SdRevolve";
    viewer.addMesh(obj, "mesh");
    return { created: "revolution", axisFrom: args.axisFrom, axisTo: args.axisTo, angleStart: start, angleEnd: end };
  } catch (e) {
    return { error: String(e), created: null };
  }
});

registerHandler("SdSweep", (args) => {
  try {
    const profile = resolveCurve(args.profile);
    const rail    = resolveCurve(args.rail);
    const surface = sweepSurface(profile, rail, { keepFrame: (args.keepFrame as boolean) ?? false });
    const tess = tessellateSurface(surface, 32, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "sweep";
    obj.userData.creator = "SdSweep";
    viewer.addMesh(obj, "mesh");
    return { created: "sweep" };
  } catch (e) {
    return { error: String(e), created: null };
  }
});

registerHandler("SdLoft", (args) => {
  try {
    const rawCurves = (args.curves as unknown[] | undefined) ?? [];
    if (rawCurves.length < 2) return { error: "SdLoft requires at least 2 curves", created: null };
    const curves = rawCurves.map((c) => resolveCurve(c));
    const surface = loftSurfaces(curves, {
      closed:  (args.closed  as boolean) ?? false,
      degreeV: (args.degreeV as number)  ?? Math.min(3, curves.length - 1),
    });
    const tess = tessellateSurface(surface, 32, 32);
    const obj = surfaceToMesh(tess);
    obj.userData.kind = "loft";
    obj.userData.creator = "SdLoft";
    viewer.addMesh(obj, "mesh");
    return { created: "loft", curveCount: curves.length };
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
    obj.userData.creator = "SdArray";
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
        viewer.addMesh(p, "mesh");
        batchObjs.push(p);
      } else {
        const clone = baseObj.clone(true);
        clone.position.set(
          baseObj.position.x + dx,
          baseObj.position.y + dy,
          baseObj.position.z + dz,
        );
        clone.userData.creator = "SdArray";
        viewer.addMesh(clone, (clone.userData.kind as string | undefined) ?? "mesh");
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

registerHandler("SdResetCPlane", () => {
  const reset: CPlane = { ...WORLD_XY };
  viewer.activeCPlane = reset;
  window.dispatchEvent(new CustomEvent("viewer:cplane-changed", {
    detail: { cplane: reset, mode: "world" },
    bubbles: false,
  }));
  return { reset: true };
});

// Install shim handlers for every dictionary verb that doesn't have a native
// handler yet. This makes all 66+ verbs reachable by the agent (#58 Tier 0).
// Explicit registerHandler() calls above take priority — installDefaultHandlers
// skips any canonical name that already has a handler.
installDefaultHandlers();

const scenePanel = new ScenePanel(scenePanelEl, viewer);

registerHandler("SdClearScene", () => {
  viewer.clearScene();
  scenePanel.clear();
  resetRibbonElementTypes();
  clearSelected();
  window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
  return { ok: true, cleared: true };
});

// Isolate status bar indicator — show/hide #sb-isolate on viewer:isolate-changed.
document.addEventListener("viewer:isolate-changed", (e) => {
  const cell = document.getElementById("sb-isolate");
  if (!cell) return;
  const uuid = (e as CustomEvent<{ uuid: string | null }>).detail?.uuid;
  cell.style.display = uuid ? "" : "none";
});

// Navigation hotkeys — Blender-numpad keymap, with letter fallbacks for
// keyboards without a numpad. Captured at window level but ignored if the
// user is typing in any input/textarea/contenteditable.
window.addEventListener("keydown", (e) => {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
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
      pendingStl = msg.stl.byteLength > 0 ? msg.stl : null;
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
  const dx = (b.max[0] - b.min[0]).toFixed(2);
  const dy = (b.max[1] - b.min[1]).toFixed(2);
  const dz = (b.max[2] - b.min[2]).toFixed(2);
  return `${dx}×${dy}×${dz}m`;
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
  pendingStl = null; // STL is replicad-only; loaded-file path doesn't ship one.
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
    // STL is only available when the prompt path produced a binary STL blob.
    if (fmt === "stl") {
      btn.disabled = !pendingStl;
      continue;
    }
    // STEP is only available when the source is a replicad-generated shape
    // (currently we don't keep the OCCT shape handle around outside the
    // worker, so STEP write is gated to "prompt" source for now).
    if (fmt === "step") {
      btn.disabled = currentSource.kind !== "prompt";
      continue;
    }
    btn.disabled = false;
  }
}

async function handleExport(fmt: string): Promise<void> {
  const stem = currentSource.kind === "prompt"
    ? currentDemo.id
    : currentSource.kind === "file"
      ? sanitizeStem(currentSource.filename)
      : "export";
  try {
    if (fmt === "ifc") {
      await exportIfc(stem);
      return;
    }
    if (fmt === "stl") {
      if (pendingStl) {
        downloadBlob(new Blob([pendingStl], { type: "model/stl" }), `${stem}.stl`);
        setStatus(`STL · ${(pendingStl.byteLength / 1024).toFixed(1)} KB`, "ok");
      } else {
        setStatus("STL only available for replicad-generated geometry.", "warn");
      }
      return;
    }
    const obj = viewer.getActiveObject();
    if (!obj) {
      setStatus("No geometry loaded.", "warn");
      return;
    }
    setStatus(`Exporting ${fmt.toUpperCase()}...`, "info");
    if (fmt === "obj") {
      const text = exportObj(obj);
      downloadBlob(new Blob([text], { type: "model/obj" }), `${stem}.obj`);
      setStatus(`OBJ · ${(text.length / 1024).toFixed(1)} KB`, "ok");
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
      setStatus("STEP export is stubbed for the import pass — coming next.", "warn");
    } else {
      setStatus(`Unknown export format: ${fmt}`, "err");
    }
  } catch (e) {
    setStatus(`Export ${fmt.toUpperCase()} failed: ${(e as Error).message}`, "err");
  }
}

function sanitizeStem(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_\-]+/g, "_") || "export";
}

// Creator tags that are spatial/structural only — skip in IFC element export.
const IFC_SKIP_CREATORS = new Set(["IfcGrid", "IfcGridLine", "IfcLevel", "IfcDatum", "IfcReferenceLine"]);

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
    if (sceneElements.length > 0) {
      bytes = buildIfcScene(sceneElements, exportLevels);
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
            : "GemmaArchitect Element";
      bytes = buildIfc({ vertices: data.vertices, indices: data.indices }, label);
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
const workbenchEl = document.querySelector(".workbench") as HTMLElement | null;
initShellChrome({
  onModeChange: (k) => {
    activateMode(k, workbenchEl);
    setRibbonMode(k as "model" | "layout" | "research");
  },
  onSplitMode: (mode) => viewer.splitMode(mode),
});
buildWorkbench();
if (workbenchEl) buildModes(workbenchEl);
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

