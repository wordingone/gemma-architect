#!/usr/bin/env bash
# shared-browser-tab-guard.sh — PreToolUse hook: warn when >2 page tabs open
# before a gemma-verify run, so stale tabs don't contaminate surface results.
#
# Install (per-founder symlink or direct reference in settings.json):
#   bash B:/M/gemma-architect/scripts/shared-browser-tab-guard.sh
#
# Fires on: Bash tool calls containing "verify:raw" or "verify:cdp"
# Exits 2 (block + warn) if >MAX_TABS page tabs open on :9222.
# Exits 0 (allow) otherwise, or if shared browser is not reachable.

MAX_TABS=2
CDP_HOST="http://localhost:9222"

# Only fire on verify commands
TOOL_INPUT="${TOOL_INPUT_COMMAND:-}"
if [[ "$TOOL_INPUT" != *"verify:raw"* && "$TOOL_INPUT" != *"verify:cdp"* ]]; then
  exit 0
fi

# Check shared browser reachable
TAB_COUNT=$(curl -s --max-time 3 "${CDP_HOST}/json" 2>/dev/null \
  | python3 -c "import sys,json; tabs=json.load(sys.stdin); print(sum(1 for t in tabs if t.get('type')=='page'))" 2>/dev/null)

if [[ -z "$TAB_COUNT" ]]; then
  # Browser not reachable — let verify handle that
  exit 0
fi

if (( TAB_COUNT > MAX_TABS )); then
  echo "WARN: shared-browser has ${TAB_COUNT} page tabs open (max ${MAX_TABS})." >&2
  echo "Stale tabs may contaminate surface results. Run:" >&2
  echo "  node scripts/shared-browser-sweep.mjs --dry-run" >&2
  echo "  node scripts/shared-browser-sweep.mjs" >&2
  exit 2
fi

exit 0
