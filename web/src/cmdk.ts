// Cmd-K command palette (#179) — bundle port. Opens on Cmd/Ctrl+K
// from anywhere in the app; Esc / click backdrop closes; Up/Down to
// navigate, Enter to invoke. Filter narrows by label substring.

import { iconSVG } from "./icons";
import { openExportDrawer } from "./export-drawer";
import { saveProjectJson } from "./shell";
import { runAgentTurn } from "./agent-harness";
import { dispatch } from "./dispatch";

type Cmd = {
  group: "GENERATE" | "MODEL" | "VIEW" | "FILE";
  icon: string;
  label: string;
  kbd: string;
  run: () => void;
};

function clickById(id: string) {
  const el = document.getElementById(id);
  (el as HTMLElement | null)?.click();
}

function activateModeKey(k: string) {
  const tab = document.querySelector(`.mode-tab[data-mode="${k}"]`) as HTMLElement | null;
  tab?.click();
}

function selectDemoIndex(i: number) {
  const sel = document.getElementById("prompt-select") as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = String(i);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}

function activateDockTab(id: string) {
  const tab = document.querySelector(`.dock-tab[data-tab="${id}"]`) as HTMLElement | null;
  tab?.click();
}

const ALL_CMDS: Cmd[] = [
  { group: "GENERATE", icon: "sparkle",  label: "Prompt → geometry",        kbd: "⌘P",  run: () => activateDockTab("prompt") },
  { group: "GENERATE", icon: "sparkle",  label: "Run current prompt",       kbd: "⌘⏎", run: () => clickById("ai-generate-btn") },
  { group: "GENERATE", icon: "sparkle",  label: "Vary current with seed",   kbd: "⌘⇧P", run: () => clickById("ai-generate-btn") },
  {
    group: "GENERATE", icon: "sparkle",
    label: "Agent: describe what to build…",
    kbd: "⌘⌥G",
    run: () => {
      const userPrompt = window.prompt("Describe what to build (Gemma·Architect agent):");
      if (!userPrompt?.trim()) return;
      runAgentTurn({ prompt: userPrompt.trim() }).then((resp) => {
        if (resp.dispatches.length === 0) {
          console.info("[agent]", resp.text || "(no dispatches)");
          return;
        }
        for (const d of resp.dispatches) {
          dispatch(d.verb, d.args).catch((e) => console.warn("[agent dispatch]", e));
        }
      }).catch((e) => console.error("[agent]", e));
    },
  },
  { group: "MODEL",    icon: "wall",     label: "New wall",                 kbd: "W",   run: () => selectDemoIndex(0) },
  { group: "MODEL",    icon: "slab",     label: "New slab (raised)",        kbd: "S",   run: () => selectDemoIndex(2) },
  { group: "MODEL",    icon: "column",   label: "New column",               kbd: "C",   run: () => selectDemoIndex(1) },
  { group: "MODEL",    icon: "extrude",  label: "Slab with stair hole",     kbd: "E",   run: () => selectDemoIndex(3) },
  { group: "MODEL",    icon: "wall",     label: "L-shape walls",            kbd: "L",   run: () => selectDemoIndex(5) },
  { group: "MODEL",    icon: "wall",     label: "Schultz Residence (14 elements)", kbd: "R",   run: () => selectDemoIndex(8) },
  { group: "VIEW",     icon: "graph",        label: "Toggle drafting style", kbd: "D",   run: () => (window as unknown as { __toggleDrafting?: () => void }).__toggleDrafting?.() },
  { group: "VIEW",     icon: "split-single", label: "Mode → MODEL",         kbd: "⌥1",  run: () => activateModeKey("model") },
  { group: "VIEW",     icon: "split-quad",   label: "Mode → LAYOUT (paper)", kbd: "⌥2",  run: () => activateModeKey("layout") },
  { group: "VIEW",     icon: "graph",        label: "Mode → RESEARCH",      kbd: "⌥3",  run: () => activateModeKey("research") },
  { group: "VIEW",     icon: "terminal",     label: "Show CONSOLE tab",     kbd: "⌥C",  run: () => activateDockTab("console") },
  { group: "VIEW",     icon: "graph",        label: "Show NODES tab",       kbd: "⌥N",  run: () => activateDockTab("nodes") },
  { group: "VIEW",     icon: "history",      label: "Show HISTORY tab",     kbd: "⌥H",  run: () => activateDockTab("history") },
  { group: "FILE",     icon: "import",   label: "Import IFC / STEP / OBJ…", kbd: "⌘O",  run: () => clickById("file-pick-btn") },
  { group: "FILE",     icon: "export",   label: "Export…",                   kbd: "⌘E",  run: () => openExportDrawer() },
  { group: "FILE",     icon: "export",   label: "Export IFC4 (one-click)",   kbd: "",    run: () => (document.querySelector('.exp-btn[data-fmt="ifc"]') as HTMLElement | null)?.click() },
  { group: "FILE",     icon: "export",   label: "Export GLB (one-click)",    kbd: "",    run: () => (document.querySelector('.exp-btn[data-fmt="glb"]') as HTMLElement | null)?.click() },
  { group: "FILE",     icon: "save",     label: "Save .gma project",        kbd: "⌘S",  run: () => saveProjectJson() },
];

