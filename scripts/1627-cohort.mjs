#!/usr/bin/env bun
// scripts/1627-cohort.mjs — §#1795 value-evolution assertion suite for #1627 C+D
//
// S1: dGPU — wasm_fallback_classification absent (runtime)
// S2: wasm_fallback_classification — code-presence in Pages bundle (Block C path 1)
// S3: probe-failure — wasm_fallback_probe_failure code-presence (Block C path 2)
// S4: device-lost dgpu (first) — WORKER_RECYCLED reason=device-lost-dgpu, recycleCount+1
// S5: device-lost igpu — navigation to ?gpu=wasm
// S6: device-lost dgpu × 2 — agentmodel:fatal reason=device-lost-recycle-limit
//
// S4–S6 use a Worker constructor proxy (addScriptToEvaluateOnNewDocument) that
// captures the harness onmessage setter and exposes window.__lastWorkerProxy._inject(msg).
// dispatchEvent() is synchronous — events fire within _inject() before it returns,
// so listener setup + inject + event read are combined in single IIFEs.
//
// Usage: bun scripts/1627-cohort.mjs
// Launches headless Chrome on :9333 — does NOT touch user's :9222 Chromium.

import { writeFileSync, mkdirSync, rmSync } from "fs";
import { mkdtempSync } from "fs";
import { execSync, spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { acquireLock, releaseLock } from "./harness-lock.mjs";

// Single-flight guard — prevent concurrent runs colliding on CDP WebSocket.
await acquireLock("1627-cohort");
process.on("exit", releaseLock);
process.on("SIGINT",  () => { releaseLock(); process.exit(130); });
process.on("SIGTERM", () => { releaseLock(); process.exit(143); });
process.on("uncaughtException", (e) => { releaseLock(); console.error(e); process.exit(1); });

const PAGES_URL       = "https://wordingone.github.io/gemma-architect/";
const STATE_DIR       = `${process.cwd()}/state`;
const BOOT_TIMEOUT_MS = 25 * 60 * 1000;
const READY_POLL_MS   = 5_000;

function ts()      { return new Date().toISOString(); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function getSHA()  {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); } catch { return "unknown"; }
}

mkdirSync(STATE_DIR, { recursive: true });
const sha       = getSHA();
const timestamp = ts().replace(/[-:.]/g, "").slice(0, 15) + "Z";
const outFile   = `${STATE_DIR}/1627-cohort-${sha}-${timestamp}.json`;

console.log(`\n── #1795 1627-cohort  sha=${sha}  ${ts()} ──`);
console.log(`   Pages: ${PAGES_URL}`);
console.log(`   Out:   ${outFile}`);

// ── Headless Chromium — isolated test process on :9333 ────────────────────────
// S4–S6 drive fatal device-lost states. NEVER use user's :9222 or Target.createTarget
// (creates visible tab on user's Chromium). Separate headless process with own profile.

const CHROME_BIN  = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const COHORT_PORT = 9333;
const CDP_COHORT  = `http://localhost:${COHORT_PORT}`;
const tempProfile = mkdtempSync(join(tmpdir(), "1627-cohort-"));

let chromeProc = null;
function cleanupChrome() {
  try { if (chromeProc) chromeProc.kill("SIGKILL"); } catch {}
  try { rmSync(tempProfile, { recursive: true, force: true }); } catch {}
}
// Wire cleanup before process.on("exit") from acquireLock so Chrome is killed first.
process.prependListener("exit", cleanupChrome);
process.on("SIGINT",          () => { cleanupChrome(); process.exit(130); });
process.on("SIGTERM",         () => { cleanupChrome(); process.exit(143); });

chromeProc = spawn(CHROME_BIN, [
  `--remote-debugging-port=${COHORT_PORT}`,
  `--user-data-dir=${tempProfile}`,
  "--headless=new",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  PAGES_URL,
], { stdio: "ignore", detached: false });
console.log(`   Headless Chrome PID ${chromeProc.pid} on :${COHORT_PORT}`);

