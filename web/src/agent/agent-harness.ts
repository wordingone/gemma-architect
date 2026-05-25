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
// §P0-ARC (#1389): typed runtime state machine — replaces scattered lifecycle booleans.
import { AgentRuntimeController } from "./agent-runtime-controller";
const _arc = new AgentRuntimeController();

// §#1628: Sentry telemetry — init at module load; active in PROD when VITE_SENTRY_DSN is set.
initTelemetry();

// Boot telemetry state — accumulated across phase_timing messages; emitted on boot-complete.
let _telBootLoadSource = "unknown";
let _telWorkerBootMs = 0; // set when initWorkerIfNeeded creates the worker

// §#1659: dev-tool — accumulate raw model output per turn for Phase J sidecar.
let _rawOutIdx = 0;
type _RawOutputEntry = { turnId: number; ts: string; raw: string };
(window as unknown as { __agentRawOutputs?: _RawOutputEntry[] }).__agentRawOutputs ??= [];

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
import { selfSpecController, BASELINE_TPS_P50 } from "./self-spec-controller";
import type { SelfSpecRuntimeState } from "./self-spec-controller";
import { isWasmFallbackMode } from "./boot-screen";
import {
  initTelemetry,
  emitBootFingerprint,
  emitBootComplete,
  emitDispatchTurn,
  emitRecycle,
  type AdapterFingerprint,
} from "./telemetry-remote.js";

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

// §P0-ARC (#1389): lifecycle flags now live on _arc. Module-scope aliases for
// backwards-compatible read access; all mutations go through _arc.dispatch().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).__arc = _arc; // DevTools inspection

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
type WorkerGenResult = {
  text: string; specAttempts: number; specAccepts: number;
  prefillMs: number; decodeMs: number; inputLength: number; tokensOut: number;
};
const _generateCallbacks = new Map<string, {
  resolve: (r: WorkerGenResult) => void;
  reject: (e: Error) => void;
}>();
// §#1472: per-token activity watchdog reset — set by runAgentTurn, called on each
// generate-progress heartbeat (every 50 tokens). Lets long responses complete without
// the 60s watchdog firing. The watchdog only fires if NO tokens arrive for 60s.
let _activeWatchdogReset: (() => void) | null = null;

// ── Model-worker recycle (#1303) ─────────────────────────────────────────────
// Terminate + reinitialize the inference worker every N turns to release
// accumulated ONNX WebGPU buffer pool (KV cache residuals). Model weights
// reload from browser cache — no network download after first load.
const MODEL_WORKER_RECYCLE_AFTER = 5; // turns before forced recycle (#1313: was 10; Phase J data shows stall at turn 6 with threshold=10 — recycle after 5 turns prevents accumulated GPU state from reaching the stall point)
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__model_worker_recycle_count = 0;
}

// §#1505: Scene-VRAM pressure threshold — creator-tagged objects beyond this count
// indicate enough THREE.js GPU buffers to compete with LLM KV-cache on the next turn.
// Triggers proactive worker recycle (KV-cache flush) before inference begins.
const SCENE_VRAM_RECYCLE_THRESHOLD = 12;

// §#1505: Shared graceful-shutdown + planned-recycle sequence.
// Used by both the turn-count gate and the scene-VRAM gate.
async function _doPlannedRecycle(reason: string): Promise<void> {
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
  _arc.dispatch({ type: "D3D12_OOM", reason: "planned" });
  (window as unknown as Record<string, unknown>).__model_worker_recycle_count = _arc.recycleCount;
  window.dispatchEvent(new CustomEvent("agentmodel:worker-recycled", {
    detail: { recycleCount: _arc.recycleCount, reason },
  }));
  _arc.dispatch({ type: "WORKER_RECYCLED", recycleCount: _arc.recycleCount, reason });
  emitRecycle(_arc.recycleCount, reason);
}

