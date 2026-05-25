// self-spec-drafter.test.ts — Unit tests for #1860 Sub-3 drafter loop.
//
// All tests use a deterministic mock ORT session — no real ONNX files required.
// Run: bun test web/test/self-spec-drafter.test.ts

import { describe, expect, test, mock } from "bun:test";
import type { DrafterState, DraftBlock } from "../src/agent/self-spec-drafter";
import { draftBlock, exitLayerKvFromMetadata } from "../src/agent/self-spec-drafter";

// ── Config constants matching E2B anatomy ─────────────────────────────────────

const NUM_KV_LAYERS = 15;
const EXIT_LAYER_KV = 5;          // E2B r=0.33
const HIDDEN_SIZE    = 1536;
const VOCAB_SIZE     = 262144;
const NUM_KV_HEADS   = 1;
const KV_HEAD_DIM    = 256;

const E2B_CONFIG = {
  numKvLayers:    NUM_KV_LAYERS,
  numKvHeads:     NUM_KV_HEADS,
  lastSliding:    14,
  lastFull:       14,
  fullAttn:       new Set([4, 9, 14]),
  drafterKvWindow: 0,
  hiddenSize:     HIDDEN_SIZE,
};

// ── Mock tensor factory ───────────────────────────────────────────────────────

function mockTensor(
  type: string,
  data: number[] | BigInt64Array | Float32Array,
  dims: number[],
) {
  return { type, data, dims };
}

function mockKvTensor(): object {
  return mockTensor("float16", new Float32Array(NUM_KV_HEADS * KV_HEAD_DIM), [1, NUM_KV_HEADS, 1, KV_HEAD_DIM]);
}

/** Build a fake verifier KV for all 15 layers. */
function buildVerifierKv(): Record<string, object> {
  const kv: Record<string, object> = {};
  for (let i = 0; i < NUM_KV_LAYERS; i++) {
    kv[`present.${i}.key`]   = mockKvTensor();
    kv[`present.${i}.value`] = mockKvTensor();
  }
  return kv;
}

// ── Mock ORT session factory ──────────────────────────────────────────────────

/** Captures which outputNames were requested in each decoder.run() call. */
const capturedOutputNames: string[][] = [];
/** Token sequence returned by mock: token d → (d+1)*100 by default */
let mockTokenSequence: number[] = [];
let mockTokenIdx = 0;

function makeMockEmbedSession() {
  return {
    async run(_feed: unknown) {
      return {
        inputs_embeds:    mockTensor("float32", new Float32Array(HIDDEN_SIZE), [1, 1, HIDDEN_SIZE]),
        per_layer_inputs: mockTensor("float32", new Float32Array(1), [1, 1, 1, 1]),
      };
    },
  };
}

function makeMockDecoderSession() {
  return {
    async run(_feed: unknown, outputNames?: string[]) {
      capturedOutputNames.push(outputNames ?? []);

      // Build the result map — only include requested outputs
      const result: Record<string, object> = {};
      const requested = new Set(outputNames ?? []);

      // logits_early_exit: put a spike at the next mock token ID
      if (requested.has("logits_early_exit")) {
        const data = new Float32Array(VOCAB_SIZE);
        const tokenId = mockTokenIdx < mockTokenSequence.length
          ? mockTokenSequence[mockTokenIdx]
          : (mockTokenIdx + 1) * 100;
        data[tokenId] = 10.0;  // spike → argmax will pick this token
        mockTokenIdx++;
        result["logits_early_exit"] = mockTensor("float32", data, [1, 1, VOCAB_SIZE]);
      }

      // KV outputs for requested present.N.key/value
      for (const name of requested) {
        if (name.startsWith("present.")) {
          result[name] = mockKvTensor();
        }
      }

      return result;
    },
  };
}

function makeMockOrt() {
  return {
    Tensor: function(type: string, data: unknown[], dims: number[]) {
      return mockTensor(type, data as number[], dims);
    },
  };
}

// ── Helper: build DrafterState ────────────────────────────────────────────────

function makeDrafterState(overrides: Partial<DrafterState> = {}): DrafterState {
  return {
    sessions: {
      embed:   makeMockEmbedSession(),
      decoder: makeMockDecoderSession(),
    } as unknown as import("../src/agent/webgpu-mtp-backend").MtpSessions,
    ort:         makeMockOrt(),
    kvCache:     buildVerifierKv(),
    kvSeqLen:    10,
    config:      E2B_CONFIG,
    lastToken:   42,
    exitLayerKv: EXIT_LAYER_KV,
    ...overrides,
  };
}

// ── Test: draftOutputNames (internal shape check via black-box) ───────────────

