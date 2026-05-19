# Palette Coverage Audit — SOUL-17

Verified 2026-05-19 against `web/src/shell/workbench.ts:109` (`PALETTE_SECTIONS`).

**Result: full coverage.** All 42 interactive palette tools have a registered Sd* handler.
Gaps are in interactive-vs-agent parity, not in dispatch coverage.

---

## Palette inventory (workbench.ts:109, PALETTE_SECTIONS)

### Section 0 — Transform (6 tools)

| Tool id | Sd* verb | Notes |
|---|---|---|
| select | — | Selection state only; no dispatch verb needed |
| move | SdMove | ✓ |
| rotate | SdRotate | ✓ |
| scale | SdScale | ✓ |
| copy | SdCopy | ✓ |
| array | SdArrayLinear / SdArrayPolar | ✓ (SdArray aliases both) |

### Section 1 — Primitives (6 tools)

| Tool id | Sd* verb |
|---|---|
| line | SdLine |
| rect | SdRect |
| circle | SdCircle |
| polyline | SdPolyline |
| curve | SdCurve |
| point | SdPoint |

### Section 2 — Modeling (3 tools)

| Tool id | Sd* verb |
|---|---|
| extrude | SdExtrude |
| boolean | SdBoolean |
| fillet | SdFillet |

### Section 3 — Architectural (11 tools)

| Tool id | Sd* verb |
|---|---|
| wall | SdWall |
| slab | SdSlab |
| column | SdColumn |
| beam | SdBeam |
| roof | SdRoof |
| space | SdSpace |
| foundation | SdFoundation |
| ceiling | SdCeiling |
| grid | SdGrid |
| level | SdLevel |
| datum | SdDatum |

### Section 4 — MEP / BIM (8 tools)

| Tool id | Sd* verb |
|---|---|
| stair | SdStair |
| door | SdDoor |
| window | SdWindow |
| ramp | SdRamp |
| railing | SdRailing |
| curtainwall | SdCurtainWall |
| skylight | SdSkylight |
| opening | SdOpening |

### Section 5 — Section / Clip (2 tools)

| Tool id | Sd* verb |
|---|---|
| section | SdSection |
| clip | SdClippingPlane |

### Section 6 — Annotation (6 tools)

| Tool id | Sd* verb |
|---|---|
| aligned-dim | SdAlignedDim |
| angular-dim | SdAngularDim |
| area-dim | SdAreaDim |
| volume-dim | SdVolumeDim |
| label | SdLabel |
| transient-measure | SdTransientMeasure |

**Total: 42 tools across 7 sections.**

> Note: `SdArc` is registered in `spatial-api.yaml` but `arc` is not in the current palette sections. It is accessible via agent dispatch only.

### Extended modeling verbs (schema-only, not in palette)

`SdEllipse`, `SdArc`, `SdRevolve`, `SdSweep`, `SdLoft` — confirmed in `main.ts` handlers + `spatial-api.yaml`.

---

## Gap analysis

### Coverage gaps: NONE

All 42 palette tools have a registered Sd* handler in `web/src/main.ts` and a schema entry in `web/src/commands/spatial-api.yaml`. No palette tool is dispatch-dark.

### Parity gaps (interactive richer than agent verb)

These are known, acceptable asymmetries — single-call agent semantics vs multi-step interactive UX:

1. **SdWall vs interactive wall-from-curve** — Interactive supports drawing walls along arbitrary paths. SdWall accepts `start`/`end` endpoints. Agent semantics: correct (wall-from-curve is a multi-click gesture).

2. **SdExtrude vs interactive extrude** — Interactive has live-preview drag during height selection. SdExtrude is single-call (`profileId` + `height`). Agent semantics: correct.

3. **SdFillet vs interactive fillet** — Interactive shows live radius preview on edge-hover. SdFillet is single-call (`target` + `radius`, optional `edgeId`). Agent semantics: correct (edgeId added in #1098).

4. **SdBoolean vs interactive boolean** — Interactive is two-step select (A then B). SdBoolean accepts both operands in one call. Agent semantics: preferred (single-call is more composable).

5. **SdArray vs interactive array** — Interactive supports grid, polar, and path modes via mode picker. SdArrayLinear and SdArrayPolar cover linear + polar. Path-array has no Sd* verb yet.

---

## Recommendation

**Coverage: complete.** No new Sd* verbs needed to close palette coverage.

**Parity improvements** (separate issues if prioritized):
- Wall-from-curve path for SdWall (multi-point variant)
- SdArrayPath for path-array mode (only mode without agent dispatch)

---

## Cross-references

- `web/src/shell/workbench.ts:109` — `PALETTE_SECTIONS` source of truth
- `web/src/commands/spatial-api.yaml` — full Sd* verb registry
- `docs/tool-taxonomy.md` — pre-hackathon mcp-rhino → replicad mapping (historical)
- Issue #933 — audit tracking
