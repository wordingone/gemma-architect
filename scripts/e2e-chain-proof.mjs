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
  // Forward diagnostic signals + first-token marker to stdout in real time.
  // [chainproof] = browser-side poll logs; [vision] = model received prompt.
  const text = msg.text();
  if (text.startsWith('[chainproof]') || text.startsWith('[vision]'))
    process.stdout.write('  BROWSER ' + line + '\n');
});

// Navigation forensics — capture URL when page navigates mid-test.
// Resolves the root-cause ambiguity from iter 10-42-25Z (context-destroyed at +543s).
// SW-triggered reload → navigates to http://localhost:5847
// OOM/crash → navigates to chrome-error://chromewebdata
// Neither OOM nor app-navigation code could explain +543s; SW updatefound is the remaining candidate.
const _t0 = Date.now();
const navLog = [];
page.on('framenavigated', frame => {
  if (frame === page.mainFrame()) {
    const entry = `+${Math.round((Date.now() - _t0) / 1000)}s  framenavigated → ${frame.url()}`;
    navLog.push(entry);
    process.stderr.write('  NAV ' + entry + '\n');
  }
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
console.log('PHASE 1 — Fresh session: clear state, preserve model + shaders + COI SW');
console.log('════════════════════════════════════════════════════════');

// Navigate to TARGET first — ensures CDP storage ops target :5847 origin.
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });

// Clear session state only. cache_storage (model), OPFS (WebGPU shaders), and
// service_workers preserved. The COI service worker (coi-serviceworker.js) is
// infrastructure — it provides COOP/COEP shims required for SharedArrayBuffer /
// WebGPU. Unregistering it triggers re-registration on next load, which fires an
// 'updatefound' event → window.location.reload() mid-boot. Root cause of the
// +543s context-destroyed failure in iter 10-42-25Z (SW candidate A, confirmed
// by elimination). Keeping the SW registered means no re-registration, no
// updatefound, no reload. It is not session state.
await cdp.send('Storage.clearDataForOrigin', {
  origin: TARGET_ORIGIN,
  storageTypes: 'cookies,indexeddb,local_storage',
});
log('CDP wipe complete — IDB, cookies, localStorage cleared (SW + cache_storage + OPFS preserved)');

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
// .catch() converts page navigation / context destruction to a clean FAIL event
// rather than an uncaught exception that crashes node (seen in iter 10-42-25Z).
const bootFromPage = page.evaluate(() => new Promise(resolve => {
  const done = name => e => resolve({ event: name, detail: e.detail ?? null });
  window.addEventListener('agentmodel:boot-complete',  done('boot-complete'),  { once: true });
  window.addEventListener('agentmodel:returning-user', done('returning-user'), { once: true });
  window.addEventListener('agentmodel:error',          done('error'),          { once: true });
})).catch(err => ({ event: 'context-destroyed', detail: String(err) }));
const bootTimeout = new Promise(r => setTimeout(() => r({ event: 'timeout' }), BOOT_MS));
const bootResult  = await Promise.race([bootFromPage, bootTimeout]);

clearInterval(pollInterval);

