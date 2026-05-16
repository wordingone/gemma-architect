// skill-canvas.ts — #722: Grasshopper-style skill-node canvas.
//
// Each canvas node = ONE OF:
//  "skill"  — built-in or user-saved skill (entire dispatch chain runs on Run)
//  "script" — inline DSL code, evaluated via compileDsl() on Run
//
// Palette left-sidebar lists all 13 built-in skills + user-saved + "+ Script".
// Pan on middle-mouse drag; zoom on wheel. Wire nodes with output→input ports.
// Topo-sorted run dispatches all steps in dependency order.

import { dispatchSync, type DispatchArgs } from "../commands/dispatch";
import { compileDsl } from "../commands/dsl-eval";
import { saveSkill, listSavedSkills, type SkillStep, type SavedSkill } from "./skill-store";
import { openSaveSkillModal } from "./skill-modal";

// ── Built-in skill names (web/skills/*/) ──────────────────────────────────────

const BUILT_IN_SKILL_NAMES: string[] = [
  "align-to-grid",
  "dimension-chain",
  "extrude-walls",
  "fire-station",
  "hospitality-cabin",
  "mirror-across-axis",
  "office-25desk",
  "place-doors",
  "replicate-from-video",
  "research-from-prompt",
  "research-pavilion",
  "room-from-prompt",
  "sf-residence-2br",
  "stair-from-points",
];

let _builtInCache: Array<{ name: string; steps: SkillStep[] }> | null = null;

async function loadBuiltInSkills(): Promise<Array<{ name: string; steps: SkillStep[] }>> {
  if (_builtInCache) return _builtInCache;
  const results = await Promise.all(
    BUILT_IN_SKILL_NAMES.map(async (slug) => {
      try {
        const res = await fetch(`/skills/${slug}/skill.json`);
        if (!res.ok) return null;
        const d = await res.json() as { name?: string; steps?: SkillStep[] };
        return { name: d.name ?? slug, steps: d.steps ?? [] };
      } catch { return null; }
    })
  );
  _builtInCache = results.filter((r): r is { name: string; steps: SkillStep[] } => r !== null);
  return _builtInCache;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type CanvasNode = {
  id: string;
  kind?: "skill" | "script";  // undefined = legacy verb-based (runWithAnimation)
  // Skill node:
  skillId?: string;
  skillName?: string;
  skillSteps?: SkillStep[];
  // Script node:
  scriptSource?: string;
  // Legacy single-verb (runWithAnimation backward-compat):
  verb?: string;
  args?: Record<string, unknown>;
  // Canvas position (canvas coordinate space, pre-transform):
  x: number;
  y: number;
};

export type CanvasEdge = {
  id: string;
  from: string;
  to: string;
};

export type CanvasGraph = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

// ── Persistence ───────────────────────────────────────────────────────────────

const LS_KEY = "gemma-cad:skill-canvas-v2";
const LS_KEY_V1_A = "gemma-cad:skill-canvas-v1";
const LS_KEY_V1_B = "gemma-architect:skill-canvas-v1";

function loadGraph(): CanvasGraph {
  try {
    const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem(LS_KEY_V1_A) ?? localStorage.getItem(LS_KEY_V1_B);
    if (raw) return JSON.parse(raw) as CanvasGraph;
  } catch { /* ignore */ }
  return { nodes: [], edges: [] };
}

function saveGraph(g: CanvasGraph): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(g)); } catch { /* ignore */ }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── SkillCanvas class ─────────────────────────────────────────────────────────

export class SkillCanvas {
  private _graph: CanvasGraph;
  private _svg!: SVGSVGElement;
  private _nodesEl!: HTMLElement;
  private _transformEl!: HTMLElement;
  private _viewport!: HTMLElement;
  private _paletteEl!: HTMLElement;

  // Pan/zoom state
  private _tx = 0;
  private _ty = 0;
  private _tz = 1;
  private _panStart: { mx: number; my: number; tx: number; ty: number } | null = null;

  // Drag state
  private _dragNode: { id: string; ox: number; oy: number; sx: number; sy: number } | null = null;
  // Port-connect state
  private _connectFrom: { id: string; side: "out" } | null = null;
  private _connectLine: SVGPathElement | null = null;

  constructor(private _root: HTMLElement) {
    this._graph = loadGraph();
    this._build();
  }

  // ── Build DOM ──────────────────────────────────────────────────────────────

