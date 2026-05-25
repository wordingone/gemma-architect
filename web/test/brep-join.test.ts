// brep-join.test.ts — AC #1829: SdJoin brep-op palette.
//
// Tests:
//   1. SdJoin schema: targets required; synonyms in dictionary.
//   2. Synonym routing: 'join' / 'joinbrep' / 'merge-surfaces' → SdJoin.
//   3. Dispatch: mock handler receives targets array.
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
  unregisterHandler("SdJoin");
});

// ── 1. Schema ─────────────────────────────────────────────────────────────────

describe("SdJoin schema", () => {
  test("SdJoin is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdJoin");
    expect(entry).toBeDefined();
  });

  test("targets arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdJoin");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "targets");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("SdJoin has synonyms including 'join'", () => {
    const entry = getDictionary().find((e) => e.name === "SdJoin");
    expect(entry?.synonyms).toContain("join");
  });
});

// ── 2. Synonym resolution ─────────────────────────────────────────────────────

describe("SdJoin synonym resolution", () => {
  test("'join' resolves to SdJoin", () => {
    expect(resolveVerb("join")).toBe("SdJoin");
  });

  test("'joinbrep' resolves to SdJoin", () => {
    expect(resolveVerb("joinbrep")).toBe("SdJoin");
  });

  test("'merge-surfaces' resolves to SdJoin", () => {
    expect(resolveVerb("merge-surfaces")).toBe("SdJoin");
  });

  test("SdJoin resolves to itself", () => {
    expect(resolveVerb("SdJoin")).toBe("SdJoin");
  });
});

// ── 3. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdJoin dispatch routing", () => {
  test("mock handler receives targets array via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdJoin", (args) => {
      calls.push(args);
      return { created: "joined-uuid", faceCount: 2 };
    });
    const targets = ["surf-uuid-1", "surf-uuid-2"];
    const dr = dispatchSync("SdJoin", { targets });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].targets).toEqual(targets);
  });

  test("synonym 'join' routes to SdJoin handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdJoin", (args) => {
      calls.push(args);
      return { created: "joined-uuid", faceCount: 2 };
    });
    const dr = dispatchSync("join", { targets: ["a", "b"] });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'merge-surfaces' routes to SdJoin handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdJoin", (args) => {
      calls.push(args);
      return { created: "joined-uuid", faceCount: 2 };
    });
    expect(dispatchSync("merge-surfaces", { targets: ["x", "y"] }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("handler result has created and faceCount", () => {
    registerHandler("SdJoin", () => ({ created: "poly-result", faceCount: 3 }));
    const dr = dispatchSync("SdJoin", { targets: ["s1", "s2", "s3"] });
    expect(dr.ok).toBe(true);
    const result = (dr as { ok: true; result: { created: string; faceCount: number } }).result;
    expect(result.created).toBe("poly-result");
    expect(result.faceCount).toBe(3);
  });
});

// ── 4. Error path ─────────────────────────────────────────────────────────────

describe("SdJoin error path", () => {
  test("missing targets → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdJoin", () => ({ created: "x", faceCount: 0 }));
    const dr = dispatchSync("SdJoin", {});
    expect(dr.ok).toBe(false);
  });
});
