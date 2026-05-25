// brep-boolean.ts unit tests — IBooleanBackend + registry + toy backend (#1818 PR-1).
// Covers: IBooleanBackend interface contract, registry (register/resolve/list),
//         ToyBooleanBackend (union structural concat, difference/intersection NOT_IMPLEMENTED),
//         top-level dispatch (brepUnion/brepDifference/brepIntersection/brepSection),
//         per-op backend selection, BACKEND_UNAVAILABLE error path.
//         #1828: SdBooleanUnion/SdBooleanDifference/SdBooleanIntersection schema +
//         synonym routing + dispatch routing + error path.
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import {
  registerBackend, registeredBackends, resolveBackend,
  brepUnion, brepDifference, brepIntersection, brepSection,
  ToyBooleanBackend, _clearRegistryForTest,
  type IBooleanBackend, type BrepResult, type ChangeMap,
} from "../src/nurbs/brep-boolean";
import { brepFromSurface, brepFaceCount, type Brep } from "../src/nurbs/nurbs-brep";
import type { PlaneSurface } from "../src/nurbs/nurbs-surfaces";
import { Plane, Interval } from "../src/nurbs/nurbs-primitives";
import { getDictionary, clearDictionaryCache } from "../src/commands/dictionary";
import {
  resolveVerb, registerHandler, unregisterHandler, dispatchSync, setRuntimeAliases,
} from "../src/commands/dispatch";

function planeSurface(): PlaneSurface {
  return {
    kind: "plane",
    plane: Plane.worldXY(),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(0, 1),
    vExtent: Interval.create(0, 1),
  };
}

function twoShellBrep(): Brep {
  return {
    shells: [
      brepFromSurface(planeSurface()).shells[0],
      brepFromSurface(planeSurface()).shells[0],
    ],
  };
}

// Reset registry to just the toy backend after each test
afterEach(() => {
  _clearRegistryForTest(true);
});

describe("IBooleanBackend registry", () => {
  test("toy backend is auto-registered at module load", () => {
    expect(registeredBackends()).toContain("toy");
  });

  test("registeredBackends returns ids sorted by priority descending", () => {
    const mockHighPriority: IBooleanBackend = {
      id: "mock-high",
      priority: 99,
      union: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "", backend: "mock-high" } }),
      difference: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "", backend: "mock-high" } }),
      intersection: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "", backend: "mock-high" } }),
      section: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "", backend: "mock-high" } }),
    };
    registerBackend(mockHighPriority);
    const ids = registeredBackends();
    expect(ids[0]).toBe("mock-high"); // highest priority first
    expect(ids).toContain("toy");
  });

  test("resolveBackend auto-picks highest priority when no backend specified", () => {
    const result = resolveBackend();
    expect("code" in result).toBe(false); // not an error
    if (!("code" in result)) {
      expect(result.id).toBeDefined();
    }
  });

  test("resolveBackend returns exact backend when id specified", () => {
    const result = resolveBackend({ backend: "toy" });
    expect("code" in result).toBe(false);
    if (!("code" in result)) {
      expect(result.id).toBe("toy");
    }
  });

  test("resolveBackend returns BACKEND_UNAVAILABLE for unknown id", () => {
    const result = resolveBackend({ backend: "unknown-backend-xyz" });
    expect("code" in result).toBe(true);
    if ("code" in result) {
      expect(result.code).toBe("BACKEND_UNAVAILABLE");
      expect(result.backend).toBe("unknown-backend-xyz");
    }
  });

  test("later registration overrides earlier for same id", () => {
    const mockToy: IBooleanBackend = {
      id: "toy",
      priority: 0,
      union: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "overridden", backend: "toy" } }),
      difference: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "overridden", backend: "toy" } }),
      intersection: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "overridden", backend: "toy" } }),
      section: () => ({ ok: false, error: { code: "NOT_IMPLEMENTED", message: "overridden", backend: "toy" } }),
    };
    registerBackend(mockToy);
    const r = resolveBackend({ backend: "toy" });
    if (!("code" in r)) {
      const result = r.union(brepFromSurface(planeSurface()), brepFromSurface(planeSurface()));
      expect(result.ok).toBe(false); // overridden implementation returns error
    }
  });
});