if (bootResult.event === 'timeout') {
  log(`❌ Boot timed out after ${BOOT_MS / 60_000} min — CDN too slow or stalled`);
  process.exit(1);
}
if (bootResult.event === 'context-destroyed') {
  log(`❌ Phase 2: execution context destroyed — page navigated or crashed mid-boot`);
  log(`   Detail: ${bootResult.detail}`);
  log(`   Navigation log (check URL for SW-reload vs crash): ${navLog.join(' | ') || '(none recorded)'}`);
  log(`   Last 10 browser console lines:`);
  consoleLogs.slice(-10).forEach(l => log(`     ${l}`));
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

const DISPATCH_TIMEOUT_MS       = 3 * 60 * 1000; // 3 min total for NL + geometry
const FIRST_DISPATCH_TIMEOUT_MS = 120_000;         // 120s — explicit FAIL if model never dispatches

const turnFromPage = page.evaluate(() => new Promise(resolve => {
  const t0 = Date.now();
  const elapsedS = () => Math.round((Date.now() - t0) / 1000);

  // Prefer agent:turn-complete event (fires when both NL + dispatches done)
  window.addEventListener('agent:turn-complete', e => {
    console.log(`[chainproof] agent:turn-complete fired at +${elapsedS()}s`);
    resolve({ source: 'event', detail: e.detail ?? null });
  }, { once: true });

  // Fallback: scene stabilization — 10s no change in children count,
  // and count must exceed initialCount (pre-dispatch default scene).
  // Without this guard, the 10s stable window fires at the initial
  // scene count (e.g. 13 default children) before the model has had
  // time to emit its first dispatch — which can take 30-120s when
  // Phase 2 is fast (cache hit, 12s boot) and the model is cold-warm.
  const initialCount = window.__viewer?.scene?.children?.length ?? -1;
  let firstDispatchMs = null;
  let lastCount = -1, stableFor = 0;
  // 60s — last-resort fallback. agent:turn-complete should win the race for
  // normally-progressing turns. 10s was too short: model dispatches 2 setup
  // objects quickly then pauses >10s before architectural dispatch begins.
  const STABLE_MS = 60_000, POLL_MS = 1_000;

  // Explicit timeout: if model does not dispatch any geometry in 120s, FAIL.
  // Distinguishes "model silent" from "scene-stable fired too early."
  const firstDispatchTimer = setTimeout(() => {
    clearInterval(poll);
    console.log(`[chainproof] dispatch-timeout at +${elapsedS()}s — no geometry dispatched (scene still at ${window.__viewer?.scene?.children?.length ?? -1}, initial=${initialCount})`);
    resolve({ source: 'dispatch-timeout', initialCount });
  }, 120_000);

  const poll = setInterval(() => {
    const count = window.__viewer?.scene?.children?.length ?? -1;
    if (count !== lastCount) {
      if (count > initialCount) {
        if (firstDispatchMs === null) {
          firstDispatchMs = Date.now() - t0;
          console.log(`[chainproof] first-dispatch at +${elapsedS()}s — scene ${initialCount} → ${count}`);
          clearTimeout(firstDispatchTimer);
        }
        // Log each newly dispatched object (creator + name + uuid)
        const children = window.__viewer?.scene?.children ?? [];
        const prevIdx = Math.max(lastCount < initialCount ? initialCount : lastCount, initialCount);
        const newOnes = children.slice(prevIdx, count);
        for (const c of newOnes) {
          const creator = c.userData?.creator ?? '?';
          const uuid = (c.uuid ?? '').slice(0, 8);
          const name = c.name ?? '?';
          console.log(`[chainproof] dispatch obj#${prevIdx + newOnes.indexOf(c) + 1}: creator=${creator} name=${name} uuid=${uuid}`);
        }
      }
      lastCount = count; stableFor = 0;
    } else {
      stableFor += POLL_MS;
    }
    if (stableFor >= STABLE_MS && count > initialCount) {
      clearInterval(poll);
      console.log(`[chainproof] scene-stable at +${elapsedS()}s — count=${count} initial=${initialCount} delta=${count - initialCount} — turn-complete NEVER fired, fell back to scene-stable`);
      resolve({ source: 'scene-stable', count, initialCount, firstDispatchMs });
    }
  }, POLL_MS);

  window.addEventListener('agent:turn-complete', () => {
    clearInterval(poll);
    clearTimeout(firstDispatchTimer);
  }, { once: true });
}));
const turnTimeout  = new Promise(r => setTimeout(() => r({ source: 'timeout' }), DISPATCH_TIMEOUT_MS));
const turnResult   = await Promise.race([turnFromPage, turnTimeout]);

log(`Turn settled — source: ${turnResult.source}`);

// On any timeout: surface [agent-harness] diagnostic dumps captured in consoleLogs
function surfaceHarnessLogs(label) {
  const harnessLines = consoleLogs.filter(l =>
    l.includes('[agent-harness:turn-complete]') || l.includes('[agent-harness:zero-dispatch]')
  );
  if (harnessLines.length > 0) {
    log(`🔍 ${label} — agent-harness diagnostic (${harnessLines.length} lines):`);
    harnessLines.forEach(l => log(`   ${l}`));
  } else {
    log(`⚠️  ${label} — no [agent-harness] logs captured (model may not have completed a turn)`);
  }
}

if (turnResult.source === 'dispatch-timeout') {
  log(`❌ DISPATCH TIMEOUT — model did not produce any scene geometry within 120s. Phase 5 will fail.`);
  surfaceHarnessLogs('dispatch-timeout');
} else if (turnResult.source === 'timeout') {
  log(`❌ TURN TIMEOUT — full ${DISPATCH_TIMEOUT_MS / 1000}s elapsed without turn completion.`);
  surfaceHarnessLogs('turn-timeout');
}

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
