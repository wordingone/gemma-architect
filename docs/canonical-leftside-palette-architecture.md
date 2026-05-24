# Canonical Leftside Palette Architecture

Issue #1711. Doc-only — no code changes.  
Triangulated from ≥3 PERFECTED buttons per architectural claim.  
Tables + file:line cites > prose. Use this as the gate criterion for future palette-button PRs.

---

## Phase 1 — Inventory

All 41 palette entries, drawn from `web/src/shell/workbench.ts:110-167` (`PALETTE_SECTIONS`), `web/src/tools/index.ts:362-408` (`TOOL_HANDLERS`), and `web/src/viewer/op-tool.ts:1775-1926` (`opStartTool`).

### Section 1 — Transform / Selection

| ID | Label | Entry point | Clicks | Mechanic |
|---|---|---|---|---|
| `select` | Select | workbench.ts:700 | N/A | hold-for-dropdown; 4 sub-modes (Standard/Window/Lasso/Boundary) |
| `move` | Move | workbench.ts:728 | N/A | PT state machine via `ptStartTool("move")` |
| `rotate` | Rotate | workbench.ts:728 | N/A | PT state machine via `ptStartTool("rotate")` |
| `scale` | Scale | workbench.ts:700 | N/A | hold-for-dropdown; 3 sub-modes (3D/1D/2D); PT state machine |
| `copy` | Copy | workbench.ts:728 | N/A | OP_TOOL_IDS; op-tool.ts:1847 |
| `array` | Array | workbench.ts:728 | N/A | OP_TOOL_IDS; op-tool.ts:1858; 4 array modes |

### Section 2 — CAD Sketch

| ID | Label | Entry point | Clicks | Builder |
|---|---|---|---|---|
| `line` | Line | tools/index.ts:372 | 2 | sketch.ts:83 `buildLine` |
| `rect` | Rectangle | tools/index.ts:370 | 2 | sketch.ts:21 `buildRect` |
| `circle` | Circle | tools/index.ts:371 | 2 | sketch.ts:52 `buildCircle` |
| `polyline` | Polyline | tools/index.ts:388 | -1 | sketch.ts:137 `buildPolyline` |
| `curve` | Curve | tools/index.ts:389 | -1 | sketch.ts:164 `buildCurve` |
| `point` | Point | tools/index.ts:390 | 1 | sketch.ts:248 `buildPoint` |

### Section 3 — Solid Operations

| ID | Label | Entry point | Clicks | Mechanic |
|---|---|---|---|---|
| `extrude` | Extrude | tools/index.ts:391 | 3 | OP_TOOL_IDS; op-tool.ts:1784 |
| `boolean` | Boolean | workbench.ts:728 | N/A | OP_TOOL_IDS; op-tool.ts:1787 |
| `fillet` | Fillet | workbench.ts:728 | N/A | OP_TOOL_IDS; op-tool.ts:1790 |

### Section 4 — Architectural Elements

| ID | Label | Entry point | Clicks | Builder |
|---|---|---|---|---|
| `wall` | Wall | tools/index.ts:363 | 2 | structural.ts:114 `buildWall`; 4-mode dropdown |
| `slab` | Slab | tools/index.ts:373 | 2 | structural.ts:238 `buildSlab` |
| `column` | Column | tools/index.ts:376 | 1 | structural.ts:255 `buildColumn` |
| `beam` | Beam | tools/index.ts:392 | 2 | structural.ts:777 `buildBeam` |
| `roof` | Roof | tools/index.ts:393 | 2 | structural.ts:804 `buildRoof`; `atTopOfLevel` |
| `space` | Space | tools/index.ts:394 | 2 | structural.ts:1173 `buildSpace` |
| `foundation` | Foundation | tools/index.ts:395 | 2 | structural.ts:1189 `buildFoundation` |
| `ceiling` | Ceiling | tools/index.ts:396 | 2 | structural.ts:1205 `buildCeiling`; `atTopOfLevel` |
| `grid` | Grid | tools/index.ts:402 | 2 | structural.ts:1324 `buildGridLine`; always Z=0 |
| `level` | Level | tools/index.ts:403 | 1 | structural.ts:1382 `buildLevel` |
| `datum` | Reference Line | tools/index.ts:404 | 2 | structural.ts:1402 `buildReferenceLine`; always Z=0 |

### Section 5 — IFC Circulation / Envelope

