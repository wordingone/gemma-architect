// self-spec-verifier.test.ts — Unit tests for #1860 Sub-4 verifier + KV restore.
//
// All tests use a deterministic mock decoder — no real ONNX required.
// Run: bun test web/test/self-spec-verifier.test.ts

import { describe, expect, test } from "bun:test";
import type { DrafterState } from "../src/agent/self-spec-drafter";
import type { VerifyResult } from "../src/agent/self-spec-verifier";
import { verifyBlock, cycleOutput } from "../src/agent/self-spec-verifier";
import type { DraftBlock } from "../src/agent/self-spec-drafter";

// ── Constants ─────────────────────────────────────────────────────────────────

const NUM_KV_LAYERS = 15;
const HIDDEN_SIZE   = 1536;
const VOCAB_SIZE    = 262144;
const NUM_KV_HEADS  = 1;
const KV_HEAD_DIM   = 256;
const KV_SEQ_LEN    = 10;  // pre-draft verifier KV length

const E2B_CONFIG = {
  numKvLayers:    NUM_KV_LAYERS,
  numKvHeads:     NUM_KV_HEADS,
  lastSliding:    14,
  lastFull:       14,
  fullAttn:       new Set([4, 9, 14]),
  drafterKvWindow: 0,
  hiddenSize:     HIDDEN_SIZE,
};

// ── Mock helpers ──────────────────────────────────────────────────────────────

function mockTensor(
  type: string,
  data: number[] | BigInt64Array | Float32Array | Uint16Array,
  dims: number[],
) {
  return { type, data, dims };
}

function mockKvTensor(seqLen: number): object {
  return mockTensor(
    "float32",
    new Float32Array(NUM_KV_HEADS * seqLen * KV_HEAD_DIM),
    [1, NUM_KV_HEADS, seqLen, KV_HEAD_DIM],
  );
}

function buildVerifierKv(seqLen = KV_SEQ_LEN): Record<string, object> {
  const kv: Record<string, object> = {};
  for (let i = 0; i < NUM_KV_LAYERS; i++) {
    kv[`present.${i}.key`]   = mockKvTensor(seqLen);
    kv[`present.${i}.value`] = mockKvTensor(seqLen);
  }
  return kv;
}

function makeEmptyDraftBlock(): DraftBlock {
  return { tokens: [], earlyKv: [], earlyLogits: [] };
}

function makeDraftBlock(tokens: number[]): DraftBlock {
  return {
    tokens,
    earlyKv:     tokens.map(() => ({})),
    earlyLogits: tokens.map(() => new Float32Array(VOCAB_SIZE)),
  };
}

// ── Mock decoder factory ──────────────────────────────────────────────────────

/** Track decoder call count. */
let decoderCallCount = 0;

/**
 * Build a mock decoder that returns deterministic logits:
 * logits[0, p, verifierTokens[p]] = spike → argmax = verifierTokens[p].
 * KV output: present.N.key/value shaped [1, H, KV_SEQ_LEN + k, D].
 */
function makeMockDecoder(verifierTokens: number[]) {
  decoderCallCount = 0;
  return {
    async run(
      feed: Record<string, { dims?: number[] }>,
      _outputNames?: string[],
    ) {
      decoderCallCount++;
      const k = verifierTokens.length;
      const fullSeqLen = KV_SEQ_LEN + k;

      // Logits: [1, k, VOCAB_SIZE] with spike at verifierTokens[p] per position p
      const logitsData = new Float32Array(k * VOCAB_SIZE);
      for (let p = 0; p < k; p++) {
        const token = p < verifierTokens.length ? verifierTokens[p] : 99;
        logitsData[p * VOCAB_SIZE + token] = 10.0;
      }

      const result: Record<string, object> = {
        logits: mockTensor("float32", logitsData, [1, k, VOCAB_SIZE]),
      };

      // All L layers' KV — shape [1, H, KV_SEQ_LEN + k, D]
      for (let i = 0; i < NUM_KV_LAYERS; i++) {
        result[`present.${i}.key`]   = mockKvTensor(fullSeqLen);
        result[`present.${i}.value`] = mockKvTensor(fullSeqLen);
      }

      return result;
    },
  };
}

