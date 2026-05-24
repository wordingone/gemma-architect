// Layout (paper-space) mode.
//
// A functional implementation of layout mode where existing viewports ARE the
// cameras: the user composes a sheet by placing panels, picking which viewport
// each panel renders, and at what scale. References: Rhino's Layout + Detail
// viewport, AutoCAD's Paper Space + Viewports.
//
// Design notes:
//   - Sheet sizes are ISO A0..A4 + US Letter/Legal/Tabloid + Custom (W×H mm).
//   - Sheet renders at 96 dpi for screen preview, fit-to-container.
//   - Click-and-drag on the sheet creates a panel; toolbar buttons change the
//     viewport assignment + scale.
//   - Panels render live WebGL thumbnails via window.__viewer.renderThumbnailTo
//     when a viewer is loaded; an SVG fallback draws scene bounds for tests and
//     when no viewer is available. SceneBoundsProvider is injected at
//     buildLayoutMode-time; tests use a stub that returns a unit cube.
//   - Title block is a dedicated bottom strip; cells are contenteditable.
//   - Scale bar overlay per panel uses the panel's scale ratio.
//   - Export to SVG assembles panel SVGs + title block + scale bars into a
//     single <svg>. PDF uses jsPDF via dynamic import (so the test file can
//     pin a stub if needed; in practice we just import). AI re-uses the SVG
//     stream with a PostScript preamble + .ai extension. DWG falls back to
//     SVG when LibreDWG-WASM isn't bundled (it isn't, today — clear note).

import { iconSVG } from "../ui/icons";
import { formatLength } from "../units.js";
import { getState } from "../app-state.js";
import type { Viewer, ExportFacePoly, ClassifiedEdgeSeg } from "../viewer/viewer";
import { LINEWEIGHT, DASH_PATTERN, DXF_LWEIGHT, DXF_LINETYPE } from "../viewer/viewer";
import { clippingPlaneStore } from "../geometry/clipping-planes";
import { levelStore } from "../geometry/levels";

// --- Sheet sizes (mm) -----------------------------------------------------

export type SheetSizeId =
  | "A0" | "A1" | "A2" | "A3" | "A4"
  | "Letter" | "Legal" | "Tabloid"
  | "Custom";
export type Orientation = "portrait" | "landscape";

interface SheetDims { w: number; h: number; }

const SHEET_DIMS: Record<Exclude<SheetSizeId, "Custom">, SheetDims> = {
  A0:      { w: 841,  h: 1189 },
  A1:      { w: 594,  h: 841  },
  A2:      { w: 420,  h: 594  },
  A3:      { w: 297,  h: 420  },
  A4:      { w: 210,  h: 297  },
  Letter:  { w: 216,  h: 279  },
  Legal:   { w: 216,  h: 356  },
  Tabloid: { w: 279,  h: 432  },
};

const DEFAULT_CUSTOM: SheetDims = { w: 400, h: 600 };

function sheetMm(size: SheetSizeId, orientation: Orientation, custom: SheetDims): SheetDims {
  const base = size === "Custom" ? custom : SHEET_DIMS[size];
  // SHEET_DIMS list every preset as portrait (h >= w). landscape swaps.
  const portrait = base.w <= base.h ? base : { w: base.h, h: base.w };
  return orientation === "landscape" ? { w: portrait.h, h: portrait.w } : portrait;
}

// 96 dpi at 25.4 mm per inch ⇒ 1 mm = 96/25.4 px ≈ 3.7795 px.
const MM_TO_PX = 96 / 25.4;
function sheetPx(mm: SheetDims): { w: number; h: number; } {
  return { w: mm.w * MM_TO_PX, h: mm.h * MM_TO_PX };
}

// --- Viewports ------------------------------------------------------------

export type ViewportId =
  | "top" | "bottom"
  | "front" | "back"
  | "left" | "right"
  | "perspective" | "axonometric";

const VIEWPORT_LABELS: Record<ViewportId, string> = {
  top:          "TOP",
  bottom:       "BOTTOM",
  front:        "FRONT",
  back:         "BACK",
  left:         "LEFT",
  right:        "RIGHT",
  perspective:  "PERSPECTIVE",
  axonometric:  "AXONOMETRIC",
};

// --- Scale ratios ---------------------------------------------------------

const SCALE_PRESETS = [
  "1:1", "1:5", "1:10", "1:20", "1:25", "1:50",
  "1:100", "1:200", "1:500", "1:1000",
  "NTS", "Custom",
] as const;

// Standard US/Imperial architectural scales shown when unitSystem === "imperial".
// Format: "a" = 1'-0" where a is the paper measurement in inches.
// Ratio = 12 / a (feet to paper inches).
const IMPERIAL_SCALE_PRESETS = [
  `1/16" = 1'-0"`,  // 1:192
  `1/8" = 1'-0"`,   // 1:96
  `1/4" = 1'-0"`,   // 1:48
  `1/2" = 1'-0"`,   // 1:24
  `3/4" = 1'-0"`,   // 1:16
  `1" = 1'-0"`,     // 1:12
  `1-1/2" = 1'-0"`, // 1:8
  `3" = 1'-0"`,     // 1:4
  "NTS", "Custom",
] as const;

function activeScalePresets(): readonly string[] {
  return getState("unitSystem") === "imperial" ? IMPERIAL_SCALE_PRESETS : SCALE_PRESETS;
}

export type ScaleId = typeof SCALE_PRESETS[number] | typeof IMPERIAL_SCALE_PRESETS[number] | string;

export function parseScale(s: ScaleId): number {
  // Returns drawing-unit / paper-unit ratio. NTS → 1.
  if (s === "NTS") return 1;
  // Standard metric 1:N ratio.
  const metricM = /^1:(\d+(?:\.\d+)?)$/.exec(s);
  if (metricM) return parseFloat(metricM[1]);
  // Imperial architectural: 'a" = 1\'-0"' where a can be whole, fraction, or mixed.
  // e.g. '1/4" = 1\'-0"' → ratio = 12 / 0.25 = 48
  // e.g. '1-1/2" = 1\'-0"' → ratio = 12 / 1.5 = 8
  const impM = /^(.+?)" = 1'-0"$/.exec(s);
  if (impM) {
    const frac = impM[1].trim();
    const mixed = /^(\d+)-(\d+)\/(\d+)$/.exec(frac);
    const simple = /^(\d+)\/(\d+)$/.exec(frac);
    const whole = /^(\d+)$/.exec(frac);
    let inches: number;
    if (mixed) inches = parseInt(mixed[1]) + parseInt(mixed[2]) / parseInt(mixed[3]);
    else if (simple) inches = parseInt(simple[1]) / parseInt(simple[2]);
    else if (whole) inches = parseInt(whole[1]);
    else return 1;
    return inches > 0 ? 12 / inches : 1;
  }
  return 1;
}

// --- Display modes --------------------------------------------------------

export type DisplayMode = "shaded" | "wireframe" | "ghosted" | "realistic" | "technical";
const DISPLAY_MODES: DisplayMode[] = ["shaded", "wireframe", "ghosted", "realistic", "technical"];

// --- Sheet presets (W3.1) -------------------------------------------------

type SheetPresetId = "perspective" | "axonometric" | "plan" | "section" | "elevation" | "blank";
interface SheetPresetDef { name: string; viewport: ViewportId; scale: ScaleId; displayMode: DisplayMode; }
const SHEET_PRESET_DEFS: Record<Exclude<SheetPresetId, "blank">, SheetPresetDef> = {
  perspective: { name: "Perspective", viewport: "perspective", scale: "NTS",       displayMode: "technical" },
  axonometric: { name: "Axonometric", viewport: "axonometric", scale: "1:50",  displayMode: "technical" },
  plan:        { name: "Plan",        viewport: "top",         scale: "1:100", displayMode: "technical" },
  section:     { name: "Section",     viewport: "front",       scale: "1:50",  displayMode: "technical" },
  elevation:   { name: "Elevation",   viewport: "front",       scale: "1:50",  displayMode: "technical" },
};
// "plan" omitted — plan sheets are managed dynamically by syncPlanSheets() (#1846).
const SHEET_PRESET_ORDER: Exclude<SheetPresetId, "blank">[] = ["perspective", "axonometric", "section", "elevation"];

// --- Scene bounds provider ------------------------------------------------

export interface SceneBounds {
  min: [number, number, number];
  max: [number, number, number];
}
export type SceneBoundsProvider = () => SceneBounds;

const DEFAULT_BOUNDS: SceneBounds = { min: [-1, -1, -1], max: [1, 1, 1] };
const DEFAULT_PROVIDER: SceneBoundsProvider = () => DEFAULT_BOUNDS;

// Returns true when the bounds are the unit-cube stub (no real scene loaded).
function isStubBounds(b: SceneBounds): boolean {
  return (
    Math.abs(b.min[0] + 1) < 0.001 && Math.abs(b.min[1] + 1) < 0.001 && Math.abs(b.min[2] + 1) < 0.001 &&
    Math.abs(b.max[0] - 1) < 0.001 && Math.abs(b.max[1] - 1) < 0.001 && Math.abs(b.max[2] - 1) < 0.001
  );
}

// --- Sheet state ----------------------------------------------------------

interface SheetData {
  id: string;
  name: string;
  size: SheetSizeId;
  orientation: Orientation;
  customMm: SheetDims;
  panels: PanelState[];
}

let _sheetIdSeq = 0;
const newSheetId = (): string => `sheet-${++_sheetIdSeq}`;

// --- Panel state ----------------------------------------------------------

// Detail reference: the parent panel + region within it.
export interface DetailRef {
  parentPanelId: string;
  regionX: number;    // px in parent panel's local coordinate space
  regionY: number;
  regionW: number;
  regionH: number;
  label: string;      // A, B, C…
}

export interface PanelInit {
  x: number;          // px from sheet origin
  y: number;
  w: number;
  h: number;
  viewport: ViewportId;
  scale?: ScaleId;    // default "1:100"
  title?: string;
  border?: "thin" | "thick" | "none";
  displayMode?: DisplayMode; // default "shaded"; detail panels default "technical"
  detailOf?: DetailRef;
}

// PanelState is explicit (not Required<PanelInit>) so detailOf stays optional.
interface PanelState {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  viewport: ViewportId;
  scale: ScaleId;
  title: string;
  border: "thin" | "thick" | "none";
  displayMode: DisplayMode;
  detailOf?: DetailRef;
}

// --- Public API -----------------------------------------------------------

export interface LayoutOptions {
  size?: SheetSizeId;
  orientation?: Orientation;
  customMm?: SheetDims;
  bounds?: SceneBoundsProvider;
  initialPanels?: PanelInit[];
  titleBlock?: Partial<TitleBlock>;
  showTitleBlock?: boolean;  // default false — blank paper
  spawnDefault?: boolean;   // default true — auto-creates one panel on empty layout
}

export interface TitleBlock {
  project: string;
  sheet: string;
  scale: string;
  drawnBy: string;
  date: string;
}

const DEFAULT_TITLE: TitleBlock = {
  project:  "UNTITLED · 001",
  sheet:    "A-101",
  scale:    "1:50 / NTS",
  drawnBy:  "GEMMA·AI",
  date:     formatToday(),
};

