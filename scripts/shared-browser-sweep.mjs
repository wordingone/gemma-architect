#!/usr/bin/env node
// shared-browser-sweep.mjs — close stale non-canonical tabs on :9222.
//
// Canonical tab: http://localhost:5175/* (gemma-architect-master build).
// Any other page-type tab older than --max-age-ms is closed and logged.
// Tabs without a recorded first-seen time are treated as new (age=0).
//
// Age tracking: Chrome's /json API does not expose tab creation time.
// We maintain a sidecar file (state/shared-browser-tabs-seen.json) that
// maps tabId -> firstSeenMs. On each sweep: new tabs are recorded;
// tabs absent from /json are pruned; age is computed from firstSeenMs.
// about:blank tabs are skipped (used by start.ps1 as sentinel windows).
//
// Usage:
//   node scripts/shared-browser-sweep.mjs [--max-age-ms=300000] [--dry-run]
//
// Auto-invoked every 10 min via scripts/shared-browser-watch.mjs (spawned by
// shared-browser:start npm script). The cron interval IS the effective grace
// period for new tabs — a tab open at two consecutive sweeps is at least
// intervalMs old regardless of its recorded firstSeenMs.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(ROOT, "state");
mkdirSync(STATE_DIR, { recursive: true });
const LOG_FILE      = join(STATE_DIR, "shared-browser-sweep.log");
const SIDECAR_FILE  = join(STATE_DIR, "shared-browser-tabs-seen.json");

const CDP_HOST  = "http://localhost:9222";
const MAX_AGE_MS = Number(
  process.argv.find((a) => a.startsWith("--max-age-ms="))?.split("=")[1] ?? 300_000,
);
const DRY_RUN = process.argv.includes("--dry-run");

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `${ts()} ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function fmtAge(ms) {
  if (ms < 60_000)  return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function loadSidecar() {
  try {
    return JSON.parse(readFileSync(SIDECAR_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSidecar(data) {
  writeFileSync(SIDECAR_FILE, JSON.stringify(data, null, 2));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function closeTab(tab) {
  const wsUrl = tab.webSocketDebuggerUrl;
  if (!wsUrl) {
    log(`CLOSE-SKIP ${tab.id} ${tab.url} — no webSocketDebuggerUrl`);
    return false;
  }
  const id = wsUrl.split("/").pop();
  const closeUrl = `${CDP_HOST}/json/close/${id}`;
  const res = await fetch(closeUrl);
  return res.ok;
}

// Kill the vite server listening on `port`, with a guard: never kill a process
// whose CommandLine contains "--port 5175" (canonical server).
function killViteOnPort(port) {
  if (port === 5175) return false; // hard guard: never kill canonical
  try {
    const ps = `
      $conn = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;
      if (!$conn) { exit 1 }
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue;
      if (!$proc -or $proc.CommandLine -notmatch 'vite') { exit 2 }
      if ($proc.CommandLine -match '--port 5175') { exit 3 }
      Write-Output "$($proc.ProcessId):$($proc.CommandLine.Substring(0, [Math]::Min(120, $proc.CommandLine.Length)))";
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue;
      exit 0
    `;
    const out = execSync(`powershell -NoProfile -Command "${ps.replace(/\n\s*/g, ' ')}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) {
      log(`KILLED-VITE port=${port} proc=${out.split(":")[0]}`);
      return true;
    }
  } catch (e) {
    const code = e.status ?? -1;
    if (code === 1) { /* no listener on port */ }
    else if (code === 2) { /* listener is not vite */ }
    else if (code === 3) { log(`SKIP-CANONICAL-VITE port=${port} — has --port 5175`); }
    else { log(`KILL-VITE-ERR port=${port}: ${String(e.message).slice(0, 80)}`); }
  }
  return false;
}

async function sweep() {
  let tabs;
  try {
    tabs = await fetchJson(`${CDP_HOST}/json`);
  } catch (e) {
    log(`SKIP shared-browser not reachable: ${e.message}`);
    return { checked: 0, closed: 0 };
  }

  const now = Date.now();
  const pageTabs = tabs.filter((t) => t.type === "page");

  // Update sidecar: record new tabs, prune gone tabs
  const seen = loadSidecar();
  const liveIds = new Set(pageTabs.map((t) => t.id));
  for (const id of Object.keys(seen)) {
    if (!liveIds.has(id)) delete seen[id];
  }
  for (const tab of pageTabs) {
    if (!seen[tab.id]) seen[tab.id] = now;
  }
  saveSidecar(seen);

  let closed = 0;

  for (const tab of pageTabs) {
    const url = tab.url ?? "";
    if (url.startsWith("http://localhost:5175/") || url === "about:blank") continue;

    const firstSeen = seen[tab.id] ?? now;
    const ageMs = now - firstSeen;
    const ageStr = fmtAge(ageMs);

    if (ageMs < MAX_AGE_MS) {
      log(`SKIP-YOUNG ${tab.id} ${url} age=${ageStr} (threshold ${fmtAge(MAX_AGE_MS)})`);
      continue;
    }

    const label = `${tab.id} ${url} age=${ageStr}`;

    if (DRY_RUN) {
      log(`DRY-RUN would-close ${label}`);
    } else {
      const ok = await closeTab(tab);
      if (ok) {
        log(`CLOSED ${label}`);
        closed++;
        // Kill the vite server feeding this non-canonical tab.
        const portMatch = url.match(/localhost:(\d+)/);
        if (portMatch) killViteOnPort(Number(portMatch[1]));
      } else {
        log(`CLOSE-FAILED ${label}`);
      }
    }
  }

  if (closed === 0 && !DRY_RUN) {
    log(`OK no stale tabs (checked ${pageTabs.length} page-type tabs)`);
  }
  return { checked: pageTabs.length, closed };
}

sweep().then(({ checked, closed }) => {
  if (DRY_RUN) console.log(`dry-run: checked ${checked} tabs`);
  process.exit(0);
}).catch((e) => {
  log(`ERROR ${e.message}`);
  process.exit(1);
});
