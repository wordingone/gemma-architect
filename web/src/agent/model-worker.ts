/// <reference lib="webworker" />
// model-worker.ts — Web Worker for on-device model load + inference (#936).
// Runs in a dedicated thread so from_pretrained() + model.generate() never block
// the main thread (tab-wedge fix for demo-blocker issue #936).
//
// Protocol (main → worker):
//   {type:"init", modelId, drafterUrl, drafterCacheKey}
//   {type:"generate", turnId, messages, imageUrl?, videoUrls?, maxNewTokens, eosId, draftK, useMtp}
//   {type:"abort", turnId}
//
// Protocol (worker → main):
//   {type:"returning-user"}                  // cached weights detected before download
//   {type:"manifest",    totalBytesExpected}  // total expected bytes across all files
//   {type:"progress",    phase, file, bytes, total, throughputBytesPerSec, progress?}
//   {type:"model-ready", device}
//   {type:"warmup-done"}
//   {type:"drafter-ready"}
//   {type:"drafter-error", error}
//   {type:"boot-complete"}                    // model-ready + warmup-done + drafter done
//   {type:"ready",       device}
//   {type:"generate-done", turnId, text, specAttempts, specAccepts,
//                          prefillMs, decodeMs, inputLength, tokensOut}
//   {type:"generate-error", turnId, error}
//   {type:"error",       error}

import { Gemma4ForConditionalGeneration, AutoProcessor, RawImage, env as tfEnv } from "@huggingface/transformers";
import { getMtpSessions, runMtpSpecDecode, MTP_CONFIG_E4B } from "./webgpu-mtp-backend.js";
import { fetchDrafterCached } from "./drafter-cache.js";
// §C-ort-static (#1375): static import bundles ORT directly into the worker chunk.
// Dynamic `await import("onnxruntime-web")` caused vite to emit a separate
// hash-stamped ort.bundle.min-*.js that could 404 on Pages when deployment
// hashes drifted between builds. Static import eliminates the separate chunk.
import * as ort from "onnxruntime-web";

// ── Worker state ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _model: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _processor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _drafterSession: any = null;
// §#1410: true when model weights weren't in Cache API at boot time (cold download).
// Cold-cache paths have more pending GPU work after load → larger race window.
let _coldCacheBoot = false;

const WEBGPU_CONTEXT_LIMIT = 16384;

// MTP verification gate (#679).  True = real greedy token comparison is wired
// in webgpu-mtp-backend.ts (runMtpSpecDecode compares argmax(target) vs draftToken).
// Set false here to keep spec-decode dormant even if drafter loads successfully.
// Flip to false if verification is ever reverted to the "accept-all" placeholder.
const MTP_VERIFICATION_WIRED = true;

// Boot-completion tracking — boot-complete fires when all three phases done.
let _bootModelReady = false;
let _bootWarmupDone = false;
let _bootDrafterDone = false; // true when drafter-ready OR drafter-error OR no drafterUrl

// Throughput tracking for progress events.
let _progressLastBytes = 0;
let _progressLastTs = 0;

function calcThroughput(cumulativeBytes: number): number {
  const now = Date.now();
  const dtMs = now - _progressLastTs;
  const db = cumulativeBytes - _progressLastBytes;
  _progressLastBytes = cumulativeBytes;
  _progressLastTs = now;
  if (dtMs < 50 || db <= 0) return 0;
  return Math.round(db / (dtMs / 1000));
}

function post(msg: Record<string, unknown>): void {
  (self as unknown as Worker).postMessage(msg);
}

function checkBootComplete(): void {
  if (_bootModelReady && _bootWarmupDone && _bootDrafterDone) {
    post({ type: "boot-complete" });
  }
}