function makeMockEmbed() {
  return {
    async run(_feed: unknown) {
      return {
        inputs_embeds:    mockTensor("float32", new Float32Array(HIDDEN_SIZE), [1, 1, HIDDEN_SIZE]),
        per_layer_inputs: mockTensor("float32", new Float32Array(1), [1, 1, 1, 1]),
      };
    },
  };
}

function makeMockOrt() {
  return {
    Tensor: function(type: string, data: unknown, dims: number[]) {
      return mockTensor(type, data as Float32Array, dims);
    },
  };
}

function makeState(verifierTokens: number[]): DrafterState {
  return {
    sessions: {
      embed:   makeMockEmbed(),
      decoder: makeMockDecoder(verifierTokens),
    } as unknown as import("../src/agent/webgpu-mtp-backend").MtpSessions,
    ort:         makeMockOrt(),
    kvCache:     buildVerifierKv(),
    kvSeqLen:    KV_SEQ_LEN,
    config:      E2B_CONFIG,
    lastToken:   42,
    exitLayerKv: 5,
  };
}

// ── Test: all-accept ──────────────────────────────────────────────────────────

describe("all-accept: verifier matches all draft tokens", () => {
  test("all 4 tokens accepted, replacement null", async () => {
    const draftTokens    = [100, 200, 300, 400];
    const verifierTokens = [100, 200, 300, 400]; // full match

    const state = makeState(verifierTokens);
    const draft = makeDraftBlock(draftTokens);
    const result: VerifyResult = await verifyBlock(state, draft);

    expect(result.accepted).toEqual([100, 200, 300, 400]);
    expect(result.replacement).toBeNull();
    expect(result.verifierLogits).toHaveLength(4);
  });

  test("newKv seq length = kvSeqLen + k when all accepted", async () => {
    const k = 4;
    const draftTokens = [100, 200, 300, 400];
    const state = makeState([100, 200, 300, 400]);
    const result = await verifyBlock(state, makeDraftBlock(draftTokens));

    const expectedSeqLen = KV_SEQ_LEN + k;
    for (let i = 0; i < NUM_KV_LAYERS; i++) {
      const kv = result.newKv[`present.${i}.key`];
      expect(kv.dims[2]).toBe(expectedSeqLen);
    }
  });
});

// ── Test: mid-reject ──────────────────────────────────────────────────────────

describe("mid-reject: first mismatch at position 2", () => {
  test("first 2 accepted, replacement at position 2", async () => {
    const draftTokens    = [100, 200, 300, 400];
    const verifierTokens = [100, 200, 999, 888]; // mismatch at p=2

    const state = makeState(verifierTokens);
    const result = await verifyBlock(state, makeDraftBlock(draftTokens));

    expect(result.accepted).toEqual([100, 200]);
    expect(result.replacement).toBe(999);
  });

  test("newKv seq length = kvSeqLen + 2 + 1 (accepted + replacement)", async () => {
    const draftTokens    = [100, 200, 300, 400];
    const verifierTokens = [100, 200, 999, 888];

    const state = makeState(verifierTokens);
    const result = await verifyBlock(state, makeDraftBlock(draftTokens));

    const expectedSeqLen = KV_SEQ_LEN + 2 + 1; // accepted=2, replacement=1
    for (let i = 0; i < NUM_KV_LAYERS; i++) {
      expect(result.newKv[`present.${i}.key`].dims[2]).toBe(expectedSeqLen);
      expect(result.newKv[`present.${i}.value`].dims[2]).toBe(expectedSeqLen);
    }
  });

  test("verifierLogits has k entries even on mid-reject", async () => {
    const draftTokens    = [100, 200, 300, 400];
    const verifierTokens = [100, 200, 999, 888];

    const state  = makeState(verifierTokens);
    const result = await verifyBlock(state, makeDraftBlock(draftTokens));

    // verifierLogits always has k entries (all positions were computed by the decoder)
    expect(result.verifierLogits).toHaveLength(4);
    // Logit at mismatch position has spike at verifier's token (999)
    const misMatchLogit = result.verifierLogits[2];
    const argmaxAt2 = misMatchLogit.indexOf(Math.max(...misMatchLogit));
    expect(argmaxAt2).toBe(999);
  });
});

