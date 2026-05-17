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

import { Gemma4ForConditionalGeneration, AutoProcessor, RawImage, PreTrainedModel } from "@huggingface/transformers";
import { getDictionary } from "../commands/dictionary";
import { listHandlers } from "../commands/dispatch";
import { getMtpSessions, runMtpSpecDecode, MTP_CONFIG_E4B } from "./webgpu-mtp-backend.js";

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

// P10-2: session-level flag; set on first OrtRun failure during inference.
// When true, all subsequent runAgentTurn() calls route to remote regardless of
// whether the model loaded successfully in-browser.
let _webgpuFallbackEngaged = false;
let _deviceLabel = "GPU"; // updated after model load to reflect actual backend

// On-device WebGPU context size limit (#424). Shared with prefill warmup (#492).
const WEBGPU_CONTEXT_LIMIT = 2048;

// System-prompt prefill deduplication guard (#492).
let _prefillDone = false;

// ---- Model loading (in-browser path) ---------------------------------------

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

let _model: PreTrainedModel | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _processor: any = null;
let _loadPromise: Promise<{ model: PreTrainedModel; processor: unknown }> | null = null;

// ── MTP drafter (#674 AC3-AC5) ───────────────────────────────────────────────
//
// Gemma 4 MTP uses a 78M drafter (gemma-4-E2B-it-assistant) that operates on
// the TARGET model's hidden states and KV cache, not on token embeddings alone.
// The drafter is exported to ONNX and loaded as a second InferenceSession.
//
// spec-decode loop prerequisites (ALL THREE must be true for _mtpActive = true):
//   1. Drafter ONNX loaded successfully (_drafterSession !== null)
//   2. Target ONNX exposes "last_hidden_state" output node
//   3. MTP_VERIFICATION_WIRED === true (real per-token target verification implemented)
//
// transformers.js 4.2.0 does NOT expose target hidden states (condition 2 false),
// AND verification is not yet wired (condition 3 false) — the spec-decode branch is
// structurally dormant today. Fallback (AC5): standard model.generate() is always used
// when any prerequisite fails. (#679 added condition 3 to prevent drafter-only unverified
// output from silently activating when conditions 1+2 become true upstream.)
//
// Drafter ONNX input interface (E4B — see scripts/export-drafter-e4b-onnx.py):
//   inputs_embeds [B, seq, 5120] = cat([target_token_embed, target_hidden_state], dim=-1)
//   position_ids  [B, seq]       = constant at last-seen-token position for all draft steps
//   sliding_k     [B, 2, kv, 256] = target last sliding_attention layer K (2 KV heads)
//   sliding_v     [B, 2, kv, 256] = target last sliding_attention layer V
//   full_k        [B, 2, kv, 512] = target last full_attention layer K (2 KV heads)
//   full_v        [B, 2, kv, 512] = target last full_attention layer V
// Outputs: logits [B, seq, 262144], projected_state [B, seq, 2560]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtSession = any; // onnxruntime-web InferenceSession (loaded dynamically)

let _drafterSession: OrtSession | null = null;
let _drafterLoadAttempted = false;
let _drafterLoadPromise: Promise<void> | null = null;

// Relative path — served same-origin from public/models/ (avoids CORS block on GitHub Releases).
// For production deploy: include drafter.onnx in the deployment bundle or proxy via a CORS-enabled CDN.
const DRAFTER_ONNX_URL = "/models/gemma-4-E4B-it-assistant/drafter.onnx";
// Bump this key to bust the IDB cache when a new drafter export is deployed.
const DRAFTER_CACHE_KEY = "mtp-drafter-e4b-v1";
const MTP_DRAFT_N = 3; // candidate tokens to draft per speculation step
// Flip to true when drafter ONNX is deployed and output names are confirmed (#738).
// Two-gate design: drafter loaded + verification wired. Target hidden-state exposure
// is best-effort (approximated by token embedding when unavailable).
const MTP_VERIFICATION_WIRED = true;

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

