// skill-canvas.ts — P5a: hand-rolled graph canvas for SKILL NODES wiring.
//
// Zero graph-library dependency. Nodes are absolutely-positioned divs;
// edges are SVG cubic bezier paths rendered on an overlay <svg>. State
// persists to localStorage. Canvas serializes to/from P4 SavedSkill via
// "Compile to skill" → saveSkill().
//
// P5a scope: manual wiring, topo-sorted run/compile. Agent graph emit is P5b.

import { dispatchSync, type DispatchArgs } from "../commands/dispatch";
import { saveSkill, type SkillStep } from "./skill-store";
import { openSaveSkillModal } from "./skill-modal";

// ── Verb palette ─────────────────────────────────────────────────────────────

export const CANVAS_VERBS: string[] = [
  "IfcWall", "IfcSlab", "IfcColumn", "IfcBeam",
  "IfcDoor", "IfcWindow", "IfcRoof", "IfcSpace",
  "IfcStair", "IfcRamp", "IfcRailing", "IfcFoundation",
  "IfcCeiling", "IfcCurtainWall", "IfcGrid", "IfcLevel",
  "SdBox", "SdSphere", "SdCylinder",
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type CanvasNode = {
  id: string;
  verb: string;
  args: Record<string, unknown>;
  x: number;
  y: number;
};

export type CanvasEdge = {
  id: string;
  from: string;   // source node id
  to:   string;   // target node id
};

export type CanvasGraph = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

// ── Persistence ───────────────────────────────────────────────────────────────

const LS_KEY = "gemma-architect:skill-canvas-v1";

function loadGraph(): CanvasGraph {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as CanvasGraph;
  } catch { /* ignore */ }
  return { nodes: [], edges: [] };
}

function saveGraph(g: CanvasGraph): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(g)); } catch { /* ignore */ }
}

// ── SkillCanvas class ─────────────────────────────────────────────────────────

export class SkillCanvas {
  private _graph: CanvasGraph;
  private _svg!: SVGSVGElement;
  private _nodesEl!: HTMLElement;
  private _viewport!: HTMLElement;

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

