# Verify Discipline

Operational rules for gemma-verify runs. All rules are BINDING as of 2026-05-11 (#504).

## Infrastructure constraints (hard)

- **ONE Chromium on `:9222`.** No worker spawns a second browser — not headless, not a second profile, not a second port. The single shared Chromium is canonical.
- **ONE vite on `:5175` from `B:/M/gemma-architect-master/`.** No worker starts a second vite on :5175 or any port without explicit user approval. `:5175` is the user's URL.
- Violations break the user's active view. There is no workaround.

## Serving-tree freeze (hard)

`B:/M/gemma-architect-master/` is **frozen** to autofwd-daemon writes only.

Workers MUST NOT:
- `git checkout` any branch in `gemma-architect-master/`
- Edit any file in `gemma-architect-master/` (including `state/surface-allowfail.txt`)
- Sync files from a feature branch into `gemma-architect-master/`
- Run any command in `gemma-architect-master/` that leaves tracked files dirty

The autofwd daemon (`#239`) is the only writer. Its sole job is `git pull` on master. If it can't run (dirty working tree), the serving tree diverges from master.

Workers iterate exclusively in `B:/M/gemma-architect/` (feature-dev) on feature branches.

## Pre-merge browser-based verify: BANNED

Pre-merge `gemma-verify-raw` against `:5175` is forbidden. The single `:5175` vite serves master HEAD from `gemma-architect-master/`. Running verify against it while a feature branch is under review:

- Contaminates the verify baseline (wrong-version testing)
- Forces the serving tree to switch branches (disrupts the user's view)
- Causes cross-worker DOM collisions when engineers verify concurrently

**The pre-merge gate is:** code-inspection + CI (typecheck-test + fixtures-validate must be green) + unit/component tests in own worktree (`bun test web/`).

Post-merge verify on master HEAD is the canonical end-to-end check. When PR merges and autofwd pulls it into `gemma-architect-master/`, the next regular verify run catches any regression.

## surface-allowfail.txt schema

`state/surface-allowfail.txt` is PR-tracked. Every entry must follow this format:

```
surface-name  # #<issue>  <one-line reason>
```

Rules:
1. **An open tracking issue is required** before a surface may be added to allowfail.
2. **The issue number must be cited** next to the surface name in the file.
3. **The commit message must name each surface added** (e.g., `add snap-cursor-vertex to allowfail, tracking #484`).
4. **Local dirty-edits to mask verify failures are Class F** (gate-softening). They are forbidden. Stash or revert any such edit before the next session.

Correct entry example:
```
snap-cursor-vertex  # #484  camera-fit timing race: midpoint vs endpoint snap nondeterministic at varying viewport widths
```

## Verify wrapper (recommended path)

All normal gemma-verify runs should go through the lockfile-coordinator wrapper (`scripts/gemma-verify.mjs`, shipped in PR #479) rather than calling `gemma-verify-raw.mjs` directly. The wrapper serializes concurrent runs from engineers and archives per-run receipts.

```bash
bun scripts/gemma-verify.mjs            # normal run
bun scripts/gemma-verify.mjs --caller archie
```

`gemma-verify-raw.mjs` is for debugging only and is not safe to run concurrently.

## Future design (DEFERRED — not implemented, requires user approval)

If pre-merge browser-based verify becomes necessary, the candidate approach that respects the one-browser/one-server constraint:

1. Same single `:5175` vite, configured to statically serve per-PR build artifacts at distinct paths (e.g., `:5175/pr-502/` → `gemma-architect-master/web/dist-pr-502/`).
2. `bun run build` from a per-PR worktree outputs to that path.
3. The single `:9222` Chromium opens a **separate tab** at `:5175/pr-502/`. The user's tab on `:5175/` (master HEAD) is a different document and is undisturbed.
4. `gemma-verify-raw` attaches to the PR-specific tab by URL match.

This requires: vite static-serve config change, build-artifact placement convention, per-PR tab management in verify, stale-artifact cleanup. Out of scope until user approves.

## Cross-refs

- `docs/internal/working-tree-discipline.md` — worktree / branch checkout rules
- `docs/github-flow.md` — branching policy
- Issue #504 — incident chain + architectural constraints
- Memory: `feedback_serving_tree_frozen_workers_in_feature_dev`
- Memory: `feedback_shared_browser_no_playwright_mcp`
- Memory: `feedback_never_change_port_numbers`