async function recycleModelWorkerIfNeeded(): Promise<void> {
  if (!_inferenceWorker) return;

  // §#1505: VRAM-aware early recycle — count creator-tagged scene objects.
  // When the scene has grown large (many GPU buffers from dispatches), flush the
  // ORT KV-cache BEFORE the next turn's inference to prevent D3D12_OOM mid-turn.
  // Fires ahead of the turn-count gate so Turn 2 gets a fresh worker after a large Turn 1.
  {
    type CreatorChild = { userData?: Record<string, unknown> };
    const _sceneArr = (window as unknown as { __viewer?: { scene?: { children?: CreatorChild[] } } })
      .__viewer?.scene?.children;
    const _creatorCount = _sceneArr?.filter(c => c.userData?.creator != null).length ?? 0;
    if (_creatorCount >= SCENE_VRAM_RECYCLE_THRESHOLD && _arc.turnCount > 0) {
      await _doPlannedRecycle("scene-vram");
      return;
    }
  }

  if (_arc.turnCount < MODEL_WORKER_RECYCLE_AFTER) return;

  await _doPlannedRecycle("planned"); // #1303: turn-count-based KV buffer flush
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
  _telWorkerBootMs = Date.now(); // §#1628: epoch for boot_complete elapsed_ms
  _telBootLoadSource = "unknown"; // reset per worker spawn
  // §P0-ARC: signal boot start only from quiescent states; recovering path skips BOOT_REQUESTED
  // (it goes directly from recovering → ready via MODEL_READY + BOOT_COMPLETE from new worker).
  if (_arc.state === "idle" || _arc.state === "ready" || _arc.state === "failed") {
    _arc.dispatch({ type: "BOOT_REQUESTED" });
  }

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
        _arc.dispatch({ type: "MODEL_READY", device: (msg.device as string) === "GPU" ? "GPU" : "CPU" });
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel}`);
        window.dispatchEvent(new CustomEvent("agentmodel:ready", { detail: { device: _arc.deviceLabel } }));
        break;
      case "warmup-done":
        _arc.dispatch({ type: "PREFILL_DONE" });
        if (msg.skipped) {
          // #1313: noWarmup path confirmed. Expose for harness (window.__agent_warmup_skipped_count).
          const w = window as unknown as Record<string, unknown>;
          w.__agent_warmup_skipped_count = ((w.__agent_warmup_skipped_count as number | undefined) ?? 0) + 1;
        }
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel} · READY`);
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
      case "phase_timing": {
        // §#1628: accumulate boot telemetry state from worker diagnostic messages.
        const _ptPhase = msg.phase as string;
        if (_ptPhase === "from_pretrained_start" && msg.load_source) {
          _telBootLoadSource = msg.load_source as string;
        }
        if (_ptPhase === "adapter_fingerprint" && msg.adapter_info) {
          emitBootFingerprint(msg.adapter_info as AdapterFingerprint);
        }
        break;
      }
      case "boot-complete":
        _arc.dispatch({ type: "BOOT_COMPLETE" }); // #1036 — sets bootComplete, clears nextInitNoWarmup
        window.dispatchEvent(new CustomEvent("agentmodel:boot-complete"));
        // §#1628: emit boot_complete telemetry with elapsed time + load source.
        emitBootComplete(_telWorkerBootMs > 0 ? Date.now() - _telWorkerBootMs : 0, _telBootLoadSource);
        break;
      case "ready":
        // workerReady already set by MODEL_READY dispatch — no additional state mutation needed
        break;
      case "context-budget":
        window.dispatchEvent(new CustomEvent("agentmodel:context-budget", {
          detail: {
            inputLength: msg.inputLength as number,
            limit: msg.limit as number,
            ratio: (msg.inputLength as number) / (msg.limit as number),
          },
        }));
        break;
      case "generate-progress":
        _activeWatchdogReset?.(); // §#1472: reset per-token watchdog (50-token heartbeat)
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
          // turnCount incremented by GENERATE_REQUESTED dispatch at turn start
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
        // §#1666: reset ARC from "generating" → "ready" so subsequent prompts don't deadlock.
        _arc.dispatch({ type: "GENERATE_FAILED" });
        if (msg.error === "model not loaded") {
          (window as unknown as Record<string, unknown>).__model_dead = true;
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
          // §P0-ARC: D3D12_OOM resets all lifecycle flags and increments recycleCount.
          _arc.dispatch({ type: "D3D12_OOM" }); // → state = recycling
          (window as unknown as Record<string, unknown>).__model_worker_recycle_count = _arc.recycleCount;
          const _win = window as unknown as Record<string, unknown>;
          _win.__agent_d3d12_recycles = ((_win.__agent_d3d12_recycles as number | undefined) ?? 0) + 1;
          window.dispatchEvent(new CustomEvent("agentmodel:worker-recycled", {
            detail: { recycleCount: _arc.recycleCount, reason: "d3d12-oom" },
          }));
          emitRecycle(_arc.recycleCount, "d3d12-oom"); // §#1628
          // §C-recycle-limit (#1381): 2+ GPU resets → page-level WGPU adapter irrecoverably
          // corrupted. Auto-respawn produces "function signature mismatch" because the new
          // worker's ONNX WASM imports fail against the torn adapter's device table.
          // Surface user-actionable reload message and halt instead of spawning a doomed worker.
          // §#1505: FATAL_ERROR only when ≥2 *unplanned* OOMs occur consecutively.
          // Planned recycling (scene-vram / turn-count flushes) resets unplannedOomCount to 0
          // via BOOT_REQUESTED on the new worker, preventing false FATAL_ERROR.
          if (_arc.unplannedOomCount >= 2) {
            const _fatalMsg = "GPU memory exhausted after multiple resets — please refresh the page to continue.";
            _arc.dispatch({ type: "FATAL_ERROR", error: _fatalMsg }); // sets webgpuFallbackEngaged, bootComplete, modelLoadError
            for (const [, cb] of _generateCallbacks) cb.reject(new Error(_fatalMsg));
            _generateCallbacks.clear();
            updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ERROR`);
            window.dispatchEvent(new CustomEvent("agentmodel:fatal", {
              detail: { reason: "recycle-limit", recycleCount: _arc.recycleCount },
            }));
            // Re-enable chat input so the error surfaces on the user's next send attempt.
            window.dispatchEvent(new CustomEvent("agentmodel:boot-complete"));
            setTimeout(() => { _w.terminate(); }, 400);
            break;
          }
          // Normal first recycle (count === 1): respawn worker without warmup (#1377).
          _arc.dispatch({ type: "WORKER_RECYCLED", recycleCount: _arc.recycleCount, reason: "d3d12-oom" }); // → recovering
          updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel} · ⟳`);
          // §C-recycle-silent (#1394): tag with isD3D12Recycle so chat-panel suppresses
          // the error bubble. Recycle is a background recovery — badge shows ⟳, user retries.
          for (const [, cb] of _generateCallbacks) {
            const _re = Object.assign(new Error("d3d12-oom: worker recycled"), { isD3D12Recycle: true });
            cb.reject(_re);
          }
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
        _arc.dispatch({ type: "FATAL_ERROR", error: _errMsg }); // #1036 — sets webgpuFallbackEngaged, bootComplete, modelLoadError
        console.error("[gemma] model load failed:", _errMsg); // #1036 DevTools AC1
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ERROR`);
        window.dispatchEvent(new CustomEvent("agentmodel:error", { detail: msg.error }));
        for (const [, cb] of _generateCallbacks) cb.reject(new Error(_errMsg));
        _generateCallbacks.clear();
        break;
      }
      // §#1627-D: classification-aware device.lost handler.
      // Worker fires this when GPUDevice.lost resolves with reason !== "destroyed".
      // retryBudget=1 (dgpu) → existing D3D12 OOM recycle path (one WebGPU retry).
      // retryBudget=0 (igpu/software) → navigate to ?gpu=wasm, no WebGPU retry.
      case "device-lost": {
        const _adClass  = (msg.adClass  as string) ?? "unknown";
        const _budget   = (msg.retryBudget as number) ?? 0;
        const _lostReason = (msg.reason as string) ?? "unknown";
        console.log(`[#1627-D] harness: device.lost adClass=${_adClass} reason=${_lostReason} retryBudget=${_budget}`);
        window.dispatchEvent(new CustomEvent("agentmodel:device-lost", {
          detail: { adClass: _adClass, reason: _lostReason, retryBudget: _budget },
        }));
        if (_budget === 0) {
          // igpu/software: skip WebGPU retry — reload under WASM EP (boot-capability-gate path 2).
          console.log("[#1627-D] igpu/software device.lost — redirecting to ?gpu=wasm");
          window.location.assign(new URL("?gpu=wasm", window.location.href).href);
        } else if (_inferenceWorker) {
          // dgpu: treat as D3D12 OOM — one recycle allowed before fatal path (matches §C-recycle-limit #1381).
          _inferenceWorker.postMessage({ type: "destroy-device" });
          const _w = _inferenceWorker;
          _inferenceWorker = null;
          _arc.dispatch({ type: "D3D12_OOM" });
          (window as unknown as Record<string, unknown>).__model_worker_recycle_count = _arc.recycleCount;
          const _win = window as unknown as Record<string, unknown>;
          _win.__agent_d3d12_recycles = ((_win.__agent_d3d12_recycles as number | undefined) ?? 0) + 1;
          window.dispatchEvent(new CustomEvent("agentmodel:worker-recycled", {
            detail: { recycleCount: _arc.recycleCount, reason: "device-lost-dgpu" },
          }));
          emitRecycle(_arc.recycleCount, "device-lost-dgpu"); // §#1628
          if (_arc.unplannedOomCount >= 2) {
            const _fatalMsg = "GPU device lost after multiple resets — please refresh the page to continue.";
            _arc.dispatch({ type: "FATAL_ERROR", error: _fatalMsg });
            for (const [, cb] of _generateCallbacks) cb.reject(new Error(_fatalMsg));
            _generateCallbacks.clear();
            updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ERROR`);
            window.dispatchEvent(new CustomEvent("agentmodel:fatal", {
              detail: { reason: "device-lost-recycle-limit", recycleCount: _arc.recycleCount },
            }));
            window.dispatchEvent(new CustomEvent("agentmodel:boot-complete"));
            setTimeout(() => { _w.terminate(); }, 400);
          } else {
            _arc.dispatch({ type: "WORKER_RECYCLED", recycleCount: _arc.recycleCount, reason: "device-lost-dgpu" }); // → recovering
            updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel} · ⟳`);
            for (const [, cb] of _generateCallbacks) {
              const _re = Object.assign(new Error("device-lost: worker recycled"), { isD3D12Recycle: true });
              cb.reject(_re);
            }
            _generateCallbacks.clear();
            setTimeout(() => { _w.terminate(); initWorkerIfNeeded(); }, 400);
          }
        }
        break;
      }
    }
  };

  _inferenceWorker.onerror = (e) => {
    _arc.webgpuFallbackEngaged = true; // direct assignment — onerror can fire from any state
    const errMsg = e.message ?? "worker error";
    updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  ERROR`);
    for (const [, cb] of _generateCallbacks) cb.reject(new Error(errMsg));
    _generateCallbacks.clear();
  };

  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LOADING…`);
  window.dispatchEvent(new CustomEvent("agentmodel:loading", { detail: { progress: 0 } }));

  const _noWarmup = _arc.nextInitNoWarmup; // consumed — controller clears on BOOT_COMPLETE
  _inferenceWorker.postMessage({
    type:             "init",
    modelId:          MODEL_ID,
    drafterUrl:       DRAFTER_ONNX_URL,
    drafterCacheKey:  DRAFTER_CACHE_KEY,
    noWarmup:         _noWarmup,
    // §#1637 Path 2: forceWasm=true when user chose WASM EP fallback at boot modal.
    forceWasm:        isWasmFallbackMode(),
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
  if (_arc.prefillDone) return;
  _arc.dispatch({ type: "PREFILL_DONE" });

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
    _arc.prefillDone = false; // reset on failure so next call retries
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
- UNITS: values in the prompt are authoritative. "12m" means exactly 12 metres — never apply imperial-to-metric conversion when the prompt uses metric. "12ft" means 12 feet. Emit the number exactly as specified in the active unit system.
- CONTINUATION UNIT RULE: In a continuation turn (adding to an existing scene), metric values pass through DIRECTLY — do NOT convert. "12m" → 12.0. "1m tall" → height=1.0. Only explicit feet/inch literals receive ft→m conversion. The parent structure's unit syntax does not affect new additions stated in metres.
`.trim();

const BUILDING_DEFAULTS = `
BUILDING DEFAULTS — apply when dimensions are unspecified. "Design a house/apartment/office" implies ALL of the following element types:
- IfcLevel: one per storey (elevation = floor_index × floor_height). Always emit before walls on that level.
- IfcWall: exterior 0.15m thick; interior partition 0.10m thick. Enclose all rooms — no open faces. Every multi-room building MUST include ≥1 interior partition per storey (profile endpoints both inside the perimeter bbox, centroid >0.5m from any perimeter edge).
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
- ATTACHED STRUCTURES ("attached to the south/north/east/west wall", "garage on the side", "extension"): the new structure's footprint EXTENDS FROM the shared wall face outward. Never collapse profile endpoints — p1 must differ from p2 on every SdWall.
- EXTENSION RULE (algorithm for every attached structure): (1) Read the shared-face wall endpoints W1, W2 from prior tool_calls in this conversation. (2) perpendicular direction = away from parent: if wall is along X axis (W1.y=W2.y), perp=[0,-1] for south or [0,+1] for north; if along Y axis (W1.x=W2.x), perp=[-1,0] for west or [+1,0] for east. (3) Far-face: F1=[W1[0]+perp[0]*depth, W1[1]+perp[1]*depth], F2=[W2[0]+perp[0]*depth, W2[1]+perp[1]*depth]. (4) Emit three walls: far [F1,F2], side-A [W1,F1], side-B [W2,F2]. INVARIANT: every emitted wall has p1≠p2 (dist≥0.5m). NEVER submit [W,W] — same coordinate for both endpoints.
- SdWall (boundary/garden/fence): height 1.2m minimum; 1.2m–1.8m typical. 0.3m signals a ft→m unit error (1ft ≈ 0.30m); use 1.2m instead. Never emit height < 1.0m for outdoor boundary context.
`.trim();

// Handler auto-behaviors: concise principles so the agent knows what NOT to compute.
// Token budget: ≤200 tokens for this entire block.
const MULTI_LEVEL_NOTES = `
HANDLER AUTO-BEHAVIORS — the dispatch handlers do these automatically; agent must NOT re-compute or emit extra args for them:
- IfcRoof(type=pitched): auto-trims the two short-edge (gable-end) walls to a triangle profile. Emit IfcRoof only — do NOT emit topProfile on walls.
- IfcStair: auto-cuts a rectangular stairwell void through the IfcSlab at target elevation. Place IfcStair AFTER the upper-floor slab.
- Multi-level sequence: emit ALL IfcLevel calls first (elevation=0, 3.0, 6.0 ...), then setActiveLevel, then walls+slabs for that level. Walls spanning only one storey use height = floor_height (not total building height).
- SdSlab MUST be the FIRST dispatch after each setActiveLevel (intermediate floor slab for that storey). Emit SdSlab before any SdWall on that level — walls with no floor beneath them are invalid.
`.trim();

// FEW_SHOT_EXAMPLES — API/CPU path. Two examples kept trim for WASM heap (#1058, #1194).
const FEW_SHOT_EXAMPLES = `
Examples — emit <plan> block then <tool_call> tags, copy function names EXACTLY:

User: draw a 5m wall, 0.2m thick, 2.8m tall
Assistant:
<plan>
1. SdWall — profile=[[0,0],[5,0]], thickness=0.2, height=2.8
</plan>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,0],[5,0]],"thickness":0.2,"height":2.8},"metadata":{"source":"agent"}}</tool_call>

