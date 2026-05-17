/**
 * WASM MTP backend — browser-resident Gemma 4 speculative decoding via turboquant WASM.
 *
 * This module is the entry point for WASM-resident inference (#738). Currently it
 * provides only the cross-origin isolation startup check (#739); the full backend
 * (model loading, inference loop, WebGPU EP orchestration) lands in a follow-up.
 *
 * Startup check must run before any SharedArrayBuffer allocation or WASM thread
 * spawn. Import this module early in main.ts to fail loud rather than fail silently
 * when COOP/COEP headers are misconfigured.
 */

export class CrossOriginIsolationError extends Error {
  constructor() {
    super(
      "crossOriginIsolated is false — SharedArrayBuffer and WASM pthreads require " +
      "Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-Policy: require-corp. " +
      "Check dev-server headers (vite.config.ts server.headers) or the hosting environment."
    );
    this.name = "CrossOriginIsolationError";
  }
}

/** True when COOP+COEP headers are in place and SharedArrayBuffer is available. */
export const crossOriginIsolated: boolean =
  typeof self !== "undefined" && (self as Window & typeof globalThis).crossOriginIsolated === true;

/**
 * Assert cross-origin isolation. Call once at app startup.
 * Throws CrossOriginIsolationError and logs to console.error if headers are missing.
 * In production builds the error is surfaced but non-fatal so the app degrades to
 * non-threaded WASM; in dev it throws to surface the misconfiguration immediately.
 */
export function assertCrossOriginIsolated(opts: { throwInDev?: boolean } = {}): void {
  if (crossOriginIsolated) return;

  const err = new CrossOriginIsolationError();
  console.error("[wasm-backend]", err.message);

  const isDev = import.meta.env.DEV;
  if (isDev || opts.throwInDev) {
    throw err;
  }
  // Production: log and continue — WASM pthreads unavailable, MTP disabled.
}
