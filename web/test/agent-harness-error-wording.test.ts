// agent-harness-error-wording.test.ts — #1369: error message branches on error text.
//
// agent-harness.ts cannot be imported directly (WebGPU/transformers deps).
// Mirror the §C-error-wording branch logic inline and assert each path.

import { describe, expect, test } from "bun:test";

// Mirror of §C-error-wording guard in agent-harness.ts (_modelLoadError branch).
function formatModelLoadError(errorText: string): string {
  const isWebGpuError = /WebGPU|adapter|GPUDevice|requestAdapter/i.test(errorText);
  return isWebGpuError
    ? `Model failed to load — WebGPU may not be supported on this device. Try Chrome 115+ on a desktop with a dedicated GPU. (${errorText})`
    : `Model failed to load — ${errorText}. Try refreshing or check the browser console for details.`;
}

describe("#1369 — model load error wording branches on error text", () => {
  test("(a) WebGPU adapter unavailable → WebGPU-attribution wording", () => {
    const msg = formatModelLoadError("Failed to requestAdapter: WebGPU is not supported");
    expect(msg).toContain("WebGPU may not be supported");
    expect(msg).toContain("Chrome 115+");
    expect(msg).toContain("requestAdapter");
  });

  test("(a2) GPUDevice lost → WebGPU-attribution wording", () => {
    const msg = formatModelLoadError("GPUDevice was lost");
    expect(msg).toContain("WebGPU may not be supported");
    expect(msg).toContain("GPUDevice was lost");
  });

  test("(a3) adapter keyword → WebGPU-attribution wording", () => {
    const msg = formatModelLoadError("Could not get adapter from navigator.gpu");
    expect(msg).toContain("WebGPU may not be supported");
  });

  test("(b) fetch 401 → generic wording, no WebGPU mention", () => {
    const msg = formatModelLoadError("HTTP 401 Unauthorized fetching model manifest");
    expect(msg).toContain("Model failed to load");
    expect(msg).toContain("Try refreshing");
    expect(msg).not.toContain("WebGPU may not be supported");
    expect(msg).not.toContain("Chrome 115+");
    expect(msg).toContain("HTTP 401 Unauthorized");
  });

  test("(c) ONNX session create failure → generic wording, no WebGPU mention", () => {
    const msg = formatModelLoadError("Failed to create ONNX InferenceSession: invalid model");
    expect(msg).toContain("Model failed to load");
    expect(msg).toContain("browser console");
    expect(msg).not.toContain("WebGPU may not be supported");
    expect(msg).toContain("invalid model");
  });

  test("(c2) network fetch 404 → generic wording", () => {
    const msg = formatModelLoadError("404 Not Found: ort.bundle.min-BPFhwRnR.js");
    expect(msg).toContain("Model failed to load");
    expect(msg).not.toContain("WebGPU may not be supported");
    expect(msg).toContain("404 Not Found");
  });
});
