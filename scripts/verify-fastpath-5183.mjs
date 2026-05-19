#!/usr/bin/env bun
// verify-fastpath-5183.mjs — CDP receipt for chat skill fastpath on port 5183.
// Opens a new tab at :5183 in the shared browser (CDP_PORT), runs the fastpath
// verification, saves a receipt, then closes the tab.

import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { CDP_PORT, CDP_BASE } from "./ports.mjs";

const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const TS  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT = `state/verify-skill-fastpath-${SHA}-${TS}.json`;
mkdirSync("state", { recursive: true });

const TARGET_URL = "http://localhost:5183/";

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 1: Open new tab via Target.createTarget (browser-level WS — avoids /json/new) ──
console.log(`Opening new tab: ${TARGET_URL}`);
const version = await fetch(`${CDP_BASE}/json/version`).then(r => r.json());
const bws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { bws.on("open", res); bws.on("error", rej); });
const createReply = await new Promise(r => {
  bws.on("message", raw => r(JSON.parse(raw)));
  bws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: TARGET_URL } }));
});
bws.close();
const TARGET_ID = createReply.result.targetId;
await delay(500);
const tabList = await fetch(`${CDP_BASE}/json`).then(r => r.json());
const newTab = tabList.find(t => t.id === TARGET_ID);
if (!newTab) { console.error("ERROR: created tab not found"); process.exit(1); }
const PAGE_WS = newTab.webSocketDebuggerUrl;
console.log("New tab WS:", PAGE_WS);

// ── 2: Connect to new tab page WS ─────────────────────────────────────────────
let msgId = 1;
const pending = new Map();
const ws = new WebSocket(PAGE_WS);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
console.log("Connected to new tab");

ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
  }
});

async function closeTab(targetId) {
  try {
    const ver = await fetch(`${CDP_BASE}/json/version`).then(r => r.json());
    const bwsClose = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { bwsClose.on("open", res); bwsClose.on("error", rej); });
    await new Promise(r => {
      bwsClose.on("message", raw => r(JSON.parse(raw)));
      bwsClose.send(JSON.stringify({ id: 1, method: "Target.closeTarget", params: { targetId } }));
    });
    bwsClose.close();
  } catch { /* ignore close errors */ }
}

function send(method, params = {}) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "Runtime error");
  return r.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");

// Wait for page load (it was just opened)
console.log("Waiting for page load + WASM init...");
await delay(8000);

const checks = [];
function record(name, passed, evidence) {
  checks.push({ name, passed, evidence });
  console.log(`  ${passed ? "✓" : "✗"} ${name}`);
  if (!passed) console.log("    evidence:", JSON.stringify(evidence).slice(0, 400));
}

// ── B: Activate PROMPT mode + confirm chat input ──────────────────────────────
const chatReady = await evaluate(`
  (() => {
    const tabs = Array.from(document.querySelectorAll(".dock-tab-btn, [data-tab]"));
    const promptTab = tabs.find(t =>
      t.textContent?.trim().toUpperCase().startsWith("PROMPT") ||
      t.textContent?.trim().toUpperCase().startsWith("CREATE")
    );
    if (promptTab) promptTab.click();
    const pill = document.querySelector(".mode-pill");
    if (pill && pill.getAttribute("data-mode") === "console") pill.click();
    return !!document.querySelector(".chat-input");
  })()
`);
await delay(300);
record("chat-input-visible", chatReady, { chatReady });

if (!chatReady) {
  console.error("No .chat-input found — aborting");
  ws.close();
  await closeTab(TARGET_ID);
  process.exit(1);
}

// ── C: Baseline scene count ────────────────────────────────────────────────────
const beforeCount = await evaluate(`window.__viewer?.scene?.children?.length ?? -1`);
console.log(`  Baseline scene children: ${beforeCount}`);

// ── D: Submit prompt ──────────────────────────────────────────────────────────
await evaluate(`
  (() => {
    const input = document.querySelector(".chat-input");
    input.value = "design a fire station";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  })()
`);
console.log("  Prompt submitted. Polling...");

// ── E: Poll for scene growth (fastpath should complete in <3s) ────────────────
let afterCount = beforeCount;
for (let i = 0; i < 50; i++) {
  await delay(200);
  afterCount = await evaluate(`window.__viewer?.scene?.children?.length ?? -1`);
  if (afterCount - beforeCount >= 15) break;
}
await delay(800);
afterCount = await evaluate(`window.__viewer?.scene?.children?.length ?? -1`);
const meshDelta = afterCount - beforeCount;
console.log(`  After: ${afterCount} (Δ=${meshDelta})`);
record("mesh-delta-ge-18", meshDelta >= 18, { beforeCount, afterCount, meshDelta });

// ── F: Last assistant message ─────────────────────────────────────────────────
const msgEv = await evaluate(`
  (() => {
    const msgs = Array.from(document.querySelectorAll(".chat-msg-assistant:not(.chat-thinking)"));
    const last = msgs[msgs.length - 1];
    if (!last) return { found: false, pillCount: 0, hasError: false, content: "" };
    return {
      found: true,
      pillCount: last.querySelectorAll(".chat-dispatch-pill").length,
      hasError: !!last.querySelector(".chat-msg-error"),
      content: (last.querySelector(".chat-msg-content")?.textContent ?? "").slice(0, 300),
    };
  })()
`);
console.log("  Last msg:", JSON.stringify(msgEv));
record("assistant-msg-present", msgEv?.found, msgEv);
record("dispatch-pills-ge-18", (msgEv?.pillCount ?? 0) >= 18, { pillCount: msgEv?.pillCount });
record("no-chat-error", !msgEv?.hasError, { hasError: msgEv?.hasError });

// ── G: Send button re-enabled (no stuck spinner = fastpath, not model wait) ───
const btnOk = await evaluate(`
  (() => {
    const btn = document.querySelector(".chat-send-btn");
    const thinking = document.querySelectorAll(".chat-thinking");
    return { btnDisabled: btn?.disabled ?? true, spinnerCount: thinking.length };
  })()
`);
record("send-btn-re-enabled", !btnOk?.btnDisabled && btnOk?.spinnerCount === 0, btnOk);

// ── Summary ───────────────────────────────────────────────────────────────────
const allPassed = checks.every(c => c.passed);
const receipt = {
  sha: SHA,
  timestamp: new Date().toISOString(),
  page_url: TARGET_URL,
  all_passed: allPassed,
  checks,
};

console.log("\n── Results ──────────────────────────────────────────────────");
for (const c of checks) console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name}`);
console.log(`\nall_passed: ${allPassed}`);
writeFileSync(OUT, JSON.stringify(receipt, null, 2));
console.log(`Receipt: ${OUT}`);

ws.close();
// Close the tab we opened (via Target.closeTarget — avoids /json/close HTTP endpoint)
await closeTab(TARGET_ID);
process.exit(allPassed ? 0 : 1);
