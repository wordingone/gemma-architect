#!/usr/bin/env bun
// clear-cache.mjs — Nuke all caches for the gemma-architect origin.
//
// Deletes:
//   - All Cache Storage caches (model weights, CDN assets)
//   - All IndexedDB databases (drafter ONNX — gemma-architect-models)
//   - LocalStorage + SessionStorage
//   - Service worker registrations
//
// Usage: bun scripts/clear-cache.mjs [--port CDP_PORT] [--target-url DEV_URL]
//
// Used by gemma-verify-raw.mjs --fresh-user flag before running the suite.

import WebSocket from "ws";
import { CDP_PORT as _DEFAULT_CDP_PORT, DEV_PORT as _DEFAULT_DEV_PORT } from "./ports.mjs";

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const CDP_PORT = portIdx !== -1 ? Number(args[portIdx + 1]) : _DEFAULT_CDP_PORT;
const targetIdx = args.indexOf("--target-url");
const TARGET_HINT = targetIdx !== -1 ? args[targetIdx + 1] : (process.env.GEMMA_DEV_URL ?? `localhost:${_DEFAULT_DEV_PORT}`);

// ── Connect to CDP ────────────────────────────────────────────────────────────
const targets = await fetch(`http://localhost:${CDP_PORT}/json`).then((r) => r.json()).catch(() => null);
if (!targets) {
  console.error(`[clear-cache] ERROR: CDP not reachable at http://localhost:${CDP_PORT}/json`);
  process.exit(1);
}

const target = targets.find(
  (t) => t.type === "page" && (t.url?.includes(`${_DEFAULT_DEV_PORT}`) || t.url?.includes(TARGET_HINT)),
);
if (!target?.webSocketDebuggerUrl) {
  console.error(`[clear-cache] ERROR: no matching page target for ${TARGET_HINT}. Targets:`, targets.map((t) => t.url));
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
};
await new Promise((r) => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) return null;
  return res?.result?.result?.value;
}

// ── Clear caches ──────────────────────────────────────────────────────────────
console.log("[clear-cache] Clearing all origin caches…");

const result = await evaluate(`(async () => {
  const log = [];

  // 1. Cache Storage
  try {
    const names = await caches.keys();
    for (const name of names) {
      await caches.delete(name);
      log.push('cache:' + name);
    }
  } catch (e) {
    log.push('cache-error:' + e.message);
  }

  // 2. IndexedDB
  try {
    const dbs = await indexedDB.databases();
    for (const { name } of dbs) {
      if (!name) continue;
      await new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
        req.onblocked = resolve; // proceed even if blocked
      });
      log.push('idb:' + name);
    }
  } catch (e) {
    log.push('idb-error:' + e.message);
  }

  // 3. localStorage + sessionStorage
  try {
    localStorage.clear();
    log.push('localStorage');
  } catch (e) {
    log.push('localStorage-error:' + e.message);
  }
  try {
    sessionStorage.clear();
    log.push('sessionStorage');
  } catch (e) {
    log.push('sessionStorage-error:' + e.message);
  }

  // 4. Service worker unregistrations
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      await reg.unregister();
      log.push('sw:' + reg.scope);
    }
  } catch (e) {
    log.push('sw-error:' + e.message);
  }

  return { cleared: log };
})()`);

ws.close();

if (!result) {
  console.error("[clear-cache] evaluate returned null — some caches may not have been cleared");
  process.exit(1);
}

console.log("[clear-cache] Cleared:", result.cleared.join(", ") || "(nothing found)");
console.log("[clear-cache] Done.");
