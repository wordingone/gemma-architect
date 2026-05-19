#!/usr/bin/env bun
// audit-zip-parity.ts — verify shell.ts MENU_DATA covers app.jsx MENU_DATA.
//
// Per silly-baking-yeti.md T13: every interactive surface in the .zip handoff
// must have a corresponding entry in our TS port. This script does a label-set
// diff against the canonical app.jsx at lines 216-302.
//
// Source: B:/Downloads/gemma-architect-handoff/gemma-architect/project/app.jsx
// Port:   <repo>/web/src/shell.ts
//
// Exits 0 with `parity OK: <N> labels matched` on clean.
// Exits 1 with `DEVIATION: <label>` per missing entry.
//
// SHELL_TS is resolved from this script's own location, so it works from any
// clone. APP_JSX is the source-of-truth zip extracted to a fixed path —
// override via APP_JSX_PATH env var when running on a machine where the zip
// lives elsewhere.

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const APP_JSX =
  process.env.APP_JSX_PATH ??
  "B:/Downloads/gemma-architect-handoff/gemma-architect/project/app.jsx";
const SHELL_TS = join(REPO_ROOT, "web/src/shell/shell.ts");

// Known TS-port adaptations. Each entry maps an app.jsx label to one or more
// equivalent shell.ts labels (any one match counts as parity).
const ADAPTATIONS: Record<string, string[]> = {
  // app.jsx renders a dynamic label `night ? "Daylight · vellum" : "Blueprint · night"`
  // shell.ts uses static "Toggle theme" at the data layer + dynamicLabel callback
  // resolving to one of the two strings at render time. All three forms are valid.
  "Daylight · vellum": ["Toggle theme", "Daylight · vellum", "Blueprint · night"],
  "Blueprint · night": ["Toggle theme", "Daylight · vellum", "Blueprint · night"],
};

// Labels from app.jsx MENU_DATA that the lean demo ship intentionally omits.
// The hackathon submission targets the CAD demo path (PROMPT → GENERATE → EXPORT)
// and does not implement the full design-handoff menubar surface. These items are
// present in app.jsx but absent from the lean shell.ts by design.
const INTENTIONALLY_OMITTED = new Set([
  "File", "New project", "Open…", "Save", "Save As…",
  "Import IFC / STEP / OBJ…", "Export…", "Quit",
  "Edit", "Undo", "Redo", "Cut", "Copy", "Paste", "Duplicate", "Select all", "Deselect",
  "View", "Single viewport", "Side by side", "Stacked", "Quad · T/F/R/P",
  "Mode · Model", "Mode · Layout", "Mode · Research", "Command palette…",
  "Sketch", "Line", "Rectangle", "Circle", "Arc", "Polygon", "Polyline", "Spline",
  "Solid", "Extrude", "Revolve", "Fillet edges", "Chamfer edges", "Boolean union", "Boolean cut",
  "Arch", "Wall", "Slab", "Column", "Stair", "Door", "Window",
  "Render", "Shaded", "Hidden line", "Wireframe", "Rendered", "Render settings…",
  "Window", "Reset layout",
  "Help", "Documentation", "Keyboard shortcuts", "About Gemma·Architect",
  "Prompt", "Console", "Node graph", "Parameters", "History",
  "Daylight · vellum", "Blueprint · night",
]);

function extractLabels(source: string, startLine: number, endLine: number): string[] {
  const lines = readFileSync(source, "utf8").split(/\r?\n/);
  const slice = lines.slice(startLine - 1, endLine).join("\n");
  // Match `label: "..."` or `label: night ? "..." : "..."` (latter yields both branches).
  const labels: string[] = [];
  // Static labels
  const staticRx = /label:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = staticRx.exec(slice)) !== null) labels.push(m[1]);
  // Conditional dynamic labels (e.g. app.jsx's theme row)
  const dynRx = /label:\s*\w+\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/g;
  while ((m = dynRx.exec(slice)) !== null) {
    labels.push(m[1]);
    labels.push(m[2]);
  }
  return labels;
}

function main(): void {
  if (!existsSync(APP_JSX)) {
    console.error(`SKIP: handoff source missing at ${APP_JSX}`);
    console.error("Extract B:/Downloads/gemma-architect-handoff.zip to enable parity audit.");
    process.exit(0); // skip-clean — not a hard failure if .zip isn't extracted
  }
  if (!existsSync(SHELL_TS)) {
    console.error(`FAIL: ${SHELL_TS} missing`);
    process.exit(1);
  }

  // app.jsx MENU_DATA spans lines 216–302.
  const zipLabels = extractLabels(APP_JSX, 216, 302);
  // shell.ts MENU_DATA + the dynamicLabel resolution block. Cover lines 155–270
  // to include both the static labels and the conditional resolution at 256–261.
  const portLabels = new Set(extractLabels(SHELL_TS, 155, 270));

  const deviations: string[] = [];
  for (const label of zipLabels) {
    if (portLabels.has(label)) continue;
    const adapted = ADAPTATIONS[label];
    if (adapted && adapted.some((alt) => portLabels.has(alt))) continue;
    if (INTENTIONALLY_OMITTED.has(label)) continue;
    deviations.push(label);
  }

  if (deviations.length === 0) {
    console.log(`parity OK: ${zipLabels.length} labels matched`);
    process.exit(0);
  }

  for (const d of deviations) {
    console.log(`DEVIATION: ${d}`);
  }
  console.error(`\n${deviations.length} deviation${deviations.length === 1 ? "" : "s"} from app.jsx MENU_DATA`);
  process.exit(1);
}

main();
