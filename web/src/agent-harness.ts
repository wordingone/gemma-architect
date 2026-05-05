// agent-harness.ts — In-browser WebGPU inference via Transformers.js v4 (#47).
//
// Model: onnx-community/gemma-4-E2B-it-ONNX (Q4 quantized, CDN-hosted).
// Replaces the localhost:8084 llama-server fetch path from the original
// agent-harness design. Same public interface — chat-panel.ts and cmdk.ts
// unchanged.
//
// Load sequence:
//   1. First call to runAgentTurn() triggers model download (~2GB, cached by browser).
//   2. Badge element (#ai-model-badge) shows download progress then "LIVE".
//   3. Subsequent calls skip loading and go straight to inference.
//
// Tool-call format: model emits ```json {"verb":"Name","args":{...}} ``` blocks.
// parseDispatches() extracts these; remaining text becomes the response text.

import { pipeline } from "@huggingface/transformers";
import { getDictionary } from "./dictionary";
import { snapshotAsText } from "./scene-kg";
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipe: any = null;
let _pipePromise: Promise<unknown> | null = null;

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getModel(): Promise<any> {
  if (_pipe) return _pipe;
  if (_pipePromise) return _pipePromise;

  _pipePromise = (async () => {
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

    // Attempt 1: WebGPU (fastest, requires Chrome 113+ or Firefox Nightly)
    type DeviceSpec = { device: "webgpu" | "auto"; dtype: "q4f16" | "q4"; label: string };
    const backends: DeviceSpec[] = [
      { device: "webgpu", dtype: "q4f16", label: "GPU" },
      { device: "auto",   dtype: "q4",    label: "CPU" },
    ];

    let lastErr: Error = new Error("No backend available");
    for (const { device, dtype, label } of backends) {
      try {
        const p = await pipeline("text-generation", MODEL_ID, {
          device,
          dtype,
          progress_callback: progressCb,
        });
        _pipe = p;
        updateBadge(`<span class="v">G</span>EMMA·4·E2B  ·  LIVE · ${label}`);
        window.dispatchEvent(new CustomEvent("agentmodel:ready", { detail: { device, label } }));
        return p;
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

  return _pipePromise;
}

// ---- System prompt --------------------------------------------------------

function summariseDictionary(): string {
  const dict = getDictionary();
  const lines = dict.map((e) => {
    const argList = e.args.map((a) => `${a.name}:${a.type}${a.required ? "" : "?"}`).join(", ");
    return `  ${e.canonical_name}(${argList})`;
  });
  return `Available verbs (${dict.length}):\n${lines.join("\n")}`;
}

function summariseSkills(skills: Skill[] | undefined): string {
  if (!skills || skills.length === 0) return "Available skills: none active.";
  return `Available skills:\n${skills.map((s) => `  ${s.name} (v${s.version}): ${s.description}`).join("\n")}`;
}

export function buildSystemPrompt(skills?: Skill[]): string {
  return [
    "You are Gemma·Architect, a parametric CAD assistant embedded in a browser app.",
    "When the user asks to create or modify geometry, emit tool calls as JSON code blocks.",
    'Format: ```json\\n{"verb":"VerbName","args":{...}}\\n```',
    "Emit one ```json block per tool call. Multiple actions = multiple blocks in sequence.",
    summariseDictionary(),
    `Current scene: ${snapshotAsText()}`,
    summariseSkills(skills),
    "For questions or summaries, respond with plain text only (no JSON blocks).",
  ].join("\n\n");
}

export function buildToolDefinitions(): Record<string, unknown>[] {
  // Not used in the WebGPU path (tool calls are text-parsed, not schema-validated).
  return [];
}

// ---- Tool-call parsing ---------------------------------------------------

function parseDispatches(raw: string): { dispatches: AgentDispatch[]; text: string } {
  const dispatches: AgentDispatch[] = [];
  const blockRe = /```json\s*([\s\S]*?)```/gi;
  const removals: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(raw)) !== null) {
    removals.push(m[0]);
    try {
      const parsed: unknown = JSON.parse(m[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          const verb = typeof obj.verb === "string" ? obj.verb.trim() : "";
          const args =
            obj.args && typeof obj.args === "object" && !Array.isArray(obj.args)
              ? (obj.args as Record<string, unknown>)
              : {};
          if (verb) dispatches.push({ verb, args });
        }
      }
    } catch {
      // Malformed block — skip silently.
    }
  }

  let text = raw;
  for (const block of removals) {
    text = text.replace(block, "");
  }
  return { dispatches, text: text.trim() };
}

// ---- Public entry point --------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
  const model = await getModel();

  const messages = [
    { role: "system" as const, content: buildSystemPrompt(req.skills) },
    ...(req.history ?? []),
    { role: "user" as const, content: req.prompt },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await model(messages, {
    max_new_tokens: 1024,
    temperature: 0.2,
    do_sample: true,
    return_full_text: false,
  });

  // Transformers.js chat output: result[0].generated_text is Message[] or string.
  const rawOutput: unknown = result?.[0]?.generated_text;
  let responseText = "";
  if (Array.isArray(rawOutput)) {
    const last = rawOutput.at(-1);
    responseText =
      last && typeof last === "object" && "content" in last && typeof (last as { content: unknown }).content === "string"
        ? (last as { content: string }).content
        : "";
  } else if (typeof rawOutput === "string") {
    responseText = rawOutput;
  }

  const { dispatches, text } = parseDispatches(responseText);
  return { dispatches, text: text || responseText, raw: result };
}
