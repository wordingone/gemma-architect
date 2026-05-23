#!/usr/bin/env bun
// mtp-ab-tg.mjs — E4B MTP A/B dual-scenario (#788 / #793).
//
// Two arms × two scenarios:
//   Arm ON  (E4B default): MTP active via E4B drafter
//   Arm OFF (E4B + ?mtp=off): drafter short-circuited, standard generate
//   Scenario 1 (build):  "Build a 16-foot wall..." — text-only, no VISUAL_RE
//   Scenario 2 (visual): "What's currently in the scene?" — triggers VISUAL_RE → auto-capture
//
// Acceptance (#751 gate from mail #8347):
//   - ON arm: mtp_on=true for BOTH scenarios
//   - spec_attempts > 0 on ≥1 scenario
//   - ratio ≥ 1.10 on ≥1 scenario
//
// Usage:
//   bun scripts/mtp-ab-tg.mjs
//
// Outputs: console table + scripts/mtp-ab-result.json
//
// Prerequisites:
//   - Shared browser at :9222 with a :5847 page tab loaded
//   - gemma-architect dev server at :5847 (gemma-architect-master autofwd or bun web:dev)
//   - E4B drafter ONNX reachable (CDN: GitHub Releases drafter-e4b-v1, or local public/models/)

import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";
import { CDP_PORT, DEV_URL } from "./ports.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE_URL = process.env.APP_URL ?? DEV_URL;
// Scenario 1: text-only build prompt — does NOT match VISUAL_RE in chat-panel.ts.
// /(see|look|what|describe|show|scene|there|currently|have|how many|visible|appear|color|shape|render|view|display|tell me about)/i
const PROMPT_TEXT   = "Build a 16-foot wall at the origin, then add a 16' × 16' floor slab beneath it.";
// Scenario 2: canonical perception prompt per `feedback_test_scenarios_must_match_user_facing_use_case`.
// Matches VISUAL_RE ("what"/"currently"/"scene") → auto-capture + multimodal.
// Per #793 gate removal: MTP must fire on visual turns too (mtp_on:true in ON arm).
const PROMPT_VISUAL = "What's currently in the scene?";
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
  const targets = await fetch(`http://localhost:${CDP_PORT}/json`).then(r => r.json());
  const host = new URL(BASE_URL).host;
  const t = targets.find(t => t.url?.includes(host) && t.type === "page")
         ?? targets.find(t => t.type === "page");
  if (!t) throw new Error(`No page tab found at :${CDP_PORT}`);
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

