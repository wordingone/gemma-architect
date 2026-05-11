// Lightweight app state singleton + pub/sub. Used by shell.ts (modebar,
// ribbon-tools, statusbar Tool/Sel cells, BLUEPRINT pill), workbench.ts
// (palette buttons), main.ts (statusbar bindings, splitMenu wiring).
//
// Not a generic redux — the four pieces of state below are exactly what
// the .zip's React app keeps in useState hooks:
//   activeTool / viewMode / layout / night / selectedId
//
// Anything more elaborate (scene KG, dispatch table, agent harness state)
// lives in the dedicated module that owns it.

export type LayoutMode = "single" | "hsplit" | "vsplit" | "quad";
export type ViewName = "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "perspective";

export interface AppState {
  activeTool: string;          // e.g. "select", "wall", "extrude"
  activeTab: string;           // active ribbon tab, e.g. "MODEL", "DRAFT"
  viewMode: "model" | "layout" | "research";
  layout: LayoutMode;          // viewport split layout
  night: boolean;              // BLUEPRINT (true) / VELLUM (false)
  selectedId: string | null;   // current selection uuid, or null
  currentView: ViewName;       // active single-pane view
  compScope: boolean;          // COMP toggle: filter scene tree to selected-component subtree
}

const DEFAULT_STATE: AppState = {
  activeTool: "select",
  activeTab: "MODEL",
  viewMode: "model",
  layout: "single",            // current TS port runs single-viewport by default
  night: false,
  selectedId: null,
  currentView: "perspective",
  compScope: false,
};

type Listener<K extends keyof AppState> = (value: AppState[K]) => void;

const listeners: { [K in keyof AppState]?: Set<Listener<K>> } = {};
const state: AppState = { ...DEFAULT_STATE };

export function getState<K extends keyof AppState>(key: K): AppState[K] {
  return state[key];
}

export function setState<K extends keyof AppState>(key: K, value: AppState[K]): void {
  if (state[key] === value) return;
  state[key] = value;
  const set = listeners[key] as Set<Listener<K>> | undefined;
  if (!set) return;
  for (const fn of set) {
    try { fn(value); } catch (e) { console.error(`[app-state] listener for "${String(key)}" threw`, e); }
  }
}

export function subscribe<K extends keyof AppState>(key: K, fn: Listener<K>): () => void {
  let set = listeners[key] as Set<Listener<K>> | undefined;
  if (!set) {
    set = new Set();
    (listeners as Record<string, Set<Listener<keyof AppState>>>)[key as string] = set as unknown as Set<Listener<keyof AppState>>;
  }
  set.add(fn);
  // Fire once with current value so subscribers paint correctly on first attach.
  try { fn(state[key]); } catch (e) { console.error(`[app-state] listener for "${String(key)}" threw on initial fire`, e); }
  return () => { set!.delete(fn); };
}

// Helper: toggle the "active" class across all DOM elements with
// data-tool=<id> when activeTool changes. Used by ribbon-tools + palette.
// Selectors are filtered to elements with the data-tool attribute so we
// don't accidentally activate unrelated nodes.
export function syncToolActiveClass(): void {
  subscribe("activeTool", (id) => {
    document.querySelectorAll<HTMLElement>("[data-tool]").forEach((el) => {
      el.classList.toggle("active", el.dataset.tool === id);
    });
  });
}

// Helper: toggle data-mode attribute on documentElement when night changes.
// Side-effect that the rest of the app relies on for theme switching.
export function syncThemeAttribute(): void {
  subscribe("night", (n) => {
    document.documentElement.setAttribute("data-mode", n ? "night" : "day");
    try { localStorage.setItem("gemma-architect.theme", n ? "night" : "day"); } catch { /* private mode */ }
  });
}

// Helper: hydrate from localStorage on first load.
export function hydrateFromStorage(): void {
  try {
    const v = localStorage.getItem("gemma-architect.theme");
    if (v === "night") setState("night", true);
    else if (v === "day") setState("night", false);
  } catch { /* ignore */ }
}

// Wire app-state verbs into the dispatch table. Imported lazily to avoid
// bundling dispatch.ts into modules that don't need it — registerHandler is
// called once at module init when workbench boots and imports this module.
import { registerHandler } from "./commands/dispatch.js";
registerHandler("setActiveTool", (args) => { setState("activeTool", args["toolId"] as string); });
registerHandler("setViewContext", (args) => { setState("activeTab", args["tab"] as string); });
