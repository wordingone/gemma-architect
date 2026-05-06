// Workbench scaffolding — design-handoff #172 + #174 + #175.
//
// Builds the bundle's three-pane workbench structure:
//   .workbench grid (44px palette / 1fr center-col / 280px sidebar)
//     .palette       — left gutter, icon-only tool buttons in sections
//     .center-col    — viewport-area + dock-divider + dock
//     .sidebar       — right rail, SCENE / INSPECT / ASSETS tabs + snap-dock
//
// The dock has 5 tabs (PROMPT / CONSOLE / NODES / PARAMETERS / HISTORY).
// Existing prompt-pane content moves into the PROMPT tab body; param-panel
// into PARAMETERS; scene-panel into the SCENE sidebar tab. The IDs remain
// intact so main.ts wiring (run button, file picker, sample selector, etc.)
// keeps working without changes.

import { iconSVG, axesGizmoSVG } from "./icons";
import { generateGeometry, GenerateError } from "./ai-generate";
import { ChatPanel } from "./chat-panel";
import { compileDsl } from "./dsl-eval";
import { dispatchSync, type DispatchArgs } from "./dispatch";
import { setState } from "./app-state";
import { setGridOn, setSnapOn, setOrthoOn, setPolarOn, setVertexSnapOn, setEdgeSnapOn, setStep, setAngleStep, getSnap } from "./snap-state";
import { buildSelectionFiltersPanel } from "./scene-panel";
import * as THREE from "three";
import { subscribe, getSelected, subscribeMulti, getMultiSelected, type Selection } from "./selection-state";
import { getCreateSequence } from "./create-mode";

// Push a line into the in-page CONSOLE dock tab. The tab body lives in
// buildConsoleTabBody and re-implements its own local pushLine for the DSL
// terminal — this exported variant lets runGenerate (and any future caller)
// surface telemetry there too. Falls back to console.log when the dock isn't
// mounted yet.
function pushConsoleLine(kind: "cmd" | "ok" | "err" | "info", text: string): void {
  const history = document.getElementById("console-history");
  if (!history) {
    console.log(`[console:${kind}] ${text}`);
    return;
  }
  const d = new Date();
  const ts =
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0");
  const glyph = kind === "cmd" ? "›" : kind === "ok" ? "✓" : kind === "err" ? "✗" : "·";
  const line = document.createElement("div");
  line.className = `console-line ${kind}`;
  line.innerHTML = `<span class="ts"></span><span class="glyph"></span><span class="text"></span>`;
  line.querySelector(".ts")!.textContent = ts;
  line.querySelector(".glyph")!.textContent = glyph;
  line.querySelector(".text")!.textContent = text;
  history.appendChild(line);
  history.scrollTop = history.scrollHeight;
}

type PaletteSection = { tools: { id: string; icon: string; label: string }[] };

const PALETTE_SECTIONS: PaletteSection[] = [
  { tools: [
    { id: "select",  icon: "select",  label: "Select" },
    { id: "move",    icon: "move",    label: "Move" },
    { id: "rotate",  icon: "rotate",  label: "Rotate" },
    { id: "scale",   icon: "scale",   label: "Scale" },
  ]},
  { tools: [
    { id: "line",    icon: "line",    label: "Line" },
    { id: "rect",    icon: "rect",    label: "Rectangle" },
    { id: "circle",  icon: "circle",  label: "Circle" },
    { id: "polyline",icon: "polyline",label: "Polyline" },
    { id: "curve",   icon: "curve",   label: "Curve" },
    { id: "point",   icon: "point",   label: "Point" },
  ]},
  { tools: [
    { id: "extrude", icon: "extrude", label: "Extrude" },
    { id: "boolean", icon: "boolean", label: "Boolean" },
    { id: "fillet",  icon: "fillet",  label: "Fillet" },
  ]},
  { tools: [
    { id: "wall",    icon: "wall",    label: "Wall" },
    { id: "slab",    icon: "slab",    label: "Slab" },
    { id: "column",  icon: "column",  label: "Column" },
    { id: "stair",   icon: "stair",   label: "Stair" },
  ]},
];

type DockTab = { id: string; icon: string; label: string };
const DOCK_TABS: DockTab[] = [
  { id: "prompt",     icon: "sparkle",  label: "CREATE" },
  { id: "nodes",      icon: "graph",    label: "NODES" },
  { id: "parameters", icon: "sliders",  label: "PARAMETERS" },
  { id: "history",    icon: "history",  label: "HISTORY" },
];

// Merged PROMPT/CONSOLE input: one tab, two modes. Shift+Tab toggles.
//   "prompt"  → NL → ai-generate (cache → LoRA fallback) → JS → kernel
//   "console" → DSL / `:verb` registry → compileDsl/dispatchSync → JS → kernel
// Persists per-session via localStorage.
type ConsoleMode = "prompt" | "console";
const CONSOLE_MODE_LS_KEY = "gemma-architect:console-mode-v1";
function loadConsoleMode(): ConsoleMode {
  try {
    const v = localStorage.getItem(CONSOLE_MODE_LS_KEY);
    return v === "console" ? "console" : "prompt";
  } catch { return "prompt"; }
}
function saveConsoleMode(m: ConsoleMode): void {
  try { localStorage.setItem(CONSOLE_MODE_LS_KEY, m); } catch {}
}

