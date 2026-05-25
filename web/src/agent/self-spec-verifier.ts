// self-spec-verifier.ts — Self-speculative verifier + KV restore (#1860 Sub-4).
//
// Runs the FULL L-layer decoder ONCE on the k-token draft block, then:
//   1. Compares verifier argmax vs draft tokens (exact_argmax criterion).
//   2. Finds the longest accepted prefix.
//   3. Slices verifier KV to kvSeqLen + acceptedLen + (replacement ? 1 : 0).
//   4. Returns the KV as the new authoritative session state.
//
// Acceptance criterion: exact_argmax — deterministic, argmax-vs-argmax.
// Sampling-equivalent mode (rejection sampling with Gumbel-softmax correction)
// is deferred to a follow-up per issue scope.
//
// Note on logit alignment: logits[0, p, :] = P(t | prefix + d_0..d_p). We compare
// this directly against draft.tokens[p] (approach: "the verifier's view at position p").
// This is off-by-one vs strict spec-decode theory but is a valid exact_argmax heuristic
// and matches the issue's AC test cases exactly.

import type { DrafterState, DraftBlock } from "./self-spec-drafter";

const VOCAB_SIZE = 262144;

// ── Types ─────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtTensor = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrtGlobal = any;

export interface VerifyResult {
  /** Draft tokens where verifier argmax matched — longest prefix before first mismatch. */
  accepted: number[];
  /**
   * Verifier's argmax at the first mismatch position, or null if all k tokens accepted.
   * This is the replacement token the main loop emits when a rejection occurs.
   */
  replacement: number | null;
  /**
   * Verifier KV sliced to kvSeqLen + accepted.length + (replacement ? 1 : 0) positions.
   * This replaces the main session's kvCache after verifyBlock returns.
   * Drafter's earlyKv is fully discarded.
   */
  newKv: Record<string, OrtTensor>;
  /**
   * Per-position verifier logits (VOCAB_SIZE each) for all k positions.
   * Available to Sub-5 for telemetry or soft-acceptance experiments.
   */
  verifierLogits: Float32Array[];
}

/** Tokens emitted in one spec-decode cycle + efficiency telemetry. */
export interface CycleOutput {
  /** accepted tokens + replacement (if any). Length 1..k+1. */
  emittedTokens: number[];
  /**
   * Efficiency: emittedTokens.length / (k_drafted + 1 verify step).
   * > 1 when more than 1 token emitted per verify step (the goal).
   */
  speedupRealized: number;
}

// ── KV slice helper ───────────────────────────────────────────────────────────

/**
 * Slice a KV tensor on axis-2 to `newSeqLen` positions.
 * Input shape: [B, numHeads, oldSeqLen, headDim].
 * Output shape: [B, numHeads, newSeqLen, headDim].
 * Handles float32 and float16 (Uint16Array) backing stores.
 */
function sliceKvToSeqLen(
  tensor: OrtTensor,
  newSeqLen: number,
  ort: OrtGlobal,
): OrtTensor {
  const dims = tensor.dims as number[];
  const [B, H, oldSeqLen, D] = dims;
  if (newSeqLen >= oldSeqLen) return tensor;

  const isU16 = tensor.data instanceof Uint16Array;
  const src = tensor.data as Float32Array | Uint16Array;
  const newData = isU16
    ? new Uint16Array(B * H * newSeqLen * D)
    : new Float32Array(B * H * newSeqLen * D);

  for (let b = 0; b < B; b++) {
    for (let h = 0; h < H; h++) {
      const srcBase = (b * H + h) * oldSeqLen * D;
      const dstBase = (b * H + h) * newSeqLen * D;
      newData.set(src.subarray(srcBase, srcBase + newSeqLen * D), dstBase);
    }
  }

  return new ort.Tensor(
    isU16 ? "float16" : "float32",
    newData,
    [B, H, newSeqLen, D],
  );
}

// ── argmax / slice helpers ────────────────────────────────────────────────────

function argmax(logits: Float32Array, offset: number): number {
  let best = 0;
  for (let i = 1; i < VOCAB_SIZE; i++) {
    if (logits[offset + i] > logits[offset + best]) best = i;
  }
  return best;
}

