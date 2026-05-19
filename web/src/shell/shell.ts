import { iconSVG } from "../ui/icons.js";
import { dispatchSync } from "../commands/dispatch.js";
import { buildPhoneSlider } from "../ui/phone-slider.js";
import { getState, subscribe } from "../app-state.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Shell chrome — design-handoff #171.
//
// Builds the menubar (3 menus) / modebar (4 modes) / ribbon (RENDER tab + right actions)
// statusbar wiring on top of the existing prompt-pane + viewer-pane layout.
//
// DOM target classes match the design bundle's structure (project/styles.css):
// .app, .menubar, .modebar, .ribbon, .ribbon-tabs, .ribbon-tools, .statusbar,
// .menu-item / .menu-dropdown / .menu-row / .menu-row-kbd / .menu-sep, etc.

type MenuEntry = { label: string; shortcut?: string; separator?: false; canonical?: string; toolId?: string; onAction?: () => void; stub?: boolean } | { separator: true };
type MenuItem = {
  label: string;
  entries: MenuEntry[];
};

const MENUS: MenuItem[] = [
  { label: "File", entries: [
    { label: "Open / Import…",  shortcut: "⌘O", onAction: () => openProjectFile() },
    { label: "Save project",    shortcut: "⌘S", onAction: () => saveProjectGemarch(_currentFileName) },
    { label: "Save As…",       shortcut: "⇧⌘S", onAction: () => saveProjectGemarch(null) },
    { separator: true },
    { label: "Export…",         shortcut: "⌘E", canonical: "SdExport" },
    { separator: true },
    { label: "Units: Metric ↔ Imperial", onAction: () => {
      const cur = getState("unitSystem") ?? "metric";
      dispatchSync("SdSetUnits", { system: cur === "metric" ? "imperial" : "metric" });
    }},
  ]},
  { label: "Edit", entries: [
    { label: "Undo",       shortcut: "⌘Z",   canonical: "SdUndo" },
    { label: "Redo",       shortcut: "⇧⌘Z",  canonical: "SdRedo" },
    { separator: true },
    { label: "Select all", shortcut: "⌘A",   canonical: "SdSelectAll" },
    { label: "Deselect",   shortcut: "esc",  canonical: "SdDeselect" },
  ]},
  { label: "Help", entries: [
    { label: "Keyboard shortcuts",    shortcut: "⌘K", onAction: () => document.getElementById("ribbon-palette-btn")?.click() },
    { label: "About Gemma-CAD", stub: true,    onAction: () => alert("Gemma-CAD\n\nOpen-source architectural design environment.\ngithub.com/wordingone/gemma-architect") },
  ]},
];

type ToolGroup = { label: string; tools: string[] };
const LAYOUT_RIBBON_TABS = [] as const;
type LayoutRibbonTab = typeof LAYOUT_RIBBON_TABS[number];

const LAYOUT_TOOL_GROUPS: ToolGroup[] = [
  { label: "NAVIGATE",  tools: ["Select", "Pan", "Zoom"] },
  { label: "VIEWPORT",  tools: ["Viewport", "Frame", "Scale", "Align", "Detail"] },
  { label: "DRAW",      tools: ["Line", "Rect", "Circle"] },
  { label: "MEASURE",   tools: ["Ruler", "Compass", "Text", "Leader", "Callout", "Aligned-Dim", "Angular-Dim", "Area-Dim"] },
];

const RESEARCH_TOOL_GROUPS: ToolGroup[] = [
  { label: "CORPUS",   tools: ["Search", "Import", "Globe"] },
  { label: "FINDINGS", tools: ["Sparkle", "Link"] },
  { label: "EXPORT",   tools: ["Export"] },
];

type ModeDef = { key: string; num: string; label: string };
const MODES: ModeDef[] = [
  { key: "model",    num: "01", label: "MODEL" },
  { key: "layout",   num: "02", label: "LAYOUT" },
  { key: "research", num: "03", label: "RESEARCH" },
];

const RIBBON_TABS = [] as const;
type RibbonTab = typeof RIBBON_TABS[number];