function formatToday(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}·${m}·${dd}`;
}

let _panelIdSeq = 0;
const newPanelId = (): string => `panel-${++_panelIdSeq}`;

// LayoutController is the per-host instance state. Stored on the host element
// via a WeakMap so the module-level export functions (addPanel, exportLayout*)
// can resolve it without callers passing the instance back in.
class LayoutController {
  host: HTMLElement;
  sheets: SheetData[];
  activeSheetIdx: number = 0;
  bounds: SceneBoundsProvider;
  title: TitleBlock;

  // Getters proxy to active sheet so callers (export, addPanel, etc.) are unchanged.
  get activeSheet(): SheetData { return this.sheets[this.activeSheetIdx]; }
  get panels(): PanelState[] { return this.activeSheet.panels; }
  get size(): SheetSizeId { return this.activeSheet.size; }
  set size(v: SheetSizeId) { this.activeSheet.size = v; }
  get orientation(): Orientation { return this.activeSheet.orientation; }
  set orientation(v: Orientation) { this.activeSheet.orientation = v; }
  get customMm(): SheetDims { return this.activeSheet.customMm; }

  // DOM refs.
  sheetEl!: HTMLElement;
  toolbarEl!: HTMLElement;
  tabsScrollEl!: HTMLElement;
  private sizeSelEl!: HTMLSelectElement;
  private oriSelEl!: HTMLSelectElement;
  titleblockEl!: HTMLElement;

  // Drag-to-create state.
  private dragging: { startX: number; startY: number; el?: HTMLElement } | null = null;
  // Detail region drag state.
  private _detailDrag: {
    mode: "panel" | "sheet";
    parentId: string | null;
    parentEl: HTMLElement | null;
    parent: PanelState | null;
    startX: number;
    startY: number;
    ghost: HTMLElement;
  } | null = null;
  // Active ribbon tool (e.g. "detail"). null = default pointer.
  private activeTool: string | null = null;
  // Pan-tool drag state: screen origin + stage scroll origin.
  private _panDrag: { sx: number; sy: number; scrollLeft: number; scrollTop: number } | null = null;
  // Counter for detail label letters (A, B, C…).
  private _detailLabelSeq = 0;
  // Selected panel (for toolbar interaction).
  private selectedPanelId: string | null = null;
  // Live thumbnail canvases for detail panels: panelId → {canvas, viewName, displayMode}.
  private _thumbCanvases = new Map<string, { canvas: HTMLCanvasElement; viewName: "top" | "persp" | "front" | "right"; anchorX: number; anchorY: number; snapW: number; snapH: number; displayMode: DisplayMode }>();
  private _thumbRAF = 0;
  // Set by onSheetMouseUp when a drag-to-create completes; suppresses the
  // subsequent click event so click-to-add doesn't fire a second addPanel.
  private _dragCompleted = false;
  // Unlink button — visible only when activeSheet is linked to a clip plane (#1849 §5.4).
  private _unlinkBtn: HTMLElement | null = null;
  // Subscription for levelStore changes — auto-syncs plan sheets (#1846).
  private _levelUnsub: (() => void) | null = null;
  // levelId → sheetId for auto-named plan sheets (#1846). Per-instance to avoid cross-test pollution.
  private _planSheetByLevelId = new Map<string, string>();
  // sheetIds where user manually renamed — opts out of auto-rename on level rename (#1846).
  private _planSheetUserRenamed = new Set<string>();
  // levelId → sheetId for auto-named RCP sheets (#1844).
  private _rcpSheetByLevelId = new Map<string, string>();
  // sheetIds where user manually renamed the RCP tab (#1844).
  private _rcpSheetUserRenamed = new Set<string>();
  // Fit-to-stage scale factor (zoom). All mouse coords divided by this.
  private zoomFactor = 1;
  // Previous sheet pixel dimensions — used in applySheetDims to rescale panels proportionally.
  private _prevSheetPxW = 0;
  private _prevSheetPxH = 0;
  // Whether to render the title block.
  private _showTitleBlock: boolean;
  // Watches stage size changes (including mode-switch from display:none → flex).
  private _ro: ResizeObserver | null = null;
  // Active model-space navigation state (dblclick to enter, click-outside to exit).
  private _navPanelId: string | null = null;
  private _navDispose: (() => void) | null = null;
  private _navDocListener: ((e: MouseEvent) => void) | null = null;

  constructor(host: HTMLElement, opts: LayoutOptions) {
    this.host = host;
    const size = opts.size ?? "Tabloid";
    const orientation = opts.orientation ?? "landscape";
    const customMm = opts.customMm ?? { ...DEFAULT_CUSTOM };
    // 4 preset sheets (perspective/axonometric/section/elevation). Plan sheets added by syncPlanSheets (#1846).
    this.sheets = SHEET_PRESET_ORDER.map((pid) => ({
      id: newSheetId(),
      name: SHEET_PRESET_DEFS[pid].name,
      size,
      orientation,
      customMm: { ...customMm },
      panels: [],
    }));
    this.activeSheetIdx = 0;
    this.bounds = opts.bounds ?? DEFAULT_PROVIDER;
    this.title = { ...DEFAULT_TITLE, ...(opts.titleBlock ?? {}) };
    this._showTitleBlock = opts.showTitleBlock ?? false;
    this.build();
    // Spawn preset panels for each sheet unless caller overrides sheet 0 via initialPanels.
    if (opts.spawnDefault !== false) {
      const hasInitial = (opts.initialPanels?.length ?? 0) > 0;
      SHEET_PRESET_ORDER.forEach((pid, i) => {
        if (i === 0 && hasInitial) return; // initialPanels fill sheet 0 instead
        this.switchSheet(i);
        const def = SHEET_PRESET_DEFS[pid];
        this._spawnPresetPanel(def.viewport, def.scale, def.displayMode);
      });
      this.switchSheet(0);
    }
    // initialPanels go to the active (first) sheet.
    for (const p of opts.initialPanels ?? []) this.addPanel(p);
    // Re-fit whenever the stage changes size (covers mode-switch from display:none → flex).
    const stage = this.sheetEl.parentElement;
    if (stage && typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => requestAnimationFrame(() => this.fitToStage()));
      this._ro.observe(stage);
    }
  }

  // --- Build DOM -----

  private build(): void {
    this.host.innerHTML = "";
    this.host.classList.add("paper-mode");

    const stage = document.createElement("div");
    stage.className = "paper-stage";
    this.host.appendChild(stage);

    this.toolbarEl = document.createElement("div");
    this.toolbarEl.className = "paper-toolbar";
    this.host.appendChild(this.toolbarEl);
    this.buildToolbar();

    this.sheetEl = document.createElement("div");
    this.sheetEl.className = "paper-sheet";
    this.sheetEl.dataset.size = this.size;
    this.sheetEl.dataset.orientation = this.orientation;
    stage.appendChild(this.sheetEl);

    this.applySheetDims();

    // Click-and-drag panel creation. Bound on sheet so panel children block by
    // checking event.target before opening a drag.
    this.sheetEl.addEventListener("mousedown", (e) => this.onSheetMouseDown(e));
    this.sheetEl.addEventListener("mousemove", (e) => this.onSheetMouseMove(e));
    this.sheetEl.addEventListener("mouseup",   ()  => this.onSheetMouseUp());
    this.sheetEl.addEventListener("mouseleave",()  => this.onSheetMouseUp());
    // Click-to-add: single click on empty sheet area creates a default-size panel.
    // Fires after mouseup; suppressed when a drag-to-create just completed.
    this.sheetEl.addEventListener("click", (e) => this.onSheetClick(e));

    // Ribbon tool activation.
    window.addEventListener("ribbon:tool-click", (e: Event) => {
      const ce = e as CustomEvent<{ tool: string | null }>;
      const tool = ce.detail.tool;
      // Always clean up active drag state on tool switch.
      this._detailDrag?.ghost.remove();
      this._detailDrag = null;
      this.dragging?.el?.remove();
      this.dragging = null;
      this._panDrag = null;
      if (!tool || tool === "select") {
        this.activeTool = null;
        this.sheetEl.style.cursor = "";
      } else if (tool === "pan") {
        this.activeTool = "pan";
        this.sheetEl.style.cursor = "grab";
      } else if (tool === "zoom") {
        this.activeTool = "zoom";
        this.sheetEl.style.cursor = "zoom-in";
      } else {
        // All other tools: crosshair cursor, activeTool set for future handlers.
        this.activeTool = tool;
        this.sheetEl.style.cursor = "crosshair";
      }
    });

    // Title block — only when explicitly requested.
    this.titleblockEl = document.createElement("div");
    this.titleblockEl.className = "paper-titleblock";
    if (this._showTitleBlock) {
      this.sheetEl.appendChild(this.titleblockEl);
      this.renderTitleBlock();
    }

    // Subscribe to levelStore so plan + RCP sheets track level changes (#1846/#1844).
    if (this._levelUnsub) this._levelUnsub();
    this._levelUnsub = levelStore.subscribe(() => {
      this.syncPlanSheets();
      this.syncRcpSheets();
    });
    this.syncPlanSheets();
    this.syncRcpSheets();
  }

  private buildToolbar(): void {
    const tb = this.toolbarEl;
    tb.innerHTML = "";

    // Left: sheet tab strip (nav arrows + scrollable tabs + add).
    const tabStrip = document.createElement("div");
    tabStrip.className = "sheet-tab-strip";

    // Scroll-left button.
    const navL = document.createElement("button");
    navL.type = "button";
    navL.className = "sheet-tab-nav";
    navL.innerHTML = "&#9664;";
    navL.title = "Scroll tabs left";
    navL.addEventListener("click", () => {
      this.tabsScrollEl.scrollBy({ left: -120, behavior: "smooth" });
    });
    tabStrip.appendChild(navL);

    // Scrollable tabs container.
    const tabsScroll = document.createElement("div");
    tabsScroll.className = "sheet-tabs";
    this.tabsScrollEl = tabsScroll;
    tabStrip.appendChild(tabsScroll);

    // Scroll-right button.
    const navR = document.createElement("button");
    navR.type = "button";
    navR.className = "sheet-tab-nav";
    navR.innerHTML = "&#9654;";
    navR.title = "Scroll tabs right";
    navR.addEventListener("click", () => {
      this.tabsScrollEl.scrollBy({ left: 120, behavior: "smooth" });
    });
    tabStrip.appendChild(navR);

    // Add-sheet button — shows preset picker.
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "sheet-tab-add";
    addBtn.title = "Add sheet";
    addBtn.textContent = "+";
    addBtn.addEventListener("click", () => this.addSheet());
    tabStrip.appendChild(addBtn);

    tb.appendChild(tabStrip);
    this.renderTabs();

    // Right: settings (size, orient, custom dims).
    const settings = document.createElement("div");
    settings.className = "paper-toolbar-settings";

    // Sheet-size dropdown.
    const sizeSel = document.createElement("select");
    sizeSel.className = "paper-tool";
    sizeSel.setAttribute("aria-label", "Sheet size");
    const sizes: SheetSizeId[] = ["Tabloid", "Letter", "Legal", "A0", "A1", "A2", "A3", "A4", "Custom"];
    for (const s of sizes) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s === "Tabloid" ? "11×17" : s;
      if (s === this.size) opt.selected = true;
      sizeSel.appendChild(opt);
    }
    sizeSel.addEventListener("change", () => {
      this.size = sizeSel.value as SheetSizeId;
      customWrap.classList.toggle("visible", this.size === "Custom");
      this.applySheetDims();
    });
    this.sizeSelEl = sizeSel;
    settings.appendChild(this.labelled("Size", sizeSel));

    // Orientation toggle.
    const oriSel = document.createElement("select");
    oriSel.className = "paper-tool";
    oriSel.setAttribute("aria-label", "Orientation");
    for (const o of ["landscape", "portrait"] as Orientation[]) {
      const opt = document.createElement("option");
      opt.value = o; opt.textContent = o.charAt(0).toUpperCase() + o.slice(1);
      if (o === this.orientation) opt.selected = true;
      oriSel.appendChild(opt);
    }
    oriSel.addEventListener("change", () => {
      this.orientation = oriSel.value as Orientation;
      this.applySheetDims();
    });
    this.oriSelEl = oriSel;
    settings.appendChild(this.labelled("Orient", oriSel));

    // Custom dims (visible only when Custom selected).
    const wIn = document.createElement("input");
    wIn.type = "number"; wIn.value = String(this.customMm.w); wIn.min = "10"; wIn.step = "1";
    wIn.className = "paper-tool paper-tool-num";
    wIn.setAttribute("aria-label", "Custom width (mm)");
    wIn.addEventListener("change", () => {
      this.customMm.w = Math.max(10, Number(wIn.value) || DEFAULT_CUSTOM.w);
      if (this.size === "Custom") this.applySheetDims();
    });
    const hIn = document.createElement("input");
    hIn.type = "number"; hIn.value = String(this.customMm.h); hIn.min = "10"; hIn.step = "1";
    hIn.className = "paper-tool paper-tool-num";
    hIn.setAttribute("aria-label", "Custom height (mm)");
    hIn.addEventListener("change", () => {
      this.customMm.h = Math.max(10, Number(hIn.value) || DEFAULT_CUSTOM.h);
      if (this.size === "Custom") this.applySheetDims();
    });
    const customWrap = document.createElement("span");
    customWrap.className = "paper-tool-custom";
    customWrap.appendChild(this.labelled("W mm", wIn));
    customWrap.appendChild(this.labelled("H mm", hIn));
    settings.appendChild(customWrap);

    tb.appendChild(settings);

    // Unlink button — shown when the active sheet is linked to a clip-plane entity (#1849 §5.4).
    const unlinkBtn = document.createElement("button");
    unlinkBtn.type = "button";
    unlinkBtn.className = "paper-tool paper-tool-unlink";
    unlinkBtn.style.cssText = "display:none; margin-left:8px; background:none; border:1px solid var(--hairline); border-radius:2px; color:var(--sanguine,#c0392b); cursor:pointer; padding:0 8px; line-height:24px; font-size:10px; letter-spacing:0.05em;";
    unlinkBtn.textContent = "Unlink";
    unlinkBtn.title = "Detach sheet from linked clipping plane (freeze current bounds)";
    unlinkBtn.addEventListener("click", () => {
      const host = this.host;
      const sheetId = this.activeSheet.id;
      unlinkClipPlaneSheet(host, sheetId);
      unlinkBtn.style.display = "none";
    });
    this._unlinkBtn = unlinkBtn;
    tb.appendChild(unlinkBtn);
  }

  private renderTabs(): void {
    const c = this.tabsScrollEl;
    if (!c) return;
    c.innerHTML = "";
    this.sheets.forEach((sheet, i) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `sheet-tab${i === this.activeSheetIdx ? " active" : ""}`;
      tab.textContent = sheet.name;
      tab.title = sheet.name;
      tab.addEventListener("click", () => this.switchSheet(i));
      // Double-click to rename — inline input (no window.prompt).
      tab.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "text";
        input.className = "sheet-tab-rename-input";
        input.value = sheet.name;
        tab.textContent = "";
        tab.appendChild(input);
        input.focus();
        input.select();
        const commit = () => {
          const v = input.value.trim();
          if (v) sheet.name = v;
          this.renderTabs();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { ke.preventDefault(); commit(); }
          else if (ke.key === "Escape") { ke.stopPropagation(); this.renderTabs(); }
        });
        input.addEventListener("click", (ie) => ie.stopPropagation());
      });
      c.appendChild(tab);
    });
    // Scroll active tab into view.
    const activeTab = c.children[this.activeSheetIdx] as HTMLElement | undefined;
    activeTab?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }

  private switchSheet(idx: number): void {
    if (idx < 0 || idx >= this.sheets.length || idx === this.activeSheetIdx) return;
    this.activeSheetIdx = idx;
    this._prevSheetPxW = 0; this._prevSheetPxH = 0;
    // Clear panels from DOM (keep sheet element, titleblock).
    this.sheetEl.querySelectorAll(".paper-cell").forEach((el) => el.remove());
    // Apply new sheet size/orientation.
    this.applySheetDims();
    // Re-render this sheet's panels.
    for (const p of this.activeSheet.panels) this.renderPanel(p);
    // Sync settings dropdowns.
    if (this.sizeSelEl) this.sizeSelEl.value = this.size;
    if (this.oriSelEl) this.oriSelEl.value = this.orientation;
    // Update Unlink button visibility for the new active sheet (#1849 §5.4).
    if (this._unlinkBtn) {
      const isLinked = _sheetClipLinks.has(this.activeSheet.id);
      this._unlinkBtn.style.display = isLinked ? "inline-block" : "none";
    }
    // Update tab highlight.
    this.renderTabs();
  }

  /**
   * Sync plan sheets with the levelStore (#1846).
   * Called once on init and on every levelStore change.
   * - Adds a plan sheet for any level with no linked sheet.
   * - Renames existing linked sheets when the level's name changes (unless user-renamed).
   * - Removes plan sheets for levels that have been deleted.
   */
  private syncPlanSheets(): void {
    const levels = levelStore.all();
    const currentLevelIds = new Set(levels.map(l => l.id));

    // Remove sheets for deleted levels.
    for (const [levelId, sheetId] of [...this._planSheetByLevelId.entries()]) {
      if (!currentLevelIds.has(levelId)) {
        const idx = this.sheets.findIndex(s => s.id === sheetId);
        if (idx !== -1) {
          if (this.activeSheetIdx > idx) this.activeSheetIdx--;
          else if (this.activeSheetIdx === idx) this.activeSheetIdx = Math.max(0, idx - 1);
          this.sheets.splice(idx, 1);
        }
        this._planSheetByLevelId.delete(levelId);
        this._planSheetUserRenamed.delete(sheetId);
      }
    }

    // Add or rename sheets for current levels.
    for (const level of levels) {
      const expectedName = `Plan: ${level.name}`;
      const existingSheetId = this._planSheetByLevelId.get(level.id);
      if (!existingSheetId) {
        // Create new plan sheet for this level.
        const id = newSheetId();
        this._planSheetByLevelId.set(level.id, id);
        const defaultSheet = this.sheets[0];
        this.sheets.push({
          id,
          name: expectedName,
          size: defaultSheet?.size ?? "Tabloid",
          orientation: defaultSheet?.orientation ?? "landscape",
          customMm: defaultSheet ? { ...defaultSheet.customMm } : { ...DEFAULT_CUSTOM },
          panels: [],
        });
      } else if (!this._planSheetUserRenamed.has(existingSheetId)) {
        // Rename if level was renamed.
        const sheet = this.sheets.find(s => s.id === existingSheetId);
        if (sheet && sheet.name !== expectedName) sheet.name = expectedName;
      }
    }

    this.renderTabs();
  }

  /** Return the levelId linked to a plan sheet, or undefined if not a plan sheet (#1846). */
  getLinkedLevelId(sheetId: string): string | undefined {
    for (const [levelId, sid] of this._planSheetByLevelId) {
      if (sid === sheetId) return levelId;
    }
    return undefined;
  }

  /** Mark a plan sheet as user-renamed — opt out of auto-rename on level rename (#1846). */
  markUserRenamed(sheetId: string): void {
    this._planSheetUserRenamed.add(sheetId);
  }

  /** Sync RCP sheets with levelStore — mirrors syncPlanSheets() with "RCP:" prefix (#1844). */
  private syncRcpSheets(): void {
    const levels = levelStore.all();
    const currentLevelIds = new Set(levels.map(l => l.id));

    for (const [levelId, sheetId] of [...this._rcpSheetByLevelId.entries()]) {
      if (!currentLevelIds.has(levelId)) {
        const idx = this.sheets.findIndex(s => s.id === sheetId);
        if (idx !== -1) {
          if (this.activeSheetIdx > idx) this.activeSheetIdx--;
          else if (this.activeSheetIdx === idx) this.activeSheetIdx = Math.max(0, idx - 1);
          this.sheets.splice(idx, 1);
        }
        this._rcpSheetByLevelId.delete(levelId);
        this._rcpSheetUserRenamed.delete(sheetId);
      }
    }

    for (const level of levels) {
      const expectedName = `RCP: ${level.name}`;
      const existingSheetId = this._rcpSheetByLevelId.get(level.id);
      if (!existingSheetId) {
        const id = newSheetId();
        this._rcpSheetByLevelId.set(level.id, id);
        const defaultSheet = this.sheets[0];
        this.sheets.push({
          id,
          name: expectedName,
          size: defaultSheet?.size ?? "Tabloid",
          orientation: defaultSheet?.orientation ?? "landscape",
          customMm: defaultSheet ? { ...defaultSheet.customMm } : { ...DEFAULT_CUSTOM },
          panels: [],
        });
      } else if (!this._rcpSheetUserRenamed.has(existingSheetId)) {
        const sheet = this.sheets.find(s => s.id === existingSheetId);
        if (sheet && sheet.name !== expectedName) sheet.name = expectedName;
      }
    }

    this.renderTabs();
  }

  /** Return the levelId linked to an RCP sheet, or undefined if not an RCP sheet (#1844). */
  getRcpLinkedLevelId(sheetId: string): string | undefined {
    for (const [levelId, sid] of this._rcpSheetByLevelId) {
      if (sid === sheetId) return levelId;
    }
    return undefined;
  }

  /** Mark an RCP sheet as user-renamed — opt out of auto-rename on level rename (#1844). */
  markRcpUserRenamed(sheetId: string): void {
    this._rcpSheetUserRenamed.add(sheetId);
  }

  /** Auto-create a named sheet linked to a clipping-plane entity (#1849). Returns new sheet id. */
  addLinkedSheet(name: string, clipPlaneId?: string): string {
    const id = newSheetId();
    // Store the link BEFORE switchSheet so the Unlink button appears on first switch.
    if (clipPlaneId) _sheetClipLinks.set(id, clipPlaneId);
    this.sheets.push({
      id,
      name,
      size: this.size,
      orientation: this.orientation,
      customMm: { ...this.customMm },
      panels: [],
    });
    this.renderTabs();
    this.switchSheet(this.sheets.length - 1);
    return id;
  }

  private addSheet(presetId?: SheetPresetId): void {
    if (!presetId) { this._showPresetPicker(); return; }
    const def = presetId !== "blank" ? SHEET_PRESET_DEFS[presetId as Exclude<SheetPresetId, "blank">] : null;
    this.sheets.push({
      id: newSheetId(),
      name: def ? def.name : `Sheet ${this.sheets.length + 1}`,
      size: this.size,
      orientation: this.orientation,
      customMm: { ...this.customMm },
      panels: [],
    });
    this.switchSheet(this.sheets.length - 1);
    if (def) this._spawnPresetPanel(def.viewport, def.scale, def.displayMode);
  }

  private _spawnPresetPanel(viewport: ViewportId, scale: ScaleId, displayMode: DisplayMode): void {
    const mm = sheetMm(this.size, this.orientation, this.customMm);
    const r = 0.015; // 1.5% margin → ~97% content area
    this.addPanel({
      x: Math.round(mm.w * MM_TO_PX * r),
      y: Math.round(mm.h * MM_TO_PX * r),
      w: Math.round(mm.w * MM_TO_PX * (1 - 2 * r)),
      h: Math.round(mm.h * MM_TO_PX * (1 - 2 * r)),
      viewport, scale, displayMode,
    });
  }

  private _spawnDefaultPanel(): void {
    this._spawnPresetPanel("perspective", "1:100", "shaded");
  }

  private _showPresetPicker(): void {
    const overlay = document.createElement("div");
    overlay.className = "sheet-preset-picker";
    const dismiss = () => overlay.remove();
    overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(); });
    const presets: Array<{ id: SheetPresetId; label: string }> = [
      { id: "perspective", label: "Perspective" },
      { id: "axonometric", label: "Axonometric" },
      { id: "plan",        label: "Plan" },
      { id: "section",     label: "Section" },
      { id: "elevation",   label: "Elevation" },
      { id: "blank",       label: "Blank" },
    ];
    const grid = document.createElement("div");
    grid.className = "sheet-preset-grid";
    for (const p of presets) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sheet-preset-btn";
      btn.dataset.preset = p.id;
      btn.textContent = p.label;
      btn.addEventListener("click", () => { dismiss(); this.addSheet(p.id); });
      grid.appendChild(btn);
    }
    overlay.appendChild(grid);
    this.host.appendChild(overlay);
  }

  private labelled(name: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "paper-tool-label";
    const k = document.createElement("span");
    k.className = "paper-tool-k";
    k.textContent = name;
    wrap.appendChild(k);
    wrap.appendChild(control);
    return wrap;
  }

  private applySheetDims(): void {
    const mm = sheetMm(this.size, this.orientation, this.customMm);
    const px = sheetPx(mm);
    if (this._prevSheetPxW > 0 && this._prevSheetPxH > 0 && this.panels.length > 0) {
      const sx = px.w / this._prevSheetPxW;
      const sy = px.h / this._prevSheetPxH;
      for (const p of this.panels) {
        p.x = Math.round(p.x * sx); p.y = Math.round(p.y * sy);
        p.w = Math.round(p.w * sx); p.h = Math.round(p.h * sy);
      }
      for (const p of this.panels) this.renderPanel(p);
    }
    this._prevSheetPxW = px.w;
    this._prevSheetPxH = px.h;
    this.sheetEl.style.width = `${px.w}px`;
    this.sheetEl.style.height = `${px.h}px`;
    this.sheetEl.style.aspectRatio = `${mm.w} / ${mm.h}`;
    this.sheetEl.dataset.size = this.size;
    this.sheetEl.dataset.orientation = this.orientation;
    this.sheetEl.dataset.widthMm = String(mm.w);
    this.sheetEl.dataset.heightMm = String(mm.h);
    // Scale sheet to fit stage after layout stabilizes.
    requestAnimationFrame(() => this.fitToStage());
  }

  private fitToStage(): void {
    const stage = this.sheetEl.parentElement as HTMLElement | null;
    if (!stage) return;
    const PAD = 32;
    const sw = stage.clientWidth  - PAD * 2;
    const sh = stage.clientHeight - PAD * 2;
    if (sw <= 0 || sh <= 0) return;
    const pxW = parseFloat(this.sheetEl.style.width)  || 1;
    const pxH = parseFloat(this.sheetEl.style.height) || 1;
    this.zoomFactor = Math.min(1, sw / pxW, sh / pxH);
    this.sheetEl.style.zoom = String(this.zoomFactor);
    // Expose inverse zoom so CSS can scale header content back to screen size.
    this.sheetEl.style.setProperty("--iz", String(1 / this.zoomFactor));
  }

  // --- Drag-to-create ----

  private onSheetMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    if (this.activeTool === "pan") {
      const stage = this.sheetEl.parentElement as HTMLElement | null;
      if (stage) {
        this.sheetEl.style.cursor = "grabbing";
        this._panDrag = { sx: e.clientX, sy: e.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
        e.preventDefault();
      }
      return;
    }
    if (this.activeTool === "detail") {
      this.startDetailDrag(e);
      return;
    }
    if (this.activeTool !== "viewport") return;
    // Ignore clicks that originate in panels / titleblock — those have their
    // own click handlers (selection / contenteditable).
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest(".paper-cell, .paper-titleblock, .paper-toolbar")) return;
    const rect = this.sheetEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.zoomFactor;
    const y = (e.clientY - rect.top)  / this.zoomFactor;
    const ghost = document.createElement("div");
    ghost.className = "paper-cell-ghost";
    ghost.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;border:1.5px dashed var(--ink,#1a1a22);pointer-events:none;z-index:100;`;
    this.sheetEl.appendChild(ghost);
    this.dragging = { startX: x, startY: y, el: ghost };
  }

  private startDetailDrag(e: MouseEvent): void {
    const tgt = e.target as HTMLElement | null;
    const panelEl = tgt?.closest<HTMLElement>(".paper-cell");
    const panelId = panelEl?.dataset.panelId ?? null;
    const parent = panelId ? (this.panels.find((p) => p.id === panelId) ?? null) : null;

    const rect = panelEl
      ? panelEl.getBoundingClientRect()
      : this.sheetEl.getBoundingClientRect();

    const x = (e.clientX - rect.left) / this.zoomFactor;
    const y = (e.clientY - rect.top)  / this.zoomFactor;

    const ghost = document.createElement("div");
    ghost.className = "paper-cell-ghost";
    ghost.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0;border:1.5px dashed var(--accent,#3d85c8);pointer-events:none;z-index:100;`;
    (panelEl ?? this.sheetEl).appendChild(ghost);

    this._detailDrag = {
      mode: panelId ? "panel" : "sheet",
      parentId: panelId,
      parentEl: panelEl ?? null,
      parent,
      startX: x,
      startY: y,
      ghost,
    };
  }

  private onSheetMouseMove(e: MouseEvent): void {
    if (this._panDrag) {
      const stage = this.sheetEl.parentElement as HTMLElement | null;
      if (stage) {
        stage.scrollLeft = this._panDrag.scrollLeft - (e.clientX - this._panDrag.sx);
        stage.scrollTop  = this._panDrag.scrollTop  - (e.clientY - this._panDrag.sy);
      }
      return;
    }
    if (this._detailDrag) {
      this.updateDetailDrag(e);
      return;
    }
    if (!this.dragging) return;
    const rect = this.sheetEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / this.zoomFactor;
    const y = (e.clientY - rect.top) / this.zoomFactor;
    const dx = x - this.dragging.startX;
    const dy = y - this.dragging.startY;
    const ghost = this.dragging.el!;
    const left = Math.min(this.dragging.startX, x);
    const top  = Math.min(this.dragging.startY, y);
    ghost.style.left = `${left}px`;
    ghost.style.top  = `${top}px`;
    ghost.style.width  = `${Math.abs(dx)}px`;
    ghost.style.height = `${Math.abs(dy)}px`;
  }

  private updateDetailDrag(e: MouseEvent): void {
    if (!this._detailDrag) return;
    const { mode, parentEl, parent, startX, startY, ghost } = this._detailDrag;

    if (mode === "panel") {
      const rect = parentEl!.getBoundingClientRect();
      const rawX = Math.max(0, Math.min((e.clientX - rect.left) / this.zoomFactor, parent!.w));
      const rawY = Math.max(0, Math.min((e.clientY - rect.top)  / this.zoomFactor, parent!.h));
      ghost.style.left   = `${Math.min(startX, rawX)}px`;
      ghost.style.top    = `${Math.min(startY, rawY)}px`;
      ghost.style.width  = `${Math.abs(rawX - startX)}px`;
      ghost.style.height = `${Math.abs(rawY - startY)}px`;
    } else {
      const rect = this.sheetEl.getBoundingClientRect();
      const x = (e.clientX - rect.left) / this.zoomFactor;
      const y = (e.clientY - rect.top)  / this.zoomFactor;
      ghost.style.left   = `${Math.min(startX, x)}px`;
      ghost.style.top    = `${Math.min(startY, y)}px`;
      ghost.style.width  = `${Math.abs(x - startX)}px`;
      ghost.style.height = `${Math.abs(y - startY)}px`;
    }
  }

  private onSheetMouseUp(): void {
    if (this._panDrag) {
      this._panDrag = null;
      this.sheetEl.style.cursor = "grab";
      return;
    }
    if (this._detailDrag) {
      this.finishDetailDrag();
      return;
    }
    if (!this.dragging) return;
    const ghost = this.dragging.el!;
    const w = parseFloat(ghost.style.width)  || 0;
    const h = parseFloat(ghost.style.height) || 0;
    const x = parseFloat(ghost.style.left)   || 0;
    const y = parseFloat(ghost.style.top)    || 0;
    ghost.remove();
    this.dragging = null;
    if (w < 30 || h < 30) return; // tiny drags — let click handler add default-size panel
    this._dragCompleted = true; // suppress click-to-add for this pointer sequence
    this.addPanel({ x, y, w, h, viewport: "top", scale: "1:100" });
    this.activeTool = null;
    this.sheetEl.style.cursor = "";
    window.dispatchEvent(new CustomEvent("layout:tool-deactivated", { detail: { tool: "viewport" } }));
  }

  private applyZoom(factor: number): void {
    this.zoomFactor = Math.max(0.05, Math.min(5, this.zoomFactor * factor));
    this.sheetEl.style.zoom = String(this.zoomFactor);
    this.sheetEl.style.setProperty("--iz", String(1 / this.zoomFactor));
  }

  private onSheetClick(e: MouseEvent): void {
    if (this._dragCompleted) { this._dragCompleted = false; return; }
    if (this.activeTool === "zoom") {
      this.applyZoom(e.shiftKey ? 1 / 1.3 : 1.3);
      this.sheetEl.style.cursor = e.shiftKey ? "zoom-out" : "zoom-in";
      return;
    }
    if (this.activeTool !== "viewport") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && tgt.closest(".paper-cell, .paper-titleblock, .paper-toolbar")) return;
    const rect = this.sheetEl.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / this.zoomFactor;
    const cy = (e.clientY - rect.top)  / this.zoomFactor;
    // Default size: 200mm × 150mm, centred on click, clamped to sheet.
    const w = Math.round(200 * MM_TO_PX);
    const h = Math.round(150 * MM_TO_PX);
    this.addPanel({ x: Math.max(0, cx - w / 2), y: Math.max(0, cy - h / 2), w, h, viewport: "top", scale: "1:100" });
    this.activeTool = null;
    this.sheetEl.style.cursor = "";
    window.dispatchEvent(new CustomEvent("layout:tool-deactivated", { detail: { tool: "viewport" } }));
  }

  private finishDetailDrag(): void {
    if (!this._detailDrag) return;
    const { mode, parentId, parent, ghost } = this._detailDrag;
    const rX = parseFloat(ghost.style.left)   || 0;
    const rY = parseFloat(ghost.style.top)    || 0;
    const rW = parseFloat(ghost.style.width)  || 0;
    const rH = parseFloat(ghost.style.height) || 0;
    ghost.remove();
    this._detailDrag = null;

    if (rW < 20 || rH < 20) { this.deactivateTool(); return; }

    const labelIdx = this._detailLabelSeq++;
    const label = String.fromCharCode(65 + (labelIdx % 26));

    if (mode === "panel") {
      // Region drawn inside a parent panel → place detail panel adjacent to parent.
      const detailW = Math.max(rW * 2, 150);
      const detailH = Math.max(rH * 2, 100);
      this.addPanel({
        x: parent!.x + parent!.w + 20,
        y: parent!.y,
        w: detailW,
        h: detailH,
        viewport: parent!.viewport,
        scale: parent!.scale,
        title: `DETAIL ${label}`,
        border: "thick",
        detailOf: { parentPanelId: parentId!, regionX: rX, regionY: rY, regionW: rW, regionH: rH, label },
      });
    } else {
      // Rect drawn on blank sheet → the rect IS the detail panel.
      // Auto-link to the first non-detail panel if one exists.
      const firstParent = this.panels.find((p) => !p.detailOf);
      if (firstParent) {
        this.addPanel({
          x: rX, y: rY, w: rW, h: rH,
          viewport: firstParent.viewport,
          scale: firstParent.scale,
          title: `DETAIL ${label}`,
          border: "thick",
          detailOf: {
            parentPanelId: firstParent.id,
            regionX: 0, regionY: 0,
            regionW: firstParent.w, regionH: firstParent.h,
            label,
          },
        });
      } else {
        this.addPanel({ x: rX, y: rY, w: rW, h: rH, viewport: "top", scale: "1:100", title: `DETAIL ${label}`, border: "thick" });
      }
    }
    this.deactivateTool();
  }

  private deactivateTool(): void {
    this.activeTool = null;
    this.sheetEl.style.cursor = "";
    window.dispatchEvent(new CustomEvent("layout:tool-deactivated", { detail: { tool: "detail" } }));
  }

  private _thumbLastRender = 0;
  private _startThumbLoop(): void {
    if (this._thumbRAF) return;
    const THUMB_INTERVAL_MS = 100; // ~10 fps — complex IFC scenes are expensive to double-render
    const tick = (now: DOMHighResTimeStamp) => {
      if (this._thumbCanvases.size === 0) { this._thumbRAF = 0; return; }
      this._thumbRAF = requestAnimationFrame(tick);
      if (now - this._thumbLastRender < THUMB_INTERVAL_MS) return;
      this._thumbLastRender = now;
      const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
      if (viewer) {
        for (const { canvas, viewName, anchorX, anchorY, snapW, snapH, displayMode } of this._thumbCanvases.values()) {
          viewer.renderThumbnailTo(viewName, canvas, anchorX, anchorY, snapW, snapH, displayMode);
        }
      }
    };
    this._thumbRAF = requestAnimationFrame(tick);
  }

  pauseThumbLoop(): void {
    if (this._thumbRAF) {
      cancelAnimationFrame(this._thumbRAF);
      this._thumbRAF = 0;
    }
  }

  resumeThumbLoop(): void {
    if (this._thumbCanvases.size > 0) this._startThumbLoop();
  }

  // --- Panel CRUD ----

  private _enterNavigate(p: PanelState, canvas: HTMLCanvasElement): void {
    this._exitNavigate();
    const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
    if (!viewer) return;
    const viewName = layoutViewportToViewName(p.viewport);
    const controls = viewer.createNavControls(viewName, canvas);
    this._navPanelId = p.id;
    this._navDispose = () => controls.dispose();
    // Mark panel visually.
    const el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${p.id}"]`);
    el?.classList.add("is-navigating");
    // Exit when the user clicks outside the canvas.
    const onDocClick = (e: MouseEvent) => {
      if (!canvas.contains(e.target as Node)) {
        this._exitNavigate();
      }
    };
    this._navDocListener = onDocClick;
    // Use capture so we see the click before other handlers consume it.
    document.addEventListener("mousedown", onDocClick, true);
  }

  private _exitNavigate(): void {
    if (this._navDispose) { this._navDispose(); this._navDispose = null; }
    if (this._navDocListener) {
      document.removeEventListener("mousedown", this._navDocListener, true);
      this._navDocListener = null;
    }
    if (this._navPanelId) {
      const el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${this._navPanelId}"]`);
      el?.classList.remove("is-navigating");
      this._navPanelId = null;
    }
  }

  addPanel(init: PanelInit): PanelState {
    const isDetail = !!init.detailOf;
    const p: PanelState = {
      id:          newPanelId(),
      x:           init.x,
      y:           init.y,
      w:           init.w,
      h:           init.h,
      viewport:    init.viewport,
      scale:       init.scale ?? "1:100",
      title:       init.title ?? (isDetail ? `DETAIL ${init.detailOf!.label}` : VIEWPORT_LABELS[init.viewport]),
      border:      init.border ?? (isDetail ? "thick" : "thin"),
      displayMode: init.displayMode ?? "technical",
      ...(isDetail ? { detailOf: init.detailOf } : {}),
    };
    this.panels.push(p);
    this.renderPanel(p);
    this.renderDetailOverlays();
    return p;
  }

  removePanel(id: string): void {
    const idx = this.panels.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.panels.splice(idx, 1);
    this._thumbCanvases.delete(id);
    const el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
    if (el) el.remove();
    if (this.selectedPanelId === id) this.selectedPanelId = null;
    // Remove detail panels whose parent was just deleted.
    const deps = this.panels.filter((p) => p.detailOf?.parentPanelId === id).map((p) => p.id);
    for (const depId of deps) this.removePanel(depId);
    this.renderDetailOverlays();
  }

  private renderDetailOverlays(): void {
    this.sheetEl.querySelectorAll(".paper-cell-detail-region").forEach((el) => el.remove());
    for (const p of this.panels) {
      if (!p.detailOf) continue;
      const d = p.detailOf;
      const parentEl = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${d.parentPanelId}"]`);
      if (!parentEl) continue;
      const overlay = document.createElement("div");
      overlay.className = "paper-cell-detail-region";
      overlay.style.left   = `${d.regionX}px`;
      overlay.style.top    = `${d.regionY}px`;
      overlay.style.width  = `${d.regionW}px`;
      overlay.style.height = `${d.regionH}px`;
      const bubble = document.createElement("span");
      bubble.className = "paper-cell-detail-label";
      bubble.textContent = d.label;
      overlay.appendChild(bubble);
      parentEl.appendChild(overlay);
    }
  }

  private renderPanel(p: PanelState): void {
    let el = this.sheetEl.querySelector<HTMLElement>(`[data-panel-id="${p.id}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "paper-cell";
      el.dataset.panelId = p.id;
      this.sheetEl.appendChild(el);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectPanel(p.id);
      });
      let _hdrTimer: ReturnType<typeof setTimeout> | null = null;
      el.addEventListener("mouseenter", () => {
        if (_hdrTimer) { clearTimeout(_hdrTimer); _hdrTimer = null; }
        el!.querySelector<HTMLElement>(".paper-cell-header")?.classList.add("hdr-visible");
      });
      el.addEventListener("mouseleave", () => {
        if (_hdrTimer) clearTimeout(_hdrTimer);
        _hdrTimer = setTimeout(() => {
          el!.querySelector<HTMLElement>(".paper-cell-header")?.classList.remove("hdr-visible");
          _hdrTimer = null;
        }, 3500);
      });
    }
    if (p.detailOf) el.classList.add("detail-panel"); else el.classList.remove("detail-panel");
    el.style.position = "absolute";
    el.style.left = `${p.x}px`;
    el.style.top  = `${p.y}px`;
    el.style.width  = `${p.w}px`;
    el.style.height = `${p.h}px`;
    if (p.border === "none")  el.style.border = "none";
    if (p.border === "thick") el.style.borderWidth = "2px";

    el.innerHTML = "";

    // Header overlay — shows on hover, collapses on click away.
    const header = document.createElement("div");
    header.className = "paper-cell-header";
    header.addEventListener("mousedown", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === "SELECT" || tgt.tagName === "BUTTON") return;
      e.stopPropagation();
      e.preventDefault();
      this.selectPanel(p.id);
      const startMX = e.clientX, startMY = e.clientY;
      const startPX = p.x, startPY = p.y;
      document.body.style.cursor = "grabbing";
      const onMove = (ev: MouseEvent) => {
        p.x = startPX + (ev.clientX - startMX) / this.zoomFactor;
        p.y = startPY + (ev.clientY - startMY) / this.zoomFactor;
        el.style.left = `${p.x}px`;
        el.style.top  = `${p.y}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    const label = document.createElement("span");
    label.className = "paper-cell-label";
    label.textContent = p.title;
    header.appendChild(label);

    const vSel = document.createElement("select");
    vSel.className = "paper-cell-select";
    vSel.setAttribute("aria-label", "Viewport");
    for (const v of Object.keys(VIEWPORT_LABELS) as ViewportId[]) {
      const opt = document.createElement("option");
      opt.value = v; opt.textContent = VIEWPORT_LABELS[v];
      if (v === p.viewport) opt.selected = true;
      vSel.appendChild(opt);
    }
    vSel.addEventListener("change", () => {
      p.viewport = vSel.value as ViewportId;
      p.title = VIEWPORT_LABELS[p.viewport];
      this.renderPanel(p);
    });

    const sSel = document.createElement("select");
    sSel.className = "paper-cell-select";
    sSel.setAttribute("aria-label", "Scale");
    const presets = activeScalePresets();
    const isCustomScale = !presets.includes(p.scale);
    for (const s of presets) {
      const opt = document.createElement("option");
      opt.value = s; opt.textContent = s;
      if (s === p.scale || (s === "Custom" && isCustomScale)) opt.selected = true;
      sSel.appendChild(opt);
    }

    const sCustomInput = document.createElement("input");
    sCustomInput.type = "text";
    sCustomInput.className = "paper-cell-scale-input";
    sCustomInput.setAttribute("aria-label", "Custom scale");
    sCustomInput.placeholder = "1:150";
    sCustomInput.value = isCustomScale ? p.scale : "";
    sCustomInput.style.display = isCustomScale ? "" : "none";

    const applyCustomScale = () => {
      const raw = sCustomInput.value.trim();
      if (/^1:\d+(\.\d+)?$/.test(raw)) {
        p.scale = raw;
        this.renderPanel(p);
      } else {
        sCustomInput.value = p.scale;
      }
    };
    sCustomInput.addEventListener("blur", applyCustomScale);
    sCustomInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); applyCustomScale(); }
    });

    sSel.addEventListener("change", () => {
      if (sSel.value === "Custom") {
        sCustomInput.style.display = "";
        sCustomInput.focus();
        sCustomInput.select();
      } else {
        sCustomInput.style.display = "none";
        p.scale = sSel.value;
        this.renderPanel(p);
      }
    });

    const dmSel = document.createElement("select");
    dmSel.className = "paper-cell-select";
    dmSel.setAttribute("aria-label", "Display mode");
    for (const dm of DISPLAY_MODES) {
      const opt = document.createElement("option");
      opt.value = dm;
      opt.textContent = dm.charAt(0).toUpperCase() + dm.slice(1);
      if (dm === p.displayMode) opt.selected = true;
      dmSel.appendChild(opt);
    }
    dmSel.addEventListener("change", () => {
      p.displayMode = dmSel.value as DisplayMode;
      const entry = this._thumbCanvases.get(p.id);
      if (entry) entry.displayMode = p.displayMode;
    });

    header.appendChild(vSel);
    header.appendChild(sSel);
    header.appendChild(sCustomInput);
    header.appendChild(dmSel);
    el.appendChild(header);

    // Render the viewport content — live WebGL thumbnail for all panels.
    const renderWrap = document.createElement("div");
    renderWrap.className = "paper-cell-render";
    renderWrap.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      this._enterNavigate(p, thumbCanvas);
    });
    const viewName = layoutViewportToViewName(p.viewport);
    const thumbCanvas = document.createElement("canvas");
    thumbCanvas.width = Math.max(1, Math.round(p.w));
    thumbCanvas.height = Math.max(1, Math.round(p.h));
    thumbCanvas.style.cssText = "width:100%;height:100%;display:block;";
    renderWrap.appendChild(thumbCanvas);
    this._thumbCanvases.set(p.id, { canvas: thumbCanvas, viewName, anchorX: 0, anchorY: 0, snapW: 0, snapH: 0, displayMode: p.displayMode });
    this._startThumbLoop();
    el.appendChild(renderWrap);

    // Scale bar overlay.
    const sb = document.createElement("div");
    sb.className = "paper-cell-scalebar";
    sb.innerHTML = renderScaleBar(p);
    el.appendChild(sb);

    // Close button.
    const close = document.createElement("button");
    close.type = "button";
    close.className = "paper-cell-close";
    close.innerHTML = iconSVG("x", 12);
    close.title = "Remove panel";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removePanel(p.id);
    });
    el.appendChild(close);

    // Resize handles — 8 directions.
    for (const dir of ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const) {
      const handle = document.createElement("div");
      handle.className = "panel-resize-handle";
      handle.dataset.dir = dir;
      handle.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.selectPanel(p.id);
        const startMX = e.clientX, startMY = e.clientY;
        const ox = p.x, oy = p.y, ow = p.w, oh = p.h;
        // Snapshot the canvas dimensions at drag start — used by renderThumbnailTo
        // to compute the window crop during the drag.
        const entry0 = this._thumbCanvases.get(p.id);
        if (entry0) {
          entry0.snapW = entry0.canvas.width;
          entry0.snapH = entry0.canvas.height;
          entry0.anchorX = dir.includes("w") ? 1 : 0;
          entry0.anchorY = dir.includes("n") ? 1 : 0;
        }
        const onMove = (ev: MouseEvent) => {
          const dx = (ev.clientX - startMX) / this.zoomFactor;
          const dy = (ev.clientY - startMY) / this.zoomFactor;
          if (dir.includes("e")) p.w = Math.max(80, ow + dx);
          if (dir.includes("s")) p.h = Math.max(60, oh + dy);
          if (dir.includes("w")) { p.x = ox + dx; p.w = Math.max(80, ow - dx); }
          if (dir.includes("n")) { p.y = oy + dy; p.h = Math.max(60, oh - dy); }
          el.style.left   = `${p.x}px`;
          el.style.top    = `${p.y}px`;
          el.style.width  = `${p.w}px`;
          el.style.height = `${p.h}px`;
          // Keep canvas pixel dimensions in sync so the rAF loop renders at
          // the live size rather than CSS-stretching the old resolution.
          const entry = this._thumbCanvases.get(p.id);
          if (entry) {
            const nw = Math.max(1, Math.round(p.w));
            const nh = Math.max(1, Math.round(p.h));
            if (entry.canvas.width !== nw) entry.canvas.width = nw;
            if (entry.canvas.height !== nh) entry.canvas.height = nh;
          }
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          // Clear the drag snapshot — rendering reverts to plain aspect adaptation.
          const entry = this._thumbCanvases.get(p.id);
          if (entry) { entry.snapW = 0; entry.snapH = 0; }
          this.renderPanel(p);
          this.selectPanel(p.id);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
      el.appendChild(handle);
    }
  }

  private selectPanel(id: string): void {
    this.selectedPanelId = id;
    this.sheetEl.querySelectorAll<HTMLElement>(".paper-cell").forEach((c) => {
      c.classList.toggle("selected", c.dataset.panelId === id);
    });
  }

  // --- Title block ---

  private renderTitleBlock(): void {
    const t = this.titleblockEl;
    t.innerHTML = "";
    const cells: Array<[string, keyof TitleBlock, boolean]> = [
      ["PROJECT", "project", true],
      ["Sheet",   "sheet",   false],
      ["Scale",   "scale",   false],
      ["Drawn",   "drawnBy", false],
      ["Date",    "date",    false],
    ];
    for (const [label, key, brand] of cells) {
      const cell = document.createElement("div");
      cell.className = `tb-cell${brand ? " brand" : ""}`;
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = label;
      cell.appendChild(k);
      const v = document.createElement("span");
      v.className = "v";
      v.contentEditable = "true";
      v.spellcheck = false;
      v.textContent = this.title[key];
      v.dataset.titleKey = key;
      v.addEventListener("input", () => {
        this.title[key] = v.textContent ?? "";
      });
      cell.appendChild(v);
      t.appendChild(cell);
    }
  }
}

