#!/usr/bin/env node
/**
 * fresh-device-e2e-proof.mjs — #1058 programmatic fresh-device E2E proof.
 *
 * Launches an isolated headless Chromium (fresh profile, no cache, no IDB),
 * navigates to GH Pages, drives the consent flow, and records timing artifacts
 * proving:
 *   1. Consent dialog appears on first visit (fresh profile = no cache)
 *   2. Clicking "Download" starts HF Hub model download
 *   3. New 90s STALLED watchdog does NOT false-fire at 60s (old threshold)
 *   4. Progress bar moves (bytes arriving from HF Hub CDN)
 *   5. [If time permits] ONNX session init + SdPlaceWall verb dispatch
 *
 * Usage: ELI_CROSS_VALIDATION=1 node scripts/fresh-device-e2e-proof.mjs
 * Output: submission/fresh-device-e2e-proof/<ISO-ts>/
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

const GH_PAGES = 'https://wordingone.github.io/gemma-architect/';
const MAX_MS   = 12 * 60 * 1000; // 12 min cap — model download won't complete, but we prove key milestones

const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
const DIR = `submission/fresh-device-e2e-proof/${TS}`;
mkdirSync(DIR, { recursive: true });

const log = [];
function emit(event, data = {}) {
  const entry = { t: Date.now(), event, ...data };
  log.push(entry);
  console.log(`[${new Date(entry.t).toISOString()}] ${event}`, data);
}

emit('script_start', { target: GH_PAGES, artifactDir: DIR });

// ── Launch ─────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const context = await browser.newContext({
  recordVideo: { dir: DIR, size: { width: 1280, height: 800 } },
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36',
});
emit('browser_launched', { headless: true, freshProfile: true });

const page = await context.newPage();
const consoleLog = [];
page.on('console', msg => {
  const entry = { t: Date.now(), type: msg.type(), text: msg.text() };
  consoleLog.push(entry);
  if (msg.type() === 'error') emit('console_error', { text: msg.text() });
});

const networkLog = [];
page.on('response', res => {
  const url = res.url();
  if (url.includes('huggingface.co') || url.includes('hf.co') || url.includes('xethub')) {
    const entry = { t: Date.now(), status: res.status(), url: url.slice(0, 120) };
    networkLog.push(entry);
    if (networkLog.length <= 5 || url.includes('.bin') || url.includes('gguf')) {
      emit('hf_response', entry);
    }
  }
});

// ── Navigate ────────────────────────────────────────────────────────────────────
emit('navigating', { url: GH_PAGES });
await page.goto(GH_PAGES, { waitUntil: 'domcontentloaded', timeout: 30_000 });
emit('dom_content_loaded');

await page.screenshot({ path: `${DIR}/01-initial-load.png` });

// ── Inject event instrumentation ────────────────────────────────────────────────
await page.evaluate(() => {
  window.__e2eProof = { events: [], t0: Date.now() };
  const trackEvent = (name, detail) => window.__e2eProof.events.push({
    name, ms: Date.now() - window.__e2eProof.t0, detail
  });
  ['agentmodel:manifest','agentmodel:loading','agentmodel:ready',
   'agentmodel:error','agentmodel:boot-complete','agentmodel:drafter:loading',
   'agentmodel:drafter:ready','agentmodel:returning-user'].forEach(ev => {
    window.addEventListener(ev, e => trackEvent(ev, {
      bytes: e.detail?.bytes, total: e.detail?.total,
      totalBytesExpected: e.detail?.totalBytesExpected,
      file: e.detail?.file,
    }));
  });
});
emit('event_instrumentation_injected');

// ── Wait for consent dialog ──────────────────────────────────────────────────────
emit('waiting_for_consent_dialog');
let consentVisible = false;
try {
  await page.waitForSelector('#model-consent-overlay', { timeout: 15_000 });
  consentVisible = true;
  emit('consent_dialog_visible');
  await page.screenshot({ path: `${DIR}/02-consent-dialog.png` });
} catch {
  // Could be returning-user path (model already cached) — check
  const hasReturningUser = await page.evaluate(() =>
    !!document.querySelector('#model-download-strip') || !!document.querySelector('.boot-screen')
  );
  emit('consent_dialog_not_found', { hasReturningUser, note: 'may be returning-user path or slow load' });
  await page.screenshot({ path: `${DIR}/02-no-consent.png` });
}

if (consentVisible) {
  // ── Verify consent dialog content ────────────────────────────────────────────
  const dialogText = await page.evaluate(() =>
    document.querySelector('#model-consent-overlay')?.textContent?.slice(0, 200)
  );
  emit('consent_dialog_text', { text: dialogText?.trim() });

  // ── Click Download ───────────────────────────────────────────────────────────
  emit('clicking_download');
  await page.click('#consent-approve');
  emit('download_clicked');
  await page.screenshot({ path: `${DIR}/03-post-consent-click.png` });
}

// ── Monitor download progress ──────────────────────────────────────────────────
const startMs = Date.now();
let manifestTs = null;
let firstByteTs = null;
let stalledAt60Detected = false;
let stalledAt90Detected = false;
let screenshotIdx = 4;
const screenshots = [];

const checkStalled = async (label) => {
  const info = await page.evaluate(() => {
    const strip = document.getElementById('model-download-strip');
    const status = document.querySelector('#model-download-strip [id="model-dl-label"]');
    const bar = document.getElementById('model-dl-bar');
    const pct = document.getElementById('model-dl-pct');
    const overlay = document.getElementById('model-consent-overlay');
    const bootScreen = document.querySelector('[id="model-download-strip"], .boot-screen');
    // Check for STALLED message in boot-screen status element
    const allText = document.body.innerText;
    const hasStalled = allText.includes('DOWNLOAD STALLED');
    const hasProgress = !!strip || !!bootScreen;
    return {
      hasStalled,
      hasProgress,
      pct: pct?.textContent,
      label: status?.textContent,
      barWidth: bar?.style.width,
      proofEvents: window.__e2eProof?.events ?? [],
    };
  });
  emit(label, {
    hasStalled: info.hasStalled,
    hasProgress: info.hasProgress,
    pct: info.pct,
    label: info.label,
    barWidth: info.barWidth,
    eventCount: info.proofEvents?.length,
  });
  if (info.hasStalled) {
    emit('STALLED_DETECTED', { label });
    screenshots.push({ label: `${label}_STALLED`, path: `${DIR}/${screenshotIdx++}-STALLED-${label}.png` });
    await page.screenshot({ path: screenshots[screenshots.length - 1].path });
  }
  return info;
};

// Poll for progress every 10s for up to MAX_MS
const POLL_INTERVAL = 10_000;
let elapsed = 0;
let manifestFired = false;
let modelReady = false;

while (elapsed < MAX_MS) {
  await new Promise(r => setTimeout(r, POLL_INTERVAL));
  elapsed = Date.now() - startMs;

  const info = await page.evaluate(() => {
    const events = window.__e2eProof?.events ?? [];
    return {
      events,
      bodyText: document.body.innerText?.slice(0, 500),
    };
  });

  const events = info.events;
  if (!manifestFired && events.some(e => e.name === 'agentmodel:manifest')) {
    manifestFired = true;
    manifestTs = elapsed;
    emit('agentmodel_manifest_fired', { elapsedMs: elapsed });
  }
  if (!firstByteTs && events.some(e => e.name === 'agentmodel:loading' && (e.detail?.bytes ?? 0) > 0)) {
    firstByteTs = elapsed;
    emit('first_byte_received', { elapsedMs: elapsed, deltaFromManifest: manifestTs ? elapsed - manifestTs : null });
  }
  if (events.some(e => e.name === 'agentmodel:ready' || e.name === 'agentmodel:boot-complete')) {
    modelReady = true;
    emit('model_ready', { elapsedMs: elapsed });
    break;
  }

  // Key milestone screenshots
  if (elapsed >= 55_000 && elapsed < 65_000 && !stalledAt60Detected) {
    stalledAt60Detected = true;
    const snap = `${DIR}/${screenshotIdx++}-T60s-no-stalled.png`;
    await page.screenshot({ path: snap });
    const info60 = await checkStalled('T60s_watchdog_check');
    emit('T60s_screenshot', { path: snap, hasStalled: info60.hasStalled });
  }
  if (elapsed >= 85_000 && elapsed < 95_000 && !stalledAt90Detected) {
    stalledAt90Detected = true;
    const snap = `${DIR}/${screenshotIdx++}-T90s-watchdog-threshold.png`;
    await page.screenshot({ path: snap });
    const info90 = await checkStalled('T90s_watchdog_threshold');
    emit('T90s_screenshot', { path: snap, hasStalled: info90.hasStalled });
  }

  // Regular progress snapshots
  if (elapsed % 60_000 < POLL_INTERVAL) {
    const snap = `${DIR}/${screenshotIdx++}-T${Math.round(elapsed/1000)}s-progress.png`;
    await page.screenshot({ path: snap });
    emit('progress_screenshot', { elapsedMs: elapsed, path: snap });
  }
}

// ── Final state ─────────────────────────────────────────────────────────────────
await page.screenshot({ path: `${DIR}/${screenshotIdx++}-final-state.png` });

// ── IDB dump ────────────────────────────────────────────────────────────────────
const idbState = await page.evaluate(async () => {
  try {
    const dbs = await indexedDB.databases();
    const result = {};
    for (const { name } of (dbs ?? [])) {
      result[name] = { present: true };
    }
    return result;
  } catch (e) { return { error: e.message }; }
});
emit('idb_state', { databases: idbState });

// ── Cache storage ────────────────────────────────────────────────────────────────
const cacheState = await page.evaluate(async () => {
  try {
    const names = await caches.keys();
    const result = {};
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      result[name] = { keyCount: keys.length, keys: keys.map(r => r.url).slice(0, 5) };
    }
    return result;
  } catch (e) { return { error: e.message }; }
});
emit('cache_state', { caches: cacheState });

// ── Agent dispatch (if model ready) ──────────────────────────────────────────────
if (modelReady) {
  emit('attempting_verb_dispatch');
  try {
    const dispatchResult = await page.evaluate(() => {
      // Try to dispatch SdPlaceWall via the global dispatch mechanism
      if (window.__dispatch) {
        window.__dispatch({ name: 'SdPlaceWall', arguments: { startX: 0, startY: 0, endX: 5, endY: 0, height: 3 } });
        return { method: '__dispatch', success: true };
      }
      // Try window events
      window.dispatchEvent(new CustomEvent('gemma:dispatch', {
        detail: { name: 'SdPlaceWall', arguments: { startX: 0, startY: 0, endX: 5, endY: 0, height: 3 } }
      }));
      return { method: 'CustomEvent', success: true };
    });
    emit('verb_dispatch_result', dispatchResult);
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: `${DIR}/${screenshotIdx++}-post-dispatch.png` });
  } catch (e) {
    emit('verb_dispatch_error', { error: e.message });
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────────
const proofEvents = await page.evaluate(() => window.__e2eProof?.events ?? []);
const summary = {
  target: GH_PAGES,
  artifactDir: DIR,
  totalElapsedMs: Date.now() - startMs,
  consentDialogVisible: consentVisible,
  manifestFiredMs: manifestTs,
  firstByteMs: firstByteTs,
  manifestToFirstByteMs: (manifestTs != null && firstByteTs != null) ? firstByteTs - manifestTs : null,
  stalledAt60sDetected: stalledAt60Detected ? 'CHECK_RESULT' : 'NOT_REACHED_YET',
  stalledAt90sDetected: stalledAt90Detected ? 'CHECK_RESULT' : 'NOT_REACHED_YET',
  modelReady,
  proofEvents: proofEvents.slice(0, 20),
  networkHfRequests: networkLog.length,
  log,
};

writeFileSync(`${DIR}/summary.json`, JSON.stringify(summary, null, 2));
writeFileSync(`${DIR}/console.json`, JSON.stringify(consoleLog, null, 2));
writeFileSync(`${DIR}/network-hf.json`, JSON.stringify(networkLog, null, 2));
writeFileSync(`${DIR}/proof-events.json`, JSON.stringify(proofEvents, null, 2));

emit('artifacts_saved', { dir: DIR });
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));

// ── Close ────────────────────────────────────────────────────────────────────────
await context.close(); // video saved here
await browser.close();
emit('done');