let overlayEl: HTMLDivElement | null = null;
let panelEl: HTMLDivElement | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLDivElement | null = null;
let selIdx = 0;
let filtered: Cmd[] = ALL_CMDS;

function render() {
  if (!listEl) return;
  let html = "";
  let lastGroup: string | null = null;
  filtered.forEach((c, i) => {
    if (c.group !== lastGroup) {
      html += `<div class="cmdk-group-label">${c.group}</div>`;
      lastGroup = c.group;
    }
    html += `
      <div class="cmdk-row ${i === selIdx ? "selected" : ""}" data-idx="${i}">
        <span class="icon">${iconSVG(c.icon, 14)}</span>
        <span>${c.label}</span>
        <span class="kbd">${c.kbd}</span>
      </div>`;
  });
  listEl.innerHTML = html;
}

function applyFilter(q: string) {
  const qq = q.trim().toLowerCase();
  filtered = qq
    ? ALL_CMDS.filter((c) => c.label.toLowerCase().includes(qq) || c.group.toLowerCase().includes(qq))
    : ALL_CMDS;
  selIdx = 0;
  render();
}

function invokeSelected() {
  const c = filtered[selIdx];
  if (!c) return;
  close();
  // Defer so the close transition runs first.
  queueMicrotask(() => c.run());
}

function close() {
  if (overlayEl) overlayEl.remove();
  if (panelEl) panelEl.remove();
  overlayEl = null;
  panelEl = null;
  inputEl = null;
  listEl = null;
}

function open() {
  if (overlayEl) return; // already open
  overlayEl = document.createElement("div");
  overlayEl.className = "cmdk-backdrop";
  overlayEl.addEventListener("click", close);
  document.body.appendChild(overlayEl);

  panelEl = document.createElement("div");
  panelEl.className = "cmdk";
  panelEl.innerHTML = `
    <input class="cmdk-input" placeholder="type to search commands · or describe what you want…" />
    <div class="cmdk-list"></div>
  `;
  document.body.appendChild(panelEl);

  inputEl = panelEl.querySelector(".cmdk-input") as HTMLInputElement;
  listEl = panelEl.querySelector(".cmdk-list") as HTMLDivElement;
  selIdx = 0;
  filtered = ALL_CMDS;
  render();
  inputEl.focus();

  inputEl.addEventListener("input", () => applyFilter(inputEl!.value));
  inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selIdx = Math.min(filtered.length - 1, selIdx + 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selIdx = Math.max(0, selIdx - 1);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      invokeSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  listEl.addEventListener("mousemove", (e) => {
    const row = (e.target as HTMLElement).closest(".cmdk-row") as HTMLElement | null;
    if (!row) return;
    const i = Number(row.dataset.idx || "0");
    if (i !== selIdx) {
      selIdx = i;
      render();
    }
  });
  listEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest(".cmdk-row") as HTMLElement | null;
    if (!row) return;
    selIdx = Number(row.dataset.idx || "0");
    invokeSelected();
  });
}

export function initCmdK() {
  // Global Cmd/Ctrl+K opens the palette. Toggles on second press.
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const isCmd = (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
    if (isCmd) {
      e.preventDefault();
      if (overlayEl) close();
      else open();
    }
  });

  // Ribbon ⌘K button — clicking opens palette.
  document.getElementById("ribbon-palette-btn")?.addEventListener("click", () => {
    if (overlayEl) close();
    else open();
  });
}

export function openCmdK() { open(); }
export function closeCmdK() { close(); }