| ID | Label | Entry point | Clicks | Builder |
|---|---|---|---|---|
| `stair` | Stair | tools/index.ts:377 | 2 | structural.ts:401 `buildStair`; 3-mode dropdown |
| `door` | Door | tools/index.ts:374 | 1 | tools/openings.ts `buildDoor`; `atTopOfLevel`; variant picker |
| `window` | Window | tools/index.ts:375 | 1 | tools/openings.ts `buildWindow`; `atTopOfLevel`; variant picker |
| `ramp` | Ramp | tools/index.ts:400 | 2 | sketch.ts:195 `buildRamp` |
| `railing` | Railing | tools/index.ts:401 | 2 | sketch.ts:213 `buildRailing` |
| `curtainwall` | Curtain Wall | tools/index.ts:397 | 2 | structural.ts:1226 `buildCurtainWall`; `atTopOfLevel` |
| `skylight` | Skylight | tools/index.ts:398 | 2 | structural.ts:1309 `buildSkylight` |
| `opening` | Opening | tools/index.ts:399 | 1 | tools/openings.ts:364 `buildOpening`; `atZ` |

### Section 6 — Analysis

| ID | Label | Entry point | Clicks | Builder |
|---|---|---|---|---|
| `section` | Section Box | tools/index.ts:405 | 2 | structural.ts:1422 `buildSectionBox`; `dispatchOnCommit` |
| `clip` | Clip Plane | tools/index.ts:406 | 1 or 2 | structural.ts:1513/1536; 2-mode dropdown |

### Section 7 — Measurements / Annotations

| ID | Label | Entry point | Mechanic |
|---|---|---|---|
| `aligned-dim` | Aligned Dim | op-tool.ts:1793 | OP_TOOL_IDS; SVG overlay |
| `angular-dim` | Angular Dim | op-tool.ts:1793 | OP_TOOL_IDS; SVG overlay |
| `area-dim` | Area | op-tool.ts:1793 | OP_TOOL_IDS; polygon pick |
| `volume-dim` | Volume | op-tool.ts:1793 | OP_TOOL_IDS; click object |
| `label` | Label | op-tool.ts:1825 | OP_TOOL_IDS; click-place text |
| `transient-measure` | Transient | op-tool.ts:1828 | OP_TOOL_IDS; 2-pt distance |

---

## Phase 2 — Classification

### Criteria (from C4–C7 and PERFECTED-button inspection)

**For create tools** (clicks ≥ 1, produce geometry):

| # | Criterion | Where verified |
|---|---|---|
| P1 | `mesh.position.set(cx, cy, z)` — centroid-anchored, not world origin | sketch.ts:37,66,93; structural.ts:248 |
| P2 | `userData.kind` = semantic string (not `"brep"` for 2D sketch; any consistent string for 3D) | sketch.ts:39,68,95,154,183 |
| P3 | `userData.creator` = tool id string | all builders |
| P4 | `userData.controlPoints` = `THREE.Vector3[]` for linear/curve tools (C4) | sketch.ts:97,157,187 |
| P5 | `userData.endpoints` = `SnapVertex[]` for snap integration | sketch.ts:41,71,98,158,189; structural.ts:80,148,170,224 |
| P6 | Auto-return to select after commit: `dispatchSync("setActiveTool", { toolId: "select" })` | tools/index.ts:614,629,664,684,693,725,733,809,833 |
| P7 | Rubber-band preview: geometry ghost rendered on mousemove (via `updateRubberBand`) | tools/index.ts:421-467 |

**For op tools** (in `OP_TOOL_IDS`, drive state machine):

| # | Criterion | Where verified |
|---|---|---|
| O1 | Phase state machine: typed `_opPhase` with named `kind` fields | op-tool.ts:1775 |
| O2 | Picker hint at every phase: `ptPrompt(…)` | op-tool.ts:1786,1789,1792 |
| O3 | Coord input where applicable: `ptShowCoordInput(…)` | op-tool.ts:1853 |
| O4 | Gumball disabled on entry: `viewer.setGumballEnabled(false)` | op-tool.ts:1782 |
| O5 | Clean cancel path: Escape → `opCancel(viewer, false)` | tools/index.ts:970,975,979 |
| O6 | Preview geometry during operation | op-tool.ts (extrude drag preview) |
| O7 | Auto-return to select on commit: `dispatchSync("setActiveTool", { toolId: "select" })` | op-tool.ts ~1690 |

### Classification table

**PERFECTED** — all applicable criteria met; user hand-held through development.

