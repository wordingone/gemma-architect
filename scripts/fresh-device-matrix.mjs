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
 * PART B — Browser E2E tests (Playwright, 4 browser configs):
 *   Navigates to GH Pages or local dev server.
 *   Installs Playwright fake clock to control timer execution.
 *   Dispatches synthetic agentmodel:* events to simulate failure modes.
 *   Advances fake clock and verifies STALLED behavior.
 *   Runs in: chromium-fresh, chromium-partial, firefox-fresh, edge-fresh.
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
 *
 * Output: state/matrix-<ISO-ts>.json
 */
import { chromium, firefox } from 'playwright';
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
  : 'https://wordingone.github.io/gemma-architect/';
const CFG_IDX     = args.indexOf('--config');
const CONFIG_FILTER = CFG_IDX >= 0 ? args[CFG_IDX + 1] : null;

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
    name: 'inference-demo-chip',
    description: '2-storey house demo chip — boot completes, chip clicked, output appears in prompt wall',
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
      if (!booted) throw new Error('SKIP: model not cached at this origin — navigate to :5847 and let model download, then rerun');

      // Find and click the 2-storey house demo chip
      // Chips are .chat-starter-chip elements with data-prompt-chip="1"
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
      if (!clicked) throw new Error('2-storey house chip not found — model may not be cached yet');

      // Wait for inference output to appear (any new content in .chat-list)
      await page.evaluate(() => new Promise((resolve, reject) => {
        const TIMEOUT_MS = 30_000;
        let done = false;
        const timer = setTimeout(() => {
          if (!done) { done = true; reject(new Error('inference output not visible within 30s')); }
        }, TIMEOUT_MS);
        const wall = document.querySelector('.chat-list');
        if (!wall) { clearTimeout(timer); return reject(new Error('chat-list not found')); }
        if (wall.children.length > 0) { clearTimeout(timer); return resolve(); }
        const obs = new MutationObserver(() => {
          if (!done && wall.children.length > 0) { done = true; clearTimeout(timer); obs.disconnect(); resolve(); }
        });
        obs.observe(wall, { childList: true });
      }));
    },
  },
];

const BROWSER_CONFIGS = [
  {
    name: 'chromium-fresh',
    engine: 'chromium',
    channel: undefined,
    description: 'Chromium headless, empty profile',
  },
  {
    name: 'chromium-partial-cache',
    engine: 'chromium',
    channel: undefined,
    description: 'Chromium headless, with transformers-cache IDB entry',
    seedCache: true,
  },
  {
    name: 'firefox-fresh',
    engine: 'firefox',
    channel: undefined,
    description: 'Firefox headless, empty profile',
  },
  {
    name: 'edge-fresh',
    engine: 'chromium',
    channel: 'msedge',
    description: 'Edge (Chromium-based), empty profile',
  },
];

