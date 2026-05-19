# Secrets Scanning (gitleaks)

gemma-architect uses [gitleaks](https://github.com/gitleaks/gitleaks) for secret detection at three layers:

## Phase 1 — baseline scan (completed)

Full history scan of the public repo. Clean: no real secrets found. See PR #1149.

## Phase 2 — git-history allowlist (completed)

Added `.gitleaks.toml` with allowlist for `CONSENT_KEY = "gemma4-e4b-consent-v1"` (localStorage key constant, not a credential). Scanned 1627 commits; 0 real secrets. See PR #1150.

## Phase 3 — pre-commit hook (this PR, #1153)

Catches new secrets at commit time before they enter git history.

### Setup (required once per clone)

```sh
bun run pre-commit-setup
```

This runs `git config core.hooksPath .githooks` and marks `.githooks/pre-commit` executable. After this, every `git commit` runs:

```sh
gitleaks protect --staged --config .gitleaks.toml --no-banner
```

### Requires gitleaks binary

Download from https://github.com/gitleaks/gitleaks/releases (v8+). The hook silently skips if `gitleaks` is not on PATH — it will not block commits on machines without gitleaks installed. CI enforces as the backstop.

### Allowlisted patterns

See `.gitleaks.toml`. Currently allowlisted:

- `gemma4-e4b-consent-v1` — localStorage key name (not a credential)

## Phase 4 — CI backstop (this PR, #1153)

The `typecheck-test` CI job runs `gitleaks detect --config .gitleaks.toml` on every push/PR. This catches commits that bypassed the local hook via `git commit --no-verify`.