// Module-level refs used by setRibbonMode to swap ribbon content in-place.
let _ribbonTabsEl: HTMLElement | null = null;
let _ribbonToolsEl: HTMLElement | null = null;
let _ribbonEl: HTMLElement | null = null;
// Live reference to the Elements section's cards container, updated each time
// appendRibbonAssets builds it. Used by setRibbonElementTypes / reset.
let _elemCardsEl: HTMLElement | null = null;
let _elemCardWrapEl: HTMLElement | null = null; // the wrap passed to buildAssetCard
// Separate chips container for dynamic IFC element-type chips — lives BELOW the static
// Wall/Sweep cards. Hidden via :empty CSS when no IFC is loaded.
let _elemChipsEl: HTMLElement | null = null;

function fillRibbonTabs(tabsEl: HTMLElement, tabs: readonly string[], initialTab: string) {
  tabsEl.querySelectorAll<HTMLElement>(".ribbon-tab").forEach(el => el.remove());
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

// SAMPLES displayed as ribbon asset cards in MODEL mode (far right of ribbon-tools).
// Projects = full building scenes; Elements = individual components.
// Use BASE_URL prefix so thumbnail paths resolve correctly on GitHub Pages
// (base: "./" in vite.config.ts means absolute "/thumbnails/..." paths 404).
const _BASE = import.meta.env.BASE_URL;
const RIBBON_SCENE_SAMPLES = [
  { name: "Schultz Residence",  v: "schultz-residence", thumb: `${_BASE}thumbnails/schultz-residence.png` },
  { name: "KIT FZK-Haus",       v: "kit-fzk-haus",      thumb: `${_BASE}thumbnails/kit-fzk-haus.png` },
  { name: "KIT Institute",      v: "kit-office",         thumb: `${_BASE}thumbnails/kit-office.png` },
  { name: "Bonsai House",       v: "bonsai-openings",    thumb: `${_BASE}thumbnails/bonsai-openings.png` },
];
const RIBBON_ELEMENT_SAMPLES = [
  { name: "Wall",  v: "wall-with-opening", thumb: `${_BASE}thumbnails/wall-with-opening.png` },
  { name: "Sweep", v: "simple-sweep",      thumb: `${_BASE}thumbnails/simple-sweep.png` },
];

function buildAssetCard(
  s: { name: string; v: string; thumb: string },
  wrap: HTMLElement,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "ribbon-asset-card";
  card.dataset.sample = s.v;

  const img = document.createElement("img");
  img.className = "ribbon-card-img";
  img.src = s.thumb;
  img.alt = s.name;

  const lbl = document.createElement("span");
  lbl.className = "ribbon-card-name";
  lbl.textContent = s.name;

  card.appendChild(img);
  card.appendChild(lbl);
  card.addEventListener("click", () => {
    wrap.querySelectorAll(".ribbon-asset-card.selected").forEach((c: Element) => c.classList.remove("selected"));
    card.classList.add("selected");
    const sel = document.getElementById("sample-select") as HTMLSelectElement | null;
    if (sel) {
      sel.value = s.v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  return card;
}

function appendRibbonAssets(ribbonHost: HTMLElement) {
  const wrap = document.createElement("div");
  wrap.className = "ribbon-assets";

  function buildColumn(label: string, samples: typeof RIBBON_SCENE_SAMPLES): HTMLElement {
    const col = document.createElement("div");
    col.className = "ribbon-section-col";
    col.dataset.section = label.toUpperCase();

    const hdr = document.createElement("span");
    hdr.className = "ribbon-asset-section-header";
    hdr.textContent = label;
    col.appendChild(hdr);

    const cards = document.createElement("div");
    cards.className = "ribbon-assets-cards";
    for (const s of samples) cards.appendChild(buildAssetCard(s, wrap));
    col.appendChild(cards);

    if (label === "Elements") {
      _elemCardsEl = cards;
      _elemCardWrapEl = wrap;
      // Chips container — dynamic IFC type chips sit below the static cards.
      // :empty CSS hides it when no IFC is loaded.
      const chips = document.createElement("div");
      chips.className = "ribbon-assets-cards ribbon-assets-cards--chips";
      col.appendChild(chips);
      _elemChipsEl = chips;
    }

    return col;
  }

  wrap.appendChild(buildColumn("Projects", RIBBON_SCENE_SAMPLES));

  const divider = document.createElement("div");
  divider.className = "ribbon-asset-divider";
  wrap.appendChild(divider);

  wrap.appendChild(buildColumn("Elements", RIBBON_ELEMENT_SAMPLES));
  const rightEl = ribbonHost.querySelector(".ribbon-right");
  if (rightEl) ribbonHost.insertBefore(wrap, rightEl);
  else ribbonHost.appendChild(wrap);
}

// Map IFC class name to an icon key in icons.ts (fallback "model").
function ifcClassIcon(cls: string): string {
  const lower = cls.toLowerCase();
  if (lower.includes("wall"))        return "wall";
  if (lower.includes("slab"))        return "slab";
  if (lower.includes("column"))      return "column";
  if (lower.includes("beam"))        return "beam";
  if (lower.includes("stair"))       return "stair";
  if (lower.includes("door"))        return "door";
  if (lower.includes("window"))      return "window";
  if (lower.includes("roof"))        return "roof";
  if (lower.includes("space"))       return "space";
  if (lower.includes("foundation") || lower.includes("footing")) return "foundation";
  if (lower.includes("ceiling"))     return "ceiling";
  if (lower.includes("curtain"))     return "curtainwall";
  if (lower.includes("railing"))     return "railing";
  if (lower.includes("ramp"))        return "ramp";
  if (lower.includes("opening") || lower.includes("void")) return "opening";
  return "model";
}

// Populate the dynamic IFC element-type chips below the always-visible static cards.
// Static Wall/Sweep cards are untouched; chips appear in the separate _elemChipsEl row.
export function setRibbonElementTypes(types: { cls: string; count: number }[]): void {
  if (!_elemChipsEl) return;
  _elemChipsEl.innerHTML = "";
  for (const { cls, count } of types) {
    const chip = document.createElement("div");
    chip.className = "ribbon-element-chip";
    chip.dataset.ifcClass = cls;
    chip.title = `${cls} (${count})`;
    chip.innerHTML = `
      <span class="ribbon-chip-icon">${iconSVG(ifcClassIcon(cls), 16)}</span>
      <span class="ribbon-chip-name">${escapeHtml(cls.replace(/^Ifc/, ""))}</span>
      <span class="ribbon-chip-count">${count}</span>
    `;
    chip.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("ribbon:ifc-type", { detail: { cls } }));
    });
    _elemChipsEl.appendChild(chip);
  }
}

// Clear dynamic chips on scene clear / non-IFC load. Static cards remain.
export function resetRibbonElementTypes(): void {
  if (!_elemChipsEl) return;
  _elemChipsEl.innerHTML = "";
}

// Append the ARCH|COMP toggle into the ribbon tabs strip (MODEL mode only).
function appendArchCompSlider(tabsEl: HTMLElement) {
  tabsEl.querySelector(".yin-toggle")?.remove();
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
  if (!_ribbonTabsEl || !_ribbonToolsEl) {
    // Refs lost (HMR or race before buildRibbon ran). Re-query rather than silently drop.
    _ribbonTabsEl  = document.querySelector(".ribbon-tabs")  as HTMLElement | null;
    _ribbonToolsEl = document.querySelector(".ribbon-tools") as HTMLElement | null;
    _ribbonEl      = document.querySelector(".ribbon")       as HTMLElement | null;
    if (!_ribbonTabsEl || !_ribbonToolsEl) return;
  }
  if (mode === "layout") {
    _ribbonTabsEl.style.display = "none";  // no section tabs in layout mode
    fillRibbonTools(_ribbonToolsEl, LAYOUT_TOOL_GROUPS);
    _ribbonEl?.querySelector(".ribbon-assets")?.remove();
  } else if (mode === "research") {
    _ribbonTabsEl.style.display = "none";  // no section tabs in research mode
    fillRibbonTools(_ribbonToolsEl, RESEARCH_TOOL_GROUPS);
    _ribbonEl?.querySelector(".ribbon-assets")?.remove();
  } else {
    _ribbonTabsEl.style.display = "";      // restore tabs column for model mode
    fillRibbonTabs(_ribbonTabsEl, RIBBON_TABS, "");
    appendArchCompSlider(_ribbonTabsEl);
    fillRibbonTools(_ribbonToolsEl, []);
    _ribbonEl?.querySelector(".ribbon-assets")?.remove();
    if (_ribbonEl) appendRibbonAssets(_ribbonEl);
  }
}

const RECENT_FILES_KEY = "gemma-cad.recent-files";
const MAX_RECENT = 5;
type RecentEntry = { name: string; ts: number; data: string };

let _fileNameEl: HTMLElement | null = null;
let _currentFileName = "Untitled.001";

function loadRecentFiles(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(RECENT_FILES_KEY);
    if (raw) return JSON.parse(raw) as RecentEntry[];
  } catch { /* ignore */ }
  return [];
}

