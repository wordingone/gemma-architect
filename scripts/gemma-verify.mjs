#!/usr/bin/env bun
// scripts/gemma-verify.mjs — Lockfile-coordinator wrapper for gemma-verify-raw.mjs
//
// Serializes concurrent gemma-verify invocations so concurrent engineers never
// DOM-stomp each other in the shared browser:
//   1. Acquire state/gemma-verify.lock (atomic openSync wx — create-or-fail).
//   2. Poll every 2s up to 10min if held by another process.
//      Stale lock (>15min old OR holder PID dead) → take over with logged notice.
//   3. Run gemma-verify-raw.mjs as subprocess with original args.
//   4. Archive receipt to state/gemma-verify-runs/<ts>-<caller>.json.
//   5. Copy to state/gemma-verify-last.json (single canonical path for hook consumers).
//   6. Release lock on normal exit or SIGINT/SIGTERM.
//
// Usage:
//   bun scripts/gemma-verify.mjs                       # normal
//   bun scripts/gemma-verify.mjs --caller archie       # identify caller in lock JSON
//   bun scripts/gemma-verify.mjs --target-url http://localhost:5173/   # forwarded to raw
//
// Debug (no locking, no archival):
//   bun scripts/gemma-verify-raw.mjs                   # not for normal use

import { openSync, closeSync, readFileSync, writeFileSync,
         mkdirSync, unlinkSync, statSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const STATE_DIR = join(ROOT, "state");
const RUNS_DIR  = join(STATE_DIR, "gemma-verify-runs");
const LOCK_PATH = join(STATE_DIR, "gemma-verify.lock");
const LAST_PATH = join(STATE_DIR, "gemma-verify-last.json");
const RAW       = process.env.GEMMA_VERIFY_RAW_OVERRIDE ?? join(__dirname, "gemma-verify-raw.mjs");

const POLL_MS        = 2_000;
const WAIT_TIMEOUT_S = parseInt(process.env.GEMMA_VERIFY_LOCK_WAIT_S ?? "") || (10 * 60);
const STALE_S        = 15 * 60;  // 15 min → stale takeover

// ── Argument parsing ─────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const ciIdx   = argv.indexOf("--caller");
const CALLER  = ciIdx !== -1 ? argv[ciIdx + 1] : "unknown";
const RAW_ARGS = ciIdx !== -1
  ? argv.filter((_, i) => i !== ciIdx && i !== ciIdx + 1)
  : argv;

const TS = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15) + "Z";

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(RUNS_DIR,  { recursive: true });

// ── Lock primitives ──────────────────────────────────────────────────────────

function tryAcquire() {
  try {
    const fd = openSync(LOCK_PATH, "wx");
    writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      started_ts: new Date().toISOString(),
      caller: CALLER,
      host_run_id: `${Date.now()}-${process.pid}`,
    }));
    closeSync(fd);
    return true;
  } catch { return false; }
}

function readLock() {
  try { return JSON.parse(readFileSync(LOCK_PATH, "utf8")); }
  catch { return null; }
}

function isStale(lock) {
  if (!lock?.started_ts) return true;
  return (Date.now() - new Date(lock.started_ts).getTime()) > STALE_S * 1_000;
}

function isPidAlive(pid) {
  // process.kill(pid, 0) throws ESRCH (dead) or EPERM (alive, no permission).
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

function releaseLock() {
  try { unlinkSync(LOCK_PATH); } catch { /* already gone — that is fine */ }
}

// ── Acquire-or-wait ──────────────────────────────────────────────────────────

async function acquireOrWait() {
  if (tryAcquire()) return;

  const deadline = Date.now() + WAIT_TIMEOUT_S * 1_000;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    const lock = readLock();
    if (!lock) {
      if (tryAcquire()) return;
      continue;
    }
    if (isStale(lock) || !isPidAlive(lock.pid)) {
      const ageS = Math.round((Date.now() - new Date(lock.started_ts).getTime()) / 1_000);
      console.log(
        `[gemma-verify] stale/dead lock detected — pid=${lock.pid} caller=${lock.caller} age=${ageS}s — taking over`
      );
      try { unlinkSync(LOCK_PATH); } catch {}
      if (tryAcquire()) return;
    }
    // Holder alive + fresh — keep polling
  }

  const lock = readLock();
  console.error(
    `[gemma-verify] lock-wait-timeout: waited ${WAIT_TIMEOUT_S}s — holder pid=${lock?.pid} caller=${lock?.caller}`
  );
  process.exit(1);
}

// ── Signal cleanup ───────────────────────────────────────────────────────────

let locked = false;
process.on("SIGINT",  () => { if (locked) releaseLock(); process.exit(130); });
process.on("SIGTERM", () => { if (locked) releaseLock(); process.exit(143); });

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`[gemma-verify] acquiring lock (caller=${CALLER} pid=${process.pid})`);
await acquireOrWait();
locked = true;
console.log(`[gemma-verify] lock acquired`);

let exitCode = 1;
try {
  const proc = Bun.spawnSync(["bun", RAW, ...RAW_ARGS], {
    cwd: ROOT,
    stdio: ["inherit", "inherit", "inherit"],
  });
  exitCode = proc.exitCode ?? 1;

  // Find the most-recently modified SHA-named receipt in STATE_DIR.
  // The raw script writes state/gemma-verify-<sha>-<ts>.json.
  const receipts = readdirSync(STATE_DIR)
    .filter(f => /^gemma-verify-[a-f0-9]+-\d+Z\.json$/.test(f))
    .map(f => ({ f, mtime: statSync(join(STATE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (receipts.length > 0) {
    const src     = join(STATE_DIR, receipts[0].f);
    const archive = join(RUNS_DIR, `${TS}-${CALLER}.json`);
    const content = readFileSync(src);
    writeFileSync(archive, content);
    writeFileSync(LAST_PATH, content);
    console.log(`[gemma-verify] receipt archived → ${archive}`);
    console.log(`[gemma-verify] last.json updated → ${LAST_PATH}`);
  } else {
    console.warn("[gemma-verify] no receipt found to archive (raw script may have failed early)");
  }
} finally {
  releaseLock();
  locked = false;
  console.log(`[gemma-verify] lock released`);
}

process.exit(exitCode);
