#!/usr/bin/env bun
// mtp-ab-tg.mjs — A/B tg measurement: E2B with MTP vs E2B without MTP.
//
// Connects to shared browser at :9222 (raw CDP WS, no Playwright).
// Navigates the existing :5175 tab to ?gemma_model=e2b and ?gemma_model=e2b&mtp=off,
// sends one chat turn each, reads window.__telemetry for tg_tps.
//
// Usage:
//   bun scripts/mtp-ab-tg.mjs
//
// Outputs: console table + scripts/mtp-ab-result.json
//
// Prerequisites:
//   - Shared browser at :9222 with a :5175 page tab loaded
//   - gemma-architect dev server at :5175 (gemma-architect-master autofwd or bun web:dev)
//   - ?mtp=off URL param support (PR #779)

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT_CDP = parseInt(process.env.PORT_CDP ?? "9222", 10);
const BASE_URL = process.env.APP_URL ?? "http://localhost:5175/";
const PROMPT   = "Describe the default scene in one sentence.";
const TURN_TIMEOUT_MS = 180_000; // 3 min — E2B cold-start can be slow

async function cdpConnect(wsUrl) {
  const consoleLogs = [];
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    ws.on("open", () => resolve({
      ws, consoleLogs,
      send: (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++msgId;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        })
    }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      // Capture console events (requires Runtime.enable + Console.enable)
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params?.args?.map(a => a.value ?? a.description ?? "").join(" ");
        if (text) consoleLogs.push({ level: msg.params.type, text });
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.on("error", reject);
  });
}

async function getTarget() {
  const targets = await fetch(`http://localhost:${PORT_CDP}/json`).then(r => r.json());
  const host = new URL(BASE_URL).host;
  const t = targets.find(t => t.url?.includes(host) && t.type === "page")
         ?? targets.find(t => t.type === "page");
  if (!t) throw new Error(`No page tab found at :${PORT_CDP}`);
  return t;
}

async function navigate({ ws, send }, url) {
  await send("Page.navigate", { url });
  // Wait for page load
  await new Promise(r => setTimeout(r, 4000));
}

async function evaluate({ ws, send }, expression, timeoutMs = TURN_TIMEOUT_MS) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function sendPromptAndWait(cdp, beforeCount) {
  await evaluate(cdp, `
    (async () => {
      const inp = document.querySelector('.chat-input, #chat-input, textarea');
      if (!inp) throw new Error('no chat input found');
      inp.value = ${JSON.stringify(PROMPT)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    })()
  `);
  return evaluate(cdp, `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${TURN_TIMEOUT_MS};
      const before = ${beforeCount};
      const check = () => {
        const t = window.__telemetry || [];
        if (t.length > before) { resolve(t[t.length - 1]); return; }
        if (Date.now() > deadline) { reject(new Error('turn timeout')); return; }
        setTimeout(check, 1000);
      };
      check();
    })
  `);
}

async function waitLive(cdp) {
  console.log("[mtp-ab] waiting for model LIVE badge...");
  const loaded = await evaluate(cdp, `
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ${TURN_TIMEOUT_MS};
      const check = () => {
        const badge = document.getElementById('ai-model-badge');
        if (badge && badge.textContent.includes('LIVE')) { resolve(true); return; }
        if (Date.now() > deadline) { reject(new Error('model load timeout')); return; }
        setTimeout(check, 2000);
      };
      check();
    })
  `);
  if (!loaded) throw new Error("Model failed to reach LIVE state");
}

// Trigger drafter ONNX load and wait for it via window.__loadDrafter() (set by agent-harness).
// WebGPU shader compilation can take 30-120s on cold start — must complete before any turn.
async function waitDrafter(cdp) {
  const DRAFTER_TIMEOUT_MS = 300_000; // 5 min max (cold WebGPU shader compile)
  console.log("[mtp-ab] triggering drafter load + waiting for ready...");
  const result = await evaluate(cdp, `
    new Promise(async (resolve, reject) => {
      const deadline = Date.now() + ${DRAFTER_TIMEOUT_MS};
      if (typeof window.__loadDrafter !== 'function') {
        // Older build without the global — fall back to polling __drafterLoaded
        const poll = () => {
          if (window.__drafterLoaded === true) { resolve('loaded'); return; }
          if (Date.now() > deadline) { reject(new Error('drafter load timeout')); return; }
          setTimeout(poll, 2000);
        };
        poll();
        return;
      }
      try {
        await window.__loadDrafter();
        resolve(window.__drafterLoaded ? 'loaded' : 'failed');
      } catch (e) {
        resolve('failed: ' + e.message);
      }
    })
  `, DRAFTER_TIMEOUT_MS + 5000);
  if (result === 'loaded') {
    console.log("[mtp-ab] drafter ready (loaded).");
  } else {
    console.warn(`[mtp-ab] drafter load result: ${result} — MTP may not fire`);
  }
}

