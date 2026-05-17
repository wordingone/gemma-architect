#!/usr/bin/env bun
// mtp-ab-tg.mjs — Dual-scenario MTP validation for E4B (#788 / #793).
//
// Connects to shared browser at :9222 (raw CDP WS, no Playwright).
// Loads E4B (default model — no ?gemma_model= param needed post #804).
// Runs two scenarios per #793's gate removal:
//   Scenario A (text-only): canonical build prompt — confirms MTP fires on text turns.
//   Scenario B (visual):    describe-scene prompt — confirms MTP fires on visual turns
//                           (multimodal bypass was removed in #793; accept_rate is lower
//                            but >0, so mtp_on must be true for both scenarios).
//
// Usage:
//   bun scripts/mtp-ab-tg.mjs
//
// Outputs: console table + scripts/mtp-ab-result.json
//
// Prerequisites:
//   - Shared browser at :9222 with a :5175 page tab loaded
//   - gemma-architect dev server at :5175 (gemma-architect-master autofwd or bun web:dev)
//   - E4B drafter ONNX reachable (CDN: GitHub Releases drafter-e4b-v1, or local public/models/)

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT_CDP = parseInt(process.env.PORT_CDP ?? "9222", 10);
const BASE_URL = process.env.APP_URL ?? "http://localhost:5175/";
// Scenario A: text-only build prompt — does NOT match VISUAL_RE in chat-panel.ts.
// /(see|look|what|describe|show|scene|there|currently|have|how many|visible|appear|color|shape|render|view|display|tell me about)/i
const PROMPT_TEXT   = "Build a 5m wall at the origin, then add a 5x5 floor slab beneath it.";
// Scenario B: visual prompt — DOES match VISUAL_RE, triggers auto-capture + multimodal.
// Per #793 gate removal: MTP must fire on visual turns too (mtp_on: true).
const PROMPT_VISUAL = "Describe what is currently visible in the scene.";
const TURN_TIMEOUT_MS = 180_000; // 3 min — E4B cold-start can be slow

async function cdpConnect(wsUrl) {
  const consoleLogs = [];
  const eventHandlers = new Map(); // event name → handler[]
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let msgId = 0;
    const pending = new Map();
    const cdp = {
      ws, consoleLogs,
      send: (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++msgId;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        }),
      // One-shot event listener — resolves when the named CDP event fires
      once: (event) =>
        new Promise((res) => {
          const list = eventHandlers.get(event) ?? [];
          list.push(res);
          eventHandlers.set(event, list);
        }),
    };
    ws.on("open", () => resolve(cdp));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      // Dispatch named events (Page.loadEventFired, etc.)
      if (msg.method) {
        const handlers = eventHandlers.get(msg.method);
        if (handlers?.length) {
          const h = handlers.shift();
          if (handlers.length === 0) eventHandlers.delete(msg.method);
          h(msg.params);
        }
      }
      // Capture console events (requires Runtime.enable + Console.enable)
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params?.args?.map(a => a.value ?? a.description ?? "").join(" ");
        if (text) consoleLogs.push({ level: msg.params.type, text });
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          // -32000 = page navigated or closed during evaluate — resolve null so callers can retry
          if (msg.error.code === -32000) res(null);
          else rej(new Error(JSON.stringify(msg.error)));
        } else {
          res(msg.result);
        }
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

async function navigate(cdp, url) {
  const loadPromise = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  // Wait for Page.loadEventFired (real signal) or 15s fallback
  await Promise.race([loadPromise, new Promise(r => setTimeout(r, 15_000))]);
  // Extra settle time — React hydration and model init start after DOMContentLoaded
  await new Promise(r => setTimeout(r, 2000));
}

