// webgpu-mtp-backend.ts — Three-session ORT spec-decode pipeline (#751).
//
// Uses embed_tokens + decoder_model_merged sessions already loaded by
// transformers.js — no extra model download. Drafter session passed in from
// agent-harness.ts (loaded via drafter-cache.ts, #750).
//
// Drafter target model: google/gemma-4-E2B-it (from drafter ONNX metadata).
// MTP therefore only fires when the browser loads E2B — gated in agent-harness.ts.
//
// Decoder ONNX structure differs by model variant:
//   E4B (default, 24 KV layers): ONNX topology parse of decoder_model_merged_q4.onnx.
//     num_kv_heads=2, FULL_ATTN={5,11,17,23}, LAST_SLIDING=22, LAST_FULL=23.
//     See web/src/agent/decoder-kv-shapes.json for complete per-layer table.
//   E2B (MTP-active variant, 15 KV layers): ONNX topology parse of E2B decoder.
//     num_kv_heads=1, FULL_ATTN={4,9,14}, LAST_SLIDING=13, LAST_FULL=14.
//   Both: inputs_embeds [B,S,1536], per_layer_inputs [B,S,35,256],
//         attention_mask [B,S+past] int64, position_ids [B,S] int64,
//         num_logits_to_keep [] int64, past_key_values.N.key/value [B,nh,past,hd]
//         Outputs: logits [B,keep,262144], present.N.key/value [B,nh,S,hd]
//
// Drafter ONNX inputs (drafter-fp16.onnx, confirmed by ONNX parse):
//   inputs_embeds float32 [1,1,3072], position_ids int64 [1,1],
//   sliding_k/v float32 [1,1,16,256], full_k/v float32 [1,1,16,512]

const HIDDEN_SIZE = 1536;
const VOCAB_SIZE  = 262144;

// Per-model KV config — drafter targets E2B, so only E2B config is used for MTP.
export interface MtpModelConfig {
  numKvLayers:    number;
  numKvHeads:     number;
  lastSliding:    number;
  lastFull:       number;
  fullAttn:       Set<number>;
  drafterKvWindow: number;
}

export const MTP_CONFIG_E2B: MtpModelConfig = {
  numKvLayers:    15,
  numKvHeads:     1,
  lastSliding:    13,
  lastFull:       14,
  fullAttn:       new Set([4, 9, 14]),
  drafterKvWindow: 16,
};

export interface MtpSessions {
  embed: unknown;    // embed_tokens ORT session
  decoder: unknown;  // decoder_model_merged ORT session
}

// ── Session discovery ────────────────────────────────────────────────────────

/**
 * Extract ORT session handles from the already-loaded transformers.js model.
 * No file download — reuses what `from_pretrained` already loaded into VRAM.
 *
 * Returns null when session names don't match (model variant mismatch).
 */
export function getMtpSessions(model: unknown): MtpSessions | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = model as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessions: Record<string, any> = m?.sessions ?? {};

  const embed =
    sessions["embed_tokens"] ??
    sessions["model.embed_tokens"] ??
    null;

  const decoder =
    sessions["decoder_model_merged"] ??
    sessions["decoder_with_past_model"] ??
    sessions["model"] ??
    m.session ??
    null;

  if (!embed || !decoder) {
    console.warn(
      "[mtp-backend] getMtpSessions: sessions not found.",
      "Model keys:", Object.keys(m ?? {}).slice(0, 12),
      "Session keys:", Object.keys(sessions).slice(0, 12),
      "embed found:", !!embed,
      "decoder found:", !!decoder,
    );
    return null;
  }
  console.info("[mtp-backend] Sessions acquired — embed + decoder reusing VRAM allocation.");
  try {
    for (const name of (decoder as any).inputNames ?? []) {
      const meta = (decoder as any).inputMetadata?.[name];
      if (meta) console.info(`[mtp-backend] ${name}`, { type: meta?.type, dims: meta?.dims });
    }
  } catch { /* inputMetadata not available in this ORT version */ }
  return { embed, decoder };
}

// ── KV cache helpers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyKvFeed(ort: any, cfg: MtpModelConfig): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed: Record<string, any> = {};
  for (let i = 0; i < cfg.numKvLayers; i++) {
    const hd = cfg.fullAttn.has(i) ? 512 : 256;
    // fp16 backed by Uint16Array; shape [B, numKvHeads, past_seq, head_dim].
    const t = new ort.Tensor("float16", new Uint16Array(0), [1, cfg.numKvHeads, 0, hd]);
    feed[`past_key_values.${i}.key`]   = t;
    feed[`past_key_values.${i}.value`] = t;
  }
  console.info(`[mtp-backend] emptyKvFeed: float16 numKvHeads=${cfg.numKvHeads} fullAttn=[${[...cfg.fullAttn]}]`);
  return feed;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kvCacheToPast(kvCache: Record<string, any>, cfg: MtpModelConfig): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed: Record<string, any> = {};
  for (let i = 0; i < cfg.numKvLayers; i++) {
    feed[`past_key_values.${i}.key`]   = kvCache[`present.${i}.key`];
    feed[`past_key_values.${i}.value`] = kvCache[`present.${i}.value`];
  }
  return feed;
}

