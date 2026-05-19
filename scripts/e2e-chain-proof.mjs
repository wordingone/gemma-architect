/**
 * e2e-chain-proof.mjs
 * Full chain: fresh-device IDB clear → real model download → boot → demo chip inference.
 * Attaches to shared :9222. Never launches or closes Chrome.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
const ARTIFACT_DIR = resolve(ROOT, `state/chain-proof-artifacts/${TS}`);
mkdirSync(ARTIFACT_DIR, { recursive: true });

const TARGET = 'http://localhost:5847/';
const BOOT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min for real download from CDN
const INFER_TIMEOUT_MS = 90_000;

// ── Connect (never close Chrome) ──────────────────────────────────────────────
const _exitBefore       = process.rawListeners('exit').slice();
const _sigintBefore     = process.rawListeners('SIGINT').slice();
const _beforeExitBefore = process.rawListeners('beforeExit').slice();
const _sigtermBefore    = process.rawListeners('SIGTERM').slice();

const browser = await chromium.connectOverCDP('http://localhost:9222');

const purgeNew = (ev, before) =>
  process.rawListeners(ev).filter(l => !before.includes(l)).forEach(l => process.removeListener(ev, l));
purgeNew('exit', _exitBefore);
purgeNew('SIGINT', _sigintBefore);
purgeNew('beforeExit', _beforeExitBefore);
purgeNew('SIGTERM', _sigtermBefore);

browser.close = async () => {};
const ctx = browser.contexts()[0];
if (ctx) ctx.close = async () => {};

const pages = ctx.pages();
const page = pages.length > 0 ? pages[0] : await ctx.newPage();
console.log(`Connected to :9222 — using ${pages.length > 0 ? 'existing' : 'new'} tab`);

// Console capture — highest forensic value on the real-CDN path
const consoleLogs = [];
page.on('console', msg => {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `${ts} [${msg.type()}] ${msg.text()}`;
  consoleLogs.push(line);
  // Mirror to script stdout for real-time visibility
  if (msg.type() === 'error' || msg.type() === 'warning') process.stderr.write(line + '\n');
});

// ── Step 1: Navigate to app, clear IDB ───────────────────────────────────────
console.log('\n[1/3] Clearing IDB (fresh-device simulation)...');
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });

await page.evaluate(async () => {
  // Clear IDB stores
  const dbs = ['transformers-cache', 'model-cache', 'gemma-cache'];
  for (const name of dbs) {
    await new Promise(res => {
      const r = indexedDB.deleteDatabase(name);
      r.onsuccess = res; r.onerror = res; r.onblocked = res;
    });
  }
  // Clear Cache API (transformers.js stores model weights here, not in IDB)
  if ('caches' in globalThis) {
    const names = await caches.keys();
    await Promise.all(names.map(n => caches.delete(n)));
  }
});
console.log('  IDB + Cache API cleared (true fresh device)');

// ── Step 2: Reload → real fresh-device download ───────────────────────────────
console.log('\n[2/3] Reloading (fresh device)…');
await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
console.log('  Page loaded — watching boot events (timeout 5 min)...');

// Poll loading state every 10s while waiting for boot event
const pollInterval = setInterval(async () => {
  try {
    const state = await page.evaluate(() => {
      const screen = document.querySelector('.boot-screen, #boot-screen, [data-boot-screen]');
      const stalled = document.body.innerText.includes('DOWNLOAD STALLED') || document.body.innerText.includes('check your connection');
      const pct = document.querySelector('.download-pct, .progress-pct, [data-progress]');
      return {
        screenVisible: screen ? screen.getBoundingClientRect().height > 0 : null,
        stalled,
        progress: pct ? pct.textContent.trim() : null,
        bodySnippet: document.body.innerText.slice(0, 120).replace(/\n/g, ' '),
      };
    });
    if (state.stalled) {
      console.error('  ❌ STALLED screen appeared — fix regression!');
      process.exitCode = 1;
    } else {
      console.log(`  ⏳ ${new Date().toISOString().slice(11,19)} — ${state.bodySnippet}`);
    }
  } catch {}
}, 10_000);

const bootResult = await page.evaluate(() => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ event: 'timeout' }), 600_000);
  const done = (name) => (e) => { clearTimeout(timer); resolve({ event: name, detail: e.detail ?? null }); };
  window.addEventListener('agentmodel:boot-complete', done('boot-complete'));
  window.addEventListener('agentmodel:returning-user', done('returning-user'));
  window.addEventListener('agentmodel:error', done('error'));
}), { timeout: 605_000 });

clearInterval(pollInterval);

if (bootResult.event === 'timeout') {
  console.error('  ❌ Boot timed out after 5 min — model download stalled or too slow');
  process.exit(1);
}
if (bootResult.event === 'error') {
  console.error('  ❌ agentmodel:error fired:', JSON.stringify(bootResult.detail));
  process.exit(1);
}
console.log(`  ✅ Boot complete — event: ${bootResult.event}`);

// ── Step 3: Click demo chip → wait for inference output ───────────────────────
console.log('\n[3/3] Clicking demo chip → waiting for inference...');

// Small wait for UI to stabilize post-boot
await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));

const chipText = await page.evaluate(() => {
  const chips = Array.from(document.querySelectorAll(
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
  console.error('  ❌ Demo chip not found on page');
  process.exit(1);
}
console.log(`  Clicked: "${chipText}"`);

const inferResult = await page.evaluate(() => new Promise((resolve) => {
  const FAIL_PHRASES = ['model is still loading', 'please wait a moment'];
  const check = () => {
    const wall = document.querySelector('.chat-list');
    if (!wall || wall.children.length === 0) return null;
    const texts = Array.from(wall.children).map(el => el.textContent?.toLowerCase() ?? '');
    const stillLoading = texts.some(t => FAIL_PHRASES.some(p => t.includes(p)));
    if (stillLoading) return { ok: false, reason: 'model-not-ready: boot gate did not hold', texts };
    return { ok: true, count: wall.children.length, texts };
  };
  const wall = document.querySelector('.chat-list');
  if (!wall) return resolve({ ok: false, reason: 'no .chat-list' });
  const immediate = check();
  if (immediate) return resolve(immediate);
  const obs = new MutationObserver(() => {
    const r = check();
    if (r) { obs.disconnect(); resolve(r); }
  });
  obs.observe(wall, { childList: true, subtree: true });
  setTimeout(() => { obs.disconnect(); resolve({ ok: false, reason: 'timeout — no model response' }); }, 90_000);
}), { timeout: 95_000 });

if (!inferResult.ok) {
  console.error(`  ❌ Inference check failed: ${inferResult.reason}`);
  if (inferResult.texts) console.error('  Chat content:', inferResult.texts);
  process.exit(1);
}
console.log(`  ✅ Model responded (${inferResult.count} message(s)); boot gate held — no "model still loading"`);
if (inferResult.texts) console.log('  Content:', inferResult.texts.map(t => t.slice(0, 80)));

// Write console capture and final screenshot
try {
  const consoleLogPath = resolve(ARTIFACT_DIR, 'console.log');
  writeFileSync(consoleLogPath, consoleLogs.join('\n') + (consoleLogs.length ? '\n' : ''), 'utf8');
  console.log(`\n📝 Console capture: ${consoleLogPath} (${consoleLogs.length} lines)`);
  const screenshotPath = resolve(ARTIFACT_DIR, 'final.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`📷 Screenshot: ${screenshotPath}`);
} catch (e) {
  console.log(`⚠️  Artifact write failed: ${e.message.slice(0, 60)}`);
}

console.log('\n✅ CHAIN COMPLETE: loading screen → fresh download → boot → inference\n');