async function runArm(cdp, url, armName) {
  console.log(`\n[mtp-ab] ── Arm ${armName} → ${url}`);
  await navigate(cdp, url);
  await waitLive(cdp);
  await waitDrafter(cdp);

  // Pre-arm diagnostic
  const diag = await evaluate(cdp, `({
    href: window.location.href,
    mtpParam: new URLSearchParams(window.location.search).get('mtp'),
    drafterLoaded: window.__drafterLoaded,
    hasLoadFn: typeof window.__loadDrafter,
    badge: document.getElementById('ai-model-badge')?.textContent?.trim() ?? null,
  })`);
  console.log(`[mtp-ab] [${armName}] page state:`, JSON.stringify(diag));

  // Warmup turn — WebGPU shader compile + drafter session init
  console.log(`[mtp-ab] [${armName}] warmup turn...`);
  const wBefore = await evaluate(cdp, `(window.__telemetry || []).length`);
  const wTurn = await sendPromptAndWait(cdp, wBefore, PROMPT_TEXT);
  console.log(`[mtp-ab] [${armName}] warmup done: mtp_on=${wTurn?.mtp_on}, tg=${wTurn?.tg_tps?.toFixed(2)}`);

  if (armName === "ON" && !wTurn?.mtp_on) {
    const drafterLogs = cdp.consoleLogs
      .filter(l => l.text.includes("[agent-harness]") || l.text.includes("[mtp") || l.text.includes("Drafter") || l.text.includes("warn"))
      .slice(-20)
      .map(l => `[${l.level}] ${l.text}`);
    console.warn(`[mtp-ab] [${armName}] mtp_on=false after warmup — relevant logs:`);
    drafterLogs.forEach(l => console.warn(" ", l));
  }

  // Scenario 1: build (text-only, no VISUAL_RE)
  console.log(`[mtp-ab] [${armName}] scenario build...`);
  const bBefore = await evaluate(cdp, `(window.__telemetry || []).length`);
  const buildTurn = await sendPromptAndWait(cdp, bBefore, PROMPT_TEXT);
  console.log(`[mtp-ab] [${armName}] build: mtp_on=${buildTurn?.mtp_on}, tg=${buildTurn?.tg_tps?.toFixed(2)}, spec_attempts=${buildTurn?.spec_attempts}`);

  // Scenario 2: visual — triggers VISUAL_RE → auto-capture + multimodal
  console.log(`[mtp-ab] [${armName}] scenario visual...`);
  const vBefore = await evaluate(cdp, `(window.__telemetry || []).length`);
  const visualTurn = await sendPromptAndWait(cdp, vBefore, PROMPT_VISUAL);
  console.log(`[mtp-ab] [${armName}] visual: mtp_on=${visualTurn?.mtp_on}, tg=${visualTurn?.tg_tps?.toFixed(2)}, spec_attempts=${visualTurn?.spec_attempts}`);

  return { build: buildTurn, visual: visualTurn };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const target = await getTarget();
console.log(`[mtp-ab] connecting to tab: ${target.url} (id: ${target.id})`);
const cdp = await cdpConnect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Console.enable");

// Arm ON:  E4B default URL — MTP active via E4B drafter.
// Arm OFF: same E4B model + ?mtp=off — drafter short-circuited, standard generate.
const urlOn  = `${BASE_URL}`;
const urlOff = `${BASE_URL}?mtp=off`;

const on  = await runArm(cdp, urlOn,  "ON");
const off = await runArm(cdp, urlOff, "OFF");

console.log("[mtp-ab] ON  arm:", JSON.stringify(on,  null, 2));
console.log("[mtp-ab] OFF arm:", JSON.stringify(off, null, 2));

// Ratios: tg_tps ON / tg_tps OFF per scenario
const ratioBuild  = (on.build?.tg_tps  ?? 0) / (off.build?.tg_tps  ?? 1);
const ratioVisual = (on.visual?.tg_tps ?? 0) / (off.visual?.tg_tps ?? 1);

// Gate (#751 — mail #8347):
//   ON arm: mtp_on=true for BOTH scenarios
//   spec_attempts > 0 on ≥1 scenario
//   ratio ≥ 1.10 on ≥1 scenario
const onBuildMtp  = on.build?.mtp_on  === true;
const onVisualMtp = on.visual?.mtp_on === true;
const specAttempts = (on.build?.spec_attempts ?? 0) + (on.visual?.spec_attempts ?? 0);
const ratioPass    = ratioBuild >= 1.10 || ratioVisual >= 1.10;

const verdict =
  !onBuildMtp   ? "FAIL — ON arm build scenario mtp_on=false" :
  !onVisualMtp  ? "FAIL — ON arm visual scenario mtp_on=false" :
  specAttempts === 0 ? "FAIL — spec_attempts=0 on both scenarios" :
  !ratioPass    ? `FAIL — ratio below 1.10 (build=${ratioBuild.toFixed(3)}, visual=${ratioVisual.toFixed(3)})` :
  "PASS";

const summary = {
  arm_on: {
    build:  { mtp_on: on.build?.mtp_on,  tg_tps: on.build?.tg_tps,  spec_attempts: on.build?.spec_attempts,  spec_accepts: on.build?.spec_accepts,  spec_accept_rate: on.build?.spec_accept_rate  },
    visual: { mtp_on: on.visual?.mtp_on, tg_tps: on.visual?.tg_tps, spec_attempts: on.visual?.spec_attempts, spec_accepts: on.visual?.spec_accepts, spec_accept_rate: on.visual?.spec_accept_rate },
  },
  arm_off: {
    build:  { tg_tps: off.build?.tg_tps  },
    visual: { tg_tps: off.visual?.tg_tps },
  },
  ratio_build:  ratioBuild,
  ratio_visual: ratioVisual,
  verdict,
  on_turns:  on,
  off_turns: off,
};

console.log("\n── E4B MTP A/B Result (#788/#793) ────────────────────────────────────");
console.log(`  ON  build:  mtp_on=${on.build?.mtp_on},  tg=${on.build?.tg_tps?.toFixed(2)} t/s, spec_attempts=${on.build?.spec_attempts}, accept_rate=${on.build?.spec_accept_rate?.toFixed(3)}`);
console.log(`  ON  visual: mtp_on=${on.visual?.mtp_on}, tg=${on.visual?.tg_tps?.toFixed(2)} t/s, spec_attempts=${on.visual?.spec_attempts}, accept_rate=${on.visual?.spec_accept_rate?.toFixed(3)}`);
console.log(`  OFF build:  tg=${off.build?.tg_tps?.toFixed(2)} t/s`);
console.log(`  OFF visual: tg=${off.visual?.tg_tps?.toFixed(2)} t/s`);
console.log(`  Ratio build:  ${ratioBuild.toFixed(3)}`);
console.log(`  Ratio visual: ${ratioVisual.toFixed(3)}`);
console.log(`  Verdict: ${verdict}`);
console.log("──────────────────────────────────────────────────────────────────────");

const outFile = resolve(__dirname, "mtp-ab-result.json");
writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n");
console.log(`[mtp-ab] written: ${outFile}`);

cdp.ws.close();