const _controllers = new WeakMap<HTMLElement, LayoutController>();

/** Maps sheetData.id → ClippingPlaneEntity.id for auto-linked sheets (#1849). */
const _sheetClipLinks = new Map<string, string>();


/** Return the clipping-plane entity ID linked to a sheet, if any. */
export function getClipPlaneIdForSheet(sheetId: string): string | undefined {
  return _sheetClipLinks.get(sheetId);
}

/**
 * Return the levelId linked to a plan sheet (#1846), or undefined if not a plan sheet.
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function getLinkedLevelIdForSheet(host: HTMLElement, sheetId: string): string | undefined {
  return _controllers.get(host)?.getLinkedLevelId(sheetId);
}

/**
 * Mark a plan sheet as user-renamed — disables auto-rename on future level renames (#1846).
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function markPlanSheetUserRenamed(host: HTMLElement, sheetId: string): void {
  _controllers.get(host)?.markUserRenamed(sheetId);
}

/**
 * Return the levelId linked to an RCP sheet (#1844), or undefined if not an RCP sheet.
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function getRcpLinkedLevelIdForSheet(host: HTMLElement, sheetId: string): string | undefined {
  return _controllers.get(host)?.getRcpLinkedLevelId(sheetId);
}

/**
 * Mark an RCP sheet as user-renamed — disables auto-rename on future level renames (#1844).
 * @param host    The paper-mode host element.
 * @param sheetId The sheet's id.
 */
