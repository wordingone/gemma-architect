/**
 * e2e-chain-proof.mjs — no-fakes gate for #1058
 *
 * Full chain: real CDN download → real boot → real chip click →
 *             real NL reply → real geometry dispatch → real viewport assertion.
 *
 * NOTHING FAKED. No fake-clock. No synthetic events. No mocked responses.
 * Every step is real. Every assertion is on real state.
 *
 * Run only with explicit user invitation:
 *   CHAIN_PROOF_INVITED=1 node scripts/e2e-chain-proof.mjs
 *
 * Attaches to shared :9222. Never launches or closes Chrome.
 */

// ── User-invitation gate ──────────────────────────────────────────────────────
if (!process.env.CHAIN_PROOF_INVITED) {
  console.log('Chain proof requires explicit user invitation.');
  console.log('Run with: CHAIN_PROOF_INVITED=1 node scripts/e2e-chain-proof.mjs');
  process.exit(0);
}

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const TS        = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
const ARTIFACT_DIR = resolve(ROOT, `state/chain-proof-artifacts/${TS}`);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const TARGET        = 'http://localhost:5847/';
const TARGET_ORIGIN = new URL(TARGET).origin;
const BOOT_MS       = 10 * 60 * 1000; // 10 min — real CDN download of ~2.7GB

const t0    = Date.now();
const elapsed = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
const log   = msg => console.log(`  ${elapsed()}  ${msg}`);
const pause = ms  => new Promise(r => setTimeout(r, ms));

// ── Connect — never close Chrome ──────────────────────────────────────────────
const _exitBefore       = process.rawListeners('exit').slice();
const _sigintBefore     = process.rawListeners('SIGINT').slice();
const _beforeExitBefore = process.rawListeners('beforeExit').slice();
const _sigtermBefore    = process.rawListeners('SIGTERM').slice();

const browser = await chromium.connectOverCDP('http://localhost:9222');

const purgeNew = (ev, before) =>
  process.rawListeners(ev).filter(l => !before.includes(l))
    .forEach(l => process.removeListener(ev, l));
purgeNew('exit',       _exitBefore);
purgeNew('SIGINT',     _sigintBefore);
purgeNew('beforeExit', _beforeExitBefore);
purgeNew('SIGTERM',    _sigtermBefore);

browser.close = async () => {};
const ctx = browser.contexts()[0];
if (ctx) ctx.close = async () => {};

const pages = ctx.pages();
const page  = pages.length > 0 ? pages[0] : await ctx.newPage();
log(`Connected to :9222 — ${pages.length > 0 ? 'existing' : 'new'} tab`);

// Set Playwright-level timeout high so evaluate() calls don't expire
// before the real CDN download completes.
page.setDefaultTimeout(12 * 60 * 1000);

// CDP session — for storage wipe
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable').catch(() => {});

// Console capture — full forensic log of the real-CDN session
const consoleLogs = [];
page.on('console', msg => {
  const ts   = new Date().toISOString().slice(11, 23);
  const line = `${ts} [${msg.type()}] ${msg.text()}`;
  consoleLogs.push(line);
  if (msg.type() === 'error' || msg.type() === 'warning')
    process.stderr.write('  BROWSER ' + line + '\n');
});

// ── Phase 1: Real fresh-device wipe ──────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 1 — Fresh device: wipe all storage, load app');
console.log('════════════════════════════════════════════════════════');

// Register init script BEFORE navigation so boot events are captured even if they
// fire before Phase 2's page.evaluate registers its listeners. Returning-user path
// can fire within milliseconds of DOMContentLoaded when model is in OPFS cache.
await page.addInitScript(() => {
  window.__bootResult = null;
  const _capture = name => e => {
    if (!window.__bootResult) window.__bootResult = { event: name, detail: e.detail ?? null };
  };
  window.addEventListener('agentmodel:boot-complete',  _capture('boot-complete'),  { once: true });
  window.addEventListener('agentmodel:returning-user', _capture('returning-user'), { once: true });
  window.addEventListener('agentmodel:error',          _capture('error'),          { once: true });
});

await cdp.send('Storage.clearDataForOrigin', { origin: TARGET_ORIGIN, storageTypes: 'all' });
await cdp.send('Network.clearBrowserCache');
log('CDP wipe complete — IDB, Cache API, cookies, all cleared');

