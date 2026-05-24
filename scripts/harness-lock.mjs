// harness-lock.mjs — single-flight pidfile guard for cohort/verify runners.
// Prevents concurrent runs that collide on :9222 CDP WebSocket.
//
// Usage:
//   import { acquireLock, releaseLock } from "./harness-lock.mjs";
//   const lock = await acquireLock("phase-j-verify");  // throws EBUSY if already running
//   process.on("exit", releaseLock);
//   process.on("SIGINT", () => { releaseLock(); process.exit(130); });
//   process.on("SIGTERM", () => { releaseLock(); process.exit(143); });
//   process.on("uncaughtException", (e) => { releaseLock(); throw e; });

import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";

const STATE_DIR = `${process.cwd()}/state`;
mkdirSync(STATE_DIR, { recursive: true });

let _lockFile = null;

function pidAlive(pid) {
  try {
    const out = execSync(
      `wmic process where "ProcessId=${pid}" get ProcessId /format:value 2>nul`,
      { encoding: "utf8", timeout: 5000 }
    );
    return out.includes(`${pid}`);
  } catch { return false; }
}

export async function acquireLock(name) {
  _lockFile = `${STATE_DIR}/${name}.pid`;
  if (existsSync(_lockFile)) {
    let existing;
    try { existing = JSON.parse(readFileSync(_lockFile, "utf8")); } catch { existing = null; }
    if (existing?.pid && pidAlive(existing.pid)) {
      throw new Error(
        `EBUSY: ${name} already running as PID ${existing.pid} since ${existing.startedAt}. ` +
        `Kill it first or wait for completion.`
      );
    }
    // Stale pidfile (PID dead) — overwrite and proceed.
  }
  const entry = { pid: process.pid, name, startedAt: new Date().toISOString() };
  writeFileSync(_lockFile, JSON.stringify(entry), { flag: "w" });
  return entry;
}

export function releaseLock() {
  if (_lockFile) {
    try { unlinkSync(_lockFile); } catch { /* already gone */ }
    _lockFile = null;
  }
}
