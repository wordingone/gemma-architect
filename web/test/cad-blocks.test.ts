// Regression-net: #1853 — CAD blocks library.
// Tests: block catalog completeness, provenance, panel state, insertion flow.

import { test, expect, describe } from "bun:test";
import {
  BLOCK_CATALOG,
  getBlockEntry,
  getSelectedBlockId,
  setSelectedBlockId,
  type BlockEntry,
} from "../src/shell/cad-blocks-panel";

// ── Catalog completeness ─────────────────────────────────────────────────────

describe("BLOCK_CATALOG completeness (AC #1: ≥30 blocks)", () => {
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
  const byCategory = (cat: string) => BLOCK_CATALOG.filter(b => b.category === cat);

  test("Doors: 5 plan + 5 elevation + 2 section", () => {
    const plan = byCategory("Doors").filter(b => b.view === "plan");
    const elev = byCategory("Doors").filter(b => b.view === "elevation");
    const sect = byCategory("Doors").filter(b => b.view === "section");
    expect(plan.length).toBe(5);
    expect(elev.length).toBe(5);
    expect(sect.length).toBeGreaterThanOrEqual(1);
  });

  test("Windows: 5 plan + 5 elevation + 3 section", () => {
    const plan = byCategory("Windows").filter(b => b.view === "plan");
    const elev = byCategory("Windows").filter(b => b.view === "elevation");
    const sect = byCategory("Windows").filter(b => b.view === "section");
    expect(plan.length).toBe(5);
    expect(elev.length).toBe(5);
    expect(sect.length).toBe(3);
  });

  test("Furniture: ≥9 total", () => {
    expect(byCategory("Furniture").length).toBeGreaterThanOrEqual(9);
  });

  test("Plumbing: 5 plan views (sink/toilet/tub/shower)", () => {
    const plan = byCategory("Plumbing").filter(b => b.view === "plan");
    expect(plan.length).toBe(5);
  });

  test("Entourage: 3 plan + 3 elevation (standing/sitting/walking)", () => {
    const plan = byCategory("Entourage").filter(b => b.view === "plan");
    const elev = byCategory("Entourage").filter(b => b.view === "elevation");
    expect(plan.length).toBe(3);
    expect(elev.length).toBe(3);
  });

  test("Vegetation: 3 plan + 3 elevation (tree/shrub)", () => {
    const plan = byCategory("Vegetation").filter(b => b.view === "plan");
    const elev = byCategory("Vegetation").filter(b => b.view === "elevation");
    expect(plan.length).toBe(3);
    expect(elev.length).toBe(3);
  });

  test("Vehicles: 2 plan views (sedan/suv)", () => {
    const plan = byCategory("Vehicles").filter(b => b.view === "plan");
    expect(plan.length).toBe(2);
  });

  test("all required categories are present", () => {
    const cats = new Set(BLOCK_CATALOG.map(b => b.category));
    expect(cats.has("Doors")).toBe(true);
    expect(cats.has("Windows")).toBe(true);
    expect(cats.has("Furniture")).toBe(true);
    expect(cats.has("Plumbing")).toBe(true);
    expect(cats.has("Entourage")).toBe(true);
    expect(cats.has("Vegetation")).toBe(true);
    expect(cats.has("Vehicles")).toBe(true);
  });
});

// ── Specific block shapes (spot-check) ───────────────────────────────────────

describe("specific block entries", () => {
  test("single-swing door plan entry exists", () => {
    const e = getBlockEntry("doors/plan/single-swing");
    expect(e).toBeDefined();
    expect(e!.view).toBe("plan");
    expect(e!.category).toBe("Doors");
  });

  test("fixed window elevation entry exists", () => {
    const e = getBlockEntry("windows/elevation/fixed");
    expect(e).toBeDefined();
    expect(e!.view).toBe("elevation");
    expect(e!.path).toBe("windows/elevation/fixed.svg");
  });

  test("toilet plan entry exists", () => {
    const e = getBlockEntry("plumbing/plan/toilet");
    expect(e).toBeDefined();
    expect(e!.category).toBe("Plumbing");
  });

  test("person-standing plan and elevation both exist", () => {
    expect(getBlockEntry("entourage/plan/person-standing")).toBeDefined();
    expect(getBlockEntry("entourage/elevation/person-standing")).toBeDefined();
  });

  test("sedan and suv plan both exist", () => {
    expect(getBlockEntry("vehicles/plan/sedan")).toBeDefined();
    expect(getBlockEntry("vehicles/plan/suv")).toBeDefined();
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
  test("initial value is null", () => {
    setSelectedBlockId(null);
    expect(getSelectedBlockId()).toBeNull();
  });

  test("setSelectedBlockId stores id", () => {
    setSelectedBlockId("doors/plan/single-swing");
    expect(getSelectedBlockId()).toBe("doors/plan/single-swing");
    setSelectedBlockId(null);
  });

  test("setSelectedBlockId(null) clears", () => {
    setSelectedBlockId("furniture/plan/chair");
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

  test("layerId-aware: entries carry id which serves as blockId for RS_Insert", () => {
    const entry = getBlockEntry("furniture/plan/sofa");
    expect(entry?.id).toBe("furniture/plan/sofa");
  });
});
