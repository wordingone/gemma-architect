import { iconSVG } from "./icons.js";
import { dispatchSync } from "./commands/dispatch.js";
import { buildPhoneSlider } from "./phone-slider.js";

// Shell chrome — design-handoff #171.
//
// Builds the menubar (9 menus) / modebar (4 modes) / ribbon (6 tabs + tools)
// statusbar wiring on top of the existing prompt-pane + viewer-pane layout.
//
// DOM target classes match the design bundle's structure (project/styles.css):
// .app, .menubar, .modebar, .ribbon, .ribbon-tabs, .ribbon-tools, .statusbar,
// .menu-item / .menu-dropdown / .menu-row / .menu-row-kbd / .menu-sep, etc.

type MenuEntry = { label: string; shortcut?: string; separator?: false; canonical?: string; toolId?: string } | { separator: true };
type MenuItem = {
  label: string;
  entries: MenuEntry[];
};

const MENUS: MenuItem[] = [
  { label: "File", entries: [
    { label: "New project",                shortcut: "⌘N" },
    { label: "Open…",                      shortcut: "⌘O",  canonical: "SdOpen" },
    { label: "Save",                       shortcut: "⌘S",  canonical: "SdSave" },
    { label: "Save As…",                   shortcut: "⇧⌘S" },
    { separator: true },
    { label: "Import IFC / STEP / OBJ…",                   canonical: "SdImport" },
    { label: "Export…",                    shortcut: "⌘E",  canonical: "SdExport" },
    { separator: true },
    { label: "Quit",                       shortcut: "⌘Q" },
  ]},
  { label: "Edit", entries: [
    { label: "Undo",         shortcut: "⌘Z" },
    { label: "Redo",         shortcut: "⇧⌘Z" },
    { separator: true },
    { label: "Cut",          shortcut: "⌘X" },
    { label: "Copy",         shortcut: "⌘C" },
    { label: "Paste",        shortcut: "⌘V" },
    { label: "Duplicate",    shortcut: "⌘D" },
    { separator: true },
    { label: "Select all",   shortcut: "⌘A",  canonical: "SdSelectAll" },
    { label: "Deselect",     shortcut: "esc", canonical: "SdDeselect" },
  ]},
  { label: "View", entries: [
    { label: "Single viewport", shortcut: "⍐1" },
    { label: "Side by side",    shortcut: "⍐2" },
    { label: "Stacked",         shortcut: "⍐3" },
    { label: "Quad · T/F/R/P",  shortcut: "⍐4" },
    { separator: true },
    { label: "Mode · Model" },
    { label: "Mode · Layout" },
    { label: "Mode · Research" },
    { separator: true },
    { label: "Toggle theme" },
    { label: "Command palette…", shortcut: "⌘K" },
  ]},
  { label: "Sketch", entries: [
    { label: "Line",       shortcut: "L", toolId: "line" },
    { label: "Rectangle",  shortcut: "R", toolId: "rect" },
    { label: "Circle",     shortcut: "C", toolId: "circle" },
    { label: "Polyline",                  toolId: "polyline" },
    { label: "Polygon",                   toolId: "polygon" },
    { label: "Arc",                       toolId: "arc" },
    { label: "Spline",                    toolId: "spline" },
  ]},
  { label: "Solid", entries: [
    { label: "Extrude",       shortcut: "E", toolId: "extrude" },
    { label: "Revolve",                      toolId: "revolve" },
    { separator: true },
    { label: "Boolean union",               canonical: "SdBooleanUnion" },
    { label: "Boolean cut",                 canonical: "SdBooleanDifference" },
    { separator: true },
    { label: "Fillet edges",                toolId: "fillet" },
    { label: "Chamfer edges",               toolId: "chamfer" },
  ]},
  { label: "Arch", entries: [
    { label: "Wall",   shortcut: "W", toolId: "wall" },
    { label: "Slab",   shortcut: "S", toolId: "slab" },
    { label: "Column",               toolId: "column" },
    { label: "Stair",                toolId: "stair" },
    { label: "Door",                 toolId: "door" },
    { label: "Window",               toolId: "window" },
  ]},
  { label: "Render", entries: [
    { label: "Wireframe" },
    { label: "Hidden line" },
    { label: "Shaded" },
    { label: "Rendered" },
    { separator: true },
    { label: "Render settings…" },
  ]},
  { label: "Window", entries: [
    { label: "Prompt" },
    { label: "Console" },
    { label: "Node graph" },
    { label: "Parameters" },
    { label: "History" },
    { separator: true },
    { label: "Reset layout" },
  ]},
  { label: "Help", entries: [
    { label: "Documentation" },
    { label: "Keyboard shortcuts" },
    { label: "About Gemma·Architect" },
  ]},
];