// Exposed so cmdk can flip the mode without round-tripping through the DOM.
let _setConsoleModeFn: ((m: ConsoleMode) => void) | null = null;
export function setConsoleMode(m: ConsoleMode): void {
  _setConsoleModeFn?.(m);
}

type SidebarTab = { id: string; label: string };
const SIDEBAR_TABS: SidebarTab[] = [
  { id: "scene",   label: "SCENE" },
  { id: "inspect", label: "INSPECT" },
  { id: "assets",  label: "ASSETS" },
];

const SAMPLE_ASSETS = [
  { id: "schultz", name: "Schultz Resid.",  sub: "IFC · 22 MB",   v: "schultz-residence" },
  { id: "haus",    name: "FZK-Haus",        sub: "IFC · 412 KB",  v: "kit-fzk-haus" },
  { id: "inst",    name: "Institute v2",    sub: "IFC · 1.2 MB",  v: "kit-office" },
  { id: "bonsai",  name: "Bonsai openings", sub: "IFC · 88 KB",   v: "bonsai-openings" },
  { id: "wall",    name: "Wall+Window",     sub: "IFC · 7 KB",    v: "wall-with-opening" },
  { id: "sweep",   name: "Sweep · simple",  sub: "IFC · 12 KB",   v: "simple-sweep" },
  { id: "tri-obj", name: "Triangle",        sub: "OBJ · 1 KB",    v: "triangle-obj" },
  { id: "tri-stl", name: "Triangle",        sub: "STL · 1 KB",    v: "triangle-stl" },
];

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function buildPalette(host: HTMLElement) {
  host.innerHTML = "";
  for (const section of PALETTE_SECTIONS) {
    const sec = el("div", "palette-section");
    for (const tool of section.tools) {
      const btn = el("button", "palette-btn", { type: "button", title: tool.label, "data-tool": tool.id });
      btn.innerHTML = iconSVG(tool.icon, 18) +
        `<span class="palette-tooltip">${tool.label}</span><span class="corner"></span>`;
      // Palette button click drives app-state, which fans out to ribbon
      // tool-btns and statusbar Tool cell via subscriptions in shell.ts.
      // syncToolActiveClass (in app-state) drives the .active class on every
      // [data-tool] element, including this palette-btn — no local toggling
      // needed.
      btn.addEventListener("click", () => dispatchSync("setActiveTool", { toolId: tool.id }));
      sec.appendChild(btn);
    }
    host.appendChild(sec);
  }
  // Initial active class is driven by syncToolActiveClass in shell.ts via
  // the activeTool subscription firing once on attach (default "select").
}

function buildSnapDock(): HTMLElement {
  const root = el("div", "snap-dock");
  const snap = getSnap();
  // Mirror the selection-filters checkbox pattern in scene-panel.ts so the
  // snap dock and the selection filter panel share one visual language —
  // two-column grid, sf-row labels, native <input type=checkbox>. Each
  // checkbox is wired to the snap-state singleton; create-mode.ts (sketch
  // quantising) and viewer.ts (gumball drag + relocate snapping) read from
  // the singleton, so changing a box here flows everywhere automatically.
  const SNAP_KEYS: Array<{ key: keyof typeof snap; label: string }> = [
    { key: "snapOn",       label: "Snap" },
    { key: "orthoOn",      label: "Ortho" },
    { key: "gridOn",       label: "Grid" },
    { key: "polarOn",      label: "Polar" },
    { key: "vertexSnapOn", label: "Vertex" },
    { key: "edgeSnapOn",   label: "Edge" },
  ];
  const rows = SNAP_KEYS.map(({ key, label }) => {
    const checked = snap[key] ? "checked" : "";
    return `<label class="sf-row" style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:11px; cursor:pointer;">
      <input type="checkbox" data-snap="${key}" ${checked} style="margin:0;"/>
      <span style="color:var(--ink-soft);">${label}</span>
    </label>`;
  }).join("");
  root.innerHTML = `
    <div class="snap-dock-title">SNAP / CONSTRAIN</div>
    <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:0 12px; padding:2px 0 4px;">
      ${rows}
    </div>
    <div class="snap-row"><span class="k">step</span><input class="snap-input" id="snap-step-input" type="number" min="0.001" step="0.1" value="${snap.step.toFixed(2)}"><span class="u">m</span></div>
    <div class="snap-row"><span class="k">angle</span><input class="snap-input" id="snap-angle-input" type="number" min="0.1" step="1" value="${snap.angleStep}"><span class="u">°</span></div>
    <div class="snap-row"><span class="k">cplane</span><span class="v">XY · z=0</span></div>
  `;
  // Wire each checkbox to its corresponding snap-state setter. Setters emit
  // so subscribed listeners (viewer grid rebuild, etc.) refresh automatically.
  root.querySelectorAll<HTMLInputElement>("input[data-snap]").forEach((input) => {
    const key = input.dataset.snap;
    input.addEventListener("change", () => {
      const on = input.checked;
      switch (key) {
        case "snapOn":       setSnapOn(on); break;
        case "orthoOn":      setOrthoOn(on); break;
        case "gridOn":       setGridOn(on); break;
        case "polarOn":      setPolarOn(on); break;
        case "vertexSnapOn": setVertexSnapOn(on); break;
        case "edgeSnapOn":   setEdgeSnapOn(on); break;
      }
    });
  });
  // STEP + ANGLE inputs — change drives snap-state.setStep / setAngleStep,
  // which emits a snap-state subscription so the viewer rebuilds the grid
  // at the new step. The grid divisions equal sceneSize / step so the
  // visible gridlines and the snap increments are always one and the same.
  const stepInput = root.querySelector<HTMLInputElement>("#snap-step-input");
  if (stepInput) {
    stepInput.addEventListener("change", () => {
      const v = parseFloat(stepInput.value);
      if (Number.isFinite(v) && v > 0) {
        setStep(v);
        stepInput.value = v.toFixed(v >= 1 ? 1 : 2);
      } else {
        stepInput.value = getSnap().step.toFixed(2);
      }
    });
  }
  const angleInput = root.querySelector<HTMLInputElement>("#snap-angle-input");
  if (angleInput) {
    angleInput.addEventListener("change", () => {
      const v = parseFloat(angleInput.value);
      if (Number.isFinite(v) && v > 0) {
        setAngleStep(v);
        angleInput.value = String(v);
      } else {
        angleInput.value = String(getSnap().angleStep);
      }
    });
  }
  return root;
}