// Check if model weights are already in Cache API — indicates a returning user.
// transformers.js stores downloaded files in Cache Storage keyed to their CDN URLs.
async function checkReturningUser(modelId: string): Promise<boolean> {
  try {
    if (!("caches" in globalThis)) return false;
    const names = await (globalThis as unknown as { caches: CacheStorage }).caches.keys();
    for (const name of names) {
      const cache = await (globalThis as unknown as { caches: CacheStorage }).caches.open(name);
      const keys = await cache.keys();
      if (keys.some((req) => req.url.includes(modelId))) return true;
    }
  } catch { /* Cache API unavailable (private mode / quota) */ }
  return false;
}

// ── Message router ────────────────────────────────────────────────────────────
self.onmessage = async (ev: MessageEvent<Record<string, unknown>>) => {
  const { type, ...data } = ev.data;
  try {
    if (type === "init")             await handleInit(data);
    else if (type === "generate")    await handleGenerate(data);
    else if (type === "shutdown")    await handleShutdown();
    else if (type === "destroy-device") handleDestroyDevice();
    // "abort" is handled via the AbortController in handleGenerate (future work)
  } catch (e) {
    post({ type: "error", error: (e as Error).message });
  }
};

// ── Init: from_pretrained + warmup probe + drafter ───────────────────────────
async function handleInit(data: Record<string, unknown>): Promise<void> {
  // §A-init (#990): dispose prior ORT sessions on re-init (model swap) — prevents VRAM leak.
  if (_drafterSession) {
    try { await (_drafterSession as any).release?.(); } catch { /* non-fatal */ }
    _drafterSession = null;
  }
  if (_model) {
    try { await (_model as any).dispose?.(); } catch { /* non-fatal */ }
    _model = null;
  }
  _processor = null;

  const modelId = data.modelId as string;
  const drafterUrl = data.drafterUrl as string;
  const drafterCacheKey = data.drafterCacheKey as string;
  // noWarmup: set by recycle path. GPU device+compiled shaders persist across worker
  // terminate/recreate; skip sanity probe and warmup to avoid ~120s re-compilation.
  const noWarmup = (data.noWarmup as boolean | undefined) === true;
  // §C-warmup-context (#1362): representative system prompt passed from main thread.
  // Used to exercise ~1000-token KV cache allocations during the warmup probe so the
  // GPU buffer pools are pre-sized before the first real inference call.
  const warmupPrompt = (data.warmupPrompt as string | undefined) ?? "";

  // Returning-user detection: if model files are already in Cache API, skip the
  // loading screen and show a fast-path pulse instead.
  const isReturning = await checkReturningUser(modelId);
  _coldCacheBoot = !isReturning; // §#1410: track cold-cache state for retry backoff + post-drafter probe
  if (isReturning) {
    post({ type: "returning-user" });
  }

  // Emit manifest with estimated total bytes so the overlay can show aggregate %.
  // E4B: model ONNX q4f16 ≈ 2.5 GB + drafter ≈ 158 MB + tokenizer files ≈ 5 MB.
  const ESTIMATED_MODEL_BYTES = 2_700_000_000;
  post({ type: "manifest", totalBytesExpected: ESTIMATED_MODEL_BYTES });

  // Cumulative bytes downloaded (all model files combined) for aggregate throughput.
  // Track per-file to correctly accumulate across shard boundaries — `info.loaded`
  // resets to 0 for each new file, so Math.max() was wrong (#1365).
  const _fileBytes = new Map<string, number>();
  let _cumulativeBytes = 0;

  const progressCb = (info: Record<string, unknown>) => {
    if (info.status === "downloading") {
      const bytes = (info.loaded as number | undefined) ?? 0;
      const total = (info.total as number | undefined) ?? 0;
      const name = (info.name as string | undefined) ?? "";
      const prev = _fileBytes.get(name) ?? 0;
      _fileBytes.set(name, bytes);
      _cumulativeBytes += bytes - prev;
      const throughputBytesPerSec = calcThroughput(_cumulativeBytes);
      post({
        type: "progress",
        phase: "model",
        progress: (info.progress as number | undefined) ?? 0,
        file: ((info.name as string | undefined) ?? "").split("/").pop() ?? "",
        bytes,
        total,
        throughputBytesPerSec,
      });
    } else if (info.status === "initiate") {
      // §A-shard-boundary (#1216): "initiate" fires when a new shard fetch starts,
      // before first bytes arrive. Without this, the 30s stall watchdog fires
      // during the CDN inter-shard gap, producing variable STALLED screen counts.
      post({
        type: "progress",
        phase: "model",
        progress: 0,
        file: ((info.name as string | undefined) ?? "").split("/").pop() ?? "",
        bytes: 0,
        total: 0,
        throughputBytesPerSec: 0,
      });
    } else if (info.status === "loading") {
      post({ type: "progress", phase: "model-init", bytes: 0, total: 0, throughputBytesPerSec: 0 });
    }
  };

  const backends: Array<{ device: "webgpu" | "auto"; dtype: "q4f16" | "q4"; label: string }> = [
    { device: "webgpu", dtype: "q4f16", label: "GPU" },
    { device: "auto",   dtype: "q4",    label: "CPU" },
  ];

  let loadedLabel = "CPU";

  for (const { device, dtype, label } of backends) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let model: Awaited<ReturnType<typeof Gemma4ForConditionalGeneration.from_pretrained>>;
      try {
        model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
          dtype, device, progress_callback: progressCb,
        });
      } catch (loadErr) {
        // §B-cache-retry (#1316): Cache.put() failure on fresh chromium profiles causes
        // Cache API to drop model shards silently, making ORT unable to find external data.
        // Retry once with browser cache disabled — forces direct fetch, bypassing Cache API.
        const isExternalDataErr = /Failed to load external data file|Can't create a session|Deserialize tensor/i
          .test((loadErr as Error).message ?? "");
        if (!isExternalDataErr) throw loadErr;
        tfEnv.useBrowserCache = false;
        await new Promise<void>(r => setTimeout(r, 500));
        model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
          dtype, device, progress_callback: progressCb,
        });
      }
      const processor = await AutoProcessor.from_pretrained(modelId);

      // WebGPU sanity probe — same as main-thread path (#128/#133).
      // Skipped on recycle (noWarmup): GPU device is persistent, shaders already compiled.
      if (device === "webgpu" && !noWarmup) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const proc = processor as any;
          // Short probe: verify WebGPU backend can run at all. Real inference at ~1300 tok
          // (trimmed system prompt #1194) stays under SafeInt overflow threshold.
          const probeText = proc.tokenizer.apply_chat_template(
            [{ role: "user", content: "test" }],
            { tokenize: false, add_generation_prompt: true },
          ) as string;
          const probeIn = await proc(probeText);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (model as any).generate({ ...probeIn, max_new_tokens: 1 });
        } catch {
          continue; // WebGPU probe failed → try CPU
        }
      }

      _model = model;
      _processor = processor;
      loadedLabel = label;
      break;
    } catch (e) {
      if (device === "webgpu") continue;
      post({ type: "error", error: (e as Error).message });
      return;
    }
  }

  if (!_model) {
    post({ type: "error", error: "No backend available for model load." });
    return;
  }

  _bootModelReady = true;
  post({ type: "model-ready", device: loadedLabel });
  checkBootComplete();

  // Warmup probe — warms GPU shader pipeline; non-fatal if it fails.
  // Skipped on recycle (noWarmup): compiled pipelines persist in GPU driver cache.
  if (!noWarmup) {
    try {
      post({ type: "progress", phase: "warmup", bytes: 0, total: 0, throughputBytesPerSec: 0 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = _processor as any;
      // §C-warmup-context (#1362): include system prompt so the probe exercises the same
      // KV cache buffer sizes as real inference (~1300 tokens). Without this, the probe
      // uses ~6 tokens and leaves GPU buffers undersized, causing ORT buffer_manager.cc:553
      // to crash (ERROR_CODE=1) on the first full-length inference call.
      //
      // §C-warmup-decode (#1362-B): generate 8 tokens (not 1) to exercise the GPU→CPU
      // readback path (BufferManager::Download) across multiple decode steps. The cold-cache
      // Schultz crash fires during multi-step decode — a 1-step warmup leaves the
      // wgpuBufferMapAsync→unmap pipeline untested, letting the race condition manifest on
      // the first real inference. 8 steps add ~1.5s to warmup and pre-allocate the decode
      // buffer pool to steady-state before the user submits any prompt.
      const warmupMessages: Array<{ role: string; content: string }> = warmupPrompt
        ? [{ role: "system", content: warmupPrompt }, { role: "user", content: "." }]
        : [{ role: "user", content: "." }];
      const chatText = proc.apply_chat_template(
        warmupMessages,
        { add_generation_prompt: true, tokenize: false },
      ) as string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inputs: any = await proc(chatText, null);
      const tokCount: number = inputs.input_ids?.dims?.[1] ?? 0;
      if (tokCount < WEBGPU_CONTEXT_LIMIT - 64) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (_model as any).generate({ ...inputs, max_new_tokens: 8, do_sample: false });
      }
    } catch (e) {
      console.warn("[model-worker] warmup probe failed:", (e as Error).message ?? e);
    }
  }

  _bootWarmupDone = true;
  post({ type: "warmup-done", skipped: noWarmup }); // #1313: skipped=true when noWarmup (recycle path)
  checkBootComplete();

  // Drafter load — fire after warmup; drafter-error is non-fatal (standard path covers)
  if (drafterUrl) {
    try {
      post({ type: "progress", phase: "drafter", progress: 0, bytes: 0, total: 0, throughputBytesPerSec: 0 });
      let _drafterLastBytes = 0;
      let _drafterLastTs = Date.now();
      const drafterBuf = await fetchDrafterCached(drafterUrl, drafterCacheKey, (loaded, total) => {
        const now = Date.now();
        const dtMs = now - _drafterLastTs;
        const throughputBytesPerSec = dtMs >= 50 ? Math.round((loaded - _drafterLastBytes) / (dtMs / 1000)) : 0;
        _drafterLastBytes = loaded;
        _drafterLastTs = now;
        post({
          type: "progress",
          phase: "drafter",
          progress: total > 0 ? (loaded / total) * 100 : -1,
          bytes: loaded,
          total,
          throughputBytesPerSec,
        });
      });
      _drafterSession = await ort.InferenceSession.create(drafterBuf, {
        executionProviders: ["webgpu", "wasm"],
        preferredOutputLocation: { logits: "cpu", proj_state: "cpu" },
      });
      _bootDrafterDone = true;
      post({ type: "drafter-ready" });
    } catch (e) {
      _bootDrafterDone = true;
      post({ type: "drafter-error", error: (e as Error).message?.slice(0, 120) });
    }
  } else {
    // No drafter URL — drafter phase is skipped.
    _bootDrafterDone = true;
  }

  // §C-post-drafter-probe (#1410): The main warmup probe runs before the drafter
  // ORT session initializes its WebGPU context. ORT's WebGPU pipeline compilation
  // queues GPU commands that can interfere with the buffer Download path, causing
  // wgpuBufferMapAsync to fire BEFORE the buffer is ready. Run one generate step
  // after drafter init to flush the GPU command queue into steady state before
  // the first real inference. Only needed on cold-cache boot — warm-cache skips
  // the drafter WebGPU init path (ORT session is restored from OPFS cache).
  if (!noWarmup && _coldCacheBoot && _model && _processor) {
    try {
      const proc = _processor as any;
      const _syncText = proc.apply_chat_template(
        [{ role: "user", content: "." }],
        { add_generation_prompt: true, tokenize: false },
      ) as string;
      const _syncIn = await proc(_syncText, null);
      if ((_syncIn.input_ids?.dims?.[1] ?? 0) < WEBGPU_CONTEXT_LIMIT - 64) {
        // §#1416: Promise.race with 30s timeout — generate() can hang indefinitely on
        // cold-cache if drafter ORT WebGPU shader compilation still holds the GPU queue.
        // The probe is best-effort; timeout ensures checkBootComplete() always runs.
        await Promise.race([
          (_model as any).generate({ ..._syncIn, max_new_tokens: 1, do_sample: false }),
          new Promise<void>(r => setTimeout(r, 30_000)),
        ]);
      }
    } catch { /* non-fatal — flush is best-effort */ }
  }

  checkBootComplete();
  post({ type: "ready", device: loadedLabel });
}

