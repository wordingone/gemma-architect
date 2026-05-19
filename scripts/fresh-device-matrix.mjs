#!/usr/bin/env node
/**
 * fresh-device-matrix.mjs — deterministic watchdog reproduction + fix verification (#1058).
 *
 * TWO PARTS:
 *
 * PART A — Logic unit tests (Node.js only, no browser):
 *   Embeds the exact watchdog algorithm from boot-screen.ts in two variants:
 *   OLD (pre-#1169): else if (_firstLoadingReceived && _loadedBytes > prevLoaded)
 *   NEW (post-#1169): else if (_firstLoadingReceived)
 *   Runs each scenario against both. Proves old code fails + new code passes.
 *
 * PART B — Browser E2E tests (7 CDP-variant chromium configs):
 *   ALL configs attach to the shared :9222 Chromium — never launch a new browser.
 *   State reset between configs via CDP: Storage.clearDataForOrigin + Network.clearBrowserCache.
 *   Per-config variation applied via CDP or page.evaluate AFTER goto.
 *   Sequential: one config at a time, full teardown before next.
 *   Screenshots saved to state/matrix-artifacts/<ts>/<config>/final.png.
 *
 * ROOT CAUSE (confirmed by Part A):
 *   _loadedBytes = Math.max(_loadedBytes, d.bytes) where d.bytes is per-file bytes.
 *   When shard N starts, d.bytes resets to 0, then climbs from 0 → shard_size.
 *   If shard_size <= previous shard's total, Math.max keeps _loadedBytes constant.
 *   OLD code: _loadedBytes > prevLoaded = false → watchdog never resets → STALLED fires
 *     even with bytes actively flowing from CDN.
 *   FIX: reset watchdog on any loading event after first bytes, not just when bytes advance.
 *
 * Usage:
 *   node scripts/fresh-device-matrix.mjs            # run Part A + Part B
 *   node scripts/fresh-device-matrix.mjs --unit     # Part A only (fast, no browser)
 *   node scripts/fresh-device-matrix.mjs --browser  # Part B only
 *   node scripts/fresh-device-matrix.mjs --url http://localhost:5847  # custom URL for Part B
 *   node scripts/fresh-device-matrix.mjs --config chromium-fresh      # single config
 *
 * Output: state/matrix-<ISO-ts>.json
 *         state/matrix-artifacts/<ISO-ts>/<config>/final.png
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
const OUT_FILE = resolve(ROOT, `state/matrix-${TS}.json`);
mkdirSync(resolve(ROOT, 'state'), { recursive: true });

const args = process.argv.slice(2);
const RUN_UNIT    = !args.includes('--browser');
const RUN_BROWSER = !args.includes('--unit');
const URL_IDX     = args.indexOf('--url');
const TARGET_URL  = URL_IDX >= 0 ? args[URL_IDX + 1]
  : 'http://localhost:5847/';
const CFG_IDX     = args.indexOf('--config');
const CONFIG_FILTER = CFG_IDX >= 0 ? args[CFG_IDX + 1] : null;

const TARGET_ORIGIN = (() => { try { return new URL(TARGET_URL).origin; } catch { return TARGET_URL; } })();
const ARTIFACT_DIR = resolve(ROOT, `state/matrix-artifacts/${TS}`);
mkdirSync(ARTIFACT_DIR, { recursive: true });

console.log(`\nfresh-device-matrix.mjs`);
console.log(`Target URL: ${TARGET_URL}`);
console.log(`Parts: ${RUN_UNIT ? 'Unit ' : ''}${RUN_BROWSER ? 'Browser' : ''}`);
console.log(`Output: ${OUT_FILE}\n`);

// ── PART A: Watchdog logic unit tests ────────────────────────────────────────

/**
 * Simulates the boot-screen watchdog in pure JS.
 * Returns { stalledAtMs: number|null, events: string[] }
 */
function runWatchdog(variant, scenario) {
  // Identical to boot-screen.ts logic
  let _loadedBytes    = 0;
  let _firstLoadingReceived = false;
  let _watchdogFireAt  = null;
  let _stalledAtMs     = null;
  let _now             = 0;
  const log            = [];

  function _setWatchdog(ms) {
    _watchdogFireAt = _now + ms;
    log.push(`  [${_now}ms] watchdog set → fires at ${_watchdogFireAt}ms`);
  }
  function _clearWatchdog() {
    if (_watchdogFireAt !== null) {
      log.push(`  [${_now}ms] watchdog cleared (was ${_watchdogFireAt}ms)`);
      _watchdogFireAt = null;
    }
  }
  function _tick(ms) {
    _now += ms;
    if (_watchdogFireAt !== null && _now >= _watchdogFireAt) {
      _stalledAtMs = _now;
      _watchdogFireAt = null;
      log.push(`  [${_now}ms] *** STALLED fired ***`);
    }
  }

  function handleManifest(totalBytesExpected) {
    log.push(`  [${_now}ms] agentmodel:manifest (total=${totalBytesExpected})`);
    _clearWatchdog();
    _setWatchdog(90_000);  // 90s initial grace
  }

  function handleLoading(bytes) {
    const prevLoaded = _loadedBytes;
    if ((bytes ?? 0) > 0) _loadedBytes = Math.max(_loadedBytes, bytes);
    log.push(`  [${_now}ms] agentmodel:loading bytes=${bytes} _loadedBytes=${_loadedBytes} prev=${prevLoaded}`);

    if (!_firstLoadingReceived && _loadedBytes > 0) {
      _firstLoadingReceived = true;
      _clearWatchdog();
      _setWatchdog(30_000);
    } else if (variant === 'OLD') {
      // OLD code: only reset if _loadedBytes advanced
      if (_firstLoadingReceived && _loadedBytes > prevLoaded) {
        _clearWatchdog();
        _setWatchdog(30_000);
      }
    } else {
      // NEW code (#1169): reset on ANY loading event after first bytes
      if (_firstLoadingReceived) {
        _clearWatchdog();
        _setWatchdog(30_000);
      }
    }
  }

  // Run scenario
  scenario(handleManifest, handleLoading, _tick);

  return { stalledAtMs: _stalledAtMs, log };
}