User: Build a two-story residential house, 26' wide by 20' deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs.
Assistant: 26ft × 20ft, 2 floors × 9.0ft walls, pitched roof. Ground: slab + 4 perimeter walls + 2 interior partitions (E-W at y=10, N-S at x=13) + door + 4 windows + stair. Upper: slab + 4 walls + 4 windows + SdRoof.
<plan>
1. SdLevel — name="Level 1", elevation=0, height=9.0, extent=26
2. SdLevel — name="Level 2", elevation=9.0, height=9.0, extent=26
3. setActiveLevel — id=level/0
4. SdSlab — profile=[[0,0],[26,0],[26,20],[0,20]], thickness=0.67
5. SdWall — south ground, profile=[[0,0],[26,0]], thickness=0.67, height=9.0
6. SdWall — east ground, profile=[[26,0],[26,20]], thickness=0.67, height=9.0
7. SdWall — north ground, profile=[[26,20],[0,20]], thickness=0.67, height=9.0
8. SdWall — west ground, profile=[[0,20],[0,0]], thickness=0.67, height=9.0
9. SdWall — interior partition E-W, profile=[[1,10],[12,10]], thickness=0.33, height=9.0
10. SdWall — interior partition N-S, profile=[[13,10],[13,19]], thickness=0.33, height=9.0
11. SdDoor — south entry, position=[13,0,0], sillH=0
12. SdWindow — south, position=[5,0,0], windowType=eg
13. SdWindow — east, position=[26,10,0], windowType=eg
14. SdWindow — north, position=[13,20,0], windowType=eg
15. SdWindow — west, position=[0,10,0], windowType=eg
16. SdStair — NE corner, start=[23,16], end=[23,8], type=straight
17. setActiveLevel — id=level/1
18. SdSlab — upper, profile=[[0,0],[26,0],[26,20],[0,20]], thickness=0.67
19. SdWall — south upper, profile=[[0,0],[26,0]], thickness=0.67, height=9.0
20. SdWall — east upper, profile=[[26,0],[26,20]], thickness=0.67, height=9.0
21. SdWall — north upper, profile=[[26,20],[0,20]], thickness=0.67, height=9.0
22. SdWall — west upper, profile=[[0,20],[0,0]], thickness=0.67, height=9.0
23. SdWindow — upper south, position=[5,0,0], windowType=og
24. SdWindow — upper east, position=[26,10,0], windowType=og
25. SdWindow — upper north, position=[13,20,0], windowType=og
26. SdWindow — upper west, position=[0,10,0], windowType=og
27. SdRoof — pitched, footprint=[[0,0],[26,0],[26,20],[0,20]], pitchDeg=30
</plan>
<tool_call>{"name":"SdLevel","arguments":{"name":"Level 1","elevation":0,"height":9.0,"extent":26},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdLevel","arguments":{"name":"Level 2","elevation":9.0,"height":9.0,"extent":26},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"setActiveLevel","arguments":{"id":"level/0"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdSlab","arguments":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[1,10],[12,10]],"thickness":0.33,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[13,10],[13,19]],"thickness":0.33,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdDoor","arguments":{"position":[13,0,0],"sillH":0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[5,0,0],"windowType":"eg"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[26,10,0],"windowType":"eg"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[13,20,0],"windowType":"eg"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[0,10,0],"windowType":"eg"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdStair","arguments":{"start":[23,16],"end":[23,8],"type":"straight"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"setActiveLevel","arguments":{"id":"level/1"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdSlab","arguments":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[5,0,0],"windowType":"og"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[26,10,0],"windowType":"og"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[13,20,0],"windowType":"og"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWindow","arguments":{"position":[0,10,0],"windowType":"og"},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdRoof","arguments":{"roofType":"pitched","footprint":[[0,0],[26,0],[26,20],[0,20]],"pitchDeg":30},"metadata":{"source":"agent"}}</tool_call>

User: add a garage attached to the south wall, 5m wide by 3m deep (parent house south wall runs from [0,0] to [5,0])
Assistant: W1=[0,0] W2=[5,0] (south wall, along X). Perp=[0,-1] (extends south). F1=[0,-3] F2=[5,-3]. Far wall [F1,F2]; side-west [W1,F1]; side-east [W2,F2]. All p1≠p2. House south wall NOT re-emitted.
<plan>
1. SdWall — garage south (far), profile=[[0,-3],[5,-3]], thickness=0.2, height=2.4
2. SdWall — garage west side, profile=[[0,-3],[0,0]], thickness=0.2, height=2.4
3. SdWall — garage east side, profile=[[5,-3],[5,0]], thickness=0.2, height=2.4
</plan>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,-3],[5,-3]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,-3],[0,0]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[5,-3],[5,0]],"thickness":0.2,"height":2.4},"metadata":{"source":"agent"}}</tool_call>

