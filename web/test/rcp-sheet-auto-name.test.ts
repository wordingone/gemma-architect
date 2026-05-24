// Regression-net: #1844 — Layout RCP sheets auto-named "RCP: Level N".
// Tests: syncRcpSheets lifecycle, SheetViewType "rcp", applySheetCut RCP branch,
//        getRcpLinkedLevelIdForSheet, markRcpSheetUserRenamed.

import { test, expect, describe, beforeEach } from "bun:test";
import { levelStore } from "../src/geometry/levels";
import {
  getRcpLinkedLevelIdForSheet,
  markRcpSheetUserRenamed,
  buildLayoutMode,
  type SheetLevelRef,
  type SheetTemplate,
} from "../src/shell/layout";

beforeEach(() => {
  const extras = levelStore.all().filter(l => l.id !== "level/0");
  for (const l of extras) levelStore.remove(l.id);
  levelStore.update("level/0", { name: "Level 1" });
});

// ── SheetViewType "rcp" ───────────────────────────────────────────────────────

describe("SheetTemplate viewType rcp", () => {
  test("SheetTemplate accepts viewType 'rcp'", () => {
    const t: SheetTemplate = {
      id: "R1",
      viewType: "rcp",
      title: "RCP: Level 1",
      levelId: "level/0",
      camera: "top",
    };
    expect(t.viewType).toBe("rcp");
  });

  test("SheetTemplate accepts rcpCutOffset override", () => {
    const t: SheetTemplate = {
      id: "R2",
      viewType: "rcp",
      title: "RCP: Level 1",
      levelId: "level/0",
      rcpCutOffset: 2.1,
      camera: "top",
    };
    expect(t.rcpCutOffset).toBe(2.1);
  });

  test("SheetLevelRef accepts optional height field", () => {
    const ref: SheetLevelRef = { elevation: 0, height: 3.2 };
    expect(ref.height).toBe(3.2);
  });
});

// ── Initial sync ──────────────────────────────────────────────────────────────

describe("RCP sheet initial sync", () => {
  test("buildLayoutMode creates an 'RCP: Level 1' sheet for default Level 1", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const rcpSheets = c.sheets.filter(s => s.name.startsWith("RCP:"));
    expect(rcpSheets.length).toBe(1);
    expect(rcpSheets[0].name).toBe("RCP: Level 1");
  });

  test("getRcpLinkedLevelIdForSheet returns 'level/0' for the RCP: Level 1 sheet", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const rcpSheet = c.sheets.find(s => s.name === "RCP: Level 1")!;
    expect(rcpSheet).toBeDefined();
    expect(getRcpLinkedLevelIdForSheet(host, rcpSheet.id)).toBe("level/0");
  });

  test("both plan and RCP sheets exist alongside the 4 preset sheets", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const planSheets = c.sheets.filter(s => s.name.startsWith("Plan:"));
    const rcpSheets = c.sheets.filter(s => s.name.startsWith("RCP:"));
    const other = c.sheets.filter(s => !s.name.startsWith("Plan:") && !s.name.startsWith("RCP:"));
    expect(planSheets.length).toBe(1);
    expect(rcpSheets.length).toBe(1);
    expect(other.length).toBe(4); // perspective, axonometric, section, elevation
  });
});

// ── Level add ─────────────────────────────────────────────────────────────────

describe("RCP sheet on level add", () => {
  test("adding a level creates an 'RCP: Level 2' sheet", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    const rcpSheets = c.sheets.filter(s => s.name.startsWith("RCP:"));
    expect(rcpSheets.length).toBe(2);
    expect(rcpSheets.find(s => s.name === "RCP: Level 2")).toBeDefined();
  });

  test("two levels → two RCP sheets (AC mirror of #1846 test)", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.add({ name: "Level 2", elevation: 3.0 });
    levelStore.add({ name: "Level 3", elevation: 6.0 });
    const rcpSheets = c.sheets.filter(s => s.name.startsWith("RCP:"));
    expect(rcpSheets.length).toBe(3); // Level 1 + Level 2 + Level 3
    expect(rcpSheets.map(s => s.name).sort()).toEqual(["RCP: Level 1", "RCP: Level 2", "RCP: Level 3"]);
  });
});

// ── Level rename ──────────────────────────────────────────────────────────────

describe("RCP sheet on level rename", () => {
  test("renaming Level 1 to 'Ground Floor' renames the RCP sheet", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    levelStore.update("level/0", { name: "Ground Floor" });
    const rcpSheet = c.sheets.find(s => s.name.startsWith("RCP:"));
    expect(rcpSheet?.name).toBe("RCP: Ground Floor");
  });

  test("user-renamed RCP sheet is NOT auto-renamed on level rename", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const rcpSheet = c.sheets.find(s => s.name === "RCP: Level 1")!;
    rcpSheet.name = "Custom Ceiling Plan";
    markRcpSheetUserRenamed(host, rcpSheet.id);
    levelStore.update("level/0", { name: "Basement" });
    expect(rcpSheet.name).toBe("Custom Ceiling Plan");
  });
});

// ── Level remove ─────────────────────────────────────────────────────────────

describe("RCP sheet on level remove", () => {
  test("removing a level removes its RCP sheet", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const l2 = levelStore.add({ name: "Level 2", elevation: 3.0 });
    expect(c.sheets.filter(s => s.name.startsWith("RCP:")).length).toBe(2);
    levelStore.remove(l2.id);
    expect(c.sheets.filter(s => s.name.startsWith("RCP:")).length).toBe(1);
    expect(c.sheets.find(s => s.name === "RCP: Level 2")).toBeUndefined();
  });

  test("getRcpLinkedLevelIdForSheet returns undefined after level removed", () => {
    const host = document.createElement("div");
    const c = buildLayoutMode(host, { spawnDefault: false });
    const l2 = levelStore.add({ name: "Level 2", elevation: 3.0 });
    const sheet = c.sheets.find(s => s.name === "RCP: Level 2")!;
    expect(sheet).toBeDefined();
    const sheetId = sheet.id;
    levelStore.remove(l2.id);
    expect(getRcpLinkedLevelIdForSheet(host, sheetId)).toBeUndefined();
  });
});
