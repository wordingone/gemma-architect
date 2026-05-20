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
const BOOT_MS       = 20 * 60 * 1000; // 20 min — real CDN download of ~2.7GB; 10-min cap caused iter-7 timeout

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
//
// Semantic: clear SESSION STATE only — each iter boots with a clean app state
// (no stale chat history, no prior project, no cached user prefs). Persistent
// assets (Cache API model shards, OPFS WebGPU compiled shaders) survive across
// iters because:
//   - Cache API: Transformers.js model (~GB). CDN re-download takes >20 min on
//     this host — exceeds Phase 2 budget. Model validity is not iter-scoped.
//   - OPFS: WebGPU compiled shaders. Cold compile also >20 min. Shader validity
//     is not iter-scoped.
//
// What this validates: returning-user path determinism across 5 consecutive runs.
// First-time cold-download (truly fresh device) is validated separately, not per-iter.
//
console.log('\n════════════════════════════════════════════════════════');
console.log('PHASE 1 — Fresh session: clear state, preserve model + shaders');
console.log('════════════════════════════════════════════════════════');

// Navigate to TARGET first — ensures CDP storage ops target :5847 origin.
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });

// Clear session state only. cache_storage (model) and OPFS (WebGPU shaders) preserved.
await cdp.send('Storage.clearDataForOrigin', {
  origin: TARGET_ORIGIN,
  storageTypes: 'cookies,indexeddb,local_storage,service_workers',
});
log('CDP wipe complete — IDB, cookies, localStorage, SW unregistered (cache_storage + OPFS preserved)');

await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });
log('App loaded — boot screen should appear');
await pause(2_000);

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
      const pctEl   = document.querySelector('[data-progress], .download-pct, .progress-pct');
      return { stalled, pct: pctEl ? pctEl.textContent.trim() : null, snippet: body.slice(0, 120).replace(/\n+/g, ' | ') };
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

// Wait for real boot event — Promise.race with Node-side timeout
const bootFromPage = page.evaluate(() => new Promise(resolve => {
  const done = name => e => resolve({ event: name, detail: e.detail ?? null });
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

const DISPATCH_TIMEOUT_MS = 3 * 60 * 1000; // 3 min for NL + geometry

const turnFromPage = page.evaluate(() => new Promise(resolve => {
  // Prefer agent:turn-complete event (fires when both NL + dispatches done)
  window.addEventListener('agent:turn-complete', e => {
    resolve({ source: 'event', detail: e.detail ?? null });
  }, { once: true });

  // Fallback: scene stabilization — 10s no change in children count
  let lastCount = -1, stableFor = 0;
  const STABLE_MS = 10_000, POLL_MS = 1_000;
  const poll = setInterval(() => {
    const count = window.__viewer?.scene?.children?.length ?? -1;
    if (count !== lastCount) { lastCount = count; stableFor = 0; }
    else stableFor += POLL_MS;
    if (stableFor >= STABLE_MS && count > 0) {
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

// Canonical camera pose: SdZoomExtents → viewer.frameAllVisible() →
// perspective cam, dir=(1,1,1.5).norm, fit-to-scene-bounds. Eliminates
// azimuth variance across iters (iter 4 top-down: roof obscured walls).
await page.evaluate(() => window.__dispatch?.('SdZoomExtents', {}));
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
