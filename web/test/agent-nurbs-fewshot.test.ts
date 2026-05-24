// agent-nurbs-fewshot.test.ts — §#1831: NURBS/BRep verb coverage in agent few-shot.
//
// Verifies:
//   1. NURBS verbs exist in the dictionary with correct schemas.
//   2. resolveVerb maps synonyms to canonicals for NURBS verbs.
//   3. Synthetic tool_call JSON strings (matching few-shot examples) parse to valid dispatches.
//
// Note: agent-harness.ts cannot be imported directly (transformers dep not testable in Bun).
// We verify schemas + dispatch routing without importing the prompt builder.

import { describe, expect, test, beforeEach } from "bun:test";
import { getDictionary, clearDictionaryCache } from "../src/commands/dictionary";
import {
  resolveVerb,
  registerHandler,
  unregisterHandler,
  dispatchSync,
  setRuntimeAliases,
} from "../src/commands/dispatch";

const NURBS_CANONICALS = [
  "SdArc",
  "SdCurve",
  "SdSpline",
  "SdLoft",
  "SdSweep",
  "SdRevolve",
  "SdBoolean",
];

beforeEach(() => {
  clearDictionaryCache();
  setRuntimeAliases({});
  for (const name of NURBS_CANONICALS) unregisterHandler(name);
});

// ── 1. Dictionary presence ──────────────────────────────────────────────────

describe("NURBS verbs in dictionary", () => {
  test("all 7 NURBS canonicals are present", () => {
    const dict = getDictionary();
    const names = new Set(dict.map((e) => e.name));
    for (const v of NURBS_CANONICALS) {
      expect(names.has(v)).toBe(true);
    }
  });

  test("SdArc has optional center/radius/startAngle/endAngle args", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdArc");
    expect(entry).toBeDefined();
    if (!entry) return;
    const argNames = entry.args.map((a) => a.name);
    expect(argNames).toContain("center");
    expect(argNames).toContain("radius");
    expect(argNames).toContain("startAngle");
    expect(argNames).toContain("endAngle");
    // all optional — SdArc has defaults for every param
    for (const a of entry.args) {
      expect(a.required).toBeFalsy();
    }
  });

  test("SdCurve requires points", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdCurve");
    expect(entry).toBeDefined();
    if (!entry) return;
    const points = entry.args.find((a) => a.name === "points");
    expect(points).toBeDefined();
    expect(points?.required).toBe(true);
  });

  test("SdSpline requires points", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdSpline");
    expect(entry).toBeDefined();
    if (!entry) return;
    const points = entry.args.find((a) => a.name === "points");
    expect(points?.required).toBe(true);
  });

  test("SdLoft requires curves", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdLoft");
    expect(entry).toBeDefined();
    if (!entry) return;
    const curves = entry.args.find((a) => a.name === "curves");
    expect(curves?.required).toBe(true);
  });

  test("SdSweep requires profile and rail", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdSweep");
    expect(entry).toBeDefined();
    if (!entry) return;
    const argNames = entry.args.filter((a) => a.required).map((a) => a.name);
    expect(argNames).toContain("profile");
    expect(argNames).toContain("rail");
  });

  test("SdRevolve requires profile", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdRevolve");
    expect(entry).toBeDefined();
    if (!entry) return;
    const profile = entry.args.find((a) => a.name === "profile");
    expect(profile?.required).toBe(true);
  });

  test("SdBoolean requires a and b", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdBoolean");
    expect(entry).toBeDefined();
    if (!entry) return;
    const argNames = entry.args.filter((a) => a.required).map((a) => a.name);
    expect(argNames).toContain("a");
    expect(argNames).toContain("b");
  });
});

// ── 2. Synonym resolution ────────────────────────────────────────────────────

describe("NURBS synonym resolution", () => {
  test("'arc' resolves to SdArc", () => {
    expect(resolveVerb("arc")).toBe("SdArc");
  });

  test("'curve' resolves to SdCurve", () => {
    expect(resolveVerb("curve")).toBe("SdCurve");
  });

  test("'spline' resolves to SdSpline", () => {
    expect(resolveVerb("spline")).toBe("SdSpline");
  });

  test("'loft' resolves to SdLoft", () => {
    expect(resolveVerb("loft")).toBe("SdLoft");
  });

  test("'sweep' resolves to SdSweep", () => {
    expect(resolveVerb("sweep")).toBe("SdSweep");
  });

  test("'revolve' resolves to SdRevolve", () => {
    expect(resolveVerb("revolve")).toBe("SdRevolve");
  });
});

