// telemetry-remote.ts — Sentry client-side event reporting (#1628).
//
// Active in PROD only when VITE_SENTRY_DSN is set.
// Opt-out: ?notelemetry=1 in URL, or localStorage key gemma-architect-telemetry-opt-out=1.
// user_id: anonymous UUID stable across tabs (localStorage key gemma-architect-anon-user-id).
// session_id: ephemeral per-tab UUID (crypto.randomUUID at module load).
// PII: scrubbed before every event via telemetry-scrub.ts.

import * as Sentry from "@sentry/browser";
import { scrubPii } from "./telemetry-scrub.js";

const DSN = import.meta.env["VITE_SENTRY_DSN"] as string | undefined;
const OPT_OUT_KEY = "gemma-architect-telemetry-opt-out";
const USER_ID_KEY = "gemma-architect-anon-user-id";

// Per-tab session ID — ephemeral, not stored in localStorage.
const _sessionId = crypto.randomUUID();

function isOptedOut(): boolean {
  try {
    if (new URLSearchParams(location.search).get("notelemetry") === "1") return true;
    if (localStorage.getItem(OPT_OUT_KEY) === "1") return true;
  } catch { /* storage unavailable */ }
  return false;
}

export function getOrCreateAnonymousUserId(): string {
  try {
    const stored = localStorage.getItem(USER_ID_KEY);
    if (stored) return stored;
    const id = crypto.randomUUID();
    localStorage.setItem(USER_ID_KEY, id);
    return id;
  } catch {
    return "anon";
  }
}

let _initialized = false;

export function initTelemetry(): void {
  if (_initialized || !DSN || !import.meta.env.PROD || isOptedOut()) return;
  _initialized = true;
  const userId = getOrCreateAnonymousUserId();
  Sentry.init({
    dsn: DSN,
    release: (import.meta.env["VITE_GIT_SHA"] as string | undefined) ?? "unknown",
    environment: "production",
    sampleRate: 1.0,
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.message) event.message = scrubPii(event.message);
      if (event.exception?.values) {
        event.exception.values.forEach(v => { if (v.value) v.value = scrubPii(v.value); });
      }
      return event;
    },
  });
  // user_id stable across tabs; session_id ephemeral per tab.
  Sentry.setUser({ id: userId });
  Sentry.setTag("session_id", _sessionId);
}

export type AdapterFingerprint = {
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  maxBufferMB: number;
  isFallback: boolean;
  classification: "dgpu" | "igpu" | "software" | "unknown";
};

export type FallbackState = "dgpu" | "igpu_wasm_inference" | "webgl_wasm_inference" | "cad_only";

export function emitBootFingerprint(fp: AdapterFingerprint): void {
  if (!_initialized) return;
  Sentry.captureEvent({ level: "info", message: "boot_fingerprint", extra: { ...fp, session_id: _sessionId } });
}

export function emitBootComplete(bootMs: number, loadSource: string): void {
  if (!_initialized) return;
  Sentry.captureEvent({ level: "info", message: "boot_complete", extra: { boot_ms: bootMs, load_source: loadSource, session_id: _sessionId } });
}

export function emitDispatchTurn(dispatchCount: number, durationMs: number): void {
  if (!_initialized) return;
  if (Math.random() > 0.1) return; // 10% sample
  Sentry.captureEvent({ level: "info", message: "dispatch_turn", extra: { dispatch_count: dispatchCount, duration_ms: durationMs, session_id: _sessionId } });
}

export function emitRecycle(recycleCount: number, reason: string): void {
  if (!_initialized) return;
  Sentry.captureEvent({ level: "warning", message: "worker_recycle", extra: { recycle_count: recycleCount, reason, session_id: _sessionId } });
}

export function emitError(message: string, context?: Record<string, unknown>): void {
  if (!_initialized) return;
  Sentry.captureEvent({ level: "error", message: "app_error", extra: { error_message: scrubPii(message), session_id: _sessionId, ...context } });
}

// §#1627 block C: fallback-state telemetry — emitted once boot completes and the
// inference tier is resolved (dgpu → WASM-EP fallback ladder).
export function emitFallbackState(state: FallbackState, context?: Record<string, unknown>): void {
  if (!_initialized) return;
  Sentry.captureEvent({ level: "info", message: "fallback_state_observed", extra: { state, session_id: _sessionId, ...context } });
}