export function markRcpSheetUserRenamed(host: HTMLElement, sheetId: string): void {
  _controllers.get(host)?.markRcpUserRenamed(sheetId);
}

/**
 * Auto-create a linked section sheet in the Layout tab for a new clipping plane (#1849).
 * Called by the SdClippingPlane handler when autoSheet is true.
 * @param host      The paper-mode host element (from getLayoutHost()).
 * @param clipPlaneId  The ClippingPlaneEntity id from clippingPlaneStore.
 * @param name      Sheet tab label (e.g. "Section — Clip A").
 * @returns The new sheetData.id, or "" if no LayoutController is mounted.
 */
export function addLinkedClipPlaneSheet(host: HTMLElement, clipPlaneId: string, name: string): string {
  const c = _controllers.get(host);
  if (!c) return "";
  // Pass clipPlaneId so the link is stored BEFORE switchSheet fires (Unlink button visibility).
  return c.addLinkedSheet(name, clipPlaneId);
}

/**
 * Detach a linked sheet from its clipping-plane entity (#1849 §5.4).
 * Copies the entity's current bounds into static SheetTemplate fields and removes the link.
 * The ClippingPlaneEntity remains in the scene and store.
 * @returns The frozen config (origin/normal/farClip) or null if the sheet wasn't linked.
 */
