#!/usr/bin/env bun
// verify-cache-put-1500.mjs — Regression test for #1500 (cache.put() UnknownError fix)
//
// Verifies that the monkey-patch in model-worker.ts correctly handles cache.put()
// failures so UnknownError never propagates as an unhandled rejection.
//
// Two #1500 fix paths:
//   A) Quota probe: navigator.storage.estimate() → free < 5.5GB → useBrowserCache=false
//      (no cache.put() calls made at all)
//   B) Monkey-patch: cache.put() throws → caught → console.warn + useBrowserCache=false
//      (shard continues in-memory, download proceeds)
//
// Pass condition: zero UnknownError in unhandled exceptions.
// Either fix path produces a PASS — the assertion is about error containment.
//
// Usage:
//   bun scripts/verify-cache-put-1500.mjs
//   bun scripts/verify-cache-put-1500.mjs --target-url http://localhost:5175/
//   bun scripts/verify-cache-put-1500.mjs --target-url https://wordingone.github.io/gemma-architect/
//   bun scripts/verify-cache-put-1500.mjs --timeout 300   (seconds; default 120)
//
// Raw CDP WS, no playwright dep (pattern from gemma-verify-raw.mjs).
// Single-tab discipline: attaches to existing tab only, never opens a new one.

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const CDP_BASE  = "http://localhost:9222";
const STATE_DIR = `${process.cwd()}/state`;

const targetUrlIdx = process.argv.indexOf("--target-url");
const TARGET_URL   = targetUrlIdx !== -1 ? process.argv[targetUrlIdx + 1] : null;

const timeoutIdx   = process.argv.indexOf("--timeout");
const TIMEOUT_S    = timeoutIdx !== -1 ? Number(process.argv[timeoutIdx + 1]) : 120;
const TIMEOUT_MS   = TIMEOUT_S * 1000;

function getSHA() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

// ── CDP plumbing ──────────────────────────────────────────────────────────────

const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) {
  console.error("ERROR: Cannot reach CDP at :9222 — is the shared browser running?");
  process.exit(1);
}

const pages = targets.filter(t => t.type === "page");

// Pick target tab: prefer --target-url match, else dev server, else first page
let tab = null;
if (TARGET_URL) {
  const host = new URL(TARGET_URL).host;
  tab = pages.find(t => t.url?.includes(host));
  if (!tab) {
    console.error(`ERROR: no page tab matching '${TARGET_URL}' found.`);
    console.error("Available pages:", pages.map(t => t.url).join(", "));
    process.exit(1);
  }
} else {
  tab = pages.find(t => t.url?.includes("localhost:5175"))
     ?? pages.find(t => t.url?.includes("gemma-architect"))
     ?? pages[0];
  if (!tab) {
    console.error("ERROR: no usable page tab found in shared browser.");
    process.exit(1);
  }
}

const tabOrigin = new URL(tab.url).origin;
console.log(`Attaching to: ${tab.url} (origin: ${tabOrigin})`);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const listeners = {};

ws.onmessage = raw => {
  const x = JSON.parse(raw.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  if (x.method && listeners[x.method]) {
    for (const fn of listeners[x.method]) fn(x.params);
  }
};
await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function on(method, fn) {
  listeners[method] = listeners[method] ?? [];
  listeners[method].push(fn);
}

async function evalR(expr, awaitPromise = false) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise,
    timeout: 15000,
  });
  if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.exception?.description?.slice(0, 120) };
  return { val: r.result?.result?.value };
}

// ── Enable domains ────────────────────────────────────────────────────────────

await send("Runtime.enable");
await send("Page.enable");

// ── Collect evidence ──────────────────────────────────────────────────────────

const consoleMessages = [];       // all console.* from any context (incl. workers)
const unhandledErrors = [];       // unhandled promise rejections / uncaught exceptions
let modelReady        = false;
let monkeyPatchFired  = false;    // [model-worker] cache.put() rejected
let quotaProbeFired   = false;    // quota probe disabled cache before any download
let firstWorkerMsg    = null;     // timestamp of first worker activity