  private _build(): void {
    this._root.innerHTML = "";
    this._root.className = "skill-canvas-root";

    // Palette sidebar (populated asynchronously)
    const palette = document.createElement("div");
    palette.className = "skill-canvas-palette";
    palette.innerHTML = `<div class="skill-canvas-palette-title">Loading…</div>`;
    this._paletteEl = palette;
    this._root.appendChild(palette);

    // Viewport
    const viewport = document.createElement("div");
    viewport.className = "skill-canvas-viewport";
    this._viewport = viewport;

    // Pan/zoom transform layer — wraps SVG + nodes so both move together.
    const transformEl = document.createElement("div");
    transformEl.className = "skill-canvas-transform";
    this._transformEl = transformEl;
    this._applyTransform();

    // SVG edge layer (inside transform so edges scale/pan with nodes)
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "skill-canvas-svg");
    this._svg = svg;
    transformEl.appendChild(svg);

    // Node layer
    const nodesEl = document.createElement("div");
    nodesEl.className = "skill-canvas-nodes";
    this._nodesEl = nodesEl;
    transformEl.appendChild(nodesEl);

    viewport.appendChild(transformEl);

    // Drop target for palette drags
    viewport.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
    viewport.addEventListener("drop", (e) => {
      e.preventDefault();
      const raw = e.dataTransfer!.getData("text/plain");
      if (!raw) return;
      const rect = viewport.getBoundingClientRect();
      const cx = (e.clientX - rect.left  - this._tx) / this._tz - 80;
      const cy = (e.clientY - rect.top   - this._ty) / this._tz - 20;
      try {
        const d = JSON.parse(raw) as { kind: string; skillId?: string; skillName?: string; skillSteps?: SkillStep[] };
        if (d.kind === "skill") {
          this._addSkillNode(d.skillId ?? d.skillName ?? "skill", d.skillName ?? "skill", d.skillSteps ?? [], cx, cy);
        } else {
          this._addScriptNode(cx, cy);
        }
      } catch { /* ignore malformed */ }
    });

