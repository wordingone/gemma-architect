#!/usr/bin/env bun
// verify-retroactive-121.mjs — PR #121 cmdk dismiss evidence.
// Verifies: open cmdk → X button closes it; Esc key also closes it.
import { connectPage5175, delay, writeReceipt, makeRecorder, SHA } from "./retroactive-cdp-lib.mjs";

const OUT = `state/verify-retroactive-121-${SHA}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
const { evaluate, screenshot, close } = await connectPage5175();
console.log("Connected to :5175");

const checks = [];
const record = makeRecorder(checks);

// ── A: Open cmdk via ribbon button click ─────────────────────────────────────
const btnFound = await evaluate(`
  (() => {
    const btn = document.getElementById("ribbon-palette-btn");
    if (!btn) return false;
    btn.click();
    return true;
  })()
`);
await delay(500);

const overlayOpen = await evaluate(`!!document.querySelector(".cmdk-backdrop")`);
const panelOpen  = await evaluate(`!!document.querySelector(".cmdk")`);
record("cmdk-opens-on-button-click", (overlayOpen || panelOpen), { btnFound, overlayOpen, panelOpen });
console.log("  cmdk open state:", { btnFound, overlayOpen, panelOpen });

// ── B: Screenshot cmdk open state ────────────────────────────────────────────
const b64Open = await screenshot();
import { writeFileSync } from "fs";
writeFileSync(`state/verify-retro-121-open-${SHA}.png`, Buffer.from(b64Open, "base64"));
console.log(`  Screenshot (open): state/verify-retro-121-open-${SHA}.png`);

// ── C: Dismiss via X button ───────────────────────────────────────────────────
const dismissClicked = await evaluate(`
  (() => {
    const btn = document.querySelector(".cmdk-close");
    if (btn) { btn.click(); return "clicked"; }
    return "no-close-btn";
  })()
`);
await delay(400);
const overlayClosed = await evaluate(`!document.querySelector(".cmdk-backdrop") && !document.querySelector(".cmdk")`);
record("cmdk-closes-on-dismiss", overlayClosed, { dismissClicked, overlayClosed });

// ── D: Screenshot closed state ────────────────────────────────────────────────
const b64Closed = await screenshot();
writeFileSync(`state/verify-retro-121-closed-${SHA}.png`, Buffer.from(b64Closed, "base64"));
console.log(`  Screenshot (closed): state/verify-retro-121-closed-${SHA}.png`);

// ── E: Reopen and test Esc-key dismiss ───────────────────────────────────────
await evaluate(`document.getElementById("ribbon-palette-btn")?.click()`);
await delay(400);
await evaluate(`
  (() => {
    const input = document.querySelector(".cmdk-input");
    const target = input ?? document.querySelector(".cmdk") ?? document;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
  })()
`);
await delay(400);
const escClosed = await evaluate(`!document.querySelector(".cmdk-backdrop") && !document.querySelector(".cmdk")`);
record("cmdk-closes-on-esc", escClosed, { escClosed });

close();
const allPassed = writeReceipt(OUT, checks, { pr: 121, concern: "cmdk-dismiss" });
process.exit(allPassed ? 0 : 1);
