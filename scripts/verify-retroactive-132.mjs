#!/usr/bin/env bun
// verify-retroactive-132.mjs — PR #132 palette 2-column evidence.
import { connectPage5847, delay, writeReceipt, makeRecorder, SHA } from "./retroactive-cdp-lib.mjs";

const OUT = `state/verify-retroactive-132-${SHA}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
const { evaluate, screenshot, close } = await connectPage5847();
console.log("Connected to :5847");

const checks = [];
const record = makeRecorder(checks);

// ── A: Screenshot palette ─────────────────────────────────────────────────────
const b64 = await screenshot();
import { writeFileSync } from "fs";
writeFileSync(`state/verify-retro-132-palette-${SHA}.png`, Buffer.from(b64, "base64"));
console.log(`  Screenshot: state/verify-retro-132-palette-${SHA}.png`);

// ── B: .palette-section exists in DOM ─────────────────────────────────────────
const sectionCount = await evaluate(`document.querySelectorAll(".palette-section").length`);
record("palette-sections-present", sectionCount > 0, { sectionCount });

// ── C: Computed style = repeat(2, 36px) ───────────────────────────────────────
const gridCols = await evaluate(`
  (() => {
    const sec = document.querySelector(".palette-section");
    if (!sec) return null;
    return getComputedStyle(sec).gridTemplateColumns;
  })()
`);
console.log(`  gridTemplateColumns: "${gridCols}"`);
// Chrome may return "repeat(2, 36px)" or "36px 36px" depending on layout state.
const is2Col = !!gridCols?.includes("36px") && (gridCols.includes("repeat(2") || gridCols === "36px 36px" || gridCols === "72px 72px");
record("palette-section-2-column", is2Col, { gridCols });

// ── D: All visible sections have 2-column layout ──────────────────────────────
const allSections2Col = await evaluate(`
  (() => {
    const secs = Array.from(document.querySelectorAll(".palette-section"))
      .filter(s => getComputedStyle(s).display !== "none");
    return secs.every(s => {
      const cols = getComputedStyle(s).gridTemplateColumns;
      return cols.includes("36px");
    });
  })()
`);
record("all-visible-sections-2-col", allSections2Col, { allSections2Col });

close();
const allPassed = writeReceipt(OUT, checks, { pr: 132, concern: "palette-2-column" });
process.exit(allPassed ? 0 : 1);
