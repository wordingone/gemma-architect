// §P0-ARC (#1389): Typed runtime state machine for the model-worker lifecycle.
// Replaces scattered boolean flags (_bootComplete, _workerReady, _prefillDone,
// _nextInitNoWarmup, _webgpuFallbackEngaged, _modelLoadError, _modelWorkerRecycleCount,
// _modelWorkerTurnCount, _nextInitNoWarmup) with a single controller instance.
//
// Design: pure state machine — no DOM, no Worker references, no side effects.
// Callers receive transition callbacks and execute side effects themselves.

export type RuntimeState =
  | "idle"
  | "booting"
  | "ready"
  | "generating"
  | "recycling"
  | "recovering"
  | "failed";

export type RuntimeEvent =
  | { type: "BOOT_REQUESTED" }
  | { type: "MODEL_READY"; device: string }
  | { type: "BOOT_COMPLETE" }
  | { type: "GENERATE_REQUESTED"; turnId: string }
  | { type: "PREFILL_DONE" }
  | { type: "GENERATE_DONE"; turnId: string }
  | { type: "GENERATE_FAILED" }
  | { type: "D3D12_OOM"; reason?: string }
  | { type: "WATCHDOG_TIMEOUT"; turnId: string }
  | { type: "WORKER_RECYCLED"; recycleCount: number; reason: string }
  | { type: "RECOVERY_COMPLETE" }
  | { type: "FATAL_ERROR"; error: string; reason?: string }
  // §#1860 Sub-6: self-speculative decoding failure events
  | { type: "SELF_SPEC_DRAFT_START"; turnId: string }        // drafter begins a k-step block
  | { type: "SELF_SPEC_DRAFT_DEVICE_LOST"; turnId: string }  // device-lost mid-draft
  | { type: "SELF_SPEC_VERIFY_D3D12_OOM"; turnId: string };  // D3D12_OOM mid-verify-pass

export type TransitionCallback = (
  from: RuntimeState,
  event: RuntimeEvent,
  to: RuntimeState,
  ctrl: AgentRuntimeController,
) => void;

// Allowed transitions. Any event not listed for a state is INVALID.
const TRANSITIONS: Record<RuntimeState, Partial<Record<RuntimeEvent["type"], RuntimeState>>> = {
  idle:       { BOOT_REQUESTED: "booting" },
  booting:    { MODEL_READY: "booting", BOOT_COMPLETE: "ready", FATAL_ERROR: "failed",
                PREFILL_DONE: "booting",      // warmup-done fires before boot-complete (#1407)
                GENERATE_REQUESTED: "generating" }, // prompt submitted during post-recycle boot (#1526 H3)
  ready:      { GENERATE_REQUESTED: "generating", BOOT_REQUESTED: "booting",
                PREFILL_DONE: "ready",        // warmup-done after recycle if noWarmup=false
                D3D12_OOM: "recycling",       // planned recycle dispatched before GENERATE_REQUESTED (#1750)
                WORKER_RECYCLED: "recovering" }, // unplanned recycle while idle — no prior D3D12_OOM (#1526 H2)
  generating: {
    PREFILL_DONE:     "generating",
    GENERATE_DONE:    "ready",
    // §#1666: generate-error (model not loaded) → reset to ready so next prompt isn't deadlocked.
    GENERATE_FAILED:  "ready",
    D3D12_OOM:        "recycling",
    WATCHDOG_TIMEOUT: "recycling",
    FATAL_ERROR:      "failed",
    // Post-planned-recycle race: new worker sends model-ready/boot-complete while a
    // generate is in flight (the old turn is still awaiting resolution).
    MODEL_READY:      "generating",
    BOOT_COMPLETE:    "ready",
    // §#1860 Sub-6: self-speculative failure events (drafter/verifier abort paths).
    SELF_SPEC_DRAFT_START:        "generating", // self-loop: marker only, no state change
    SELF_SPEC_DRAFT_DEVICE_LOST:  "recycling",  // device-lost mid-draft → discard + recycle
    SELF_SPEC_VERIFY_D3D12_OOM:   "recycling",  // D3D12_OOM mid-verify → discard + recycle
  },
  recycling:  { WORKER_RECYCLED: "recovering", FATAL_ERROR: "failed" },
  recovering: {
    MODEL_READY:        "recovering",
    BOOT_COMPLETE:      "ready",
    FATAL_ERROR:        "failed",
    PREFILL_DONE:       "recovering", // warmup PREFILL_DONE from dying worker — stay in recovering (#1581-S3)
    // Post-planned-recycle: first turn submitted before new worker finishes booting.
    GENERATE_REQUESTED: "generating",
    D3D12_OOM:          "recycling",  // device lost during post-recycle boot (#1840)
  },
  // failed is terminal — only BOOT_REQUESTED (manual reload path) escapes it
  failed:     { BOOT_REQUESTED: "booting" },
};

/** Set to true in tests to make invalid transitions throw instead of console.error. */
export let strictMode = false;
export function setStrictMode(v: boolean): void { strictMode = v; }

export class AgentRuntimeController {
  // ── Current state ──────────────────────────────────────────────────────────
  state: RuntimeState = "idle";

