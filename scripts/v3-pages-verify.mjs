#!/usr/bin/env bun
// v3-pages-verify.mjs — cold Pages visit diagnostic, 6 steps, terminal state only
// Leo mail 9491 — V3 verification
// Usage: bun scripts/v3-pages-verify.mjs

const PAGES_URL    = 'https://wordingone.github.io/gemma-architect/';
const PAGES_ORIGIN = 'https://wordingone.github.io';
const CDP_BASE     = 'http://localhost:9222';
const T0 = Date.now();
const elapsed = () => `+${Math.round((Date.now()-T0)/1000)}s`;

function log(msg) { console.log(`[v3 ${elapsed()}] ${msg}`); }

// ── Browser-level connection ──────────────────────────────────────────────────

const version = await fetch(`${CDP_BASE}/json/version`).then(r => r.json()).catch(() => null);
if (!version?.webSocketDebuggerUrl) {
  console.error('ERROR: cannot reach CDP at', CDP_BASE, '— is Chrome :9222 running?');
  process.exit(1);
}

const bws = new WebSocket(version.webSocketDebuggerUrl);
let msgId = 1;
const pending   = new Map(); // id → resolve  (for all sessions)
const listeners = new Map(); // method → [fn]

bws.onmessage = m => {
  const x = JSON.parse(m.data);
  const key = x.sessionId ? `${x.sessionId}:${x.id}` : String(x.id);
  if (x.id !== undefined && pending.has(key)) {
    pending.get(key)(x); pending.delete(key);
  }
  if (x.method) {
    const evt = x.sessionId ? `${x.sessionId}:${x.method}` : x.method;
    for (const fn of (listeners.get(evt) ?? [])) fn(x.params);
  }
};

await new Promise(r => bws.addEventListener('open', r));

function send(method, params = {}, sessionId = null) {
  return new Promise(resolve => {
    const id = msgId++;
    const key = sessionId ? `${sessionId}:${id}` : String(id);
    pending.set(key, resolve);
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    bws.send(JSON.stringify(msg));
  });
}

function on(method, fn, sessionId = null) {
  const key = sessionId ? `${sessionId}:${method}` : method;
  const arr = listeners.get(key) ?? [];
  arr.push(fn);
  listeners.set(key, arr);
}

// ── Create new tab ────────────────────────────────────────────────────────────

log('creating new tab...');
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
log(`new tab targetId=${targetId}`);

const { result: { sessionId: sid } } = await send('Target.attachToTarget', { targetId, flatten: true });
log(`sessionId=${sid}`);

const ps = (m, p = {}) => send(m, p, sid);  // page-session send

await ps('Runtime.enable');
await ps('Page.enable');
await ps('Network.enable');

// ── Storage clear BEFORE navigation ──────────────────────────────────────────

log(`clearing storage for ${PAGES_ORIGIN}...`);
let preUsage = 0, postUsage = 0;
try {
  const pre = await ps('Storage.getUsageAndQuota', { origin: PAGES_ORIGIN });
  preUsage = pre?.result?.usage ?? -1;
  log(`pre-wipe usage: ${(preUsage/1e6).toFixed(2)} MB`);
} catch { log('pre-wipe usage query failed'); }

await ps('Storage.clearDataForOrigin', { origin: PAGES_ORIGIN, storageTypes: 'all' });

try {
  const post = await ps('Storage.getUsageAndQuota', { origin: PAGES_ORIGIN });
  postUsage = post?.result?.usage ?? -1;
  log(`post-wipe usage: ${(postUsage/1e6).toFixed(2)} MB`);
} catch { log('post-wipe usage query failed'); }

// ── Collect console + network events ─────────────────────────────────────────

const consoleErrors = [];
const allConsoleLogs = [];  // all types — used for harness diagnostics on timeout
const networkFails  = [];
const allNetworkReqs = {};  // requestId → url

on('Runtime.consoleAPICalled', p => {
  const text = p.args?.map(a => a.value ?? a.description ?? '').join(' ') ?? '';
  const ts = elapsed();
  allConsoleLogs.push({ ts, type: p.type, text: text.slice(0, 400) });
  if (p.type === 'error' || p.type === 'warning') {
    consoleErrors.push({ ts, type: p.type, text: text.slice(0, 300) });
    log(`console.${p.type}: ${text.slice(0, 200)}`);
  }
}, sid);