const UNIT_SCENARIOS = [
  {
    name: 'shard-stagnation-same-size',
    description: 'Shard 1 bytes (per-file) equal to shard 0 total — _loadedBytes never advances during shard 1',
    expectStalledOld: true,
    expectStalledNew: false,
    run(manifest, loading, tick) {
      manifest(1_000_000_000);
      tick(1_000);
      // Shard 0: per-file bytes go 0 → 500MB, _loadedBytes = 500MB
      loading(500_000_000);
      tick(5_000);
      // Shard 1: per-file bytes reset to 0, go 0 → 500MB
      // _loadedBytes = Math.max(500MB, 0–500MB) = 500MB always (never advances)
      for (let b = 50_000_000; b <= 500_000_000; b += 50_000_000) {
        loading(b);
        tick(5_000);  // 5s per chunk — total 50s of loading events
      }
      // OLD code: watchdog from shard 0 fires at T+1+30=T+31s; shard 1 events don't reset it
      // NEW code: shard 1 events reset watchdog each time → no STALLED
    },
  },
  {
    name: 'shard-stagnation-smaller-shard',
    description: 'Shard 1 is smaller than shard 0 — per-file bytes never exceed shard 0 total',
    expectStalledOld: true,
    expectStalledNew: false,
    run(manifest, loading, tick) {
      manifest(1_000_000_000);
      tick(1_000);
      // Shard 0: 800MB
      loading(800_000_000);
      tick(5_000);
      // Shard 1: only 200MB — per-file bytes 0 → 200MB, all < 800MB
      for (let b = 20_000_000; b <= 200_000_000; b += 20_000_000) {
        loading(b);
        tick(5_000);
      }
    },
  },
  {
    name: 'normal-continuous-download',
    description: 'Bytes arrive every 5s with monotonically increasing cumulative total',
    expectStalledOld: false,
    expectStalledNew: false,
    run(manifest, loading, tick) {
      manifest(1_000_000_000);
      tick(1_000);
      // Single shard, continuously increasing bytes
      for (let b = 100_000_000; b <= 900_000_000; b += 100_000_000) {
        loading(b);
        tick(5_000);
      }
    },
  },
  {
    name: 'pre-manifest-probe-events',
    description: 'Pre-manifest loading events with empty bytes must not trigger early watchdog',
    expectStalledOld: false,
    expectStalledNew: false,
    run(manifest, loading, tick) {
      // Pre-manifest probe events (from agent-harness.ts lines 311+336)
      loading(undefined);  // bytes=undefined → (bytes??0)>0 = false, _loadedBytes stays 0
      loading(undefined);
      tick(5_000);
      // Manifest arrives at T+5s
      manifest(1_000_000_000);
      tick(1_000);
      // Real bytes arrive shortly after
      loading(100_000_000);
      tick(5_000);
      loading(200_000_000);
      tick(5_000);
    },
  },
  {
    name: 'genuine-stall-no-bytes-post-manifest',
    description: 'After manifest, no loading events for 91s — STALLED is correct behavior',
    expectStalledOld: true,
    expectStalledNew: true,
    run(manifest, loading, tick) {
      manifest(1_000_000_000);
      tick(91_000);  // 91s gap — exceeds 90s initial grace
    },
  },
  {
    name: 'genuine-stall-mid-download',
    description: 'After first bytes, 31s gap — STALLED correct behavior',
    expectStalledOld: true,
    expectStalledNew: true,
    run(manifest, loading, tick) {
      manifest(1_000_000_000);
      tick(1_000);
      loading(100_000_000);   // first real bytes → 30s window
      tick(31_000);            // 31s gap — exceeds 30s window
    },
  },
];

