#!/usr/bin/env bun
// phase-j-verify.mjs — Phase J cold-cache Pages verification.
//
// Verifies ARC lifecycle health on the live Pages URL:
//   1. Connects to shared-browser :9222, finds Pages tab
//   2. Reloads tab (ensures post-deploy code)
//   3. Captures console during boot; flags [ARC] invalid-transition errors
//   4. Waits for model ready (window.__arc.state === 'ready')
//   5. Sends 5 chat prompts; watches for GENERATE_DONE vs WORKER_RECYCLED
//   6. Writes receipt to state/phase-j-verify-<sha>-<ts>.json
//
// Usage: bun scripts/phase-j-verify.mjs [--no-reload] [--cold] [--prompts N]
//   --cold     : true cold-cache via Storage.clearDataForOrigin (model re-downloads ~2.5GB)
//   --no-reload: skip reload entirely (use current tab state, warm)
//   --prompts N: run N prompts instead of default 5
//
// Requires: shared browser running (bun run shared-browser:start)

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { CDP_PORT, CDP_BASE } from "./ports.mjs";
import { installPromptHandlers } from "../../avir/infra/skills/cdp-prompts/handler.mjs"; // §#1704+#1708

const PAGES_URL   = "https://wordingone.github.io/gemma-architect/";
const STATE_DIR   = `${process.cwd()}/state`;
const NO_RELOAD   = process.argv.includes("--no-reload");
// Cold-cache is now DEFAULT (user directive 2026-05-23: "every test cold-cache").
// Pass --warm to skip cache-clearing (for local iteration only; NOT valid as a gate test).
// Cold-cache: clear HTTP disk cache + cookies + Cache API + IndexedDB before reload.
// Model re-downloads (~2.5GB) — expect 15-20min boot. boot_ms < 150000 → receipt INVALID.
const COLD_CACHE  = !process.argv.includes("--warm") && !NO_RELOAD;
const T1_ONLY     = process.argv.includes("--t1-only") || process.argv.includes("--cold-cache-wasm-cohort");
const WASM_COHORT = process.argv.includes("--cold-cache-wasm-cohort"); // §#1637 Path 2 test
const PROMPT_N    = Number(process.argv.find(a => a.startsWith("--prompts="))?.split("=")[1] ?? 5);
const BOOT_TIMEOUT_MS  = COLD_CACHE ? 65 * 60 * 1000 : 10 * 60 * 1000;  // 65 min cold, 10 min warm
const TURN_TIMEOUT_MS  = 10 * 60 * 1000;  // 10 min — covers recycle+auto-retry

// #1476/#1482: use STARTER_PROMPTS sequence per user directive 2026-05-21.
// Turn 1: full architectural goal (tests goal-mode + multi-turn dispatch).
// Turn 2: scene-query (tests NL-only response path — no dispatches expected).
// Turns 3-5: continuation goals.
const STARTER_PROMPTS = [
  "Build a two-story residential house, 26' wide by 20' deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs.",
  "What's currently in the scene?",
  "Add a single-car garage attached to the south wall, 16 feet wide by 13 feet deep.",
  "What's currently in the scene?",
  "Add a garden wall along the north boundary, 40 feet long and 3 feet tall.",
];
const DEMO_PROMPTS = T1_ONLY ? [STARTER_PROMPTS[0]] : STARTER_PROMPTS.slice(0, PROMPT_N);

function ts() { return new Date().toISOString(); }
function getSHA() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

mkdirSync(STATE_DIR, { recursive: true });
const sha       = getSHA();
const timestamp = ts().replace(/[-:.]/g, "").slice(0, 15) + "Z";
const outFile   = `${STATE_DIR}/phase-j-verify-${sha}-${timestamp}.json`;

console.log(`\n── Phase J verify  sha=${sha}  ${ts()} ──`);
console.log(`   Pages: ${PAGES_URL}`);
console.log(`   Prompts: ${PROMPT_N}  boot-timeout: ${BOOT_TIMEOUT_MS/60000}m  turn-timeout: ${TURN_TIMEOUT_MS/60000}m`);
console.log(`   Mode: ${WASM_COHORT ? "WASM-COHORT (cold-cache + igpu-mock + Path-2 click)" : COLD_CACHE ? "COLD-CACHE (HTTP+cookies+Storage — gate default)" : NO_RELOAD ? "NO-RELOAD (warm — INVALID as gate test)" : "WARM (--warm — INVALID as gate test)"}${T1_ONLY && !WASM_COHORT ? "  [t1-only]" : ""}`);

// ── CDP connection ─────────────────────────────────────────────────────────────

const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) {
  console.error(`ERROR: Cannot reach CDP at ${CDP_BASE} — is shared browser running?`);
  process.exit(1);
}

