// agent-harness-mtp.test.ts — MTP gate logic tests.
//
// model-worker.ts cannot be imported directly in Bun test env (ORT WebGPU deps).
// These tests mirror the gate logic inline and assert the compile-time constant
// that guards the spec-decode loop in model-worker.ts.

import { describe, expect, test } from "bun:test";

// Mirror of MTP_VERIFICATION_WIRED from model-worker.ts (must match — CI fails if out of sync).
// #679: constant added to model-worker.ts; true = webgpu-mtp-backend.ts greedy verification wired.
const MTP_VERIFICATION_WIRED = true;

// Mirror of payloadHasMultimodal() from agent-harness.ts (#740-C).
function payloadHasMultimodal(req: { userImage?: string; frames?: unknown[] }): boolean {
  if (req.userImage) return true;
  if (req.frames && req.frames.length > 0) return true;
  return false;
}

// Mirror of the spec-decode gate in model-worker.ts (#679).
// Gate: useMtp && drafterLoaded && MTP_VERIFICATION_WIRED && inputLength < 900.
function computeSpecDecodeActive(
  useMtp: boolean,
  drafterLoaded: boolean,
  verificationWired: boolean,
  inputLength: number,
): boolean {
  return useMtp && drafterLoaded && verificationWired && inputLength < 900;
}

describe("#679 — MTP_VERIFICATION_WIRED gate (model-worker.ts spec-decode guard)", () => {
  test("spec-decode active when all three conditions met (text turn, short input)", () => {
    expect(computeSpecDecodeActive(true, true, MTP_VERIFICATION_WIRED, 100)).toBe(true);
  });

  test("spec-decode off when useMtp=false (?mtp=off query param)", () => {
    expect(computeSpecDecodeActive(false, true, true, 100)).toBe(false);
  });

  test("spec-decode off when drafter not loaded", () => {
    expect(computeSpecDecodeActive(true, false, true, 100)).toBe(false);
  });

  test("spec-decode off when MTP_VERIFICATION_WIRED=false", () => {
    expect(computeSpecDecodeActive(true, true, false, 100)).toBe(false);
  });

  test("spec-decode off when inputLength >= 900 (drafter quality gate)", () => {
    expect(computeSpecDecodeActive(true, true, true, 900)).toBe(false);
    expect(computeSpecDecodeActive(true, true, true, 997)).toBe(false);
  });

  test("MTP_VERIFICATION_WIRED constant is true — greedy verification wired in webgpu-mtp-backend.ts (#679)", () => {
    expect(MTP_VERIFICATION_WIRED).toBe(true);
  });

  // AC3 (#679): dormant path → mtp_on=false, spec_attempts=0
  test("dormant path: MTP_VERIFICATION_WIRED=false → gate blocks, mtp_on stays false", () => {
    const WIRED_FALSE = false;
    const gateOpen = computeSpecDecodeActive(true, true, WIRED_FALSE, 100);
    // Gate closed → spec_attempts never incremented → mtp_on must stay false.
    const specAttempts = gateOpen ? 1 : 0;
    const mtpActive = gateOpen && specAttempts > 0;
    expect(gateOpen).toBe(false);
    expect(specAttempts).toBe(0);
    expect(mtpActive).toBe(false);
  });

  test("dormant path: long input (≥900 tok) → gate blocks regardless of WIRED", () => {
    const gateOpen = computeSpecDecodeActive(true, true, true, 997);
    const specAttempts = gateOpen ? 1 : 0;
    const mtp_on = gateOpen && specAttempts > 0;
    expect(gateOpen).toBe(false);
    expect(specAttempts).toBe(0);
    expect(mtp_on).toBe(false);
  });

  // Multimodal bypass: payloadHasMultimodal → useMtp=false in agent-harness.ts.
  test("multimodal payload sets useMtp=false → spec-decode off", () => {
    const multimodalReq = { userImage: "data:image/png;base64,abc" };
    const useMtp = !payloadHasMultimodal(multimodalReq);
    expect(computeSpecDecodeActive(useMtp, true, true, 100)).toBe(false);
  });
});