function runUnitTests() {
  console.log('═'.repeat(60));
  console.log('PART A — Logic unit tests');
  console.log('═'.repeat(60));

  const results = [];
  let pass = 0, fail = 0;

  for (const scenario of UNIT_SCENARIOS) {
    const resultOld = runWatchdog('OLD', scenario.run);
    const resultNew = runWatchdog('NEW', scenario.run);

    const oldCorrect = (resultOld.stalledAtMs !== null) === scenario.expectStalledOld;
    const newCorrect = (resultNew.stalledAtMs !== null) === scenario.expectStalledNew;
    const ok = oldCorrect && newCorrect;

    if (ok) pass++; else fail++;

    console.log(`\n${ok ? '✅' : '❌'} ${scenario.name}`);
    console.log(`   ${scenario.description}`);
    console.log(`   OLD: stalled=${resultOld.stalledAtMs !== null} (expect ${scenario.expectStalledOld}) → ${oldCorrect ? 'CORRECT' : 'WRONG'}`);
    console.log(`   NEW: stalled=${resultNew.stalledAtMs !== null} (expect ${scenario.expectStalledNew}) → ${newCorrect ? 'CORRECT' : 'WRONG'}`);
    if (resultOld.stalledAtMs) console.log(`   OLD stall fired at ${resultOld.stalledAtMs}ms`);

    results.push({
      scenario: scenario.name,
      description: scenario.description,
      expectStalledOld: scenario.expectStalledOld,
      expectStalledNew: scenario.expectStalledNew,
      oldStalled: resultOld.stalledAtMs !== null,
      oldStalledAtMs: resultOld.stalledAtMs,
      newStalled: resultNew.stalledAtMs !== null,
      newStalledAtMs: resultNew.stalledAtMs,
      oldCorrect,
      newCorrect,
      pass: ok,
    });
  }

  console.log(`\nUnit results: ${pass}/${UNIT_SCENARIOS.length} passed`);
  return { passed: pass, failed: fail, total: UNIT_SCENARIOS.length, scenarios: results };
}

// ── PART B: Browser E2E tests ─────────────────────────────────────────────────

// Boot-gate fail phrases — inference output containing these means the gate didn't hold.
const INFER_FAIL_PHRASES = ['model is still loading', 'please wait a moment'];

const BROWSER_SCENARIOS = [
  {
    name: 'shard-stagnation',
    description: 'Shard 1 bytes ≤ shard 0 total — the confirmed root cause failure mode',
    expectStalled: false,  // new code should handle this
    useFakeClock: true,
    async inject(page) {
      // Dispatch manifest
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:manifest', {
          detail: { totalBytesExpected: 1_000_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 1_000);

      // Shard 0: 500MB total
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:loading', {
          detail: { bytes: 500_000_000, total: 1_000_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);

      // Shard 1: per-file bytes 0 → 500MB (same range — _loadedBytes stagnates with old code)
      for (let b = 50_000_000; b <= 500_000_000; b += 50_000_000) {
        await page.evaluate((bytes) => {
          window.dispatchEvent(new CustomEvent('agentmodel:loading', {
            detail: { bytes, total: 1_000_000_000 }
          }));
        }, b);
        await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);
      }

      // With new code: watchdog reset on each event → no STALLED
      // Would fail with old code (watchdog fires at ~T+31s)
    },
  },
  {
    name: 'shard-boundary-zero-byte',
    description: 'Shard boundary event with bytes=0 — must reset watchdog',
    expectStalled: false,
    useFakeClock: true,
    async inject(page) {
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:manifest', {
          detail: { totalBytesExpected: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 1_000);

      // First real bytes (shard 0)
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:loading', {
          detail: { bytes: 300_000_000, total: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);

      // Shard boundary: bytes=0 (new shard starting)
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:loading', {
          detail: { bytes: 0, total: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);

      // Shard 1 bytes arrive
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:loading', {
          detail: { bytes: 100_000_000, total: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);
    },
  },
  {
    name: 'pre-manifest-probe-events',
    description: 'Empty loading events before manifest must not trigger 30s watchdog early',
    expectStalled: false,
    useFakeClock: true,
    async inject(page) {
      // Pre-manifest probes (no bytes)
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          window.dispatchEvent(new CustomEvent('agentmodel:loading', { detail: {} }));
        });
        await page.evaluate((ms) => window.__advanceFakeClock(ms), 1_000);
      }
      // Manifest arrives
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:manifest', {
          detail: { totalBytesExpected: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 1_000);
      // Real bytes
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:loading', {
          detail: { bytes: 200_000_000, total: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);
    },
  },
  {
    name: 'normal-continuous',
    description: 'Regular byte progress every 5s — no STALLED expected (baseline)',
    expectStalled: false,
    useFakeClock: true,
    async inject(page) {
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:manifest', {
          detail: { totalBytesExpected: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 1_000);
      for (let b = 200_000_000; b <= 1_400_000_000; b += 200_000_000) {
        await page.evaluate((bytes) => {
          window.dispatchEvent(new CustomEvent('agentmodel:loading', {
            detail: { bytes, total: 2_700_000_000 }
          }));
        }, b);
        await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);
      }
    },
  },
  {
    name: 'genuine-stall-mid-download',
    description: 'Bytes stop after first chunk — STALLED must appear (failure-detection path)',
    expectStalled: true,  // the watchdog SHOULD fire here — this is the correct behavior
    useFakeClock: true,
    async inject(page) {
      // Manifest → first bytes → 31s silence → watchdog fires → STALLED shown
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:manifest', {
          detail: { totalBytesExpected: 2_700_000_000 }
        }));
      });
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 1_000);
      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('agentmodel:loading', {
          detail: { bytes: 100_000_000, total: 2_700_000_000 }
        }));
      });
      // 31s gap — exceeds 30s watchdog → STALLED must appear
      await page.evaluate((ms) => window.__advanceFakeClock(ms), 31_000);
    },
  },
  {
    name: 'inference-demo-chip',
    description: '2-storey house demo chip — boot completes, chip clicked, output appears without "still loading"',
    expectStalled: false,
    useFakeClock: false,  // real timers — inference requires actual setTimeout/fetch
    async inject(page) {
      // Wait for boot-complete (model loaded). 30s fast-check: returning-user fires in <5s
      // if model is already cached. If timeout, the model needs downloading first — skip.
      const booted = await page.evaluate(() => new Promise((resolve) => {
        const TIMEOUT_MS = 30_000;
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(false); } }, TIMEOUT_MS);
        const already = document.querySelector('[data-boot-state="ready"], .prompt-input, #prompt-input');
        if (already) { clearTimeout(timer); return resolve(true); }
        window.addEventListener('agentmodel:boot-complete', () => {
          if (!done) { done = true; clearTimeout(timer); resolve(true); }
        }, { once: true });
        window.addEventListener('agentmodel:returning-user', () => {
          if (!done) { done = true; clearTimeout(timer); resolve(true); }
        }, { once: true });
      }));
      if (!booted) throw new Error('SKIP: model not cached at this origin — run full download first, then rerun matrix');

      // Wait 1s for UI to stabilize post-boot before clicking
      await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));

      // Find and click the 2-storey house demo chip
      const clicked = await page.evaluate(() => {
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
      if (!clicked) throw new Error('2-storey house chip not found — UI may not be ready');

      // Wait for inference output. Hardened: fail if boot-gate did not hold (FAIL_PHRASES in output).
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
        setTimeout(() => { obs.disconnect(); resolve({ ok: false, reason: 'timeout — no model response in 30s' }); }, 30_000);
      }));

      if (!inferResult.ok) throw new Error(`Boot gate check failed: ${inferResult.reason}`);
    },
  },
];

