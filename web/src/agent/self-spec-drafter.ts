// self-spec-drafter.ts — Self-speculative early-exit drafter loop (#1860 Sub-3).
//
// Runs only the first `exitLayerKv` KV layers of the decoder per draft step,
// reading `logits_early_exit` from the dual-head ONNX (Sub-2 #1862).
// Does NOT touch the verifier's KV cache — draft KV is accumulated separately.
//
// Consumed by Sub-4 verifier which compares verifier argmax against draftTokens
// and restores KV to the longest accepted prefix.

import type { MtpModelConfig, MtpSessions } from "./webgpu-mtp-backend";

const VOCAB_SIZE = 262144;

// ── Types ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtTensor = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtGlobal = any;

/**
 * Snapshot of decoder state at the point the drafter is called.
 * The verifier's kvCache MUST NOT be mutated by draftBlock.
 */
export interface DrafterState {
  sessions: MtpSessions;           // embed + decoder sessions (reused from verifier)
  ort: OrtGlobal;                  // onnxruntime-web namespace
  kvCache: Record<string, OrtTensor>; // verifier's KV: present.N.key/value (read-only)
  kvSeqLen: number;                // sequence length up to last verified token
  config: MtpModelConfig;          // E2B or E4B KV layout
  lastToken: number;               // last accepted token ID (drafter starts from here)
  exitLayerKv: number;             // KV index of early-exit layer (5 for E2B, 8 for E4B)
}

/** KV update for layers 0..exitLayerKv from one draft step. */
export type DraftStepKv = Record<string, OrtTensor>;

export interface DraftBlock {
  /** Drafted token IDs, length ≤ k (may be shorter if EOS hit). */
  tokens: number[];
  /**
   * Per-step draft KV updates for layers 0..exitLayerKv.
   * earlyKv[i] = {present.0.key, present.0.value, ..., present.e.key, present.e.value}
   * produced in draft step i. Sub-4 uses this to reconstruct KV on acceptance.
   */
  earlyKv: DraftStepKv[];
  /**
   * logits_early_exit per draft step (shape: [VOCAB_SIZE] each, from argmax position).
   * Available to Sub-4 for rejection sampling or acceptance-rate telemetry.
   */
  earlyLogits: Float32Array[];
}

// ── Output name list builder ──────────────────────────────────────────────────

/**
 * Build the ORT outputNames for a draft step:
 * logits_early_exit + present.0..exitLayerKv.key/value.
 *
 * ORT prunes computation to only these outputs, so layers exitLayerKv+1..L-1
 * are not computed — this is the speedup source.
 */
function draftOutputNames(exitLayerKv: number): string[] {
  const names: string[] = ["logits_early_exit"];
  for (let i = 0; i <= exitLayerKv; i++) {
    names.push(`present.${i}.key`, `present.${i}.value`);
  }
  return names;
}

// ── KV feed builder ───────────────────────────────────────────────────────────

/**
 * Build past_key_values feed for one draft step.
 *
 * Layers 0..exitLayerKv: use accumulated draft KV (grows per step).
 * Layers exitLayerKv+1..L-1: use verifier KV (frozen — drafter doesn't compute these).
 *
 * On draft step 0: draft KV is empty, so all layers use verifier KV.
 * On draft step d>0: layers 0..exitLayerKv use the accumulated draft KV from steps 0..d-1.
 */
function buildDraftFeed(
  state: DrafterState,
  accumulatedDraftKv: DraftStepKv,  // built up across steps 0..d-1
): Record<string, OrtTensor> {
  const feed: Record<string, OrtTensor> = {};
  const { config, kvCache } = state;

  for (let i = 0; i < config.numKvLayers; i++) {
    const draftKey = accumulatedDraftKv[`present.${i}.key`];
    if (draftKey !== undefined) {
      // Draft KV exists for this layer — use it (includes verifier prefix + draft tokens)
      feed[`past_key_values.${i}.key`]   = accumulatedDraftKv[`present.${i}.key`];
      feed[`past_key_values.${i}.value`] = accumulatedDraftKv[`present.${i}.value`];
    } else {
      // Layer beyond exit — use frozen verifier KV
      feed[`past_key_values.${i}.key`]   = kvCache[`present.${i}.key`];
      feed[`past_key_values.${i}.value`] = kvCache[`present.${i}.value`];
    }
  }
  return feed;
}

// ── argmax helper ─────────────────────────────────────────────────────────────

function argmax(logits: Float32Array, offset = 0): number {
  let best = 0;
  for (let i = 1; i < VOCAB_SIZE; i++) {
    if (logits[offset + i] > logits[offset + best]) best = i;
  }
  return best;
}

