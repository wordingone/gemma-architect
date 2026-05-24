// Regression-net: #1846 — Layout plan sheets auto-named "Plan: Level N".
// Tests: levelStore subscribe wiring, syncPlanSheets lifecycle, getLinkedLevelIdForSheet.

import { test, expect, describe, beforeEach } from "bun:test";
import { levelStore } from "../src/geometry/levels";
import {
  getLinkedLevelIdForSheet,
  markPlanSheetUserRenamed,
  buildLayoutMode,
} from "../src/shell/layout";

// Reset levelStore before each test — add/remove non-ground levels so Level 1 always exists.
beforeEach(() => {
  // Remove any non-builtin levels by removing levels with id != "level/0".
  const extras = levelStore.all().filter(l => l.id !== "level/0");
  for (const l of extras) levelStore.remove(l.id);
  // Reset Level 1 name.
  levelStore.update("level/0", { name: "Level 1" });
});

// ── Initial sync ──────────────────────────────────────────────────────────────

describe("plan sheet initial sync", () => {
  test("buildLayoutMode creates a 'Plan: Level 1' sheet for default Level 1", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planSheets = c.sheets.filter(s => s.name.startsWith("Plan:"));
    expect(planSheets.length).toBe(1);
    expect(planSheets[0].name).toBe("Plan: Level 1");
  });

  test("getLinkedLevelIdForSheet returns 'level/0' for the Plan: Level 1 sheet", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planSheet = c.sheets.find(s => s.name === "Plan: Level 1")!;
    expect(planSheet).toBeDefined();
    expect(getLinkedLevelIdForSheet(host, planSheet.id)).toBe("level/0");
  });

  test("4 preset sheets (non-plan, non-rcp) are created alongside the plan sheet", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const presets = c.sheets.filter(s => !s.name.startsWith("Plan:") && !s.name.startsWith("RCP:"));
    expect(presets.length).toBe(4); // perspective, axonometric, section, elevation
  });
});

// ── Level add ─────────────────────────────────────────────────────────────────

describe("plan sheet on level add", () => {
  test("adding a level creates a new plan sheet named 'Plan: Level 2'", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const before = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    const after = c.sheets.filter(s => s.name.startsWith("Plan:"));
    expect(after.length).toBe(before + 1);
    expect(after.find(s => s.name === "Plan: Level 2")).toBeDefined();
  });

  test("dispatch SdLevel twice creates 2 plan sheets (AC test from issue)", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    levelStore.add({ name: "Level 3", elevation: 6.0 });
    const planSheets = c.sheets.filter(s => s.name.startsWith("Plan:"));
    expect(planSheets.length).toBe(3); // Level 1 + Level 2 + Level 3
    expect(planSheets.map(s => s.name).sort()).toEqual(["Plan: Level 1", "Plan: Level 2", "Plan: Level 3"]);
  });

  test("getLinkedLevelIdForSheet returns the added level's id", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const l2 = levelStore.add({ name: "Level 2", elevation: 3.0 });
    const sheet = c.sheets.find(s => s.name === "Plan: Level 2")!;
    expect(sheet).toBeDefined();
    const levelId = getLinkedLevelIdForSheet(host, sheet.id);
    expect(levelId).toBe(l2.id);
  });
});

// ── Level rename ──────────────────────────────────────────────────────────────

describe("plan sheet on level rename", () => {
  test("renaming Level 1 to 'Ground Floor' renames the plan sheet (AC test from issue)", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.update("level/0", { name: "Ground Floor" });
    const planSheet = c.sheets.find(s => s.name.startsWith("Plan:"));
    expect(planSheet?.name).toBe("Plan: Ground Floor");
  });

  test("user-renamed sheet is NOT auto-renamed on level rename", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planSheet = c.sheets.find(s => s.name === "Plan: Level 1")!;
    planSheet.name = "My Custom Floor Plan"; // user edits the tab
    markPlanSheetUserRenamed(host, planSheet.id);
    levelStore.update("level/0", { name: "Basement" });
    // Should still have the user-set name.
    expect(planSheet.name).toBe("My Custom Floor Plan");
  });
});

// ── Level remove ─────────────────────────────────────────────────────────────

describe("plan sheet on level remove", () => {
  test("removing a level removes its plan sheet", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const l2 = levelStore.add({ name: "Level 2", elevation: 3.0 });
    const beforeCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    expect(beforeCount).toBe(2); // Level 1 + Level 2
    levelStore.remove(l2.id);
    const afterCount = c.sheets.filter(s => s.name.startsWith("Plan:")).length;
    expect(afterCount).toBe(1); // Only Level 1 left
    expect(c.sheets.find(s => s.name === "Plan: Level 2")).toBeUndefined();
  });

  test("getLinkedLevelIdForSheet returns undefined after level removed", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const l2 = levelStore.add({ name: "Level 2", elevation: 3.0 });
    const sheet = c.sheets.find(s => s.name === "Plan: Level 2")!;
    expect(sheet).toBeDefined();
    const sheetId = sheet.id;
    levelStore.remove(l2.id);
    expect(getLinkedLevelIdForSheet(host, sheetId)).toBeUndefined();
  });
});
