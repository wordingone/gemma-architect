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
bun run verify:raw
```

The raw CDP runner (`scripts/gemma-verify-raw.mjs`) writes the same JSON as the SKILL.md skill:
```
B:/M/gemma-architect-master/state/gemma-verify-<sha>-<timestamp>.json
{ "sha": "...", "attached_via_cdp": true, "all_passed": true, "surfaces": [...] }
```

When `attached_via_cdp: true`, the JSON satisfies the gemma-verify-gate hook. The hook will also fail loud if `cdp.json` is missing (see gate behavior below).

### Canonical tab

In CDP mode the runner finds the existing tab whose URL starts with `http://localhost:5175/` and reuses it — it never opens a new tab. If no such tab exists the runner exits 2 with `BLOCKED: no canonical tab found`. The tab is never closed after the run; Jun's window and tab survive every `verify:raw` invocation. To restore a closed canonical tab, run `stop.ps1` then `start.ps1`.

---

## Driving the canonical tab — use `bun run cdp ...`

`scripts/cdp.ts` is the default path for interacting with the canonical tab. Every action goes through the app's normal pointer/keyboard pipeline — identical to a real mouse/keyboard event from Jun.

**Using `bun run cdp eval` more than once for the same action means a new subcommand should be filed.**

### Subcommand reference

```bash
bun run cdp inspect                          # scene tree + selection state (JSON, read-only)
bun run cdp click <selector>                 # PointerEvent click on CSS selector
bun run cdp click-text "<text>"              # click element by exact text content
bun run cdp click-at <x> <y>               # PointerEvent at viewport coords (relative to .vp-body)
bun run cdp key <name> [--mods ctrl,shift]  # KeyboardEvent: Delete, Escape, g, ArrowUp, etc.
bun run cdp eval "<js>"                      # arbitrary evaluate (escape hatch — file a ticket first)
bun run cdp screenshot [--out path.png]      # save canonical-tab screenshot
bun run cdp prompt "<text>"                  # type into DSL console + submit
bun run cdp select-all                       # Ctrl+A
bun run cdp delete-selected                  # Delete keystroke
```

### End-to-end example

```bash
# Delete the default wall the right way (user-path mirroring):
bun run cdp click-text "Wall"    # click-select wall in scene panel or ribbon
bun run cdp key Delete           # Delete keystroke → fires app pipeline → history records SdDelete
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | success |
| 1 | action failed (selector not found, etc.) |
| 2 | no canonical tab (start shared browser first) |

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
GEMMA_ISOLATED=1 bun run verify:raw
gh pr create ...  # gate reads GEMMA_ISOLATED and skips cdp.json check
```

---

## Jun's window is the test target

Closing the shared Chrome window kills the shared session for everyone. Don't close it manually unless running `stop.ps1`.

Agent teams (Wren/Kit/Vigil etc.) connect to the same window — their Playwright cursors are visible to Jun in real time. The `gemma-verify-cdp.ts` runner does **not** close the browser after the run; it disconnects from the CDP session, leaving the window open.
