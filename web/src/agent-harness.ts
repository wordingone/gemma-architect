// agent-harness.ts — Gemma 4 agent wrapper (T10 per silly-baking-yeti.md).
//
// Wraps the local Gemma 4 (E2B-it) llama-server endpoint with:
//   - System prompt: Spatial Dictionary entries + Scene KG snapshot + matched skills
//   - Tools array: dispatch table → OpenAI-compat function definitions
//   - Multimodal content blocks: optional ImageBitmap frames forwarded as
//     `image_url` parts (Gemma 4 vision tower handles them natively;
//     gemma-architect's adapter at `src/serve/serve_lora.py` is OURS, so the
//     image-stripping bug in avir-cli's openai-adapter does not apply here)
//   - Tool-call parsing: `tool_calls[]` deltas mapped to AgentDispatch records
//
// The harness does NOT execute dispatches itself — it returns the parsed
// AgentDispatch[] for the caller (shell.ts / agent loop) to invoke via
// `dispatch()` from `./dispatch`. Keeps this module pure-IO + pure-mapping
// so it stays unit-testable against a mocked fetch.
//
// Endpoint: http://127.0.0.1:8083/v1/chat/completions (overridable via
// VITE_AGENT_URL or window.__agentUrl, mirroring the ai-generate.ts pattern).

import { getDictionary, type SdArg, type SpatialDictionaryEntry } from "./dictionary";
import { snapshotAsText } from "./scene-kg";
import type { Skill } from "./skills-loader";

export type AgentRequest = {
  prompt: string;
  frames?: ImageBitmap[];
  maxTurns?: number;
  skills?: Skill[];
  model?: string;
};

export type AgentDispatch = {
  verb: string;
  args: Record<string, unknown>;
};

export type AgentResponse = {
  dispatches: AgentDispatch[];
  text: string;
  raw?: unknown;
};

// ---- Endpoint resolution -----------------------------------------------

const DEFAULT_ENDPOINT = "http://127.0.0.1:8083/v1/chat/completions";
const DEFAULT_MODEL = "gemma-4-e2b-it";

function getEndpoint(): string {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __agentUrl?: string };
    if (w.__agentUrl) return w.__agentUrl;
  }
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_AGENT_URL ?? DEFAULT_ENDPOINT;
}

// ---- JSON-schema generation from the dispatch table --------------------
// Map SdArgType → JSON-schema property. Kernel-specific handles (edge /
// surface / solid) become opaque `string` so the agent passes UUIDs.
function argToJsonSchema(arg: SdArg): Record<string, unknown> {
  switch (arg.type) {
    case "number":
    case "integer":
      return { type: arg.type === "integer" ? "integer" : "number" };
    case "boolean":
      return { type: "boolean" };
    case "string":
    case "enum_format":
      return { type: "string" };
    case "point2":
      return { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };
    case "point3":
    case "vector3":
      return { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
    case "polyline":
    case "polyline_or_circle":
    case "list_point2":
      return { type: "array", items: { type: "array", items: { type: "number" } } };
    case "list_edge":
    case "list_face":
    case "list_any":
    case "list_edge_or_surface":
      return { type: "array", items: { type: "string" } };
    case "any":
      return {};
    default:
      // Kernel-internal handles (edge / surface / solid / curve / plane3 /
      // line3 / number_or_vector3 / arraybuffer / etc.) are passed by
      // reference as opaque tokens — the agent cites them by UUID, the
      // dispatch handler resolves them on the kernel side.
      return { type: "string" };
  }
}

function entryToTool(entry: SpatialDictionaryEntry): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const a of entry.args) {
    properties[a.name] = argToJsonSchema(a);
    if (a.required) required.push(a.name);
  }
  const description =
    `${entry.kernel_op} (${entry.topology_role})` +
    (entry.synonyms.length > 0 ? ` — synonyms: ${entry.synonyms.slice(0, 4).join(", ")}` : "");
  return {
    type: "function",
    function: {
      name: entry.canonical_name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

export function buildToolDefinitions(): Record<string, unknown>[] {
  return getDictionary().map(entryToTool);
}

// ---- System prompt assembly --------------------------------------------

function summariseSkills(skills: Skill[] | undefined): string {
  if (!skills || skills.length === 0) return "Available skills: none active for this turn.";
  const lines = skills.map((s) => `- ${s.name} (v${s.version}): ${s.description}`);
  return `Available skills:\n${lines.join("\n")}`;
}

function summariseDictionary(): string {
  const dict = getDictionary();
  // One-line per entry keeps the prompt under ~3KB even at 70 verbs.
  const lines = dict.map((e) => {
    const argList = e.args.map((a) => `${a.name}:${a.type}${a.required ? "" : "?"}`).join(",");
    return `- ${e.canonical_name}(${argList}) — ${e.topology_role}`;
  });
  return `Available verbs (${dict.length}):\n${lines.join("\n")}`;
}

export function buildSystemPrompt(skills?: Skill[]): string {
  const sd = summariseDictionary();
  const kg = snapshotAsText();
  const sk = summariseSkills(skills);
  return [
    "You are Gemma·Architect, a CAD agent. You drive a parametric CAD UI by emitting tool calls against the verbs below.",
    sd,
    `Current scene: ${kg}`,
    sk,
    "Respond with one or more tool calls when an action is needed. Use plain text only for clarifying questions or summaries.",
  ].join("\n\n");
}

// ---- Multimodal content blocks -----------------------------------------
// ImageBitmap (from T12 video-recorder) → base64 PNG data URL via
// OffscreenCanvas, serialised inline for the inference endpoint.
async function frameToDataUrl(frame: ImageBitmap): Promise<string> {
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("agent-harness: 2D canvas context unavailable");
  ctx.drawImage(frame, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(binary) : "";
  return `data:image/png;base64,${b64}`;
}

async function buildUserContent(
  prompt: string,
  frames: ImageBitmap[] | undefined,
): Promise<unknown> {
  if (!frames || frames.length === 0) return prompt;
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const f of frames) {
    const url = await frameToDataUrl(f);
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

// ---- Tool-call parsing -------------------------------------------------

type ChatChoiceMessage = {
  content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: ChatChoiceMessage; finish_reason?: string }>;
};

function parseDispatches(message: ChatChoiceMessage | undefined): AgentDispatch[] {
  if (!message || !Array.isArray(message.tool_calls)) return [];
  const out: AgentDispatch[] = [];
  for (const call of message.tool_calls) {
    const verb = call.function?.name?.trim();
    if (!verb) continue;
    const rawArgs = call.function?.arguments ?? "{}";
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed arg JSON — preserve the raw string so the caller can log
      // it; dispatch() will reject via ArgValidationError on type mismatch.
      args = { _raw: rawArgs };
    }
    out.push({ verb, args });
  }
  return out;
}

// ---- Public entry point ------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
  const endpoint = getEndpoint();
  const model = req.model ?? DEFAULT_MODEL;
  const userContent = await buildUserContent(req.prompt, req.frames);
  const messages = [
    { role: "system", content: buildSystemPrompt(req.skills) },
    { role: "user", content: userContent },
  ];
  const body = {
    model,
    messages,
    tools: buildToolDefinitions(),
    tool_choice: "auto",
    max_tokens: 4096,
    temperature: 0.2,
  };
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`agent-harness: HTTP ${resp.status} ${resp.statusText}`);
  }
  const json = (await resp.json()) as ChatCompletionResponse;
  const choice = json.choices?.[0];
  const dispatches = parseDispatches(choice?.message);
  const text = choice?.message?.content?.trim() ?? "";
  return { dispatches, text, raw: json };
}