// ── Test: full-reject ─────────────────────────────────────────────────────────

describe("full-reject: all draft tokens mismatched", () => {
  test("0 accepted, replacement = verifier token at position 0", async () => {
    const draftTokens    = [100, 200, 300, 400];
    const verifierTokens = [555, 666, 777, 888]; // all mismatch

    const state  = makeState(verifierTokens);
    const result = await verifyBlock(state, makeDraftBlock(draftTokens));

    expect(result.accepted).toHaveLength(0);
    expect(result.replacement).toBe(555);
  });

  test("newKv seq length = kvSeqLen + 0 + 1 (no accepted, one replacement)", async () => {
    const state  = makeState([555, 666, 777, 888]);
    const result = await verifyBlock(state, makeDraftBlock([100, 200, 300, 400]));

    const expectedSeqLen = KV_SEQ_LEN + 1; // 0 accepted + 1 replacement
    for (let i = 0; i < NUM_KV_LAYERS; i++) {
      expect(result.newKv[`present.${i}.key`].dims[2]).toBe(expectedSeqLen);
    }
  });
});

// ── Test: decoder called exactly once ─────────────────────────────────────────

describe("decoder call count (run once per draft block)", () => {
  test("decoder.run called exactly once regardless of k", async () => {
    const state = makeState([100, 200, 300, 400]);
    decoderCallCount = 0;

    await verifyBlock(state, makeDraftBlock([100, 200, 300, 400]));

    expect(decoderCallCount).toBe(1);
  });

  test("decoder.run called once even on mid-reject (k=4)", async () => {
    const state = makeState([100, 200, 999, 888]);
    decoderCallCount = 0;

    await verifyBlock(state, makeDraftBlock([100, 200, 300, 400]));

    expect(decoderCallCount).toBe(1);
  });
});

// ── Test: KV non-leak guard ───────────────────────────────────────────────────

describe("KV-leak guard: state.kvCache never mutated", () => {
  test("state.kvCache object identity preserved after verifyBlock", async () => {
    const state = makeState([100, 200, 300, 400]);
    const kvRef = state.kvCache;
    const layer0KeyRef = kvRef["present.0.key"];

    await verifyBlock(state, makeDraftBlock([100, 200, 300, 400]));

    expect(state.kvCache).toBe(kvRef);
    expect(state.kvCache["present.0.key"]).toBe(layer0KeyRef);
  });

  test("newKv has ALL numKvLayers entries (no missing layers)", async () => {
    const state  = makeState([100, 200, 999, 888]);
    const result = await verifyBlock(state, makeDraftBlock([100, 200, 300, 400]));

    // Note: toHaveProperty("present.0.key") interprets dots as path separators in Bun.
    // Use direct property access instead.
    for (let i = 0; i < NUM_KV_LAYERS; i++) {
      expect(result.newKv[`present.${i}.key`]).toBeDefined();
      expect(result.newKv[`present.${i}.value`]).toBeDefined();
    }
    // No extra layers
    const keyCount = Object.keys(result.newKv).length;
    expect(keyCount).toBe(2 * NUM_KV_LAYERS);
  });

  test("newKv is NOT the same object as kvCache (verifier KV, not pre-draft KV)", async () => {
    const state  = makeState([100, 200, 300, 400]);
    const result = await verifyBlock(state, makeDraftBlock([100, 200, 300, 400]));

    // newKv is a fresh object derived from verifierOut, not state.kvCache
    expect(result.newKv).not.toBe(state.kvCache);
    expect(result.newKv["present.0.key"]).not.toBe(state.kvCache["present.0.key"]);
  });
});