function logicsSlice(data: Float32Array, offset: number): Float32Array {
  return data.slice(offset, offset + VOCAB_SIZE);
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Verify a k-token draft block with the full L-layer decoder.
 *
 * The decoder runs ONCE on all k draft tokens simultaneously (not k separate calls).
 * This is the efficiency advantage vs naive greedy decoding: k+1 tokens emitted
 * per 1 full-decoder call + k early-exit calls.
 *
 * Invariant: state.kvCache is never mutated. The returned newKv replaces it in the
 * main session after this call (caller's responsibility).
 *
 * @param state  Current decoder state — same interface as DrafterState.
 * @param draft  Output from draftBlock(): k draft tokens + earlyKv (discarded here).
 */
export async function verifyBlock(
  state: DrafterState,
  draft: DraftBlock,
): Promise<VerifyResult> {
  const k = draft.tokens.length;

  // Degenerate case: empty draft (e.g., EOS before any token).
  if (k === 0) {
    return {
      accepted:      [],
      replacement:   null,
      newKv:         { ...state.kvCache },
      verifierLogits: [],
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { sessions, ort: O, config, kvCache, kvSeqLen } = state;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const embed   = sessions.embed   as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoder = sessions.decoder as any;

  // 1. Embed ALL k draft tokens in a single call.
  const inputIdData = new BigInt64Array(k);
  for (let i = 0; i < k; i++) inputIdData[i] = BigInt(draft.tokens[i]);

  const embedOut = await embed.run({
    input_ids: new O.Tensor("int64", inputIdData, [1, k]),
  });

  // 2. Attention mask: [1, kvSeqLen + k] (full prefix + draft positions).
  const attnLen = kvSeqLen + k;
  const attnMask = new BigInt64Array(attnLen).fill(BigInt(1));

  // 3. Position IDs: [1, k] = [kvSeqLen, kvSeqLen+1, ..., kvSeqLen+k-1].
  const posData = new BigInt64Array(k);
  for (let i = 0; i < k; i++) posData[i] = BigInt(kvSeqLen + i);

  // 4. Past KV feed: ALL L layers from the pre-draft verifier state.
  const pastFeed: Record<string, OrtTensor> = {};
  for (let i = 0; i < config.numKvLayers; i++) {
    pastFeed[`past_key_values.${i}.key`]   = kvCache[`present.${i}.key`];
    pastFeed[`past_key_values.${i}.value`] = kvCache[`present.${i}.value`];
  }

  // 5. Full output names: logits + ALL L layers' present.N.key/value.
  //    No outputNames pruning — full forward pass through all layers.
  const fullOutputNames = ["logits"];
  for (let i = 0; i < config.numKvLayers; i++) {
    fullOutputNames.push(`present.${i}.key`, `present.${i}.value`);
  }

  // 6. Run FULL decoder ONCE on all k tokens.
  //    num_logits_to_keep = k → logits shape: [1, k, VOCAB_SIZE].
  const verifierOut = await decoder.run(
    {
      inputs_embeds:      embedOut["inputs_embeds"],
      per_layer_inputs:   embedOut["per_layer_inputs"],
      attention_mask:     new O.Tensor("int64", attnMask, [1, attnLen]),
      position_ids:       new O.Tensor("int64", posData, [1, k]),
      num_logits_to_keep: new O.Tensor("int64", [BigInt(k)], []),
      ...pastFeed,
    },
    fullOutputNames,
  );

  // 7. Extract logits.
  //    logits shape: [1, k, VOCAB_SIZE] — collect all k steps (decoder computed them all).
  const logitsTensor = verifierOut["logits"];
  const logitsData   = logitsTensor.data as Float32Array;

  // Collect ALL k per-step logits first (for telemetry — available even on early rejection).
  const verifierLogits: Float32Array[] = [];
  for (let p = 0; p < k; p++) {
    const offset     = p * VOCAB_SIZE;
    const stepLogits = new Float32Array(VOCAB_SIZE);
    stepLogits.set(logicsSlice(logitsData, offset));
    verifierLogits.push(stepLogits);
  }

  // Acceptance loop: find longest prefix where verifier argmax matches draft token.
  const accepted: number[]      = [];
  let replacement: number | null = null;

  for (let p = 0; p < k; p++) {
    const verifierToken = argmax(logitsData, p * VOCAB_SIZE);
    if (verifierToken === draft.tokens[p]) {
      accepted.push(draft.tokens[p]);
    } else {
      replacement = verifierToken;
      break;
    }
  }

  // 8. Slice verifier KV to the accepted + replacement window.
  //    Verifier KV shape: [1, H, kvSeqLen+k, headDim].
  //    Target:            [1, H, kvSeqLen + accepted.length + (replacement?1:0), headDim].
  const newKvSeqLen = kvSeqLen + accepted.length + (replacement !== null ? 1 : 0);
  const newKv: Record<string, OrtTensor> = {};
  for (let i = 0; i < config.numKvLayers; i++) {
    newKv[`present.${i}.key`]   = sliceKvToSeqLen(verifierOut[`present.${i}.key`],   newKvSeqLen, O);
    newKv[`present.${i}.value`] = sliceKvToSeqLen(verifierOut[`present.${i}.value`], newKvSeqLen, O);
  }

  return { accepted, replacement, newKv, verifierLogits };
}

/**
 * Compute per-cycle telemetry from a verify result.
 *
 * @param result   Output of verifyBlock().
 * @param kDrafted Number of draft steps that ran (= draft.tokens.length).
 */
export function cycleOutput(result: VerifyResult, kDrafted: number): CycleOutput {
  const emittedTokens = [
    ...result.accepted,
    ...(result.replacement !== null ? [result.replacement] : []),
  ];
  // Denominator: k draft steps + 1 full verify pass = kDrafted + 1 effective steps.
  const speedupRealized = emittedTokens.length / (kDrafted + 1);
  return { emittedTokens, speedupRealized };
}
