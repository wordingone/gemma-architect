// agent-harness.ts — In-browser WebGPU inference via Transformers.js v4 (#47).
//
// Model: onnx-community/gemma-4-E2B-it-ONNX (Q4 quantized, CDN-hosted).
// Uses Gemma4ForConditionalGeneration + AutoProcessor directly — the
// "image-text-to-text" pipeline task is not supported in transformers.js 4.2.0.
//
// Load sequence:
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

export type AgentDispatch = {
  verb: string;
  args: Record<string, unknown>;
};

export type AgentRequest = {
  prompt: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  frames?: ImageBitmap[];
  maxTurns?: number;
  skills?: Skill[];
  model?: string;
};

export type AgentResponse = {
  dispatches: AgentDispatch[];
  text: string;
  raw?: unknown;
};

// ---- Model loading --------------------------------------------------------

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
Examples of correct function calls (copy the function names EXACTLY — do not rename them):

User: create a box 6m wide, 4m deep, 3m tall
Assistant:
\`\`\`json
{"verb":"SdBox","args":{"width":6,"depth":4,"height":3}}
\`\`\`

User: draw a wall 4m long, 0.3m thick, 3m tall
Assistant:
\`\`\`json
{"verb":"IfcWall","args":{"profile":[[0,0],[4,0]],"thickness":0.3,"height":3}}
\`\`\`

User: add a sphere radius 1
Assistant:
\`\`\`json
{"verb":"SdSphere","args":{"radius":1}}
\`\`\`

User: add a cylinder, radius 0.5 height 2
Assistant:
\`\`\`json
{"verb":"SdCylinder","args":{"radius":0.5,"height":2}}
\`\`\`

User: delete the selected object
Assistant:
\`\`\`json
{"verb":"SdDelete","args":{}}
\`\`\`

User: undo that
Assistant:
\`\`\`json
{"verb":"SdUndo","args":{}}
\`\`\`

User: redo
Assistant:
\`\`\`json
{"verb":"SdRedo","args":{}}
\`\`\`

User: move the selected object 2m in the X direction
Assistant:
\`\`\`json
{"verb":"SdMove","args":{"x":2,"y":0,"z":0}}
\`\`\`

User: rotate 45 degrees around Z
Assistant:
\`\`\`json
{"verb":"SdRotate","args":{"angle":45,"axis":[0,0,1]}}
\`\`\`

User: scale the selection by 2
Assistant:
\`\`\`json
{"verb":"SdScale","args":{"factor":2}}
\`\`\`

User: select the object
Assistant:
\`\`\`json
{"verb":"SdSelect","args":{}}
\`\`\`

User: group the selected objects
Assistant:
\`\`\`json
{"verb":"SdGroup","args":{}}
\`\`\`

User: import a file
Assistant:
\`\`\`json
{"verb":"SdImport","args":{}}
\`\`\`

User: export as IFC
Assistant:
\`\`\`json
{"verb":"SdExport","args":{"format":"ifc"}}
\`\`\`

`.trim();

export function buildSystemPrompt(skills?: Skill[]): string {
  return [
    "You are Gemma·Architect, a parametric CAD assistant embedded in a browser app.",
    "When the user asks to create or modify geometry, emit function calls.",
    'Preferred format: <tool_call>{"command":"VerbName","parameters":{...},"metadata":{"source":"agent"}}</tool_call>',
    'Legacy format accepted: ```json\n{"verb":"VerbName","args":{...}}\n```',
    "Emit one ```json block per function call. Multiple actions = multiple blocks in sequence.",
    "CRITICAL: Use ONLY the exact function names listed below. Do not invent or rename functions — any function not in the list is silently rejected and nothing will be created.",
    FEW_SHOT_EXAMPLES,
    summariseDictionary(),
    `Current scene (text): ${buildSceneContext()}`,
    "Use the 'Current scene' text above to silently inform your responses (e.g. avoid creating duplicates, reference object counts). Do NOT proactively announce or describe scene contents. Do NOT take actions based on scene state alone. Only act on explicit user requests. If a viewport image is attached, describe it only when the user has explicitly asked you to look at or describe the scene.",
    summariseSkills(skills),
    "For questions or summaries, respond with plain text only (no JSON blocks).",
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

// ---- Public entry point --------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
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
  if (req.frames && req.frames.length > 0) {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any = await proc(chatText, imageList.length > 0 ? imageList : null);

  // Generate — greedy decoding for deterministic function-call JSON.
  const outputs = await model.generate({
    ...inputs,
    max_new_tokens: 1024,
    do_sample: false,
  });

  // Decode only the newly generated tokens (strip the prompt prefix).
  const inputLength: number = inputs.input_ids?.dims?.[1] ?? 0;
  const generated = inputLength > 0 ? (outputs as any).slice(null, [inputLength, null]) : outputs;
  const decoded: string[] = proc.batch_decode(generated, { skip_special_tokens: true });
  const responseText = decoded[0] ?? "";

  const { dispatches, text } = parseDispatches(responseText);
  return { dispatches, text: text || responseText, raw: outputs };
}
