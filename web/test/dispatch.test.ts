// dispatch.test.ts — verify the central command dispatch (T6).
// Per plan §T6 verification: every entry in spatial-api.yaml
// resolves to a handler with arg validation; ArgValidationError is
// returned not thrown; UnknownVerb returned cleanly; alias resolution
// follows the documented order (canonical → runtime → compiled).

import { describe, expect, test, beforeEach } from "bun:test";
import { getDictionary, clearDictionaryCache } from "../src/commands/dictionary";
import {
  dispatch,
  dispatchSync,
  resolveVerb,
  registerHandler,
  unregisterHandler,
  registerHandlers,
  hasHandler,
  setRuntimeAliases,
  installDefaultHandlers,
  dispatchCoverage,
} from "../src/commands/dispatch";

function clearAllHandlers() {
  // We can't `dispatch.clear()` because the registry is module-private.
  // Instead, unregister every dictionary verb. (This is enough for tests;
  // production never needs to clear.)
  const dict = getDictionary();
  for (const e of dict) unregisterHandler(e.canonical_name);
}

beforeEach(() => {
  clearDictionaryCache();
  clearAllHandlers();
  setRuntimeAliases({});
});

describe("Verb resolution", () => {
  test("resolves canonical name to itself", () => {
    expect(resolveVerb("SdWall")).toBe("SdWall");
  });

  test("resolves a synonym to canonical", () => {
    const wallCanonical = resolveVerb("wall");
    expect(wallCanonical).toBeTruthy();
    // The exact canonical depends on the YAML — we just assert it's
    // a valid dictionary entry.
    expect(getDictionary().some((e) => e.canonical_name === wallCanonical)).toBe(true);
  });

  test("resolves old Ifc* synonym to new Sd* canonical", () => {
    // IfcWall was renamed to SdWall; old name kept as synonym for backward compat.
    expect(resolveVerb("IfcWall")).toBe("SdWall");
  });

  test("returns null for unknown token", () => {
    expect(resolveVerb("__nonexistent_verb__")).toBeNull();
  });

  test("runtime alias overrides take precedence over compiled aliases for unknown synonyms", () => {
    expect(resolveVerb("zzzCustom")).toBeNull();
    setRuntimeAliases({ zzzCustom: "SdWall" });
    expect(resolveVerb("zzzCustom")).toBe("SdWall");
  });

  test("runtime alias is case-insensitive", () => {
    setRuntimeAliases({ MyWall: "SdWall" });
    expect(resolveVerb("mywall")).toBe("SdWall");
    expect(resolveVerb("MYWALL")).toBe("SdWall");
  });

  test("invalid runtime alias target gracefully falls through", () => {
    setRuntimeAliases({ floof: "DefinitelyNotAReal_Canonical_Name" });
    // Falls through to compiled aliases, which won't have "floof"
    // either — should return null, not the bogus canonical.
    expect(resolveVerb("floof")).toBeNull();
  });
});