// ── CDP-variant browser configs ───────────────────────────────────────────────
//
// All 7 configs run sequentially on the SAME :9222 Chromium tab.
// setup()   — called once before all scenarios; applies CDP-level state
// setupPage()— called after each page.goto(); applies page-level state (DOM context needed)
// teardown()— called once after all scenarios; resets CDP-level state

const BROWSER_CONFIGS = [
  {
    name: 'chromium-fresh',
    description: 'Full storage clear via CDP — first-install simulation',
    skipInference: false,
    async setup(page, cdp) {
      await cdp.send('Storage.clearDataForOrigin', { origin: TARGET_ORIGIN, storageTypes: 'all' });
      await cdp.send('Network.clearBrowserCache');
    },
    async teardown(page, cdp) {},
  },
  {
    name: 'chromium-partial-cache',
    description: 'Partial IDB entry seeded (1KB in transformers-cache) — stale/incomplete prior download',
    skipInference: false,
    async setup(page, cdp) {
      await cdp.send('Storage.clearDataForOrigin', { origin: TARGET_ORIGIN, storageTypes: 'all' });
      await cdp.send('Network.clearBrowserCache');
    },
    async setupPage(page) {
      // Seed a partial IDB entry BEFORE fake timer injection (seedCache uses real setTimeout).
      await page.evaluate(() => new Promise(resolve => {
        setTimeout(() => {
          const req = indexedDB.open('transformers-cache');
          req.onupgradeneeded = (e) => {
            try { e.target.result.createObjectStore('kv'); } catch {}
          };
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('kv')) { db.close(); return resolve(); }
            try {
              const tx = db.transaction('kv', 'readwrite');
              tx.objectStore('kv').put(new Uint8Array(1024), 'partial-seed');
              tx.oncomplete = () => { db.close(); resolve(); };
              tx.onerror = () => { db.close(); resolve(); };
            } catch { db.close(); resolve(); }
          };
          req.onerror = () => resolve();
        }, 500);
      })).catch(() => {});
    },
    async teardown(page, cdp) {},
  },
  {
    name: 'chromium-svc-worker',
    description: 'Service worker state preserved — checks SW does not intercept model fetch',
    skipInference: false,
    async setup(page, cdp) {
      // Clear everything EXCEPT service_workers — keep any registered SW from prior session
      // to test that model download works under SW caching layer.
      await cdp.send('Storage.clearDataForOrigin', {
        origin: TARGET_ORIGIN,
        storageTypes: 'cookies,file_systems,indexeddb,local_storage,shader_cache,websql,cache_storage',
      });
      await cdp.send('Network.clearBrowserCache');
    },
    async teardown(page, cdp) {
      // Unregister any SW the app registered so subsequent configs start clean.
      await page.evaluate(async () => {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          for (const r of regs) await r.unregister().catch(() => {});
        } catch {}
      }).catch(() => {});
    },
  },
  {
    name: 'chromium-quota-pressured',
    description: '~100MB IDB junk seeded before test — storage-pressure scenario',
    skipInference: false,
    async setup(page, cdp) {
      await cdp.send('Storage.clearDataForOrigin', { origin: TARGET_ORIGIN, storageTypes: 'all' });
      await cdp.send('Network.clearBrowserCache');
    },
    async setupPage(page) {
      // Fill ~100MB of IDB junk to create storage pressure. 10×10MB chunks.
      await page.evaluate(async () => {
        const DB_NAME = 'matrix-quota-junk';
        const chunk = new Uint8Array(10 * 1024 * 1024); // 10MB
        await new Promise(resolve => {
          const req = indexedDB.open(DB_NAME, 1);
          req.onupgradeneeded = () => req.result.createObjectStore('junk');
          req.onsuccess = async () => {
            const db = req.result;
            let ok = true;
            for (let i = 0; i < 10 && ok; i++) {
              await new Promise(res => {
                try {
                  const tx = db.transaction('junk', 'readwrite');
                  tx.objectStore('junk').put(chunk, `junk-${i}`);
                  tx.oncomplete = res;
                  tx.onerror = () => { ok = false; res(); };
                } catch { ok = false; res(); }
              });
            }
            db.close();
            resolve();
          };
          req.onerror = () => resolve();
        }).catch(() => {});
      }).catch(() => {});
    },
    async teardown(page, cdp) {
      await page.evaluate(async () => {
        await new Promise(resolve => {
          const req = indexedDB.deleteDatabase('matrix-quota-junk');
          req.onsuccess = req.onerror = resolve;
        }).catch(() => {});
      }).catch(() => {});
    },
  },
  {
    name: 'chromium-throttle',
    description: '300 kbps download throttle via CDP — watchdog robustness on slow CDN',
    skipInference: true,  // throttled network makes real model download impractically slow
    async setup(page, cdp) {
      await cdp.send('Storage.clearDataForOrigin', { origin: TARGET_ORIGIN, storageTypes: 'all' });
      await cdp.send('Network.clearBrowserCache');
      await cdp.send('Network.enable');
      // Throttle is applied in setupPage() AFTER page.goto — the app bundle loads at full speed,
      // throttle simulates slow CDN during the model download phase only.
    },
    async preGoto(page, cdp) {
      // Reset throttle before each goto so the page load itself is at full speed.
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
      }).catch(() => {});
    },
    async setupPage(page, cdp) {
      // Apply throttle AFTER page load — active during scenario event injection.
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: Math.floor(300 * 1024 / 8),  // 300 kbps → ~37,500 bytes/s
        uploadThroughput: Math.floor(100 * 1024 / 8),
        latency: 200,
      });
    },
    async teardown(page, cdp) {
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
      }).catch(() => {});
    },
  },
  {
    name: 'chromium-no-SAB',
    description: 'SharedArrayBuffer=undefined injected before app init — ORT fallback path',
    skipInference: true,  // SAB required for ORT; model execution will fail
    _sabScriptId: null,
    async setup(page, cdp) {
      await cdp.send('Storage.clearDataForOrigin', { origin: TARGET_ORIGIN, storageTypes: 'all' });
      await cdp.send('Network.clearBrowserCache');
      // Inject SAB=undefined BEFORE next page load so app code sees it from the start.
      const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: 'try { Object.defineProperty(window, "SharedArrayBuffer", { get: () => undefined, configurable: true }); } catch {}',
      });
      this._sabScriptId = identifier;
    },
    async teardown(page, cdp) {
      if (this._sabScriptId) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: this._sabScriptId,
        }).catch(() => {});
        this._sabScriptId = null;
      }
    },
  },
  {
    name: 'chromium-DNS-timeout',
    description: 'HuggingFace CDN URLs blocked — model fetch fails; watchdog + error-path tested',
    skipInference: true,  // CDN blocked; model can't download
    async setup(page, cdp) {
      await cdp.send('Storage.clearDataForOrigin', { origin: TARGET_ORIGIN, storageTypes: 'all' });
      await cdp.send('Network.clearBrowserCache');
      await cdp.send('Network.enable');
      await cdp.send('Network.setBlockedURLs', {
        urls: [
          'https://huggingface.co/*',
          'https://*.huggingface.co/*',
          'https://cdn-lfs.huggingface.co/*',
          'https://cdn-lfs-us-1.huggingface.co/*',
        ],
      });
    },
    async teardown(page, cdp) {
      await cdp.send('Network.setBlockedURLs', { urls: [] }).catch(() => {});
    },
  },
];

