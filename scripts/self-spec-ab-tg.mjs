#!/usr/bin/env bun
// self-spec-ab-tg.mjs — Self-speculative decoding A/B harness (#1860 Sub-7).
//
// Two cold-cache arms:
//   Path A (baseline):   ?mtp=off      — MTP+self-spec disabled entirely
//   Path B (self-spec):  default URL   — SelfSpecController active (warmup-gated)
//
// Per arm: 6 canonical imperial prompts × N_TURNS_PER_ROUND rounds.
// Per turn: capture self_spec_active, accepted_tokens, acceptance_rate, verify_beta,
//           effective_tps, speedup_observed from window.__telemetry.
//
// Acceptance gate (issue #1867):
//   speedup_p50 ≥ 1.35 × baseline TPS
//   acceptance_rate_p50 ≥ 0.80
//   verify_beta_p50 ≤ 1.30
//   deviceLostCount == 0
//   oomCount == 0
//
// Usage:
//   bun scripts/self-spec-ab-tg.mjs [--dry-run]
//
// Env overrides:
//   APP_URL             — override Pages URL (default from ports.mjs DEV_URL)
//   SELF_SPEC_N_ROUNDS  — number of prompt cycles per arm (default 2)
//
// Outputs: console summary + state/self-spec-ab-samples-<sha>.json + receipt

import { execSync }                from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname }        from "path";
import { fileURLToPath }           from "url";
import { WebSocket }               from "ws";
import { CDP_PORT, DEV_URL }       from "./ports.mjs";
import { buildReceipt }            from "./self-spec-acceptance-receipt.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL  = process.env.APP_URL ?? DEV_URL;
const DRY_RUN   = process.argv.includes("--dry-run");

// Number of cycles through all 6 prompts per arm.
// Turns per arm = N_ROUNDS × 6. Minimum 2 for meaningful p50.
// Recommend 3+ (18 turns per arm, ~15-30 min) for gate-grade data.
const N_ROUNDS = parseInt(process.env.SELF_SPEC_N_ROUNDS ?? "2");

const TURN_TIMEOUT_MS = 180_000; // 3 min per turn

// 6 canonical imperial prompts (all measurements in imperial units).
// Designed to exercise both text-only (build) and perception (scene query) paths.
const PROMPTS = [
  // 1. Build — text-only, no VISUAL_RE match
  "Build a 16-foot wide, 8-foot tall exterior wall at the origin.",
  // 2. Visual query — matches VISUAL_RE ("what"/"currently"/"scene") → multimodal
  "What's currently in the scene? Describe all elements and their dimensions in feet.",
  // 3. Spatial — extends scene, imperial coords
  "Add a 10-foot tall column 6 feet east of the current wall.",
  // 4. Transform — imperial delta
  "Move the floor slab down 4 feet.",
  // 5. Measurement query — forces model to read scene geometry
  "What are the exact dimensions of each element in the scene? List in feet and inches.",
  // 6. Complex build — two elements, imperial
  "Add a 20-foot by 16-foot rectangular slab at elevation 0 as a floor base, then add a 24-foot wide roof at 12 feet above grade.",
];

// ── CDP helpers (same pattern as mtp-ab-tg.mjs) ──────────────────────────────

async function cdpConnect(wsUrl) {
  const consoleLogs   = [];
  const eventHandlers = new Map();
  return new Promise((resolve, reject) => {
    const ws     = new WebSocket(wsUrl);
    let   msgId  = 0;
    const pending = new Map();
    const cdp = {
      ws, consoleLogs,
      send: (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++msgId;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        }),
      once: (event) =>
        new Promise((res) => {
          const list = eventHandlers.get(event) ?? [];
          list.push(res);
          eventHandlers.set(event, list);
        }),
    };
    ws.on("open",    () => resolve(cdp));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method) {
        const handlers = eventHandlers.get(msg.method);
        if (handlers?.length) {
          const h = handlers.shift();
          if (handlers.length === 0) eventHandlers.delete(msg.method);
          h(msg.params);
        }
      }
      if (msg.method === "Runtime.consoleAPICalled") {
        const text = msg.params?.args?.map(a => a.value ?? a.description ?? "").join(" ");
        if (text) consoleLogs.push({ level: msg.params.type, text });
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
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
  const host    = new URL(BASE_URL).host;
  const t = targets.find(t => t.url?.includes(host) && t.type === "page")
         ?? targets.find(t => t.type === "page");
  if (!t) throw new Error(`No page tab at :${CDP_PORT} — is the shared browser up?`);
  return t;
}

async function evaluate(cdp, expression, timeoutMs = TURN_TIMEOUT_MS) {
  const r = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs,
  });
  if (!r) throw new Error("CDP_NAVIGATED: page context gone during evaluate");
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
}

async function navigate(cdp, url) {
  const loadPromise = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await Promise.race([loadPromise, new Promise(r => setTimeout(r, 15_000))]);
  await new Promise(r => setTimeout(r, 2000)); // React hydration settle
}