describe("ToyBooleanBackend", () => {
  const toy = new ToyBooleanBackend();
  const a = brepFromSurface(planeSurface());
  const b = brepFromSurface(planeSurface());

  test("id is 'toy' and priority is 0", () => {
    expect(toy.id).toBe("toy");
    expect(toy.priority).toBe(0);
  });

  describe("union", () => {
    test("returns ok: true", () => {
      const r = toy.union(a, b);
      expect(r.ok).toBe(true);
    });

    test("result.brep has shells from both inputs (structural concat)", () => {
      const r = toy.union(a, b) as { ok: true; brep: Brep; changeMap: ChangeMap };
      expect(r.brep.shells).toHaveLength(a.shells.length + b.shells.length);
    });

    test("face count = sum of inputs", () => {
      const r = toy.union(a, b) as { ok: true; brep: Brep; changeMap: ChangeMap };
      expect(brepFaceCount(r.brep)).toBe(brepFaceCount(a) + brepFaceCount(b));
    });

    test("changeMap.modified maps all input shells", () => {
      const aMulti = twoShellBrep(); // 2 shells
      const bSingle = brepFromSurface(planeSurface()); // 1 shell
      const r = toy.union(aMulti, bSingle) as { ok: true; brep: Brep; changeMap: ChangeMap };
      expect(r.changeMap.modified.get("a:0")).toBe("result:0");
      expect(r.changeMap.modified.get("a:1")).toBe("result:1");
      expect(r.changeMap.modified.get("b:0")).toBe("result:2");
    });

    test("changeMap.created is empty (no synthetic new shells)", () => {
      const r = toy.union(a, b) as { ok: true; brep: Brep; changeMap: ChangeMap };
      expect(r.changeMap.created).toHaveLength(0);
    });

    test("changeMap.deleted is empty (no shells removed)", () => {
      const r = toy.union(a, b) as { ok: true; brep: Brep; changeMap: ChangeMap };
      expect(r.changeMap.deleted).toHaveLength(0);
    });

    test("union of empty breps returns empty brep", () => {
      const empty: Brep = { shells: [] };
      const r = toy.union(empty, empty) as { ok: true; brep: Brep; changeMap: ChangeMap };
      expect(r.brep.shells).toHaveLength(0);
    });
  });

  describe("difference / intersection / section", () => {
    test("difference returns NOT_IMPLEMENTED error", () => {
      const r = toy.difference(a, b);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("NOT_IMPLEMENTED");
        expect(r.error.backend).toBe("toy");
      }
    });

    test("intersection returns NOT_IMPLEMENTED error", () => {
      const r = toy.intersection(a, b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_IMPLEMENTED");
    });

    test("section returns NOT_IMPLEMENTED error", () => {
      const r = toy.section(a, b);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_IMPLEMENTED");
    });
  });
});

