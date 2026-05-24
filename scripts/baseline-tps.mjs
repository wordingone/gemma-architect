#!/usr/bin/env bun
// baseline-tps.mjs — Baseline TPS measurement for #1861 (self-spec early-exit #1860).
//
// Connects to the shared browser at :9222 (raw CDP WebSocket, no Playwright).
// Cold-cache boots the target URL, then runs each canonical imperial prompt
// 10 times, capturing tg_tps from window.__telemetry after each turn.
//
// Required: shared browser running at :9222. Pass Pages URL via --url flag.
// NOT for localhost. Per feedback_no_localhost_testing_permanent_ban.
//
// Usage:
//   bun scripts/baseline-tps.mjs --url https://wordingone.github.io/gemma-architect/
//   bun scripts/baseline-tps.mjs --url https://wordingone.github.io/gemma-architect/ --turns 10

import { writeFileSync, mkdirSync } from "fs";
import { CDP_PORT, CDP_BASE } from "./ports.mjs";

// ── Args ──────────────────────────────────────────────────────────────────────

const urlIdx = process.argv.indexOf("--url");
const PAGES_URL = urlIdx !== -1 ? process.argv[urlIdx + 1] : null;
if (!PAGES_URL) {
  console.error("ERROR: --url <pages-url> required. No localhost.");
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(PAGES_URL)) {
  console.error("ERROR: localhost banned per feedback_no_localhost_testing_permanent_ban.");
  process.exit(1);
}

const turnsIdx = process.argv.indexOf("--turns");
const TURNS_PER_PROMPT = turnsIdx !== -1 ? parseInt(process.argv[turnsIdx + 1]) : 10;

// ── Canonical imperial prompts (from STARTER_PROMPTS in chat-panel.ts) ───────

const PROMPTS = [
  { label: "two-story-house", complexity: "long",
    text: "Build a two-story residential house, 26' wide by 20' deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs." },
  { label: "scene-query", complexity: "short",
    text: "What's currently in the scene?" },
  { label: "wall-height", complexity: "short",
    text: "Change the height of the currently selected wall to 10'." },
  { label: "garage", complexity: "medium",
    text: "Add an attached single-car garage, 12' wide by 22' deep, connected to the right side of the house." },
  { label: "section-cut", complexity: "medium",
    text: "Cut a vertical section through the center of the building and describe the structural elements and layers visible in the section." },
  { label: "stair-add", complexity: "medium",
    text: "Add a straight-run stair from the first floor to the second floor, 3' wide, with 14 risers each 7\" tall." },
];

// ── CDP helpers ───────────────────────────────────────────────────────────────

function cdpWs(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        ws.send(JSON.stringify({ id: msgId, method, params }));
      }),
      on: (method, cb) => { ws._handlers = ws._handlers ?? {}; ws._handlers[method] = cb; },
      ws,
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
      if (msg.method && ws._handlers?.[msg.method]) ws._handlers[msg.method](msg.params);
    };
    ws.onerror = reject;
    ws.onclose = () => reject(new Error("WebSocket closed unexpectedly"));
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function percentile(sorted, p) {
  const i = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(i), hi = Math.ceil(i);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`[baseline-tps] Target: ${PAGES_URL}`);
console.log(`[baseline-tps] Turns per prompt: ${TURNS_PER_PROMPT}`);
console.log(`[baseline-tps] Total samples: ${TURNS_PER_PROMPT * PROMPTS.length}`);
console.log(`[baseline-tps] CDP: ${CDP_BASE}`);

// 1. Find shared browser tab
const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) {
  console.error(`ERROR: Cannot reach CDP at ${CDP_BASE} — is the shared browser running?`);
  process.exit(1);
}

// Use any existing page tab — we navigate it to Pages URL anyway.
// Do NOT filter on localhost: the tab's origin will become Pages after navigation.
const pagesHost = new URL(PAGES_URL).host;
let target = targets.find(t => t.type === "page");
if (!target) {
  console.error("ERROR: no page tab found in shared browser");
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(target.url)) {
  console.log(`[baseline-tps] Tab is at ${target.url} — will navigate to Pages URL (origin-local storage cleared after nav)`);
}

console.log(`[baseline-tps] Attaching to tab: ${target.url}`);
const cdp = await cdpWs(target.webSocketDebuggerUrl);

// 2. Enable domains
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");

