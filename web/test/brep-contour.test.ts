// brep-contour.test.ts — AC #1829: SdContour brep-op palette.
//
// Tests:
//   1. SdContour schema: target required, interval+count optional; synonyms.
//   2. Synonym routing: 'contour' / 'sections' / 'slice' → SdContour.
//   3. Dispatch: mock handler receives target + interval + count.
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
  unregisterHandler("SdContour");
});

// ── 1. Schema ─────────────────────────────────────────────────────────────────

describe("SdContour schema", () => {
  test("SdContour is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdContour");
    expect(entry).toBeDefined();
  });

  test("target arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdContour");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "target");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("interval arg is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdContour");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "interval");
    expect(arg).toBeDefined();
    expect(arg?.required).toBeFalsy();
  });

  test("count arg is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdContour");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "count");
    expect(arg).toBeDefined();
    expect(arg?.required).toBeFalsy();
  });

  test("SdContour has synonyms including 'contour'", () => {
    const entry = getDictionary().find((e) => e.name === "SdContour");
    expect(entry?.synonyms).toContain("contour");
  });
});

// ── 2. Synonym resolution ─────────────────────────────────────────────────────

describe("SdContour synonym resolution", () => {
  test("'contour' resolves to SdContour", () => {
    expect(resolveVerb("contour")).toBe("SdContour");
  });

  test("'sections' resolves to SdContour", () => {
    expect(resolveVerb("sections")).toBe("SdContour");
  });

  test("'slice' resolves to SdContour", () => {
    expect(resolveVerb("slice")).toBe("SdContour");
  });

  test("SdContour resolves to itself", () => {
    expect(resolveVerb("SdContour")).toBe("SdContour");
  });
});

// ── 3. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdContour dispatch routing", () => {
  test("mock handler receives target via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdContour", (args) => {
      calls.push(args);
      return { target: args.target, contourLevels: [1, 2, 3], sliceCount: 3, interval: 1 };
    });
    const dr = dispatchSync("SdContour", { target: "solid-uuid-1" });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe("solid-uuid-1");
  });

  test("mock handler receives target + interval", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdContour", (args) => {
      calls.push(args);
      return { target: args.target, contourLevels: [0.5, 1.5], sliceCount: 2, interval: args.interval };
    });
    const dr = dispatchSync("SdContour", { target: "solid-uuid-2", interval: 0.5 });
    expect(dr.ok).toBe(true);
    expect(calls[0].interval).toBe(0.5);
  });

  test("mock handler receives target + count", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdContour", (args) => {
      calls.push(args);
      return { target: args.target, contourLevels: [1,2,3,4,5,6,7,8,9,10], sliceCount: 10, interval: 0 };
    });
    const dr = dispatchSync("SdContour", { target: "solid-uuid-3", count: 10 });
    expect(dr.ok).toBe(true);
    expect(calls[0].count).toBe(10);
  });

  test("synonym 'contour' routes to SdContour handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdContour", (args) => {
      calls.push(args);
      return { target: "x", contourLevels: [], sliceCount: 0, interval: 1 };
    });
    expect(dispatchSync("contour", { target: "solid-uuid-4" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'sections' routes to SdContour handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdContour", (args) => {
      calls.push(args);
      return { target: "x", contourLevels: [], sliceCount: 0, interval: 1 };
    });
    expect(dispatchSync("sections", { target: "solid-uuid-5" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'slice' routes to SdContour handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdContour", (args) => {
      calls.push(args);
      return { target: "x", contourLevels: [], sliceCount: 0, interval: 1 };
    });
    expect(dispatchSync("slice", { target: "solid-uuid-6" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("handler result has contourLevels array + sliceCount", () => {
    registerHandler("SdContour", () => ({
      target: "s1", contourLevels: [1.0, 2.0, 3.0, 4.0, 5.0], sliceCount: 5, interval: 1,
    }));
    const dr = dispatchSync("SdContour", { target: "s1" });
    expect(dr.ok).toBe(true);
    const result = (dr as { ok: true; result: { contourLevels: number[]; sliceCount: number } }).result;
    expect(result.contourLevels).toHaveLength(5);
    expect(result.sliceCount).toBe(5);
  });
});

// ── 4. Error path ─────────────────────────────────────────────────────────────

describe("SdContour error path", () => {
  test("missing target → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdContour", () => ({ target: "x", contourLevels: [], sliceCount: 0, interval: 1 }));
    const dr = dispatchSync("SdContour", {});
    expect(dr.ok).toBe(false);
  });

  test("target supplied, interval+count omitted → dispatch succeeds (both optional)", () => {
    registerHandler("SdContour", () => ({ target: "s1", contourLevels: [1,2,3], sliceCount: 3, interval: 1 }));
    const dr = dispatchSync("SdContour", { target: "solid-x" });
    expect(dr.ok).toBe(true);
  });
});
