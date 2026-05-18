// agent-harness.ts — In-browser WebGPU inference via Transformers.js v4 (#47).
//
// Model: onnx-community/gemma-4-E4B-it-ONNX (Q4 quantized, CDN-hosted). E2B available via ?gemma_model=e2b.
// Uses Gemma4ForConditionalGeneration + AutoProcessor directly — the
// "image-text-to-text" pipeline task is not supported in transformers.js 4.2.0.
//
// Remote path (Prong A, issue #99):
//   Set VITE_GEMMA_AGENT_URL=http://localhost:8088 to route runAgentTurn()
//   through serve_lora.py instead of loading the ONNX model in-browser.
//   When the env var is unset, the original in-browser WebGPU path is used.
//
// Load sequence (in-browser path):
//   1. First call to runAgentTurn() triggers model download (~4GB, cached by browser).
//   2. Badge element (#ai-model-badge) shows download progress then "LIVE".
//   3. Subsequent calls skip loading and go straight to inference.
//
// Function-call format: model emits ```json {"verb":"Name","args":{...}} ``` blocks.
// parseDispatches() extracts these; remaining text becomes the response text.

import { getDictionary } from "../commands/dictionary";
import { listHandlers } from "../commands/dispatch";
import { getState } from "../app-state";
import { StandardBackend } from "./standard-backend";

// ── Cluster catalog (populated by workbench after each save/delete) ──────────
let _clusterCatalog: { name: string; steps: number }[] = [];

export function setClusterCatalog(clusters: { name: string; steps: number }[]): void {
  _clusterCatalog = clusters;
}
import { snapshotAsText } from "../scene/scene-kg";
import { captureViewport } from "./viewport-capture";
import type { Skill } from "./skills-loader";
import { recordTurn } from "./telemetry";

export type AgentDispatch = {
  verb: string;
  args: Record<string, unknown>;
};

export type AgentRequest = {
  prompt: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  frames?: ImageBitmap[];   // in-browser WebGPU path (RawImage)
  userImage?: string;       // remote path — pre-encoded data URL from chat-panel
  maxTurns?: number;
  skills?: Skill[];
  skillsTotal?: number; // total registered skills before keyword filtering
  model?: string;
  maxNewTokens?: number; // default 512; pass 1024 for plan turns
};

export type AgentResponse = {
  dispatches: AgentDispatch[];
  text: string;
  plan?: string; // extracted from <plan>…</plan> block
  raw?: unknown;
};

// ---- Remote endpoint (VITE_GEMMA_AGENT_URL) --------------------------------

const REMOTE_URL: string = (import.meta.env as Record<string, string>).VITE_GEMMA_AGENT_URL ?? "";

// P10-2: session-level flag; set on first worker error.
// When true, all subsequent runAgentTurn() calls route to remote.
let _webgpuFallbackEngaged = false;
let _deviceLabel = "GPU"; // updated from worker model-ready message

// Warmup deduplication guard — set to true when worker sends warmup-done.
let _prefillDone = false;

// Standard backend (#929): dedicated Web Worker for the standard fallback path.
// Activated when the drafter ONNX fails to load so subsequent turns don't go
// through model-worker.ts's inline model.generate() call.
let _standardBackend: StandardBackend | null = null;
let _standardBackendActivating = false;

function activateStandardBackend(): void {
  if (_standardBackend || _standardBackendActivating) return;
  _standardBackendActivating = true;
  const sb = new StandardBackend({ modelId: MODEL_ID, dtype: "q4f16" });
  sb.init()
    .then(() => {
      _standardBackend = sb;
      window.dispatchEvent(new CustomEvent("agentmodel:standard-backend:ready"));
    })
    .catch((e) => {
      _standardBackendActivating = false;
      console.warn("[agent-harness] standard backend init failed:", (e as Error).message);
    });
}

// ---- Model loading (in-browser path via Web Worker #936) -------------------

// Model candidates — E4B is default; switch to E2B via ?gemma_model=e2b URL param.
export const MODEL_ID_CANDIDATES = {
  e2b: "onnx-community/gemma-4-E2B-it-ONNX",
  e4b: "onnx-community/gemma-4-E4B-it-ONNX",
} as const;

const _modelParam =
  typeof window !== "undefined"
    ? (new URLSearchParams(window.location.search).get("gemma_model") ?? "").toLowerCase()
    : "";
export const MODEL_ID: string =
  _modelParam === "e2b" ? MODEL_ID_CANDIDATES.e2b : MODEL_ID_CANDIDATES.e4b;
const MODEL_LABEL: string = _modelParam === "e2b" ? "E2B" : "E4B";

// ?mtp=off disables spec-decode even when all other gates pass — used for A/B tg baseline.
const _MTP_OFF =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("mtp") === "off";

const BADGE_ID = "ai-model-badge";

// ── Worker state (#936) ──────────────────────────────────────────────────────
let _inferenceWorker: Worker | null = null;
let _workerReady = false;
type WorkerGenResult = {
  text: string; specAttempts: number; specAccepts: number;
  prefillMs: number; decodeMs: number; inputLength: number; tokensOut: number;
};
const _generateCallbacks = new Map<string, {
  resolve: (r: WorkerGenResult) => void;
  reject: (e: Error) => void;
}>();

// CDN URL injected at build time via VITE_DRAFTER_ONNX_URL env var (#812).
const DRAFTER_ONNX_URL: string =
  import.meta.env["VITE_DRAFTER_ONNX_URL"] ?? "/models/gemma-4-E4B-it-assistant/drafter.onnx";
const DRAFTER_CACHE_KEY = "mtp-drafter-e4b-v1";
const MTP_DRAFT_N = 3; // candidate tokens to draft per speculation step

/**
 * Returns true when the request includes image/audio/viewport content.
 * The MTP drafter is text-only; multimodal turns must bypass spec-decode so
 * the modality is never silently stripped (#740-C).
 */
export function payloadHasMultimodal(req: AgentRequest): boolean {
  if (req.userImage) return true;            // explicit data URL from chat panel
  if (req.frames && req.frames.length > 0) return true; // viewport-capture or image bitmaps
  return false;
}

// Drafter load trigger shim — kept for external tooling (A/B scripts, verify harness).
// Worker handles actual load; this is a no-op that resolves immediately.
if (typeof globalThis !== "undefined") {
  (globalThis as any).__loadDrafter = (): Promise<void> => Promise.resolve();
}

function updateBadge(inner: string): void {
  const el = document.getElementById(BADGE_ID);
  if (el) el.innerHTML = inner;
}

// ── Worker lifecycle (#936) ──────────────────────────────────────────────────

/** Create the inference worker (if not already created), wire its message handler,
 *  and post {type:"init"} to start model load + warmup + drafter load in the worker. */