User: add a storage annex attached to the east wall, 5m deep (parent east wall runs from [6,-4] to [6,4])
Assistant: W1=[6,4] W2=[6,-4] (east wall, along Y). Perp=[+1,0] (extends east). F1=[11,4] F2=[11,-4]. Far wall [F1,F2]; side-north [W1,F1]; side-south [W2,F2]. All p1≠p2.
<plan>
1. SdWall — annex east (far), profile=[[11,4],[11,-4]], thickness=0.2, height=3.0
2. SdWall — annex north side, profile=[[6,4],[11,4]], thickness=0.2, height=3.0
3. SdWall — annex south side, profile=[[6,-4],[11,-4]], thickness=0.2, height=3.0
</plan>
<tool_call>{"name":"SdWall","arguments":{"profile":[[11,4],[11,-4]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[6,4],[11,4]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>
<tool_call>{"name":"SdWall","arguments":{"profile":[[6,-4],[11,-4]],"thickness":0.2,"height":3.0},"metadata":{"source":"agent"}}</tool_call>

User: add a garden wall along the north boundary, 12m long and 1m tall
Assistant: Boundary/garden walls are a SINGLE linear SdWall — not a closed polygon, not a new level. Height 1m = 1.0 (metric literal; never convert to feet).
<plan>
1. SdWall — north boundary, profile=[[0,22],[12,22]], thickness=0.2, height=1.0
</plan>
<tool_call>{"name":"SdWall","arguments":{"profile":[[0,22],[12,22]],"thickness":0.2,"height":1.0},"metadata":{"source":"agent"}}</tool_call>

User: draw a 90-degree arc with center at (5,0,0) and radius 5
Assistant: Quarter-circle arc: center [5,0,0], radius 5, 0 → π/2 rad (1.5708).
<plan>
1. SdArc — center=[5,0,0], radius=5, startAngle=0, endAngle=1.5708
</plan>
<tool_call>{"name":"SdArc","arguments":{"center":[5,0,0],"radius":5,"startAngle":0,"endAngle":1.5708},"metadata":{"source":"agent"}}</tool_call>

User: draw a curve through these 5 points: (0,0), (2,3), (5,4), (8,2), (10,0)
Assistant: Catmull-Rom interpolating curve through 5 control points.
<plan>
1. SdCurve — points=[[0,0],[2,3],[5,4],[8,2],[10,0]]
</plan>
<tool_call>{"name":"SdCurve","arguments":{"points":[[0,0],[2,3],[5,4],[8,2],[10,0]]},"metadata":{"source":"agent"}}</tool_call>

User: interpolate a smooth spline through these 4 points: (0,0), (3,4), (7,3), (10,0)
Assistant: Clamped uniform NURBS cubic through 4 control points. SdSpline requires at least 4 points.
<plan>
1. SdSpline — points=[[0,0],[3,4],[7,3],[10,0]]
</plan>
<tool_call>{"name":"SdSpline","arguments":{"points":[[0,0],[3,4],[7,3],[10,0]]},"metadata":{"source":"agent"}}</tool_call>

User: loft these 3 cross-section curves into a surface
Assistant: Loft 3 polyline cross-sections from z=0 to z=10.
<plan>
1. SdLoft — curves=[bottom [[0,0,0],[5,0,0]], mid [[0,0,5],[5,0,5]], top [[0,0,10],[5,0,10]]]
</plan>
<tool_call>{"name":"SdLoft","arguments":{"curves":[{"points":[[0,0,0],[5,0,0]]},{"points":[[0,0,5],[5,0,5]]},{"points":[[0,0,10],[5,0,10]]}]},"metadata":{"source":"agent"}}</tool_call>

User: sweep this circular profile along the path curve
Assistant: Sweep a full-circle arc (radius 1) along a 3-point polyline rail.
<plan>
1. SdSweep — profile={arc: center=[0,0,0], r=1, 0→6.2832}, rail={polyline: [[0,0,0],[5,0,0],[10,0,5]]}
</plan>
<tool_call>{"name":"SdSweep","arguments":{"profile":{"kind":"arc","center":[0,0,0],"radius":1,"startAngle":0,"endAngle":6.2832},"rail":{"points":[[0,0,0],[5,0,0],[10,0,5]]}},"metadata":{"source":"agent"}}</tool_call>

User: revolve this profile around the Z-axis to make a solid of revolution
Assistant: Revolve a line [0,0,0]→[5,0,0] full 360° around Z axis → disk/cylinder solid.
<plan>
1. SdRevolve — profile={line: from=[0,0,0], to=[5,0,0]}, axisFrom=[0,0,0], axisTo=[0,0,1], 0→6.2832
</plan>
<tool_call>{"name":"SdRevolve","arguments":{"profile":{"kind":"line","from":[0,0,0],"to":[5,0,0]},"axisFrom":[0,0,0],"axisTo":[0,0,1],"angleStart":0,"angleEnd":6.2832},"metadata":{"source":"agent"}}</tool_call>

User: fill this closed curve with a surface patch
Assistant: Fill a rectangular closed loop with a flat surface patch at z=0.
<plan>
1. SdSurface — profile={points: [[0,0,0],[4,0,0],[4,3,0],[0,3,0]]} (closed loop → filled surface)
</plan>
<tool_call>{"name":"SdSurface","arguments":{"profile":{"points":[[0,0,0],[4,0,0],[4,3,0],[0,3,0]]}},"metadata":{"source":"agent"}}</tool_call>

User: place a reference plane at 3 points — origin at [0,0,0], width to [5,0,0], height to [0,0,3]
Assistant: Place a planar surface via 3-point pick: origin=[0,0,0], xAxis=[5,0,0] (width), yAxis=[0,0,3] (height).
<plan>
1. SdPlane — origin=[0,0,0], xAxis=[5,0,0], yAxis=[0,0,3] → quad planar surface
</plan>
<tool_call>{"name":"SdPlane","arguments":{"origin":[0,0,0],"xAxis":[5,0,0],"yAxis":[0,0,3]},"metadata":{"source":"agent"}}</tool_call>

User: union the two selected objects
Assistant: SdBooleanUnion — a and b are object UUIDs from the scene context "Current scene:" list.
<plan>
1. SdBooleanUnion — a=<uuid-of-first-object>, b=<uuid-of-second-object>
</plan>
<tool_call>{"name":"SdBooleanUnion","arguments":{"a":"<uuid-of-object-a>","b":"<uuid-of-object-b>"},"metadata":{"source":"agent"}}</tool_call>

User: cut a spherical hole through the box
Assistant: SdBooleanDifference — outer=box uuid, inner=sphere uuid (from scene context).
<plan>
1. SdBooleanDifference — outer=<box-uuid>, inner=<sphere-uuid>
</plan>
<tool_call>{"name":"SdBooleanDifference","arguments":{"outer":"<box-uuid>","inner":"<sphere-uuid>"},"metadata":{"source":"agent"}}</tool_call>

User: intersect these two overlapping solids
Assistant: SdBooleanIntersection — keeps only the shared volume of a and b.
<plan>
1. SdBooleanIntersection — a=<uuid-A>, b=<uuid-B>
</plan>
<tool_call>{"name":"SdBooleanIntersection","arguments":{"a":"<uuid-A>","b":"<uuid-B>"},"metadata":{"source":"agent"}}</tool_call>

User: explode that polysurface into its individual faces
Assistant: SdExplode — target UUID from scene context.
<plan>
1. SdExplode — target=<uuid-of-polysurface>
</plan>
<tool_call>{"name":"SdExplode","arguments":{"target":"<uuid-of-polysurface>"},"metadata":{"source":"agent"}}</tool_call>

User: join these two surfaces into one polysurface
Assistant: SdJoin — targets is an array of surface UUIDs from the scene context.
<plan>
1. SdJoin — targets=[<uuid-A>, <uuid-B>]
</plan>
<tool_call>{"name":"SdJoin","arguments":{"targets":["<uuid-of-surface-A>","<uuid-of-surface-B>"]},"metadata":{"source":"agent"}}</tool_call>

User: rebuild that NURBS surface with 20 control points
Assistant: SdRebuild — target UUID + count=20.
<plan>
1. SdRebuild — target=<uuid>, count=20
</plan>
<tool_call>{"name":"SdRebuild","arguments":{"target":"<uuid-of-surface>","count":20},"metadata":{"source":"agent"}}</tool_call>

User: generate contour curves at 1-metre intervals across that solid
Assistant: SdContour — target UUID, interval=1.
<plan>
1. SdContour — target=<uuid>, interval=1
</plan>
<tool_call>{"name":"SdContour","arguments":{"target":"<uuid-of-solid>","interval":1},"metadata":{"source":"agent"}}</tool_call>
`.trim();

const WEBGPU_HOUSE_FEW_SHOT = `
Examples — copy verb names EXACTLY; emit <tool_call> blocks directly (no <plan> block):

User: build a two-story residential house, 26 feet wide by 20 feet deep
Assistant: 26ft × 20ft, 2 floors × 9.0ft walls, pitched roof. Door + 4 windows on L1; interior partition at y=10; 4 windows on L2; stair at NE corner.
<tool_call>{"command":"SdLevel","parameters":{"name":"Level 1","elevation":0,"height":9.0,"extent":26}}</tool_call>
<tool_call>{"command":"SdLevel","parameters":{"name":"Level 2","elevation":9.0,"height":9.0,"extent":26}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[1,10],[12,10]],"thickness":0.33,"height":9.0}}</tool_call>
<tool_call>{"command":"SdDoor","parameters":{"position":[5,0,0],"width":3.0,"height":7.0,"sillH":0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[18,0,0],"windowType":"eg"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[26,10,0],"windowType":"eg"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[13,20,0],"windowType":"eg"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[0,10,0],"windowType":"eg"}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/1"}}</tool_call>
<tool_call>{"command":"SdSlab","parameters":{"profile":[[0,0],[26,0],[26,20],[0,20]],"thickness":0.67}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,0],[26,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,0],[26,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[26,20],[0,20]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,20],[0,0]],"thickness":0.67,"height":9.0}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[18,0,0],"windowType":"og"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[26,10,0],"windowType":"og"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[13,20,0],"windowType":"og"}}</tool_call>
<tool_call>{"command":"SdWindow","parameters":{"position":[0,10,0],"windowType":"og"}}</tool_call>
<tool_call>{"command":"SdRoof","parameters":{"roofType":"pitched","footprint":[[0,0],[26,0],[26,20],[0,20]],"pitchDeg":30}}</tool_call>
<tool_call>{"command":"setActiveLevel","parameters":{"id":"level/0"}}</tool_call>
<tool_call>{"command":"SdStair","parameters":{"start":[23,16],"end":[23,8],"type":"straight"}}</tool_call>