    // Pan: middle-mouse drag
    viewport.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this._panStart = { mx: e.clientX, my: e.clientY, tx: this._tx, ty: this._ty };
      }
    });

    // Zoom: wheel toward cursor
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const newTz = Math.max(0.1, Math.min(5, this._tz * factor));
      this._tx = mx - (mx - this._tx) * (newTz / this._tz);
      this._ty = my - (my - this._ty) * (newTz / this._tz);
      this._tz = newTz;
      this._applyTransform();
    }, { passive: false });

    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup",   this._onMouseUp);

    this._root.appendChild(viewport);

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "skill-canvas-toolbar";
    toolbar.innerHTML = `
      <button class="btn btn-sm sc-clear-btn" type="button">Clear</button>
      <button class="btn btn-sm sc-run-btn" type="button">▶ Run</button>
      <button class="btn btn-accent btn-sm sc-compile-btn" type="button">Compile to skill</button>
    `;
    toolbar.querySelector(".sc-clear-btn")!.addEventListener("click", () => this._clear());
    toolbar.querySelector(".sc-run-btn")!.addEventListener("click", () => void this._run());
    toolbar.querySelector(".sc-compile-btn")!.addEventListener("click", () => this._compile());
    this._root.appendChild(toolbar);

    this._renderGraph();
    void this._buildPalette();
  }

  private _applyTransform(): void {
    this._transformEl.style.transform = `translate(${this._tx}px,${this._ty}px) scale(${this._tz})`;
  }

  private async _buildPalette(): Promise<void> {
    const [builtIn, saved] = await Promise.all([
      loadBuiltInSkills(),
      listSavedSkills().catch(() => [] as SavedSkill[]),
    ]);

    this._paletteEl.innerHTML = "";

    const makeTitle = (text: string, mt = false): HTMLElement => {
      const t = document.createElement("div");
      t.className = "skill-canvas-palette-title";
      if (mt) t.style.marginTop = "8px";
      t.textContent = text;
      return t;
    };

    // Built-in skills
    this._paletteEl.appendChild(makeTitle("Built-in"));
    for (const skill of builtIn) {
      this._paletteEl.appendChild(this._makePaletteItem(skill.name, skill.steps.length, {
        kind: "skill", skillId: skill.name, skillName: skill.name, skillSteps: skill.steps,
      }));
    }

    // User-saved skills
    if (saved.length > 0) {
      this._paletteEl.appendChild(makeTitle("Saved", true));
      for (const skill of saved) {
        this._paletteEl.appendChild(this._makePaletteItem(skill.name, skill.steps.length, {
          kind: "skill", skillId: skill.id, skillName: skill.name, skillSteps: skill.steps,
        }));
      }
    }

    // Script template
    this._paletteEl.appendChild(makeTitle("Custom", true));
    const scriptItem = document.createElement("div");
    scriptItem.className = "skill-canvas-palette-item sc-palette-script";
    scriptItem.textContent = "+ Script";
    scriptItem.title = "Drag to add an inline DSL script node";
    scriptItem.draggable = true;
    scriptItem.addEventListener("dragstart", (e) => {
      e.dataTransfer!.setData("text/plain", JSON.stringify({ kind: "script" }));
      e.dataTransfer!.effectAllowed = "copy";
    });
    scriptItem.addEventListener("dblclick", () => this._addScriptAtCenter());
    this._paletteEl.appendChild(scriptItem);
  }

  private _makePaletteItem(
    name: string,
    stepCount: number,
    dragData: { kind: string; skillId?: string; skillName?: string; skillSteps?: SkillStep[] }
  ): HTMLElement {
    const item = document.createElement("div");
    item.className = "skill-canvas-palette-item";
    item.innerHTML = `<span class="sc-pal-name">${escHtml(name)}</span><span class="sc-pal-badge">${stepCount}</span>`;
    item.title = `${name} · ${stepCount} step${stepCount === 1 ? "" : "s"} — drag to canvas or double-click`;
    item.draggable = true;
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer!.setData("text/plain", JSON.stringify(dragData));
      e.dataTransfer!.effectAllowed = "copy";
    });
    item.addEventListener("dblclick", () => {
      const rect = this._viewport.getBoundingClientRect();
      const cx = (rect.width  / 2 - this._tx) / this._tz - 80;
      const cy = (rect.height / 2 - this._ty) / this._tz - 20;
      this._addSkillNode(
        dragData.skillId ?? dragData.skillName ?? "skill",
        dragData.skillName ?? name,
        dragData.skillSteps ?? [],
        cx, cy
      );
    });
    return item;
  }

  // ── Graph mutation ─────────────────────────────────────────────────────────

  private _addSkillNode(skillId: string, skillName: string, skillSteps: SkillStep[], x: number, y: number): void {
    this._graph.nodes.push({
      id: crypto.randomUUID(), kind: "skill",
      skillId, skillName, skillSteps,
      x: Math.max(0, x), y: Math.max(0, y),
    });
    saveGraph(this._graph);
    this._renderGraph();
  }

  private _addScriptNode(x: number, y: number): void {
    this._graph.nodes.push({
      id: crypto.randomUUID(), kind: "script",
      scriptSource: "",
      x: Math.max(0, x), y: Math.max(0, y),
    });
    saveGraph(this._graph);
    this._renderGraph();
  }

  private _addScriptAtCenter(): void {
    const rect = this._viewport.getBoundingClientRect();
    this._addScriptNode(
      (rect.width  / 2 - this._tx) / this._tz - 80,
      (rect.height / 2 - this._ty) / this._tz - 20
    );
  }

  private _removeNode(id: string): void {
    this._graph.nodes = this._graph.nodes.filter(n => n.id !== id);
    this._graph.edges = this._graph.edges.filter(e => e.from !== id && e.to !== id);
    saveGraph(this._graph);
    this._renderGraph();
  }

  private _clear(): void {
    this._graph = { nodes: [], edges: [] };
    saveGraph(this._graph);
    this._renderGraph();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private _renderGraph(): void {
    this._nodesEl.innerHTML = "";
    for (const node of this._graph.nodes) {
      this._nodesEl.appendChild(this._buildNodeEl(node));
    }
    this._renderEdges();
  }

  private _buildNodeEl(node: CanvasNode): HTMLElement {
    const el = document.createElement("div");
    el.className = "sc-node";
    el.dataset.id = node.id;
    el.style.cssText = `left:${node.x}px; top:${node.y}px;`;

    if (node.kind === "script") {
      el.classList.add("sc-node-script");
      el.innerHTML = `
        <div class="sc-node-header">
          <span class="sc-node-verb">Script</span>
          <button class="sc-node-del" title="Remove" type="button">✕</button>
        </div>
        <div class="sc-node-body">
          <textarea class="sc-script-src" rows="3" spellcheck="false" placeholder="wall (0 0) (5 0) height=3">${escHtml(node.scriptSource ?? "")}</textarea>
        </div>
        <div class="sc-node-ports">
          <div class="sc-port sc-port-in"  data-node="${node.id}" data-side="in"  title="Input"></div>
          <div class="sc-port sc-port-out" data-node="${node.id}" data-side="out" title="Output"></div>
        </div>
      `;
      el.querySelector<HTMLTextAreaElement>(".sc-script-src")!.addEventListener("input", (ev) => {
        node.scriptSource = (ev.target as HTMLTextAreaElement).value;
        saveGraph(this._graph);
      });
    } else {
      // Skill node (includes legacy verb-based nodes from runWithAnimation)
      const displayName = node.skillName ?? node.verb ?? "?";
      const stepCount = node.skillSteps?.length ?? (node.verb ? 1 : 0);
      el.innerHTML = `
        <div class="sc-node-header">
          <span class="sc-node-verb">${escHtml(displayName)}</span>
          <button class="sc-node-del" title="Remove" type="button">✕</button>
        </div>
        <div class="sc-node-body sc-node-skill-body">
          <span class="sc-step-badge">${stepCount} step${stepCount === 1 ? "" : "s"}</span>
        </div>
        <div class="sc-node-ports">
          <div class="sc-port sc-port-in"  data-node="${node.id}" data-side="in"  title="Input"></div>
          <div class="sc-port sc-port-out" data-node="${node.id}" data-side="out" title="Output"></div>
        </div>
      `;
    }

    el.querySelector(".sc-node-del")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this._removeNode(node.id);
    });

    // Node drag — skip on ports, delete button, textarea
    el.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement;
      if (t.classList.contains("sc-port") || t.classList.contains("sc-node-del") || t.tagName === "TEXTAREA") return;
      e.preventDefault();
      this._dragNode = { id: node.id, ox: node.x, oy: node.y, sx: e.clientX, sy: e.clientY };
    });

    // Wire from output port
    el.querySelector(".sc-port-out")!.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._connectFrom = { id: node.id, side: "out" };
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("class", "sc-edge-draft");
      this._svg.appendChild(line);
      this._connectLine = line;
    });

    // Accept wire on input port
    el.querySelector(".sc-port-in")!.addEventListener("mouseup", (e) => {
      e.stopPropagation();
      if (!this._connectFrom) return;
      const fromId = this._connectFrom.id;
      const toId = node.id;
      if (fromId !== toId && !this._graph.edges.find(ex => ex.from === fromId && ex.to === toId)) {
        this._graph.edges.push({ id: crypto.randomUUID(), from: fromId, to: toId });
        saveGraph(this._graph);
      }
      this._endConnect();
      this._renderGraph();
    });

    return el;
  }

  private _renderEdges(): void {
    this._svg.innerHTML = "";
    for (const edge of this._graph.edges) {
      const from = this._graph.nodes.find(n => n.id === edge.from);
      const to   = this._graph.nodes.find(n => n.id === edge.to);
      if (!from || !to) continue;
      // Output port is on the right side of the node (node width = 160px)
      const path = this._edgePath(from.x + 160, from.y + 48, to.x, to.y + 48);
      const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
      el.setAttribute("class", "sc-edge");
      el.setAttribute("d", path);
      el.addEventListener("dblclick", () => {
        this._graph.edges = this._graph.edges.filter(e => e.id !== edge.id);
        saveGraph(this._graph);
        this._renderGraph();
      });
      this._svg.appendChild(el);
    }
  }

  private _edgePath(x1: number, y1: number, x2: number, y2: number): string {
    const cx = (x1 + x2) / 2;
    return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
  }

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  private _onMouseMove = (e: MouseEvent): void => {
    // Pan (middle button held)
    if (this._panStart) {
      this._tx = this._panStart.tx + e.clientX - this._panStart.mx;
      this._ty = this._panStart.ty + e.clientY - this._panStart.my;
      this._applyTransform();
    }

    // Drag node
    if (this._dragNode) {
      const d = this._dragNode;
      const node = this._graph.nodes.find(n => n.id === d.id);
      if (node) {
        node.x = Math.max(0, d.ox + (e.clientX - d.sx) / this._tz);
        node.y = Math.max(0, d.oy + (e.clientY - d.sy) / this._tz);
        const el = this._nodesEl.querySelector<HTMLElement>(`[data-id="${d.id}"]`);
        if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
        this._renderEdges();
      }
    }

    // Rubber-band edge draft (coordinates in canvas space)
    if (this._connectFrom && this._connectLine) {
      const from = this._graph.nodes.find(n => n.id === this._connectFrom!.id);
      if (from) {
        const vpRect = this._viewport.getBoundingClientRect();
        const x2 = (e.clientX - vpRect.left  - this._tx) / this._tz;
        const y2 = (e.clientY - vpRect.top   - this._ty) / this._tz;
        this._connectLine.setAttribute("d", this._edgePath(from.x + 160, from.y + 48, x2, y2));
      }
    }
  };

  private _onMouseUp = (_e: MouseEvent): void => {
    if (this._dragNode) { saveGraph(this._graph); this._dragNode = null; }
    if (this._panStart) this._panStart = null;
    if (this._connectFrom) this._endConnect();
  };

  private _endConnect(): void {
    this._connectLine?.remove();
    this._connectLine = null;
    this._connectFrom = null;
  }

  // ── Run & Compile ──────────────────────────────────────────────────────────

  private async _run(): Promise<void> {
    for (const node of this._topoSort()) {
      await this._runNode(node);
    }
  }

  private async _runNode(node: CanvasNode): Promise<void> {
    if (node.kind === "script") {
      const src = node.scriptSource?.trim() ?? "";
      if (!src) return;
      const result = compileDsl(src);
      if (!result.ok) return;
      for (const d of result.dispatches ?? []) {
        dispatchSync(d.verb, d.args as DispatchArgs);
        await new Promise(r => setTimeout(r, 80));
      }
    } else if (node.skillSteps && node.skillSteps.length > 0) {
      for (const step of node.skillSteps) {
        dispatchSync(step.verb, step.args as DispatchArgs);
        await new Promise(r => setTimeout(r, 80));
      }
    } else if (node.verb) {
      // Legacy single-verb node (runWithAnimation compat)
      dispatchSync(node.verb, (node.args ?? {}) as DispatchArgs);
      await new Promise(r => setTimeout(r, 80));
    }
  }

  private _compile(): void {
    const steps: SkillStep[] = [];
    for (const node of this._topoSort()) {
      if (node.skillSteps) steps.push(...node.skillSteps);
      else if (node.verb) steps.push({ verb: node.verb, args: node.args ?? {} });
    }
    if (steps.length === 0) return;
    openSaveSkillModal(steps);
  }

  private _topoSort(): CanvasNode[] {
    const inDeg = new Map<string, number>(this._graph.nodes.map(n => [n.id, 0]));
    const adj   = new Map<string, string[]>(this._graph.nodes.map(n => [n.id, []]));
    for (const e of this._graph.edges) {
      adj.get(e.from)!.push(e.to);
      inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
    }
    const queue = this._graph.nodes.filter(n => (inDeg.get(n.id) ?? 0) === 0);
    const order: CanvasNode[] = [];
    while (queue.length > 0) {
      const n = queue.shift()!;
      order.push(n);
      for (const nxt of adj.get(n.id) ?? []) {
        const deg = (inDeg.get(nxt) ?? 1) - 1;
        inDeg.set(nxt, deg);
        if (deg === 0) {
          const nxtNode = this._graph.nodes.find(x => x.id === nxt);
          if (nxtNode) queue.push(nxtNode);
        }
      }
    }
    const seen = new Set(order.map(n => n.id));
    this._graph.nodes.filter(n => !seen.has(n.id)).sort((a, b) => a.x - b.x).forEach(n => order.push(n));
    return order;
  }

  // ── P5b: agent-triggered animation ────────────────────────────────────────

  async runWithAnimation(steps: SkillStep[]): Promise<void> {
    const nodes: CanvasNode[] = steps.map((step, i) => ({
      id: crypto.randomUUID(),
      kind: "skill" as const,
      skillName: step.verb,
      skillSteps: [step],
      // Legacy fields kept for fallback:
      verb: step.verb,
      args: step.args,
      x: 20 + i * 180,
      y: 80,
    }));
    const edges: CanvasEdge[] = nodes.slice(0, -1).map((n, i) => ({
      id: crypto.randomUUID(),
      from: n.id,
      to: nodes[i + 1].id,
    }));
    this._graph = { nodes, edges };
    saveGraph(this._graph);
    this._renderGraph();

    for (const node of this._topoSort()) {
      const el = this._nodesEl.querySelector<HTMLElement>(`[data-id="${node.id}"]`);
      el?.classList.add("node-running");
      await this._runNode(node);
      el?.classList.remove("node-running");
    }
    (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  destroy(): void {
    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("mouseup",   this._onMouseUp);
  }
}

// Exported for backward-compat (verb palette was public API in #408 siblings)
export const CANVAS_VERBS: string[] = BUILT_IN_SKILL_NAMES;
