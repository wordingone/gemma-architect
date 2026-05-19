# Working-Tree Discipline

`B:/M/gemma-architect/` is the **shared working tree** — the engineer develops in it and the vite dev server at `localhost:5847` serves from it. Whatever branch is checked out there is what the user sees.

## Rules

1. **Never `git checkout <branch>` in `B:/M/gemma-architect/`** unless you're the assigned engineer and are deliberately switching what the user sees. `bash`'s `cd` resets between invocations; `git checkout` writes to disk and persists across them.
2. **All other work goes in a `git worktree`** off the shared clone:
   ```bash
   cd B:/M/gemma-architect
   git worktree add B:/M/gemma-architect-<topic> <branch>
   ```
   This creates an isolated working tree at the new path. The shared tree's checkout is unaffected.
3. **Verify with `git worktree list`** before any branch operation. If you see your topic branch already checked out somewhere, work there. If you don't, add it.
4. **Never run a parallel vite from a worktree on the same port (5847)**. Either use a different port (and confirm before pointing at it — see gate-discipline rule about port redirects), or don't run vite at all from the worktree.

## When the shared tree's branch DOES need to change

Only when verifying a different PR end-to-end on the dev URL. Coordinate with the team first:

1. Confirm the user is ready to switch his view (mail him; wait for ack).
2. Switch the shared tree to the target branch.
3. Verify the user sees the new state.
4. Switch back to the prior branch when done.

For PR review without user-side verification, use a worktree + a separate dev server on a different port; never touch the shared tree.

## Verification commands

```bash
# Where does this branch live? (returns path or empty)
git worktree list | grep <branch-name>

# What branch is the shared tree on right now?
cd B:/M/gemma-architect && git rev-parse --abbrev-ref HEAD

# What's vite serving at :5847?
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5847 -State Listen | ForEach-Object { Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess) | Select-Object ProcessId, CommandLine }"
```

The third command returns the process serving the dev URL; its working directory is in the CommandLine. Cross-check that working dir's HEAD before assuming what the user sees.

## Removing a worktree when done

```bash
git worktree remove B:/M/gemma-architect-<topic>
```

Only after the branch is merged or abandoned. `git worktree remove` errors out if there are uncommitted changes — commit or stash first.

## Cross-refs

- `docs/github-flow.md` — branching policy
- the `gate-discipline.md` self-catch 2026-05-05 — the canonical incident
- Issue #103 — LAYOUT-mode click bug surfaced when this rule was violated 2026-05-08