User: add a garden wall along the north boundary, 12m long and 1m tall
Assistant: 12m → 12.0 (metric literal; no ft→m conversion). Single linear SdWall.
<tool_call>{"command":"SdWall","parameters":{"profile":[[0,22],[12,22]],"thickness":0.2,"height":1.0}}</tool_call>

User: draw a 90-degree arc with center at (5,0,0) and radius 5
Assistant: Quarter-circle arc, 0 → π/2 rad.
<tool_call>{"command":"SdArc","parameters":{"center":[5,0,0],"radius":5,"startAngle":0,"endAngle":1.5708}}</tool_call>

User: draw a curve through these 5 points: (0,0), (2,3), (5,4), (8,2), (10,0)
Assistant: Catmull-Rom curve.
<tool_call>{"command":"SdCurve","parameters":{"points":[[0,0],[2,3],[5,4],[8,2],[10,0]]}}</tool_call>

User: interpolate a smooth spline through 4 points: (0,0), (3,4), (7,3), (10,0)
Assistant: NURBS cubic spline (≥4 points required).
<tool_call>{"command":"SdSpline","parameters":{"points":[[0,0],[3,4],[7,3],[10,0]]}}</tool_call>

User: loft 3 cross-section curves into a surface
Assistant: Loft 3 polyline sections.
<tool_call>{"command":"SdLoft","parameters":{"curves":[{"points":[[0,0,0],[5,0,0]]},{"points":[[0,0,5],[5,0,5]]},{"points":[[0,0,10],[5,0,10]]}]}}</tool_call>

