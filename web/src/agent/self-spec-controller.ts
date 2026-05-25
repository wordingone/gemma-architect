// self-spec-controller.ts — Activation gates + per-turn telemetry for self-speculative
// decoding (#1860 Sub-5).
//
// Decides whether the self-speculative drafter+verifier path should be active on each turn,
// based on 11 runtime conditions enumerated in the issue. All state transitions are surfaced
// in the `reason` field — no silent activation or disable transitions.
//
// Per-turn flow (agent-harness.ts):
//   1. Before turn: call shouldActivate(state) → { active, reason }
//   2. Pass active → worker as useMtp flag
//   3. After turn: call recordTurn(acceptanceRate) → updates rolling window

const WARMUP_TURNS        = 3;    // first N turns always disable — model not yet calibrated
const ACCEPTANCE_WINDOW   = 10;   // rolling window size for acceptance-rate tracking
const CONSEC_LOW_LIMIT    = 3;    // consecutive turns below LOW_ACCEPTANCE → force-disable
const LOW_ACCEPTANCE      = 0.70; // threshold for consecutive-low trigger
const ENABLE_MIN_RATE     = 0.75; // rolling-window floor for enable
const ENABLE_MAX_BETA     = 1.35; // verify_beta ceiling for enable
const DISABLE_MAX_BETA    = 1.45; // verify_beta hard-disable (above enable ceiling)

// Sub-1 (#1861) baseline: median tg_tps = 2.132 t/s from 25 scene-query samples on Pages.
// Used for speedup_observed computation. Update when new baseline run completes.
export const BASELINE_TPS_P50 = 2.132;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Runtime state snapshot passed to shouldActivate() at turn start. */
export interface SelfSpecRuntimeState {
  backendPath:     "webgpu" | "remote" | "wasm";
  modelReady:      boolean;
  prefillComplete: boolean;  // prefill / warmup pass complete
  inputLength:     number;   // estimated token count for this turn's input
  contextLimit:    number;   // model context limit (16384 for E4B)
  verifyBeta:      number;   // ratio: verify_step_ms / single_token_full_decode_ms (default 1.0)
  deviceLost:      boolean;  // true if any DeviceLost event has fired
  recycleCount:    number;   // _arc.recycleCount — any recycle → disable
  highEntropyMode: boolean;  // true when temperature > 0.5 or top-p sampling active
}

export interface ShouldActivateResult {
  active: boolean;
  reason: string; // always set — enable and disable both produce a reason string
}

// ── Controller ────────────────────────────────────────────────────────────────

export class SelfSpecController {
  private _turnsCompleted  = 0;
  private _acceptanceWin: number[] = [];
  private _consecutiveLow  = 0;
  private _forcedDisable   = false;

  // ── Decision (called before each turn) ──────────────────────────────────────

  shouldActivate(state: SelfSpecRuntimeState): ShouldActivateResult {
    // Gate 1: warmup — first WARMUP_TURNS turns always disabled
    if (this._turnsCompleted < WARMUP_TURNS) {
      return { active: false, reason: `warmup(${this._turnsCompleted}/${WARMUP_TURNS})` };
    }

    // Gate 2: consecutive-low-acceptance forced disable
    if (this._forcedDisable) {
      return { active: false, reason: `consecutive_low_acceptance(≥${CONSEC_LOW_LIMIT})` };
    }

    // Gates 3-10: instantaneous disable conditions (any one → disable immediately)

    // Gate 3: backend path — self-spec requires WebGPU ORT sessions
    if (state.backendPath !== "webgpu") {
      return { active: false, reason: `backend:${state.backendPath}` };
    }

    // Gate 4: model must be loaded and ready
    if (!state.modelReady) {
      return { active: false, reason: "model_not_ready" };
    }

    // Gate 5: prefill/warmup pass must be complete
    if (!state.prefillComplete) {
      return { active: false, reason: "prefill_incomplete" };
    }

    // Gate 6: input must fit within context window
    if (state.inputLength > state.contextLimit) {
      return { active: false, reason: `input_overflow(${state.inputLength}>${state.contextLimit})` };
    }

    // Gate 7: no device-lost event in this session
    if (state.deviceLost) {
      return { active: false, reason: "device_lost" };
    }

    // Gate 8: no D3D12 OOM recycles (any recycle degrades KV state)
    if (state.recycleCount > 0) {
      return { active: false, reason: `recycle(count=${state.recycleCount})` };
    }

    // Gate 9: verifyBeta hard ceiling (drafter cost too high relative to verifier)
    if (state.verifyBeta > DISABLE_MAX_BETA) {
      return { active: false, reason: `verify_beta_hard(${state.verifyBeta.toFixed(2)}>${DISABLE_MAX_BETA})` };
    }

    // Gate 10: high-entropy sampling mode — acceptance rate is unreliable under high temperature
    if (state.highEntropyMode) {
      return { active: false, reason: "high_entropy_mode" };
    }

    // Gates 11-12: enable conditions (rolling-window acceptance rate + beta ceiling)

    // Gate 11: recent acceptance rate must be above enable floor
    const rate = this._recentRate();
    if (rate < ENABLE_MIN_RATE) {
      return { active: false, reason: `acceptance_rate_low(${rate.toFixed(2)}<${ENABLE_MIN_RATE})` };
    }

    // Gate 12: verifyBeta soft ceiling (enable is tighter than disable ceiling)
    if (state.verifyBeta > ENABLE_MAX_BETA) {
      return { active: false, reason: `verify_beta_soft(${state.verifyBeta.toFixed(2)}>${ENABLE_MAX_BETA})` };
    }

    return {
      active: true,
      reason: `active(rate=${rate.toFixed(2)},beta=${state.verifyBeta.toFixed(2)})`,
    };
  }

  // ── State update (called after each turn completes) ──────────────────────────

  recordTurn(acceptanceRate: number): void {
    this._turnsCompleted++;

    // Update rolling window
    this._acceptanceWin.push(acceptanceRate);
    if (this._acceptanceWin.length > ACCEPTANCE_WINDOW) this._acceptanceWin.shift();

    // Consecutive-low tracking
    if (acceptanceRate < LOW_ACCEPTANCE) {
      this._consecutiveLow++;
      if (this._consecutiveLow >= CONSEC_LOW_LIMIT) {
        this._forcedDisable = true;
      }
    } else {
      this._consecutiveLow = 0;
      // Lift force-disable when acceptance recovers above the enable floor
      if (this._forcedDisable && acceptanceRate >= ENABLE_MIN_RATE) {
        this._forcedDisable = false;
      }
    }
  }

  private _recentRate(): number {
    if (this._acceptanceWin.length === 0) return 1.0; // assume best before any data
    const sum = this._acceptanceWin.reduce((a, b) => a + b, 0);
    return sum / this._acceptanceWin.length;
  }

  // ── Read-only accessors (tests + DevTools) ───────────────────────────────────

  get turnsCompleted(): number  { return this._turnsCompleted; }
  get forcedDisable():  boolean { return this._forcedDisable; }
  get consecutiveLow(): number  { return this._consecutiveLow; }
  get recentRate():     number  { return this._recentRate(); }
}

// Module-level singleton — shared across all runAgentTurn() calls within the session.
export const selfSpecController = new SelfSpecController();