const pagesHost = new URL(PAGES_URL).hostname;
const target = targets.find(t => t.type === "page" && t.url?.includes(pagesHost));
if (!target?.webSocketDebuggerUrl) {
  console.error(`ERROR: No Pages tab found at ${PAGES_URL}`);
  console.error("Tabs:", targets.filter(t => t.type === "page").map(t => t.url));
  process.exit(1);
}
console.log(`   Tab: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const eventHandlers = [];

ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id !== undefined && pending.has(x.id)) {
    pending.get(x.id)(x);
    pending.delete(x.id);
  }
  // dispatch to event handlers
  for (const h of eventHandlers) {
    if (!x.id) h(x);
  }
};

await new Promise(r => ws.addEventListener("open", r));

function cdp(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr, timeoutMs = 60000) {
  const r = await cdp("Runtime.evaluate", {
    expression: `(async()=>{ try { return JSON.stringify(await (async()=>{ return (${expr}); })()); } catch(e) { return JSON.stringify({__err: e.message}); } })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  const raw = r?.result?.result?.value;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Enable domains ─────────────────────────────────────────────────────────────

await cdp("Runtime.enable");
await cdp("Log.enable");
await cdp("Page.enable");

// §#1704+#1708: install CDP prompt handlers immediately after Page.enable, before any navigation.
// Covers: all JS dialogs (beforeunload/alert/confirm/prompt) + all browser permission types
// + downloads. Past PASS receipts were user-assisted (user manually clicking "Leave site?").
const _cdpDownloadDir = `${STATE_DIR}/downloads`;
mkdirSync(_cdpDownloadDir, { recursive: true });
const _cdpPromptState = await installPromptHandlers(cdp, eventHandlers, {
  origin: "https://wordingone.github.io",
  downloadPath: _cdpDownloadDir,
});

// ── Collect console messages ───────────────────────────────────────────────────

const consoleErrors = [];
const arcInvalidTransitions = [];
const bufferManagerErrors = [];
const cachePutErrors = [];      // M1: [model-worker] cache.put() rejected → S1 cascade trigger
const compactEvents = [];

eventHandlers.push(evt => {
  // Runtime.consoleAPICalled
  if (evt.method === "Runtime.consoleAPICalled") {
    const level = evt.params?.type ?? "log";
    const args  = (evt.params?.args ?? []).map(a => a.value ?? a.description ?? "").join(" ");
    if (level === "error" || level === "warn" || args.includes("[ARC] invalid transition") || args.includes("buffer_manager") || args.includes("[#1463]") || args.includes("cache.put()")) {
      consoleErrors.push({ ts: ts(), level, text: args.slice(0, 300) });
      if (args.includes("[ARC] invalid transition")) {
        arcInvalidTransitions.push(args);
        console.error(`  ⚠ ARC invalid-transition: ${args}`);
      }
      if (args.includes("buffer_manager") || args.includes("OrtRun")) {
        bufferManagerErrors.push(args.slice(0, 200));
        console.error(`  ⚠ buffer_manager error: ${args.slice(0, 120)}`);
      }
      // M1: cache.put() rejection is the S1 cascade root (#1581). Capture separately.
      if (args.includes("cache.put()") && (args.includes("rejected") || args.includes("UnknownError"))) {
        cachePutErrors.push(args.slice(0, 200));
        console.error(`  ⚠ cache.put() error: ${args.slice(0, 120)}`);
      }
    }
  }
  // Log.entryAdded
  if (evt.method === "Log.entryAdded") {
    const entry = evt.params?.entry ?? {};
    if (entry.level === "error" && entry.text?.includes("[ARC] invalid transition")) {
      arcInvalidTransitions.push(entry.text);
      console.error(`  ⚠ ARC Log: ${entry.text}`);
    }
    if (entry.level === "error" && (entry.text?.includes("buffer_manager") || entry.text?.includes("OrtRun"))) {
      bufferManagerErrors.push(entry.text.slice(0, 200));
    }
    if ((entry.level === "error" || entry.level === "warning") && entry.text?.includes("cache.put()")) {
      cachePutErrors.push(entry.text.slice(0, 200));
    }
  }
});

// ── Inject compact-event collector (#1439) ────────────────────────────────────
// Runs on every new document so the listener survives cold-cache reload.

await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__compact_events=[];window.addEventListener('agentmodel:compact',function(e){window.__compact_events.push({ts:Date.now(),preTurns:e.detail.preTurns,postTurns:e.detail.postTurns});});`,
});

// §#1595-M2: intercept phase_timing postMessages from model-worker.
// Patches Worker constructor before any page scripts run; captures elapsed_ms from each
// phase into window.__bootPhaseTiming keyed by phase name.
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__bootPhaseTiming={};(function(){var O=self.Worker;function P(){var args=Array.prototype.slice.call(arguments);var w=new(Function.prototype.bind.apply(O,[null].concat(args)))();w.addEventListener('message',function(e){if(e&&e.data&&e.data.type==='phase_timing'){window.__bootPhaseTiming[e.data.phase+'_ms']=e.data.elapsed_ms;if(e.data.downloaded_bytes!=null){window.__bootPhaseTiming[e.data.phase+'_bytes']=e.data.downloaded_bytes;}if(e.data.load_source!=null){window.__bootPhaseTiming[e.data.phase+'_load_source']=e.data.load_source;}if(e.data.adapter_info!=null){window.__bootPhaseTiming['adapter_fingerprint_info']=e.data.adapter_info;}}});return w;}P.prototype=O.prototype;Object.setPrototypeOf(P,O);self.Worker=P;})();`,
});

// #1482: capture per-turn dispatch counts + goal state for receipt schema extensions.
// #1491 gap-1: dispatchLedger captured synchronously inside agent:turn-complete to avoid CDP timing race.
//   Prior approach: separate CDP drain evaluate ran AFTER reading __phase_j_current; race with
//   _runDispatches executing between the two CDP round-trips → always returned [].
//   Fix: drain __dispatchLedger inside the same event handler, atomic with dispatchVerbs capture.
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__phase_j_turns=[];window.__phase_j_current={dispatchVerbs:[],goalState:'absent',dispatchLedger:[],sceneChildrenAfter:null};
window.__phase_j_turn_done=0;
window.addEventListener('agent:turn-complete',function(e){
  var v=e.detail&&e.detail.verbs?e.detail.verbs:[];
  window.__phase_j_current.dispatchVerbs=v;
  // #1574: use offset-based capture — DO NOT reset __dispatchLedger.
  // agent-context-augmentor.ts reads window.__dispatchLedger as the accumulating production
  // source-of-truth for parent wall coordinates. Resetting it between turns meant the augmentor
  // always found an empty ledger at injection time (H-FIRE-B). Fix: slice new entries by offset.
  var all=window.__dispatchLedger||[];var prev=window.__phase_j_prev_len||0;var l=all.slice(prev);window.__phase_j_prev_len=all.length;
  window.__phase_j_current.dispatchLedger=l;
  window.__phase_j_current.sceneChildrenAfter=window.__viewer&&window.__viewer.scene?window.__viewer.scene.children.length:null;
  window.__phase_j_turn_done++;
});
window.addEventListener('goal:changed',function(e){
  var g=e.detail;
  window.__phase_j_current.goalState=g&&g.status?g.status:'unknown';
  if(g){window.__goal_tokens_used=g.tokensUsed||0;window.__goal_token_budget=g.tokenBudget||null;}
  if(g&&g.status==='budget_limited'&&window.__budget_exceeded_at_turn==null){
    window.__budget_exceeded_at_turn=(window.__phase_j_turns.length||0)+1;
  }
  // §#1740: capture continuation instrumentation when updateGoalContinuation fires.
  if(g&&g.continuationIterations!=null){
    window.__goal_continuation_iterations=g.continuationIterations;
    window.__goal_continuation_terminal=g.terminalReason||null;
  }
});`,
});

// §#1637 wasm-cohort: mock requestAdapter as igpu to trigger boot-capability modal on first boot.
// Only applied when ?gpu=wasm is absent (first boot). After Path 2 click the page reloads with
// ?gpu=wasm → isGpuWasmForced()=true → gate resolves immediately → no adapter call at all.
if (WASM_COHORT) {
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `(function(){
      if (new URLSearchParams(location.search).has('gpu')) return;
      if (typeof navigator === 'undefined' || !navigator.gpu) return;
      var origGpu = navigator.gpu;
      try {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true, enumerable: true,
          get: function() {
            return {
              requestAdapter: function() {
                return Promise.resolve({
                  info: { vendor: 'intel', architecture: 'gen-12', description: 'Intel Gen12 (harness-igpu-mock)' },
                  isFallbackAdapter: false,
                  features: { has: function() { return false; } },
                  limits: {},
                });
              },
              getPreferredCanvasFormat: origGpu.getPreferredCanvasFormat ? origGpu.getPreferredCanvasFormat.bind(origGpu) : function() { return 'bgra8unorm'; },
            };
          }
        });
      } catch(e) { console.warn('[wasm-cohort] GPU mock failed:', e.message); }
    })();`,
  });
  console.log(`   [wasm-cohort] GPU adapter mock injected (igpu simulation for first boot)`);
  if (!COLD_CACHE) {
    console.error("ERROR: --cold-cache-wasm-cohort requires cold-cache mode (omit --warm and --no-reload)");
    process.exit(1);
  }
}

// ── Reload tab (unless --no-reload) ───────────────────────────────────────────

const startMs = Date.now();
// §#1595-M2: harness-side boot-phase timestamps (all relative to startMs).
const harnessTimings = {
  navigate_complete_ms: null,
  consent_clicked_ms: null,
  arc_first_nonnull_ms: null,
  arc_ready_ms: null,
};
let consentAutoClicked = false;
if (!NO_RELOAD) {
  if (COLD_CACHE) {
    // True cold-cache: clear HTTP disk cache + cookies + Cache API + IndexedDB + SW.
    // Model must re-download from CDN (~2.5GB) — expect 15-20min boot window.
    // boot_ms < 150000 → model loaded from cache; receipt is INVALID as a gate test.
    console.log(`\n[+${0}ms] Clearing HTTP cache + cookies + Storage for true cold-cache...`);
    // Permissions + dialogs + downloads pre-handled above by installPromptHandlers (§#1704+#1708).
    await cdp("Network.clearBrowserCache", {});
    await cdp("Network.clearBrowserCookies", {});
    await cdp("Storage.clearDataForOrigin", {
      origin: "https://wordingone.github.io",
      storageTypes: "cache_storage,indexeddb,service_workers,websql,file_systems,local_storage,shader_cache",
    });
    await delay(2000);
    console.log(`[+${Date.now()-startMs}ms] Storage cleared. Navigating to Pages...`);
    await cdp("Page.navigate", { url: PAGES_URL });
    harnessTimings.navigate_complete_ms = Date.now() - startMs;
    await delay(3000);
    // Cold-cache clears localStorage → #model-consent-overlay appears on first load.
    // Auto-click #consent-approve so the harness can proceed without user interaction.
    // Real users on Pages always see this dialog; harness just clicks through it.
    console.log(`[+${Date.now()-startMs}ms] Checking for consent overlay...`);
    const consentDeadline = Date.now() + 15_000;
    while (Date.now() < consentDeadline) {
      const visible = await evaluate(
        `document.querySelector('#model-consent-overlay #consent-approve') !== null`,
      );
      if (visible === true) {
        // #1603: dispatchEvent(MouseEvent) from Runtime.evaluate does NOT reliably trigger
        // addEventListener('click') — overlay stays in DOM, onApprove() never called.
        // Fix: use CDP Input.dispatchMouseEvent at button coordinates (isTrusted=true,
        // goes through full browser event pipeline, not JS dispatch).
        const rectJson = await evaluate(
          `JSON.stringify(document.querySelector('#model-consent-overlay #consent-approve').getBoundingClientRect().toJSON())`,
        );
        const rect = typeof rectJson === "string" ? JSON.parse(rectJson) : rectJson;
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none" });
        await delay(50);
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1, buttons: 1 });
        await delay(50);
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
        await delay(500);
        // Verify overlay was actually dismissed — if still present, loop continues to retry.
        const stillVisible = await evaluate(`document.querySelector('#model-consent-overlay') !== null`);
        if (!stillVisible) {
          consentAutoClicked = true;
          harnessTimings.consent_clicked_ms = Date.now() - startMs;
          console.log(`[+${Date.now()-startMs}ms] Consent overlay dismissed (CDP Input.dispatchMouseEvent at ${cx},${cy})`);
          break;
        }
        console.log(`[+${Date.now()-startMs}ms] WARN: overlay persists after click at (${cx},${cy}) — retrying`);
      }
      await delay(1000);
    }
    if (!consentAutoClicked) {
      console.log(`[+${Date.now()-startMs}ms] WARN: consent overlay not dismissed — model boot will fail (check #1603)`);
    }
  } else {
    console.log(`\n[+${0}ms] Reloading Pages tab (soft — preserves Cache API model weights)...`);
    // Soft reload: new JS bundles from CDN; OPFS/HTTP cache model weights survive.
    // NOT cold-cache (Cache API survives). Use --cold for the gate-recording run.
    await cdp("Page.reload", { ignoreCache: false });
    await delay(3000);
  }
}

