// self-spec-ab-harness.test.ts — Unit tests for #1860 Sub-7: A/B harness receipt computation.
// Tests: p50(), computeMetrics(), evaluateGates(), buildReceipt().
// All computation is pure (no CDP, no DOM).
// Run: bun test web/test/self-spec-ab-harness.test.ts

import { describe, expect, test } from "bun:test";
import {
  p50,
  computeMetrics,
  evaluateGates,
  buildReceipt,
  SPEEDUP_THRESHOLD,
  ACCEPTANCE_THRESHOLD,
  VERIFY_BETA_THRESHOLD,
} from "../../scripts/self-spec-acceptance-receipt.mjs";

// ── p50 ───────────────────────────────────────────────────────────────────────

describe("p50: median of numeric array", () => {
  test("empty array returns 0", () => {
    expect(p50([])).toBe(0);
  });

  test("undefined/null returns 0", () => {
    expect(p50(undefined as unknown as number[])).toBe(0);
    expect(p50(null as unknown as number[])).toBe(0);
  });

  test("single element returns that element", () => {
    expect(p50([42])).toBe(42);
    expect(p50([3.14])).toBeCloseTo(3.14, 5);
  });

  test("odd-length sorted array: middle element", () => {
    expect(p50([1, 2, 3])).toBe(2);
    expect(p50([10, 20, 30, 40, 50])).toBe(30);
  });

  test("even-length sorted array: average of two middle elements", () => {
    expect(p50([1, 2, 3, 4])).toBe(2.5);
    expect(p50([10, 20, 30, 40])).toBe(25);
  });

  test("unsorted input: correctly sorts before finding median", () => {
    expect(p50([5, 1, 3])).toBe(3);
    expect(p50([100, 1, 50, 25])).toBe(37.5);
  });

  test("does not mutate input array", () => {
    const arr = [3, 1, 2];
    p50(arr);
    expect(arr).toEqual([3, 1, 2]);
  });

  test("all-same values: returns that value", () => {
    expect(p50([2.0, 2.0, 2.0])).toBe(2.0);
  });

  test("two elements: exact average", () => {
    expect(p50([1.0, 3.0])).toBe(2.0);
  });
});

// ── computeMetrics ────────────────────────────────────────────────────────────

function makeASample(tg_tps: number): object {
  return { tg_tps, self_spec_active: false };
}

function makeBSampleActive(effective_tps: number, acceptance_rate: number, verify_beta = 1.0): object {
  return {
    effective_tps,
    tg_tps: effective_tps,
    self_spec_active: true,
    acceptance_rate,
    verify_beta,
    self_spec_device_lost: false,
    self_spec_oom: false,
  };
}

function makeBSampleInactive(tg_tps: number): object {
  return {
    tg_tps,
    effective_tps: tg_tps,
    self_spec_active: false,
    self_spec_device_lost: false,
    self_spec_oom: false,
  };
}