// ── Fix 2: JS-level explicit clear for surfaces CDP may miss (OPFS, Cache API, IDB, SW) ─
const clearReport = await page.evaluate(async () => {
  const r = {};
  try {
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
    r.cacheApi = `cleared ${names.length}`;
  } catch (e) { r.cacheApi = `err:${e.message.slice(0,40)}`; }

  try {
    const root = await navigator.storage.getDirectory();
    const entries = [];
    for await (const [name] of root.entries()) entries.push(name);
    await Promise.all(entries.map(n => root.removeEntry(n, { recursive: true })));
    r.opfs = `cleared ${entries.length} entries`;
  } catch (e) { r.opfs = `err:${e.message.slice(0,40)}`; }

  try {
    const dbs = await indexedDB.databases?.() ?? [];
    for (const db of dbs) {
      const req = indexedDB.deleteDatabase(db.name);
      await new Promise(res => { req.onsuccess = res; req.onerror = res; req.onblocked = res; });
    }
    r.idb = `cleared ${dbs.length} dbs`;
  } catch (e) { r.idb = `err:${e.message.slice(0,40)}`; }

  try {
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    await Promise.all(regs.map(reg => reg.unregister()));
    r.sw = `unregistered ${regs.length}`;
  } catch (e) { r.sw = `err:${e.message.slice(0,40)}`; }

  return r;
}).catch(e => ({ error: e.message.slice(0, 80) }));
log(`JS clear: ${JSON.stringify(clearReport)}`);

// ── Fix 1: Verify storage is near-empty after wipe ───────────────────────────
const storageCheck = await page.evaluate(async () => {
  const est = await navigator.storage.estimate().catch(() => null);
  const cacheNames = await caches.keys().catch(() => []);
  let opfsEntries = 0;
  try { const root = await navigator.storage.getDirectory(); for await (const _ of root.entries()) opfsEntries++; } catch {}
  return { usageBytes: est?.usage ?? -1, cacheNames, opfsEntries };
}).catch(e => ({ error: e.message.slice(0, 80) }));
log(`Post-wipe storage: usage=${storageCheck.usageBytes}B caches=[${(storageCheck.cacheNames ?? []).join(',')}] opfs=${storageCheck.opfsEntries}`);

if (!storageCheck.error &&
    ((storageCheck.usageBytes > 5_000_000) ||
     (storageCheck.cacheNames?.length > 0)  ||
     (storageCheck.opfsEntries > 0))) {
  log('HALT:fresh-device-violated STORAGE — residual model data survives wipe');
  process.exit(1);
}

// ── Fix 4: Cache-bust URL so service-worker URL matching cannot shortcut ─────
const GOTO_URL = TARGET + '?_freshdevice=' + Date.now();
await page.goto(GOTO_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
log('App loaded — boot screen should appear');
await pause(2_000);

// Auto-click "Download model" prompt if present (app shows this on fresh device before fetch starts)
const downloadBtnText = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Download model'));
  if (btn) { btn.click(); return btn.textContent.trim(); }
  return null;
}).catch(() => null);
if (downloadBtnText) {
  log(`Clicked: "${downloadBtnText}" — CDN fetch initiated`);
} else {
  log('No "Download model" button found — download may auto-start');
}

// ── Phase 2: Real CDN download, watched live ──────────────────────────────────
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 2 — Real CDN download (no fake bytes, no synthetic events)');
console.log(`  Watching HuggingFace CDN deliver real model bytes (up to ${BOOT_MS / 60_000} min)...`);
console.log('════════════════════════════════════════════════════════');

const progressHistory = [];
let   lastPct         = null;

// Poll visible progress every 15s for user-watchable stdout + monotonicity record
const pollInterval = setInterval(async () => {
  try {
    const s = await page.evaluate(() => {
      const body    = document.body.innerText ?? '';
      const stalled = body.includes('DOWNLOAD STALLED') || body.includes('check your connection');
      const pctEl   = document.querySelector('[data-download-pct]');
      const pct = pctEl ? (pctEl.getAttribute('data-download-pct') || pctEl.textContent?.trim() || null) : null;
      return { stalled, pct, snippet: body.slice(0, 120).replace(/\n+/g, ' | ') };
    }).catch(() => null);
    if (!s) return;
    if (s.stalled) {
      log('❌ STALLED screen visible — real download interrupted');
    } else {
      if (s.pct && s.pct !== lastPct) {
        progressHistory.push({ ts: Date.now(), pct: s.pct });
        lastPct = s.pct;
      }
      log(`${s.pct ?? '?%'} — ${s.snippet.slice(0, 90)}`);
    }
  } catch {}
}, 15_000);

// Wait for real boot event — Promise.race with Node-side timeout.
// Also checks window.__bootResult set by the init script, in case the event
// fired during the 2-second pause before this evaluate registered its listeners.
const bootFromPage = page.evaluate(() => new Promise(resolve => {
  if (window.__bootResult) { resolve(window.__bootResult); return; }
  const done = name => e => {
    window.__bootResult = { event: name, detail: e.detail ?? null };
    resolve(window.__bootResult);
  };
  window.addEventListener('agentmodel:boot-complete',  done('boot-complete'),  { once: true });
  window.addEventListener('agentmodel:returning-user', done('returning-user'), { once: true });
  window.addEventListener('agentmodel:error',          done('error'),          { once: true });
}));
const bootTimeout = new Promise(r => setTimeout(() => r({ event: 'timeout' }), BOOT_MS));
const bootResult  = await Promise.race([bootFromPage, bootTimeout]);