// ── Test: empty draft block ───────────────────────────────────────────────────

describe("empty draft (EOS before any token)", () => {
  test("returns empty accepted, null replacement, shallow-copy of kvCache", async () => {
    const state  = makeState([]);
    const result = await verifyBlock(state, makeEmptyDraftBlock());

    expect(result.accepted).toHaveLength(0);
    expect(result.replacement).toBeNull();
    expect(result.verifierLogits).toHaveLength(0);
    // newKv is a shallow copy of kvCache (no verifier pass needed)
    expect(result.newKv["present.0.key"]).toBe(state.kvCache["present.0.key"]);
  });
});

// ── Test: cycleOutput telemetry ───────────────────────────────────────────────

describe("cycleOutput telemetry", () => {
  test("all-accept: emittedTokens = k, speedup = k/(k+1)", () => {
    const result: VerifyResult = {
      accepted:       [100, 200, 300, 400],
      replacement:    null,
      newKv:          {},
      verifierLogits: [],
    };
    const out = cycleOutput(result, 4);
    expect(out.emittedTokens).toEqual([100, 200, 300, 400]);
    expect(out.speedupRealized).toBeCloseTo(4 / 5, 5); // 4 tokens / 5 steps
  });

  test("mid-reject: emittedTokens = accepted + replacement", () => {
    const result: VerifyResult = {
      accepted:       [100, 200],
      replacement:    999,
      newKv:          {},
      verifierLogits: [],
    };
    const out = cycleOutput(result, 4);
    expect(out.emittedTokens).toEqual([100, 200, 999]);
    expect(out.speedupRealized).toBeCloseTo(3 / 5, 5);
  });

  test("full-reject: emittedTokens = [replacement], speedup < 1", () => {
    const result: VerifyResult = {
      accepted:       [],
      replacement:    555,
      newKv:          {},
      verifierLogits: [],
    };
    const out = cycleOutput(result, 4);
    expect(out.emittedTokens).toEqual([555]);
    expect(out.speedupRealized).toBeCloseTo(1 / 5, 5); // worse than greedy
  });
});

// ── Test: KV slice correctness ────────────────────────────────────────────────

describe("KV slice — verifier KV is source of truth, not drafter KV", () => {
  test("verifier KV dims before slice match kvSeqLen + k", async () => {
    // The verifier ran on k=3 tokens with kvSeqLen=10
    // Before slice, present.N.key should be [1, H, 13, D]
    // After slice to 10+2+1=13 (all accepted), no-op → still 13

    const k = 3;
    const state = makeState([100, 200, 300]);
    const result = await verifyBlock(state, makeDraftBlock([100, 200, 300]));

    // All accepted → newKvSeqLen = 10+3+0 = 13
    expect(result.newKv["present.0.key"].dims[2]).toBe(KV_SEQ_LEN + k);
  });

  test("KV slice shrinks on partial accept: dims[2] < kvSeqLen + k", async () => {
    // k=4, reject at p=1 → accepted=1, replacement=1 → newKvSeqLen=10+1+1=12 < 14
    const state  = makeState([100, 999, 777, 888]); // mismatch at p=1
    const result = await verifyBlock(state, makeDraftBlock([100, 200, 300, 400]));

    expect(result.accepted).toEqual([100]);
    expect(result.replacement).toBe(999);

    const expected = KV_SEQ_LEN + 1 + 1; // 12
    for (let i = 0; i < NUM_KV_LAYERS; i++) {
      expect(result.newKv[`present.${i}.key`].dims[2]).toBe(expected);
    }
  });
});