type ToolGroup = { label: string; tools: string[] };
const TOOL_GROUPS: ToolGroup[] = [
  { label: "TRANSFORM", tools: ["Select", "Move", "Rotate", "Scale"] },
  { label: "SKETCH 2D", tools: ["Line", "Rect", "Circle", "Polygon", "Polyline", "Arc", "Spline"] },
  { label: "SOLID",     tools: ["Extrude", "Revolve", "Fillet", "Chamfer", "Boolean"] },
  { label: "ARCH",      tools: ["Wall", "Slab", "Column", "Stair", "Door", "Window"] },
  { label: "MEASURE",   tools: ["Ruler", "Compass", "Aligned-Dim", "Angular-Dim", "Area-Dim", "Volume-Dim", "Label", "Transient-Measure"] },
];

const LAYOUT_RIBBON_TABS = ["RENDER"] as const;
type LayoutRibbonTab = typeof LAYOUT_RIBBON_TABS[number];

const LAYOUT_TOOL_GROUPS: ToolGroup[] = [
  { label: "NAVIGATE",  tools: ["Select", "Pan", "Zoom"] },
  { label: "VIEWPORT",  tools: ["Viewport", "Frame", "Scale", "Align", "Detail"] },
  { label: "DRAW",      tools: ["Line", "Rect", "Circle"] },
  { label: "MEASURE",   tools: ["Ruler", "Compass", "Text", "Leader", "Callout", "Aligned-Dim", "Angular-Dim", "Area-Dim"] },
];

type ModeDef = { key: string; num: string; label: string };
const MODES: ModeDef[] = [
  { key: "model",    num: "01", label: "MODEL" },
  { key: "layout",   num: "02", label: "LAYOUT" },
  { key: "research", num: "03", label: "RESEARCH" },
];

const RIBBON_TABS = ["RENDER"] as const;
type RibbonTab = typeof RIBBON_TABS[number];

// Module-level refs used by setRibbonMode to swap ribbon content in-place.
let _ribbonTabsEl: HTMLElement | null = null;
let _ribbonToolsEl: HTMLElement | null = null;

function fillRibbonTabs(tabsEl: HTMLElement, tabs: readonly string[], initialTab: string) {
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const tab = document.createElement("div");
    tab.className = "ribbon-tab";
    tab.dataset.tab = t;
    tab.setAttribute("role", "tab");
    const isActive = t === initialTab;
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
    if (isActive) tab.classList.add("active");
    tab.textContent = t;
    tab.addEventListener("click", (e) => {
      tabsEl.querySelectorAll<HTMLElement>(".ribbon-tab").forEach((el) => {
        const active = el === tab;
        el.classList.toggle("active", active);
        el.setAttribute("aria-selected", active ? "true" : "false");
      });
      if (t === "RENDER") {
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("render-mode-toggle", { detail: { rect: tab.getBoundingClientRect() } }));
      } else {
        dispatchSync("setViewContext", { tab: t });
      }
    });
    tabsEl.appendChild(tab);
  }
}

function fillRibbonTools(toolsEl: HTMLElement, groups: ToolGroup[]) {
  toolsEl.innerHTML = "";
  for (const group of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "tool-group";

    const btnsEl = document.createElement("div");
    btnsEl.className = "tool-group-btns";
    for (const tool of group.tools) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-btn";
      btn.dataset.tool = tool.toLowerCase();
      btn.title = tool;
      btn.innerHTML = iconSVG(tool.toLowerCase(), 16);
      btn.addEventListener("click", () => {
        const wasActive = btn.classList.contains("active");
        toolsEl.querySelectorAll<HTMLElement>(".tool-btn").forEach((b) => b.classList.remove("active"));
        if (!wasActive) {
          btn.classList.add("active");
          window.dispatchEvent(new CustomEvent("ribbon:tool-click", { detail: { tool: tool.toLowerCase() } }));
        } else {
          window.dispatchEvent(new CustomEvent("ribbon:tool-click", { detail: { tool: null } }));
        }
      });
      btnsEl.appendChild(btn);
    }
    groupEl.appendChild(btnsEl);

    const label = document.createElement("span");
    label.className = "tool-group-label";
    label.textContent = group.label;
    groupEl.appendChild(label);

    toolsEl.appendChild(groupEl);
  }
}

