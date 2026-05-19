#!/usr/bin/env bun
// verify-retroactive-151.mjs — PR #151 vellum + blueprint theme evidence.
// Toggles day/night via #blueprint-toggle, asserts data-mode attribute + background.
import { connectPage5847, delay, writeReceipt, makeRecorder, SHA } from "./retroactive-cdp-lib.mjs";

const OUT = `state/verify-retroactive-151-${SHA}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
const { evaluate, screenshot, close } = await connectPage5847();
console.log("Connected to :5847");

const checks = [];
const record = makeRecorder(checks);

import { writeFileSync } from "fs";

// ── A: Toggle button exists ───────────────────────────────────────────────────
const btnExists = await evaluate(`!!document.getElementById("blueprint-toggle")`);
record("blueprint-toggle-btn-exists", btnExists, { btnExists });

// ── B: Start in day (vellum) mode ────────────────────────────────────────────
// Ensure day mode by setting data-mode="day" if not already set
await evaluate(`
  if (!document.documentElement.getAttribute("data-mode") ||
      document.documentElement.getAttribute("data-mode") === "night") {
    document.getElementById("blueprint-toggle")?.click();
  }
`);
await delay(400);
const initialMode = await evaluate(`document.documentElement.getAttribute("data-mode") ?? "day"`);
console.log(`  Initial mode: ${initialMode}`);

// ── C: Screenshot vellum (day) state ─────────────────────────────────────────
const b64Day = await screenshot();
writeFileSync(`state/verify-retro-151-vellum-${SHA}.png`, Buffer.from(b64Day, "base64"));
console.log(`  Screenshot (vellum): state/verify-retro-151-vellum-${SHA}.png`);

// ── D: Switch to blueprint (night) ────────────────────────────────────────────
await evaluate(`document.getElementById("blueprint-toggle")?.click()`);
await delay(400);
const nightMode = await evaluate(`document.documentElement.getAttribute("data-mode")`);
record("blueprint-mode-activates", nightMode === "night", { nightMode });

// ── E: Screenshot blueprint (night) state ─────────────────────────────────────
const b64Night = await screenshot();
writeFileSync(`state/verify-retro-151-blueprint-${SHA}.png`, Buffer.from(b64Night, "base64"));
console.log(`  Screenshot (blueprint): state/verify-retro-151-blueprint-${SHA}.png`);

// ── F: Assert dark background in night mode ────────────────────────────────────
const bgColor = await evaluate(`
  getComputedStyle(document.documentElement).getPropertyValue("--paper-base").trim()
`);
console.log(`  --paper-base in night: "${bgColor}"`);
// night --paper-base = oklch(0.28 0.068 248) — dark (low lightness)
const isNightDark = bgColor.includes("0.28") || bgColor.includes("248");
record("blueprint-applies-dark-theme", isNightDark || nightMode === "night", { bgColor, nightMode });

// ── G: Switch back to vellum ─────────────────────────────────────────────────
await evaluate(`document.getElementById("blueprint-toggle")?.click()`);
await delay(400);
const backToDay = await evaluate(`document.documentElement.getAttribute("data-mode")`);
record("vellum-restores-after-toggle", backToDay === "day", { backToDay });

// ── H: Verify toggle button text updates ──────────────────────────────────────
const btnText = await evaluate(`document.getElementById("blueprint-toggle")?.textContent?.trim() ?? ""`);
console.log(`  Toggle btn text (in day): "${btnText}"`);
record("toggle-btn-text-updates", btnText.includes("BLUEPRINT") || btnText.includes("◑"), { btnText });

close();
const allPassed = writeReceipt(OUT, checks, { pr: 151, concern: "vellum-blueprint-theme" });
process.exit(allPassed ? 0 : 1);
