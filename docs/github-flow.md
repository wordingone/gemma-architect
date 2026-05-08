# GitHub Flow Policy (master)

This repository uses GitHub Flow with `master` as the only long-lived branch.

> See also: [Working-Tree Discipline](internal/working-tree-discipline.md) — rules for `B:/M/gemma-architect/` (the shared tree serving Jun's `:5175`).

## Rules

1. Branch from `master` using one of:
   - `feat/<short-topic>`
   - `fix/<short-topic>`
   - `chore/<short-topic>`
   - `docs/<short-topic>`
2. Open a PR early (same day as first push).
3. Keep branches short-lived (target merge/close in 3 working days).
4. Merge to `master` only through PR (no direct push).
5. Use squash merge and delete the source branch after merge.

## Required Checks Before Merge

- CI workflow must pass:
  - `typecheck-test`
  - `fixtures-validate`
  - `console-dispatch-guard`
- At least one approved review.
- Branch must be up to date with `master`.

## Console/Dispatch Safety

Changes touching any of these files require extra validation:

- `web/src/workbench.ts`
- `web/src/dsl-eval.ts`
- `web/src/dispatch.ts`
- `web/test/dispatch.test.ts`

Run:

- `bun run audit:dispatch`
- `bun test web/test/dispatch.test.ts`

## Existing Branch Triage Workflow

For each legacy non-`master` branch:

1. Check if it has unique commits vs `master`.
2. If no unique commits: delete branch.
3. If unique commits exist: cherry-pick only relevant commits into a new focused branch from current `master`.
4. Open focused PR with test evidence.
5. Delete legacy source branch after decision (merged or intentionally dropped).

Reference command:

```powershell
$branches = git for-each-ref --format='%(refname:short)' refs/heads | ? { $_ -ne 'master' }
foreach($b in $branches){
  $c = ((git rev-list --left-right --count "master...$b").Trim() -split "\s+")
  "$b | branch_unique=$($c[1]) | master_unique=$($c[0])"
}
```
