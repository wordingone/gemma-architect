// self-spec-edge-cases.test.ts — #1860 Sub-6: ARC edge cases for self-speculative decoding.
// Covers: device-lost mid-draft, D3D12_OOM mid-verify, multimodal prefill guard,
// post-recovery warmup, SELF_SPEC_DRAFT_START denied from recovering state.
// Run: bun test web/test/self-spec-edge-cases.test.ts

import { describe, expect, test, beforeEach } from "bun:test";
import {
  SelfSpecController,
  type SelfSpecRuntimeState,
} from "../src/agent/self-spec-controller";
import {
  AgentRuntimeController,
  setStrictMode,
} from "../src/agent/agent-runtime-controller";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<SelfSpecRuntimeState> = {}): SelfSpecRuntimeState {
  return {
    backendPath:     "webgpu",
    modelReady:      true,
    prefillComplete: true,
    inputLength:     100,
    contextLimit:    16384,
    verifyBeta:      1.0,
    deviceLost:      false,
    recycleCount:    0,
    highEntropyMode: false,
    ...overrides,
  };
}

function warmUp(ctrl: SelfSpecController, turns = 3, rate = 0.9): void {
  for (let i = 0; i < turns; i++) ctrl.recordTurn(rate);
}

function bootArc(arc: AgentRuntimeController): void {
  arc.dispatch({ type: "BOOT_REQUESTED" });
  arc.dispatch({ type: "MODEL_READY", device: "GPU" });
  arc.dispatch({ type: "BOOT_COMPLETE" });
}

// ── ARC: SELF_SPEC_DRAFT_DEVICE_LOST ─────────────────────────────────────────

describe("ARC: SELF_SPEC_DRAFT_DEVICE_LOST (device-lost mid-draft)", () => {
  let arc: AgentRuntimeController;
  beforeEach(() => {
    arc = new AgentRuntimeController();
    setStrictMode(true);
    bootArc(arc);
  });

  test("transitions generating → recycling", () => {
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    expect(arc.state).toBe("generating");
    arc.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t1" });
    expect(arc.state).toBe("recycling");
  });

  test("increments recycleCount", () => {
    const before = arc.recycleCount;
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t1" });
    expect(arc.recycleCount).toBe(before + 1);
  });

  test("clears workerReady + bootComplete + prefillDone", () => {
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "PREFILL_DONE" });
    expect(arc.prefillDone).toBe(true);
    arc.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t1" });
    expect(arc.workerReady).toBe(false);
    expect(arc.bootComplete).toBe(false);
    expect(arc.prefillDone).toBe(false);
  });

  test("is INVALID from non-generating states (strictMode throws)", () => {
    // From ready — not in generating, so SELF_SPEC_DRAFT_DEVICE_LOST is invalid.
    expect(() => {
      arc.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t2" });
    }).toThrow();
  });
});

// ── ARC: SELF_SPEC_VERIFY_D3D12_OOM ──────────────────────────────────────────

describe("ARC: SELF_SPEC_VERIFY_D3D12_OOM (D3D12_OOM mid-verify)", () => {
  let arc: AgentRuntimeController;
  beforeEach(() => {
    arc = new AgentRuntimeController();
    setStrictMode(true);
    bootArc(arc);
  });

  test("transitions generating → recycling", () => {
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_VERIFY_D3D12_OOM", turnId: "t1" });
    expect(arc.state).toBe("recycling");
  });

  test("increments recycleCount (same as D3D12_OOM)", () => {
    const before = arc.recycleCount;
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_VERIFY_D3D12_OOM", turnId: "t1" });
    expect(arc.recycleCount).toBe(before + 1);
  });

  test("is INVALID from recovering state (explicit-deny SELF_SPEC_DRAFT_START pattern)", () => {
    // Demonstrate the explicit-deny: self-spec events rejected from recovering.
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t1" }); // → recycling
    arc.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "test" }); // → recovering
    expect(arc.state).toBe("recovering");
    expect(() => {
      arc.dispatch({ type: "SELF_SPEC_VERIFY_D3D12_OOM", turnId: "t2" });
    }).toThrow(); // invalid from recovering
  });
});

// ── ARC: SELF_SPEC_DRAFT_START ────────────────────────────────────────────────

