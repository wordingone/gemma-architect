// plane-tool.test.ts — AC #1827: Plane palette 3-point picker + dispatch routing.
//
// Tests:
//   1. SdPlane schema: origin, xAxis, yAxis all required; synonyms.
//   2. Synonym routing: 'plane' / 'ref-plane' / 'surface-plane' → SdPlane.
//   3. Dispatch: mock handler receives origin + xAxis + yAxis.
//   4. Error path: missing required field → schema validation failure.

import { describe, expect, test, beforeEach } from "bun:test";
import { getDictionary, clearDictionaryCache } from "../src/commands/dictionary";
import {
  resolveVerb,
  registerHandler,
  unregisterHandler,
  dispatchSync,
  setRuntimeAliases,
} from "../src/commands/dispatch";

beforeEach(() => {
  clearDictionaryCache();
  setRuntimeAliases({});
  unregisterHandler("SdPlane");
});

// ── 1. Schema ─────────────────────────────────────────────────────────────────

describe("SdPlane schema", () => {
  test("SdPlane is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdPlane");
    expect(entry).toBeDefined();
  });

  test("origin arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdPlane");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "origin");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("xAxis arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdPlane");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "xAxis");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("yAxis arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdPlane");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "yAxis");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });
});

// ── 2. Synonym resolution ─────────────────────────────────────────────────────

describe("SdPlane synonym resolution", () => {
  test("'plane' resolves to SdPlane", () => {
    expect(resolveVerb("plane")).toBe("SdPlane");
  });

  test("'ref-plane' resolves to SdPlane", () => {
    expect(resolveVerb("ref-plane")).toBe("SdPlane");
  });

  test("'surface-plane' resolves to SdPlane", () => {
    expect(resolveVerb("surface-plane")).toBe("SdPlane");
  });

  test("SdPlane resolves to itself", () => {
    expect(resolveVerb("SdPlane")).toBe("SdPlane");
  });
});

// ── 3. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdPlane dispatch routing", () => {
  test("mock handler receives origin + xAxis + yAxis via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdPlane", (args) => {
      calls.push(args);
      return { created: "plane" };
    });
    const origin = [0, 0, 0];
    const xAxis  = [5, 0, 0];
    const yAxis  = [0, 0, 3];
    const dr = dispatchSync("SdPlane", { origin, xAxis, yAxis });
    expect(dr.ok).toBe(true);
    expect((dr as { ok: true; canonical: string; result: { created: string } }).result.created).toBe("plane");
    expect(calls).toHaveLength(1);
    expect(calls[0].origin).toEqual(origin);
    expect(calls[0].xAxis).toEqual(xAxis);
    expect(calls[0].yAxis).toEqual(yAxis);
  });

  test("synonym 'plane' routes to SdPlane handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdPlane", (args) => {
      calls.push(args);
      return { created: "plane" };
    });
    const dr = dispatchSync("plane", { origin: [0,0,0], xAxis: [4,0,0], yAxis: [0,3,0] });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'ref-plane' routes to SdPlane handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdPlane", (args) => {
      calls.push(args);
      return { created: "plane" };
    });
    const dr = dispatchSync("ref-plane", { origin: [0,0,0], xAxis: [4,0,0], yAxis: [0,3,0] });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("dispatch with all 3 points produces created=plane", () => {
    registerHandler("SdPlane", () => ({ created: "plane" }));
    const dr = dispatchSync("SdPlane", {
      origin: [1, 2, 0],
      xAxis:  [6, 2, 0],
      yAxis:  [1, 7, 0],
    });
    expect(dr.ok).toBe(true);
    expect((dr as { ok: true; canonical: string; result: { created: string } }).result.created).toBe("plane");
  });
});

// ── 4. Error path ─────────────────────────────────────────────────────────────

describe("SdPlane error path", () => {
  test("missing origin → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdPlane", () => ({ created: "plane" }));
    const dr = dispatchSync("SdPlane", { xAxis: [5,0,0], yAxis: [0,3,0] });
    expect(dr.ok).toBe(false);
  });

  test("missing xAxis → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdPlane", () => ({ created: "plane" }));
    const dr = dispatchSync("SdPlane", { origin: [0,0,0], yAxis: [0,3,0] });
    expect(dr.ok).toBe(false);
  });

  test("missing yAxis → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdPlane", () => ({ created: "plane" }));
    const dr = dispatchSync("SdPlane", { origin: [0,0,0], xAxis: [5,0,0] });
    expect(dr.ok).toBe(false);
  });
});
