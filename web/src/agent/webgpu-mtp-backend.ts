// webgpu-mtp-backend.ts — Three-session ORT spec-decode pipeline (#751).
//
// Uses embed_tokens + decoder_model_merged sessions already loaded by
// transformers.js — no extra model download. Drafter session passed in from
// agent-harness.ts (loaded via drafter-cache.ts, #750).
//
// Decoder ONNX structure (onnx-community/gemma-4-E2B-it-ONNX, q4):
//   15 KV layers; full-attention (head_dim=512) at layers 4, 9, 14.
//   Last sliding layer: 13 (head_dim=256) → drafter sliding_k/v input.
//   Last full layer:    14 (head_dim=512) → drafter full_k/v input.
//   Inputs:  inputs_embeds [B,S,1536], per_layer_inputs [B,S,35,256],
//            attention_mask [B,S+past] int64, position_ids [B,S] int64,
//            num_logits_to_keep [] int64, past_key_values.N.key/value
//   Outputs: logits [B,keep,262144], present.N.key/value

const NUM_KV_LAYERS   = 15;
const LAST_SLIDING    = 13;   // present.13.key/value — head_dim 256
const LAST_FULL       = 14;   // present.14.key/value — head_dim 512
const HIDDEN_SIZE     = 1536;
const VOCAB_SIZE      = 262144;
const FULL_ATTN: Set<number> = new Set([4, 9, 14]);  // layers with head_dim 512

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
  return { embed, decoder };
}

// ── KV cache helpers ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emptyKvFeed(ort: any): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed: Record<string, any> = {};
  for (let i = 0; i < NUM_KV_LAYERS; i++) {
    const hd = FULL_ATTN.has(i) ? 512 : 256;
    feed[`past_key_values.${i}.key`]   = new ort.Tensor("float32", new Float32Array(0), [1, 1, 0, hd]);
    feed[`past_key_values.${i}.value`] = new ort.Tensor("float32", new Float32Array(0), [1, 1, 0, hd]);
  }
  return feed;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function kvCacheToPast(kvCache: Record<string, any>): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed: Record<string, any> = {};
  for (let i = 0; i < NUM_KV_LAYERS; i++) {
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
 */
export async function runMtpSpecDecode(
  sessions: MtpSessions,
  drafterSess: unknown,
  ort: unknown,
  inputIds: BigInt64Array,
  maxNew: number,
  draftK: number,
  eosTokenId = 1,
): Promise<MtpDecodeResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { embed, decoder } = sessions as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const drafter = drafterSess as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const O = ort as any;

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
    ...emptyKvFeed(O),
  });

  // Cache all KV outputs from prefill
  for (let i = 0; i < NUM_KV_LAYERS; i++) {
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

    const slidingK = kvCache[`present.${LAST_SLIDING}.key`];
    const slidingV = kvCache[`present.${LAST_SLIDING}.value`];
    const fullK    = kvCache[`present.${LAST_FULL}.key`];
    const fullV    = kvCache[`present.${LAST_FULL}.value`];

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
        position_ids:  new O.Tensor("int64", [BigInt(kvSeqLen + d)], [1, 1]),
        sliding_k: slidingK,
        sliding_v: slidingV,
        full_k:    fullK,
        full_v:    fullV,
      });

      const draftLogit = argmax(draftOut["logits"].data as Float32Array);
      draftTokens.push(draftLogit);
      projState = draftOut["proj_state"];
      lastToken = draftLogit;
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

    const verifyOut = await decoder.run({
      inputs_embeds:      embedVer["inputs_embeds"],
      per_layer_inputs:   embedVer["per_layer_inputs"],
      attention_mask:     new O.Tensor("int64", attnMask, [1, attnLen]),
      position_ids:       new O.Tensor("int64", posIdsV,  [1, K2]),
      num_logits_to_keep: new O.Tensor("int64", [BigInt(K2)], []),
      ...kvCacheToPast(kvCache),
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

    // Update KV cache with verify outputs (covers accepted token positions)
    for (let i = 0; i < NUM_KV_LAYERS; i++) {
      kvCache[`present.${i}.key`]   = verifyOut[`present.${i}.key`];
      kvCache[`present.${i}.value`] = verifyOut[`present.${i}.value`];
    }
    kvSeqLen += accepted;

    if (eos) break;
  }

  return { tokens, specAttempts, specAccepts };
}
