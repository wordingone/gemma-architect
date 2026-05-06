#!/usr/bin/env bun
// audit-stubs.ts — scan web/src for stub UI handlers.
//
// Per silly-baking-yeti.md T13: zero stubs is part of plan retirement criteria.
// Detects categories of "dead UI" that ship as visible-but-inert handlers
// (alert("not implemented"), TODO comments, throw-stubs, etc.).
//
// Does NOT verify dispatch routing — handlers that exist but route to the
// wrong sink (e.g. setState instead of dispatch) pass this audit. See
// scripts/audit-dispatch-routing.ts for that class of regression.
//
// Exits 0 with stdout `0 stubs` on clean.
// Exits 1 with each violation on its own line: `<file>:<line>: <category> — <snippet>`.

import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";

// Paths resolved from the script location so the audit works from any clone
// (regardless of where the repo lives on disk). Run from the repo root:
//   bun scripts/audit-stubs.ts
const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOT = join(REPO_ROOT, "web/src");
const REPORT_ROOT = REPO_ROOT;

type Violation = { file: string; line: number; category: string; snippet: string };

const PATTERNS: { rx: RegExp; cat: string }[] = [
  { rx: /alert\([^)]*not\s+yet\s+implemented/i, cat: "alert-stub" },
  { rx: /alert\([^)]*not\s+implemented/i,        cat: "alert-stub" },
  { rx: /alert\([^)]*\bTODO\b/i,                 cat: "alert-stub" },
  { rx: /\/\/\s*TODO\b/,                         cat: "todo-comment" },
  { rx: /\/\/\s*FIXME\b/,                        cat: "fixme-comment" },
  { rx: /\/\/\s*stub\b/i,                        cat: "stub-comment" },
  { rx: /throw\s+new\s+Error\(['"`].*?(TODO|stub|not\s+implemented)/i, cat: "throw-stub" },
  { rx: /console\.(log|warn|error)\(['"`].*?(TODO|stub|not\s+implemented)/i, cat: "console-stub" },
  { rx: /=>\s*\{\s*\/\*\s*(TODO|stub)/i,         cat: "empty-handler-comment" },
];

const EXCLUDE_FILES = new Set([
  "spatial-api.LICENSE.md",
  "nurbs-kernel.LICENSE.md",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    if (ent.startsWith(".")) continue;
    const full = join(dir, ent);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx|html)$/.test(ent) && !EXCLUDE_FILES.has(ent)) out.push(full);
  }
  return out;
}

function scanFile(file: string): Violation[] {
  const rel = relative(REPORT_ROOT, file).replace(/\\/g, "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const found: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip our own audit script self-references and the patterns array.
    if (rel.endsWith("/audit-stubs.ts")) continue;
    for (const { rx, cat } of PATTERNS) {
      if (rx.test(line)) {
        found.push({ file: rel, line: i + 1, category: cat, snippet: line.trim().slice(0, 120) });
        break; // one violation per line, first match wins
      }
    }
  }
  return found;
}

function main(): void {
  const files = walk(ROOT);
  const violations: Violation[] = [];
  for (const f of files) violations.push(...scanFile(f));

  if (violations.length === 0) {
    console.log("0 stubs");
    process.exit(0);
  }

  for (const v of violations) {
    console.log(`${v.file}:${v.line}: ${v.category} — ${v.snippet}`);
  }
  console.error(`\n${violations.length} stub${violations.length === 1 ? "" : "s"} found`);
  process.exit(1);
}

main();