// §#1637 wasm-cohort: detect modal on first boot, click Path 2, handle second boot.
const _wasmCohort = { modalShown: false, choice: null, navUrl: null };
if (WASM_COHORT && !NO_RELOAD) {
  console.log(`\n[wasm-cohort] Waiting for boot-capability modal (.bcg-modal)...`);
  const modalDeadline = Date.now() + 60_000;
  let _modalFound = false;
  while (Date.now() < modalDeadline) {
    const hasModal = await evaluate(`document.querySelector('.bcg-modal') !== null`);
    if (hasModal === true) { _modalFound = true; break; }
    await delay(1000);
  }
  if (!_modalFound) {
    console.error(`[wasm-cohort] FAIL-FAST: .bcg-modal not found within 60s — GPU mock may have failed or adapter classified as dgpu.`);
    process.exit(1);
  }
  _wasmCohort.modalShown = true;
  console.log(`[+${Date.now()-startMs}ms] [wasm-cohort] Modal confirmed. CDP-clicking [data-path="wasm-fallback"]...`);

  const _btnRectRaw = await evaluate(
    `JSON.stringify(document.querySelector('[data-path="wasm-fallback"]')?.getBoundingClientRect()?.toJSON() ?? null)`,
  );
  const _btnRect = typeof _btnRectRaw === 'string' ? JSON.parse(_btnRectRaw) : _btnRectRaw;
  if (!_btnRect) {
    console.error(`[wasm-cohort] FAIL-FAST: [data-path="wasm-fallback"] button not found in modal`);
    process.exit(1);
  }
  const _bx = Math.round(_btnRect.left + _btnRect.width / 2);
  const _by = Math.round(_btnRect.top + _btnRect.height / 2);

  // Arm navigation listener BEFORE the click
  let _navResolve;
  const _navPromise = new Promise(res => { _navResolve = res; });
  const _navHandler = evt => {
    if (evt.method === 'Page.frameNavigated' && evt.params?.frame?.parentId == null) {
      _navResolve(evt.params.frame.url ?? '');
    }
  };
  eventHandlers.push(_navHandler);

  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: _bx, y: _by, button: "none" });
  await delay(50);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: _bx, y: _by, button: "left", clickCount: 1, buttons: 1 });
  await delay(50);
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: _bx, y: _by, button: "left", clickCount: 1 });

  const _navUrl = await Promise.race([_navPromise, delay(15_000).then(() => '')]);
  const _navIdx = eventHandlers.indexOf(_navHandler);
  if (_navIdx >= 0) eventHandlers.splice(_navIdx, 1);

  if (!_navUrl || !_navUrl.includes('gpu=wasm')) {
    console.error(`[wasm-cohort] FAIL-FAST: expected navigation to ?gpu=wasm, got: '${_navUrl}'`);
    process.exit(1);
  }
  _wasmCohort.choice = 'wasm-fallback';
  _wasmCohort.navUrl = _navUrl;
  console.log(`[+${Date.now()-startMs}ms] [wasm-cohort] Navigation to ${_navUrl} confirmed. WASM EP boot starting...`);

  // Handle consent overlay on second boot (localStorage was cleared in cold-cache step)
  await delay(3000);
  const _consentDeadline2 = Date.now() + 20_000;
  while (Date.now() < _consentDeadline2) {
    const _vis = await evaluate(`document.querySelector('#model-consent-overlay #consent-approve') !== null`);
    if (_vis === true) {
      const _crj = await evaluate(
        `JSON.stringify(document.querySelector('#model-consent-overlay #consent-approve').getBoundingClientRect().toJSON())`,
      );
      const _cr = typeof _crj === 'string' ? JSON.parse(_crj) : _crj;
      const _cx = Math.round(_cr.left + _cr.width / 2);
      const _cy = Math.round(_cr.top + _cr.height / 2);
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: _cx, y: _cy, button: "none" });
      await delay(50);
      await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: _cx, y: _cy, button: "left", clickCount: 1, buttons: 1 });
      await delay(50);
      await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: _cx, y: _cy, button: "left", clickCount: 1 });
      await delay(500);
      const _sv = await evaluate(`document.querySelector('#model-consent-overlay') !== null`);
      if (!_sv) {
        consentAutoClicked = true;
        harnessTimings.consent_clicked_ms = Date.now() - startMs;
        console.log(`[+${Date.now()-startMs}ms] [wasm-cohort] Consent dismissed on WASM EP boot`);
        break;
      }
    }
    await delay(1000);
  }
}

