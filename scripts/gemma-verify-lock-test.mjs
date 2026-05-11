#!/usr/bin/env bun
// scripts/gemma-verify-lock-test.mjs
//
// Smoke tests for gemma-verify.mjs lockfile coordinator.
// Tests 3 ACs that the happy-path run does not cover:
//   AC #2 — Parallel serialize: A holds lock, B polls, B acquires after A releases
//   AC #3 — Stale-lock takeover: dead-pid lock → log + take over
//   AC #4 — Lock-wait-timeout: live-pid lock held past GEMMA_VERIFY_LOCK_WAIT_S
//
// Usage: bun scripts/gemma-verify-lock-test.mjs
// Exit 0 = all pass. Exit 1 = one or more failures.

import { writeFileSync, readFileSync, unlinkSync,
         mkdirSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, "..");
const STATE_DIR = join(ROOT, "state");
const RUNS_DIR  = join(STATE_DIR, "gemma-verify-runs");
const LOCK_PATH = join(STATE_DIR, "gemma-verify.lock");
const LAST_PATH = join(STATE_DIR, "gemma-verify-last.json");
const WRAPPER   = join(__dirname, "gemma-verify.mjs");
const STUB_RAW  = join(__dirname, "gemma-verify-stub-test.mjs");

// ── Stub raw script ──────────────────────────────────────────────────────────
// Mimics gemma-verify-raw.mjs: creates a receipt and exits 0.
const STUB_SHA = "abc1234";
writeFileSync(STUB_RAW, `#!/usr/bin/env bun
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
const STATE_DIR = ${JSON.stringify(STATE_DIR)};
mkdirSync(STATE_DIR, { recursive: true });
const sha = ${JSON.stringify(STUB_SHA)};
const ts = new Date().toISOString().replace(/[-:.TZ]/g,"").slice(0,15) + "Z";
const outFile = join(STATE_DIR, \`gemma-verify-\${sha}-\${ts}.json\`);
writeFileSync(outFile, JSON.stringify({ sha, timestamp: ts, attached_via_cdp: true, all_passed: true, surfaces: [] }, null, 2));
console.log("stub: wrote " + outFile);
await new Promise(r => setTimeout(r, 300));
process.exit(0);
`);

// ── Helpers ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok    = (label) => { pass++; console.log(`  ✓ ${label}`); };
const notOk = (label, detail) => { fail++; console.log(`  ✗ ${label}: ${detail}`); };

function cleanup() {
  try { unlinkSync(LOCK_PATH); } catch {}
  try { unlinkSync(LAST_PATH); } catch {}
  if (existsSync(STATE_DIR)) {
    for (const f of readdirSync(STATE_DIR)) {
      if (f.startsWith(`gemma-verify-${STUB_SHA}`)) try { unlinkSync(join(STATE_DIR, f)); } catch {}
    }
  }
  if (existsSync(RUNS_DIR)) {
    for (const f of readdirSync(RUNS_DIR)) {
      if (f.includes("eli-test") || f.includes("archie-test") || f.includes("takeover-test") || f.includes("timeout-test"))
        try { unlinkSync(join(RUNS_DIR, f)); } catch {}
    }
  }
}

const BASE_ENV = { ...process.env, GEMMA_VERIFY_RAW_OVERRIDE: STUB_RAW };

const runWrapper = (args = [], extraEnv = {}) =>
  Bun.spawnSync(["bun", WRAPPER, ...args], {
    cwd: ROOT,
    env: { ...BASE_ENV, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });

// ── Test 1: Parallel serialize (AC #2) ───────────────────────────────────────
console.log("\n[1] Parallel serialize (AC #2)");
cleanup();
mkdirSync(RUNS_DIR, { recursive: true });

// A runs the stub (stub sleeps 300ms so A holds lock briefly).
// Start A async so we can launch B while A holds the lock.
const procA = Bun.spawn(["bun", WRAPPER, "--caller", "eli-test"], {
  cwd: ROOT,
  env: BASE_ENV,
  stdout: "pipe",
  stderr: "pipe",
});

// Give A time to acquire the lock before B starts.
await new Promise(r => setTimeout(r, 400));

// B launches — lock is held by A; B must poll until A releases.
const procBResult = runWrapper(["--caller", "archie-test"]);
await procA.exited;

const runFiles = existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR) : [];
const eliRun    = runFiles.find(f => f.includes("eli-test"));
const archieRun = runFiles.find(f => f.includes("archie-test"));
const lastObj   = existsSync(LAST_PATH) ? JSON.parse(readFileSync(LAST_PATH, "utf8")) : null;
const bOut      = new TextDecoder().decode(procBResult.stdout);