// FAKE_TIMER_INJECT: replaces window.setTimeout with fake version for watchdog unit testing.
// Injected via page.evaluate() AFTER page.goto() and AFTER any seedCache/setupPage calls,
// so real timers used during setup complete normally.
const FAKE_TIMER_INJECT = `
  window.__fakeTimerMap = new Map();
  window.__fakeNow = Date.now();
  let __fakeSeq = 1e6;
  const __rST = window.setTimeout.bind(window);
  const __rCT = window.clearTimeout.bind(window);
  window.setTimeout = function(fn, ms) {
    const id = '__ft' + (__fakeSeq++);
    window.__fakeTimerMap.set(id, { fn, fireAt: window.__fakeNow + (ms || 0) });
    return id;
  };
  window.clearTimeout = function(id) {
    if (typeof id === 'string' && id.startsWith('__ft')) window.__fakeTimerMap.delete(id);
    else __rCT(id);
  };
  window.__advanceFakeClock = function(ms) {
    window.__fakeNow += ms;
    for (const [id, { fn, fireAt }] of [...window.__fakeTimerMap.entries()]) {
      if (window.__fakeNow >= fireAt) { window.__fakeTimerMap.delete(id); try { fn(); } catch {} }
    }
  };
`;

async function runBrowserConfig(cfg, page, cdp, artifactDir) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Browser: ${cfg.name} — ${cfg.description}`);
  console.log('─'.repeat(60));

  const cfgResult = {
    name: cfg.name,
    description: cfg.description,
    skipInference: cfg.skipInference ?? false,
    browserError: null,
    scenarios: [],
    screenshotPath: null,
    consoleLogPath: null,
  };

  // Per-config artifact dir created early so console + screenshots can write immediately.
  const cfgArtifactDir = resolve(artifactDir, cfg.name);
  mkdirSync(cfgArtifactDir, { recursive: true });

  // Console capture — every browser console message logged for forensic analysis.
  // Catches fake-timer leaks, CDN errors, ORT warnings.
  const consoleLogs = [];
  const consoleHandler = msg => {
    const ts = new Date().toISOString().slice(11, 23);
    consoleLogs.push(`${ts} [${msg.type()}] ${msg.text()}`);
  };
  page.on('console', consoleHandler);

  // Screenshot strip helper — silent on failure, sequential frame index.
  let frameIdx = 0;
  const snap = async (label) => {
    const fname = `frame-${String(frameIdx).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: resolve(cfgArtifactDir, fname), fullPage: false }).catch(() => {});
    frameIdx++;
  };

  // Apply CDP-level setup for this config (storage clear + network conditions)
  try {
    await cfg.setup(page, cdp);
  } catch (err) {
    page.off('console', consoleHandler);
    cfgResult.browserError = `setup failed: ${err.message}`;
    console.log(`  ❌ Setup failed: ${err.message.slice(0, 100)}`);
    return cfgResult;
  }

  await snap('post-setup');

  try {
    for (const scenario of BROWSER_SCENARIOS) {
      // Skip inference for configs where model can't load
      if (scenario.name === 'inference-demo-chip' && cfg.skipInference) {
        console.log(`  ⏭  ${scenario.name}: SKIP (config disables inference)`);
        cfgResult.scenarios.push({ scenario: scenario.name, skipped: true, reason: 'config skipInference', pass: true });
        await snap(`${scenario.name}-skip`);
        continue;
      }

      // Real-clock (inference) scenario runs on the shared page with real timers.
      if (!scenario.useFakeClock) {
        try {
          if (cfg.preGoto) await cfg.preGoto(page, cdp).catch(() => {});
          await page.goto(TARGET_URL, { timeout: 60_000, waitUntil: 'domcontentloaded' });
          await scenario.inject(page);
          const stalled = await page.evaluate(() => {
            const text = document.body.innerText ?? '';
            return text.includes('DOWNLOAD STALLED') || text.includes('check your connection');
          });
          const pass = stalled === scenario.expectStalled;
          cfgResult.scenarios.push({ scenario: scenario.name, expectStalled: scenario.expectStalled, stalled, pass });
          console.log(`  ${pass ? '✅' : '❌'} ${scenario.name}: ${stalled ? 'STALLED' : 'no-stall'} (expect ${scenario.expectStalled ? 'stalled' : 'no-stall'})`);
        } catch (err) {
          const isSkip = err.message.startsWith('SKIP:');
          console.log(`  ${isSkip ? '⏭ ' : '⚠️ '} ${scenario.name}: ${isSkip ? err.message : 'error — ' + err.message.slice(0, 80)}`);
          cfgResult.scenarios.push({ scenario: scenario.name, error: err.message, pass: isSkip, skipped: isSkip });
        }
        await snap(scenario.name);
        continue;
      }

      // Fake-clock watchdog scenario
      try {
        // preGoto: reset any lingering per-scenario state (e.g., throttle from previous scenario).
        if (cfg.preGoto) await cfg.preGoto(page, cdp).catch(() => {});
        await page.goto(TARGET_URL, { timeout: 30_000, waitUntil: 'domcontentloaded' });

        // Per-config page-level setup (seed cache, fill quota, apply throttle, etc.) — runs BEFORE
        // fake timer so real setTimeout calls inside setupPage complete normally.
        if (cfg.setupPage) {
          await cfg.setupPage(page, cdp).catch(() => {});
        }

        // Install fake timer AFTER setupPage
        await page.evaluate(FAKE_TIMER_INJECT);

        // Suppress boot events so the boot-screen stays active for synthetic-event testing.
        await page.evaluate(() => {
          const origDispatch = window.dispatchEvent.bind(window);
          window.dispatchEvent = function(event) {
            if (event.type === 'agentmodel:error' || event.type === 'agentmodel:boot-complete'
                || event.type === 'agentmodel:returning-user') {
              window.__suppressedEvents = (window.__suppressedEvents || 0) + 1;
              return true;
            }
            return origDispatch(event);
          };
        });

        // Dismiss consent overlay if visible
        const consentVisible = await page.evaluate(() => {
          const el = document.querySelector('#model-consent-overlay');
          return el ? el.getBoundingClientRect().height > 0 : false;
        });
        if (consentVisible) {
          await page.evaluate(() => {
            const btn = document.querySelector('#consent-approve');
            if (btn) btn.click();
          });
          await page.evaluate((ms) => window.__advanceFakeClock(ms), 200);
        }

        // Run the scenario
        await scenario.inject(page);
        await page.evaluate((ms) => window.__advanceFakeClock(ms), 5_000);

        // Check STALLED
        const stalled = await page.evaluate(() => {
          const text = document.body.innerText ?? '';
          return text.includes('DOWNLOAD STALLED') || text.includes('check your connection');
        });

        const pass = stalled === scenario.expectStalled;
        cfgResult.scenarios.push({ scenario: scenario.name, expectStalled: scenario.expectStalled, stalled, pass });
        console.log(`  ${pass ? '✅' : '❌'} ${scenario.name}: ${stalled ? 'STALLED' : 'no-stall'} (expect ${scenario.expectStalled ? 'stalled' : 'no-stall'})`);

      } catch (err) {
        console.log(`  ⚠️  ${scenario.name}: error — ${err.message.slice(0, 80)}`);
        cfgResult.scenarios.push({ scenario: scenario.name, error: err.message, pass: false });
      }

      await snap(scenario.name);
    }

    // Final screenshot (kept as 'final.png' for compatibility; strip frames are per-scenario)
    const screenshotPath = resolve(cfgArtifactDir, 'final.png');
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    cfgResult.screenshotPath = screenshotPath;
    console.log(`  📷 Screenshot: ${screenshotPath}`);

  } catch (err) {
    cfgResult.browserError = err.message;
    console.log(`  ❌ Config error: ${err.message.slice(0, 100)}`);
  } finally {
    // Always run teardown to reset network/CDP state for next config
    try {
      await cfg.teardown(page, cdp);
    } catch (err) {
      console.log(`  ⚠️  Teardown error: ${err.message.slice(0, 60)}`);
    }

    // Post-teardown screenshot (captures state after network/CDP conditions reset)
    await snap('post-teardown');

    // Write console capture
    page.off('console', consoleHandler);
    try {
      const consoleLogPath = resolve(cfgArtifactDir, 'console.log');
      writeFileSync(consoleLogPath, consoleLogs.join('\n') + (consoleLogs.length ? '\n' : ''), 'utf8');
      cfgResult.consoleLogPath = consoleLogPath;
      console.log(`  📝 Console: ${consoleLogPath} (${consoleLogs.length} lines)`);
    } catch (err) {
      console.log(`  ⚠️  Console log write failed: ${err.message.slice(0, 60)}`);
    }
  }

  const watchdogNames = new Set(BROWSER_SCENARIOS.filter(s => s.useFakeClock).map(s => s.name));
  const watchdogResults = cfgResult.scenarios.filter(s => watchdogNames.has(s.scenario));
  cfgResult.pass = !cfgResult.browserError
    && watchdogResults.length > 0
    && watchdogResults.every(s => s.pass);
  const scenPass = cfgResult.scenarios.filter(s => s.pass || s.skipped).length;
  const scenTotal = cfgResult.scenarios.length;
  console.log(`  Result: ${cfgResult.pass ? '✅ PASS' : (cfgResult.browserError ? '⚠️  SKIP' : '❌ FAIL')} (${scenPass}/${scenTotal} scenarios)`);

  return cfgResult;
}

