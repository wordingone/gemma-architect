// dictionary.test.ts — verify the spatial dictionary loads, indexes, and
// resolves aliases. Per plan §T5 verification table.

import { describe, expect, test, beforeEach } from "bun:test";
import {
  getDictionary,
  getAliasIndex,
  getHotkeyIndex,
  resolveAlias,
  getEntry,
  clearDictionaryCache,
  type SpatialDictionaryEntry,
} from "../src/commands/dictionary";

const REQUIRED_FIELDS: Array<keyof SpatialDictionaryEntry> = [
  "name",
  "kernel_op",
  "topology_role",
  "kernel",
  "synonyms",
];

describe("Spatial Dictionary loader", () => {
  beforeEach(() => clearDictionaryCache());

  test("dictionary parses without throwing", () => {
    const dict = getDictionary();
    expect(Array.isArray(dict)).toBe(true);
    expect(dict.length).toBeGreaterThanOrEqual(50);
  });

  test("every entry has all required fields", () => {
    const dict = getDictionary();
    for (const entry of dict) {
      for (const field of REQUIRED_FIELDS) {
        expect(entry[field], `entry ${entry.name} missing ${field}`).toBeDefined();
      }
      expect(entry.synonyms.length).toBeGreaterThan(0);
    }
  });

  test("canonical names are unique", () => {
    const dict = getDictionary();
    const seen = new Set<string>();
    for (const entry of dict) {
      expect(seen.has(entry.name), `duplicate canonical: ${entry.name}`).toBe(false);
      seen.add(entry.name);
    }
  });

  test("alias index covers every synonym of every entry", () => {
    // Note: synonyms can be shared across entries (e.g., "measure" may be
    // both a sketch dimension verb and an analysis verb); the index is
    // last-wins. We only assert that every synonym resolves to SOME
    // canonical, not that it resolves back to its parent entry.
    const dict = getDictionary();
    const idx = getAliasIndex();
    const validNames = new Set(dict.map((e) => e.name));
    for (const entry of dict) {
      for (const syn of entry.synonyms) {
        const resolved = idx.get(syn.toLowerCase());
        expect(
          resolved,
          `synonym "${syn}" of ${entry.name} not in alias index`
        ).toBeDefined();
        expect(
          resolved && validNames.has(resolved),
          `synonym "${syn}" → "${resolved}" which is not a known name`
        ).toBe(true);
      }
    }
  });

  test("resolveAlias is case-insensitive and returns canonical", () => {
    expect(resolveAlias("wall")).toBeDefined();
    expect(resolveAlias("WALL")).toBe(resolveAlias("wall"));
    expect(resolveAlias("Wall")).toBe(resolveAlias("wall"));
  });

  test("resolveAlias returns falsy for unknown synonym", () => {
    expect(resolveAlias("__definitely_not_a_real_verb__")).toBeFalsy();
  });

  test("getEntry returns the canonical entry", () => {
    const wallCanonical = resolveAlias("wall");
    expect(wallCanonical).toBeDefined();
    if (wallCanonical) {
      const entry = getEntry(wallCanonical);
      expect(entry).toBeDefined();
      expect(entry?.name).toBe(wallCanonical);
    }
  });

  test("hotkey index points each hotkey to a canonical entry", () => {
    const dict = getDictionary();
    const hkIdx = getHotkeyIndex();
    for (const [hotkey, canonical] of hkIdx.entries()) {
      const entry = dict.find((e) => e.name === canonical);
      expect(entry, `hotkey ${hotkey} → ${canonical} but no such canonical`).toBeDefined();
    }
  });

  test("kernel field is one of the known kernels", () => {
    const dict = getDictionary();
    const allowed = new Set(["replicad", "nurbs-webgpu", "drafting"]);
    for (const entry of dict) {
      expect(
        allowed.has(entry.kernel),
        `entry ${entry.name} has unknown kernel: ${entry.kernel}`
      ).toBe(true);
    }
  });

  test("topology_role is one of the known roles", () => {
    const dict = getDictionary();
    const allowed = new Set(["host", "hosted", "void", "face", "edge", "solid", "vertex", "curve", "annotation", "view", "selection", "io", "compound", "group", "transform", "system"]);
    for (const entry of dict) {
      expect(
        allowed.has(entry.topology_role),
        `entry ${entry.name} has unknown topology_role: ${entry.topology_role}`
      ).toBe(true);
    }
  });

  test("at least one architectural IFC entity is present (smoke)", () => {
    const dict = getDictionary();
    const hasWall = dict.some((e) => e.name === "IfcWall" || e.ifc4_class === "IfcWall");
    const hasSlab = dict.some((e) => e.name === "IfcSlab" || e.ifc4_class === "IfcSlab");
    expect(hasWall, "no IfcWall entry").toBe(true);
    expect(hasSlab, "no IfcSlab entry").toBe(true);
  });

  test("at least one boolean op is present (union/difference/intersection)", () => {
    const dict = getDictionary();
    const ops = dict.map((e) => e.name.toLowerCase());
    expect(
      ops.some((n) => /union|fuse/i.test(n)),
      "no boolean union op"
    ).toBe(true);
    expect(
      ops.some((n) => /diff|cut|sub/i.test(n)),
      "no boolean diff op"
    ).toBe(true);
  });
});