| Button | Missing criteria | Notes |
|---|---|---|
| `line` | — | P1-P7 all met; sketch.ts:83 |
| `rect` | — | P1-P7; no controlPoints (2-pt bounding, correct); sketch.ts:21 |
| `circle` | — | P1-P7; no controlPoints (radius not linear, correct); sketch.ts:52 |
| `polyline` | — | P1-P7 + isClosed + commits on Enter; sketch.ts:137 |
| `curve` | — | P1-P7 + nurbsCVs + isClosed; sketch.ts:164 |
| `wall` | — | P1-P7 + 4-mode dropdown + chain mode + wall-corner joins; structural.ts:114 |
| `door` | — | P1,P3,P6 + ghost preview on hover + `atTopOfLevel` Z + variant picker (3 presets); openings.ts |
| `window` | — | same as door; 2 pane-style variants; openings.ts |
| `stair` | — | P1,P3,P4(stairParams),P6,P7 + 3-mode dropdown + run-derived count; structural.ts:401 |
| `select` | N/A | 4-mode dropdown; op clean cancel; workbench.ts:700 |
| `move` | N/A | PT state machine; gumball off; coord input; axis constraints; tools/index.ts:968 |
| `rotate` | N/A | PT state machine; 3-click axis; gumball off; tools/index.ts:968 |
| `scale` | N/A | 3-mode dropdown; PT state machine; gumball off; tools/index.ts:968 |
| `copy` | — | O1-O5,O7; auto-selects existing target; coord input dx/dy/dz; op-tool.ts:1847 |
| `clip` | — | 2-mode dropdown; buildClipPlanePlan (1 click) + buildClipPlaneSection (2 clicks); structural.ts:1513 |
| `volume-dim` | — | Single-click object; full result label; op-tool.ts:1793 |

**PARTIAL** — core mechanic works, 1–2 criteria missing.

| Button | Missing | Gap |
|---|---|---|
| `roof` | P5 | Footprint dashed preview during draw; Group sub-elements (rafters, ridge, fascia, soffit); `atTopOfLevel`; userData.roofParams; structural.ts:804 |
| `extrude` | O6 | 3-phase (select→drag→commit); auto-profile detection from SKETCH_PROFILE_CREATORS; preview present during drag but absent during select phase; op-tool.ts:1784 |
| `slab` | P5 | No `endpoints`; snapping won't find wall corners of slab edges; structural.ts:238 |
| `column` | P5 | No `endpoints`; single-click point tool — P4 N/A; structural.ts:255 |
| `beam` | P5 | No `endpoints`; centroid at midpoint + level height, correct; structural.ts:777 |
| `space` | P5 | Semi-transparent box; usable geometry; no snap integration; structural.ts:1173 |
| `foundation` | P5 | Box below Z=0; usable geometry; no snap integration; structural.ts:1189 |
| `ceiling` | P5 | Box at `atTopOfLevel`; usable geometry; no snap integration; structural.ts:1205 |
| `boolean` | O6 | Phase machine full (bool_a→bool_b→bool_mode chooser); preview not shown during object selection |
| `array` | O6 | 4 sub-types (linear/polar/curve/rect); full phase machine; no live preview during array |
| `polygon` | P2,P5 | kind="brep" (should be "polygon"); no endpoints; has controlPoints; sketch.ts:106 |
| `point` | P5,P7 | Single-point marker; no endpoints; no rubber-band (1-click, correct); sketch.ts:248 |
| `opening` | P5 | Has ghost preview on hover (opening-specific, not rubber-band); no endpoints; openings.ts:364 |
| `curtainwall` | P5 | Complex mullion+glass Group; `atTopOfLevel`; creator="curtainwall"; no endpoints; structural.ts:1226 |
| `skylight` | P5 | Planar glass pane; creator="skylight"; no endpoints; structural.ts:1309 |
| `railing` | P5 | Centroid correct (midpoint); creator="railing"; no endpoints; sketch.ts:213 |
| `aligned-dim` | O6 | Full op phase (dim_a→dim_b→dim_c); SVG overlay; no live segment preview |
| `angular-dim` | O6 | Same pattern |
| `area-dim` | O6 | Click-accumulate polygon points |
| `label` | O6 | label_pick → label_text (text input) |
| `transient-measure` | O6 | tmeasure_a → tmeasure_b; distance label |

**STUB** — defective; registered but produces wrong or broken output.