function initWorkerIfNeeded(): Worker {
  if (_inferenceWorker) return _inferenceWorker;

  _inferenceWorker = new Worker(
    new URL("./model-worker.ts", import.meta.url),
    { type: "module" },
  );

  _inferenceWorker.onmessage = (ev: MessageEvent<Record<string, unknown>>) => {
    const msg = ev.data;
    switch (msg.type) {
      case "returning-user":
        window.dispatchEvent(new CustomEvent("agentmodel:returning-user"));
        break;
      case "manifest":
        window.dispatchEvent(new CustomEvent("agentmodel:manifest", {
          detail: { totalBytesExpected: msg.totalBytesExpected as number },
        }));
        break;
      case "progress": {
        const phase = msg.phase as string;
        const bytes = (msg.bytes as number | undefined) ?? 0;
        const total = (msg.total as number | undefined) ?? 0;
        const throughputBytesPerSec = (msg.throughputBytesPerSec as number | undefined) ?? 0;
        if (phase === "drafter") {
          window.dispatchEvent(new CustomEvent("agentmodel:drafter:loading", {
            detail: { progress: msg.progress ?? 0, bytes, total, throughputBytesPerSec },
          }));
        } else {
          const pct = msg.progress != null ? `${Math.round(msg.progress as number)}%` : "";
          const file = (msg.file as string | undefined) ?? "";
          const label = [pct, file].filter(Boolean).join(" ");
          if (label) updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ${label}`);
          window.dispatchEvent(new CustomEvent("agentmodel:loading", {
            detail: { progress: msg.progress ?? 0, file, bytes, total, throughputBytesPerSec, phase },
          }));
        }
        break;
      }
      case "model-ready":
        _deviceLabel = (msg.device as string) === "GPU" ? "GPU" : "CPU";
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel}`);
        window.dispatchEvent(new CustomEvent("agentmodel:ready", { detail: { device: _deviceLabel } }));
        break;
      case "warmup-done":
        _prefillDone = true;
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel} · READY`);
        break;
      case "drafter-ready":
        (globalThis as any).__drafterLoaded = true;
        window.dispatchEvent(new CustomEvent("agentmodel:drafter:ready"));
        break;
      case "drafter-error":
        (globalThis as any).__drafterLoaded = false;
        window.dispatchEvent(new CustomEvent("agentmodel:drafter:error", { detail: msg.error }));
        activateStandardBackend(); // spawn dedicated standard-path worker (#929)
        break;
      case "boot-complete":
        window.dispatchEvent(new CustomEvent("agentmodel:boot-complete"));
        break;
      case "ready":
        _workerReady = true;
        break;
      case "generate-progress":
        window.dispatchEvent(new CustomEvent("agentmodel:generate-progress", {
          detail: { turnId: msg.turnId, tokens_generated: msg.tokens_generated },
        }));
        break;
      case "generate-warning":
        window.dispatchEvent(new CustomEvent("agentmodel:generate-warning", {
          detail: { turnId: msg.turnId, message: msg.message },
        }));
        break;
      case "generate-done": {
        const cb = _generateCallbacks.get(msg.turnId as string);
        if (cb) {
          _generateCallbacks.delete(msg.turnId as string);
          cb.resolve({
            text:         msg.text as string,
            specAttempts: msg.specAttempts as number,
            specAccepts:  msg.specAccepts as number,
            prefillMs:    msg.prefillMs as number,
            decodeMs:     msg.decodeMs as number,
            inputLength:  msg.inputLength as number,
            tokensOut:    msg.tokensOut as number,
          });
        }
        break;
      }
      case "generate-error": {
        const cb = _generateCallbacks.get(msg.turnId as string);
        if (cb) {
          _generateCallbacks.delete(msg.turnId as string);
          cb.reject(new Error(msg.error as string));
        }
        break;
      }
      case "error":
        _webgpuFallbackEngaged = true;
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ERROR`);
        window.dispatchEvent(new CustomEvent("agentmodel:error", { detail: msg.error }));
        for (const [, cb] of _generateCallbacks) cb.reject(new Error(msg.error as string));
        _generateCallbacks.clear();
        break;
    }
  };

  _inferenceWorker.onerror = (e) => {
    _webgpuFallbackEngaged = true;
    const errMsg = e.message ?? "worker error";
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ERROR`);
    for (const [, cb] of _generateCallbacks) cb.reject(new Error(errMsg));
    _generateCallbacks.clear();
  };

  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LOADING…`);
  window.dispatchEvent(new CustomEvent("agentmodel:loading", { detail: { progress: 0 } }));

  _inferenceWorker.postMessage({
    type:             "init",
    modelId:          MODEL_ID,
    drafterUrl:       DRAFTER_ONNX_URL,
    drafterCacheKey:  DRAFTER_CACHE_KEY,
  });

  return _inferenceWorker;
}

/** Fire-and-forget model prefetch (#936).
 *  Safe to call early (prompt tab focus / DOMContentLoaded).
 *  On-device: creates worker, which handles load + warmup + drafter in background.
 *  Remote: primes llama-server KV prefix cache. */
export function prefetchModel(): void {
  if (REMOTE_URL) {
    void prefillSystemPromptAsync();
    return;
  }
  initWorkerIfNeeded();
}

/** Remote KV warmup (#492). On-device warmup is handled by the worker. */
async function prefillSystemPromptAsync(): Promise<void> {
  if (_prefillDone) return;
  _prefillDone = true;

  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · REMOTE · ⟳ PRIMING`);
  try {
    const messages = [
      { role: "system" as const, content: buildSystemPrompt() },
      { role: "user" as const, content: "." },
    ];
    await fetch(`${REMOTE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, max_tokens: 1, temperature: 0.1 }),
    });
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · REMOTE · READY`);
  } catch {
    _prefillDone = false;
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · REMOTE`);
  }
}

// ---- System prompt --------------------------------------------------------

function summariseDictionary(): string {
  const dict = getDictionary();
  const implemented = new Set(listHandlers());
  // Show only verbs that have a registered handler (native or shim).
  // Falls back to full dictionary if dispatch hasn't initialized yet.
  const available = implemented.size > 0 ? dict.filter((e) => implemented.has(e.canonical_name)) : dict;
  const lines = available.map((e) => {
    const argList = e.args
      .map((a) => {
        const req = a.required ? "required" : "optional";
        const unit = a.unit ? ` unit=${a.unit}` : "";
        const def = a.default !== undefined ? ` default=${JSON.stringify(a.default)}` : "";
        return `${a.name}:${a.type} [${req}${unit}${def}]`;
      })
      .join(", ");
    const syn = e.synonyms.length > 0 ? ` synonyms=[${e.synonyms.join(", ")}]` : "";
    return `  ${e.canonical_name}(${argList})${syn}`;
  });
  const count = available.length;
  return count > 0
    ? `Available function schemas (${count} — use ONLY these function names, do not invent function names):\n${lines.join("\n")}`
    : "No function schemas currently available. Do not emit function calls.";
}

function summariseSkills(skills: Skill[] | undefined): string {
  if (!skills || skills.length === 0) return "Available skills: none active.";
  return `Available skills:\n${skills.map((s) => `  ${s.name} (v${s.version}): ${s.description}`).join("\n")}`;
}

function summariseClusters(): string {
  if (_clusterCatalog.length === 0) return "";
  const lines = _clusterCatalog.map(c => `  ${c.name} (${c.steps} steps)`).join("\n");
  return `Saved skill clusters (run with SdRunCluster({name:"…"})):\n${lines}\nTo place copies at different positions, emit separate SdRunCluster calls with distinct anchor offsets — e.g. anchor:[5,0,0] shifts all positions +5 on X. Do NOT use repeat for multi-position placement.`;
}

function buildSceneContext(): string {
  // Try KG first (populated by dispatch-created objects).
  // snapshotAsText() prefixes its own "Current scene: " — strip it so the
  // caller's `Current scene: ${buildSceneContext()}` doesn't double-prefix.
  const kg = snapshotAsText().replace(/^Current scene:\s*/i, "");
  if (!kg.startsWith("empty")) return kg;

  // Walk for IFC elements — web-ifc sets userData.expressID + userData.ifcClass on each mesh.
  type ViewerLike = { getScene?: () => { traverse?: (cb: (o: unknown) => void) => void; children?: unknown[] } };
  const viewer = (window as unknown as { __viewer?: ViewerLike }).__viewer;
  const scene = viewer?.getScene?.();
  if (scene?.traverse) {
    const ifcCounts: Record<string, number> = {};
    let ifcTotal = 0;
    scene.traverse((obj: unknown) => {
      const ud = (obj as { userData?: Record<string, unknown> })?.userData;
      if (ud?.expressID != null && ud?.ifcClass) {
        const cls = String(ud.ifcClass);
        ifcCounts[cls] = (ifcCounts[cls] ?? 0) + 1;
        ifcTotal++;
      }
    });
    if (ifcTotal > 0) {
      const parts = Object.entries(ifcCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => `${n}× ${cls}`)
        .join(", ");
      return `IFC model loaded: ${ifcTotal} elements — ${parts}.`;
    }
  }

  // Fall back to top-level scene children (generic / non-IFC scenes).
  // userData.creator is set by every dispatch handler (SdBox, SdWall, etc.) — scaffolding groups
  // added by the viewer (grid, axes, pivot proxy, cplane gizmo) never carry this property.
  // Filter to creator-tagged objects only so the agent's view matches what the user can select.
  type ViewerScene = { children?: Array<{ type: string; name?: string; userData?: Record<string, unknown>; position?: { x: number; y: number; z: number } }> };
  const fallbackViewer = (window as unknown as { __viewer?: { scene?: ViewerScene } }).__viewer;
  const children = fallbackViewer?.scene?.children;

  const meshes = children?.filter((c) => (c.type === "Mesh" || c.type === "Group") && c.userData?.creator != null) ?? [];
  if (meshes.length === 0) return "empty workspace — no objects placed yet.";

  const lines = meshes.slice(0, 15).map((m) => {
    const pos = m.position
      ? `at (${m.position.x.toFixed(1)}, ${m.position.y.toFixed(1)}, ${m.position.z.toFixed(1)})`
      : "";
    return `${m.name || m.type}${pos ? " " + pos : ""}`;
  });
  const suffix = meshes.length > 15 ? ` … and ${meshes.length - 15} more` : "";
  return `${meshes.length} object(s): ${lines.join("; ")}${suffix}.`;
}