// Append the ARCH|COMP toggle into the ribbon tabs strip (MODEL mode only).
function appendArchCompSlider(tabsEl: HTMLElement) {
  const { root } = buildPhoneSlider({
    initial: "ARCH",
    onChange: (tab) => {
      window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab } }));
    },
  });
  tabsEl.appendChild(root);
  // Sync palette on every (re-)mount — no-op at first paint (buildPalette not yet
  // registered); on MODEL re-entry keeps slider+palette in sync.
  window.dispatchEvent(new CustomEvent("ribbon:section-tab", { detail: { tab: "ARCH" } }));
}

export function setRibbonMode(mode: "model" | "layout" | "research") {
  if (!_ribbonTabsEl || !_ribbonToolsEl) return;
  if (mode === "layout") {
    fillRibbonTabs(_ribbonTabsEl, LAYOUT_RIBBON_TABS, LAYOUT_RIBBON_TABS[0]);
    fillRibbonTools(_ribbonToolsEl, LAYOUT_TOOL_GROUPS);
  } else if (mode === "research") {
    fillRibbonTabs(_ribbonTabsEl, RIBBON_TABS, RIBBON_TABS[0]);
    fillRibbonTools(_ribbonToolsEl, TOOL_GROUPS);
  } else {
    fillRibbonTabs(_ribbonTabsEl, RIBBON_TABS, RIBBON_TABS[0]);
    fillRibbonTools(_ribbonToolsEl, TOOL_GROUPS);
    appendArchCompSlider(_ribbonTabsEl);
  }
}

const THEME_KEY = "gemma-architect.theme";
type ThemeMode = "day" | "night";

function setTheme(mode: ThemeMode) {
  document.documentElement.setAttribute("data-mode", mode);
  try { localStorage.setItem(THEME_KEY, mode); } catch { /* private mode etc. */ }
}

function loadTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "day" || v === "night") return v;
  } catch { /* ignore */ }
  return "day";
}

