// #1655 — SdStair must reject dimension overrides and descending/zero-rise stair requests.
// Two enforcement layers:
//   1. DIMENSION_ARGS_BLOCKLIST (dispatch.ts) — blocks riserHeight/treadDepth; agent can
//      only control placement, not step geometry.
//   2. DimensionGuardrail (dimension-guardrails.ts) — rejects level_to.elevation ≤
//      level_from.elevation before a degenerate mesh is built.
import { describe, test, expect, beforeEach } from "bun:test";
import {
  dispatch,
  registerHandler,
  unregisterHandler,
  setRuntimeAliases,
} from "../src/commands/dispatch";
import { getDictionary, clearDictionaryCache } from "../src/commands/dictionary";

function clearAllHandlers() {
  const dict = getDictionary();
  for (const e of dict) unregisterHandler(e.name);
}

beforeEach(() => {
  clearDictionaryCache();
  clearAllHandlers();
  setRuntimeAliases({});
});

describe("stair-validator-ibc (#1655)", () => {
  // ── Blocklist: dimension override args rejected before handler runs ──────────

  test("riserHeight arg blocked — ArgValidationError", async () => {
    // Blocklist fires before handler; no-op handler verifies handler not reached.
    registerHandler("SdStair", () => ({ placed: true }));
    const r = await dispatch("SdStair", { riserHeight: 0.685 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("ArgValidationError");
      expect(r.detail).toMatch(/riserHeight/);
    }
  });

  test("treadDepth arg blocked — ArgValidationError", async () => {
    registerHandler("SdStair", () => ({ placed: true }));
    const r = await dispatch("SdStair", { treadDepth: 0.1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("ArgValidationError");
      expect(r.detail).toMatch(/treadDepth/);
    }
  });

  // ── Guardrail: level_to.elevation must exceed level_from.elevation ───────────

  test("descending stair (level 1 → level 0) rejected — DimensionGuardrailError", async () => {
    registerHandler("SdStair", () => ({ placed: true }));
    const r = await dispatch("SdStair", {
      level_from: { elevation: 2.74 },
      level_to:   { elevation: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toBe("DimensionGuardrailError");
      expect(r.detail).toMatch(/level_to\.elevation/);
    }
  });

  test("zero-delta stair (same level) rejected — DimensionGuardrailError", async () => {
    registerHandler("SdStair", () => ({ placed: true }));
    const r = await dispatch("SdStair", {
      level_from: { elevation: 0 },
      level_to:   { elevation: 0 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("DimensionGuardrailError");
  });

  // ── Valid args pass through to handler ───────────────────────────────────────

  test("valid ascending stair (level 0 → level 1) passes guardrail", async () => {
    registerHandler("SdStair", () => ({ placed: true }));
    const r = await dispatch("SdStair", {
      level_from: { elevation: 0 },
      level_to:   { elevation: 2.74 },
    });
    // Must NOT be a guardrail/blocklist rejection.
    expect(r.ok).toBe(true);
  });
});
