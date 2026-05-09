#!/usr/bin/env bun
// Shared CDP utilities for retroactive evidence scripts.
import { WebSocket } from "ws";
import { mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";

export const SHA = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
mkdirSync("state", { recursive: true });

export function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Connect to the :5175 page target in the shared browser. */
export async function connectPage5175() {
  const targets = JSON.parse(execSync("curl -s http://localhost:9222/json", { encoding: "utf8" }));
  const target = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
  if (!target) throw new Error("No :5175 page target — is the shared browser running?");
  return connectWS(target.webSocketDebuggerUrl);
}

/** Connect to a raw WS CDP page target. Returns { send, evaluate, close }. */
export async function connectWS(wsUrl) {
  let msgId = 1;
  const pending = new Map();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  ws.on("message", raw => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result ?? {});
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "Runtime error");
    return r.result?.value;
  };

  const screenshot = async () => {
    const r = await send("Page.captureScreenshot", { format: "png", quality: 80 });
    return r.data; // base64
  };

  const close = () => ws.close();
  await send("Runtime.enable");
  await send("Page.enable");
  return { send, evaluate, screenshot, close };
}

/** Build a minimal receipt and write it. Returns allPassed. */
export function writeReceipt(outFile, checks, extra = {}) {
  const allPassed = checks.every(c => c.passed);
  writeFileSync(outFile, JSON.stringify({ sha: SHA, timestamp: new Date().toISOString(), all_passed: allPassed, checks, ...extra }, null, 2));
  console.log(`\n── Results ─────────────────────────────────────────`);
  for (const c of checks) console.log(`  ${c.passed ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`\nall_passed: ${allPassed}`);
  console.log(`Receipt: ${outFile}`);
  return allPassed;
}

/** Record a check. */
export function makeRecorder(checks) {
  return function record(name, passed, evidence) {
    checks.push({ name, passed, evidence });
    console.log(`  ${passed ? "✓" : "✗"} ${name}`);
    if (!passed) console.log("    evidence:", JSON.stringify(evidence).slice(0, 400));
  };
}
