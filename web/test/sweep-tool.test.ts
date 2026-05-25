// sweep-tool.test.ts — AC #1824: Sweep palette path/profile picker + dispatch routing.
//
// Tests:
//   1. sweepSurface algorithm: rail + profile → surface with expected structure.
//   2. SdSweep schema: profile and rail required.
//   3. Synonym routing: 'sweep' → SdSweep.
//   4. Dispatch: SdSweep mock handler receives profile + rail args.
//   5. Error path: missing rail → handler returns error.

import { describe, expect, test, beforeEach } from "bun:test";
import { sweepSurface } from "../src/nurbs/nurbs-surface-algorithms";
import { tessellateSurface } from "../src/nurbs/nurbs-surfaces";
import { type LineCurve } from "../src/nurbs/nurbs-curves";
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
  unregisterHandler("SdSweep");
});

// ── 1. sweepSurface algorithm ────────────────────────────────────────────────

describe("sweepSurface — line profile swept along straight rail", () => {
  // Rail: straight line along X axis (0,0,0) → (10,0,0)
  const rail: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to:   { x: 10, y: 0, z: 0 },
    domain: { min: 0, max: 1 },
  };
  // Profile: short vertical line segment (0,0,0) → (0,2,0)
  const profile: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to:   { x: 0, y: 2, z: 0 },
    domain: { min: 0, max: 1 },
  };

  test("produces a NurbsSurface kind='nurbs'", () => {
    const surf = sweepSurface(profile, rail);
    expect(surf.kind).toBe("nurbs");
  });

  test("tessellated at 32×32 → 2048 triangles", () => {
    const surf = sweepSurface(profile, rail);
    const mesh = tessellateSurface(surf, 32, 32);
    expect(mesh.indices.length / 3).toBe(2 * 32 * 32);
  });

  test("tessellated at 32×32 → 1089 vertices", () => {
    const surf = sweepSurface(profile, rail);
    const mesh = tessellateSurface(surf, 32, 32);
    expect(mesh.positions.length / 3).toBe(33 * 33);
  });

  test("surface spans non-trivial x-range (rail extent)", () => {
    const surf = sweepSurface(profile, rail);
    const mesh = tessellateSurface(surf, 32, 32);
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minX) minX = mesh.positions[i];
      if (mesh.positions[i] > maxX) maxX = mesh.positions[i];
    }
    expect(maxX - minX).toBeGreaterThan(5);
  });
});

// ── 2. Schema: SdSweep requires profile + rail ───────────────────────────────

describe("SdSweep schema", () => {
  test("SdSweep is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdSweep");
    expect(entry).toBeDefined();
  });

  test("profile arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdSweep");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "profile");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("rail arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdSweep");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "rail");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });
});

// ── 3. Synonym resolution ─────────────────────────────────────────────────────

describe("SdSweep synonym resolution", () => {
  test("'sweep' resolves to SdSweep", () => {
    expect(resolveVerb("sweep")).toBe("SdSweep");
  });

  test("SdSweep resolves to itself", () => {
    expect(resolveVerb("SdSweep")).toBe("SdSweep");
  });
});

// ── 4. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdSweep dispatch routing", () => {
  test("mock handler receives profile + rail via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdSweep", (args) => {
      calls.push(args);
      return { created: "sweep" };
    });
    const rail    = { points: [[0,0,0],[10,0,0]] };
    const profile = { points: [[0,0,0],[0,2,0]] };
    const dr = dispatchSync("SdSweep", { rail, profile });
    expect(dr.ok).toBe(true);
    expect((dr as { ok: true; canonical: string; result: { created: string } }).result.created).toBe("sweep");
    expect(calls).toHaveLength(1);
    expect(calls[0].rail).toEqual(rail);
    expect(calls[0].profile).toEqual(profile);
  });

  test("synonym 'sweep' routes to SdSweep handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdSweep", (args) => {
      calls.push(args);
      return { created: "sweep" };
    });
    const dr = dispatchSync("sweep", {
      rail:    { points: [[0,0,0],[5,0,0]] },
      profile: { points: [[0,0,0],[0,1,0]] },
    });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// ── 5. Error path ─────────────────────────────────────────────────────────────

describe("SdSweep error path", () => {
  test("missing rail → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdSweep", (args) => {
      void args;
      return { created: "sweep" };
    });
    // schema requires both profile + rail; missing rail → validation rejects before handler
    const dr = dispatchSync("SdSweep", { profile: { points: [[0,0,0],[0,1,0]] } });
    expect(dr.ok).toBe(false);
  });

  test("missing profile → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdSweep", (args) => {
      void args;
      return { created: "sweep" };
    });
    // schema requires both profile + rail; missing profile → validation rejects before handler
    const dr = dispatchSync("SdSweep", { rail: { points: [[0,0,0],[5,0,0]] } });
    expect(dr.ok).toBe(false);
  });

  test("handler returns error object when rail arg is empty points", () => {
    registerHandler("SdSweep", (args) => {
      const railPts = (args.rail as { points?: unknown[] } | undefined)?.points ?? [];
      if (railPts.length < 2) return { error: "SdSweep rail requires at least 2 points", created: null };
      return { created: "sweep" };
    });
    const dr = dispatchSync("SdSweep", {
      profile: { points: [[0,0,0],[0,1,0]] },
      rail:    { points: [[0,0,0]] }, // only 1 point — handler rejects
    });
    expect(dr.ok).toBe(true);
    const handlerResult = (dr as { ok: true; canonical: string; result: Record<string, unknown> }).result;
    expect(typeof handlerResult.error).toBe("string");
    expect(String(handlerResult.error)).toContain("rail");
  });
});
