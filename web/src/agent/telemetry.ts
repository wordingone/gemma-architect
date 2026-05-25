// Per-turn telemetry ring buffer for speed measurement (#98 P6a).
// Accessible via `window.__telemetry` for debugging.
// Toggle the perf strip in chat panel via cmdk `debug.telemetry`.

export interface TurnTelemetry {
  ts: number;        // Date.now() at turn start
  prefill_ms: number;
  decode_ms: number;
  tokens_in: number;
  tokens_out: number;
  system_prompt_chars: number;
  skills_total: number;
  skills_matched: number;
  tg_tps: number;    // tokens/s during generation
  pp_tps: number;    // tokens/s during prefill (approx)
  mtp_on?: boolean;         // true when MTP spec-decode was active for this turn
  spec_attempts?: number;   // draft tokens proposed by drafter this turn (#674 AC4)
  spec_accepts?: number;    // draft tokens accepted by target this turn
  spec_accept_rate?: number; // spec_accepts / spec_attempts (0 when mtp_on false)
  path?: "webgpu" | "remote" | "wasm"; // inference path used
  // Self-speculative decoding telemetry (#1860 Sub-5)
  self_spec_active?: boolean;   // whether self-spec path was active for this turn
  self_spec_reason?: string;    // controller's gate reason string (debug)
  draft_tokens?: number;        // drafter tokens proposed (k × spec_cycles)
  accepted_tokens?: number;     // verifier-accepted tokens (excluding replacements)
  acceptance_rate?: number;     // accepted_tokens / draft_tokens this turn
  verify_beta?: number;         // verify_step_ms / full_decode_step_ms (default 1.0)
  effective_tps?: number;       // emitted_tokens / (decode_ms / 1000) — post-acceptance
  speedup_observed?: number;    // effective_tps / BASELINE_TPS_P50
}

const RING_SIZE = 1000; // §C-telem (#990): 1000 samples supports 10-min moving averages at ~1 turn/s
const _ring: TurnTelemetry[] = [];

export function recordTurn(t: TurnTelemetry): void {
  if (_ring.length >= RING_SIZE) _ring.shift();
  _ring.push(t);
  (window as any).__telemetry = _ring;
}

export function lastTurn(): TurnTelemetry | null {
  return _ring.length > 0 ? _ring[_ring.length - 1] : null;
}

export function allTurns(): TurnTelemetry[] {
  return [..._ring];
}

// Expose on window immediately so console access works before any turn runs.
(window as any).__telemetry = _ring;