describe("computeMetrics: derives p50 values from A/B sample arrays", () => {
  test("speedup_p50 = pathB_tps_p50 / pathA_tps_p50", () => {
    const pathA = [makeASample(2.0), makeASample(2.0), makeASample(2.0)];
    const pathB = [makeBSampleActive(3.0, 0.90), makeBSampleActive(3.0, 0.90), makeBSampleActive(3.0, 0.90)];
    const m = computeMetrics(pathA, pathB);
    expect(m.speedup_p50).toBeCloseTo(1.5, 5);
    expect(m.pathA_tps_p50).toBeCloseTo(2.0, 5);
    expect(m.pathB_tps_p50).toBeCloseTo(3.0, 5);
  });

  test("speedup_p50 = 0 when pathA samples are empty", () => {
    const m = computeMetrics([], [makeBSampleActive(3.0, 0.9)]);
    expect(m.speedup_p50).toBe(0);
  });

  test("acceptance_rate_p50 only counts self_spec_active=true turns", () => {
    // Mix of active and inactive turns: only active ones should count
    const pathB = [
      makeBSampleActive(3.0, 0.85),
      makeBSampleActive(3.0, 0.90),
      makeBSampleActive(3.0, 0.80),
      makeBSampleInactive(2.5), // should NOT contribute to acceptance_rate
    ];
    const m = computeMetrics([], pathB);
    // p50 of [0.85, 0.90, 0.80] = 0.85
    expect(m.acceptance_rate_p50).toBeCloseTo(0.85, 5);
    expect(m.n_path_b_active).toBe(3);
  });

  test("acceptance_rate_p50 = 0 when no active turns in pathB", () => {
    const pathB = [makeBSampleInactive(2.5), makeBSampleInactive(2.5)];
    const m = computeMetrics([], pathB);
    expect(m.acceptance_rate_p50).toBe(0);
    expect(m.n_path_b_active).toBe(0);
  });

  test("verify_beta_p50 from active turns only", () => {
    const pathB = [
      makeBSampleActive(3.0, 0.9, 1.10),
      makeBSampleActive(3.0, 0.9, 1.20),
      makeBSampleActive(3.0, 0.9, 1.30),
    ];
    const m = computeMetrics([], pathB);
    expect(m.verify_beta_p50).toBeCloseTo(1.20, 5);
  });

  test("verify_beta_p50 defaults to 1.0 when no active turns", () => {
    const m = computeMetrics([], [makeBSampleInactive(2.0)]);
    expect(m.verify_beta_p50).toBeCloseTo(1.0, 5);
  });

  test("deviceLostCount counts self_spec_device_lost=true entries in pathB", () => {
    const pathB = [
      makeBSampleActive(3.0, 0.9),
      { ...makeBSampleActive(3.0, 0.9), self_spec_device_lost: true },
      { ...makeBSampleActive(3.0, 0.9), self_spec_device_lost: true },
    ];
    const m = computeMetrics([], pathB);
    expect(m.deviceLostCount).toBe(2);
  });

  test("oomCount counts self_spec_oom=true entries in pathB", () => {
    const pathB = [
      makeBSampleActive(3.0, 0.9),
      { ...makeBSampleActive(3.0, 0.9), self_spec_oom: true },
    ];
    const m = computeMetrics([], pathB);
    expect(m.oomCount).toBe(1);
  });

  test("n_path_a, n_path_b counts all samples regardless of active flag", () => {
    const pathA = [makeASample(2.0), makeASample(2.0)];
    const pathB = [makeBSampleActive(3.0, 0.9), makeBSampleInactive(2.5)];
    const m = computeMetrics(pathA, pathB);
    expect(m.n_path_a).toBe(2);
    expect(m.n_path_b).toBe(2);
  });

  test("both empty arrays: all zeros", () => {
    const m = computeMetrics([], []);
    expect(m.speedup_p50).toBe(0);
    expect(m.acceptance_rate_p50).toBe(0);
    expect(m.deviceLostCount).toBe(0);
    expect(m.oomCount).toBe(0);
  });
});

// ── evaluateGates ─────────────────────────────────────────────────────────────

function passingMetrics(): ReturnType<typeof computeMetrics> {
  return {
    pathA_tps_p50:       2.0,
    pathB_tps_p50:       3.0,
    speedup_p50:         1.50,          // ≥ 1.35 ✓
    acceptance_rate_p50: 0.85,          // ≥ 0.80 ✓
    verify_beta_p50:     1.10,          // ≤ 1.30 ✓
    deviceLostCount:     0,             // = 0 ✓
    oomCount:            0,             // = 0 ✓
    n_path_a: 3, n_path_b: 3, n_path_b_active: 3,
  };
}