describe("draftBlock output shape", () => {
  test("returns k tokens for k draft steps (no EOS)", async () => {
    capturedOutputNames.length = 0;
    mockTokenSequence = [100, 200, 300];  // 3 distinct non-EOS tokens
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const result: DraftBlock = await draftBlock(state, 3);

    expect(result.tokens).toHaveLength(3);
    expect(result.tokens).toEqual([100, 200, 300]);
    expect(result.earlyKv).toHaveLength(3);
    expect(result.earlyLogits).toHaveLength(3);
  });

  test("earlyLogits per step has VOCAB_SIZE elements", async () => {
    mockTokenSequence = [500];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const result = await draftBlock(state, 1);

    expect(result.earlyLogits[0]).toHaveLength(VOCAB_SIZE);
    // Argmax should be at the mock spike position
    const argmax = result.earlyLogits[0].indexOf(Math.max(...result.earlyLogits[0]));
    expect(argmax).toBe(500);
  });
});

// ── Test: ORT output name pruning ─────────────────────────────────────────────

describe("ORT output name pruning", () => {
  test("decoder.run receives logits_early_exit + present.0..exitLayerKv.key/value only", async () => {
    capturedOutputNames.length = 0;
    mockTokenSequence = [200];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    await draftBlock(state, 1);

    expect(capturedOutputNames).toHaveLength(1);
    const requested = capturedOutputNames[0];

    // Must include logits_early_exit
    expect(requested).toContain("logits_early_exit");

    // Must include present.0..exitLayerKv.key/value (0..5 for E2B)
    for (let i = 0; i <= EXIT_LAYER_KV; i++) {
      expect(requested).toContain(`present.${i}.key`);
      expect(requested).toContain(`present.${i}.value`);
    }

    // Must NOT include layers beyond exitLayerKv
    for (let i = EXIT_LAYER_KV + 1; i < NUM_KV_LAYERS; i++) {
      expect(requested).not.toContain(`present.${i}.key`);
      expect(requested).not.toContain(`present.${i}.value`);
    }
  });

  test("requested output count = 1 + 2*(exitLayerKv+1)", async () => {
    capturedOutputNames.length = 0;
    mockTokenSequence = [300];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    await draftBlock(state, 1);

    const expectedCount = 1 + 2 * (EXIT_LAYER_KV + 1);  // 1 + 2*6 = 13
    expect(capturedOutputNames[0]).toHaveLength(expectedCount);
  });
});

// ── Test: KV non-mutation guard ───────────────────────────────────────────────

describe("verifier KV non-mutation", () => {
  test("state.kvCache is identical object after draftBlock (not mutated)", async () => {
    mockTokenSequence = [100, 200, 300];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const kvCacheRef = state.kvCache;

    // Snapshot keys and object identity before
    const keysBefore = Object.keys(kvCacheRef).sort().join(",");
    const layer0KeyRef = kvCacheRef["present.0.key"];
    const layer14KeyRef = kvCacheRef[`present.${NUM_KV_LAYERS - 1}.key`];

    await draftBlock(state, 3);

    // Same object reference — not replaced
    expect(state.kvCache).toBe(kvCacheRef);
    // Key set unchanged
    expect(Object.keys(state.kvCache).sort().join(",")).toBe(keysBefore);
    // Individual tensor objects unchanged (no in-place mutation)
    expect(state.kvCache["present.0.key"]).toBe(layer0KeyRef);
    expect(state.kvCache[`present.${NUM_KV_LAYERS - 1}.key`]).toBe(layer14KeyRef);
  });

  test("earlyKv per step contains ONLY layers 0..exitLayerKv", async () => {
    mockTokenSequence = [400, 500];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const result = await draftBlock(state, 2);

    for (let d = 0; d < 2; d++) {
      const stepKvKeys = Object.keys(result.earlyKv[d]);
      // Must have exactly 2*(exitLayerKv+1) entries
      expect(stepKvKeys).toHaveLength(2 * (EXIT_LAYER_KV + 1));
      // No layer beyond exitLayerKv
      for (const key of stepKvKeys) {
        const match = key.match(/present\.(\d+)\./);
        expect(match).not.toBeNull();
        const layerIdx = parseInt(match![1], 10);
        expect(layerIdx).toBeLessThanOrEqual(EXIT_LAYER_KV);
      }
    }
  });
});

// ── Test: EOS early stop ──────────────────────────────────────────────────────

