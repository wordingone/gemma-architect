// Workbench scaffolding — design-handoff #172 + #174 + #175.
//
// Builds the bundle's three-pane workbench structure:
//   .workbench grid (44px palette / 1fr center-col / 280px sidebar)
//     .palette       — left gutter, icon-only tool buttons in sections
//     .center-col    — viewport-area + dock-divider + dock
//     .sidebar       — right rail, SCENE / INSPECT / ASSETS tabs + snap-dock
//
// The dock has 4 tabs (PROMPT / SKILL NODES / PARAMETERS / HISTORY).
// Existing prompt-pane content moves into the PROMPT tab body; param-panel
// into PARAMETERS; scene-panel into the SCENE sidebar tab. The IDs remain
// intact so main.ts wiring (run button, file picker, sample selector, etc.)
// keeps working without changes.

import { layerStore, type Layer, DEFAULT_LAYER_ID } from "../geometry/layers";
import { drawingLayerStore, type DrawingLayer } from "../geometry/drawing-layers";
import { pushCustomAction } from "../history";
import { Viewer } from "../viewer/viewer";
import { iconSVG, axesGizmoSVG } from "../ui/icons";
import {
  setRenderMode, setLineType, setLineWeight, getRenderMode, getLineType, getLineWeight,
  type RenderMode, type LineType, type LineWeight,
} from "../viewer/render-modes";
import { generateGeometry, GenerateError } from "../agent/ai-generate";
import { ChatPanel } from "../chat/chat-panel";
import { compileDsl } from "../commands/dsl-eval";
import { dispatch, dispatchSync, registerPostDispatch, type DispatchArgs } from "../commands/dispatch";
import { startCommandSession } from "../commands/command-session";
import { setPickerHint } from "../viewer/picker-hint";
import { getState, setState, subscribe as subscribeAppState, type ViewName } from "../app-state";
import { formatLength } from "../units";
import { setGridOn, setSnapOn, setOrthoOn, setPolarOn, setVertexSnapOn, setEdgeSnapOn, setMidpointSnapOn, setStep, setAngleStep, getSnap } from "../viewer/snap-state";
import { buildSelectionFiltersPanel } from "../scene/scene-panel";
import { levelStore, type Level } from "../geometry/levels";
import { refLineStore } from "../geometry/ref-lines";
import * as THREE from "three";
import { subscribe, getSelected, subscribeMulti, getMultiSelected, type Selection } from "../viewer/selection-state";
import { getCreateSequence } from "../tools/index";
import { prefetchModel, MODEL_ID, setClusterCatalog } from "../agent/agent-harness";
import { checkConsentAndLoad } from "../agent/model-consent";
import { listSavedSkills, deleteSkill, listClusters, saveCluster, deleteCluster, type SavedSkill, type SkillStep, type SkillCluster, type SkillClusterStep } from "../skills/skill-store";
import type { Skill } from "../agent/skills-loader";
import { openSaveSkillModal } from "../skills/skill-modal";
import { SkillCanvas } from "../skills/skill-canvas";
import { rebuildWallParams } from "../tools/structural";
import { attemptWallCornerJoins } from "../tools/wall-corners";
import { initWallHeightHandle, showWallHeightHandle, hideWallHeightHandle } from "../viewer/wall-height-handle";

// Eager-load all build-time skill.json files so the chat fastpath has steps at runtime.
// Only the 5 schema_version-2 skills have a "steps" array; others have undefined steps.
type _SkillJsonEntry = {
  name: string;
  keywords: string[];
  steps?: Array<{ verb: string; args: Record<string, unknown> }>;
};
// Access .default for compatibility across Vite JSON module shapes.
const _SKILL_JSON_MODS = import.meta.glob(
  "../skills/*/skill.json",
  { eager: true },
) as Record<string, { default: _SkillJsonEntry } | _SkillJsonEntry>;

function _buildTimeSkills(): Skill[] {
  const skills = Object.values(_SKILL_JSON_MODS).map((mod) => {
    const json = ("default" in mod ? mod.default : mod) as _SkillJsonEntry;
    return {
      name: json.name,
      version: "0",
      description: json.name.replace(/-/g, " "),
      keywords: json.keywords,
      examples: [],
      eval_id: "",
      body: "",
      steps: json.steps,
    };
  });
  return skills;
}

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
    { id: "copy",    icon: "copy",    label: "Copy" },
    { id: "array",   icon: "array",   label: "Array" },
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
    { id: "wall",       icon: "wall",       label: "Wall" },
    { id: "slab",       icon: "slab",       label: "Slab" },
    { id: "column",     icon: "column",     label: "Column" },
    { id: "beam",       icon: "beam",       label: "Beam" },
    { id: "roof",       icon: "roof",       label: "Roof" },
    { id: "space",      icon: "space",      label: "Space" },
    { id: "foundation", icon: "foundation", label: "Foundation" },
    { id: "ceiling",    icon: "ceiling",    label: "Ceiling" },
    { id: "grid",       icon: "grid",       label: "Grid" },
    { id: "level",      icon: "level",      label: "Level" },
    { id: "datum",      icon: "datum",      label: "Reference Line" },
  ]},
  { tools: [
    { id: "stair",       icon: "stair",       label: "Stair" },
    { id: "door",        icon: "door",        label: "Door" },
    { id: "window",      icon: "window",      label: "Window" },
    { id: "ramp",        icon: "ramp",        label: "Ramp" },
    { id: "railing",     icon: "railing",     label: "Railing" },
    { id: "curtainwall", icon: "curtainwall", label: "Curtain Wall" },
    { id: "skylight",    icon: "skylight",    label: "Skylight" },
    { id: "opening",     icon: "opening",     label: "Opening" },
  ]},
  { tools: [
    { id: "section", icon: "section", label: "Section Box" },
    { id: "clip",    icon: "clip",    label: "Clip Plane" },
  ]},
  { tools: [
    { id: "aligned-dim",       icon: "aligned-dim",       label: "Aligned Dim" },
    { id: "angular-dim",       icon: "angular-dim",       label: "Angular Dim" },
    { id: "area-dim",          icon: "area-dim",          label: "Area" },
    { id: "volume-dim",        icon: "volume-dim",        label: "Volume" },
    { id: "label",             icon: "label",             label: "Label" },
    { id: "transient-measure", icon: "transient-measure", label: "Transient" },
  ]},
];

type DockTab = { id: string; icon: string; label: string };
const DOCK_TABS: DockTab[] = [
  { id: "prompt",  icon: "sparkle", label: "CREATE" },
  { id: "skills",  icon: "graph",   label: "SKILLS" },
  { id: "history", icon: "history", label: "HISTORY" },
];

// Merged PROMPT/CONSOLE input: one tab, two modes. Shift+Tab toggles.
//   "prompt"  → NL → ai-generate (cache → LoRA fallback) → JS → kernel
//   "console" → DSL / `:verb` registry → compileDsl/dispatchSync → JS → kernel
// Persists per-session via localStorage.
type ConsoleMode = "prompt" | "console";
const CONSOLE_MODE_LS_KEY = "gemma-cad:console-mode-v1";
const CONSOLE_MODE_LS_KEY_LEGACY = "gemma-architect:console-mode-v1";
function loadConsoleMode(): ConsoleMode {
  try {
    const v = localStorage.getItem(CONSOLE_MODE_LS_KEY) ?? localStorage.getItem(CONSOLE_MODE_LS_KEY_LEGACY);
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

// Module-level chat-panel ref so skillstore:saved can push saved skills into fastpath.
let _chatPanel: InstanceType<typeof ChatPanel> | null = null;

function _savedSkillsAsSkills(saved: SavedSkill[]): Skill[] {
  return saved.map((s) => ({
    name: s.name,
    version: "0",
    description: s.description ?? s.name,
    // Keywords: split name on spaces/hyphens/underscores; also include the full name.
    keywords: [...new Set([
      s.name.toLowerCase(),
      ...s.name.toLowerCase().split(/[\s\-_]+/).filter((t) => t.length > 1),
    ])],
    examples: [],
    eval_id: "",
    body: "",
    steps: s.steps,
  }));
}

async function _refreshChatSkills(): Promise<void> {
  if (!_chatPanel) return;
  const saved = await listSavedSkills().catch(() => [] as SavedSkill[]);
  _chatPanel.setSkills([..._buildTimeSkills(), ..._savedSkillsAsSkills(saved)]);
}

type SidebarTab = { id: string; label: string };
const SIDEBAR_TABS: SidebarTab[] = [
  { id: "scene",   label: "SCENE" },
  { id: "inspect", label: "INSPECT" },
];

function el(tag: string, cls?: string, attrs?: Record<string, string>): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

// PALETTE_SECTIONS indices: 0=transform 1=sketch 2=solid 3=arch 4=comp 5=measure
const ARCH_SECTION_IDX = 3;
const COMP_SECTION_IDX = 4;

// Single shared tooltip element — created once, reused across all palette instances.
function getPaletteTip(): HTMLDivElement {
  let tip = document.getElementById("palette-tip") as HTMLDivElement | null;
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "palette-tip";
    tip.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "display:none",
      "background:#111",
      "color:#fff",
      "padding:3px 8px",
      "font-size:10px",
      "font-family:var(--mono,monospace)",
      "letter-spacing:.06em",
      "text-transform:uppercase",
      "border-radius:4px",
      "white-space:nowrap",
      "z-index:99999",
    ].join(";");
    document.body.appendChild(tip);
    // Follow cursor while visible.
    document.addEventListener("mousemove", (e) => {
      if (tip!.style.display === "none") return;
      tip!.style.left = (e.clientX + 14) + "px";
      tip!.style.top  = (e.clientY - 10) + "px";
    });
  }
  return tip;
}

function showSelModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Standard",       sub: "Default click-to-select",            toolId: "select"       },
    { label: "Window Select",  sub: "Drag rectangle  [Crossing/Window]",  toolId: "sel-window"   },
    { label: "Lasso Select",   sub: "Freehand region  [Crossing/Window]", toolId: "sel-lasso"    },
    { label: "Boundary Select",sub: "Pick curve or draw polygon",         toolId: "sel-boundary" },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    // Click support (after hold releases outside menu or for keyboard nav).
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  // During hold-drag: highlight the row under the cursor.
  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  // Pointerup: activate the hovered row (drag-select) or dismiss if outside menu.
  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
      return;
    }
    // Released outside the menu — keep it open for click interaction;
    // dismiss on next outside click.
    if (!menu.contains(under as Node)) {
      menu.remove();
      return;
    }
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function showScaleModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Scale 3D",  sub: "Uniform scale in all axes",              toolId: "scale"    },
    { label: "Scale 1D",  sub: "Stretch along one axis  [X / Y / Z]",   toolId: "scale-1d" },
    { label: "Scale 2D",  sub: "Uniform scale in XY plane  [Z intact]", toolId: "scale-2d" },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
      return;
    }
    if (!menu.contains(under as Node)) {
      menu.remove();
      return;
    }
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function showWallModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Wall",              sub: "Click two endpoints",                   toolId: "wall"          },
    { label: "Polyline Walls",    sub: "Click chain of points — wall per segment", toolId: "wall-polyline" },
    { label: "Curve Walls",       sub: "Click control pts — spline-fit walls",  toolId: "wall-curve"    },
    { label: "Walls from Object", sub: "Pick existing polygon / curve / line",  toolId: "wall-pick"     },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
      return;
    }
    if (!menu.contains(under as Node)) {
      menu.remove();
      return;
    }
    setTimeout(() => document.addEventListener("pointerdown", onOutside, true), 0);
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function showStairModeMenu(anchor: HTMLElement): void {
  document.querySelector(".sel-mode-menu")?.remove();

  const modes: Array<{ label: string; sub: string; toolId: string }> = [
    { label: "Stair (1-Line)",   sub: "Click start → end point",              toolId: "stair"          },
    { label: "Polyline Stair",   sub: "Click chain of points — flight per segment", toolId: "stair-polyline" },
    { label: "Curve Stair",      sub: "Click control pts — spiral / curved",   toolId: "stair-curve"    },
  ];

  const menu = el("div", "sel-mode-menu");
  menu.setAttribute("role", "menu");
  const rows: HTMLElement[] = [];
  for (const mode of modes) {
    const row = el("div", "sel-mode-row");
    row.setAttribute("role", "menuitem");
    row.setAttribute("tabindex", "0");
    row.dataset.toolId = mode.toolId;
    const labelEl = el("span", "sel-mode-label");
    labelEl.textContent = mode.label;
    const subEl = el("span", "sel-mode-sub");
    subEl.textContent = mode.sub;
    row.appendChild(labelEl);
    row.appendChild(subEl);
    row.addEventListener("click", () => {
      menu.remove();
      cleanup();
      dispatchSync("setActiveTool", { toolId: mode.toolId });
    });
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); row.click(); }
    });
    rows.push(row);
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.top  = (rect.bottom + 4) + "px";

  const onMove = (ev: PointerEvent) => {
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const hovered = under?.closest<HTMLElement>(".sel-mode-row") ?? null;
    for (const r of rows) r.classList.toggle("active", r === hovered);
  };

  const onUp = (ev: PointerEvent) => {
    cleanup();
    const under = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = under?.closest<HTMLElement>(".sel-mode-row");
    if (row?.dataset.toolId) {
      menu.remove();
      dispatchSync("setActiveTool", { toolId: row.dataset.toolId });
    } else {
      menu.remove();
    }
  };

  const onOutside = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) {
      menu.remove();
      document.removeEventListener("pointerdown", onOutside, true);
    }
  };

  const cleanup = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
  };

  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}