describe("evaluateGates: applies 5 acceptance thresholds", () => {
  test("all gates pass → passed:true", () => {
    const { gates, passed } = evaluateGates(passingMetrics());
    expect(passed).toBe(true);
    expect(gates.speedup_gte_1_35).toBe(true);
    expect(gates.acceptance_rate_gte_0_80).toBe(true);
    expect(gates.verify_beta_lte_1_30).toBe(true);
    expect(gates.zero_device_lost).toBe(true);
    expect(gates.zero_oom).toBe(true);
  });

  test("speedup exactly at threshold → passes (≥ not >)", () => {
    const m = { ...passingMetrics(), speedup_p50: SPEEDUP_THRESHOLD };
    const { gates } = evaluateGates(m);
    expect(gates.speedup_gte_1_35).toBe(true);
  });

  test("speedup below threshold → passed:false", () => {
    const m = { ...passingMetrics(), speedup_p50: SPEEDUP_THRESHOLD - 0.01 };
    const { gates, passed } = evaluateGates(m);
    expect(gates.speedup_gte_1_35).toBe(false);
    expect(passed).toBe(false);
  });

  test("acceptance_rate exactly at threshold → passes", () => {
    const m = { ...passingMetrics(), acceptance_rate_p50: ACCEPTANCE_THRESHOLD };
    expect(evaluateGates(m).gates.acceptance_rate_gte_0_80).toBe(true);
  });

  test("acceptance_rate below threshold → passed:false", () => {
    const m = { ...passingMetrics(), acceptance_rate_p50: ACCEPTANCE_THRESHOLD - 0.01 };
    const { gates, passed } = evaluateGates(m);
    expect(gates.acceptance_rate_gte_0_80).toBe(false);
    expect(passed).toBe(false);
  });

  test("verify_beta exactly at threshold → passes (≤ not <)", () => {
    const m = { ...passingMetrics(), verify_beta_p50: VERIFY_BETA_THRESHOLD };
    expect(evaluateGates(m).gates.verify_beta_lte_1_30).toBe(true);
  });

  test("verify_beta above threshold → passed:false", () => {
    const m = { ...passingMetrics(), verify_beta_p50: VERIFY_BETA_THRESHOLD + 0.01 };
    const { gates, passed } = evaluateGates(m);
    expect(gates.verify_beta_lte_1_30).toBe(false);
    expect(passed).toBe(false);
  });

  test("one device-lost event → passed:false", () => {
    const m = { ...passingMetrics(), deviceLostCount: 1 };
    const { gates, passed } = evaluateGates(m);
    expect(gates.zero_device_lost).toBe(false);
    expect(passed).toBe(false);
  });

  test("one OOM event → passed:false", () => {
    const m = { ...passingMetrics(), oomCount: 1 };
    const { gates, passed } = evaluateGates(m);
    expect(gates.zero_oom).toBe(false);
    expect(passed).toBe(false);
  });

  test("multiple gates failing: passed:false, all failing gates false", () => {
    const m = {
      ...passingMetrics(),
      speedup_p50:         1.20,  // FAIL
      acceptance_rate_p50: 0.70,  // FAIL
      oomCount:            2,     // FAIL
    };
    const { gates, passed } = evaluateGates(m);
    expect(passed).toBe(false);
    expect(gates.speedup_gte_1_35).toBe(false);
    expect(gates.acceptance_rate_gte_0_80).toBe(false);
    expect(gates.zero_oom).toBe(false);
    // Passing gates are still true
    expect(gates.verify_beta_lte_1_30).toBe(true);
    expect(gates.zero_device_lost).toBe(true);
  });
});

// ── buildReceipt ──────────────────────────────────────────────────────────────

const SAMPLE_PROMPTS = [
  "Build a 16-foot wide, 8-foot tall exterior wall.",
  "What's currently in the scene? Describe all dimensions in feet.",
];