export function unlinkClipPlaneSheet(
  host: HTMLElement,
  sheetId: string,
): { origin: [number, number, number]; normal: [number, number, number]; farClip: number } | null {
  const clipPlaneId = _sheetClipLinks.get(sheetId);
  if (!clipPlaneId) return null;
  const entity = clippingPlaneStore.get(clipPlaneId);
  _sheetClipLinks.delete(sheetId);
  if (!entity) return null;
  const frozen = { origin: entity.origin, normal: entity.normal, farClip: entity.bounds.farClip };
  // Update controller's unlink button if this is the active sheet.
  const c = _controllers.get(host);
  if (c && c.activeSheet.id === sheetId && c["_unlinkBtn"]) {
    (c["_unlinkBtn"] as HTMLElement).style.display = "none";
  }
  document.dispatchEvent(new CustomEvent("layout:sheet-unlinked", { detail: { sheetId, ...frozen } }));
  return frozen;
}

// --- Public exports ---

export function buildLayoutMode(host: HTMLElement, opts: LayoutOptions = {}): LayoutController {
  const c = new LayoutController(host, opts);
  _controllers.set(host, c);
  return c;
}

export function addPanel(host: HTMLElement, init: PanelInit): PanelState {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController; call buildLayoutMode first");
  return c.addPanel(init);
}

export function getPanels(host: HTMLElement): PanelState[] {
  const c = _controllers.get(host);
  return c ? c.panels.slice() : [];
}

export function getController(host: HTMLElement): LayoutController | undefined {
  return _controllers.get(host);
}