  // ── Derived fields (backwards-compatible with old flag names) ─────────────
  bootComplete       = false;
  workerReady        = false;
  prefillDone        = false;
  nextInitNoWarmup   = false;
  webgpuFallbackEngaged = false;
  modelLoadError: string | null = null;
  deviceLabel        = "GPU";
  recycleCount       = 0;
  turnCount          = 0;
  activeTurnId: string | null = null;

  // ── Listeners ─────────────────────────────────────────────────────────────
  private _listeners: TransitionCallback[] = [];

  onTransition(cb: TransitionCallback): () => void {
    this._listeners.push(cb);
    return () => { this._listeners = this._listeners.filter(l => l !== cb); };
  }

  // ── Dispatch ─────────────────────────────────────────────────────────────
  dispatch(event: RuntimeEvent): void {
    const from = this.state;
    const table = TRANSITIONS[from];
    const to = (table as Record<string, RuntimeState>)[event.type];

    if (!to) {
      const msg = `[ARC] invalid transition: ${from} + ${event.type}`;
      if (strictMode) throw new Error(msg);
      console.error(msg, { state: from, event });
      return;
    }

    this._apply(event);
    this.state = to;

    const detail = { from, event: event.type, to, turnId: this.activeTurnId ?? undefined };
    console.debug("[ARC]", from, "──", event.type, "──>", to, detail);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("arc:transition", { detail }));
    }

    for (const l of this._listeners) {
      try { l(from, event, to, this); } catch (e) { console.error("[ARC] listener error", e); }
    }
  }

  // ── State mutation (called inside dispatch before updating this.state) ────
  private _apply(ev: RuntimeEvent): void {
    switch (ev.type) {
      case "BOOT_REQUESTED":
        this.bootComplete = false;
        this.workerReady  = false;
        this.prefillDone  = false;
        this.webgpuFallbackEngaged = false;
        this.modelLoadError = null;
        this.activeTurnId = null;
        break;
      case "MODEL_READY":
        this.deviceLabel = ev.device;
        this.workerReady = true;
        break;
      case "BOOT_COMPLETE":
        this.bootComplete = true;
        // Clear nextInitNoWarmup after it was consumed
        this.nextInitNoWarmup = false;
        break;
      case "GENERATE_REQUESTED":
        this.activeTurnId = ev.turnId;
        this.prefillDone  = false;
        this.turnCount++;
        break;
      case "PREFILL_DONE":
        this.prefillDone = true;
        break;
      case "GENERATE_DONE":
        this.prefillDone  = false;
        this.activeTurnId = null;
        break;
      case "D3D12_OOM":
      case "WATCHDOG_TIMEOUT":
        this.workerReady  = false;
        this.bootComplete = false;
        this.prefillDone  = false;
        this.turnCount    = 0;
        this.nextInitNoWarmup = true;
        this.recycleCount++;
        break;
      case "WORKER_RECYCLED":
        if (this.state === "ready") {
          // Unplanned recycle — worker died without prior D3D12_OOM/WATCHDOG_TIMEOUT.
          // Reset flags and increment recycleCount (normally done by those events).
          this.workerReady      = false;
          this.bootComplete     = false;
          this.prefillDone      = false;
          this.turnCount        = 0;
          this.nextInitNoWarmup = true;
          this.recycleCount++;
        }
        // Planned path (recycling → recovering): recycleCount/flags already set by D3D12_OOM/WATCHDOG_TIMEOUT.
        break;
      case "RECOVERY_COMPLETE":
        // Unused — use BOOT_COMPLETE from recovering state instead.
        break;
      case "SELF_SPEC_DRAFT_START":
        // No state mutation — just a marker for listeners / telemetry.
        break;
      case "SELF_SPEC_DRAFT_DEVICE_LOST":
      case "SELF_SPEC_VERIFY_D3D12_OOM":
        // Same recovery path as D3D12_OOM: discard in-flight draft block and recycle.
        this.workerReady  = false;
        this.bootComplete = false;
        this.prefillDone  = false;
        this.turnCount    = 0;
        this.nextInitNoWarmup = true;
        this.recycleCount++;
        break;
      case "FATAL_ERROR":
        this.webgpuFallbackEngaged = true;
        this.bootComplete  = true; // unblocks chat-input gate
        this.modelLoadError = ev.error;
        this.workerReady   = false;
        break;
    }
  }

  // ── Convenience: is chat input allowed? ───────────────────────────────────
  get chatInputEnabled(): boolean {
    // Enabled when: ready, generating (streaming), or failed (so user can see error on next send).
    // Disabled during: idle, booting, recycling, recovering.
    return (
      this.bootComplete &&
      !this.webgpuFallbackEngaged &&
      (this.state === "ready" || this.state === "generating" || this.state === "failed")
    ) || (this.webgpuFallbackEngaged && this.bootComplete);
  }

  // ── Convenience: is a boot overlay needed? ───────────────────────────────
  get showBootOverlay(): boolean {
    return this.state === "idle" || this.state === "booting" || this.state === "recovering";
  }
}