const DIMENSION_RULES = `
DIMENSION RULES — extract ALL numeric values BEFORE generating geometry. Never use default 5.5 × 2.8 × 0.2 when the prompt gives dimensions.
- Width / length / depth: take EXACT values from prompt ("20m × 15m" → width=20, depth=15).
- Height: floor_height × n_stories. "3-story, 3m floor height" → total=9m; use 3m per IfcLevel.
- Footprint polygon: [[0,0],[W,0],[W,D],[0,D]] where W=width, D=depth.
- Multi-story: one IfcLevel per floor, elevation = floor_index × floor_height. Default floor heights: 3.0m office/residential, 4.5m industrial/bay.
- SdSpace must include a descriptive name= param: name="lobby", name="apparatus bay 1", etc.
`.trim();

const BUILDING_DEFAULTS = `
BUILDING DEFAULTS — apply when dimensions are unspecified. "Design a house/apartment/office" implies ALL of the following element types:
- IfcLevel: one per storey (elevation = floor_index × floor_height). Always emit before walls on that level.
- IfcWall: exterior 0.15m thick; interior partition 0.10m thick. Enclose all rooms — no open faces.
- IfcSlab: 0.20m thick at every level base (floor slab). Also use for roof on flat-roof buildings.
- IfcDoor: width=0.9, height=2.1, wallThickness=0.15. One per building minimum; front entry on south wall.
- IfcWindow: width=1.2, height=1.2, sillH=0.9. Minimum 2 per exterior elevation (south + north or east + west).
- SdColumn: size=0.3 at building corners and wall junctions; height = floor height. Add when span >6m.
- IfcRoof: roofType=pitched (residential house/tiny home), roofType=hipped (villa), roofType=flat (apartment/office), roofType=shed (lean-to/mono-pitch, industrial annexe). pitchDeg=35 default.
- IfcStair: width=1.0, type=straight. Dispatch AFTER the upper-floor slab; handler auto-cuts stairwell void. Minimum 1 per multi-storey building.
- SdCeiling: one per storey, placed at floor_height elevation. width/depth = room footprint. elevation = floor_index × floor_height + floor_height (top of room). IFC convention: explicit IfcCovering element; do NOT rely on slab-above as implicit ceiling.
- SdExport: always end with format=ifc, target=scene.
- Room sizes (net internal): bedroom 9-15m², living 18-25m², kitchen 8-12m², bathroom 4-6m².
- Floor heights: residential 3.0m, office 3.5m, industrial/bay 4.5m.
`.trim();

// Handler auto-behaviors: concise principles so the agent knows what NOT to compute.
// Token budget: ≤200 tokens for this entire block.
const MULTI_LEVEL_NOTES = `
HANDLER AUTO-BEHAVIORS — the dispatch handlers do these automatically; agent must NOT re-compute or emit extra args for them:
- IfcRoof(type=pitched): auto-trims the two short-edge (gable-end) walls to a triangle profile. Emit IfcRoof only — do NOT emit topProfile on walls.
- IfcStair: auto-cuts a rectangular stairwell void through the IfcSlab at target elevation. Place IfcStair AFTER the upper-floor slab.
- Multi-level sequence: emit ALL IfcLevel calls first (elevation=0, 3.0, 6.0 ...), then setActiveLevel, then walls+slabs for that level. Walls spanning only one storey use height = floor_height (not total building height).
`.trim();

