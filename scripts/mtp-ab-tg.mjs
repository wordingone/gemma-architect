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
import { WebSocket } from "ws";

const PORT_CDP = 9222;
const BASE_URL = "http://localhost:5175/";
const PROMPT   = "Describe the default scene in one sentence.";
const TURN_TIMEOUT_MS = 180_000; // 3 min — E2B cold-start can be slow

async function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    ws.on("open", () => resolve({ ws, send: (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      })
    }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
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
  const t = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
  if (!t) throw new Error("No :5175 page tab in shared browser. Open http://localhost:5175/ first.");
  return t;
}

async function navigate({ ws, send }, url) {
  await send("Page.navigate", { url });
  // Wait for page load
  await new Promise(r => setTimeout(r, 4000));
}

async function evaluate({ ws, send }, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: TURN_TIMEOUT_MS,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function runTurn(cdp, url) {
  console.log(`\n[mtp-ab] navigating → ${url}`);
  await navigate(cdp, url);

  // Wait for model to load (badge shows LIVE)
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

  // Record turn count before
  const beforeCount = await evaluate(cdp, `(window.__telemetry || []).length`);

  // Send prompt via chat input
  console.log(`[mtp-ab] sending prompt: "${PROMPT}"`);
  await evaluate(cdp, `
    (async () => {
      const inp = document.querySelector('#chat-input, .chat-input, [data-chat-input], textarea');
      if (!inp) throw new Error('no chat input found');
      inp.value = ${JSON.stringify(PROMPT)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      // Try Enter key
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    })()
  `);

  // Wait for turn to complete (new entry in __telemetry)
  console.log("[mtp-ab] waiting for turn to complete...");
  const telemetry = await evaluate(cdp, `
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

  return telemetry;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const target = await getTarget();
console.log(`[mtp-ab] connecting to tab: ${target.url} (id: ${target.id})`);
const cdp = await cdpConnect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

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

const outFile = new URL("./mtp-ab-result.json", import.meta.url).pathname;
writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
console.log(`[mtp-ab] written: ${outFile}`);

cdp.ws.close();
