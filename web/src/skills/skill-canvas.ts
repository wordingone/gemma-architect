// skill-canvas.ts — #727: finished SKILL NODES feature.
//
// Section A: top toolbar (⏺ RECORD · Clear · Run · Save-as-skill)
// Section B: multi-IO ports, marquee select, Cmd-D/G, dblclick disconnect
// Section C: setNodeSelectHandler → workbench wires the right inspector
// Section D: recording (pointer | key | tool | dispatch | scene events + optional VP9)
// Section E: simple recording auto-saves; complex fires "record:complex-stop"

import { dispatchSync, registerPostDispatch, type DispatchArgs } from "../commands/dispatch";
import { compileDsl } from "../commands/dsl-eval";
import { saveSkill, listSavedSkills, listCanvasClusters, type SkillStep, type SavedSkill, type CanvasCluster } from "./skill-store";
import { openSaveSkillModal, openSaveClusterModal } from "./skill-modal";
import { subscribe as subscribeAppState, getState } from "../app-state";
import { seedStarterClusters, STARTER_IDS } from "./starter-clusters";


// ── Types ─────────────────────────────────────────────────────────────────────

export type CanvasNode = {
  id: string;
  kind?: "skill" | "script";
  skillId?: string;
  skillName?: string;
  skillSteps?: SkillStep[];
  scriptSource?: string;
  verb?: string;
  args?: Record<string, unknown>;
  x: number;
  y: number;
  inPorts: number;
  outPorts: number;
};

export type CanvasEdge = {
  id: string;
  from: string;
  fromPort: number;
  to: string;
  toPort: number;
};

export type CanvasGroup = {
  id: string;
  name: string;
  nodeIds: string[];
  color: string;
};

export type CanvasGraph = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  groups: CanvasGroup[];
};

export type RecordEvent =
  | { ts: number; kind: "pointer"; clientX: number; clientY: number; target: string; button: number }
  | { ts: number; kind: "key"; key: string; targetTag: string }
  | { ts: number; kind: "tool"; toolId: string; source: "click" | "hotkey" }
  | { ts: number; kind: "dispatch"; verb: string; args: Record<string, unknown>; resultUuid?: string }
  | { ts: number; kind: "scene"; action: "add" | "remove" | "move" | "select"; uuid: string };

export type RecordingArtifact = {
  duration_ms: number;
  events: RecordEvent[];
  videoBlob?: Blob;
  estimatedBytes: number;
};

export type RecordingAnalysis = {
  skills: Array<{ name: string; description: string; steps: SkillStep[] }>;
  wiring: Array<{ from: string; to: string }>;
};

// ── Persistence ───────────────────────────────────────────────────────────────

const LS_KEY = "gemma-cad:skill-canvas-v3";
const LS_KEY_V2 = "gemma-cad:skill-canvas-v2";
const LS_KEY_V1_A = "gemma-cad:skill-canvas-v1";
const LS_KEY_V1_B = "gemma-architect:skill-canvas-v1";

function migrateNode(n: Partial<CanvasNode>): CanvasNode {
  return {
    id: n.id ?? crypto.randomUUID(),
    kind: n.kind,
    skillId: n.skillId, skillName: n.skillName, skillSteps: n.skillSteps,
    scriptSource: n.scriptSource, verb: n.verb, args: n.args,
    x: n.x ?? 0, y: n.y ?? 0,
    inPorts: n.inPorts ?? 1,
    outPorts: n.outPorts ?? 1,
  };
}

function migrateEdge(e: Partial<CanvasEdge>): CanvasEdge {
  return {
    id: e.id ?? crypto.randomUUID(),
    from: e.from ?? "", fromPort: e.fromPort ?? 0,
    to: e.to ?? "", toPort: e.toPort ?? 0,
  };
}

function loadGraph(): CanvasGraph {
  try {
    const raw = localStorage.getItem(LS_KEY)
      ?? localStorage.getItem(LS_KEY_V2)
      ?? localStorage.getItem(LS_KEY_V1_A)
      ?? localStorage.getItem(LS_KEY_V1_B);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CanvasGraph>;
      return {
        nodes: (parsed.nodes ?? []).map(migrateNode),
        edges: (parsed.edges ?? []).map(migrateEdge),
        groups: parsed.groups ?? [],
      };
    }
  } catch { /* ignore */ }
  return { nodes: [], edges: [], groups: [] };
}

function saveGraph(g: CanvasGraph): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(g)); } catch { /* ignore */ }
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Port geometry
const PORT_START_Y = 44;
const PORT_SPACING = 18;
const NODE_WIDTH = 160;

function portY(portIdx: number): number {
  return PORT_START_Y + portIdx * PORT_SPACING;
}

// ── SkillCanvas class ─────────────────────────────────────────────────────────

export class SkillCanvas {
  private _graph: CanvasGraph;
  private _svg!: SVGSVGElement;
  private _nodesEl!: HTMLElement;
  private _transformEl!: HTMLElement;
  private _viewport!: HTMLElement;
  private _paletteEl!: HTMLElement;
  private _emptyHint: HTMLElement | null = null;

  // Selection
  private _selected = new Set<string>();

  // Pan/zoom
  private _tx = 0;
  private _ty = 0;
  private _tz = 1;
  private _panStart: { mx: number; my: number; tx: number; ty: number } | null = null;

  // Node drag
  private _dragNode: { id: string; ox: number; oy: number; sx: number; sy: number } | null = null;
  private _multiDragStart: Map<string, { ox: number; oy: number }> | null = null;

  // Marquee
  private _marqueeStart: { cx: number; cy: number } | null = null;
  private _marqueeEl: HTMLElement | null = null;

  // Port-connect
  private _connectFrom: { id: string; port: number } | null = null;
  private _connectLine: SVGPathElement | null = null;

  // Recording
  private _recording = false;
  private _recordEvents: RecordEvent[] = [];
  private _recordStart = 0;
  private _recordMediaRecorder: MediaRecorder | null = null;
  private _recordChunks: Blob[] = [];
  private _recordToolUnsubscribe: (() => void) | null = null;
  private _recordDispatchUnsubscribe: (() => void) | null = null;
  private _recordBtn: HTMLElement | null = null;
  private _recordStatus: HTMLElement | null = null;
  private _clusterBtn: HTMLButtonElement | null = null;

