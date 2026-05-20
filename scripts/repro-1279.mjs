#!/usr/bin/env bun
/**
 * repro-1279.mjs — Deterministic repro harness for #1279 (fresh-device download stall)
 *
 * Navigates to deployed Pages URL in a fresh context (site-data cleared for origin).
 * Captures console for 120s and reports which of the 5 required markers appear.
 *
 * Usage: bun scripts/repro-1279.mjs
 */

import { writeFileSync, mkdirSync } from "fs";

const CDP_BASE   = "http://localhost:9222";
const PAGES_URL  = "https://wordingone.github.io/gemma-architect/";
const PAGES_ORIGIN = "https://wordingone.github.io";
const WAIT_MS    = 120_000; // 120s — enough to see the 90s watchdog fire
const STATE_DIR  = "B:/M/gemma-architect-archie/state";

mkdirSync(STATE_DIR, { recursive: true });

// ── 1. Get target list ────────────────────────────────────────────────────────
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) {
  console.error("ERROR: CDP not reachable at :9222");
  process.exit(1);
}

// Only real page tabs are usable — workers have type "worker"
// Use the existing page tab (will navigate it to Pages, then back)
const pageTargets = targets.filter(t => t.type === "page");
let target = pageTargets[0];
if (!target) {
  console.error("No page tab found. Tabs:", targets.map(t=>`${t.type}:${t.url}`));
  process.exit(1);
}
const originalUrl = target.url;
console.log(`Will navigate existing tab from ${originalUrl} → Pages URL`);
console.log(`Using tab: ${target.url || "(blank)"} — ${target.id}`);

// ── 2. Open WS to tab ─────────────────────────────────────────────────────────
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const events  = [];

ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  events.push(x);
};
await new Promise(r => ws.addEventListener("open", r));
console.log("WS connected");

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Console.enable");
await send("Network.enable");
await send("Page.bringToFront");

// ── 3. Clear site data for Pages origin ──────────────────────────────────────
console.log(`Clearing site data for ${PAGES_ORIGIN}...`);
const clearRes = await send("Storage.clearDataForOrigin", {
  origin: PAGES_ORIGIN,
  storageTypes: "appcache,cookies,file_systems,indexeddb,local_storage,manifest,service_workers,cache_storage,all",
});
console.log("Clear result:", JSON.stringify(clearRes?.result));

// Small pause after clear
await new Promise(r => setTimeout(r, 500));

// ── 4. Set up console capture ─────────────────────────────────────────────────
const consoleLogs = [];
const t0 = Date.now();

// Console.messageAdded fires for console messages
ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }

  // Runtime console API calls
  if (x.method === "Runtime.consoleAPICalled") {
    const ts = Math.round(Date.now() - t0);
    const text = (x.params?.args ?? []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
    const type = x.params?.type ?? "log";
    consoleLogs.push({ ts, type, text });
    process.stdout.write(`  +${ts}ms [${type}] ${text.slice(0, 200)}\n`);
  }

  // Console.messageAdded
  if (x.method === "Console.messageAdded") {
    const ts = Math.round(Date.now() - t0);
    const msg = x.params?.message ?? {};
    const text = msg.text ?? "";
    const level = msg.level ?? "log";
    consoleLogs.push({ ts, type: level, text, url: msg.url });
    process.stdout.write(`  +${ts}ms [${level}] ${text.slice(0, 200)}\n`);
  }

  // Page navigated
  if (x.method === "Page.frameNavigated") {
    const url = x.params?.frame?.url;
    if (url) console.log(`  +${Math.round(Date.now()-t0)}ms PAGE NAVIGATED → ${url}`);
  }
};

// ── 5. Navigate to Pages URL ──────────────────────────────────────────────────
console.log(`\nNavigating to ${PAGES_URL}...`);
await send("Page.navigate", { url: PAGES_URL });
console.log("Navigation dispatched — waiting for console events...\n");

// ── 6. Wait 120s ──────────────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, WAIT_MS));

// ── 7. Analyse markers ────────────────────────────────────────────────────────
const fullText = consoleLogs.map(l => l.text).join("\n");

const markers = {
  m1_color_warn:      consoleLogs.some(l => l.text.includes("Unknown color model oklch")),
  m2_stall_trace:     consoleLogs.some(l => l.text.includes("[gemma-cad] stall trace") && l.text.includes('"event":"manifest"') && !l.text.includes('"event":"downloading"')),
  m3_power_pref:      consoleLogs.filter(l => l.text.includes("powerPreference option is currently ignored")).length,
  m4_cache_put_error: consoleLogs.some(l => l.text.includes("UnknownError") && l.text.includes("put")),
  m5_stalled_ui:      consoleLogs.some(l => l.text.includes("DOWNLOAD STALLED")),
  downloading_seen:   consoleLogs.some(l => l.text.includes('"event":"downloading"') || l.text.includes("downloading")),
  manifest_seen:      consoleLogs.some(l => l.text.includes('"event":"manifest"') || l.text.includes("manifest")),
};

console.log("\n=== MARKER ANALYSIS ===");
console.log("M1 THREE.Color warning:    ", markers.m1_color_warn ? "✓ SEEN" : "✗ NOT SEEN");
console.log("M2 stall trace (no dl):    ", markers.m2_stall_trace ? "✓ SEEN" : "✗ NOT SEEN");
console.log("M3 powerPreference warns:  ", markers.m3_power_pref >= 3 ? `✓ SEEN (${markers.m3_power_pref}×)` : `~ PARTIAL (${markers.m3_power_pref}×, need ≥3)`);
console.log("M4 Cache.put UnknownError: ", markers.m4_cache_put_error ? "✓ SEEN" : "✗ NOT SEEN");
console.log("M5 DOWNLOAD STALLED UI:    ", markers.m5_stalled_ui ? "✓ SEEN" : "✗ NOT SEEN");
console.log("");
console.log("downloading events seen:   ", markers.downloading_seen ? "YES (model loaded OK?)" : "NO (consistent with stall)");
console.log("manifest seen:             ", markers.manifest_seen ? "YES" : "NO");

const allFive = markers.m1_color_warn && markers.m2_stall_trace && markers.m3_power_pref >= 3 && markers.m4_cache_put_error && markers.m5_stalled_ui;
console.log(`\nFULL REPRO: ${allFive ? "✓ ALL 5 MARKERS" : "✗ PARTIAL"}`);

// ── 8. Write artifact ─────────────────────────────────────────────────────────
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const outFile = `${STATE_DIR}/repro-1279-${ts}.json`;
writeFileSync(outFile, JSON.stringify({ url: PAGES_URL, captured_at: new Date().toISOString(), markers, consoleLogs }, null, 2));
console.log(`\nArtifact: ${outFile}`);

// Navigate back to original URL
if (originalUrl && originalUrl !== PAGES_URL) {
  console.log(`\nRestoring tab to ${originalUrl}...`);
  await send("Page.navigate", { url: originalUrl });
  await new Promise(r => setTimeout(r, 2000));
}

ws.close();
process.exit(0);