// ── Main export ───────────────────────────────────────────────────────────────

const EOS_TOKEN_ID = 1;

/**
 * Draft up to k tokens using only the first exitLayerKv+1 KV layers.
 *
 * Invariant: state.kvCache is NEVER modified. All writes go to accumulatedDraftKv,
 * returned as earlyKv[d] for each draft step d.
 *
 * @param state   Current decoder state (verifier KV + sessions).
 * @param k       Maximum draft tokens to produce.
 * @param eosId   EOS token ID (default 1 for Gemma). Draft stops early on EOS.
 */
export async function draftBlock(
  state: DrafterState,
  k: number,
  eosId = EOS_TOKEN_ID,
): Promise<DraftBlock> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { sessions, ort: O, config, kvSeqLen, exitLayerKv } = state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embed   = (sessions.embed   as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoder = (sessions.decoder as any);

  const outputNames = draftOutputNames(exitLayerKv);

  const tokens:      number[]      = [];
  const earlyKv:     DraftStepKv[] = [];
  const earlyLogits: Float32Array[] = [];

  // Accumulated draft KV: present.0..exitLayerKv.key/value growing across steps.
  // Starts empty — step 0 uses verifier KV for all layers.
  let accumulatedDraftKv: DraftStepKv = {};

  let lastToken = state.lastToken;

  for (let d = 0; d < k; d++) {
    // 1. Embed last (draft) token
    const embedOut = await embed.run({
      input_ids: new O.Tensor("int64", [BigInt(lastToken)], [1, 1]),
    });

    // 2. Build position for this draft step
    const draftPos = kvSeqLen + d;
    const attnLen  = draftPos + 1;
    const attnMask = new BigInt64Array(attnLen).fill(BigInt(1));

    // 3. Build KV feed — verifier KV for layers 0..exitLayerKv (or accumulated draft KV)
    //    + verifier KV for layers exitLayerKv+1..L-1 (always frozen)
    const pastFeed = buildDraftFeed(state, accumulatedDraftKv);

    // 4. Run decoder — ORT prunes to layers 0..exitLayerKv + early-exit head
    const draftOut = await decoder.run(
      {
        inputs_embeds:      embedOut["inputs_embeds"],
        per_layer_inputs:   embedOut["per_layer_inputs"],
        attention_mask:     new O.Tensor("int64", attnMask, [1, attnLen]),
        position_ids:       new O.Tensor("int64", [BigInt(draftPos)], [1, 1]),
        num_logits_to_keep: new O.Tensor("int64", [BigInt(1)], []),
        ...pastFeed,
      },
      outputNames,
    );

    // 5. Read early-exit logits and pick argmax
    const logitsTensor = draftOut["logits_early_exit"];
    const logitsData   = logitsTensor.data as Float32Array;
    const draftToken   = argmax(logitsData);

    // Capture per-step logits slice (last position only; S=1 at decode time)
    const stepLogits = new Float32Array(VOCAB_SIZE);
    stepLogits.set(logitsData.slice(0, VOCAB_SIZE));
    earlyLogits.push(stepLogits);

    // 6. Collect draft KV for layers 0..exitLayerKv — merge into accumulated
    const stepKv: DraftStepKv = {};
    for (let i = 0; i <= exitLayerKv; i++) {
      stepKv[`present.${i}.key`]   = draftOut[`present.${i}.key`];
      stepKv[`present.${i}.value`] = draftOut[`present.${i}.value`];
    }
    earlyKv.push(stepKv);

    // Advance accumulated KV: next step uses these updated layers 0..exitLayerKv
    accumulatedDraftKv = { ...stepKv };

    // 7. Record token and advance
    tokens.push(draftToken);
    lastToken = draftToken;

    // Yield to keep main thread responsive between draft steps
    await new Promise<void>(r => setTimeout(r, 0));

    // Stop early on EOS
    if (draftToken === eosId) break;
  }

  return { tokens, earlyKv, earlyLogits };
}

// ── Config helpers ────────────────────────────────────────────────────────────

/** Read exit_layer_kv_index from ONNX metadata_props, or fall back to anatomy-derived default. */
export function exitLayerKvFromMetadata(
  sessionMeta: Record<string, string> | null | undefined,
  config: MtpModelConfig,
): number {
  const fromMeta = sessionMeta?.["exit_layer_kv_index"];
  if (fromMeta !== undefined) {
    const parsed = parseInt(fromMeta, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < config.numKvLayers) return parsed;
  }
  // Fallback: r=0.33 default from anatomy (E2B: KV 5, E4B: KV 8)
  return Math.floor(config.numKvLayers / 3);
}