async function loadDrafter(): Promise<void> {
  if (_drafterLoadAttempted) return;
  _drafterLoadAttempted = true;
  try {
    // onnxruntime-web is already loaded by transformers.js — access the global.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ort = (globalThis as any).ort ?? (await import("onnxruntime-web"));
    // IDB-backed fetch: first call downloads 158 MB and caches; subsequent calls
    // read from IDB (~ms) skipping the network entirely. Bump DRAFTER_CACHE_KEY
    // to invalidate the cache when a new drafter export is deployed.
    const { fetchDrafterCached } = await import("./drafter-cache.js");
    const drafterBuf = await fetchDrafterCached(DRAFTER_ONNX_URL, DRAFTER_CACHE_KEY);
    _drafterSession = await ort.InferenceSession.create(drafterBuf, {
      executionProviders: ["webgpu", "wasm"],
      // Drafter runs on WebGPU EP; output tensors are GPU-resident by default.
      // tensor.data is null for GPU tensors — read via getData() or pin to CPU.
      // Pinning both outputs to CPU so argmax(logits.data) and projState.data
      // are valid synchronously without an explicit getData() call per step.
      preferredOutputLocation: { logits: "cpu", proj_state: "cpu" },
    });
    console.info("[agent-harness] Drafter ONNX loaded — MTP spec-decode active (#738).");
    // Signal for external tooling (A/B scripts, verify harness) that drafter is ready.
    (globalThis as any).__drafterLoaded = true;
  } catch (e) {
    // AC5: graceful fallback — network error, version mismatch, model not hosted yet.
    console.warn(
      "[agent-harness] Drafter ONNX load failed (AC5 fallback, standard generate active):",
      (e as Error).message?.slice(0, 120),
    );
    _drafterSession = null;
    (globalThis as any).__drafterLoaded = false;
  }
}

// Expose drafter load trigger and ready flag for external tooling (A/B scripts, verify).
// __loadDrafter() returns a Promise that resolves when drafter is done loading (or failed).
// __drafterLoaded is true on success, false on failure, undefined if load not yet triggered.
if (typeof globalThis !== "undefined") {
  (globalThis as any).__loadDrafter = (): Promise<void> => {
    _drafterLoadPromise ??= loadDrafter();
    return _drafterLoadPromise;
  };
}

function updateBadge(inner: string): void {
  const el = document.getElementById(BADGE_ID);
  if (el) el.innerHTML = inner;
}

type ProgressInfo = {
  status: string;
  name?: string;
  progress?: number;
};