describe("ARC: SELF_SPEC_DRAFT_START (drafter begins a block)", () => {
  let arc: AgentRuntimeController;
  beforeEach(() => {
    arc = new AgentRuntimeController();
    setStrictMode(true);
    bootArc(arc);
  });

  test("self-loop in generating state: state stays generating", () => {
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    expect(arc.state).toBe("generating");
    arc.dispatch({ type: "SELF_SPEC_DRAFT_START", turnId: "t1" });
    expect(arc.state).toBe("generating"); // no-op self-loop
  });

  test("no recycleCount change from DRAFT_START", () => {
    const before = arc.recycleCount;
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_DRAFT_START", turnId: "t1" });
    expect(arc.recycleCount).toBe(before);
  });

  test("SELF_SPEC_DRAFT_START is INVALID from recovering (explicit-deny)", () => {
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t1" }); // → recycling
    arc.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "test" }); // → recovering
    expect(arc.state).toBe("recovering");
    expect(() => {
      arc.dispatch({ type: "SELF_SPEC_DRAFT_START", turnId: "t2" });
    }).toThrow(); // recovering state does NOT allow SELF_SPEC_DRAFT_START
  });

  test("SELF_SPEC_DRAFT_START is INVALID from ready (guard: must be in generating)", () => {
    expect(arc.state).toBe("ready");
    expect(() => {
      arc.dispatch({ type: "SELF_SPEC_DRAFT_START", turnId: "t1" });
    }).toThrow();
  });
});

// ── Controller: multimodal prefill guard ──────────────────────────────────────

describe("Controller: multimodal prefill in-progress guard", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("setMmPrefillInProgress(true) → shouldActivate returns false + reason", () => {
    ctrl.setMmPrefillInProgress(true);
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(false);
    expect(r.reason).toBe("mm_prefill_in_progress");
  });

  test("mm_prefill_in_progress overrides all other conditions (even fully green state)", () => {
    // Even with: perfect acceptance rate, valid beta, no recycles — must still be false
    ctrl.setMmPrefillInProgress(true);
    const r = ctrl.shouldActivate(makeState({
      backendPath: "webgpu",
      modelReady: true,
      prefillComplete: true,
      inputLength: 50,
      verifyBeta: 1.0,
      deviceLost: false,
      recycleCount: 0,
      highEntropyMode: false,
    }));
    expect(r.active).toBe(false);
    expect(r.reason).toBe("mm_prefill_in_progress");
  });

  test("setMmPrefillInProgress(false) restores normal activation", () => {
    ctrl.setMmPrefillInProgress(true);
    expect(ctrl.shouldActivate(makeState()).active).toBe(false);
    ctrl.setMmPrefillInProgress(false);
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });

  test("mmPrefillInProgress accessor reflects the current flag value", () => {
    expect(ctrl.mmPrefillInProgress).toBe(false);
    ctrl.setMmPrefillInProgress(true);
    expect(ctrl.mmPrefillInProgress).toBe(true);
  });
});

// ── Controller: post-recovery warmup ─────────────────────────────────────────

describe("Controller: post-recovery warmup (notifyRecovery)", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("immediately after notifyRecovery: disabled (turn 0 of recovery window)", () => {
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(true); // was active before recovery
    ctrl.notifyRecovery();
    const r2 = ctrl.shouldActivate(makeState());
    expect(r2.active).toBe(false);
    expect(r2.reason).toContain("post_recovery_warmup");
  });

  test("notifyRecovery disables for exactly WARMUP_TURNS (3) turns", () => {
    ctrl.notifyRecovery();
    // Turn 1: disabled
    expect(ctrl.shouldActivate(makeState()).active).toBe(false);
    ctrl.recordTurn(0.9); // completes turn 1
    // Turn 2: disabled
    expect(ctrl.shouldActivate(makeState()).active).toBe(false);
    ctrl.recordTurn(0.9); // completes turn 2
    // Turn 3: disabled
    expect(ctrl.shouldActivate(makeState()).active).toBe(false);
    ctrl.recordTurn(0.9); // completes turn 3
    // Turn 4: enabled (window exhausted)
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });

  test("notifyRecovery clears stale acceptance window", () => {
    // Push very low acceptance into window
    for (let i = 0; i < 5; i++) ctrl.recordTurn(0.5);
    ctrl.notifyRecovery();
    // After recovery window, recentRate defaults to 1.0 (empty window)
    for (let i = 0; i < 3; i++) ctrl.recordTurn(0.9); // flush recovery disable
    // Window was cleared, so recentRate is from new data only
    expect(ctrl.recentRate).toBeGreaterThanOrEqual(0.9);
  });

  test("notifyRecovery clears forcedDisable from prior consecutive-low streak", () => {
    ctrl.recordTurn(0.65);
    ctrl.recordTurn(0.65);
    ctrl.recordTurn(0.65); // triggers forcedDisable
    expect(ctrl.forcedDisable).toBe(true);
    ctrl.notifyRecovery();
    expect(ctrl.forcedDisable).toBe(false);
  });

  test("postRecoveryDisableRemaining accessor counts down correctly", () => {
    ctrl.notifyRecovery();
    expect(ctrl.postRecoveryDisableRemaining).toBe(3);
    ctrl.recordTurn(0.9);
    expect(ctrl.postRecoveryDisableRemaining).toBe(2);
    ctrl.recordTurn(0.9);
    expect(ctrl.postRecoveryDisableRemaining).toBe(1);
    ctrl.recordTurn(0.9);
    expect(ctrl.postRecoveryDisableRemaining).toBe(0);
  });
});

