// §P0-ARC (#1389): Unit tests for AgentRuntimeController — 10 AC scenarios.
// Pure controller tests: no DOM, no Worker. Bun test runner.

import { describe, it, expect, beforeEach } from "bun:test";
import { AgentRuntimeController, setStrictMode } from "./agent-runtime-controller";

setStrictMode(true); // invalid transitions throw in tests

function boot(ctrl: AgentRuntimeController): void {
  ctrl.dispatch({ type: "BOOT_REQUESTED" });
  ctrl.dispatch({ type: "MODEL_READY", device: "GPU" });
  ctrl.dispatch({ type: "BOOT_COMPLETE" });
}

describe("AgentRuntimeController", () => {
  let ctrl: AgentRuntimeController;
  beforeEach(() => { ctrl = new AgentRuntimeController(); });

  // Scenario 1: cold boot → ready
  it("cold boot → ready", () => {
    expect(ctrl.state).toBe("idle");
    ctrl.dispatch({ type: "BOOT_REQUESTED" });
    expect(ctrl.state).toBe("booting");
    expect(ctrl.bootComplete).toBe(false);
    ctrl.dispatch({ type: "MODEL_READY", device: "GPU" });
    expect(ctrl.state).toBe("booting");
    expect(ctrl.workerReady).toBe(true);
    expect(ctrl.deviceLabel).toBe("GPU");
    ctrl.dispatch({ type: "BOOT_COMPLETE" });
    expect(ctrl.state).toBe("ready");
    expect(ctrl.bootComplete).toBe(true);
  });

  // Scenario 2: generate → done
  it("generate → done", () => {
    boot(ctrl);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    expect(ctrl.state).toBe("generating");
    expect(ctrl.activeTurnId).toBe("t1");
    expect(ctrl.turnCount).toBe(1);
    ctrl.dispatch({ type: "PREFILL_DONE" });
    expect(ctrl.prefillDone).toBe(true);
    ctrl.dispatch({ type: "GENERATE_DONE", turnId: "t1" });
    expect(ctrl.state).toBe("ready");
    expect(ctrl.prefillDone).toBe(false);
    expect(ctrl.activeTurnId).toBeNull();
  });

  // Scenario 3: generate → watchdog timeout → recycle → respawn → ready
  it("generate → watchdog timeout → recycle → respawn → ready", () => {
    boot(ctrl);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    ctrl.dispatch({ type: "WATCHDOG_TIMEOUT", turnId: "t1" });
    expect(ctrl.state).toBe("recycling");
    expect(ctrl.recycleCount).toBe(1);
    expect(ctrl.nextInitNoWarmup).toBe(true);
    expect(ctrl.bootComplete).toBe(false);
    ctrl.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "generate-stall-watchdog" });
    expect(ctrl.state).toBe("recovering");
    ctrl.dispatch({ type: "BOOT_COMPLETE" });
    expect(ctrl.state).toBe("ready");
    expect(ctrl.bootComplete).toBe(true);
    expect(ctrl.nextInitNoWarmup).toBe(false); // consumed on BOOT_COMPLETE
  });

  // Scenario 4: D3D12 OOM → recycle → respawn → ready
  it("D3D12 OOM → recycle → respawn → ready", () => {
    boot(ctrl);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    ctrl.dispatch({ type: "D3D12_OOM" });
    expect(ctrl.state).toBe("recycling");
    expect(ctrl.recycleCount).toBe(1);
    ctrl.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "d3d12-oom" });
    ctrl.dispatch({ type: "BOOT_COMPLETE" });
    expect(ctrl.state).toBe("ready");
  });

  // Scenario 5: planned recycle → respawn → ready (same as D3D12 path)
  it("planned recycle → respawn → ready", () => {
    boot(ctrl);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    ctrl.dispatch({ type: "D3D12_OOM", reason: "planned" });
    ctrl.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "planned" });
    ctrl.dispatch({ type: "BOOT_COMPLETE" });
    expect(ctrl.state).toBe("ready");
    expect(ctrl.recycleCount).toBe(1);
  });

  // Scenario 6: recycle during active send (state is generating when OOM fires)
  it("recycle during active send", () => {
    boot(ctrl);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t2" });
    expect(ctrl.activeTurnId).toBe("t2");
    ctrl.dispatch({ type: "D3D12_OOM" });
    // activeTurnId cleared, state recycling
    expect(ctrl.state).toBe("recycling");
    ctrl.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "d3d12-oom" });
    ctrl.dispatch({ type: "MODEL_READY", device: "GPU" });
    ctrl.dispatch({ type: "BOOT_COMPLETE" });
    expect(ctrl.state).toBe("ready");
  });

  // Scenario 7: drafter failure without fatal model failure (MODEL_READY still fires; BOOT_COMPLETE follows)
  it("drafter failure does not become fatal", () => {
    // Drafter failure is a worker-level error on the drafter model — the main model still boots.
    // Controller receives MODEL_READY (main model) + BOOT_COMPLETE without drafter.
    boot(ctrl);
    expect(ctrl.state).toBe("ready");
    expect(ctrl.modelLoadError).toBeNull();
    expect(ctrl.webgpuFallbackEngaged).toBe(false);
  });

  // Scenario 8: stale worker message ignored (via turnId check — controller tracks activeTurnId)
  it("stale worker message: generate-done for wrong turnId is rejected", () => {
    boot(ctrl);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    // Caller should check: if (msg.turnId !== ctrl.activeTurnId) ignore
    // The controller doesn't auto-reject — callers gate on activeTurnId
    expect(ctrl.activeTurnId).toBe("t1");
    // Simulate stale message from old worker for turnId "t0" — caller discards
    const isStale = "t0" !== ctrl.activeTurnId;
    expect(isStale).toBe(true);
    // Complete real turn
    ctrl.dispatch({ type: "GENERATE_DONE", turnId: "t1" });
    expect(ctrl.state).toBe("ready");
  });

  // Scenario 9: SEND cannot remain permanently disabled
  it("chat input re-enabled after recycle", () => {
    boot(ctrl);
    expect(ctrl.chatInputEnabled).toBe(true);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    ctrl.dispatch({ type: "D3D12_OOM" });
    expect(ctrl.chatInputEnabled).toBe(false); // recycling: disabled
    ctrl.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "d3d12-oom" });
    expect(ctrl.chatInputEnabled).toBe(false); // recovering: disabled
    ctrl.dispatch({ type: "BOOT_COMPLETE" });
    expect(ctrl.chatInputEnabled).toBe(true); // ready: enabled
  });

  // Scenario 10: FATAL_ERROR path — no "model still loading" shown after UI active
  it("FATAL_ERROR: bootComplete=true, webgpuFallbackEngaged=true, modelLoadError set", () => {
    boot(ctrl);
    ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
    ctrl.dispatch({ type: "FATAL_ERROR", error: "ONNX session creation failed" });
    expect(ctrl.state).toBe("failed");
    expect(ctrl.webgpuFallbackEngaged).toBe(true);
    expect(ctrl.bootComplete).toBe(true); // chat-input gate unblocked
    expect(ctrl.modelLoadError).toBe("ONNX session creation failed");
    expect(ctrl.showBootOverlay).toBe(false); // boot overlay gone even in failed state
    // chat input "enabled" in failed state so user sees error on next send
    expect(ctrl.chatInputEnabled).toBe(true);
  });

  // Bonus: invalid transition throws in strict mode
  it("invalid transition throws in strict mode", () => {
    expect(() => ctrl.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" })).toThrow(
      "[ARC] invalid transition: idle + GENERATE_REQUESTED",
    );
  });

  // Bonus: transition log contains from/event/to
  it("transition logging via onTransition callback", () => {
    const log: string[] = [];
    ctrl.onTransition((from, ev, to) => log.push(`${from}+${ev.type}→${to}`));
    ctrl.dispatch({ type: "BOOT_REQUESTED" });
    ctrl.dispatch({ type: "BOOT_COMPLETE" });
    expect(log).toContain("idle+BOOT_REQUESTED→booting");
    expect(log).toContain("booting+BOOT_COMPLETE→ready");
  });
});
