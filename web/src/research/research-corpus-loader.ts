// Default fixture corpus — bundled markdown via Vite's `?raw` import.
// Kept separate from research-index.ts so the pure scoring math stays
// importable in Node-side tests without pulling .md asset transforms.
//
// Adding more docs: drop a *.md file under web/research-corpus/, add
// the import + entry below. For real web search, swap the WEB block
// for an adapter that hits a search API and indexes the response.

import type { CorpusEntry } from "./research-index";

import wallThicknessMd from "../../research-corpus/wall-thickness.md?raw";
import ifc4Md from "../../research-corpus/ifc4-schema-basics.md?raw";
import gableRoofMd from "../../research-corpus/gable-roof.md?raw";
import daylightMd from "../../research-corpus/daylight-calc.md?raw";
import buildingCodesMd from "../../research-corpus/building-codes-101.md?raw";

export function defaultCorpus(): CorpusEntry[] {
  const local: CorpusEntry[] = [
    {
      name: "wall-thickness.md",
      kind: "local",
      source: "LOCAL · research-corpus/",
      body: wallThicknessMd,
    },
    {
      name: "ifc4-schema-basics.md",
      kind: "local",
      source: "LOCAL · research-corpus/",
      body: ifc4Md,
    },
    {
      name: "gable-roof.md",
      kind: "local",
      source: "LOCAL · research-corpus/",
      body: gableRoofMd,
    },
    {
      name: "daylight-calc.md",
      kind: "local",
      source: "LOCAL · research-corpus/",
      body: daylightMd,
    },
    {
      name: "building-codes-101.md",
      kind: "local",
      source: "LOCAL · research-corpus/",
      body: buildingCodesMd,
    },
  ];

  // WEB fixtures — small placeholder "results" indexed alongside locals
  // so the WEB filter pill has something to show. Real web search is
  // documented as future work in
  // `web/skills/research-from-prompt/SKILL.md`.
  const web: CorpusEntry[] = [
    {
      name: "ashrae-90.1-2022.web",
      kind: "web",
      source: "WEB · ashrae.org",
      body: [
        "# ASHRAE 90.1-2022 envelope summary",
        "",
        "Climate zone 4A opaque assemblies must meet U-factor and continuous",
        "insulation criteria of Table 5.5-4. Mass walls U <= 0.090. Vertical",
        "fenestration SHGC <= 0.36 for north-facing fixed glazing with PF < 0.5.",
        "",
        "(stub web result — replace with real search adapter; see SKILL.md)",
      ].join("\n"),
    },
    {
      name: "boston-zoning-art32.web",
      kind: "web",
      source: "WEB · boston.gov",
      body: [
        "# Boston Zoning Article 32 (R-1 residential)",
        "",
        "Front setback 20 ft, side 10 ft each, rear 25 ft when abutting",
        "residential. Height cap 35 ft without variance. FAR 0.5 baseline.",
        "",
        "(stub web result)",
      ].join("\n"),
    },
  ];

  return [...local, ...web];
}
