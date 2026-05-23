#!/usr/bin/env bun
// lint-test-prompts.mjs — guard against metric dimension strings in user-facing inputs.
// Rule (2026-05-23): any string submitted to chat-input, runMultiAgent, agent.ask,
// __runIteration, or input.value MUST use imperial units only.
// Exit 0 = clean; exit 1 = violations found.
// Exempt: comment-only lines (// ...) and lines without string literal delimiters.

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// Code files that submit user-facing prompt strings to chat-input or agent.ask.
// (dataset/v2-spec.md is documentation — not code that submits to chat-input.)
const SCAN_TARGETS = [
  "scripts/gemma-verify-raw.mjs",
  "scripts/mtp-ab-tg.mjs",
  "scripts/haiku-rehearsal.mjs",
  "scripts/closed-loop-cad.ts",
  "scripts/dev-as-architect.ts",
  "web/test/coordination.test.ts",
  "web/test/agent-instance.test.ts",
];

// Match: digit(s) + optional decimal + 'm' not followed by a word char.
// Catches "5m", "0.2m", "2.5m" but not "metric", "method", "meters".
const METRIC_RE = /\b\d+(?:\.\d+)?m(?!\w)/;

let total = 0;

for (const rel of SCAN_TARGETS) {
  const abs = join(ROOT, rel);
  let src;
  try {
    src = readFileSync(abs, "utf-8");
  } catch {
    console.warn(`SKIP: ${rel} — not found`);
    continue;
  }

  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();
    // Skip comment-only lines
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    // Strip inline comments, then check for string delimiters
    const stripped = raw.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    if (!/["'`]/.test(stripped)) continue;
    if (!METRIC_RE.test(stripped)) continue;
    console.error(`FAIL  ${rel}:${i + 1}  ${raw.trim()}`);
    total++;
  }
}

if (total === 0) {
  console.log("lint:prompts OK — no metric strings in user-facing inputs");
  process.exit(0);
} else {
  console.error(`\nlint:prompts FAIL — ${total} metric string(s). Convert to imperial (feet/inches).`);
  process.exit(1);
}