async function evaluate(cdp, expression, timeoutMs = TURN_TIMEOUT_MS) {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (!r) throw new Error("CDP_NAVIGATED: page context gone during evaluate");
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function sendPromptAndWait(cdp, beforeCount, prompt = PROMPT_TEXT) {
  await evaluate(cdp, `
    (async () => {
      const inp = document.querySelector('.chat-input, #chat-input, textarea');
      if (!inp) throw new Error('no chat input found');
      inp.value = ${JSON.stringify(prompt)};
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
  console.log("[mtp-ab] waiting for model READY badge...");
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // Short synchronous expression — survives -32000 if page is mid-navigation
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => { const b = document.getElementById('ai-model-badge'); return b ? b.textContent : null; })()`,
        returnByValue: true,
        timeout: 5000,
      });
      const text = r?.result?.value;
      // Wait for READY, not just LIVE — PRIMING state (KV prewarm) comes after LIVE and
      // blocks inference. Sending a turn while badge shows ⟳ PRIMING causes turn timeout.
      if (text?.includes("READY")) return;
      if (text) process.stdout.write(`\r[mtp-ab] badge: ${text.trim().slice(0, 60)}   `);
    } catch (_) {
      // Evaluation failed (page context gone) — retry after delay
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("model READY timeout");
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

async function runTurn(cdp, url, { warmup = true, prompt = PROMPT_TEXT } = {}) {
  console.log(`\n[mtp-ab] navigating → ${url}`);
  await navigate(cdp, url);
  await waitLive(cdp);
  await waitDrafter(cdp);

  // Pre-turn diagnostic: verify page state before sending any turn.
  const diag = await evaluate(cdp, `({
    href: window.location.href,
    mtpParam: new URLSearchParams(window.location.search).get('mtp'),
    modelParam: new URLSearchParams(window.location.search).get('gemma_model'),
    drafterLoaded: window.__drafterLoaded,
    hasLoadFn: typeof window.__loadDrafter,
    badge: document.getElementById('ai-model-badge')?.textContent?.trim() ?? null,
  })`);
  console.log("[mtp-ab] page state:", JSON.stringify(diag));

  if (warmup) {
    // Warmup turn: lets WebGPU shaders compile and drafter session initialize.
    console.log("[mtp-ab] warmup turn...");
    const wBefore = await evaluate(cdp, `(window.__telemetry || []).length`);
    const wTurn = await sendPromptAndWait(cdp, wBefore, PROMPT_TEXT);
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

  // Measurement turn with specified prompt
  console.log(`[mtp-ab] measurement turn (prompt: ${JSON.stringify(prompt.slice(0, 60))}...)...`);
  const mBefore = await evaluate(cdp, `(window.__telemetry || []).length`);
  const turn = await sendPromptAndWait(cdp, mBefore, prompt);
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

// Scenario A: text-only — E4B default, canonical build prompt.
// MTP must fire: mtp_on=true.
const e4bUrl = `${BASE_URL}`;  // E4B is default — no ?gemma_model= param needed post #804
results.text = await runTurn(cdp, e4bUrl, { warmup: true, prompt: PROMPT_TEXT });
console.log("[mtp-ab] Scenario A (text-only):", JSON.stringify(results.text, null, 2));

// Scenario B: visual — same URL, prompt triggers VISUAL_RE → auto-capture.
// MTP must still fire (bypass removed in #793): mtp_on=true.
results.visual = await runTurn(cdp, e4bUrl, { warmup: false, prompt: PROMPT_VISUAL });
console.log("[mtp-ab] Scenario B (visual):", JSON.stringify(results.visual, null, 2));

// Gate: both scenarios must show mtp_on:true per #793
const textPass   = results.text?.mtp_on   === true;
const visualPass = results.visual?.mtp_on === true;
const bothPass   = textPass && visualPass;

const verdict =
  !textPass   ? "FAIL — text scenario mtp_on=false" :
  !visualPass ? "FAIL — visual scenario mtp_on=false" :
  "PASS — mtp_on=true for both text and visual scenarios";

const summary = {
  scenario_text:   { mtp_on: results.text?.mtp_on, tg_tps: results.text?.tg_tps, specAttempts: results.text?.specAttempts, specAccepts: results.text?.specAccepts },
  scenario_visual: { mtp_on: results.visual?.mtp_on, tg_tps: results.visual?.tg_tps, specAttempts: results.visual?.specAttempts, specAccepts: results.visual?.specAccepts },
  verdict,
  text_turn:   results.text,
  visual_turn: results.visual,
};

console.log("\n── E4B MTP Dual-Scenario Result (#788/#793) ──────────────────────────");
console.log(`  Scenario A (text-only): mtp_on=${results.text?.mtp_on}, tg=${results.text?.tg_tps?.toFixed(2)} t/s`);
console.log(`  Scenario B (visual):    mtp_on=${results.visual?.mtp_on}, tg=${results.visual?.tg_tps?.toFixed(2)} t/s`);
console.log(`  Verdict:                ${verdict}`);
console.log("──────────────────────────────────────────────────────────────────────");

const outFile = resolve(__dirname, "mtp-ab-result.json");
writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
console.log(`[mtp-ab] written: ${outFile}`);

cdp.ws.close();