function buildPalette(host: HTMLElement) {
  host.innerHTML = "";

  const tip = getPaletteTip();

  // Event delegation on the palette host — avoids per-button listener setup.
  host.addEventListener("mouseover", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".palette-btn");
    if (!btn) return;
    const label = btn.getAttribute("aria-label") ?? "";
    tip.textContent = label;
    tip.style.left = (e as MouseEvent).clientX + 14 + "px";
    tip.style.top  = (e as MouseEvent).clientY - 10 + "px";
    tip.style.display = "block";
  });
  host.addEventListener("mouseout", (e) => {
    const leaving = (e.target as HTMLElement).closest<HTMLElement>(".palette-btn");
    if (!leaving) return;
    const to = (e as MouseEvent).relatedTarget as HTMLElement | null;
    if (to && leaving.contains(to)) return;
    tip.style.display = "none";
  });

  const sectionEls: HTMLElement[] = [];

  for (let i = 0; i < PALETTE_SECTIONS.length; i++) {
    const section = PALETTE_SECTIONS[i];
    const sec = el("div", "palette-section");
    if (i === COMP_SECTION_IDX) sec.classList.add("palette-section--hidden");
    for (const tool of section.tools) {
      const btn = el("button", "palette-btn", { type: "button", "aria-label": tool.label, "data-tool": tool.id });
      const hasCorner = tool.id === "select" || tool.id === "scale" || tool.id === "wall" || tool.id === "stair";
      btn.innerHTML = iconSVG(tool.icon, 18) + (hasCorner ? `<span class="corner"></span>` : "");
      if (tool.id === "select" || tool.id === "scale" || tool.id === "wall" || tool.id === "stair") {
        // Hold anywhere on the button to open the mode dropdown;
        // short click (< 280ms) dispatches the default tool action.
        const showMenu = tool.id === "select" ? showSelModeMenu
          : tool.id === "scale" ? showScaleModeMenu
          : tool.id === "stair" ? showStairModeMenu
          : showWallModeMenu;
        const defaultToolId = tool.id; // "select" or "scale"
        let holdTimer: ReturnType<typeof setTimeout> | null = null;
        let menuOpened = false;
        btn.addEventListener("pointerdown", (ev) => {
          if (ev.button !== 0) return;
          try { btn.releasePointerCapture(ev.pointerId); } catch { /* ok */ }
          menuOpened = false;
          holdTimer = setTimeout(() => {
            menuOpened = true;
            showMenu(btn);
          }, 280);
        });
        btn.addEventListener("pointerup", () => {
          if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        });
        btn.addEventListener("click", () => {
          if (!menuOpened) dispatchSync("setActiveTool", { toolId: defaultToolId });
          menuOpened = false;
        });
      } else {
        btn.addEventListener("click", () => dispatchSync("setActiveTool", { toolId: tool.id }));
      }
      sec.appendChild(btn);
    }
    host.appendChild(sec);
    sectionEls[i] = sec;
  }

  function showSectionTab(tab: "ARCH" | "COMP") {
    const showArch = tab === "ARCH";
    sectionEls[ARCH_SECTION_IDX]?.classList.toggle("palette-section--hidden", !showArch);
    sectionEls[COMP_SECTION_IDX]?.classList.toggle("palette-section--hidden", showArch);
  }

  window.addEventListener("ribbon:section-tab", (rawEv) => {
    const tab = (rawEv as CustomEvent<{ tab: string }>).detail?.tab;
    if (tab === "ARCH" || tab === "COMP") {
      showSectionTab(tab as "ARCH" | "COMP");
    }
  });
}

function buildSnapDock(): HTMLElement {
  const root = el("div", "snap-dock");
  const snap = getSnap();
  // Mirror the selection-filters checkbox pattern in scene-panel.ts so the
  // snap dock and the selection filter panel share one visual language —
  // two-column grid, sf-row labels, native <input type=checkbox>. Each
  // checkbox is wired to the snap-state singleton; tools/index.ts (sketch
  // quantising) and viewer.ts (gumball drag + relocate snapping) read from
  // the singleton, so changing a box here flows everywhere automatically.
  const SNAP_KEYS: Array<{ key: keyof typeof snap; label: string }> = [
    { key: "snapOn",          label: "Snap" },
    { key: "orthoOn",         label: "Ortho" },
    { key: "gridOn",          label: "Grid" },
    { key: "polarOn",         label: "Polar" },
    { key: "vertexSnapOn",    label: "Vertex" },
    { key: "edgeSnapOn",      label: "Edge" },
    { key: "midpointSnapOn",  label: "Midpt" },
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
    <div class="snap-row"><span class="k">step</span><input class="snap-input" id="snap-step-input" type="number" min="0.001" step="0.1" value="${getState("unitSystem") === "imperial" ? (snap.step * 3.28084).toFixed(2) : snap.step.toFixed(2)}"><span class="u">${getState("unitSystem") === "imperial" ? "ft" : "m"}</span></div>
    <div class="snap-row"><span class="k">angle</span><input class="snap-input" id="snap-angle-input" type="number" min="0.1" step="1" value="${snap.angleStep}"><span class="u">°</span></div>
    <div class="snap-row snap-row--cplane" title="Click to change construction plane" style="cursor:pointer"><span class="k">cplane</span><span class="v" id="snap-cplane-label">World XY</span></div>
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
        case "vertexSnapOn":   setVertexSnapOn(on); break;
        case "edgeSnapOn":     setEdgeSnapOn(on); break;
        case "midpointSnapOn": setMidpointSnapOn(on); break;
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
      const imperial = getState("unitSystem") === "imperial";
      const FT = 3.28084;
      if (Number.isFinite(v) && v > 0) {
        const stepM = imperial ? v / FT : v;
        setStep(stepM);
        stepInput.value = (imperial ? stepM * FT : stepM).toFixed(2);
      } else {
        const stepM = getSnap().step;
        stepInput.value = (imperial ? stepM * FT : stepM).toFixed(2);
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

  // CPlane label — reactive update on viewer:cplane-changed (#362).
  const cplaneLabel = root.querySelector<HTMLElement>("#snap-cplane-label");
  if (cplaneLabel) {
    const cplaneRow = root.querySelector<HTMLElement>(".snap-row--cplane");
    // Map SdSetCPlane mode string + CPlane kind to a display label.
    const cplaneDisplayName = (mode: string, kind: string): string => {
      if (kind === "world") return "World XY";
      if (kind === "view-derived") return `${mode.charAt(0).toUpperCase()}${mode.slice(1)} (view)`;
      if (kind === "host-derived") return "Host surface";
      if (mode && mode !== "world") return `${mode.charAt(0).toUpperCase()}${mode.slice(1)}`;
      return "Custom";
    };

    window.addEventListener("viewer:cplane-changed", (e) => {
      const { cplane, mode } = (e as CustomEvent<{ cplane: { kind: string }; mode: string }>).detail;
      const label = cplaneDisplayName(mode ?? "", cplane?.kind ?? "world");
      cplaneLabel.textContent = label;
      // Highlight when non-default plane is active.
      cplaneLabel.style.color = cplane?.kind === "world" ? "" : "var(--sanguine)";
    });

    // Click opens cmdk pre-filled with SdSetCPlane so user can pick a mode.
    cplaneRow?.addEventListener("click", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "k", code: "KeyK", ctrlKey: true, bubbles: true,
      }));
      // Pre-fill cmdk input with the verb after a tick (cmdk needs to mount first).
      setTimeout(() => {
        const cmdk = document.querySelector<HTMLInputElement>(".cmdk-input");
        if (cmdk) { cmdk.value = "SdSetCPlane "; cmdk.dispatchEvent(new Event("input", { bubbles: true })); }
      }, 80);
    });
  }

  return root;
}


