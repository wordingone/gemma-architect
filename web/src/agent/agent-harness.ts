// agent-harness.ts — In-browser WebGPU inference via Transformers.js v4 (#47).
//
// Model: onnx-community/gemma-4-E2B-it-ONNX (Q4 quantized, CDN-hosted).
// Uses Gemma4ForConditionalGeneration + AutoProcessor directly — the
// "image-text-to-text" pipeline task is not supported in transformers.js 4.2.0.
//
// Remote path (Prong A, issue #99):
//   Set VITE_GEMMA_AGENT_URL=http://localhost:8088 to route runAgentTurn()
//   through serve_lora.py instead of loading the ONNX model in-browser.
//   When the env var is unset, the original in-browser WebGPU path is used.
//
// Load sequence (in-browser path):
//   1. First call to runAgentTurn() triggers model download (~2GB, cached by browser).
//   2. Badge element (#ai-model-badge) shows download progress then "LIVE".
//   3. Subsequent calls skip loading and go straight to inference.
//
// Function-call format: model emits ```json {"verb":"Name","args":{...}} ``` blocks.
// parseDispatches() extracts these; remaining text becomes the response text.

import { Gemma4ForConditionalGeneration, AutoProcessor, RawImage, PreTrainedModel } from "@huggingface/transformers";
import { getDictionary } from "../commands/dictionary";
import { listHandlers } from "../commands/dispatch";
import { snapshotAsText } from "../scene-kg";
import { captureViewport } from "../viewport-capture";
import type { Skill } from "./skills-loader";
import { recordTurn } from "../telemetry";

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

// ---- Model loading (in-browser path) ---------------------------------------

const MODEL_ID = "onnx-community/gemma-4-E2B-it-ONNX";
const BADGE_ID = "ai-model-badge";

let _model: PreTrainedModel | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _processor: any = null;
let _loadPromise: Promise<{ model: PreTrainedModel; processor: unknown }> | null = null;

function updateBadge(inner: string): void {
  const el = document.getElementById(BADGE_ID);
  if (el) el.innerHTML = inner;
}

type ProgressInfo = {
  status: string;
  name?: string;
  progress?: number;
};

// P10-4: VRAM ceiling pre-check. Gemma 4 E2B q4f16 needs ~2GB GPU memory.
// If the adapter reports less usable headroom, skip in-browser load and force remote.
const VRAM_FLOOR_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

async function checkVramCeiling(): Promise<boolean> {
  try {
    if (!navigator.gpu) return false; // no WebGPU, will fall back to CPU
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    // limits.maxBufferSize is not a free-VRAM probe but is a hard device ceiling.
    // Adapters below 2GB maxBufferSize cannot fit E2B weights regardless of free memory.
    const maxBuf: number = (adapter.limits as Record<string, number>).maxBufferSize ?? 0;
    if (maxBuf < VRAM_FLOOR_BYTES) {
      console.warn(`[agent-harness] P10-4 VRAM ceiling: maxBufferSize=${maxBuf} < ${VRAM_FLOOR_BYTES} — forcing remote.`);
      window.dispatchEvent(new CustomEvent("agent:telemetry", { detail: { event: "vram_ceiling_exceeded", maxBufferSize: maxBuf } }));
      return true; // ceiling exceeded — force remote
    }
    return false; // OK to run in-browser
  } catch {
    return false; // probe failed; let normal load attempt decide
  }
}

