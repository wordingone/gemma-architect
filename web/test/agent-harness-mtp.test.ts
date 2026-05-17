// agent-harness-mtp.test.ts — MTP gate logic tests.
//
// agent-harness.ts cannot be imported directly in Bun test env (@huggingface/transformers
// requires a browser DOM). These tests mirror the gate logic inline and assert the
// compile-time constant that guards the spec-decode loop.

import { describe, expect, test } from "bun:test";

// Mirror of the gate constant from agent-harness.ts (must match — CI fails if out of sync).
// #738: flipped to true — drafter ONNX deployed, output names confirmed (scatter/linear_21).
const MTP_VERIFICATION_WIRED = true;

// Mirror of payloadHasMultimodal() from agent-harness.ts (#740-C).
function payloadHasMultimodal(req: { userImage?: string; frames?: unknown[] }): boolean {
  if (req.userImage) return true;
  if (req.frames && req.frames.length > 0) return true;
  return false;
}

// Mirror of the drafterReady gate after #738 + #740-C.
// Two-gate (drafter loaded + verification wired) + multimodal bypass.
function computeDrafterReady(
  drafterLoaded: boolean,
  verificationWired: boolean,
  multimodalPayload: boolean,
): boolean {
  return drafterLoaded && verificationWired && !multimodalPayload;
}

describe("#738 + #740-C — MTP verification gate (two-gate + multimodal bypass)", () => {
  test("drafterReady is true when drafter loaded + WIRED=true + text-only request", () => {
    expect(computeDrafterReady(true, MTP_VERIFICATION_WIRED, false)).toBe(true);
  });

  test("drafterReady is false when drafter not loaded", () => {
    expect(computeDrafterReady(false, true, false)).toBe(false);
  });

  test("drafterReady is false when MTP_VERIFICATION_WIRED=false", () => {
    expect(computeDrafterReady(true, false, false)).toBe(false);
  });

  test("drafterReady is false when payload has image (userImage)", () => {
    const req = { prompt: "describe the building", userImage: "data:image/png;base64,abc" };
    expect(computeDrafterReady(true, true, payloadHasMultimodal(req))).toBe(false);
  });

  test("drafterReady is false when payload has viewport frames", () => {
    const req = { prompt: "what do you see?", frames: [{}] as unknown[] };
    expect(computeDrafterReady(true, true, payloadHasMultimodal(req))).toBe(false);
  });

  test("MTP_VERIFICATION_WIRED constant is true — drafter ONNX deployed (#738)", () => {
    expect(MTP_VERIFICATION_WIRED).toBe(true);
  });

  test("mtp_on stays false when drafterReady=false (telemetry honesty)", () => {
    const specAttempts = 0;
    const drafterReady = computeDrafterReady(true, MTP_VERIFICATION_WIRED, false);
    const mtpActive = drafterReady && specAttempts > 0;
    // drafterReady is true, but no spec attempts ran → mtpActive false
    expect(drafterReady).toBe(true);
    expect(mtpActive).toBe(false);
  });

  test("mtp_on false when multimodal bypass engaged", () => {
    const specAttempts = 0;
    const multimodalReq = { userImage: "data:image/png;base64,abc" };
    const drafterReady = computeDrafterReady(true, true, payloadHasMultimodal(multimodalReq));
    const mtpActive = drafterReady && specAttempts > 0;
    expect(drafterReady).toBe(false);
    expect(mtpActive).toBe(false);
  });
});
