#!/usr/bin/env bun
// audit-undo-coverage.ts — exits non-zero if raw scene.add / scene.remove calls
// exist in production source outside of the sanctioned wrappers (#850).
//
// Sanctioned patterns:
//   - Files in ALLOWLIST (visual overlays, clip-fill, gizmo lines — transient objects
//     that are shown during an action and never enter the undo stack by design).
//   - Lines with an `// audit-undo-ok` inline comment (escape hatch for justified bypasses
//     in otherwise-audited files; must accompany a code comment explaining why).
//
// Everything else must use viewer.addMesh / viewer.removeObject /
// pushReplaceAction / pushDeleteAction / history.ts wrappers.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../web/src", import.meta.url).pathname.replace(/^\/([A-Za-z]):/, "$1:");

// Files whose scene.add/remove calls are entirely transient (preview objects,
// visual helpers, gizmo lines). These never persist after the action completes
// so they need no undo coverage.
const ALLOWLIST = new Set([
  // Undo implementation — adds/removes during revert/replay.
  "history.ts",
  // Canonical add/remove wrappers — the call sites we're protecting.
  "viewer/viewer.ts",
  // Visual overlays — transient objects, zero undo-stack surface.
  "viewer/transforms.ts",       // gizmo preview lines + TransformControls
  "viewer/op-tool.ts",          // operation preview mesh + gizmo lines
  "viewer/sub-object-handles.ts", // face/edge handle meshes
  "viewer/clip-fill.ts",        // stencil fill helpers (internal renderer state)
  "viewer/cplane-gizmo.ts",     // construction-plane gizmo
  "viewer/section-handles.ts",  // section-box handles
  // CSG intermediate helpers — managed by their own pushReplaceAction calls.
  "tools/join-groups.ts",
  // Sketch/tool preview markers — transient, cleaned up before action commits.
  "tools/index.ts",
]);

const PATTERNS = [
  /\bscene\.add\s*\(/,
  /\bscene\.remove\s*\(/,
  /\.getScene\(\)\s*\.add\s*\(/,
  /\.getScene\(\)\s*\.remove\s*\(/,
];

const SKIP_COMMENT = /\/\/\s*audit-undo-ok/;

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

let violations = 0;

for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (ALLOWLIST.has(rel)) continue;

  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("//")) continue; // comment-only line
    if (SKIP_COMMENT.test(line)) continue;           // inline escape
    for (const pat of PATTERNS) {
      if (pat.test(line)) {
        console.error(`VIOLATION  ${rel}:${i + 1}  ${line.trim()}`);
        violations++;
        break;
      }
    }
  }
}

if (violations === 0) {
  console.log("audit-undo-coverage: OK — no bypass paths found.");
  process.exit(0);
} else {
  console.error(`\naudit-undo-coverage: FAIL — ${violations} bypass path(s). Use viewer.addMesh / pushReplaceAction / pushDeleteAction, or add // audit-undo-ok with justification.`);
  process.exit(1);
}
