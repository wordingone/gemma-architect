// Type declarations for self-spec-acceptance-receipt.mjs
// Required for web/tsconfig.json (moduleResolution: "Bundler", strict: true).

export declare const SPEEDUP_THRESHOLD:    number;
export declare const ACCEPTANCE_THRESHOLD: number;
export declare const VERIFY_BETA_THRESHOLD: number;

export interface ReceiptMetrics {
  pathA_tps_p50:        number;
  pathB_tps_p50:        number;
  speedup_p50:          number;
  acceptance_rate_p50:  number;
  verify_beta_p50:      number;
  deviceLostCount:      number;
  oomCount:             number;
  n_path_a:             number;
  n_path_b:             number;
  n_path_b_active:      number;
}

export interface ReceiptGates {
  speedup_gte_1_35:          boolean;
  acceptance_rate_gte_0_80:  boolean;
  verify_beta_lte_1_30:      boolean;
  zero_device_lost:          boolean;
  zero_oom:                  boolean;
}

export interface Receipt {
  sha:                string;
  ts:                 string;
  cold_cache:         boolean;
  n_prompts:          number;
  n_turns_per_prompt: number;
  prompts:            string[];
  metrics:            ReceiptMetrics;
  gates:              ReceiptGates;
  fzk_verdict:        string | null;
  passed:             boolean;
}

export interface ReceiptMeta {
  sha?:               string;
  ts?:                string;
  prompts?:           string[];
  n_turns_per_prompt?: number;
  fzk_verdict?:       string | null;
}

export declare function p50(values: number[] | null | undefined): number;
export declare function computeMetrics(
  pathASamples: object[],
  pathBSamples: object[],
): ReceiptMetrics;
export declare function evaluateGates(
  metrics: ReceiptMetrics,
): { gates: ReceiptGates; passed: boolean };
export declare function buildReceipt(
  pathASamples: object[],
  pathBSamples: object[],
  meta?: ReceiptMeta,
): Receipt;