// --- Viewport ID → Viewer ViewName mapping --------------------------------

function layoutViewportToViewName(v: ViewportId): "top" | "persp" | "front" | "right" {
  switch (v) {
    case "front": case "back": return "front";
    case "right": case "left": return "right";
    case "perspective": case "axonometric": return "persp";
    default: return "top";
  }
}

// --- Viewport SVG rendering (real projection + AABB fallback) -------------

interface PlanProj { sx: (a: number, b: number, c: number) => number; sy: (a: number, b: number, c: number) => number; au: number; av: number; }

function renderViewportSvg(p: PanelState, b: SceneBounds, viewer?: Viewer): string {
  const w = p.w, h = p.h;
  if (w < 4 || h < 4) return "";

  // Real 3D edge projection (#1211 + #1803 + #1804): fills first, classified edges on top.
  if (viewer) {
    const viewName = layoutViewportToViewName(p.viewport);
    // Use classified edges (#1804) when available; fall back to unclassified (#1211).
    const classifiedSegs: ClassifiedEdgeSeg[] = viewer.getClassifiedEdgeSegmentsForView
      ? viewer.getClassifiedEdgeSegmentsForView(viewName, w, h)
      : [];
    const segs = classifiedSegs.length > 0
      ? []
      : viewer.getEdgeSegmentsForView(viewName, w, h);
    const polys: ExportFacePoly[] = viewer.getFacePolygonsForView
      ? viewer.getFacePolygonsForView(viewName, w, h)
      : [];

    if (classifiedSegs.length > 0 || segs.length > 0 || polys.length > 0) {
      const fillMarkup = polys.map(({ pts, fill }) => {
        const [a, b2, c] = pts;
        return `<polygon points="${a[0].toFixed(2)},${a[1].toFixed(2)} ${b2[0].toFixed(2)},${b2[1].toFixed(2)} ${c[0].toFixed(2)},${c[1].toFixed(2)}" fill="${fill}" stroke="none"/>`;
      }).join("\n      ");

      let edgeMarkup: string;
      if (classifiedSegs.length > 0) {
        // Classified edges: render each class with its lineweight + dash pattern.
        edgeMarkup = classifiedSegs.map(({ x1, y1, x2, y2, cls }) => {
          const dash = DASH_PATTERN[cls];
          const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
          return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${LINEWEIGHT[cls]}"${dashAttr}/>`;
        }).join("\n      ");
      } else {
        edgeMarkup = segs.map(([x1, y1, x2, y2]) =>
          `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`,
        ).join("\n      ");
      }

      return `<svg viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" preserveAspectRatio="xMidYMid meet">
      <rect x="0" y="0" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#ffffff"/>
      <g>${fillMarkup}</g>
      <g fill="none" stroke="#1a1a22" stroke-linecap="round" stroke-linejoin="round">
      ${edgeMarkup}
      </g>
    </svg>`;
    }
    // No geometry yet — fall through to AABB placeholder.
  }

  const dx = b.max[0] - b.min[0] || 1;
  const dy = b.max[1] - b.min[1] || 1;
  const dz = b.max[2] - b.min[2] || 1;

  // Project corners of the AABB based on viewport orientation.
  // For ortho views we drop one axis; for axonometric/perspective we use a
  // simple isometric projection (cabinet-style) with no actual perspective
  // (the placeholder honors orientation, not optical exactness).
  let proj: PlanProj;
  switch (p.viewport) {
    case "top":         proj = { sx: (x, _y, _z) => x, sy: (_x, y, _z) => -y, au: dx, av: dy }; break;
    case "bottom":      proj = { sx: (x, _y, _z) => x, sy: (_x, y, _z) =>  y, au: dx, av: dy }; break;
    case "front":       proj = { sx: (x, _y, _z) => x, sy: (_x, _y, z) => -z, au: dx, av: dz }; break;
    case "back":        proj = { sx: (x, _y, _z) => -x, sy: (_x, _y, z) => -z, au: dx, av: dz }; break;
    case "left":        proj = { sx: (_x, y, _z) => -y, sy: (_x, _y, z) => -z, au: dy, av: dz }; break;
    case "right":       proj = { sx: (_x, y, _z) =>  y, sy: (_x, _y, z) => -z, au: dy, av: dz }; break;
    case "axonometric":
    case "perspective": {
      // 30° iso-ish: x-axis at +30°, y-axis at +150°, z up.
      const c30 = Math.cos(Math.PI / 6), s30 = Math.sin(Math.PI / 6);
      proj = {
        sx: (x, y, _z) =>  x * c30 - y * c30,
        sy: (x, y,  z) => -z + (x * s30 + y * s30),
        au: (dx + dy) * c30,
        av: (dx + dy) * s30 + dz,
      };
      break;
    }
  }

  // Project all 8 corners.
  const corners: Array<[number, number, number]> = [
    [b.min[0], b.min[1], b.min[2]],
    [b.max[0], b.min[1], b.min[2]],
    [b.max[0], b.max[1], b.min[2]],
    [b.min[0], b.max[1], b.min[2]],
    [b.min[0], b.min[1], b.max[2]],
    [b.max[0], b.min[1], b.max[2]],
    [b.max[0], b.max[1], b.max[2]],
    [b.min[0], b.max[1], b.max[2]],
  ];
  const projected = corners.map((c) => [proj.sx(c[0], c[1], c[2]), proj.sy(c[0], c[1], c[2])] as [number, number]);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of projected) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const PAD = 8;
  const aw = maxX - minX || 1;
  const ah = maxY - minY || 1;
  const k = Math.min((w - 2 * PAD) / aw, (h - 2 * PAD) / ah);
  const ox = (w - aw * k) / 2 - minX * k;
  const oy = (h - ah * k) / 2 - minY * k;
  const xy = projected.map(([x, y]) => [x * k + ox, y * k + oy] as [number, number]);

  const isOrtho = p.viewport !== "axonometric" && p.viewport !== "perspective";

  if (isOrtho) {
    // Draw the 2D rectangle (front face of the AABB in the picked plane).
    // Diagonal dashes only shown for the stub/empty-scene placeholder so
    // the user can tell no real geometry is loaded yet. When a real scene
    // is present the rectangle alone shows the meaningful projection.
    const pts = [xy[0], xy[1], xy[2], xy[3]];
    const path = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} ` +
                 `L ${pts[1][0].toFixed(2)} ${pts[1][1].toFixed(2)} ` +
                 `L ${pts[2][0].toFixed(2)} ${pts[2][1].toFixed(2)} ` +
                 `L ${pts[3][0].toFixed(2)} ${pts[3][1].toFixed(2)} Z`;
    const isStub = isStubBounds(b);
    const diagonals = isStub
      ? `<line x1="${pts[0][0].toFixed(2)}" y1="${pts[0][1].toFixed(2)}" x2="${pts[2][0].toFixed(2)}" y2="${pts[2][1].toFixed(2)}" stroke-width="0.4" stroke-dasharray="2 2"/>
        <line x1="${pts[1][0].toFixed(2)}" y1="${pts[1][1].toFixed(2)}" x2="${pts[3][0].toFixed(2)}" y2="${pts[3][1].toFixed(2)}" stroke-width="0.4" stroke-dasharray="2 2"/>`
      : "";
    const vb1 = `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`;
    return `<svg viewBox="${vb1}" preserveAspectRatio="xMidYMid meet">
      <g fill="none" stroke="#1a1a22" stroke-width="1">
        <path d="${path}" stroke-width="1.4"/>
        ${diagonals}
      </g>
    </svg>`;
  }

  // Axonometric: outline the AABB with hidden-line dashes on the back edges.
  const E: Array<[number, number]> = [
    // bottom
    [0, 1], [1, 2], [2, 3], [3, 0],
    // top
    [4, 5], [5, 6], [6, 7], [7, 4],
    // verticals
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const lines = E.map(([a, c], i) => {
    const x1 = xy[a][0].toFixed(2);
    const y1 = xy[a][1].toFixed(2);
    const x2 = xy[c][0].toFixed(2);
    const y2 = xy[c][1].toFixed(2);
    // last 2 bottom edges (back) get dashed for hidden-line read.
    const dashed = i === 1 || i === 2 || i === 10 || i === 11;
    const sw = dashed ? 0.5 : 1.2;
    const da = dashed ? ` stroke-dasharray="3 2"` : "";
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="${sw}"${da}/>`;
  }).join("\n      ");
  const vb2 = `0 0 ${w.toFixed(2)} ${h.toFixed(2)}`;
  return `<svg viewBox="${vb2}" preserveAspectRatio="xMidYMid meet">
    <g fill="none" stroke="#1a1a22">
      ${lines}
    </g>
  </svg>`;
}

// --- Scale bar ------------------------------------------------------------

function renderScaleBar(p: PanelState): string {
  // The scale bar represents PAPER → DRAWING units. With scale 1:100 a 50 mm
  // bar on paper = 5000 mm = 5 m drawing-side. We draw a 50 px (~13.2 mm) bar
  // and label it accordingly.
  const ratio = parseScale(p.scale);
  const barPx = 50;
  const barMm = barPx / MM_TO_PX;
  const drawingMm = barMm * ratio;
  let label: string;
  if (p.scale === "NTS") label = "NTS";
  else label = formatLength(drawingMm / 1000);
  const half = barPx / 2;
  return `<svg viewBox="0 0 ${barPx + 14} 14" width="${barPx + 14}" height="14" aria-label="scale bar">
    <g stroke="#1a1a22" fill="#1a1a22" font-family="monospace" font-size="7">
      <rect x="2" y="6" width="${half}" height="3" fill="#1a1a22"/>
      <rect x="${2 + half}" y="6" width="${half}" height="3" fill="none" stroke-width="0.5"/>
      <line x1="2" y1="6" x2="2" y2="11" stroke-width="0.6"/>
      <line x1="${2 + half}" y1="6" x2="${2 + half}" y2="11" stroke-width="0.6"/>
      <line x1="${2 + barPx}" y1="6" x2="${2 + barPx}" y2="11" stroke-width="0.6"/>
      <text x="${2 + barPx + 2}" y="10">${label}</text>
    </g>
  </svg>`;
}

// --- Export ---------------------------------------------------------------

export function exportLayoutAsSvg(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  return composeSvg(c);
}

function composeSvg(c: LayoutController): string {
  const mm = sheetMm(c.size, c.orientation, c.customMm);
  // Use mm as native unit so downstream PDF/AI/DWG paths convert cleanly.
  // Render width="<W>mm" so SVG viewers honor real-world dimensions.
  const px = sheetPx(mm);
  const w = px.w, h = px.h;
  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;

  const panelMarkup = c.panels.map((p) => {
    const inner = renderViewportSvg(p, c.bounds(), viewer).replace(/^<svg [^>]*>|<\/svg>$/g, "");
    const sb = renderScaleBar(p).replace(/^<svg [^>]*>|<\/svg>$/g, "");
    const titleLabel = `<text x="6" y="10" font-size="7" font-family="monospace" fill="#1a1a22">${escapeXml(p.title)}</text>`;
    const scaleLabel = `<text x="${(p.w - 4).toFixed(2)}" y="10" font-size="7" font-family="monospace" fill="#5a5a66" text-anchor="end">${escapeXml(p.scale)}</text>`;
    const sbX = (p.w - 70).toFixed(2);
    const sbY = (p.h - 16).toFixed(2);
    return `<g transform="translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})">
      <rect x="0" y="0" width="${p.w.toFixed(2)}" height="${p.h.toFixed(2)}" fill="#ffffff" stroke="#1a1a22" stroke-width="${p.border === "thick" ? 1.5 : 0.6}"${p.border === "none" ? ` stroke-opacity="0"` : ""}/>
      <svg x="0" y="0" width="${p.w.toFixed(2)}" height="${p.h.toFixed(2)}" viewBox="0 0 ${p.w.toFixed(2)} ${p.h.toFixed(2)}">${inner}</svg>
      ${titleLabel}
      ${scaleLabel}
      <g transform="translate(${sbX} ${sbY})">${sb}</g>
    </g>`;
  }).join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}" width="${mm.w}mm" height="${mm.h}mm">
  <rect x="0" y="0" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="#fefefa" stroke="#1a1a22" stroke-width="1"/>
  <rect x="12" y="12" width="${(w - 24).toFixed(2)}" height="${(h - 24).toFixed(2)}" fill="none" stroke="#5a5a66" stroke-width="0.4"/>
  ${panelMarkup}
