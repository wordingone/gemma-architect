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
// Function-call format: model emits <tool_call>{"name":"FnName","arguments":{...}}</tool_call> blocks.
// parseDispatches() extracts these; remaining text becomes the response text.

import { getDictionary } from "../commands/dictionary";
import { listHandlers } from "../commands/dispatch";
import { getState } from "../app-state";
import { makeAgentInstanceFactory } from "./agent-instance";
export type { AgentInstance, AgentTurn } from "./agent-instance";
import { StandardBackend } from "./standard-backend";
import {
  WASM_BACKEND_ENABLED,
  WASM_DRAFTER_URL,
  loadWasmBackend,
  wasmChatCompletion,
} from "./wasm-backend";
import { VIDEO_INPUT_ENABLED, buildVideoDataUrls } from "./video-input";

// ── Cluster catalog (populated by workbench after each save/delete) ──────────
let _clusterCatalog: { name: string; steps: number }[] = [];

export function setClusterCatalog(clusters: { name: string; steps: number }[]): void {
  _clusterCatalog = clusters;
}

// ── Canvas skill catalog (#1116/SU-7) — starter nodes + saved CanvasCluster ─
let _canvasSkillCatalog: { name: string; verb: string; desc: string }[] = [];

export function setCanvasSkillCatalog(skills: { name: string; verb: string; desc: string }[]): void {
  _canvasSkillCatalog = skills;
}
import { snapshotAsText } from "../scene/scene-kg";
import { captureViewport } from "./viewport-capture";
import type { Skill } from "./skills-loader";
import { recordTurn } from "./telemetry";

export type AgentDispatch = {
  name: string;
  arguments: Record<string, unknown>;
};

export type AgentRequest = {
  prompt: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  frames?: ImageBitmap[];   // video frames from ring buffer (#693) — gated by VITE_VIDEO_INPUT
  userImage?: string;       // remote path — pre-encoded data URL from chat-panel
  maxTurns?: number;
  skills?: Skill[];
  skillsTotal?: number; // total registered skills before keyword filtering
  model?: string;
  maxNewTokens?: number; // default 4096 (#1048)
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
let _modelLoadError: string | null = null; // #1036: set when worker posts type:"error"
let _bootComplete = false;                 // #1036: set when worker posts type:"boot-complete"
type WorkerGenResult = {
  text: string; specAttempts: number; specAccepts: number;
  prefillMs: number; decodeMs: number; inputLength: number; tokensOut: number;
};
const _generateCallbacks = new Map<string, {
  resolve: (r: WorkerGenResult) => void;
  reject: (e: Error) => void;
}>();

// ── Model-worker recycle (#1303) ─────────────────────────────────────────────
// Terminate + reinitialize the inference worker every N turns to release
// accumulated ONNX WebGPU buffer pool (KV cache residuals). Model weights
// reload from browser cache — no network download after first load.
const MODEL_WORKER_RECYCLE_AFTER = 5; // turns before forced recycle (#1313: was 10; Phase J data shows stall at turn 6 with threshold=10 — recycle after 5 turns prevents accumulated GPU state from reaching the stall point)
let _modelWorkerTurnCount = 0;
let _modelWorkerRecycleCount = 0;
let _nextInitNoWarmup = false; // set by recycle path; GPU device+shaders persist, skip warmup
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__model_worker_recycle_count = 0;
}

async function recycleModelWorkerIfNeeded(): Promise<void> {
  if (_modelWorkerTurnCount < MODEL_WORKER_RECYCLE_AFTER) return;
  if (!_inferenceWorker) return;

  // Graceful shutdown: let worker release ORT sessions + model before terminate.
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    const onMsg = (ev: MessageEvent<Record<string, unknown>>) => {
      if (ev.data.type === "shutdown-complete") {
        clearTimeout(timeout);
        _inferenceWorker?.removeEventListener("message", onMsg);
        resolve();
      }
    };
    _inferenceWorker!.addEventListener("message", onMsg);
    _inferenceWorker!.postMessage({ type: "shutdown" });
  });

  _inferenceWorker!.terminate();
  _inferenceWorker = null;
  _workerReady = false;
  _bootComplete = false;
  _prefillDone = false;
  _modelWorkerTurnCount = 0;
  _nextInitNoWarmup = true; // GPU device+compiled shaders persist; new worker skips warmup probe
  _modelWorkerRecycleCount++;
  (window as unknown as Record<string, unknown>).__model_worker_recycle_count = _modelWorkerRecycleCount;
  window.dispatchEvent(new CustomEvent("agentmodel:worker-recycled", {
    detail: { recycleCount: _modelWorkerRecycleCount },
  }));
}