function argmax(logits: Float32Array, offset = 0): number {
  let best = 0;
  for (let i = 1; i < VOCAB_SIZE; i++) {
    if (logits[offset + i] > logits[offset + best]) best = i;
  }
  return best;
}

// Decode one fp16 bit-pattern (Uint16) to a float32 number.
function fp16ToFloat32(h: number): number {
  const s = (h >> 15) & 0x1;
  const e = (h >> 10) & 0x1f;
  const m =  h        & 0x3ff;
  if (e === 0)  return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
  if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
}

// Drafter expects float32 with 1 KV head; decoder outputs fp16 with 2 KV heads.
// Full S version (kept for reference; spec-decode uses the tail variant below).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fp16Head0ToFp32(kvTensor: any, ort: any): any {
  const [B, , S, H] = kvTensor.dims as number[];  // [1, 2, S, hd]
  const src = kvTensor.data as Uint16Array;        // fp16 backing: 2*S*H elements
  const f32 = new Float32Array(S * H);
  for (let i = 0; i < S * H; i++) f32[i] = fp16ToFloat32(src[i]);
  return new ort.Tensor("float32", f32, [B, 1, S, H]);
}

// Drafter KV window is fixed at W tokens (static ONNX dim, confirmed by OrtRun "Got: 936 Expected: 16").
// Takes the last W tokens from the decoder fp16 cache, averages across all numHeads heads,
// and returns float32 [B, 1, W, H]. Zero-pads at front when S < W.
//
// Head-average, not head-0 slice: the drafter was trained on a target KV that folds numHeads=2
// into a single-head representation. Averaging is the cheapest correct approximation.
// If accept_rate is still poor after this, check drafter.inputMetadata.dims for sliding_k/full_k.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fp16HeadAvgToFp32Tail(kvTensor: any, W: number, ort: any): any {
  const [B, numHeads, S, H] = kvTensor.dims as number[];
  const src = kvTensor.data as Uint16Array;  // fp16: numHeads * S * H elements, row-major per head
  const f32 = new Float32Array(W * H);       // zero-filled → zero-pad when S < W
  const copyLen   = Math.min(S, W);
  const srcTokOff = S - copyLen;             // first token to copy (tail of the sequence)
  const dstTokOff = W - copyLen;             // destination token (zero-pad at front)
  for (let t = 0; t < copyLen; t++) {
    for (let h = 0; h < H; h++) {
      let sum = 0;
      for (let nh = 0; nh < numHeads; nh++) {
        sum += fp16ToFloat32(src[nh * S * H + (srcTokOff + t) * H + h]);
      }
      f32[(dstTokOff + t) * H + h] = sum / numHeads;
    }
  }
  return new ort.Tensor("float32", f32, [B, 1, W, H]);
}

// After each verify step, rejected draft tokens leave stale KV entries at the tail of
// the verifyOut present tensors. Truncate to `newLen` on axis-2 before storing in kvCache.
// verifyOut present shape: [B, numHeads, past+K2, H] (fp16 Uint16Array).
// Returns fp16 [B, numHeads, newLen, H] with each head's last K2-accepted entries dropped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sliceKvAxis2(kvTensor: any, newLen: number, ort: any): any {
  const [B, numHeads, , H] = kvTensor.dims as number[];
  const src = kvTensor.data as Uint16Array;
  const dst = new Uint16Array(B * numHeads * newLen * H);
  for (let h = 0; h < B * numHeads; h++) {
    // Each head lane is contiguous; copy only the first newLen token entries.
    dst.set(src.subarray(h * (kvTensor.dims[2] as number) * H, h * (kvTensor.dims[2] as number) * H + newLen * H), h * newLen * H);
  }
  return new ort.Tensor("float16", dst, [B, numHeads, newLen, H]);
}

// ── Main export: spec-decode loop ────────────────────────────────────────────

export interface MtpDecodeResult {
  tokens: number[];
  specAttempts: number;
  specAccepts: number;
}

/**
 * Run three-session MTP spec-decode.
 *
 * @param sessions      embed + decoder from getMtpSessions()
 * @param drafterSess   drafter ORT session (loaded by agent-harness.ts)
 * @param ort           onnxruntime-web global (already loaded by transformers.js)
 * @param inputIds      full tokenized prompt as BigInt64Array [S]
 * @param maxNew        max new tokens to generate
 * @param draftK        draft tokens per target verify step
 * @param eosTokenId    EOS token id (1 for Gemma)
 * @param config        per-model KV layout — must match the loaded decoder variant
 */
