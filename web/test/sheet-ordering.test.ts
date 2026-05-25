// Regression-net: #1847 — Default sheet ordering.
// Target order: Plan(s) → Section(s) → Elevation(s) → RCP(s) → Axonometric → Perspective
// Also tests DEMO_SHEET_SET ordering (sections before elevations).

import { test, expect, describe, beforeEach } from "bun:test";
import { levelStore } from "../src/geometry/levels";
import { buildLayoutMode, DEMO_SHEET_SET } from "../src/shell/layout";

beforeEach(() => {
  const extras = levelStore.all().filter(l => l.id !== "level/0");
  for (const l of extras) levelStore.remove(l.id);
  levelStore.update("level/0", { name: "Level 1" });
});

// ── DEMO_SHEET_SET ordering ────────────────────────────────────────────────────

describe("DEMO_SHEET_SET ordering (#1847)", () => {
  test("sections come before elevations", () => {
    const secIdx = DEMO_SHEET_SET.findIndex(s => s.viewType === "section");
    const elvIdx = DEMO_SHEET_SET.findIndex(s => s.viewType === "elevation");
    expect(secIdx).toBeLessThan(elvIdx);
  });

  test("all sections appear before any elevation", () => {
    const lastSec = DEMO_SHEET_SET.reduce((acc, s, i) => s.viewType === "section" ? i : acc, -1);
    const firstElv = DEMO_SHEET_SET.findIndex(s => s.viewType === "elevation");
    expect(lastSec).toBeLessThan(firstElv);
  });
});

// ── LayoutController sheet tab order ─────────────────────────────────────────

describe("LayoutController sheet order (#1847)", () => {
  test("first sheet is 'Plan: Level 1' (plan at index 0)", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    expect(c.sheets[0].name).toBe("Plan: Level 1");
  });

  test("Section preset follows all Plan sheets", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    expect(c.sheets[planCount].name).toBe("Section");
  });

  test("Elevation preset follows Section", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    expect(c.sheets[planCount + 1].name).toBe("Elevation");
  });

  test("RCP sheet follows Elevation", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    // planCount presets: Section(+0), Elevation(+1), then RCP(+2)
    expect(c.sheets[planCount + 2].name).toBe("RCP: Level 1");
  });

  test("Axonometric follows RCP region", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const rcpIdx = c.sheets.findIndex(s => s.name === "RCP: Level 1");
    expect(c.sheets[rcpIdx + 1].name).toBe("Axonometric");
  });

  test("Perspective is last", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    expect(c.sheets[c.sheets.length - 1].name).toBe("Perspective");
  });

  test("full order for single level: Plan → Section → Elevation → RCP → Axonometric → Perspective", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const names = c.sheets.map(s => s.name);
    expect(names).toEqual([
      "Plan: Level 1",
      "Section",
      "Elevation",
      "RCP: Level 1",
      "Axonometric",
      "Perspective",
    ]);
  });
});

// ── Plan sheet insertion index on level add ───────────────────────────────────

describe("Plan sheet insertion order on level add (#1847)", () => {
  test("second plan sheet inserts at index 1 (after first plan)", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    expect(c.sheets[0].name).toBe("Plan: Level 1");
    expect(c.sheets[1].name).toBe("Plan: Level 2");
  });

  test("two plans: Section still follows both plans", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    expect(c.sheets[2].name).toBe("Section");
  });

  test("plan removal restores original order", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const l2 = levelStore.add({ name: "Level 2", elevation: 3.0 });
    levelStore.remove(l2.id);
    expect(c.sheets[0].name).toBe("Plan: Level 1");
    expect(c.sheets[1].name).toBe("Section");
  });
});

// ── RCP sheet insertion index on level add ────────────────────────────────────

describe("RCP sheet insertion order on level add (#1847)", () => {
  test("two levels: both RCP sheets are after both elevation presets", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    // [Plan:L1, Plan:L2, Section, Elevation, RCP:L1, RCP:L2, Axo, Perspective]
    const names = c.sheets.map(s => s.name);
    const rcpIdxs = names.reduce<number[]>((a, n, i) => n.startsWith("RCP:") ? [...a, i] : a, []);
    const elvIdx = names.indexOf("Elevation");
    expect(rcpIdxs.every(i => i > elvIdx)).toBe(true);
  });

  test("RCP sheets appear before Axonometric", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    const names = c.sheets.map(s => s.name);
    const lastRcp = names.reduce((a, n, i) => n.startsWith("RCP:") ? i : a, -1);
    const axoIdx = names.indexOf("Axonometric");
    expect(lastRcp).toBeLessThan(axoIdx);
  });
});
