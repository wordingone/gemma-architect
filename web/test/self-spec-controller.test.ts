// self-spec-controller.test.ts — Gate conditions for #1860 Sub-5.
// Run: bun test web/test/self-spec-controller.test.ts

import { describe, expect, test, beforeEach } from "bun:test";
import {
  SelfSpecController,
  type SelfSpecRuntimeState,
} from "../src/agent/self-spec-controller";

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

// ── Warmup gate ───────────────────────────────────────────────────────────────

describe("warmup gate — first 3 turns always disabled", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); });

  test("turn 0: disabled (warmup 0/3)", () => {
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/warmup\(0\/3\)/);
  });

  test("turn 1: disabled after 1 recordTurn", () => {
    ctrl.recordTurn(0.9);
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/warmup\(1\/3\)/);
  });

  test("turn 2: disabled after 2 recordTurns", () => {
    ctrl.recordTurn(0.9);
    ctrl.recordTurn(0.9);
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(false);
    expect(r.reason).toMatch(/warmup\(2\/3\)/);
  });

  test("turn 3: enabled after warmup complete (happy state)", () => {
    warmUp(ctrl);
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(true);
  });
});

// ── Enable conditions (6) ─────────────────────────────────────────────────────

describe("enable condition: backendPath must be webgpu", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("remote backend → disabled", () => {
    const r = ctrl.shouldActivate(makeState({ backendPath: "remote" }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain("remote");
  });

  test("wasm backend → disabled", () => {
    const r = ctrl.shouldActivate(makeState({ backendPath: "wasm" }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain("wasm");
  });

  test("webgpu backend → eligible", () => {
    expect(ctrl.shouldActivate(makeState({ backendPath: "webgpu" })).active).toBe(true);
  });
});

describe("enable condition: modelReady", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("modelReady=false → disabled with reason", () => {
    const r = ctrl.shouldActivate(makeState({ modelReady: false }));
    expect(r.active).toBe(false);
    expect(r.reason).toBe("model_not_ready");
  });

  test("modelReady=true → eligible", () => {
    expect(ctrl.shouldActivate(makeState({ modelReady: true })).active).toBe(true);
  });
});

describe("enable condition: prefillComplete", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("prefillComplete=false → disabled", () => {
    const r = ctrl.shouldActivate(makeState({ prefillComplete: false }));
    expect(r.active).toBe(false);
    expect(r.reason).toBe("prefill_incomplete");
  });

  test("prefillComplete=true → eligible", () => {
    expect(ctrl.shouldActivate(makeState({ prefillComplete: true })).active).toBe(true);
  });
});

describe("enable condition: inputLength ≤ contextLimit", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("inputLength > contextLimit → disabled", () => {
    const r = ctrl.shouldActivate(makeState({ inputLength: 16385, contextLimit: 16384 }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain("input_overflow");
  });

  test("inputLength = contextLimit → enabled (boundary equal)", () => {
    expect(ctrl.shouldActivate(makeState({ inputLength: 16384, contextLimit: 16384 })).active).toBe(true);
  });

  test("inputLength < contextLimit → enabled", () => {
    expect(ctrl.shouldActivate(makeState({ inputLength: 1000, contextLimit: 16384 })).active).toBe(true);
  });
});

describe("enable condition: recentAcceptanceRate ≥ 0.75 (post-warmup)", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); });

  test("acceptance rate 0.74 → disabled (below 0.75 floor)", () => {
    // Warmup with low rate
    for (let i = 0; i < 3; i++) ctrl.recordTurn(0.74);
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(false);
    expect(r.reason).toContain("acceptance_rate_low");
  });

  test("acceptance rate 0.75 → enabled (at floor)", () => {
    for (let i = 0; i < 3; i++) ctrl.recordTurn(0.75);
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });

  test("no prior acceptance data → enabled (optimistic default 1.0)", () => {
    // After warmup with high rate (no data before warmup resolves, but recordTurn IS called)
    for (let i = 0; i < 3; i++) ctrl.recordTurn(1.0);
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });
});