export async function runMtpSpecDecode(
  sessions: MtpSessions,
  drafterSess: unknown,
  ort: unknown,
  inputIds: BigInt64Array,
  maxNew: number,
  draftK: number,
  eosTokenId = 1,
  config: MtpModelConfig = MTP_CONFIG_E2B,
): Promise<MtpDecodeResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { embed, decoder } = sessions as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drafter = drafterSess as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const O = ort as any;

  try {
    console.info("[mtp-backend] drafter.inputNames:", JSON.stringify((drafter as any).inputNames ?? []));
    console.info("[mtp-backend] drafter.outputNames:", JSON.stringify((drafter as any).outputNames ?? []));
    for (const name of (drafter as any).inputNames ?? []) {
      const meta = (drafter as any).inputMetadata?.[name];
      if (meta) console.info(`[mtp-backend] drafter in:${name}`, { type: meta?.type, dims: meta?.dims });
    }
  } catch { /* inputMetadata not available in this ORT version */ }

  const seqLen0 = inputIds.length;
  const tokens: number[] = [];
  let specAttempts = 0;
  let specAccepts  = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let kvCache: Record<string, any> = {};
  let kvSeqLen = seqLen0;

  // ── 1. Prefill ─────────────────────────────────────────────────────────────
  const embedPre = await embed.run({
    input_ids: new O.Tensor("int64", inputIds, [1, seqLen0]),
  });

  const posIds0   = new BigInt64Array(seqLen0).map((_, i) => BigInt(i));
  const attnMask0 = new BigInt64Array(seqLen0).fill(BigInt(1));

  const prefillOut = await decoder.run({
    inputs_embeds:      embedPre["inputs_embeds"],
    per_layer_inputs:   embedPre["per_layer_inputs"],
    attention_mask:     new O.Tensor("int64", attnMask0, [1, seqLen0]),
    position_ids:       new O.Tensor("int64", posIds0,   [1, seqLen0]),
    num_logits_to_keep: new O.Tensor("int64", [BigInt(1)], []),
    ...emptyKvFeed(O, config),
  });

  // Cache all KV outputs from prefill.
  for (let i = 0; i < config.numKvLayers; i++) {
    kvCache[`present.${i}.key`]   = prefillOut[`present.${i}.key`];
    kvCache[`present.${i}.value`] = prefillOut[`present.${i}.value`];
  }

  // First predicted token from prefill logits
  let nextToken = argmax(prefillOut["logits"].data as Float32Array);
  tokens.push(nextToken);
  if (nextToken === eosTokenId || tokens.length >= maxNew) {
    return { tokens, specAttempts, specAccepts };
  }

  console.info(`[mtp] spec-decode loop active, K=${draftK}`);

  // ── 2. Spec-decode iterations ───────────────────────────────────────────────
  while (tokens.length < maxNew) {
    const K = Math.min(draftK, maxNew - tokens.length);

    // Drafter KV window = 16 tokens (static ONNX dim). Slice tail + fp16→fp32 + head-avg.
    const { lastSliding, lastFull, drafterKvWindow } = config;
    const slidingK = fp16HeadAvgToFp32Tail(kvCache[`present.${lastSliding}.key`],   drafterKvWindow, O);
    const slidingV = fp16HeadAvgToFp32Tail(kvCache[`present.${lastSliding}.value`], drafterKvWindow, O);
    const fullK    = fp16HeadAvgToFp32Tail(kvCache[`present.${lastFull}.key`],      drafterKvWindow, O);
    const fullV    = fp16HeadAvgToFp32Tail(kvCache[`present.${lastFull}.value`],    drafterKvWindow, O);

    // ── 2a. Draft K tokens with drafter ──────────────────────────────────────
    const draftTokens: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let projState: any = null;
    let lastToken = nextToken;

    for (let d = 0; d < K; d++) {
      specAttempts++;

      const tokenEmbedOut = await embed.run({
        input_ids: new O.Tensor("int64", [BigInt(lastToken)], [1, 1]),
      });
      const tokenEmbed = tokenEmbedOut["inputs_embeds"].data as Float32Array; // [1536]

      const combined = new Float32Array(HIDDEN_SIZE * 2);
      for (let i = 0; i < HIDDEN_SIZE; i++) {
        combined[i]               = tokenEmbed[i] ?? 0;
        combined[i + HIDDEN_SIZE] = projState ? (projState.data as Float32Array)[i] ?? 0 : 0;
      }

      const draftOut = await drafter.run({
        inputs_embeds: new O.Tensor("float32", combined, [1, 1, HIDDEN_SIZE * 2]),
        // Drafter operates in LOCAL position space: KV window occupies 0..drafterKvWindow-1,
        // draft token d is at drafterKvWindow+d. Passing absolute kvSeqLen+d (e.g. 936+)
        // is semantically incompatible with the drafter's learned RoPE associations even
        // though 936 is within the 4096-position RoPE table — it yields NaN logits via
        // mismatched q·k cross-frame interactions propagating to fp16 overflow.
        position_ids:  new O.Tensor("int64", [BigInt(drafterKvWindow + d)], [1, 1]),
        sliding_k: slidingK,
        sliding_v: slidingV,
        full_k:    fullK,
        full_v:    fullV,
      });

      const draftLogit = argmax(draftOut["logits"].data as Float32Array);
      draftTokens.push(draftLogit);
      projState = draftOut["proj_state"];
      // Probe on first draft step of first spec iteration to confirm projState wiring.
      if (d === 0 && specAttempts === 1) {
        const ps = draftOut["proj_state"];
        const psData = ps?.data as Float32Array | undefined;
        console.info("[mtp-backend] d=0 probe:", {
          outputKeys: Object.keys(draftOut),
          proj_state_dims: ps?.dims,
          proj_state_defined: ps != null,
          proj_state_nonzero: psData ? psData.slice(0, 4) : null,
          draftLogit,
        });
      }
      lastToken = draftLogit;
    }
    // Log first-iteration draft summary.
    if (specAttempts <= draftK) {
      console.info("[mtp-backend] iter-1 draftTokens:", draftTokens);
    }

    // ── 2b. Verify K draft tokens with target decoder ─────────────────────────
    // Run decoder on K positions using accumulated KV cache as past.
    const K2 = draftTokens.length;
    const verifyIds = new BigInt64Array(K2).map((_, i) => BigInt(draftTokens[i]));
    const embedVer = await embed.run({
      input_ids: new O.Tensor("int64", verifyIds, [1, K2]),
    });

    const posIdsV  = new BigInt64Array(K2).map((_, i) => BigInt(kvSeqLen + i));
    const attnLen  = kvSeqLen + K2;
    const attnMask = new BigInt64Array(attnLen).fill(BigInt(1));

    // Diagnostic probe — capture verify-call shape values so the attention_mask
    // off-by-N can be derived from the error's reported condition vs X dims.
    console.info("[mtp-backend] verify site:", {
      kvSeqLen,
      K,
      K2,
      attnLen,
      posIdsV: Array.from(posIdsV).map(Number),
      pastKeyDims: (kvCache[`present.0.key`] as any)?.dims,
    });

    const verifyOut = await decoder.run({
      inputs_embeds:      embedVer["inputs_embeds"],
      per_layer_inputs:   embedVer["per_layer_inputs"],
      attention_mask:     new O.Tensor("int64", attnMask, [1, attnLen]),
      position_ids:       new O.Tensor("int64", posIdsV,  [1, K2]),
      num_logits_to_keep: new O.Tensor("int64", [BigInt(K2)], []),
      ...kvCacheToPast(kvCache, config),
    });

    // ── 2c. Greedy acceptance — take target tokens (correct by construction) ──
    const verifyLogitsAll = verifyOut["logits"].data as Float32Array; // [K2 * VOCAB_SIZE]
    let accepted = 0;
    let eos = false;

    for (let i = 0; i < K2; i++) {
      const targetTok = argmax(verifyLogitsAll, i * VOCAB_SIZE);
      if (targetTok === draftTokens[i]) specAccepts++;
      tokens.push(targetTok);
      accepted++;
      if (targetTok === eosTokenId || tokens.length >= maxNew) { eos = true; break; }
      if (targetTok !== draftTokens[i]) {
        // Mismatch — target token already appended; stop this verify step.
        nextToken = targetTok;
        break;
      }
      nextToken = targetTok;
    }

    // Update KV cache — truncate to accepted tokens only.
    // verifyOut present dims[2] = kvSeqLen + K2 (includes all K2 draft positions).
    // Rejected drafts at the tail must be dropped; otherwise pastKeyDims[2] diverges
    // from kvSeqLen and the next iteration's attention_mask length mismatches scores.
    const newCacheLen = kvSeqLen + accepted;
    for (let i = 0; i < config.numKvLayers; i++) {
      kvCache[`present.${i}.key`]   = sliceKvAxis2(verifyOut[`present.${i}.key`],   newCacheLen, O);
      kvCache[`present.${i}.value`] = sliceKvAxis2(verifyOut[`present.${i}.value`], newCacheLen, O);
    }
    kvSeqLen = newCacheLen;

    if (eos) break;
  }

  return { tokens, specAttempts, specAccepts };
}