const FEW_SHOT_EXAMPLES = `
Examples — copy verb names EXACTLY; always emit <plan> before tool_call tags:

User: draw a 5m wall, 0.2m thick, 2.8m tall
Assistant:
<plan>
1. SdWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8
</plan>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8},"metadata":{"source":"agent"}}</tool_call>

User: create a box 6m wide, 4m deep, 3m tall
Assistant:
<plan>
1. SdBox — width=6, depth=4, height=3
</plan>
<tool_call>{"command":"SdBox","parameters":{"width":6,"depth":4,"height":3},"metadata":{"source":"agent"}}</tool_call>

User: rotate 45 degrees around Z
Assistant:
<plan>
1. SdRotate — angle=45, axis=[0,0,1]
</plan>
<tool_call>{"command":"SdRotate","parameters":{"angle":45,"axis":[0,0,1]},"metadata":{"source":"agent"}}</tool_call>

User: design a small research pavilion
Assistant: Assuming 8×6m open plan, flat roof, 3.5m height.
<plan>
1. SdWall — south, profile=[[0,0],[8,0]], thickness=0.2, height=3.5
2. SdWall — north, profile=[[8,6],[0,6]], thickness=0.2, height=3.5
3. SdWall — east, profile=[[8,0],[8,6]], thickness=0.2, height=3.5
4. SdWall — west, profile=[[0,6],[0,0]], thickness=0.2, height=3.5
5. SdBox — roof slab, width=8.4, depth=6.4, height=0.2
6. SdBox — corner column, width=0.3, depth=0.3, height=3.5
</plan>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[8,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,6],[0,6]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,0],[8,6]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,6],[0,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdBox","parameters":{"width":8.4,"depth":6.4,"height":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdBox","parameters":{"width":0.3,"depth":0.3,"height":3.5},"metadata":{"source":"agent"}}</tool_call>

User: design a 2-story library, 12m × 8m
Assistant: Assuming 3.0m ground-floor height, 3.0m upper-floor height, concrete slab at +3.0m.
<plan>
1. SdLevel — name="Ground", elevation=0, height=3.0
2. SdLevel — name="2nd Floor", elevation=3.0, height=3.0
3. setActiveLevel — id from Ground SdLevel return
4. SdWall — south ground, profile=[[0,0],[12,0]], thickness=0.3, height=3.0
5. SdWall — north ground, profile=[[12,8],[0,8]], thickness=0.3, height=3.0
6. SdWall — east ground, profile=[[12,0],[12,8]], thickness=0.3, height=3.0
7. SdWall — west ground, profile=[[0,8],[0,0]], thickness=0.3, height=3.0
8. SdSlab — ground floor slab at elev=3.0, profile=[[0,0],[12,0],[12,8],[0,8]]
9. setActiveLevel — id from 2nd Floor SdLevel return
10. SdWall — south upper, profile=[[0,0],[12,0]], thickness=0.3, height=3.0
11. SdWall — north upper, profile=[[12,8],[0,8]], thickness=0.3, height=3.0
12. SdWall — east upper, profile=[[12,0],[12,8]], thickness=0.3, height=3.0
13. SdWall — west upper, profile=[[0,8],[0,0]], thickness=0.3, height=3.0
14. SdSlab — roof slab at elev=6.0, profile=[[0,0],[12,0],[12,8],[0,8]]
</plan>
<tool_call>{"command":"SdLevel","parameters":{"name":"Ground","elevation":0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdLevel","parameters":{"name":"2nd Floor","elevation":3.0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[12,8],[0,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[12,0],[12,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[12,0],[12,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[12,8],[0,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[12,0],[12,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[12,0],[12,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>

User: put this wall on the Elements layer instead
Assistant: Assuming the wall profile and dimensions from context; overriding layer to Elements.
<plan>
1. SdWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8, layer=Elements
</plan>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8,"layer":"Elements"},"metadata":{"source":"agent"}}</tool_call>

User: add a slab but put it on the Annotations layer for now
Assistant: Overriding auto-routing; placing slab on Annotations layer as requested.
<plan>
1. SdSlab — width=6, depth=4, thickness=0.2, layer=Annotations
</plan>
<tool_call>{"command":"SdSlab","parameters":{"width":6,"depth":4,"thickness":0.2,"layer":"Annotations"},"metadata":{"source":"agent"}}</tool_call>

User: design a 12m × 8m single-story hospitality cabin, 2.4m ceiling
Assistant: 12m wide, 8m deep, 1 floor × 2.4m. Footprint [[0,0],[12,0],[12,8],[0,8]].
<plan>
1. SdLevel — name="Ground", elevation=0, extent=12
2. SdWall — south, profile=[[0,0],[12,0]], thickness=0.2, height=2.4
3. SdWall — north, profile=[[12,8],[0,8]], thickness=0.2, height=2.4
4. SdWall — east, profile=[[12,0],[12,8]], thickness=0.2, height=2.4
5. SdWall — west, profile=[[0,8],[0,0]], thickness=0.2, height=2.4
6. SdSlab — profile=[[0,0],[12,0],[12,8],[0,8]], thickness=0.2
7. SdCeiling — width=12, depth=8, elevation=2.4
8. SdSpace — footprint=[[1,1],[7,1],[7,7],[1,7]], height=2.4, name="main hall"
9. SdSpace — footprint=[[7,1],[11,1],[11,7],[7,7]], height=2.4, name="kitchenette"
10. SdDoor — width=0.91, height=2.1
</plan>
<tool_call>{"command":"SdLevel","parameters":{"name":"Ground","elevation":0,"extent":12},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[12,8],[0,8]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[12,0],[12,8]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[12,0],[12,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdCeiling","parameters":{"width":12,"depth":8,"elevation":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[1,1],[7,1],[7,7],[1,7]],"height":2.4,"name":"main hall"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[7,1],[11,1],[11,7],[7,7]],"height":2.4,"name":"kitchenette"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":0.91,"height":2.1},"metadata":{"source":"agent"}}</tool_call>

User: design a 20m × 12m 2-story office building, 3.5m floor height
Assistant: 20m wide, 12m deep, 2 floors × 3.5m = 7m total. Ground Floor at 0m, Floor 2 at 3.5m.
<plan>
1. SdLevel — name="Ground Floor", elevation=0, extent=20
2. SdLevel — name="Floor 2", elevation=3.5, extent=20
3. setActiveLevel — id=level/0
4. SdWall — south ground, profile=[[0,0],[20,0]], thickness=0.2, height=3.5
5. SdWall — north ground, profile=[[20,12],[0,12]], thickness=0.2, height=3.5
6. SdWall — east ground, profile=[[20,0],[20,12]], thickness=0.2, height=3.5
7. SdWall — west ground, profile=[[0,12],[0,0]], thickness=0.2, height=3.5
8. SdSlab — mid-floor at elev 3.5, profile=[[0,0],[20,0],[20,12],[0,12]]
9. SdCeiling — ground floor ceiling, width=20, depth=12, elevation=3.5
10. SdSpace — name="reception", footprint=[[0,0],[6,0],[6,12],[0,12]], height=3.5
11. SdSpace — name="open office", footprint=[[6,0],[20,0],[20,12],[6,12]], height=3.5
12. setActiveLevel — id=level/1
13. SdWall — south upper, profile=[[0,0],[20,0]], thickness=0.2, height=3.5
14. SdWall — north upper, profile=[[20,12],[0,12]], thickness=0.2, height=3.5
15. SdWall — east upper, profile=[[20,0],[20,12]], thickness=0.2, height=3.5
16. SdWall — west upper, profile=[[0,12],[0,0]], thickness=0.2, height=3.5
17. SdSlab — roof at elev 7.0, profile=[[0,0],[20,0],[20,12],[0,12]]
18. SdCeiling — upper floor ceiling, width=20, depth=12, elevation=7.0
19. SdSpace — name="conference room", footprint=[[0,0],[10,0],[10,12],[0,12]], height=3.5
20. SdSpace — name="office suite", footprint=[[10,0],[20,0],[20,12],[10,12]], height=3.5
</plan>
<tool_call>{"command":"SdLevel","parameters":{"name":"Ground Floor","elevation":0,"extent":20},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdLevel","parameters":{"name":"Floor 2","elevation":3.5,"extent":20},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[20,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[20,12],[0,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[20,0],[20,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,12],[0,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[20,0],[20,12],[0,12]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdCeiling","parameters":{"width":20,"depth":12,"elevation":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[0,0],[6,0],[6,12],[0,12]],"height":3.5,"name":"reception"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[6,0],[20,0],[20,12],[6,12]],"height":3.5,"name":"open office"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[20,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[20,12],[0,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[20,0],[20,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,12],[0,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[20,0],[20,12],[0,12]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdCeiling","parameters":{"width":20,"depth":12,"elevation":7.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[0,0],[10,0],[10,12],[0,12]],"height":3.5,"name":"conference room"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[10,0],[20,0],[20,12],[10,12]],"height":3.5,"name":"office suite"},"metadata":{"source":"agent"}}</tool_call>

User: design a two-story residential house, 8m × 6m
Assistant: 8m wide, 6m deep, 2 floors × 2.74m walls, 3.0m floor-to-floor. Door on south face (y=0); stair at NE corner cuts void in upper slab.
<plan>
1. SdRectangle — footprint, width=8, length=6, center=[4,3]
2. SdLevel — Ground, elevation=0, height=3.0, extent=8
3. SdLevel — Floor 2, elevation=3.0, height=3.0, extent=8
4. setActiveLevel — id=level/0 (ground)
5. SdSlab — ground slab, profile=[[0,0],[8,0],[8,6],[0,6]], thickness=0.10
6. SdWall — south ground, profile=[[0,0],[8,0]], thickness=0.20, height=2.74
7. SdWall — east ground, profile=[[8,0],[8,6]], thickness=0.20, height=2.74
8. SdWall — north ground, profile=[[8,6],[0,6]], thickness=0.20, height=2.74
9. SdWall — west ground, profile=[[0,6],[0,0]], thickness=0.20, height=2.74
10. SdCeiling — ground ceiling, width=8, depth=6, elevation=2.74
11. setActiveLevel — id=level/1 (upper, so next slab lands at z=3.0)
12. SdSlab — upper slab, profile=[[0,0],[8,0],[8,6],[0,6]], thickness=0.10
13. setActiveLevel — id=level/0 (back to ground so stair void-cut scans upper slab)
14. SdStair — NE corner, start=[7,5], end=[7.7,2.2], type=straight, riser=0.1778, tread=0.2794, width=0.914, targetHeight=3.0
15. setActiveLevel — id=level/1 (upper walls + ceiling + roof)
16. SdWall — south upper, profile=[[0,0],[8,0]], thickness=0.20, height=2.74
17. SdWall — east upper, profile=[[8,0],[8,6]], thickness=0.20, height=2.74
18. SdWall — north upper, profile=[[8,6],[0,6]], thickness=0.20, height=2.74
19. SdWall — west upper, profile=[[0,6],[0,0]], thickness=0.20, height=2.74
20. SdCeiling — upper ceiling, width=8, depth=6, elevation=5.74
21. SdRoof — pitched, footprint=[[0,0],[8,0],[8,6],[0,6]], pitchDeg=30
22. setActiveLevel — id=level/0 (ground door + windows)
23. SdDoor — south wall entry, position=[4,0,0], width=0.914, height=2.032
24. SdWindow — south wall, position=[1.5,0,0], width=1.2, height=1.2, sillH=0.9
25. SdWindow — east wall, position=[8,3,0], width=1.2, height=1.2, sillH=0.9
</plan>
<tool_call>{"command":"SdRectangle","parameters":{"width":8,"length":6,"center":[4,3]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdLevel","parameters":{"name":"Ground","elevation":0,"height":3.0,"extent":8},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdLevel","parameters":{"name":"Floor 2","elevation":3.0,"height":3.0,"extent":8},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[8,0],[8,6],[0,6]],"thickness":0.10},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[8,0]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,0],[8,6]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,6],[0,6]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,6],[0,0]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdCeiling","parameters":{"width":8,"depth":6,"elevation":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[8,0],[8,6],[0,6]],"thickness":0.10},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdStair","parameters":{"start":[7,5],"end":[7.7,2.2],"type":"straight","riser":0.1778,"tread":0.2794,"width":0.914,"targetHeight":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[8,0]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,0],[8,6]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,6],[0,6]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,6],[0,0]],"thickness":0.20,"height":2.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdCeiling","parameters":{"width":8,"depth":6,"elevation":5.74},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdRoof","parameters":{"roofType":"pitched","footprint":[[0,0],[8,0],[8,6],[0,6]],"pitchDeg":30},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"position":[4,0,0],"width":0.914,"height":2.032},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[1.5,0,0],"width":1.2,"height":1.2,"sillH":0.9},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[8,3,0],"width":1.2,"height":1.2,"sillH":0.9},"metadata":{"source":"agent"}}</tool_call>

User: design a 24m × 25m fire station with 3 apparatus bays
Assistant: 24m wide, 25m deep. Bay zone 24×9m at 4.5m height; living zone 24×16m at 2.8m height.
<plan>
1. SdLevel — name="Ground", elevation=0, extent=24
2. SdWall — south, profile=[[0,0],[24,0]], thickness=0.3, height=4.5
3. SdWall — north, profile=[[24,25],[0,25]], thickness=0.3, height=4.5
4. SdWall — east, profile=[[24,0],[24,25]], thickness=0.3, height=4.5
5. SdWall — west, profile=[[0,25],[0,0]], thickness=0.3, height=4.5
6. SdSlab — profile=[[0,0],[24,0],[24,25],[0,25]], thickness=0.2
7. SdSpace — footprint=[[0,0],[8,0],[8,9],[0,9]], height=4.5, name="apparatus bay 1"
8. SdSpace — footprint=[[8,0],[16,0],[16,9],[8,9]], height=4.5, name="apparatus bay 2"
9. SdSpace — footprint=[[16,0],[24,0],[24,9],[16,9]], height=4.5, name="apparatus bay 3"
10. SdSpace — footprint=[[0,9],[12,9],[12,25],[0,25]], height=2.8, name="day room"
11. SdSpace — footprint=[[12,9],[24,9],[24,25],[12,25]], height=2.8, name="dormitory"
12. SdDoor — width=4.0, height=4.2
13. SdDoor — width=4.0, height=4.2
14. SdDoor — width=4.0, height=4.2
15. SdDoor — width=0.9, height=2.1
</plan>
<tool_call>{"command":"SdLevel","parameters":{"name":"Ground","elevation":0,"extent":24},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[24,0]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[24,25],[0,25]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[24,0],[24,25]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,25],[0,0]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[24,0],[24,25],[0,25]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[0,0],[8,0],[8,9],[0,9]],"height":4.5,"name":"apparatus bay 1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[8,0],[16,0],[16,9],[8,9]],"height":4.5,"name":"apparatus bay 2"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[16,0],[24,0],[24,9],[16,9]],"height":4.5,"name":"apparatus bay 3"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[0,9],[12,9],[12,25],[0,25]],"height":2.8,"name":"day room"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSpace","parameters":{"footprint":[[12,9],[24,9],[24,25],[12,25]],"height":2.8,"name":"dormitory"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":4.0,"height":4.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":4.0,"height":4.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":4.0,"height":4.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":0.9,"height":2.1},"metadata":{"source":"agent"}}</tool_call>

User: add a 1m grid and snap walls to it
Assistant: Adding 1m grid; walls will snap to intersections.
<plan>
1. SdRefGrid — spacing=1, count=30, rotation=0
2. setActiveGrid — id from SdRefGrid return
3. SdWall — south, profile=[[0,0],[12,0]], thickness=0.2, height=3.0
</plan>
<tool_call>{"command":"SdRefGrid","parameters":{"spacing":1,"count":30,"rotation":0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveGrid","parameters":{"id":"grid/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>

User: build a 5m wall and export it as ifc
Assistant: Building a 5m wall then exporting the scene as IFC.
<plan>
1. SdWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8
2. SdExport — format=ifc, target=scene
</plan>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdExport","parameters":{"format":"ifc","target":"scene"},"metadata":{"source":"agent"}}</tool_call>

User: design a small entrance pavilion and send me the GLB for review
Assistant: 4m × 4m entrance canopy, 3m height. Exporting GLB after build.
<plan>
1. SdWall — west, profile=[[0,0],[0,4]], thickness=0.2, height=3.0
2. SdWall — east, profile=[[4,4],[4,0]], thickness=0.2, height=3.0
3. SdSlab — canopy, profile=[[0,0],[4,0],[4,4],[0,4]], thickness=0.15
4. SdExport — format=glb, target=scene
</plan>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[0,4]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[4,4],[4,0]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[4,0],[4,4],[0,4]],"thickness":0.15},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdExport","parameters":{"format":"glb","target":"scene"},"metadata":{"source":"agent"}}</tool_call>

User: crop the model to a 5m x 5m x 3m box at the origin
Assistant:
<plan>
1. SdSectionBox — min=[0,0,0], max=[5,5,3], enabled=true
</plan>
<tool_call>{"command":"SdSectionBox","parameters":{"min":[0,0,0],"max":[5,5,3],"enabled":true},"metadata":{"source":"agent"}}</tool_call>

User: add a horizontal clipping plane at z=2.5 to see the floor plan
Assistant:
<plan>
1. SdClippingPlane — origin=[0,0,2.5], normal=[0,0,-1], label="floor-cut"
</plan>
<tool_call>{"command":"SdClippingPlane","parameters":{"origin":[0,0,2.5],"normal":[0,0,-1],"label":"floor-cut"},"metadata":{"source":"agent"}}</tool_call>

User: design a small house
Assistant: Assuming 8m × 6m footprint, 1 storey, 3.0m ceiling, 3 rooms (living + bedroom + bathroom), gable roof, 1 front door, 4 windows.
<plan>
1. IfcLevel — name="Ground", elevation=0, height=3.0
2. IfcWall — south front, profile=[[0,0],[8,0]], thickness=0.15, height=3.0
3. IfcWall — north rear, profile=[[8,6],[0,6]], thickness=0.15, height=3.0
4. IfcWall — east, profile=[[8,0],[8,6]], thickness=0.15, height=3.0
5. IfcWall — west, profile=[[0,6],[0,0]], thickness=0.15, height=3.0
6. IfcSlab — floor, profile=[[0,0],[8,0],[8,6],[0,6]], thickness=0.2
7. IfcWall — living/bedroom partition, profile=[[5,0],[5,6]], thickness=0.1, height=3.0
8. IfcWall — bedroom/bath divider, profile=[[5,4],[8,4]], thickness=0.1, height=3.0
9. IfcDoor — front entry, width=0.9, height=2.1, position=[4,0]
10. IfcWindow — south left, width=1.2, height=1.2, sillH=0.9, position=[1.5,0]
11. IfcWindow — south right, width=1.2, height=1.2, sillH=0.9, position=[6.5,0]
12. IfcWindow — east, width=1.0, height=1.2, sillH=0.9, position=[8,3]
13. IfcWindow — north, width=1.0, height=1.2, sillH=0.9, position=[4,6]
14. IfcRoof — pitched gable, roofType=pitched, footprint=[[0,0],[8,0],[8,6],[0,6]], pitchDeg=35
15. SdExport — format=ifc, target=scene
</plan>
<tool_call>{"command":"IfcLevel","parameters":{"name":"Ground","elevation":0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[8,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[8,6],[0,6]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[8,0],[8,6]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,6],[0,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[8,0],[8,6],[0,6]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[5,0],[5,6]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[5,4],[8,4]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":0.9,"height":2.1,"position":[4,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[1.5,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[6.5,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[8,3]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[4,6]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcRoof","parameters":{"roofType":"pitched","footprint":[[0,0],[8,0],[8,6],[0,6]],"pitchDeg":35},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdExport","parameters":{"format":"ifc","target":"scene"},"metadata":{"source":"agent"}}</tool_call>

User: design a 2-storey house
Assistant: Assuming 10m × 8m footprint, 2 storeys at 3.0m each, 4 bedrooms upper / living+kitchen lower, gable roof, 2 doors, 6 windows.
<plan>
1. IfcLevel — name="Ground", elevation=0, height=3.0
2. IfcLevel — name="First Floor", elevation=3.0, height=3.0
3. setActiveLevel — id=level/0
4. IfcWall — south ground, profile=[[0,0],[10,0]], thickness=0.15, height=3.0
5. IfcWall — north ground, profile=[[10,8],[0,8]], thickness=0.15, height=3.0
6. IfcWall — east ground, profile=[[10,0],[10,8]], thickness=0.15, height=3.0
7. IfcWall — west ground, profile=[[0,8],[0,0]], thickness=0.15, height=3.0
8. IfcSlab — ground floor, profile=[[0,0],[10,0],[10,8],[0,8]], thickness=0.2
9. IfcWall — kitchen/living partition, profile=[[5,0],[5,8]], thickness=0.1, height=3.0
10. IfcDoor — front entry, width=0.9, height=2.1, position=[5,0]
11. IfcDoor — rear patio, width=0.9, height=2.1, position=[5,8]
12. IfcWindow — south ×2, width=1.2, height=1.2, sillH=0.9
13. IfcWindow — north, width=1.0, height=1.2, sillH=0.9, position=[7,8]
14. setActiveLevel — id=level/1
15. IfcWall — south upper, profile=[[0,0],[10,0]], thickness=0.15, height=3.0
16. IfcWall — north upper, profile=[[10,8],[0,8]], thickness=0.15, height=3.0
17. IfcWall — east upper, profile=[[10,0],[10,8]], thickness=0.15, height=3.0
18. IfcWall — west upper, profile=[[0,8],[0,0]], thickness=0.15, height=3.0
19. IfcSlab — mid-floor ceiling/upper floor, profile=[[0,0],[10,0],[10,8],[0,8]], thickness=0.2
20. IfcWall — bedroom partitions, profile=[[5,0],[5,8]], thickness=0.1, height=3.0
21. IfcWall — bedroom partition 2, profile=[[0,4],[5,4]], thickness=0.1, height=3.0
22. IfcWindow — upper south ×2, width=1.2, height=1.2, sillH=0.9
23. IfcWindow — upper north, width=1.0, height=1.2, sillH=0.9
24. IfcRoof — pitched gable, roofType=pitched, footprint=[[0,0],[10,0],[10,8],[0,8]], pitchDeg=35
25. SdExport — format=ifc, target=scene
</plan>
<tool_call>{"command":"IfcLevel","parameters":{"name":"Ground","elevation":0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcLevel","parameters":{"name":"First Floor","elevation":3.0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[10,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[10,8],[0,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[10,0],[10,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[10,0],[10,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[5,0],[5,8]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":0.9,"height":2.1,"position":[5,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":0.9,"height":2.1,"position":[5,8]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[2,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[7,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[7,8]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[10,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[10,8],[0,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[10,0],[10,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[10,0],[10,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[5,0],[5,8]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,4],[5,4]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[2,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[7,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[7,8]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcRoof","parameters":{"roofType":"pitched","footprint":[[0,0],[10,0],[10,8],[0,8]],"pitchDeg":35},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdExport","parameters":{"format":"ifc","target":"scene"},"metadata":{"source":"agent"}}</tool_call>

User: Describe the default scene in one sentence.
Assistant: The viewport shows an empty three-dimensional canvas — no geometry has been placed yet, and the Current scene contains no objects.

User: What's in the scene?
Assistant: The scene is currently empty — no walls, slabs, or spaces have been placed. The viewport shows a neutral 3D environment ready for your first command.

User: What do you see?
Assistant: Four white extruded walls meeting at right angles enclose a rectangular room roughly 8 m × 6 m in plan, with a flat gray slab at the base and a ceiling plane at 3.0 m. The Current scene contains: 4 walls (200 mm thick, 3.0 m tall), 1 floor slab, 1 ceiling.

User: union these two walls — ids abc123 and def456
Assistant:
<plan>
1. SdBoolean — op=union, a=abc123, b=def456
</plan>
<tool_call>{"command":"SdBoolean","parameters":{"op":"union","a":"abc123","b":"def456"},"metadata":{"source":"agent"}}</tool_call>

User: what is the distance between [0,0,0] and [3,4,0]?
Assistant:
<plan>
1. SdAlignedDim — a=[0,0,0], b=[3,4,0]
</plan>
<tool_call>{"command":"SdAlignedDim","parameters":{"a":[0,0,0],"b":[3,4,0]},"metadata":{"source":"agent"}}</tool_call>
`.trim();