// 3. Navigate to Pages URL FIRST (must be in Pages origin to clear Pages storage)
console.log("[baseline-tps] Navigating to Pages URL...");
const nav1Done = new Promise(res => {
  cdp.on("Page.frameNavigated", (p) => {
    if (p.frame.url?.includes(pagesHost)) res(p.frame.url);
  });
});
await cdp.send("Page.navigate", { url: PAGES_URL });
await Promise.race([nav1Done, sleep(30000)]);
console.log("[baseline-tps] Pages URL loaded. Now clearing origin storage (cold-cache)...");
await sleep(2000); // let page settle before clearing

// 4. Cold-cache clear in Pages origin context
// Network-level: browser-wide HTTP cache + cookies
await cdp.send("Network.clearBrowserCache");
await cdp.send("Network.clearBrowserCookies");

// Origin-level: Cache API, IDB, SW — runs in Pages origin, clears Pages storage only
const clearResult = await cdp.send("Runtime.evaluate", {
  expression: `(async () => {
    const log = [];
    try {
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
        log.push('sw:' + regs.length);
      }
    } catch (e) { log.push('sw-err:' + e.message); }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      log.push('cache:' + keys.length);
    } catch (e) { log.push('cache-err:' + e.message); }
    try {
      const dbs = await indexedDB.databases?.() ?? [];
      await Promise.all(dbs.map(db => new Promise((res, rej) => {
        const req = indexedDB.deleteDatabase(db.name);
        req.onsuccess = res; req.onerror = () => rej(req.error); req.onblocked = res;
      })));
      log.push('idb:' + dbs.length);
    } catch (e) { log.push('idb-err:' + e.message); }
    try { localStorage.clear(); log.push('ls'); } catch {}
    return log.join(',');
  })()`,
  awaitPromise: true,
}).catch(e => ({ result: { value: "clear-error:" + e.message } }));
console.log(`[baseline-tps] Storage cleared: ${clearResult?.result?.value ?? '?'}`);

// 5. Reload to cold-boot (all storage now clear — this is the actual cold-cache start)
console.log("[baseline-tps] Reloading for cold-cache boot...");
const nav2Done = new Promise(res => {
  cdp.on("Page.frameNavigated", (p) => {
    if (p.frame.url?.includes(pagesHost) && p.frame.parentId === undefined) res(p.frame.url);
  });
});
await cdp.send("Page.reload", { ignoreCache: true });
await Promise.race([nav2Done, sleep(15000)]);
console.log("[baseline-tps] Reload done. Waiting for boot...");

// 6. Wait for agentmodel:boot-complete (cold boot takes 2-5 min for E4B)
const BOOT_TIMEOUT_MS = 360000; // 6 min
const bootDone = new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("Boot timeout (6 min)")), BOOT_TIMEOUT_MS);
  cdp.send("Runtime.evaluate", {
    expression: `
      new Promise((resolve) => {
        if (document.querySelector('.chat-input') && !document.querySelector('.boot-screen')) {
          resolve('already-ready');
          return;
        }
        window.addEventListener('agentmodel:boot-complete', () => resolve('boot-complete'), { once: true });
        window.addEventListener('agentmodel:fatal', () => resolve('fatal'), { once: true });
      })
    `,
    awaitPromise: true,
    timeout: BOOT_TIMEOUT_MS,
  }).then(r => { clearTimeout(t); res(r.result?.value ?? 'unknown'); })
    .catch(e => { clearTimeout(t); rej(e); });
});

let bootResult;
try {
  bootResult = await bootDone;
  console.log(`[baseline-tps] Boot result: ${bootResult}`);
  if (bootResult === "fatal") {
    console.error("ERROR: boot ended with fatal — WebGPU not available or model failed to load");
    process.exit(1);
  }
} catch (e) {
  console.error("ERROR: boot timeout:", e.message);
  process.exit(1);
}

// 6. Read model info
const modelInfo = await cdp.send("Runtime.evaluate", {
  expression: `JSON.stringify({
    telemetry_count: (window.__telemetry ?? []).length,
    session: window.__gemmaSession ?? null,
  })`,
}).then(r => { try { return JSON.parse(r.result?.value ?? '{}'); } catch { return {}; } });

console.log(`[baseline-tps] Model info:`, modelInfo);

// 7. Run prompts
const samples = [];
let baselineTelCount = modelInfo.telemetry_count ?? 0;

