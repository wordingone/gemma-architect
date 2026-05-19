# C2 Schema-Handler Audit — spatial-api.yaml vs main.ts handlers

**Generated:** 2026-05-19  
**Branch:** audit/c2-schema-handler  
**Scope:** All `Sd*` commands in `web/src/commands/spatial-api.yaml` cross-checked against `registerHandler("Sd*", …)` blocks in `web/src/main.ts`

---

## Verdict legend

| Verdict | Meaning |
|---|---|
| CLEAN | Schema required fields match handler's actual required fields |
| SCHEMA-TOO-STRICT | Schema `required: true`, handler has default → validator rejects valid agent call |
| SCHEMA-TOO-LOOSE | Schema `required: false` / field missing, handler would fail without it |
| TYPE-MISMATCH | Schema field name or type diverges from what handler reads |
| NEEDS-INVESTIGATION | No explicit handler (falls to installDefaultHandlers shim); behavior unclear |

---

## Full Command Table

| Command | Schema required fields | Handler actual required fields | Verdict |
|---|---|---|---|
| SdLine | start, end | none (start→[0,0], end→[1,0]) | SCHEMA-TOO-STRICT |
| SdArc | angleStart, angleEnd | none | SCHEMA-TOO-STRICT + TYPE-MISMATCH |
| SdCircle | center, radius | none (center→[0,0], radius→1) | SCHEMA-TOO-STRICT |
| SdPolygon | center, radius, sides | — | NEEDS-INVESTIGATION |
| SdPolyline | points | points (error if <2) | CLEAN |
| SdRectangle | width, length | none (width→1, length→1) | SCHEMA-TOO-STRICT |
| SdEllipse | center, rx, ry | none (all defaulted) | SCHEMA-TOO-STRICT |
| SdCurve | points | points (error if <2) | CLEAN |
| SdSpline | points | points (error if <4) | CLEAN |
| SdPoint | position | none (position→[0,0]) | SCHEMA-TOO-STRICT |
| SdBox | width, depth, height | none (all→1) | SCHEMA-TOO-STRICT |
| SdCylinder | radius, height | none (radius→0.5, height→2) | SCHEMA-TOO-STRICT |
| SdSphere | radius | none (radius→1) | SCHEMA-TOO-STRICT |
| SdCone | radius1, radius2 | reads args.radius only | TYPE-MISMATCH |
| SdPrism | profile, height | — | NEEDS-INVESTIGATION |
| SdExtrude | distance | none (distance→1) | SCHEMA-TOO-STRICT |
| SdRevolve | profile, axis | reads axisFrom+axisTo (not axis) | TYPE-MISMATCH |
| SdSweep | profile, path | reads args.rail (not path) | SCHEMA-TOO-LOOSE + TYPE-MISMATCH |
| SdLoft | sections | reads args.curves (not sections) | SCHEMA-TOO-LOOSE + TYPE-MISMATCH |
| SdBooleanUnion | a, b | — | NEEDS-INVESTIGATION |
| SdBooleanDifference | outer, inner | — | NEEDS-INVESTIGATION |
| SdBooleanIntersection | a, b | — | NEEDS-INVESTIGATION |
| SdBoolean | op, a, b | op, a, b (explicit null-checks) | CLEAN |
| SdFillet | edges, radius | reads args.target (UUID), not edges | TYPE-MISMATCH |
| SdChamfer | edges, distance | — | NEEDS-INVESTIGATION |
| SdOffset | source, distance | — | NEEDS-INVESTIGATION |
| SdTrim | source, cutter | — | NEEDS-INVESTIGATION |
| SdExtend | source, target | — | NEEDS-INVESTIGATION |
| SdSplit | source, cutter | — | NEEDS-INVESTIGATION |
| SdShell | source, thickness | — | NEEDS-INVESTIGATION |
| SdMove | none | none | CLEAN |
| SdRotate | angle | none (angle→0) | SCHEMA-TOO-STRICT |
| SdScale | factor | none (factor→1) | SCHEMA-TOO-STRICT |
| SdMirror | target, plane | — | NEEDS-INVESTIGATION |
| SdArray | count, spacing | none (count→1, spacing→[1,0,0]) | SCHEMA-TOO-STRICT |
| SdCopy | none | none | CLEAN |
| SdArrayLinear | count | none (count→3, dx→1) | SCHEMA-TOO-STRICT |
| SdArrayGrid | rows, cols | none (rows→3, cols→3) | SCHEMA-TOO-STRICT |
| SdArrayPolar | count | none (count→6, angle→360) | SCHEMA-TOO-STRICT |
| SdWall | none | none | CLEAN |
| SdSlab | none | none | CLEAN |
| SdColumn | position | none (pos→[0,0]) | SCHEMA-TOO-STRICT |
| SdBeam | none | none | CLEAN |
| SdMember | none | none | CLEAN |
| SdStair | none | none | CLEAN |
| SdDoor | position | none (pos→[0,0]) | SCHEMA-TOO-STRICT |
| SdWindow | position | none (pos→[0,0]) | SCHEMA-TOO-STRICT |
| SdRoof | footprint | none (w→8, d→10, default) | SCHEMA-TOO-STRICT |
| SdSpace | footprint, height | footprint→5×4; height arg not read | SCHEMA-TOO-STRICT (height dead) |
| SdFoundation | none | none | CLEAN |
| SdCeiling | none | none | CLEAN |
| SdCurtainWall | none | none | CLEAN |
| SdPlate | none | none | CLEAN |
| SdSkylight | none | none | CLEAN |
| SdOpening | none | none | CLEAN |
| SdRamp | none | none | CLEAN |
| SdRailing | none | none | CLEAN |
| SdRefGrid | none | none | CLEAN |
| setGridVisible | id, visible | id, visible | CLEAN |
| setGridSpacing | id, spacing | id, spacing | CLEAN |
| setActiveGrid | id | id | CLEAN |
| SdLevel | none | none | CLEAN |
| SdDatum | none | none | CLEAN |
| SdReferenceLine | none | none | CLEAN |
| SdFurnishing | none | none | CLEAN |
| SdAnnotationDimension | from, to | — | NEEDS-INVESTIGATION |
| SdLeader | from, to, text | — | NEEDS-INVESTIGATION |
| SdText | position, content | — | NEEDS-INVESTIGATION |
| SdGroup | members | — | NEEDS-INVESTIGATION |
| SdUngroup | target | — | NEEDS-INVESTIGATION |
| SdLayer | target, layer | — | NEEDS-INVESTIGATION |
| SdLock | target | — | NEEDS-INVESTIGATION |
| SdHide | target | — | NEEDS-INVESTIGATION |
| SdSelect | id | id (explicit null-guard) | CLEAN |
| SdSelectByQuery | none | none | CLEAN |
| SdSelectAll | none | none | CLEAN |
| SdDelete | none | none | CLEAN |
| SdDeselect | none | — | NEEDS-INVESTIGATION |
| SdIsolate | uuid | uuid (null-guard) | CLEAN |
| SdIsolateOff | none | none | CLEAN |
| SdFitToObject | uuid | uuid (null-guard) | CLEAN |
| SdZoomExtents | none | none | CLEAN |
| SdZoomSelected | none | none | CLEAN |
| SdSetViewOrtho | none | none | CLEAN |
| SdSetViewPerspective | none | none | CLEAN |
| SdSetCPlane | mode | none (mode→"world") | SCHEMA-TOO-STRICT |
| SdResetCPlane | none | none | CLEAN |
| SdToggleCPlaneGizmo | none | none | CLEAN |
| SdRenderMode | none | none | CLEAN |
| SdMeasure | from, to | — | NEEDS-INVESTIGATION |
| SdArea | target | — | NEEDS-INVESTIGATION |
| SdVolume | target | — | NEEDS-INVESTIGATION |
| SdDimAligned | from, to | — | NEEDS-INVESTIGATION (SdAlignedDim has handler) |
| SdDimAngular | vertex, from, to | — | NEEDS-INVESTIGATION (SdAngularDim has handler) |
| SdAlignedDim | a, b | a, b (defaults silently) | CLEAN |
| SdAngularDim | vertex, ray1, ray2 | all defaults silently | CLEAN |
| SdAreaDim | points | points (error if <3) | CLEAN |
| SdVolumeDim | id | id (null-guard) | CLEAN |
| SdLabel | text | text (null-guard) | CLEAN |
| SdTransientMeasure | a, b | none (both→[0,0,0]) | SCHEMA-TOO-STRICT |
| SdImport | format, bytes | — | NEEDS-INVESTIGATION |
| SdExport | format | format (null-guard) | CLEAN |
| SdSave | none | none | NEEDS-INVESTIGATION |
| SdOpen | none | none | NEEDS-INVESTIGATION |
| SdClearScene | none | none | CLEAN |
| SdUndo | none | none | CLEAN |
| SdRedo | none | none | CLEAN |
| SdListObjects | none | none | CLEAN |
| SdRunCluster | name | name (returns error if missing) | CLEAN |
| SdListClusters | none | none | CLEAN |
| SdSetUnits | system | none (system→"metric") | SCHEMA-TOO-STRICT |
| setActiveTool | toolId | — | NEEDS-INVESTIGATION |
| setActiveLevel | id | id (null-guard) | CLEAN |
| setLevelVisible | id, visible | id, visible | CLEAN |
| removeLevel | id | id (null-guard) | CLEAN |
| SdSectionBox | min, max | min, max (null-guard) | CLEAN |
| SdSectionBoxOff | none | none | CLEAN |
| SdClippingPlane | origin, normal | origin, normal | CLEAN |
| SdClippingPlanesClear | none | none | CLEAN |
| SdClippingPlaneRemove | label | label (null-guard) | CLEAN |

