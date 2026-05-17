import { test, expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSkills, findSkillsForPrompt, parseFrontmatter } from "../src/agent/skills-loader";

// Resolve relative to this test file so the run is worktree-portable
// (matches the same trick `scripts/test-ai-match.ts` uses).
const SKILLS_DIR = new URL("../skills/", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const SCHEMA_PATH = join(SKILLS_DIR, "skills.schema.json");

test("no built-in skills present (synthetic fixtures removed per #838)", async () => {
  const skills = await loadSkills(SKILLS_DIR);
  expect(skills.length).toBe(0);
  expect(skills.map((s) => s.name)).toEqual([]);
});

test("keyword match logic scores skills correctly", () => {
  // Test the matcher with inline mock skills so it exercises the scoring
  // algorithm without requiring built-in fixture files.
  const mockSkills = [
    { name: "extrude-walls", version: "1.0.0", description: "Extrudes polylines into walls", keywords: ["extrude", "wall", "polyline"], examples: ["extrude this", "wall from polyline"], eval_id: "e1", body: "## When to use\n## How it works\n## Examples\n## Failure modes" },
    { name: "mirror-across-axis", version: "1.0.0", description: "Mirrors objects across an axis", keywords: ["mirror", "axis", "reflect"], examples: ["mirror these", "reflect across"], eval_id: "e2", body: "## When to use\n## How it works\n## Examples\n## Failure modes" },
    { name: "place-doors", version: "1.0.0", description: "Places door objects in walls", keywords: ["door", "place", "opening"], examples: ["place a door", "add door"], eval_id: "e3", body: "## When to use\n## How it works\n## Examples\n## Failure modes" },
  ];

  const matches = findSkillsForPrompt(mockSkills, "extrude this polyline into a wall");
  expect(matches.length).toBeGreaterThan(0);
  expect(matches[0].name).toBe("extrude-walls");

  const doorMatches = findSkillsForPrompt(mockSkills, "put a door at this clicked point");
  expect(doorMatches[0].name).toBe("place-doors");

  const mirrorMatches = findSkillsForPrompt(mockSkills, "mirror these walls across the X axis");
  expect(mirrorMatches[0].name).toBe("mirror-across-axis");

  // No match for irrelevant prompt.
  const noMatch = findSkillsForPrompt(mockSkills, "asdf qwerty zzz nothing relevant");
  expect(noMatch.length).toBe(0);
});

test("findSkillsForPrompt returns empty for irrelevant prompts", async () => {
  const skills = await loadSkills(SKILLS_DIR);
  const matches = findSkillsForPrompt(skills, "asdf qwerty zzz nothing relevant here");
  expect(matches.length).toBe(0);
});

test("skill.json directory is empty after synthetic fixture removal (#838)", async () => {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());
  expect(dirs.length).toBe(0);
});

test("skill.json keywords match SKILL.md frontmatter keywords", async () => {
  // Catch drift between the two metadata sources: any keyword in the JSON
  // sidecar must also appear in the markdown frontmatter, and vice versa.
  // (The JSON is the build-time index; the markdown is what the LLM reads.)
  const skills = await loadSkills(SKILLS_DIR);
  for (const s of skills) {
    const sidecarRaw = await readFile(join(SKILLS_DIR, s.name, "skill.json"), "utf8");
    const sidecar = JSON.parse(sidecarRaw) as { keywords: string[]; eval_id: string };
    const sortedSidecar = [...sidecar.keywords].sort();
    const sortedFm = [...s.keywords].sort();
    expect(sortedSidecar).toEqual(sortedFm);
    expect(sidecar.eval_id).toBe(s.eval_id);
  }
});

test("frontmatter parser handles inline lists, block lists, and quoted values", () => {
  const fm = parseFrontmatter(
    [
      "name: example",
      'description: "a value with: colons and \\"quotes\\""',
      "keywords: [a, b, c]",
      "examples:",
      '  - "first example"',
      "  - second example",
    ].join("\n"),
  );
  expect(fm.name).toBe("example");
  expect(fm.keywords).toEqual(["a", "b", "c"]);
  expect((fm.examples as string[]).length).toBe(2);
  expect((fm.examples as string[])[0]).toBe('first example');
});