for (let pi = 0; pi < PROMPTS.length; pi++) {
  const prompt = PROMPTS[pi];
  console.log(`\n[baseline-tps] Prompt ${pi + 1}/${PROMPTS.length}: ${prompt.label}`);

  for (let turn = 1; turn <= TURNS_PER_PROMPT; turn++) {
    const beforeCount = baselineTelCount;

    // Inject prompt into chat input
    await cdp.send("Runtime.evaluate", {
      expression: `
        (() => {
          const inp = document.querySelector('.chat-input');
          if (!inp) return 'no-input';
          if (inp.disabled) return 'disabled';
          inp.value = ${JSON.stringify(prompt.text)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true, shiftKey: false }));
          inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          return 'sent';
        })()
      `,
    });

    // Poll for telemetry increment (turn completed)
    const TURN_TIMEOUT_MS = 120000; // 2 min per turn
    const startMs = Date.now();
    let tgTps = null;
    let telEntry = null;

    while (Date.now() - startMs < TURN_TIMEOUT_MS) {
      await sleep(2000);
      const check = await cdp.send("Runtime.evaluate", {
        expression: `
          (() => {
            const t = window.__telemetry ?? [];
            if (t.length <= ${beforeCount}) return null;
            const last = t[t.length - 1];
            return JSON.stringify({ tg_tps: last.tg_tps, pp_tps: last.pp_tps, tokens_out: last.tokens_out, decode_ms: last.decode_ms, path: last.path });
          })()
        `,
      }).then(r => { try { return r.result?.value ? JSON.parse(r.result.value) : null; } catch { return null; } });

      if (check) {
        telEntry = check;
        tgTps = check.tg_tps;
        baselineTelCount = beforeCount + 1;
        break;
      }
    }

    if (tgTps === null) {
      console.warn(`  [turn ${turn}] TIMEOUT — no telemetry after 2 min`);
      samples.push({ prompt_idx: pi, prompt: prompt.label, complexity: prompt.complexity, turn, tg_tps: null, pp_tps: null, tokens_out: null, decode_ms: null, error: "timeout" });
    } else {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      console.log(`  [turn ${turn}] tg_tps=${tgTps?.toFixed(1)} tokens_out=${telEntry.tokens_out} decode_ms=${Math.round(telEntry.decode_ms)} path=${telEntry.path} (+${elapsed}s)`);
      samples.push({ prompt_idx: pi, prompt: prompt.label, complexity: prompt.complexity, turn, tg_tps: tgTps, pp_tps: telEntry.pp_tps, tokens_out: telEntry.tokens_out, decode_ms: telEntry.decode_ms, path: telEntry.path });
    }

    // Small gap between turns to avoid triggering history budget or goal continuation
    await sleep(1000);
  }
}

// 8. Compute stats per prompt
const stats = {};
for (let pi = 0; pi < PROMPTS.length; pi++) {
  const p = PROMPTS[pi];
  const tpsValues = samples.filter(s => s.prompt_idx === pi && s.tg_tps !== null).map(s => s.tg_tps).sort((a, b) => a - b);
  if (tpsValues.length === 0) { stats[p.label] = { error: "no valid samples" }; continue; }
  stats[p.label] = {
    count: tpsValues.length,
    median: percentile(tpsValues, 50),
    p25: percentile(tpsValues, 25),
    p75: percentile(tpsValues, 75),
    min: tpsValues[0],
    max: tpsValues[tpsValues.length - 1],
    complexity: p.complexity,
  };
}

// 9. Write output
const date = new Date().toISOString().slice(0, 10);
const outPath = `${process.cwd()}/state/baseline-tps-${date}.json`;
mkdirSync(`${process.cwd()}/state`, { recursive: true });
const output = {
  date,
  url: PAGES_URL,
  cold_cache: true,
  turns_per_prompt: TURNS_PER_PROMPT,
  prompt_count: PROMPTS.length,
  total_samples: samples.filter(s => s.tg_tps !== null).length,
  stats,
  samples,
};
writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log(`\n[baseline-tps] Done. Output: ${outPath}`);
console.log("[baseline-tps] Stats summary:");
for (const [label, s] of Object.entries(stats)) {
  if (s.error) { console.log(`  ${label}: ERROR — ${s.error}`); continue; }
  console.log(`  ${label} (${s.complexity}): median=${s.median?.toFixed(1)} p25=${s.p25?.toFixed(1)} p75=${s.p75?.toFixed(1)} n=${s.count}`);
}
