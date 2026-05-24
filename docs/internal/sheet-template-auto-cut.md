# SheetTemplate Auto-Cut: Plan and RCP Section Planes

Documents how `applySheetCut` wires the viewer's clip/section planes for plan and RCP sheet templates during PDF export (and live preview). Introduced in #1846 (plan) and #1844 (RCP).

---

## Plan view cut (`viewType: "plan"`)

```
 ┌──────────── ceiling ────────────────┐  elevation + levelHeight
 │                                     │
 │  ◀──── cut plane ────────────────  │  elevation + planCutHeight (default 1.22 m / 4')
 │                                     │
 └──────────── floor ──────────────────┘  elevation
```

- Section box: `[−BIG, −BIG, elevation]` → `[+BIG, +BIG, elevation + planCutHeight]`
- Default cut height: `1.22 m` (4 ft). Override via `SheetTemplate.planCutHeight`.
- Clip crops geometry below the cut plane; camera is set to `"top"` (plan projection).

## Reflected ceiling plan cut (`viewType: "rcp"`)

```
 ┌──────────── ceiling ────────────────┐  elevation + levelHeight
 │                                     │
 │  ◀──── cut plane ────────────────  │  elevation + rcpCutOffset (default 2.44 m / 8')
 │                                     │
 └──────────── floor ──────────────────┘  elevation
```

- Section box: `[−BIG, −BIG, elevation + rcpCutOffset]` → `[+BIG, +BIG, elevation + levelHeight]`
- Default cut offset: `2.44 m` (8 ft). Override via `SheetTemplate.rcpCutOffset`.
- Clip shows only geometry **above** the cut — ceiling structure, lighting, sprinklers, HVAC diffusers.
- Camera is set to `"top"` (looking down at ceiling from above, reflected convention).
- `levelHeight` is read from the level entity if `SheetTemplate.levelId` is set; fallback 3.0 m.

## Level data flow

```
levelStore (geometry/levels.ts)
  └── LayoutController.syncPlanSheets() / syncRcpSheets()
        └── per-instance _planSheetByLevelId / _rcpSheetByLevelId
              └── SheetData with name "Plan: <levelName>" / "RCP: <levelName>"
                    └── applySheetCut(t, viewer, levels) reads t.levelId → levels[levelId]
                          → elevation + height → section box coords
```

## Key types

```typescript
export interface SheetLevelRef {
  elevation: number; // meters
  height?: number;   // meters, used by rcp branch (fallback 3.0)
}

export interface SheetTemplate {
  viewType: SheetViewType;   // "plan" | "rcp" | "section" | "elevation" | "3d"
  levelId?: string;          // links to levelStore entity
  planCutHeight?: number;    // plan cut offset above elevation (default 1.22)
  rcpCutOffset?: number;     // rcp cut offset above elevation (default 2.44)
  // ...
}
```

## References

- `web/src/shell/layout.ts` — `applySheetCut()`, `syncPlanSheets()`, `syncRcpSheets()`
- `web/src/geometry/levels.ts` — `levelStore`
- `web/test/plan-sheet-auto-name.test.ts` — plan sync lifecycle tests (#1846)
- `web/test/rcp-sheet-auto-name.test.ts` — RCP sync lifecycle tests (#1844)
