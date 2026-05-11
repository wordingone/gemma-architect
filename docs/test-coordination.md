# Test Coordination — gemma-verify lockfile wrapper

## Why coordination matters

Eli and Archie can both invoke `gemma-verify-raw.mjs` — directly or via the `/gemma-verify` skill. Without coordination, two concurrent runs hit the same shared Chromium page (`:9222`) and stomp on each other's DOM state: one run loads an IFC model while the other dispatches a wall, producing false-fail signals that eat signoff cycles.

## Normal invocation: always use the wrapper

```bash
# From B:/M/gemma-architect or B:/M/gemma-architect-master:
bun scripts/gemma-verify.mjs

# Identify the caller in the lock file (useful in CI / multi-agent contexts):
bun scripts/gemma-verify.mjs --caller archie

# Forward args to the raw script:
bun scripts/gemma-verify.mjs --target-url http://localhost:5173/
```

The wrapper:
1. Acquires `state/gemma-verify.lock` (atomic `openSync wx` — create-or-fail).
2. Polls every 2 s, up to 10 min, if another process holds the lock.
3. Detects stale locks (holder PID dead OR lock age > 15 min) and takes over with a logged notice.
4. Runs `gemma-verify-raw.mjs` as a subprocess, forwarding all args.
5. Archives the receipt to `state/gemma-verify-runs/<ts>-<caller>.json`.
6. Copies it to `state/gemma-verify-last.json` — the single canonical path for hook consumers.
7. Releases the lock on normal exit, SIGINT, or SIGTERM.

## Debugging: raw script (not for normal use)

```bash
bun scripts/gemma-verify-raw.mjs
```

Use only when diagnosing wrapper failures or developing new surfaces. The raw script skips locking and archival — parallel raw runs will DOM-stomp.

## Lock file format

`state/gemma-verify.lock`:
```json
{ "pid": 12345, "started_ts": "2026-05-11T15:00:00.000Z", "caller": "eli", "host_run_id": "1715440000000-12345" }
```

Stale detection: age > 15 min OR `process.kill(pid, 0)` throws ESRCH.

## Receipt paths

| Path | Written by | Contents |
|------|-----------|---------|
| `state/gemma-verify-<sha>-<ts>.json` | raw script | Per-run surface results, `all_passed`, SHA |
| `state/gemma-verify-runs/<ts>-<caller>.json` | wrapper | Archived copy of the above, tagged with caller |
| `state/gemma-verify-last.json` | wrapper | Copy of most-recent receipt (hook consumers read this) |

## Gate hook

`B:/M/avir/eli/.claude/hooks/gemma-verify-gate.sh` blocks `gh pr create/merge` against gemma-architect-master until a SHA-matching `state/gemma-verify-<sha>-*.json` exists. Produce it by running the wrapper before opening a PR:

```bash
cd B:/M/gemma-architect-master
bun scripts/gemma-verify.mjs --caller eli
```

## Timeout behaviour

If the lock is held for > 10 min by a live process, the waiting invocation exits non-zero:

```
[gemma-verify] lock-wait-timeout: waited 600s — holder pid=<N> caller=<name>
```

Kill the stuck holder (`kill <N>`) and retry. The lock file is at `state/gemma-verify.lock`.
