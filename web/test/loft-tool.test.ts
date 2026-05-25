// loft-tool.test.ts — AC #1823: Loft palette 2-curve picker + dispatch routing.
//
// Tests:
//   1. loftSurfaces algorithm: 2-curve input → surface with expected face count.
//   2. SdLoft schema: curves required.
//   3. Synonym routing: 'loft' / 'blend' → SdLoft.
//   4. Dispatch: SdLoft mock handler receives curves array.
//   5. Error path: <2 curves → handler returns error.

import { describe, expect, test, beforeEach } from "bun:test";
import { loftSurfaces } from "../src/nurbs/nurbs-surface-algorithms";
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
  unregisterHandler("SdLoft");
});

// ── 1. loftSurfaces algorithm ────────────────────────────────────────────────

describe("loftSurfaces — 2-curve → surface geometry", () => {
  const bottom: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 0 },
    to:   { x: 5, y: 0, z: 0 },
    domain: { min: 0, max: 1 },
  };
  const top: LineCurve = {
    kind: "line",
    from: { x: 0, y: 0, z: 5 },
    to:   { x: 5, y: 0, z: 5 },
    domain: { min: 0, max: 1 },
  };

  test("produces a NurbsSurface kind='nurbs'", () => {
    const surf = loftSurfaces([bottom, top]);
    expect(surf.kind).toBe("nurbs");
  });

  test("tessellated at 32×32 → 2048 triangles", () => {
    const surf = loftSurfaces([bottom, top]);
    const mesh = tessellateSurface(surf, 32, 32);
    const triCount = mesh.indices.length / 3;
    expect(triCount).toBe(2 * 32 * 32); // 2048
  });

  test("tessellated at 32×32 → 33×33 = 1089 vertices", () => {
    const surf = loftSurfaces([bottom, top]);
    const mesh = tessellateSurface(surf, 32, 32);
    const vertCount = mesh.positions.length / 3;
    expect(vertCount).toBe(33 * 33); // 1089
  });

  test("all vertices span z from 0 to 5 (loft between z=0 and z=5 curves)", () => {
    const surf = loftSurfaces([bottom, top]);
    const mesh = tessellateSurface(surf, 32, 32);
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minZ) minZ = mesh.positions[i];
      if (mesh.positions[i] > maxZ) maxZ = mesh.positions[i];
    }
    expect(minZ).toBeLessThan(0.1);
    expect(maxZ).toBeGreaterThan(4.9);
  });

  test("throws with <2 curves", () => {
    expect(() => loftSurfaces([bottom])).toThrow("loftSurfaces requires at least 2 curves");
  });

  test("3-curve loft produces 2048 triangles (same grid, more profile curves)", () => {
    const mid: LineCurve = {
      kind: "line",
      from: { x: 0, y: 0, z: 2.5 },
      to:   { x: 5, y: 0, z: 2.5 },
      domain: { min: 0, max: 1 },
    };
    const surf = loftSurfaces([bottom, mid, top]);
    const mesh = tessellateSurface(surf, 32, 32);
    expect(mesh.indices.length / 3).toBe(2048);
  });
});

// ── 2. Schema: SdLoft requires curves ────────────────────────────────────────

describe("SdLoft schema", () => {
  test("SdLoft is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdLoft");
    expect(entry).toBeDefined();
  });

  test("curves arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdLoft");
    if (!entry) return;
    const curvesArg = entry.args.find((a) => a.name === "curves");
    expect(curvesArg).toBeDefined();
    expect(curvesArg?.required).toBe(true);
  });

  test("closed arg exists and is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdLoft");
    if (!entry) return;
    const closedArg = entry.args.find((a) => a.name === "closed");
    expect(closedArg).toBeDefined();
    expect(closedArg?.required).toBeFalsy();
  });
});

// ── 3. Synonym resolution ─────────────────────────────────────────────────────

describe("SdLoft synonym resolution", () => {
  test("'loft' resolves to SdLoft", () => {
    expect(resolveVerb("loft")).toBe("SdLoft");
  });

  test("'blend' resolves to SdLoft", () => {
    expect(resolveVerb("blend")).toBe("SdLoft");
  });

  test("SdLoft resolves to itself", () => {
    expect(resolveVerb("SdLoft")).toBe("SdLoft");
  });
});

// ── 4. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdLoft dispatch routing", () => {
  test("mock handler receives curves array via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdLoft", (args) => {
      calls.push(args);
      return { created: "loft" };
    });
    const curves = [
      { points: [[0,0,0],[5,0,0]] },
      { points: [[0,0,5],[5,0,5]] },
    ];
    const dr = dispatchSync("SdLoft", { curves });
    expect(dr.ok).toBe(true);
    expect((dr as { ok: true; canonical: string; result: { created: string } }).result.created).toBe("loft");
    expect(calls).toHaveLength(1);
    expect(calls[0].curves).toEqual(curves);
  });

  test("synonym 'loft' routes to SdLoft handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdLoft", (args) => {
      calls.push(args);
      return { created: "loft" };
    });
    const dr = dispatchSync("loft", { curves: [{ points: [[0,0,0],[1,0,0]] }, { points: [[0,0,1],[1,0,1]] }] });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// ── 5. Error path ─────────────────────────────────────────────────────────────

describe("SdLoft error path", () => {
  test("<2 curves → handler returns error object", () => {
    registerHandler("SdLoft", (args) => {
      const rawCurves = ((args.curves ?? args.sections) as unknown[] | undefined) ?? [];
      if (rawCurves.length < 2) return { error: "SdLoft requires at least 2 curves", created: null };
      return { created: "loft" };
    });
    const dr = dispatchSync("SdLoft", { curves: [{ points: [[0,0,0],[1,0,0]] }] });
    expect(dr.ok).toBe(true); // dispatch succeeds; error is in handler result
    const handlerResult = (dr as { ok: true; canonical: string; result: Record<string, unknown> }).result;
    expect(typeof handlerResult.error).toBe("string");
    expect(String(handlerResult.error)).toContain("at least 2 curves");
  });
});
