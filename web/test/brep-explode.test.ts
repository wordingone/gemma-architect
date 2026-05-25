// brep-explode.test.ts — AC #1829: SdExplode brep-op palette.
//
// Tests:
//   1. SdExplode schema: target required; synonyms in dictionary.
//   2. Synonym routing: 'explode' / 'brep-explode' / 'extract-faces' → SdExplode.
//   3. Dispatch: mock handler receives target.
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
  unregisterHandler("SdExplode");
});

// ── 1. Schema ─────────────────────────────────────────────────────────────────

describe("SdExplode schema", () => {
  test("SdExplode is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdExplode");
    expect(entry).toBeDefined();
  });

  test("target arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdExplode");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "target");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("SdExplode has synonyms including 'explode'", () => {
    const entry = getDictionary().find((e) => e.name === "SdExplode");
    expect(entry?.synonyms).toContain("explode");
  });

  test("SdUngroup does NOT have 'explode' as synonym (moved to SdExplode)", () => {
    const entry = getDictionary().find((e) => e.name === "SdUngroup");
    expect(entry?.synonyms).not.toContain("explode");
  });
});

// ── 2. Synonym resolution ─────────────────────────────────────────────────────

describe("SdExplode synonym resolution", () => {
  test("'explode' resolves to SdExplode", () => {
    expect(resolveVerb("explode")).toBe("SdExplode");
  });

  test("'brep-explode' resolves to SdExplode", () => {
    expect(resolveVerb("brep-explode")).toBe("SdExplode");
  });

  test("'extract-faces' resolves to SdExplode", () => {
    expect(resolveVerb("extract-faces")).toBe("SdExplode");
  });

  test("SdExplode resolves to itself", () => {
    expect(resolveVerb("SdExplode")).toBe("SdExplode");
  });
});

// ── 3. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdExplode dispatch routing", () => {
  test("mock handler receives target via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdExplode", (args) => {
      calls.push(args);
      return { exploded: ["face-uuid-1", "face-uuid-2"], faceCount: 2 };
    });
    const dr = dispatchSync("SdExplode", { target: "brep-uuid-1" });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].target).toBe("brep-uuid-1");
  });

  test("synonym 'explode' routes to SdExplode handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdExplode", (args) => {
      calls.push(args);
      return { exploded: ["f1"], faceCount: 1 };
    });
    const dr = dispatchSync("explode", { target: "brep-uuid-2" });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'brep-explode' routes to SdExplode handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdExplode", (args) => {
      calls.push(args);
      return { exploded: ["f1"], faceCount: 1 };
    });
    expect(dispatchSync("brep-explode", { target: "brep-uuid-3" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("handler result has faceCount and exploded array", () => {
    registerHandler("SdExplode", () => ({ exploded: ["a", "b", "c"], faceCount: 3 }));
    const dr = dispatchSync("SdExplode", { target: "poly-1" });
    expect(dr.ok).toBe(true);
    const result = (dr as { ok: true; result: { exploded: string[]; faceCount: number } }).result;
    expect(result.faceCount).toBe(3);
    expect(result.exploded).toHaveLength(3);
  });
});

// ── 4. Error path ─────────────────────────────────────────────────────────────

describe("SdExplode error path", () => {
  test("missing target → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdExplode", () => ({ exploded: [], faceCount: 0 }));
    const dr = dispatchSync("SdExplode", {});
    expect(dr.ok).toBe(false);
  });
});
