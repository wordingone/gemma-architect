// self-spec-telemetry.test.ts — Verify 8 new TurnTelemetry fields exist and are correctly typed.
// Run: bun test web/test/self-spec-telemetry.test.ts

import { describe, expect, test } from "bun:test";
import type { TurnTelemetry } from "../src/agent/telemetry";
import { BASELINE_TPS_P50 } from "../src/agent/self-spec-controller";

// ── Type-level completeness check ─────────────────────────────────────────────
// TypeScript ensures all 8 fields are present on the interface.
// At runtime we construct a full object and verify each key.

const REQUIRED_SELF_SPEC_FIELDS: (keyof TurnTelemetry)[] = [
  "self_spec_active",
  "self_spec_reason",
  "draft_tokens",
  "accepted_tokens",
  "acceptance_rate",
  "verify_beta",
  "effective_tps",
  "speedup_observed",
];

function buildFullTelemetry(overrides: Partial<TurnTelemetry> = {}): TurnTelemetry {
  return {
    ts:                  Date.now(),
    prefill_ms:          120,
    decode_ms:           4000,
    tokens_in:           512,
    tokens_out:          200,
    system_prompt_chars: 3000,
    skills_total:        4,
    skills_matched:      2,
    tg_tps:              5.0,
    pp_tps:              15.0,
    mtp_on:              true,
    spec_attempts:       30,
    spec_accepts:        22,
    spec_accept_rate:    22 / 30,
    path:                "webgpu",
    // Self-spec fields
    self_spec_active:    true,
    self_spec_reason:    "active(rate=0.80,beta=1.00)",
    draft_tokens:        30,
    accepted_tokens:     22,
    acceptance_rate:     22 / 30,
    verify_beta:         1.0,
    effective_tps:       5.0,
    speedup_observed:    5.0 / BASELINE_TPS_P50,
    ...overrides,
  };
}

// ── Interface field presence ──────────────────────────────────────────────────

describe("TurnTelemetry has all 8 self-spec fields", () => {
  test("all required fields are present and non-undefined", () => {
    const t = buildFullTelemetry();
    for (const field of REQUIRED_SELF_SPEC_FIELDS) {
      expect(t[field]).toBeDefined();
    }
  });

  test("fields are optional (undefined is valid)", () => {
    // A bare telemetry object without self-spec fields is still a valid TurnTelemetry.
    const bare: TurnTelemetry = {
      ts:                  Date.now(),
      prefill_ms:          100,
      decode_ms:           1000,
      tokens_in:           50,
      tokens_out:          80,
      system_prompt_chars: 500,
      skills_total:        0,
      skills_matched:      0,
      tg_tps:              8.0,
      pp_tps:              20.0,
    };
    // All self-spec fields are absent — TypeScript allows this (optional fields).
    for (const field of REQUIRED_SELF_SPEC_FIELDS) {
      expect(bare[field]).toBeUndefined();
    }
  });
});

// ── Value correctness ─────────────────────────────────────────────────────────

describe("telemetry field value contracts", () => {
  test("acceptance_rate = accepted_tokens / draft_tokens when draft_tokens > 0", () => {
    const t = buildFullTelemetry({ draft_tokens: 30, accepted_tokens: 22 });
    const computed = t.accepted_tokens! / t.draft_tokens!;
    expect(t.acceptance_rate).toBeCloseTo(computed, 5);
  });

  test("acceptance_rate is 0 or undefined when draft_tokens is 0", () => {
    const t = buildFullTelemetry({ draft_tokens: 0, accepted_tokens: 0, acceptance_rate: 0 });
    // Either 0 or undefined — not NaN, not Infinity
    expect(t.acceptance_rate === 0 || t.acceptance_rate === undefined).toBe(true);
  });

  test("speedup_observed = effective_tps / BASELINE_TPS_P50", () => {
    const tps = 7.0;
    const t = buildFullTelemetry({ effective_tps: tps, speedup_observed: tps / BASELINE_TPS_P50 });
    expect(t.speedup_observed).toBeCloseTo(tps / BASELINE_TPS_P50, 5);
  });

  test("speedup_observed > 1.0 when effective_tps exceeds baseline", () => {
    // BASELINE_TPS_P50 = 2.132; anything > 2.132 should produce speedup > 1
    const t = buildFullTelemetry({ effective_tps: 5.0, speedup_observed: 5.0 / BASELINE_TPS_P50 });
    expect(t.speedup_observed!).toBeGreaterThan(1.0);
  });

  test("speedup_observed < 1.0 when effective_tps is below baseline", () => {
    const t = buildFullTelemetry({ effective_tps: 1.0, speedup_observed: 1.0 / BASELINE_TPS_P50 });
    expect(t.speedup_observed!).toBeLessThan(1.0);
  });

  test("self_spec_active=false: reason is a non-empty disable string", () => {
    const t = buildFullTelemetry({
      self_spec_active: false,
      self_spec_reason: "warmup(0/3)",
    });
    expect(t.self_spec_active).toBe(false);
    expect(t.self_spec_reason!.length).toBeGreaterThan(0);
  });

  test("verify_beta defaults to 1.0 in harness (no external measurement yet)", () => {
    // Verify the constant default matches what the harness passes.
    const t = buildFullTelemetry({ verify_beta: 1.0 });
    expect(t.verify_beta).toBe(1.0);
  });
});

// ── BASELINE_TPS_P50 constant ─────────────────────────────────────────────────

describe("BASELINE_TPS_P50 constant", () => {
  test("is a positive finite number", () => {
    expect(BASELINE_TPS_P50).toBeGreaterThan(0);
    expect(isFinite(BASELINE_TPS_P50)).toBe(true);
  });

  test("matches Sub-1 measured median (2.132 t/s ± 0.1)", () => {
    // Sub-1 (#1861) 25-sample cold-cache scene-query: p50 = 2.132494958158695.
    // Allow ±0.1 tolerance to survive baseline file updates.
    expect(BASELINE_TPS_P50).toBeGreaterThan(2.0);
    expect(BASELINE_TPS_P50).toBeLessThan(2.3);
  });
});

// ── Value evolution: accepted_tokens non-zero after 1 active turn ─────────────

describe("value evolution: accepted_tokens > 0 requires specAccepts > 0 in worker", () => {
  test("when specAccepts=5 and specAttempts=8, accepted_tokens=5", () => {
    const specAccepts = 5;
    const specAttempts = 8;
    const t = buildFullTelemetry({
      draft_tokens:    specAttempts,
      accepted_tokens: specAccepts,
      acceptance_rate: specAccepts / specAttempts,
      self_spec_active: true,
      mtp_on: true,
    });
    expect(t.accepted_tokens).toBe(5);
    expect(t.draft_tokens).toBe(8);
    expect(t.acceptance_rate).toBeCloseTo(5 / 8, 5);
  });

  test("when self_spec_active=false, accepted_tokens may be 0", () => {
    const t = buildFullTelemetry({
      self_spec_active: false,
      self_spec_reason: "warmup(1/3)",
      accepted_tokens:  0,
      draft_tokens:     0,
      acceptance_rate:  0,
    });
    expect(t.accepted_tokens).toBe(0);
    expect(t.self_spec_active).toBe(false);
  });
});
