# Shared Browser — Lifecycle Guide

A single persistent headed Chromium window at `http://localhost:5175/` serves as the common visual target for Jun, Eli, Leo, and Eli's agent teams (Wren/Vigil/Kit/Faye/Quinn/Hart/Aria). When any agent runs gemma-verify, Jun sees cursor movement in this window in real time.

Per Jun directive 2026-05-06.

---

## Start

```powershell
bun run shared-browser:start
# or directly:
powershell -File scripts/shared-browser/start.ps1
```

**Idempotent.** If Chrome is already listening on port 9222, the script reads the websocket endpoint, refreshes `cdp.json`, and exits without spawning a second instance.

After start, verify:

```bash
curl http://localhost:9222/json/version
# expect: { "Browser": "Chrome/147...", "webSocketDebuggerUrl": "ws://..." }
cat B:/M/gemma-architect-master/.shared-browser/cdp.json
# expect: { "endpoint": "ws://...", "started_at": "...", "pid": <int> }
```

---

## Stop

```powershell
bun run shared-browser:stop
# or directly:
powershell -File scripts/shared-browser/stop.ps1
```

Kills Chrome by PID (read from `cdp.json`), removes `cdp.json`. Does **not** touch the profile directory.

**Do not stop between vite restarts.** The browser survives server restarts; just refresh the page inside it.

---

## Verify it's up

```bash
# Quick check — should return 200 with Browser field
curl -s http://localhost:9222/json/version | python -c "import json,sys; d=json.load(sys.stdin); print('OK:', d['Browser'])"

# cdp.json should exist with a live PID
python -c "
import json, subprocess, sys
d = json.load(open('B:/M/gemma-architect-master/.shared-browser/cdp.json'))
pid = d['pid']
print('endpoint:', d['endpoint'])
result = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/NH'], capture_output=True, text=True)
print('process alive:', str(pid) in result.stdout)
"
```

---

## Run gemma-verify against the shared window

```bash
bun run verify:cdp
# or with --isolated flag to force a fresh browser (CI mode, skips CDP):
bun run verify:cdp -- --isolated
```

The CDP runner (`scripts/gemma-verify-cdp.ts`) writes the same JSON as the SKILL.md skill:
```
B:/M/gemma-architect-master/state/gemma-verify-<sha>-<timestamp>.json
{ "sha": "...", "attached_via_cdp": true, "all_passed": true, "surfaces": [...] }
```

When `attached_via_cdp: true`, the JSON satisfies the gemma-verify-gate hook. The hook will also fail loud if `cdp.json` is missing (see gate behavior below).

### Canonical tab

In CDP mode the runner finds the existing tab whose URL starts with `http://localhost:5175/` and reuses it — it never opens a new tab. If no such tab exists the runner exits 2 with `BLOCKED: no canonical tab found`. The tab is never closed after the run; Jun's window and tab survive every `verify:cdp` invocation. To restore a closed canonical tab, run `stop.ps1` then `start.ps1`.

---

## Restart cleanly

```powershell
powershell -File scripts/shared-browser/stop.ps1
powershell -File scripts/shared-browser/start.ps1
```

The persistent profile at `B:\M\gemma-architect-master\.shared-browser\profile` survives restarts — cookies, localStorage (theme, console-mode, scene state) are preserved.

---

## What survives restarts

| Item | Survives stop/start? |
|------|---------------------|
| Profile (cookies, localStorage) | Yes — `--user-data-dir` is persistent |
| Open tabs | No — Chrome closes; start.ps1 opens a fresh tab at :5175 |
| Page state (scene objects, tools active) | No — fresh page load |

---

## Gate behavior (`gemma-verify-gate.sh`)

The `gemma-verify-gate.sh` PreToolUse hook blocks `gh pr create` and `gh pr merge` against gemma-architect if `cdp.json` is missing. This prevents an isolated browser run from silently replacing the shared-window evidence.

To run a PR gate in CI (no shared window):
```bash
GEMMA_ISOLATED=1 bun run verify:cdp -- --isolated
gh pr create ...  # gate reads GEMMA_ISOLATED and skips cdp.json check
```

---

## Jun's window is the test target

Closing the shared Chrome window kills the shared session for everyone. Don't close it manually unless running `stop.ps1`.

Agent teams (Wren/Kit/Vigil etc.) connect to the same window — their Playwright cursors are visible to Jun in real time. The `gemma-verify-cdp.ts` runner does **not** close the browser after the run; it disconnects from the CDP session, leaving the window open.