describe("EOS early stop", () => {
  test("stops at EOS token (default eosId=1), returns fewer than k tokens", async () => {
    // Second token is EOS (id=1) — should stop after 2 tokens
    mockTokenSequence = [100, 1, 200, 300];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const result = await draftBlock(state, 4);

    // Should stop at token idx 1 (EOS), returning [100, 1]
    expect(result.tokens).toHaveLength(2);
    expect(result.tokens[1]).toBe(1);
    expect(result.earlyKv).toHaveLength(2);
  });

  test("custom eosId stops early when that token appears", async () => {
    mockTokenSequence = [100, 200, 999, 300];  // 999 = custom EOS
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const result = await draftBlock(state, 5, 999);

    expect(result.tokens).toHaveLength(3);
    expect(result.tokens[2]).toBe(999);
  });

  test("no early stop when no EOS in sequence", async () => {
    mockTokenSequence = [100, 200, 300];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const result = await draftBlock(state, 3);

    expect(result.tokens).toHaveLength(3);
  });
});

// ── Test: exitLayerKvFromMetadata ─────────────────────────────────────────────

describe("exitLayerKvFromMetadata", () => {
  test("reads exit_layer_kv_index from metadata", () => {
    const meta = { exit_layer_kv_index: "5" };
    expect(exitLayerKvFromMetadata(meta, E2B_CONFIG)).toBe(5);
  });

  test("falls back to Math.floor(numKvLayers/3) when metadata is null", () => {
    const fallback = exitLayerKvFromMetadata(null, E2B_CONFIG);
    expect(fallback).toBe(Math.floor(NUM_KV_LAYERS / 3));  // 5 for E2B
  });

  test("falls back when exit_layer_kv_index is out of range", () => {
    const meta = { exit_layer_kv_index: "999" };
    expect(exitLayerKvFromMetadata(meta, E2B_CONFIG)).toBe(Math.floor(NUM_KV_LAYERS / 3));
  });

  test("E4B config: floor(24/3) = 8 as fallback", () => {
    const e4bConfig = { ...E2B_CONFIG, numKvLayers: 24 };
    expect(exitLayerKvFromMetadata(undefined, e4bConfig)).toBe(8);
  });
});

// ── Test: KV feed routing across multi-step draft ─────────────────────────────

describe("multi-step KV accumulation", () => {
  test("k=3 draft produces k earlyKv entries each with correct layer range", async () => {
    mockTokenSequence = [111, 222, 333];
    mockTokenIdx = 0;

    const state = makeDrafterState();
    const result = await draftBlock(state, 3);

    expect(result.earlyKv).toHaveLength(3);
    for (const stepKv of result.earlyKv) {
      // Each step should have exactly 2 * (EXIT_LAYER_KV + 1) KV tensors
      const keys = Object.keys(stepKv);
      expect(keys).toHaveLength(2 * (EXIT_LAYER_KV + 1));
    }
  });

  test("position_ids advance: kvSeqLen + d for draft step d", async () => {
    // Track position_ids via a custom mock that records them
    const seenPositions: number[] = [];
    mockTokenSequence = [100, 200];
    mockTokenIdx = 0;

    const embedMock = {
      async run(_feed: unknown) {
        return {
          inputs_embeds:    mockTensor("float32", new Float32Array(HIDDEN_SIZE), [1, 1, HIDDEN_SIZE]),
          per_layer_inputs: mockTensor("float32", new Float32Array(1), [1, 1, 1, 1]),
        };
      },
    };

    const decoderMock = {
      async run(feed: Record<string, { data: BigInt64Array | number[] }>, outputNames?: string[]) {
        const posData = feed["position_ids"]?.data;
        if (posData instanceof BigInt64Array) seenPositions.push(Number(posData[0]));
        else if (Array.isArray(posData)) seenPositions.push(Number(posData[0]));

        const result: Record<string, object> = {};
        const requested = new Set(outputNames ?? []);
        if (requested.has("logits_early_exit")) {
          const data = new Float32Array(VOCAB_SIZE);
          const tokenId = seenPositions.length <= mockTokenSequence.length
            ? mockTokenSequence[seenPositions.length - 1]
            : 99;
          data[tokenId] = 10.0;
          result["logits_early_exit"] = mockTensor("float32", data, [1, 1, VOCAB_SIZE]);
        }
        for (const name of requested) {
          if (name.startsWith("present.")) result[name] = mockKvTensor();
        }
        return result;
      },
    };

    const state = makeDrafterState({
      sessions: { embed: embedMock, decoder: decoderMock } as unknown as import("../src/agent/webgpu-mtp-backend").MtpSessions,
      kvSeqLen: 10,
    });

    await draftBlock(state, 2);

    // Step 0: position = kvSeqLen + 0 = 10
    // Step 1: position = kvSeqLen + 1 = 11
    expect(seenPositions).toHaveLength(2);
    expect(seenPositions[0]).toBe(10);
    expect(seenPositions[1]).toBe(11);
  });
});
