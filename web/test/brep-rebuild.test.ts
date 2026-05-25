// brep-rebuild.test.ts — AC #1829: SdRebuild brep-op palette.
//
// Tests:
//   1. SdRebuild schema: target required, count optional; synonyms in dictionary.
//   2. Synonym routing: 'rebuild' / 'refit' → SdRebuild.
//   3. Dispatch: mock handler receives target + count.
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
  unregisterHandler("SdRebuild");
});

// ── 1. Schema ─────────────────────────────────────────────────────────────────

describe("SdRebuild schema", () => {
  test("SdRebuild is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdRebuild");
    expect(entry).toBeDefined();
  });

  test("target arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdRebuild");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "target");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("count arg is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdRebuild");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "count");
    expect(arg).toBeDefined();
    expect(arg?.required).toBeFalsy();
  });

  test("SdRebuild has synonyms including 'rebuild'", () => {
    const entry = getDictionary().find((e) => e.name === "SdRebuild");
    expect(entry?.synonyms).toContain("rebuild");
  });
});

// ── 2. Synonym resolution ─────────────────────────────────────────────────────

describe("SdRebuild synonym resolution", () => {
  test("'rebuild' resolves to SdRebuild", () => {
    expect(resolveVerb("rebuild")).toBe("SdRebuild");
  });

  test("'refit' resolves to SdRebuild", () => {
    expect(resolveVerb("refit")).toBe("SdRebuild");
  });

  test("SdRebuild resolves to itself", () => {
    expect(resolveVerb("SdRebuild")).toBe("SdRebuild");
  });
});

// ── 3. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdRebuild dispatch routing", () => {
  test("mock handler receives target via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdRebuild", (args) => {
      calls.push(args);
      return { rebuilt: args.target, originalVertices: 24, targetCount: 48 };
    });
    const dr = dispatchSync("SdRebuild", { target: "surf-uuid-1" });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe("surf-uuid-1");
  });

  test("mock handler receives target + count", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdRebuild", (args) => {
      calls.push(args);
      return { rebuilt: args.target, originalVertices: 24, targetCount: args.count };
    });
    const dr = dispatchSync("SdRebuild", { target: "surf-uuid-2", count: 20 });
    expect(dr.ok).toBe(true);
    expect(calls[0].count).toBe(20);
  });

  test("synonym 'rebuild' routes to SdRebuild handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdRebuild", (args) => {
      calls.push(args);
      return { rebuilt: "x", originalVertices: 0, targetCount: 0 };
    });
    expect(dispatchSync("rebuild", { target: "surf-uuid-3" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'refit' routes to SdRebuild handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdRebuild", (args) => {
      calls.push(args);
      return { rebuilt: "x", originalVertices: 0, targetCount: 0 };
    });
    expect(dispatchSync("refit", { target: "surf-uuid-4" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("handler result has rebuilt + originalVertices + targetCount", () => {
    registerHandler("SdRebuild", () => ({ rebuilt: "surf-1", originalVertices: 24, targetCount: 48 }));
    const dr = dispatchSync("SdRebuild", { target: "surf-1" });
    expect(dr.ok).toBe(true);
    const result = (dr as { ok: true; result: { rebuilt: string; originalVertices: number; targetCount: number } }).result;
    expect(result.rebuilt).toBe("surf-1");
    expect(result.originalVertices).toBeGreaterThanOrEqual(0);
  });
});

// ── 4. Error path ─────────────────────────────────────────────────────────────

describe("SdRebuild error path", () => {
  test("missing target → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdRebuild", () => ({ rebuilt: "x", originalVertices: 0, targetCount: 0 }));
    const dr = dispatchSync("SdRebuild", {});
    expect(dr.ok).toBe(false);
  });

  test("target supplied, count omitted → dispatch succeeds (count is optional)", () => {
    registerHandler("SdRebuild", () => ({ rebuilt: "surf-x", originalVertices: 12, targetCount: 24 }));
    const dr = dispatchSync("SdRebuild", { target: "surf-x" });
    expect(dr.ok).toBe(true);
  });
});