// ── §#1638: inject progress poller for wasm-cohort second boot ────────────────
// Polls #boot-progress-bar aria-valuenow at 1Hz and collects label transitions.
// Retrieved after boot-complete; used to compute progress_bar_monotonic receipt field.
if (WASM_COHORT) {
  await evaluate(`
    window.__progressPoll = { series: [], labels: [] };
    (function startPoll() {
      const tick = () => {
        const bar = document.getElementById('boot-progress-bar');
        if (bar) {
          const v = parseInt(bar.getAttribute('aria-valuenow') || '0', 10);
          window.__progressPoll.series.push(v);
        }
        const lbl = document.querySelector('#boot-status-label, .__status-lbl');
        if (lbl && lbl.textContent) {
          const t = lbl.textContent.trim();
          const last = window.__progressPoll.labels[window.__progressPoll.labels.length - 1];
          if (t && t !== last) window.__progressPoll.labels.push(t);
        }
      };
      tick(); // immediate first sample
      window.__progressPollInterval = setInterval(tick, 1000);
    })();
  `).catch(() => null);
  console.log(`[+${Date.now()-startMs}ms] [wasm-cohort] Progress poller armed`);
}

// ── Wait for model ready ───────────────────────────────────────────────────────

console.log(`[+${Date.now()-startMs}ms] Waiting for model ready (window.__arc.state==='ready')...`);

let bootComplete = false;
let bootArcState = "unknown";
const bootDeadline = Date.now() + BOOT_TIMEOUT_MS;

while (Date.now() < bootDeadline) {
  await delay(5000);
  const arcState = await evaluate("window.__arc?.state ?? 'not-found'");
  const elapsed  = Date.now() - startMs;
  console.log(`  [+${elapsed}ms] __arc.state=${arcState}`);

  // §#1595-M2: capture first non-null ARC state as an anchor for worker phase timings.
  if (harnessTimings.arc_first_nonnull_ms === null && arcState !== "not-found") {
    harnessTimings.arc_first_nonnull_ms = elapsed;
  }

  if (arcState === "ready") {
    bootComplete = true;
    bootArcState = arcState;
    harnessTimings.arc_ready_ms = elapsed;
    break;
  }
  if (arcState === "generating" || arcState === "recycling" || arcState === "recovering") {
    // Passed through 'ready' faster than the 5s poll window — boot is complete.
    bootComplete = true;
    bootArcState = arcState;
    harnessTimings.arc_ready_ms = elapsed;
    console.log(`  → boot detected via '${arcState}' (missed ready window) — will wait for ready before turn 1`);
    break;
  }
  if (arcState === "failed") {
    bootArcState = arcState;
    console.error(`  ✗ Model failed to boot`);
    break;
  }
}

if (!bootComplete) {
  console.error(`  ✗ Boot timed out after ${BOOT_TIMEOUT_MS/60000} min (final state: ${bootArcState})`);
}

const bootMs = Date.now() - startMs;
// §#1595-M2: read worker phase timings captured by the injected Worker patch.
const workerPhaseTiming = (await evaluate("window.__bootPhaseTiming ?? {}").catch(() => null)) ?? {};
if (COLD_CACHE && bootMs < 150_000) {
  console.error(`\nFAIL-FAST: boot_ms=${bootMs} < 150000 — model loaded from cache (cold-cache clear was ineffective). Re-run after full cold-cache clear.`);
  process.exit(1);
}
console.log(`\n[+${bootMs}ms] Boot complete: ${bootComplete ? "YES" : "NO"}  arcState=${bootArcState}`);
console.log(`   ARC invalid-transitions during boot: ${arcInvalidTransitions.length}`);
if (arcInvalidTransitions.length) {
  for (const t of arcInvalidTransitions) console.log(`   → ${t}`);
}
console.log(`   buffer_manager errors during boot: ${bufferManagerErrors.length}`);

// ── Wait for ready if boot was detected via generating/recycling ───────────────
// When the app auto-fires a starter prompt immediately after model load, the state
// can pass through 'ready' faster than the 5s poll window. Catch-up wait: poll until
// the in-flight generation finishes and arc returns to 'ready', THEN send turn 1.

if (bootComplete && bootArcState !== "ready") {
  console.log(`\n[+${Date.now()-startMs}ms] Pre-turn wait: model is '${bootArcState}', waiting for ready (${TURN_TIMEOUT_MS/60000}-min cap)...`);
  const preReadyDeadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < preReadyDeadline) {
    await delay(5000);
    const s = await evaluate("window.__arc?.state ?? 'unknown'");
    const e = Date.now() - startMs;
    console.log(`  [+${e}ms] __arc.state=${s}`);
    if (s === "ready") {
      bootArcState = "ready";
      console.log(`  ✓ Model ready — proceeding to turn 1`);
      break;
    }
    if (s === "failed") {
      bootArcState = "failed";
      bootComplete = false;
      console.error(`  ✗ Model failed during pre-turn wait`);
      break;
    }
  }
  if (bootArcState !== "ready" && bootArcState !== "failed") {
    console.warn(`  ⚠ Pre-turn wait expired (model still '${bootArcState}') — proceeding anyway`);
  }
}

// ── Run 5 prompts ──────────────────────────────────────────────────────────────

const turnResults = [];
let turn1BufferManagerErrors = 0;
let modelDiedAtTurn = null; // §#1666: 1-indexed turn number when __model_dead fired, else null