on("Runtime.consoleAPICalled", e => {
  const text = (e.args ?? []).map(a => a.value ?? a.description ?? "").join(" ");
  const entry = { ts: Date.now(), type: e.type, text: text.slice(0, 300) };
  consoleMessages.push(entry);

  if (text.includes("[model-worker] cache.put() rejected")) {
    monkeyPatchFired = true;
    console.log("  [OBSERVE] monkey-patch fired:", text.slice(0, 120));
  }
  if (text.includes("agentmodel:ready") || text.includes("[test] model-ready")) {
    modelReady = true;
    console.log("  [OBSERVE] model-ready signal received");
  }
  if (text.includes("[model-worker]") && !firstWorkerMsg) {
    firstWorkerMsg = Date.now();
    console.log("  [OBSERVE] first worker message:", text.slice(0, 80));
  }
  // Detect quota probe path: tfEnv.useBrowserCache set to false before any shard download
  if (text.includes("useBrowserCache") || text.includes("quota") || text.includes("cache disabled")) {
    console.log("  [OBSERVE] cache-related log:", text.slice(0, 120));
  }
});

on("Runtime.exceptionThrown", e => {
  const desc = e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? "unknown";
  const entry = { ts: Date.now(), desc: desc.slice(0, 300) };
  unhandledErrors.push(entry);
  if (desc.includes("UnknownError")) {
    console.log("  [OBSERVE] UnknownError in unhandled exception:", desc.slice(0, 120));
  }
});

