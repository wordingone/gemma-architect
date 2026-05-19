#!/usr/bin/env bash
# audit-no-gemma3-or-26b.sh — fails on any Gemma 3 / Gemma 3n / Gemma 4 26B reference
#
# Verification gate for the 2026-05-05 purge per project directive ("huge drift").
# Exits 1 on any match outside the allowlist; exits 0 clean.
#
# Allowlist (excluded from the scan):
#   web/public/samples/*.ifc — IFC GUID strings + hex color codes are false positives
#   outputs/archive-*/**     — archived contaminated artifacts
#   docs/archive/**          — archived retrospective documents
#   .git/**                  — git internals
#
# Run from repo root or anywhere; resolves $REPO from script location.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${SCRIPT_DIR}/.." && pwd)"

HITS=$(rg -i \
  --glob '!web/public/samples/*.ifc' \
  --glob '!outputs/archive-*/**' \
  --glob '!outputs/archive-*' \
  --glob '!docs/archive/**' \
  --glob '!.git/**' \
  --glob '!scripts/audit-no-gemma3-or-26b.sh' \
  'gemma-3|gemma-3n|Gemma 3|Gemma-3|26B-A4B|26b-a4b|gemma-4-26|gemma3n' \
  "$REPO" 2>/dev/null || true)

if [[ -n "$HITS" ]]; then
  echo "DRIFT REMAINS:" >&2
  echo "$HITS" >&2
  exit 1
fi

echo "audit-no-gemma3-or-26b: clean"