// Try WebGPU first (q4f16 quantization); fall back through device:"auto"
// (onnxruntime-web selects WebGL then WASM-SIMD automatically). Model files
// are cached in browser storage after first download — subsequent visits skip
// the network transfer entirely.
async function getModel(): Promise<{ model: PreTrainedModel; processor: unknown }> {
  if (_model && _processor) return { model: _model, processor: _processor };
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LOADING…`);
    window.dispatchEvent(new CustomEvent("agentmodel:loading", { detail: { progress: 0 } }));

    const progressCb = (info: ProgressInfo) => {
      if (info.status === "downloading") {
        const pct = info.progress != null ? `${Math.round(info.progress)}%` : "";
        const file = info.name?.split("/").pop() ?? "";
        const label = [pct, file].filter(Boolean).join(" ");
        updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  ${label}`);
        window.dispatchEvent(
          new CustomEvent("agentmodel:loading", { detail: { progress: info.progress ?? 0, file } }),
        );
      } else if (info.status === "loading") {
        updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  INITIALIZING`);
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
        updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LIVE · ${label}`);
        window.dispatchEvent(new CustomEvent("agentmodel:ready", { detail: { device, label } }));
        return { model, processor };
      } catch (e) {
        lastErr = e as Error;
        if (device === "webgpu") {
          console.warn("[agent-harness] WebGPU unavailable, trying CPU fallback:", (e as Error).message);
          updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LOADING CPU…`);
        }
      }
    }

    window.dispatchEvent(new CustomEvent("agentmodel:error", { detail: lastErr.message }));
    throw lastErr;
  })();

  // _loadPromise was assigned on the line above — non-null is guaranteed here.
  return _loadPromise!;
}

/** Fire-and-forget model prefetch. Safe to call early (CREATE tab focus).
 *  No-op when remote inference is configured — badge is set to LIVE·REMOTE immediately. */
export function prefetchModel(): void {
  if (REMOTE_URL) {
    // Remote path: mark as ready immediately so bench + UI don't wait for an in-browser load.
    updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LIVE · REMOTE`);
    return;
  }
  // P10-4: run VRAM ceiling check before starting the heavy model load.
  checkVramCeiling().then((ceilingExceeded) => {
    if (ceilingExceeded) {
      updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  VRAM LIMIT — REMOTE REQUIRED`);
      _webgpuFallbackEngaged = true; // re-use P10-2 flag to force remote routing
      return;
    }
    getModel().catch(() => { /* errors surface on first runAgentTurn */ });
  });
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

function buildSceneContext(): string {
  // Try KG first (populated by dispatch-created objects).
  const kg = snapshotAsText();
  if (!kg.includes("empty")) return kg;

  // Fall back to walking the THREE.js scene graph for the default demo scene.
  type ViewerScene = { children?: Array<{ type: string; name?: string; position?: { x: number; y: number; z: number } }> };
  const viewer = (window as unknown as { __viewer?: { scene?: ViewerScene } }).__viewer;
  const children = viewer?.scene?.children;
  if (!children) return kg;

  const meshes = children.filter((c) => c.type === "Mesh" || c.type === "Group");
  if (meshes.length === 0) return kg;

  const lines = meshes.slice(0, 15).map((m) => {
    const pos = m.position
      ? `at (${m.position.x.toFixed(1)}, ${m.position.y.toFixed(1)}, ${m.position.z.toFixed(1)})`
      : "";
    return `${m.name || m.type}${pos ? " " + pos : ""}`;
  });
  const suffix = meshes.length > 15 ? ` … and ${meshes.length - 15} more` : "";
  return `Scene contains ${meshes.length} object(s): ${lines.join("; ")}${suffix}.`;
}


const DIMENSION_RULES = `
DIMENSION RULES — extract ALL numeric values BEFORE generating geometry. Never use default 5.5 × 2.8 × 0.2 when the prompt gives dimensions.
- Width / length / depth: take EXACT values from prompt ("20m × 15m" → width=20, depth=15).
- Height: floor_height × n_stories. "3-story, 3m floor height" → total=9m; use 3m per IfcLevel.
- Footprint polygon: [[0,0],[W,0],[W,D],[0,D]] where W=width, D=depth.
- Multi-story: one IfcLevel per floor, elevation = floor_index × floor_height. Default floor heights: 3.0m office/residential, 4.5m industrial/bay.
- IfcSpace must include a descriptive name= param: name="lobby", name="apparatus bay 1", etc.
`.trim();

const FEW_SHOT_EXAMPLES = `
Examples — copy verb names EXACTLY; always emit <plan> before tool_call tags:

User: draw a 5m wall, 0.2m thick, 2.8m tall
Assistant:
<plan>
1. IfcWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8
</plan>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8},"metadata":{"source":"agent"}}</tool_call>

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
1. IfcWall — south, profile=[[0,0],[8,0]], thickness=0.2, height=3.5
2. IfcWall — north, profile=[[8,6],[0,6]], thickness=0.2, height=3.5
3. IfcWall — east, profile=[[8,0],[8,6]], thickness=0.2, height=3.5
4. IfcWall — west, profile=[[0,6],[0,0]], thickness=0.2, height=3.5
5. SdBox — roof slab, width=8.4, depth=6.4, height=0.2
6. SdBox — corner column, width=0.3, depth=0.3, height=3.5
</plan>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[8,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[8,6],[0,6]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[8,0],[8,6]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,6],[0,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdBox","parameters":{"width":8.4,"depth":6.4,"height":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdBox","parameters":{"width":0.3,"depth":0.3,"height":3.5},"metadata":{"source":"agent"}}</tool_call>

User: design a 2-story library, 12m × 8m
Assistant: Assuming 3.0m ground-floor height, 3.0m upper-floor height, concrete slab at +3.0m.
<plan>
1. IfcLevel — name="Ground", elevation=0, height=3.0
2. IfcLevel — name="2nd Floor", elevation=3.0, height=3.0
3. setActiveLevel — id from Ground IfcLevel return
4. IfcWall — south ground, profile=[[0,0],[12,0]], thickness=0.3, height=3.0
5. IfcWall — north ground, profile=[[12,8],[0,8]], thickness=0.3, height=3.0
6. IfcWall — east ground, profile=[[12,0],[12,8]], thickness=0.3, height=3.0
7. IfcWall — west ground, profile=[[0,8],[0,0]], thickness=0.3, height=3.0
8. IfcSlab — ground floor slab at elev=3.0, profile=[[0,0],[12,0],[12,8],[0,8]]
9. setActiveLevel — id from 2nd Floor IfcLevel return
10. IfcWall — south upper, profile=[[0,0],[12,0]], thickness=0.3, height=3.0
11. IfcWall — north upper, profile=[[12,8],[0,8]], thickness=0.3, height=3.0
12. IfcWall — east upper, profile=[[12,0],[12,8]], thickness=0.3, height=3.0
13. IfcWall — west upper, profile=[[0,8],[0,0]], thickness=0.3, height=3.0
14. IfcSlab — roof slab at elev=6.0, profile=[[0,0],[12,0],[12,8],[0,8]]
</plan>
<tool_call>{"command":"IfcLevel","parameters":{"name":"Ground","elevation":0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcLevel","parameters":{"name":"2nd Floor","elevation":3.0,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[12,8],[0,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[12,0],[12,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[12,0],[12,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[12,8],[0,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[12,0],[12,8]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.3,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[12,0],[12,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>

User: put this wall on the Construction layer instead
Assistant: Assuming the wall profile and dimensions from context; overriding layer to Construction.
<plan>
1. IfcWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8, layer=Construction
</plan>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8,"layer":"Construction"},"metadata":{"source":"agent"}}</tool_call>

User: add a slab but put it on the Annotations layer for now
Assistant: Overriding auto-routing; placing slab on Annotations layer as requested.
<plan>
1. IfcSlab — width=6, depth=4, thickness=0.2, layer=Annotations
</plan>
<tool_call>{"command":"IfcSlab","parameters":{"width":6,"depth":4,"thickness":0.2,"layer":"Annotations"},"metadata":{"source":"agent"}}</tool_call>

User: design a 12m × 8m single-story hospitality cabin, 2.4m ceiling
Assistant: 12m wide, 8m deep, 1 floor × 2.4m. Footprint [[0,0],[12,0],[12,8],[0,8]].
<plan>
1. IfcLevel — name="Ground", elevation=0, extent=12
2. IfcWall — south, profile=[[0,0],[12,0]], thickness=0.2, height=2.4
3. IfcWall — north, profile=[[12,8],[0,8]], thickness=0.2, height=2.4
4. IfcWall — east, profile=[[12,0],[12,8]], thickness=0.2, height=2.4
5. IfcWall — west, profile=[[0,8],[0,0]], thickness=0.2, height=2.4
6. IfcSlab — profile=[[0,0],[12,0],[12,8],[0,8]], thickness=0.2
7. IfcSpace — footprint=[[1,1],[7,1],[7,7],[1,7]], height=2.4, name="main hall"
8. IfcSpace — footprint=[[7,1],[11,1],[11,7],[7,7]], height=2.4, name="kitchenette"
9. IfcDoor — width=0.91, height=2.1
</plan>
<tool_call>{"command":"IfcLevel","parameters":{"name":"Ground","elevation":0,"extent":12},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[12,8],[0,8]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[12,0],[12,8]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,8],[0,0]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[12,0],[12,8],[0,8]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[1,1],[7,1],[7,7],[1,7]],"height":2.4,"name":"main hall"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[7,1],[11,1],[11,7],[7,7]],"height":2.4,"name":"kitchenette"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":0.91,"height":2.1},"metadata":{"source":"agent"}}</tool_call>