// Try WebGPU first (q4f16 quantization); fall back through device:"auto"
// (onnxruntime-web selects WebGL then WASM-SIMD automatically). Model files
// are cached in browser storage after first download — subsequent visits skip
// the network transfer entirely.
async function getModel(): Promise<{ model: PreTrainedModel; processor: unknown }> {
  if (_model && _processor) return { model: _model, processor: _processor };
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LOADING…`);
    window.dispatchEvent(new CustomEvent("agentmodel:loading", { detail: { progress: 0 } }));

    const progressCb = (info: ProgressInfo) => {
      if (info.status === "downloading") {
        const pct = info.progress != null ? `${Math.round(info.progress)}%` : "";
        const file = info.name?.split("/").pop() ?? "";
        const label = [pct, file].filter(Boolean).join(" ");
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ${label}`);
        window.dispatchEvent(
          new CustomEvent("agentmodel:loading", { detail: { progress: info.progress ?? 0, file } }),
        );
      } else if (info.status === "loading") {
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  INITIALIZING`);
      }
    };

    type DeviceSpec = { device: "webgpu" | "auto"; dtype: "q4f16" | "q4"; label: string };
    const backends: DeviceSpec[] = [
      { device: "webgpu", dtype: "q4f16", label: "GPU" },
      { device: "auto",   dtype: "q4",    label: "CPU" },
    ];

    let lastErr: Error = new Error("No backend available");
    for (const { device, dtype, label } of backends) {
      try {
        const model = await Gemma4ForConditionalGeneration.from_pretrained(MODEL_ID, {
          dtype,
          device,
          progress_callback: progressCb,
        });
        const processor = await AutoProcessor.from_pretrained(MODEL_ID);

        // Probe WebGPU for silent OrtRun buffer corruption (#128/#133).
        // onnxruntime-web 1.26.0-dev + Chrome 147 regression: from_pretrained
        // succeeds but GPU buffers can be invalid; error only surfaces mid-decode
        // (buffer download path not exercised on a 1-token run). Use 20 tokens
        // to force the iterative decode path that triggers the failure.
        if (device === "webgpu") {
          try {
            const probeText = (processor as any).tokenizer.apply_chat_template(
              [{ role: "user", content: "test" }],
              { tokenize: false, add_generation_prompt: true },
            ) as string;
            const probeIn = await (processor as any)(probeText);
            await (model as any).generate({ ...probeIn, max_new_tokens: 20 });
          } catch (probeErr) {
            console.warn(
              "[agent-harness] WebGPU probe failed — OrtRun buffer invalid (#128); falling back to CPU.",
              (probeErr as Error).message.slice(0, 120),
            );
            continue; // skip assignment; next backend (CPU) will be tried
          }
        }

        _model = model;
        _processor = processor;
        _deviceLabel = label;
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${label}`);
        window.dispatchEvent(new CustomEvent("agentmodel:ready", { detail: { device, label } }));
        return { model, processor };
      } catch (e) {
        lastErr = e as Error;
        if (device === "webgpu") {
          console.warn("[agent-harness] WebGPU unavailable, trying CPU fallback:", (e as Error).message);
          updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LOADING CPU…`);
        }
      }
    }

    window.dispatchEvent(new CustomEvent("agentmodel:error", { detail: lastErr.message }));
    throw lastErr;
  })();

  // _loadPromise was assigned on the line above — non-null is guaranteed here.
  return _loadPromise!;
}

/** Fire-and-forget model prefetch + system-prompt KV warmup (#492).
 *  Safe to call early (prompt tab focus / DOMContentLoaded).
 *  Badge flow: PRIMING → READY (remote) | LOADING → LIVE → PRIMING → READY (on-device). */
export function prefetchModel(): void {
  if (REMOTE_URL) {
    void prefillSystemPromptAsync();
    return;
  }
  getModel()
    .then(() => prefillSystemPromptAsync())
    .catch(() => { /* errors surface on first runAgentTurn */ });
}

/** System-prompt KV warmup (#492). Fires once per session.
 *  Remote: primes llama-server KV prefix cache so subsequent prompts skip system-prompt re-prefill.
 *  On-device: warms GPU shader pipeline and ONNX execution context. */
async function prefillSystemPromptAsync(): Promise<void> {
  if (_prefillDone) return;
  _prefillDone = true;

  if (REMOTE_URL) {
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
    return;
  }

  // On-device path: warm GPU shader pipeline with a 1-token probe generation.
  try {
    const { model, processor } = await getModel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = processor as any;
    const label = document.getElementById(BADGE_ID)?.innerHTML?.includes("CPU") ? "CPU" : "GPU";
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${label} · ⟳ PRIMING`);
    const chatText: string = proc.apply_chat_template(
      [
        { role: "system", content: buildWebGPUSystemPrompt() },
        { role: "user", content: "." },
      ],
      { add_generation_prompt: true, tokenize: false },
    ) as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs: any = await proc(chatText, null);
    const tokCount: number = inputs.input_ids?.dims?.[1] ?? 0;
    if (tokCount < WEBGPU_CONTEXT_LIMIT - 64) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (model as any).generate({ ...inputs, max_new_tokens: 1, do_sample: false });
    }
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${label} · READY`);
  } catch {
    _prefillDone = false; // allow retry on first real prompt
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
- Height: floor_height × n_stories. "3-story, 3m floor height" → total=9m; use 3m per SdLevel.
- Footprint polygon: [[0,0],[W,0],[W,D],[0,D]] where W=width, D=depth.
- Multi-story: one SdLevel per floor, elevation = floor_index × floor_height. Default floor heights: 3.0m office/residential, 4.5m industrial/bay.
- SdSpace must include a descriptive name= param: name="lobby", name="apparatus bay 1", etc.
`.trim();