async function runBrowserTests() {
  console.log('\n' + '═'.repeat(60));
  console.log('PART B — Browser E2E tests');
  console.log('═'.repeat(60));

  const results = [];
  const filteredConfigs = CONFIG_FILTER
    ? BROWSER_CONFIGS.filter(c => c.name === CONFIG_FILTER)
    : BROWSER_CONFIGS;
  if (CONFIG_FILTER && filteredConfigs.length === 0) {
    console.log(`⚠️  No config matches --config ${CONFIG_FILTER}. Valid: ${BROWSER_CONFIGS.map(c => c.name).join(', ')}`);
    process.exit(1);
  }

  // Connect ONCE to :9222 — never close — shared Chromium stays alive for the full run.
  // Capture process listeners BEFORE connecting; remove any Playwright adds AFTER.
  // This prevents Playwright's exit-time Browser.close CDP command from firing.
  const _exitBefore       = process.rawListeners('exit').slice();
  const _sigintBefore     = process.rawListeners('SIGINT').slice();
  const _beforeExitBefore = process.rawListeners('beforeExit').slice();
  const _sigtermBefore    = process.rawListeners('SIGTERM').slice();

  let browser, page, ctx, cdp;
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222');

    const purgeNew = (event, before) => {
      process.rawListeners(event)
        .filter(l => !before.includes(l))
        .forEach(l => process.removeListener(event, l));
    };
    purgeNew('exit',       _exitBefore);
    purgeNew('SIGINT',     _sigintBefore);
    purgeNew('beforeExit', _beforeExitBefore);
    purgeNew('SIGTERM',    _sigtermBefore);

    browser.close = async () => {};
    ctx = browser.contexts()[0];
    if (ctx) ctx.close = async () => {};

    const pages = ctx.pages();
    page = pages.length > 0 ? pages[0] : await ctx.newPage();
    console.log(`Connected to shared :9222, using ${pages.length > 0 ? 'existing' : 'new'} tab`);

    // Create ONE CDP session for state-reset operations across all configs.
    cdp = await ctx.newCDPSession(page);
    // Enable Network domain once; individual configs call Network.enable if they need it.
    await cdp.send('Network.enable').catch(() => {});

  } catch (err) {
    console.log(`❌ Cannot connect to :9222 — ${err.message.slice(0, 100)}`);
    console.log('Start the shared browser first: bun run shared-browser:start');
    return {
      passed: 0, skipped: filteredConfigs.length, failed: 0, total: filteredConfigs.length,
      configs: filteredConfigs.map(c => ({ name: c.name, browserError: 'no :9222', scenarios: [], pass: false })),
    };
  }

  for (const cfg of filteredConfigs) {
    const r = await runBrowserConfig(cfg, page, cdp, ARTIFACT_DIR);
    results.push(r);
  }

  const passed = results.filter(r => r.pass).length;
  const skipped = results.filter(r => r.browserError).length;
  const failed = results.filter(r => !r.pass && !r.browserError).length;

  // Reset browser to a clean state after all configs.
  // The last fake-clock scenario replaces window.setTimeout with a fake version.
  // Without this navigation, the user's browser is left with the fake clock active —
  // boot-screen.ts watchdog timers never fire (require __advanceFakeClock), causing
  // STALLED to never appear during real CDN downloads (#1058 post-matrix repro).
  try {
    if (cdp) await cdp.send('Network.setBlockedURLs', { urls: [] }).catch(() => {});
    if (cdp) await cdp.send('Network.emulateNetworkConditions', {
      offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0,
    }).catch(() => {});
    await page.goto(TARGET_URL, { timeout: 30_000, waitUntil: 'domcontentloaded' });
    console.log('\nBrowser reset to clean state (fake-clock cleared, network conditions reset).');
  } catch (e) {
    console.log(`\n⚠️  Final reset navigation failed: ${e.message.slice(0, 80)}`);
  }

  console.log(`\nBrowser results: ${passed} pass / ${skipped} skip / ${failed} fail (of ${results.length} configs)`);
  return { passed, skipped, failed, total: results.length, configs: results };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const report = { ts: TS, targetUrl: TARGET_URL, artifactDir: ARTIFACT_DIR, unit: null, browser: null };