async function runTurn(cdp, url, { warmup = true } = {}) {
  console.log(`\n[mtp-ab] navigating → ${url}`);
  await navigate(cdp, url);
  await waitLive(cdp);
  await waitDrafter(cdp);

  if (warmup) {
    // Warmup turn: lets WebGPU shaders compile and drafter session initialize.
    // MTP is gated on drafter load completing (awaited inside runAgentTurn).
    // A fresh Chrome profile may need extra time for shader JIT.
    console.log("[mtp-ab] warmup turn...");
    const wBefore = await evaluate(cdp, `(window.__telemetry || []).length`);
    const wTurn = await sendPromptAndWait(cdp, wBefore);
    console.log(`[mtp-ab] warmup done: mtp_on=${wTurn?.mtp_on}, tg=${wTurn?.tg_tps?.toFixed(2)}`);

    if (!wTurn?.mtp_on) {
      const drafterLogs = cdp.consoleLogs
        .filter(l => l.text.includes("[agent-harness]") || l.text.includes("[mtp") || l.text.includes("Drafter") || l.text.includes("warn"))
        .slice(-20)
        .map(l => `[${l.level}] ${l.text}`);
      console.warn("[mtp-ab] mtp_on=false after warmup — relevant logs:");
      drafterLogs.forEach(l => console.warn(" ", l));
    }
  }

  // Measurement turn
  console.log("[mtp-ab] measurement turn...");
  const mBefore = await evaluate(cdp, `(window.__telemetry || []).length`);
  const turn = await sendPromptAndWait(cdp, mBefore);
  return turn;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const target = await getTarget();
console.log(`[mtp-ab] connecting to tab: ${target.url} (id: ${target.id})`);
const cdp = await cdpConnect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Console.enable");

const results = {};

// Run MTP-ON first
const mtpUrl = `${BASE_URL}?gemma_model=e2b`;
results.mtp_on = await runTurn(cdp, mtpUrl);
console.log("[mtp-ab] MTP-ON turn:", JSON.stringify(results.mtp_on, null, 2));

// Run MTP-OFF
const baseUrl = `${BASE_URL}?gemma_model=e2b&mtp=off`;
results.mtp_off = await runTurn(cdp, baseUrl);
console.log("[mtp-ab] MTP-OFF turn:", JSON.stringify(results.mtp_off, null, 2));

// Compute ratio
const mtp_tg    = results.mtp_on?.tg_tps ?? 0;
const base_tg   = results.mtp_off?.tg_tps ?? 0;
const ratio     = base_tg > 0 ? (mtp_tg / base_tg).toFixed(3) : "N/A";
const verdict   = parseFloat(ratio) >= 1.10 ? "PASS (≥10% speedup)" : parseFloat(ratio) >= 1.0 ? "MARGINAL (<10%)" : "FAIL (regression)";

const summary = {
  baseline_tg:  base_tg.toFixed(2),
  mtp_tg:       mtp_tg.toFixed(2),
  ratio,
  verdict,
  mtp_on_turn:  results.mtp_on,
  mtp_off_turn: results.mtp_off,
};

console.log("\n── A/B Result ────────────────────────────────────────");
console.log(`  baseline_tg (mtp=off): ${summary.baseline_tg} t/s`);
console.log(`  mtp_tg      (mtp=on):  ${summary.mtp_tg} t/s`);
console.log(`  ratio:                 ${ratio}`);
console.log(`  verdict:               ${verdict}`);
console.log("──────────────────────────────────────────────────────");

const outFile = resolve(__dirname, "mtp-ab-result.json");
writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
console.log(`[mtp-ab] written: ${outFile}`);

cdp.ws.close();