function buildSceneTab(scenePanel: HTMLElement | null): HTMLElement {
  const wrap = el("div", "tab-body hier-tab");

  if (!scenePanel) {
    const hint = el("div");
    hint.style.cssText = "padding:8px 10px; font-size:11px; color:var(--ink-faint);";
    hint.textContent = "No scene — drop IFC/GLB or pick a sample.";
    wrap.appendChild(hint);
  }

  function addSubsection(title: string, body: HTMLElement): void {
    const hdr = el("div");
    hdr.style.cssText =
      "display:flex; align-items:center; gap:5px; padding:5px 10px 4px;" +
      " border-top:1px solid var(--hairline-soft); cursor:pointer; user-select:none;";
    const arrow = el("span");
    arrow.textContent = "▾";
    arrow.style.cssText = "font-size:9px; color:var(--ink-faint);";
    const label = el("span");
    label.textContent = title;
    label.style.cssText =
      "font-family:var(--mono); font-size:9px; letter-spacing:0.12em;" +
      " text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
    hdr.appendChild(arrow);
    hdr.appendChild(label);
    let open = true;
    hdr.addEventListener("click", () => {
      open = !open;
      body.style.display = open ? "" : "none";
      arrow.textContent = open ? "▾" : "▸";
    });
    wrap.appendChild(hdr);
    wrap.appendChild(body);
  }

  addSubsection("BUILDING LAYERS", buildLayersTab());
  const refBody = el("div");
  refBody.appendChild(buildLevelsTab());
  refBody.appendChild(build2DLayersTab());
  addSubsection("REFERENCE GEOMETRY", refBody);
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
    <div class="prop-section" id="wall-params-section" style="display:none">
      <div class="prop-section-title">WALL PARAMETERS</div>
      <div class="prop-row">
        <span class="k">Thickness</span>
        <span class="v">
          <input type="number" data-wall-field="thickness" min="0.05" max="1.0" step="0.01" style="width:54px"/>
          <span class="unit">m</span>
          <input type="range" data-wall-slider="thickness" min="0.05" max="1.0" step="0.01" style="width:60px;accent-color:var(--sanguine)"/>
        </span>
      </div>
      <div class="prop-row">
        <span class="k">Bottom elev.</span>
        <span class="v">
          <input type="number" data-wall-field="bottom" step="0.05" style="width:54px"/>
          <span class="unit">m</span>
          <select data-wall-level-select="bottom" style="font-size:9.5px;background:var(--paper-2);border:1px solid var(--hairline);color:var(--ink);border-radius:var(--r-sm);padding:1px 2px"></select>
        </span>
      </div>
      <div class="prop-row">
        <span class="k">Height</span>
        <span class="v">
          <input type="number" data-wall-field="height" min="0.1" max="30" step="0.05" style="width:54px"/>
          <span class="unit">m</span>
          <input type="range" data-wall-slider="height" min="0.1" max="30" step="0.05" style="width:60px;accent-color:var(--sanguine)"/>
        </span>
      </div>
    </div>
  `;

  function updateInspect(sel: Selection | null): void {
    const title = wrap.querySelector<HTMLElement>(".props-title");
    const subtitle = wrap.querySelector<HTMLElement>(".props-subtitle");

    // Multi-select path: Ctrl+click set has > 1 element.
    const multi = getMultiSelected();
    if (multi.length > 1) {
      if (title) title.textContent = `${multi.length} components selected`;
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
      // Wall params: batch multi-select (all walls → pre-populate if same value)
      const wallMeshes = multi
        .map((s) => s.object as THREE.Mesh)
        .filter((o) => o.userData?.creator === "wall");
      updateWallSection(wallMeshes);
      if (wallMeshes.length === 1) showWallHeightHandle(wallMeshes[0]);
      else hideWallHeightHandle();
      return;
    }

    if (!sel) {
      if (title) title.textContent = "—";
      if (subtitle) subtitle.textContent = "no selection";
      wrap.querySelectorAll<HTMLElement>("[data-field]").forEach((v) => (v.textContent = "—"));
      wrap.querySelectorAll<HTMLElement>(".axis").forEach((a) => (a.textContent = "—"));
      updateWallSection([]);
      hideWallHeightHandle();
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

    // Wall params section
    if (obj.userData?.creator === "wall") {
      updateWallSection([obj as THREE.Mesh]);
      showWallHeightHandle(obj as THREE.Mesh);
    } else {
      updateWallSection([]);
      hideWallHeightHandle();
    }
  }

  // ── Wall parameters section ────────────────────────────────────────────────
  let _activeWalls: THREE.Mesh[] = [];

  function updateWallSection(walls: THREE.Mesh[]): void {
    const sec = wrap.querySelector<HTMLElement>("#wall-params-section");
    if (!sec) return;
    _activeWalls = walls;
    if (walls.length === 0) {
      sec.style.display = "none";
      return;
    }
    sec.style.display = "";

    const thicknessInput = sec.querySelector<HTMLInputElement>('[data-wall-field="thickness"]');
    const thicknessSlider = sec.querySelector<HTMLInputElement>('[data-wall-slider="thickness"]');
    const heightInput = sec.querySelector<HTMLInputElement>('[data-wall-field="height"]');
    const heightSlider = sec.querySelector<HTMLInputElement>('[data-wall-slider="height"]');
    const bottomInput = sec.querySelector<HTMLInputElement>('[data-wall-field="bottom"]');
    const levelSelect = sec.querySelector<HTMLSelectElement>('[data-wall-level-select="bottom"]');

    const allT = walls.map((m) => (m.userData.wallThickness as number | undefined) ?? 0.2);
    const allH = walls.map((m) => (m.userData.wallHeight as number | undefined) ?? 3);
    const allZ = walls.map((m) => m.position.z);

    const sameT = allT.every((v) => v === allT[0]);
    const sameH = allH.every((v) => v === allH[0]);
    const sameZ = allZ.every((v) => v === allZ[0]);

    const tVal = sameT ? String(allT[0].toFixed(3)) : "";
    const hVal = sameH ? String(allH[0].toFixed(3)) : "";
    const zVal = sameZ ? String(allZ[0].toFixed(3)) : "";

    if (thicknessInput) thicknessInput.value = tVal;
    if (thicknessSlider) thicknessSlider.value = tVal;
    if (heightInput) heightInput.value = hVal;
    if (heightSlider) heightSlider.value = hVal;
    if (bottomInput) bottomInput.value = zVal;

    // Populate level dropdown
    if (levelSelect) {
      const levels = levelStore.all();
      levelSelect.innerHTML = '<option value="">manual</option>' +
        levels.map((lv) => `<option value="${lv.elevation}">${lv.name} (${formatLength(lv.elevation)})</option>`).join("");
      levelSelect.value = sameZ ? String(allZ[0]) : "";
    }
  }

  function applyWallParam(field: "thickness" | "height" | "bottom", rawVal: string): void {
    const val = parseFloat(rawVal);
    if (!isFinite(val) || _activeWalls.length === 0) return;
    for (const m of _activeWalls) {
      if (field === "thickness") rebuildWallParams(m, { thickness: Math.max(0.01, val) });
      else if (field === "height") rebuildWallParams(m, { height: Math.max(0.01, val) });
      else if (field === "bottom") rebuildWallParams(m, { bottomElevation: val });
    }
    // Re-apply corner joins after geometry rebuild — rebuildWallParams creates a fresh
    // BoxGeometry which drops the mitre/butt cuts from the original join.
    const scene = (window as unknown as { __viewer?: { getScene(): THREE.Scene } }).__viewer?.getScene();
    if (scene) {
      for (const m of _activeWalls) attemptWallCornerJoins(m, scene);
    }
    // Refresh display values to reflect clamping
    updateWallSection(_activeWalls);
  }

  // Wire input↔slider sync and live apply — set up once after HTML exists.
  const wallSec = wrap.querySelector<HTMLElement>("#wall-params-section");
  if (wallSec) {
    for (const field of ["thickness", "height"] as const) {
      const inp = wallSec.querySelector<HTMLInputElement>(`[data-wall-field="${field}"]`);
      const sld = wallSec.querySelector<HTMLInputElement>(`[data-wall-slider="${field}"]`);
      inp?.addEventListener("change", (e) => {
        const v = (e.target as HTMLInputElement).value;
        if (sld) sld.value = v;
        applyWallParam(field, v);
      });
      sld?.addEventListener("input", (e) => {
        const v = (e.target as HTMLInputElement).value;
        if (inp) inp.value = v;
        applyWallParam(field, v);
      });
    }
    const bottomInp = wallSec.querySelector<HTMLInputElement>('[data-wall-field="bottom"]');
    bottomInp?.addEventListener("change", (e) => applyWallParam("bottom", (e.target as HTMLInputElement).value));
    const levelSel = wallSec.querySelector<HTMLSelectElement>('[data-wall-level-select="bottom"]');
    levelSel?.addEventListener("change", (e) => {
      const v = (e.target as HTMLSelectElement).value;
      if (!v) return;
      if (bottomInp) bottomInp.value = v;
      applyWallParam("bottom", v);
    });
  }

  // Refresh wall-params fields when height-handle drag updates userData.
  window.addEventListener("wall:params-changed", () => updateWallSection(_activeWalls));

  subscribe(updateInspect);
  subscribeMulti(() => updateInspect(getSelected()));
  updateInspect(getSelected());
  return wrap;
}

function buildLevelsTab(): HTMLElement {
  const wrap = el("div", "tab-body levels-tab");

  function renderRow(lvl: Level, list: HTMLElement) {
    const row = el("div", "level-row");
    row.style.cssText = `display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; cursor:pointer; background:${lvl.active ? "var(--accent-subtle, rgba(80,140,255,0.12))" : "transparent"};`;

    const eye = el("button", "level-eye");
    eye.innerHTML = lvl.visible
      ? `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>`
      : `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"/><line x1="2" y1="10" x2="10" y2="2" stroke="currentColor" stroke-width="1.2"/></svg>`;
    eye.style.cssText = "border:none; background:transparent; cursor:pointer; padding:0; color:var(--ink-body); flex-shrink:0;";
    eye.title = lvl.visible ? "Hide level" : "Show level";
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("setLevelVisible", { id: lvl.id, visible: !lvl.visible });
    });

    const nameEl = el("div");
    nameEl.textContent = lvl.name;
    nameEl.style.cssText = "flex:1; font-size:11px; color:var(--ink-body);";

    const elevEl = el("div");
    elevEl.textContent = formatLength(Math.abs(lvl.elevation)).replace(/^/, lvl.elevation >= 0 ? "+" : "−");
    elevEl.style.cssText = "font-size:9px; color:var(--ink-dim); white-space:nowrap;";

    const heightEl = el("div", "level-height-display");
    heightEl.textContent = `h: ${formatLength(lvl.height)}`;
    heightEl.title = "Floor-to-floor height — click to edit";
    heightEl.style.cssText = "font-size:9px; color:var(--ink-faint); white-space:nowrap; cursor:pointer; padding:0 2px;";
    heightEl.addEventListener("click", (e) => {
      e.stopPropagation();
      const imperial = getState("unitSystem") === "imperial";
      const FT = 3.28084;
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "0.01";
      inp.step = "0.5";
      inp.value = imperial ? (lvl.height * FT).toFixed(2) : lvl.height.toFixed(2);
      inp.title = imperial ? "Floor-to-floor height (ft)" : "Floor-to-floor height (m)";
      inp.style.cssText = "width:46px; font-size:9px; padding:1px 3px; background:var(--chrome,#1a1a1a); border:1px solid var(--accent,#5080ff); color:var(--ink-body,#ddd); border-radius:2px;";
      const unitLabel = document.createElement("span");
      unitLabel.textContent = imperial ? "ft" : "m";
      unitLabel.style.cssText = "font-size:9px; color:var(--ink-faint); margin-left:2px; flex-shrink:0;";
      const inpWrap = el("div", "level-height-input-wrap");
      inpWrap.style.cssText = "display:flex; align-items:center;";
      inpWrap.appendChild(inp);
      inpWrap.appendChild(unitLabel);
      heightEl.replaceWith(inpWrap);
      inp.focus(); inp.select();
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        const raw = parseFloat(inp.value);
        if (!isNaN(raw) && raw > 0) {
          const hM = imperial ? raw / FT : raw;
          levelStore.update(lvl.id, { height: hM });
          // levelStore.update notifies subscribers → render() rebuilds the tab
        } else if (inpWrap.parentNode) {
          inpWrap.replaceWith(heightEl);
        }
      };
      inp.addEventListener("blur", commit);
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); inp.blur(); }
        if (ev.key === "Escape") { committed = true; if (inpWrap.parentNode) inpWrap.replaceWith(heightEl); ev.stopPropagation(); }
      });
    });

    const chip = el("div", "level-active-chip");
    chip.textContent = "ACTIVE";
    chip.style.cssText = `font-size:8px; padding:1px 4px; border-radius:2px; background:var(--accent,#5080ff); color:#fff; display:${lvl.active ? "block" : "none"};`;

    row.appendChild(eye);
    row.appendChild(nameEl);
    row.appendChild(elevEl);
    row.appendChild(heightEl);
    row.appendChild(chip);

    if (lvl.id !== "level/0") {
      const delBtn = el("button", "level-del-btn");
      delBtn.textContent = "−";
      delBtn.title = "Delete level";
      delBtn.style.cssText = "border:none; background:transparent; cursor:pointer; padding:0 2px; color:var(--ink-faint); font-size:14px; line-height:1; flex-shrink:0;";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("removeLevel", { id: lvl.id });
      });
      row.appendChild(delBtn);
    }

    row.addEventListener("click", () => {
      (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("setActiveLevel", { id: lvl.id });
    });

    list.appendChild(row);
  }

  function render() {
    wrap.innerHTML = "";

    const header = el("div", "levels-header");
    header.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:4px 2px 6px;";
    const title = el("div");
    title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
    title.textContent = "BUILDING LEVELS";
    const addBtn = el("button", "levels-add-btn");
    addBtn.textContent = "+";
    addBtn.style.cssText = "font-size:12px; padding:0 6px; cursor:pointer; background:var(--chrome-secondary); border:none; color:var(--ink-body); border-radius:3px;";
    header.appendChild(title);
    header.appendChild(addBtn);
    wrap.appendChild(header);

    const list = el("div", "levels-list");
    list.style.cssText = "display:flex; flex-direction:column; gap:2px;";
    for (const lvl of levelStore.all()) renderRow(lvl, list);
    wrap.appendChild(list);

    addBtn.addEventListener("click", () => {
      const existing = wrap.querySelector(".level-form");
      if (existing) { existing.remove(); return; }
      const form = el("div", "level-form");
      form.style.cssText = "display:flex; flex-direction:column; gap:4px; padding:6px; background:var(--chrome-secondary); border-radius:4px; margin-top:6px;";
      const imperial = getState("unitSystem") === "imperial";
      const FT = 3.28084;
      const maxElevM = Math.max(...levelStore.all().map(l => l.elevation));
      const defaultDisplayVal = imperial ? ((maxElevM + 3) * FT).toFixed(1) : (maxElevM + 3).toFixed(1);
      const unit = imperial ? "ft" : "m";
      form.innerHTML = `
        <input class="level-elev-input" placeholder="Elevation (${unit})" type="number" step="${imperial ? "0.5" : "0.1"}" value="${defaultDisplayVal}" style="font-size:11px; padding:3px 5px; background:var(--input-bg,var(--chrome)); border:1px solid var(--hairline); color:var(--ink-body); border-radius:3px;"/>
        <div style="display:flex; gap:4px;">
          <button class="level-create-btn" style="flex:1; font-size:10px; padding:3px; background:var(--accent,#5080ff); color:#fff; border:none; border-radius:3px; cursor:pointer;">Add Level</button>
          <button class="level-cancel-btn" style="font-size:10px; padding:3px 8px; background:none; border:1px solid var(--hairline); color:var(--ink-body); border-radius:3px; cursor:pointer;">Cancel</button>
        </div>
      `;
      wrap.appendChild(form);
      form.querySelector<HTMLButtonElement>(".level-cancel-btn")!.addEventListener("click", () => form.remove());
      form.querySelector<HTMLButtonElement>(".level-create-btn")!.addEventListener("click", () => {
        const elevDisplay = parseFloat((form.querySelector<HTMLInputElement>(".level-elev-input")!).value);
        if (isNaN(elevDisplay)) return;
        const elevM = imperial ? elevDisplay / FT : elevDisplay;
        const all = levelStore.all();
        const name = elevM >= 0
          ? `Level ${all.filter(l => l.elevation >= 0).length + 1}`
          : `Level B${all.filter(l => l.elevation < 0).length + 1}`;
        (window as unknown as { __dispatch?: (cmd: string, args: unknown) => unknown }).__dispatch?.("IfcLevel", { name, elevation: elevM });
        form.remove();
      });
    });
  }

  render();
  // Re-render on levelStore changes (active level switch, visibility toggle, new level added).
  levelStore.subscribe(render);
  return wrap;
}