  // Inspector callback (set by workbench)
  private _onNodeSelect: ((nodeId: string | null) => void) | null = null;

  // Live re-dispatch state (#425)
  private _nodeHasResult = new Set<string>();
  private _paramTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private _root: HTMLElement) {
    this._graph = loadGraph();
    this._build();
    (window as unknown as Record<string, unknown>).__skillCanvas = this;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  setNodeSelectHandler(fn: ((nodeId: string | null) => void) | null): void {
    this._onNodeSelect = fn;
  }

  getNode(id: string): CanvasNode | undefined {
    return this._graph.nodes.find(n => n.id === id);
  }

  getGraph(): CanvasGraph {
    return this._graph;
  }

  updateNodeScript(id: string, src: string): void {
    const node = this._graph.nodes.find(n => n.id === id);
    if (node) { node.scriptSource = src; saveGraph(this._graph); }
  }

  // Live re-dispatch: called by workbench inspector on slider/input change (#425).
  // Debounces 150ms, undoes prior result, re-dispatches with updated args.
  updateNodeArg(nodeId: string, stepIdx: number, key: string, value: unknown): void {
    const node = this._graph.nodes.find(n => n.id === nodeId);
    if (!node || !node.skillSteps) return;
    const step = node.skillSteps[stepIdx];
    if (!step) return;
    step.args = { ...step.args, [key]: value };
    saveGraph(this._graph);

    const prev = this._paramTimers.get(nodeId);
    if (prev !== undefined) clearTimeout(prev);
    this._paramTimers.set(nodeId, setTimeout(() => {
      this._paramTimers.delete(nodeId);
      void this._redispatchNode(nodeId);
    }, 150));
  }

  private async _redispatchNode(nodeId: string): Promise<void> {
    const node = this._graph.nodes.find(n => n.id === nodeId);
    if (!node) return;
    if (this._nodeHasResult.has(nodeId)) {
      dispatchSync("SdUndo", {});
      this._nodeHasResult.delete(nodeId);
    }
    const el = this._nodesEl.querySelector<HTMLElement>(`[data-id="${nodeId}"]`);
    el?.classList.add("node-running");
    await this._runNode(node);
    el?.classList.remove("node-running");

    // Cascade to downstream nodes in topological order (#426 SU-4).
    const downstreamIds = this._getDownstream(nodeId);
    if (downstreamIds.size > 0) {
      const topoOrder = this._topoSort();
      // Undo downstream results in reverse topo order before re-running.
      for (let i = topoOrder.length - 1; i >= 0; i--) {
        const n = topoOrder[i];
        if (!downstreamIds.has(n.id) || !this._nodeHasResult.has(n.id)) continue;
        dispatchSync("SdUndo", {});
        this._nodeHasResult.delete(n.id);
      }
      // Re-dispatch downstream in forward topo order.
      for (const n of topoOrder) {
        if (!downstreamIds.has(n.id)) continue;
        const el2 = this._nodesEl.querySelector<HTMLElement>(`[data-id="${n.id}"]`);
        el2?.classList.add("node-running");
        await this._runNode(n);
        el2?.classList.remove("node-running");
      }
    }

    (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
  }

  async refreshPalette(): Promise<void> {
    await this._buildPalette();
  }

  loadAnalysis(skills: RecordingAnalysis["skills"], wiring: RecordingAnalysis["wiring"]): void {
    const nodes: CanvasNode[] = skills.map((sk, i) => ({
      id: crypto.randomUUID(), kind: "skill" as const,
      skillId: sk.name, skillName: sk.name,
      skillSteps: sk.steps,
      x: 20 + i * 190, y: 80,
      inPorts: i > 0 ? 1 : 0,
      outPorts: i < skills.length - 1 ? 1 : 0,
    }));
    const idxById = new Map(nodes.map((n, i) => [n.skillName ?? n.skillId ?? "", i]));
    const edges: CanvasEdge[] = wiring.map(w => ({
      id: crypto.randomUUID(),
      from: nodes[idxById.get(w.from) ?? 0]?.id ?? "",
      fromPort: 0,
      to: nodes[idxById.get(w.to) ?? 0]?.id ?? "",
      toPort: 0,
    })).filter(e => e.from && e.to);
    this._graph = { nodes, edges, groups: [] };
    saveGraph(this._graph);
    this._renderGraph();
  }

  startRecording(): void {
    if (this._recording) return;
    this._recording = true;
    this._recordEvents = [];
    this._recordStart = Date.now();
    this._recordChunks = [];

    // Tool subscription
    const prevTool = getState("activeTool") as string;
    let lastTool = prevTool;
    this._recordToolUnsubscribe = subscribeAppState("activeTool", (tool) => {
      if (tool !== lastTool) {
        this._recordEvents.push({ ts: Date.now() - this._recordStart, kind: "tool", toolId: String(tool), source: "click" });
        lastTool = String(tool);
      }
    });

    // Dispatch subscription
    this._recordDispatchUnsubscribe = registerPostDispatch((verb, args) => {
      if (!this._recording) return;
      this._recordEvents.push({
        ts: Date.now() - this._recordStart, kind: "dispatch",
        verb, args: args as Record<string, unknown>,
      });
    });

    // Pointer events
    window.addEventListener("pointerdown", this._onRecordPointer, { capture: true, passive: true });
    // Key events
    window.addEventListener("keydown", this._onRecordKey, { capture: true, passive: true });
    // Scene select
    window.addEventListener("viewer:select", this._onRecordSelect as EventListener);

    // Optional VP9 capture — find the Three.js canvas
    try {
      const canvas = document.querySelector<HTMLCanvasElement>("#viewport-2 canvas");
      if (canvas && typeof (canvas as HTMLCanvasElement & { captureStream?: (fps: number) => MediaStream }).captureStream === "function") {
        const stream = (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(10);
        const mr = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
        mr.ondataavailable = (ev) => { if (ev.data.size > 0) this._recordChunks.push(ev.data); };
        mr.start(500);
        this._recordMediaRecorder = mr;
      }
    } catch { /* VP9 capture optional */ }

    this._updateRecordUI();
  }

  stopRecording(): RecordingArtifact | null {
    if (!this._recording) return null;
    this._recording = false;
    const duration_ms = Date.now() - this._recordStart;

    // Teardown
    window.removeEventListener("pointerdown", this._onRecordPointer, { capture: true });
    window.removeEventListener("keydown", this._onRecordKey, { capture: true });
    window.removeEventListener("viewer:select", this._onRecordSelect as EventListener);
    this._recordToolUnsubscribe?.();
    this._recordToolUnsubscribe = null;
    this._recordDispatchUnsubscribe?.();
    this._recordDispatchUnsubscribe = null;

    let videoBlob: Blob | undefined;
    if (this._recordMediaRecorder) {
      this._recordMediaRecorder.stop();
      if (this._recordChunks.length > 0) {
        videoBlob = new Blob(this._recordChunks, { type: "video/webm" });
      }
      this._recordMediaRecorder = null;
    }

    const events = [...this._recordEvents];
    const estimatedBytes = JSON.stringify(events).length + (videoBlob?.size ?? 0);
    this._recordEvents = [];

    this._updateRecordUI();

    const artifact: RecordingArtifact = { duration_ms, events, videoBlob, estimatedBytes };
    this._classifyAndSave(artifact);
    return artifact;
  }

  // ── Build DOM ──────────────────────────────────────────────────────────────

  private _build(): void {
    this._root.innerHTML = "";
    this._root.className = "skill-canvas-root";
    this._root.style.cssText = "display:flex; flex-direction:column; height:100%; overflow:hidden;";

    // ── Top toolbar ──────────────────────────────────────────────────────────
    const toolbar = document.createElement("div");
    toolbar.className = "skill-canvas-toolbar sc-toolbar-top";

    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.className = "btn btn-sm sc-record-btn";
    recordBtn.innerHTML = `<span class="sc-record-dot">⏺</span> RECORD`;
    this._recordBtn = recordBtn;

    const recordStatus = document.createElement("span");
    recordStatus.className = "sc-record-status";
    this._recordStatus = recordStatus;

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "btn btn-sm sc-clear-btn";
    clearBtn.textContent = "Clear";

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "btn btn-sm sc-run-btn";
    runBtn.textContent = "▶ Run";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-accent btn-sm sc-compile-btn";
    saveBtn.textContent = "Save as skill";

    const clusterBtn = document.createElement("button");
    clusterBtn.type = "button";
    clusterBtn.className = "btn btn-sm sc-cluster-btn";
    clusterBtn.textContent = "Save cluster";
    clusterBtn.title = "Save selected nodes as a reusable cluster";
    clusterBtn.disabled = true;

    recordBtn.addEventListener("click", () => {
      if (this._recording) this.stopRecording();
      else this.startRecording();
    });
    clearBtn.addEventListener("click", () => this._clear());
    runBtn.addEventListener("click", () => void this._run());
    saveBtn.addEventListener("click", () => this._compile());
    clusterBtn.addEventListener("click", () => void this._saveSelectedAsCluster());

    toolbar.append(recordBtn, recordStatus, clearBtn, runBtn, saveBtn, clusterBtn);
    this._clusterBtn = clusterBtn;
    this._root.appendChild(toolbar);

    // ── Main row (palette + viewport) ────────────────────────────────────────
    const mainRow = document.createElement("div");
    mainRow.style.cssText = "display:flex; flex:1; min-height:0; overflow:hidden;";

    // Palette sidebar
    const palette = document.createElement("div");
    palette.className = "skill-canvas-palette";
    palette.innerHTML = `<div class="skill-canvas-palette-title">Loading…</div>`;
    this._paletteEl = palette;
    mainRow.appendChild(palette);

    // Viewport
    const viewport = document.createElement("div");
    viewport.className = "skill-canvas-viewport";
    this._viewport = viewport;

    // Pan/zoom transform layer
    const transformEl = document.createElement("div");
    transformEl.className = "skill-canvas-transform";
    this._transformEl = transformEl;
    this._applyTransform();

    // SVG edge layer
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "skill-canvas-svg");
    this._svg = svg;
    transformEl.appendChild(svg);

    // Node layer
    const nodesEl = document.createElement("div");
    nodesEl.className = "skill-canvas-nodes";
    this._nodesEl = nodesEl;
    transformEl.appendChild(nodesEl);

    // Marquee overlay
    const marqueeEl = document.createElement("div");
    marqueeEl.className = "sc-marquee";
    marqueeEl.style.display = "none";
    viewport.appendChild(marqueeEl);
    this._marqueeEl = marqueeEl;

    viewport.appendChild(transformEl);

    // Viewport interactions
    viewport.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; });
    viewport.addEventListener("drop", (e) => {
      e.preventDefault();
      const raw = e.dataTransfer!.getData("text/plain");
      if (!raw) return;
      const rect = viewport.getBoundingClientRect();
      const cx = (e.clientX - rect.left - this._tx) / this._tz - 80;
      const cy = (e.clientY - rect.top  - this._ty) / this._tz - 20;
      try {
        const d = JSON.parse(raw) as { kind: string; skillId?: string; skillName?: string; skillSteps?: SkillStep[] };
        if (d.kind === "skill") {
          this._addSkillNode(d.skillId ?? d.skillName ?? "skill", d.skillName ?? "skill", d.skillSteps ?? [], cx, cy);
        } else {
          this._addScriptNode(cx, cy);
        }
      } catch { /* ignore */ }
    });

    // Pan: middle-mouse drag
    viewport.addEventListener("mousedown", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this._panStart = { mx: e.clientX, my: e.clientY, tx: this._tx, ty: this._ty };
      } else if (e.button === 0 && e.target === viewport || e.target === transformEl || e.target === nodesEl || e.target === svg) {
        // Marquee start (click on empty canvas)
        const rect = viewport.getBoundingClientRect();
        const cx = (e.clientX - rect.left - this._tx) / this._tz;
        const cy = (e.clientY - rect.top  - this._ty) / this._tz;
        this._marqueeStart = { cx, cy };
        // Deselect on blank click without shift
        if (!e.shiftKey) {
          this._selected.clear();
          this._updateSelection();
          this._onNodeSelect?.(null);
        }
      }
    });

    // Zoom: wheel
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

    // Keyboard shortcuts
    window.addEventListener("keydown", this._onKeyDown);

    mainRow.appendChild(viewport);
    this._root.appendChild(mainRow);

    this._renderGraph();
    void this._buildPalette();
    window.addEventListener("skillstore:cluster-saved", () => { void this._buildPalette(); });
  }

  private _applyTransform(): void {
    this._transformEl.style.transform = `translate(${this._tx}px,${this._ty}px) scale(${this._tz})`;
  }

  private _updateRecordUI(): void {
    if (!this._recordBtn || !this._recordStatus) return;
    if (this._recording) {
      this._recordBtn.classList.add("sc-recording");
      this._recordBtn.innerHTML = `<span class="sc-record-dot sc-record-active">⏹</span> STOP`;
      this._recordStatus.textContent = "Recording…";
    } else {
      this._recordBtn.classList.remove("sc-recording");
      this._recordBtn.innerHTML = `<span class="sc-record-dot">⏺</span> RECORD`;
      this._recordStatus.textContent = "";
    }
  }

  // ── Palette ────────────────────────────────────────────────────────────────

  private async _buildPalette(): Promise<void> {
    await seedStarterClusters();
    const [saved, clusters] = await Promise.all([
      listSavedSkills().catch(() => [] as SavedSkill[]),
      listCanvasClusters().catch(() => [] as CanvasCluster[]),
    ]);

    const starterClusters = clusters.filter(c => STARTER_IDS.has(c.id));
    const userClusters    = clusters.filter(c => !STARTER_IDS.has(c.id));

    this._paletteEl.innerHTML = "";

    // Template: + Skill
    const skillItem = document.createElement("div");
    skillItem.className = "skill-canvas-palette-item sc-palette-template";
    skillItem.dataset.template = "skill";
    skillItem.textContent = "+ Skill";
    skillItem.title = "Drag to add an empty skill node";
    skillItem.draggable = true;
    skillItem.addEventListener("dragstart", (e) => {
      e.dataTransfer!.setData("text/plain", JSON.stringify({ kind: "skill", skillId: "", skillName: "untitled skill", skillSteps: [] }));
      e.dataTransfer!.effectAllowed = "copy";
    });
    skillItem.addEventListener("dblclick", () => {
      const rect = this._viewport.getBoundingClientRect();
      this._addSkillNode("", "untitled skill", [],
        (rect.width  / 2 - this._tx) / this._tz - 80,
        (rect.height / 2 - this._ty) / this._tz - 20);
    });
    this._paletteEl.appendChild(skillItem);

    // Template: + Script
    const scriptItem = document.createElement("div");
    scriptItem.className = "skill-canvas-palette-item sc-palette-template";
    scriptItem.dataset.template = "script";
    scriptItem.textContent = "+ Script";
    scriptItem.title = "Drag to add an inline DSL/JS script node";
    scriptItem.draggable = true;
    scriptItem.addEventListener("dragstart", (e) => {
      e.dataTransfer!.setData("text/plain", JSON.stringify({ kind: "script" }));
      e.dataTransfer!.effectAllowed = "copy";
    });
    scriptItem.addEventListener("dblclick", () => this._addScriptAtCenter());
    this._paletteEl.appendChild(scriptItem);

    // ── Starter Library section ───────────────────────────────────────────────
    if (starterClusters.length > 0) {
      const starterTitle = document.createElement("div");
      starterTitle.className = "skill-canvas-palette-title";
      starterTitle.style.marginTop = "10px";
      starterTitle.textContent = "Starter Library";
      this._paletteEl.appendChild(starterTitle);
      for (const cluster of starterClusters) {
        this._paletteEl.appendChild(this._makeClusterItem(cluster));
      }
    }

    // Saved skills
    if (saved.length > 0) {
      const title = document.createElement("div");
      title.className = "skill-canvas-palette-title";
      title.style.marginTop = "8px";
      title.textContent = "Saved";
      this._paletteEl.appendChild(title);
      for (const skill of saved) {
        this._paletteEl.appendChild(this._makePaletteItem(skill.name, skill.steps.length, {
          kind: "skill", skillId: skill.id, skillName: skill.name, skillSteps: skill.steps,
        }));
      }
    } else {
      const hint = document.createElement("div");
      hint.className = "sc-palette-empty-hint";
      hint.textContent = "No saved skills yet — record one with ⏺ RECORD.";
      this._paletteEl.appendChild(hint);
    }

    // ── User clusters section ─────────────────────────────────────────────────
    if (userClusters.length > 0) {
      const clusterTitle = document.createElement("div");
      clusterTitle.className = "skill-canvas-palette-title";
      clusterTitle.style.marginTop = "10px";
      clusterTitle.textContent = "Clusters";
      this._paletteEl.appendChild(clusterTitle);
      for (const cluster of userClusters) {
        this._paletteEl.appendChild(this._makeClusterItem(cluster));
      }
    }
  }

  private _makeClusterItem(cluster: CanvasCluster): HTMLElement {
    const item = document.createElement("div");
    item.className = "skill-canvas-palette-item";
    item.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:4px;";
    item.title = cluster.description ?? cluster.name;
    item.innerHTML = `
      <span class="sc-pal-name" style="overflow:hidden;text-overflow:ellipsis;">${escHtml(cluster.name)}</span>
      <span style="display:flex;gap:3px;flex-shrink:0;">
        <span class="sc-cluster-load-btn" title="Load cluster onto canvas" style="cursor:pointer;padding:1px 4px;border-radius:2px;font-size:9px;background:var(--paper-3,#2a2a2a);">load</span>
        <span class="sc-cluster-export-btn" title="Export as .skill file" style="cursor:pointer;padding:1px 4px;border-radius:2px;font-size:9px;background:var(--paper-3,#2a2a2a);">↓</span>
      </span>
    `;
    item.querySelector(".sc-cluster-load-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      this.loadCanvasCluster(cluster);
    });
    item.querySelector(".sc-cluster-export-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      SkillCanvas.exportClusterFile(cluster);
    });
    return item;
  }

  private _makePaletteItem(
    name: string,
    stepCount: number,
    dragData: { kind: string; skillId?: string; skillName?: string; skillSteps?: SkillStep[] }
  ): HTMLElement {
    const item = document.createElement("div");
    item.className = "skill-canvas-palette-item";
    item.innerHTML = `<span class="sc-pal-name">${escHtml(name)}</span><span class="sc-pal-badge">${stepCount}</span>`;
    item.title = `${name} · ${stepCount} step${stepCount === 1 ? "" : "s"} — drag or double-click`;
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
        cx, cy,
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
      inPorts: 1, outPorts: 1,
    });
    saveGraph(this._graph);
    this._renderGraph();
  }

  private _addScriptNode(x: number, y: number): void {
    this._graph.nodes.push({
      id: crypto.randomUUID(), kind: "script",
      scriptSource: "",
      x: Math.max(0, x), y: Math.max(0, y),
      inPorts: 1, outPorts: 1,
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
    // Undo this node's last dispatch result before removing (#425)
    if (this._nodeHasResult.has(id)) {
      dispatchSync("SdUndo", {});
      this._nodeHasResult.delete(id);
    }
    const timer = this._paramTimers.get(id);
    if (timer !== undefined) { clearTimeout(timer); this._paramTimers.delete(id); }

    this._graph.nodes = this._graph.nodes.filter(n => n.id !== id);
    this._graph.edges = this._graph.edges.filter(e => e.from !== id && e.to !== id);
    this._graph.groups = this._graph.groups.map(g => ({
      ...g, nodeIds: g.nodeIds.filter(nid => nid !== id)
    })).filter(g => g.nodeIds.length > 0);
    this._selected.delete(id);
    saveGraph(this._graph);
    this._renderGraph();
  }

  private _clear(): void {
    for (const timer of this._paramTimers.values()) clearTimeout(timer);
    this._paramTimers.clear();
    this._nodeHasResult.clear();
    this._graph = { nodes: [], edges: [], groups: [] };
    this._selected.clear();
    saveGraph(this._graph);
    this._renderGraph();
  }

  private _duplicateSelected(): void {
    if (this._selected.size === 0) return;
    const newIds: string[] = [];
    for (const id of this._selected) {
      const n = this._graph.nodes.find(x => x.id === id);
      if (!n) continue;
      const newId = crypto.randomUUID();
      this._graph.nodes.push({ ...n, id: newId, x: n.x + 20, y: n.y + 20 });
      newIds.push(newId);
    }
    this._selected.clear();
    newIds.forEach(id => this._selected.add(id));
    saveGraph(this._graph);
    this._renderGraph();
  }

  private _groupSelected(): void {
    if (this._selected.size < 2) return;
    const group: CanvasGroup = {
      id: crypto.randomUUID(),
      name: "Group",
      nodeIds: [...this._selected],
      color: "#2a4060",
    };
    this._graph.groups.push(group);
    saveGraph(this._graph);
    this._renderGraph();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private _renderGraph(): void {
    this._nodesEl.innerHTML = "";
    if (this._graph.nodes.length === 0) {
      if (!this._emptyHint) {
        const hint = document.createElement("div");
        hint.className = "sc-canvas-empty-hint";
        hint.textContent = "Drag a Skill or Script to begin";
        this._viewport.appendChild(hint);
        this._emptyHint = hint;
      }
    } else if (this._emptyHint) {
      this._emptyHint.remove();
      this._emptyHint = null;
    }
    // Group backdrops (behind nodes)
    for (const group of this._graph.groups) {
      this._nodesEl.appendChild(this._buildGroupEl(group));
    }
    for (const node of this._graph.nodes) {
      this._nodesEl.appendChild(this._buildNodeEl(node));
    }
    this._renderEdges();
    this._updateSelection();
  }

  private _buildGroupEl(group: CanvasGroup): HTMLElement {
    const nodeRects = group.nodeIds.map(id => this._graph.nodes.find(n => n.id === id)).filter(Boolean) as CanvasNode[];
    if (nodeRects.length === 0) return document.createElement("div");
    const xs = nodeRects.map(n => n.x);
    const ys = nodeRects.map(n => n.y);
    const minX = Math.min(...xs) - 12;
    const minY = Math.min(...ys) - 28;
    const maxX = Math.max(...xs) + NODE_WIDTH + 12;
    const maxY = Math.max(...ys) + 80 + 12;

    const el = document.createElement("div");
    el.className = "sc-group";
    el.style.cssText = `left:${minX}px; top:${minY}px; width:${maxX - minX}px; height:${maxY - minY}px; background:${group.color}22; border:1px solid ${group.color}55; border-radius:4px; position:absolute;`;
    const label = document.createElement("div");
    label.className = "sc-group-label";
    label.style.cssText = `position:absolute; top:4px; left:8px; font-size:10px; color:${group.color}; font-weight:600; letter-spacing:.05em;`;
    label.textContent = group.name;
    label.contentEditable = "true";
    label.spellcheck = false;
    label.addEventListener("input", () => { group.name = label.textContent ?? "Group"; saveGraph(this._graph); });
    el.appendChild(label);
    return el;
  }

  private _buildNodeEl(node: CanvasNode): HTMLElement {
    const el = document.createElement("div");
    el.className = "sc-node";
    el.dataset.id = node.id;
    el.style.cssText = `left:${node.x}px; top:${node.y}px;`;

    const inPorts = node.inPorts ?? 1;
    const outPorts = node.outPorts ?? 1;

    const buildPorts = (count: number, side: "in" | "out"): HTMLElement => {
      const wrap = document.createElement("div");
      wrap.className = `sc-ports sc-ports-${side}`;
      for (let i = 0; i < count; i++) {
        const port = document.createElement("div");
        port.className = `sc-port sc-port-${side}`;
        port.dataset.node = node.id;
        port.dataset.side = side;
        port.dataset.port = String(i);
        port.title = `${side === "in" ? "Input" : "Output"} ${i}`;
        wrap.appendChild(port);
      }
      const addPort = document.createElement("div");
      addPort.className = "sc-port-add";
      addPort.title = `Add ${side} port`;
      addPort.textContent = "+";
      addPort.addEventListener("click", (e) => {
        e.stopPropagation();
        if (side === "in") node.inPorts = (node.inPorts ?? 1) + 1;
        else node.outPorts = (node.outPorts ?? 1) + 1;
        saveGraph(this._graph);
        this._renderGraph();
      });
      wrap.appendChild(addPort);
      return wrap;
    };

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
      `;
      el.querySelector<HTMLTextAreaElement>(".sc-script-src")!.addEventListener("input", (ev) => {
        node.scriptSource = (ev.target as HTMLTextAreaElement).value;
        saveGraph(this._graph);
      });
    } else {
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
      `;
    }

    // Ports
    if (inPorts > 0) {
      const inEl = buildPorts(inPorts, "in");
      inEl.style.cssText = "position:absolute; left:-8px; top:0; display:flex; flex-direction:column; gap:4px;";
      el.appendChild(inEl);
    }
    if (outPorts > 0) {
      const outEl = buildPorts(outPorts, "out");
      outEl.style.cssText = "position:absolute; right:-8px; top:0; display:flex; flex-direction:column; gap:4px;";
      el.appendChild(outEl);
    }

    // Delete
    el.querySelector(".sc-node-del")!.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._removeNode(node.id);
    });

    // Select on click
    el.addEventListener("mousedown", (ev) => {
      const t = ev.target as HTMLElement;
      if (t.classList.contains("sc-port") || t.classList.contains("sc-port-add") ||
          t.classList.contains("sc-node-del") || t.tagName === "TEXTAREA") return;
      ev.preventDefault();
      ev.stopPropagation();

      if (ev.shiftKey) {
        if (this._selected.has(node.id)) this._selected.delete(node.id);
        else this._selected.add(node.id);
      } else {
        if (!this._selected.has(node.id)) {
          this._selected.clear();
          this._selected.add(node.id);
        }
      }
      this._updateSelection();
      this._onNodeSelect?.(node.id);

      // Start drag
      this._dragNode = { id: node.id, ox: node.x, oy: node.y, sx: ev.clientX, sy: ev.clientY };
      if (this._selected.size > 1) {
        // Capture starting positions of all selected for multi-drag
        this._multiDragStart = new Map(
          [...this._selected].map(id => {
            const n = this._graph.nodes.find(x => x.id === id);
            return [id, { ox: n?.x ?? 0, oy: n?.y ?? 0 }];
          })
        );
      } else {
        this._multiDragStart = null;
      }
    });

    // Wire from output port
    el.querySelectorAll<HTMLElement>(".sc-port-out").forEach((portEl) => {
      portEl.addEventListener("mousedown", (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        const portIdx = parseInt(portEl.dataset.port ?? "0", 10);
        this._connectFrom = { id: node.id, port: portIdx };
        const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
        line.setAttribute("class", "sc-edge-draft");
        this._svg.appendChild(line);
        this._connectLine = line;
      });
    });

    // Accept wire on input port; dblclick = disconnect all edges to this port
    el.querySelectorAll<HTMLElement>(".sc-port-in").forEach((portEl) => {
      portEl.addEventListener("mouseup", (ev) => {
        ev.stopPropagation();
        if (!this._connectFrom) return;
        const fromId = this._connectFrom.id;
        const fromPort = this._connectFrom.port;
        const toPort = parseInt(portEl.dataset.port ?? "0", 10);
        if (fromId !== node.id && !this._graph.edges.find(e => e.from === fromId && e.to === node.id && e.fromPort === fromPort && e.toPort === toPort)) {
          if (this._hasCycle(fromId, node.id)) {
            portEl.setAttribute("data-cycle-reject", "1");
            setTimeout(() => portEl.removeAttribute("data-cycle-reject"), 500);
          } else {
            this._graph.edges.push({ id: crypto.randomUUID(), from: fromId, fromPort, to: node.id, toPort });
            saveGraph(this._graph);
          }
        }
        this._endConnect();
        this._renderGraph();
      });
      portEl.addEventListener("dblclick", (ev) => {
        ev.stopPropagation();
        const toPort = parseInt(portEl.dataset.port ?? "0", 10);
        this._graph.edges = this._graph.edges.filter(e => !(e.to === node.id && e.toPort === toPort));
        saveGraph(this._graph);
        this._renderGraph();
      });
    });

    return el;
  }

  private _renderEdges(): void {
    this._svg.innerHTML = "";
    // SVG must cover the full canvas content area
    const allX = this._graph.nodes.map(n => n.x + NODE_WIDTH);
    const allY = this._graph.nodes.map(n => n.y + 120);
    const w = Math.max(2000, ...allX);
    const h = Math.max(2000, ...allY);
    this._svg.setAttribute("width", String(w));
    this._svg.setAttribute("height", String(h));

    for (const edge of this._graph.edges) {
      const from = this._graph.nodes.find(n => n.id === edge.from);
      const to   = this._graph.nodes.find(n => n.id === edge.to);
      if (!from || !to) continue;

      const x1 = from.x + NODE_WIDTH;
      const y1 = portY(edge.fromPort);
      const x2 = to.x;
      const y2 = portY(edge.toPort);

      const path = this._edgePath(x1, y1, x2, y2);
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

  private _updateSelection(): void {
    this._nodesEl.querySelectorAll<HTMLElement>(".sc-node").forEach(el => {
      const id = el.dataset.id ?? "";
      el.classList.toggle("sc-node-selected", this._selected.has(id));
    });
    if (this._clusterBtn) this._clusterBtn.disabled = this._selected.size === 0;
  }

  // ── Mouse handlers ─────────────────────────────────────────────────────────

  private _onMouseMove = (e: MouseEvent): void => {
    if (this._panStart) {
      this._tx = this._panStart.tx + e.clientX - this._panStart.mx;
      this._ty = this._panStart.ty + e.clientY - this._panStart.my;
      this._applyTransform();
    }

    if (this._dragNode) {
      const d = this._dragNode;
      const dx = (e.clientX - d.sx) / this._tz;
      const dy = (e.clientY - d.sy) / this._tz;
      if (this._multiDragStart && this._selected.size > 1) {
        for (const [id, { ox, oy }] of this._multiDragStart) {
          const n = this._graph.nodes.find(x => x.id === id);
          if (n) {
            n.x = Math.max(0, ox + dx);
            n.y = Math.max(0, oy + dy);
            const el = this._nodesEl.querySelector<HTMLElement>(`[data-id="${id}"]`);
            if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
          }
        }
      } else {
        const n = this._graph.nodes.find(x => x.id === d.id);
        if (n) {
          n.x = Math.max(0, d.ox + dx);
          n.y = Math.max(0, d.oy + dy);
          const el = this._nodesEl.querySelector<HTMLElement>(`[data-id="${d.id}"]`);
          if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
        }
      }
      this._renderEdges();
    }

    // Marquee
    if (this._marqueeStart && this._marqueeEl) {
      const vpRect = this._viewport.getBoundingClientRect();
      const cx = (e.clientX - vpRect.left - this._tx) / this._tz;
      const cy = (e.clientY - vpRect.top  - this._ty) / this._tz;
      const x0 = Math.min(this._marqueeStart.cx, cx);
      const y0 = Math.min(this._marqueeStart.cy, cy);
      const x1 = Math.max(this._marqueeStart.cx, cx);
      const y1 = Math.max(this._marqueeStart.cy, cy);
      // Display in screen space (viewport-relative)
      const sx0 = x0 * this._tz + this._tx;
      const sy0 = y0 * this._tz + this._ty;
      this._marqueeEl.style.cssText = `display:block; position:absolute; left:${sx0}px; top:${sy0}px; width:${(x1-x0)*this._tz}px; height:${(y1-y0)*this._tz}px; border:1px dashed var(--accent,#4af); background:rgba(68,170,255,.08); pointer-events:none; z-index:10;`;
    }

    // Edge draft
    if (this._connectFrom && this._connectLine) {
      const from = this._graph.nodes.find(n => n.id === this._connectFrom!.id);
      if (from) {
        const vpRect = this._viewport.getBoundingClientRect();
        const x2 = (e.clientX - vpRect.left - this._tx) / this._tz;
        const y2 = (e.clientY - vpRect.top  - this._ty) / this._tz;
        this._connectLine.setAttribute("d", this._edgePath(from.x + NODE_WIDTH, portY(this._connectFrom.port), x2, y2));
      }
    }
  };

  private _onMouseUp = (e: MouseEvent): void => {
    if (this._dragNode) { saveGraph(this._graph); this._dragNode = null; this._multiDragStart = null; }
    if (this._panStart) this._panStart = null;
    if (this._connectFrom) this._endConnect();

    // Finish marquee
    if (this._marqueeStart) {
      const vpRect = this._viewport.getBoundingClientRect();
      const cx = (e.clientX - vpRect.left - this._tx) / this._tz;
      const cy = (e.clientY - vpRect.top  - this._ty) / this._tz;
      const x0 = Math.min(this._marqueeStart.cx, cx);
      const y0 = Math.min(this._marqueeStart.cy, cy);
      const x1 = Math.max(this._marqueeStart.cx, cx);
      const y1 = Math.max(this._marqueeStart.cy, cy);
      if (x1 - x0 > 4 || y1 - y0 > 4) {
        // Select intersecting nodes
        if (!e.shiftKey) this._selected.clear();
        for (const n of this._graph.nodes) {
          if (n.x < x1 && n.x + NODE_WIDTH > x0 && n.y < y1 && n.y + 80 > y0) {
            this._selected.add(n.id);
          }
        }
        this._updateSelection();
        if (this._selected.size === 1) this._onNodeSelect?.([...this._selected][0]);
        else if (this._selected.size === 0) this._onNodeSelect?.(null);
      }
      this._marqueeStart = null;
      if (this._marqueeEl) this._marqueeEl.style.display = "none";
    }
  };

  private _onKeyDown = (e: KeyboardEvent): void => {
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) return;

    if (e.key === "Delete" || e.key === "Backspace") {
      for (const id of this._selected) this._removeNode(id);
      this._selected.clear();
      this._onNodeSelect?.(null);
    } else if ((e.metaKey || e.ctrlKey) && e.key === "d") {
      e.preventDefault();
      this._duplicateSelected();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "g") {
      e.preventDefault();
      this._groupSelected();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
      if (this._selected.size === 0) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      for (const id of this._selected) {
        const n = this._graph.nodes.find(x => x.id === id);
        if (n) { n.x = Math.max(0, n.x + dx); n.y = Math.max(0, n.y + dy); }
      }
      saveGraph(this._graph);
      this._renderGraph();
    }
  };

  private _endConnect(): void {
    this._connectLine?.remove();
    this._connectLine = null;
    this._connectFrom = null;
  }

  // ── Recording event listeners ──────────────────────────────────────────────

  private _onRecordPointer = (e: PointerEvent): void => {
    if (!this._recording) return;
    const target = e.target instanceof Element ? e.target.className?.toString().slice(0, 40) : "?";
    this._recordEvents.push({
      ts: Date.now() - this._recordStart,
      kind: "pointer", clientX: e.clientX, clientY: e.clientY,
      target, button: e.button,
    });
  };

  private _onRecordKey = (e: KeyboardEvent): void => {
    if (!this._recording) return;
    // Skip modifier-only keys
    if (["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
    this._recordEvents.push({
      ts: Date.now() - this._recordStart,
      kind: "key", key: e.key,
      targetTag: (e.target instanceof Element ? e.target.tagName : "?"),
    });
  };

  private _onRecordSelect = (rawEv: Event): void => {
    if (!this._recording) return;
    const ev = rawEv as CustomEvent<{ uuid: string | null }>;
    const uuid = ev.detail?.uuid;
    if (uuid) {
      this._recordEvents.push({ ts: Date.now() - this._recordStart, kind: "scene", action: "select", uuid });
    }
  };

  // ── Recording classification & save ───────────────────────────────────────

  private _classifyAndSave(artifact: RecordingArtifact): void {
    const steps: SkillStep[] = (artifact.events.filter(e => e.kind === "dispatch") as Array<{ ts: number; kind: "dispatch"; verb: string; args: Record<string, unknown>; resultUuid?: string }>)
      .map(e => ({ verb: e.verb, args: e.args }));
    if (steps.length === 0) return;
    openSaveSkillModal(steps);
    void this.refreshPalette();
  }

  // ── Run & Compile ──────────────────────────────────────────────────────────

  private async _run(): Promise<void> {
    for (const node of this._topoSort()) {
      const el = this._nodesEl.querySelector<HTMLElement>(`[data-id="${node.id}"]`);
      el?.classList.add("node-running");
      await this._runNode(node);
      el?.classList.remove("node-running");
    }
    (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
  }

  private async _runNode(node: CanvasNode): Promise<void> {
    let dispatched = false;
    if (node.kind === "script") {
      const src = node.scriptSource?.trim() ?? "";
      if (!src) return;
      const result = compileDsl(src);
      if (!result.ok) return;
      for (const d of result.dispatches ?? []) {
        dispatchSync(d.verb, d.args as DispatchArgs);
        dispatched = true;
        await new Promise(r => setTimeout(r, 80));
      }
    } else if (node.skillSteps && node.skillSteps.length > 0) {
      for (const step of node.skillSteps) {
        dispatchSync(step.verb, step.args as DispatchArgs);
        dispatched = true;
        await new Promise(r => setTimeout(r, 80));
      }
    } else if (node.verb) {
      dispatchSync(node.verb, (node.args ?? {}) as DispatchArgs);
      dispatched = true;
      await new Promise(r => setTimeout(r, 80));
    }
    if (dispatched) this._nodeHasResult.add(node.id);
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

  // ── Cycle detection / downstream helpers ──────────────────────────────────

  // DFS check: would adding edge from→to create a cycle?
  private _hasCycle(from: string, to: string): boolean {
    const visited = new Set<string>();
    const queue = [to];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === from) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const edge of this._graph.edges) {
        if (edge.from === cur) queue.push(edge.to);
      }
    }
    return false;
  }

  // BFS: all node IDs reachable downstream of nodeId (not including nodeId itself).
  private _getDownstream(nodeId: string): Set<string> {
    const downstream = new Set<string>();
    const queue = [nodeId];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const edge of this._graph.edges) {
        if (edge.from === cur && !downstream.has(edge.to)) {
          downstream.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    return downstream;
  }

  // ── Topo-sort (Kahn's algorithm) ───────────────────────────────────────────

  private _topoSort(): CanvasNode[] {
    const inDeg = new Map<string, number>(this._graph.nodes.map(n => [n.id, 0]));
    const adj   = new Map<string, string[]>(this._graph.nodes.map(n => [n.id, []]));
    for (const e of this._graph.edges) {
      adj.get(e.from)?.push(e.to);
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

  // ── Backward-compat: agent-triggered animation ─────────────────────────────

  async runWithAnimation(steps: SkillStep[]): Promise<void> {
    const nodes: CanvasNode[] = steps.map((step, i) => ({
      id: crypto.randomUUID(), kind: "skill" as const,
      skillName: step.verb, skillSteps: [step],
      verb: step.verb, args: step.args,
      x: 20 + i * 180, y: 80,
      inPorts: i > 0 ? 1 : 0, outPorts: i < steps.length - 1 ? 1 : 0,
    }));
    const edges: CanvasEdge[] = nodes.slice(0, -1).map((n, i) => ({
      id: crypto.randomUUID(), from: n.id, fromPort: 0, to: nodes[i + 1].id, toPort: 0,
    }));
    this._graph = { nodes, edges, groups: [] };
    saveGraph(this._graph);
    this._renderGraph();
    await this._run();
  }

  // ── Cluster save / load (#427) ─────────────────────────────────────────────

  private async _saveSelectedAsCluster(): Promise<void> {
    if (this._selected.size === 0) return;
    const selectedIds = new Set(this._selected);
    const nodes = this._graph.nodes.filter(n => selectedIds.has(n.id));
    const edges = this._graph.edges.filter(e => selectedIds.has(e.from) && selectedIds.has(e.to));
    const graphJson = JSON.stringify({ nodes, edges, groups: [] });
    openSaveClusterModal(graphJson, nodes.length, edges.length, () => {
      void this._buildPalette();
    });
  }

  // Append a saved cluster's nodes/edges to the current graph.
  loadCanvasCluster(cluster: CanvasCluster): void {
    let parsed: { nodes: CanvasNode[]; edges: CanvasEdge[]; groups: CanvasGroup[] };
    try { parsed = JSON.parse(cluster.graphJson) as typeof parsed; }
    catch { return; }

    // Re-ID to avoid UUID collisions; offset position so they don't overlap existing nodes.
    const idMap = new Map<string, string>();
    const offset = { x: 20, y: 20 };
    const newNodes: CanvasNode[] = (parsed.nodes ?? []).map(n => {
      const newId = crypto.randomUUID();
      idMap.set(n.id, newId);
      return { ...n, id: newId, x: (n.x ?? 0) + offset.x, y: (n.y ?? 0) + offset.y };
    });
    const newEdges: CanvasEdge[] = (parsed.edges ?? [])
      .filter(e => idMap.has(e.from) && idMap.has(e.to))
      .map(e => ({ ...e, id: crypto.randomUUID(), from: idMap.get(e.from)!, to: idMap.get(e.to)! }));

    this._graph.nodes.push(...newNodes);
    this._graph.edges.push(...newEdges);
    saveGraph(this._graph);
    this._renderGraph();
  }

  // Export a cluster as a downloadable .skill JSON file.
  static exportClusterFile(cluster: CanvasCluster): void {
    const payload = JSON.stringify({
      schema: "gemma-cad:canvas-cluster:v1",
      name: cluster.name,
      description: cluster.description,
      nodeCount: cluster.nodeCount,
      edgeCount: cluster.edgeCount,
      graph: JSON.parse(cluster.graphJson) as unknown,
    }, null, 2);
    const blob = new Blob([payload], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `${cluster.name.replace(/[^a-z0-9_-]/gi, "-")}.skill`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  destroy(): void {
    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("mouseup",   this._onMouseUp);
    window.removeEventListener("keydown",   this._onKeyDown);
    if (this._recording) this.stopRecording();
  }
}

// Backward-compat export (verb palette was public in prior siblings)
export type { SkillStep };