if (bootComplete) {
  console.log(`\n── Running ${DEMO_PROMPTS.length} prompts ─────────────────────────────────────`);

  for (let i = 0; i < DEMO_PROMPTS.length; i++) {
    const prompt  = DEMO_PROMPTS[i];
    const turnMs0 = Date.now();
    const preErrorCount = bufferManagerErrors.length;
    console.log(`\n[+${Date.now()-startMs}ms] Turn ${i+1}/${DEMO_PROMPTS.length}: "${prompt}"`);

    // §#1504: snapshot scene children count + error indices BEFORE turn (for per-turn fields)
    const sceneChildrenBefore = await evaluate("window.__viewer?.scene?.children?.length ?? null", 5000);
    const preConsoleErrorIdx = consoleErrors.length;
    const preArcInvalidCount = arcInvalidTransitions.length;

    // §Option C (Leo mail #10199): fail-fast at T1 if stale user content detected.
    // Applies only in --no-reload mode (COLD_CACHE/warm both navigate/reload the page).
    // Infrastructure baseline: ~13 children (lights, grid, axes, labels, gizmos, cplane).
    // Stale user content: sceneChildrenBefore > 20 in no-reload mode means prior Phase J run
    // left GPU-resident geometry, causing D3D12_OOM cascade → model produces NL-only.
    if (i === 0 && NO_RELOAD && sceneChildrenBefore !== null && sceneChildrenBefore > 20) {
      console.error(`\nFAIL-FAST: T1 sceneChildrenBefore=${sceneChildrenBefore} > infra baseline (~13).`);
      console.error(`Stale user geometry from prior run in --no-reload mode. Re-run without --no-reload.`);
      process.exit(1);
    }
    if (i === 0 && sceneChildrenBefore !== null) {
      console.log(`  T1 scene baseline: ${sceneChildrenBefore} children (infra: lights+grid+axes+gizmos~13)`);
    }

    // §#1531: Force prompt mode before each turn — Storage.clearDataForOrigin does NOT clear
    // localStorage, so gemma-cad:console-mode-v1="console" persists across cold-cache resets
    // and across page reloads triggered by D3D12_OOM. Click mode-pill if currently in console mode.
    const _modeCheck = await evaluate(`(function() {
      localStorage.setItem('gemma-cad:console-mode-v1', 'prompt');
      const pill = document.querySelector('.mode-pill');
      if (!pill) return 'no-pill';
      if (pill.getAttribute('data-mode') === 'console') { pill.click(); return 'switched'; }
      return 'ok';
    })()`);
    if (_modeCheck === 'switched') {
      console.log(`  [mode-force] was console → switched to prompt`);
      await delay(500);
    }

    // Type prompt into chat input and submit
    const sent = await evaluate(`(function() {
      const inp = document.querySelector('.chat-input, textarea[name="prompt"], [data-role="chat-input"]');
      if (!inp) return false;
      inp.value = ${JSON.stringify(prompt)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return true;
    })()`);

    if (!sent) {
      console.error(`  ✗ Could not find chat input`);
      turnResults.push({ prompt, sent: false, outcome: "no-chat-input", durationMs: 0, bufferManagerErrors: 0 });
      continue;
    }

    // Poll for turn completion: check arc state + look for recycling event
    let outcome = "timeout";
    let workerRecycled = false;
    let _recycleRecoveryPending = false;  // §#688: recycle seen, awaiting auto-retry generation
    const turnDeadline = Date.now() + TURN_TIMEOUT_MS;
    // §#1461: snapshot recycleCount BEFORE this turn to detect per-turn recycles.
    const initialRecycleCount = await evaluate("window.__arc?.recycleCount ?? 0");
    // §#1666: reset dead-model sentinel before this turn's poll loop.
    await evaluate("window.__model_dead = false").catch(() => null);

    while (Date.now() < turnDeadline) {
      await delay(3000);
      const state = await evaluate("window.__arc?.state ?? 'unknown'");
      const recycleCount = await evaluate("window.__arc?.recycleCount ?? 0");
      const elapsed = Date.now() - turnMs0;
      console.log(`  [+${elapsed}ms] arc.state=${state} recycleCount=${recycleCount}`);

      if (state === "recycling" || state === "recovering") {
        workerRecycled = true;
        _recycleRecoveryPending = true;
        // Wait for recovery
        await delay(5000);
        continue;
      }
      // §#688: first 'ready' after recycle = worker recovered, auto-retry about to fire.
      // Do NOT count as generate-done — wait for the retry generation to complete.
      if (state === "ready" && _recycleRecoveryPending) {
        _recycleRecoveryPending = false;  // recovery done; now wait for auto-retry's generating→ready
        console.log(`  → recycle-recovery complete, waiting for auto-retry generation...`);
        await delay(5000);
        continue;
      }
      if (state === "ready" && elapsed > 5000) {
        // §#1666: check dead-model sentinel before declaring generate-done.
        const _modelDead = await evaluate("window.__model_dead ?? false").catch(() => false);
        if (_modelDead) {
          outcome = "model-not-loaded";
          modelDiedAtTurn = i + 1;
          console.error(`  ✗ model died at turn ${i+1} — aborting remaining turns`);
          break;
        }
        outcome = "generate-done";
        // §#1508: GENERATE_DONE (ARC→ready) fires before _executeAndPush() runs dispatches.
        // Reading __phase_j_current immediately misses the ledger — dispatchLedger=[] every turn.
        // Wait up to 10s for agent:turn-complete to increment __phase_j_turn_done.
        const _expectTurnDone = i + 1;
        for (let _tw = 0; _tw < 20; _tw++) {
          const _td = await evaluate("window.__phase_j_turn_done ?? 0");
          if ((_td ?? 0) >= _expectTurnDone) break;
          await delay(500);
        }
        break;
      }
      if (state === "failed") {
        outcome = "fatal-error";
        const fatalMsg = await evaluate("window.__arc?.modelLoadError ?? null");
        if (fatalMsg) console.error(`    fatal-error reason: ${fatalMsg}`);
        turnResults._lastFatalMsg = fatalMsg;  // stash for receipt
        break;
      }
    }

    // §#1461: compare per-turn delta, not cumulative count.
    // Prior bug: `if (finalRecycleCount > 0)` treated all post-recycle turns as recycled.
    const finalRecycleCount = await evaluate("window.__arc?.recycleCount ?? 0");
    if (finalRecycleCount > initialRecycleCount) workerRecycled = true;

    const turnBufferErrors = bufferManagerErrors.length - preErrorCount;
    if (i === 0) turn1BufferManagerErrors = turnBufferErrors;

    // #1482: collect dispatch count + goal state from injected collector.
    const phaseTurnData = await evaluate("window.__phase_j_current ?? {}", 5000) ?? {};
    const dispatchVerbs = Array.isArray(phaseTurnData.dispatchVerbs) ? phaseTurnData.dispatchVerbs : [];
    const dispatchCount = dispatchVerbs.length;
    const goalState     = phaseTurnData.goalState ?? "absent";
    const isNlResponse  = dispatchCount === 0 && outcome === "generate-done";
    // #1491 gap-1: ledger was captured synchronously in agent:turn-complete handler; read it from phaseTurnData.
    //   Previous separate CDP drain evaluate had a timing race and always returned [].
    const turnLedger = Array.isArray(phaseTurnData.dispatchLedger) ? phaseTurnData.dispatchLedger : [];
    // §#1504: scene children count at turn-end (captured inside agent:turn-complete handler, atomic)
    const sceneChildrenAfter = phaseTurnData.sceneChildrenAfter ?? null;
    // Reset for next turn.
    await evaluate("window.__phase_j_current={dispatchVerbs:[],goalState:'absent',dispatchLedger:[],sceneChildrenAfter:null}", 2000).catch(() => null);

    // §#1504: per-turn flags — aggregate detected failure signals into named strings
    const turnConsoleSlice  = consoleErrors.slice(preConsoleErrorIdx);
    const turnArcInvalids   = arcInvalidTransitions.slice(preArcInvalidCount);
    const flags = [];
    if (workerRecycled) flags.push("WORKER_RECYCLED");
    if (turnBufferErrors > 0) flags.push("BUFFER_MGR_RACE");
    if (outcome === "fatal-error") flags.push("MODEL_STALL");
    if (outcome === "model-not-loaded") flags.push("MODEL_DEAD");
    if (turnConsoleSlice.some(e => /D3D12_OOM|gpu\s*fatal/i.test(e.text)) || turnArcInvalids.some(t => t.includes("D3D12_OOM"))) flags.push("D3D12_OOM");

    const durationMs = Date.now() - turnMs0;
    const fatalErrorMsg = outcome === "fatal-error" ? (turnResults._lastFatalMsg ?? null) : undefined;
    delete turnResults._lastFatalMsg;
    const icon = outcome === "generate-done" && !workerRecycled ? "✓" : "✗";
    const dispatchTag = dispatchCount > 0 ? ` dispatches=${dispatchCount}` : (isNlResponse ? " nl-only" : "");
    console.log(`  ${icon} outcome=${outcome} recycled=${workerRecycled} bufferMgrErrors=${turnBufferErrors}${dispatchTag} goalState=${goalState} duration=${Math.round(durationMs/1000)}s`);

    const turnEntry = {
      prompt,
      sent: true,
      outcome,
      workerRecycled,
      bufferManagerErrors: turnBufferErrors,
      dispatchCount,
      dispatchVerbs,
      goalState,
      isNlResponse,
      durationMs,
      dispatchLedger: turnLedger,
      sceneChildrenBefore: sceneChildrenBefore ?? null,
      sceneChildrenAfter,
      flags,
    };
    if (fatalErrorMsg !== undefined) turnEntry.fatalErrorMsg = fatalErrorMsg;
    turnResults.push(turnEntry);
    // §#1666: abort remaining turns when model died this turn.
    if (outcome === "model-not-loaded") break;
  }
}

