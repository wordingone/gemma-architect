#!/usr/bin/env node
// gemma-master-autofwd.mjs — auto-fast-forward the gemma-architect-master serving
// tree when origin/master advances. Fixes the recurring stale-branch drift where
// Jun's :5175 window shows outdated UI (issue #239, third recurrence 2026-05-09).
//
// Design:
//   Poll origin/master every 30s. On SHA change:
//     - Branch must be "master" (serving-tree invariant)
//     - Tree must be clean (no uncommitted changes)
//   If both: `git pull --ff-only` → HMR fires automatically on :5175
//   If either fails: log SKIP reason; never touch the tree
//
// Heartbeat: state/gemma-master-autofwd.heartbeat updated on every poll.
// Log:        state/gemma-master-autofwd.log (appended, not rotated)
//
// Usage:
//   node scripts/gemma-master-autofwd.mjs           # runs until killed
//   node scripts/gemma-master-autofwd.mjs --dry-run  # log only, no pull

import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

const SERVING_DIR = "B:/M/gemma-architect-master";
const STATE_DIR   = join(SERVING_DIR, "state");
const HEARTBEAT   = join(STATE_DIR, "gemma-master-autofwd.heartbeat");
const LOG_FILE    = join(STATE_DIR, "gemma-master-autofwd.log");
const POLL_MS     = 30_000;
const DRY_RUN     = process.argv.includes("--dry-run");

mkdirSync(STATE_DIR, { recursive: true });

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `${ts()} ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

function run(cmd) {
  return spawnSync(cmd, { shell: true, cwd: SERVING_DIR, encoding: "utf8" });
}

async function poll() {
  writeFileSync(HEARTBEAT, ts());

  const remoteResult = run("git ls-remote origin master");
  if (remoteResult.status !== 0) {
    log(`SKIP ls-remote failed: ${(remoteResult.stderr ?? "").trim()}`);
    return;
  }
  const remoteSha = (remoteResult.stdout ?? "").trim().split(/\s+/)[0];
  if (!remoteSha || remoteSha.length < 7) {
    log(`SKIP empty or invalid remote SHA`);
    return;
  }

  const localResult = run("git rev-parse HEAD");
  if (localResult.status !== 0) {
    log(`SKIP rev-parse failed: ${(localResult.stderr ?? "").trim()}`);
    return;
  }
  const localSha = (localResult.stdout ?? "").trim();

  if (remoteSha === localSha) return; // already current

  const branchResult = run("git branch --show-current");
  const branch = (branchResult.stdout ?? "").trim();
  if (branch !== "master") {
    log(`SKIP-WRONG-BRANCH serving tree on '${branch}', not 'master' (local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)})`);
    return;
  }

  // Only tracked changes block the pull; untracked files are harmless for ff-only.
  const statusResult = run("git status --porcelain");
  const trackedDirty = (statusResult.stdout ?? "")
    .split("\n")
    .filter(l => l.length >= 2 && !l.startsWith("??"))
    .join("\n")
    .trim();
  if (trackedDirty) {
    log(`SKIP-DIRTY serving tree has tracked uncommitted changes (local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)})`);
    return;
  }

  const label = `local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)}`;

  if (DRY_RUN) {
    log(`DRY-RUN would-pull ${label}`);
    return;
  }

  log(`PULL ${label}`);
  run("git fetch origin");
  const pullResult = run("git pull --ff-only origin master");
  if (pullResult.status === 0) {
    log(`OK pulled to ${remoteSha.slice(0, 7)} — HMR will fire on :5175`);
  } else {
    log(`PULL-FAILED ${(pullResult.stderr ?? "").trim()}`);
  }
}

log(`gemma-master-autofwd starting${DRY_RUN ? " (dry-run)" : ""} — polling every ${POLL_MS / 1000}s`);
poll();
setInterval(poll, POLL_MS);
