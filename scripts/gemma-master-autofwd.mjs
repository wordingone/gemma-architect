#!/usr/bin/env node
// gemma-master-autofwd.mjs — auto-fast-forward the gemma-architect-master serving
// tree when origin/master advances. Fixes the recurring stale-branch drift where
// the :5847 window shows outdated UI (issue #239, third recurrence 2026-05-09).
//
// Design:
//   Poll origin/master every 30s. On SHA change:
//     - Branch must be "master" (serving-tree invariant)
//     - Tree must be clean OR dirty only with HMR-residue (content == incoming)
//   If HMR-residue: auto-stash before pull, drop stash after (#1193)
//   If real WIP (unique content): log SKIP; never touch the tree
//   If both: `git pull --ff-only` → HMR fires automatically on :5847
//
// Heartbeat: state/gemma-master-autofwd.heartbeat updated on every poll.
// Log:        state/gemma-master-autofwd.log (rotated at 10MB → .log.1)
//
// Usage:
//   node scripts/gemma-master-autofwd.mjs           # runs until killed
//   node scripts/gemma-master-autofwd.mjs --dry-run  # log only, no pull

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
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

function rotateLog(maxBytes = 10 * 1024 * 1024) {
  try {
    if (statSync(LOG_FILE).size < maxBytes) return;
    const rotated = LOG_FILE + ".1";
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(LOG_FILE, rotated);
  } catch { /* ignore — missing file is fine on first run */ }
}

function run(cmd) {
  return spawnSync(cmd, { shell: true, cwd: SERVING_DIR, encoding: "utf8" });
}

// Returns files whose working-tree content does NOT match origin/master's blob.
// Files that already match origin/master are HMR-sync residue — safe to stash.
// Mirrors safe-stash.sh blob-hash equality check (leo/scripts/safe-stash.sh).
function findUniqueContent(dirtyLines, remoteSha) {
  const unique = [];
  for (const line of dirtyLines) {
    const f = line.trim();
    if (!f) continue;
    const wtResult = run(`git hash-object -- "${f}"`);
    const wtHash = (wtResult.stdout ?? "").trim();
    const omResult = run(`git rev-parse "${remoteSha}:${f}"`);
    const omHash = (omResult.stdout ?? "").trim();
    if (!wtHash || !omHash || wtHash !== omHash) {
      unique.push(f);
    }
  }
  return unique;
}

async function poll() {
  try {
    rotateLog();
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

    if (remoteSha === localSha) {
      log(`skip: already current (${localSha.slice(0, 7)})`);
      return;
    }

    const branchResult = run("git branch --show-current");
    const branch = (branchResult.stdout ?? "").trim();
    if (branch !== "master") {
      log(`SKIP-WRONG-BRANCH serving tree on '${branch}', not 'master' (local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)})`);
      return;
    }

    // Only tracked changes block the pull; untracked files are harmless for ff-only.
    const statusResult = run("git status --porcelain");
    const dirtyLines = (statusResult.stdout ?? "")
      .split("\n")
      .filter(l => l.length >= 2 && !l.startsWith("??"))
      .map(l => l.slice(3)); // strip XY status prefix
    let stashedHmr = false;

    if (dirtyLines.length > 0) {
      // Blob-hash check: files whose working-tree content != origin/master blob are real WIP.
      // Files that already match are HMR-sync residue written by Vite — safe to auto-stash.
      const unique = findUniqueContent(dirtyLines, remoteSha);
      if (unique.length > 0) {
        log(`SKIP-DIRTY unique WIP in ${unique.length} file(s): ${unique.join(", ")} (local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)})`);
        return;
      }
      // All dirty tracked files are HMR residue — auto-stash before pull.
      log(`AUTO-STASH ${dirtyLines.length} HMR-residue file(s) before pull (local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)})`);
      if (!DRY_RUN) {
        const stashResult = run(`git stash push -m "autofwd-hmr-residue-${ts()}"`);
        if (stashResult.status !== 0) {
          log(`SKIP stash-push failed: ${(stashResult.stderr ?? "").trim()}`);
          return;
        }
        stashedHmr = true;
      }
    }

    const label = `local=${localSha.slice(0, 7)} remote=${remoteSha.slice(0, 7)}`;

    if (DRY_RUN) {
      log(`DRY-RUN would-pull ${label}${dirtyLines.length > 0 ? ` (would-auto-stash ${dirtyLines.length} HMR-residue file(s))` : ""}`);
      return;
    }

    log(`PULL ${label}`);
    run("git fetch origin");
    const pullResult = run("git pull --ff-only origin master");
    if (pullResult.status === 0) {
      log(`OK pulled to ${remoteSha.slice(0, 7)} — HMR will fire on :5847`);
      if (stashedHmr) {
        // Content already matches HEAD after pull — drop the stash (no re-apply needed).
        const dropResult = run("git stash drop");
        if (dropResult.status === 0) {
          log(`AUTO-STASH dropped (HMR residue content now matches HEAD)`);
        } else {
          log(`WARN stash-drop failed — stash left on stack: ${(dropResult.stderr ?? "").trim()}`);
        }
      }
    } else {
      log(`PULL-FAILED ${(pullResult.stderr ?? "").trim()}`);
      if (stashedHmr) {
        // Restore the stash so no work is lost.
        run("git stash pop");
        log(`AUTO-STASH restored after pull failure`);
      }
    }
  } catch (err) {
    log(`ERROR poll threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

log(`gemma-master-autofwd starting${DRY_RUN ? " (dry-run)" : ""} — polling every ${POLL_MS / 1000}s`);
poll();
setInterval(poll, POLL_MS);
