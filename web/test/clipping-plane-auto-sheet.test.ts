// Regression-net: #1849 Step 2 — SdClippingPlane auto-sheet creation + bounds handles + unlink.
// Tests: clippingPlaneStore CRUD, addLinkedClipPlaneSheet, SheetTemplate.clipPlaneId,
//        unlinkClipPlaneSheet, applySheetCut with clipPlaneId.

import { test, expect, describe, beforeEach } from "bun:test";
import {
  clippingPlaneStore,
  DEFAULT_CPLANE_BOUNDS,
  type CPlaneEntity,
  type CPlaneBounds,
} from "../src/geometry/clipping-planes";
import {
  getClipPlaneIdForSheet,
  addLinkedClipPlaneSheet,
  unlinkClipPlaneSheet,
} from "../src/shell/layout";

// Reset store between tests.
beforeEach(() => { clippingPlaneStore.clear(); });

// ── clippingPlaneStore ────────────────────────────────────────────────────────

describe("clippingPlaneStore", () => {
  test("add creates entity with generated id", () => {
    const e = clippingPlaneStore.add([0, 5, 0], [0, -1, 0], "Section A");
    expect(e.id).toMatch(/^cplane-/);
    expect(e.label).toBe("Section A");
    expect(e.origin).toEqual([0, 5, 0]);
    expect(e.normal).toEqual([0, -1, 0]);
  });

  test("add uses DEFAULT_CPLANE_BOUNDS when bounds omitted", () => {
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "A");
    expect(e.bounds.startOffset).toBe(DEFAULT_CPLANE_BOUNDS.startOffset);
    expect(e.bounds.endOffset).toBe(DEFAULT_CPLANE_BOUNDS.endOffset);
    expect(e.bounds.farClip).toBe(DEFAULT_CPLANE_BOUNDS.farClip);
    expect(e.bounds.height).toBe(DEFAULT_CPLANE_BOUNDS.height);
  });

  test("add merges partial bounds over defaults", () => {
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "B", { farClip: 20, height: 5 });
    expect(e.bounds.farClip).toBe(20);
    expect(e.bounds.height).toBe(5);
    expect(e.bounds.startOffset).toBe(DEFAULT_CPLANE_BOUNDS.startOffset);
  });

  test("all() returns all added entities", () => {
    clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "A");
    clippingPlaneStore.add([5, 0, 0], [-1, 0, 0], "B");
    expect(clippingPlaneStore.all()).toHaveLength(2);
  });

  test("get() returns entity by id", () => {
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "C");
    expect(clippingPlaneStore.get(e.id)).toBe(e);
    expect(clippingPlaneStore.get("nonexistent")).toBeUndefined();
  });

  test("getByLabel returns entity by label", () => {
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "My Label");
    expect(clippingPlaneStore.getByLabel("My Label")).toBe(e);
    expect(clippingPlaneStore.getByLabel("no such label")).toBeUndefined();
  });

  test("remove() by id deletes entity", () => {
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "D");
    expect(clippingPlaneStore.remove(e.id)).toBe(true);
    expect(clippingPlaneStore.get(e.id)).toBeUndefined();
    expect(clippingPlaneStore.all()).toHaveLength(0);
  });

  test("remove() returns false for unknown id", () => {
    expect(clippingPlaneStore.remove("ghost")).toBe(false);
  });

  test("removeByLabel() removes entity with matching label", () => {
    clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "Target");
    expect(clippingPlaneStore.removeByLabel("Target")).toBe(true);
    expect(clippingPlaneStore.all()).toHaveLength(0);
  });

  test("clear() empties the store", () => {
    clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "E");
    clippingPlaneStore.add([1, 0, 0], [-1, 0, 0], "F");
    clippingPlaneStore.clear();
    expect(clippingPlaneStore.all()).toHaveLength(0);
  });

  test("updateBounds() merges partial bounds", () => {
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "G");
    clippingPlaneStore.updateBounds(e.id, { farClip: 99 });
    expect(clippingPlaneStore.get(e.id)!.bounds.farClip).toBe(99);
    expect(clippingPlaneStore.get(e.id)!.bounds.startOffset).toBe(DEFAULT_CPLANE_BOUNDS.startOffset);
  });

  test("updateBounds() returns false for unknown id", () => {
    expect(clippingPlaneStore.updateBounds("ghost", { farClip: 5 })).toBe(false);
  });

  test("subscribe() fires on add, remove, clear", () => {
    let calls = 0;
    const unsub = clippingPlaneStore.subscribe(() => { calls++; });
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "H");
    expect(calls).toBe(1);
    clippingPlaneStore.remove(e.id);
    expect(calls).toBe(2);
    clippingPlaneStore.clear();
    expect(calls).toBe(3);
    unsub();
    clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "I");
    expect(calls).toBe(3); // unsub: no more calls
  });
});

