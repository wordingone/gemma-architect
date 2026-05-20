#!/usr/bin/env bun
/**
 * repro-1279.mjs — Deterministic repro harness for #1279 (fresh-device download stall)
 *
 * Opens a NEW CDP tab for the Pages URL — the existing dev-server tab is NEVER touched.
 * Clears site data, waits for the 90s stall watchdog (M2), takes DOM snapshot + screenshot,
 * then closes the repro tab.
 *
 * Usage: bun scripts/repro-1279.mjs
 */

import { writeFileSync, mkdirSync } from "fs";

const CDP_BASE     = "http://localhost:9222";
const PAGES_URL    = "https://wordingone.github.io/gemma-architect/";
const PAGES_ORIGIN = "https://wordingone.github.io";
const MAX_WAIT_MS  = 115_000;
const STATE_DIR    = "B:/M/gemma-architect-archie/state";

mkdirSync(STATE_DIR, { recursive: true });

// ── 1. Open a NEW tab for the repro (existing tab untouched) ──────────────────
const newTarget = await fetch(`${CDP_BASE}/json/new?${encodeURIComponent(PAGES_URL)}`, { method: "PUT" })
  .then(r => r.json()).catch(() => null);
if (!newTarget?.webSocketDebuggerUrl) {
  console.error("ERROR: could not open new CDP tab");
  process.exit(1);
}
console.log(`Repro tab opened: ${newTarget.id}`);

// ── 2. WS to new tab ──────────────────────────────────────────────────────────
const ws = new WebSocket(newTarget.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
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
await send("Page.bringToFront");

// ── 3. Clear site data before any content loads ───────────────────────────────
console.log(`Clearing site data for ${PAGES_ORIGIN}...`);
const clearRes = await send("Storage.clearDataForOrigin", {
  origin: PAGES_ORIGIN,
  storageTypes: "appcache,cookies,file_systems,indexeddb,local_storage,manifest,service_workers,cache_storage,all",
});
console.log("Clear result:", JSON.stringify(clearRes?.result));
await new Promise(r => setTimeout(r, 800));

// ── 4. Console capture + M2 trigger ──────────────────────────────────────────
const consoleLogs = [];
const t0 = Date.now();
let m2Resolve = null;
const m2Promise = new Promise(r => { m2Resolve = r; });

ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }

  if (x.method === "Runtime.consoleAPICalled") {
    const ts = Math.round(Date.now() - t0);
    const text = (x.params?.args ?? []).map(a => a.value ?? a.description ?? JSON.stringify(a)).join(" ");
    const type = x.params?.type ?? "log";
    consoleLogs.push({ ts, type, text });
    process.stdout.write(`  +${ts}ms [${type}] ${text.slice(0, 200)}\n`);
    if (text.includes("[gemma-cad] stall trace") && m2Resolve) {
      console.log(`\n  >>> M2 at +${ts}ms — capturing <<<`);
      m2Resolve(); m2Resolve = null;
    }
  }
  if (x.method === "Console.messageAdded") {
    const ts = Math.round(Date.now() - t0);
    const msg = x.params?.message ?? {};
    const text = msg.text ?? "";
    consoleLogs.push({ ts, type: msg.level ?? "log", text, url: msg.url });
    process.stdout.write(`  +${ts}ms [${msg.level}] ${text.slice(0, 200)}\n`);
  }
  if (x.method === "Page.frameNavigated") {
    const url = x.params?.frame?.url;
    if (url) console.log(`  +${Math.round(Date.now()-t0)}ms PAGE NAVIGATED → ${url}`);
  }
};

// ── 5. Navigate the repro tab to Pages URL ────────────────────────────────────
console.log(`\nNavigating repro tab to ${PAGES_URL}...`);
await send("Page.navigate", { url: PAGES_URL });
console.log("Waiting for M2 or 115s cap...\n");

await Promise.race([m2Promise, new Promise(r => setTimeout(r, MAX_WAIT_MS))]);
console.log(`\nCapture ended at +${Math.round(Date.now()-t0)}ms`);
await new Promise(r => setTimeout(r, 1000)); // let DOM settle after stall