function buildLayersTab(): HTMLElement {
  const wrap = el("div", "tab-body layers-tab");

  const header = el("div", "layers-header");
  header.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:4px 2px 6px;";
  const title = el("div");
  title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
  title.textContent = "BUILDING LAYERS";
  const addBtn = el("button");
  addBtn.style.cssText = "font-size:11px; background:none; border:1px solid var(--hairline); border-radius:3px; color:var(--ink); cursor:pointer; padding:1px 6px; line-height:16px;";
  addBtn.textContent = "+";
  addBtn.title = "New layer";
  header.appendChild(title);
  header.appendChild(addBtn);
  wrap.appendChild(header);

  const list = el("div", "layer-list");
  wrap.appendChild(list);

  function getViewer(): Viewer | undefined {
    return (window as unknown as { __viewer?: Viewer }).__viewer;
  }

  function applyVisibility(layerId: string, visible: boolean): void {
    const v = getViewer();
    if (!v) return;
    v.getScene().traverse((obj) => {
      if ((obj as THREE.Object3D & { userData: Record<string, unknown> }).userData?.layerId === layerId) {
        obj.visible = visible;
      }
    });
  }

  function applyColor(layerId: string, hex: string): void {
    const v = getViewer();
    if (!v) return;
    const color = new THREE.Color(hex);
    v.getScene().traverse((obj) => {
      if ((obj as THREE.Object3D & { userData: Record<string, unknown> }).userData?.layerId === layerId) {
        const mesh = obj as THREE.Mesh;
        if (mesh.isMesh && mesh.material) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
              (m as THREE.MeshStandardMaterial).color.set(color);
              (m as THREE.MeshStandardMaterial).needsUpdate = true;
            }
          }
        }
      }
    });
  }

  // Per-layer expand state — persists across re-renders.
  const expandedLayers = new Set<string>();

  function getLayerObjects(layerId: string): THREE.Object3D[] {
    const v = getViewer();
    if (!v) return [];
    const hits: THREE.Object3D[] = [];
    v.getScene().traverse((obj) => {
      const ud = (obj as THREE.Object3D & { userData: Record<string, unknown> }).userData;
      if (ud?.layerId === layerId && ud?.kind) hits.push(obj);
    });
    return hits;
  }

  function buildChildRows(layerId: string): HTMLElement {
    const wrap = el("div");
    wrap.style.cssText = "background:var(--surface-2,rgba(0,0,0,0.12));";
    const objs = getLayerObjects(layerId);
    if (objs.length === 0) {
      const empty = el("div");
      empty.style.cssText = "padding:4px 10px 4px 28px; font-size:10px; color:var(--ink-faint); font-style:italic;";
      empty.textContent = "No objects";
      wrap.appendChild(empty);
    } else {
      for (const obj of objs) {
        const childRow = el("div");
        childRow.style.cssText = "display:flex; align-items:center; gap:6px; padding:3px 4px 3px 28px; border-bottom:1px solid var(--hairline); cursor:pointer; min-height:22px;";
        childRow.title = "Select object";
        const nameSpan = el("span");
        nameSpan.style.cssText = "flex:1; font-size:10px; color:var(--ink-dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        const ud = (obj as THREE.Object3D & { userData: Record<string, unknown> }).userData;
        nameSpan.textContent = obj.name || String(ud.kind || obj.uuid.slice(0, 8));
        childRow.appendChild(nameSpan);
        childRow.addEventListener("click", () => {
          window.dispatchEvent(new CustomEvent("viewer:select-uuid", { detail: { uuid: obj.uuid } }));
        });
        childRow.addEventListener("mouseenter", () => { childRow.style.background = "var(--surface-hover,rgba(255,255,255,0.06))"; });
        childRow.addEventListener("mouseleave", () => { childRow.style.background = ""; });
        wrap.appendChild(childRow);
      }
    }
    return wrap;
  }

  function renderList(): void {
    list.innerHTML = "";
    for (const layer of layerStore.all()) {
      const isExpanded = expandedLayers.has(layer.id);

      const row = el("div", "layer-row", { "data-layer-id": layer.id });
      row.style.cssText = "display:flex; align-items:center; gap:4px; padding:3px 2px; border-bottom:1px solid var(--hairline); min-height:26px;";

      // Expand arrow
      const arrowBtn = el("button");
      arrowBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink-faint); padding:0 2px; flex-shrink:0; font-size:9px; width:14px; text-align:center;";
      arrowBtn.textContent = isExpanded ? "▾" : "▸";
      arrowBtn.title = isExpanded ? "Collapse" : "Expand";
      arrowBtn.addEventListener("click", () => {
        if (expandedLayers.has(layer.id)) expandedLayers.delete(layer.id);
        else expandedLayers.add(layer.id);
        renderList();
      });

      // Eye toggle
      const eyeBtn = el("button");
      eyeBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink); opacity:" + (layer.visible ? "1" : "0.35") + "; padding:0 2px; flex-shrink:0;";
      eyeBtn.title = layer.visible ? "Hide layer" : "Show layer";
      eyeBtn.innerHTML = layer.visible
        ? `<svg width="13" height="9" viewBox="0 0 13 9" fill="none"><ellipse cx="6.5" cy="4.5" rx="5.5" ry="3.5" stroke="currentColor"/><circle cx="6.5" cy="4.5" r="1.5" fill="currentColor"/></svg>`
        : `<svg width="13" height="9" viewBox="0 0 13 9" fill="none"><ellipse cx="6.5" cy="4.5" rx="5.5" ry="3.5" stroke="currentColor" stroke-dasharray="2 1"/></svg>`;
      eyeBtn.addEventListener("click", () => {
        const oldVisible = layer.visible;
        const newVisible = !layer.visible;
        pushCustomAction(
          () => { layerStore.setVisible(layer.id, oldVisible); applyVisibility(layer.id, oldVisible); renderList(); },
          () => { layerStore.setVisible(layer.id, newVisible); applyVisibility(layer.id, newVisible); renderList(); },
        );
        layerStore.setVisible(layer.id, newVisible);
        applyVisibility(layer.id, newVisible);
      });

      // Lock toggle
      const lockBtn = el("button");
      lockBtn.style.cssText = "background:none; border:none; cursor:pointer; color:var(--ink); opacity:" + (layer.locked ? "1" : "0.35") + "; padding:0 2px; flex-shrink:0;";
      lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer";
      lockBtn.innerHTML = layer.locked
        ? `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`
        : `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor" stroke-dasharray="2 1"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`;
      lockBtn.addEventListener("click", () => {
        const oldLocked = layer.locked;
        const newLocked = !layer.locked;
        pushCustomAction(
          () => { layerStore.setLocked(layer.id, oldLocked); renderList(); },
          () => { layerStore.setLocked(layer.id, newLocked); renderList(); },
        );
        layerStore.setLocked(layer.id, newLocked);
      });

      // Color swatch
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = layer.color;
      colorInput.style.cssText = "width:14px; height:14px; border:none; padding:0; cursor:pointer; flex-shrink:0; border-radius:2px;";
      colorInput.title = "Layer color";
      colorInput.addEventListener("change", () => {
        const oldColor = layer.color;
        const newColor = colorInput.value;
        pushCustomAction(
          () => { layerStore.setColor(layer.id, oldColor); applyColor(layer.id, oldColor); renderList(); },
          () => { layerStore.setColor(layer.id, newColor); applyColor(layer.id, newColor); renderList(); },
        );
        layerStore.setColor(layer.id, newColor);
        applyColor(layer.id, newColor);
      });

      // Name — click toggles expand
      const nameEl = el("span");
      nameEl.style.cssText = "flex:1; font-size:11px; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer;";
      nameEl.textContent = layer.name;
      nameEl.addEventListener("click", () => {
        if (expandedLayers.has(layer.id)) expandedLayers.delete(layer.id);
        else expandedLayers.add(layer.id);
        renderList();
      });

      // Delete button (disabled for built-in "0/Default")
      const delBtn = el("button") as HTMLButtonElement;
      delBtn.style.cssText = "background:none; border:none; cursor:" + (layer.id === DEFAULT_LAYER_ID ? "default" : "pointer") + "; color:var(--ink-dim); opacity:" + (layer.id === DEFAULT_LAYER_ID ? "0.2" : "0.6") + "; padding:0 2px; flex-shrink:0; font-size:13px;";
      delBtn.textContent = "×";
      delBtn.title = layer.id === DEFAULT_LAYER_ID ? "Default layer cannot be deleted" : "Delete layer";
      delBtn.disabled = layer.id === DEFAULT_LAYER_ID;
      delBtn.addEventListener("click", () => {
        if (layer.id === DEFAULT_LAYER_ID) return;
        layerStore.remove(layer.id);
      });

      row.appendChild(arrowBtn);
      row.appendChild(eyeBtn);
      row.appendChild(lockBtn);
      row.appendChild(colorInput);
      row.appendChild(nameEl);
      row.appendChild(delBtn);
      list.appendChild(row);

      if (isExpanded) {
        list.appendChild(buildChildRows(layer.id));
      }
    }
  }

  addBtn.addEventListener("click", () => {
    const name = prompt("Layer name:");
    if (!name?.trim()) return;
    layerStore.add({ name: name.trim(), visible: true, locked: false, color: "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0") });
  });

  layerStore.subscribe(renderList);
  renderList();
  return wrap;
}