const BUILDING_DEFAULTS = `
BUILDING DEFAULTS — apply when dimensions are unspecified. "Design a house/apartment/office" implies ALL of the following element types:
- SdLevel: one per storey (elevation = floor_index × floor_height). Always emit before walls on that level.
- SdWall: exterior 0.15m thick; interior partition 0.10m thick. Enclose all rooms — no open faces.
- SdSlab: 0.20m thick at every level base (floor slab). Also use for roof on flat-roof buildings.
- SdDoor: width=0.9, height=2.1, wallThickness=0.15. One per building minimum; front entry on south wall.
- SdWindow: width=1.2, height=1.2, sillH=0.9. Minimum 2 per exterior elevation (south + north or east + west).
- SdColumn: size=0.3 at building corners and wall junctions; height = floor height. Add when span >6m.
- SdRoof: roofType=pitched (residential house/tiny home), roofType=hipped (villa), roofType=flat (apartment/office), roofType=shed (lean-to/mono-pitch, industrial annexe). pitchDeg=35 default.
- SdCeiling: one per storey, placed at floor_height elevation. width/depth = room footprint. elevation = floor_index × floor_height + floor_height (top of room). IFC convention: explicit IfcCovering element; do NOT rely on slab-above as implicit ceiling.
- SdExport: always end with format=ifc, target=scene.
- Room sizes (net internal): bedroom 9-15m², living 18-25m², kitchen 8-12m², bathroom 4-6m².
- Floor heights: residential 3.0m, office 3.5m, industrial/bay 4.5m.
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

User: put this wall on the Construction layer instead
Assistant: Assuming the wall profile and dimensions from context; overriding layer to Construction.
<plan>
1. SdWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8, layer=Construction
</plan>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8,"layer":"Construction"},"metadata":{"source":"agent"}}</tool_call>

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
1. SdLevel — name="Ground", elevation=0, height=3.0
2. SdWall — south front, profile=[[0,0],[8,0]], thickness=0.15, height=3.0
3. SdWall — north rear, profile=[[8,6],[0,6]], thickness=0.15, height=3.0
4. SdWall — east, profile=[[8,0],[8,6]], thickness=0.15, height=3.0
5. SdWall — west, profile=[[0,6],[0,0]], thickness=0.15, height=3.0
6. SdSlab — floor, profile=[[0,0],[8,0],[8,6],[0,6]], thickness=0.2
7. SdWall — living/bedroom partition, profile=[[5,0],[5,6]], thickness=0.1, height=3.0
8. SdWall — bedroom/bath divider, profile=[[5,4],[8,4]], thickness=0.1, height=3.0
9. SdDoor — front entry, width=0.9, height=2.1, position=[4,0]
10. SdWindow — south left, width=1.2, height=1.2, sillH=0.9, position=[1.5,0]
11. SdWindow — south right, width=1.2, height=1.2, sillH=0.9, position=[6.5,0]
12. SdWindow — east, width=1.0, height=1.2, sillH=0.9, position=[8,3]
13. SdWindow — north, width=1.0, height=1.2, sillH=0.9, position=[4,6]
14. SdRoof — pitched gable, roofType=pitched, footprint=[[0,0],[8,0],[8,6],[0,6]], pitchDeg=35
15. SdExport — format=ifc, target=scene
</plan>
<tool_call>{"command":"SdLevel","parameters":{"name":"Ground","elevation":0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[8,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,6],[0,6]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[8,0],[8,6]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,6],[0,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[8,0],[8,6],[0,6]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[5,0],[5,6]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[5,4],[8,4]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":0.9,"height":2.1,"position":[4,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[1.5,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[6.5,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[8,3]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[4,6]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdRoof","parameters":{"roofType":"pitched","footprint":[[0,0],[8,0],[8,6],[0,6]],"pitchDeg":35},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdExport","parameters":{"format":"ifc","target":"scene"},"metadata":{"source":"agent"}}</tool_call>

User: design a 2-storey house
Assistant: Assuming 10m × 8m footprint, 2 storeys at 3.0m each, 4 bedrooms upper / living+kitchen lower, gable roof, 2 doors, 6 windows.
<plan>
1. SdLevel — name="Ground", elevation=0, height=3.0
2. SdLevel — name="First Floor", elevation=3.0, height=3.0
3. setActiveLevel — id=level/0
4. SdWall — south ground, profile=[[0,0],[10,0]], thickness=0.15, height=3.0
5. SdWall — north ground, profile=[[10,8],[0,8]], thickness=0.15, height=3.0
6. SdWall — east ground, profile=[[10,0],[10,8]], thickness=0.15, height=3.0
7. SdWall — west ground, profile=[[0,8],[0,0]], thickness=0.15, height=3.0
8. SdSlab — ground floor, profile=[[0,0],[10,0],[10,8],[0,8]], thickness=0.2
9. SdWall — kitchen/living partition, profile=[[5,0],[5,8]], thickness=0.1, height=3.0
10. SdDoor — front entry, width=0.9, height=2.1, position=[5,0]
11. SdDoor — rear patio, width=0.9, height=2.1, position=[5,8]
12. SdWindow — south ×2, width=1.2, height=1.2, sillH=0.9
13. SdWindow — north, width=1.0, height=1.2, sillH=0.9, position=[7,8]
14. setActiveLevel — id=level/1
15. SdWall — south upper, profile=[[0,0],[10,0]], thickness=0.15, height=3.0
16. SdWall — north upper, profile=[[10,8],[0,8]], thickness=0.15, height=3.0
17. SdWall — east upper, profile=[[10,0],[10,8]], thickness=0.15, height=3.0
18. SdWall — west upper, profile=[[0,8],[0,0]], thickness=0.15, height=3.0
19. SdSlab — mid-floor ceiling/upper floor, profile=[[0,0],[10,0],[10,8],[0,8]], thickness=0.2
20. SdWall — bedroom partitions, profile=[[5,0],[5,8]], thickness=0.1, height=3.0
21. SdWall — bedroom partition 2, profile=[[0,4],[5,4]], thickness=0.1, height=3.0
22. SdWindow — upper south ×2, width=1.2, height=1.2, sillH=0.9
23. SdWindow — upper north, width=1.0, height=1.2, sillH=0.9
24. SdRoof — pitched gable, roofType=pitched, footprint=[[0,0],[10,0],[10,8],[0,8]], pitchDeg=35
25. SdExport — format=ifc, target=scene
</plan>
<tool_call>{"command":"SdLevel","parameters":{"name":"Ground","elevation":0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdLevel","parameters":{"name":"First Floor","elevation":3.0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[10,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[10,8],[0,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[10,0],[10,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[10,0],[10,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[5,0],[5,8]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":0.9,"height":2.1,"position":[5,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"width":0.9,"height":2.1,"position":[5,8]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[2,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[7,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[7,8]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[10,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[10,8],[0,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[10,0],[10,8]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.15,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[10,0],[10,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[5,0],[5,8]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,4],[5,4]],"thickness":0.1,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[2,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.2,"height":1.2,"sillH":0.9,"position":[7,0]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"width":1.0,"height":1.2,"sillH":0.9,"position":[7,8]},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdRoof","parameters":{"roofType":"pitched","footprint":[[0,0],[10,0],[10,8],[0,8]],"pitchDeg":35},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdExport","parameters":{"format":"ifc","target":"scene"},"metadata":{"source":"agent"}}</tool_call>

User: Describe the default scene in one sentence.
Assistant: The viewport shows an empty three-dimensional canvas — no geometry has been placed yet, and the Current scene contains no objects.

User: What's in the scene?
Assistant: The scene is currently empty — no walls, slabs, or spaces have been placed. The viewport shows a neutral 3D environment ready for your first command.

User: What do you see?
Assistant: Four white extruded walls meeting at right angles enclose a rectangular room roughly 8 m × 6 m in plan, with a flat gray slab at the base and a ceiling plane at 3.0 m. The Current scene contains: 4 walls (200 mm thick, 3.0 m tall), 1 floor slab, 1 ceiling.
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
    FEW_SHOT_EXAMPLES,
    summariseDictionary(),
    `Current scene: ${buildSceneContext()}`,
    "SCENE QUERY RESPONSE: when asked to describe the scene, what you see, what is in the scene, or what the default scene looks like — respond with PLAIN TEXT ONLY. Do NOT emit <plan> or <tool_call> blocks. Instead: (1) describe the viewport image visually: shapes, colors, materials, arrangement, scale (2-3 sentences); (2) narrate the object inventory from the \'Current scene:\' line above in plain English. Combine into ONE natural prose paragraph. No bullet lists. No Sd* names in prose — verb chips are shown separately in the UI.",
    summariseSkills(skills),
    summariseClusters(),
  ].filter(Boolean).join("\n\n");
}

// Compact system prompt for the on-device WebGPU path (#424 follow-up).
// The E2B model's compiled context window (~2048 tokens) cannot fit the full
// prompt (summariseDictionary alone is ~1200 tokens). This version:
//   - drops BUILDING_DEFAULTS (large, inferred by model training)
//   - uses 1 minimal few-shot example instead of 6
//   - replaces summariseDictionary (full args) with verb-names-only list
// Result: ~600-700 tokens vs ~3000, leaving ~1300+ tokens for generation.
export function buildWebGPUSystemPrompt(skills?: Skill[]): string {
  const dict = getDictionary();
  const implemented = new Set(listHandlers());
  const available = implemented.size > 0 ? dict.filter((e) => implemented.has(e.canonical_name)) : dict;
  const verbNames = available.map((e) => e.canonical_name).join(", ");
  const verbList = verbNames.length > 0
    ? `Available verbs (use ONLY these exact names): ${verbNames}`
    : "No verbs currently available. Do not emit function calls.";

  return [
    "You are Gemma, a parametric CAD assistant. Be direct — no preamble.",
    "PLAN BEFORE DISPATCH: emit <plan> block first, then <tool_call> blocks.\nExample:\n<plan>\n1. SdWall — profile=[[0,0],[5,0]], height=2.8\n</plan>\n<tool_call>{\"command\":\"SdWall\",\"parameters\":{\"profile\":[[0,0],[5,0]],\"height\":2.8},\"metadata\":{\"source\":\"agent\"}}</tool_call>",
    "AMBIGUITY: infer defaults, state ONE assumption, execute. Do NOT ask questions.",
    DIMENSION_RULES,
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

  // Pass 1: FunctionGemma-style <tool_call>{...}</tool_call> blocks.
  let text = raw.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi, (_, inner) => {
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

// ---- Public entry point --------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
  // P10-2: if a prior OrtRun failure engaged the session-level fallback, route remote.
  if (REMOTE_URL && _webgpuFallbackEngaged) return runRemoteAgentTurn(req);
  if (REMOTE_URL) return runRemoteAgentTurn(req);
  const { model, processor } = await getModel();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = processor as any;

  type TextPart = { type: "text"; text: string };
  type ImagePart = { type: "image"; image: RawImage };
  type ContentPart = TextPart | ImagePart;
  type UserContent = string | ContentPart[];

  // Only attach viewport image when the caller explicitly requests it via
  // req.frames (e.g. user clicked "look at scene" or typed "what do you see?").
  // Proactive capture caused the model to narrate and act on scene state without
  // being asked — Jun directive 2026-05-06.
  const imageList: RawImage[] = [];
  let userContent: UserContent;
  if (req.userImage) {
    // User-attached image (D1 multimodal) — use directly without viewport capture.
    const rawImage = await RawImage.fromURL(req.userImage);
    imageList.push(rawImage);
    userContent = [
      { type: "image", image: rawImage } satisfies ImagePart,
      { type: "text", text: req.prompt } satisfies TextPart,
    ];
  } else if (req.frames && req.frames.length > 0) {
    const snapshotUrl = captureViewport();
    if (snapshotUrl) {
      const rawImage = await RawImage.fromURL(snapshotUrl);
      imageList.push(rawImage);
    }
    userContent = imageList.length > 0
      ? [
          { type: "image", image: imageList[0] } satisfies ImagePart,
          { type: "text", text: req.prompt } satisfies TextPart,
        ]
      : req.prompt;
  } else {
    userContent = req.prompt;
  }

  // Keep at most the last 10 turns (20 messages) to bound prefill length.
  // Beyond ~10 turns, older context hurts latency more than it helps accuracy.
  const MAX_HISTORY_MSGS = 20;
  const trimmedHistory = (req.history ?? []).slice(-MAX_HISTORY_MSGS);

  const messages = [
    { role: "system" as const, content: buildWebGPUSystemPrompt(req.skills) },
    ...trimmedHistory,
    { role: "user" as const, content: userContent },
  ];

  // Gemma4Processor._call(text, images, audio, options) — passing options as the
  // second argument incorrectly routes it to `images`, causing image.rgb() errors.
  // Correct approach: apply chat template to get a string, then call proc(text, images).
  const chatText: string = proc.apply_chat_template(messages, {
    add_generation_prompt: true,
    tokenize: false,
  }) as string;

  // Encode: processor tokenizes text and encodes images (null when text-only).
  console.log("[vision] proc: images=", imageList.length, "userImage=", req.userImage ? req.userImage.length : 0);
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any = await proc(chatText, imageList.length > 0 ? imageList : null);
  const tProc = performance.now();
  console.log("[vision] tokens=", inputs.input_ids?.dims?.[1]);

  // Guard: WebGPU ONNX model compiled context limit ~2048 tokens (#424).
  // Long system prompts (summariseDictionary + BUILDING_DEFAULTS + FEW_SHOT) reach
  // 2000-3000 tokens, pushing input + max_new_tokens past the limit and triggering
  // SafeIntOnOverflow in OrtRun buffer shape computation.
  // Route to REMOTE for long inputs without permanently engaging _webgpuFallbackEngaged —
  // WebGPU remains available for shorter prompts within the same session.
  // WEBGPU_CONTEXT_LIMIT is now at module level (shared with prefill warmup #492).
  const preCheckLen: number = inputs.input_ids?.dims?.[1] ?? 0;
  const safeMaxNewTokens = Math.min(req.maxNewTokens ?? 512, WEBGPU_CONTEXT_LIMIT - preCheckLen);
  if (preCheckLen + 64 > WEBGPU_CONTEXT_LIMIT || safeMaxNewTokens <= 0) {
    window.dispatchEvent(new CustomEvent("agent:telemetry", {
      detail: { event: "webgpu_input_too_long", inputTokens: preCheckLen, safeMaxNewTokens },
    }));
    if (REMOTE_URL) return runRemoteAgentTurn(req);
    throw new Error(`Prompt too long for on-device inference (${preCheckLen} tokens > ${WEBGPU_CONTEXT_LIMIT - 64} safe limit). Configure VITE_GEMMA_AGENT_URL for complex prompts.`);
  }

  // Generate — greedy decoding for deterministic function-call JSON.
  // P10-2: catch OrtRun failures that slip past the load-time probe (#128/#133).
  //
  // MTP spec-decode (#674 AC3):
  // Fire-and-forget drafter load on first generate call so it's ready by turn 2.
  // The spec-decode branch activates only when BOTH conditions hold:
  //   (a) drafter ONNX loaded (_drafterSession !== null)
  //   (b) target ONNX exposes "last_hidden_state" output node
  // Condition (b) is false in transformers.js 4.2.0 — the branch is structurally
  // dormant today but will fire automatically once the target ONNX is updated.
  // AC5: any drafter load failure is silently swallowed in loadDrafter(); no crash.
  // Store promise so turn-1 can await it (fixes drafter-race: gate evaluated before
  // session.create completes even on IDB hit — #754 Finding #1).
  _drafterLoadPromise ??= loadDrafter();
  await _drafterLoadPromise;

  // Two-gate (#793) + E2B model guard:
  //   drafter loaded + verification wired + E2B model active.
  // E4B drafter (#793): exported from google/gemma-4-E4B-it-assistant (302 MB fp32).
  // KV shapes match E4B target: 24 layers, 2 KV heads, hidden_size=2560.
  // Visual turns included — drafter is unconditioned on the image; accept_rate is
  // lower on visual turns but >0, which beats the prior 0% bypass on all-E4B sessions.
  const drafterReady =
    _drafterSession !== null &&
    MTP_VERIFICATION_WIRED &&
    MODEL_ID === MODEL_ID_CANDIDATES.e4b &&
    !_MTP_OFF;

  let specAttempts = 0;
  let specAccepts = 0;
  let outputs: unknown;

  if (drafterReady) {
    // ── Three-session MTP spec-decode (#751) ──────────────────────────────────
    // embed_tokens + decoder_model_merged sessions reused from already-loaded
    // transformers.js model — no extra VRAM cost. Drafter session loaded via
    // drafter-cache.ts. Full greedy verification with KV cache accumulation.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ort = (globalThis as any).ort ?? (await import("onnxruntime-web"));
      const mtpSessions = getMtpSessions(model);

      if (!mtpSessions) {
        // Session keys don't match (model variant or transformers.js version).
        console.warn("[mtp] getMtpSessions() returned null — standard generate path.");
      } else {
        const inputIdsTensor = (inputs as any).input_ids as { data: BigInt64Array; dims: number[] };
        const eosId: number = (model as any).config?.eos_token_id ?? 1;

        const result = await runMtpSpecDecode(
          mtpSessions,
          _drafterSession!,
          ort,
          inputIdsTensor.data,
          safeMaxNewTokens,
          MTP_DRAFT_N,
          eosId,
          MTP_CONFIG_E4B,
        );

        specAttempts = result.specAttempts;
        specAccepts  = result.specAccepts;

        // Build a duck-typed tensor compatible with transformers.js batch_decode().
        // batch_decode calls .tolist() → [[n, n, ...]] (number[], not BigInt).
        const promptLen = inputIdsTensor.dims[1];
        const newToks   = result.tokens; // number[] — generated tokens only
        const allNums   = [...Array.from(inputIdsTensor.data, Number), ...newToks];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const makeTensor = (nums: number[]): any => ({
          data: new BigInt64Array(nums.map(BigInt)),
          dims: [1, nums.length],
          tolist: () => [nums.slice()],
          slice: (_ax: null, range: [number, null | undefined]) => makeTensor(nums.slice(range[0])),
        });
        outputs = makeTensor(allNums);
      }
    } catch (specErr) {
      console.warn(`[agent-harness] MTP spec-decode error — falling back to standard generate: ${(specErr as Error)?.message ?? specErr}`);
      specAttempts = 0;
      specAccepts  = 0;
      outputs = undefined;
    }
  }

  // Standard generate — used when spec-decode is inactive or falls through.
  if (!outputs) {
    try {
      outputs = await model.generate({
        ...inputs,
        max_new_tokens: safeMaxNewTokens,
        do_sample: false,
      });
    } catch (ortErr) {
      const msg = (ortErr as Error).message ?? "";
      console.warn("[agent-harness] OrtRun failure during generation — engaging remote fallback.", msg.slice(0, 120));
      _webgpuFallbackEngaged = true;
      window.dispatchEvent(new CustomEvent("agent:telemetry", { detail: { event: "webgpu_fallback_engaged", reason: msg.slice(0, 120) } }));
      updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · REMOTE (fallback)`);
      if (REMOTE_URL) return runRemoteAgentTurn(req);
      throw new Error(`WebGPU OrtRun failed and no REMOTE_URL configured: ${msg.slice(0, 200)}`);
    }
  }

  const _mtpActive = drafterReady && specAttempts > 0;
  const tGen = performance.now();
  const _specAcceptRate = specAttempts > 0 ? specAccepts / specAttempts : 0;

  // Decode only the newly generated tokens (strip the prompt prefix).
  const inputLength: number = inputs.input_ids?.dims?.[1] ?? 0;
  const generated = inputLength > 0 ? (outputs as any).slice(null, [inputLength, null]) : outputs;
  const tokensOut: number = (generated as any)?.dims?.[1] ?? 0;
  const prefillMs = tProc - t0;
  const decodeMs = tGen - tProc;
  const tgTps = decodeMs > 0 ? tokensOut / (decodeMs / 1000) : 0;
  const ppTps = prefillMs > 0 ? inputLength / (prefillMs / 1000) : 0;
  console.debug(`[agent] prefill=${Math.round(prefillMs)}ms decode=${Math.round(decodeMs)}ms in=${inputLength} out=${tokensOut} tg=${tgTps.toFixed(1)}t/s mtp=${_mtpActive}`);
  const _mtpSuffix = _mtpActive ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel} · ${tgTps.toFixed(0)} t/s${_mtpSuffix}`);
  recordTurn({
    ts: Date.now(),
    prefill_ms: prefillMs,
    decode_ms: decodeMs,
    tokens_in: inputLength,
    tokens_out: tokensOut,
    system_prompt_chars: buildSystemPrompt(req.skills).length,
    skills_total: req.skillsTotal ?? req.skills?.length ?? 0,
    skills_matched: req.skills?.length ?? 0,
    tg_tps: tgTps,
    pp_tps: ppTps,
    mtp_on: _mtpActive,
    spec_attempts: specAttempts,
    spec_accepts: specAccepts,
    spec_accept_rate: _specAcceptRate,
    path: "webgpu",
  });

  const decoded: string[] = proc.batch_decode(
    typeof (generated as any).tolist === "function" ? (generated as any).tolist() : generated,
    { skip_special_tokens: true },
  );
  const responseText = decoded[0] ?? "";

  // Extract <plan> block before dispatch parsing.
  let plan: string | undefined;
  const afterPlan = responseText.replace(/<plan>([\s\S]*?)<\/plan>/i, (_, inner: string) => {
    plan = inner.trim();
    return "";
  });

  const { dispatches, text } = parseDispatches(afterPlan);
  return { dispatches, text: text.trim() || responseText, plan, raw: outputs };
}