User: design a 20m × 12m 2-story office building, 3.5m floor height
Assistant: 20m wide, 12m deep, 2 floors × 3.5m = 7m total. Ground Floor at 0m, Floor 2 at 3.5m.
<plan>
1. IfcLevel — name="Ground Floor", elevation=0, extent=20
2. IfcLevel — name="Floor 2", elevation=3.5, extent=20
3. setActiveLevel — id=level/0
4. IfcWall — south ground, profile=[[0,0],[20,0]], thickness=0.2, height=3.5
5. IfcWall — north ground, profile=[[20,12],[0,12]], thickness=0.2, height=3.5
6. IfcWall — east ground, profile=[[20,0],[20,12]], thickness=0.2, height=3.5
7. IfcWall — west ground, profile=[[0,12],[0,0]], thickness=0.2, height=3.5
8. IfcSlab — mid-floor at elev 3.5, profile=[[0,0],[20,0],[20,12],[0,12]]
9. IfcSpace — name="reception", footprint=[[0,0],[6,0],[6,12],[0,12]], height=3.5
10. IfcSpace — name="open office", footprint=[[6,0],[20,0],[20,12],[6,12]], height=3.5
11. setActiveLevel — id=level/1
12. IfcWall — south upper, profile=[[0,0],[20,0]], thickness=0.2, height=3.5
13. IfcWall — north upper, profile=[[20,12],[0,12]], thickness=0.2, height=3.5
14. IfcWall — east upper, profile=[[20,0],[20,12]], thickness=0.2, height=3.5
15. IfcWall — west upper, profile=[[0,12],[0,0]], thickness=0.2, height=3.5
16. IfcSlab — roof at elev 7.0, profile=[[0,0],[20,0],[20,12],[0,12]]
17. IfcSpace — name="conference room", footprint=[[0,0],[10,0],[10,12],[0,12]], height=3.5
18. IfcSpace — name="office suite", footprint=[[10,0],[20,0],[20,12],[10,12]], height=3.5
</plan>
<tool_call>{"command":"IfcLevel","parameters":{"name":"Ground Floor","elevation":0,"extent":20},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcLevel","parameters":{"name":"Floor 2","elevation":3.5,"extent":20},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[20,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[20,12],[0,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[20,0],[20,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,12],[0,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[20,0],[20,12],[0,12]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[0,0],[6,0],[6,12],[0,12]],"height":3.5,"name":"reception"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[6,0],[20,0],[20,12],[6,12]],"height":3.5,"name":"open office"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[20,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[20,12],[0,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[20,0],[20,12]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,12],[0,0]],"thickness":0.2,"height":3.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[20,0],[20,12],[0,12]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[0,0],[10,0],[10,12],[0,12]],"height":3.5,"name":"conference room"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[10,0],[20,0],[20,12],[10,12]],"height":3.5,"name":"office suite"},"metadata":{"source":"agent"}}</tool_call>

User: design a 24m × 25m fire station with 3 apparatus bays
Assistant: 24m wide, 25m deep. Bay zone 24×9m at 4.5m height; living zone 24×16m at 2.8m height.
<plan>
1. IfcLevel — name="Ground", elevation=0, extent=24
2. IfcWall — south, profile=[[0,0],[24,0]], thickness=0.3, height=4.5
3. IfcWall — north, profile=[[24,25],[0,25]], thickness=0.3, height=4.5
4. IfcWall — east, profile=[[24,0],[24,25]], thickness=0.3, height=4.5
5. IfcWall — west, profile=[[0,25],[0,0]], thickness=0.3, height=4.5
6. IfcSlab — profile=[[0,0],[24,0],[24,25],[0,25]], thickness=0.2
7. IfcSpace — footprint=[[0,0],[8,0],[8,9],[0,9]], height=4.5, name="apparatus bay 1"
8. IfcSpace — footprint=[[8,0],[16,0],[16,9],[8,9]], height=4.5, name="apparatus bay 2"
9. IfcSpace — footprint=[[16,0],[24,0],[24,9],[16,9]], height=4.5, name="apparatus bay 3"
10. IfcSpace — footprint=[[0,9],[12,9],[12,25],[0,25]], height=2.8, name="day room"
11. IfcSpace — footprint=[[12,9],[24,9],[24,25],[12,25]], height=2.8, name="dormitory"
12. IfcDoor — width=4.0, height=4.2
13. IfcDoor — width=4.0, height=4.2
14. IfcDoor — width=4.0, height=4.2
15. IfcDoor — width=0.9, height=2.1
</plan>
<tool_call>{"command":"IfcLevel","parameters":{"name":"Ground","elevation":0,"extent":24},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[24,0]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[24,25],[0,25]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[24,0],[24,25]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,25],[0,0]],"thickness":0.3,"height":4.5},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[24,0],[24,25],[0,25]],"thickness":0.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[0,0],[8,0],[8,9],[0,9]],"height":4.5,"name":"apparatus bay 1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[8,0],[16,0],[16,9],[8,9]],"height":4.5,"name":"apparatus bay 2"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[16,0],[24,0],[24,9],[16,9]],"height":4.5,"name":"apparatus bay 3"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[0,9],[12,9],[12,25],[0,25]],"height":2.8,"name":"day room"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSpace","parameters":{"footprint":[[12,9],[24,9],[24,25],[12,25]],"height":2.8,"name":"dormitory"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":4.0,"height":4.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":4.0,"height":4.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":4.0,"height":4.2},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcDoor","parameters":{"width":0.9,"height":2.1},"metadata":{"source":"agent"}}</tool_call>