describe("buildReceipt: assembles full receipt from A/B samples", () => {
  function makeSamples(tps: number, rate: number, n = 3): object[] {
    return Array.from({ length: n }, () => makeBSampleActive(tps, rate));
  }

  test("receipt has all required top-level fields", () => {
    const r = buildReceipt(
      [makeASample(2.0), makeASample(2.0)],
      makeSamples(3.0, 0.85),
      { sha: "abc1234", prompts: SAMPLE_PROMPTS, n_turns_per_prompt: 3 },
    );
    expect(r.sha).toBe("abc1234");
    expect(r.cold_cache).toBe(true);
    expect(r.n_prompts).toBe(2);
    expect(r.n_turns_per_prompt).toBe(3);
    expect(r.prompts).toEqual(SAMPLE_PROMPTS);
    expect(r.metrics).toBeDefined();
    expect(r.gates).toBeDefined();
    expect(typeof r.passed).toBe("boolean");
    expect(typeof r.ts).toBe("string");
  });

  test("receipt.passed=true when all gates pass (speedup ≥ 1.35, rate ≥ 0.80, beta ≤ 1.30)", () => {
    const pathA = [makeASample(2.0), makeASample(2.0), makeASample(2.0)];
    const pathB = [
      makeBSampleActive(2.9, 0.85, 1.05),
      makeBSampleActive(3.0, 0.85, 1.10),
      makeBSampleActive(2.9, 0.85, 1.08),
    ];
    const r = buildReceipt(pathA, pathB);
    // speedup_p50 = 2.9/2.0 = 1.45 ≥ 1.35 ✓; rate = 0.85 ≥ 0.80 ✓; beta = 1.08 ≤ 1.30 ✓
    expect(r.passed).toBe(true);
  });

  test("receipt.passed=false when speedup is below threshold", () => {
    const pathA = [makeASample(2.0)];
    const pathB = [makeBSampleActive(2.5, 0.85)]; // speedup = 1.25 < 1.35
    const r = buildReceipt(pathA, pathB);
    expect(r.passed).toBe(false);
    expect(r.gates.speedup_gte_1_35).toBe(false);
  });

  test("receipt.passed=false when no self-spec-active turns (acceptance_rate_p50 = 0)", () => {
    const pathA = [makeASample(2.0)];
    const pathB = [makeBSampleInactive(3.5)]; // effective_tps high but no active turns
    const r = buildReceipt(pathA, pathB);
    expect(r.gates.acceptance_rate_gte_0_80).toBe(false);
    expect(r.passed).toBe(false);
  });

  test("fzk_verdict is null when not provided", () => {
    const r = buildReceipt([], []);
    expect(r.fzk_verdict).toBeNull();
  });

  test("fzk_verdict is preserved from meta", () => {
    const r = buildReceipt([], [], { fzk_verdict: "identical" });
    expect(r.fzk_verdict).toBe("identical");
  });

  test("sha defaults to 'unknown' when not provided", () => {
    const r = buildReceipt([], []);
    expect(r.sha).toBe("unknown");
  });

  test("gates object has exactly 5 keys", () => {
    const r = buildReceipt([], []);
    const gateKeys = Object.keys(r.gates);
    expect(gateKeys).toHaveLength(5);
    expect(gateKeys).toContain("speedup_gte_1_35");
    expect(gateKeys).toContain("acceptance_rate_gte_0_80");
    expect(gateKeys).toContain("verify_beta_lte_1_30");
    expect(gateKeys).toContain("zero_device_lost");
    expect(gateKeys).toContain("zero_oom");
  });

  test("metrics object has all required fields", () => {
    const r = buildReceipt([], []);
    const m = r.metrics;
    expect(typeof m.speedup_p50).toBe("number");
    expect(typeof m.acceptance_rate_p50).toBe("number");
    expect(typeof m.verify_beta_p50).toBe("number");
    expect(typeof m.deviceLostCount).toBe("number");
    expect(typeof m.oomCount).toBe("number");
    expect(typeof m.n_path_a).toBe("number");
    expect(typeof m.n_path_b).toBe("number");
    expect(typeof m.n_path_b_active).toBe("number");
  });
});

// ── Threshold constants ───────────────────────────────────────────────────────

describe("exported threshold constants match issue #1867 spec", () => {
  test("SPEEDUP_THRESHOLD = 1.35", () => {
    expect(SPEEDUP_THRESHOLD).toBe(1.35);
  });

  test("ACCEPTANCE_THRESHOLD = 0.80", () => {
    expect(ACCEPTANCE_THRESHOLD).toBe(0.80);
  });

  test("VERIFY_BETA_THRESHOLD = 1.30", () => {
    expect(VERIFY_BETA_THRESHOLD).toBe(1.30);
  });
});
