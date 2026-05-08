// gemma-architect skills loader — reads SKILL.md files under web/skills/,
// parses YAML frontmatter + body, and exposes a keyword-match index for
// the agent harness.
//
// Design intent (per #176-pipeline + T11):
//   - Skills are markdown so the LLM agent can read them verbatim.
//   - Each SKILL.md ships a JSON sidecar (skill.json) so toolchains and the
//     evaluator don't have to re-parse YAML.
//   - The loader runs once per session start; there is no hot-reload (the
//     skill set is bundled at build time, intentionally fixed for the
//     current LoRA / cache pair).
//
// Frontmatter parser is hand-rolled (no `gray-matter` dependency) and
// supports the limited subset T11 actually uses:
//   - scalar:        key: value
//   - inline list:   key: [a, b, "c with spaces"]
//   - block list:    key:
//                      - item1
//                      - item2
// Booleans/numbers stay as strings except for `examples_count` etc., which
// are read from the JSON sidecar (typed) — keeping the parser dumb is a
// deliberate scope limit.

// node:fs and node:path are used only inside loadSkills (Node.js / test context).
// They are imported dynamically so the module is safe to bundle for the browser,
// where loadSkills is never called.

export type Skill = {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  examples: string[];
  eval_id: string;
  body: string;
};

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

type Frontmatter = Record<string, string | string[]>;

const FENCE = "---";

function splitFrontmatter(source: string): { fm: string; body: string } {
  // Normalise CRLF; strip BOM if present.
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0] !== FENCE) {
    return { fm: "", body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === FENCE) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return { fm: "", body: text };
  }
  const fm = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  // Trim a single leading newline from the body for readability.
  return { fm, body: body.startsWith("\n") ? body.slice(1) : body };
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseInlineList(raw: string): string[] {
  // `[a, b, "c, with comma"]` — split on top-level commas only, respecting
  // single/double quoted segments. The skill metadata never embeds objects
  // inside lists, so this is sufficient.
  const inside = raw.trim().slice(1, -1);
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < inside.length; i++) {
    const ch = inside[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      const item = unquote(buf);
      if (item.length > 0) out.push(item);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = unquote(buf);
  if (tail.length > 0) out.push(tail);
  return out;
}

export function parseFrontmatter(fmText: string): Frontmatter {
  const out: Frontmatter = {};
  if (fmText.trim().length === 0) return out;
  const lines = fmText.split("\n");
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  const finishList = () => {
    if (currentKey !== null && currentList !== null) {
      out[currentKey] = currentList;
    }
    currentKey = null;
    currentList = null;
  };

  for (const rawLine of lines) {
    if (rawLine.trim().length === 0) continue;
    if (rawLine.trim().startsWith("#")) continue; // YAML comment

    // Block-list item: leading whitespace then `- ...`.
    const blockItem = rawLine.match(/^\s+-\s+(.*)$/);
    if (blockItem && currentList !== null) {
      currentList.push(unquote(blockItem[1]));
      continue;
    }

    // Otherwise we expect `key:` or `key: value` at column 0.
    const kv = rawLine.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) {
      // Unrecognised line — skip silently. Strict-mode would throw; we'd
      // rather degrade than block load on a typo'd skill.
      continue;
    }
    finishList(); // any prior block list is now closed.
    const key = kv[1];
    const valueRaw = kv[2];

    if (valueRaw.length === 0) {
      // `key:` on its own line → expect a block list to follow.
      currentKey = key;
      currentList = [];
      continue;
    }

    if (valueRaw.startsWith("[") && valueRaw.endsWith("]")) {
      out[key] = parseInlineList(valueRaw);
      continue;
    }

    out[key] = unquote(valueRaw);
  }
  finishList();
  return out;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function asString(value: string | string[] | undefined, key: string, where: string): string {
  if (typeof value !== "string") {
    throw new Error(`Skill ${where}: expected string for "${key}", got ${typeof value}`);
  }
  return value;
}

function asStringArray(
  value: string | string[] | undefined,
  key: string,
  where: string,
): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.length > 0) return [value];
  throw new Error(`Skill ${where}: expected list for "${key}"`);
}

export function parseSkill(source: string, where: string): Skill {
  const { fm, body } = splitFrontmatter(source);
  if (fm.trim().length === 0) {
    throw new Error(`Skill ${where}: missing YAML frontmatter`);
  }
  const meta = parseFrontmatter(fm);
  const skill: Skill = {
    name: asString(meta.name, "name", where),
    version: asString(meta.version, "version", where),
    description: asString(meta.description, "description", where),
    keywords: asStringArray(meta.keywords, "keywords", where),
    examples: asStringArray(meta.examples, "examples", where),
    eval_id: asString(meta.eval_id, "eval_id", where),
    body,
  };
  return skill;
}

// Default skills directory: resolved relative to THIS module so the loader
// works in worktrees, in `bun test`, and from the bundled web build (Vite
// import.meta.url is stable across builds).
function defaultSkillsDir(): string {
  return new URL("../skills/", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");
}

export async function loadSkills(skillsDir?: string): Promise<Skill[]> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const { readFile, readdir } = await import(/* @vite-ignore */ "node:fs/promises");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const { join } = await import(/* @vite-ignore */ "node:path");
  const dir = skillsDir ?? defaultSkillsDir();
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = join(dir, entry.name, "SKILL.md");
    let source: string;
    try {
      source = await readFile(skillMdPath, "utf8");
    } catch {
      // Directory without SKILL.md — skip. Lets us drop assets, fixtures,
      // README files alongside skills without breaking load.
      continue;
    }
    const skill = parseSkill(source, entry.name);
    if (skill.name !== entry.name) {
      throw new Error(
        `Skill ${entry.name}: frontmatter name "${skill.name}" does not match directory`,
      );
    }
    skills.push(skill);
  }
  // Stable order helps tests and snapshot diffs.
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// ---------------------------------------------------------------------------
// Prompt → skill matcher
// ---------------------------------------------------------------------------

const STOP = new Set([
  "a", "an", "the", "of", "to", "for", "by", "with", "and", "or", "in", "on",
  "at", "is", "be", "are", "from", "into", "onto", "as", "this", "that",
  "these", "those", "it", "its", "i", "we", "you", "make", "create", "build",
  "draw", "place", "add", "put", "set", "do", "use", "using", "please",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\w-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOP.has(t));
}

export function findSkillsForPrompt(skills: Skill[], prompt: string): Skill[] {
  const promptTokens = new Set(tokens(prompt));
  if (promptTokens.size === 0) return [];

  const scored: { skill: Skill; score: number }[] = [];
  for (const skill of skills) {
    let score = 0;
    for (const kw of skill.keywords) {
      // Each keyword may itself be multi-word ("polyline footprint"); count
      // a hit if any of its sub-tokens appear in the prompt. This matches
      // the LLM-side intuition: keywords are search hooks, not exact
      // phrases.
      const kwTokens = tokens(kw);
      const hit = kwTokens.some((t) => promptTokens.has(t));
      if (hit) score += 1;
    }
    if (score > 0) scored.push({ skill, score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.skill.name.localeCompare(b.skill.name);
  });
  return scored.map((s) => s.skill);
}