// WebGPU-only few-shot: one example (two-story residential house) to stay under
// the 2048-position ONNX bake limit. buildSystemPrompt uses full FEW_SHOT_EXAMPLES.
// #980: No <plan> block — emit <tool_call> blocks directly. Level naming: Level 1 = ground.
const WEBGPU_HOUSE_FEW_SHOT = `
Examples — copy verb names EXACTLY; emit <tool_call> blocks directly (no <plan> block):

User: build a two-story residential house, 26 feet wide by 20 feet deep
Assistant: 26ft × 20ft, 2 floors × 9.0ft walls, pitched roof. Door + 4 windows on L1; 4 windows on L2; stair at NE corner.
<tool_call>{"command":"SdLevel","parameters":{"name":"Level 1","elevation":0,"height":9.0,"extent":26}}</tool_call>
<tool_call>{"command":"SdLevel","parameters":{"name":"Level 2","elevation":9.0,"height":9.0,"extent":26}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"position":[5,0,0],"width":3.0,"height":7.0,"sillH":0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[18,0,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[26,10,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[13,20,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[0,10,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[18,0,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[26,10,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[13,20,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[0,10,0],"width":3.0,"height":4.0,"sillH":3.0}}</tool_call>
<tool_call>{"command":"SdRoof","parameters":{"roofType":"pitched","footprint":[[0,0],[26,0],[26,20],[0,20]],"pitchDeg":30}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"}}</tool_call>
<tool_call>{"command":"SdStair","parameters":{"start":[23,16],"end":[23,8],"type":"straight","riser":0.583,"tread":0.917,"width":3.0,"targetHeight":9.0}}</tool_call>
`.trim();