    // Palette sidebar
    const palette = document.createElement("div");
    palette.className = "skill-canvas-palette";
    palette.innerHTML = `<div class="skill-canvas-palette-title">Verbs</div>`;
    for (const verb of CANVAS_VERBS) {
      const item = document.createElement("div");
      item.className = "skill-canvas-palette-item";
      item.textContent = verb.replace(/^Ifc|^Sd/, "");
      item.title = verb;
      item.draggable = true;
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer!.setData("text/plain", verb);
        e.dataTransfer!.effectAllowed = "copy";
      });
      palette.appendChild(item);
    }
    this._root.appendChild(palette);

    // Viewport (canvas area)
    const viewport = document.createElement("div");
    viewport.className = "skill-canvas-viewport";
    this._viewport = viewport;

    // SVG edge layer
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "skill-canvas-svg");
    this._svg = svg;
    viewport.appendChild(svg);

    // Node layer
    const nodesEl = document.createElement("div");
    nodesEl.className = "skill-canvas-nodes";
    this._nodesEl = nodesEl;
    viewport.appendChild(nodesEl);

    // Drop target
    viewport.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
    viewport.addEventListener("drop", (e) => {
      e.preventDefault();
      const verb = e.dataTransfer!.getData("text/plain");
      if (!verb) return;
      const rect = viewport.getBoundingClientRect();
      this._addNode(verb, e.clientX - rect.left - 70, e.clientY - rect.top - 20);
    });

    // Global mouse events for drag + connect
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("mouseup",   this._onMouseUp);

    this._root.appendChild(viewport);

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "skill-canvas-toolbar";
    toolbar.innerHTML = `
      <button class="btn btn-sm sc-clear-btn" type="button">Clear</button>
      <button class="btn btn-sm sc-run-btn" type="button">Run</button>
      <button class="btn btn-accent btn-sm sc-compile-btn" type="button">Compile to skill</button>
    `;
    toolbar.querySelector(".sc-clear-btn")!.addEventListener("click", () => this._clear());
    toolbar.querySelector(".sc-run-btn")!.addEventListener("click", () => void this._run());
    toolbar.querySelector(".sc-compile-btn")!.addEventListener("click", () => this._compile());
    this._root.appendChild(toolbar);

    this._renderGraph();
  }

  // ── Graph mutation ─────────────────────────────────────────────────────────

  private _addNode(verb: string, x: number, y: number): void {
    const node: CanvasNode = { id: crypto.randomUUID(), verb, args: {}, x, y };
    this._graph.nodes.push(node);
    saveGraph(this._graph);
    this._renderGraph();
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
    el.innerHTML = `
      <div class="sc-node-header">
        <span class="sc-node-verb">${node.verb.replace(/^Ifc|^Sd/, "")}</span>
        <button class="sc-node-del" title="Remove" type="button">✕</button>
      </div>
      <div class="sc-node-ports">
        <div class="sc-port sc-port-in"  data-node="${node.id}" data-side="in"  title="Input"></div>
        <div class="sc-port sc-port-out" data-node="${node.id}" data-side="out" title="Output"></div>
      </div>
    `;
    el.querySelector(".sc-node-del")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this._removeNode(node.id);
    });
    // Node drag
    el.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).classList.contains("sc-port") ||
          (e.target as HTMLElement).classList.contains("sc-node-del")) return;
      e.preventDefault();
      this._dragNode = { id: node.id, ox: node.x, oy: node.y, sx: e.clientX, sy: e.clientY };
    });
    // Port connect
    el.querySelector(".sc-port-out")!.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._connectFrom = { id: node.id, side: "out" };
      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("class", "sc-edge-draft");
      this._svg.appendChild(line);
      this._connectLine = line;
    });
    el.querySelector(".sc-port-in")!.addEventListener("mouseup", (e) => {
      e.stopPropagation();
      if (!this._connectFrom) return;
      const fromId = this._connectFrom.id;
      const toId = node.id;
      if (fromId !== toId && !this._graph.edges.find(e2 => e2.from === fromId && e2.to === toId)) {
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
      const path = this._edgePath(from.x + 140, from.y + 36, to.x, to.y + 36);
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
    if (this._dragNode) {
      const d = this._dragNode;
      const node = this._graph.nodes.find(n => n.id === d.id);
      if (node) {
        node.x = Math.max(0, d.ox + e.clientX - d.sx);
        node.y = Math.max(0, d.oy + e.clientY - d.sy);
        const el = this._nodesEl.querySelector<HTMLElement>(`[data-id="${d.id}"]`);
        if (el) { el.style.left = `${node.x}px`; el.style.top = `${node.y}px`; }
        this._renderEdges();
      }
    }
    if (this._connectFrom && this._connectLine) {
      const from = this._graph.nodes.find(n => n.id === this._connectFrom!.id);
      if (from) {
        const vpRect = this._viewport.getBoundingClientRect();
        const x2 = e.clientX - vpRect.left;
        const y2 = e.clientY - vpRect.top;
        this._connectLine.setAttribute("d", this._edgePath(from.x + 140, from.y + 36, x2, y2));
      }
    }
  };

  private _onMouseUp = (e: MouseEvent): void => {
    if (this._dragNode) {
      saveGraph(this._graph);
      this._dragNode = null;
    }
    if (this._connectFrom) this._endConnect();
  };

  private _endConnect(): void {
    this._connectLine?.remove();
    this._connectLine = null;
    this._connectFrom = null;
  }

  // ── Run & Compile ──────────────────────────────────────────────────────────

  private async _run(): Promise<void> {
    const ordered = this._topoSort();
    for (const node of ordered) {
      dispatchSync(node.verb, node.args as DispatchArgs);
      await new Promise(r => setTimeout(r, 80));
    }
  }

  private _compile(): void {
    const steps: SkillStep[] = this._topoSort().map(n => ({ verb: n.verb, args: n.args }));
    if (steps.length === 0) return;
    openSaveSkillModal(steps);
  }

  // Simple topological sort using Kahn's algorithm.
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
    // Fallback: nodes not reached by topo (cycles) appended in position order
    const seen = new Set(order.map(n => n.id));
    const rest = this._graph.nodes.filter(n => !seen.has(n.id));
    rest.sort((a, b) => a.x - b.x);
    return [...order, ...rest];
  }

  // ── P5b: agent-triggered animation ────────────────────────────────────────

  // Build a fresh linear graph from steps, render it, then highlight each
  // node in topo order as its verb dispatches. Called by skill:animate event.
  async runWithAnimation(steps: SkillStep[]): Promise<void> {
    const nodes: CanvasNode[] = steps.map((step, i) => ({
      id: crypto.randomUUID(),
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
      dispatchSync(node.verb, node.args as DispatchArgs);
      await new Promise(r => setTimeout(r, 80));
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
