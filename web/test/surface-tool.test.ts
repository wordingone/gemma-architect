// surface-tool.test.ts — AC #1826: Surface palette curve-bound picker + dispatch routing.
//
// Tests:
//   1. SdSurface schema: profile + points optional; synonyms.
//   2. Synonym routing: 'surface' / 'patch' / 'cap' / 'fill' → SdSurface.
//   3. Dispatch: SdSurface mock handler receives profile arg.
//   4. Error path: handler returns error for <3 points or missing profile.

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
  unregisterHandler("SdSurface");
});

// ── 1. Schema ─────────────────────────────────────────────────────────────────

describe("SdSurface schema", () => {
  test("SdSurface is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdSurface");
    expect(entry).toBeDefined();
  });

  test("profile arg exists and is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdSurface");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "profile");
    expect(arg).toBeDefined();
    expect(arg?.required).toBeFalsy();
  });

  test("points arg exists and is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdSurface");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "points");
    expect(arg).toBeDefined();
    expect(arg?.required).toBeFalsy();
  });
});

// ── 2. Synonym resolution ─────────────────────────────────────────────────────

describe("SdSurface synonym resolution", () => {
  test("'surface' resolves to SdSurface", () => {
    expect(resolveVerb("surface")).toBe("SdSurface");
  });

  test("'patch' resolves to SdSurface", () => {
    expect(resolveVerb("patch")).toBe("SdSurface");
  });

  test("'cap' resolves to SdSurface", () => {
    expect(resolveVerb("cap")).toBe("SdSurface");
  });

  test("'fill' resolves to SdSurface", () => {
    expect(resolveVerb("fill")).toBe("SdSurface");
  });

  test("SdSurface resolves to itself", () => {
    expect(resolveVerb("SdSurface")).toBe("SdSurface");
  });
});

// ── 3. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdSurface dispatch routing", () => {
  test("mock handler receives profile arg via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdSurface", (args) => {
      calls.push(args);
      return { created: "surface" };
    });
    const profile = { points: [[0,0,0],[4,0,0],[4,3,0],[0,3,0]] };
    const dr = dispatchSync("SdSurface", { profile });
    expect(dr.ok).toBe(true);
    expect((dr as { ok: true; canonical: string; result: { created: string } }).result.created).toBe("surface");
    expect(calls).toHaveLength(1);
    expect(calls[0].profile).toEqual(profile);
  });

  test("mock handler receives points array directly", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdSurface", (args) => {
      calls.push(args);
      return { created: "surface" };
    });
    const points = [[0,0,0],[5,0,0],[5,5,0],[0,5,0]];
    const dr = dispatchSync("SdSurface", { points });
    expect(dr.ok).toBe(true);
    expect(calls[0].points).toEqual(points);
  });

  test("synonym 'patch' routes to SdSurface handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdSurface", (args) => {
      calls.push(args);
      return { created: "surface" };
    });
    const dr = dispatchSync("patch", { profile: { points: [[0,0,0],[3,0,0],[3,3,0]] } });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'fill' routes to SdSurface handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdSurface", (args) => {
      calls.push(args);
      return { created: "surface" };
    });
    const dr = dispatchSync("fill", { profile: { points: [[0,0,0],[3,0,0],[3,3,0]] } });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("empty dispatch (no args) succeeds schema validation (no required fields)", () => {
    registerHandler("SdSurface", () => ({ error: "SdSurface: provide profile with points or points array", created: null }));
    // schema has required:[] — dispatch validates OK; handler returns its own error
    const dr = dispatchSync("SdSurface", {});
    expect(dr.ok).toBe(true);
    const result = (dr as { ok: true; canonical: string; result: Record<string, unknown> }).result;
    expect(typeof result.error).toBe("string");
  });
});

// ── 4. Error path ─────────────────────────────────────────────────────────────

describe("SdSurface error path", () => {
  test("<3 points → handler returns error", () => {
    registerHandler("SdSurface", (args) => {
      const raw = (args.profile ?? args.points) as { points?: unknown[] } | unknown[] | undefined;
      const pts = Array.isArray(raw) ? raw : (raw as { points?: unknown[] } | undefined)?.points ?? [];
      if (pts.length < 3) return { error: "SdSurface requires at least 3 points", created: null };
      return { created: "surface" };
    });
    const dr = dispatchSync("SdSurface", { profile: { points: [[0,0,0],[1,0,0]] } });
    expect(dr.ok).toBe(true);
    const result = (dr as { ok: true; canonical: string; result: Record<string, unknown> }).result;
    expect(typeof result.error).toBe("string");
    expect(String(result.error)).toContain("3 points");
  });

  test("missing profile and points → handler returns error", () => {
    registerHandler("SdSurface", (args) => {
      const raw = args.profile ?? args.points;
      if (!raw) return { error: "SdSurface: provide profile with points or points array", created: null };
      return { created: "surface" };
    });
    const dr = dispatchSync("SdSurface", {});
    expect(dr.ok).toBe(true);
    const result = (dr as { ok: true; canonical: string; result: Record<string, unknown> }).result;
    expect(typeof result.error).toBe("string");
    expect(String(result.error)).toContain("profile");
  });
});
