// #1675 — Engine-determinism Phase 1 ROOF: per-element invariant gate.
// Pins SdRoof buildRoof output against FZK KIT Haus reference geometry
// (12×10m footprint, 30° pitch, 0.5m overhang — correct dimensions per
// docs/canonical-roof-fzk-haus.md §A).
//
// Guards the recurring bug class: gable-end / pitch-deg / pfette-position
// regressions introduced by refactors. Tolerance 1e-3 on float quantities.
//
// Structural checks migrated to compareFixture() (#1779). Derived math tests
// stay hardcoded — they verify formulas, not group structure.
import { describe, test, expect } from "bun:test";
import { buildRoof } from "../src/tools/structural";
import { compareFixture } from "../src/test/fixture-compare";
import type { FixtureJson } from "../src/test/fixture-compare";
import target from "./fixtures/fzk-haus-roof-target.json";

const TOL = 1e-3;

describe("SdRoof FZK invariant gate (#1675)", () => {
  const group = buildRoof(
    { x: target.params.p0.x, y: target.params.p0.y },
    { x: target.params.p1.x, y: target.params.p1.y },
    { type: "pitched", pitchDeg: target.params.pitchDeg, overhang: target.params.overhang },
  ).mesh;

  // ── Derived quantities (hardcoded: formula verification, not structure) ───

  test("derived: rH = spanHalf × tan(pitchRad)", () => {
    const pitchRad = (target.params.pitchDeg * Math.PI) / 180;
    expect(Math.abs(target.derived.rH - target.derived.spanHalf * Math.tan(pitchRad))).toBeLessThan(TOL);
  });

  test("derived: rafterLen = spanHalf / cos(pitchRad)", () => {
    const pitchRad = (target.params.pitchDeg * Math.PI) / 180;
    expect(Math.abs(target.derived.rafterLen - target.derived.spanHalf / Math.cos(pitchRad))).toBeLessThan(TOL);
  });

  // ── Structural invariants (compareFixture — collects all drift) ───────────

  test("structural invariants: compareFixture passes with no drift", () => {
    const eps = { geometry: TOL, position: TOL, rotation: TOL, dot: TOL };
    const result = compareFixture(group, target as unknown as FixtureJson, { epsilon: eps });
    if (!result.pass) {
      const summary = result.failures
        .map((f) => `  ${f.component}.${f.quantity}: expected=${f.expected} actual=${f.actual} delta=${f.delta.toFixed(6)}`)
        .join("\n");
      throw new Error(`compareFixture found ${result.failures.length} drift(s):\n${summary}`);
    }
    expect(result.pass).toBe(true);
  });
});
