## Summary

Describe the problem and the change in 2-5 lines.

## Scope

- In scope:
- Out of scope:

## Risk

- Risk level: `low` | `medium` | `high`
- Affected surfaces:
- Rollback plan:

## Verification

- [ ] `bun run typecheck`
- [ ] `bun run web:typecheck`
- [ ] `bun run audit:stubs`
- [ ] `bun run audit:parity`
- [ ] `bun test`

If console/dispatch paths changed, also include:

- [ ] `bun run audit:dispatch`
- [ ] `bun test web/test/dispatch.test.ts`
- [ ] Manual check at `http://localhost:5847/`:
  - console DSL input
  - `:` direct dispatch input
  - left palette tool click dispatch

## Notes

Link issue(s), prior branch, or cherry-picked commit(s).
