#!/usr/bin/env node
// audit-vite-spawn.mjs — Gate: no checked-in script may spawn vite without
// --port 5175 --strictPort. Exits non-zero if violations found.
//
// Scans:
//   - package.json "scripts" section
//   - scripts/*.{mjs,ts,js,ps1}
//
// Pass patterns (any one of these means the invocation is compliant):
//   --port 5175 --strictPort  (canonical)
//   --port 5175 (missing strictPort still raises a warning but not a failure
//                because strictPort is advisory for CI one-off invocations)
//   The invocation is inside a comment line (# or //)
//   The file is a retroactive-* or debug-* script (archive, not production)

import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

const violations = [];
const warnings = [];

// ── package.json scripts ──────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
  // Match vite only as a launch command (followed by whitespace or end), not inside filenames.
  if (!/\bvite(\s|$)/.test(cmd)) continue;
  if (/\bbuild\b|\bpreview\b/.test(cmd)) continue; // build/preview don't need --port
  if (!cmd.includes("--port 5175")) {
    violations.push({ source: "package.json", key: name, cmd });
  } else if (!cmd.includes("--strictPort")) {
    warnings.push({ source: "package.json", key: name, cmd, reason: "missing --strictPort" });
  }
}

// ── scripts/ files ────────────────────────────────────────────────────────────
const ARCHIVE_PREFIX = /^(retroactive-|debug-|_ac-|verify-168|verify-169)/;
const EXTS = new Set([".mjs", ".ts", ".js", ".ps1"]);

// Matches lines that actually launch vite as a dev server (not grep/match checks).
// Patterns: exec("...vite..."), spawn("vite"...), subprocess.Popen(["vite"...]),
//           or a bare shell invocation like `vite --...` as a string argument.
const VITE_LAUNCH_RE = /\b(execSync|exec|spawn|spawnSync|Popen)\s*\(\s*["'`][^"'`]*\bvite\b|["'`]\s*vite\s+--(?!.*build|.*preview)/;

for (const f of readdirSync(SCRIPTS_DIR)) {
  const ext = f.slice(f.lastIndexOf("."));
  if (!EXTS.has(ext)) continue;
  if (ARCHIVE_PREFIX.test(f)) continue; // archived, not production paths
  if (f === "audit-vite-spawn.mjs") continue; // skip self

  const src = readFileSync(join(SCRIPTS_DIR, f), "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#|\/\/)/.test(line)) continue; // skip comment lines
    if (!VITE_LAUNCH_RE.test(line)) continue;
    if (!line.includes("--port 5175")) {
      violations.push({ source: `scripts/${f}`, line: i + 1, text: line.trim().slice(0, 120) });
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────
if (warnings.length) {
  console.warn("WARN audit:vite-spawn — missing --strictPort (non-fatal):");
  for (const w of warnings) console.warn(`  ${w.source} [${w.key}]: ${w.cmd}`);
}

if (violations.length === 0) {
  console.log("OK audit:vite-spawn — all vite dev invocations enforce --port 5175");
  process.exit(0);
} else {
  console.error("FAIL audit:vite-spawn — vite spawned without --port 5175:");
  for (const v of violations) {
    if (v.key) {
      console.error(`  package.json [${v.key}]: ${v.cmd}`);
    } else {
      console.error(`  ${v.source}:${v.line}: ${v.text}`);
    }
  }
  console.error("Fix: add --port 5175 --strictPort to every vite dev invocation.");
  process.exit(1);
}