User: add a 1m grid and snap walls to it
Assistant: Adding 1m grid; walls will snap to intersections.
<plan>
1. IfcGrid — spacing=1, count=30, rotation=0
2. setActiveGrid — id from IfcGrid return
3. IfcWall — south, profile=[[0,0],[12,0]], thickness=0.2, height=3.0
</plan>
<tool_call>{"command":"IfcGrid","parameters":{"spacing":1,"count":30,"rotation":0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"setActiveGrid","parameters":{"id":"grid/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[12,0]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>

User: build a 5m wall and export it as ifc
Assistant: Building a 5m wall then exporting the scene as IFC.
<plan>
1. IfcWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8
2. SdExport — format=ifc, target=scene
</plan>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"SdExport","parameters":{"format":"ifc","target":"scene"},"metadata":{"source":"agent"}}</tool_call>

User: design a small entrance pavilion and send me the GLB for review
Assistant: 4m × 4m entrance canopy, 3m height. Exporting GLB after build.
<plan>
1. IfcWall — west, profile=[[0,0],[0,4]], thickness=0.2, height=3.0
2. IfcWall — east, profile=[[4,4],[4,0]], thickness=0.2, height=3.0
3. IfcSlab — canopy, profile=[[0,0],[4,0],[4,4],[0,4]], thickness=0.15
4. SdExport — format=glb, target=scene
</plan>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[0,0],[0,4]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcWall","parameters":{"profile":[[4,4],[4,0]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"command":"IfcSlab","parameters":{"profile":[[0,0],[4,0],[4,4],[0,4]],"thickness":0.15},"metadata":{"source":"agent"}}</tool_call>
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
`.trim();

export function buildSystemPrompt(skills?: Skill[]): string {
  return [
    "You are Gemma·Architect, a parametric CAD assistant. Be direct — no preamble, no performative filler ('certainly!', 'I'll help you with that!', 'Great!' and similar are forbidden).",
    "PLAN BEFORE DISPATCH: For every request that emits tool calls, first emit a compact <plan> block, then the tool_call blocks.\n<plan> format — EXACTLY this structure, no prose:\n<plan>\n1. VerbName — key_arg=value, …\n2. VerbName — key_arg=value\n</plan>",
    "AMBIGUITY: Infer the most common default and proceed. If one critical parameter is missing, state your assumption on ONE line (e.g. 'Assuming 2.8 m ceiling height.') then execute. Do NOT ask multiple clarifying questions.",
    'Preferred tool call format: <tool_call>{"command":"VerbName","parameters":{...},"metadata":{"source":"agent"}}</tool_call>',
    'Fallback format: ```json\n{"verb":"VerbName","args":{...}}\n```',
    "CRITICAL: Use ONLY the exact function names listed below. Any unknown name is silently dropped — nothing will be created.",
    DIMENSION_RULES,
    FEW_SHOT_EXAMPLES,
    summariseDictionary(),
    `Current scene: ${buildSceneContext()}`,
    "Use scene info silently (avoid duplicates, reference object counts). Do NOT narrate scene contents unprompted. Act ONLY on explicit user requests. If a viewport image is attached, describe it only when explicitly asked.",
    summariseSkills(skills),
    "For questions (no geometry change): plain text only, ≤60 words, no JSON or tool_call blocks.",
  ].join("\n\n");
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

  updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LIVE · REMOTE ·  ⟳`);

  const resp = await fetch(`${REMOTE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens: 1024, temperature: 0.1 }),
  });
  if (!resp.ok) throw new Error(`remote agent: HTTP ${resp.status} from ${REMOTE_URL}`);

  const json = (await resp.json()) as {
    choices: Array<{ message: { role: string; content: string } }>;
    usage?: { prompt_tokens?: number };
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
      body: JSON.stringify({ prompt, n_predict: 1024, temperature: 0.1, stop: ["<end_of_turn>"] }),
    });
    if (!compResp.ok) throw new Error(`remote agent fallback: HTTP ${compResp.status}`);
    const compJson = (await compResp.json()) as { content: string; tokens_predicted?: number };
    const content = compJson.content ?? "";
    updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LIVE · REMOTE`);
    const { dispatches, text } = parseDispatches(content);
    return { dispatches, text: text || content, raw: compJson };
  }

  const content = json.choices[0]?.message?.content ?? "";
  const tpsLabel = json._tps != null ? ` · ${json._tps.toFixed(0)} t/s` : "";
  const mtpLabel = json._mtp_enabled ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LIVE · REMOTE${mtpLabel}${tpsLabel}`);

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
    { role: "system" as const, content: buildSystemPrompt(req.skills) },
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
  const t0 = performance.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any = await proc(chatText, imageList.length > 0 ? imageList : null);
  const tProc = performance.now();

  // Generate — greedy decoding for deterministic function-call JSON.
  // P10-2: catch OrtRun failures that slip past the load-time probe (#128/#133).
  // On first failure: engage session-level fallback flag, retry via remote if available.
  let outputs: unknown;
  try {
    outputs = await model.generate({
      ...inputs,
      max_new_tokens: req.maxNewTokens ?? 1024,
      do_sample: false,
    });
  } catch (ortErr) {
    const msg = (ortErr as Error).message ?? "";
    console.warn("[agent-harness] OrtRun failure during generation — engaging remote fallback.", msg.slice(0, 120));
    _webgpuFallbackEngaged = true;
    window.dispatchEvent(new CustomEvent("agent:telemetry", { detail: { event: "webgpu_fallback_engaged", reason: msg.slice(0, 120) } }));
    updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LIVE · REMOTE (fallback)`);
    if (REMOTE_URL) return runRemoteAgentTurn(req);
    throw new Error(`WebGPU OrtRun failed and no REMOTE_URL configured: ${msg.slice(0, 200)}`);
  }
  const tGen = performance.now();

  // Decode only the newly generated tokens (strip the prompt prefix).
  const inputLength: number = inputs.input_ids?.dims?.[1] ?? 0;
  const generated = inputLength > 0 ? (outputs as any).slice(null, [inputLength, null]) : outputs;
  const tokensOut: number = (generated as any)?.dims?.[1] ?? 0;
  const prefillMs = tProc - t0;
  const decodeMs = tGen - tProc;
  const tgTps = decodeMs > 0 ? tokensOut / (decodeMs / 1000) : 0;
  const ppTps = prefillMs > 0 ? inputLength / (prefillMs / 1000) : 0;
  console.debug(`[agent] prefill=${Math.round(prefillMs)}ms decode=${Math.round(decodeMs)}ms in=${inputLength} out=${tokensOut} tg=${tgTps.toFixed(1)}t/s`);
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
  });

  const decoded: string[] = proc.batch_decode(generated, { skip_special_tokens: true });
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
