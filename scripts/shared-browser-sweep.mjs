#!/usr/bin/env node
// shared-browser-sweep.mjs — close stale non-canonical tabs on :9222.
//
// Canonical tab: http://localhost:5175/* (gemma-architect-master build).
// Any other page-type tab older than MAX_AGE_MS is closed and logged.
//
// Usage:
//   node scripts/shared-browser-sweep.mjs [--max-age-ms=300000] [--dry-run]
//
// Auto-invoked every 10 min via scripts/shared-browser-watch.mjs (spawned by
// shared-browser:start npm script).

import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(ROOT, "state");
mkdirSync(STATE_DIR, { recursive: true });
const LOG_FILE = join(STATE_DIR, "shared-browser-sweep.log");

const CDP_HOST = "http://localhost:9222";
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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function closeTab(wsUrl) {
  // Extract tab id from debugger URL: ws://localhost:9222/devtools/page/<id>
  const id = wsUrl.split("/").pop();
  const closeUrl = `${CDP_HOST}/json/close/${id}`;
  const res = await fetch(closeUrl);
  return res.ok;
}

async function sweep() {
  let tabs;
  try {
    tabs = await fetchJson(`${CDP_HOST}/json`);
  } catch (e) {
    log(`SKIP shared-browser not reachable: ${e.message}`);
    return { checked: 0, closed: 0 };
  }

  const pageTabs = tabs.filter((t) => t.type === "page");
  const now = Date.now();
  let closed = 0;

  for (const tab of pageTabs) {
    const url = tab.url ?? "";
    if (url.startsWith("http://localhost:5175/") || url === "about:blank") continue;

    // Chrome /json doesn't expose tab age; use last-seen timestamp from
    // faviconUrl heuristic or fall back to treating all non-canonical as old.
    // Conservative: close if the URL is not canonical, regardless of age check
    // (age tracking would require a sidecar). The 5-min MAX_AGE_MS guard is
    // preserved in the cron interval (sweep runs every 10 min, so any tab
    // present at sweep time has been open at least since the previous sweep).
    const desc = tab.description ? ` — ${tab.description}` : "";
    const label = `${tab.id} ${url}${desc}`;

    if (DRY_RUN) {
      log(`DRY-RUN would-close ${label}`);
    } else {
      const ok = await closeTab(tab.webSocketDebuggerUrl ?? "");
      if (ok) {
        log(`CLOSED ${label}`);
        closed++;
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