// Full cold-cache wipe for the given origin. Clears Cache API, IDB, SW, cookies, HTTP.
async function clearCache(cdp, origin) {
  await navigate(cdp, "about:blank"); // leave origin context before clearing
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Network.clearBrowserCookies");
  // Clear origin storage (Cache API, IDB, localStorage, sessionStorage)
  try {
    await cdp.send("Storage.clearDataForOrigin", {
      origin, storageTypes: "all",
    });
  } catch (_) {
    // Older CDP targets may not support this method — warn and continue
    console.warn("[self-spec-ab] Storage.clearDataForOrigin failed — continuing with HTTP cache cleared");
  }
  // Unregister service workers so stale SW caches don't serve cached JS
  try {
    await cdp.send("ServiceWorker.unregister", { scopeURL: origin + "/" });
  } catch (_) { /* ignore — no SW registered is fine */ }
}

async function waitLive(cdp) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  process.stdout.write("[self-spec-ab] waiting for model READY...");
  while (Date.now() < deadline) {
    try {
      const r = await cdp.send("Runtime.evaluate", {
        expression: `(() => { const b = document.getElementById('ai-model-badge'); return b ? b.textContent : null; })()`,
        returnByValue: true,
        timeout: 5000,
      });
      const text = r?.result?.value;
      if (text?.includes("READY")) { process.stdout.write(" READY\n"); return; }
      if (text) process.stdout.write(`\r[self-spec-ab] badge: ${text.trim().slice(0, 60)}   `);
    } catch (_) { /* page context may be mid-navigation */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("model READY timeout");
}

async function waitDrafter(cdp) {
  const DRAFTER_TIMEOUT_MS = 300_000;
  const result = await evaluate(cdp, `
    new Promise(async (resolve, reject) => {
      const deadline = Date.now() + ${DRAFTER_TIMEOUT_MS};
      if (typeof window.__loadDrafter !== 'function') {
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
      } catch (e) { resolve('failed: ' + e.message); }
    })
  `, DRAFTER_TIMEOUT_MS + 5000);
  if (result === "loaded") {
    console.log("[self-spec-ab] drafter ready.");
  } else {
    console.warn(`[self-spec-ab] drafter result: ${result} — self-spec may not fire`);
  }
}

async function sendPromptAndWait(cdp, beforeCount, prompt) {
  await evaluate(cdp, `
    (async () => {
      const inp = document.querySelector('.chat-input, #chat-input, textarea');
      if (!inp) throw new Error('no chat input');
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

// Run one arm: navigate cold → N_ROUNDS of all 6 prompts → collect samples.
// Returns array of turn telemetry objects (one per turn).
async function runArm(cdp, url, armName) {
  console.log(`\n[self-spec-ab] ── ${armName} → ${url}`);
  const origin = new URL(url).origin;

  await clearCache(cdp, origin);
  await navigate(cdp, url);
  await waitLive(cdp);
  await waitDrafter(cdp);

  const diag = await evaluate(cdp, `({
    href: window.location.href,
    selfSpecParam: new URLSearchParams(window.location.search).get('self_spec'),
    mtpParam:      new URLSearchParams(window.location.search).get('mtp'),
    badge: document.getElementById('ai-model-badge')?.textContent?.trim() ?? null,
  })`);
  console.log(`[self-spec-ab] [${armName}] state:`, JSON.stringify(diag));

  if (DRY_RUN) {
    console.log(`[self-spec-ab] [${armName}] DRY_RUN — skipping prompt turns`);
    return [];
  }

  const samples = [];
  for (let round = 0; round < N_ROUNDS; round++) {
    for (let pi = 0; pi < PROMPTS.length; pi++) {
      const prompt      = PROMPTS[pi];
      const beforeCount = await evaluate(cdp, `(window.__telemetry || []).length`);
      const turnIndex   = round * PROMPTS.length + pi + 1;

      process.stdout.write(`[self-spec-ab] [${armName}] turn ${turnIndex}/${N_ROUNDS * PROMPTS.length} prompt[${pi}]...`);
      let turn;
      try {
        turn = await sendPromptAndWait(cdp, beforeCount, prompt);
      } catch (e) {
        process.stdout.write(` TIMEOUT/ERROR: ${e.message}\n`);
        samples.push({
          tg_tps:                0,
          effective_tps:         0,
          self_spec_active:      false,
          self_spec_reason:      "turn_error",
          acceptance_rate:       0,
          verify_beta:           1.0,
          self_spec_device_lost: false,
          self_spec_oom:         false,
          _error:                e.message,
          _round: round, _prompt_index: pi,
        });
        continue;
      }

      const sspActive = turn?.self_spec_active ?? false;
      const sspRate   = turn?.acceptance_rate  ?? 0;
      const sspBeta   = turn?.verify_beta      ?? 1.0;
      const effTps    = turn?.effective_tps    ?? turn?.tg_tps ?? 0;
      process.stdout.write(` ${sspActive ? "SSP" : "base"} rate=${sspRate.toFixed(2)} beta=${sspBeta.toFixed(2)} tg=${effTps.toFixed(2)}\n`);

      samples.push({
        tg_tps:                turn?.tg_tps         ?? 0,
        effective_tps:         effTps,
        self_spec_active:      sspActive,
        self_spec_reason:      turn?.self_spec_reason    ?? null,
        draft_tokens:          turn?.draft_tokens        ?? 0,
        accepted_tokens:       turn?.accepted_tokens     ?? 0,
        acceptance_rate:       sspRate,
        verify_beta:           sspBeta,
        speedup_observed:      turn?.speedup_observed    ?? 0,
        self_spec_device_lost: turn?.self_spec_device_lost === true,
        self_spec_oom:         turn?.self_spec_oom        === true,
        mtp_on:                turn?.mtp_on               ?? false,
        spec_attempts:         turn?.spec_attempts        ?? 0,
        spec_accepts:          turn?.spec_accepts         ?? 0,
        _round:                round,
        _prompt_index:         pi,
        _prompt:               prompt.slice(0, 60),
      });
    }
  }
  return samples;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const target = await getTarget();
console.log(`[self-spec-ab] connecting: ${target.url?.slice(0, 80)}`);
const cdp = await cdpConnect(target.webSocketDebuggerUrl);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Console.enable");
await cdp.send("Network.enable");
await cdp.send("ServiceWorker.enable");

const sha = (() => {
  try {
    return execSync("git -C B:/M/gemma-architect rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch (_) { return "unknown"; }
})();

// Path A: baseline (MTP+self-spec disabled via ?mtp=off)
const urlA = `${BASE_URL}?mtp=off`;
const pathASamples = await runArm(cdp, urlA, "A-baseline");

// Path B: self-spec (controller active, gated by warmup)
const urlB = BASE_URL;
const pathBSamples = await runArm(cdp, urlB, "B-self-spec");

cdp.ws.close();

// Build samples file and receipt
const ts = new Date().toISOString();
const samplesData = {
  sha, ts,
  n_rounds: N_ROUNDS,
  prompts: PROMPTS,
  n_turns_per_prompt: N_ROUNDS,
  n_path_a: pathASamples.length,
  n_path_b: pathBSamples.length,
  path_a_samples: pathASamples,
  path_b_samples: pathBSamples,
};

const stateDir = resolve(__dirname, "..", "state");
mkdirSync(stateDir, { recursive: true });
const samplesPath = resolve(stateDir, `self-spec-ab-samples-${sha}.json`);
writeFileSync(samplesPath, JSON.stringify(samplesData, null, 2) + "\n");
console.log(`\n[self-spec-ab] samples written: ${samplesPath}`);

const receipt = buildReceipt(pathASamples, pathBSamples, {
  sha, ts, prompts: PROMPTS, n_turns_per_prompt: N_ROUNDS,
});

const receiptPath = resolve(stateDir, `self-spec-receipt-${sha}-${Date.now()}.json`);
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

console.log(`\n── Self-Spec A/B Receipt (#1867) ───────────────────────────────────────`);
console.log(`  sha:                  ${sha}`);
console.log(`  turns path A:         ${pathASamples.length}`);
console.log(`  turns path B:         ${pathBSamples.length} (active: ${receipt.metrics.n_path_b_active})`);
console.log(`  pathA tps p50:        ${receipt.metrics.pathA_tps_p50.toFixed(3)} t/s`);
console.log(`  pathB tps p50:        ${receipt.metrics.pathB_tps_p50.toFixed(3)} t/s`);
console.log(`  speedup_p50:          ${receipt.metrics.speedup_p50.toFixed(3)}  (gate: ≥1.35) ${receipt.gates.speedup_gte_1_35     ? "✓" : "✗"}`);
console.log(`  acceptance_rate_p50:  ${receipt.metrics.acceptance_rate_p50.toFixed(3)}  (gate: ≥0.80) ${receipt.gates.acceptance_rate_gte_0_80 ? "✓" : "✗"}`);
console.log(`  verify_beta_p50:      ${receipt.metrics.verify_beta_p50.toFixed(3)}  (gate: ≤1.30) ${receipt.gates.verify_beta_lte_1_30      ? "✓" : "✗"}`);
console.log(`  device_lost_count:    ${receipt.metrics.deviceLostCount}  (gate: =0) ${receipt.gates.zero_device_lost ? "✓" : "✗"}`);
console.log(`  oom_count:            ${receipt.metrics.oomCount}  (gate: =0) ${receipt.gates.zero_oom           ? "✓" : "✗"}`);
console.log(`  Verdict: ${receipt.passed ? "PASS" : "FAIL"}`);
console.log(`──────────────────────────────────────────────────────────────────────────`);
console.log(`  Receipt written: ${receiptPath}`);

if (!receipt.passed) process.exit(1);
