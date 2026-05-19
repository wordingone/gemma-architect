#!/usr/bin/env bun
// gen-thumbnails.mjs — Generate ribbon asset thumbnail PNGs via CDP.
// Loads each IFC sample in the shared browser, waits for WebGL render,
// screenshots a centered 4:3 crop of the viewer canvas, writes to
// web/public/thumbnails/{id}.png
//
// Usage: bun scripts/gen-thumbnails.mjs

import { WebSocket } from "ws";
import { writeFileSync, mkdirSync } from "fs";
import { CDP_PORT, DEV_PORT, CDP_BASE } from "./ports.mjs";

const CDP_URL = CDP_BASE;
const OUT_DIR = "web/public/thumbnails";

// Scenes = full buildings; Elements = individual components
const SAMPLES = [
  // scenes
  { id: "schultz-residence",  waitMs: 60000 },
  { id: "kit-fzk-haus",       waitMs: 15000 },
  { id: "kit-office",         waitMs: 30000 },
  { id: "bonsai-openings",    waitMs:  8000 },
  // elements
  { id: "wall-with-opening",  waitMs:  5000 },
  { id: "simple-sweep",       waitMs:  5000 },
];

// ── CDP connection ────────────────────────────────────────────────────────────
const targets = await fetch(`${CDP_URL}/json`).then(r => r.json());
const target  = targets.find(t => t.url?.includes(`localhost:${DEV_PORT}`) && t.type === "page");
if (!target) { console.error(`No :${DEV_PORT} page target`); process.exit(1); }
console.log(`Connected to: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
};
await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await send("Runtime.enable");
await send("Page.enable");
await send("Page.bringToFront");

async function evaluate(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) return null;
  return res?.result?.result?.value;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function canvasBpp() {
  const rect = await evaluate(`(function() {
    const c = document.getElementById('viewer-canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`);
  if (!rect || rect.width < 1) return 0;
  const snap = await send("Page.captureScreenshot", {
    format: "jpeg", quality: 50,
    clip: { x: rect.x, y: rect.y, width: Math.min(200, rect.width), height: Math.min(150, rect.height), scale: 1 },
  });
  const b64 = snap?.result?.data ?? "";
  return b64.length > 0 ? b64.length * 0.75 / (200 * 150) : 0;
}

async function waitForRender(maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const bpp = await canvasBpp();
    if (bpp > 0.025) return true;
    await delay(1000);
  }
  const bpp = await canvasBpp();
  console.log(`  render timeout (bpp=${bpp.toFixed(3)}) — screenshotting anyway`);
  return false;
}

// ── Reset scene ───────────────────────────────────────────────────────────────
async function resetScene() {
  await evaluate(`
    try {
      window.__dispatch('clearScene', {});
    } catch(e) {
      // fallback: clear via viewer
      if (window.__viewer) {
        while (window.__viewer.scene.children.length > 0)
          window.__viewer.scene.remove(window.__viewer.scene.children[0]);
      }
    }
  `);
  await delay(500);
}

// ── Deselect all — hides gumball/flagging overlays before screenshot ──────────
async function deselect() {
  await evaluate(`
    try { window.__dispatch('SdDeselect', {}); } catch(e) {}
  `);
  await delay(300);
}

// ── Screenshot canvas with 4:3 center crop ────────────────────────────────────
async function screenshotCanvas() {
  const rect = await evaluate(`(function() {
    const c = document.getElementById('viewer-canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  if (!rect) throw new Error("viewer-canvas not found");

  // 4:3 center crop, max 320×240, padded 10% inward for visual comfort
  const maxW = Math.min(320, Math.floor(rect.w * 0.9));
  const clipW = maxW;
  const clipH = Math.round(clipW * 0.75);
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;

  const snap = await send("Page.captureScreenshot", {
    format: "png",
    clip: {
      x: Math.max(rect.x, cx - clipW / 2),
      y: Math.max(rect.y, cy - clipH / 2),
      width: clipW,
      height: clipH,
      scale: 1,
    },
  });
  return snap?.result?.data ?? null;
}

// ── Main loop ─────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });

for (const s of SAMPLES) {
  console.log(`\n[${s.id}] loading...`);
  await resetScene();

  // Trigger sample load via sample-select change event
  await evaluate(`(function() {
    const sel = document.getElementById('sample-select');
    if (!sel) return;
    sel.value = '${s.id}';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  // Wait for render
  process.stdout.write(`  waiting up to ${Math.round(s.waitMs / 1000)}s for render...`);
  await waitForRender(s.waitMs);
  process.stdout.write(" done\n");

  // Extra settle for complex models
  await delay(1500);

  // Deselect everything to hide gumball / flagging overlays
  await deselect();

  // Screenshot
  const b64 = await screenshotCanvas();
  if (!b64) { console.log(`  SKIP: screenshot returned null`); continue; }

  const outPath = `${OUT_DIR}/${s.id}.png`;
  writeFileSync(outPath, Buffer.from(b64, "base64"));
  console.log(`  → ${outPath} (${Math.round(Buffer.from(b64, "base64").length / 1024)}KB)`);
}

ws.close();
console.log("\nDone. Thumbnails in:", OUT_DIR);
