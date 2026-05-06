// Wires the UI: prompt mode (existing) + file-load mode (new).
//
// The prompt-mode flow is unchanged from the v1 release — dropdown, textarea,
// Run button, worker, viewer.setMesh.
// The file-load flow accepts IFC/STEP via the worker (heavy parsing) and
// GLB/GLTF/OBJ/STL on the main thread via three.js JSM loaders.
//
// Export menu is shared: the active source (whether replicad-generated or
// loaded-from-file) is queried via viewer.getActiveMeshData().

import { initShellChrome, setRibbonMode } from "./shell";
import { initPalette } from "./palette";
import { buildWorkbench } from "./workbench";
import { buildModes, activateMode } from "./modes";
import { initCmdK } from "./cmdk";
import { initExportDrawer, openExportDrawer } from "./export-drawer";
import { Viewer } from "./viewer";
import { ScenePanel, type SceneSummary } from "./scene-panel";
import { applyDrafting, removeDrafting, isDrafting } from "./drafting";
import { DEMOS, applyParams, type DemoPrompt, type Param } from "./demo-prompts";
import { buildIfc, ifcRoundTrip } from "./ifc";
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
import { syncToolActiveClass } from "./app-state";
import { initCreateMode } from "./create-mode";
import { undo, redo } from "./history";
import { registerHandler, dispatchSync } from "./dispatch";
import { addToMultiSelected, clearMultiSelected, getFilters, topologyAllowed } from "./selection-state";
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
syncToolActiveClass();
initCreateMode(viewer);

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
  const geom = new THREE.BoxGeometry(w, d, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9c0a8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "SdBox";
  viewer.addMesh(mesh, "brep");
  return { created: "box", width: w, depth: d, height: h };
});

registerHandler("SdSphere", (args) => {
  const r = (args.radius as number | undefined) ?? 1;
  const geom = new THREE.SphereGeometry(r, 32, 16);
  const mat = new THREE.MeshStandardMaterial({ color: 0xb6d59a, roughness: 0.4, metalness: 0.0 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.z = r;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "SdSphere";
  viewer.addMesh(mesh, "brep");
  return { created: "sphere", radius: r };
});

registerHandler("SdCylinder", (args) => {
  const r = (args.radius as number | undefined) ?? 0.5;
  const h = (args.height as number | undefined) ?? 2;
  const geom = new THREE.CylinderGeometry(r, r, h, 32);
  geom.rotateX(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9ec5d8, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.z = h / 2;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "SdCylinder";
  viewer.addMesh(mesh, "brep");
  return { created: "cylinder", radius: r, height: h };
});

registerHandler("SdCone", (args) => {
  const r = (args.radius as number | undefined) ?? 0.5;
  const h = (args.height as number | undefined) ?? 2;
  const geom = new THREE.ConeGeometry(r, h, 32);
  geom.rotateX(Math.PI / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd0a868, roughness: 0.55, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.z = h / 2;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "SdCone";
  viewer.addMesh(mesh, "brep");
  return { created: "cone", radius: r, height: h };
});

registerHandler("IfcWall", (args) => {
  const profile = (args.profile as [number, number][]) ?? [[0, 0], [4, 0]];
  const t = (args.thickness as number | undefined) ?? 0.3;
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
    mesh.position.set((profile[0][0] + profile[profile.length - 1][0]) / 2, (profile[0][1] + profile[profile.length - 1][1]) / 2, 0);
    mesh.rotation.z = Math.atan2(dy, dx);
  }
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcWall";
  viewer.addMesh(mesh, "brep");
  return { created: "wall", length: len, thickness: t, height: wallH };
});

registerHandler("IfcSlab", (args) => {
  const w = (args.width as number | undefined) ?? (args.length as number | undefined) ?? 4;
  const d = (args.depth as number | undefined) ?? (args.width as number | undefined) ?? 4;
  const t = (args.thickness as number | undefined) ?? 0.2;
  const elev = (args.elevation as number | undefined) ?? 0;
  const geom = new THREE.BoxGeometry(w, d, t);
  const mat = new THREE.MeshStandardMaterial({ color: 0xa8a097, roughness: 0.7, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.z = elev;
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcSlab";
  viewer.addMesh(mesh, "brep");
  return { created: "slab", width: w, depth: d };
});

registerHandler("IfcColumn", (args) => {
  const s = (args.size as number | undefined) ?? 0.3;
  const h = (args.height as number | undefined) ?? 4;
  const geom = new THREE.BoxGeometry(s, s, h);
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0xd1c5b0, roughness: 0.6, metalness: 0.05 });
  const mesh = new THREE.Mesh(geom, mat);
  const p = args.position as [number, number] | undefined;
  if (p) mesh.position.set(p[0], p[1], 0);
  mesh.userData.kind = "brep";
  mesh.userData.creator = "IfcColumn";
  viewer.addMesh(mesh, "brep");
  return { created: "column", height: h };
});

const scenePanel = new ScenePanel(scenePanelEl, viewer);

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
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
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

worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  const msg = ev.data;
  if (msg.type === "ready") {
    workerReady = true;
    runBtn.disabled = false;
    setStatus("OpenCascade ready. Running first demo…", "info");
    pendingRuns.forEach((fn) => fn());
    pendingRuns.length = 0;
    // Auto-run the loaded demo on first ready so the viewer isn't empty on landing.
    runJs(jsSource.value);
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
          buildIfcMesh(msg, file.name).then((scene) => finalizeFileLoad(scene, file.name));
        } else if (msg.type === "load-ifc-error") {
          setStatus(`IFC parse failed: ${msg.error}`, "err");
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
  };
  // Summary string for IFC looks like
  //   "<filename> · 7,123 entities · 56,832 triangles · IFC4"
  const m = scene.summary.match(/(\d[\d,]*)\s+entit/i);
  if (m) summary.entityCount = parseInt(m[1].replace(/,/g, ""), 10);
  const sm = scene.summary.match(/IFC[24X]+/i);
  if (sm) summary.schema = sm[0].toUpperCase();
  scenePanel.update(summary);
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

async function exportIfc(stem: string): Promise<void> {
  const data = viewer.getActiveMeshData();
  if (!data) {
    setStatus("No mesh data available to export as IFC.", "warn");
    return;
  }
  setStatus("Building IFC + verifying round-trip via web-ifc...", "info");
  try {
    const label =
      currentSource.kind === "prompt"
        ? currentDemo.label
        : currentSource.kind === "file"
          ? `Imported ${currentSource.filename}`
          : "GemmaArchitect Element";
    const bytes = buildIfc({ vertices: data.vertices, indices: data.indices }, label);
    const result = await ifcRoundTrip(bytes);
    if (result.ok) {
      setStatus(
        `IFC4 ${(result.byteSize / 1024).toFixed(1)} KB · ${result.productCount} proxy · ${result.schema} round-trip OK`,
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
initPalette();
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
loadDemo(0);
setStatus("Loading OpenCascade WebAssembly...", "info");
runBtn.disabled = true;
refreshExportButtons(true);