---

## Divergence Catalog

### P1 — Critical: Field Name / Type Mismatch (broken dispatch path)

These commands will produce wrong or no output regardless of what the agent emits, because the handler reads a different field name than what the schema declares and the agent will emit.

**C2-001 · SdArc — SCHEMA-TOO-STRICT + TYPE-MISMATCH**
- Schema: `angleStart`, `angleEnd` required
- Handler reads: `args.startAngle`, `args.endAngle`
- Effect: agent emits `{angleStart: 0, angleEnd: 1.57}` → handler reads `undefined` → silently falls back to 0/π/2 always → arc always defaults regardless of args
- Fix: rename schema fields `angleStart`→`startAngle`, `angleEnd`→`endAngle`, both `required: false`

**C2-002 · SdRevolve — TYPE-MISMATCH**
- Schema: field `axis: line3` required
- Handler reads: `args.axisFrom: point3`, `args.axisTo: point3` (two separate fields)
- Effect: agent emits `{axis: {from:[0,0,0], to:[0,0,1]}}` → handler reads `args.axisFrom`/`args.axisTo` → undefined → revolve always spins around Z regardless of args
- Fix: replace schema `axis: line3` with `axisFrom: point3 required:false` + `axisTo: point3 required:false`

**C2-003 · SdSweep — SCHEMA-TOO-LOOSE + TYPE-MISMATCH**
- Schema: field `path` required
- Handler reads: `args.rail`
- Effect: agent emits `{path: <curve>}` → `resolveCurve(args.rail)` → undefined → throws → dispatch error
- Fix: rename schema `path`→`rail`, mark `required: false`; OR add handler fallback `args.rail ?? args.path`