function buildSceneTab(scenePanel: HTMLElement | null): HTMLElement {
  const wrap = el("div", "tab-body scene-tab");
  if (scenePanel) {
    // Move existing scene-panel into here so main.ts wiring keeps working.
    scenePanel.classList.add("scene-panel-embed");
    wrap.appendChild(scenePanel);
  } else {
    wrap.innerHTML = `<div class="empty-hint">No scene loaded — drop an IFC/GLB or pick a sample.</div>`;
  }
  return wrap;
}

function buildInspectTab(): HTMLElement {
  const wrap = el("div", "tab-body props");
  wrap.innerHTML = `
    <div class="props-header">
      <div>
        <div class="props-title">—</div>
        <div class="props-subtitle">no selection</div>
      </div>
    </div>
    <div class="prop-section">
      <div class="prop-section-title">IDENTITY</div>
      <div class="prop-row"><span class="k">Name</span><span class="v" data-field="name">—</span></div>
      <div class="prop-row"><span class="k">Type</span><span class="v" data-field="type">—</span></div>
      <div class="prop-row"><span class="k">GUID</span><span class="v" data-field="guid">—</span></div>
      <div class="prop-row"><span class="k">Storey</span><span class="v" data-field="storey">—</span></div>
      <div class="prop-row"><span class="k">Layer</span><span class="v" data-field="layer">—</span></div>
    </div>
    <div class="prop-section">
      <div class="prop-section-title">TRANSFORM</div>
      <div class="prop-vec3">
        <span class="k">Position</span>
        <span class="axis" data-axis="X">—</span>
        <span class="axis" data-axis="Y">—</span>
        <span class="axis" data-axis="Z">—</span>
      </div>
      <div class="prop-vec3">
        <span class="k">Rotation</span>
        <span class="axis" data-axis="Rx">—</span>
        <span class="axis" data-axis="Ry">—</span>
        <span class="axis" data-axis="Rz">—</span>
      </div>
    </div>
    <div class="prop-section">
      <div class="prop-section-title">BOUNDS</div>
      <div class="prop-vec3">
        <span class="k">Size</span>
        <span class="axis" data-axis="dX">—</span>
        <span class="axis" data-axis="dY">—</span>
        <span class="axis" data-axis="dZ">—</span>
      </div>
    </div>
  `;

  function updateInspect(sel: Selection | null): void {
    const title = wrap.querySelector<HTMLElement>(".props-title");
    const subtitle = wrap.querySelector<HTMLElement>(".props-subtitle");

    // Multi-select path: Ctrl+click set has > 1 element.
    const multi = getMultiSelected();
    if (multi.length > 1) {
      if (title) title.textContent = `${multi.length} elements selected`;
      const types = [...new Set(
        multi.map((s) => (s.object.userData?.ifcClass as string | undefined) || s.topology)
      )].sort().join(", ");
      if (subtitle) subtitle.textContent = types;
      wrap.querySelectorAll<HTMLElement>("[data-field]").forEach((v) => (v.textContent = "—"));
      // TRANSFORM position: all "—"
      wrap.querySelectorAll<HTMLElement>(".axis").forEach((a) => (a.textContent = "—"));
      // BOUNDS: union bbox of all selected meshes.
      const unionBox = new THREE.Box3();
      for (const s of multi) unionBox.expandByObject(s.object);
      const sizeAxes = wrap.querySelectorAll<HTMLElement>('.prop-vec3:nth-of-type(3) .axis');
      if (isFinite(unionBox.min.x)) {
        const sz = new THREE.Vector3();
        unionBox.getSize(sz);
        if (sizeAxes[0]) sizeAxes[0].textContent = sz.x.toFixed(3);
        if (sizeAxes[1]) sizeAxes[1].textContent = sz.y.toFixed(3);
        if (sizeAxes[2]) sizeAxes[2].textContent = sz.z.toFixed(3);
      }
      return;
    }

    if (!sel) {
      if (title) title.textContent = "—";
      if (subtitle) subtitle.textContent = "no selection";
      wrap.querySelectorAll<HTMLElement>("[data-field]").forEach((v) => (v.textContent = "—"));
      wrap.querySelectorAll<HTMLElement>(".axis").forEach((a) => (a.textContent = "—"));
      return;
    }
    const obj = sel.object as THREE.Object3D;
    const ud = (obj.userData ?? {}) as {
      ifcClass?: string;
      guid?: string;
      storeyName?: string;
      layer?: string;
    };
    if (title) title.textContent = obj.name || sel.uuid.slice(0, 8);
    if (subtitle) subtitle.textContent = ud.ifcClass || sel.topology;
    const nameEl = wrap.querySelector<HTMLElement>('[data-field="name"]');
    if (nameEl) nameEl.textContent = obj.name || "—";
    const typeEl = wrap.querySelector<HTMLElement>('[data-field="type"]');
    if (typeEl) typeEl.textContent = ud.ifcClass || sel.topology;
    const guidEl = wrap.querySelector<HTMLElement>('[data-field="guid"]');
    if (guidEl) guidEl.textContent = ud.guid || (sel.uuid.slice(0, 16) + "…");
    const storeyEl = wrap.querySelector<HTMLElement>('[data-field="storey"]');
    if (storeyEl) storeyEl.textContent = ud.storeyName || "—";
    const layerEl = wrap.querySelector<HTMLElement>('[data-field="layer"]');
    if (layerEl) layerEl.textContent = ud.layer || ud.ifcClass || "default";
    // Position: prefer bounding-box center for IFC (vertices are world-space
    // baked, so getWorldPosition returns 0,0,0). For non-IFC objects with a
    // real local origin, the center of the bbox still reads sensibly.
    const box = new THREE.Box3().setFromObject(obj);
    const posAxes = wrap.querySelectorAll<HTMLElement>('.prop-vec3:nth-of-type(1) .axis');
    if (isFinite(box.min.x)) {
      const center = new THREE.Vector3();
      box.getCenter(center);
      if (posAxes[0]) posAxes[0].textContent = center.x.toFixed(3);
      if (posAxes[1]) posAxes[1].textContent = center.y.toFixed(3);
      if (posAxes[2]) posAxes[2].textContent = center.z.toFixed(3);
    } else {
      const pos = new THREE.Vector3();
      obj.getWorldPosition(pos);
      if (posAxes[0]) posAxes[0].textContent = pos.x.toFixed(3);
      if (posAxes[1]) posAxes[1].textContent = pos.y.toFixed(3);
      if (posAxes[2]) posAxes[2].textContent = pos.z.toFixed(3);
    }
    // Bounds
    const sizeAxes = wrap.querySelectorAll<HTMLElement>('.prop-vec3:nth-of-type(3) .axis');
    if (isFinite(box.min.x)) {
      const sz = new THREE.Vector3();
      box.getSize(sz);
      if (sizeAxes[0]) sizeAxes[0].textContent = sz.x.toFixed(3);
      if (sizeAxes[1]) sizeAxes[1].textContent = sz.y.toFixed(3);
      if (sizeAxes[2]) sizeAxes[2].textContent = sz.z.toFixed(3);
    } else {
      sizeAxes.forEach((a) => (a.textContent = "—"));
    }
  }

  subscribe(updateInspect);
  subscribeMulti(() => updateInspect(getSelected()));
  updateInspect(getSelected());
  return wrap;
}