function buildBrand(): HTMLElement {
  const brand = document.createElement("div");
  brand.className = "brand";

  const mark = document.createElement("span");
  mark.className = "brand-mark";
  // Bundle BrandMark — circle + crosshair + sanguine sweep.
  mark.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.4"/>
    <path d="M12 3v18M3 12h18" stroke="currentColor" stroke-width="0.8" stroke-dasharray="2 2" opacity="0.5"/>
    <path d="M16 9.5a5 5 0 1 0 0 5h-3.5" stroke="oklch(0.55 0.15 28)" stroke-width="1.6" fill="none" stroke-linecap="round"/>
  </svg>`;
  brand.appendChild(mark);

  const name = document.createElement("span");
  name.className = "brand-name";
  name.innerHTML = `GEMMA<span class="b-slash">/</span>ARCHITECT`;
  brand.appendChild(name);

  return brand;
}

function buildMenubar(host: HTMLElement) {
  host.innerHTML = "";

  // Brand cell on the left.
  host.appendChild(buildBrand());

  // Menu items wrapper — required by .menubar grid; bundle structure.
  const items = document.createElement("div");
  items.className = "menubar-items";
  host.appendChild(items);

  let openItem: HTMLDivElement | null = null;
  let openDropdown: HTMLDivElement | null = null;

  function closeMenu() {
    if (openDropdown) {
      openDropdown.remove();
      openDropdown = null;
    }
    if (openItem) {
      openItem.classList.remove("open");
      openItem = null;
    }
  }

  function openMenuFor(menu: MenuItem, anchor: HTMLDivElement) {
    closeMenu();
    const panel = document.createElement("div");
    panel.className = "menu-dropdown";
    panel.setAttribute("role", "menu");
    panel.dataset.for = menu.label.toLowerCase();
    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    for (const entry of menu.entries) {
      if ("separator" in entry && entry.separator) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        sep.setAttribute("role", "separator");
        panel.appendChild(sep);
        continue;
      }
      const e = entry as { label: string; shortcut?: string; canonical?: string; toolId?: string };
      const row = document.createElement("div");
      row.className = "menu-row";
      row.setAttribute("role", "menuitem");

      const label = document.createElement("span");
      label.className = "menu-row-label";
      label.textContent = e.label;
      row.appendChild(label);

      if (e.shortcut) {
        const kbd = document.createElement("span");
        kbd.className = "menu-row-kbd";
        kbd.textContent = e.shortcut;
        row.appendChild(kbd);
      }

      row.addEventListener("click", () => {
        if (e.toolId) {
          dispatchSync("setActiveTool", { toolId: e.toolId });
        } else if (e.canonical) {
          dispatchSync(e.canonical, {});
        }
        closeMenu();
      });
      panel.appendChild(row);
    }

    // Position relative to anchor inside .menu-item (bundle uses absolute inside menu-item).
    anchor.appendChild(panel);
    anchor.classList.add("open");
    openItem = anchor;
    openDropdown = panel;
  }

  for (const menu of MENUS) {
    const item = document.createElement("div");
    item.className = "menu-item";
    item.dataset.menu = menu.label.toLowerCase();
    item.setAttribute("role", "menuitem");
    item.tabIndex = 0;
    item.textContent = menu.label;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openItem === item) {
        closeMenu();
      } else {
        openMenuFor(menu, item);
      }
    });
    item.addEventListener("mouseenter", () => {
      if (openItem && openItem !== item) {
        openMenuFor(menu, item);
      }
    });
    items.appendChild(item);
  }

  // Spacer pushes right cluster to the far edge.
  const spacer = document.createElement("div");
  spacer.className = "menubar-spacer";
  host.appendChild(spacer);

  // Right cluster — file label + BLUEPRINT/VELLUM theme pill + session pill.
  const right = document.createElement("div");
  right.className = "menubar-right";
  right.innerHTML = `
    <span>Untitled.001 · IFC4</span>
    <button id="blueprint-toggle" class="theme-pill" type="button" title="Toggle day/night (Ctrl+\\)" aria-label="Toggle theme">◑ BLUEPRINT</button>
    <span class="session-pill"><span class="dot"></span>LOCAL · NO CLOUD</span>
  `;
  host.appendChild(right);

  // Click-outside closes the dropdown.
  document.addEventListener("click", (e) => {
    if (!openDropdown) return;
    const tgt = e.target as Node | null;
    if (tgt && (openDropdown.contains(tgt) || openItem?.contains(tgt))) return;
    closeMenu();
  });
  // Escape closes.
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openDropdown) {
      closeMenu();
    }
  });
}

function buildModebar(host: HTMLElement, onChange?: (k: string) => void): (k: string) => void {
  host.innerHTML = "";
  const tabs: HTMLDivElement[] = [];

  for (const mode of MODES) {
    const tab = document.createElement("div");
    tab.className = "mode-tab";
    tab.dataset.mode = mode.key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", mode === MODES[0] ? "true" : "false");
    if (mode === MODES[0]) tab.classList.add("active");

    const num = document.createElement("span");
    num.className = "mode-num";
    num.textContent = mode.num;
    tab.appendChild(num);

    const label = document.createTextNode(" " + mode.label);
    tab.appendChild(label);

    tab.addEventListener("click", () => activate(mode.key));
    tabs.push(tab);
    host.appendChild(tab);
  }

  // Spacer + meta cluster (right-aligned context label).
  const spacer = document.createElement("div");
  spacer.className = "modebar-spacer";
  host.appendChild(spacer);

  const meta = document.createElement("div");
  meta.className = "modebar-meta";
  meta.innerHTML = `<span class="k">CONTEXT</span><span class="v">3D · IFC4 · m</span>`;
  host.appendChild(meta);

  function activate(key: string) {
    for (const t of tabs) {
      const isActive = t.dataset.mode === key;
      t.classList.toggle("active", isActive);
      t.setAttribute("aria-selected", isActive ? "true" : "false");
    }
    const sbModeV = document.querySelector("#sb-mode .v") as HTMLElement | null;
    if (sbModeV) {
      const def = MODES.find((m) => m.key === key);
      sbModeV.textContent = (def?.label ?? key).toUpperCase();
    }
    if (onChange) onChange(key);
  }
  return activate;
}

function buildRibbon(ribbonHost: HTMLElement, onSplitMode?: (mode: "single" | "quad") => void) {
  ribbonHost.innerHTML = "";

  const tabsEl = document.createElement("div");
  tabsEl.className = "ribbon-tabs";
  tabsEl.setAttribute("role", "tablist");
  ribbonHost.appendChild(tabsEl);
  _ribbonTabsEl = tabsEl;

  const toolsEl = document.createElement("div");
  toolsEl.className = "ribbon-tools";
  ribbonHost.appendChild(toolsEl);
  _ribbonToolsEl = toolsEl;

  // Fill with model ribbon content initially.
  fillRibbonTabs(tabsEl, RIBBON_TABS, RIBBON_TABS[0]);
  fillRibbonTools(toolsEl, TOOL_GROUPS);
  appendArchCompSlider(tabsEl);

  // .ribbon-right — quick actions (palette + export + viewport split).
  const rightEl = document.createElement("div");
  rightEl.className = "ribbon-right";
  rightEl.innerHTML = `
    <button class="btn btn-ghost" type="button" id="ribbon-split-single-btn" title="Single viewport (1)">&#x2b1c;</button>
    <button class="btn btn-ghost" type="button" id="ribbon-split-quad-btn" title="Quad split (4)">&#x229e;</button>
    <button class="btn btn-ghost" type="button" id="ribbon-palette-btn" title="Open command palette (Ctrl+K)">⌘K</button>
    <button class="btn" type="button" id="ribbon-export-btn" title="Export (Ctrl+E)">EXPORT</button>
  `;
  ribbonHost.appendChild(rightEl);

  rightEl.querySelector("#ribbon-split-single-btn")?.addEventListener("click", () => {
    onSplitMode?.("single");
  });
  rightEl.querySelector("#ribbon-split-quad-btn")?.addEventListener("click", () => {
    onSplitMode?.("quad");
  });

  rightEl.querySelector("#ribbon-palette-btn")?.addEventListener("click", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  });

  // When layout signals tool deactivation, clear active state on ribbon buttons.
  window.addEventListener("layout:tool-deactivated", () => {
    _ribbonToolsEl?.querySelectorAll<HTMLElement>(".tool-btn").forEach((b) => b.classList.remove("active"));
  });
}

function wireThemeToggle() {
  const initial = loadTheme();
  setTheme(initial);
  const btn = document.getElementById("blueprint-toggle");
  function updatePillLabel(mode: ThemeMode) {
    if (btn) btn.textContent = mode === "night" ? "○ VELLUM" : "◑ BLUEPRINT";
  }
  updatePillLabel(initial);
  btn?.addEventListener("click", () => {
    const cur = (document.documentElement.getAttribute("data-mode") as ThemeMode) ?? "day";
    const next = cur === "day" ? "night" : "day";
    setTheme(next);
    updatePillLabel(next);
  });
  window.addEventListener("keydown", (e) => {
    // Ctrl+\ — theme toggle. Skip when the user is editing text so we don't
    // steal a backslash they actually wanted.
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key !== "\\") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable)) return;
    e.preventDefault();
    const cur = (document.documentElement.getAttribute("data-mode") as ThemeMode) ?? "day";
    const next = cur === "day" ? "night" : "day";
    setTheme(next);
    updatePillLabel(next);
  });
}

function wireFpsCounter() {
  const cell = document.getElementById("sb-fps");
  const v = cell?.querySelector(".v") as HTMLElement | null;
  if (!v) return;
  let frames = 0;
  let last = performance.now();
  function tick(now: number) {
    frames++;
    if (now - last >= 1000) {
      const fps = Math.round((frames * 1000) / (now - last));
      v!.textContent = `${fps}`;
      frames = 0;
      last = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

export function saveProjectJson(): void {
  const payload = { version: 1 };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "project.gemma.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initShellChrome(opts?: { onModeChange?: (k: string) => void; onSplitMode?: (mode: "single" | "quad") => void }) {
  const menubar = document.querySelector(".menubar") as HTMLElement | null;
  const modebar = document.querySelector(".modebar") as HTMLElement | null;
  const ribbon  = document.querySelector(".ribbon")  as HTMLElement | null;
  if (menubar) buildMenubar(menubar);
  if (modebar) buildModebar(modebar, opts?.onModeChange);
  if (ribbon)  buildRibbon(ribbon, opts?.onSplitMode);
  wireThemeToggle();
  wireFpsCounter();
}