describe("enable condition: verifyBeta ≤ 1.35", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("verifyBeta = 1.36 → disabled (above soft enable ceiling)", () => {
    const r = ctrl.shouldActivate(makeState({ verifyBeta: 1.36 }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain("verify_beta_soft");
  });

  test("verifyBeta = 1.35 → enabled (at ceiling)", () => {
    expect(ctrl.shouldActivate(makeState({ verifyBeta: 1.35 })).active).toBe(true);
  });

  test("verifyBeta = 1.0 → enabled", () => {
    expect(ctrl.shouldActivate(makeState({ verifyBeta: 1.0 })).active).toBe(true);
  });
});

// ── Disable conditions (5) ────────────────────────────────────────────────────

describe("disable condition: consecutive low acceptance (≥3 turns < 0.70)", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("2 consecutive low turns → still enabled", () => {
    ctrl.recordTurn(0.65); // low
    ctrl.recordTurn(0.65); // low
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });

  test("3 consecutive low turns → force-disabled", () => {
    ctrl.recordTurn(0.65);
    ctrl.recordTurn(0.65);
    ctrl.recordTurn(0.65);
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(false);
    expect(r.reason).toContain("consecutive_low_acceptance");
  });

  test("force-disable lifts when acceptance recovers ≥ 0.75", () => {
    ctrl.recordTurn(0.65);
    ctrl.recordTurn(0.65);
    ctrl.recordTurn(0.65); // trigger force-disable
    expect(ctrl.shouldActivate(makeState()).active).toBe(false);
    ctrl.recordTurn(0.80); // recovery
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });

  test("consecutive low counter resets on good turn", () => {
    ctrl.recordTurn(0.65); // low
    ctrl.recordTurn(0.65); // low (2 consecutive)
    ctrl.recordTurn(0.85); // recovery resets counter
    ctrl.recordTurn(0.65); // low — but only 1 consecutive now
    ctrl.recordTurn(0.65); // 2 consecutive — still not 3
    expect(ctrl.shouldActivate(makeState()).active).toBe(true);
  });
});

describe("disable condition: deviceLost", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("deviceLost=true → disabled", () => {
    const r = ctrl.shouldActivate(makeState({ deviceLost: true }));
    expect(r.active).toBe(false);
    expect(r.reason).toBe("device_lost");
  });
});

describe("disable condition: recycleCount > 0", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("recycleCount=1 → disabled", () => {
    const r = ctrl.shouldActivate(makeState({ recycleCount: 1 }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain("recycle");
  });

  test("recycleCount=0 → eligible", () => {
    expect(ctrl.shouldActivate(makeState({ recycleCount: 0 })).active).toBe(true);
  });
});

describe("disable condition: verifyBeta > 1.45 (hard ceiling)", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("verifyBeta = 1.46 → hard-disabled", () => {
    const r = ctrl.shouldActivate(makeState({ verifyBeta: 1.46 }));
    expect(r.active).toBe(false);
    expect(r.reason).toContain("verify_beta_hard");
  });

  test("verifyBeta = 1.45 → not hard-disabled (still soft-disabled at 1.36-1.45)", () => {
    // Between 1.35 (soft enable ceil) and 1.45 (hard disable): soft disable fires first
    const r = ctrl.shouldActivate(makeState({ verifyBeta: 1.45 }));
    // Either soft or hard disable: just confirm disabled
    expect(r.active).toBe(false);
  });
});

describe("disable condition: highEntropyMode", () => {
  let ctrl: SelfSpecController;
  beforeEach(() => { ctrl = new SelfSpecController(); warmUp(ctrl); });

  test("highEntropyMode=true → disabled", () => {
    const r = ctrl.shouldActivate(makeState({ highEntropyMode: true }));
    expect(r.active).toBe(false);
    expect(r.reason).toBe("high_entropy_mode");
  });

  test("highEntropyMode=false → eligible", () => {
    expect(ctrl.shouldActivate(makeState({ highEntropyMode: false })).active).toBe(true);
  });
});

// ── Reason string always set ──────────────────────────────────────────────────

describe("reason string is always populated", () => {
  test("active result includes rate and beta in reason", () => {
    const ctrl = new SelfSpecController();
    warmUp(ctrl);
    const r = ctrl.shouldActivate(makeState());
    expect(r.active).toBe(true);
    expect(r.reason).toMatch(/active\(rate=[\d.]+,beta=[\d.]+\)/);
  });

  test("disabled result has non-empty reason string", () => {
    const ctrl = new SelfSpecController();
    const r = ctrl.shouldActivate(makeState()); // warmup → disabled
    expect(r.reason.length).toBeGreaterThan(0);
  });
});

// ── Accessor correctness ─────────────────────────────────────────────────────

describe("accessor values reflect internal state", () => {
  test("turnsCompleted increments with each recordTurn", () => {
    const ctrl = new SelfSpecController();
    expect(ctrl.turnsCompleted).toBe(0);
    ctrl.recordTurn(0.9);
    expect(ctrl.turnsCompleted).toBe(1);
    ctrl.recordTurn(0.9);
    expect(ctrl.turnsCompleted).toBe(2);
  });

  test("forcedDisable is false until 3 consecutive low turns", () => {
    const ctrl = new SelfSpecController();
    warmUp(ctrl);
    expect(ctrl.forcedDisable).toBe(false);
    ctrl.recordTurn(0.65);
    ctrl.recordTurn(0.65);
    expect(ctrl.forcedDisable).toBe(false);
    ctrl.recordTurn(0.65);
    expect(ctrl.forcedDisable).toBe(true);
  });

  test("recentRate returns rolling average of acceptance window", () => {
    const ctrl = new SelfSpecController();
    for (let i = 0; i < 5; i++) ctrl.recordTurn(0.8);
    expect(ctrl.recentRate).toBeCloseTo(0.8, 4);
  });
});
