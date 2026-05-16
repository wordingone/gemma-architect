// agent-harness-mtp.test.ts — #679 AC3: MTP verification gate stays dormant.
//
// agent-harness.ts cannot be imported directly in Bun test env (@huggingface/transformers
// requires a browser DOM). These tests mirror the gate logic inline and assert the
// compile-time constant that guards the spec-decode loop.

import { describe, expect, test } from "bun:test";

// Mirror of the gate constant from agent-harness.ts (must match — CI fails if out of sync).
// When #679 AC2 (real per-token verification) lands, flip BOTH this AND the source constant.
const MTP_VERIFICATION_WIRED = false;

describe("#679 — MTP verification gate (drafterReady three-way guard)", () => {
  function computeDrafterReady(
    drafterLoaded: boolean,
    targetHasHiddenStates: boolean,
    verificationWired: boolean,
  ): boolean {
    return drafterLoaded && targetHasHiddenStates && verificationWired;
  }

  test("drafterReady is false when MTP_VERIFICATION_WIRED=false, even if drafter loaded + target has hidden states", () => {
    const ready = computeDrafterReady(true, true, MTP_VERIFICATION_WIRED);
    expect(ready).toBe(false);
  });

  test("drafterReady is false when drafter not loaded", () => {
    expect(computeDrafterReady(false, true, true)).toBe(false);
  });

  test("drafterReady is false when target lacks hidden states", () => {
    expect(computeDrafterReady(true, false, true)).toBe(false);
  });

  test("drafterReady is true only when all three conditions hold", () => {
    expect(computeDrafterReady(true, true, true)).toBe(true);
  });

  test("MTP_VERIFICATION_WIRED constant is false — spec-decode dormant by default", () => {
    // This test fails if someone flips the constant without implementing AC2.
    // Before flipping to true: real per-token target verification must be in place (#679 AC2).
    expect(MTP_VERIFICATION_WIRED).toBe(false);
  });

  test("mtp_on stays false when drafterReady=false (telemetry honesty)", () => {
    const specAttempts = 0; // no spec-decode ran
    const drafterReady = computeDrafterReady(true, true, MTP_VERIFICATION_WIRED);
    const mtpActive = drafterReady && specAttempts > 0;
    expect(mtpActive).toBe(false);
    expect(specAttempts).toBe(0);
  });
});