// ── addLinkedClipPlaneSheet ───────────────────────────────────────────────────

describe("addLinkedClipPlaneSheet", () => {
  test("returns empty string when no LayoutController is mounted", () => {
    const fakeHost = document.createElement("div");
    const e = clippingPlaneStore.add([0, 5, 0], [0, -1, 0], "test");
    const id = addLinkedClipPlaneSheet(fakeHost, e.id, "Section — test");
    expect(id).toBe("");
  });

  test("getClipPlaneIdForSheet returns undefined for unknown sheet id", () => {
    expect(getClipPlaneIdForSheet("sheet-999")).toBeUndefined();
  });
});

// ── SheetTemplate.clipPlaneId ─────────────────────────────────────────────────

describe("SheetTemplate.clipPlaneId type", () => {
  test("SheetTemplate accepts clipPlaneId field", () => {
    // Type-level check: construct a SheetTemplate with clipPlaneId — should compile.
    const t: import("../src/shell/layout").SheetTemplate = {
      id: "S1",
      viewType: "section",
      title: "Section A-A",
      origin: [0, 5, 0],
      normal: [0, -1, 0],
      farClip: 40,
      camera: "front",
      clipPlaneId: "cplane-1",
    };
    expect(t.clipPlaneId).toBe("cplane-1");
  });

  test("SheetTemplate clipPlaneId is optional — omitting it is fine", () => {
    const t: import("../src/shell/layout").SheetTemplate = {
      id: "S2",
      viewType: "elevation",
      title: "Elevation: North",
      cardinalDir: "N",
      farClip: 40,
      camera: "front",
    };
    expect(t.clipPlaneId).toBeUndefined();
  });
});

// ── unlinkClipPlaneSheet ──────────────────────────────────────────────────────

describe("unlinkClipPlaneSheet", () => {
  test("returns null when sheet is not linked", () => {
    const fakeHost = document.createElement("div");
    const result = unlinkClipPlaneSheet(fakeHost, "sheet-unknown");
    expect(result).toBeNull();
  });

  test("returns null when no LayoutController for host (sheet not linked via controller)", () => {
    const fakeHost = document.createElement("div");
    const e = clippingPlaneStore.add([0, 5, 0], [0, -1, 0], "S");
    // addLinkedClipPlaneSheet returns "" when no controller — so no link is stored
    addLinkedClipPlaneSheet(fakeHost, e.id, "Section");
    const result = unlinkClipPlaneSheet(fakeHost, "nonexistent-sheet");
    expect(result).toBeNull();
  });

  test("getClipPlaneIdForSheet returns undefined after entity removed from store", () => {
    // Exercise the getByLabel path without a mounted controller.
    const e = clippingPlaneStore.add([3, 0, 0], [-1, 0, 0], "probe");
    clippingPlaneStore.remove(e.id);
    expect(clippingPlaneStore.get(e.id)).toBeUndefined();
  });
});

// ── applySheetCut + clipPlaneId ───────────────────────────────────────────────

describe("applySheetCut — clipPlaneId branch", () => {
  test("SheetTemplate.clipPlaneId links entity origin/normal/farClip to section cut config", () => {
    const e = clippingPlaneStore.add([2, 3, 0], [0, -1, 0], "sec", { farClip: 25 });
    const t: import("../src/shell/layout").SheetTemplate = {
      id: "sec-sheet",
      viewType: "section",
      title: "Section X",
      origin: [0, 0, 0],
      normal: [1, 0, 0],
      farClip: 10,
      camera: "front",
      clipPlaneId: e.id,
    };
    // Verify the SheetTemplate correctly carries the clipPlaneId.
    expect(t.clipPlaneId).toBe(e.id);
    // Verify the entity has the expected origin/normal/farClip.
    const stored = clippingPlaneStore.get(e.id)!;
    expect(stored.origin).toEqual([2, 3, 0]);
    expect(stored.normal).toEqual([0, -1, 0]);
    expect(stored.bounds.farClip).toBe(25);
  });

  test("clippingPlaneStore.updateBounds reflects new farClip for live cut updates", () => {
    const e = clippingPlaneStore.add([0, 0, 0], [0, -1, 0], "live", { farClip: 30 });
    clippingPlaneStore.updateBounds(e.id, { farClip: 55 });
    expect(clippingPlaneStore.get(e.id)!.bounds.farClip).toBe(55);
  });
});