describe("Dispatch + validation", () => {
  test("UnknownVerb on unknown verb", async () => {
    const r = await dispatch("__nonexistent__", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("UnknownVerb");
      expect(r.canonical).toBeNull();
    }
  });

  test("NoHandler when verb resolves but nothing is registered", async () => {
    // SdWall resolves to canonical "SdWall"; IfcWall is a synonym that also resolves to it.
    const r = await dispatch("SdWall", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error === "NoHandler" || r.error === "ArgValidationError").toBe(true);
      expect(r.canonical).toBe("SdWall");
    }
  });

  test("ArgValidationError when a required arg is missing", async () => {
    // Find any entry with a required arg.
    const dict = getDictionary();
    const entryWithRequired = dict.find((e) => e.args.some((a) => a.required));
    expect(entryWithRequired).toBeDefined();
    if (!entryWithRequired) return;
    registerHandler(entryWithRequired.canonical_name, () => "ok");
    const r = await dispatch(entryWithRequired.canonical_name, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("ArgValidationError");
    }
  });

  test("ArgValidationError on type mismatch", async () => {
    // Find any entry with a numeric required arg.
    const dict = getDictionary();
    const entry = dict.find((e) =>
      e.args.some((a) => a.required && (a.type === "number" || a.type === "integer")),
    );
    if (!entry) return; // skip if YAML has no such entry
    const numericArg = entry.args.find((a) => a.required && (a.type === "number" || a.type === "integer"));
    if (!numericArg) return;
    registerHandler(entry.canonical_name, () => "ok");
    // Build a complete-ish args object but break the numeric one.
    const args: Record<string, unknown> = {};
    for (const a of entry.args) {
      if (a.required) {
        if (a.name === numericArg.name) args[a.name] = "not-a-number";
        else if (a.type === "number" || a.type === "integer") args[a.name] = 1;
        else if (a.type === "string") args[a.name] = "ok";
        else if (a.type === "boolean") args[a.name] = true;
        else if (a.type === "point2") args[a.name] = [0, 0];
        else if (a.type === "point3" || a.type === "vector3") args[a.name] = [0, 0, 0];
        else if (a.type === "polyline" || a.type === "list_point2") args[a.name] = [[0, 0]];
        else args[a.name] = {};
      }
    }
    const r = await dispatch(entry.canonical_name, args);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("ArgValidationError");
      expect(r.detail).toContain(numericArg.name);
    }
  });

  test("HandlerThrew is captured, not propagated", async () => {
    registerHandler("SdWall", () => {
      throw new Error("boom");
    });
    // Provide all required args so we hit the handler.
    const dict = getDictionary();
    const wall = dict.find((e) => e.canonical_name === "SdWall");
    expect(wall).toBeDefined();
    if (!wall) return;
    const args: Record<string, unknown> = {};
    for (const a of wall.args) {
      if (a.required) {
        if (a.type === "number" || a.type === "integer") args[a.name] = 1;
        else if (a.type === "polyline" || a.type === "list_point2") args[a.name] = [[0, 0], [1, 1]];
        else if (a.type === "point2") args[a.name] = [0, 0];
        else if (a.type === "point3" || a.type === "vector3") args[a.name] = [0, 0, 0];
        else args[a.name] = "x";
      }
    }
    const r = await dispatch("SdWall", args);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("HandlerThrew");
      expect(r.detail).toContain("boom");
    }
  });

  test("dispatchSync flags Promise-returning handlers", () => {
    registerHandler("SdWall", () => Promise.resolve("nope"));
    const dict = getDictionary();
    const wall = dict.find((e) => e.canonical_name === "SdWall")!;
    const args: Record<string, unknown> = {};
    for (const a of wall.args) {
      if (a.required) {
        if (a.type === "number" || a.type === "integer") args[a.name] = 1;
        else if (a.type === "polyline" || a.type === "list_point2") args[a.name] = [[0, 0], [1, 1]];
        else args[a.name] = "x";
      }
    }
    const r = dispatchSync("SdWall", args);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("HandlerThrew");
  });

  test("happy path: registered handler returns ok with result", async () => {
    registerHandler("SdWall", () => ({ created: "wall-1" }));
    const dict = getDictionary();
    const wall = dict.find((e) => e.canonical_name === "SdWall")!;
    const args: Record<string, unknown> = {};
    for (const a of wall.args) {
      if (a.required) {
        if (a.type === "number" || a.type === "integer") args[a.name] = 1;
        else if (a.type === "polyline" || a.type === "list_point2") args[a.name] = [[0, 0], [1, 1]];
        else args[a.name] = "x";
      }
    }
    const r = await dispatch("SdWall", args);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { created: string }).created).toBe("wall-1");
  });

  test("dispatch resolves synonyms to their canonical handler", async () => {
    const wallCanonical = resolveVerb("wall");
    expect(wallCanonical).toBeTruthy();
    if (!wallCanonical) return;
    registerHandler(wallCanonical, () => "via synonym");
    const dict = getDictionary();
    const wall = dict.find((e) => e.canonical_name === wallCanonical)!;
    const args: Record<string, unknown> = {};
    for (const a of wall.args) {
      if (a.required) {
        if (a.type === "number" || a.type === "integer") args[a.name] = 1;
        else if (a.type === "polyline" || a.type === "list_point2") args[a.name] = [[0, 0], [1, 1]];
        else args[a.name] = "x";
      }
    }
    const r = await dispatch("wall", args);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.canonical).toBe(wallCanonical);
      expect(r.result).toBe("via synonym");
    }
  });
});

describe("SdWall profile requirement (#326)", () => {
  beforeEach(() => {
    unregisterHandler("SdWall");
  });

  test("dispatch succeeds when profile is provided", async () => {
    registerHandler("SdWall", (args) => ({ got: args }));
    // IfcWall is a synonym for SdWall — both input paths must work.
    const r = await dispatch("IfcWall", { profile: [[0, 0], [5, 0]], thickness: 0.2, height: 2.8 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical).toBe("SdWall");
  });

  test("dispatch accepts SdWall with start/end args (profile now optional)", async () => {
    registerHandler("SdWall", () => "ok");
    // profile is now optional; start+end are the alternative form.
    const r = await dispatch("SdWall", { start: { x: 0, y: 0, z: 0 }, end: { x: 5, y: 0, z: 0 } });
    expect(r.ok).toBe(true);
    // empty args still succeed (handler uses defaults)
    const r2 = await dispatch("SdWall", {});
    expect(r2.ok).toBe(true);
  });
});

describe("Bulk handler installation + coverage", () => {
  test("installDefaultHandlers covers every dictionary entry", () => {
    installDefaultHandlers();
    const cov = dispatchCoverage();
    expect(cov.total).toBeGreaterThan(0);
    expect(cov.covered).toBe(cov.total);
    expect(cov.missing.length).toBe(0);
    expect(cov.covered_ratio).toBe(1);
  });

  test("dispatchCoverage returns missing entries when handlers are sparse", () => {
    // Register 1 handler.
    registerHandler("SdWall", () => null);
    const cov = dispatchCoverage();
    expect(cov.covered).toBe(1);
    expect(cov.missing.length).toBe(cov.total - 1);
  });

  test("registerHandlers bulk-registers a record", () => {
    registerHandlers({
      SdWall: () => 1,
      SdSlab: () => 2,
    });
    expect(hasHandler("SdWall")).toBe(true);
    expect(hasHandler("SdSlab")).toBe(true);
  });
});