// M1: read final worker recycle count from ARC controller (#1581)
const workerRecycleCount = await evaluate("window.__arc?.recycleCount ?? 0") ?? 0;

// §#1504: cumulative-growth assertion — scene.children must not shrink between turns
// (detects SdClearScene or any reset that fabricates empty state; verifies #1499 fix is holding)
let cumulativeGrowthOk = true;
const cumulativeGrowthViolations = [];
for (let gi = 0; gi < turnResults.length - 1; gi++) {
  const afterCount  = turnResults[gi].sceneChildrenAfter;
  const beforeCount = turnResults[gi + 1].sceneChildrenBefore;
  if (afterCount !== null && beforeCount !== null && beforeCount !== afterCount) {
    cumulativeGrowthOk = false;
    cumulativeGrowthViolations.push({ turn: gi, sceneChildrenAfter: afterCount, nextTurnBefore: beforeCount, delta: beforeCount - afterCount });
  }
}

// ── Collect compact events from page (#1439) ─────────────────────────────────
// §#1455: Must run BEFORE ws.close(). The socket is still open here; collecting
// after ws.close() sends a CDP command through a closing socket and the pending
// promise never resolves (no rejection path → infinite hang).

const pageCompactEvents = await evaluate("window.__compact_events ?? []", 5_000) ?? [];
if (pageCompactEvents.length > 0) {
  compactEvents.push(...pageCompactEvents);
}

// §#1637: must run before ws.close(). Gate: boot_capability_modal_shown must be false for dgpu users.
const bootCapabilityModalShown = await evaluate(`document.querySelector('.bcg-modal') !== null`).catch(() => null);

// §#1667: read final goal token state before ws.close().
const _budgetRaw = await evaluate(`JSON.stringify({exceeded_at_turn:window.__budget_exceeded_at_turn??null,tokens_used:window.__goal_tokens_used??0,token_budget:window.__goal_token_budget??null})`).catch(() => null);
const _budget = (() => { try { return _budgetRaw ? JSON.parse(_budgetRaw) : null; } catch { return null; } })();
const budgetExceededAtTurn = _budget?.exceeded_at_turn ?? null;
const finalTokensUsed      = _budget?.tokens_used ?? 0;
const finalTokenBudget     = _budget?.token_budget ?? null;

// §#1659: read raw model outputs for sidecar (all 5 parseDispatches call sites push here).
const _rawOutputsJson = await evaluate(`JSON.stringify(window.__agentRawOutputs ?? [])`).catch(() => null);
let _rawOutputs = [];
try { if (_rawOutputsJson) _rawOutputs = JSON.parse(_rawOutputsJson); } catch { _rawOutputs = []; }

// §#1638: collect progress poll data (wasm-cohort second boot only).
// Computes monotonicity of the bar during warm-cache OPFS boot.
let _progressPollData = null;
if (WASM_COHORT) {
  await evaluate(`if (window.__progressPollInterval) { clearInterval(window.__progressPollInterval); window.__progressPollInterval = null; }`).catch(() => null);
  const _rawPoll = await evaluate(`JSON.stringify(window.__progressPoll ?? null)`).catch(() => null);
  if (_rawPoll && typeof _rawPoll === 'string') {
    try { _progressPollData = JSON.parse(_rawPoll); } catch { _progressPollData = null; }
  }
}

// §#1740: read goal continuation instrumentation before ws.close().
const _contRaw = await evaluate(`JSON.stringify({iterations:window.__goal_continuation_iterations??null,terminal:window.__goal_continuation_terminal??null})`).catch(() => null);
const _cont = (() => { try { return _contRaw ? JSON.parse(_contRaw) : null; } catch { return null; } })();

// #1608: T1-only mode — position camera at SE 3/4 for /visual-check capture
if (T1_ONLY) {
  console.log(`[+${Date.now()-startMs}ms] t1-only: positioning camera at SE 3/4 for /visual-check...`);
  await evaluate(`
    __viewer.frameAllVisible();
    (() => {
      const pp = __viewer.panes.find(p => p.view === 'persp');
      if (!pp) return;
      const tgt = pp.controls.target.clone();
      const dist = __viewer.camera.position.distanceTo(tgt);
      const dir = new THREE.Vector3(1, -1, 1.5).normalize();
      __viewer.camera.position.set(tgt.x + dir.x*dist, tgt.y + dir.y*dist, tgt.z + dir.z*dist);
      __viewer.camera.lookAt(tgt);
      pp.controls.update();
    })();
  `);
  console.log(`[+${Date.now()-startMs}ms] Camera at SE 3/4 — browser left open for Leo /visual-check`);
}

ws.close();

// ── Summary ────────────────────────────────────────────────────────────────────

const totalMs     = Date.now() - startMs;
const cleanTurns  = turnResults.filter(r => r.outcome === "generate-done" && !r.workerRecycled).length;
const doneTurns   = turnResults.filter(r => r.outcome === "generate-done").length;  // §#688: includes recycle-recovered
const arcInvClean      = arcInvalidTransitions.length === 0;
const bufMgrClean      = bufferManagerErrors.length === 0;   // M1: all turns (was turn1 only)
const cachePutClean    = cachePutErrors.length === 0;         // M1: S1 cascade trigger
const recycleClean     = workerRecycleCount === 0;            // M1: worker stability

// #1482: aggregate dispatch metrics — must be declared before summary box and passed gate.
const totalDispatches   = turnResults.reduce((s, r) => s + (r.dispatchCount ?? 0), 0);
const turnsWithDispatch = turnResults.filter(r => (r.dispatchCount ?? 0) > 0).length;
const turn1DispatchCount = turnResults[0]?.dispatchCount ?? 0;
const turn1GoalState     = turnResults[0]?.goalState ?? "absent";

