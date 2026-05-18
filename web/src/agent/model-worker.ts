/// <reference lib="webworker" />
// model-worker.ts — Web Worker for on-device model load + inference (#936).
// Runs in a dedicated thread so from_pretrained() + model.generate() never block
// the main thread (tab-wedge fix for demo-blocker issue #936).
//
// Protocol (main → worker):
//   {type:"init", modelId, drafterUrl, drafterCacheKey}
//   {type:"generate", turnId, messages, imageUrl?, maxNewTokens, eosId, draftK, useMtp}
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

const WEBGPU_CONTEXT_LIMIT = 2048;

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
    if (type === "init")     await handleInit(data);
    else if (type === "generate") await handleGenerate(data);
    // "abort" is handled via the AbortController in handleGenerate (future work)
  } catch (e) {
    post({ type: "error", error: (e as Error).message });
  }
};

// ── Init: from_pretrained + warmup probe + drafter ───────────────────────────
async function handleInit(data: Record<string, unknown>): Promise<void> {
  const modelId = data.modelId as string;
  const drafterUrl = data.drafterUrl as string;
  const drafterCacheKey = data.drafterCacheKey as string;

  // Returning-user detection: if model files are already in Cache API, skip the
  // loading screen and show a fast-path pulse instead.
  const isReturning = await checkReturningUser(modelId);
  if (isReturning) {
    post({ type: "returning-user" });
  }

  // Emit manifest with estimated total bytes so the overlay can show aggregate %.
  // E4B: model ONNX q4f16 ≈ 2.5 GB + drafter ≈ 158 MB + tokenizer files ≈ 5 MB.
  const ESTIMATED_MODEL_BYTES = 2_700_000_000;
  post({ type: "manifest", totalBytesExpected: ESTIMATED_MODEL_BYTES });

  // Cumulative bytes downloaded (all model files combined) for aggregate throughput.
  let _cumulativeBytes = 0;

  const progressCb = (info: Record<string, unknown>) => {
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
          const probeText = proc.tokenizer.apply_chat_template(
            [{ role: "user", content: "test" }],
            { tokenize: false, add_generation_prompt: true },
          ) as string;
          const probeIn = await proc(probeText);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (model as any).generate({ ...probeIn, max_new_tokens: 20 });
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

  // Warmup probe — warms GPU shader pipeline; non-fatal if it fails
  try {
    post({ type: "progress", phase: "warmup", bytes: 0, total: 0, throughputBytesPerSec: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc = _processor as any;
    const chatText = proc.apply_chat_template(
      [{ role: "user", content: "." }],
      { add_generation_prompt: true, tokenize: false },
    ) as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputs: any = await proc(chatText, null);
    const tokCount: number = inputs.input_ids?.dims?.[1] ?? 0;
    if (tokCount < WEBGPU_CONTEXT_LIMIT - 64) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (_model as any).generate({ ...inputs, max_new_tokens: 1, do_sample: false });
    }
  } catch { /* warmup failure non-fatal */ }

  _bootWarmupDone = true;
  post({ type: "warmup-done" });
  checkBootComplete();

  // Drafter load — fire after warmup; drafter-error is non-fatal (standard path covers)
  if (drafterUrl) {
    try {
      post({ type: "progress", phase: "drafter", progress: 0, bytes: 0, total: 0, throughputBytesPerSec: 0 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ort = (globalThis as any).ort ?? await import("onnxruntime-web");
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

  checkBootComplete();
  post({ type: "ready", device: loadedLabel });
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

  // Format messages into a single string via apply_chat_template
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let messagesForTemplate: any[] = messages;
  if (imageUrl && imageList.length > 0) {
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
  }) as string;

  // Tokenize (pass image list separately for processor's vision encoder)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inputs: any = await proc(chatText, imageList.length > 0 ? imageList : null);
  const tProc = performance.now();
  const inputLength: number = inputs.input_ids?.dims?.[1] ?? 0;

  const safeMaxNewTokens = Math.min(maxNewTokens, WEBGPU_CONTEXT_LIMIT - inputLength);
  if (safeMaxNewTokens <= 0) {
    post({ type: "generate-error", turnId, error: `input too long: ${inputLength} tokens` });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let outputs: any;
  let specAttempts = 0;
  let specAccepts  = 0;

  // MTP spec-decode (same path as before, now running inside worker)
  if (useMtp && _drafterSession) {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outputs = await (_model as any).generate({
      ...inputs,
      max_new_tokens: safeMaxNewTokens,
      do_sample: false,
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
