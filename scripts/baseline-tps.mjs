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
const TURNS_PER_PROMPT = turnsIdx !== -1 ? parseInt(process.argv[turnsIdx + 1]) : 1;

// ── Sampling strategy: 15 fresh sessions, each 1 turn of the confirmed webgpu prompt ──
//
// The send button takes 10+ minutes to re-enable within a single session after each turn
// (webgpu path still; arc context accumulates and triggers long pre-processing).
// Solution: 1 turn per fresh session (reload between each). 15 sessions = 15 samples.
// Each reload takes ~40s boot; total runtime ~14 min for 15 samples.
//
// "What's currently in the scene?" is the ONLY confirmed non-dispatch webgpu-path prompt.
// All other prompts (measurements, scene inspection, geometry questions) trigger tool dispatch
// → agent path → 30+ min per turn. Never use those for baseline TPS measurement.
const N_SAMPLES = 25; // ~33% timeout rate observed; 25 samples gives ≥15 valid at up to 40% timeouts
const PROMPTS = Array.from({ length: N_SAMPLES }, (_, i) => ({
  label: `scene-query-${String(i + 1).padStart(2, "0")}`,
  complexity: "short",
  text: "What's currently in the scene?",
}));

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
let currentTabId = target.id;
let cdp = await cdpWs(target.webSocketDebuggerUrl);

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

// 4. Clear HTTP cache + cookies only. NEVER touch localStorage (app stores boot-state there)
//    and NEVER touch OPFS (model lives there — ~4GB, re-download takes 10+ min).
await cdp.send("Network.clearBrowserCache");
await cdp.send("Network.clearBrowserCookies");
console.log("[baseline-tps] HTTP cache + cookies cleared (localStorage + OPFS preserved)");

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