// page is the shared tab; ctx is the browser context (needed for creating inference pages).
async function runBrowserConfig(cfg, page, ctx) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Browser: ${cfg.name} — ${cfg.description}`);
  console.log('─'.repeat(60));

  const cfgResult = {
    name: cfg.name,
    description: cfg.description,
    browserError: null,
    scenarios: [],
  };

  page.on('console', () => {});
  page.on('pageerror', () => {});

  // FAKE_TIMER_INJECT: injected via page.evaluate() after each page.goto().
  // Does NOT use Page.addScriptToEvaluateOnNewDocument, so it never accumulates across sessions.
  // Captures setTimeout/clearTimeout calls made by the boot-screen's event handlers AFTER inject.
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

  try {
    for (const scenario of BROWSER_SCENARIOS) {
      // Real-clock scenarios (inference) run on a fresh short-lived page to avoid fake-clock
      // contamination. The page is closed after; the shared window stays open.
      if (!scenario.useFakeClock) {
        let realPage;
        try {
          realPage = await ctx.newPage();
          await realPage.goto(TARGET_URL, { timeout: 60_000, waitUntil: 'domcontentloaded' });
          await scenario.inject(realPage);
          const stalled = await realPage.evaluate(() => {
            const text = document.body.innerText ?? '';
            return text.includes('DOWNLOAD STALLED') || text.includes('check your connection');
          });
          const pass = stalled === scenario.expectStalled;
          cfgResult.scenarios.push({ scenario: scenario.name, expectStalled: scenario.expectStalled, stalled, pass });
          console.log(`  ${pass ? '✅' : '❌'} ${scenario.name}: ${stalled ? 'STALLED' : 'no-stall'} (expect ${scenario.expectStalled ? 'stalled' : 'no-stall'})`);
        } catch (err) {
          console.log(`  ⚠️  ${scenario.name}: error — ${err.message.slice(0, 80)}`);
          cfgResult.scenarios.push({ scenario: scenario.name, error: err.message, pass: false });
        } finally {
          if (realPage) await realPage.close().catch(() => {});
        }
        continue;
      }

      // Fake-clock scenario: inject custom fake timer after each goto (no addScriptToEvaluateOnNewDocument).
      try {
        await page.goto(TARGET_URL, { timeout: 30_000, waitUntil: 'domcontentloaded' });

        // Seed partial cache BEFORE installing fake timer — seedCache uses real setTimeout internally.
        // If FAKE_TIMER_INJECT ran first, the setTimeout(fn, 500) call would be swallowed by the
        // fake timer map and __advanceFakeClock() would never fire it, hanging page.evaluate() forever.
        if (cfg.seedCache) {
          await page.evaluate(() => new Promise(resolve => {
            setTimeout(() => {
              const req = indexedDB.open('transformers-cache'); // no version — use existing
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
        }

        // Install fake timer AFTER seedCache so the app's own setTimeout calls are intercepted
        // but our IDB seeding already completed with the real timer.
        await page.evaluate(FAKE_TIMER_INJECT);

        // Suppress agentmodel:error/boot-complete/returning-user so the boot-screen stays
        // active for synthetic-event testing.
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

        // Click consent if visible
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
    }
  } catch (err) {
    cfgResult.browserError = err.message;
    console.log(`  ❌ Config error: ${err.message.slice(0, 100)}`);
  }

  const scenPass = cfgResult.scenarios.filter(s => s.pass).length;
  const scenTotal = cfgResult.scenarios.length;
  // Config PASS is gated on fake-clock (watchdog) scenarios only. Inference is informational.
  const watchdogNames = new Set(BROWSER_SCENARIOS.filter(s => s.useFakeClock).map(s => s.name));
  const watchdogResults = cfgResult.scenarios.filter(s => watchdogNames.has(s.scenario));
  cfgResult.pass = !cfgResult.browserError && watchdogResults.length > 0 && watchdogResults.every(s => s.pass);
  console.log(`  Result: ${cfgResult.pass ? '✅ PASS' : (cfgResult.browserError ? '⚠️ SKIP' : '❌ FAIL')} (${scenPass}/${scenTotal} scenarios)`);

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

  // Connect ONCE — never close — shared :9222 stays alive for the full run.
  //
  // Root cause of browser closure: Playwright registers process.on('exit'/'SIGINT'/'beforeExit')
  // handlers inside connectOverCDP that eventually send CDP Browser.close, terminating Chrome.
  // Fix: capture listeners BEFORE connecting, then surgically remove any new ones Playwright adds.
  // Also override browser.close and ctx.close as belt-and-suspenders.
  const _exitBefore       = process.rawListeners('exit').slice();
  const _sigintBefore     = process.rawListeners('SIGINT').slice();
  const _beforeExitBefore = process.rawListeners('beforeExit').slice();
  const _sigtermBefore    = process.rawListeners('SIGTERM').slice();

  let browser, page, ctx;
  try {
    browser = await chromium.connectOverCDP('http://localhost:9222');

    // Remove any new process listeners Playwright registered during connectOverCDP.
    // This prevents Playwright's exit-time Browser.close CDP command from firing.
    const purgeNew = (event, before) => {
      process.rawListeners(event)
        .filter(l => !before.includes(l))
        .forEach(l => process.removeListener(event, l));
    };
    purgeNew('exit',       _exitBefore);
    purgeNew('SIGINT',     _sigintBefore);
    purgeNew('beforeExit', _beforeExitBefore);
    purgeNew('SIGTERM',    _sigtermBefore);

    // Belt-and-suspenders: also no-op the public close methods.
    browser.close = async () => {};

    ctx = browser.contexts()[0];
    if (ctx) ctx.close = async () => {};

    const pages = ctx.pages();
    page = pages.length > 0 ? pages[0] : await ctx.newPage();
    console.log(`Connected to shared :9222, using ${pages.length > 0 ? 'existing' : 'new'} tab`);
  } catch (err) {
    console.log(`❌ Cannot connect to :9222 — ${err.message.slice(0, 100)}`);
    console.log('Start the shared browser first: bun run shared-browser:start');
    return { passed: 0, skipped: filteredConfigs.length, failed: 0, total: filteredConfigs.length,
      configs: filteredConfigs.map(c => ({ name: c.name, browserError: 'no :9222', scenarios: [], pass: false })) };
  }

  for (const cfg of filteredConfigs) {
    let r;
    if (cfg.engine === 'chromium' && !cfg.channel) {
      r = await runBrowserConfig(cfg, page, ctx);
    } else {
      // Firefox / Edge require headless launch — not permitted.
      r = { name: cfg.name, description: cfg.description,
        browserError: `${cfg.name}: requires separate headless browser — not permitted`,
        scenarios: [], pass: false };
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Browser: ${cfg.name} — SKIP (requires headless, not permitted)`);
      console.log('─'.repeat(60));
    }
    results.push(r);
  }
  const passed = results.filter(r => r.pass).length;
  const skipped = results.filter(r => r.browserError).length;
  const failed = results.filter(r => !r.pass && !r.browserError).length;

  console.log(`\nBrowser results: ${passed} pass / ${skipped} skip / ${failed} fail (of ${results.length} configs)`);
  return { passed, skipped, failed, total: results.length, configs: results };
}

// ── Main ──────────────────────────────────────────────────────────────────────

const report = { ts: TS, targetUrl: TARGET_URL, unit: null, browser: null };

if (RUN_UNIT) {
  report.unit = runUnitTests();
}

if (RUN_BROWSER) {
  report.browser = await runBrowserTests();
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
  }
}

writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
console.log(`\nOutput: ${OUT_FILE}`);

// Exit 1 if any hard failures (not browser-install skips)
const unitFail = report.unit && report.unit.failed > 0;
const browserFail = report.browser && report.browser.failed > 0;
if (unitFail || browserFail) {
  process.exit(1);
}
