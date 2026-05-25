// revolve-tool.test.ts — AC #1825: Revolve palette axis/profile picker + dispatch routing.
//
// Tests:
//   1. surfaceOfRevolution algorithm: profile + axis → surface with expected structure.
//   2. SdRevolve schema: profile required, axis/angle args optional with defaults.
//   3. Synonym routing: 'revolve' / 'lathe' → SdRevolve.
//   4. Dispatch: SdRevolve mock handler receives profile + axis args.
//   5. Error path: missing profile → schema validation failure.

import { describe, expect, test, beforeEach } from "bun:test";
import { surfaceOfRevolution } from "../src/nurbs/nurbs-surface-algorithms";
import { tessellateSurface, pointAtUV } from "../src/nurbs/nurbs-surfaces";
import { type LineCurve } from "../src/nurbs/nurbs-curves";
import { Plane } from "../src/nurbs/nurbs-primitives";
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
  unregisterHandler("SdRevolve");
});

// ── 1. surfaceOfRevolution algorithm ─────────────────────────────────────────

describe("surfaceOfRevolution — line profile → cylinder-like", () => {
  // Profile: vertical line at x=2 from z=0 to z=3
  const profile: LineCurve = {
    kind: "line",
    from: { x: 2, y: 0, z: 0 },
    to:   { x: 2, y: 0, z: 3 },
    domain: { min: 0, max: 1 },
  };
  // Axis: Z axis (0,0,0) → (0,0,1)
  const axis = { from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: 1 } };

  test("produces a RevSurface kind='rev'", () => {
    const surf = surfaceOfRevolution(profile, axis, 0, 2 * Math.PI);
    expect(surf.kind).toBe("rev");
  });

  test("tessellated at 32×64 → 2048 × 2 triangles", () => {
    const surf = surfaceOfRevolution(profile, axis, 0, 2 * Math.PI);
    const mesh = tessellateSurface(surf, 32, 64);
    expect(mesh.indices.length / 3).toBe(2 * 32 * 64);
  });

  test("radius is constant ~2 throughout (cylindrical)", () => {
    const surf = surfaceOfRevolution(profile, axis, 0, 2 * Math.PI);
    for (const [u, v] of [[0, 0], [0.5, Math.PI / 2], [0.5, Math.PI], [1, 3 * Math.PI / 2]] as [number, number][]) {
      const pt = pointAtUV(surf, u, v);
      const r = Math.sqrt(pt.x * pt.x + pt.y * pt.y);
      expect(r).toBeCloseTo(2, 4);
    }
  });

  test("z-extent matches profile z-range (0 to 3)", () => {
    const surf = surfaceOfRevolution(profile, axis, 0, 2 * Math.PI);
    const mesh = tessellateSurface(surf, 16, 32);
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 2; i < mesh.positions.length; i += 3) {
      if (mesh.positions[i] < minZ) minZ = mesh.positions[i];
      if (mesh.positions[i] > maxZ) maxZ = mesh.positions[i];
    }
    expect(minZ).toBeCloseTo(0, 3);
    expect(maxZ).toBeCloseTo(3, 3);
  });

  test("half-revolution (π) produces a half-cylinder", () => {
    const surf = surfaceOfRevolution(profile, axis, 0, Math.PI);
    // At v=π the point should be at x=-2, y≈0
    const pt = pointAtUV(surf, 0.5, Math.PI);
    expect(pt.x).toBeCloseTo(-2, 3);
    expect(Math.abs(pt.y)).toBeLessThan(1e-3);
  });
});

// ── 2. Schema: SdRevolve requires profile; axis/angle args optional ───────────

describe("SdRevolve schema", () => {
  test("SdRevolve is in dictionary", () => {
    const entry = getDictionary().find((e) => e.name === "SdRevolve");
    expect(entry).toBeDefined();
  });

  test("profile arg is required", () => {
    const entry = getDictionary().find((e) => e.name === "SdRevolve");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "profile");
    expect(arg).toBeDefined();
    expect(arg?.required).toBe(true);
  });

  test("axisFrom arg is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdRevolve");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "axisFrom");
    expect(arg).toBeDefined();
    expect(arg?.required).toBeFalsy();
  });

  test("axisTo arg is optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdRevolve");
    if (!entry) return;
    const arg = entry.args.find((a) => a.name === "axisTo");
    expect(arg).toBeDefined();
    expect(arg?.required).toBeFalsy();
  });

  test("angleStart and angleEnd args are optional", () => {
    const entry = getDictionary().find((e) => e.name === "SdRevolve");
    if (!entry) return;
    for (const name of ["angleStart", "angleEnd"]) {
      const arg = entry.args.find((a) => a.name === name);
      expect(arg).toBeDefined();
      expect(arg?.required).toBeFalsy();
    }
  });
});

// ── 3. Synonym resolution ─────────────────────────────────────────────────────

describe("SdRevolve synonym resolution", () => {
  test("'revolve' resolves to SdRevolve", () => {
    expect(resolveVerb("revolve")).toBe("SdRevolve");
  });

  test("'lathe' resolves to SdRevolve", () => {
    expect(resolveVerb("lathe")).toBe("SdRevolve");
  });

  test("SdRevolve resolves to itself", () => {
    expect(resolveVerb("SdRevolve")).toBe("SdRevolve");
  });
});

// ── 4. Dispatch routing (mock handler) ───────────────────────────────────────

describe("SdRevolve dispatch routing", () => {
  test("mock handler receives profile + axis args via dispatchSync", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdRevolve", (args) => {
      calls.push(args);
      return { created: "revolution" };
    });
    const profile  = { kind: "line", from: [2,0,0], to: [2,0,3] };
    const axisFrom = [0,0,0];
    const axisTo   = [0,0,1];
    const dr = dispatchSync("SdRevolve", { profile, axisFrom, axisTo, angleStart: 0, angleEnd: 6.2832 });
    expect(dr.ok).toBe(true);
    expect((dr as { ok: true; canonical: string; result: { created: string } }).result.created).toBe("revolution");
    expect(calls).toHaveLength(1);
    expect(calls[0].profile).toEqual(profile);
    expect(calls[0].axisFrom).toEqual(axisFrom);
  });

  test("synonym 'revolve' routes to SdRevolve handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdRevolve", (args) => {
      calls.push(args);
      return { created: "revolution" };
    });
    const dr = dispatchSync("revolve", { profile: { kind: "line", from: [1,0,0], to: [1,0,1] } });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("synonym 'lathe' routes to SdRevolve handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdRevolve", (args) => {
      calls.push(args);
      return { created: "revolution" };
    });
    const dr = dispatchSync("lathe", { profile: { kind: "line", from: [1,0,0], to: [1,0,1] } });
    expect(dr.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("profile-only dispatch succeeds (axis defaults applied by handler)", () => {
    registerHandler("SdRevolve", (args) => {
      expect(args.profile).toBeDefined();
      return { created: "revolution" };
    });
    const dr = dispatchSync("SdRevolve", { profile: { kind: "line", from: [1,0,0], to: [1,0,2] } });
    expect(dr.ok).toBe(true);
  });
});

// ── 5. Error path ─────────────────────────────────────────────────────────────

describe("SdRevolve error path", () => {
  test("missing profile → dispatch fails schema validation (ok=false)", () => {
    registerHandler("SdRevolve", (args) => {
      void args;
      return { created: "revolution" };
    });
    // profile is required; omitting it → schema validation rejects before handler runs
    const dr = dispatchSync("SdRevolve", { axisFrom: [0,0,0], axisTo: [0,0,1] });
    expect(dr.ok).toBe(false);
  });
});
