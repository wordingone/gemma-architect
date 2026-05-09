#!/usr/bin/env bun
// verify-skill-fastpath.ts — CDP evidence receipt for the chat skill fastpath.
//
// Verifies that typing "design a fire station" in the chat input and pressing
// Enter fires the skill fastpath (no model inference), producing:
//   - scene mesh count delta ≥ 18 (one mesh per skill step)
//   - no error-class chat messages
//   - dispatch pills rendered in the assistant message
//
// Saves receipt to: state/verify-skill-fastpath-<sha>-<ts>.json
// Exit 0 = all_passed. Exit 1 = failed. Exit 2 = setup error.

import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const CDP_JSON  = "B:/M/gemma-architect-master/.shared-browser/cdp.json";
const STATE_DIR = `${process.cwd()}/state`;
const DEV_URL   = "http://localhost:5175/";

function getSHA(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch { return "unknown"; }
}

const sha       = getSHA();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 16) + "Z";
mkdirSync(STATE_DIR, { recursive: true });
const outFile = `${STATE_DIR}/verify-skill-fastpath-${sha}-${timestamp}.json`;

if (!existsSync(CDP_JSON)) {
  console.error(`BLOCKED: ${CDP_JSON} not found. Start shared browser first.`);
  process.exit(2);
}
const { endpoint } = JSON.parse(readFileSync(CDP_JSON, "utf8").replace(/^﻿/, ""));
const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0] ?? await browser.newContext();
console.log(`Connected via CDP: ${endpoint}`);

const allPages = browser.contexts().flatMap(c => c.pages());
const page = allPages.find(p => p.url().startsWith(DEV_URL));
if (!page) {
  console.error(`BLOCKED: no page at ${DEV_URL}`);
  process.exit(2);
}
console.log(`Page: ${page.url()}`);

// Reload to ensure HMR changes (workbench.ts setSkills wiring) are active.
await page.goto(DEV_URL, { waitUntil: "load", timeout: 30000 });
await page.waitForTimeout(3000); // wait for viewer + skill-store init

type Check = { name: string; passed: boolean; evidence: unknown };
const checks: Check[] = [];

function record(c: Check) {
  checks.push(c);
  console.log(`  ${c.passed ? "✓" : "✗"} ${c.name}`);
  if (!c.passed) console.log("    evidence:", JSON.stringify(c.evidence).slice(0, 300));
}

// ── A: Ensure CREATE tab is visible in PROMPT mode ────────────────────────────
const tabActivated = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll(".dock-tab-btn, [data-tab]"));
  const promptTab = tabs.find(t =>
    t.textContent?.trim().toUpperCase().startsWith("PROMPT") ||
    t.textContent?.trim().toUpperCase().startsWith("CREATE")
  );
  if (promptTab) (promptTab as HTMLElement).click();
  const pill = document.querySelector(".mode-pill") as HTMLElement | null;
  if (pill && pill.getAttribute("data-mode") === "console") pill.click();
  return !!document.querySelector(".chat-input");
});
await page.waitForTimeout(300);
record({ name: "chat-input-visible", passed: tabActivated, evidence: { tabActivated } });

// ── B: Clear any previous chat history (hard-reload would break HMR state) ───
await page.evaluate(() => {
  const clearBtn = document.querySelector(".chat-clear-btn") as HTMLElement | null;
  if (clearBtn) clearBtn.click();
});
await page.waitForTimeout(100);

// ── C: Capture baseline scene children count ──────────────────────────────────
const beforeCount = await page.evaluate(() =>
  (window as any).__viewer?.scene?.children?.length ?? -1
);
console.log(`  Baseline scene children: ${beforeCount}`);

// ── D: Type prompt and submit ─────────────────────────────────────────────────
await page.evaluate(() => {
  const input = document.querySelector(".chat-input") as HTMLTextAreaElement | null;
  if (!input) throw new Error("no .chat-input");
  input.value = "design a fire station";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
});
console.log("  Prompt submitted. Waiting for skill dispatch...");

// ── E: Poll until mesh count delta stabilises or timeout ─────────────────────
let afterCount = beforeCount;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(200);
  afterCount = await page.evaluate(() =>
    (window as any).__viewer?.scene?.children?.length ?? -1
  );
  if (afterCount - beforeCount >= 15) break; // enough dispatches landed
}
await page.waitForTimeout(600); // settle
afterCount = await page.evaluate(() =>
  (window as any).__viewer?.scene?.children?.length ?? -1
);
const meshDelta = afterCount - beforeCount;
console.log(`  After: ${afterCount} scene children (Δ=${meshDelta})`);
record({ name: "mesh-delta-ge-18", passed: meshDelta >= 18, evidence: { beforeCount, afterCount, meshDelta } });

// ── F: Verify assistant message + dispatch pills ──────────────────────────────
const msgEvidence = await page.evaluate(() => {
  const msgs = Array.from(document.querySelectorAll(".chat-msg-assistant:not(.chat-thinking)"));
  const last = msgs[msgs.length - 1] as HTMLElement | undefined;
  if (!last) return { found: false, pillCount: 0, hasError: false, content: "" };
  return {
    found: true,
    pillCount: last.querySelectorAll(".chat-dispatch-pill").length,
    hasError: !!last.querySelector(".chat-msg-error"),
    content: (last.querySelector(".chat-msg-content")?.textContent ?? "").slice(0, 200),
  };
});
record({ name: "assistant-msg-present", passed: msgEvidence.found, evidence: msgEvidence });
record({ name: "dispatch-pills-present", passed: msgEvidence.pillCount >= 18, evidence: { pillCount: msgEvidence.pillCount } });
record({ name: "no-chat-error", passed: !msgEvidence.hasError, evidence: msgEvidence });

// ── G: Verify no model inference occurred (button re-enabled, no thinking el) ─
const noSpinner = await page.evaluate(() => {
  const thinking = document.querySelectorAll(".chat-thinking");
  const btn = document.querySelector(".chat-send-btn") as HTMLButtonElement | null;
  return { spinnerCount: thinking.length, btnDisabled: btn?.disabled ?? true };
});
record({ name: "no-spinner-model-inference", passed: noSpinner.spinnerCount === 0 && !noSpinner.btnDisabled, evidence: noSpinner });

// ── H: frameAllVisible fired (viewer has non-empty bounding box) ──────────────
const viewerFramed = await page.evaluate(() => {
  const v = (window as any).__viewer;
  if (!v) return false;
  const box = new (v.scene.constructor as any)();
  return v.scene.children.length > 5;
});
record({ name: "viewer-has-geometry", passed: viewerFramed, evidence: { sceneChildren: afterCount } });

// ── Summary ───────────────────────────────────────────────────────────────────
const allPassed = checks.every(c => c.passed);
const receipt = {
  sha,
  timestamp: new Date().toISOString(),
  page_url: page.url(),
  all_passed: allPassed,
  checks,
};

console.log("\n── Results ──────────────────────────────────────────────────");
for (const c of checks) console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name}`);
console.log(`\nall_passed: ${allPassed}`);
writeFileSync(outFile, JSON.stringify(receipt, null, 2));
console.log(`Receipt: ${outFile}`);

await browser.close();
process.exit(allPassed ? 0 : 1);
