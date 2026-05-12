#!/usr/bin/env node
// scripts/demo-drive.mjs — Automated demo driver for D4 hackathon video
//
// Drives the :5175 app through the demo flow via CDP:
//   1. Attach image (snapshot PNG) via chat attach button
//   2. Submit "Design a building like this" prompt
//   3. Wait for agent response + dispatch completion
//   4. Submit refinement prompt
//   5. Export IFC
//
// Run alongside demo-record.mjs (start recording first, then drive):
//   node scripts/demo-record.mjs --out state/demo-frames/run1 &
//   node scripts/demo-drive.mjs --snapshot fire-station --prompt "Design a fire station"
//
// Usage:
//   node scripts/demo-drive.mjs [--snapshot NAME] [--prompt TEXT] [--refine TEXT] [--pause-before N]
//
//   --snapshot NAME   Snapshot stem from web/public/snapshots/ (e.g. fire-station)
//                     Resolves to latest SHA-stamped PNG automatically
//   --prompt TEXT     Initial design prompt (default: "Design a building like this")
//   --refine TEXT     Refinement prompt after initial design (optional)
//   --pause-before N  Seconds to pause before starting (default: 3)
//   --dry-run         Print steps without executing
//
// Issue #150 — D4 demo recording pipeline.

import { readdirSync, readFileSync } from "fs";
import { WebSocket } from "ws";

// ── Args ──────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : def;
}
const hasFlag = name => process.argv.includes(name);

const snapshotStem = arg("--snapshot", "fire-station");
const promptText   = arg("--prompt", "Design a building like this");
const refineText   = arg("--refine", null);
const pauseBefore  = parseInt(arg("--pause-before", "3"), 10);
const dryRun       = hasFlag("--dry-run");

// ── Resolve snapshot path ─────────────────────────────────────────────────────
const SNAPSHOTS_DIR = "web/public/snapshots";
let snapshotPath = null;
try {
  const files = readdirSync(SNAPSHOTS_DIR).filter(f => f.startsWith(snapshotStem) && f.endsWith(".png"));
  if (files.length === 0) throw new Error(`no snapshot matching ${snapshotStem}`);
  // Pick the most recent (alphabetical = SHA order, last is newest)
  snapshotPath = `${SNAPSHOTS_DIR}/${files.sort().at(-1)}`;
  console.log(`[demo-drive] Snapshot: ${snapshotPath}`);
} catch (e) {
  console.error(`[demo-drive] ERROR: ${e.message}`);
  console.error(`[demo-drive] Available snapshots in ${SNAPSHOTS_DIR}:`);
  try {
    const all = readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith(".png")).map(f => f.replace(/-[a-f0-9]{7}\.png$/, ""));
    [...new Set(all)].forEach(s => console.error(`  ${s}`));
  } catch { /* ignore */ }
  process.exit(1);
}

if (dryRun) {
  console.log("[demo-drive] DRY RUN — steps:");
  console.log(`  1. Pause ${pauseBefore}s`);
  console.log(`  2. Attach ${snapshotPath} via chat image button`);
  console.log(`  3. Submit: "${promptText}"`);
  console.log(`  4. Wait for agent response`);
  if (refineText) console.log(`  5. Submit refinement: "${refineText}"`);
  console.log(`  6. Wait for refinement response`);
  process.exit(0);
}

// ── CDP connection ────────────────────────────────────────────────────────────
const targets = await fetch("http://localhost:9222/json").then(r => r.json());
const target  = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
if (!target) {
  console.error("ERROR: no :5175 page target found — is the shared browser running?");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

ws.onmessage = msg => {
  const x = JSON.parse(msg.data);
  if (x.id != null && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
};
await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function evaluate(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) return null;
  return res?.result?.result?.value;
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.bringToFront");

// ── Helpers ───────────────────────────────────────────────────────────────────

// Set chat input text
async function setChatInput(text) {
  await evaluate(`
    (function() {
      const el = document.querySelector('.chat-input');
      if (!el) throw new Error('no .chat-input');
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      nativeInputValueSetter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
}

// Click send button
async function clickSend() {
  await evaluate(`document.querySelector('.chat-send-btn')?.click()`);
}

// Attach image via file input (inject base64 data)
async function attachSnapshot(filePath) {
  const bytes = readFileSync(filePath);
  const b64   = bytes.toString("base64");
  const name  = filePath.split("/").at(-1);

  // Inject file into the hidden file input via DataTransfer
  const ok = await evaluate(`
    (async function() {
      const input = document.querySelector('input[type="file"][accept*="image"]');
      if (!input) return { error: 'no file input found' };
      const b64 = ${JSON.stringify(b64)};
      const byteStr = atob(b64);
      const ab = new ArrayBuffer(byteStr.length);
      const ia = new Uint8Array(ab);
      for (let i = 0; i < byteStr.length; i++) ia[i] = byteStr.charCodeAt(i);
      const blob = new Blob([ab], { type: 'image/png' });
      const file = new File([blob], ${JSON.stringify(name)}, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set;
      nativeSetter.call(input, dt.files);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, name: ${JSON.stringify(name)} };
    })()
  `);
  return ok;
}

// Wait for dispatch event (agent finished)
async function waitForDispatch(timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const busy = await evaluate(`!!document.querySelector('.chat-send-btn[disabled]') || document.querySelector('.chat-bubble.pending') !== null`);
    if (!busy) return true;
    await delay(500);
  }
  return false; // timed out
}

// ── Demo flow ─────────────────────────────────────────────────────────────────

console.log(`[demo-drive] Pausing ${pauseBefore}s before starting...`);
await delay(pauseBefore * 1000);

// Step 1: Attach snapshot image
console.log(`[demo-drive] Attaching snapshot: ${snapshotPath}`);
const attachResult = await attachSnapshot(snapshotPath);
if (attachResult?.error) {
  console.warn(`[demo-drive] Attach warning: ${attachResult.error} — continuing with text-only prompt`);
} else {
  console.log(`[demo-drive] Attached: ${attachResult?.name}`);
  await delay(500);
}

// Step 2: Set prompt + send
console.log(`[demo-drive] Submitting: "${promptText}"`);
await setChatInput(promptText);
await delay(200);
await clickSend();

// Step 3: Wait for response
console.log(`[demo-drive] Waiting for agent response (up to 90s)...`);
await delay(2000); // let the button disable first
const ok1 = await waitForDispatch(90_000);
if (!ok1) console.warn("[demo-drive] Timeout waiting for initial response — continuing");
else console.log("[demo-drive] Initial design complete.");
await delay(2000);

// Step 4: Refinement (optional)
if (refineText) {
  console.log(`[demo-drive] Submitting refinement: "${refineText}"`);
  await setChatInput(refineText);
  await delay(200);
  await clickSend();
  console.log(`[demo-drive] Waiting for refinement response...`);
  await delay(2000);
  const ok2 = await waitForDispatch(90_000);
  if (!ok2) console.warn("[demo-drive] Timeout waiting for refinement — continuing");
  else console.log("[demo-drive] Refinement complete.");
  await delay(2000);
}

console.log("[demo-drive] Demo flow complete. Stop demo-record.mjs (Ctrl+C) to assemble video.");
ws.close();
process.exit(0);