// ── 6. DOM inspection (M5) ────────────────────────────────────────────────────
console.log("=== DOM INSPECTION ===");
const domResult = await send("Runtime.evaluate", {
  expression: `(() => {
    try {
      const overlay = document.getElementById('boot-screen');
      const allDivs = overlay ? [...overlay.querySelectorAll('div')] : [];
      const stalledDiv = allDivs.find(d => d.textContent?.includes('DOWNLOAD STALLED'));
      return JSON.stringify({
        bootScreenExists: !!overlay,
        overlayVisible: overlay ? overlay.style.opacity !== '0' : false,
        stalledTextVisible: !!stalledDiv,
        stalledText: stalledDiv?.textContent?.trim() ?? '',
      });
    } catch(e) { return JSON.stringify({ error: e.message }); }
  })()`,
  returnByValue: true,
});
let domInfo = {};
try { domInfo = JSON.parse(domResult?.result?.value ?? "{}"); } catch {}
console.log("boot-screen:", domInfo.bootScreenExists, "visible:", domInfo.overlayVisible);
console.log("STALLED text in DOM:", domInfo.stalledTextVisible, JSON.stringify(domInfo.stalledText));

// Cache state
const cacheResult = await send("Runtime.evaluate", {
  expression: `caches.keys().then(ks => JSON.stringify({ count: ks.length, keys: ks }))`,
  awaitPromise: true, returnByValue: true,
});
let cacheInfo = {};
try { cacheInfo = JSON.parse(cacheResult?.result?.value ?? "{}"); } catch {}
console.log("Cache API keys:", JSON.stringify(cacheInfo));

// Screenshot
const ssResult = await send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
const ssTs = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const ssPath = `${STATE_DIR}/repro-1279-screenshot-${ssTs}.jpg`;
if (ssResult?.result?.data) {
  writeFileSync(ssPath, Buffer.from(ssResult.result.data, "base64"));
  console.log(`Screenshot: ${ssPath}`);
}

// ── 7. Markers ────────────────────────────────────────────────────────────────
const markers = {
  m1_color_warn:      consoleLogs.some(l => l.text.includes("Unknown color model oklch")),
  m2_stall_trace:     consoleLogs.some(l => l.text.includes("[gemma-cad] stall trace") && l.text.includes('"event":"manifest"') && !l.text.includes('"event":"downloading"')),
  m3_power_pref:      consoleLogs.filter(l => l.text.includes("powerPreference option is currently ignored")).length,
  m4_cache_put_error: consoleLogs.some(l => l.text.includes("UnknownError") || l.text.includes("cache-put-error")),
  m5_stalled_ui:      !!domInfo.stalledTextVisible,
  returning_user:     consoleLogs.some(l => l.text.includes("returning-user") || l.text.includes("READY")),
  downloading_seen:   consoleLogs.some(l => l.text.includes('"event":"downloading"')),
};

console.log("\n=== MARKER ANALYSIS ===");
console.log("M1 THREE.Color warning:    ", markers.m1_color_warn ? "✓ SEEN" : "✗ NOT SEEN");
console.log("M2 stall trace (no dl):    ", markers.m2_stall_trace ? "✓ SEEN" : "✗ NOT SEEN");
console.log("M3 powerPreference warns:  ", markers.m3_power_pref >= 3 ? `✓ SEEN (${markers.m3_power_pref}×)` : `~ PARTIAL (${markers.m3_power_pref}×)`);
console.log("M4 Cache.put UnknownError: ", markers.m4_cache_put_error ? "✓ SEEN" : "✗ NOT SEEN");
console.log("M5 STALLED UI (DOM):       ", markers.m5_stalled_ui ? "✓ SEEN" : "✗ NOT SEEN");
console.log("");
console.log("returning-user (fast-path):", markers.returning_user ? "YES (cache not cleared?)" : "NO (correct)");
console.log("downloading events:        ", markers.downloading_seen ? "YES" : "NO");

const corePath = markers.m1_color_warn && markers.m2_stall_trace && markers.m5_stalled_ui && !markers.returning_user;
console.log(`\nSTALL PATH CONFIRMED: ${corePath ? "✓ YES" : "✗ NO"}`);

// Artifact
const ts2 = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
const outFile = `${STATE_DIR}/repro-1279-${ts2}.json`;
writeFileSync(outFile, JSON.stringify({ url: PAGES_URL, captured_at: new Date().toISOString(), markers, domInfo, cacheInfo, consoleLogs, screenshotPath: ssPath }, null, 2));
console.log(`Artifact: ${outFile}`);

// ── 8. Close repro tab (never touches the dev-server tab) ─────────────────────
ws.close();
await fetch(`${CDP_BASE}/json/close/${newTarget.id}`).catch(() => {});
console.log("Repro tab closed.");
process.exit(0);