// ── Shutdown: release ORT sessions when worker is terminated ─────────────────
// §B-device-destroy (#1313): destroy the underlying WebGPU GPUDevice so D3D12 buffer
// pressure is fully released before the worker is terminated. Non-fatal — always posts
// device-destroyed so the main thread can proceed without waiting indefinitely.
//
// §C-destroy-null-ref (#1381-L1): after destroy(), null out the tfEnv device reference
// so ORT cannot reuse the destroyed handle on the next load path.
// NOTE: Lead 2 (await device.lost) was reverted — it caused a NEW failure class
// ("operation does not support unaligned accesses" + Aborted()) by leaving the WebGPU
// buffer pool partially-released before the null assignment, producing misaligned offsets
// on the next Worker's WASM imports. Synchronous destroy + immediate null is the correct shape.
function handleDestroyDevice(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backends = (tfEnv.backends as any);
    const device = backends?.onnx?.webgpu?.device as
      | { destroy?: () => void }
      | undefined;
    if (device && typeof device.destroy === "function") device.destroy();
    // L1: null the reference so ORT cannot resolve it on next load
    if (backends?.onnx?.webgpu) backends.onnx.webgpu.device = null;
  } catch { /* non-fatal — best-effort cleanup */ }
  post({ type: "device-destroyed" });
}