export function buildSystemPrompt(skills?: Skill[]): string {
  return [
    "You are Gemma, a parametric CAD assistant. Be direct — no preamble, no performative filler ('certainly!', 'I'll help you with that!', 'Great!' and similar are forbidden).",
    "PLAN BEFORE DISPATCH: For every request that emits tool calls, first emit a compact <plan> block, then the tool_call blocks.\n<plan> format — EXACTLY this structure, no prose:\n<plan>\n1. VerbName — key_arg=value, …\n2. VerbName — key_arg=value\n</plan>",
    "AMBIGUITY: Infer the most common default and proceed. If one critical parameter is missing, state your assumption on ONE line (e.g. 'Assuming 2.8 m ceiling height.') then execute. Do NOT ask multiple clarifying questions.",
    'Preferred tool call format: <tool_call>{"command":"VerbName","parameters":{...},"metadata":{"source":"agent"}}</tool_call>',
    'Fallback format: ```json\n{"verb":"VerbName","args":{...}}\n```',
    "CRITICAL: Use ONLY the exact function names listed below. Any unknown name is silently dropped — nothing will be created.",
    DIMENSION_RULES,
    BUILDING_DEFAULTS,
    MULTI_LEVEL_NOTES,
    FEW_SHOT_EXAMPLES,
    summariseDictionary(),
    `Current scene: ${buildSceneContext()}`,
    "SCENE QUERY RESPONSE: when asked to describe the scene, what you see, what is in the scene, or what the default scene looks like — respond with PLAIN TEXT ONLY. Do NOT emit <plan> or <tool_call> blocks. Instead: (1) describe the viewport image visually: shapes, colors, materials, arrangement, scale (2-3 sentences); (2) narrate the object inventory from the \'Current scene:\' line above in plain English. Combine into ONE natural prose paragraph. No bullet lists. No Sd* names in prose — verb chips are shown separately in the UI.",
    summariseSkills(skills),
    summariseClusters(),
  ].filter(Boolean).join("\n\n");
}

