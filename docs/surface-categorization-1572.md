# Surface Categorization — #1572 Umbrella

**Created:** 2026-05-23  
**Owner:** Archie  
**Issue:** #1572  
**Receipt used:** `state/gemma-verify-bfc6872-20260522T2104458Z.json` (most recent)  
**Prior receipt:** `state/gemma-verify-28ae2ea-20260520T1222025Z.json`  
**Baseline (all-pass):** `state/gemma-verify-992c913-20260505T134905Z.json` (11 surfaces only)

---

## Purpose

Classify each failing surface on current master into one of three buckets:

- **stale-test** — assertion logic no longer matches current UI/behavior; safe to allowfail now
- **never-validated** — surface added but never observed-PASS; hold for Eli's N-agent run
- **real-regression-suspect** — evidence shows it passed before; file issue, do not allowfail

Leo directive (mail #10519): produce categorization doc + updated `surface-allowfail.txt` for stale-test class. Cross-merge with Eli's N-agent failure list when available.

---

## Allowfail cleanup

`demo-cluster-flow` was added to allowfail with `#670 new surface — allow-fail until first green run confirms timing`. The bfc6872 receipt shows it **passed** (`passed: true`, `uiCardFound: false` soft-pass). Remove from allowfail.

---

## Stale-test surfaces (added to allowfail in this PR)

| Surface | S# | Issue | Stale reason |
|---|---|---|---|
| `ifc-import-renders` | S13 | #326 | Injects IFC via `#file-input` DataTransfer; file-input path no longer triggers `viewer:ifc-loaded` after worker-based IFC loading refactor. Receipt: HTTP 404 on `/samples/Schultz_Residence.ifc`. |
| `ifc-render-determinism` | S14 | #326 | Explicitly depends on `ifc-import-renders` succeeding (60s timeout waiting for IFC load event that never fires). Cascade failure. |
| `ifc-picker-activation` | S30 | #326 | cmdk "IfcWall" + Enter used to activate the IFC entity picker prompt. Now activates the wall creation tool; `.picker-prompt.visible` never set. Receipt: `visible: false, promptText: "Waiting for SdPolyline: points."` |
| `starter-library` | S67 | #428 | `import('/src/skills/starter-clusters.ts')` — TypeScript source dynamic import only works with Vite dev server. Fails on any bundled deployment (raw `.ts` served as 404). Receipt: `"Failed to fetch dynamically imported module: https://wordingone.github.io/src/skills/starter-clusters.ts"`. |
| `two-story-house-chip` | S70 | #471 | Asserts `.chat-starter-chip` "Two-story house" exists. Chip was part of the hackathon demo suite; removed/paused per #471 PAUSED bucket. Receipt: `chipLabels: []`. |
| `gable-trim-undo-roundtrip` | S76 | #916 | Places walls via `SdWall({ x, y, length, direction, height })` — stale API. Schema dropped `direction` param; wall placement uses `profile` or `start/end` only. All 4 placement calls fail silently, "fewer than 4 walls placed". |

---

## Never-validated surfaces (hold for Eli's N-agent run)

These surfaces were written to test features that require either a backend export service, a future feature not yet shipped, or an on-device model session. None has a confirmed PASS in any receipt. Cross-merge after Eli shares N-agent failure list.

### Export-backend surfaces (8)

All return `ok: false, testMode: false, raw: "{}"`. The `testMode: false` field means the test is hitting the real export path, which requires a backend service not available in the verify environment.

| Surface | Export format |
|---|---|
| `export-ifc4` | IFC4 |
| `export-3dm` | 3DM (Rhino) |
| `export-dwg` | DWG |
| `export-obj` | OBJ |
| `export-stl` | STL |
| `export-usdz` | USDZ |
| `export-svg` | SVG (separate from layout-svg-vector-export which passes) |
| `export-pdf` | PDF |

Issue to file: single umbrella issue for export-backend surfaces — verify environment must either mock the export backend or mark these as integration-only.

### Feature-not-yet-shipped

| Surface | Evidence | Comment |
|---|---|---|
| `stair-ceiling-hole` | `ceilingHoleUuid: null` | Stair placement does not yet punch a hole in the ceiling slab. Feature tracked separately. |

### Regression-net surfaces (written against an open bug, never PASS)

| Surface | Issue | Evidence |
|---|---|---|
| `window-void-single` | #1518 | `zGapOk: false`; void cut geometry for single window doesn't produce expected z-gap |
| `window-void-compound` | #1520 | `zGapOk: false`; compound void (2 windows) also fails |
| `wall-window-void-cut` | #1518 | Not yet in any receipt (surface added after bfc6872) |

### Newer surfaces (not yet in any receipt)

| Surface | Issue | Comment |
|---|---|---|
| `level-aware-host-find` | #1518 | Added after bfc6872 receipt |
| `garden-wall-height-guard` | — | Added after bfc6872 receipt |
| `gable-trim-z-origin` | — | Added after bfc6872 receipt |

---

## Real-regression-suspect surfaces (file issues, do not allowfail)

These surfaces were confirmed passing at some point (removed from allowfail, or present in passing receipts) and are now failing. Each needs a specific fix; adding to allowfail would hide the regression.

| Surface | Evidence of prior pass | Current failure |
|---|---|---|
| `view-cplane-orientation` | Removed from allowfail commit `ee13291` (#1350) | `dotY: 0, orientOk: false` — camera orientation not matching expected cplane direction |
| `host-cplane-orientation` | Same commit `ee13291` (#1350) | `IfcWall dispatch failed` — wall placement that triggers host-cplane resolution fails |
| `stair-parametric` | Sub-test A: `SdStair({ start: {x,y}, end: {x,y} })` creates no stair group | Likely DimensionGuardrail (PR #1687) rejects start/end-only dispatch when no `level_from/level_to` elevation delta provided |
| `snap-face-vertex-priority` | Was in hackathon allowfail #1268; removed after fix | `faceVertex: {x:0, y:0.1, z:0}` doesn't match `target: {x:0, y:0, z:0}`; snap priority ordering broken |
| `hidden-level-unselectable` | Removed from allowfail commit `2eb104e` (#1413) | `meshVisible: true` when hidden level's mesh should be invisible; level hide regression |
| `copy-click-commits-selection` | In hackathon allowfail, presumably fixed | `copyPlaced: false`; copy placement after selection-commit doesn't add geometry |
| `array-linear-spawns-copies` | In hackathon allowfail (#944), removed after fix | `"Linear chip not found", chipLabels: []`; SdArray type-selection chips UI changed |
| `array-polar-spawns-radial` | In hackathon allowfail (#1092) | Same — Polar chip not found |
| `array-rect-spawns-grid` | In hackathon allowfail (#1092) | Same — Rectangular chip not found |
| `fillet-schema-edge-dispatch` | Present in passing receipts | `allEdgesOk: false, oobError: true`; fillet edge index out-of-bounds at `edgeIndex >= faces.length` |

### Issue mapping for real-regression-suspect

- `view-cplane-orientation` + `host-cplane-orientation` → single issue: CPlane regression (restore fix from #1350)
- `stair-parametric` → issue: DimensionGuardrail breaks start/end stair placement; investigate level_from/level_to default when not supplied
- `snap-face-vertex-priority` → issue: snap priority regression
- `hidden-level-unselectable` → issue: level hide regression (restore fix from #1413)
- `copy-click-commits-selection` → issue: copy placement broken
- `array-linear-spawns-copies` + `array-polar-spawns-radial` + `array-rect-spawns-grid` → single issue: Array type chip UI regression
- `fillet-schema-edge-dispatch` → issue: fillet oobError (#1518 area)

---

## Surface counts

| Category | Count |
|---|---|
| Stale-test (added to allowfail) | 6 |
| Never-validated (export backend) | 8 |
| Never-validated (feature not shipped / regression-net / new) | 7 |
| Real-regression-suspect | 10 |
| Allowfail cleanup (demo-cluster-flow removed) | 1 removed |
| **Total failing surfaces addressed** | **31** |

---

## Cross-merge note

When Eli shares the N-agent (on-device model) failure list, cross-merge with the 14 agent-path surfaces already in allowfail (su1-end-to-end-2storey-house, agent-palette-parity, agent-build-and-export, agent-skill-rotated-invocation, agent-invoke-skill, goal-mode-smoke, on-device-agent-response, fzk-haus-perception-rehearsal, agent-verb-completeness, demo-prompt-design-house, chat-plan-foldable, skill-node-parameter-sidecar, snap-cursor-vertex) plus the 7 never-validated surfaces above.
