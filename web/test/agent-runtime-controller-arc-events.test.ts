// agent-runtime-controller-arc-events.test.ts — #1868 Path A unit tests.
// Gates #1795 closure. Replaces cohort S4-S6 (headless Chrome has no WebGPU;
// app never spawns Worker → proxy injection has nothing to intercept).
//
// Tests the ARC state machine directly: transitions, recycleCount, derived
// fields. No real GPU, no browser, deterministic. <5s total.
//
// Scenario mapping to original cohort spec:
//   S4: device-lost dgpu (first)       → D3D12_OOM from generating → recycling → recovering → ready
//   S5: device-lost igpu               → FATAL_ERROR from generating → failed
//   S6: device-lost dgpu × 2 → recovering → D3D12_OOM → recycling (PR #1841 fix)

import { describe, test, expect, beforeEach } from "bun:test";
import {
  AgentRuntimeController,
  setStrictMode,
} from "../src/agent/agent-runtime-controller";

function bootedCtrl(): AgentRuntimeController {
  const c = new AgentRuntimeController();
  c.dispatch({ type: "BOOT_REQUESTED" });
  c.dispatch({ type: "MODEL_READY", device: "NVIDIA GeForce RTX 4090" });
  c.dispatch({ type: "BOOT_COMPLETE" });
  return c;
}

function generatingCtrl(): AgentRuntimeController {
  const c = bootedCtrl();
  c.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
  return c;
}