describe("top-level dispatch (brepUnion / brepDifference / brepIntersection / brepSection)", () => {
  const a = brepFromSurface(planeSurface());
  const b = brepFromSurface(planeSurface());

  test("brepUnion routes to toy backend by default", () => {
    const r = brepUnion(a, b);
    expect(r.ok).toBe(true);
  });

  test("brepUnion with explicit backend:'toy' routes correctly", () => {
    const r = brepUnion(a, b, { backend: "toy" });
    expect(r.ok).toBe(true);
  });

  test("brepDifference returns NOT_IMPLEMENTED via toy", () => {
    const r = brepDifference(a, b, { backend: "toy" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_IMPLEMENTED");
  });

  test("brepIntersection returns NOT_IMPLEMENTED via toy", () => {
    const r = brepIntersection(a, b, { backend: "toy" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_IMPLEMENTED");
  });

  test("brepSection returns NOT_IMPLEMENTED via toy", () => {
    const r = brepSection(a, b, { backend: "toy" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_IMPLEMENTED");
  });

  test("unknown backend returns BACKEND_UNAVAILABLE", () => {
    const r = brepUnion(a, b, { backend: "does-not-exist" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("BACKEND_UNAVAILABLE");
    }
  });

  test("per-op backend selection — mock backend used only for that call", () => {
    let called = false;
    const mockBackend: IBooleanBackend = {
      id: "mock-per-op",
      priority: 1,
      union: (a, b) => { called = true; return { ok: true, brep: a, changeMap: { created: [], modified: new Map(), deleted: [] } }; },
      difference: (a, b) => ({ ok: true, brep: b, changeMap: { created: [], modified: new Map(), deleted: [] } }),
      intersection: (a, b) => ({ ok: true, brep: a, changeMap: { created: [], modified: new Map(), deleted: [] } }),
      section: (a, b) => ({ ok: true, brep: a, changeMap: { created: [], modified: new Map(), deleted: [] } }),
    };
    registerBackend(mockBackend);

    // Call with explicit toy backend — mock should NOT be called
    brepUnion(a, b, { backend: "toy" });
    expect(called).toBe(false);

    // Call with explicit mock backend — mock IS called
    brepUnion(a, b, { backend: "mock-per-op" });
    expect(called).toBe(true);
  });
});

// ── #1828: Schema + synonym + dispatch routing for per-variant handlers ────────

describe("SdBooleanUnion / SdBooleanDifference / SdBooleanIntersection — schema (#1828)", () => {
  beforeEach(() => { clearDictionaryCache(); setRuntimeAliases({}); });

  test("SdBooleanUnion in dictionary, a+b required", () => {
    const entry = getDictionary().find((e) => e.name === "SdBooleanUnion");
    expect(entry).toBeDefined();
    expect(entry!.args.find((a) => a.name === "a")?.required).toBe(true);
    expect(entry!.args.find((a) => a.name === "b")?.required).toBe(true);
  });

  test("SdBooleanDifference in dictionary, outer+inner required", () => {
    const entry = getDictionary().find((e) => e.name === "SdBooleanDifference");
    expect(entry).toBeDefined();
    expect(entry!.args.find((a) => a.name === "outer")?.required).toBe(true);
    expect(entry!.args.find((a) => a.name === "inner")?.required).toBe(true);
  });

  test("SdBooleanIntersection in dictionary, a+b required", () => {
    const entry = getDictionary().find((e) => e.name === "SdBooleanIntersection");
    expect(entry).toBeDefined();
    expect(entry!.args.find((a) => a.name === "a")?.required).toBe(true);
    expect(entry!.args.find((a) => a.name === "b")?.required).toBe(true);
  });
});

describe("boolean variant synonym routing (#1828)", () => {
  beforeEach(() => { clearDictionaryCache(); setRuntimeAliases({}); });

  test("'union' → SdBooleanUnion", () => expect(resolveVerb("union")).toBe("SdBooleanUnion"));
  test("'fuse' → SdBooleanUnion",  () => expect(resolveVerb("fuse")).toBe("SdBooleanUnion"));
  test("'merge' → SdBooleanUnion", () => expect(resolveVerb("merge")).toBe("SdBooleanUnion"));
  test("'difference' → SdBooleanDifference", () => expect(resolveVerb("difference")).toBe("SdBooleanDifference"));
  test("'cut' → SdBooleanDifference",      () => expect(resolveVerb("cut")).toBe("SdBooleanDifference"));
  test("'subtract' → SdBooleanDifference", () => expect(resolveVerb("subtract")).toBe("SdBooleanDifference"));
  test("'intersection' → SdBooleanIntersection", () => expect(resolveVerb("intersection")).toBe("SdBooleanIntersection"));
  test("'intersect' → SdBooleanIntersection",    () => expect(resolveVerb("intersect")).toBe("SdBooleanIntersection"));
  test("'common' → SdBooleanIntersection",       () => expect(resolveVerb("common")).toBe("SdBooleanIntersection"));
});

describe("per-variant dispatch routing (#1828)", () => {
  beforeEach(() => {
    clearDictionaryCache(); setRuntimeAliases({});
    unregisterHandler("SdBooleanUnion");
    unregisterHandler("SdBooleanDifference");
    unregisterHandler("SdBooleanIntersection");
  });

  test("SdBooleanUnion mock receives a+b", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdBooleanUnion", (args) => { calls.push(args); return { created: "union" }; });
    const dr = dispatchSync("SdBooleanUnion", { a: "id-A", b: "id-B" });
    expect(dr.ok).toBe(true);
    expect(calls[0].a).toBe("id-A");
    expect(calls[0].b).toBe("id-B");
  });

  test("synonym 'union' routes to SdBooleanUnion handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdBooleanUnion", (args) => { calls.push(args); return { created: "union" }; });
    expect(dispatchSync("union", { a: "id-A", b: "id-B" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("SdBooleanDifference mock receives outer+inner", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdBooleanDifference", (args) => { calls.push(args); return { created: "diff" }; });
    dispatchSync("SdBooleanDifference", { outer: "box", inner: "sphere" });
    expect(calls[0].outer).toBe("box");
    expect(calls[0].inner).toBe("sphere");
  });

  test("synonym 'cut' routes to SdBooleanDifference handler", () => {
    const calls: unknown[] = [];
    registerHandler("SdBooleanDifference", (args) => { calls.push(args); return { created: "diff" }; });
    expect(dispatchSync("cut", { outer: "id-A", inner: "id-B" }).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("SdBooleanIntersection mock receives a+b", () => {
    const calls: Record<string, unknown>[] = [];
    registerHandler("SdBooleanIntersection", (args) => { calls.push(args); return { created: "inter" }; });
    dispatchSync("SdBooleanIntersection", { a: "id-A", b: "id-B" });
    expect(calls[0].a).toBe("id-A");
    expect(calls[0].b).toBe("id-B");
  });

  test("SdBooleanUnion missing b → ok=false (schema validation)", () => {
    registerHandler("SdBooleanUnion", () => ({ created: "union" }));
    expect(dispatchSync("SdBooleanUnion", { a: "id-A" }).ok).toBe(false);
  });

  test("SdBooleanDifference missing inner → ok=false (schema validation)", () => {
    registerHandler("SdBooleanDifference", () => ({ created: "diff" }));
    expect(dispatchSync("SdBooleanDifference", { outer: "id-A" }).ok).toBe(false);
  });

  test("SdBooleanIntersection missing a → ok=false (schema validation)", () => {
    registerHandler("SdBooleanIntersection", () => ({ created: "inter" }));
    expect(dispatchSync("SdBooleanIntersection", { b: "id-B" }).ok).toBe(false);
  });
});

describe("BrepResult type contract", () => {
  test("ok:true result has brep and changeMap", () => {
    const r: BrepResult = brepUnion(brepFromSurface(planeSurface()), brepFromSurface(planeSurface()));
    if (r.ok) {
      expect(r.brep).toBeDefined();
      expect(r.changeMap).toBeDefined();
      expect(Array.isArray(r.changeMap.created)).toBe(true);
      expect(r.changeMap.modified instanceof Map).toBe(true);
      expect(Array.isArray(r.changeMap.deleted)).toBe(true);
    }
  });

  test("ok:false result has typed KernelError", () => {
    const r: BrepResult = brepDifference(
      brepFromSurface(planeSurface()),
      brepFromSurface(planeSurface()),
      { backend: "toy" },
    );
    if (!r.ok) {
      expect(r.error.code).toBeDefined();
      expect(typeof r.error.message).toBe("string");
      expect(typeof r.error.backend).toBe("string");
    }
  });
});
