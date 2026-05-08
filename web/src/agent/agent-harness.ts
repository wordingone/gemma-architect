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

/** Fire-and-forget model prefetch. Safe to call early (CREATE tab focus). */
export function prefetchModel(): void {
  getModel().catch(() => { /* errors surface on first runAgentTurn */ });
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
`.trim();

export function buildSystemPrompt(skills?: Skill[]): string {
  return [
    "You are Gemma·Architect, a parametric CAD assistant. Be direct — no preamble, no performative filler ('certainly!', 'I'll help you with that!', 'Great!' and similar are forbidden).",
    "PLAN BEFORE DISPATCH: For every request that emits tool calls, first emit a compact <plan> block, then the tool_call blocks.\n<plan> format — EXACTLY this structure, no prose:\n<plan>\n1. VerbName — key_arg=value, …\n2. VerbName — key_arg=value\n</plan>",
    "AMBIGUITY: Infer the most common default and proceed. If one critical parameter is missing, state your assumption on ONE line (e.g. 'Assuming 2.8 m ceiling height.') then execute. Do NOT ask multiple clarifying questions.",
    'Preferred tool call format: <tool_call>{"command":"VerbName","parameters":{...},"metadata":{"source":"agent"}}</tool_call>',
    'Fallback format: ```json\n{"verb":"VerbName","args":{...}}\n```',
    "CRITICAL: Use ONLY the exact function names listed below. Any unknown name is silently dropped — nothing will be created.",
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

// ---- Remote inference path (serve_lora.py) --------------------------------

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

  updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  REMOTE ·  ⟳`);

  const resp = await fetch(`${REMOTE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, max_tokens: 1024, temperature: 0.1 }),
  });
  if (!resp.ok) throw new Error(`remote agent: HTTP ${resp.status} from ${REMOTE_URL}`);

  const json = (await resp.json()) as {
    choices: Array<{ message: { role: string; content: string } }>;
    _latency_ms?: number;
    _tps?: number;
    _mtp_enabled?: boolean;
  };

  const content = json.choices[0]?.message?.content ?? "";
  const tpsLabel = json._tps != null ? ` · ${json._tps.toFixed(0)} t/s` : "";
  const mtpLabel = json._mtp_enabled ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  REMOTE${mtpLabel}${tpsLabel}`);

  const { dispatches, text } = parseDispatches(content);
  return { dispatches, text: text || content, raw: json };
}

// ---- Public entry point --------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
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
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: req.maxNewTokens ?? 1024,
    do_sample: false,
  });
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