function buildAssetsTab(onPickSample: (v: string) => void): HTMLElement {
  const wrap = el("div", "tab-body assets");
  const search = el("div", "assets-search");
  search.innerHTML = `${iconSVG("search", 11)}<input placeholder="search samples, primitives, blocks..."/>`;
  wrap.appendChild(search);

  const sectionLabel = el("div");
  sectionLabel.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); padding:6px 2px 4px; font-weight:600; display:flex; align-items:center; gap:6px;";
  sectionLabel.innerHTML = `<span style="flex:1; height:1px; background:var(--hairline);"></span>SAMPLE FILES<span style="flex:1; height:1px; background:var(--hairline);"></span>`;
  wrap.appendChild(sectionLabel);

  const grid = el("div", "asset-grid");
  for (const a of SAMPLE_ASSETS) {
    const card = el("div", "asset-card", { "data-sample": a.v });
    card.innerHTML = `
      <div class="asset-thumb"></div>
      <div class="asset-meta">
        <div class="name">${a.name}</div>
        <div class="sub">${a.sub}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      grid.querySelectorAll(".asset-card.selected").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      onPickSample(a.v);
    });
    grid.appendChild(card);
  }
  wrap.appendChild(grid);
  return wrap;
}

function buildSidebar(host: HTMLElement, scenePanel: HTMLElement | null) {
  host.innerHTML = "";

  const tabs = el("div", "sb-tabs");
  const body = el("div", "sb-body");
  body.style.cssText = "flex:1; min-height:0; overflow-y:auto; overflow-x:hidden;";
  const snap = buildSnapDock();

  const panes: Record<string, HTMLElement> = {
    scene:   buildSceneTab(scenePanel),
    inspect: buildInspectTab(),
    assets:  buildAssetsTab((v) => {
      // Drive existing sample-select dropdown so loader picks up the sample.
      const sel = document.getElementById("sample-select") as HTMLSelectElement | null;
      if (sel) {
        sel.value = v;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }),
  };

  for (const t of SIDEBAR_TABS) {
    const tab = el("div", "sb-tab", { "data-tab": t.id });
    tab.textContent = t.label;
    tab.addEventListener("click", () => activate(t.id));
    tabs.appendChild(tab);
  }

  function activate(id: string) {
    tabs.querySelectorAll(".sb-tab").forEach((t) => {
      const isActive = (t as HTMLElement).dataset.tab === id;
      t.classList.toggle("active", isActive);
    });
    body.innerHTML = "";
    if (panes[id]) body.appendChild(panes[id]);
  }

  const filterPanel = buildSelectionFiltersPanel();

  host.appendChild(tabs);
  host.appendChild(body);
  host.appendChild(filterPanel);
  host.appendChild(snap);
  activate("scene");
}

// Suggestion chips → existing demo prompts (drives #prompt-select).
// demoId is matched against the option label prefix ("1. ", "6. ", etc.)
// because main.ts populates the dropdown with `value=index, text="N. Label"`.
const PROMPT_CHIPS: { label: string; demoId: string }[] = [
  { label: "Wall · 5.5 × 0.2 × 2.8 m",         demoId: "wall" },
  { label: "Circular column",                   demoId: "column" },
  { label: "Raised slab",                       demoId: "raised-slab" },
  { label: "Slab w/ stair hole",                demoId: "slab-with-hole" },
  { label: "Wall with doorway",                 demoId: "wall-with-door" },
  { label: "L-shape walls",                     demoId: "l-walls" },
  { label: "Four-walled room",                  demoId: "four-walled-room" },
  { label: "Stair-step",                        demoId: "stair-step" },
  { label: "Schultz Residence · 14 elements",   demoId: "schultz-residence" },
];

// localStorage-backed real session history — populated when user generates geometry.
const RECENT_LS_KEY = "gemma-architect:recent-v1";
type RecentEntry = { ts: string; label: string };

function loadRecentEntries(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_LS_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch { return []; }
}

export function saveRecentEntry(label: string): void {
  const d = new Date();
  const ts = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const entries = loadRecentEntries().filter(e => e.label !== label);
  entries.unshift({ ts, label });
  try { localStorage.setItem(RECENT_LS_KEY, JSON.stringify(entries.slice(0, 5))); } catch {}
  // Refresh the rendered list if it's in the DOM.
  renderRecentList(document.getElementById("ai-recent-list"));
}

function renderRecentList(host: HTMLElement | null): void {
  if (!host) return;
  host.innerHTML = "";
  for (const r of loadRecentEntries()) {
    const line = el("div", "ai-recent");
    const span = document.createElement("span");
    span.className = "ts";
    span.textContent = r.ts;
    line.appendChild(span);
    line.appendChild(document.createTextNode(r.label));
    host.appendChild(line);
  }
}

// Map a demo id (e.g. "l-walls") to the dropdown's numeric option value
// by matching the option text prefix. main.ts builds the dropdown from
// DEMOS[] in order, so DEMO_ID_ORDER mirrors that order.
const DEMO_ID_ORDER = [
  "wall", "column", "raised-slab", "slab-with-hole",
  "wall-with-door", "l-walls", "four-walled-room", "stair-step",
  "schultz-residence",
];
function demoIdToIndex(id: string): string | null {
  const i = DEMO_ID_ORDER.indexOf(id);
  return i >= 0 ? String(i) : null;
}

function buildPromptTabBody(promptPane: HTMLElement | null): HTMLElement {
  const wrap = el("div", "tab-body prompt-tab create-tab");

  let mode = loadConsoleMode();

  const header = el("div", "ai-header");
  function renderHeader(): void {
    header.innerHTML = `
      <div class="ai-title">
        ${mode === "console" ? iconSVG("terminal", 13) : iconSVG("sparkle", 13)}
        ${mode === "console" ? "CONSOLE  ·  DSL COMMAND INPUT" : "CREATE  ·  CONVERSATION WITH GEMMA·ARCHITECT"}
      </div>
      <button class="mode-pill" title="Shift+Tab to toggle mode" data-mode="${mode}">
        ${mode === "console" ? "● CONSOLE" : "○ CREATE"}
      </button>
      <span class="ai-badge" id="ai-model-badge">
        <span class="v">G</span>EMMA·4·E2B  ·  LIVE
      </span>
    `;
    header.querySelector(".mode-pill")?.addEventListener("click", () => {
      setConsoleMode(mode === "console" ? "prompt" : "console");
    });
  }
  renderHeader();
  wrap.appendChild(header);

  // Build both inner panes upfront; swap visibility on mode change.
  const chatRoot = el("div", "chat-panel-root");
  new ChatPanel(chatRoot);

  const consolePane = buildConsoleInner();

  const innerHost = el("div", "create-tab-inner");
  innerHost.appendChild(mode === "console" ? consolePane : chatRoot);
  wrap.appendChild(innerHost);

  // Wire _setConsoleModeFn — this is the hook cmdk + Shift+Tab call.
  _setConsoleModeFn = (m: ConsoleMode) => {
    if (m === mode) return;
    mode = m;
    saveConsoleMode(m);
    renderHeader();
    innerHost.innerHTML = "";
    innerHost.appendChild(m === "console" ? consolePane : chatRoot);
  };

  // Shift+Tab global handler (added once per tab build; cleaned up on tab destroy via AbortController).
  const ac = new AbortController();
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.shiftKey && e.key === "Tab") {
      e.preventDefault();
      setConsoleMode(mode === "console" ? "prompt" : "console");
    }
  }, { signal: ac.signal });
  // Detach when wrap is removed from DOM.
  new MutationObserver(() => {
    if (!wrap.isConnected) ac.abort();
  }).observe(document.body, { childList: true, subtree: true });

  // Keep the legacy prompt-pane element alive in off-grid-host.
  if (promptPane) {
    promptPane.classList.add("prompt-pane-embed");
  }

  return wrap;
}

function buildConsoleInner(): HTMLElement {
  const wrap = el("div", "console-inner-pane");
  wrap.innerHTML = `
    <div class="console">
      <div class="console-history" id="console-history">
        <div class="console-line info"><span class="ts">00:00:01</span><span class="glyph">·</span><span class="text">OpenCascade WebAssembly initialized</span></div>
        <div class="console-line info"><span class="ts">00:00:01</span><span class="glyph">·</span><span class="text">web-ifc parser ready · IFC4 schema</span></div>
        <div class="console-line ok"><span class="ts">00:00:02</span><span class="glyph">✓</span><span class="text">LoRA adapter loaded</span></div>
        <div class="console-line info"><span class="ts">00:00:03</span><span class="glyph">·</span><span class="text">DSL ready · type wall|slab|column|box|cut, then ⏎</span></div>
      </div>
      <div class="console-prompt">
        <span class="caret">›</span>
        <input id="console-input" placeholder="DSL — wall (0 0) (5 0) height=3 thickness=0.2     |     column (0 0) height=3 profile=square(0.3)"/>
        <span style="font-family:var(--mono); font-size:9.5px; color:var(--ink-faint); letter-spacing:0.04em;">⏎ run</span>
      </div>
    </div>
  `;

  const input = wrap.querySelector<HTMLInputElement>("#console-input")!;
  const history = wrap.querySelector<HTMLDivElement>("#console-history")!;
  const buffer: string[] = [];
  let bufferIdx = 0;

  function ts(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }
  function pushLine(kind: "cmd" | "ok" | "err" | "info", text: string) {
    const line = document.createElement("div");
    line.className = `console-line ${kind}`;
    const glyph = kind === "cmd" ? "›" : kind === "ok" ? "✓" : kind === "err" ? "✗" : "·";
    line.innerHTML = `<span class="ts">${ts()}</span><span class="glyph">${glyph}</span><span class="text"></span>`;
    line.querySelector(".text")!.textContent = text;
    history.appendChild(line);
    history.scrollTop = history.scrollHeight;
  }

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.shiftKey && e.key === "Tab") return; // let global handler take it
    if (e.key === "Enter") {
      e.preventDefault();
      const src = input.value.trim();
      if (!src) return;
      buffer.push(src);
      bufferIdx = buffer.length;
      input.value = "";
      pushLine("cmd", src);

      const isDeclCmd = src.startsWith(":");
      const dslSrc = isDeclCmd ? src.slice(1).trim() : src;

      if (isDeclCmd) {
        const tokens = dslSrc.split(/\s+/);
        const verb = tokens[0];
        const dispArgs: DispatchArgs = {};
        for (const t of tokens.slice(1)) {
          const eq = t.indexOf("=");
          if (eq > 0) {
            const k = t.slice(0, eq);
            const v = t.slice(eq + 1);
            const n = Number(v);
            dispArgs[k] = Number.isFinite(n) ? n : v;
          }
        }
        const dr = dispatchSync(verb, dispArgs);
        pushLine(
          dr.ok ? "ok" : "info",
          `dispatch ${verb} → ${dr.ok ? dr.canonical! : `${dr.error}${dr.detail ? ": " + dr.detail : ""}`}`,
        );
      }

      const c = compileDsl(dslSrc);
      if (!c.ok) {
        pushLine("err", `line ${c.line}: ${c.message}`);
        return;
      }
      if (c.dispatches && c.dispatches.length > 0) {
        for (const d of c.dispatches) {
          const dr = dispatchSync(d.verb, d.args);
          pushLine(
            dr.ok ? "ok" : "info",
            `dispatch ${d.verb} → ${dr.ok ? dr.canonical! : `${dr.error}${dr.detail ? ": " + dr.detail : ""}`}`,
          );
        }
      }
      if (c.js) {
        const jsSrc = document.getElementById("js-source") as HTMLTextAreaElement | null;
        const runBtn = document.getElementById("run-btn") as HTMLButtonElement | null;
        if (jsSrc && runBtn) {
          jsSrc.value = c.js;
          jsSrc.dispatchEvent(new Event("input", { bubbles: true }));
          pushLine("info", `compiled · ${c.solids.length} solid${c.solids.length === 1 ? "" : "s"} → kernel`);
          runBtn.click();
        } else {
          pushLine("err", "kernel not ready (no #run-btn / #js-source)");
        }
      }
    } else if (e.key === "ArrowUp") {
      if (buffer.length === 0) return;
      e.preventDefault();
      bufferIdx = Math.max(0, bufferIdx - 1);
      input.value = buffer[bufferIdx] ?? "";
    } else if (e.key === "ArrowDown") {
      if (buffer.length === 0) return;
      e.preventDefault();
      bufferIdx = Math.min(buffer.length, bufferIdx + 1);
      input.value = buffer[bufferIdx] ?? "";
    }
  });

  return wrap;
}

// ── Live construction graph (NODES tab) ────────────────────────────────────

interface NodeRecord { label: string; }
const _nodes: NodeRecord[] = [];
let _nodesLastSeqLen = 0;
let _nodesWrap: HTMLElement | null = null;

const GEOMETRY_OP_RE = /^(Ifc|Sd|sd)/;

function chainToLabel(chain: string): string {
  const m = chain.match(/const (\w+)\s*=\s*([\w.]+)\(/);
  if (m) return `${m[1]} · ${m[2]}`;
  const first = chain.split("\n")[0].slice(0, 60);
  return first || chain.slice(0, 60);
}

function commandToLabel(id: string, args: Record<string, unknown>): string {
  const argStr = Object.entries(args)
    .filter(([k]) => !["canonical", "kernel"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "number" ? (v as number).toFixed(2) : v}`)
    .slice(0, 3)
    .join(" ");
  return argStr ? `${id} · ${argStr}` : id;
}

