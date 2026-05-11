#!/usr/bin/env node
// Verifies that each surface block in gemma-verify-raw.mjs has balanced { }.
// Also runs node --check for a global parse-error pass.
// Exits 1 on any imbalance.

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const TARGET = resolve(__dir, 'gemma-verify-raw.mjs');

// ── Pass 1: node --check (catches outright parse errors) ─────────────────────
try {
  execFileSync(process.execPath, ['--check', TARGET], { stdio: 'pipe' });
} catch (e) {
  const msg = e.stderr?.toString() ?? e.message;
  console.error(`SYNTAX ERROR (node --check):\n${msg}`);
  process.exit(1);
}

// ── Pass 2: running depth at each surface boundary must be constant ───────────
// The surfaces all live inside a single outer block (depth=1 expected).
// If Surface N's closing } is dropped, Surface N+1's boundary will be at
// depth=2 instead of 1 — caught immediately.

const src = readFileSync(TARGET, 'utf8');
const lines = src.split('\n');
const SURFACE_RE = /^\/\/ ── Surface /;

// Parse brace depth through the file, recording depth at each surface boundary.
// inStr/inBlockComment persist across line boundaries (template literals span lines).
let depth = 0;
let inStr = null;       // null | '"' | "'" | '`'
let inBlockComment = false;
const boundaries = [];  // [{lineNo, depth, label}]

for (let ln = 0; ln < lines.length; ln++) {
  const line = lines[ln];

  // Record depth BEFORE processing this line's characters.
  if (SURFACE_RE.test(line)) {
    boundaries.push({ lineNo: ln + 1, depth, label: line.replace(/^\/\/ ── /, '').replace(/ ─+$/, '').trim() });
  }

  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];
    const next = i + 1 < n ? line[i + 1] : '';

    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; }
      else i++;
      continue;
    }

    if (inStr !== null) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }

    // Line comment — stop processing this line.
    if (ch === '/' && next === '/') break;
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }

    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }

    if (ch === '{') depth++;
    else if (ch === '}') depth--;

    i++;
  }

  // Single-quoted and double-quoted strings cannot span lines in JS.
  // If we reach EOL still inside one, the file is malformed; reset to be safe.
  if (inStr === '"' || inStr === "'") inStr = null;
  // Template literals CAN span lines — do NOT reset inStr for '`'.
}

// ── Analysis ──────────────────────────────────────────────────────────────────
if (boundaries.length === 0) {
  console.error('No surface boundaries found — is the target file correct?');
  process.exit(1);
}

// All surface boundaries should be at the same depth.
const expectedDepth = boundaries[0].depth;
const violations = boundaries.filter(b => b.depth !== expectedDepth);

if (violations.length > 0) {
  console.error('BRACE BALANCE VIOLATIONS in gemma-verify-raw.mjs:');
  console.error(`  Expected all surface boundaries at depth=${expectedDepth}`);
  for (const v of violations) {
    const delta = v.depth - expectedDepth;
    console.error(`  L${v.lineNo}: ${v.label} — depth=${v.depth} (delta ${delta > 0 ? '+' : ''}${delta}, likely missing ${delta > 0 ? 'closing' : 'opening'} brace in prior surface)`);
  }
  process.exit(1);
}

if (depth !== 0) {
  console.error(`GLOBAL BRACE IMBALANCE: file ends at depth=${depth} (expected 0)`);
  process.exit(1);
}

console.log(`OK: ${boundaries.length} surface boundaries all at depth=${expectedDepth}, file ends at depth=0`);