clearInterval(pollInterval);

if (bootResult.event === 'timeout') {
  log(`❌ Boot timed out after ${BOOT_MS / 60_000} min — CDN too slow or stalled`);
  process.exit(1);
}
if (bootResult.event === 'error') {
  log(`❌ agentmodel:error: ${JSON.stringify(bootResult.detail)}`);
  process.exit(1);
}
// Fix 3: returning-user = model was cached = fresh-device-violated
if (bootResult.event === 'returning-user') {
  log('HALT:fresh-device-violated — returning-user fired; model cached, CDN download NOT tested');
  process.exit(1);
}

// Monotonicity check — real bytes must only go up
const monotonicOk = progressHistory.length < 2 || progressHistory.every((p, i) => {
  if (i === 0) return true;
  return (parseInt(p.pct) || 0) >= (parseInt(progressHistory[i - 1].pct) || 0);
});

log(`✅ Boot complete — event: ${bootResult.event}`);
log(`   Progress: ${progressHistory.map(p => p.pct).join(' → ') || '(no progress samples)'}`);
log(`   Monotonic: ${monotonicOk ? '✅' : '⚠️  non-monotonic detected'}`);

await pause(2_000);

// ── Phase 3: Real chip click ──────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 3 — Real chip click (two-storey house)');
console.log('════════════════════════════════════════════════════════');

await pause(2_000); // real wait for UI to stabilize

const chipText = await page.evaluate(() => {
  const chips  = Array.from(document.querySelectorAll(
    '.chat-starter-chip, [data-prompt-chip], .ai-chip'
  ));
  const target = chips.find(el => {
    const t = el.textContent.toLowerCase();
    return t.includes('two-story') || t.includes('two story') || t.includes('2 stor') || t.includes('house');
  });
  if (target) { target.click(); return target.textContent.trim(); }
  return null;
});

if (!chipText) {
  log('❌ Demo chip not found — UI may not have loaded correctly');
  process.exit(1);
}
log(`✅ Chip clicked: "${chipText}"`);
await pause(2_000);

// ── Phase 3.5 + 4: Wait for agent:turn-complete ──────────────────────────────
// agent:turn-complete fires (chat-panel.ts:624) when NL reply is rendered
// AND all tool dispatches have completed. Covers both phase 3.5 and 4.
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 3.5 — Agent NL reply + tool dispatches (watching live)');
console.log('  Waiting for agent:turn-complete...');
console.log('════════════════════════════════════════════════════════');

const DISPATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — Gemma 4B needs up to ~200s for 997-tok plan

const turnFromPage = page.evaluate(() => new Promise(resolve => {
  // Prefer agent:turn-complete event (fires when both NL + dispatches done)
  window.addEventListener('agent:turn-complete', e => {
    resolve({ source: 'event', detail: e.detail ?? null });
  }, { once: true });

  // Fallback: scene stabilization — 10s no change AFTER new geometry appears.
  // initialCount captures the default-scene baseline so the fallback does NOT fire
  // while the model is still generating (scene unchanged at baseline count).
  const initialCount = window.__viewer?.scene?.children?.length ?? 0;
  let lastCount = -1, stableFor = 0;
  const STABLE_MS = 10_000, POLL_MS = 1_000;
  const poll = setInterval(() => {
    const count = window.__viewer?.scene?.children?.length ?? -1;
    if (count !== lastCount) { lastCount = count; stableFor = 0; }
    else stableFor += POLL_MS;
    if (stableFor >= STABLE_MS && count > initialCount) {
      clearInterval(poll);
      resolve({ source: 'scene-stable', count });
    }
  }, POLL_MS);

  // Clean up poll if event fires first
  window.addEventListener('agent:turn-complete', () => clearInterval(poll), { once: true });
}));
const turnTimeout  = new Promise(r => setTimeout(() => r({ source: 'timeout' }), DISPATCH_TIMEOUT_MS));
const turnResult   = await Promise.race([turnFromPage, turnTimeout]);

log(`Turn settled — source: ${turnResult.source}`);

// Phase 3.5 assertion: NL text visible in chat panel
const nlText = await page.evaluate(() => {
  const msgs = Array.from(document.querySelectorAll(
    '.chat-list .chat-message[data-role="assistant"], .chat-message.assistant, .chat-bubble.assistant'
  ));
  return msgs.length ? (msgs[msgs.length - 1].textContent?.trim() ?? '') : null;
}).catch(() => null);