// On-device WebGPU system prompt. TRIAGE: uses WEBGPU_HOUSE_FEW_SHOT (one example,
// ~450 tok) instead of full FEW_SHOT_EXAMPLES (~1375 tok) to stay under the 2048-position
// ONNX bake limit (SafeInt overflow at safeint.h:17 confirmed 2026-05-18). Real fix: #998.
export function buildWebGPUSystemPrompt(skills?: Skill[]): string {
  const dict = getDictionary();
  const implemented = new Set(listHandlers());
  const available = implemented.size > 0 ? dict.filter((e) => implemented.has(e.canonical_name)) : dict;
  const verbNames = available.map((e) => e.canonical_name).join(", ");
  const verbList = verbNames.length > 0
    ? `Available verbs (use ONLY these exact names): ${verbNames}`
    : "No verbs currently available. Do not emit function calls.";

  const unitSystem = getState("unitSystem");
  const unitHint = unitSystem === "imperial"
    ? "Active unit: imperial. Express all lengths in feet (e.g. 26ft, 20ft, 9.6ft). Emit foot values directly in coordinates — 26 feet wide → x-max 26, 20 feet deep → y-max 20."
    : "Active unit: metric. In NL responses express lengths in metres (e.g. 5m, 3m). Dispatch args use the active unit's numbers directly — emit metres for metric mode.";

  return [
    "You are Gemma, a parametric CAD assistant. Be direct — no preamble.",
    "DISPATCH DIRECTLY: emit <tool_call> blocks immediately — no <plan> block. State ONE assumption on one line if needed, then emit tool calls. Level names are always 'Level 1', 'Level 2', 'Level 3' — never 'Ground', 'Floor 2', or custom names.",
    "AMBIGUITY: infer defaults, state ONE assumption, execute. Do NOT ask questions.",
    unitHint,
    "BUILDINGS: For houses/buildings use SdLevel+SdWall+SdSlab+SdRoof+SdWindow+SdDoor+SdStair. Never use SdBox for a building — SdBox is raw geometry only.",
    DIMENSION_RULES,
    WEBGPU_HOUSE_FEW_SHOT,
    verbList,
    `Current scene: ${buildSceneContext()}`,
    summariseSkills(skills),
    summariseClusters(),
    "SCENE QUERY — if the user asks what is in the scene, what you see, or about colors/shapes/appearance: write PLAIN TEXT ONLY, NO tool_call blocks. Describe the viewport image in detail: building form and silhouette, roof shape and exact color, wall color and material, visible windows (count, position, color), site/ground pad color, background grid. State colors precisely (e.g. 'brown', 'gray', 'green'). Then in one sentence summarize the 'Current scene:' object list. If the viewport is literally empty (no geometry, only grid lines and axis arrows) say so.",
  ].filter(Boolean).join("\n\n");
}

export function buildToolDefinitions(): Record<string, unknown>[] {
  // Not used in the WebGPU path (function calls are text-parsed, not schema-validated).
  return [];
}

// ---- Function-call parsing ----------------------------------------------

function parseDispatches(raw: string): { dispatches: AgentDispatch[]; text: string } {
  const dispatches: AgentDispatch[] = [];

  function tryExtract(jsonStr: string): boolean {
    try {
      const parsed: unknown = JSON.parse(jsonStr);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      let found = false;
      for (const item of items) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const verbRaw =
            typeof obj.verb === "string"
              ? obj.verb
              : typeof obj.command === "string"
                ? obj.command
                : "";
          const verb = verbRaw.trim();
          const args = (
            obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
              ? obj.args
              : obj.parameters && typeof obj.parameters === "object" && !Array.isArray(obj.parameters)
                ? obj.parameters
                : {}
          ) as Record<string, unknown>;
          if (verb) { dispatches.push({ verb, args }); found = true; }
        }
      }
      return found;
    } catch { return false; }
  }

  // Pass 1: <tool_call>{...}</tool_call> blocks. >? handles Gemma omitting the closing >
  // of the opening tag (outputs "<tool_call{" instead of "<tool_call>{").
  let text = raw.replace(/<tool_call>?\s*([\s\S]*?)\s*<\/tool_call>/gi, (_, inner) => {
    tryExtract(inner.trim());
    return "";
  });

  // Pass 2: fenced ```json ... ``` blocks.
  text = text.replace(/```json\s*([\s\S]*?)```/gi, (_, inner) => {
    tryExtract(inner.trim());
    return "";
  });

  // Pass 3: bare "json" marker (no backticks) at the start of a line, optionally
  // followed by a newline, then a single-line JSON object.
  // Handles model outputs like "json\n{...}" and "json {...}".
  text = text.replace(/(^|\r?\n)([ \t]*json[ \t]*\r?\n?[ \t]*)(\{[^\n\r]+\})/gi,
    (match, newline, _prefix, inner) => {
      tryExtract(inner.trim());
      return newline; // keep leading newline to preserve line breaks
    });

  // Pass 4: standalone single-line JSON object with a "verb" field on its own line.
  // Handles bare {"verb":"..."} that the model emits without any wrapper.
  text = text.replace(/^[ \t]*(\{[^\n\r]+"verb"[^\n\r]*\})[ \t]*$/gm, (match, inner) => {
    if (tryExtract(inner.trim())) return "";
    return match; // not a valid dispatch — leave as-is
  });

  return { dispatches, text: text.trim() };
}

// ---- Remote inference path (serve_lora.py / llama-server) -----------------

// Formats messages into the gemma instruction-tuned prompt for /completion.
// Fallback when /v1/chat/completions has a broken --chat-template (llama-server
// b8786 bug: --chat-template gemma renders as literal "gemma", 3 tokens only).
function formatGemmaCompletionPrompt(
  messages: Array<{ role: string; content: string | unknown[] }>,
): string {
  const parts: string[] = ["<bos>"];
  let pendingSystem = "";
  for (const msg of messages) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content as Array<{ type: string; text?: string }>)
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join("");
    if (msg.role === "system") {
      pendingSystem = text;
    } else if (msg.role === "user") {
      const combined = pendingSystem ? `${pendingSystem}\n\n${text}` : text;
      parts.push(`<start_of_turn>user\n${combined}<end_of_turn>\n`);
      pendingSystem = "";
    } else if (msg.role === "assistant") {
      parts.push(`<start_of_turn>model\n${text}<end_of_turn>\n`);
    }
  }
  parts.push("<start_of_turn>model\n");
  return parts.join("");
}

