import { test, expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadSkills, findSkillsForPrompt, parseFrontmatter } from "../src/agent/skills-loader";

// Resolve relative to this test file so the run is worktree-portable
// (matches the same trick `scripts/test-ai-match.ts` uses).
const SKILLS_DIR = new URL("../skills/", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
const SCHEMA_PATH = join(SKILLS_DIR, "skills.schema.json");

const EXPECTED_NAMES = [
  "align-to-grid",
  "dimension-chain",
  "extrude-walls",
  "fire-station",
  "hospitality-cabin",
  "mirror-across-axis",
  "office-25desk",
  "place-doors",
  "replicate-from-video",
  "research-from-prompt",
  "research-pavilion",
  "room-from-prompt",
  "sf-residence-2br",
  "stair-from-points",
];

test("all 14 skills load with valid frontmatter", async () => {
  const skills = await loadSkills(SKILLS_DIR);
  expect(skills.length).toBe(14);
  // loadSkills sorts by name — the asserted order matches.
  expect(skills.map((s) => s.name)).toEqual(EXPECTED_NAMES);
  for (const s of skills) {
    expect(s.name).toBeTruthy();
    expect(s.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(s.description.length).toBeGreaterThan(10);
    expect(s.keywords.length).toBeGreaterThan(0);
    expect(s.examples.length).toBeGreaterThanOrEqual(2);
    expect(s.eval_id.length).toBeGreaterThan(0);
    expect(s.body.length).toBeGreaterThan(50);
    // Body MUST contain the four section headings the agent reads at
    // dispatch time. Keeping these guarded prevents a "skill loaded but
    // contract drifted" silent regression.
    expect(s.body).toContain("## When to use");
    expect(s.body).toContain("## How it works");
    expect(s.body).toContain("## Examples");
    expect(s.body).toContain("## Failure modes");
  }
});

test("keyword match returns expected skill first", async () => {
  const skills = await loadSkills(SKILLS_DIR);
  const matches = findSkillsForPrompt(skills, "extrude this polyline into a wall");
  expect(matches.length).toBeGreaterThan(0);
  expect(matches[0].name).toBe("extrude-walls");

  // Spot-check a couple of other prompts to ensure the matcher isn't a
  // single-skill stub.
  const doorMatches = findSkillsForPrompt(skills, "put a door at this clicked point");
  expect(doorMatches[0].name).toBe("place-doors");

  const stairMatches = findSkillsForPrompt(skills, "make a staircase between these two points");
  expect(stairMatches[0].name).toBe("stair-from-points");

  const mirrorMatches = findSkillsForPrompt(skills, "mirror these walls across the X axis");
  // mirror-across-axis must outscore extrude-walls (which shares "wall")
  // because two of mirror's keywords ("mirror", "axis") hit.
  expect(mirrorMatches[0].name).toBe("mirror-across-axis");
});

test("findSkillsForPrompt returns empty for irrelevant prompts", async () => {
  const skills = await loadSkills(SKILLS_DIR);
  const matches = findSkillsForPrompt(skills, "asdf qwerty zzz nothing relevant here");
  expect(matches.length).toBe(0);
});

test("skill.json files validate against schema", async () => {
  // Hand-validate against the JSON schema — ajv is not in the deps tree
  // (the constraint is "DO NOT install new dependencies for parsing").
  const schemaText = await readFile(SCHEMA_PATH, "utf8");
  const schema = JSON.parse(schemaText) as {
    required: string[];
    properties: Record<string, { type?: string; pattern?: string; minimum?: number; minItems?: number }>;
  };

  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  const sidecars: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    sidecars.push(join(SKILLS_DIR, e.name, "skill.json"));
  }
  expect(sidecars.length).toBe(14);

  for (const sidecarPath of sidecars) {
    const raw = await readFile(sidecarPath, "utf8");
    const json: Record<string, unknown> = JSON.parse(raw);
    // Required keys.
    for (const key of schema.required) {
      expect(json).toHaveProperty(key);
    }
    // Type / pattern checks for the keys we care about.
    expect(typeof json.name).toBe("string");
    expect(typeof json.version).toBe("string");
    expect((json.version as string).match(/^\d+\.\d+\.\d+$/)).toBeTruthy();
    expect(typeof json.schema_version).toBe("number");
    expect(json.schema_version).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(json.keywords)).toBe(true);
    expect((json.keywords as string[]).length).toBeGreaterThan(0);
    expect(typeof json.examples_count).toBe("number");
    expect(json.examples_count).toBeGreaterThanOrEqual(1);
    expect(typeof json.eval_id).toBe("string");
    expect((json.eval_id as string).length).toBeGreaterThan(0);
  }
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