User: sweep a circular profile along a path curve
Assistant: Sweep circle (r=1) along polyline rail.
<tool_call>{"command":"SdSweep","parameters":{"profile":{"kind":"arc","center":[0,0,0],"radius":1,"startAngle":0,"endAngle":6.2832},"rail":{"points":[[0,0,0],[5,0,0],[10,0,5]]}}}</tool_call>

User: revolve a line profile around the Z-axis
Assistant: Full 360° revolution around Z axis.
<tool_call>{"command":"SdRevolve","parameters":{"profile":{"kind":"line","from":[0,0,0],"to":[5,0,0]},"axisFrom":[0,0,0],"axisTo":[0,0,1],"angleStart":0,"angleEnd":6.2832}}</tool_call>

User: union the two selected objects
Assistant: SdBoolean union from scene UUIDs.
<tool_call>{"command":"SdBoolean","parameters":{"op":"union","a":"<uuid-of-object-a>","b":"<uuid-of-object-b>"}}</tool_call>
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
    'GOAL COMPLETION: when all requested elements are placed and the task is done, signal completion: <tool_call>{"name":"update_goal","arguments":{"status":"complete"},"metadata":{"source":"agent"}}</tool_call>',
    summariseSkills(skills),
    summariseClusters(),
    summariseCanvasSkills(),
  ].filter(Boolean).join("\n\n");
}

// On-device WebGPU system prompt. TRIAGE: uses WEBGPU_HOUSE_FEW_SHOT (one example,
// ~450 tok) instead of full FEW_SHOT_EXAMPLES (~1375 tok) to stay under the 2048-position
// ONNX bake limit (SafeInt overflow at safeint.h:17 confirmed 2026-05-18). Real fix: #998.
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
    "UNITS: prompt-stated units are authoritative. '12m' → 12.0 always — never apply ft→m conversion when the prompt specifies 'm'. '12ft' → 3.66. Prompt unit overrides active unit system.",
    "BUILDINGS: For houses/buildings use SdLevel+SdWall+SdSlab+SdRoof+SdWindow+SdDoor+SdStair. Never use SdBox for a building — SdBox is raw geometry only.",
    "SCENE QUERY RESPONSE: when asked to describe the scene, what you see, what is in the scene, or what the default scene looks like — respond with PLAIN TEXT ONLY. Do NOT emit <plan> or <tool_call> blocks. Describe what you see: shapes, materials, arrangement. One natural prose paragraph.",
    'GOAL COMPLETION: when all requested elements are placed and the task is done, signal completion: <tool_call>{"name":"update_goal","arguments":{"status":"complete"},"metadata":{"source":"agent"}}</tool_call>',
    WEBGPU_HOUSE_FEW_SHOT,
    verbList,
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
    (window as unknown as { __agentRawOutputs: _RawOutputEntry[] }).__agentRawOutputs.push({ turnId: ++_rawOutIdx, ts: new Date().toISOString(), raw: content.slice(0, 102400) }); // §#1659 AC5: 100KB cap
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
  (window as unknown as { __agentRawOutputs: _RawOutputEntry[] }).__agentRawOutputs.push({ turnId: ++_rawOutIdx, ts: new Date().toISOString(), raw: content.slice(0, 102400) }); // §#1659 AC5
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
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel} · ⟳`);

  const stream = sb.generate({ messages, maxNewTokens: req.maxNewTokens ?? 1024 });
  // Drain the token stream (satisfies AC: tokens stream back via postMessage inside worker)
  for await (const _tok of stream) { /* tokens flow via postMessage internally */ }

  const { text: responseText, tokensOut } = await stream.resultPromise;
  const decodeMs = Date.now() - t0;
  const tgTps = decodeMs > 0 ? tokensOut / (decodeMs / 1000) : 0;
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel} · ${tgTps.toFixed(0)} t/s`);

  let plan: string | undefined;
  const afterPlan = responseText.replace(/<plan>([\s\S]*?)<\/plan>/i, (_, inner: string) => {
    plan = inner.trim();
    return "";
  });
  (window as unknown as { __agentRawOutputs: _RawOutputEntry[] }).__agentRawOutputs.push({ turnId: ++_rawOutIdx, ts: new Date().toISOString(), raw: responseText.slice(0, 102400) }); // §#1659 AC5
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
    max_tokens:  req.maxNewTokens ?? 1024,
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

  (window as unknown as { __agentRawOutputs: _RawOutputEntry[] }).__agentRawOutputs.push({ turnId: ++_rawOutIdx, ts: new Date().toISOString(), raw: content.slice(0, 102400) }); // §#1659 AC5
  const { dispatches, text } = parseDispatches(content);
  return { dispatches, text: text || content, raw: json };
}