</svg>
`;
}


function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (ch) => {
    switch (ch) {
      case "<":  return "&lt;";
      case ">":  return "&gt;";
      case "&":  return "&amp;";
      case "\"": return "&quot;";
      default:   return "&apos;";
    }
  });
}

// --- Sheet template — #1805 -----------------------------------------------
//
// A SheetTemplate describes one drawing in a multi-sheet set: the view type,
// the cut configuration (plan level, section plane, or cardinal elevation),
// and the camera axis. applySheetCut() wires the viewer's clip-plane API
// so that when the PDF engine queries getClassifiedEdgeSegmentsForView() or
// getFacePolygonsForView(), it sees only the geometry that belongs to this
// sheet's view.

export type SheetViewType = "plan" | "rcp" | "section" | "elevation" | "3d";
export type CardinalDir = "N" | "S" | "E" | "W";

export interface SheetTemplate {
  /** Sheet identifier, e.g. "S1" … "S8". */
  id: string;
  viewType: SheetViewType;
  title: string;

  // Plan / RCP config (shared — both keyed by levelId)
  /** Level.id from the level store (required for viewType = "plan" or "rcp"). */
  levelId?: string;
  /** Meters above level.elevation for the plan cut plane (default 1.372 m = 4'6"). */
  cutOffset?: number;
  /** Meters above level.elevation for the RCP cut plane (default 2.44 m = 8'). */
  rcpCutOffset?: number;

  // Section / Elevation config
  origin?: [number, number, number];
  normal?: [number, number, number];
  /** How deep behind the cut plane to render (meters). */
  farClip?: number;

  // Elevation shorthand — auto-derives origin + normal from the model AABB.
  cardinalDir?: CardinalDir;

  // Camera axis for this sheet.
  camera: "top" | "front" | "right";

  /** ID of the linked ClippingPlaneEntity (#1849). Present when sheet was auto-created by SdClippingPlane. */
  clipPlaneId?: string;
}

/** Default elevation sheet set (#1850): N/E/S/W, one per cardinal direction. */
export const DEMO_SHEET_SET: SheetTemplate[] = [
  { id: "S1", viewType: "elevation", title: "Elevation: North", cardinalDir: "N", farClip: 40, camera: "front" },
  { id: "S2", viewType: "elevation", title: "Elevation: East",  cardinalDir: "E", farClip: 40, camera: "right" },
  { id: "S3", viewType: "elevation", title: "Elevation: South", cardinalDir: "S", farClip: 40, camera: "front" },
  { id: "S4", viewType: "elevation", title: "Elevation: West",  cardinalDir: "W", farClip: 40, camera: "right" },
];

/** Level stub used in applySheetCut when levelStore is not provided. */
export interface SheetLevelRef { elevation: number; height?: number; }

/**
 * Apply viewer clip planes for the given SheetTemplate.
 * Call this before querying getClassifiedEdgeSegmentsForView or
 * getFacePolygonsForView. Call resetSheetCut() afterwards.
 *
 * @param viewer   The active Viewer instance.
 * @param t        SheetTemplate to apply.
 * @param levels   Map/object of levelId → {elevation} (required for plan views).
 */
export function applySheetCut(
  viewer: Viewer,
  t: SheetTemplate,
  levels?: Record<string, SheetLevelRef>,
): void {
  viewer.clearClippingPlanes();
  viewer.clearSectionBox();

  const BIG = 1e6;

  if (t.viewType === "plan") {
    const lvl = levels?.[t.levelId ?? ""] ?? { elevation: 0 };
    const cut = (t.cutOffset ?? 1.372);
    viewer.setSectionBox(
      [-BIG, -BIG, lvl.elevation],
      [ BIG,  BIG, lvl.elevation + cut],
    );
  } else if (t.viewType === "rcp") {
    // Reflected ceiling plan (#1844): section box from rcpCutOffset up to level ceiling.
    // Shows ceiling-mounted elements (light fixtures, joists, ducts) when viewed from top.
    // Cut at 8' (2.44 m) from floor by default; upper bound is level.height (floor-to-ceiling).
    const lvl = levels?.[t.levelId ?? ""] ?? { elevation: 0, height: 3.0 };
    const rcpCut = t.rcpCutOffset ?? 2.44;
    const levelHeight = lvl.height ?? 3.0;
    viewer.setSectionBox(
      [-BIG, -BIG, lvl.elevation + rcpCut],
      [ BIG,  BIG, lvl.elevation + levelHeight],
    );
  } else if (t.viewType === "section") {
    // §5.3: when linked to a clip-plane entity, read live origin/normal/farClip from store.
    let origin: [number, number, number] = t.origin ?? [0, 0, 0];
    let normal: [number, number, number] = t.normal ?? [0, -1, 0];
    let farClip = t.farClip;
    if (t.clipPlaneId) {
      const entity = clippingPlaneStore.get(t.clipPlaneId);
      if (entity) {
        origin = entity.origin;
        normal = entity.normal;
        farClip = entity.bounds.farClip;
      }
    }
    viewer.addClippingPlane(origin, normal, "sheet-front");
    if (farClip != null) {
      const back: [number, number, number] = [
        origin[0] + normal[0] * farClip,
        origin[1] + normal[1] * farClip,
        origin[2] + normal[2] * farClip,
      ];
      viewer.addClippingPlane(back, [-normal[0], -normal[1], -normal[2]], "sheet-back");
    }
  } else if (t.viewType === "elevation") {
    let origin: [number, number, number];
    let normal: [number, number, number];
    if (t.cardinalDir) {
      const bounds = viewer.getSceneBounds?.();
      const cx = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
      const cy = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
      const cz = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;
      const margin = 0.1;
      switch (t.cardinalDir) {
        case "N": origin = [cx, bounds ? bounds.max.y + margin : BIG, cz]; normal = [0, -1, 0]; break;
        case "S": origin = [cx, bounds ? bounds.min.y - margin : -BIG, cz]; normal = [0,  1, 0]; break;
        case "E": origin = [bounds ? bounds.max.x + margin : BIG, cy, cz]; normal = [-1, 0, 0]; break;
        case "W": origin = [bounds ? bounds.min.x - margin : -BIG, cy, cz]; normal = [ 1, 0, 0]; break;
      }
    } else {
      origin = t.origin ?? [0, 0, 0];
      normal = t.normal ?? [0, -1, 0];
    }
    viewer.addClippingPlane(origin!, normal!, "sheet-front");
    if (t.farClip != null) {
      const n = normal!;
      const back: [number, number, number] = [
        origin![0] + n[0] * t.farClip,
        origin![1] + n[1] * t.farClip,
        origin![2] + n[2] * t.farClip,
      ];
      viewer.addClippingPlane(back, [-n[0], -n[1], -n[2]], "sheet-back");
    }
  }
  // viewType "3d": no cut — full scene.
}

/** Remove all sheet cuts and restore unclipped view. */
export function resetSheetCut(viewer: Viewer): void {
  viewer.clearClippingPlanes();
  viewer.clearSectionBox();
}

/**
 * Export a list of SheetTemplates as a multi-page PDF.
 * Each template becomes one page; the viewer clip planes are applied and
 * reset for each sheet. Sheet size defaults to A1 landscape.
 */
export async function exportSheetSetAsPdf(
  templates: SheetTemplate[],
  opts: {
    sheetSize?: SheetSizeId;
    orientation?: Orientation;
    levels?: Record<string, SheetLevelRef>;
    panelMarginMm?: number;
  } = {},
): Promise<ArrayBuffer> {
  const {
    sheetSize = "A1",
    orientation = "landscape",
    levels = {},
    panelMarginMm = 10,
  } = opts;

  const mm = sheetMm(sheetSize, orientation, DEFAULT_CUSTOM);
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    orientation: mm.w > mm.h ? "landscape" : "portrait",
    unit: "mm",
    format: [mm.w, mm.h],
  });

  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
  const PX_TO_MM = 25.4 / 96;
  // Panel spans the full sheet minus margins.
  const panelWmm = mm.w - panelMarginMm * 2;
  const panelHmm = mm.h - panelMarginMm * 2;
  const panelWpx = Math.round(panelWmm / PX_TO_MM);
  const panelHpx = Math.round(panelHmm / PX_TO_MM);

  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (i > 0) doc.addPage([mm.w, mm.h], mm.w > mm.h ? "landscape" : "portrait");

    // Sheet border.
    doc.setLineWidth(0.4);
    doc.setDrawColor(60, 60, 70);
    doc.rect(3, 3, mm.w - 6, mm.h - 6);

    // Sheet title.
    doc.setFontSize(9);
    doc.setTextColor(26, 26, 34);
    doc.text(`${t.id}  ${t.title}`, panelMarginMm, mm.h - panelMarginMm / 2);

    // Apply view-specific cut.
    if (viewer) {
      applySheetCut(viewer, t, levels);
    }

    const px = panelMarginMm;
    const py = panelMarginMm;

    // Render fills then classified edges (same logic as exportLayoutAsPdf).
    if (viewer?.getFacePolygonsForView) {
      const polys = viewer.getFacePolygonsForView(t.camera, panelWpx, panelHpx);
      for (const { pts, fill } of polys) {
        const [r, g, b2] = hexToRgb(fill);
        doc.setFillColor(r, g, b2);
        doc.triangle(
          px + pts[0][0] * PX_TO_MM, py + pts[0][1] * PX_TO_MM,
          px + pts[1][0] * PX_TO_MM, py + pts[1][1] * PX_TO_MM,
          px + pts[2][0] * PX_TO_MM, py + pts[2][1] * PX_TO_MM,
          "F",
        );
      }
    }
    doc.setDrawColor(26, 26, 34);
    if (viewer?.getClassifiedEdgeSegmentsForView) {
      const clSegs = viewer.getClassifiedEdgeSegmentsForView(t.camera, panelWpx, panelHpx);
      for (const { x1, y1, x2, y2, cls } of clSegs) {
        doc.setLineWidth(LINEWEIGHT[cls] * PX_TO_MM);
        const dash = DASH_PATTERN[cls];
        if (dash) {
          const [d, g] = dash.split(" ").map((v) => parseFloat(v) * PX_TO_MM);
          doc.setLineDashPattern([d, g], 0);
        } else {
          doc.setLineDashPattern([], 0);
        }
        doc.line(px + x1 * PX_TO_MM, py + y1 * PX_TO_MM, px + x2 * PX_TO_MM, py + y2 * PX_TO_MM);
      }
      doc.setLineDashPattern([], 0);
      doc.setLineWidth(0.25);
    }

    // Reset cut for next sheet.
    if (viewer) resetSheetCut(viewer);
  }

  return doc.output("arraybuffer") as ArrayBuffer;
}

// PDF export — uses jsPDF (dynamic import to avoid pulling it into the main
// bundle until the user actually exports). We project panel SVG primitives
// to PDF coordinates (mm-native: jsPDF uses bottom-up Y by default in pt,
// but unit:"mm" + format keeps positions intuitive). Output dimensions
// match the sheet exactly.
const MM_TO_PT = 72 / 25.4;

export async function exportLayoutAsPdf(host: HTMLElement): Promise<ArrayBuffer> {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  const mm = sheetMm(c.size, c.orientation, c.customMm);

  // jsPDF: unit "mm", custom format [W, H], orientation auto from format.
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({
    orientation: mm.w > mm.h ? "landscape" : "portrait",
    unit: "mm",
    format: [mm.w, mm.h],
  });

  // px → mm conversion (sheet is laid out in px at 96dpi).
  const PX_TO_MM = 25.4 / 96;
  const sheetWmm = mm.w;
  const sheetHmm = mm.h;

  // Sheet outline + inner border (already part of the page).
  doc.setLineWidth(0.4);
  doc.setDrawColor(60, 60, 70);
  doc.rect(3, 3, sheetWmm - 6, sheetHmm - 6);

  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;
  // Panels.
  for (const p of c.panels) {
    const px = p.x * PX_TO_MM;
    const py = p.y * PX_TO_MM;
    const pw = p.w * PX_TO_MM;
    const ph = p.h * PX_TO_MM;
    doc.setLineWidth(p.border === "thick" ? 0.6 : 0.25);
    doc.setDrawColor(26, 26, 34);
    if (p.border !== "none") doc.rect(px, py, pw, ph);
    // Project geometry: fills first (behind edges), then edge lines on top.
    // Fills: use direct getFacePolygonsForView when viewer is available (#1803).
    if (viewer?.getFacePolygonsForView) {
      const viewName = layoutViewportToViewName(p.viewport);
      const polys = viewer.getFacePolygonsForView(viewName, p.w, p.h);
      for (const { pts, fill } of polys) {
        const [r, g, b2] = hexToRgb(fill);
        doc.setFillColor(r, g, b2);
        doc.triangle(
          px + pts[0][0] * PX_TO_MM, py + pts[0][1] * PX_TO_MM,
          px + pts[1][0] * PX_TO_MM, py + pts[1][1] * PX_TO_MM,
          px + pts[2][0] * PX_TO_MM, py + pts[2][1] * PX_TO_MM,
          "F",
        );
      }
    }
    // Edge lines on top of fills — draw classified edges directly for lineweight+dash fidelity.
    doc.setDrawColor(26, 26, 34);
    if (viewer?.getClassifiedEdgeSegmentsForView) {
      const viewName = layoutViewportToViewName(p.viewport);
      const clSegs = viewer.getClassifiedEdgeSegmentsForView(viewName, p.w, p.h);
      for (const { x1, y1, x2, y2, cls } of clSegs) {
        const lw = LINEWEIGHT[cls] * PX_TO_MM;
        doc.setLineWidth(lw);
        const dash = DASH_PATTERN[cls];
        if (dash) {
          // "4 2" → [4*PX_TO_MM, 2*PX_TO_MM] mm dash/gap
          const [d, g] = dash.split(" ").map((v) => parseFloat(v) * PX_TO_MM);
          doc.setLineDashPattern([d, g], 0);
        } else {
          doc.setLineDashPattern([], 0);
        }
        doc.line(px + x1 * PX_TO_MM, py + y1 * PX_TO_MM, px + x2 * PX_TO_MM, py + y2 * PX_TO_MM);
      }
      // Reset to solid after classified pass.
      doc.setLineDashPattern([], 0);
      doc.setLineWidth(0.25);
    } else {
      // Fallback: extract from SVG (no lineweight differentiation).
      const inner = renderViewportSvg(p, c.bounds(), viewer);
      doc.setLineWidth(0.25);
      extractSvgLines(inner).forEach(([sx, sy, ex, ey]) => {
        doc.line(px + sx * PX_TO_MM, py + sy * PX_TO_MM, px + ex * PX_TO_MM, py + ey * PX_TO_MM);
      });
      extractSvgPaths(inner).forEach((pts) => {
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k];
          doc.line(px + a[0] * PX_TO_MM, py + a[1] * PX_TO_MM, px + b[0] * PX_TO_MM, py + b[1] * PX_TO_MM);
        }
      });
    }
    // Panel title + scale label.
    doc.setFontSize(7);
    doc.setTextColor(26, 26, 34);
    doc.text(p.title, px + 1.5, py + 3);
    doc.text(String(p.scale), px + pw - 1.5, py + 3, { align: "right" });
  }

  // jsPDF exposes the output as ArrayBuffer via output("arraybuffer").
  const ab = doc.output("arraybuffer") as ArrayBuffer;
  return ab;
}

// Some viewers require pure ASCII inside text strings; keep helper for any
// non-jsPDF path.
function _pdfEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}
void _pdfEscape;
void MM_TO_PT;

function extractSvgLines(svg: string): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const re = /<line\s[^>]*x1="([\d.\-]+)"\s+y1="([\d.\-]+)"\s+x2="([\d.\-]+)"\s+y2="([\d.\-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    out.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])]);
  }
  return out;
}

function extractSvgPaths(svg: string): Array<Array<[number, number]>> {
  // Only support absolute M / L / Z combinations for the placeholder paths.
  const out: Array<Array<[number, number]>> = [];
  const re = /<path\s[^>]*d="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const pts: Array<[number, number]> = [];
    const tokens = m[1].split(/[\s,]+/);
    let i = 0;
    let first: [number, number] | null = null;
    while (i < tokens.length) {
      const tok = tokens[i++];
      if (tok === "M" || tok === "L") {
        const x = parseFloat(tokens[i++]);
        const y = parseFloat(tokens[i++]);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          pts.push([x, y]);
          if (tok === "M") first = [x, y];
        }
      } else if (tok === "Z" || tok === "z") {
        if (first) pts.push([first[0], first[1]]);
      }
    }
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

// Adobe Illustrator (.ai) export — modern AI files are PDF-compatible. Some
// older Illustrator versions accepted SVG (with optional %!PS preamble) too.
// We emit SVG content with an AI-flavored XML comment marker; consumers that
// expect AI-as-PDF can use exportLayoutAsPdf() instead.
export function exportLayoutAsAi(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  const svg = composeSvg(c);
  // PostScript-flavored preamble inside an XML comment so the file remains
  // valid SVG; Illustrator detects on extension as well.
  const ps = "<!--%!PS-Adobe-3.0\n%%Creator: gemma-cad\n%%Title: layout export\n%%Pages: 1\n%%EndComments\n-->";
  return svg.replace("<?xml version=\"1.0\" encoding=\"UTF-8\"?>", `<?xml version="1.0" encoding="UTF-8"?>\n${ps}`);
}

// DWG export — LibreDWG-WASM is not bundled at present. We emit a SVG sidecar
// with a leading XML comment noting the DWG limitation, and let downstream
// tooling (CAD round-tripper) convert.
export function exportLayoutAsDwgFallback(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  const svg = composeSvg(c);
  const note = "<!-- DWG export not available without LibreDWG-WASM. Export saved as SVG sidecar. -->\n";
  return note + svg;
}

// DXF vector export — AC1015 (R2000), AcDbLine entities with per-layer lineweight (#1804).
// One DXF layer per EdgeClass (AIA-style names). DASHED linetype defined inline for
// hidden-line rendering. Coordinates in mm (sheet paper space). Y axis is DXF bottom-up.
//
// Layer → EdgeClass mapping:
//   BORDER      — panel borders
//   A-SECT-CUT  — section-cut (weight 70 = 0.70mm, CONTINUOUS)
//   A-SILHOUETTE— silhouette  (weight 50 = 0.50mm, CONTINUOUS)
//   A-NAKED     — naked edge  (weight 35 = 0.35mm, CONTINUOUS)
//   A-EDGE      — standard edge (weight 25 = 0.25mm, CONTINUOUS)
//   A-TANGENT   — tangent edge  (weight 18 = 0.18mm, CONTINUOUS)
//   A-HIDDEN    — hidden line   (weight 13 = 0.13mm, DASHED)
const _DXF_LAYERS: Array<{ name: string; color: number; lweight: number; ltype: string }> = [
  { name: "BORDER",       color: 7, lweight: 50, ltype: "CONTINUOUS" },
  { name: "A-SECT-CUT",   color: 1, lweight: DXF_LWEIGHT["section-cut"], ltype: DXF_LINETYPE["section-cut"] },
  { name: "A-SILHOUETTE", color: 2, lweight: DXF_LWEIGHT["silhouette"],   ltype: DXF_LINETYPE["silhouette"] },
  { name: "A-NAKED",      color: 3, lweight: DXF_LWEIGHT["naked"],        ltype: DXF_LINETYPE["naked"] },
  { name: "A-EDGE",       color: 4, lweight: DXF_LWEIGHT["edge"],         ltype: DXF_LINETYPE["edge"] },
  { name: "A-TANGENT",    color: 5, lweight: DXF_LWEIGHT["tangent"],      ltype: DXF_LINETYPE["tangent"] },
  { name: "A-HIDDEN",     color: 8, lweight: DXF_LWEIGHT["hidden"],       ltype: DXF_LINETYPE["hidden"] },
];

const _DXF_CLS_TO_LAYER: Record<string, string> = {
  "section-cut": "A-SECT-CUT",
  "silhouette":  "A-SILHOUETTE",
  "naked":       "A-NAKED",
  "edge":        "A-EDGE",
  "tangent":     "A-TANGENT",
  "hidden":      "A-HIDDEN",
};

export function exportLayoutAsDxf(host: HTMLElement): string {
  const c = _controllers.get(host);
  if (!c) throw new Error("layout: host has no LayoutController");
  const mm = sheetMm(c.size, c.orientation, c.customMm);
  const sheetHpx = sheetPx(mm).h;
  const PX_TO_MM = 1 / MM_TO_PX;
  const viewer = (window as unknown as { __viewer?: Viewer }).__viewer;

  // Monotonic handle counter for AC1015 entity handles.
  let _h = 1;
  const h = () => (_h++).toString(16).toUpperCase();

  const lines: string[] = [];

  // AC1015 header.
  lines.push("0", "SECTION", "2", "HEADER");
  lines.push("9", "$ACADVER", "1", "AC1015");
  lines.push("9", "$HANDSEED", "5", "FFFF");
  lines.push("9", "$EXTMIN", "10", "0", "20", "0", "30", "0");
  lines.push("9", "$EXTMAX",
    "10", mm.w.toFixed(4), "20", mm.h.toFixed(4), "30", "0");
  lines.push("0", "ENDSEC");

  // Tables section: LTYPE + LAYER.
  lines.push("0", "SECTION", "2", "TABLES");

  // LTYPE table: CONTINUOUS + DASHED.
  lines.push("0", "TABLE", "2", "LTYPE", "5", h(), "70", "2");
  // CONTINUOUS linetype.
  lines.push("0", "LTYPE", "5", h(),
    "100", "AcDbSymbolTableRecord",
    "100", "AcDbLinetypeTableRecord",
    "2", "CONTINUOUS", "70", "0", "3", "Solid line", "72", "65", "73", "0", "40", "0.0");
  // DASHED linetype: 0.5 on, 0.25 off (0.75mm period).
  lines.push("0", "LTYPE", "5", h(),
    "100", "AcDbSymbolTableRecord",
    "100", "AcDbLinetypeTableRecord",
    "2", "DASHED", "70", "0", "3", "__ __ __", "72", "65", "73", "2", "40", "0.75",
    "49", "0.5", "74", "0",
    "49", "-0.25", "74", "0");
  lines.push("0", "ENDTAB");

  // LAYER table.
  lines.push("0", "TABLE", "2", "LAYER", "5", h(), "70", String(_DXF_LAYERS.length));
  for (const { name, color, lweight, ltype } of _DXF_LAYERS) {
    lines.push("0", "LAYER", "5", h(),
      "100", "AcDbSymbolTableRecord",
      "100", "AcDbLayerTableRecord",
      "2", name, "70", "0", "62", String(color), "6", ltype, "370", String(lweight));
  }
  lines.push("0", "ENDTAB");
  lines.push("0", "ENDSEC");

  // Entities.
  lines.push("0", "SECTION", "2", "ENTITIES");

  for (const p of c.panels) {
    const ox = p.x * PX_TO_MM;
    const oy = (sheetHpx - p.y - p.h) * PX_TO_MM; // flip Y for DXF bottom-up
    const ph = p.h * PX_TO_MM;

    // Panel border on BORDER layer.
    if (p.border !== "none") {
      const bx1 = ox, by1 = oy, bx2 = ox + p.w * PX_TO_MM, by2 = oy + p.h * PX_TO_MM;
      for (const [ax, ay, bx, by] of [
        [bx1, by1, bx2, by1], [bx2, by1, bx2, by2],
        [bx2, by2, bx1, by2], [bx1, by2, bx1, by1],
      ] as [number, number, number, number][]) {
        lines.push("0", "LINE", "5", h(),
          "100", "AcDbEntity", "8", "BORDER",
          "100", "AcDbLine",
          "10", ax.toFixed(4), "20", ay.toFixed(4), "30", "0",
          "11", bx.toFixed(4), "21", by.toFixed(4), "31", "0");
      }
    }

    // Geometry: use classified edges (#1804) when available, fall back to unclassified.
    const viewName = layoutViewportToViewName(p.viewport);
    const classifiedSegs = viewer?.getClassifiedEdgeSegmentsForView
      ? viewer.getClassifiedEdgeSegmentsForView(viewName, p.w, p.h)
      : [];

    if (classifiedSegs.length > 0) {
      for (const { x1, y1, x2, y2, cls } of classifiedSegs) {
        const layer = _DXF_CLS_TO_LAYER[cls] ?? "A-EDGE";
        const sx = ox + x1 * PX_TO_MM;
        const sy = oy + (ph - y1 * PX_TO_MM);
        const ex = ox + x2 * PX_TO_MM;
        const ey = oy + (ph - y2 * PX_TO_MM);
        lines.push("0", "LINE", "5", h(),
          "100", "AcDbEntity", "8", layer,
          "100", "AcDbLine",
          "10", sx.toFixed(4), "20", sy.toFixed(4), "30", "0",
          "11", ex.toFixed(4), "21", ey.toFixed(4), "31", "0");
      }
    } else {
      // Fallback: unclassified edges on A-EDGE layer.
      const segs = viewer ? viewer.getEdgeSegmentsForView(viewName, p.w, p.h) : [];
      for (const [x1, y1, x2, y2] of segs) {
        const sx = ox + x1 * PX_TO_MM;
        const sy = oy + (ph - y1 * PX_TO_MM);
        const ex = ox + x2 * PX_TO_MM;
        const ey = oy + (ph - y2 * PX_TO_MM);
        lines.push("0", "LINE", "5", h(),
          "100", "AcDbEntity", "8", "A-EDGE",
          "100", "AcDbLine",
          "10", sx.toFixed(4), "20", sy.toFixed(4), "30", "0",
          "11", ex.toFixed(4), "21", ey.toFixed(4), "31", "0");
      }
    }
  }

  lines.push("0", "ENDSEC", "0", "EOF");
  return lines.join("\n") + "\n";
}

// --- Download helper (UI side only — not used by tests) ------------------

function triggerDownload(c: LayoutController, fmt: string): void {
  const stem = c.title.sheet.replace(/[^A-Za-z0-9_\-]+/g, "_") || "sheet";
  if (fmt === "svg") {
    const text = composeSvg(c);
    saveBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.svg`);
    return;
  }
  if (fmt === "pdf") {
    exportLayoutAsPdf(c.host).then((buf) => {
      saveBlob(new Blob([buf], { type: "application/pdf" }), `${stem}.pdf`);
    });
    return;
  }
  if (fmt === "ai") {
    const text = exportLayoutAsAi(c.host);
    // Adobe Illustrator MIME — application/postscript or application/illustrator.
    saveBlob(new Blob([text], { type: "application/illustrator" }), `${stem}.ai`);
    return;
  }
  if (fmt === "dwg") {
    const text = exportLayoutAsDwgFallback(c.host);
    saveBlob(new Blob([text], { type: "image/svg+xml" }), `${stem}.dwg.svg`);
    return;
  }
}

function saveBlob(blob: Blob, filename: string): void {
  if (typeof URL === "undefined" || typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
