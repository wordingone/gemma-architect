// T16 — research mode acceptance tests.
//
// Bun-test against the pure scoring math in `research-index.ts`. We
// avoid the Vite-bundled `?raw` corpus loader here so the tests run
// in plain Node/Bun without needing the asset pipeline; the test
// builds its own in-memory corpus that matches the shape of the
// production corpus (`web/research-corpus/*.md`).

import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildResearchIndex,
  queryResearch,
  createCitationTracker,
  type CorpusEntry,
} from "../src/research/research-index";

// Build a corpus that mirrors the shipped research-corpus/ markdown.
// Uses readFileSync so any drift between the shipped fixtures and the
// test surface is caught (instead of duplicating the markdown inline).
function loadFixtureCorpus(): CorpusEntry[] {
  const corpusDir = join(__dirname, "..", "research-corpus");
  const files = [
    "wall-thickness.md",
    "ifc4-schema-basics.md",
    "gable-roof.md",
    "daylight-calc.md",
    "building-codes-101.md",
  ];
  const local: CorpusEntry[] = files.map((f) => ({
    name: f,
    kind: "local",
    source: "LOCAL · research-corpus/",
    body: readFileSync(join(corpusDir, f), "utf8"),
  }));
  // One inline web fixture so the LOCAL/WEB filter test has both kinds.
  const web: CorpusEntry[] = [
    {
      name: "ashrae-fixture.web",
      kind: "web",
      source: "WEB · ashrae.org",
      body: "# ASHRAE 90.1 envelope\n\nGable roof envelope U-factor for climate zone 4 mass walls is U <= 0.090.",
    },
  ];
  return [...local, ...web];
}

test("search returns top 3 ranked results", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  const results = queryResearch(idx, "wall thickness conventions");
  expect(results.length).toBeGreaterThanOrEqual(3);
  // The top result must be the wall-thickness doc.
  expect(results[0].name).toMatch(/wall.thickness/i);
});

test("citation tracker appends a triple", () => {
  const tracker = createCitationTracker();
  tracker.cite({
    source: "wall-thickness.md",
    line: 42,
    claim: "minimum 100mm for partition walls",
  });
  expect(tracker.list().length).toBe(1);
  expect(tracker.list()[0].source).toBe("wall-thickness.md");
});

test("LOCAL filter excludes web sources", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  const results = queryResearch(idx, "gable roof", { source: "local" });
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(r.kind).toBe("local");
  }
});

test("WEB filter excludes local sources", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  const results = queryResearch(idx, "envelope U-factor", { source: "web" });
  expect(results.length).toBeGreaterThan(0);
  for (const r of results) {
    expect(r.kind).toBe("web");
  }
});

test("CITE filter (restrictTo) only returns previously cited docs", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  const tracker = createCitationTracker();
  tracker.cite({ source: "gable-roof.md", line: 1, claim: "gable" });
  const restrictTo = tracker.citedSources();
  const results = queryResearch(idx, "wall", { restrictTo });
  for (const r of results) {
    expect(restrictTo.has(r.name)).toBe(true);
  }
});

test("scoring is deterministic and self-similarity is highest", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  // Query that is essentially the wall-thickness doc title — top result
  // should be far ahead of others.
  const results = queryResearch(idx, "wall thickness conventions partition load-bearing exterior");
  expect(results[0].name).toBe("wall-thickness.md");
  if (results.length > 1) {
    // The top hit should be measurably better than the second.
    expect(results[0].score).toBeGreaterThan(results[1].score);
  }
});

test("snippet has a real line number into the source doc", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  const results = queryResearch(idx, "partition walls plumbing");
  expect(results.length).toBeGreaterThan(0);
  const top = results[0];
  expect(top.line).toBeGreaterThan(0);
  expect(top.snippet.length).toBeGreaterThan(0);
});

test("citation tracker exportJSON produces parseable JSON array", () => {
  const tracker = createCitationTracker();
  tracker.cite({ source: "a.md", line: 1, claim: "x" });
  tracker.cite({ source: "b.md", line: 2, claim: "y" });
  const out = tracker.exportJSON();
  const parsed = JSON.parse(out);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed.length).toBe(2);
  expect(parsed[0].source).toBe("a.md");
  expect(parsed[1].line).toBe(2);
});

test("empty query yields empty results", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  expect(queryResearch(idx, "").length).toBe(0);
  expect(queryResearch(idx, "    ").length).toBe(0);
});

test("query terms with no corpus matches return empty", async () => {
  const idx = await buildResearchIndex(loadFixtureCorpus());
  // Made-up word that won't appear anywhere.
  const results = queryResearch(idx, "xqzplotz");
  expect(results.length).toBe(0);
});