function saveRecentFilesList(entries: RecentEntry[]): void {
  try { localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(entries)); } catch { /* ignore */ }
}

function addToRecentFiles(name: string, data: string): void {
  const entries = loadRecentFiles().filter(e => e.name !== name);
  entries.unshift({ name, ts: Date.now(), data });
  saveRecentFilesList(entries.slice(0, MAX_RECENT));
}

function snapshotState(): object {
  const units = getState("unitSystem") ?? "metric";
  const w = window as Window & { __viewer?: { exportScene?: () => unknown[] } };
  return { version: 1, meta: { units, name: _currentFileName }, objects: w.__viewer?.exportScene?.() ?? [] };
}

function setCurrentFileName(name: string): void {
  _currentFileName = name;
  if (_fileNameEl) _fileNameEl.textContent = `${name} · IFC4`;
}

function loadProjectData(data: string, fileName: string): void {
  try {
    const parsed = JSON.parse(data) as { version?: number; meta?: { units?: string; name?: string } };
    if (parsed.meta?.units) dispatchSync("SdSetUnits", { system: parsed.meta.units });
    const baseName = fileName.replace(/\.(gemarch|json)$/i, "");
    setCurrentFileName(parsed.meta?.name ?? baseName);
  } catch {
    alert(`Could not load "${fileName}": invalid format.`);
  }
}