describe("AgentRuntimeController — #1868 ARC event unit tests", () => {
  beforeEach(() => setStrictMode(true));

  // ── S4: device-lost dgpu (first) ─────────────────────────────────────────

  describe("S4: D3D12_OOM from generating → planned recycle path", () => {
    test("generating + D3D12_OOM → recycling", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.state).toBe("recycling");
    });

    test("D3D12_OOM increments recycleCount", () => {
      const c = generatingCtrl();
      expect(c.recycleCount).toBe(0);
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.recycleCount).toBe(1);
    });

    test("D3D12_OOM clears workerReady and bootComplete", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.workerReady).toBe(false);
      expect(c.bootComplete).toBe(false);
    });

    test("D3D12_OOM sets nextInitNoWarmup", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.nextInitNoWarmup).toBe(true);
    });

    test("recycling + WORKER_RECYCLED → recovering (recycleCount unchanged)", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      const before = c.recycleCount;
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "device-lost-dgpu" });
      expect(c.state).toBe("recovering");
      expect(c.recycleCount).toBe(before); // planned path: already incremented by D3D12_OOM
    });

    test("recovering + MODEL_READY → recovering (stays in recovery)", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "device-lost-dgpu" });
      c.dispatch({ type: "MODEL_READY", device: "NVIDIA GeForce RTX 4090" });
      expect(c.state).toBe("recovering");
    });

    test("recovering + BOOT_COMPLETE → ready", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "device-lost-dgpu" });
      c.dispatch({ type: "MODEL_READY", device: "NVIDIA GeForce RTX 4090" });
      c.dispatch({ type: "BOOT_COMPLETE" });
      expect(c.state).toBe("ready");
      expect(c.bootComplete).toBe(true);
      expect(c.workerReady).toBe(true);
      expect(c.recycleCount).toBe(1);
    });

    test("full S4 cycle emits arc:transition events for each hop", () => {
      const c = new AgentRuntimeController();
      const transitions: string[] = [];
      c.onTransition((from, ev, to) => transitions.push(`${from}+${ev.type}→${to}`));

      c.dispatch({ type: "BOOT_REQUESTED" });
      c.dispatch({ type: "MODEL_READY", device: "GPU" });
      c.dispatch({ type: "BOOT_COMPLETE" });
      c.dispatch({ type: "GENERATE_REQUESTED", turnId: "t1" });
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "device-lost-dgpu" });
      c.dispatch({ type: "BOOT_COMPLETE" });

      expect(transitions).toContain("generating+D3D12_OOM→recycling");
      expect(transitions).toContain("recycling+WORKER_RECYCLED→recovering");
      expect(transitions).toContain("recovering+BOOT_COMPLETE→ready");
    });
  });

  // ── S5: device-lost igpu (retryBudget=0 → FATAL_ERROR) ──────────────────

  describe("S5: FATAL_ERROR from generating → failed", () => {
    test("generating + FATAL_ERROR → failed", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "FATAL_ERROR", error: "device-lost-recycle-limit", reason: "igpu-no-retry" });
      expect(c.state).toBe("failed");
    });

    test("FATAL_ERROR sets webgpuFallbackEngaged", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "FATAL_ERROR", error: "device-lost-recycle-limit" });
      expect(c.webgpuFallbackEngaged).toBe(true);
    });

    test("FATAL_ERROR sets modelLoadError", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "FATAL_ERROR", error: "device-lost-recycle-limit" });
      expect(c.modelLoadError).toBe("device-lost-recycle-limit");
    });

    test("FATAL_ERROR sets bootComplete (unblocks chat-input gate)", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "FATAL_ERROR", error: "device-lost-recycle-limit" });
      expect(c.bootComplete).toBe(true);
    });

    test("chatInputEnabled is true in failed state (user can read error)", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "FATAL_ERROR", error: "device-lost-recycle-limit" });
      expect(c.chatInputEnabled).toBe(true);
    });

    test("failed + BOOT_REQUESTED → booting (escape from failed state)", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "FATAL_ERROR", error: "device-lost-recycle-limit" });
      c.dispatch({ type: "BOOT_REQUESTED" });
      expect(c.state).toBe("booting");
    });
  });

  // ── S6: device-lost dgpu × 2 — PR #1841 fix ─────────────────────────────

  describe("S6: D3D12_OOM from recovering → recycling (PR #1841 fix)", () => {
    test("recovering + D3D12_OOM → recycling (was invalid before #1841)", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "device-lost-dgpu" });
      expect(c.state).toBe("recovering");

      // Second device-lost during post-recycle boot — this is the #1841 fix
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.state).toBe("recycling");
    });

    test("second D3D12_OOM from recovering increments recycleCount to 2", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "device-lost-dgpu" });
      c.dispatch({ type: "D3D12_OOM" }); // second loss
      expect(c.recycleCount).toBe(2);
    });

    test("full S6 cycle: two D3D12_OOM events → second WORKER_RECYCLED → recovering", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "device-lost-dgpu" });
      // Second loss during recovery
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 2, reason: "device-lost-dgpu" });
      expect(c.state).toBe("recovering");
      expect(c.recycleCount).toBe(2);
    });

    test("transition callback sees both recycling hops", () => {
      const c = generatingCtrl();
      const recyclingHops: string[] = [];
      c.onTransition((from, ev, to) => {
        if (to === "recycling") recyclingHops.push(`${from}+${ev.type}`);
      });

      c.dispatch({ type: "D3D12_OOM" });                                          // first
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "dl" });
      c.dispatch({ type: "D3D12_OOM" });                                          // second (#1841)

      expect(recyclingHops).toHaveLength(2);
      expect(recyclingHops[0]).toBe("generating+D3D12_OOM");
      expect(recyclingHops[1]).toBe("recovering+D3D12_OOM");
    });
  });

  // ── Unplanned recycle from ready (WORKER_RECYCLED without prior D3D12_OOM) ─

  describe("unplanned recycle from ready (WORKER_RECYCLED without D3D12_OOM)", () => {
    test("ready + WORKER_RECYCLED → recovering", () => {
      const c = bootedCtrl();
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "crash" });
      expect(c.state).toBe("recovering");
    });

    test("unplanned recycle increments recycleCount", () => {
      const c = bootedCtrl();
      expect(c.recycleCount).toBe(0);
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "crash" });
      expect(c.recycleCount).toBe(1);
    });

    test("unplanned recycle clears workerReady and bootComplete", () => {
      const c = bootedCtrl();
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "crash" });
      expect(c.workerReady).toBe(false);
      expect(c.bootComplete).toBe(false);
    });

    test("unplanned recycle sets nextInitNoWarmup", () => {
      const c = bootedCtrl();
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "crash" });
      expect(c.nextInitNoWarmup).toBe(true);
    });
  });

  // ── Invalid transitions throw in strict mode ──────────────────────────────

  describe("invalid transitions throw in strict mode", () => {
    test("idle + D3D12_OOM → throws", () => {
      const c = new AgentRuntimeController();
      expect(() => c.dispatch({ type: "D3D12_OOM" })).toThrow("[ARC] invalid transition");
    });

    test("booting + GENERATE_DONE → throws (unless via booting→generating path)", () => {
      const c = new AgentRuntimeController();
      c.dispatch({ type: "BOOT_REQUESTED" });
      expect(() => c.dispatch({ type: "GENERATE_DONE", turnId: "t1" })).toThrow("[ARC] invalid transition");
    });

    test("failed + D3D12_OOM → throws (failed is terminal except BOOT_REQUESTED)", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "FATAL_ERROR", error: "e" });
      expect(c.state).toBe("failed");
      expect(() => c.dispatch({ type: "D3D12_OOM" })).toThrow("[ARC] invalid transition");
    });
  });

  // ── chatInputEnabled gate ────────────────────────────────────────────────

  describe("chatInputEnabled", () => {
    test("false in idle state", () => {
      expect(new AgentRuntimeController().chatInputEnabled).toBe(false);
    });

    test("false during booting", () => {
      const c = new AgentRuntimeController();
      c.dispatch({ type: "BOOT_REQUESTED" });
      expect(c.chatInputEnabled).toBe(false);
    });

    test("true in ready state after boot", () => {
      expect(bootedCtrl().chatInputEnabled).toBe(true);
    });

    test("true during generating (streaming)", () => {
      expect(generatingCtrl().chatInputEnabled).toBe(true);
    });

    test("false during recycling", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.chatInputEnabled).toBe(false);
    });

    test("false during recovering", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "dl" });
      expect(c.chatInputEnabled).toBe(false);
    });
  });

  // ── §#1505: unplannedOomCount — planned recycles must NOT count ──────────

  describe("unplannedOomCount (#1505 VRAM management)", () => {
    test("starts at 0", () => {
      expect(new AgentRuntimeController().unplannedOomCount).toBe(0);
    });

    test("unplanned D3D12_OOM increments unplannedOomCount", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.unplannedOomCount).toBe(1);
    });

    test("planned D3D12_OOM (reason='planned') does NOT increment unplannedOomCount", () => {
      const c = bootedCtrl();
      c.dispatch({ type: "D3D12_OOM", reason: "planned" });
      expect(c.unplannedOomCount).toBe(0);
      expect(c.recycleCount).toBe(1); // recycleCount still increments
    });

    test("planned + unplanned: only unplanned contributes to unplannedOomCount", () => {
      const c = bootedCtrl();
      c.dispatch({ type: "D3D12_OOM", reason: "planned" }); // planned flush
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "planned" });
      c.dispatch({ type: "BOOT_COMPLETE" }); // → ready
      c.dispatch({ type: "GENERATE_REQUESTED", turnId: "t2" });
      c.dispatch({ type: "D3D12_OOM" }); // actual OOM
      expect(c.unplannedOomCount).toBe(1);
      expect(c.recycleCount).toBe(2);
    });

    test("BOOT_REQUESTED resets unplannedOomCount", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "D3D12_OOM" });
      expect(c.unplannedOomCount).toBe(1);
      c.dispatch({ type: "WORKER_RECYCLED", recycleCount: 1, reason: "test" });
      c.dispatch({ type: "FATAL_ERROR", error: "test" });
      c.dispatch({ type: "BOOT_REQUESTED" });
      expect(c.unplannedOomCount).toBe(0);
    });

    test("SELF_SPEC_DRAFT_DEVICE_LOST increments unplannedOomCount", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "SELF_SPEC_DRAFT_DEVICE_LOST", turnId: "t1" });
      expect(c.unplannedOomCount).toBe(1);
    });

    test("SELF_SPEC_VERIFY_D3D12_OOM increments unplannedOomCount", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "SELF_SPEC_VERIFY_D3D12_OOM", turnId: "t1" });
      expect(c.unplannedOomCount).toBe(1);
    });

    test("WATCHDOG_TIMEOUT increments unplannedOomCount", () => {
      const c = generatingCtrl();
      c.dispatch({ type: "WATCHDOG_TIMEOUT", turnId: "t1" });
      expect(c.unplannedOomCount).toBe(1);
    });
  });
});