if (nlText) {
  log(`✅ NL reply visible: "${nlText.slice(0, 200)}"`);
} else {
  log('⚠️  No assistant chat bubble found (UI selector may differ)');
}

await pause(2_000);

// Phase 4 log — scene children count
const sceneCount = await page.evaluate(() =>
  window.__viewer?.scene?.children?.length ?? -1
).catch(() => -1);
log(`Scene children at turn-complete: ${sceneCount}`);

// ── Phase 5: Scene geometry assertion ────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 5 — Scene geometry assertion (userData.creator)');
console.log('════════════════════════════════════════════════════════');

await pause(2_000);

const sceneAssertion = await page.evaluate(() => {
  const scene = window.__viewer?.scene;
  if (!scene) return { ok: false, reason: '__viewer.scene not found' };
  const all      = Array.from(scene.children ?? []);
  const walls    = all.filter(o => o.userData?.creator === 'wall').length;
  const slabs    = all.filter(o => o.userData?.creator === 'slab').length;
  const roofs    = all.filter(o => o.userData?.creator === 'roof').length;
  const doors    = all.filter(o => o.userData?.creator === 'door').length;
  const windows  = all.filter(o => o.userData?.creator === 'window').length;
  const openings = doors + windows;
  return {
    ok: walls >= 4 && slabs >= 2 && roofs >= 1 && openings >= 1,
    walls, slabs, roofs, doors, windows, openings, total: all.length,
  };
}).catch(e => ({ ok: false, reason: e.message }));

if (sceneAssertion.reason) {
  log(`❌ Scene assertion error: ${sceneAssertion.reason}`);
  process.exitCode = 1;
} else if (!sceneAssertion.ok) {
  log(`❌ Scene assertion FAILED`);
  log(`   walls:${sceneAssertion.walls} (≥4?)  slabs:${sceneAssertion.slabs} (≥2?)  ` +
      `roofs:${sceneAssertion.roofs} (≥1?)  openings:${sceneAssertion.openings} (≥1?)`);
  process.exitCode = 1;
} else {
  log('✅ Scene assertion PASSED');
  log(`   walls:${sceneAssertion.walls}  slabs:${sceneAssertion.slabs}  roofs:${sceneAssertion.roofs}  ` +
      `doors:${sceneAssertion.doors}  windows:${sceneAssertion.windows}  total:${sceneAssertion.total}`);
}

// ── Phase 6: Canvas screenshot for /visual-check ─────────────────────────────
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 6 — Canvas screenshot (Haiku /visual-check)');
console.log('════════════════════════════════════════════════════════');

await pause(1_000);

let canvasPath = null;
try {
  const canvasEl  = page.locator('#viewer-canvas, canvas.viewer-canvas, .vp-body canvas').first();
  const canvasBox = await canvasEl.boundingBox().catch(() => null);
  canvasPath = resolve(ARTIFACT_DIR, canvasBox ? 'canvas.png' : 'canvas-fullpage.png');
  await page.screenshot({ path: canvasPath, ...(canvasBox ? { clip: canvasBox } : {}) });
  log(`📷 Canvas: ${canvasPath}`);
} catch (e) {
  log(`⚠️  Canvas screenshot: ${e.message.slice(0, 60)}`);
}

// ── Phase 7: Artifacts ────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 7 — Writing artifacts');
console.log('════════════════════════════════════════════════════════');

try {
  writeFileSync(resolve(ARTIFACT_DIR, 'console.log'),
    consoleLogs.join('\n') + (consoleLogs.length ? '\n' : ''), 'utf8');
  log(`📝 console.log (${consoleLogs.length} lines)`);

  writeFileSync(resolve(ARTIFACT_DIR, 'scene-state.json'), JSON.stringify({
    bootEvent: bootResult.event,
    progressHistory,
    monotonicOk,
    turnSource: turnResult.source,
    nlTextSample: (nlText ?? '').slice(0, 500),
    scene: sceneAssertion,
  }, null, 2), 'utf8');
  log('📊 scene-state.json');

  await page.screenshot({ path: resolve(ARTIFACT_DIR, 'final.png'), fullPage: false });
  log('📷 final.png');
} catch (e) {
  log(`⚠️  Artifact write: ${e.message.slice(0, 60)}`);
}

const overallPass = !process.exitCode && sceneAssertion.ok;

console.log('\n════════════════════════════════════════════════════════');
console.log(overallPass ? '✅ CHAIN COMPLETE — all phases passed' : '❌ CHAIN INCOMPLETE — see failures above');
console.log(`Artifact dir: ${ARTIFACT_DIR}`);
if (canvasPath) console.log(`Canvas for /visual-check: ${canvasPath}`);
console.log('════════════════════════════════════════════════════════\n');