function build2DLayersTab(): HTMLElement {
  const wrap = el("div", "tab-body drawing-layers-tab");
  wrap.style.cssText = "padding:0 2px 4px;";

  // Header row: label + add (+) / delete (−) buttons
  const hdr = el("div");
  hdr.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:4px 2px 4px;";
  const title = el("div");
  title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
  title.textContent = "2D LAYERS";
  const btnWrap = el("div");
  btnWrap.style.cssText = "display:flex; gap:2px;";
  const btnStyle = "background:none; border:1px solid var(--hairline-soft); border-radius:3px; cursor:pointer; font-size:12px; color:var(--ink-dim); padding:0 5px; line-height:1.4;";

  const addBtn = el("button") as HTMLButtonElement;
  addBtn.textContent = "+";
  addBtn.title = "Add 2D layer";
  addBtn.style.cssText = btnStyle;
  addBtn.addEventListener("click", () => {
    drawingLayerStore.add(`Layer ${drawingLayerStore.all().length + 1}`);
  });

  const delBtn = el("button") as HTMLButtonElement;
  delBtn.textContent = "−";
  delBtn.title = "Delete active layer";
  delBtn.style.cssText = btnStyle;
  delBtn.addEventListener("click", () => {
    drawingLayerStore.remove(drawingLayerStore.getActiveId());
  });

  btnWrap.appendChild(addBtn);
  btnWrap.appendChild(delBtn);
  hdr.appendChild(title);
  hdr.appendChild(btnWrap);
  wrap.appendChild(hdr);

  const list = el("div", "drawing-layer-list");
  wrap.appendChild(list);

  function syncSceneVisibility(layer: DrawingLayer): void {
    const viewer = (window as unknown as { __viewer?: { forEachSceneChild: (fn: (o: { userData: Record<string, unknown>; visible: boolean }) => void) => void } }).__viewer;
    if (!viewer) return;
    viewer.forEachSceneChild((obj) => {
      if (obj.userData.drawingLayerId === layer.id) obj.visible = layer.visible;
    });
  }

  function renderList(): void {
    list.innerHTML = "";
    const activeId = drawingLayerStore.getActiveId();
    for (const layer of drawingLayerStore.all()) {
      const row = el("div");
      row.style.cssText =
        "display:flex; align-items:center; gap:5px; padding:3px 4px;" +
        " border-bottom:1px solid var(--hairline);" +
        (layer.id === activeId ? " background:var(--bg-hover);" : " cursor:pointer;");

      // Eye — toggle visibility
      const eyeBtn = el("button") as HTMLButtonElement;
      eyeBtn.style.cssText = "background:none; border:none; cursor:pointer; font-size:11px; color:var(--ink); padding:0 1px; flex-shrink:0;";
      eyeBtn.textContent = layer.visible ? "●" : "○";
      eyeBtn.title = layer.visible ? "Hide layer" : "Show layer";
      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        drawingLayerStore.setVisible(layer.id, !layer.visible);
        syncSceneVisibility(drawingLayerStore.get(layer.id)!);
      });

      // Lock — toggle locked
      const lockBtn = el("button") as HTMLButtonElement;
      lockBtn.style.cssText = "background:none; border:none; cursor:pointer; font-size:10px; color:var(--ink-dim); padding:0 1px; flex-shrink:0;";
      lockBtn.textContent = layer.locked ? "🔒" : "🔓";
      lockBtn.title = layer.locked ? "Unlock layer" : "Lock layer";
      lockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        drawingLayerStore.setLocked(layer.id, !layer.locked);
      });

      // Color swatch
      const swatchWrap = el("div");
      swatchWrap.style.cssText = "position:relative; width:14px; height:14px; border-radius:2px; flex-shrink:0; cursor:pointer; border:1px solid var(--hairline);";
      swatchWrap.style.background = layer.color;
      const colorInput = el("input") as HTMLInputElement;
      colorInput.type = "color";
      colorInput.value = layer.color;
      colorInput.style.cssText = "position:absolute; opacity:0; inset:0; width:100%; height:100%; cursor:pointer; padding:0; border:none;";
      colorInput.addEventListener("input", (e) => {
        e.stopPropagation();
        const newColor = (e.target as HTMLInputElement).value;
        drawingLayerStore.setColor(layer.id, newColor);
        // Update all scene objects on this layer
        const viewer = (window as unknown as { __viewer?: { forEachSceneChild: (fn: (o: { userData: Record<string, unknown>; material?: { color?: { set: (c: string) => void } } }) => void) => void } }).__viewer;
        if (viewer) {
          viewer.forEachSceneChild((obj) => {
            if (obj.userData.drawingLayerId === layer.id && obj.material?.color) {
              obj.material.color.set(newColor);
            }
          });
        }
      });
      swatchWrap.appendChild(colorInput);

      // Name — double-click to rename inline
      const nameEl = el("span");
      nameEl.style.cssText = "flex:1; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" + (layer.id === activeId ? " font-weight:600;" : "");
      nameEl.textContent = layer.name;
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = el("input") as HTMLInputElement;
        input.value = layer.name;
        input.style.cssText = "flex:1; font-size:11px; border:1px solid var(--sanguine); border-radius:2px; padding:0 2px; width:100%;";
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        const commit = (): void => {
          drawingLayerStore.rename(layer.id, input.value);
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { commit(); input.blur(); }
          if (ke.key === "Escape") input.blur();
        });
      });

      row.appendChild(eyeBtn);
      row.appendChild(lockBtn);
      row.appendChild(swatchWrap);
      row.appendChild(nameEl);
      row.addEventListener("click", () => { drawingLayerStore.setActive(layer.id); });
      list.appendChild(row);
    }
  }

  drawingLayerStore.subscribe(renderList);
  renderList();
  return wrap;
}

function buildDatumsTab(): HTMLElement {
  const wrap = el("div", "tab-body datums-tab");

  const header = el("div", "datums-header");
  header.style.cssText = "display:flex; align-items:center; padding:4px 2px 6px;";
  const title = el("div");
  title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:600;";
  title.textContent = "REFERENCE LINES";
  header.appendChild(title);
  wrap.appendChild(header);

  const list = el("div", "datum-list");
  list.style.cssText = "display:flex; flex-direction:column; gap:2px;";
  wrap.appendChild(list);

  function renderList(): void {
    list.innerHTML = "";
    for (const rl of refLineStore.all()) {
      const row = el("div", "layer-row");
      row.style.cssText = "display:flex; align-items:center; gap:6px; padding:3px 2px; border-bottom:1px solid var(--hairline);";

      const posEl = el("span");
      posEl.style.cssText = "flex:1; font-size:11px; color:var(--ink-body); font-family:monospace;";
      const [ax, ay] = rl.start, [bx, by] = rl.end;
      posEl.textContent = rl.label ?? `(${ax.toFixed(1)},${ay.toFixed(1)}) → (${bx.toFixed(1)},${by.toFixed(1)})`;

      row.appendChild(posEl);
      list.appendChild(row);
    }
    if (refLineStore.all().length === 0) {
      const empty = el("div");
      empty.style.cssText = "font-size:11px; color:var(--ink-dim); padding:4px 2px;";
      empty.textContent = "No reference lines placed";
      list.appendChild(empty);
    }
  }

  refLineStore.subscribe(renderList);
  renderList();
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
  };

  for (const t of SIDEBAR_TABS) {
    const tab = el("div", "sb-tab", { "data-tab": t.id });
    tab.textContent = t.label;
    tab.addEventListener("click", () => activate(t.id));
    tabs.appendChild(tab);
  }

  const filterPanel = buildSelectionFiltersPanel();

  function activate(id: string) {
    tabs.querySelectorAll(".sb-tab").forEach((t) => {
      const isActive = (t as HTMLElement).dataset.tab === id;
      t.classList.toggle("active", isActive);
    });
    body.innerHTML = "";
    if (panes[id]) body.appendChild(panes[id]);
    // filterPanel + snap persist inside scroll context across tab switches.
    body.appendChild(filterPanel);
    body.appendChild(snap);
  }

  // Resize handle — drag left edge to widen/narrow sidebar.
  const SIDEBAR_W_KEY = "gemma-sidebar-w";
  const SIDEBAR_W_MIN = 240;
  const SIDEBAR_W_MAX = 480;

  const resizeHandle = el("div", "sidebar-resize-handle");
  let resizing = false;
  let resizeStartX = 0;
  let resizeStartW = 0;

  resizeHandle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    resizing = true;
    resizeHandle.classList.add("dragging");
    resizeHandle.setPointerCapture(e.pointerId);
    resizeStartX = e.clientX;
    const wb = host.closest<HTMLElement>(".workbench");
    resizeStartW = wb ? parseInt(getComputedStyle(wb).getPropertyValue("--sidebar-w").trim() || "320", 10) : 320;
  });

  resizeHandle.addEventListener("pointermove", (e: PointerEvent) => {
    if (!resizing) return;
    const dx = resizeStartX - e.clientX; // dragging left = wider
    const newW = Math.min(SIDEBAR_W_MAX, Math.max(SIDEBAR_W_MIN, resizeStartW + dx));
    const wb = host.closest<HTMLElement>(".workbench");
    if (wb) wb.style.setProperty("--sidebar-w", `${newW}px`);
  });

  resizeHandle.addEventListener("pointerup", (e: PointerEvent) => {
    if (!resizing) return;
    resizing = false;
    resizeHandle.classList.remove("dragging");
    resizeHandle.releasePointerCapture(e.pointerId);
    const wb = host.closest<HTMLElement>(".workbench");
    if (wb) {
      const current = wb.style.getPropertyValue("--sidebar-w");
      if (current) try { localStorage.setItem(SIDEBAR_W_KEY, current); } catch {}
    }
  });

  // Restore persisted width.
  const savedW = localStorage.getItem(SIDEBAR_W_KEY);
  if (savedW) {
    const wb = host.closest<HTMLElement>(".workbench") ?? document.querySelector<HTMLElement>(".workbench");
    if (wb) wb.style.setProperty("--sidebar-w", savedW);
  }

  // Auto-switch: inspect when wall(s) selected, scene when deselected/non-wall.
  function isWall(obj: THREE.Object3D) { return obj.userData?.creator === "wall"; }
  subscribe((sel) => {
    if (sel && isWall(sel.object)) activate("inspect");
    else if (!sel) activate("scene");
  });
  subscribeMulti(() => {
    const multi = getMultiSelected();
    if (multi.length > 1) {
      if (multi.some((s) => isWall(s.object))) activate("inspect");
      else activate("scene");
    }
  });

  host.appendChild(tabs);
  host.appendChild(body);
  host.appendChild(resizeHandle);
  activate("scene");
}

// Suggestion chips → existing demo prompts (drives #prompt-select).
// demoId is matched against the option label prefix ("1. ", "6. ", etc.)
// because main.ts populates the dropdown with `value=index, text="N. Label"`.
const PROMPT_CHIPS: { label: string; demoId: string }[] = [
  { label: "Wall",                               demoId: "wall" },
  { label: "Circular column",                   demoId: "column" },
  { label: "Raised slab",                       demoId: "raised-slab" },
  { label: "Slab w/ stair hole",                demoId: "slab-with-hole" },
  { label: "Wall with doorway",                 demoId: "wall-with-door" },
  { label: "L-shape walls",                     demoId: "l-walls" },
  { label: "Four-walled room",                  demoId: "four-walled-room" },
  { label: "Stair-step",                        demoId: "stair-step" },
  { label: "Schultz Residence · 14 components",  demoId: "schultz-residence" },
];

// localStorage-backed real session history — populated when user generates geometry.
const RECENT_LS_KEY = "gemma-cad:recent-v1";
const RECENT_LS_KEY_LEGACY = "gemma-architect:recent-v1";
type RecentEntry = { ts: string; label: string };

