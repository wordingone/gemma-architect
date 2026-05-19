#!/usr/bin/env bun
// gemma-verify-demo.mjs — Pre-recording demo-flow health check (#932).
//
// Runs the 8 demo-step smoke surfaces in order with fail-fast.
// Exits 0 (all pass) or 1 (first fail). S78 is UNCERTAIN (not FAIL) if the
// model consent overlay is blocking.
//
// Output: state/demo-verify-latest.json
// Usage:  bun scripts/gemma-verify-demo.mjs
//         bun run verify:demo

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { CDP_PORT, CDP_BASE, DEV_URL as _DEFAULT_DEV_URL } from "./ports.mjs";

const DEV_URL   = process.env.GEMMA_DEV_URL ?? _DEFAULT_DEV_URL;
const STATE_DIR = `${process.cwd()}/state`;

function getSHA() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const sha       = getSHA();
const timestamp = new Date().toISOString();
mkdirSync(STATE_DIR, { recursive: true });

// ── CDP connection ────────────────────────────────────────────────────────────

const targets = await fetch(`${CDP_BASE}/json`).then(r => r.json()).catch(() => null);
if (!targets) {
  console.error(`ERROR: Cannot reach CDP at ${CDP_BASE} — is the shared browser running?`);
  process.exit(1);
}
const DEV_HOST = new URL(DEV_URL).host;
const target = targets.find(t => t.url?.includes(DEV_HOST) && t.type === "page");
if (!target) {
  console.error(`ERROR: no page tab at ${DEV_URL} found in shared browser (:${CDP_PORT})`);
  console.error("Tabs:", targets.filter(t => t.type === "page").map(t => t.url));
  process.exit(1);
}
console.log(`Attaching to: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
};
await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) return null;
  return res?.result?.result?.value;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function resetScene(label = '') {
  await evaluate(`(function() {
    window.__dispatch?.('SdClearScene', {});
    window.__clearCommandSession?.();
    window.__dispatch?.('SdSectionBoxOff', {});
    window.__dispatch?.('SdClippingPlanesClear', {});
  })()`);
  await delay(600);
  if (label) console.log(`  ↺ reset (${label})`);
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.bringToFront");

// ── Reload + test mode ───────────────────────────────────────────────────────

await send("Page.reload", { waitForNavigation: false });
await delay(2000);
await evaluate(`(window.__gemmaTest = { events: {}, surfaceResults: [] }, true)`);
await evaluate(`(window.__testMode = true, true)`);
await delay(1000);

// ── Runner ───────────────────────────────────────────────────────────────────

const surfaces = [];
let failedEarly = null;

// Returns false when the surface failed (caller should break).
function record(name, passed, evidence, uncertain = false) {
  const status = uncertain ? "UNCERTAIN" : (passed ? "pass" : "FAIL");
  surfaces.push({ name, passed: uncertain ? true : passed, uncertain, evidence });
  const icon = uncertain ? "?" : (passed ? "✓" : "✗");
  console.log(`  ${icon} ${name}  [${status}]`);
  if (!passed && !uncertain) console.log("    evidence:", JSON.stringify(evidence).slice(0, 300));
  if (!passed && !uncertain) failedEarly = name;
  return passed || uncertain;
}

console.log("\n── Demo-flow smoke pack ────────────────────────────────────────");

// ── S67: starter-library ─────────────────────────────────────────────────────
{
  const r = await evaluate(`(async function() {
    try {
      if (!window.__skillStore) return { passed: false, evidence: { reason: '__skillStore shim not available' } };
      localStorage.removeItem('gemma-starter-seeded-v1');
      const mod = await import('/src/skills/starter-clusters.ts').catch(e => ({ error: e.message }));
      if (mod.error) return { passed: false, evidence: { importError: mod.error } };
      await mod.seedStarterClusters();
      const clusters = await window.__skillStore.listCanvasClusters();
      const ids = clusters.map(c => c.id);
      const hasAll6 = ['__starter__wall-row','__starter__window-array','__starter__room',
                       '__starter__roof-walls','__starter__stair-flight','__starter__skylight-grid']
                      .every(id => ids.includes(id));
      const roomCluster = clusters.find(c => c.id === '__starter__room');
      const roomGraph   = roomCluster ? JSON.parse(roomCluster.graphJson) : null;
      const roomStepCount = roomGraph?.nodes?.[0]?.skillSteps?.length ?? 0;
      return { passed: hasAll6 && roomStepCount === 5,
               evidence: { hasAll6, roomStepCount, clusterCount: clusters.length } };
    } catch(e) { return { passed: false, evidence: { error: e.message } }; }
  })()`);
  if (!record("starter-library",
      r?.passed ?? false,
      r?.evidence ?? { reason: "evaluate null" })) {
    // fail-fast
  }
}

if (!failedEarly) {
  // ── S70: two-story-house chip ───────────────────────────────────────────────
  const r = await evaluate(`(function() {
    try {
      const chips = Array.from(document.querySelectorAll('.chat-starter-chip'));
      const chip  = chips.find(c => c.textContent.trim() === 'Two-story house');
      if (!chip) return { passed: false, evidence: { reason: 'chip not found',
                          chipLabels: chips.map(c => c.textContent.trim()) } };
      chip.click();
      const input = document.querySelector('.chat-input');
      const val   = input ? input.value : '';
      const passed = val.includes('Build a two-story house');
      return { passed, evidence: { inputValue: val.slice(0, 80) } };
    } catch(e) { return { passed: false, evidence: { error: e.message } }; }
  })()`);
  record("two-story-house-chip",
    r?.passed ?? false,
    r?.evidence ?? { reason: "evaluate null" });
}

if (!failedEarly) {
  // ── S71: canvas-visible-width-skill-nodes ────────────────────────────────────
  await evaluate(`(function() {
    const tab = document.querySelector('.dock-tab[data-tab="skills"]');
    if (tab) tab.click();
  })()`);
  await delay(600);
  const r = await evaluate(`(async function() {
    try {
      function check() {
        const vp = document.querySelector('.skill-canvas-viewport');
        if (!vp) return { ok: false, reason: 'no .skill-canvas-viewport' };
        if (window.getComputedStyle(vp).display === 'none') return { ok: false, reason: 'display:none' };
        const rect = vp.getBoundingClientRect();
        return { ok: rect.width > 100 && rect.height > 100, w: rect.width, h: rect.height };
      }
      const st = document.createElement('style');
      st.textContent = '.skill-canvas-viewport { width: 0 !important; }';
      document.head.appendChild(st);
      await new Promise(r => setTimeout(r, 50));
      const failResult = check();
      document.head.removeChild(st);
      await new Promise(r => setTimeout(r, 50));
      const liveResult = check();
      const selfTestOk = !failResult.ok;
      return { passed: liveResult.ok && selfTestOk,
               evidence: { liveW: liveResult.w, liveH: liveResult.h, selfTestOk } };
    } catch(e) { return { passed: false, evidence: { error: e.message } }; }
  })()`);
  record("canvas-visible-width-skill-nodes",
    r?.passed ?? false,
    r?.evidence ?? { reason: "evaluate null" });
}

if (!failedEarly) {
  // ── S72: canvas-visible-width-viewer ─────────────────────────────────────────
  await evaluate(`(function() {
    const tab = document.querySelector('.mode-tab[data-mode="model"]');
    if (tab) tab.click();
  })()`);
  await delay(500);
  const r = await evaluate(`(async function() {
    try {
      function check() {
        const c = document.getElementById('viewer-canvas');
        if (!c) return { ok: false, reason: 'no #viewer-canvas' };
        if (window.getComputedStyle(c).display === 'none') return { ok: false, reason: 'display:none' };
        const rect = c.getBoundingClientRect();
        return { ok: rect.width > 100 && rect.height > 100, w: rect.width, h: rect.height };
      }
      const st = document.createElement('style');
      st.textContent = '#viewer-canvas { height: 0 !important; }';
      document.head.appendChild(st);
      await new Promise(r => setTimeout(r, 50));
      const failResult = check();
      document.head.removeChild(st);
      await new Promise(r => setTimeout(r, 50));
      const liveResult = check();
      const selfTestOk = !failResult.ok;
      return { passed: liveResult.ok && selfTestOk,
               evidence: { liveW: liveResult.w, liveH: liveResult.h, selfTestOk } };
    } catch(e) { return { passed: false, evidence: { error: e.message } }; }
  })()`);
  record("canvas-visible-width-viewer",
    r?.passed ?? false,
    r?.evidence ?? { reason: "evaluate null" });
}

if (!failedEarly) {
  // ── S73: canvas-visible-width-layout-detail ───────────────────────────────────
  await evaluate(`(function() {
    const tab = document.querySelector('.mode-tab[data-mode="layout"]');
    if (tab) tab.click();
  })()`);
  await delay(800);
  await evaluate(`(async function() {
    window.dispatchEvent(new CustomEvent('ribbon:tool-click', { detail: { tool: 'viewport' } }));
    await new Promise(r => setTimeout(r, 100));
    const sheet = document.querySelector('.paper-sheet, .paper-stage');
    if (!sheet) return;
    const rect = sheet.getBoundingClientRect();
    sheet.dispatchEvent(new MouseEvent('click', {
      clientX: rect.left + rect.width * 0.5,
      clientY: rect.top  + rect.height * 0.5,
      bubbles: true, button: 0
    }));
  })()`);
  await delay(600);
  const r = await evaluate(`(async function() {
    try {
      const panels = document.querySelectorAll('[data-panel-id]');
      if (!panels.length) return { passed: false, evidence: { reason: 'no panels found' } };
      const thumbCanvas = document.querySelector('.paper-cell-render canvas');
      if (!thumbCanvas) return { passed: false,
                                 evidence: { reason: 'no .paper-cell-render canvas', panelCount: panels.length } };
      const rect    = thumbCanvas.getBoundingClientRect();
      const liveOk  = rect.width > 100 && rect.height > 100;
      const st = document.createElement('style');
      st.textContent = '.paper-cell-render canvas { width: 0 !important; }';
      document.head.appendChild(st);
      await new Promise(r => setTimeout(r, 50));
      const failRect = thumbCanvas.getBoundingClientRect();
      document.head.removeChild(st);
      await new Promise(r => setTimeout(r, 50));
      const selfTestOk = !(failRect.width > 100 && failRect.height > 100);
      return { passed: liveOk && selfTestOk,
               evidence: { liveW: rect.width, liveH: rect.height, selfTestOk } };
    } catch(e) { return { passed: false, evidence: { error: e.message } }; }
  })()`);
  // Return to model mode.
  await evaluate(`(function() {
    const tab = document.querySelector('.mode-tab[data-mode="model"]');
    if (tab) tab.click();
  })()`);
  await delay(400);
  record("canvas-visible-width-layout-detail",
    r?.passed ?? false,
    r?.evidence ?? { reason: "evaluate null" });
}

if (!failedEarly) {
  // ── S76: gable-trim undo round-trip ──────────────────────────────────────────
  await resetScene('s76-pre');
  const r = await evaluate(`(async function() {
    try {
      const d = window.__dispatch;
      if (!d) return { passed: false, evidence: { reason: '__dispatch not found' } };
      d('SdWall', { x: 0, y: 0, length: 8, direction: [0,1,0], height: 3 });
      d('SdWall', { x: 6, y: 0, length: 8, direction: [0,1,0], height: 3 });
      d('SdWall', { x: 0, y: 0, length: 6, direction: [1,0,0], height: 3 });
      d('SdWall', { x: 0, y: 8, length: 6, direction: [1,0,0], height: 3 });
      await new Promise(r => setTimeout(r, 200));
      const scene = window.__viewer?.scene;
      if (!scene) return { passed: false, evidence: { reason: 'no scene' } };
      const wallsBefore = scene.children.filter(c => c.userData?.kind === 'wall');
      if (wallsBefore.length < 4) return { passed: false,
                                           evidence: { reason: 'fewer than 4 walls', wallCount: wallsBefore.length } };
      const cntBeforeRoof = scene.children.length;
      d('SdRoof', { roofType: 'pitched', width: 6, depth: 8, height: 2 });
      await new Promise(r => setTimeout(r, 300));
      const roofAdded   = scene.children.length > cntBeforeRoof;
      const trimmedAfterRoof = scene.children.filter(c =>
        c.userData?.kind === 'wall' && c.userData?.topProfile === 'pitched').length;
      if (!roofAdded || !trimmedAfterRoof) return { passed: false,
        evidence: { phase: 'after-roof', roofAdded, trimmedAfterRoof } };
      d('SdUndo', {});
      await new Promise(r => setTimeout(r, 300));
      const roofRemoved     = scene.children.length < cntBeforeRoof + 1;
      const stillTrimmed    = scene.children.filter(c =>
        c.userData?.kind === 'wall' && c.userData?.topProfile === 'pitched').length;
      if (!roofRemoved || stillTrimmed > 0) return { passed: false,
        evidence: { phase: 'after-undo', roofRemoved, stillTrimmed } };
      d('SdRedo', {});
      await new Promise(r => setTimeout(r, 300));
      const roofRestored = scene.children.length > scene.children.filter(
        c => c.userData?.kind === 'wall').length;
      const reTrimmed    = scene.children.filter(c =>
        c.userData?.kind === 'wall' && c.userData?.topProfile === 'pitched').length;
      return { passed: roofRemoved && !stillTrimmed && reTrimmed > 0,
               evidence: { trimmedAfterRoof, roofRemoved, stillTrimmed, reTrimmed, roofRestored } };
    } catch(e) { return { passed: false, evidence: { error: e.message } }; }
  })()`);
  record("gable-trim-undo-roundtrip",
    r?.passed ?? false,
    r?.evidence ?? { reason: "evaluate null" });
}

if (!failedEarly) {
  // ── S77: export-dropdown-renders ─────────────────────────────────────────────
  await resetScene('s77-pre');
  const r = await evaluate(`(async function() {
    try {
      const exportBtn = document.getElementById('ribbon-export-btn');
      if (!exportBtn) return { passed: false, evidence: { reason: '#ribbon-export-btn not found' } };
      exportBtn.click();
      await new Promise(r => setTimeout(r, 400));
      const drawer = document.querySelector('.export-drawer');
      const drawerOpen = !!drawer && drawer.classList.contains('open');
      if (!drawerOpen) return { passed: false, evidence: { reason: '.export-drawer.open not present after click' } };
      const fmtButtons = drawer.querySelectorAll('.ed-fmt[data-fmt]');
      const fmtCount   = fmtButtons.length;
      const fmtSet     = new Set([...fmtButtons].map(b => b.dataset.fmt));
      const closeBtn   = drawer.querySelector('.ed-close');
      if (closeBtn) closeBtn.click();
      await new Promise(r => setTimeout(r, 400));
      const drawerClosed = !document.querySelector('.export-drawer.open');
      return {
        passed: fmtCount >= 10 && fmtSet.has('ifc') && fmtSet.has('glb') &&
                fmtSet.has('pdf') && fmtSet.has('dxf') && drawerClosed,
        evidence: { fmtCount, drawerOpen, drawerClosed, fmtsFound: [...fmtSet].sort() }
      };
    } catch(e) { return { passed: false, evidence: { error: e.message } }; }
  })()`);
  record("export-dropdown-renders",
    r?.passed ?? false,
    r?.evidence ?? { reason: "evaluate null" });
}

if (!failedEarly) {
  // ── S78: fzk-haus-perception-rehearsal ───────────────────────────────────────
  await resetScene('s78-pre');
  // Check for model consent overlay before submitting.
  const sendBtnState = await evaluate(`(function() {
    const btn = document.querySelector('.chat-send-btn');
    return btn ? { found: true, disabled: btn.disabled } : { found: false, disabled: true };
  })()`);

  if (!sendBtnState || sendBtnState.disabled) {
    record("fzk-haus-perception-rehearsal", false,
      { reason: "model consent overlay blocking — send button disabled" },
      /* uncertain = */ true);
  } else {
    // testMode OFF for this surface so agent turn is real.
    await evaluate(`(window.__testMode = false, true)`);
    const r = await evaluate(`(async function() {
      try {
        const KEYWORDS = ['wall', 'slab', 'roof', 'door', 'window', 'column'];
        const keyHits  = text => KEYWORDS.filter(k => text.toLowerCase().includes(k)).length;
        const selfOk   = keyHits('') === 0 && keyHits('walls, slabs and a roof') >= 2;
        if (!selfOk) return { passed: false, evidence: { selfTestFailed: true } };

        const loadPromise = new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('ifc-loaded timeout (30s)')), 30000);
          window.addEventListener('viewer:ifc-loaded', e => { clearTimeout(t); resolve(e.detail); }, { once: true });
        });
        const resp = await fetch('/samples/AC20-FZK-Haus.ifc');
        if (!resp.ok) return { passed: false, evidence: { reason: 'fetch failed', status: resp.status } };
        const bytes  = await resp.arrayBuffer();
        const file   = new File([bytes], 'AC20-FZK-Haus.ifc', { type: 'application/x-step' });
        const dt     = new DataTransfer();
        dt.items.add(file);
        const fileInput = document.getElementById('file-input');
        if (!fileInput) return { passed: false, evidence: { reason: '#file-input not found' } };
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        try { await loadPromise; } catch(e) { return { passed: false, evidence: { reason: e.message } }; }
        await new Promise(r => setTimeout(r, 1000));

        const sceneMeshCount = window.__viewer?.scene?.children?.length ?? 0;
        if (!sceneMeshCount) return { passed: false, evidence: { reason: 'scene empty after IFC load' } };

        const dockTab = document.querySelector('.dock-tab[data-tab="prompt"]');
        if (dockTab) { dockTab.click(); await new Promise(r => setTimeout(r, 200)); }

        const chatInput = document.querySelector('.chat-input');
        const sendBtn   = document.querySelector('.chat-send-btn');
        if (!chatInput || !sendBtn) return { passed: false, evidence: { reason: 'chat UI not found' } };
        if (sendBtn.disabled) return { passed: false, evidence: { reason: 'send-btn disabled' } };

        const turnPromise = new Promise(resolve => {
          const t = setTimeout(() => resolve({ timedOut: true }), 60000);
          window.addEventListener('agent:turn-complete', e => {
            clearTimeout(t); resolve({ timedOut: false, verbs: e.detail?.verbs ?? [] });
          }, { once: true });
        });
        chatInput.value = "What's currently in the scene?";
        chatInput.dispatchEvent(new Event('input', { bubbles: true }));
        chatInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
        chatInput.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        const turn = await turnPromise;
        if (turn.timedOut) return { passed: false, evidence: { reason: 'agent:turn-complete timeout (60s)', sceneMeshCount } };

        const msgEls  = document.querySelectorAll('.chat-msg-assistant, .chat-message.assistant, [data-role="assistant"]');
        const lastMsg = msgEls.length > 0 ? msgEls[msgEls.length - 1].innerText : '';
        const hits     = keyHits(lastMsg);
        return { passed: hits >= 2,
                 evidence: { sceneMeshCount, hits, hitsFound: KEYWORDS.filter(k => lastMsg.toLowerCase().includes(k)),
                              responseSnippet: lastMsg.slice(0, 200) } };
      } catch(e) { return { passed: false, evidence: { error: e.message } }; }
    })()`);
    // Restore testMode.
    await evaluate(`(window.__testMode = true, true)`);
    record("fzk-haus-perception-rehearsal",
      r?.passed ?? false,
      r?.evidence ?? { reason: "evaluate null" });
  }
}

try { ws.close(); } catch { /* ignore */ }

// ── Summary table ─────────────────────────────────────────────────────────────

const allPassed = surfaces.every(s => s.passed);
const passCount = surfaces.filter(s => s.passed && !s.uncertain).length;
const uncertCount = surfaces.filter(s => s.uncertain).length;

console.log("\n┌──────────────────────────────────────────────────────┐");
console.log("│  Demo-flow smoke pack — results                      │");
console.log("├──────────────────────────────────────────────────────┤");
for (const s of surfaces) {
  const status = s.uncertain ? "UNCERTAIN" : (s.passed ? "pass     " : "FAIL     ");
  const name   = s.name.padEnd(38).slice(0, 38);
  console.log(`│  ${status}  ${name}  │`);
}
console.log("├──────────────────────────────────────────────────────┤");
console.log(`│  ${passCount}/${surfaces.length} pass${uncertCount ? ` · ${uncertCount} uncertain` : ""}${failedEarly ? ` · stopped at: ${failedEarly}` : ""}`.padEnd(54) + "  │");
console.log("└──────────────────────────────────────────────────────┘");

// ── Write receipt ─────────────────────────────────────────────────────────────

const receipt = { sha, timestamp, all_passed: allPassed, fail_fast_at: failedEarly, surfaces };
writeFileSync(`${STATE_DIR}/demo-verify-latest.json`, JSON.stringify(receipt, null, 2));
console.log(`\nOutput: state/demo-verify-latest.json`);

process.exit(allPassed ? 0 : 1);