| Button | Gap |
|---|---|
| `ramp` | ~~P1 violated: `mesh.position.set(a.x, a.y, 0)` — start point, not centroid; P5 missing; sketch.ts:205~~ — fixed #1718; now PARTIAL (P1+P5 OK, P2 kind="ramp" OK, P7 rubber-band OK; no remaining known gaps) |
| `fillet` | ~~Phase machine present (fillet_select→fillet_edge); edge highlight missing; user-reported non-functional~~ — fixed #1719; now PARTIAL. Root cause: `opUpdateFilletEdge` loop `[1, pos.count-2]` excluded LineLoop indices 0 and last; `opApply2DFillet` guard blocked same indices. Fixed: loop wraps all indices for LineLoop; guard lifted for LineLoop. Edge highlight (opUpdateFilletEdge, orange renderOrder=999) confirmed present since PR #1202. Nav-shortcut "1" key conflict blocked by `getOpPhase()` check + capture-phase coord-input redirect. |

**SPECIALIST** — works correctly but does not fit the standard create-tool shape by design.

| Button | Notes |
|---|---|
| `grid` | Always Z=0 (architectural intent); kind="grid-line"; snap endpoints not applicable to grid lines |
| `level` | Produces sprite + level state entry; `buildLevel` returns `levelId`; atZ from getGeometryZ, not levelStore |
| `datum` | Always Z=0; has `controlPoints` as raw `[x,y,z][]` (not THREE.Vector3 — normalize in a follow-up) |
| `section` | Non-create: produces SectionBox clip state, not a persistent scene mesh; fires `dispatchOnCommit` |

---

## Phase 3 — Extracted Architectural Pattern

Triangulated from `line` / `wall` / `door` / `stair` — four PERFECTED buttons with different shapes (2D sketch / 2-pt 3D / 1-pt with elevation / 2-pt multi-param).

### 3A — Button wiring (workbench.ts:697-734)

```
// Simple create tool (no hold-for-menu):
btn.addEventListener("click", () => {
  if (getState("activeTool") === tool.id && OP_TOOL_IDS.has(tool.id)) {
    dispatchSync("setActiveTool", { toolId: "select" });      // ← toggle off if already active
  } else {
    dispatchSync("setActiveTool", { toolId: tool.id });
  }
});

// Hold-for-menu tool (select, scale, wall, stair, clip):
// pointerdown → 280ms holdTimer → showMenu(); click (short) → dispatchSync default toolId
```

**Rule:** every palette button calls `dispatchSync("setActiveTool", { toolId })` and nothing else. Business logic lives in the `activeTool` subscriber in `tools/index.ts:961`.

### 3B — Tool activation (tools/index.ts:961-999)

```typescript
subscribe("activeTool", (tool) => {
  // 1. Cancel any in-flight tool (ptCancel / opCancel)
  // 2a. Transform tools → ptStartTool(tool)  [move/rotate/scale]
  // 2b. OP tools → opStartTool(viewer, tool)  [extrude/boolean/fillet/copy/array/dims]
  // 2c. Create tools → set picker hint for unlimited-click or chain tools
  //     No explicit start — pointer events drive clicks via TOOL_HANDLERS
});
```

**Rule:** `setActiveTool` fires → subscriber cancels previous state → starts new state. Never start a tool from the button click handler.

### 3C — Create-tool click pipeline (tools/index.ts:1224-1668)

```
pointerdown → readActiveTool() → TOOL_HANDLERS[tool]
  → _pending.push(worldPt)
  → if _pending.length === handler.clicks → commit
    → addMesh(mesh)
    → dispatchSync("setActiveTool", { toolId: "select" })  ← auto-return (C7)

pointermove → updateRubberBand(viewer, handler, livePoint)  ← rubber-band preview (P7)
  → handler.handler([...pending, livePoint])
  → apply ghost material (opacity 0.35, depthTest false)
  → viewer.getScene().add(preview)
```

**Rule:** a PERFECTED create tool works entirely through `TOOL_HANDLERS` entry + `updateRubberBand`. No per-tool special-casing in the pointer event loop unless it's unlimited-clicks (`clicks: -1`) or chain mode.

### 3D — Builder function requirements