function loadRecentEntries(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_LS_KEY) ?? localStorage.getItem(RECENT_LS_KEY_LEGACY);
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
        ${mode === "console" ? "CONSOLE  ·  DSL COMMAND INPUT" : "CREATE  ·  CONVERSATION WITH GEMMA"}
      </div>
      <button class="mode-pill" title="Shift+Tab to toggle mode" data-mode="${mode}">
        ${mode === "console" ? "● CONSOLE" : "○ CREATE"}
      </button>
      <span class="ai-badge" id="ai-model-badge">
        <span class="v">G</span>EMMA·4·E4B  ·  LIVE
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
  const chatPanel = new ChatPanel(chatRoot);
  _chatPanel = chatPanel;
  void _refreshChatSkills();

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

      void (async () => {
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
          const sr = await startCommandSession({ command: verb, parameters: dispArgs, metadata: { source: "console" } });
          if (sr.status === "needs_input") {
            setPickerHint(sr.summary ?? "Click in viewport to place");
            pushLine("info", `${verb} → ${sr.summary ?? "needs_input"}`);
          } else if (sr.status === "success") {
            setPickerHint(null);
            pushLine("ok", `dispatch ${verb} → ok`);
          } else {
            // Not in dictionary — fall back to dispatchSync (e.g. setActiveTool)
            const dr = dispatchSync(verb, dispArgs);
            pushLine(
              dr.ok ? "ok" : (dr.error === "HandlerThrew" || dr.error === "NoHandler" ? "err" : "info"),
              `dispatch ${verb} → ${dr.ok ? dr.canonical! : `${dr.error}${dr.detail ? ": " + dr.detail : ""}`}`,
            );
          }
        }

        const c = compileDsl(dslSrc);
        if (!c.ok) {
          pushLine("err", `line ${c.line}: ${c.message}`);
          return;
        }
        if (c.dispatches && c.dispatches.length > 0) {
          for (const d of c.dispatches) {
            const sr = await startCommandSession({ command: d.verb, parameters: d.args, metadata: { source: "console" } });
            if (sr.status === "needs_input") {
              setPickerHint(sr.summary ?? "Click in viewport to place");
              pushLine("info", `${d.verb} → ${sr.summary ?? "needs_input"}`);
            } else if (sr.status === "success") {
              setPickerHint(null);
              pushLine("ok", `dispatch ${d.verb} → ok`);
            } else {
              const dr = dispatchSync(d.verb, d.args);
              pushLine(
                dr.ok ? "ok" : (dr.error === "HandlerThrew" || dr.error === "NoHandler" ? "err" : "info"),
                `dispatch ${d.verb} → ${dr.ok ? dr.canonical! : `${dr.error}${dr.detail ? ": " + dr.detail : ""}`}`,
              );
            }
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
      })();
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

// ── Live construction graph (SKILL NODES tab) ──────────────────────────────

// Session dispatch log — parallel to _nodes, records actual verb+args for
// skill capture. Cleared whenever the scene is cleared (gemma:run-ok resets).
const _sessionSteps: SkillStep[] = [];

// ── Cluster recording state ────────────────────────────────────────────────
let _recording = false;
let _recordSteps: SkillClusterStep[] = [];
let _recordStart = 0;
let _recordBtn: HTMLButtonElement | null = null;
let _recordStatus: HTMLSpanElement | null = null;

interface NodeRecord { label: string; verb?: string; args?: Record<string, unknown>; }
const _nodes: NodeRecord[] = [];
let _nodesLastSeqLen = 0;
let _selectedNodeIdx: number | null = null;
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

let _skillsWrap: HTMLElement | null = null;

async function refreshClusterCatalog(): Promise<void> {
  const clusters = await listClusters().catch(() => [] as SkillCluster[]);
  setClusterCatalog(clusters.map(c => ({ name: c.name, steps: c.steps.length })));
}

async function renderSkillNodes(): Promise<void> {
  if (!_skillsWrap) return;
  const [saved, clusters] = await Promise.all([
    listSavedSkills().catch(() => [] as SavedSkill[]),
    listClusters().catch(() => [] as SkillCluster[]),
  ]);
  _skillsWrap.innerHTML = "";

  // Session steps header + Save button
  const sessionHeader = document.createElement("div");
  sessionHeader.className = "skill-nodes-session-header";
  const stepCount = _sessionSteps.filter(s => /^(Ifc|Sd)/.test(s.verb)).length;
  sessionHeader.innerHTML = `
    <span class="skill-nodes-session-label">Session · ${stepCount} step${stepCount === 1 ? "" : "s"}</span>
    <button class="btn btn-sm skill-nodes-save-btn" type="button" ${stepCount === 0 ? "disabled" : ""}>Save as skill</button>
  `;
  const saveBtn = sessionHeader.querySelector<HTMLButtonElement>(".skill-nodes-save-btn")!;
  saveBtn.addEventListener("click", () => {
    const steps = _sessionSteps.filter(s => /^(Ifc|Sd)/.test(s.verb));
    openSaveSkillModal(steps);
  });
  _skillsWrap.appendChild(sessionHeader);

  // Live session node list (current build chain)
  const liveSection = document.createElement("div");
  liveSection.className = "skill-nodes-live";
  if (_nodes.length === 0) {
    liveSection.innerHTML = `<div class="empty-hint">Empty — run a prompt to build a chain.</div>`;
  } else {
    liveSection.innerHTML = _nodes.map((n, i) => `
      ${i > 0 ? `<div class="skill-nodes-arrow">↓</div>` : ""}
      <div class="node-box${i === _selectedNodeIdx ? " selected" : ""}" data-idx="${i}" title="${escHtml(n.label)}">${escHtml(n.label)}</div>
    `).join("");
  }
  _skillsWrap.appendChild(liveSection);

  // Saved skills section
  if (saved.length > 0) {
    const savedHeader = document.createElement("div");
    savedHeader.className = "skill-nodes-saved-header";
    savedHeader.textContent = `Saved skills (${saved.length})`;
    _skillsWrap.appendChild(savedHeader);

    for (const skill of saved) {
      const card = document.createElement("div");
      card.className = "skill-card";
      card.innerHTML = `
        <div class="skill-card-name">${escHtml(skill.name)}</div>
        ${skill.description ? `<div class="skill-card-desc">${escHtml(skill.description)}</div>` : ""}
        <div class="skill-card-meta">${skill.steps.length} step${skill.steps.length === 1 ? "" : "s"}</div>
        <div class="skill-card-actions">
          <button class="btn btn-sm skill-card-run" type="button">Run</button>
          <button class="btn btn-sm skill-card-delete" type="button">Delete</button>
        </div>
      `;
      card.querySelector<HTMLButtonElement>(".skill-card-run")!.addEventListener("click", async () => {
        for (const step of skill.steps) {
          dispatchSync(step.verb, step.args as DispatchArgs);
          await new Promise(r => setTimeout(r, 50));
        }
      });
      card.querySelector<HTMLButtonElement>(".skill-card-delete")!.addEventListener("click", async () => {
        await deleteSkill(skill.id);
        void renderSkillNodes();
      });
      _skillsWrap.appendChild(card);
    }
  }

  // Clusters section
  if (clusters.length > 0) {
    const clustersHeader = document.createElement("div");
    clustersHeader.className = "skill-nodes-saved-header";
    clustersHeader.textContent = `Clusters (${clusters.length})`;
    _skillsWrap.appendChild(clustersHeader);

    for (const cluster of clusters) {
      const card = document.createElement("div");
      card.className = "skill-card";
      card.innerHTML = `
        <div class="skill-card-name">${escHtml(cluster.name)}</div>
        <div class="skill-card-meta">${cluster.steps.length} step${cluster.steps.length === 1 ? "" : "s"} · cluster</div>
        <div class="skill-card-actions">
          <button class="btn btn-sm skill-card-run" type="button">Run</button>
          <button class="btn btn-sm skill-card-delete" type="button">Delete</button>
        </div>
      `;
      card.querySelector<HTMLButtonElement>(".skill-card-run")!.addEventListener("click", async () => {
        for (const step of cluster.steps) {
          await dispatch(step.verb, step.params as DispatchArgs);
          await new Promise(r => setTimeout(r, 50));
        }
      });
      card.querySelector<HTMLButtonElement>(".skill-card-delete")!.addEventListener("click", async () => {
        await deleteCluster(cluster.id);
        await refreshClusterCatalog();
        void renderSkillNodes();
      });
      _skillsWrap.appendChild(card);
    }
  }
}

let _canvasInstance: SkillCanvas | null = null;
// Kept for external call sites that may reference it (e.g. workbench:activate-canvas event).
let _activateNodesCanvas: (() => void) | null = null;

function buildSkillsTabBody(): HTMLElement {
  // #727: SKILL NODES tab — Grasshopper canvas (left) + resizable inspector (right).
  const outer = el("div", "tab-body skills-tab");
  outer.style.cssText = "display:flex; flex-direction:row; height:100%; overflow:hidden;";

  // ── Left: canvas column ───────────────────────────────────────────────────
  const nodesCol = document.createElement("div");
  nodesCol.className = "skills-nodes-col";
  nodesCol.style.cssText = "flex:1; min-width:0; display:flex; flex-direction:column; overflow:hidden;";

  const canvasPane = document.createElement("div");
  canvasPane.style.cssText = "flex:1; overflow:hidden;";
  _skillsWrap = null;
  _canvasInstance = new SkillCanvas(canvasPane);
  _activateNodesCanvas = null;

  _canvasInstance.setNodeSelectHandler((nodeId) => { _renderNodeInspector(nodeId); });

  nodesCol.appendChild(canvasPane);

  // ── Right: inspector sidecar (resizable 120-400px) ────────────────────────
  const paramsCol = document.createElement("div");
  paramsCol.className = "skills-params-col";
  paramsCol.style.cssText = "width:220px; flex-shrink:0; overflow-y:auto; padding:8px 10px; position:relative;";
  _paramsWrap = paramsCol;

  const resizeHandle = document.createElement("div");
  resizeHandle.className = "sc-inspector-resize";
  resizeHandle.style.cssText = "position:absolute; left:0; top:0; width:5px; height:100%; cursor:col-resize; z-index:2;";
  let _rDragX = 0;
  let _rDragW = 0;
  resizeHandle.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    _rDragX = ev.clientX;
    _rDragW = paramsCol.offsetWidth;
    const onMove = (mv: MouseEvent): void => {
      paramsCol.style.width = `${Math.max(120, Math.min(400, _rDragW - (mv.clientX - _rDragX)))}px`;
    };
    const onUp = (): void => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
  paramsCol.appendChild(resizeHandle);

  renderParameters(null);
  window.addEventListener("viewer:select", (rawEv) => {
    const uuid: string | null = (rawEv as CustomEvent<{ uuid: string | null }>).detail?.uuid ?? null;
    renderParameters(uuid);
  });

  outer.appendChild(nodesCol);
  outer.appendChild(paramsCol);
  return outer;
}

function _renderNodeInspector(nodeId: string | null): void {
  if (!_paramsWrap) return;
  if (!nodeId) { renderParameters(null); return; }
  const node = _canvasInstance?.getNode(nodeId);
  if (!node) { renderParameters(null); return; }

  _paramsWrap.innerHTML = "";

  // Re-add resize handle after innerHTML clear
  const rh = document.createElement("div");
  rh.className = "sc-inspector-resize";
  rh.style.cssText = "position:absolute; left:0; top:0; width:5px; height:100%; cursor:col-resize; z-index:2;";
  _paramsWrap.appendChild(rh);

  const header = document.createElement("div");
  header.className = "params-header";
  header.textContent = node.skillName ?? node.verb ?? (node.kind === "script" ? "Script" : "Node");
  _paramsWrap.appendChild(header);

  if (node.kind === "script") {
    const ta = document.createElement("textarea");
    ta.style.cssText = "width:100%; min-height:120px; font-family:monospace; font-size:11px; resize:vertical; margin-top:6px; box-sizing:border-box;";
    ta.value = node.scriptSource ?? "";
    ta.spellcheck = false;
    ta.addEventListener("input", () => { _canvasInstance?.updateNodeScript(nodeId, ta.value); });
    _paramsWrap.appendChild(ta);
  } else {
    const steps = node.skillSteps ?? [];
    const countEl = document.createElement("div");
    countEl.style.cssText = "font-size:11px; color:var(--muted); margin:4px 0 8px;";
    countEl.textContent = `${steps.length} step${steps.length === 1 ? "" : "s"}`;
    _paramsWrap.appendChild(countEl);

    steps.slice(0, 12).forEach((step, stepIdx) => {
      const verbRow = document.createElement("div");
      verbRow.className = "params-row";
      verbRow.style.cssText = "font-size:11px; font-weight:600; margin-top:8px; padding-bottom:2px; border-bottom:1px solid var(--border,#333);";
      verbRow.textContent = step.verb;
      _paramsWrap!.appendChild(verbRow);

      const numericArgs = Object.entries(step.args ?? {}).filter(([, v]) => typeof v === "number");
      for (const [key, rawVal] of numericArgs) {
        const val = rawVal as number;
        const absVal = Math.abs(val);
        const rangeMax = absVal < 0.5 ? 10 : Math.max(absVal * 4, 10);
        const rangeMin = -rangeMax;
        const stepSize = rangeMax <= 1 ? 0.01 : rangeMax <= 10 ? 0.1 : 0.5;

        const argRow = document.createElement("div");
        argRow.className = "params-row";
        argRow.style.cssText = "display:grid; grid-template-columns:70px 1fr 50px; align-items:center; gap:4px; margin:3px 0;";

        const label = document.createElement("span");
        label.className = "params-label";
        label.style.cssText = "font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        label.textContent = key;
        label.title = key;

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = String(rangeMin);
        slider.max = String(rangeMax);
        slider.step = String(stepSize);
        slider.value = String(val);
        slider.style.cssText = "width:100%; cursor:pointer;";

        const numIn = document.createElement("input");
        numIn.type = "number";
        numIn.value = String(val);
        numIn.step = String(stepSize);
        numIn.style.cssText = "width:100%; font-size:10px; padding:1px 3px; box-sizing:border-box; background:var(--surface2,#1e1e1e); color:var(--fg,#ccc); border:1px solid var(--border,#444);";

        slider.addEventListener("input", () => {
          const v = parseFloat(slider.value);
          numIn.value = String(v);
          _canvasInstance?.updateNodeArg(nodeId, stepIdx, key, v);
        });
        numIn.addEventListener("change", () => {
          const v = parseFloat(numIn.value);
          if (isNaN(v)) return;
          slider.value = String(Math.min(rangeMax, Math.max(rangeMin, v)));
          _canvasInstance?.updateNodeArg(nodeId, stepIdx, key, v);
        });

        argRow.append(label, slider, numIn);
        _paramsWrap!.appendChild(argRow);
      }
      if (numericArgs.length === 0) {
        const noArgs = document.createElement("div");
        noArgs.style.cssText = "font-size:10px; color:var(--muted); margin:2px 0 2px 4px;";
        noArgs.textContent = "(no numeric params)";
        _paramsWrap!.appendChild(noArgs);
      }
    });

    if (steps.length > 12) {
      const more = document.createElement("div");
      more.style.cssText = "font-size:10px; color:var(--muted); margin-top:4px;";
      more.textContent = `…and ${steps.length - 12} more`;
      _paramsWrap.appendChild(more);
    }
  }
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

let _historyFilter = "";
let _historyListEl: HTMLElement | null = null;

function renderHistory(): void {
  if (!_historyListEl) return;
  const q = _historyFilter.toLowerCase();
  const visible = _historyEvents.filter((h) =>
    !q || h.op.toLowerCase().includes(q) || h.args.toLowerCase().includes(q),
  );

  if (visible.length === 0) {
    _historyListEl.innerHTML = `<div class="empty-hint">No ops yet — load a demo or type a prompt.</div>`;
    return;
  }

  _historyListEl.innerHTML = "";
  for (const h of visible) {
    const row = document.createElement("div");
    row.className = "history-row";
    row.dataset.op = h.op;
    row.innerHTML = `
      <span class="history-ts">${escHtml(h.ts)}</span>
      <span class="history-op">${escHtml(h.op)}</span>
      <span class="history-args">${escHtml(h.args)}</span>
    `;
    row.addEventListener("click", () => {
      const viewer = (window as unknown as { __viewer?: { getScene(): THREE.Scene; selectObject(o: THREE.Object3D | null): void } }).__viewer;
      if (!viewer) return;
      viewer.getScene().traverse((obj) => {
        if ((obj.userData.dispatchVerb ?? obj.userData.creator) === h.op) {
          viewer.selectObject(obj);
        }
      });
    });
    _historyListEl.appendChild(row);
  }
  _historyListEl.scrollTop = _historyListEl.scrollHeight;
}

function buildHistoryTabBody(): HTMLElement {
  const wrap = el("div", "tab-body history-tab");
  wrap.style.cssText = "display:flex; flex-direction:column; height:100%; overflow:hidden;";
  _historyWrap = wrap;

  const filterBar = document.createElement("div");
  filterBar.className = "history-filter-bar";
  const filterInput = document.createElement("input");
  filterInput.type = "text";
  filterInput.placeholder = "Filter ops…";
  filterInput.className = "history-filter-input";
  filterInput.addEventListener("input", () => {
    _historyFilter = filterInput.value;
    renderHistory();
  });
  filterBar.appendChild(filterInput);
  wrap.appendChild(filterBar);

  const list = document.createElement("div");
  list.className = "history-list";
  _historyListEl = list;
  wrap.appendChild(list);

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
  // Wire post-dispatch recording hook (captures Ifc/Sd verb sequences for clusters).
  registerPostDispatch((canonical, args) => {
    if (_recording && /^(Ifc|Sd)/.test(canonical) && canonical !== "SdRunCluster" && canonical !== "SdListClusters") {
      _recordSteps.push({ verb: canonical, params: args as Record<string, unknown>, relativeTs: Date.now() - _recordStart });
    }
  });

  // Initialize cluster catalog for agent system prompt on startup.
  void refreshClusterCatalog();

  // Replicad worker path: fires when run-ok completes geometry compilation.
  window.addEventListener("gemma:run-ok", (rawEv) => {
    const ev = rawEv as CustomEvent<{ js: string; label: string }>;
    const { js, label } = ev.detail;
    _nodes.length = 0;
    _sessionSteps.length = 0;
    _nodesLastSeqLen = 0;
    for (const lbl of jsToNodeLabels(js)) {
      _nodes.push({ label: lbl });
    }
    appendHistory("generate", label);
    saveRecentEntry(label);
    void renderSkillNodes();
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
      _nodes.push({ label: commandToLabel(id, args as Record<string, unknown>), verb: id, args: args as Record<string, unknown> });
      _sessionSteps.push({ verb: id, args: args as Record<string, unknown> });
    }

    const argStr = Object.entries(args as Record<string, unknown>)
      .filter(([k]) => !["canonical", "kernel"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "number" ? (v as number).toFixed(2) : String(v)}`)
      .slice(0, 4)
      .join(" ");
    appendHistory(id, argStr);

    void renderSkillNodes();
    renderHistory();
  });

  // Refresh skill nodes after a skill is saved (modal dispatches this event).
  // Also push the newly-saved skill into the chat-panel fastpath.
  window.addEventListener("skillstore:saved", () => {
    void renderSkillNodes();
    void _refreshChatSkills();
  });

  window.addEventListener("viewer:select", (rawEv) => {
    const uuid: string | null = (rawEv as CustomEvent<{ uuid: string | null }>).detail?.uuid ?? null;
    if (uuid) {
      appendHistory("select", uuid.slice(0, 8) + "…");
      renderHistory();
    }
  });
}

// Numeric arg slider min/max/step heuristics by suffix.
function sliderBounds(name: string): [number, number, number] {
  const n = name.toLowerCase();
  if (n.includes("angle") || n.includes("rotation")) return [0, 360, 1];
  if (n.includes("thickness") || n.includes("t")) return [0.01, 2, 0.01];
  if (n.includes("radius") || n.includes("r")) return [0.05, 20, 0.05];
  if (n.includes("height") || n.includes("h")) return [0.1, 20, 0.1];
  return [0.05, 30, 0.05]; // width / length / depth / generic
}

function isDimensionKey(name: string): boolean {
  const n = name.toLowerCase();
  return !n.includes("angle") && !n.includes("rotation");
}

function fmtParam(key: string, v: number): string {
  return isDimensionKey(key) ? formatLength(v) : v.toFixed(2);
}

function renderNodeParameters(verb: string, args: Record<string, unknown>): void {
  if (!_paramsWrap) return;
  _paramsWrap.innerHTML = "";

  const header = document.createElement("div");
  header.className = "params-header";
  header.textContent = verb;
  _paramsWrap.appendChild(header);

  for (const [key, val] of Object.entries(args)) {
    if (key.startsWith("_") || key === "uuid") continue;
    if (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean") continue;

    const row = document.createElement("div");
    row.className = "params-row";
    const label = document.createElement("label");
    label.className = "params-label";
    label.textContent = key;

    if (typeof val === "number") {
      const [min, max, step] = sliderBounds(key);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "params-slider";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(val);

      const valueSpan = document.createElement("span");
      valueSpan.className = "params-value";
      valueSpan.textContent = fmtParam(key, val as number);

      slider.addEventListener("input", () => {
        valueSpan.textContent = fmtParam(key, Number(slider.value));
      });

      slider.addEventListener("change", () => {
        const newVal = Number(slider.value);
        const newArgs = { ...args, [key]: newVal };
        if (_selectedNodeIdx !== null && _nodes[_selectedNodeIdx]?.verb === verb) {
          _nodes[_selectedNodeIdx].args = newArgs;
        }
        dispatchSync(verb, newArgs as DispatchArgs);
      });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueSpan);
    } else {
      const valEl = document.createElement("span");
      valEl.className = "params-value params-value-static";
      valEl.textContent = String(val);
      row.appendChild(label);
      row.appendChild(valEl);
    }

    _paramsWrap.appendChild(row);
  }
}

let _paramsWrap: HTMLElement | null = null;

function renderParameters(uuid: string | null): void {
  if (!_paramsWrap) return;
  _paramsWrap.innerHTML = "";

  const viewer = (window as unknown as { __viewer?: { getScene(): { getObjectByUuid(u: string): import("three").Object3D | undefined }; removeObject(o: import("three").Object3D): boolean } }).__viewer;
  const obj = uuid && viewer ? viewer.getScene().getObjectByUuid(uuid) : null;
  const dispatchArgs = obj?.userData.dispatchArgs as Record<string, unknown> | undefined;
  const dispatchVerb = (obj?.userData.dispatchVerb ?? obj?.userData.creator) as string | undefined;

  if (!obj) {
    _paramsWrap.innerHTML = `<div class="empty-hint">Select an object to inspect its parameters.</div>`;
    return;
  }

  const header = document.createElement("div");
  header.className = "params-header";
  header.textContent = dispatchVerb ?? obj.name ?? obj.type ?? "Object";
  _paramsWrap.appendChild(header);

  // IFC / boot-mesh fallback: no dispatchArgs — introspect geometry
  if (!dispatchArgs || !dispatchVerb) {
    const geom = (obj as unknown as { geometry?: { type?: string; attributes?: { position?: { count?: number }; index?: { count?: number } } } }).geometry;
    const mat  = (obj as unknown as { material?: { type?: string; color?: { getHexString?(): string } } }).material;
    const pos  = obj.position;
    const bbox = new THREE.Box3().setFromObject(obj);
    const size = bbox.getSize(new THREE.Vector3());

    const addRow = (label: string, value: string): void => {
      const row = document.createElement("div");
      row.className = "params-row";
      row.innerHTML = `<span class="params-label">${escHtml(label)}</span><span class="params-value params-value-static">${escHtml(value)}</span>`;
      _paramsWrap!.appendChild(row);
    };

    addRow("type", geom?.type ?? obj.type ?? "—");
    if (geom?.attributes?.position?.count !== undefined) addRow("vertices", String(geom.attributes.position.count));
    if (geom?.attributes?.index?.count !== undefined) addRow("triangles", String(Math.floor(geom.attributes.index.count / 3)));
    addRow("bbox", `${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}`);
    addRow("position", `${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`);
    if (mat?.type) addRow("material", mat.type);
    if (mat?.color?.getHexString) addRow("color", `#${mat.color.getHexString()}`);
    if (obj.userData.creator) addRow("creator", String(obj.userData.creator));
    return;
  }

  for (const [key, val] of Object.entries(dispatchArgs)) {
    if (key.startsWith("_") || key === "uuid") continue;
    if (typeof val !== "number" && typeof val !== "string" && typeof val !== "boolean") continue;

    const row = document.createElement("div");
    row.className = "params-row";

    const label = document.createElement("label");
    label.className = "params-label";
    label.textContent = key;

    if (typeof val === "number") {
      const [min, max, step] = sliderBounds(key);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "params-slider";
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(val);

      const valueSpan = document.createElement("span");
      valueSpan.className = "params-value";
      valueSpan.textContent = fmtParam(key, val);

      slider.addEventListener("input", () => {
        valueSpan.textContent = fmtParam(key, Number(slider.value));
      });

      slider.addEventListener("change", () => {
        if (!viewer || !obj) return;
        const newVal = Number(slider.value);
        const newArgs = { ...(obj.userData.dispatchArgs as Record<string, unknown>), [key]: newVal };
        viewer.removeObject(obj);
        dispatchSync(dispatchVerb, newArgs as DispatchArgs);
      });

      row.appendChild(label);
      row.appendChild(slider);
      row.appendChild(valueSpan);
    } else {
      const valEl = document.createElement("span");
      valEl.className = "params-value params-value-static";
      valEl.textContent = String(val);
      row.appendChild(label);
      row.appendChild(valEl);
    }

    _paramsWrap.appendChild(row);
  }
}

function buildDock(
  tabsHost: HTMLElement,
  bodyHost: HTMLElement,
  promptPane: HTMLElement | null,
  _paramPanel: HTMLElement | null,
) {
  tabsHost.innerHTML = "";

  const panes: Record<string, HTMLElement> = {
    prompt:  buildPromptTabBody(promptPane),
    skills:  buildSkillsTabBody(),
    history: buildHistoryTabBody(),
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
    if (id === "prompt") {
      const remoteUrl = (import.meta.env as Record<string, string>).VITE_GEMMA_AGENT_URL ?? "";
      if (remoteUrl) {
        prefetchModel();
      } else {
        checkConsentAndLoad(MODEL_ID, () => prefetchModel());
      }
    }
  }
  activate("prompt");
  initLiveTabSubscriptions();

  // P5b: when chat-panel fires "skill:animate", switch to SKILLS→Canvas and run.
  window.addEventListener("skill:animate", (e) => {
    const { steps } = (e as CustomEvent<{ steps: SkillStep[] }>).detail;
    activate("skills");
    _activateNodesCanvas?.();
    void _canvasInstance?.runWithAnimation(steps);
  });
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

// ── View-switcher (W2.3) ──────────────────────────────────────────────────────

type ViewOption = { view: ViewName; tag: string; label: string };
const VIEW_OPTIONS: ViewOption[] = [
  { view: "top",         tag: "top",   label: "TOP" },
  { view: "bottom",      tag: "bot",   label: "BOTTOM" },
  { view: "front",       tag: "front", label: "FRONT" },
  { view: "back",        tag: "back",  label: "BACK" },
  { view: "left",        tag: "left",  label: "LEFT" },
  { view: "right",       tag: "right", label: "RIGHT" },
  { view: "iso",         tag: "iso",   label: "ISO" },
  { view: "perspective", tag: "persp", label: "PERSPECTIVE" },
];

function applyViewToBtn(btn: HTMLElement, view: ViewName): void {
  const opt = VIEW_OPTIONS.find(o => o.view === view);
  if (!opt) return;
  const tagEl = btn.querySelector<HTMLElement>(".vp-tag");
  const nameEl = btn.querySelector<HTMLElement>(".vp-view-name");
  if (tagEl) { tagEl.className = `vp-tag ${opt.tag}`; }
  if (nameEl) { nameEl.textContent = opt.label; }
  btn.dataset.vpView = view;
}

function initViewSwitcher(): void {
  const backdrop = el("div", "vs-backdrop vs-backdrop--hidden");
  document.body.appendChild(backdrop);

  const popover = el("div", "vs-popover vs-popover--hidden");
  popover.setAttribute("tabindex", "-1");
  document.body.appendChild(popover);

  let activeBtn: HTMLElement | null = null;
  let focusedIdx = -1;

  function setFocusedIdx(idx: number): void {
    focusedIdx = idx;
    popover.querySelectorAll<HTMLElement>(".vs-item").forEach((item, i) => {
      item.classList.toggle("vs-item--focused", i === idx);
    });
  }

  function closePopover(): void {
    popover.classList.add("vs-popover--hidden");
    backdrop.classList.add("vs-backdrop--hidden");
    activeBtn = null;
    focusedIdx = -1;
    popover.querySelectorAll<HTMLElement>(".vs-item").forEach(item => {
      item.classList.remove("vs-item--focused");
    });
  }

  function syncActive(current: ViewName): void {
    popover.querySelectorAll<HTMLElement>(".vs-item").forEach(item => {
      item.classList.toggle("vs-item--active", item.dataset.view === current);
    });
  }

  for (const opt of VIEW_OPTIONS) {
    const item = el("div", "vs-item", { "data-view": opt.view });
    item.innerHTML = `<span class="vs-check">✓</span><span class="vp-tag ${opt.tag}"></span><span class="vs-label">${opt.label}</span>`;
    item.addEventListener("click", () => {
      if (opt.view === "perspective") {
        dispatchSync("SdSetViewPerspective", {});
      } else {
        dispatchSync("SdSetViewOrtho", { view: opt.view });
      }
      if (activeBtn) applyViewToBtn(activeBtn, opt.view);
      closePopover();
    });
    popover.appendChild(item);
  }

  popover.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePopover(); e.preventDefault(); return; }
    const n = VIEW_OPTIONS.length;
    if (e.key === "ArrowDown") { e.preventDefault(); setFocusedIdx((focusedIdx + 1) % n); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setFocusedIdx((focusedIdx - 1 + n) % n); }
    else if (e.key === "Enter" && focusedIdx >= 0) {
      e.preventDefault();
      const opt = VIEW_OPTIONS[focusedIdx];
      if (opt) {
        if (opt.view === "perspective") {
          dispatchSync("SdSetViewPerspective", {});
        } else {
          dispatchSync("SdSetViewOrtho", { view: opt.view });
        }
        if (activeBtn) applyViewToBtn(activeBtn, opt.view);
        closePopover();
      }
    }
  });

  backdrop.addEventListener("click", closePopover);

  document.querySelectorAll<HTMLElement>(".vp-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (activeBtn === btn && !popover.classList.contains("vs-popover--hidden")) {
        closePopover();
        return;
      }
      activeBtn = btn;
      const rect = btn.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      popover.classList.remove("vs-popover--hidden");
      backdrop.classList.remove("vs-backdrop--hidden");
      const pw = popover.offsetWidth;
      const ph = popover.offsetHeight;
      let left = rect.left;
      let top  = rect.bottom + 2;
      if (left + pw > vw - 10) left = Math.max(0, rect.right - pw);
      if (top  + ph > vh - 10) top  = rect.top - ph - 2;
      popover.style.left = `${left}px`;
      popover.style.top  = `${top}px`;
      const currentView = btn.dataset.vpView as ViewName ?? "perspective";
      syncActive(currentView);
      const activeIdx = VIEW_OPTIONS.findIndex(o => o.view === currentView);
      setFocusedIdx(activeIdx >= 0 ? activeIdx : 0);
      popover.focus();
    });
  });

  // Keep viewport-2's button in sync when view changes via cmdk/agent.
  subscribeAppState("currentView", (view) => {
    const vp2btn = document.querySelector<HTMLElement>("#viewport-2 .vp-view-btn");
    if (vp2btn) applyViewToBtn(vp2btn, view);
  });
}