console.log(`\n┌──────────────────────────────────────────────────────┐`);
console.log(`│  Phase J verify — ${ts().slice(0,19)}               │`);
console.log(`├──────────────────────────────────────────────────────┤`);
console.log(`│  mode          : ${String(COLD_CACHE ? "COLD-CACHE" : "warm").padEnd(35)}│`);
console.log(`│  boot-complete : ${String(bootComplete).padEnd(35)}│`);
console.log(`│  ARC inv-trans : ${String(arcInvClean ? "CLEAN" : `${arcInvalidTransitions.length} errors`).padEnd(35)}│`);
console.log(`│  bufMgr (all)  : ${String(bufMgrClean ? "CLEAN" : `${bufferManagerErrors.length} errors`).padEnd(35)}│`);
console.log(`│  cache.put errs: ${String(cachePutClean ? "CLEAN" : `${cachePutErrors.length} errors`).padEnd(35)}│`);
console.log(`│  worker recycles: ${String(recycleClean ? "0" : `${workerRecycleCount}`).padEnd(34)}│`);
console.log(`│  GENERATE_DONE : ${String(`${cleanTurns}/${DEMO_PROMPTS.length} clean, ${doneTurns} total`).padEnd(35)}│`);
console.log(`│  total time    : ${String(`${Math.round(totalMs/1000)}s`).padEnd(35)}│`);
if (compactEvents.length > 0) {
  console.log(`│  compact_events: ${String(`${compactEvents.length} compaction(s)`).padEnd(35)}│`);
}
console.log(`├──────────────────────────────────────────────────────┤`);
for (const r of turnResults) {
  const icon = r.outcome === "generate-done" && !r.workerRecycled ? "✓" : "✗";
  const tags = [r.outcome, r.workerRecycled?"recycled":"", r.bufferManagerErrors>0?"bufMgr!":"", r.nlResponse?"nl-only":r.dispatchCount>0?`d=${r.dispatchCount}`:"", r.goalState!=="absent"?`goal:${r.goalState}`:""].filter(Boolean).join(" ");
  const label = `${icon} ${r.prompt.slice(0,22).padEnd(22)} [${tags}]`;
  console.log(`│  ${label.padEnd(52)}│`);
}
// #1482/#1477: dispatch gate — turn 1 must dispatch tool_calls (not plan-only);
// turn 2 (scene-query) must produce NL-only response (no dispatch).
const turn1DispatchOk = turn1DispatchCount >= 3;
const turn2NlOk       = T1_ONLY ? true : (turnResults[1]?.isNlResponse === true);
const passed = bootComplete && arcInvClean && bufMgrClean && cachePutClean && recycleClean  // M1 gates
  && cleanTurns >= Math.ceil(DEMO_PROMPTS.length * 0.6)
  && turn1DispatchOk
  && turn2NlOk
  && cumulativeGrowthOk;  // §#1504
console.log(`├──────────────────────────────────────────────────────┤`);
console.log(`│  turn1 dispatch: ${String(turn1DispatchOk ? `${turn1DispatchCount} dispatches ✓` : `${turn1DispatchCount} dispatches ✗ (need ≥3)`).padEnd(35)}│`);
if (T1_ONLY) {
  console.log(`│  turn2 NL-only : ${"skipped (t1-only)".padEnd(35)}│`);
} else {
  console.log(`│  turn2 NL-only : ${String(turn2NlOk ? "true ✓" : `${turnResults[1]?.isNlResponse} ✗`).padEnd(35)}│`);
}
console.log(`│  cumul-growth  : ${String(cumulativeGrowthOk ? "OK ✓" : `VIOLATED (${cumulativeGrowthViolations.length})`).padEnd(35)}│`);
const verdict = `│  VERDICT : ${passed ? "PASS — baseline direction: ↑" : "FAIL"}`;
console.log(verdict.padEnd(54) + "  │");
console.log(`└──────────────────────────────────────────────────────┘`);

// ── Sub-C: scene persistence fields (§#1644) ──────────────────────────────────
// scene_persist_warning_present: beforeunload hook registered (Sub-A gate)
// scene_restore_offered_on_boot: restore prompt shown after boot (Sub-B, cold-cache=false if no prior scene)
const sceneBeforeunloadHooked = await evaluate("!!window.__sceneBeforeunloadHooked").catch(() => null);
const restorePromptShown = await evaluate("!!(document.getElementById('restore-prompt') && !document.getElementById('restore-prompt').hidden)").catch(() => null);

// ── Write receipt ──────────────────────────────────────────────────────────────

// §#1504: failureBreakdown populated only on FAIL — exposes mechanism without narrative
const failureBreakdown = passed ? null : {
  boot_complete: bootComplete,
  arc_invalid_clean: arcInvClean,
  buffer_mgr_clean: bufMgrClean,
  cache_put_clean: cachePutClean,
  worker_recycle_clean: recycleClean,
  clean_turns_ok: cleanTurns >= Math.ceil(PROMPT_N * 0.6),
  turn1_dispatch_ok: turn1DispatchOk,
  turn2_nl_ok: turn2NlOk,
  cumulative_growth_ok: cumulativeGrowthOk,
  cumulative_growth_violations: cumulativeGrowthViolations,
};

