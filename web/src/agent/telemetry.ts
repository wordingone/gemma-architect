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
  mtp_on?: boolean;  // true when MTP / speculative decoding was active for this turn
  path?: "webgpu" | "remote"; // inference path used
}

const RING_SIZE = 50;
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