function initRenderModePopover(): void {
  const MODES: RenderMode[] = ["shaded", "wireframe", "ghosted", "realistic", "technical"];
  const LINE_TYPES: LineType[] = ["solid", "dashed", "hidden", "centerline", "gridline", "dotted"];
  const LINE_WEIGHTS: LineWeight[] = ["thin", "medium", "thick"];

  // Backdrop captures click-outside; sits below the popover in z-order.
  const backdrop = el("div", "rm-popover-backdrop rm-popover-backdrop--hidden");
  document.body.appendChild(backdrop);

  // Fixed-position popover appended to body — triggered by RENDER ribbon tab.
  const popover = el("div", "rm-popover rm-popover--hidden");
  popover.setAttribute("tabindex", "-1");
  document.body.appendChild(popover);

  // Mode list rows.
  const modeList = el("div", "rm-mode-list");
  for (const m of MODES) {
    const item = el("div", "rm-mode-item", { "data-mode": m });
    item.innerHTML = `<span class="rm-check">✓</span><span class="rm-label">${m.charAt(0).toUpperCase() + m.slice(1)}</span>`;
    item.addEventListener("click", () => { setRenderMode(m); closePopover(); });
    modeList.appendChild(item);
  }
  popover.appendChild(modeList);

  // Line type / weight sub-panel (shown only when TECHNICAL).
  const linePicker = el("div", "rm-line-picker rm-line-picker--hidden");
  const ltRow = el("div", "rm-lt-row");
  for (const lt of LINE_TYPES) {
    const b = el("button", "rm-lt-btn", { type: "button", "data-lt": lt, title: lt });
    b.textContent = lt.charAt(0).toUpperCase() + lt.slice(1);
    b.addEventListener("click", () => setLineType(lt));
    ltRow.appendChild(b);
  }
  linePicker.appendChild(ltRow);
  const lwRow = el("div", "rm-lw-row");
  for (const lw of LINE_WEIGHTS) {
    const b = el("button", "rm-lw-btn", { type: "button", "data-lw": lw, title: lw });
    b.textContent = lw.charAt(0).toUpperCase() + lw.slice(1);
    b.addEventListener("click", () => setLineWeight(lw));
    lwRow.appendChild(b);
  }
  linePicker.appendChild(lwRow);
  popover.appendChild(linePicker);

  let open = false;
  let focusedIdx = -1;

  function setFocusedIdx(idx: number): void {
    focusedIdx = idx;
    modeList.querySelectorAll<HTMLElement>(".rm-mode-item").forEach((item, i) => {
      item.classList.toggle("rm-mode-item--focused", i === idx);
    });
  }

  function closePopover() {
    open = false;
    focusedIdx = -1;
    popover.classList.add("rm-popover--hidden");
    backdrop.classList.add("rm-popover-backdrop--hidden");
    modeList.querySelectorAll<HTMLElement>(".rm-mode-item").forEach((item) => {
      item.classList.remove("rm-mode-item--focused");
    });
  }

  function syncState() {
    const mode = getRenderMode();
    const lt   = getLineType();
    const lw   = getLineWeight();
    modeList.querySelectorAll<HTMLElement>(".rm-mode-item").forEach((item) => {
      item.classList.toggle("rm-mode-item--active", item.dataset.mode === mode);
    });
    linePicker.classList.toggle("rm-line-picker--hidden", mode !== "technical");
    ltRow.querySelectorAll<HTMLElement>(".rm-lt-btn").forEach((b) => {
      b.classList.toggle("rm-lt-btn--active", b.dataset.lt === lt);
    });
    lwRow.querySelectorAll<HTMLElement>(".rm-lw-btn").forEach((b) => {
      b.classList.toggle("rm-lw-btn--active", b.dataset.lw === lw);
    });
  }

  // Keyboard: Escape closes; ArrowUp/Down cycles modes; Enter applies focused mode.
  popover.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePopover(); e.preventDefault(); return; }
    const items = MODES;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx((focusedIdx + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx((focusedIdx - 1 + items.length) % items.length);
    } else if (e.key === "Enter" && focusedIdx >= 0) {
      e.preventDefault();
      const m = MODES[focusedIdx];
      if (m) { setRenderMode(m); closePopover(); }
    }
  });

  // Wire each per-viewport RENDER button to fire render-mode-toggle with its own rect.
  document.querySelectorAll<HTMLElement>('.vp-render-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('render-mode-toggle', { detail: { rect: btn.getBoundingClientRect() } }));
    });
  });

  // RENDER button in each vp-header fires this event; position popover below it.
  window.addEventListener("render-mode-toggle", (rawEv) => {
    const rect = (rawEv as CustomEvent<{ rect: DOMRect }>).detail?.rect;
    open = !open;
    if (open && rect) {
      // Initial position
      popover.style.left = `${rect.left}px`;
      popover.style.top  = `${rect.bottom + 4}px`;
      popover.classList.remove("rm-popover--hidden");
      backdrop.classList.remove("rm-popover-backdrop--hidden");
      // Edge-collision clamp after layout
      const pw = popover.offsetWidth;
      const ph = popover.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = rect.left;
      let top  = rect.bottom + 4;
      if (left + pw > vw - 10) left = Math.max(0, rect.right - pw);
      if (top  + ph > vh - 10) top  = rect.top - ph - 4;
      popover.style.left = `${left}px`;
      popover.style.top  = `${top}px`;
      // Focus on currently-active mode
      const activeIdx = MODES.indexOf(getRenderMode());
      setFocusedIdx(activeIdx >= 0 ? activeIdx : 0);
      syncState();
      popover.focus();
    } else {
      closePopover();
    }
  });
  backdrop.addEventListener("click", closePopover);
  document.addEventListener("click", (e) => {
    if (open && !popover.contains(e.target as Node) && e.target !== backdrop) closePopover();
  });
  window.addEventListener("render-mode-changed", () => syncState());

  syncState();
}

