#!/usr/bin/env node
/**
 * lint-test-prompts.mjs — Imperial-prompt lint gate.
 *
 * Scans staged files for metric dimension strings inside user-input contexts
 * (STARTER_PROMPTS arrays, cdp.chat() calls, runIteration string args, etc.).
 * Internal numeric assertions in metres are fine; only user-facing prompt
 * strings must be imperial per the 2026-05-23 user directive.
 *
 * Exit 0 = clean. Exit 1 = violations found (blocks commit).
 */

import { execSync } from "child_process";
import { readFileSync } from "fs";

// Metric dimension patterns that are banned in user-input string contexts.
// Matches things like "5m wall", "6m wide", "10m long", "4m deep", "1.5m tall"
const METRIC_PATTERN = /\b\d+(\.\d+)?\s*m\s+(wall|wide|deep|long|tall|high|slab|floor|column|room|building|house|office|span|beam|rafter|roof|door|window|stair)/gi;

// Files + contexts to scan — only files likely to contain test prompts.
const PROMPT_FILE_PATTERNS = [
  /scripts\/gemma-verify.*\.mjs$/,
  /scripts\/phase-j-verify\.mjs$/,
  /scripts\/.*rehearsal.*\.mjs$/,
  /scripts\/.*loop.*\.ts$/,
  /scripts\/.*architect.*\.ts$/,
  /web\/test\/coordination\.test\.ts$/,
  /web\/test\/agent-instance\.test\.ts$/,
];

function getStagedFiles() {
  try {
    const out = execSync("git diff --cached --name-only --diff-filter=ACMR", {
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function isPromptFile(path) {
  return PROMPT_FILE_PATTERNS.some((re) => re.test(path));
}

// Extract string literals from source that are in user-input contexts.
// Heuristic: look for strings adjacent to STARTER_PROMPTS, runIteration,
// cdp chat, input.value =, or similar markers.
const CONTEXT_MARKERS =
  /STARTER_PROMPTS|runIteration|cdp(?:\.|\s+)chat|input\.value\s*=|\.chat\s*\(|chat\s*subcommand|prompt:\s*['"`]/;

function findViolations(filePath, source) {
  const lines = source.split("\n");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Check if this line or the surrounding context is a prompt context
    const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    if (!CONTEXT_MARKERS.test(window)) continue;

    // Look for metric strings inside string literals on this line
    const strMatches = line.match(/(['"`])[^'"`;]*\1/g) || [];
    for (const str of strMatches) {
      const m = str.match(METRIC_PATTERN);
      if (m) {
        violations.push({
          file: filePath,
          line: i + 1,
          text: line.trim().slice(0, 120),
          match: m[0],
        });
      }
    }
  }
  return violations;
}

const staged = getStagedFiles();
const promptFiles = staged.filter(isPromptFile);

let allViolations = [];

for (const f of promptFiles) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const v = findViolations(f, src);
  allViolations = allViolations.concat(v);
}

if (allViolations.length === 0) {
  process.exit(0);
}

console.error("\n❌ Imperial-prompt lint: metric dimension strings found in test prompt contexts.\n");
console.error(
  "Rule: user-input strings submitted via chat/CDP must use imperial units.\n"
);
for (const v of allViolations) {
  console.error(`  ${v.file}:${v.line}  [${v.match}]`);
  console.error(`    ${v.text}`);
}
console.error(
  "\nConvert to imperial (ft/in) or move the metric value to an internal assertion (not a prompt string).\n"
);
process.exit(1);
