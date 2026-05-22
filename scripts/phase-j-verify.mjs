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

const PAGES_URL   = "https://wordingone.github.io/gemma-architect/";
const STATE_DIR   = `${process.cwd()}/state`;
const NO_RELOAD   = process.argv.includes("--no-reload");
// --cold: clear Cache API + IndexedDB before reload (true cold-cache per leo 02:10Z mail).
// Satisfies feedback_no_localhost_testing + standing cold-cache gate directive.
// Model re-downloads (~2.5GB) — run once per PR cycle, not every iteration.
const COLD_CACHE  = process.argv.includes("--cold") && !NO_RELOAD;
const PROMPT_N    = Number(process.argv.find(a => a.startsWith("--prompts="))?.split("=")[1] ?? 5);
const BOOT_TIMEOUT_MS  = COLD_CACHE ? 65 * 60 * 1000 : 10 * 60 * 1000;  // 65 min cold (local override — 2.5GB re-download), 10 min warm
const TURN_TIMEOUT_MS  = 10 * 60 * 1000;  // 10 min — covers recycle+auto-retry (90s recovery + 226s generation)

// #1476/#1482: use STARTER_PROMPTS sequence per user directive 2026-05-21.
// Turn 1: full architectural goal (tests goal-mode + multi-turn dispatch).
// Turn 2: scene-query (tests NL-only response path — no dispatches expected).
// Turns 3-5: continuation goals.
const STARTER_PROMPTS = [
  "Build a two-story residential house, 8m wide by 6m deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs.",
  "What's currently in the scene?",
  "Add a single-car garage attached to the south wall, 5m wide by 4m deep.",
  "What's currently in the scene?",
  "Add a garden wall along the north boundary, 12m long and 1m tall.",
];
const DEMO_PROMPTS = STARTER_PROMPTS.slice(0, PROMPT_N);

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
console.log(`   Mode: ${COLD_CACHE ? "COLD-CACHE (Storage.clearDataForOrigin)" : NO_RELOAD ? "NO-RELOAD (warm)" : "SOFT-RELOAD (warm)"}`);

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

// ── Collect console messages ───────────────────────────────────────────────────

const consoleErrors = [];
const arcInvalidTransitions = [];
const bufferManagerErrors = [];
const compactEvents = [];

eventHandlers.push(evt => {
  // Runtime.consoleAPICalled
  if (evt.method === "Runtime.consoleAPICalled") {
    const level = evt.params?.type ?? "log";
    const args  = (evt.params?.args ?? []).map(a => a.value ?? a.description ?? "").join(" ");
    if (level === "error" || args.includes("[ARC] invalid transition") || args.includes("buffer_manager") || args.includes("[#1463]")) {
      consoleErrors.push({ ts: ts(), level, text: args.slice(0, 300) });
      if (args.includes("[ARC] invalid transition")) {
        arcInvalidTransitions.push(args);
        console.error(`  ⚠ ARC invalid-transition: ${args}`);
      }
      if (args.includes("buffer_manager") || args.includes("OrtRun")) {
        bufferManagerErrors.push(args.slice(0, 200));
        console.error(`  ⚠ buffer_manager error: ${args.slice(0, 120)}`);
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
  }
});

// ── Inject compact-event collector (#1439) ────────────────────────────────────
// Runs on every new document so the listener survives cold-cache reload.

await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__compact_events=[];window.addEventListener('agentmodel:compact',function(e){window.__compact_events.push({ts:Date.now(),preTurns:e.detail.preTurns,postTurns:e.detail.postTurns});});`,
});

// #1482: capture per-turn dispatch counts + goal state for receipt schema extensions.
await cdp("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__phase_j_turns=[];window.__phase_j_current={dispatchVerbs:[],goalState:'absent'};
window.addEventListener('agent:turn-complete',function(e){
  var v=e.detail&&e.detail.verbs?e.detail.verbs:[];
  window.__phase_j_current.dispatchVerbs=v;
});
window.addEventListener('goal:state-change',function(e){
  window.__phase_j_current.goalState=e.detail&&e.detail.status?e.detail.status:'unknown';
});`,
});

// ── Reload tab (unless --no-reload) ───────────────────────────────────────────