// Inject model-ready event listener before page scripts run
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.addEventListener("agentmodel:ready", () => {
      console.log("[test] model-ready");
    }, { once: true });
    window.addEventListener("agentmodel:boot-complete", () => {
      console.log("[test] boot-complete");
    }, { once: true });
  `
});

// ── Cold-cache: clear all Cache API entries for this origin ───────────────────

console.log("Clearing Cache API entries for origin:", tabOrigin);
const clearResult = await evalR(
  `caches.keys().then(ks => {
    const targets = ks.filter(k => k.includes('gemma') || k.includes('onnx') || k.includes('transformers') || k.includes('hf-cache'));
    return Promise.all(targets.map(k => caches.delete(k))).then(results => ({
      cleared: targets,
      count: results.filter(Boolean).length
    }));
  })`,
  true // awaitPromise
);
if (clearResult.err) {
  console.warn("  cache clear error:", clearResult.err);
} else {
  console.log("  Cleared caches:", clearResult.val);
}

// Also try Storage.clearDataForOrigin at CDP level (belt-and-suspenders)
const storClear = await send("Storage.clearDataForOrigin", {
  origin: tabOrigin,
  storageTypes: "cache_storage",
}).catch(() => null);
if (storClear?.result) console.log("  Storage.clearDataForOrigin: OK");

// ── Reload page ───────────────────────────────────────────────────────────────

console.log("Reloading page (cold-cache)...");
const reloadStart = Date.now();
await send("Page.reload", { ignoreCache: true });

// Wait for loadEventFired (page HTML parsed + JS started)
await new Promise(resolve => {
  on("Page.loadEventFired", resolve);
  setTimeout(resolve, 30_000); // max 30s for load event
});
console.log(`Page loaded (${Date.now() - reloadStart}ms). Waiting for model init...`);

// ── Wait for model-ready or timeout ──────────────────────────────────────────

const deadline = reloadStart + TIMEOUT_MS;
while (!modelReady && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 2_000));

  // Poll badge as secondary signal
  const badge = await evalR("document.querySelector('#ai-model-badge')?.textContent ?? ''");
  const badgeText = badge.val ?? "";
  if (badgeText.includes("LIVE") || badgeText.includes("READY")) {
    modelReady = true;
    console.log("  [OBSERVE] badge shows LIVE/READY:", badgeText.slice(0, 60));
    break;
  }
  if (badgeText && !badgeText.includes("Connecting")) {
    process.stdout.write(".");
  }

  // Check quota probe: useBrowserCache should be false if quota was low
  const ucb = await evalR(`
    (() => {
      try {
        // Check if the model worker has disabled browser cache
        // Note: tfEnv is in worker scope; check via storage estimate proxy
        return navigator.storage ? 'storage-api-available' : 'no-storage-api';
      } catch { return 'err'; }
    })()
  `);
  if (ucb.val === 'storage-api-available' && !firstWorkerMsg && Date.now() > reloadStart + 30_000) {
    // 30s after reload, no worker activity — check if quota probe short-circuited
    const est = await evalR(
      "navigator.storage.estimate().then(e => JSON.stringify({quota:e.quota,usage:e.usage}))",
      true
    );
    if (est.val) {
      const { quota, usage } = JSON.parse(est.val);
      const freeMB = Math.round((quota - usage) / 1024 / 1024);
      console.log(`  [OBSERVE] storage estimate: quota=${Math.round(quota/1e9)}GB free=${freeMB}MB usage=${Math.round(usage/1e9)}GB`);
      if (quota > 0 && (quota - usage) < 5_500_000_000) {
        quotaProbeFired = true;
        console.log("  [OBSERVE] quota probe path: free space < 5.5GB → caching disabled before load");
      }
    }
    break; // no worker activity after 30s — quota probe likely disabled load
  }
}

console.log(`\nWait complete (${Math.round((Date.now() - reloadStart) / 1000)}s elapsed).`);

// ── Assertions ────────────────────────────────────────────────────────────────

const unknownErrorsInUnhandled = unhandledErrors.filter(e => e.desc.includes("UnknownError"));
const unknownErrorsInConsole   = consoleMessages.filter(
  e => e.text.includes("UnknownError") && !e.text.includes("[model-worker] cache.put() rejected")
);

const passed = unknownErrorsInUnhandled.length === 0 && unknownErrorsInConsole.length === 0;

// ── Report ────────────────────────────────────────────────────────────────────

const sha       = getSHA();
const timestamp = new Date().toISOString();
const result = {
  sha,
  timestamp,
  issue: "#1500",
  description: "cache.put() UnknownError monkey-patch regression",
  tabUrl: tab.url,
  tabOrigin,
  passed,
  modelReady,
  monkeyPatchFired,
  quotaProbeFired,
  unknownErrorsInUnhandled,
  unknownErrorsInConsole,
  allConsoleMessages: consoleMessages.filter(m =>
    m.text.includes("[model-worker]") ||
    m.text.includes("[test]") ||
    m.text.includes("UnknownError") ||
    m.text.includes("cache") ||
    m.text.includes("quota")
  ),
};

console.log("\n── #1500 Regression Result ────────────────────────────────────────");
console.log("  passed:             ", passed);
console.log("  modelReady:         ", modelReady);
console.log("  monkeyPatchFired:   ", monkeyPatchFired, "(cache.put() rejected + caught)");
console.log("  quotaProbeFired:    ", quotaProbeFired,  "(low-quota path: cache skipped upfront)");
console.log("  unhandledUnknownErr:", unknownErrorsInUnhandled.length);
console.log("  consoleUnknownErr:  ", unknownErrorsInConsole.length, "(excluding [model-worker] prefix)");

if (!passed) {
  console.error("\nFAIL: UnknownError escaped containment:");
  for (const e of [...unknownErrorsInUnhandled, ...unknownErrorsInConsole]) {
    console.error("  ", e.desc || e.text);
  }
}

mkdirSync(STATE_DIR, { recursive: true });
const outFile = `${STATE_DIR}/verify-cache-put-1500-${sha}-${timestamp.replace(/[:.]/g, "").slice(0, 16)}.json`;
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(`\nReceipt: ${outFile}`);

ws.close();
process.exit(passed ? 0 : 1);
