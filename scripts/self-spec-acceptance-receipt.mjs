#!/usr/bin/env bun
// self-spec-acceptance-receipt.mjs — Acceptance gate for #1860 Sub-7.
//
// Pure computation layer: exports p50(), computeGates(), buildReceipt().
// When called as main (bun scripts/self-spec-acceptance-receipt.mjs <samples.json>),
// reads the JSON produced by self-spec-ab-tg.mjs and writes a receipt file.
//
// Acceptance gate thresholds (issue #1867):
//   speedup_p50      >= 1.35   (effectiveTPS path-B p50 / effectiveTPS path-A p50)
//   acceptanceRate   >= 0.80   (accepted_tokens / draft_tokens, over path-B turns with self_spec_active)
//   verifyBeta       <= 1.30   (verify overhead ratio p50)
//   deviceLostCount  == 0      (any device-lost in path B over the run → FAIL)
//   oomCount         == 0      (any D3D12_OOM in path B → FAIL)

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

export const SPEEDUP_THRESHOLD      = 1.35;
export const ACCEPTANCE_THRESHOLD   = 0.80;
export const VERIFY_BETA_THRESHOLD  = 1.30;

// ── Pure computation ──────────────────────────────────────────────────────────

/**
 * Compute the p50 (median) of a numeric array.
 * Returns 0 for empty arrays.
 */
export function p50(values) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute per-metric p50 values from A/B sample arrays.
 *
 * @param {object[]} pathASamples - turns from path A (baseline, self-spec disabled)
 * @param {object[]} pathBSamples - turns from path B (self-spec enabled)
 * @returns {object} metrics with p50 values + event counts
 */
export function computeMetrics(pathASamples, pathBSamples) {
  // Path A effective TPS: tg_tps (self-spec not active)
  const aTps = pathASamples.map(s => s.tg_tps ?? s.effective_tps ?? 0).filter(v => v > 0);

  // Path B: only use turns where self_spec_active = true for self-spec metrics
  const bActiveSamples = pathBSamples.filter(s => s.self_spec_active === true);
  const bTps           = pathBSamples.map(s => s.effective_tps ?? s.tg_tps ?? 0).filter(v => v > 0);
  const bRates         = bActiveSamples.map(s => s.acceptance_rate ?? 0);
  const bBetas         = bActiveSamples.map(s => s.verify_beta ?? 1.0);

  const pathA_tps_p50 = p50(aTps);
  const pathB_tps_p50 = p50(bTps);
  const speedup_p50   = pathA_tps_p50 > 0 ? pathB_tps_p50 / pathA_tps_p50 : 0;

  // Device-lost + OOM: look for self_spec_device_lost / self_spec_oom flags in samples
  // or count turns where recycleCount changed (indicated by device_lost: true in state)
  const deviceLostCount = pathBSamples.filter(s => s.self_spec_device_lost === true).length;
  const oomCount        = pathBSamples.filter(s => s.self_spec_oom === true).length;

  return {
    pathA_tps_p50:        pathA_tps_p50,
    pathB_tps_p50:        pathB_tps_p50,
    speedup_p50:          speedup_p50,
    acceptance_rate_p50:  p50(bRates),
    verify_beta_p50:      p50(bBetas.length > 0 ? bBetas : [1.0]),
    deviceLostCount:      deviceLostCount,
    oomCount:             oomCount,
    n_path_a:             pathASamples.length,
    n_path_b:             pathBSamples.length,
    n_path_b_active:      bActiveSamples.length,
  };
}

/**
 * Apply the 5 acceptance gates to computed metrics.
 * Returns { gates, passed }.
 */
export function evaluateGates(metrics) {
  const gates = {
    speedup_gte_1_35:          metrics.speedup_p50 >= SPEEDUP_THRESHOLD,
    acceptance_rate_gte_0_80:  metrics.acceptance_rate_p50 >= ACCEPTANCE_THRESHOLD,
    verify_beta_lte_1_30:      metrics.verify_beta_p50 <= VERIFY_BETA_THRESHOLD,
    zero_device_lost:          metrics.deviceLostCount === 0,
    zero_oom:                  metrics.oomCount === 0,
  };
  const passed = Object.values(gates).every(Boolean);
  return { gates, passed };
}

/**
 * Build a complete receipt object from A/B sample arrays.
 *
 * @param {object[]} pathASamples
 * @param {object[]} pathBSamples
 * @param {object}   meta - { sha, ts, prompts, n_turns_per_prompt, fzk_verdict? }
 * @returns {object} receipt
 */
export function buildReceipt(pathASamples, pathBSamples, meta = {}) {
  const metrics = computeMetrics(pathASamples, pathBSamples);
  const { gates, passed } = evaluateGates(metrics);
  return {
    sha:                meta.sha ?? "unknown",
    ts:                 meta.ts  ?? new Date().toISOString(),
    cold_cache:         true,
    n_prompts:          meta.prompts?.length ?? 0,
    n_turns_per_prompt: meta.n_turns_per_prompt ?? 0,
    prompts:            meta.prompts ?? [],
    metrics,
    gates,
    fzk_verdict:        meta.fzk_verdict ?? null,
    passed,
  };
}

// ── CLI: read samples JSON → write receipt ────────────────────────────────────

if (import.meta.main) {
  const samplesPath = process.argv[2];
  if (!samplesPath) {
    console.error("Usage: bun scripts/self-spec-acceptance-receipt.mjs <samples.json>");
    process.exit(1);
  }
  const samples = JSON.parse(readFileSync(samplesPath, "utf8"));
  const receipt = buildReceipt(
    samples.path_a_samples ?? [],
    samples.path_b_samples ?? [],
    {
      sha:               samples.sha,
      ts:                samples.ts ?? new Date().toISOString(),
      prompts:           samples.prompts ?? [],
      n_turns_per_prompt: samples.n_turns_per_prompt ?? 0,
      fzk_verdict:       samples.fzk_verdict ?? null,
    },
  );

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outName   = `self-spec-receipt-${receipt.sha}-${Date.now()}.json`;
  const outPath   = resolve(__dirname, "..", "state", outName);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n");
  console.log(`\n── Self-Spec Acceptance Receipt (#1867) ────────────────────────────────`);
  console.log(`  speedup_p50:          ${receipt.metrics.speedup_p50.toFixed(3)}  (gate: ≥${SPEEDUP_THRESHOLD}) ${receipt.gates.speedup_gte_1_35 ? "✓" : "✗"}`);
  console.log(`  acceptance_rate_p50:  ${receipt.metrics.acceptance_rate_p50.toFixed(3)}  (gate: ≥${ACCEPTANCE_THRESHOLD}) ${receipt.gates.acceptance_rate_gte_0_80 ? "✓" : "✗"}`);
  console.log(`  verify_beta_p50:      ${receipt.metrics.verify_beta_p50.toFixed(3)}  (gate: ≤${VERIFY_BETA_THRESHOLD}) ${receipt.gates.verify_beta_lte_1_30 ? "✓" : "✗"}`);
  console.log(`  device_lost_count:    ${receipt.metrics.deviceLostCount}  (gate: =0) ${receipt.gates.zero_device_lost ? "✓" : "✗"}`);
  console.log(`  oom_count:            ${receipt.metrics.oomCount}  (gate: =0) ${receipt.gates.zero_oom ? "✓" : "✗"}`);
  console.log(`  Verdict: ${receipt.passed ? "PASS" : "FAIL"}`);
  console.log(`────────────────────────────────────────────────────────────────────────`);
  console.log(`  Receipt written: ${outPath}`);
}