// ---- Public entry point --------------------------------------------------

export async function runAgentTurn(req: AgentRequest): Promise<AgentResponse> {
  // P10-2: if a prior worker error engaged the session-level fallback, route remote.
  if (REMOTE_URL && _arc.webgpuFallbackEngaged) return runRemoteAgentTurn(req);
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
  if (_arc.modelLoadError) {
    // §C-error-wording (#1369): only blame WebGPU when the error text actually implicates it.
    // modelLoadError is set on ANY fatal worker error (fetch 401, ONNX session, etc.) — the
    // blanket "WebGPU not supported" wording was wrong for non-adapter failures.
    const _isWebGpuError = /WebGPU|adapter|GPUDevice|requestAdapter/i.test(_arc.modelLoadError);
    throw new Error(
      _isWebGpuError
        ? `Model failed to load — WebGPU may not be supported on this device. Try Chrome 115+ on a desktop with a dedicated GPU. (${_arc.modelLoadError})`
        : `Model failed to load — ${_arc.modelLoadError}. Try refreshing or check the browser console for details.`
    );
  }
  // §#1666-NEVER: !bootComplete guard removed — structurally unreachable post-boot.
  // _recyclePending class-field in chat-panel.ts blocks chip/send during recycle window;
  // boot-complete handler is sole authority to clear. See PR #1673.

  // ── On-device path via Web Worker (#936) ─────────────────────────────────
  // Worker owns: from_pretrained, WebGPU probe, warmup, drafter load, tokenization,
  // generate, decode. Main thread never blocks during model load or inference.
  await recycleModelWorkerIfNeeded(); // #1303: release ONNX WebGPU buffer pool every N turns
  // §#1506: planned recycle sets state→recovering and bootComplete=false. The new worker
  // loads async; dispatching GENERATE_REQUESTED before boot-complete reaches a null _model
  // in the worker → "model not loaded". Spawn early and gate here until the worker is ready.
  if (_arc.state === "recovering") {
    initWorkerIfNeeded(); // start model load now so it runs in parallel with this await
    await new Promise<void>((resolve, reject) => {
      let onBoot: EventListener, onFatal: EventListener;
      onBoot = () => { window.removeEventListener("agentmodel:fatal", onFatal); resolve(); };
      onFatal = () => { window.removeEventListener("agentmodel:boot-complete", onBoot); reject(new Error("GPU fatal during model recycle")); };
      window.addEventListener("agentmodel:boot-complete", onBoot, { once: true });
      window.addEventListener("agentmodel:fatal", onFatal, { once: true });
    });
  }
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
  const _historyIn = req.history ?? [];
  let trimmedHistory = _historyIn.slice(-MAX_HISTORY_MSGS);
  // Char-based safety trim: ~40K chars ≈ 10K tokens, leaves 6K headroom for sys+image+prompt
  // within the 16384-token WEBGPU_CONTEXT_LIMIT. Drop oldest user+assistant pairs together.
  // §#1505: never trim below the last 2 messages (most recent user+assistant pair).
  // After a scene-VRAM recycle, the model needs at least the prior assistant turn so it
  // knows what was built and can continue adding geometry rather than outputting NL-only.
  const HISTORY_CHAR_BUDGET = 40_000;
  const HISTORY_MIN_TAIL = 2; // always preserve last user+assistant pair
  {
    let histChars = trimmedHistory.reduce(
      (s, m) => s + (typeof m.content === "string" ? m.content.length : 0),
      0,
    );
    while (histChars > HISTORY_CHAR_BUDGET && trimmedHistory.length > HISTORY_MIN_TAIL) {
      histChars -= (typeof trimmedHistory[0].content === "string" ? trimmedHistory[0].content.length : 0)
                + (typeof trimmedHistory[1].content === "string" ? trimmedHistory[1].content.length : 0);
      trimmedHistory = trimmedHistory.slice(2);
    }
  }
  // §C-budget (#1439): notify UI when harness-level compaction actually drops turns.
  if (trimmedHistory.length < _historyIn.length) {
    window.dispatchEvent(new CustomEvent("agentmodel:compact", {
      detail: { preTurns: _historyIn.length, postTurns: trimmedHistory.length },
    }));
  }
  const _sysPrompt = buildWebGPUSystemPrompt(req.skills);
  const messages = [
    { role: "system" as const, content: _sysPrompt },
    ...trimmedHistory,
    { role: "user" as const, content: req.prompt },
  ];

  // §#1860 Sub-5: activation gates for self-speculative decoding.
  // Estimate input tokens at ~4 chars/token (conservative pre-turn estimate).
  const _estimatedInputTokens = Math.round(
    messages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : 0), 0) / 4,
  );
  const _selfSpecState: SelfSpecRuntimeState = {
    backendPath:     "webgpu",   // harness is only reached on the WebGPU path
    modelReady:      _arc.workerReady,
    prefillComplete: _arc.prefillDone,
    inputLength:     _estimatedInputTokens,
    contextLimit:    16384,
    verifyBeta:      1.0,        // Sub-5 default; full measurement in follow-up (#1865 AC)
    deviceLost:      _arc.webgpuFallbackEngaged,
    recycleCount:    _arc.recycleCount,
    highEntropyMode: false,      // greedy by default; temperature gate in follow-up
  };
  const _selfSpecDecision = selfSpecController.shouldActivate(_selfSpecState);
  const useMtp = !_MTP_OFF && _selfSpecDecision.active;
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  // §P0-ARC: advance state machine; increments turnCount (used by recycle threshold).
  // Valid from "ready" or "recovering" (post-planned-recycle first turn).
  _arc.dispatch({ type: "GENERATE_REQUESTED", turnId });
  // §C-turn-start (#1371): observable marker so Phase J harness can confirm runAgentTurn fired.
  window.dispatchEvent(new CustomEvent("agent:turn-start", { detail: { turnId } }));

  let result: WorkerGenResult;
  try {
    result = await new Promise<WorkerGenResult>((resolve, reject) => {
      // §B-watchdog (#1313): force-terminate if no token output for 60s. Bounds D3D12
      // silent-hang failure to 60s. Device is destroyed before terminate to release buffers.
      // §#1472: watchdog now resets on each generate-progress heartbeat (every 50 tokens)
      // via _activeWatchdogReset — fires only on true stall (no tokens for 60s), not on
      // long responses. Root cause of +60s bufMgr OOM: watchdog was firing mid-generation
      // because "Design a house" generates 600+ tokens (120s at 5 tps) > 60s deadline.
      const _WATCHDOG_MS = 60_000;
      const _runWatchdog = () => {
        _watchdogTimer = null;
        _activeWatchdogReset = null;
        _generateCallbacks.delete(turnId);
        const _stalled = _inferenceWorker;
        _inferenceWorker = null;
        // §P0-ARC: WATCHDOG_TIMEOUT resets lifecycle flags and increments recycleCount.
        _arc.dispatch({ type: "WATCHDOG_TIMEOUT", turnId }); // → recycling
        _arc.dispatch({ type: "WORKER_RECYCLED", recycleCount: _arc.recycleCount, reason: "generate-stall-watchdog" }); // → recovering
        (window as unknown as Record<string, unknown>).__model_worker_recycle_count = _arc.recycleCount;
        window.dispatchEvent(new CustomEvent("agentmodel:worker-recycled", {
          detail: { recycleCount: _arc.recycleCount, reason: "generate-stall-watchdog" },
        }));
        updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel} · ⟳`);
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
        console.warn("[agent-harness] worker-stall: no token output for 60s, worker recycled");
        reject(new Error("Response timed out — the model is reloading. The input will re-enable when it's ready."));
      };
      let _watchdogTimer: ReturnType<typeof setTimeout> | null = setTimeout(_runWatchdog, _WATCHDOG_MS);
      // §#1472: register module-level reset fn so generate-progress handler can reset timer.
      _activeWatchdogReset = () => {
        if (_watchdogTimer) {
          clearTimeout(_watchdogTimer);
          _watchdogTimer = setTimeout(_runWatchdog, _WATCHDOG_MS);
        }
      };

      _generateCallbacks.set(turnId, {
        resolve: (r) => { _activeWatchdogReset = null; if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; } resolve(r); },
        reject:  (e) => { _activeWatchdogReset = null; if (_watchdogTimer) { clearTimeout(_watchdogTimer); _watchdogTimer = null; } reject(e); },
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
        maxNewTokens:  req.maxNewTokens ?? 1024,
        eosId:         1, // Gemma 4 EOS; worker also reads model.config as fallback
        draftK:        MTP_DRAFT_N,
        useMtp,
      });
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    if (msg.includes("input too long") && REMOTE_URL) return runRemoteAgentTurn(req);
    if (_arc.webgpuFallbackEngaged && REMOTE_URL) return runRemoteAgentTurn(req);
    throw err;
  }

  const { text: responseText, specAttempts, specAccepts, prefillMs, decodeMs, inputLength, tokensOut } = result;
  const _mtpActive = useMtp && specAttempts > 0;
  const tgTps = decodeMs > 0 ? tokensOut / (decodeMs / 1000) : 0;
  const ppTps = prefillMs > 0 ? inputLength / (prefillMs / 1000) : 0;
  const _specAcceptRate = specAttempts > 0 ? specAccepts / specAttempts : 0;
  // §#1860 Sub-5: self-spec telemetry fields.
  // accepted_tokens = specAccepts (verifier-accepted; replacements excluded).
  // effective_tps uses tokensOut as emitted count (conservative; same as tgTps numerator).
  const _effectiveTps = tgTps; // identical to tgTps until drafter+verifier fully wired
  const _speedupObserved = BASELINE_TPS_P50 > 0 ? _effectiveTps / BASELINE_TPS_P50 : undefined;
  const _selfSpecAcceptRate = specAttempts > 0 ? specAccepts / specAttempts : 0;
  // Update controller rolling window — use 0 if MTP was not active this turn.
  selfSpecController.recordTurn(_mtpActive ? _selfSpecAcceptRate : 0);
  console.debug(`[agent] prefill=${Math.round(prefillMs)}ms decode=${Math.round(decodeMs)}ms in=${inputLength} out=${tokensOut} tg=${tgTps.toFixed(1)}t/s mtp=${_mtpActive} self_spec=${_selfSpecDecision.active}(${_selfSpecDecision.reason})`);
  _arc.dispatch({ type: "GENERATE_DONE", turnId }); // §P0-ARC: state → ready
  const _mtpSuffix = _mtpActive ? " · MTP" : "";
  updateBadge(`<span class="v">G</span>EMMA·4·${MODEL_LABEL}  ·  LIVE · ${_arc.deviceLabel} · ${tgTps.toFixed(0)} t/s${_mtpSuffix}`);
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
    // §#1860 Sub-5
    self_spec_active:  _selfSpecDecision.active,
    self_spec_reason:  _selfSpecDecision.reason,
    draft_tokens:      specAttempts,
    accepted_tokens:   specAccepts,
    acceptance_rate:   _selfSpecAcceptRate,
    verify_beta:       _selfSpecState.verifyBeta,
    effective_tps:     _effectiveTps,
    speedup_observed:  _speedupObserved,
  });

  let plan: string | undefined;
  const afterPlan = responseText.replace(/<plan>([\s\S]*?)<\/plan>/i, (_, inner: string) => {
    plan = inner.trim();
    return "";
  });

  (window as unknown as { __agentRawOutputs: _RawOutputEntry[] }).__agentRawOutputs.push({ turnId: ++_rawOutIdx, ts: new Date().toISOString(), raw: responseText.slice(0, 102400) }); // §#1659 AC5
  const { dispatches, text } = parseDispatches(afterPlan);
  emitDispatchTurn(dispatches.length, prefillMs + decodeMs); // §#1628: 10% sample
  return { dispatches, text: text.trim() || responseText, plan, raw: undefined };
}

// ── Multi-instance factory (#1122) ────────────────────────────────────────────
// Bound to runAgentTurn so all instances share the single loaded model worker.
// N=2 VRAM delta ≈ 0 — only CPU-RAM history arrays are added per instance.
export const createAgentInstance = makeAgentInstanceFactory(runAgentTurn);
