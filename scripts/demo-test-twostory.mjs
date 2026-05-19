#!/usr/bin/env bun
// demo-test-twostory.mjs — End-to-end test for the two-story-house default-prompt chip.
// Uses raw CDP WS (no Playwright). Connects to existing :5175 tab in shared :9222 browser.
// Reports branch A (green), B (context-clamp warning), or C (silent dispatch failure).
//
// Usage: bun scripts/demo-test-twostory.mjs
// Timeout: 240 seconds for model generation.

import { execSync } from "child_process";
import { CDP_PORT, DEV_PORT, CDP_BASE, DEV_URL } from "./ports.mjs";

const CDP_URL = CDP_BASE;
const APP_URL = DEV_URL;
const TIMEOUT_MS = 240_000;

// ── Find :5175 tab ─────────────────────────────────────────────────────────────
const tabs = await fetch(`${CDP_URL}/json`).then(r => r.json());
const tab = tabs.find(t => t.url?.startsWith(APP_URL) && t.type === "page");
if (!tab) {
  console.error(`ERROR: no :${DEV_PORT} tab found in shared browser. Open ${DEV_URL} first.`);
  process.exit(1);
}
console.log("Tab found:", tab.url, "id:", tab.id);

// ── Raw CDP WS ─────────────────────────────────────────────────────────────────
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let _cmdId = 1;
const _pending = new Map();
const _events = [];
let _eventHandler = null;

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && _pending.has(msg.id)) {
    const { resolve, reject } = _pending.get(msg.id);
    _pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  } else if (msg.method) {
    _events.push(msg);
    if (_eventHandler) _eventHandler(msg);
  }
};

await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
  setTimeout(() => rej(new Error("WS connect timeout")), 5000);
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _cmdId++;
    _pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (_pending.has(id)) { _pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
    }, 30_000);
  });
}

