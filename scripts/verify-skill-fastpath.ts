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
//
// Uses an isolated headless browser against the :5183 dev server
// (which serves gemma-architect/ on the current branch).

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

// :5183 serves B:/M/gemma-architect/ (this repo). :5847 serves the master clone.
const DEV_URL   = "http://localhost:5183/";
const STATE_DIR = `${process.cwd()}/state`;

function getSHA(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", cwd: process.cwd() }).trim();
  } catch { return "unknown"; }
}

const sha       = getSHA();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 16) + "Z";
mkdirSync(STATE_DIR, { recursive: true });
const outFile = `${STATE_DIR}/verify-skill-fastpath-${sha}-${timestamp}.json`;

// Verify the dev server is up before launching Playwright
try {
  execSync(`curl -s --max-time 4 ${DEV_URL} -o nul`, { timeout: 6000 });
} catch {
  console.error(`BLOCKED: ${DEV_URL} not reachable. Start with: bun run web:dev -- --port 5183`);
  process.exit(2);
}

console.log(`Target: ${DEV_URL}`);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(DEV_URL, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(3000); // wait for viewer + skill-store init
console.log(`Page loaded: ${page.url()}`);

type Check = { name: string; passed: boolean; evidence: unknown };
const checks: Check[] = [];

function record(c: Check) {
  checks.push(c);
  console.log(`  ${c.passed ? "✓" : "✗"} ${c.name}`);
  if (!c.passed) console.log("    evidence:", JSON.stringify(c.evidence).slice(0, 300));
}

// ── 0: Confirm debug globals set (verifies _buildTimeSkills ran) ──────────────
const skillCount = await page.evaluate(() => (window as any).__debugSkillCount as number | undefined);
const skillNames = await page.evaluate(() => (window as any).__debugSkillNames as string[] | undefined);
console.log(`  _buildTimeSkills count: ${skillCount ?? "undefined"}`);
if (skillNames) console.log(`  skills: ${skillNames.join(", ")}`);
record({ name: "build-time-skills-loaded", passed: (skillCount ?? 0) > 0, evidence: { skillCount, skillNames } });

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

if (!tabActivated) {
  console.error("Chat input not found — aborting");
  await browser.close();
  process.exit(1);
}

// ── B: Baseline scene children count ──────────────────────────────────────────
const beforeCount = await page.evaluate(() =>
  (window as any).__viewer?.scene?.children?.length ?? -1
);
console.log(`  Baseline scene children: ${beforeCount}`);

// ── C: Submit prompt ──────────────────────────────────────────────────────────
await page.evaluate(() => {
  const input = document.querySelector(".chat-input") as HTMLTextAreaElement | null;
  if (!input) throw new Error("no .chat-input");
  input.value = "design a fire station";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
});
console.log("  Prompt submitted. Polling for scene growth...");

// ── D: Poll until mesh count stabilises ───────────────────────────────────────
let afterCount = beforeCount;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(200);
  afterCount = await page.evaluate(() => (window as any).__viewer?.scene?.children?.length ?? -1);
  if (afterCount - beforeCount >= 15) break;
}
await page.waitForTimeout(800);
afterCount = await page.evaluate(() => (window as any).__viewer?.scene?.children?.length ?? -1);
const meshDelta = afterCount - beforeCount;
console.log(`  After: ${afterCount} (Δ=${meshDelta})`);
record({ name: "mesh-delta-ge-18", passed: meshDelta >= 18, evidence: { beforeCount, afterCount, meshDelta } });

// ── E: Last assistant message ─────────────────────────────────────────────────
const msgEv = await page.evaluate(() => {
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
console.log("  Last msg:", JSON.stringify(msgEv));
record({ name: "assistant-msg-present", passed: msgEv?.found, evidence: msgEv });
record({ name: "dispatch-pills-ge-18", passed: (msgEv?.pillCount ?? 0) >= 18, evidence: { pillCount: msgEv?.pillCount } });
record({ name: "no-chat-error", passed: !msgEv?.hasError, evidence: { hasError: msgEv?.hasError } });

// ── F: Send button re-enabled (not stuck waiting for model) ──────────────────
const btnOk = await page.evaluate(() => {
  const btn = document.querySelector(".chat-send-btn") as HTMLButtonElement | null;
  const thinking = document.querySelectorAll(".chat-thinking");
  return { btnDisabled: btn?.disabled ?? true, spinnerCount: thinking.length };
});
record({ name: "send-btn-re-enabled", passed: !btnOk?.btnDisabled && btnOk?.spinnerCount === 0, evidence: btnOk });

// ── Summary ───────────────────────────────────────────────────────────────────
const allPassed = checks.every(c => c.passed);
const receipt = {
  sha,
  timestamp: new Date().toISOString(),
  dev_url: DEV_URL,
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
