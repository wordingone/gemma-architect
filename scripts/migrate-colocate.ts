#!/usr/bin/env bun
/**
 * migrate-colocate.ts — Option B co-location migration.
 *
 * Reads scripts/colocation-map.json and:
 *   1. Creates target directories
 *   2. git mv each TS file to its new location
 *   3. Rewrites import paths in ALL TS source + test files to reflect new locations
 *      — handles BOTH moving-target (target file moves) AND moving-importer
 *        (importer file moves, target is a static subdir like viewer/ commands/)
 *   4. git mv CSS files and updates web/src/style.css @import lines
 *
 * Usage:
 *   bun scripts/migrate-colocate.ts --dry-run   # print plan, touch nothing
 *   bun scripts/migrate-colocate.ts             # execute
 *
 * Verification oracle: bun run verify (tsc --noEmit) fails hard on broken paths.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, relative, resolve, extname } from "path";
import { execSync } from "child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

const map = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/colocation-map.json"), "utf8"));

type MoveEntry = { from: string; to: string; type: "ts" | "css" };
const moves: MoveEntry[] = map.moves;
const styleImportsAfter: string[] = map.style_css_imports_after;

// Build lookup: old abs path -> new abs path (TS only)
const tsMoveLookup = new Map<string, string>();
for (const m of moves) {
  if (m.type === "ts") {
    tsMoveLookup.set(resolve(REPO_ROOT, m.from), resolve(REPO_ROOT, m.to));
  }
}

// ---- helpers ----

function log(msg: string) { console.log(msg); }

function run(cmd: string) {
  if (DRY_RUN) {
    log(`  [dry] ${cmd}`);
  } else {
    execSync(cmd, { cwd: REPO_ROOT, stdio: "inherit" });
  }
}

function mkdirp(dir: string) {
  if (!existsSync(dir)) {
    if (DRY_RUN) { log(`  [dry] mkdir -p ${relative(REPO_ROOT, dir)}`); }
    else { mkdirSync(dir, { recursive: true }); }
  }
}

/**
 * Resolve an import specifier from importerOldDir to an absolute path.
 * Tries .ts extension first, then .js, then bare path.
 * Returns { absPath, extension } where extension is "" | ".js" | ".ts".
 */
function resolveSpecifier(
  specifier: string,
  importerOldDir: string
): { absPath: string; ext: string } | null {
  const stripped = specifier.replace(/\.(js|ts)$/, "");
  const originalExt = specifier.endsWith(".js") ? ".js" : specifier.endsWith(".ts") ? ".ts" : "";
  const base = resolve(importerOldDir, stripped);

  // Priority: tsMoveLookup first (works even if file was git mv'd away)
  for (const candidate of [base + ".ts", base + ".js", base]) {
    if (tsMoveLookup.has(candidate)) return { absPath: candidate, ext: originalExt };
  }
  // Then existsSync (for non-moving files that still exist)
  for (const candidate of [base + ".ts", base + ".js", base]) {
    if (existsSync(candidate)) return { absPath: candidate, ext: originalExt };
  }
  return null;
}

/**
 * Rewrite a single import specifier.
 *
 * importerOldAbs: where the importer USED to live (for resolving old target paths)
 * importerNewAbs: where the importer WILL live after migration (for computing new relative)
 *
 * Returns new specifier string, or null if no rewrite needed.
 */
function rewriteSpecifier(
  specifier: string,
  importerOldAbs: string,
  importerNewAbs: string
): string | null {
  if (!specifier.startsWith(".")) return null;

  const importerOldDir = dirname(importerOldAbs);
  const resolved = resolveSpecifier(specifier, importerOldDir);
  if (!resolved) return null;

  const oldTargetAbs = resolved.absPath;
  // New target: either moved location or same location if not moving
  const newTargetAbs = tsMoveLookup.get(oldTargetAbs) ?? oldTargetAbs;

  const importerMoved = importerOldAbs !== importerNewAbs;
  const targetMoved = newTargetAbs !== oldTargetAbs;

  // Only rewrite if something changed
  if (!importerMoved && !targetMoved) return null;

  const importerNewDir = dirname(importerNewAbs);
  let newRel = relative(importerNewDir, newTargetAbs).replace(/\\/g, "/");
  if (!newRel.startsWith(".")) newRel = "./" + newRel;

  // Preserve extension style from original specifier
  if (resolved.ext === ".js") {
    newRel = newRel.replace(/\.ts$/, ".js");
  } else if (resolved.ext === ".ts") {
    // keep .ts
  } else {
    newRel = newRel.replace(/\.ts$/, "");
  }

  return newRel === specifier ? null : newRel;
}

/**
 * Rewrite all relative import/export-from specifiers in a TS source string.
 */