function renderNodes(): void {
  if (!_nodesWrap) return;
  let list = _nodesWrap.querySelector<HTMLElement>(".nodes-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "nodes-list";
    list.style.cssText = "padding:8px 12px; font-family:var(--mono); font-size:11px; overflow-y:auto; height:100%;";
    _nodesWrap.appendChild(list);
  }
  if (_nodes.length === 0) {
    list.innerHTML = `<div class="empty-hint" style="padding:24px; color:var(--ink-faint);">Empty graph — load a demo or type a prompt.</div>`;
    return;
  }
  list.innerHTML = _nodes.map((n, i) => `
    ${i > 0 ? `<div style="text-align:center; color:var(--ink-faint); font-size:10px; line-height:1.4;">↓</div>` : ""}
    <div class="node-box" data-idx="${i}" style="
      border:1px solid var(--hairline); border-radius:4px; padding:6px 10px;
      margin:2px 0; background:var(--panel-bg); color:var(--ink);
      cursor:pointer; user-select:none;
    " title="${escHtml(n.label)}">${escHtml(n.label)}</div>
  `).join("");
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildNodesTabBody(): HTMLElement {
  const wrap = el("div", "tab-body nodes-tab");
  wrap.style.cssText = "display:flex; flex-direction:column; height:100%; overflow:hidden;";
  _nodesWrap = wrap;
  renderNodes();
  return wrap;
}

// ── Live event history (HISTORY tab) ───────────────────────────────────────

interface HistRecord { ts: string; op: string; args: string; }
const _historyEvents: HistRecord[] = [];
const HISTORY_CAP = 500;
let _historyWrap: HTMLElement | null = null;
let _histSessionStart = 0;

function nowTs(): string {
  const ms = Date.now() - _histSessionStart;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

function appendHistory(op: string, args: string): void {
  if (_histSessionStart === 0) _histSessionStart = Date.now();
  _historyEvents.push({ ts: nowTs(), op, args: args.slice(0, 80) });
  if (_historyEvents.length > HISTORY_CAP) _historyEvents.shift();
}

function renderHistory(): void {
  if (!_historyWrap) return;
  let list = _historyWrap.querySelector<HTMLElement>(".history-list");
  if (!list) {
    list = document.createElement("div");
    list.className = "history-list";
    list.style.cssText = "padding:4px 0; font-family:var(--mono); font-size:11px; overflow-y:auto; height:100%;";
    _historyWrap.appendChild(list);
  }
  if (_historyEvents.length === 0) {
    list.innerHTML = `<div class="empty-hint" style="padding:24px; color:var(--ink-faint);">No ops yet — load a demo or type a prompt.</div>`;
    return;
  }
  list.innerHTML = _historyEvents.map((h) => `
    <div style="display:grid; grid-template-columns:58px 160px 1fr; align-items:center;
      padding:4px 12px; gap:8px; border-bottom:1px solid var(--hairline-soft); color:var(--ink);">
      <span style="color:var(--ink-faint); font-size:10px;">${escHtml(h.ts)}</span>
      <span style="color:var(--sanguine); font-weight:600; letter-spacing:0.04em;">${escHtml(h.op)}</span>
      <span style="color:var(--ink-soft); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(h.args)}</span>
    </div>
  `).join("");
  list.scrollTop = list.scrollHeight;
}

function buildHistoryTabBody(): HTMLElement {
  const wrap = el("div", "tab-body history-tab");
  wrap.style.cssText = "display:flex; flex-direction:column; height:100%; overflow:hidden;";
  _historyWrap = wrap;
  renderHistory();
  return wrap;
}

// ── Shared event subscription (called once from buildDock) ─────────────────

function jsToNodeLabels(js: string): string[] {
  const labels: string[] = [];
  for (const m of js.matchAll(/const (\w+)\s*=\s*([\w.]+)\(/g)) {
    labels.push(`${m[1]} · ${m[2]}`);
  }
  return labels.length > 0 ? labels : js.trim() ? ["geometry · replicad"] : [];
}

function initLiveTabSubscriptions(): void {
  // Replicad worker path: fires when run-ok completes geometry compilation.
  window.addEventListener("gemma:run-ok", (rawEv) => {
    const ev = rawEv as CustomEvent<{ js: string; label: string }>;
    const { js, label } = ev.detail;
    _nodes.length = 0;
    _nodesLastSeqLen = 0;
    for (const lbl of jsToNodeLabels(js)) {
      _nodes.push({ label: lbl });
    }
    appendHistory("generate", label);
    saveRecentEntry(label);
    renderNodes();
    renderHistory();
  });

  // Dispatch path: IfcWall, SdBox, etc. called via dispatchSync.
  window.addEventListener("gemma:command", (rawEv) => {
    const ev = rawEv as CustomEvent<{ id: string; args: Record<string, unknown> }>;
    const { id, args } = ev.detail;

    const seq = getCreateSequence();
    for (let i = _nodesLastSeqLen; i < seq.length; i++) {
      _nodes.push({ label: chainToLabel(seq[i]) });
    }
    _nodesLastSeqLen = seq.length;

    if (GEOMETRY_OP_RE.test(id)) {
      _nodes.push({ label: commandToLabel(id, args as Record<string, unknown>) });
    }

    const argStr = Object.entries(args as Record<string, unknown>)
      .filter(([k]) => !["canonical", "kernel"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "number" ? (v as number).toFixed(2) : String(v)}`)
      .slice(0, 4)
      .join(" ");
    appendHistory(id, argStr);

    renderNodes();
    renderHistory();
  });

  window.addEventListener("viewer:select", (rawEv) => {
    const uuid: string | null = (rawEv as CustomEvent<{ uuid: string | null }>).detail?.uuid ?? null;
    if (uuid) {
      appendHistory("select", uuid.slice(0, 8) + "…");
      renderHistory();
    }
  });
}

function buildParametersTabBody(paramPanel: HTMLElement | null): HTMLElement {
  const wrap = el("div", "tab-body parameters-tab");
  if (paramPanel) {
    paramPanel.classList.remove("hidden");
    paramPanel.classList.add("param-panel-embed");
    wrap.appendChild(paramPanel);
  } else {
    wrap.innerHTML = `<div class="empty-hint">No parameters — load a sample with sliders or run a prompt.</div>`;
  }
  return wrap;
}

function buildDock(
  tabsHost: HTMLElement,
  bodyHost: HTMLElement,
  promptPane: HTMLElement | null,
  paramPanel: HTMLElement | null,
) {
  tabsHost.innerHTML = "";

  const panes: Record<string, HTMLElement> = {
    prompt:     buildPromptTabBody(promptPane),
    nodes:      buildNodesTabBody(),
    parameters: buildParametersTabBody(paramPanel),
    history:    buildHistoryTabBody(),
  };

  for (const t of DOCK_TABS) {
    const tab = el("div", "dock-tab", { "data-tab": t.id });
    tab.innerHTML = `${iconSVG(t.icon, 11)} ${t.label}`;
    tab.addEventListener("click", () => activate(t.id));
    tabsHost.appendChild(tab);
  }

  // Spacer + actions on the right.
  const spacer = el("div", "dock-spacer");
  tabsHost.appendChild(spacer);
  const actions = el("div", "dock-actions");
  actions.innerHTML = `
    <button class="vp-icon-btn" type="button" title="Pop out">${iconSVG("export", 11)}</button>
    <button class="vp-icon-btn" type="button" title="Clear">${iconSVG("trash", 11)}</button>
    <button class="vp-icon-btn" type="button" title="Settings">${iconSVG("settings", 11)}</button>
  `;
  tabsHost.appendChild(actions);

  function activate(id: string) {
    tabsHost.querySelectorAll(".dock-tab").forEach((t) => {
      const isActive = (t as HTMLElement).dataset.tab === id;
      t.classList.toggle("active", isActive);
    });
    bodyHost.innerHTML = "";
    if (panes[id]) bodyHost.appendChild(panes[id]);
  }
  activate("prompt");
  initLiveTabSubscriptions();
}

function wireDockResize() {
  const divider = document.getElementById("dock-divider");
  const app = document.querySelector(".app") as HTMLElement | null;
  if (!divider || !app) return;
  let dragging = false;
  let startY = 0;
  let startH = 0;
  divider.addEventListener("mousedown", (e: MouseEvent) => {
    dragging = true;
    startY = e.clientY;
    const cur = getComputedStyle(app).getPropertyValue("--dock-h").trim();
    // Default fallback matches app.jsx initial dockH=340. T1 .zip parity.
    startH = parseInt(cur || "340", 10);
    document.body.style.userSelect = "none";
  });
  window.addEventListener("mousemove", (e: MouseEvent) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    const maxH = Math.min(560, window.innerHeight * 0.5);
    const newH = Math.max(80, Math.min(maxH, startH + dy));
    app.style.setProperty("--dock-h", newH + "px");
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.userSelect = "";
  });
}

export function buildWorkbench() {
  const paletteHost = document.getElementById("palette-host");
  const dockTabsHost = document.getElementById("dock-tabs-host");
  const dockBodyHost = document.getElementById("dock-body-host");
  const sidebarHost = document.getElementById("sidebar-host");
  const axesHost = document.getElementById("vp-axes-host");

  // The original prompt-pane and scene-panel and param-panel elements are
  // built into the page by index.html / main.ts — we relocate them.
  const promptPane = document.getElementById("prompt-pane");
  const scenePanel = document.getElementById("scene-panel");
  const paramPanel = document.getElementById("param-panel");

  if (paletteHost) buildPalette(paletteHost);
  if (sidebarHost) buildSidebar(sidebarHost, scenePanel);
  if (dockTabsHost && dockBodyHost) buildDock(dockTabsHost, dockBodyHost, promptPane, paramPanel);
  if (axesHost) axesHost.innerHTML = axesGizmoSVG();

  wireDockResize();
}