// CDN URL injected at build time via VITE_DRAFTER_ONNX_URL env var (#811).
// Replace placeholder with actual HF Hub URL after drafter-e4b.onnx is uploaded.
//   Recommended host: https://huggingface.co/<user>/<repo>/resolve/main/drafter-e4b.onnx
//   Set VITE_DRAFTER_ONNX_URL in the production deploy environment to activate the CDN path.
const _DRAFTER_CDN_PLACEHOLDER = "https://huggingface.co/TODO-set-after-upload/resolve/main/drafter-e4b.onnx";
const DRAFTER_ONNX_URL: string =
  (import.meta.env["VITE_DRAFTER_ONNX_URL"] as string | undefined) ?? _DRAFTER_CDN_PLACEHOLDER;
const DRAFTER_CACHE_KEY = "mtp-drafter-e4b-v2"; // bumped: CDN URL changed from local path (#811)

// Warn in production when the drafter URL is still the placeholder (file not uploaded yet).
if (import.meta.env.PROD && DRAFTER_ONNX_URL === _DRAFTER_CDN_PLACEHOLDER) {
  console.warn(
    "[agent-harness] VITE_DRAFTER_ONNX_URL is not set — drafter will load from placeholder URL " +
    "(will 404 until drafter-e4b.onnx is uploaded and the env var is configured). " +
    "MTP spec-decode is disabled until the drafter loads. See issue #811."
  );
}
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
        if (msg.skipped) {
          // #1313: noWarmup path confirmed. Expose for harness (window.__agent_warmup_skipped_count).
          const w = window as unknown as Record<string, unknown>;
          w.__agent_warmup_skipped_count = ((w.__agent_warmup_skipped_count as number | undefined) ?? 0) + 1;
        }
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
        _bootComplete = true; // #1036
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
          _modelWorkerTurnCount++; // #1303: track for recycle
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
      case "error": {
        const _errMsg = (msg.error as string) ?? "Unknown model load error";
        // #1313: D3D12 silent OOM — OrtRun throws buffer_manager/CreateCommittedResource
        // but WebGPU reports DeviceRemovedReason=S_OK so no JS device-lost event fires.
        // Detected via OrtRun error text. Recycle worker; next turn gets a fresh worker
        // without engaging the fatal fallback path.
        const _isD3D12Oom = /OrtRun|buffer_manager|CreateCommittedResource/i.test(_errMsg);
        if (_isD3D12Oom && _inferenceWorker) {
          // §B-device-destroy (#1313): destroy D3D12 buffers before worker terminate.
          // Worker is still alive after OrtRun error — send destroy-device so it can
          // call device.destroy() before we terminate; 400ms window then hard terminate.
          _inferenceWorker.postMessage({ type: "destroy-device" });
          const _w = _inferenceWorker;
          _inferenceWorker = null;
          _workerReady = false;
          _prefillDone = false;
          _bootComplete = false;
          _modelWorkerTurnCount = 0;
          // §C-recycle-no-warmup (#1377): skip warmup on recycle path.
          // Device IS destroyed, but the 1000-token warmup probe (#1362/#1373) hits the
          // same buffer_manager.cc:553 OrtRun bug on the fresh GPU → recycled worker
          // crashes silently during warmup → boot-complete never fires → 240s timeout.
          // Shader compilation happens on the first real inference anyway. Skip warmup.
          _nextInitNoWarmup = true;
          _modelWorkerRecycleCount++;
          (window as unknown as Record<string, unknown>).__model_worker_recycle_count = _modelWorkerRecycleCount;
          const _win = window as unknown as Record<string, unknown>;
          _win.__agent_d3d12_recycles = ((_win.__agent_d3d12_recycles as number | undefined) ?? 0) + 1;
          window.dispatchEvent(new CustomEvent("agentmodel:worker-recycled", {
            detail: { recycleCount: _modelWorkerRecycleCount, reason: "d3d12-oom" },
          }));
          updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel} · ⟳`);
          for (const [, cb] of _generateCallbacks) cb.reject(new Error("d3d12-oom: worker recycled"));
          _generateCallbacks.clear();
          // #1366: terminate old worker, then eagerly spawn the replacement so that
          // `agentmodel:boot-complete` fires when re-init completes. Without this respawn,
          // the next `runAgentTurn()` is the only caller of `initWorkerIfNeeded()`, but
          // the chat-input gate (PR #1355) blocks user prompt submission until boot-complete
          // fires → hard deadlock: app wedges until page refresh after any model crash.
          setTimeout(() => {
            _w.terminate();
            initWorkerIfNeeded();
          }, 400);
          break;
        }
        // Non-OOM worker error: fatal path
        _webgpuFallbackEngaged = true;
        _modelLoadError = _errMsg; // #1036
        _bootComplete = true;      // #1036: boot sequence ended (with error)
        console.error("[gemma] model load failed:", _modelLoadError); // #1036 DevTools AC1
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ERROR`);
        window.dispatchEvent(new CustomEvent("agentmodel:error", { detail: msg.error }));
        for (const [, cb] of _generateCallbacks) cb.reject(new Error(_errMsg));
        _generateCallbacks.clear();
        break;
      }
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

  const _noWarmup = _nextInitNoWarmup;
  _nextInitNoWarmup = false;
  _inferenceWorker.postMessage({
    type:             "init",
    modelId:          MODEL_ID,
    drafterUrl:       DRAFTER_ONNX_URL,
    drafterCacheKey:  DRAFTER_CACHE_KEY,
    noWarmup:         _noWarmup,
    // §C-warmup-context (#1362): pass representative system prompt so warmup probe
    // exercises ~1000-token KV cache buffers matching real inference context size.
    // Without this the probe uses ~6 tokens, leaving large GPU buffers unexercised
    // and causing BufferManager::Download (buffer_manager.cc:553) to crash on first
    // real inference with a full-length system prompt + user message (~1300 tokens).
    warmupPrompt:     _noWarmup ? "" : buildWebGPUSystemPrompt(),
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
  // Emit an early loading event so the overlay mounts BEFORE the worker
  // triggers the browser storage-permission prompt on the first ONNX fetch.
  // Returning-user path (cached model): worker posts "returning-user" within
  // milliseconds → overlay fades immediately via agentmodel:returning-user.
  window.dispatchEvent(new CustomEvent("agentmodel:loading", { detail: { progress: 0 } }));
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
  const available = implemented.size > 0 ? dict.filter((e) => implemented.has(e.name)) : dict;
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
    return `  ${e.name}(${argList})${syn}`;
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

function summariseCanvasSkills(): string {
  if (_canvasSkillCatalog.length === 0) return "";
  const lines = _canvasSkillCatalog.map(s => `  ${s.name}(…): ${s.desc}`).join("\n");
  return `User-defined skills (invoke with SdInvokeSkill({skill:"<name>",params:{…}})):\n${lines}`;
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
- IfcDoor: width=0.914, height=2.032, wallThickness=0.15. One per building minimum; front entry on south wall.
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

// FEW_SHOT_EXAMPLES trimmed to 2 examples (~750 tok) to keep system-prompt under
// ~1000 tokens total — required for CPU/WASM inference to stay under Chrome WASM heap
// limit (~3GB). Prior 492-line version pushed system prompt to ~4000 tokens causing
// WASM OOM at ~347s on Playwright Chromium. Refs: #1058, #1194.
const FEW_SHOT_EXAMPLES = `
Examples — emit <plan> block then <tool_call> tags, copy function names EXACTLY:

User: draw a 5m wall, 0.2m thick, 2.8m tall
Assistant:
<plan>
1. SdWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8
</plan>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8},"metadata":{"source":"agent"}}</tool_call>

User: Build a two-story residential house, 26' wide by 20' deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs.
Assistant: 26ft × 20ft, 2 floors × 9.0ft walls, pitched roof. Ground: slab + 4 walls + door + 4 windows + stair. Upper: slab + 4 walls + 4 windows + SdRoof.
<plan>
1. SdLevel — name="Level 1", elevation=0, height=9.0, extent=26
2. SdLevel — name="Level 2", elevation=9.0, height=9.0, extent=26
3. setActiveLevel — id=level/0
4. SdSlab — profile=[[0,0],[26,0],[26,20],[0,20]], thickness=0.67
5. SdWall — south ground, profile=[[0,0],[26,0]], thickness=0.67, height=9.0
6. SdWall — east ground, profile=[[26,0],[26,20]], thickness=0.67, height=9.0
7. SdWall — north ground, profile=[[26,20],[0,20]], thickness=0.67, height=9.0
8. SdWall — west ground, profile=[[0,20],[0,0]], thickness=0.67, height=9.0
9. SdDoor — south entry, position=[13,0,0], width=3.0, height=7.0, sillH=0
10. SdWindow — south, position=[5,0,0], width=3.0, height=4.0, sillH=3.0
11. SdWindow — east, position=[26,10,0], width=3.0, height=4.0, sillH=3.0
12. SdWindow — north, position=[13,20,0], width=3.0, height=4.0, sillH=3.0
13. SdWindow — west, position=[0,10,0], width=3.0, height=4.0, sillH=3.0
14. SdStair — NE corner, start=[23,16], end=[23,8], type=straight, riser=0.583, tread=0.917, width=3.0, targetHeight=9.0
15. setActiveLevel — id=level/1
16. SdSlab — upper, profile=[[0,0],[26,0],[26,20],[0,20]], thickness=0.67
17. SdWall — south upper, profile=[[0,0],[26,0]], thickness=0.67, height=9.0
18. SdWall — east upper, profile=[[26,0],[26,20]], thickness=0.67, height=9.0
19. SdWall — north upper, profile=[[26,20],[0,20]], thickness=0.67, height=9.0
20. SdWall — west upper, profile=[[0,20],[0,0]], thickness=0.67, height=9.0
21. SdWindow — upper south, position=[5,0,0], width=3.0, height=4.0, sillH=3.0
22. SdWindow — upper east, position=[26,10,0], width=3.0, height=4.0, sillH=3.0
23. SdWindow — upper north, position=[13,20,0], width=3.0, height=4.0, sillH=3.0
24. SdWindow — upper west, position=[0,10,0], width=3.0, height=4.0, sillH=3.0
25. SdRoof — pitched, footprint=[[0,0],[26,0],[26,20],[0,20]], pitchDeg=30
</plan>
<tool_call>{"name":"SdLevel","arguments":{"name":"Level 1","elevation":0,"height":9.0,"extent":26},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdLevel","arguments":{"name":"Level 2","elevation":9.0,"height":9.0,"extent":26},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"setActiveLevel","arguments":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdSlab","arguments":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdDoor","arguments":{"position":[13,0,0],"width":3.0,"height":7.0,"sillH":0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[5,0,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[26,10,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[13,20,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[0,10,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdStair","arguments":{"start":[23,16],"end":[23,8],"type":"straight","riser":0.583,"tread":0.917,"width":3.0,"targetHeight":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"setActiveLevel","arguments":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdSlab","arguments":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[5,0,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[26,10,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[13,20,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[0,10,0],"width":3.0,"height":4.0,"sillH":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdRoof","arguments":{"roofType":"pitched","footprint":[[0,0],[26,0],[26,20],[0,20]],"pitchDeg":30},"metadata":{"source":"agent"}}</tool_call>
`.trim();


export function buildSystemPrompt(skills?: Skill[]): string {
  return [
    "You are Gemma, a parametric CAD assistant. Be direct — no preamble, no performative filler ('certainly!', 'I'll help you with that!', 'Great!' and similar are forbidden).",
    "PLAN BEFORE DISPATCH: For every request that emits tool calls, first emit a compact <plan> block, then the tool_call blocks.\n<plan> format — EXACTLY this structure, no prose:\n<plan>\n1. VerbName — key_arg=value, …\n2. VerbName — key_arg=value\n</plan>",
    "AMBIGUITY: Infer the most common default and proceed. If one critical parameter is missing, state your assumption on ONE line (e.g. 'Assuming 2.8 m ceiling height.') then execute. Do NOT ask multiple clarifying questions.",
    'Tool call format: <tool_call>{"name":"FunctionName","arguments":{...},"metadata":{"source":"agent"}}</tool_call>',
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
    summariseCanvasSkills(),
  ].filter(Boolean).join("\n\n");
}

// On-device WebGPU system prompt. Uses full FEW_SHOT_EXAMPLES (#999):
// ONNX model (onnx-community/gemma-4-E4B-it-ONNX) has RoPE caches at [131072, 128/256]
// and config max_position_embeddings=131072 — not baked at 2048. The earlier SafeInt
// overflow was from pre-#992 WEBGPU_CONTEXT_LIMIT=2048 in model-worker.ts (now 16384).
export function buildWebGPUSystemPrompt(skills?: Skill[]): string {
  const dict = getDictionary();
  const implemented = new Set(listHandlers());
  const available = implemented.size > 0 ? dict.filter((e) => implemented.has(e.name)) : dict;
  const verbNames = available.map((e) => e.name).join(", ");
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
    FEW_SHOT_EXAMPLES,
    verbList,
    summariseCanvasSkills(),
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
          // Accept "name" (Gemma-4-native) with "command" as backward-compat fallback.
          const nameRaw =
            typeof obj.name === "string"
              ? obj.name
              : typeof obj.command === "string"
                ? obj.command
                : "";
          const funcName = nameRaw.trim();
          const funcArgs = (
            obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)
              ? obj.arguments
              : obj.parameters && typeof obj.parameters === "object" && !Array.isArray(obj.parameters)
                ? obj.parameters
                : {}
          ) as Record<string, unknown>;
          if (funcName) { dispatches.push({ name: funcName, arguments: funcArgs }); found = true; }
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

  const stream = sb.generate({ messages, maxNewTokens: req.maxNewTokens ?? 4096 });
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

// ---- WASM backend turn (#736) --------------------------------------------

let _wasmLoading = false;

/** Route a turn through the WASM-llama backend (turboquant + MTP, browser-resident). */
async function runWasmBackendTurn(req: AgentRequest): Promise<AgentResponse> {
  if (!_wasmLoading) {
    _wasmLoading = true;
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  WASM · loading…`);
    await loadWasmBackend();
  }

  const mtpLabel = WASM_DRAFTER_URL ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  WASM${mtpLabel} · ⟳`);

  const MAX_HISTORY_MSGS = 20;
  const trimmedHistory = (req.history ?? []).slice(-MAX_HISTORY_MSGS);
  const messages = [
    { role: "system" as const, content: buildSystemPrompt(req.skills) },
    ...trimmedHistory,
    { role: "user" as const, content: req.prompt },
  ];

  const json = await wasmChatCompletion({
    messages,
    max_tokens:  req.maxNewTokens ?? 4096,
    temperature: 0.1,
  });

  const content = json.choices[0]?.message?.content ?? "";
  const tpsLabel = json._tps > 0 ? ` · ${json._tps.toFixed(0)} t/s` : "";
  const mtpActiveLabel = json._mtp_enabled ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  WASM${mtpActiveLabel}${tpsLabel}`);

  recordTurn({
    ts:                   Date.now(),
    prefill_ms:           0,
    decode_ms:            json._latency_ms,
    tokens_in:            0,
    tokens_out:           0,
    system_prompt_chars:  buildSystemPrompt(req.skills).length,
    skills_total:         req.skillsTotal ?? req.skills?.length ?? 0,
    skills_matched:       req.skills?.length ?? 0,
    tg_tps:               json._tps,
    pp_tps:               0,
    mtp_on:               json._mtp_enabled,
    path:                 "wasm",
  });

  const { dispatches, text } = parseDispatches(content);
  return { dispatches, text: text || content, raw: json };
}

// ---- Public entry point --------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
  // P10-2: if a prior worker error engaged the session-level fallback, route remote.
  if (REMOTE_URL && _webgpuFallbackEngaged) return runRemoteAgentTurn(req);
  if (REMOTE_URL) return runRemoteAgentTurn(req);

  // #736: WASM backend — env-gated, runs turboquant MTP in-browser via Emscripten.
  if (WASM_BACKEND_ENABLED && !payloadHasMultimodal(req)) return runWasmBackendTurn(req);

  // #929: if drafter failed and dedicated standard backend is ready, use it.
  // Standard backend runs model.generate() in its own isolated worker so the
  // MTP worker thread is not contended during standard-path inference.
  const drafterLoaded = (globalThis as unknown as { __drafterLoaded?: boolean }).__drafterLoaded;
  if (_standardBackend && drafterLoaded === false && !payloadHasMultimodal(req)) {
    return runStandardBackendTurn(req);
  }

  // #1036: Guard against chip-click-before-ready (loading bar "done" but model not loaded).
  if (_modelLoadError) {
    // §C-error-wording (#1369): only blame WebGPU when the error text actually implicates it.
    // _modelLoadError is set on ANY fatal worker error (fetch 401, ONNX session, etc.) — the
    // blanket "WebGPU not supported" wording was wrong for non-adapter failures.
    const _isWebGpuError = /WebGPU|adapter|GPUDevice|requestAdapter/i.test(_modelLoadError);
    throw new Error(
      _isWebGpuError
        ? `Model failed to load — WebGPU may not be supported on this device. Try Chrome 115+ on a desktop with a dedicated GPU. (${_modelLoadError})`
        : `Model failed to load — ${_modelLoadError}. Try refreshing or check the browser console for details.`
    );
  }
  if (!_bootComplete) {
    throw new Error("Model is still loading — please wait a moment and try again.");
  }

  // ── On-device path via Web Worker (#936) ─────────────────────────────────
  // Worker owns: from_pretrained, WebGPU probe, warmup, drafter load, tokenization,
  // generate, decode. Main thread never blocks during model load or inference.
  await recycleModelWorkerIfNeeded(); // #1303: release ONNX WebGPU buffer pool every N turns
  const worker = initWorkerIfNeeded();

  // Get imageUrl for vision turns (worker loads RawImage internally — no transfer needed).
  let imageUrl: string | undefined;
  if (req.userImage) {
    imageUrl = req.userImage;
  }

  // §#693 Video: when VITE_VIDEO_INPUT is set and ring-buffer frames are present,
  // sample + encode frames to data URLs for the worker's video content block path.
  // imageUrl is intentionally NOT set for video turns — worker uses videoUrls instead.
  let videoUrls: string[] | undefined;
  if (VIDEO_INPUT_ENABLED && req.frames && req.frames.length > 0) {
    videoUrls = await buildVideoDataUrls(req.frames);
  } else if (!req.userImage && req.frames && req.frames.length > 0) {
    // Fallback when video gate is off: single viewport capture (prior behavior).
    imageUrl = captureViewport() ?? undefined;
  }

  // Plain-text messages: worker splices image into last user message if imageUrl is set.
  // §C (#990): build once, reuse length for telemetry — avoids redundant 7K-char rebuild.
  const MAX_HISTORY_MSGS = 20;
  let trimmedHistory = (req.history ?? []).slice(-MAX_HISTORY_MSGS);
  // Char-based safety trim: ~40K chars ≈ 10K tokens, leaves 6K headroom for sys+image+prompt
  // within the 16384-token WEBGPU_CONTEXT_LIMIT. Drop oldest user+assistant pairs together.
  const HISTORY_CHAR_BUDGET = 40_000;
  {
    let histChars = trimmedHistory.reduce(
      (s, m) => s + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    while (histChars > HISTORY_CHAR_BUDGET && trimmedHistory.length >= 2) {
      histChars -= (typeof trimmedHistory[0].content === "string" ? trimmedHistory[0].content.length : 0)
                + (typeof trimmedHistory[1].content === "string" ? trimmedHistory[1].content.length : 0);
      trimmedHistory = trimmedHistory.slice(2);
    }
  }
  const _sysPrompt = buildWebGPUSystemPrompt(req.skills);
  const messages = [
    { role: "system" as const, content: _sysPrompt },
    ...trimmedHistory,
    { role: "user" as const, content: req.prompt },
  ];

  const useMtp = !_MTP_OFF;
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  // §C-turn-start (#1371): observable marker so Phase J harness can confirm runAgentTurn fired.
  window.dispatchEvent(new CustomEvent("agent:turn-start", { detail: { turnId } }));

  let result: WorkerGenResult;
  try {
    result = await new Promise<WorkerGenResult>((resolve, reject) => {
      // §B-watchdog (#1313): if generate produces no output for 60s, force-terminate the
      // worker and reject with a retryable error. Bounds the D3D12 silent-hang failure to
      // 60s instead of 603s. Device is destroyed before terminate to release D3D12 buffers.
      const _WATCHDOG_MS = 60_000;
      let _watchdogTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        _watchdogTimer = null;
        _generateCallbacks.delete(turnId);
        const _stalled = _inferenceWorker;
        _inferenceWorker = null;
        _workerReady = false;
        _prefillDone = false;
        _bootComplete = false;
        _modelWorkerTurnCount = 0;
        // §C-recycle-no-warmup (#1377): same rationale as D3D12-OOM path. Skip warmup
        // on recycle — the 1000-token probe (#1362/#1373) crashes on the fresh GPU,
        // blocking boot-complete for 240s. First real inference compiles shaders anyway.
        _nextInitNoWarmup = true;
        _modelWorkerRecycleCount++;
        (window as unknown as Record<string, unknown>).__model_worker_recycle_count = _modelWorkerRecycleCount;
        window.dispatchEvent(new CustomEvent("agentmodel:worker-recycled", {
          detail: { recycleCount: _modelWorkerRecycleCount, reason: "generate-stall-watchdog" },
        }));
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_deviceLabel} · ⟳`);
        if (_stalled) {
          _stalled.postMessage({ type: "destroy-device" }); // best-effort D3D12 cleanup
          // #1366: terminate then eagerly spawn replacement so agentmodel:boot-complete
          // fires + chat-input gate (PR #1355) re-enables SEND. Without respawn, the next
          // runAgentTurn call (which spawns the worker via initWorkerIfNeeded) never
          // happens because SEND stays disabled → hard deadlock.
          setTimeout(() => {
            _stalled.terminate();
            initWorkerIfNeeded();
          }, 400);
        }
        console.warn("[agent-harness] worker-stall: generate exceeded 60s, worker recycled");
        reject(new Error("Response timed out — the model is reloading. Try again in about 30 seconds."));
      }, _WATCHDOG_MS);

      _generateCallbacks.set(turnId, {
        resolve: (r) => { if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; } resolve(r); },
        reject:  (e) => { if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; } reject(e); },
      });
      // §C-stale-cb (#1371): if worker never responds within 5s of callback registration,
      // log a diagnostic. Distinct from the 60s watchdog (which recycles) — this fires
      // earlier and helps identify whether postMessage was enqueued or silently dropped.
      setTimeout(() => {
        if (_generateCallbacks.has(turnId)) {
          console.warn("[agent-harness] generate-start-no-response: 5s with no worker response, turnId=%s", turnId);
          window.dispatchEvent(new CustomEvent("agent:generate-stale", { detail: { turnId } }));
        }
      }, 5_000);
      worker.postMessage({
        type:          "generate",
        turnId,
        messages,
        imageUrl,
        videoUrls,     // §#693 — defined when VITE_VIDEO_INPUT + req.frames
        maxNewTokens:  req.maxNewTokens ?? 4096,
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

// ── Multi-instance factory (#1122) ────────────────────────────────────────────
// Bound to runAgentTurn so all instances share the single loaded model worker.
// N=2 VRAM delta ≈ 0 — only CPU-RAM history arrays are added per instance.
export const createAgentInstance = makeAgentInstanceFactory(runAgentTurn);