on('Runtime.exceptionThrown', p => {
  const text = p.exceptionDetails?.text ?? p.exceptionDetails?.exception?.description ?? 'unknown';
  consoleErrors.push({ ts: elapsed(), type: 'exception', text: text.slice(0, 300) });
  log(`exception: ${text.slice(0, 200)}`);
}, sid);

on('Network.requestWillBeSent', p => {
  allNetworkReqs[p.requestId] = p.request.url;
}, sid);

on('Network.responseReceived', p => {
  const url = p.response.url;
  const status = p.response.status;
  if (status >= 400) {
    networkFails.push({ ts: elapsed(), url: url.slice(0, 150), status });
    log(`network ${status}: ${url.slice(0, 120)}`);
  }
}, sid);

on('Network.loadingFailed', p => {
  const url = allNetworkReqs[p.requestId] ?? '?';
  if (!p.canceled) {
    const err = p.errorText ?? 'unknown';
    networkFails.push({ ts: elapsed(), url: url.slice(0, 150), error: err });
    log(`network fail: ${err} — ${url.slice(0, 100)}`);
  }
}, sid);

// ── Navigate to Pages URL ─────────────────────────────────────────────────────

log(`navigating to ${PAGES_URL}...`);
let navTs = null;
on('Page.frameNavigated', p => {
  if (p.frame.url?.startsWith('https://wordingone.github.io')) {
    navTs = elapsed();
    log(`frame navigated to ${p.frame.url}`);
  }
}, sid);

on('Page.frameNavigated', p => {
  if (p.frame.url?.includes('about:blank')) return;
  log(`frame navigated: ${p.frame.url}`);
}, sid);

await ps('Page.navigate', { url: PAGES_URL });

// Helper: poll until condition or timeout
async function pollUntil(label, checkFn, timeoutMs = 30 * 60 * 1000, pollMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let result = null;
  while (Date.now() < deadline) {
    try { result = await checkFn(); } catch (e) { result = null; }
    if (result !== null && result !== false) return { pass: true, value: result };
    await new Promise(r => setTimeout(r, pollMs));
    log(`[${label}] polling...`);
  }
  return { pass: false, value: 'timeout' };
}