async function evaluate(fn) {
  const res = await send("Runtime.evaluate", {
    expression: `(${fn})()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: TIMEOUT_MS,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text ?? JSON.stringify(res.exceptionDetails));
  return res.result.value;
}

// ── Enable Runtime events ──────────────────────────────────────────────────────
await send("Runtime.enable");

// ── Hard-refresh to pick up latest master ─────────────────────────────────────
console.log("Hard-refreshing :5175 ...");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
// Wait for load event
await new Promise(res => {
  const cleanup = setInterval(() => {
    const loadEvt = _events.find(e => e.method === "Page.loadEventFired");
    if (loadEvt) { clearInterval(cleanup); res(); }
  }, 200);
  setTimeout(() => { clearInterval(cleanup); res(); }, 10_000);
});
await new Promise(r => setTimeout(r, 2000)); // let React hydrate

console.log("Page loaded. Installing event hooks ...");

// ── Install event monitors ─────────────────────────────────────────────────────
await evaluate(`() => {
  window.__demoTest = {
    warningMessages: [],
    progressTicks: [],
    agentDone: false,
    agentDoneDetail: null,
    sceneChildCount: null,
  };

  window.addEventListener('agentmodel:generate-warning', e => {
    window.__demoTest.warningMessages.push(e.detail?.message ?? 'unknown');
  });
  window.addEventListener('agentmodel:generate-progress', e => {
    window.__demoTest.progressTicks.push(e.detail?.tokens_generated ?? 0);
  });
  window.addEventListener('agent:done', e => {
    window.__demoTest.agentDone = true;
    window.__demoTest.agentDoneDetail = e.detail ?? null;
  });
  return 'hooks installed';
}`);

// ── Check model ready ──────────────────────────────────────────────────────────
console.log("Checking model ready state ...");
const modelReady = await evaluate(`() => {
  // Check if __gemmaSession exists and model badge shows READY/LIVE
  const badge = document.querySelector('.model-badge, #model-badge, [class*="badge"]');
  const badgeText = badge?.textContent ?? '';
  const hasReady = badgeText.includes('READY') || badgeText.includes('LIVE');
  return { badgeText, hasReady };
}`);
console.log("Model badge:", JSON.stringify(modelReady));
if (!modelReady.hasReady) {
  console.log("Model not READY — waiting up to 30s for warmup ...");
  const warmupStart = Date.now();
  while (Date.now() - warmupStart < 30_000) {
    await new Promise(r => setTimeout(r, 2000));
    const check = await evaluate(`() => {
      const badge = document.querySelector('.model-badge, #model-badge, [class*="badge"]');
      return badge?.textContent ?? '';
    }`);
    if (check.includes('READY') || check.includes('LIVE')) { console.log("Model ready:", check); break; }
    process.stdout.write(".");
  }
}

// ── Find and click the two-story-house chip ────────────────────────────────────
console.log("\nLooking for two-story-house starter chip ...");
const chipResult = await evaluate(`() => {
  // Starter chips are .starter-chip or [data-starter] elements
  const chips = Array.from(document.querySelectorAll('.starter-chip, [data-starter], .chat-starter'));
  const chip = chips.find(c => c.textContent.toLowerCase().includes('two') || c.textContent.toLowerCase().includes('story') || c.textContent.toLowerCase().includes('house'));
  if (!chip) return { found: false, allChips: chips.map(c => c.textContent.trim().slice(0,50)) };
  chip.click();
  return { found: true, chipText: chip.textContent.trim().slice(0,80) };
}`);
console.log("Chip click result:", JSON.stringify(chipResult));

if (!chipResult.found) {
  console.error("ERROR: two-story-house chip not found. All chips:", chipResult.allChips);
  // Try typing the prompt directly
  console.log("Falling back to direct input ...");
  await evaluate(`() => {
    const input = document.querySelector('#chat-input, .chat-input, [placeholder*="message"], [placeholder*="prompt"]');
    if (!input) return false;
    input.value = 'Design a two-story house with 4 bedrooms, living room, kitchen, and garage';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }`);
}

// ── Submit (press Enter or click Send) ────────────────────────────────────────
await new Promise(r => setTimeout(r, 500));
await evaluate(`() => {
  const input = document.querySelector('#chat-input, .chat-input, textarea');
  if (input) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  }
  // Also try send button
  const btn = document.querySelector('#chat-send, .chat-send, button[data-send]');
  if (btn && !btn.disabled) btn.click();
  return !!input;
}`);

console.log("Prompt submitted. Waiting for generation (up to 240s) ...");
const startTs = Date.now();
let lastTick = 0;
let warningFound = null;

// ── Poll until agent:done or timeout ──────────────────────────────────────────
while (Date.now() - startTs < TIMEOUT_MS) {
  await new Promise(r => setTimeout(r, 3000));
  const state = await evaluate(`() => window.__demoTest`);

  if (state.warningMessages.length > 0 && !warningFound) {
    warningFound = state.warningMessages[0];
    console.log("\n[WARN] Context-clamp warning detected:", warningFound);
  }

  const ticks = state.progressTicks;
  if (ticks.length > 0 && ticks[ticks.length - 1] !== lastTick) {
    lastTick = ticks[ticks.length - 1];
    const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);
    process.stdout.write(`\r  Progress: ${lastTick} tok  (${elapsed}s elapsed)  `);
  }

  if (state.agentDone) {
    console.log("\nagent:done received.");
    // Sample scene geometry
    const sceneState = await evaluate(`() => {
      const scene = window.__viewer?.scene;
      if (!scene) return { error: 'no __viewer.scene' };
      const walls = scene.children.filter(c => c.userData?.type === 'wall' || c.userData?.isWall);
      const slabs = scene.children.filter(c => c.userData?.type === 'slab' || c.userData?.isSlab);
      const total = scene.children.filter(c => c.isObject3D && c.type !== 'AmbientLight' && c.type !== 'DirectionalLight');
      return { walls: walls.length, slabs: slabs.length, totalObjects: total.length, childCount: scene.children.length };
    }`);
    console.log("Scene state:", JSON.stringify(sceneState));

    // Determine branch
    if (warningFound) {
      console.log("\n=== BRANCH B: Context-clamp warning surfaced ===");
      console.log("Warning:", warningFound);
      console.log("Scene objects:", sceneState.totalObjects, "(may be 0 due to truncated plan)");
      console.log("ACTION: Audit buildWebGPUSystemPrompt + verb list to cut tokens.");
      process.exit(2);
    } else if (sceneState.totalObjects >= 4 || sceneState.walls >= 2) {
      console.log("\n=== BRANCH A: GREEN — scene populated ===");
      console.log(`Walls: ${sceneState.walls}, Slabs: ${sceneState.slabs}, Total objects: ${sceneState.totalObjects}`);
      console.log(`Token ticks seen: ${ticks.length}, final tok count: ${lastTick}`);
      process.exit(0);
    } else {
      console.log("\n=== BRANCH C: Silent dispatch failure ===");
      console.log("agent:done fired but scene has few/no objects:", sceneState);
      console.log("ACTION: Check parseDispatches against raw model output.");
      process.exit(3);
    }
  }
}

console.log("\nTIMEOUT after 240s. Progress ticks seen:", lastTick);
if (warningFound) {
  console.log("Context-clamp warning was active:", warningFound);
  process.exit(2);
}
process.exit(4);