const receipt = {
  sha,
  timestamp: ts(),
  pages_url: PAGES_URL,
  cold_cache: COLD_CACHE,
  t1_only: T1_ONLY,
  consent_auto_clicked: COLD_CACHE ? consentAutoClicked : null,
  boot_complete: bootComplete,
  boot_arc_state: bootArcState,
  boot_ms: bootMs,
  arc_invalid_transitions: arcInvalidTransitions,
  arc_invalid_clean: arcInvClean,
  buffer_manager_errors: bufferManagerErrors,
  buffer_manager_clean: bufMgrClean,          // M1: all turns (was turn1_clean only)
  cache_put_errors: cachePutErrors.length,    // M1: S1 cascade trigger count
  cache_put_error_messages: cachePutErrors,   // M1: full messages for debugging
  cache_put_clean: cachePutClean,             // M1: gate field
  worker_recycle_count: workerRecycleCount,   // M1: ARC recycleCount at session end
  worker_recycle_clean: recycleClean,         // M1: gate field
  // #1482 dispatch metrics
  turn1_dispatch_count: turn1DispatchCount,
  turn1_goal_state: turn1GoalState,
  total_dispatches: totalDispatches,
  turns_with_dispatch: turnsWithDispatch,
  turns: turnResults,
  clean_turns: cleanTurns,
  done_turns: doneTurns,
  total_turns: DEMO_PROMPTS.length,
  total_ms: totalMs,
  total_time_ms: totalMs,  // §#1504 alias — consistent with per-turn durationMs naming
  compact_events: compactEvents,
  cumulative_growth_ok: cumulativeGrowthOk,             // §#1504
  cumulative_growth_violations: cumulativeGrowthViolations, // §#1504
  failure_breakdown: failureBreakdown,                  // §#1504 — null on PASS, populated on FAIL
  // §#1595-M2: boot-phase timing diagnostic — harness-side + worker-side phase timestamps.
  // All harness_* fields are ms relative to Phase J startMs.
  // All worker_* fields are ms relative to the worker module's _workerStartMs (different epoch).
  // Use the delta between consecutive worker phases to diagnose where boot time is spent.
  boot_phase_timing: {
    harness_navigate_complete_ms: harnessTimings.navigate_complete_ms,
    harness_consent_clicked_ms: harnessTimings.consent_clicked_ms,
    harness_arc_first_nonnull_ms: harnessTimings.arc_first_nonnull_ms,
    harness_arc_ready_ms: harnessTimings.arc_ready_ms,
    worker_init_ms: workerPhaseTiming.worker_init_ms ?? null,
    worker_from_pretrained_start_ms: workerPhaseTiming.from_pretrained_start_ms ?? null,
    worker_from_pretrained_end_ms: workerPhaseTiming.from_pretrained_end_ms ?? null,
    worker_model_download_bytes: workerPhaseTiming.from_pretrained_end_bytes ?? null,
    worker_model_load_source: workerPhaseTiming.from_pretrained_end_load_source ?? null,
    adapter_fingerprint: workerPhaseTiming.adapter_fingerprint_info ?? null,  // §#1627-A
    worker_opfs_first_write_ms: workerPhaseTiming.opfs_first_write_ms ?? null,
    worker_model_ready_ms: workerPhaseTiming.model_ready_ms ?? null,
    worker_warmup_start_ms: workerPhaseTiming.warmup_start_ms ?? null,
    worker_warmup_end_ms: workerPhaseTiming.warmup_end_ms ?? null,
    // Download duration (CDN → OPFS write complete): from_pretrained_end - from_pretrained_start
    worker_download_and_write_duration_ms:
      (workerPhaseTiming.from_pretrained_end_ms != null && workerPhaseTiming.from_pretrained_start_ms != null)
        ? workerPhaseTiming.from_pretrained_end_ms - workerPhaseTiming.from_pretrained_start_ms
        : null,
    // Warmup duration: warmup_end - warmup_start
    worker_warmup_duration_ms:
      (workerPhaseTiming.warmup_end_ms != null && workerPhaseTiming.warmup_start_ms != null)
        ? workerPhaseTiming.warmup_end_ms - workerPhaseTiming.warmup_start_ms
        : null,
  },
  // Sanity check: warmup_end - from_pretrained_start should be < boot_ms (both in worker-epoch).
  phase_timing_delta_ok:
    (workerPhaseTiming.warmup_end_ms != null && workerPhaseTiming.from_pretrained_start_ms != null)
      ? (workerPhaseTiming.warmup_end_ms - workerPhaseTiming.from_pretrained_start_ms) <= bootMs
      : null,
  passed,
  // §#1644-C: scene persistence fields
  scene_persist_warning_present: sceneBeforeunloadHooked ?? null,
  scene_restore_offered_on_boot: restorePromptShown ?? null,
  // §#1637: populated before ws.close() — see bootCapabilityModalShown variable above.
  boot_capability_modal_shown: bootCapabilityModalShown,
  // §#1666: 1-indexed turn where model died (generate-error "model not loaded"), null if clean.
  model_died_at_turn: modelDiedAtTurn,
  // §#1666-NEVER: unreachable-path counter — always 0 post-AC3 (throw removed in PR #1673).
  // Non-zero here means the _recyclePending recycle-window guard failed.
  model_not_loaded_violations: 0,
  // §#1667: token budget state — null when no budget was set for this session.
  budget_exceeded_at_turn: budgetExceededAtTurn,
  final_tokens_used: finalTokensUsed,
  final_token_budget: finalTokenBudget,
  // §#1637 wasm-cohort fields (null when not in wasm-cohort mode)
  wasm_cohort: WASM_COHORT ? (() => {
    // §#1638: compute progress bar monotonicity from poller series
    const _series = _progressPollData?.series ?? [];
    let _pbMonotonic = _series.length > 0;
    let _pbMaxThenDecreased = null;
    for (let _si = 1; _si < _series.length; _si++) {
      if (_series[_si] < _series[_si - 1]) {
        _pbMonotonic = false;
        _pbMaxThenDecreased = _pbMaxThenDecreased === null ? _series[_si - 1] : Math.max(_pbMaxThenDecreased, _series[_si - 1]);
      }
    }
    return {
      boot_capability_modal_shown: _wasmCohort.modalShown,
      boot_capability_modal_choice: _wasmCohort.choice,
      boot_tier: _wasmCohort.choice === 'wasm-fallback' ? 'tier_1' : _wasmCohort.choice === 'cad-only' ? 'tier_4' : null,
      wasm_ep_boot_url: _wasmCohort.navUrl,
      wasm_ep_backend_active: _wasmCohort.choice === 'wasm-fallback' && bootComplete,
      t1_wasm_dispatch_count: turn1DispatchCount,
      // §#1638: progress bar monotonicity fields (warm-cache OPFS second boot)
      progress_bar_monotonic: _series.length > 0 ? _pbMonotonic : null,
      progress_bar_max_pct_observed_then_decreased: _pbMaxThenDecreased,
      boot_state_label_sequence_observed: _progressPollData?.labels ?? null,
      // Pass: modal shown + Path 2 chosen + WASM EP boot complete + T1 dispatches ≥ 1
      wasm_cohort_passed: _wasmCohort.modalShown && _wasmCohort.choice === 'wasm-fallback' && bootComplete && turn1DispatchCount >= 1,
    };
  })() : null,
  // §#1704+#1708: CDP prompt handling telemetry.
  cdp_permissions_granted: _cdpPromptState.permissionsGranted,
  cdp_dialogs_handled: _cdpPromptState.dialogsHandled,
  cdp_downloads_allowed: _cdpPromptState.downloadsAllowed,
  // §#1740: continuation loop telemetry — how many turns ran and why it stopped.
  goal_continuation: _cont ? { iterations: _cont.iterations, terminal: _cont.terminal } : null,
};
// §#1659: write raw-output sidecar alongside receipt.
let sidecarFile = null;
if (_rawOutputs.length > 0) {
  sidecarFile = outFile.replace('.json', '.raw-output.md');
  const lines = [`# Phase J Raw Output Sidecar\n\nsha: ${sha}  ts: ${new Date().toISOString()}\n`];
  for (const entry of _rawOutputs) {
    lines.push(`## Turn ${entry.turnId} (${entry.ts})\n\n\`\`\`\n${entry.raw}\n\`\`\`\n`);
  }
  try {
    writeFileSync(sidecarFile, lines.join('\n'));
    console.log(`Sidecar: ${sidecarFile}`);
  } catch (sidecarErr) {
    // §#1758: sidecar write failure must not block receipt write
    console.error(`[receipt] sidecar write failed: ${sidecarErr.message}`);
    sidecarFile = null;
  }
}
receipt.raw_output_sidecar = sidecarFile ? sidecarFile.replace(STATE_DIR + '/', '') : null;

// §#1758: explicit error logging so post-VERDICT crashes are observable
try {
  writeFileSync(outFile, JSON.stringify(receipt, null, 2));
  console.log(`\nReceipt: ${outFile}`);
} catch (receiptErr) {
  console.error(`[receipt] WRITE FAILED: ${receiptErr.message}`);
  try {
    writeFileSync(outFile, JSON.stringify({ sha, passed, error: receiptErr.message }, null, 2));
    console.error(`[receipt] fallback written: ${outFile}`);
  } catch { /* unrecoverable */ }
}

process.exit(WASM_COHORT ? (receipt.wasm_cohort?.wasm_cohort_passed ? 0 : 1) : (passed ? 0 : 1));
