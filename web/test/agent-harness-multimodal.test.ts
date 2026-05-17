// agent-harness-multimodal.test.ts — #740-C multimodal fallback gate scenarios.
//
// Mirrors payloadHasMultimodal() and the two-gate + multimodal bypass inline
// (agent-harness.ts cannot be imported in Bun test env — needs browser DOM).

import { describe, expect, test } from "bun:test";

// Mirror of gate constant (#738 — drafter ONNX deployed).
const MTP_VERIFICATION_WIRED = true;

// Mirror of payloadHasMultimodal() from agent-harness.ts (#740-C).
function payloadHasMultimodal(req: { prompt?: string; userImage?: string; frames?: unknown[] }): boolean {
  if (req.userImage) return true;
  if (req.frames && req.frames.length > 0) return true;
  return false;
}

// Mirror of drafterReady gate (two-gate + multimodal bypass).
function computeDrafterReady(
  drafterLoaded: boolean,
  verificationWired: boolean,
  multimodalPayload: boolean,
): boolean {
  return drafterLoaded && verificationWired && !multimodalPayload;
}

describe("#740-C — multimodal fallback path scenarios", () => {
  test("text-only prompt → payloadHasMultimodal=false → MTP path fires (drafterReady=true)", () => {
    const req = { prompt: "place a wall from 0,0 to 5,0" };
    const multimodal = payloadHasMultimodal(req);
    const drafterReady = computeDrafterReady(true, MTP_VERIFICATION_WIRED, multimodal);
    expect(multimodal).toBe(false);
    expect(drafterReady).toBe(true);
  });

  test("image-bearing (userImage) → payloadHasMultimodal=true → fallback path (drafterReady=false)", () => {
    const req = {
      prompt: "describe the building in this image",
      userImage: "data:image/png;base64,iVBORw0KGgo=",
    };
    const multimodal = payloadHasMultimodal(req);
    const drafterReady = computeDrafterReady(true, MTP_VERIFICATION_WIRED, multimodal);
    expect(multimodal).toBe(true);
    expect(drafterReady).toBe(false);
  });

  test("viewport-capture (frames) → payloadHasMultimodal=true → fallback path (drafterReady=false)", () => {
    const req = {
      prompt: "what do you see in the viewport?",
      frames: [{}] as unknown[],
    };
    const multimodal = payloadHasMultimodal(req);
    const drafterReady = computeDrafterReady(true, MTP_VERIFICATION_WIRED, multimodal);
    expect(multimodal).toBe(true);
    expect(drafterReady).toBe(false);
  });

  test("mtp_on telemetry is false when multimodal bypass engaged (specAttempts=0, drafterReady=false)", () => {
    const specAttempts = 0;
    const req = { prompt: "show me the floor plan", userImage: "data:image/png;base64,abc" };
    const multimodal = payloadHasMultimodal(req);
    const drafterReady = computeDrafterReady(true, MTP_VERIFICATION_WIRED, multimodal);
    const mtpOn = drafterReady && specAttempts > 0;
    expect(drafterReady).toBe(false);
    expect(mtpOn).toBe(false);
  });
});