// 6. Boot helper — used at startup AND between each prompt group.
// Each prompt group gets a fresh arc session to avoid context accumulation across groups.
// (5 turns of wall-height in a single session degrades TPS by turn 3-4 and crashes at turn 5.)
async function waitForBoot(cdp, label = "") {
  const BOOT_TIMEOUT_MS = 600000; // 10 min
  const bootStart = Date.now();
  let bootResult = null;
  let downloadClicked = false;
  const pfx = label ? `[baseline-tps][${label}]` : "[baseline-tps]";

  while (Date.now() - bootStart < BOOT_TIMEOUT_MS) {
    await sleep(5000);
    let check;
    try {
      check = await cdp.send("Runtime.evaluate", {
        expression: `
          (() => {
            const fatalEl = document.querySelector('.fatal-error, [data-fatal]');
            if (fatalEl) return 'fatal';
            const arc = window.__arc;
            if (arc?.state === 'failed' || arc?.modelLoadError) return 'fatal';
            if (arc?.bootComplete === true && arc?.state === 'ready') return 'ready';
            if (arc?.state === 'idle') {
              const downloadBtn = Array.from(document.querySelectorAll('button'))
                .find(b => b.textContent.includes('Download'));
              if (downloadBtn) return 'idle:download-btn-present';
              return 'idle:no-download-btn';
            }
            return 'booting:' + (arc ? 'arc.' + arc.state + ':bc=' + arc.bootComplete : 'no-arc');
          })()
        `,
      });
    } catch (e) {
      const elapsed = ((Date.now() - bootStart) / 1000).toFixed(0);
      console.log(`${pfx} Boot poll error: ${e.message} (+${elapsed}s)`);
      continue;
    }
    const val = check.result?.value ?? 'unknown';
    const elapsed = ((Date.now() - bootStart) / 1000).toFixed(0);
    console.log(`${pfx} Boot check: ${val} (+${elapsed}s)`);
    if (val === 'ready') { bootResult = 'ready'; break; }
    if (val === 'fatal') { bootResult = 'fatal'; break; }
    if (val === 'idle:download-btn-present' && !downloadClicked) {
      downloadClicked = true;
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Download'));
          if (btn) { btn.click(); return 'clicked'; }
          return 'btn-gone';
        })()`,
      });
      console.log(`${pfx} Clicked Download button — model loading from OPFS...`);
    }
  }
  return bootResult;
}

const initialBoot = await waitForBoot(cdp, "");
if (!initialBoot) {
  console.error("ERROR: boot timeout after 10 min");
  process.exit(1);
}
if (initialBoot === 'fatal') {
  console.error("ERROR: boot fatal — WebGPU not available or model failed to load");
  process.exit(1);
}
console.log(`[baseline-tps] Boot complete`);

// 6. Read model info
const modelInfo = await cdp.send("Runtime.evaluate", {
  expression: `JSON.stringify({
    telemetry_count: (window.__telemetry ?? []).length,
    session: window.__gemmaSession ?? null,
  })`,
}).then(r => { try { return JSON.parse(r.result?.value ?? '{}'); } catch { return {}; } });

console.log(`[baseline-tps] Model info:`, modelInfo);

// 7. Run prompts — each group gets a fresh arc session (reload between groups)
const samples = [];
let baselineTelCount = modelInfo.telemetry_count ?? 0;

for (let pi = 0; pi < PROMPTS.length; pi++) {
  const prompt = PROMPTS[pi];

  // Open a fresh tab between prompt groups — clears accumulated chat context and forces renderer death
  // so Chrome can reclaim WebGPU/ONNX buffers from the prior session (Page.reload() cannot do this).
  if (pi > 0) {
    console.log(`\n[baseline-tps] Opening fresh tab for prompt group ${pi + 1}/${PROMPTS.length}: ${prompt.label}...`);
    // Open a new tab instead of Page.reload() — forces a new renderer process with clean GPU/ONNX state.
    // Page.reload() accumulates ~400-800 MB WebGPU/ONNX buffers per cycle that Chrome never reclaims.
    // Only renderer process death (tab close) forces full GPU buffer reclamation.
    const newTarget = await cdp.send("Target.createTarget", { url: PAGES_URL });
    const newTabId = newTarget.targetId;
    await sleep(2000); // let Chrome register the new target before fetching its WS URL
    const freshTargets = await fetch(`${CDP_BASE}/json`).then(r => r.json());
    const freshTargetInfo = freshTargets.find(t => t.id === newTabId);
    if (!freshTargetInfo) {
      console.error(`ERROR: new tab ${newTabId} not found in /json — skipping ${prompt.label}`);
      for (let t = 1; t <= TURNS_PER_PROMPT; t++) {
        samples.push({ prompt_idx: pi, prompt: prompt.label, complexity: prompt.complexity, turn: t, tg_tps: null, pp_tps: null, tokens_out: null, decode_ms: null, error: "tab-create-failed" });
      }
      continue;
    }
    // Close old tab now — renderer death frees GPU buffers before new tab needs them
    try { await cdp.send("Target.closeTarget", { targetId: currentTabId }); } catch (_) {}
    try { cdp.ws.close(); } catch (_) {}
    // Connect to new tab
    cdp = await cdpWs(freshTargetInfo.webSocketDebuggerUrl);
    currentTabId = newTabId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    const interBoot = await waitForBoot(cdp, `p${pi + 1}`);
    if (!interBoot || interBoot === 'fatal') {
      console.error(`ERROR: inter-prompt boot failed for ${prompt.label} — marking all turns as boot-failed`);
      for (let t = 1; t <= TURNS_PER_PROMPT; t++) {
        samples.push({ prompt_idx: pi, prompt: prompt.label, complexity: prompt.complexity, turn: t, tg_tps: null, pp_tps: null, tokens_out: null, decode_ms: null, error: "boot-failed" });
      }
      continue;
    }
    // Reset baseline — new tab always starts with zero telemetry
    baselineTelCount = await cdp.send("Runtime.evaluate", {
      expression: `(window.__telemetry ?? []).length`,
    }).then(r => parseInt(r.result?.value ?? '0'));
  }

  console.log(`\n[baseline-tps] Prompt ${pi + 1}/${PROMPTS.length}: ${prompt.label}`);

  for (let turn = 1; turn <= TURNS_PER_PROMPT; turn++) {
    const beforeCount = baselineTelCount;

    // Wait for send button to be enabled (guards against disabled-during-boot or prior-turn-still-running)
    const SEND_READY_TIMEOUT = 600000; // 10 min — long prompts (two-story-house) can take >5 min
    const sendReadyStart = Date.now();
    while (Date.now() - sendReadyStart < SEND_READY_TIMEOUT) {
      const btnState = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const btn = document.querySelector('.chat-send-btn');
          if (!btn) return 'no-btn';
          return btn.disabled ? 'disabled:' + btn.textContent.trim() : 'ready';
        })()`,
      }).then(r => r.result?.value ?? 'unknown');
      if (btnState === 'ready') break;
      console.log(`  [turn ${turn}] send btn: ${btnState} — waiting...`);
      await sleep(1000);
    }

    // Inject prompt: set value then click the send button directly (more reliable than keydown)
    const injectResult = await cdp.send("Runtime.evaluate", {
      expression: `
        (() => {
          const inp = document.querySelector('.chat-input');
          const btn = document.querySelector('.chat-send-btn');
          if (!inp) return 'no-input';
          if (!btn) return 'no-btn';
          if (btn.disabled) return 'btn-disabled:' + btn.textContent.trim();
          inp.value = ${JSON.stringify(prompt.text)};
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          btn.click();
          return 'sent';
        })()
      `,
    }).then(r => r.result?.value ?? 'unknown');
    console.log(`  [turn ${turn}] inject: ${injectResult}`);

    // Poll for telemetry increment (turn completed)
    const TURN_TIMEOUT_MS = 600000; // 10 min per turn — complex prompts (two-story-house) take >5 min on E4B
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
      console.warn(`  [turn ${turn}] TIMEOUT — no telemetry after ${TURN_TIMEOUT_MS/60000} min`);
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

// 8. Compute aggregate stats across all samples (all scene-query-NN share same text)
const stats = {};
const allTpsValues = samples.filter(s => s.tg_tps !== null).map(s => s.tg_tps).sort((a, b) => a - b);
if (allTpsValues.length > 0) {
  stats["scene-query"] = {
    count: allTpsValues.length,
    median: percentile(allTpsValues, 50),
    p25: percentile(allTpsValues, 25),
    p75: percentile(allTpsValues, 75),
    min: allTpsValues[0],
    max: allTpsValues[allTpsValues.length - 1],
    complexity: "short",
    prompt_text: "What's currently in the scene?",
  };
} else {
  stats["scene-query"] = { error: "no valid samples" };
}

// 9. Write output
const date = new Date().toISOString().slice(0, 10);
const outPath = `${process.cwd()}/state/baseline-tps-${date}.json`;
mkdirSync(`${process.cwd()}/state`, { recursive: true });
const output = {
  date,
  url: PAGES_URL,
  fresh_session: true, // HTTP cache + cookies cleared; OPFS model + localStorage preserved; page reloaded
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