// ── 3. Dispatch routing ──────────────────────────────────────────────────────
// Register mock handlers and verify that tool_call JSON matching the few-shot
// examples dispatches to the correct handler with the expected args.

describe("NURBS few-shot dispatch routing", () => {
  function mockHandler(name: string) {
    const calls: Record<string, unknown>[] = [];
    registerHandler(name, (args) => {
      calls.push(args);
      return { created: name };
    });
    return calls;
  }

  test("SdArc tool_call routes with center/radius/startAngle/endAngle", () => {
    const calls = mockHandler("SdArc");
    const result = dispatchSync("SdArc", {
      center: [5, 0, 0],
      radius: 5,
      startAngle: 0,
      endAngle: 1.5708,
    });
    expect(result.ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.center).toEqual([5, 0, 0]);
    expect(calls[0]?.radius).toBe(5);
    expect(calls[0]?.endAngle).toBeCloseTo(1.5708, 3);
  });

  test("SdCurve tool_call routes with points array", () => {
    const calls = mockHandler("SdCurve");
    const points = [[0, 0], [2, 3], [5, 4], [8, 2], [10, 0]];
    const result = dispatchSync("SdCurve", { points });
    expect(result.ok).toBe(true);
    expect(calls[0]?.points).toEqual(points);
  });

  test("SdSpline tool_call routes with points array", () => {
    const calls = mockHandler("SdSpline");
    const points = [[0, 0], [3, 4], [7, 3], [10, 0]];
    const result = dispatchSync("SdSpline", { points });
    expect(result.ok).toBe(true);
    expect(calls[0]?.points).toEqual(points);
  });

  test("SdLoft tool_call routes with curves array", () => {
    const calls = mockHandler("SdLoft");
    const curves = [
      { points: [[0, 0, 0], [5, 0, 0]] },
      { points: [[0, 0, 5], [5, 0, 5]] },
      { points: [[0, 0, 10], [5, 0, 10]] },
    ];
    const result = dispatchSync("SdLoft", { curves });
    expect(result.ok).toBe(true);
    expect(calls[0]?.curves).toEqual(curves);
  });

  test("SdSweep tool_call routes with inline profile+rail", () => {
    const calls = mockHandler("SdSweep");
    const profile = { kind: "arc", center: [0, 0, 0], radius: 1, startAngle: 0, endAngle: 6.2832 };
    const rail = { points: [[0, 0, 0], [5, 0, 0], [10, 0, 5]] };
    const result = dispatchSync("SdSweep", { profile, rail });
    expect(result.ok).toBe(true);
    expect(calls[0]?.profile).toEqual(profile);
    expect(calls[0]?.rail).toEqual(rail);
  });

  test("SdRevolve tool_call routes with inline profile+axis", () => {
    const calls = mockHandler("SdRevolve");
    const profile = { kind: "line", from: [0, 0, 0], to: [5, 0, 0] };
    const result = dispatchSync("SdRevolve", {
      profile,
      axisFrom: [0, 0, 0],
      axisTo: [0, 0, 1],
      angleStart: 0,
      angleEnd: 6.2832,
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.profile).toEqual(profile);
    expect(calls[0]?.axisTo).toEqual([0, 0, 1]);
  });

  test("SdBoolean union routes with op+a+b", () => {
    const calls = mockHandler("SdBoolean");
    const result = dispatchSync("SdBoolean", {
      op: "union",
      a: "uuid-aaa",
      b: "uuid-bbb",
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.op).toBe("union");
    expect(calls[0]?.a).toBe("uuid-aaa");
    expect(calls[0]?.b).toBe("uuid-bbb");
  });

  test("SdBoolean difference routes with op=difference", () => {
    const calls = mockHandler("SdBoolean");
    const result = dispatchSync("SdBoolean", { op: "difference", a: "box-uuid", b: "sphere-uuid" });
    expect(result.ok).toBe(true);
    expect(calls[0]?.op).toBe("difference");
  });

  test("SdBoolean intersection routes with op=intersection", () => {
    const calls = mockHandler("SdBoolean");
    const result = dispatchSync("SdBoolean", { op: "intersection", a: "uuid-A", b: "uuid-B" });
    expect(result.ok).toBe(true);
    expect(calls[0]?.op).toBe("intersection");
  });
});