// §A-shutdown (#990): called via {type:"shutdown"} message before terminateWorker().
// Releases _drafterSession (ORT InferenceSession) and disposes _model (transformers.js).
// Non-fatal on any release error — worker still posts shutdown-complete.
async function handleShutdown(): Promise<void> {
  if (_drafterSession) {
    try { await (_drafterSession as any).release?.(); } catch { /* non-fatal */ }
    _drafterSession = null;
  }
  if (_model) {
    try { await (_model as any).dispose?.(); } catch { /* non-fatal */ }
    _model = null;
  }
  _processor = null;
  post({ type: "shutdown-complete" });
}

// ── Generate: apply_chat_template + tokenize + (MTP or standard) + decode ────
async function handleGenerate(data: Record<string, unknown>): Promise<void> {
  if (!_model || !_processor) {
    post({ type: "generate-error", turnId: data.turnId, error: "model not loaded" });
    return;
  }

  const turnId      = data.turnId as string;
  const messages    = data.messages as Array<{ role: string; content: string }>;
  const imageUrl    = data.imageUrl as string | undefined;
  const videoUrls   = data.videoUrls as string[] | undefined; // §#693 video content blocks
  const maxNewTokens = data.maxNewTokens as number;
  const eosId       = data.eosId as number;
  const draftK      = data.draftK as number;
  const useMtp      = data.useMtp as boolean;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = _processor as any;
  const t0 = performance.now();

  // Image: load from URL if provided
  let imageList: unknown[] = [];
  if (imageUrl) {
    try { imageList = [await RawImage.fromURL(imageUrl)]; } catch { /* skip on failure */ }
  }

  // §#693 Video: load each frame URL as RawImage[] for the video content block.
  // Gemma 4 processor accepts: proc(chatText, images=null, videos=[[frame, ...]])
  let videoFrames: unknown[] = [];
  if (videoUrls && videoUrls.length > 0) {
    for (const url of videoUrls) {
      try { videoFrames.push(await RawImage.fromURL(url)); } catch { /* skip bad frame */ }
    }
  }
  const hasVideo = videoFrames.length > 0;

  // Format messages into a single string via apply_chat_template
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messagesForTemplate: any[] = messages;
  if (hasVideo) {
    // Video content block: { type: "video", video: RawImage[] } in last user message.
    const lastUser = [...messages];
    let ui = -1;
    for (let i = lastUser.length - 1; i >= 0; i--) {
      if (lastUser[i].role === "user") { ui = i; break; }
    }
    if (ui >= 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastUser[ui] = { role: "user", content: [{ type: "video", video: videoFrames }, { type: "text", text: lastUser[ui].content }] as any };
      messagesForTemplate = lastUser;
    }
  } else if (imageUrl && imageList.length > 0) {
    // Splice image into the last user message as a multimodal content array
    const lastUser = [...messages];
    let ui = -1;
    for (let i = lastUser.length - 1; i >= 0; i--) {
      if (lastUser[i].role === "user") { ui = i; break; }
    }
    if (ui >= 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lastUser[ui] = { role: "user", content: [{ type: "image", image: imageList[0] }, { type: "text", text: lastUser[ui].content }] as any };
      messagesForTemplate = lastUser;
    }
  }
  const chatText = proc.apply_chat_template(messagesForTemplate, {
    add_generation_prompt: true,
    tokenize: false,
    enable_thinking: false, // #1044: skip <|think|> → all output budget for <tool_call> blocks
  }) as string;

  // Tokenize (pass image/video lists separately for processor's vision encoder).
  // Video: proc(chatText, images=null, videos=[[frame, ...]]) per transformers.js v4 API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any = hasVideo
    ? await proc(chatText, null, [videoFrames])
    : await proc(chatText, imageList.length > 0 ? imageList : null);
  const tProc = performance.now();
  const inputLength: number = inputs.input_ids?.dims?.[1] ?? 0;

  const safeMaxNewTokens = Math.min(maxNewTokens, WEBGPU_CONTEXT_LIMIT - inputLength);
  if (safeMaxNewTokens <= 0) {
    post({ type: "generate-error", turnId, error: `input too long: ${inputLength} tokens` });
    return;
  }
  // Warn when context saturation severely reduces output budget — produces empty plans with no error.
  if (safeMaxNewTokens < maxNewTokens / 2) {
    post({
      type: "generate-warning",
      turnId,
      message: `context saturated: prompt ${inputLength} tok, budget clamped ${maxNewTokens}→${safeMaxNewTokens} tok (limit ${WEBGPU_CONTEXT_LIMIT})`,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outputs: any;
  let specAttempts = 0;
  let specAccepts  = 0;

  // MTP spec-decode — disabled for long prompts: drafter produces degenerate output
  // (NaN verifier logits) on large inputs due to drafter KV window mismatch (#979).
  // Threshold 900: conservative safe zone; two-story-house prompt is ~997 tok.
  // WEBGPU_CONTEXT_LIMIT is now 16384 — this threshold is about drafter quality, not ceiling.
  if (useMtp && _drafterSession && MTP_VERIFICATION_WIRED && inputLength < 900) {
    try {
      const mtpSessions = getMtpSessions(_model);
      if (mtpSessions) {
        const inputIdsTensor = inputs.input_ids as { data: BigInt64Array; dims: number[] };
        const result = await runMtpSpecDecode(
          mtpSessions, _drafterSession, ort,
          inputIdsTensor.data, safeMaxNewTokens, draftK, eosId, MTP_CONFIG_E4B,
        );
        specAttempts = result.specAttempts;
        specAccepts  = result.specAccepts;
        const allNums = [...Array.from(inputIdsTensor.data, Number), ...result.tokens];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const makeTensor = (nums: number[]): any => ({
          data: new BigInt64Array(nums.map(BigInt)),
          dims: [1, nums.length],
          tolist: () => [nums.slice()],
          slice: (_ax: null, range: [number, null | undefined]) => makeTensor(nums.slice(range[0])),
        });
        outputs = makeTensor(allNums);
      }
    } catch (e) {
      console.warn("[model-worker] MTP error, standard fallback:", (e as Error).message);
      specAttempts = 0;
      specAccepts  = 0;
      outputs = undefined;
    }
  }

  // Standard generate fallback
  if (!outputs) {
    // Progress streamer — skip the initial prompt put, then post every 50 tokens generated.
    // Keeps the UI alive during long plans (two-story house ≈ 800 tokens @ 5-10 t/s = 80-160s).
    let _initPutSeen = false;
    let _tokensGenerated = 0;
    const _progressStreamer = {
      put: (_tokenIds: unknown) => {
        if (!_initPutSeen) { _initPutSeen = true; return; }
        _tokensGenerated++;
        if (_tokensGenerated === 1 || _tokensGenerated % 50 === 0) {
          post({ type: "generate-progress", turnId, tokens_generated: _tokensGenerated });
        }
      },
      end: () => {
        if (_tokensGenerated > 0) {
          post({ type: "generate-progress", turnId, tokens_generated: _tokensGenerated });
        }
      },
    };
    // §C-decode-retry (#1362-C): buffer_manager.cc:553 "Buffer was unmapped before mapping
    // was resolved" is a D3D12 CPU/GPU sync race triggered during multi-step decode.
    // One retry after 500ms gives the GPU pipeline a chance to quiesce between attempts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const _doGenerate = () => (_model as any).generate({
      ...inputs,
      max_new_tokens: safeMaxNewTokens,
      do_sample: false,
      streamer: _progressStreamer,
    });
    try {
      outputs = await _doGenerate();
    } catch (genErr) {
      const _msg = String(genErr);
      if (/buffer_manager|BufferManager|unmapped before mapping/i.test(_msg)) {
        // §C-decode-retry (#1362-C, updated #1410): cold-cache boot accumulates more
        // pending GPU work (2.5GB upload pipeline). The post-drafter probe should have
        // flushed the queue; this retry is belt-and-suspenders for residual race window.
        const _delay1 = _coldCacheBoot ? 2000 : 500;
        console.warn("[model-worker] buffer_manager race — retrying after " + _delay1 + "ms", _msg.slice(0, 120));
        await new Promise(r => setTimeout(r, _delay1));
        try {
          outputs = await _doGenerate();
        } catch (retryErr) {
          // §#1410: second retry for cold-cache (larger race window after 2.5GB download).
          if (_coldCacheBoot && /buffer_manager|BufferManager|unmapped before mapping/i.test(String(retryErr))) {
            console.warn("[model-worker] buffer_manager retry-2 — cold-cache, waiting 3000ms");
            await new Promise(r => setTimeout(r, 3000));
            outputs = await _doGenerate(); // final attempt — throws to outer catch if still failing
          } else {
            throw retryErr;
          }
        }
      } else {
        throw genErr;
      }
    }
  }

  const tGen = performance.now();

  // Decode newly generated tokens only
  const generated = inputLength > 0
    ? (outputs as any).slice(null, [inputLength, null])
    : outputs;
  const tokensOut: number = (generated as any)?.dims?.[1] ?? 0;

  const decoded: string[] = proc.batch_decode(
    typeof (generated as any).tolist === "function" ? (generated as any).tolist() : generated,
    { skip_special_tokens: true },
  );

  // §A (#990): release GPU-backed ORT tensors after decode — prevents KV VRAM leak at 16K depth.
  try { if (generated !== outputs) (generated as any)?.dispose?.(); } catch { /* non-fatal */ }
  try { (outputs as any)?.dispose?.(); } catch { /* non-fatal */ }
  // §A-inputs (#1303): release input tensors (WebGPU-backed by processor) each turn.
  for (const v of Object.values(inputs ?? {})) {
    try { (v as any)?.dispose?.(); } catch { /* non-fatal */ }
  }

  post({
    type: "generate-done",
    turnId,
    text:         decoded[0] ?? "",
    specAttempts,
    specAccepts,
    prefillMs:    tProc - t0,
    decodeMs:     tGen - tProc,
    inputLength,
    tokensOut,
  });
}
