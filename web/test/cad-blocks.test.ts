// Regression-net: #1853 / #1888 — CAD blocks library.
// Sourced from GSStnb/dxfBlocks (CC0-1.0), DXF→SVG converted.

import { test, expect, describe } from "bun:test";
import {
  BLOCK_CATALOG,
  getBlockEntry,
  getSelectedBlockId,
  setSelectedBlockId,
  type BlockEntry,
} from "../src/shell/cad-blocks-panel";

// ── Catalog completeness ─────────────────────────────────────────────────────

describe("BLOCK_CATALOG completeness (AC #1: ≥30 sourced blocks)", () => {
  test("catalog has ≥30 blocks", () => {
    expect(BLOCK_CATALOG.length).toBeGreaterThanOrEqual(30);
  });

  test("every entry has a unique id", () => {
    const ids = BLOCK_CATALOG.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry has a non-empty path", () => {
    for (const b of BLOCK_CATALOG) {
      expect(b.path.length).toBeGreaterThan(0);
    }
  });

  test("every entry has a non-empty label", () => {
    for (const b of BLOCK_CATALOG) {
      expect(b.label.length).toBeGreaterThan(0);
    }
  });

  test("every entry has a valid view", () => {
    const valid = new Set(["plan", "elevation", "section"]);
    for (const b of BLOCK_CATALOG) {
      expect(valid.has(b.view)).toBe(true);
    }
  });

  test("every path ends with .svg", () => {
    for (const b of BLOCK_CATALOG) {
      expect(b.path.endsWith(".svg")).toBe(true);
    }
  });
});

// ── Category coverage ────────────────────────────────────────────────────────

describe("block catalog category coverage", () => {
  const byView = (cat: string, v: string) => BLOCK_CATALOG.filter(b => b.category === cat && b.view === v);

  test("Doors: 5 plan views", () => {
    expect(byView("Doors", "plan").length).toBe(5);
  });

  test("Windows: 4 plan + 4 elevation + 3 section", () => {
    expect(byView("Windows", "plan").length).toBe(4);
    expect(byView("Windows", "elevation").length).toBe(4);
    expect(byView("Windows", "section").length).toBe(3);
  });

  test("Furniture: 9 plan views", () => {
    expect(byView("Furniture", "plan").length).toBe(9);
  });

  test("Plumbing: 5 plan views", () => {
    expect(byView("Plumbing", "plan").length).toBe(5);
  });

  test("Vegetation: 3 plan views", () => {
    expect(byView("Vegetation", "plan").length).toBe(3);
  });

  test("Appliances: 5 plan views", () => {
    expect(byView("Appliances", "plan").length).toBe(5);
  });

  test("all required categories present", () => {
    const cats = new Set(BLOCK_CATALOG.map(b => b.category));
    expect(cats.has("Doors")).toBe(true);
    expect(cats.has("Windows")).toBe(true);
    expect(cats.has("Furniture")).toBe(true);
    expect(cats.has("Plumbing")).toBe(true);
    expect(cats.has("Vegetation")).toBe(true);
    expect(cats.has("Appliances")).toBe(true);
  });
});

// ── Specific block entries (AC #5: path convention) ──────────────────────────

describe("specific block entries", () => {
  test("single-swing door plan entry exists", () => {
    const e = getBlockEntry("doors/plan/single-swing");
    expect(e).toBeDefined();
    expect(e!.view).toBe("plan");
    expect(e!.category).toBe("Doors");
  });

  test("fixed window plan entry exists", () => {
    const e = getBlockEntry("windows/plan/fixed");
    expect(e).toBeDefined();
    expect(e!.view).toBe("plan");
    expect(e!.path).toBe("windows/plan/fixed.svg");
  });

  test("fixed-medium window elevation entry exists", () => {
    const e = getBlockEntry("windows/elevation/fixed-medium");
    expect(e).toBeDefined();
    expect(e!.view).toBe("elevation");
  });

  test("casement-head window section entry exists", () => {
    const e = getBlockEntry("windows/section/casement-head");
    expect(e).toBeDefined();
    expect(e!.view).toBe("section");
    expect(e!.category).toBe("Windows");
  });

  test("toilet plan entry exists", () => {
    const e = getBlockEntry("plumbing/plan/toilet");
    expect(e).toBeDefined();
    expect(e!.category).toBe("Plumbing");
  });

  test("sofa furniture plan entry exists", () => {
    const e = getBlockEntry("furniture/plan/sofa");
    expect(e).toBeDefined();
    expect(e!.category).toBe("Furniture");
  });

  test("deciduous tree vegetation entry exists", () => {
    expect(getBlockEntry("vegetation/plan/tree-deciduous")).toBeDefined();
  });

  test("refrigerator appliance entry exists", () => {
    expect(getBlockEntry("appliances/plan/refrigerator")).toBeDefined();
  });

  test("getBlockEntry returns undefined for unknown id", () => {
    expect(getBlockEntry("bogus/nothing")).toBeUndefined();
  });
});

// ── Path convention: <category>/<view>/<name>.svg ────────────────────────────

describe("block path convention", () => {
  test("all paths are <category>/<view>/<name>.svg", () => {
    for (const b of BLOCK_CATALOG) {
      const parts = b.path.split("/");
      expect(parts.length).toBe(3);
      expect(parts[2].endsWith(".svg")).toBe(true);
    }
  });

  test("path category matches entry category (lower-cased)", () => {
    for (const b of BLOCK_CATALOG) {
      const pathCat = b.path.split("/")[0];
      const entryCat = b.category.toLowerCase();
      expect(pathCat).toBe(entryCat);
    }
  });

  test("path view matches entry view", () => {
    for (const b of BLOCK_CATALOG) {
      const pathView = b.path.split("/")[1];
      expect(pathView).toBe(b.view);
    }
  });
});

// ── Selected block state ─────────────────────────────────────────────────────

describe("getSelectedBlockId / setSelectedBlockId", () => {
  test("initial value is null after reset", () => {
    setSelectedBlockId(null);
    expect(getSelectedBlockId()).toBeNull();
  });

  test("setSelectedBlockId stores id", () => {
    setSelectedBlockId("doors/plan/single-swing");
    expect(getSelectedBlockId()).toBe("doors/plan/single-swing");
    setSelectedBlockId(null);
  });

  test("setSelectedBlockId(null) clears", () => {
    setSelectedBlockId("furniture/plan/sofa");
    setSelectedBlockId(null);
    expect(getSelectedBlockId()).toBeNull();
  });
});

// ── Block entry type structure ───────────────────────────────────────────────

describe("BlockEntry type structure", () => {
  test("every entry has id, category, subcategory, label, path, view", () => {
    const required: (keyof BlockEntry)[] = ["id", "category", "subcategory", "label", "path", "view"];
    for (const b of BLOCK_CATALOG) {
      for (const k of required) {
        expect(b[k]).toBeDefined();
      }
    }
  });

  test("id is the canonical block identifier (no .svg suffix)", () => {
    for (const b of BLOCK_CATALOG) {
      expect(b.id.endsWith(".svg")).toBe(false);
    }
  });
});