```typescript
// PERFECTED create builder signature:
export function buildFoo(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { mesh: THREE.Object3D; chain: string } {

  // 1. Compute geometry centroid (P1)
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;

  // 2. Build geometry (any THREE geometry type)

  // 3. Centroid-anchor the mesh (P1)
  mesh.position.set(cx, cy, 0);   // z from atZ() or atTopOfLevel() wrapping

  // 4. userData block — ALL required (P2–P5):
  mesh.userData.kind      = "foo";              // semantic, not "brep"/"mesh"
  mesh.userData.creator   = "foo";              // = tool id
  mesh.userData.controlPoints = [...];          // THREE.Vector3[] local-space (P4, linear/curve tools)
  mesh.userData.endpoints = [                   // SnapVertex[] world-space (P5)
    { x: a.x, y: a.y, z: 0, id: makeSnapId(a.x, a.y, 0) },
    { x: b.x, y: b.y, z: 0, id: makeSnapId(b.x, b.y, 0) },
  ];

  // 5. Chain string for sequence / undo history
  const chain = `const foo = ...`;

  return { mesh, chain };
}
```

**P1 gotcha:** geometry must be built around local origin `(0,0,0)` before `mesh.position.set(cx, cy, 0)`. If geometry is built at world position and mesh is at origin, gumball spawns at `(0,0,0)`.

**P4 gotcha:** `controlPoints` are in **local space** (subtract centroid). The snap and gumball code reads them in local → world transforms via `mesh.localToWorld()`.

**P5 gotcha:** `endpoints` are in **world space** (absolute). snap-state reads them directly as world snap candidates.

### 3E — atZ vs atTopOfLevel wrappers (tools/index.ts:350-360)

```typescript
// atZ: places mesh at active level elevation (Z base). Default for floor-level elements.
// atTopOfLevel: places mesh at active level elevation + offset. For doors/windows/roof/ceiling.
```

| Wrapper | Used for | `z` set to |
|---|---|---|
| `atZ` | wall, slab, column, line, rect, circle, polyline, curve, stair, beam | `levelStore.get(activeLevelId).elevation` |
| `atTopOfLevel(0)` | door, curtainwall | `elevation + 0` (front-face at slab top) |
| `atTopOfLevel(FZK_WINDOW_SILL)` | window | `elevation + sill offset` |
| `atTopOfLevel(DEFAULT_CEILING_OFFSET)` | roof, ceiling | `elevation + ceiling height` |
| none (Z=0) | grid, datum, section | always world Z=0 |

### 3F — Mode dropdown pattern (workbench.ts:277-645)

Used by: `select`, `scale`, `wall`, `stair`, `clip`.

```
btn.addEventListener("pointerdown") → holdTimer(280ms) → showXxxModeMenu(btn)
short click → dispatchSync("setActiveTool", { toolId: defaultToolId })
long press → dropdown with rows: { label, sub, toolId }
  row.click → dispatchSync("setActiveTool", { toolId: row.dataset.toolId })
```

**Rule:** mode dropdown changes the `toolId`, not the visual button state. The `syncToolActiveClass()` subscriber (app-state.ts:80) toggles `.active` on `[data-tool="<activeId>"]`. Wall sub-tools (`wall-polyline`, `wall-curve`, `wall-pick`) have no palette button — they highlight the parent `wall` button via the `WALL_SUB_TOOLS` alias at app-state.ts:78.

### 3G — Variant picker pattern (workbench.ts:755-805)

Used by: `door`, `window`.

```
subscribe("activeTool") → show/hide variantPicker
variantPicker btn.click → setDoorVariant(i) / setWindowVariant(i)
  → updates module-level variant state in tools/openings.ts
  → next door/window placement uses the variant
```

**Rule:** variant state is NOT in app-state — it's a module variable in `openings.ts`. This is intentional: variant is sticky within a session but not persisted. Future buttons with preset variants should follow the same module-variable pattern, NOT add to app-state.

### 3H — OP tool pattern (op-tool.ts:1775-1926)

Used by: extrude, boolean, fillet, copy, array, select-modes, measurements.

```
opStartTool(viewer, tool):
  1. opClearPreview + opClearLabels + opSetHover(null)
  2. _opPhase = null
  3. ptClearPrompt + ptHideCoordInput
  4. viewer.setGumballEnabled(false)
  5. Set initial _opPhase = { kind: "<tool>_<phase>" }
  6. ptPrompt("instruction for first click")

pointerdown in op phase → advance _opPhase → ptPrompt next instruction

on commit:
  7. pushAction(undoRecord)
  8. dispatchSync("setActiveTool", { toolId: "select" })
  9. viewer.setGumballEnabled(true)    ← re-enable for newly created/modified object
```

**Rule:** every op tool must call `viewer.setGumballEnabled(false)` on enter and `viewer.setGumballEnabled(true)` after commit. During selection phases, the gumball must NOT show for the target object — this is the standard.

---

## Phase 4 — Checklist for New Palette Buttons

### Create tool checklist