if (procA.exitCode === 0 && procBResult.exitCode === 0) ok("A and B both exited 0");
else notOk("exit codes", `A=${procA.exitCode} B=${procBResult.exitCode}`);

if (eliRun)    ok(`eli-test receipt archived (${eliRun})`);
else           notOk("eli-test receipt", "not found in RUNS_DIR");

if (archieRun) ok(`archie-test receipt archived (${archieRun})`);
else           notOk("archie-test receipt", "not found in RUNS_DIR");

if (lastObj?.sha === STUB_SHA) ok(`last.json sha = ${STUB_SHA}`);
else notOk("last.json sha", JSON.stringify(lastObj?.sha));

if (/acquiring lock/.test(bOut)) ok("B logged 'acquiring lock'");
else notOk("B acquiring-lock log", "(not found)");

cleanup();

// ── Test 2: Stale-lock takeover (AC #3) ─────────────────────────────────────
console.log("\n[2] Stale-lock takeover (AC #3)");
cleanup();
mkdirSync(STATE_DIR, { recursive: true });

// Write stale lock: dead PID 999999, timestamp 16 minutes ago.
const staleTs = new Date(Date.now() - 16 * 60_000).toISOString();
writeFileSync(LOCK_PATH, JSON.stringify({ pid: 999999, started_ts: staleTs, caller: "ghost", host_run_id: "ghost-0" }));

const proc2 = runWrapper(["--caller", "takeover-test"]);
const out2  = new TextDecoder().decode(proc2.stdout);

if (proc2.exitCode === 0) ok("wrapper exited 0 after stale takeover");
else notOk("exit code", String(proc2.exitCode));

if (/stale\/dead lock detected[^]*pid=999999/.test(out2)) ok("stale-takeover log matches: pid=999999");
else notOk("stale-takeover log", out2.replace(/\n/g, " ").slice(0, 250));

if (!existsSync(LOCK_PATH)) ok("lock file released after run");
else notOk("lock file released", "still exists");

cleanup();

// ── Test 3: Lock-wait-timeout (AC #4) ───────────────────────────────────────
console.log("\n[3] Lock-wait-timeout (AC #4) — GEMMA_VERIFY_LOCK_WAIT_S=4");
cleanup();
mkdirSync(STATE_DIR, { recursive: true });

// Hold the lock with a real (alive) PID and a fresh timestamp.
writeFileSync(LOCK_PATH, JSON.stringify({
  pid: process.pid,
  started_ts: new Date().toISOString(),
  caller: "holder",
  host_run_id: `holder-${Date.now()}`,
}));

const t3Start   = Date.now();
const proc3     = runWrapper(["--caller", "timeout-test"], { GEMMA_VERIFY_LOCK_WAIT_S: "4" });
const t3Elapsed = Date.now() - t3Start;
const out3      = new TextDecoder().decode(proc3.stderr) + new TextDecoder().decode(proc3.stdout);

if (proc3.exitCode === 1) ok("wrapper exited 1 on lock-wait-timeout");
else notOk("exit code", String(proc3.exitCode));

if (/lock-wait-timeout.*waited 4s/.test(out3)) ok("timeout message: 'lock-wait-timeout: waited 4s'");
else notOk("timeout message", out3.replace(/\n/g, " ").slice(0, 300));

if (t3Elapsed < 9_000) ok(`elapsed ${t3Elapsed}ms (< 9s budget)`);
else notOk("elapsed", `${t3Elapsed}ms — expected ~4s`);

// Release the lock we wrote.
try { unlinkSync(LOCK_PATH); } catch {}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} tests passed`);
try { unlinkSync(STUB_RAW); } catch {}
process.exit(fail > 0 ? 1 : 0);
