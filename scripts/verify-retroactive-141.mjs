#!/usr/bin/env bun
// verify-retroactive-141.mjs — PR #141 P5b skill animation evidence.
//
// P5b added:
//   1. chat-panel.ts: "run {skill}" prompt dispatches skill:animate CustomEvent
//   2. workbench.ts: skill:animate listener switches to NODES→Canvas + calls runWithAnimation
//   3. skill-canvas.ts: runWithAnimation() steps through nodes with 80ms delay
//
// Current state: item 1 was removed in D2 (#153) rewrite of chat-panel.ts.
// This script tests items 2+3 directly (dispatch the event, verify canvas animates).
// A follow-up defect issue should be filed for the missing chat-dispatch path.
import { connectPage5175, delay, writeReceipt, makeRecorder, SHA } from "./retroactive-cdp-lib.mjs";

const OUT = `state/verify-retroactive-141-${SHA}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
const { evaluate, screenshot, close } = await connectPage5175();
console.log("Connected to :5175");

const checks = [];
const record = makeRecorder(checks);
import { writeFileSync } from "fs";

// ── A: Activate PROMPT tab first ──────────────────────────────────────────────
await evaluate(`document.querySelector(".dock-tab[data-tab='prompt']")?.click()`);
await delay(300);

// ── B: Check if chat-panel.ts still dispatches skill:animate (P5b chat path) ──
const chatPathPresent = await evaluate(`
  (() => {
    // P5b: typing "run {skill-name}" in chat dispatches skill:animate
    // Check if chat-panel's _executeAndPush or _send still has this dispatch
    // We can't inspect source, so we do a duck-test: set a sentinel listener
    window.__skillAnimateFired = false;
    window.addEventListener("skill:animate", () => { window.__skillAnimateFired = true; }, { once: false });
    return true;
  })()
`);

// ── C: Send "run fire station" to chat (matches P5b pattern) ─────────────────
const chatReady = await evaluate(`!!document.querySelector(".chat-input")`);
if (chatReady) {
  await evaluate(`
    (() => {
      const input = document.querySelector(".chat-input");
      input.value = "run fire station";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    })()
  `);
  await delay(1500); // Wait for potential fast-path or dispatch
}
const chatFiredAnimate = await evaluate(`window.__skillAnimateFired ?? false`);
record("chat-path-fires-skill-animate", chatFiredAnimate, {
  chatFiredAnimate,
  note: "P5b chat dispatch removed in D2 — FAIL expected, file defect if false"
});
console.log(`  Chat path fired skill:animate: ${chatFiredAnimate}`);

// ── D: Test workbench listener directly — dispatch skill:animate manually ─────
// Even if chat-dispatch is broken, the workbench listener + canvas animation should work
const fakeSteps = [
  { verb: "IfcWall", args: { length: 5, height: 3 } },
  { verb: "IfcSlab", args: { width: 10, depth: 10 } },
  { verb: "IfcDoor", args: { width: 1, height: 2.1 } },
];
await evaluate(`
  window.__skillAnimateFired = false;
  window.addEventListener("skill:animate", () => { window.__skillAnimateFired = true; }, { once: true });
  window.dispatchEvent(new CustomEvent("skill:animate", { detail: { steps: ${JSON.stringify(fakeSteps)} } }));
`);
await delay(600); // 3 steps × 80ms + buffer

// ── E: Check if canvas tab activated ─────────────────────────────────────────
const nodesTabActive = await evaluate(`
  document.querySelector(".dock-tab[data-tab='nodes']")?.classList.contains("active") ?? false
`);
record("skill-animate-event-switches-to-canvas", nodesTabActive, { nodesTabActive });
console.log(`  NODES tab active after skill:animate: ${nodesTabActive}`);

// ── F: Screenshot canvas mid/post-animation ───────────────────────────────────
const b64 = await screenshot();
writeFileSync(`state/verify-retro-141-canvas-animation-${SHA}.png`, Buffer.from(b64, "base64"));
console.log(`  Screenshot: state/verify-retro-141-canvas-animation-${SHA}.png`);

// ── G: Check canvas has animated nodes ────────────────────────────────────────
const nodeCount = await evaluate(`
  document.querySelectorAll(".sc-node, .skill-canvas-node, .canvas-node, [class*='sc-node']").length
`);
console.log(`  Canvas node count after animation: ${nodeCount}`);
record("canvas-animation-runs-with-nodes", nodeCount > 0, { nodeCount, fakeStepsCount: fakeSteps.length });

// ── H: Dispatch pill count in last chat message ───────────────────────────────
const pillCount = await evaluate(`
  (() => {
    const msgs = Array.from(document.querySelectorAll(".chat-msg-assistant:not(.chat-thinking)"));
    const last = msgs[msgs.length - 1];
    return last ? last.querySelectorAll(".chat-dispatch-pill").length : 0;
  })()
`);
console.log(`  Dispatch pills in last assistant msg: ${pillCount}`);
record("dispatch-pills-in-chat-msg", pillCount > 0, { pillCount, note: "Pills present if fastpath ran (not expected on master)" });

close();
const allPassed = writeReceipt(OUT, checks, { pr: 141, concern: "p5b-skill-animation" });
process.exit(allPassed ? 0 : 1);
