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

import { Gemma4ForConditionalGeneration, AutoProcessor, RawImage } from "@huggingface/transformers";
import { getMtpSessions, runMtpSpecDecode, MTP_CONFIG_E4B } from "./webgpu-mtp-backend.js";
import { fetchDrafterCached } from "./drafter-cache.js";

// ── Worker state ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _model: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _processor: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _drafterSession: any = null;
// #1283: drafter bytes cached at boot; session lazy-created on first eligible turn
// (inputLength < 900). Avoids holding a second GPUDevice + 316MB GPU resident weights
// for the typical long-prompt demo path where MTP never fires.
let _drafterBytes: ArrayBuffer | null = null;
let _drafterSessionFailed = false;

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

// Wrap Cache.prototype.put to swallow UnknownError / QuotaExceededError.
// If Cache.put throws, transformers.js may consume (and corrupt) the response body before re-raising,
// silently aborting the download pipeline.  We patch the prototype (not globalThis.caches, which is
// a getter-only property in WorkerGlobalScope and cannot be reassigned).
function installCachePutGuard(): void {
  if (!("Cache" in globalThis)) return;
  try {
    const origPut = Cache.prototype.put;
    Cache.prototype.put = async function(this: Cache, ...args: Parameters<Cache["put"]>) {
      try {
        return await origPut.apply(this, args);
      } catch (e) {
        post({ type: "progress", phase: "cache-put-error", bytes: 0, total: 0,
               throughputBytesPerSec: 0, error: `Cache.put: ${(e as Error).message}` });
      }
    };
  } catch (_) { /* non-fatal if prototype is frozen */ }
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
    if (type === "init")          await handleInit(data);
    else if (type === "generate")  await handleGenerate(data);
    else if (type === "shutdown")  await handleShutdown();
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

  // Returning-user detection: if model files are already in Cache API, skip the
  // loading screen and show a fast-path pulse instead.
  const isReturning = await checkReturningUser(modelId);
  if (isReturning) {
    post({ type: "returning-user" });
  }

  // Install Cache.put guard before from_pretrained runs — prevents UnknownError from
  // aborting the download pipeline when Chrome's Cache API rejects the ONNX response.
  installCachePutGuard();

  // Emit manifest with estimated total bytes so the overlay can show aggregate %.
  // E4B: model ONNX q4f16 ≈ 2.5 GB + drafter ≈ 158 MB + tokenizer files ≈ 5 MB.
  const ESTIMATED_MODEL_BYTES = 2_700_000_000;
  post({ type: "manifest", totalBytesExpected: ESTIMATED_MODEL_BYTES });

  // Cumulative bytes downloaded (all model files combined) for aggregate throughput.
  let _cumulativeBytes = 0;

  // Stall detection: if no progress callback fires for STALL_AFTER_MANIFEST_MS after manifest,
  // emit a diagnostic event so the boot-screen can surface a connection-issue hint before the
  // generic 90s watchdog fires.
  const STALL_AFTER_MANIFEST_MS = 30_000;
  let _stallTimerId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    _stallTimerId = null;
    post({ type: "progress", phase: "download-stall", bytes: 0, total: 0, throughputBytesPerSec: 0 });
  }, STALL_AFTER_MANIFEST_MS);

  const _clearStallTimer = () => {
    if (_stallTimerId !== null) { clearTimeout(_stallTimerId); _stallTimerId = null; }
  };

  const progressCb = (info: Record<string, unknown>) => {
    _clearStallTimer(); // any progress event means download is live
    if (info.status === "downloading") {
      const bytes = (info.loaded as number | undefined) ?? 0;
      const total = (info.total as number | undefined) ?? 0;
      _cumulativeBytes = Math.max(_cumulativeBytes, bytes); // rough sum across files
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
    } else if (info.status === "loading") {
      post({ type: "progress", phase: "model-init", bytes: 0, total: 0, throughputBytesPerSec: 0 });
    } else {
      // Surface unexpected statuses (e.g. "error", "done", "ready") in the stall trace.
      post({ type: "progress", phase: `model-status-${String(info.status ?? "unknown")}`,
             bytes: 0, total: 0, throughputBytesPerSec: 0,
             statusDetail: String(info.message ?? info.file ?? info.name ?? "") });
    }
  };

  const backends: Array<{ device: "webgpu" | "auto"; dtype: "q4f16" | "q4"; label: string }> = [
    { device: "webgpu", dtype: "q4",    label: "GPU" }, // #1283: q4 avoids fp16 Slice path (ort#26690 regression)
    { device: "auto",   dtype: "q4",    label: "CPU" },
  ];

  let loadedLabel = "CPU";

  for (const { device, dtype, label } of backends) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const model = await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
        dtype,
        device,
        progress_callback: progressCb,
      });
      const processor = await AutoProcessor.from_pretrained(modelId);

      // WebGPU sanity probe — same as main-thread path (#128/#133)
      if (device === "webgpu") {
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
      _clearStallTimer(); // model loaded — cancel stall detection
      break;
    } catch (e) {
      if (device === "webgpu") continue;
      _clearStallTimer();
      post({ type: "error", error: (e as Error).message });
      return;
    }
  }

  if (!_model) {
    _clearStallTimer();
    post({ type: "error", error: "No backend available for model load." });
    return;
  }

  _bootModelReady = true;
  post({ type: "model-ready", device: loadedLabel });
  checkBootComplete();

  // Warmup at representative-shape (#1283): compile shader variants matching real demo prompts
  // (~900-1000 tokens) instead of a trivial 1-token "." probe that only exercises short-context
  // shaders. Without this, the first real user prompt forces JIT shader compile + KV alloc +
  // LM-head Slice pipeline creation in one transaction at click-time, which has tripped
  // Windows TDR / GPU-process restart — surfacing as "A valid external Instance reference no
  // longer exists" + WebGL Context Lost cascade. max_new_tokens=4 exercises prefill AND decoder
  // shader paths (autoregressive Slice + KV step). Non-fatal on failure.
  try {
    post({ type: "progress", phase: "warmup", bytes: 0, total: 0, throughputBytesPerSec: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = _processor as any;
    const WARMUP_PAD = "lorem ipsum dolor sit amet ".repeat(180); // ~900-1000 tok after templating
    const chatText = proc.apply_chat_template(
      [{ role: "user", content: WARMUP_PAD }],
      { add_generation_prompt: true, tokenize: false },
    ) as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs: any = await proc(chatText, null);
    const tokCount: number = inputs.input_ids?.dims?.[1] ?? 0;
    if (tokCount > 0 && tokCount < WEBGPU_CONTEXT_LIMIT - 64) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (_model as any).generate({ ...inputs, max_new_tokens: 4, do_sample: false });
    }
  } catch { /* warmup failure non-fatal */ }

  _bootWarmupDone = true;
  post({ type: "warmup-done" });
  checkBootComplete();

  // Drafter load (#1283) — fire after warmup. Only fetch bytes here; session creation
  // is deferred to handleGenerate first eligible turn (useMtp && inputLength<900).
  // Why: ort.InferenceSession.create allocates a second GPUDevice + uploads 316MB of
  // drafter weights to VRAM during boot. The vast majority of demo prompts are >900
  // tokens and never invoke MTP — so the drafter GPU session sits idle holding VRAM
  // that pushes the agent model and Three.js renderer toward Windows TDR triggers.
  // The "external Instance reference no longer exists" + WebGL Context Lost cascade
  // on the demo prompt traces to GPU process pressure from this dormant second device.
  // Lazy-create on first MTP-eligible turn (inputLength<900) keeps the fast-path warm
  // for short prompts without paying GPU residency cost on the typical long-prompt path.
  // drafter-error is still non-fatal (standard path covers).
  if (drafterUrl) {
    try {
      post({ type: "progress", phase: "drafter", progress: 0, bytes: 0, total: 0, throughputBytesPerSec: 0 });
      let _drafterLastBytes = 0;
      let _drafterLastTs = Date.now();
      _drafterBytes = await fetchDrafterCached(drafterUrl, drafterCacheKey, (loaded, total) => {
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
      _bootDrafterDone = true;
      post({ type: "drafter-ready" });
    } catch (e) {
      _drafterBytes = null;
      _bootDrafterDone = true;
      post({ type: "drafter-error", error: (e as Error).message?.slice(0, 120) });
    }
  } else {
    // No drafter URL — drafter phase is skipped.
    _bootDrafterDone = true;
  }

  checkBootComplete();
  post({ type: "ready", device: loadedLabel });
}

// ── Shutdown: release ORT sessions when worker is terminated ─────────────────
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

  // #1283: lazy-create drafter ORT session on first MTP-eligible turn. Avoids paying
  // a second GPUDevice + 316MB VRAM upload at boot for the common path where the demo
  // prompt is too long for MTP anyway. One-shot: if create() throws, mark failed and
  // never retry — standard generate covers all turns.
  if (
    useMtp &&
    inputLength < 900 &&
    !_drafterSession &&
    _drafterBytes &&
    !_drafterSessionFailed
  ) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ort = (globalThis as any).ort ?? await import("onnxruntime-web");
      _drafterSession = await ort.InferenceSession.create(_drafterBytes, {
        executionProviders: ["webgpu", "wasm"],
        preferredOutputLocation: { logits: "cpu", proj_state: "cpu" },
      });
    } catch (e) {
      _drafterSessionFailed = true;
      console.warn("[model-worker] drafter lazy-init failed, standard path only:", (e as Error).message);
    }
  }

  // MTP spec-decode — disabled for long prompts: drafter produces degenerate output
  // (NaN verifier logits) on large inputs due to drafter KV window mismatch (#979).
  // Threshold 900: conservative safe zone; two-story-house prompt is ~997 tok.
  // WEBGPU_CONTEXT_LIMIT is now 16384 — this threshold is about drafter quality, not ceiling.
  if (useMtp && _drafterSession && MTP_VERIFICATION_WIRED && inputLength < 900) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ort = (globalThis as any).ort ?? await import("onnxruntime-web");
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputs = await (_model as any).generate({
      ...inputs,
      max_new_tokens: safeMaxNewTokens,
      do_sample: false,
      streamer: _progressStreamer,
    });
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