async function runRemoteAgentTurn(req: AgentRequest): Promise<AgentResponse> {
  const MAX_HISTORY_MSGS = 20;
  const trimmedHistory = (req.history ?? []).slice(-MAX_HISTORY_MSGS);

  // Build user content — OpenAI vision format when a pre-encoded image is present.
  type TextPart = { type: "text"; text: string };
  type ImageURLPart = { type: "image_url"; image_url: { url: string } };
  type RemoteContent = string | Array<TextPart | ImageURLPart>;

  const userContent: RemoteContent = req.userImage
    ? [
        { type: "image_url", image_url: { url: req.userImage } } satisfies ImageURLPart,
        { type: "text", text: req.prompt } satisfies TextPart,
      ]
    : req.prompt;

  const messages = [
    { role: "system" as const, content: buildSystemPrompt(req.skills) },
    ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · REMOTE ·  ⟳`);

  const resp = await fetch(`${REMOTE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens: 4096, temperature: 0.1 }),
  });
  if (!resp.ok) throw new Error(`remote agent: HTTP ${resp.status} from ${REMOTE_URL}`);

  const json = (await resp.json()) as {
    choices: Array<{ message: { role: string; content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    _latency_ms?: number;
    _tps?: number;
    _mtp_enabled?: boolean;
  };

  // Detect broken llama-server --chat-template rendering (b8786 bug): all inputs
  // collapse to ≤5 tokens. Fall back to /completion with gemma-formatted prompt.
  if ((json.usage?.prompt_tokens ?? 999) <= 5) {
    // ctx-size 8192 → ~24K char budget. Trim system message to fit if oversized.
    const PROMPT_CHAR_LIMIT = 20000;
    const fallbackMessages = [...messages];
    let prompt = formatGemmaCompletionPrompt(fallbackMessages);
    if (prompt.length > PROMPT_CHAR_LIMIT) {
      const sysMsg = fallbackMessages[0];
      if (sysMsg?.role === "system" && typeof sysMsg.content === "string") {
        const excess = prompt.length - PROMPT_CHAR_LIMIT;
        sysMsg.content = sysMsg.content.slice(0, Math.max(100, sysMsg.content.length - excess));
        prompt = formatGemmaCompletionPrompt(fallbackMessages);
      }
    }
    const compResp = await fetch(`${REMOTE_URL}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, n_predict: 4096, temperature: 0.1, stop: ["<end_of_turn>"] }),
    });
    if (!compResp.ok) throw new Error(`remote agent fallback: HTTP ${compResp.status}`);
    const compJson = (await compResp.json()) as { content: string; tokens_predicted?: number };
    const content = compJson.content ?? "";
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · REMOTE`);
    recordTurn({
      ts: Date.now(),
      prefill_ms: 0,
      decode_ms: 0,
      tokens_in: 0,
      tokens_out: compJson.tokens_predicted ?? 0,
      system_prompt_chars: buildSystemPrompt(req.skills).length,
      skills_total: req.skillsTotal ?? req.skills?.length ?? 0,
      skills_matched: req.skills?.length ?? 0,
      tg_tps: 0,
      pp_tps: 0,
      mtp_on: false,
      path: "remote",
    });
    const { dispatches, text } = parseDispatches(content);
    return { dispatches, text: text || content, raw: compJson };
  }

  const content = json.choices[0]?.message?.content ?? "";
  const tpsLabel = json._tps != null ? ` · ${json._tps.toFixed(0)} t/s` : "";
  const mtpLabel = json._mtp_enabled ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · REMOTE${mtpLabel}${tpsLabel}`);

  recordTurn({
    ts: Date.now(),
    prefill_ms: 0,
    decode_ms: json._latency_ms ?? 0,
    tokens_in: json.usage?.prompt_tokens ?? 0,
    tokens_out: json.usage?.completion_tokens ?? 0,
    system_prompt_chars: buildSystemPrompt(req.skills).length,
    skills_total: req.skillsTotal ?? req.skills?.length ?? 0,
    skills_matched: req.skills?.length ?? 0,
    tg_tps: json._tps ?? 0,
    pp_tps: 0,
    mtp_on: json._mtp_enabled ?? false,
    path: "remote",
  });
  const { dispatches, text } = parseDispatches(content);
  return { dispatches, text: text || content, raw: json };
}

// ---- Standard backend turn (#929) ----------------------------------------

/** Route a turn through the dedicated standard-backend worker.
 *  Used when drafter failed to load and _standardBackend is ready. */
async function runStandardBackendTurn(req: AgentRequest): Promise<AgentResponse> {
  const sb = _standardBackend!;
  const MAX_HISTORY_MSGS = 60;
  const trimmedHistory = (req.history ?? []).slice(-MAX_HISTORY_MSGS);
  const _sysPrompt = buildWebGPUSystemPrompt(req.skills);
  const messages = [
    { role: "system" as const, content: _sysPrompt },
    ...trimmedHistory,
    { role: "user" as const, content: req.prompt },
  ];

  const t0 = Date.now();
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel} · ⟳`);

  const stream = sb.generate({ messages, maxNewTokens: req.maxNewTokens ?? 512 });
  // Drain the token stream (satisfies AC: tokens stream back via postMessage inside worker)
  for await (const _tok of stream) { /* tokens flow via postMessage internally */ }

  const { text: responseText, tokensOut } = await stream.resultPromise;
  const decodeMs = Date.now() - t0;
  const tgTps = decodeMs > 0 ? tokensOut / (decodeMs / 1000) : 0;
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel} · ${tgTps.toFixed(0)} t/s`);

  let plan: string | undefined;
  const afterPlan = responseText.replace(/<plan>([\s\S]*?)<\/plan>/i, (_, inner: string) => {
    plan = inner.trim();
    return "";
  });
  const { dispatches, text } = parseDispatches(afterPlan);
  return { dispatches, text: text.trim() || responseText, plan, raw: undefined };
}

// ---- Public entry point --------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
  // P10-2: if a prior worker error engaged the session-level fallback, route remote.
  if (REMOTE_URL && _webgpuFallbackEngaged) return runRemoteAgentTurn(req);
  if (REMOTE_URL) return runRemoteAgentTurn(req);

  // #929: if drafter failed and dedicated standard backend is ready, use it.
  // Standard backend runs model.generate() in its own isolated worker so the
  // MTP worker thread is not contended during standard-path inference.
  const drafterLoaded = (globalThis as unknown as { __drafterLoaded?: boolean }).__drafterLoaded;
  if (_standardBackend && drafterLoaded === false && !payloadHasMultimodal(req)) {
    return runStandardBackendTurn(req);
  }

  // ── On-device path via Web Worker (#936) ─────────────────────────────────
  // Worker owns: from_pretrained, WebGPU probe, warmup, drafter load, tokenization,
  // generate, decode. Main thread never blocks during model load or inference.
  const worker = initWorkerIfNeeded();

  // Get imageUrl for vision turns (worker loads RawImage internally — no transfer needed).
  let imageUrl: string | undefined;
  if (req.userImage) {
    imageUrl = req.userImage;
  } else if (req.frames && req.frames.length > 0) {
    imageUrl = captureViewport() ?? undefined;
  }

  // Plain-text messages: worker splices image into last user message if imageUrl is set.
  // §C (#990): build once, reuse length for telemetry — avoids redundant 7K-char rebuild.
  const MAX_HISTORY_MSGS = 60;
  const trimmedHistory = (req.history ?? []).slice(-MAX_HISTORY_MSGS);
  const _sysPrompt = buildWebGPUSystemPrompt(req.skills);
  const messages = [
    { role: "system" as const, content: _sysPrompt },
    ...trimmedHistory,
    { role: "user" as const, content: req.prompt },
  ];

  const useMtp = !_MTP_OFF;
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  let result: WorkerGenResult;
  try {
    result = await new Promise<WorkerGenResult>((resolve, reject) => {
      _generateCallbacks.set(turnId, { resolve, reject });
      worker.postMessage({
        type:          "generate",
        turnId,
        messages,
        imageUrl,
        maxNewTokens:  req.maxNewTokens ?? 512,
        eosId:         1, // Gemma 4 EOS; worker also reads model.config as fallback
        draftK:        MTP_DRAFT_N,
        useMtp,
      });
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("input too long") && REMOTE_URL) return runRemoteAgentTurn(req);
    if (_webgpuFallbackEngaged && REMOTE_URL) return runRemoteAgentTurn(req);
    throw err;
  }

  const { text: responseText, specAttempts, specAccepts, prefillMs, decodeMs, inputLength, tokensOut } = result;
  const _mtpActive = useMtp && specAttempts > 0;
  const tgTps = decodeMs > 0 ? tokensOut / (decodeMs / 1000) : 0;
  const ppTps = prefillMs > 0 ? inputLength / (prefillMs / 1000) : 0;
  const _specAcceptRate = specAttempts > 0 ? specAccepts / specAttempts : 0;
  console.debug(`[agent] prefill=${Math.round(prefillMs)}ms decode=${Math.round(decodeMs)}ms in=${inputLength} out=${tokensOut} tg=${tgTps.toFixed(1)}t/s mtp=${_mtpActive}`);
  const _mtpSuffix = _mtpActive ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel} · ${tgTps.toFixed(0)} t/s${_mtpSuffix}`);
  recordTurn({
    ts:                  Date.now(),
    prefill_ms:          prefillMs,
    decode_ms:           decodeMs,
    tokens_in:           inputLength,
    tokens_out:          tokensOut,
    system_prompt_chars: _sysPrompt.length,
    skills_total:        req.skillsTotal ?? req.skills?.length ?? 0,
    skills_matched:      req.skills?.length ?? 0,
    tg_tps:              tgTps,
    pp_tps:              ppTps,
    mtp_on:              _mtpActive,
    spec_attempts:       specAttempts,
    spec_accepts:        specAccepts,
    spec_accept_rate:    _specAcceptRate,
    path:                "webgpu",
  });

  let plan: string | undefined;
  const afterPlan = responseText.replace(/<plan>([\s\S]*?)<\/plan>/i, (_, inner: string) => {
    plan = inner.trim();
    return "";
  });

  const { dispatches, text } = parseDispatches(afterPlan);
  return { dispatches, text: text.trim() || responseText, plan, raw: undefined };
}
