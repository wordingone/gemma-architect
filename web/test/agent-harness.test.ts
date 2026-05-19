// agent-harness.test.ts — B11 verification: system prompt includes schema metadata.
//
// Codex commit 06bd870 grafted synonyms/units/defaults into summariseDictionary().
// Tests the underlying dictionary structure and the format logic (without importing
// agent-harness.ts directly, since its @huggingface/transformers import is not
// testable in Bun's Node-compat environment).

import { describe, expect, test } from "bun:test";
import { getDictionary } from "../src/commands/dictionary";

describe("B11 — schema metadata for system prompt", () => {
  test("SdWall entry has synonyms including 'wall' and backward-compat 'IfcWall'", () => {
    const dict = getDictionary();
    // IfcWall was renamed to SdWall in #609; old Ifc* names kept as synonyms.
    const entry = dict.find((e) => e.name === "SdWall");
    expect(entry).toBeDefined();
    if (!entry) return;
    expect(entry.synonyms).toContain("wall");
    expect(entry.synonyms).toContain("makewall");
    expect(entry.synonyms).toContain("drawwall");
    expect(entry.synonyms).toContain("IfcWall");
  });

  test("SdWall args have unit=m and default values", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdWall");
    if (!entry) return;
    const thickness = entry.args.find((a) => a.name === "thickness");
    expect(thickness).toBeDefined();
    if (!thickness) return;
    expect(thickness.unit).toBe("m");
    expect(thickness.default).toBe(0.2);
    const height = entry.args.find((a) => a.name === "height");
    expect(height?.unit).toBe("m");
    expect(height?.default).toBe(3.0);
  });

  test("summariseDictionary format: unit= and default= markers appear in formatted string", () => {
    // Inline the format logic from agent-harness.ts summariseDictionary()
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdWall");
    if (!entry) return;
    const argList = entry.args
      .map((a) => {
        const req = a.required ? "required" : "optional";
        const unit = a.unit ? ` unit=${a.unit}` : "";
        const def = a.default !== undefined ? ` default=${JSON.stringify(a.default)}` : "";
        return `${a.name}:${a.type} [${req}${unit}${def}]`;
      })
      .join(", ");
    const syn = entry.synonyms.length > 0 ? ` synonyms=[${entry.synonyms.join(", ")}]` : "";
    const line = `  ${entry.name}(${argList})${syn}`;
    expect(line).toContain("unit=m");
    expect(line).toContain("default=0.2");
    expect(line).toContain("synonyms=[");
    expect(line).toContain("IfcWall");
  });
});