// ── Controller: notifyVerifyOom ───────────────────────────────────────────────

describe("Controller: post-OOM warmup (notifyVerifyOom)", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("notifyVerifyOom disables for WARMUP_TURNS turns (same as notifyRecovery)", () => {
    ctrl.notifyVerifyOom();
    expect(ctrl.shouldActivate(makeState()).active).toBe(false);
    expect(ctrl.shouldActivate(makeState()).reason).toContain("post_recovery_warmup");
    ctrl.recordTurn(0.9);
    ctrl.recordTurn(0.9);
    ctrl.recordTurn(0.9); // exhaust window
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });

  test("notifyVerifyOom clears acceptance window (stale pre-OOM data)", () => {
    for (let i = 0; i < 5; i++) ctrl.recordTurn(0.5); // low acceptance
    ctrl.notifyVerifyOom();
    for (let i = 0; i < 3; i++) ctrl.recordTurn(0.9); // flush recovery window
    // Window was cleared, so only post-OOM samples count
    expect(ctrl.recentRate).toBeGreaterThanOrEqual(0.9);
  });
});

// ── KV-leak guard on abort ────────────────────────────────────────────────────
// Verifies that the panic path (device-lost mid-draft) does not leak drafter KV
// into the main session. This tests the contract, not the drafter implementation
// (which is covered in self-spec-drafter.test.ts and self-spec-verifier.test.ts).

describe("KV-leak guard: abort sequence contract", () => {
  test("ARC generates recycling event (not abort-and-continue)", () => {
    const arc = new AgentRuntimeController();
    setStrictMode(false); // don't throw on transitions
    bootArc(arc);
    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t1" });
    // Postcondition: in recycling, not back in generating/ready
    // This ensures the harness discards the in-flight draft block rather than
    // attempting to merge partial drafter KV into the session.
    expect(arc.state).toBe("recycling");
    expect(arc.workerReady).toBe(false);
  });

  test("controller post-recovery warmup prevents self-spec re-entry after abort", () => {
    // Simulate the full abort → recovery → re-enable cycle:
    // 1. Start warmed up
    const ctrl = new SelfSpecController();
    warmUp(ctrl);
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);

    // 2. OOM fires (equivalent to device-lost mid-draft)
    ctrl.notifyVerifyOom();
    expect(ctrl.shouldActivate(makeState()).active).toBe(false); // force-disabled

    // 3. After WARMUP_TURNS turns, re-enabled
    ctrl.recordTurn(0.9);
    ctrl.recordTurn(0.9);
    ctrl.recordTurn(0.9);
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });
});

// ── Integration: ARC transition fires controller notification ─────────────────

describe("Integration: SELF_SPEC_VERIFY_D3D12_OOM fires controller notifyVerifyOom", () => {
  test("controller is disabled for 3 turns after OOM event", () => {
    // Simulate what agent-harness.ts does on SELF_SPEC_VERIFY_D3D12_OOM:
    const ctrl = new SelfSpecController();
    warmUp(ctrl);

    const arc = new AgentRuntimeController();
    setStrictMode(false);
    bootArc(arc);
    arc.onTransition((from, event, to, _c) => {
      if (event.type === "SELF_SPEC_VERIFY_D3D12_OOM") {
        ctrl.notifyVerifyOom();
      }
    });

    arc.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    arc.dispatch({ type: "SELF_SPEC_VERIFY_D3D12_OOM", turnId: "t1" });

    // Controller must be disabled immediately after OOM
    expect(ctrl.shouldActivate(makeState()).active).toBe(false);
    expect(ctrl.postRecoveryDisableRemaining).toBe(3);
  });
});
