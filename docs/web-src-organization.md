# Web `src` Organization

This repository now groups the highest-coupling web runtime modules by domain:

- `web/src/commands`: command dictionary, dispatch, DSL, and command-session runtime
- `web/src/agent`: agent harness and skill loading
- `web/src/viewer`: viewport interaction, create-mode, selection/snap, transform helpers

Design intent:

- Keep command execution paths under `commands/*`.
- Keep model-facing orchestration under `agent/*`.
- Keep scene interaction and viewport manipulation under `viewer/*`.

Migration guardrails:

- Move files first, avoid behavior changes in the same commit.
- Keep legacy parsing/dispatch compatibility unless explicitly removed.
- Validate with `tsc` + targeted tests + live browser checks before merge.