// Panel collapse toggles (#488). Alt+[ = palette, Alt+] = sidebar.
// At ≤600px, panels become slide-in drawers (#517); at >600px, the
// palette-collapsed / sidebar-collapsed classes apply as before.
function wirePanelToggles() {
  const workbench = document.querySelector<HTMLElement>(".workbench");
  if (!workbench) return;

  // Backdrop and edge-tab toggle buttons (visible only at ≤600px via CSS).
  const backdrop = document.createElement("div");
  backdrop.className = "drawer-backdrop";
  document.body.appendChild(backdrop);

  const btnPalette = document.createElement("button");
  btnPalette.type = "button";
  btnPalette.className = "drawer-btn drawer-btn-palette";
  btnPalette.title = "Show palette";
  btnPalette.textContent = "≡";
  document.body.appendChild(btnPalette);

  const btnSidebar = document.createElement("button");
  btnSidebar.type = "button";
  btnSidebar.className = "drawer-btn drawer-btn-sidebar";
  btnSidebar.title = "Show sidebar";
  btnSidebar.textContent = "≡";
  document.body.appendChild(btnSidebar);

  function isDrawerMode(): boolean { return window.innerWidth <= 600; }

  function closeDrawers(): void {
    document.querySelector(".palette")?.classList.remove("drawer-open");
    document.querySelector(".sidebar")?.classList.remove("drawer-open");
    backdrop.classList.remove("active");
  }

  function toggleDrawer(panel: "palette" | "sidebar"): void {
    const el = document.querySelector<HTMLElement>(`.${panel}`);
    if (!el) return;
    const wasOpen = el.classList.contains("drawer-open");
    closeDrawers();
    if (!wasOpen) {
      el.classList.add("drawer-open");
      backdrop.classList.add("active");
    }
  }

  btnPalette.addEventListener("click", () => toggleDrawer("palette"));
  btnSidebar.addEventListener("click",  () => toggleDrawer("sidebar"));
  backdrop.addEventListener("click", closeDrawers);

  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key === "[") {
      e.preventDefault();
      if (isDrawerMode()) toggleDrawer("palette");
      else workbench.classList.toggle("palette-collapsed");
    }
    if (e.altKey && e.key === "]") {
      e.preventDefault();
      if (isDrawerMode()) toggleDrawer("sidebar");
      else workbench.classList.toggle("sidebar-collapsed");
    }
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

  initRenderModePopover();
  initViewSwitcher();

  wireDockResize();
  wirePanelToggles();
}