const startMs = Date.now();
if (!NO_RELOAD) {
  if (COLD_CACHE) {
    // True cold-cache: clear Cache API (transformers.js model weights), IndexedDB,
    // service workers. This is what leo's run-pages-comprehensive.mjs does (~line 140).
    // Model must re-download from CDN (~2.5GB) — expect 15-20min boot window.
    console.log(`\n[+${0}ms] Clearing Cache API + IndexedDB for true cold-cache...`);
    await cdp("Storage.clearDataForOrigin", {
      origin: "https://wordingone.github.io",
      storageTypes: "cache_storage,indexeddb,service_workers,websql,file_systems",
    });
    await delay(2000);
    console.log(`[+${Date.now()-startMs}ms] Storage cleared. Navigating to Pages...`);
    await cdp("Page.navigate", { url: PAGES_URL });
    await delay(3000);
  } else {
    console.log(`\n[+${0}ms] Reloading Pages tab (soft — preserves Cache API model weights)...`);
    // Soft reload: new JS bundles from CDN; OPFS/HTTP cache model weights survive.
    // NOT cold-cache (Cache API survives). Use --cold for the gate-recording run.
    await cdp("Page.reload", { ignoreCache: false });
    await delay(3000);
  }
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

  if (arcState === "ready") {
    bootComplete = true;
    bootArcState = arcState;
    break;
  }
  if (arcState === "generating" || arcState === "recycling" || arcState === "recovering") {
    // Passed through 'ready' faster than the 5s poll window — boot is complete.
    bootComplete = true;
    bootArcState = arcState;
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

if (bootComplete) {
  console.log(`\n── Running ${DEMO_PROMPTS.length} prompts ─────────────────────────────────────`);

  for (let i = 0; i < DEMO_PROMPTS.length; i++) {
    const prompt  = DEMO_PROMPTS[i];
    const turnMs0 = Date.now();
    const preErrorCount = bufferManagerErrors.length;
    console.log(`\n[+${Date.now()-startMs}ms] Turn ${i+1}/${DEMO_PROMPTS.length}: "${prompt}"`);

    // Reset scene before each turn
    await evaluate(`window.__dispatch?.('SdClearScene', {})`, 5000).catch(() => null);
    await delay(300);

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
        outcome = "generate-done";
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
    // Reset for next turn.
    await evaluate("window.__phase_j_current={dispatchVerbs:[],goalState:'absent'}", 2000).catch(() => null);

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
      nlResponse: isNlResponse,
      durationMs,
    };
    if (fatalErrorMsg !== undefined) turnEntry.fatalErrorMsg = fatalErrorMsg;
    turnResults.push(turnEntry);
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

ws.close();

// ── Summary ────────────────────────────────────────────────────────────────────

const totalMs     = Date.now() - startMs;
const cleanTurns  = turnResults.filter(r => r.outcome === "generate-done" && !r.workerRecycled).length;
const doneTurns   = turnResults.filter(r => r.outcome === "generate-done").length;  // §#688: includes recycle-recovered
const arcInvClean = arcInvalidTransitions.length === 0;
const bufMgrClean = turn1BufferManagerErrors === 0;

console.log(`\n┌──────────────────────────────────────────────────────┐`);
console.log(`│  Phase J verify — ${ts().slice(0,19)}               │`);
console.log(`├──────────────────────────────────────────────────────┤`);
console.log(`│  mode          : ${String(COLD_CACHE ? "COLD-CACHE" : "warm").padEnd(35)}│`);
console.log(`│  boot-complete : ${String(bootComplete).padEnd(35)}│`);
console.log(`│  ARC inv-trans : ${String(arcInvalidTransitions.length === 0 ? "CLEAN" : `${arcInvalidTransitions.length} errors`).padEnd(35)}│`);
console.log(`│  bufMgr turn-1 : ${String(bufMgrClean ? "CLEAN" : `${turn1BufferManagerErrors} errors`).padEnd(35)}│`);
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
const turn2NlOk       = turnResults[1]?.nlResponse === true;
const passed = bootComplete && arcInvClean && bufMgrClean
  && cleanTurns >= Math.ceil(PROMPT_N * 0.6)
  && turn1DispatchOk
  && turn2NlOk;
console.log(`├──────────────────────────────────────────────────────┤`);
console.log(`│  turn1 dispatch: ${String(turn1DispatchOk ? `${turn1DispatchCount} dispatches ✓` : `${turn1DispatchCount} dispatches ✗ (need ≥3)`).padEnd(35)}│`);
console.log(`│  turn2 NL-only : ${String(turn2NlOk ? "true ✓" : `${turnResults[1]?.nlResponse} ✗`).padEnd(35)}│`);
const verdict = `│  VERDICT : ${passed ? "PASS — baseline direction: ↑" : "FAIL"}`;
console.log(verdict.padEnd(54) + "  │");
console.log(`└──────────────────────────────────────────────────────┘`);

// ── Write receipt ──────────────────────────────────────────────────────────────

// #1482: aggregate dispatch metrics across all turns.
const totalDispatches  = turnResults.reduce((s, r) => s + (r.dispatchCount ?? 0), 0);
const turnsWithDispatch = turnResults.filter(r => (r.dispatchCount ?? 0) > 0).length;
const turn1DispatchCount = turnResults[0]?.dispatchCount ?? 0;
const turn1GoalState     = turnResults[0]?.goalState ?? "absent";

const receipt = {
  sha,
  timestamp: ts(),
  pages_url: PAGES_URL,
  cold_cache: COLD_CACHE,
  boot_complete: bootComplete,
  boot_arc_state: bootArcState,
  boot_ms: bootMs,
  arc_invalid_transitions: arcInvalidTransitions,
  arc_invalid_clean: arcInvClean,
  buffer_manager_errors: bufferManagerErrors,
  buffer_manager_turn1_clean: bufMgrClean,
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
  compact_events: compactEvents,
  passed,
};
writeFileSync(outFile, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${outFile}`);

process.exit(passed ? 0 : 1);
