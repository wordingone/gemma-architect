/**
 * tier0-verify.mjs — Tier 0 Gemma 4 in-browser inference live check.
 * Sends "draw a 5m wall" through the chat panel, waits for model response,
 * asserts at least one dispatch verb was emitted.
 */
import { WebSocket } from "ws";
import { readFileSync } from "fs";
import { DEV_PORT } from "./ports.mjs";

const cdpJson = JSON.parse(readFileSync("B:/M/gemma-architect-master/.shared-browser/cdp.json", "utf8").replace(/^﻿/, ""));
const EP = cdpJson.endpoint;
console.log("Browser endpoint:", EP);

let msgId = 1;
const pending = new Map();
const ws = new WebSocket(EP);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
console.log("Connected");

const browserSend = (method, params = {}) => new Promise((resolve, reject) => {
  const id = msgId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result ?? {});
  }
});

// Attach to app tab
const { targetInfos } = await browserSend("Target.getTargets");
const target = targetInfos.find(t => t.url?.includes(`localhost:${DEV_PORT}`) && t.type === "page");
if (!target) { console.error(`No :${DEV_PORT} page target`); process.exit(1); }
const { sessionId } = await browserSend("Target.attachToTarget", { targetId: target.targetId, flatten: true });

const pageSend = (method, params = {}) => new Promise((resolve, reject) => {
  const id = msgId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, sessionId, method, params }));
});
await pageSend("Runtime.enable");

const evaluate = (expr, awaitPromise = false, timeout = 60000) => pageSend("Runtime.evaluate", {
  expression: expr, returnByValue: true, awaitPromise, timeout,
}).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? JSON.stringify(r.exceptionDetails));
  return r.result?.value;
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ── Check badge ───────────────────────────────────────────────────────────────
const badge = await evaluate(`document.getElementById('ai-model-badge')?.textContent ?? 'no-badge'`);
console.log("badge:", badge);

const remoteUrl = await evaluate(`(window.__getRemoteUrl?.() ?? window._REMOTE_URL ?? window.__VITE_GEMMA_AGENT_URL ?? 'unknown')`);
console.log("remoteUrl:", remoteUrl);

// ── Check __runIteration exists ───────────────────────────────────────────────
const hasFn = await evaluate(`typeof window.__runIteration === 'function'`);
console.log("__runIteration exists:", hasFn);
if (!hasFn) { console.error("FAIL: __runIteration not found"); process.exit(1); }

// ── Run inference ─────────────────────────────────────────────────────────────
console.log("Running __runIteration('draw a 5m wall')...");
const t0 = Date.now();

// Use CDP awaitPromise with 120s timeout
const result = await pageSend("Runtime.evaluate", {
  expression: `window.__runIteration(null, null, 'draw a 5m wall', [])`,
  returnByValue: true,
  awaitPromise: true,
  timeout: 120000,
}).then(r => r.result?.value).catch(e => ({ error: e.message }));

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`inference result (${elapsed}s):`, JSON.stringify(result));

const dispatches = result?.dispatches ?? [];
const verb = dispatches[0]?.verb ?? null;
const text = result?.text ?? "";

console.log("dispatches:", dispatches.length, "| first verb:", verb);
console.log("model text (first 200):", text.slice(0, 200));

const passed = dispatches.length > 0;
console.log(passed ? "PASS: dispatch verb emitted" : "FAIL: no dispatch verb — model did not produce <tool_call>");

ws.close();
process.exit(passed ? 0 : 1);