function openProjectFile(): void {
  let picker = document.getElementById("gemarch-file-picker") as HTMLInputElement | null;
  if (!picker) {
    picker = document.createElement("input");
    picker.type = "file";
    picker.id = "gemarch-file-picker";
    picker.accept = ".gemarch,.json";
    picker.style.display = "none";
    document.body.appendChild(picker);
    picker.addEventListener("change", () => {
      const file = picker!.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        loadProjectData(text, file.name);
        addToRecentFiles(file.name, text);
      };
      reader.readAsText(file);
      picker!.value = "";
    });
  }
  picker.click();
}

function injectRecentEntries(base: MenuEntry[]): MenuEntry[] {
  const recents = loadRecentFiles();
  if (recents.length === 0) return base;
  const firstSepIdx = base.findIndex(e => "separator" in e && e.separator);
  if (firstSepIdx === -1) return base;
  const recentEntries: MenuEntry[] = recents.map(r => ({
    label: r.name,
    onAction: () => loadProjectData(r.data, r.name),
  }));
  return [...base.slice(0, firstSepIdx), ...recentEntries, ...base.slice(firstSepIdx)];
}

export function saveProjectGemarch(fileNameOrNull: string | null): void {
  const name = fileNameOrNull ?? _currentFileName;
  const data = JSON.stringify(snapshotState(), null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const dlName = name.endsWith(".gemarch") ? name : `${name}.gemarch`;
  a.download = dlName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  addToRecentFiles(dlName, data);
  setCurrentFileName(dlName.replace(/\.gemarch$/i, ""));
}

const THEME_KEY = "gemma-cad.theme";
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
  name.innerHTML = `GEMMA<span class="b-slash">-</span>CAD`;
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

    const entries = menu.label === "File" ? injectRecentEntries(menu.entries) : menu.entries;
    for (const entry of entries) {
      if ("separator" in entry && entry.separator) {
        const sep = document.createElement("div");
        sep.className = "menu-sep";
        sep.setAttribute("role", "separator");
        panel.appendChild(sep);
        continue;
      }
      const e = entry as { label: string; shortcut?: string; canonical?: string; toolId?: string; onAction?: () => void; stub?: boolean };
      const row = document.createElement("div");
      row.className = "menu-row";
      row.setAttribute("role", "menuitem");
      if (e.stub) row.dataset.stub = "true";
      if (e.toolId) row.dataset.toolId = e.toolId;
      if (e.canonical) row.dataset.canonical = e.canonical;

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
        } else if (e.onAction) {
          e.onAction();
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
    <span id="menubar-filename">${escapeHtml(_currentFileName)} · IFC4</span>
    <button id="blueprint-toggle" class="theme-pill" type="button" title="Toggle day/night (Ctrl+\\)" aria-label="Toggle theme">◑ BLUEPRINT</button>
    <span class="session-pill"><span class="dot"></span>LOCAL · NO CLOUD</span>
  `;
  _fileNameEl = right.querySelector("#menubar-filename") as HTMLElement | null;
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
  ribbonHost.appendChild(toolsEl);  // sibling of ribbon-tabs, not child
  _ribbonToolsEl = toolsEl;
  _ribbonEl = ribbonHost;

  // Fill with model ribbon content initially.
  fillRibbonTabs(tabsEl, RIBBON_TABS, "");
  appendArchCompSlider(tabsEl);
  fillRibbonTools(toolsEl, []);
  appendRibbonAssets(ribbonHost);

  // .ribbon-right — EXPORT only; split buttons live in vp-header now.
  const rightEl = document.createElement("div");
  rightEl.className = "ribbon-right";
  rightEl.innerHTML = `
    <button class="btn" type="button" id="ribbon-export-btn" title="Export (Ctrl+E)">EXPORT</button>
  `;
  ribbonHost.appendChild(rightEl);

  // Align ribbon-right width to the actual sidebar column width (--sidebar-w may be unset).
  requestAnimationFrame(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    if (sidebar) rightEl.style.width = sidebar.getBoundingClientRect().width + "px";
  });

  // Inject split-viewport controls into every vp-header's controls section.
  // All 4 viewports get the buttons — in single mode only the visible one shows them;
  // in quad mode all 4 headers carry them (consistent UX, same action).
  document.querySelectorAll<HTMLElement>(".vp-controls").forEach((vpControls) => {
    vpControls.querySelector(".vp-split-single-btn")?.remove();
    vpControls.querySelector(".vp-split-quad-btn")?.remove();
    const quadBtn = document.createElement("button");
    quadBtn.className = "vp-icon-btn vp-split-quad-btn";
    quadBtn.title = "Quad split (4)";
    quadBtn.innerHTML = iconSVG("split-quad", 14);
    quadBtn.addEventListener("click", () => onSplitMode?.("quad"));
    const singleBtn = document.createElement("button");
    singleBtn.className = "vp-icon-btn vp-split-single-btn";
    singleBtn.title = "Single viewport (1)";
    singleBtn.innerHTML = iconSVG("split-single", 14);
    singleBtn.addEventListener("click", () => {
      const vp = vpControls.closest<HTMLElement>(".viewport");
      const area = document.querySelector<HTMLElement>(".viewport-area");
      if (area && vp) {
        if (vp.id !== "viewport-2") {
          // Non-persp pane: snap the persp pane (viewport-2) to this view so
          // the view-dropdown stays functional after the split→single transition.
          delete area.dataset.focusVp;
          const viewBtn = vp.querySelector<HTMLElement>(".vp-view-btn");
          const view = viewBtn?.dataset.vpView ?? "top";
          if (view === "perspective") {
            dispatchSync("SdSetViewPerspective", {});
          } else {
            dispatchSync("SdSetViewOrtho", { view });
          }
        } else {
          delete area.dataset.focusVp;
        }
      }
      onSplitMode?.("single");
    });
    vpControls.appendChild(singleBtn);
    vpControls.appendChild(quadBtn);
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

/** @deprecated Use saveProjectGemarch */
export function saveProjectJson(): void {
  saveProjectGemarch(_currentFileName);
}

function wireUnitsCell(): void {
  const cell = document.getElementById("sb-units");
  const v = cell?.querySelector(".v") as HTMLElement | null;
  if (!v) return;
  subscribe("unitSystem", (sys) => {
    v.textContent = sys === "imperial" ? "ft · IFC4" : "m · IFC4";
  });
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
  wireUnitsCell();

  // File keyboard shortcuts: Ctrl/Cmd+O (open), Ctrl/Cmd+S (save), Ctrl/Cmd+Shift+S (save as).
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "o" || e.key === "O") {
      const tgt = e.target as HTMLElement | null;
      if (tgt?.tagName === "INPUT" || tgt?.tagName === "TEXTAREA" || tgt?.isContentEditable) return;
      e.preventDefault();
      openProjectFile();
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      if (e.shiftKey) saveProjectGemarch(null);
      else saveProjectGemarch(_currentFileName);
    }
  });
}