async function evaluate(expr, timeoutMs = 10_000) {
  const p = ps('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const t = new Promise(r => setTimeout(() => r(null), timeoutMs));
  const res = await Promise.race([p, t]);
  if (!res || res.result?.exceptionDetails) return null;
  return res.result?.result?.value;
}

// ── Step 1: COI SW registered + shell DOM visible ─────────────────────────────

log('=== STEP 1: COI SW + shell DOM ===');

// COI SW registration causes a page reload. Wait for it to settle.
// After reload, check navigator.serviceWorker.controller and #app or equivalent.
await new Promise(r => setTimeout(r, 8000)); // give SW registration + reload time

const s1 = await pollUntil('step1', async () => {
  const sw = await evaluate(`navigator.serviceWorker?.controller?.scriptURL ?? null`);
  const shell = await evaluate(`
    !!(document.querySelector('#app, #app-root, [data-testid=workbench], .workbench, #workbench, #viewport-2') ||
       document.querySelector('.ribbon') || document.querySelector('.scene-panel'))
  `);
  if (sw && shell) return { swUrl: sw, shellVisible: shell };
  if (sw && !shell) return null; // SW ok but shell not visible yet
  return null;
}, 5 * 60 * 1000, 3000);

const step1 = {
  pass: s1.pass,
  swUrl: s1.value?.swUrl ?? null,
  shellVisible: s1.value?.shellVisible ?? false,
  failure: s1.pass ? null : 'COI SW or shell DOM not found within 5 min'
};
log(`STEP 1: ${step1.pass ? 'PASS' : 'FAIL'} — SW=${step1.swUrl?.slice(-40)} shell=${step1.shellVisible}`);

// ── Step 2: Model bytes download from HF CDN ──────────────────────────────────

log('=== STEP 2: model download ===');
// Model ready: worker sends 'agentmodel:ready' or sets window.__modelReady
// Look for: boot screen gone, model-ready event, or console log 'model-ready'
// Also check: no 4xx/5xx on HF domain in networkFails

const s2 = await pollUntil('step2-model', async () => {
  // Check if boot screen is gone (app ready) — multiple possible selectors
  const bootGone = await evaluate(`
    (() => {
      const boot = document.querySelector('#boot-overlay, .boot-overlay, [data-boot], .boot-screen, #boot-screen');
      if (boot) {
        const vis = boot.getBoundingClientRect();
        if (vis.width > 0 && vis.height > 0) return false; // still visible
      }
      // Or check if model-ready flag set
      const flag = window.__modelReady || window.__gemma?.modelReady ||
                   (globalThis).__modelLoaded === true ||
                   document.querySelector('[data-model-state="ready"]') !== null;
      // Or check if ribbon/tools visible (implies app fully loaded)
      const tools = document.querySelector('.ribbon .tool-btn, .palette-btn[data-tool]');
      return flag || !!tools || !boot;
    })()
  `);
  if (bootGone) return { bootGone: true };
  return null;
}, 45 * 60 * 1000, 15000); // 45 min timeout, 15s poll

const hfFails = networkFails.filter(f => (f.url ?? '').includes('huggingface'));
const step2 = {
  pass: s2.pass,
  hfNetworkFails: hfFails,
  failure: s2.pass ? null : `boot screen still visible or model-ready not set after 45 min; HF fails=${hfFails.length}`
};
log(`STEP 2: ${step2.pass ? 'PASS' : 'FAIL'} — HF 4xx/5xx count: ${hfFails.length}`);

// ── Step 3: WebGPU init ───────────────────────────────────────────────────────

log('=== STEP 3: WebGPU init ===');
const webgpuErrors = consoleErrors.filter(e =>
  e.text.toLowerCase().includes('webgpu') ||
  e.text.toLowerCase().includes('gpu adapter') ||
  e.text.toLowerCase().includes('shader')
);
// WebGPU is considered OK if:
// 1. No webgpu-related errors in console
// 2. App reached model-ready (implies WebGPU succeeded if on WebGPU path)
// 3. Or explicitly check navigator.gpu
const gpuAvailable = await evaluate(`navigator.gpu ? 'available' : 'unavailable'`);
const step3 = {
  pass: s2.pass && webgpuErrors.length === 0, // if model loaded and no GPU errors
  gpuAvailable,
  webgpuConsoleErrors: webgpuErrors,
  failure: !s2.pass ? 'step 2 failed (model not ready)' :
           webgpuErrors.length > 0 ? `${webgpuErrors.length} WebGPU console errors` : null
};
log(`STEP 3: ${step3.pass ? 'PASS' : 'FAIL'} — gpu=${gpuAvailable} webgpu_errors=${webgpuErrors.length}`);

// ── Step 4: drafter soft-fail ─────────────────────────────────────────────────

log('=== STEP 4: drafter soft-fail ===');
const drafterErrors = consoleErrors.filter(e =>
  e.text.includes('drafter') || e.text.includes('VITE_DRAFTER_ONNX_URL') ||
  e.text.includes('TODO-set-after-upload')
);
const standardBackendActivated = await evaluate(`window.__standardBackendActive ?? false`);

// From agent-harness.ts: drafter-error → activateStandardBackend() called
// Proof via console: look for the VITE_DRAFTER_ONNX_URL warning (fires in PROD)
const drafterWarnSeen = drafterErrors.some(e => e.text.includes('VITE_DRAFTER_ONNX_URL'));
const drafterFailSeen = consoleErrors.some(e => e.text.includes('drafter-error') || e.text.includes('drafter fetch failed'));

const step4 = {
  pass: drafterWarnSeen || drafterFailSeen || drafterErrors.length > 0,
  drafterWarnSeen,
  drafterFailSeen,
  standardBackendActive: standardBackendActivated,
  drafterConsoleEntries: drafterErrors,
  note: 'Expected: CORS TypeError → drafter-error → activateStandardBackend. VITE_DRAFTER_ONNX_URL warning expected in PROD.'
};
log(`STEP 4: ${step4.pass ? 'PASS (soft-fail confirmed)' : 'inconclusive (no drafter signals found)'} — warn=${drafterWarnSeen} fail=${drafterFailSeen}`);

// ── Step 5: two-story-house chip → dispatch → geometry ───────────────────────

log('=== STEP 5: two-story-house chip → geometry ===');

let chipClicked = false;
let step5 = { pass: false, wallCount: 0, failure: 'not run' };

if (s2.pass) {
  // Find and click the demo chip
  const chip = await evaluate(`
    (() => {
      const chips = Array.from(document.querySelectorAll('.demo-chip, [data-chip], .chip-btn, .suggestion-chip, button'));
      const twoStory = chips.find(c => c.textContent?.toLowerCase().includes('two-stor') ||
                                       c.textContent?.toLowerCase().includes('2-stor') ||
                                       c.textContent?.toLowerCase().includes('two story') ||
                                       c.textContent?.toLowerCase().includes('2 stor') ||
                                       c.textContent?.toLowerCase().includes('house') ||
                                       c.getAttribute('data-chip')?.includes('two') ||
                                       c.getAttribute('data-chip')?.includes('house'));
      if (twoStory) {
        twoStory.click();
        return twoStory.textContent?.trim().slice(0, 80);
      }
      // Fallback: look for chat input and submit prompt
      const input = document.querySelector('#chat-input, .chat-input, textarea[placeholder*="message"], textarea[placeholder*="ask"]');
      if (input) {
        input.value = 'Build a two-story residential house with 4 walls, a slab, and a roof.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const form = input.closest('form');
        if (form) form.dispatchEvent(new Event('submit', { bubbles: true }));
        const btn = document.querySelector('[data-action="send"], .send-btn, button[type="submit"]');
        if (btn) btn.click();
        return 'prompt submitted via input';
      }
      return null;
    })()
  `);
  log(`step5 chip/prompt: ${chip}`);
  chipClicked = chip !== null;

  if (chipClicked) {
    // Wait for geometry: scene.children > initialCount with architectural objects
    const initialCount = await evaluate(`window.__viewer?.scene?.children?.length ?? -1`);
    log(`step5 initial scene count: ${initialCount}`);

    const s5 = await pollUntil('step5-geometry', async () => {
      const count = await evaluate(`window.__viewer?.scene?.children?.length ?? -1`);
      if (count > (initialCount ?? 0)) {
        // Count walls (IfcWall type)
        const wallCount = await evaluate(`
          (window.__viewer?.scene?.children ?? [])
            .filter(c => c.userData?.creator === 'IfcWall' || c.userData?.ifc_class === 'IfcWall' ||
                         c.name?.includes('Wall') || c.userData?.creator?.includes('Wall'))
            .length
        `);
        return { count, wallCount };
      }
      return null;
    }, 25 * 60 * 1000, 10000); // 25 min timeout

    step5 = {
      pass: s5.pass && (s5.value?.wallCount ?? 0) > 0,
      sceneCount: s5.value?.count ?? 0,
      wallCount: s5.value?.wallCount ?? 0,
      initialCount,
      failure: !s5.pass ? 'no geometry dispatched within 25 min' :
               (s5.value?.wallCount ?? 0) === 0 ? 'scene grew but no wall objects found' : null
    };
    // On timeout: surface [agent-harness] diagnostic dumps
    if (!s5.pass) {
      const harnessLogs = allConsoleLogs.filter(e =>
        e.text.includes('[agent-harness:turn-complete]') || e.text.includes('[agent-harness:zero-dispatch]')
      );
      step5.harnessDiagnostic = harnessLogs.map(e => `${e.ts} [${e.type}] ${e.text}`);
      if (harnessLogs.length > 0) {
        log(`step5 agent-harness diagnostic (${harnessLogs.length} entries):`);
        harnessLogs.forEach(e => log(`  ${e.ts} ${e.text.slice(0, 200)}`));
      } else {
        log(`step5 no [agent-harness] logs captured — model may not have completed a turn`);
      }
    }
  } else {
    step5.failure = 'chip not found and chat input not found';
  }
} else {
  step5.failure = 'skipped: step 2 failed (model not ready)';
}
log(`STEP 5: ${step5.pass ? 'PASS' : 'FAIL'} — walls=${step5.wallCount} scene=${step5.sceneCount}`);

// ── Step 6: LAYOUT tab → SVG export ──────────────────────────────────────────
// Independent of step 5 result — LAYOUT tab is a UI concern, not a dispatch concern

log('=== STEP 6: LAYOUT tab → SVG export ===');
let step6 = { pass: false, failure: 'not run' };

{
  // Click LAYOUT tab
  const layoutClicked = await evaluate(`
    (() => {
      const layoutTab = document.querySelector('[data-mode=layout], [data-tab=layout], .layout-tab, [aria-label="Layout"]');
      if (layoutTab) { layoutTab.click(); return 'clicked'; }
      const tabs = Array.from(document.querySelectorAll('.tab, [role=tab], .mode-btn'));
      const lt = tabs.find(t => t.textContent?.toLowerCase().includes('layout'));
      if (lt) { lt.click(); return 'clicked via text'; }
      return null;
    })()
  `);
  log(`step6 layout tab: ${layoutClicked}`);

  await new Promise(r => setTimeout(r, 2000));

  // Look for paper sheet (layout mode active)
  const sheetVisible = await evaluate(`
    !!document.querySelector('.paper-sheet, [data-layout=sheet], .layout-sheet, [data-layout-active]')
  `);
  log(`step6 sheet visible: ${sheetVisible}`);

  // Click SVG export button
  const exportClicked = await evaluate(`
    (() => {
      // First try layout-specific export
      const exportBtn = document.querySelector('[data-action=export-svg], [data-export=svg], .export-svg-btn');
      if (exportBtn) { exportBtn.click(); return 'export-svg clicked'; }
      // Try generic export menu
      const exportMenu = document.querySelector('[data-action=export], .export-btn, [aria-label*="export" i], [title*="export" i]');
      if (exportMenu) {
        exportMenu.click();
        return 'export menu clicked';
      }
      return null;
    })()
  `);
  log(`step6 export: ${exportClicked}`);

  await new Promise(r => setTimeout(r, 3000));

  // Check if a download was triggered (look for SVG-related response in network)
  const svgDownload = networkFails.length; // just check no new failures
  const exportResponse = await evaluate(`
    // Check for any download link that appeared
    !!document.querySelector('a[download*=".svg"], a[href*="data:image/svg"], a[href*=".svg"]')
  `);

  step6 = {
    pass: layoutClicked !== null && sheetVisible,
    layoutTabFound: layoutClicked !== null,
    sheetVisible,
    exportClicked,
    exportResponse,
    failure: layoutClicked === null ? 'LAYOUT tab not found' :
             !sheetVisible ? 'sheet element not visible after layout click' :
             exportClicked === null ? 'export button not found' : null
  };
}
log(`STEP 6: ${step6.pass ? 'PASS' : 'FAIL'} — layout=${step6.layoutTabFound} sheet=${step6.sheetVisible} export=${step6.exportClicked}`);

// ── Final console snapshot ────────────────────────────────────────────────────

const allErrors = consoleErrors.slice(0, 30);
const hfNetFails = networkFails.filter(f => (f.url ?? '').includes('huggingface'));
const otherNetFails = networkFails.filter(f => !(f.url ?? '').includes('huggingface'));

// ── Summary ───────────────────────────────────────────────────────────────────

const summary = {
  ts: new Date().toISOString(),
  pages_url: PAGES_URL,
  state_precondition: { pre_wipe_usage_bytes: preUsage, post_wipe_usage_bytes: postUsage },
  step1, step2, step3, step4, step5, step6,
  network_4xx_5xx_total: networkFails.length,
  network_hf_fails: hfNetFails.slice(0, 10),
  network_other_fails: otherNetFails.slice(0, 10),
  console_errors: allErrors,
  total_elapsed_s: Math.round((Date.now()-T0)/1000),
};

const outDir = `B:/M/gemma-architect-eli/state/pages-diagnostic-${new Date().toISOString().replace(/[:.]/g,'').slice(0,15)}Z`;
try {
  const { mkdirSync, writeFileSync } = await import('fs');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
  log(`output: ${outDir}/summary.json`);
} catch (e) {
  log(`output write error: ${e.message}`);
}

console.log('\n=== V3 SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));

bws.close();
process.exit(0);