**C2-004 · SdLoft — SCHEMA-TOO-LOOSE + TYPE-MISMATCH**
- Schema: field `sections` required
- Handler reads: `args.curves`
- Effect: agent emits `{sections: [<curve1>, <curve2>]}` → handler reads `args.curves` → empty → returns error
- Fix: rename schema `sections`→`curves`, mark `required: false`; OR add handler fallback

**C2-005 · SdFillet — TYPE-MISMATCH**
- Schema: `edges: list_edge` required, `radius: number` required
- Handler reads: `args.target` (UUID string), `radius` defaults to 0.05
- Effect: validator rejects any call missing `edges`; even with `edges`, handler ignores it and reads `target`
- Fix: replace schema `edges`→`target: object_id required:false`; `radius: required:false default:0.05`

**C2-006 · SdCone — TYPE-MISMATCH**
- Schema: `radius1: number` required, `radius2: number` required
- Handler reads: `args.radius` (single value); `radius1`/`radius2` never consumed
- Effect: agent emits `{radius1: 1, radius2: 0}` → handler reads `args.radius` → undefined → cone defaults to 0.5
- Fix: rename schema `radius1`→`radius` required:true; mark `radius2` optional with default 0 (handler ignores it currently but could be wired for truncated cone)

### P2 — High: Schema-Too-Strict (valid agent calls rejected before handler runs)

22 commands with `required: true` in schema where handler has a working default. Any agent call omitting these fields gets rejected by the validator before the handler runs.

Commands: SdLine, SdCircle, SdRectangle, SdEllipse, SdPoint, SdBox, SdCylinder, SdSphere, SdExtrude, SdRotate, SdScale, SdArray, SdArrayLinear, SdArrayGrid, SdArrayPolar, SdColumn, SdDoor, SdWindow, SdRoof, SdSpace (footprint), SdSetCPlane, SdTransientMeasure, SdSetUnits

Fix pattern: change `required: true` → `required: false` and add `default:` annotation matching the handler's fallback. One YAML-diff per command; no handler changes.

### P3 — Medium: NEEDS-INVESTIGATION (shim-only, no geometry handler)

30 commands fall to `installDefaultHandlers()` which emits a `gemma:command` DOM event and returns `{dispatched: kernel_op}`. No geometry is created unless a separate DOM listener exists. Agent calls to these produce no visual result.

Notable: **SdDimAligned** / **SdDimAngular** in YAML have no handlers, but **SdAlignedDim** / **SdAngularDim** (different canonical names) DO have handlers. Verb name drift — agent may emit the wrong canonical name.

---

## Counts

| Verdict | Count |
|---|---|
| CLEAN | 54 |
| SCHEMA-TOO-STRICT | 23 |
| SCHEMA-TOO-LOOSE + TYPE-MISMATCH | 3 (SdSweep, SdLoft) |
| TYPE-MISMATCH | 4 (SdArc, SdRevolve, SdFillet, SdCone) |
| NEEDS-INVESTIGATION | 30 |
| **Total** | **~114** |

---

## Recommended Issues

- **Umbrella issue**: C2 schema-handler sweep — 6 P1 critical mismatches + 23 P2 schema-too-strict entries
- **Fix PRs** (downstream of this audit):
  - PR-A: P1 fixes — 6 field-name/type mismatches in YAML + handler
  - PR-B: P2 fixes — 23 schema `required: true` → `required: false` in YAML only
  - PR-C: P3 investigation — map shim-only commands to planned handlers or mark stubs

---

*Methodology: agent-assisted sweep of full YAML and all registerHandler blocks. Handler "actual required" = fields the handler reads without a default and would return error/broken geometry if missing.*