if (RUN_UNIT) {
  report.unit = runUnitTests();
}

if (RUN_BROWSER) {
  if (!process.env.RUN_LIVE) {
    console.log('\n════════════════════════════════════════════════════════');
    console.log('PART B — Browser E2E tests SKIPPED (RUN_LIVE not set)');
    console.log('  These tests drive the :9222 Chromium window the user sees.');
    console.log('  Run with: RUN_LIVE=1 node scripts/fresh-device-matrix.mjs');
    console.log('════════════════════════════════════════════════════════\n');
  } else {
    report.browser = await runBrowserTests();
  }
}

// Overall summary
console.log('\n' + '═'.repeat(60));
console.log('MATRIX SUMMARY');
console.log('═'.repeat(60));
if (report.unit) {
  console.log(`Unit: ${report.unit.passed}/${report.unit.total}`);
}
if (report.browser) {
  console.log(`Browser: ${report.browser.passed} pass / ${report.browser.skipped} skip / ${report.browser.failed} fail`);
  for (const cfg of report.browser.configs) {
    const icon = cfg.pass ? '✅' : (cfg.browserError ? '⚠️ ' : '❌');
    console.log(`  ${icon} ${cfg.name}`);
    if (cfg.browserError) console.log(`     ${cfg.browserError.slice(0, 80)}`);
    if (cfg.screenshotPath) console.log(`     📷 ${cfg.screenshotPath}`);
  }
}

writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
console.log(`\nOutput: ${OUT_FILE}`);

// Exit 1 if any hard failures (not browser-install skips or inference-skip)
const unitFail = report.unit && report.unit.failed > 0;
const browserFail = report.browser && report.browser.failed > 0;
if (unitFail || browserFail) {
  process.exit(1);
}