- [ ] `PALETTE_SECTIONS` entry: `{ id, icon, label }` in correct section (workbench.ts:110)
- [ ] `TOOL_HANDLERS` entry with correct `clicks` and `handler` (tools/index.ts:362)
  - `clicks: 2` for most 2-point tools
  - `clicks: 1` for single-placement tools
  - `clicks: -1` for unlimited-click with commit on Enter/double-click
  - `chain: true` if placement repeats (wall-polyline pattern)
- [ ] `handler` is wrapped with `atZ(...)` or `atTopOfLevel(offset)` — never places at raw Z=0 unless explicitly a floor-level tool
- [ ] Builder function produces `{ mesh, chain }` (or `{ mesh, chain, extraField }`)
- [ ] Builder sets **all required userData**:
  - [ ] `kind` = semantic string (P2)
  - [ ] `creator` = tool id string (P3)
  - [ ] `controlPoints` = `THREE.Vector3[]` local-space if linear/curve geometry (P4)
  - [ ] `endpoints` = `SnapVertex[]` world-space (P5)
- [ ] `mesh.position.set(cx, cy, z)` — geometry built around local origin, position at centroid (P1)
- [ ] `chain` string is valid replicad/kernel DSL (for sequence/undo)
- [ ] Rubber-band preview works: `handler.handler([pending[0], livePoint])` must return valid geometry even for degenerate/zero-length input without throwing (P7) — wrap in `try { } catch { }`
- [ ] Auto-return to select fires after commit (P6) — this is automatic via `tools/index.ts` pipeline; only needs explicit `dispatchSync` if the tool bypasses the standard pipeline

### Op tool checklist

- [ ] Add tool id to `OP_TOOL_IDS` in picker-hint.ts if it should NOT be handled by the create-click pipeline
- [ ] Add branch in `opStartTool` (op-tool.ts:1775)
- [ ] `_opPhase = { kind: "<tool>_<phase>", ... }` at start
- [ ] `ptPrompt("instruction")` at every phase change (O2)
- [ ] `ptShowCoordInput("hint")` where coordinate typing makes sense (O3)
- [ ] `viewer.setGumballEnabled(false)` on entry (O4)
- [ ] Escape → `opCancel(viewer, false)` — wired in existing cancel handler; no extra code needed if using `_opPhase`
- [ ] `viewer.setGumballEnabled(true)` + `dispatchSync("setActiveTool", { toolId: "select" })` after commit (O7)
- [ ] `opSetHover(null)` to clear any hover state on cleanup

### Mode-dropdown checklist (if adding sub-modes)

- [ ] `const hasCorner = ...` check in workbench.ts:698 — add new tool id here if it gets a dropdown
- [ ] `showXxxModeMenu` function following the pattern at workbench.ts:277
- [ ] Sub-tool ids use `<parent>-<sub>` naming (wall-polyline, clip-section) OR are standalone
- [ ] If sub-tool has no dedicated palette button, add to `WALL_SUB_TOOLS` equivalent set + `setSubToolOverride` so `readActiveTool()` returns the correct id

### Variant picker checklist (if adding presets)

- [ ] Add SVG arrays to `_vBtnSvgs` in workbench.ts:760
- [ ] Add branch in `_rebuildVariantBtns` (workbench.ts:775)
- [ ] Store variant in module variable in the relevant `tools/` file, not in app-state
- [ ] Subscribe to `activeTool` to show/hide the picker (pattern at workbench.ts:795)

---

## Summary of open gaps (do NOT fix in this PR — file separate issues)

| Tool | Gap | Suggested issue |
|---|---|---|
| `slab` | Missing `userData.endpoints` | Add endpoints at 4 corners (matching wall pattern) |
| `column` | Missing `userData.endpoints` | Add endpoint at column base center |
| `beam` | Missing `userData.endpoints` | Add endpoints at a/b world positions |
| `polygon` | `userData.kind = "brep"` (should be "polygon") | C5 fix |
| `ramp` | ~~`mesh.position.set(a.x, a.y, 0)` — start point, not centroid (C6 violation)~~ | Fixed #1718 |
| `fillet` | ~~User-reported non-functional; now classified STUB~~ | ~~Browser verification + fix before promoting to PARTIAL~~ Fixed #1719 |
| `datum` | `userData.controlPoints` as raw `[x,y,z][]`, not `THREE.Vector3[]` | Normalize to match snap-state consumer expectations |

*Confirmed via code audit. No browser verification performed in this PR — doc-only.*