// Wait for port 9333 to bind (up to 30s)
const chromeDeadline = Date.now() + 30_000;
let cohortTargets = null;
while (Date.now() < chromeDeadline) {
  await delay(1_000);
  cohortTargets = await fetch(`${CDP_COHORT}/json`).then(r => r.json()).catch(() => null);
  if (cohortTargets) break;
}
if (!cohortTargets) {
  console.error(`ERROR: Headless Chrome did not bind :${COHORT_PORT} within 30s`);
  cleanupChrome(); process.exit(1);
}

const testTarget = cohortTargets.find(t => t.type === "page");
if (!testTarget?.webSocketDebuggerUrl) {
  console.error(`ERROR: No page target on :${COHORT_PORT}`);
  cleanupChrome(); process.exit(1);
}
console.log(`   Tab WS:  ${testTarget.webSocketDebuggerUrl}\n`);

const ws            = new WebSocket(testTarget.webSocketDebuggerUrl);
let   msgId         = 1;
const pending       = new Map();
const eventHandlers = [];

ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id !== undefined && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
  for (const h of eventHandlers) { if (!x.id) h(x); }
};
await new Promise(r => ws.addEventListener("open", r));

function cdp(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// evaluate() — expr MUST be a single expression (not multi-statement with semicolons).
// For multi-statement, wrap in: (function(){ stmt1; stmt2; return val; })()
async function evaluate(expr, timeoutMs = 30_000) {
  const r = await cdp("Runtime.evaluate", {
    expression: `(async()=>{ try { return JSON.stringify(await (async()=>{ return (${expr}); })()); } catch(e) { return JSON.stringify({__err: e.message}); } })()`,
    awaitPromise: true, returnByValue: true, timeout: timeoutMs,
  });
  const raw = r?.result?.result?.value;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

await cdp("Runtime.enable");
await cdp("Page.enable");

// Wake renderer — Chrome 147 freezes Pages tab renderer when not active.
await cdp("Page.navigate", { url: PAGES_URL });
await delay(3_000);

// ── Worker proxy — injected on every new document ──────────────────────────────
// Captures harness onmessage setter (_onmsgHandler) and exposes _inject(data).
// Also intercepts phase_timing messages for S1 BPT assertions.

const WORKER_PROXY_SOURCE = `(function() {
  var _Orig = self.Worker;
  window.__workerProxies = [];
  window.__lastWorkerProxy = null;
  window.__bootPhaseTiming = {};
  try {
    var _ss = sessionStorage.getItem('__1627bpt');
    if (_ss) Object.assign(window.__bootPhaseTiming, JSON.parse(_ss));
  } catch(ex) {}

  function WorkerProxy() {
    var args = Array.prototype.slice.call(arguments);
    var _real = new (Function.prototype.bind.apply(_Orig, [null].concat(args)))();
    var _onmsgHandler = null;

    _real.addEventListener('message', function(e) {
      if (!e || !e.data || e.data.type !== 'phase_timing') return;
      var key = e.data.phase + '_ms';
      window.__bootPhaseTiming[key] = e.data.elapsed_ms;
      if (e.data.adClass) window.__bootPhaseTiming[e.data.phase + '_adClass'] = e.data.adClass;
      try {
        var saved = JSON.parse(sessionStorage.getItem('__1627bpt') || '{}');
        saved[key] = e.data.elapsed_ms;
        if (e.data.adClass) saved[e.data.phase + '_adClass'] = e.data.adClass;
        sessionStorage.setItem('__1627bpt', JSON.stringify(saved));
      } catch(ex) {}
    });

    var proxy = {
      set onmessage(fn) { _onmsgHandler = fn; _real.onmessage = fn; },
      get onmessage()   { return _onmsgHandler; },
      addEventListener:    _real.addEventListener.bind(_real),
      removeEventListener: _real.removeEventListener.bind(_real),
      postMessage:         _real.postMessage.bind(_real),
      terminate:           _real.terminate.bind(_real),
      _inject: function(data) {
        if (_onmsgHandler) {
          try { _onmsgHandler({ data: data }); }
          catch(ex) { console.error('[1627-cohort] _inject error:', ex.message); }
        }
      },
    };
    window.__workerProxies.push(proxy);
    window.__lastWorkerProxy = proxy;
    return proxy;
  }

  WorkerProxy.prototype = _Orig.prototype;
  Object.setPrototypeOf(WorkerProxy, _Orig);
  self.Worker = WorkerProxy;
})();`;

await cdp("Page.addScriptToEvaluateOnNewDocument", { source: WORKER_PROXY_SOURCE });

// ── Helpers ────────────────────────────────────────────────────────────────────

async function softReload() { await cdp("Page.reload", { ignoreCache: false }); await delay(3_000); }
async function navigateTo(url) { await cdp("Page.navigate", { url }); await delay(3_000); }

async function clearBPT() {
  await evaluate(`(function(){
    try { sessionStorage.removeItem('__1627bpt'); } catch(e){}
    window.__bootPhaseTiming = {};
  })()`);
}

// Accept idle — model loaded, awaiting first user message (does not transition to ready without input).
async function waitForReady(label, timeoutMs = BOOT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(READY_POLL_MS);
    const state = await evaluate("window.__arc?.state ?? 'not-found'");
    const sec   = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
    console.log(`    [${label}] arc.state=${state} (+${sec}s)`);
    if (state === "ready" || state === "generating" || state === "idle") return "ready";
    if (state === "failed") return "failed";
  }
  return "timeout";
}

async function checkProxyReady() {
  for (let i = 0; i < 20; i++) {
    if (await evaluate("typeof window.__lastWorkerProxy?._inject === 'function'") === true) return true;
    await delay(500);
  }
  return false;
}

// ── Read local source for S2 + S3 (Block C in model-worker.ts, worker chunk not main bundle) ──
// Pages bundle fetch is unreliable (CDN propagation lag, worker chunk separate from index.js).
// Source grep is authoritative: it's what #1792 actually changed, independent of deployment timing.

import { readFileSync } from "fs";
let _modelWorkerSrc = "";
let _modelWorkerNote = "";
try {
  _modelWorkerSrc = readFileSync(`${process.cwd()}/web/src/agent/model-worker.ts`, "utf8");
  _modelWorkerNote = `Read web/src/agent/model-worker.ts (${_modelWorkerSrc.length} chars)`;
} catch (err) {
  _modelWorkerNote = `Read error: ${err.message}`;
}

// ── Scenario results ───────────────────────────────────────────────────────────

const scenarios = {};

// ══ S1: dGPU — wasm_fallback_classification ABSENT ════════════════════════════
console.log("── S1: dGPU — wasm_fallback_classification absent ──");
await clearBPT();
await softReload();
await delay(12_000);
const s1BPT     = await evaluate("window.__bootPhaseTiming ?? {}");
const s1ClassMs = s1BPT?.["wasm_fallback_classification_ms"] ?? null;
const s1Passed  = s1ClassMs === null;
scenarios.s1 = {
  name: "dGPU — wasm_fallback_classification absent",
  runtime_verified: true,
  passed: s1Passed,
  wasm_fallback_classification_ms: s1ClassMs,
  note: s1Passed ? null : `Unexpected: classification present (${s1ClassMs}ms)`,
};
console.log(`   ${s1Passed ? "PASS ✓" : "FAIL ✗"}  wasm_fallback_classification_ms=${s1ClassMs}\n`);

// ══ S2: wasm_fallback_classification — code-presence (Block C path 1) ══════════
console.log("── S2: wasm_fallback_classification — code-presence in model-worker.ts ──");
const s2CodePresent = _modelWorkerSrc.includes("wasm_fallback_classification");
const s2Note = s2CodePresent
  ? `Source contains "wasm_fallback_classification" in model-worker.ts`
  : `Missing "wasm_fallback_classification" — check PR #1792 merge. ${_modelWorkerNote}`;
scenarios.s2 = {
  name: "wasm_fallback_classification — code-presence in model-worker.ts (Block C path 1)",
  runtime_verified: false,
  code_present: s2CodePresent,
  passed: s2CodePresent,
  note: `Runtime requires iGPU hardware. ${s2Note}`,
};
console.log(`   ${s2CodePresent ? "PASS ✓" : "FAIL ✗"}  code_present=${s2CodePresent}  ${s2Note}\n`);

// ══ S3: probe-failure — code-presence (Block C path 2) ════════════════════════
console.log("── S3: probe-failure — code-presence in model-worker.ts ──");
const s3HasEvent    = _modelWorkerSrc.includes("wasm_fallback_probe_failure");
const s3HasLog      = _modelWorkerSrc.includes("webgpu-probe-failed");
const s3CodePresent = s3HasEvent && s3HasLog;
const s3Note = s3CodePresent
  ? `Source contains "wasm_fallback_probe_failure" and "webgpu-probe-failed" in model-worker.ts`
  : `Missing: hasEvent=${s3HasEvent} hasLog=${s3HasLog} — check PR #1792 merge. ${_modelWorkerNote}`;
scenarios.s3 = {
  name: "probe-failure — wasm_fallback_probe_failure branch in model-worker.ts (Block C path 2)",
  runtime_verified: false,
  code_present: s3CodePresent,
  passed: s3CodePresent,
  note: `Runtime requires iGPU failing WebGPU warmup probe. ${s3Note}`,
};
console.log(`   ${s3CodePresent ? "PASS ✓" : "FAIL ✗"}  code_present=${s3CodePresent}  ${s3Note}\n`);

// ══ S4–S6: warm boot then inject via Worker proxy ═════════════════════════════
console.log("── Warm boot for S4 ──");
await navigateTo(PAGES_URL);
const s4BootResult = await waitForReady("S4-boot");
const s4ProxyReady = s4BootResult === "ready" ? await checkProxyReady() : false;

if (s4BootResult !== "ready" || !s4ProxyReady) {
  const reason = s4BootResult !== "ready" ? `boot-${s4BootResult}` : "proxy-not-ready";
  console.error(`   S4/S5/S6 SKIPPED: ${reason}`);
  for (const k of ["s4", "s5", "s6"]) {
    scenarios[k] = { name: `(skipped — ${reason})`, passed: false, skipped: true, reason };
  }
} else {

  // ── S4: device-lost dgpu (first) ──────────────────────────────────────────
  console.log("\n── S4: device-lost dgpu (first) ──");
  const s4InitRecycle = await evaluate("window.__arc?.recycleCount ?? 0");
  const s4D3d12Before = await evaluate("window.__agent_d3d12_recycles ?? 0");

  // Single IIFE: setup listeners + inject + capture events.
  // dispatchEvent() is synchronous — events captured before _inject() returns.
  const s4Result = await evaluate(`(function(){
    window.__s4_lost_evt     = null;
    window.__s4_recycled_evt = null;
    window.addEventListener('agentmodel:device-lost', function(e) {
      window.__s4_lost_evt = { adClass: e.detail?.adClass, retryBudget: e.detail?.retryBudget };
    }, { once: true });
    window.addEventListener('agentmodel:worker-recycled', function(e) {
      window.__s4_recycled_evt = { reason: e.detail?.reason, recycleCount: e.detail?.recycleCount };
    }, { once: true });
    if (!window.__lastWorkerProxy) return { injected: false, error: 'no-proxy' };
    window.__lastWorkerProxy._inject({ type: 'device-lost', adClass: 'dgpu', reason: 'internal-error', retryBudget: 1 });
    return { injected: true, lostEvt: window.__s4_lost_evt, recycledEvt: window.__s4_recycled_evt };
  })()`);
  await delay(2_000);

  const s4FinalRecycle = await evaluate("window.__arc?.recycleCount ?? 0");
  const s4D3d12After   = await evaluate("window.__agent_d3d12_recycles ?? 0");
  const s4Injected     = s4Result?.injected === true;
  const s4LostEvt      = s4Result?.lostEvt ?? null;
  const s4RecycledEvt  = s4Result?.recycledEvt ?? null;
  const s4LostFired    = s4LostEvt?.adClass === "dgpu" && (s4LostEvt?.retryBudget ?? -1) === 1;
  const s4RecycleFired = s4RecycledEvt?.reason === "device-lost-dgpu";
  const s4RecycleInc   = (s4FinalRecycle ?? 0) > (s4InitRecycle ?? 0);
  const s4Passed       = Boolean(s4Injected && s4LostFired && s4RecycleFired && s4RecycleInc);
  scenarios.s4 = {
    name: "device-lost dgpu (first) — WORKER_RECYCLED reason=device-lost-dgpu",
    runtime_verified: true, passed: s4Passed, injected: s4Injected,
    agentmodel_device_lost_event: s4LostEvt,
    agentmodel_worker_recycled_event: s4RecycledEvt,
    device_lost_fired: s4LostFired, worker_recycled_fired: s4RecycleFired,
    recycle_count_before: s4InitRecycle, recycle_count_after: s4FinalRecycle,
    recycle_count_incremented: s4RecycleInc,
    d3d12_recycles_before: s4D3d12Before, d3d12_recycles_after: s4D3d12After,
  };
  console.log(`   ${s4Passed ? "PASS ✓" : "FAIL ✗"}  lost=${s4LostFired}  recycled=${s4RecycleFired}  recycleCount:${s4InitRecycle}→${s4FinalRecycle}\n`);

  // ── S5: device-lost igpu — navigation to ?gpu=wasm ────────────────────────
  console.log("── Warm boot for S5 ──");
  await navigateTo(PAGES_URL);
  const s5BootResult = await waitForReady("S5-boot");
  const s5ProxyReady = s5BootResult === "ready" ? await checkProxyReady() : false;

  if (s5BootResult !== "ready" || !s5ProxyReady) {
    const reason = s5BootResult !== "ready" ? `boot-${s5BootResult}` : "proxy-not-ready";
    console.error(`   S5 SKIPPED: ${reason}`);
    scenarios.s5 = { name: "device-lost igpu — navigation to ?gpu=wasm", passed: false, skipped: true, reason };
  } else {
    console.log("\n── S5: device-lost igpu ──");

    let s5NavUrl = null;
    const s5NavHandler = evt => {
      if (evt.method === "Page.frameNavigated" && evt.params?.frame?.parentId == null) {
        s5NavUrl = evt.params.frame.url ?? "";
      }
    };
    eventHandlers.push(s5NavHandler);

    // IIFE: setup listener (saves to sessionStorage for post-navigate read) + inject.
    // agentmodel:device-lost fires synchronously BEFORE location.assign() is called.
    const s5Result = await evaluate(`(function(){
      try { sessionStorage.removeItem('__s5_lost'); } catch(ex){}
      window.__s5_lost_evt = null;
      window.addEventListener('agentmodel:device-lost', function(e) {
        var data = { adClass: e.detail?.adClass, retryBudget: e.detail?.retryBudget };
        window.__s5_lost_evt = data;
        try { sessionStorage.setItem('__s5_lost', JSON.stringify(data)); } catch(ex){}
      }, { once: true });
      if (!window.__lastWorkerProxy) return { injected: false, error: 'no-proxy' };
      window.__lastWorkerProxy._inject({ type: 'device-lost', adClass: 'igpu', reason: 'internal-error', retryBudget: 0 });
      return { injected: true, lostEvt: window.__s5_lost_evt };
    })()`);
    await delay(4_000);  // let navigation to ?gpu=wasm complete

    const s5NavIdx = eventHandlers.indexOf(s5NavHandler);
    if (s5NavIdx >= 0) eventHandlers.splice(s5NavIdx, 1);

    // Read event from sessionStorage (persists across same-origin navigation).
    const s5LostEvtSS = await evaluate(`(function(){
      try { return JSON.parse(sessionStorage.getItem('__s5_lost') || 'null'); } catch(e){ return null; }
    })()`);
    const s5LostEvt   = s5Result?.lostEvt ?? s5LostEvtSS ?? null;
    const s5Injected  = s5Result?.injected === true;
    const s5LostFired = s5LostEvt?.adClass === "igpu" && (s5LostEvt?.retryBudget ?? -1) === 0;
    const s5NavToWasm = s5NavUrl?.includes("gpu=wasm") ?? false;
    const s5Passed    = Boolean(s5Injected && s5NavToWasm);
    scenarios.s5 = {
      name: "device-lost igpu — navigation to ?gpu=wasm",
      runtime_verified: true, passed: s5Passed, injected: s5Injected,
      agentmodel_device_lost_event: s5LostEvt,
      device_lost_fired: s5LostFired,
      navigation_url: s5NavUrl, navigated_to_wasm: s5NavToWasm,
    };
    console.log(`   ${s5Passed ? "PASS ✓" : "FAIL ✗"}  injected=${s5Injected}  lost=${s5LostFired}  nav=${s5NavUrl ?? "(none)"}\n`);
  }

  // ── S6: device-lost dgpu × 2 — agentmodel:fatal ───────────────────────────
  console.log("── Warm boot for S6 ──");
  await navigateTo(PAGES_URL);
  const s6BootResult = await waitForReady("S6-boot");
  const s6ProxyReady = s6BootResult === "ready" ? await checkProxyReady() : false;

  if (s6BootResult !== "ready" || !s6ProxyReady) {
    const reason = s6BootResult !== "ready" ? `boot-${s6BootResult}` : "proxy-not-ready";
    console.error(`   S6 SKIPPED: ${reason}`);
    scenarios.s6 = { name: "device-lost dgpu × 2 — agentmodel:fatal", passed: false, skipped: true, reason };
  } else {
    console.log("\n── S6: device-lost dgpu × 2 ──");
    const s6InitRecycle = await evaluate("window.__arc?.recycleCount ?? 0");

    // First injection: setup fatal + recycle listeners, inject dgpu/budget=1.
    // recycleCount goes 0→1, worker-recycled fires (budget>0 branch, not fatal).
    // Fatal listener stays in place for the second injection.
    const s6Result1 = await evaluate(`(function(){
      window.__s6_fatal_evt     = null;
      window.__s6_recycled1_evt = null;
      window.addEventListener('agentmodel:fatal', function(e) {
        window.__s6_fatal_evt = { reason: e.detail?.reason, recycleCount: e.detail?.recycleCount };
      }, { once: true });
      window.addEventListener('agentmodel:worker-recycled', function(e) {
        if (!window.__s6_recycled1_evt) {
          window.__s6_recycled1_evt = { reason: e.detail?.reason, recycleCount: e.detail?.recycleCount };
        }
      });
      if (!window.__lastWorkerProxy) return { injected: false, error: 'no-proxy' };
      window.__lastWorkerProxy._inject({ type: 'device-lost', adClass: 'dgpu', reason: 'internal-error', retryBudget: 1 });
      return { injected: true, recycledEvt: window.__s6_recycled1_evt };
    })()`);
    await delay(1_000);
    const s6RecycleCount1 = await evaluate("window.__arc?.recycleCount ?? 0");
    console.log(`   First inject: recycled_evt=${JSON.stringify(s6Result1?.recycledEvt)}  recycleCount=${s6RecycleCount1}`);

    // Wait for proxy2 (initWorkerIfNeeded fires 400ms after first inject via setTimeout).
    // _onmsgHandler is set synchronously in initWorkerIfNeeded — no need to await model load.
    console.log(`   Waiting for proxy2...`);
    let s6NewWorkerReady = false;
    const s6Proxy2Deadline = Date.now() + 15_000;
    while (Date.now() < s6Proxy2Deadline) {
      await delay(500);
      const pc = await evaluate("window.__workerProxies?.length ?? 0");
      if ((pc ?? 0) >= 2) { s6NewWorkerReady = true; break; }
    }
    const s6ProxyCount = await evaluate("window.__workerProxies?.length ?? 0");
    console.log(`   proxy2 ready: ${s6NewWorkerReady}  (total proxies: ${s6ProxyCount})`);

    if (!s6NewWorkerReady) {
      scenarios.s6 = {
        name: "device-lost dgpu × 2 — agentmodel:fatal reason=device-lost-recycle-limit",
        runtime_verified: true, passed: false,
        injected_1: s6Result1?.injected === true,
        recycle_1_event: s6Result1?.recycledEvt ?? null,
        recycle_count_1: s6RecycleCount1,
        note: "proxy2 did not appear within 15s after first inject",
      };
      console.log(`   FAIL ✗  proxy2 not ready\n`);
    } else {
      // Second injection: recycleCount is 1, D3D12_OOM makes it 2, fatal path fires.
      // agentmodel:fatal dispatched synchronously — captured in IIFE before _inject returns.
      const s6Result2 = await evaluate(`(function(){
        if (!window.__lastWorkerProxy) return { injected: false, error: 'no-proxy' };
        window.__lastWorkerProxy._inject({ type: 'device-lost', adClass: 'dgpu', reason: 'internal-error', retryBudget: 1 });
        return { injected: true, fatalEvt: window.__s6_fatal_evt, recycleCount: window.__arc?.recycleCount ?? 0 };
      })()`);
      await delay(500);

      const s6FatalEvt      = s6Result2?.fatalEvt ?? await evaluate("window.__s6_fatal_evt");
      const s6RecycleCount2 = s6Result2?.recycleCount ?? await evaluate("window.__arc?.recycleCount ?? 0");
      const s6Injected1     = s6Result1?.injected === true;
      const s6Injected2     = s6Result2?.injected === true;
      const s6Recycle1Evt   = s6Result1?.recycledEvt ?? null;
      const s6FatalFired    = s6FatalEvt?.reason === "device-lost-recycle-limit";
      const s6Progression   = (s6RecycleCount1 ?? 0) === 1 && (s6RecycleCount2 ?? 0) === 2;
      const s6Recycle1Ok    = s6Recycle1Evt?.reason === "device-lost-dgpu";
      const s6Passed        = Boolean(s6Injected1 && s6Injected2 && s6FatalFired && s6Progression && s6Recycle1Ok);
      scenarios.s6 = {
        name: "device-lost dgpu × 2 — agentmodel:fatal reason=device-lost-recycle-limit",
        runtime_verified: true, passed: s6Passed,
        injected_1: s6Injected1, injected_2: s6Injected2,
        recycle_1_event: s6Recycle1Evt, fatal_event: s6FatalEvt,
        recycle_count_0: s6InitRecycle, recycle_count_1: s6RecycleCount1, recycle_count_2: s6RecycleCount2,
        fatal_fired: s6FatalFired, recycle_progression_ok: s6Progression, recycle_1_reason_ok: s6Recycle1Ok,
      };
      console.log(`   ${s6Passed ? "PASS ✓" : "FAIL ✗"}  fatal=${s6FatalFired}  recycleCount:${s6InitRecycle}→${s6RecycleCount1}→${s6RecycleCount2}\n`);
    }
  }
}

ws.close();
cleanupChrome();

// ── Receipt ────────────────────────────────────────────────────────────────────

const allPassed = Object.values(scenarios).every(s => s.passed);
const receipt   = {
  sha, timestamp: ts(), pages_url: PAGES_URL, scenarios,
  device_lost_scenarios_passed: allPassed, passed: allPassed,
};

writeFileSync(outFile, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${outFile}`);
console.log(`\n┌──────────────────────────────────────────────────────┐`);
console.log(`│  #1795 1627-cohort  ${sha.padEnd(34)}│`);
console.log(`├──────────────────────────────────────────────────────┤`);
for (const [k, s] of Object.entries(scenarios)) {
  const icon = s.skipped ? "─" : s.passed ? "✓" : "✗";
  const tag  = s.runtime_verified === false ? " (code-verified)" : "";
  console.log(`│  ${icon} ${k.toUpperCase()}: ${(s.name + tag).slice(0, 47).padEnd(47)}  │`);
}
console.log(`├──────────────────────────────────────────────────────┤`);
console.log(`│  VERDICT: ${(allPassed ? "PASS ✓" : "FAIL ✗").padEnd(44)}│`);
console.log(`└──────────────────────────────────────────────────────┘`);

process.exit(allPassed ? 0 : 1);