function rewriteImports(
  source: string,
  importerOldAbs: string,
  importerNewAbs: string
): { rewritten: string; changed: boolean; replacements: string[] } {
  const replacements: string[] = [];
  // Match: from "..." / from '...' (static imports + re-exports)
  let rewritten = source.replace(/(\bfrom\s+)(["'])(\..*?)\2/g, (match, keyword, quote, specifier) => {
    const newSpec = rewriteSpecifier(specifier, importerOldAbs, importerNewAbs);
    if (newSpec === null) return match;
    replacements.push(`    ${specifier} -> ${newSpec}`);
    return `${keyword}${quote}${newSpec}${quote}`;
  });
  // Match: import("...") — inline dynamic imports and inline type imports
  rewritten = rewritten.replace(/(\bimport\s*\()(["'])(\..*?)\2(\s*\))/g, (match, prefix, quote, specifier, suffix) => {
    const newSpec = rewriteSpecifier(specifier, importerOldAbs, importerNewAbs);
    if (newSpec === null) return match;
    replacements.push(`    ${specifier} -> ${newSpec} [inline-import]`);
    return `${prefix}${quote}${newSpec}${quote}${suffix}`;
  });
  return { rewritten, changed: replacements.length > 0, replacements };
}

// ---- Collect all TS files with (old, new) path pairs ----
//
// In dry-run: files are at old locations; use tsMoveLookup to compute virtual new paths.
// In real execution: files are at new locations (after git mv); reverse lookup for old paths.

function collectFilePairs(): Array<{ fileOld: string; fileNew: string }> {
  const result: Array<{ fileOld: string; fileNew: string }> = [];

  function scanDir(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git"].includes(entry.name)) {
          scanDir(join(dir, entry.name));
        }
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        const fileAbs = join(dir, entry.name);
        if (DRY_RUN) {
          // File is at old location; look up new location
          const fileNew = tsMoveLookup.get(resolve(fileAbs)) ?? resolve(fileAbs);
          result.push({ fileOld: resolve(fileAbs), fileNew });
        } else {
          // File is at new location (after git mv); reverse lookup for old location
          let fileOld = resolve(fileAbs);
          for (const [oldAbs, newAbs] of tsMoveLookup) {
            if (newAbs === resolve(fileAbs)) { fileOld = oldAbs; break; }
          }
          result.push({ fileOld, fileNew: resolve(fileAbs) });
        }
      }
    }
  }

  scanDir(join(REPO_ROOT, "web/src"));
  scanDir(join(REPO_ROOT, "web/test"));
  return result;
}

// ---- Main ----

if (DRY_RUN) log("=== DRY RUN — nothing will be written ===\n");

// Step 1: Create target directories
log("Step 1: Create target directories");
const targetDirs = new Set<string>();
for (const m of moves) targetDirs.add(dirname(resolve(REPO_ROOT, m.to)));
for (const dir of targetDirs) mkdirp(dir);

// Step 2: git mv TS files
log("\nStep 2: git mv TS files");
for (const m of moves) {
  if (m.type !== "ts") continue;
  log(`  ${m.from} -> ${m.to}`);
  run(`git mv "${m.from}" "${m.to}"`);
}

// Step 3: Rewrite imports in all TS files
log("\nStep 3: Rewrite import paths in all TS files");
const filePairs = collectFilePairs();
let totalRewrites = 0;

for (const { fileOld, fileNew } of filePairs) {
  // In dry-run, read from old location; in real execution, read from new location
  const readPath = DRY_RUN ? fileOld : fileNew;
  if (!existsSync(readPath)) continue;

  const source = readFileSync(readPath, "utf8");
  const { rewritten, changed, replacements } = rewriteImports(source, fileOld, fileNew);

  if (changed) {
    const displayPath = relative(REPO_ROOT, fileNew).replace(/\\/g, "/");
    log(`  ${displayPath}: ${replacements.length} import(s) rewritten`);
    for (const r of replacements) log(r);
    if (!DRY_RUN) {
      writeFileSync(fileNew, rewritten, "utf8");
    }
    totalRewrites += replacements.length;
  }
}
log(`  Total imports rewritten: ${totalRewrites}`);

// Step 4: Move CSS files
log("\nStep 4: git mv CSS files");
for (const m of moves) {
  if (m.type !== "css") continue;
  log(`  ${m.from} -> ${m.to}`);
  run(`git mv "${m.from}" "${m.to}"`);
}

// Step 5: Update web/src/style.css @import lines
log("\nStep 5: Update web/src/style.css @import lines");
const styleCssPath = join(REPO_ROOT, "web/src/style.css");
const newStyleContent =
  "/* ============================================================\n" +
  "   GEMMA ARCHITECT — drafting-table aesthetic\n" +
  "   Hand-drafted on warm vellum. Graphite ink. Sanguine accent.\n" +
  "   ============================================================ */\n\n" +
  styleImportsAfter.join("\n") +
  "\n";

if (DRY_RUN) {
  log("  [dry] web/src/style.css new @imports:");
  for (const line of styleImportsAfter) log(`    ${line}`);
} else {
  writeFileSync(styleCssPath, newStyleContent, "utf8");
  log("  web/src/style.css updated");
}

// Summary
log(`\n${DRY_RUN ? "DRY RUN COMPLETE" : "MIGRATION COMPLETE"}`);
log(`  ${moves.filter(m => m.type === "ts").length} TS files moved`);
log(`  ${moves.filter(m => m.type === "css").length} CSS files moved`);
log(`  ${totalRewrites} import statements rewritten`);
if (!DRY_RUN) {
  log("\nNext: bun run verify  (tsc --noEmit catches any remaining broken paths)");
}
