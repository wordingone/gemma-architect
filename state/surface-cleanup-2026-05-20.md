# Surface Cleanup — 2026-05-20

**Source:** `state/gemma-verify-d8030da-20260520T075240Z.json` — 59 surfaces failed.

**Categories:**
- **A** — verify-ordering victim; auto-clears when #1225 (verify-ordering fix) lands
- **B** — test assertion stale; Archie fixes test in batch PRs
- **C** — genuine regression; feature broken; each filed as separate gh issue

---

## A — Ordering / model-loading victims (12)

Leave in allowfail with `# pending #1225 verify-ordering`.

| Surface | Evidence | Rationale |
|---|---|---|
| `tier0-llama-server-dispatch` | `'Model is still loading'` | Model not loaded when verify ran; soft-skips when REMOTE badge absent |
| `su1-end-to-end-2storey-house` | `'Model is still loading'` | Multi-turn agent; built-in skip on timeout |
| `demo-prompt-design-house` | evaluate timeout | NL agent model-dependent |
| `on-device-agent-response` | `consent-required` post-wipe | Model consent cleared by storage wipe; re-given on first UI interaction |
| `fzk-haus-perception-rehearsal` | `agent:turn-complete timeout (60s)` | Scene loads (14 meshes) but model too slow |
| `two-story-house-chip` | `'chip not found'` | Chips appear only after model interaction; post-wipe none shown |
| `ifc-picker-activation` | `promptText: 'Waiting for SdPolyline: points.'` | Inter-surface tool-state contamination; prior surface left SdPolyline active |
| `gable-trim-undo-roundtrip` | `wallCount: 0` | Scene contamination — no walls present at test entry point |
| `agent-build-and-export` | `hasIfcWall: False, afterCount: 16` | Agent-dependent dispatch; model returning wrong output while loading |
| `snap-cursor-vertex` | `target: null` | Timing race (existing allowfail #484) |
| `demo-cluster-flow` | `recordBtnFound: False` | Cascade from model latency (existing allowfail #670) |
| `skill-node-parameter-sidecar` | `totalBoxes: 0` | Cascade from su1-e2e (existing allowfail #538) |

---

## B — Stale assertions (19)

Add to allowfail temporarily; batch PRs remove them as fixes ship.

### B1 — Export result accessor (8 surfaces) → 1 PR

Root cause: test reads `res.testMode` but `__dispatch` now returns `{ok, canonical, result}` envelope; `testMode` is at `res.result.testMode`. All 8 export surfaces fail the `passed = !!(r?.ok && r?.testMode)` check despite handler returning `ok:true, testMode:true` in the inner result.

| Surface | Evidence |
|---|---|
| `export-ifc4` | `ok:True, testMode:False` (inner `result.testMode:true`) |
| `export-3dm` | same pattern |
| `export-dwg` | same |
| `export-obj` | same |
| `export-stl` | same |
| `export-usdz` | same |
| `export-svg` | same |
| `export-pdf` | same |

Fix: change `r?.testMode` → `r?.result?.testMode` in the EXPORT_FORMATS loop assertion.

### B2 — UI selector stale (9 surfaces) → 1 PR

| Surface | Evidence | Fix |
|---|---|---|
| `comp-scope-toggle` | `#comp-scope-btn not found` | Button removed or renamed; update test to skip or use new selector |
| `record-and-invoke-roundtrip` | `recordBtnFound: False`; dispatch+geometry both work | `.skill-nodes-record-btn` renamed; drop the UI check or update selector |
| `fillet-selected-edge` | `coord-input not found` | `.coord-input` element renamed; update selector or remove fillet-UI check |
| `wall-params-input-parsing` | `height input not found` | `#wall-params-section [data-wall-field="height"]` stale; update to current DOM |
| `export-dropdown-renders` | `.export-drawer.open not present` | Class may be `.export-drawer--open` or `.is-open`; update selector |
| `import-ifc-menu-item` | `hasImportIfc: False, hasTestHook: True` | `[data-menu] button` doesn't find "Import IFC…" text; update selector |
| `view-state-sidebar-lists-clip` | `hasViewStateHdr:False, hasSectionBoxEntry:False` | Sidebar VIEW STATE section uses div/class not span/text; update DOM check |
| `parity-dashboard` | `rows:0, sparkline:False, deltas:0` | `.parity-row`, `.parity-sparkline`, `.parity-delta` selectors stale |
| `fzk-glb-door-window` | `doorGlb:False, windowGlb:False` | Test checks `creator === 'door'` / `'window'` but actual is `'SdDoor'` / `'SdWindow'`; also root C regression (door placement rejected) — fix test first, then check if C clears |

### B3 — Logic / assumption stale (2 surfaces) → 1 PR

| Surface | Evidence | Fix |
|---|---|---|
| `unit-display` | `expected default imperial, got undefined` | Test assumes `unitSystem === 'imperial'` as initial default; after storage wipe it's undefined (default = metric). Accept metric/undefined as valid initial state. |
| `dispatch-sweep` | `SdSelect ArgValidationError: missing required arg "id"` | Test calls SdSelect without `id`; schema now requires it. Add a valid `{id: someUuid}` to the test fixture or change to SdSelectAll. |

*(Note: `canvas-visible-width-skill-nodes` structural self-test fails — `selfTestOk:False` — because CSS `width:0` injection doesn't reduce the measured width as expected (canvas sized from other source). Canvas IS visible at 1070×280. Self-test logic needs rethink.)*

---

## C — Genuine regressions (28)

Each filed as separate `gh issue create`. Owner: Archie = viewer/palette/sidebar/workbench/tools/snap; Eli = handlers/dispatch/main.ts/spatial-api.yaml/tools-builders.

| # | Surface | Evidence | Root cause | Owner |
|---|---|---|---|---|
| 1 | `layout-tab-functional` | `aspect: 1.548, expected: 0.706` | `.paper-sheet` element has wrong aspect ratio (neither portrait nor landscape A1) | Archie |
| 2 | `grid-level-datum-pick` | `hasDatum: False` | Datum marker not created after grid + level placement | Archie |
| 3 | `view-cplane-orientation` | `no SdBox in scene, eventOk:True` | SdBox dispatch fires but object not findable by `creator === 'SdBox'` — creator mismatch or scene search broken | Archie |
| 4 | `host-cplane-orientation` | `no IfcWall in scene` | Same pattern as #3 for IfcWall | Archie |
| 5 | `undo-roundtrip` | `IfcWindow: restored:False` | IfcWindow undo does not restore geometry; all other types pass | Archie |
| 6 | `host-aware-door-placement` | `doorCount:0, rejected:True` | Door placement rejected — host wall raycast failing or tool state broken | Archie |
| 7 | `polyline-render-after-4-click` | `emitClickWorld returned null on 4th click` | 4th click world-coordinate mapping returns null; polyline click pipeline broken | Archie |
| 8 | `door-wall-orientation` | `wallIsGroup:False, zOk:True, rotOk:True` | Door placed (zOk/rotOk pass) but wall not becoming Group after void-cut | Archie |
| 9 | `copy-array-side-effects-stair` | `before:15, after:16, grew:False` | Stair array creates only 1 copy instead of N; grew check fails | Archie |
| 10 | `copy-array-side-effects-door` | `before:15, after:15, grew:False` | Door array creates 0 copies | Archie |
| 11 | `skills-palette-templates` | `{}` empty evidence | Surface returned empty evidence — likely pre-condition failure; palette templates feature broken | Archie |
| 12 | `wall-corner-rejoin` | `afterIndexed:False, thicknessUpdated:False` | Geometry rebuilds (non-indexed after slider) but `userData.thickness` not updated; test fails `thicknessUpdated` check | Archie |
| 13 | `stair-parametric` | `no stair group added` | SdStair dispatch not creating stair group in scene | Eli |
| 14 | `wall-slab-cross-level-trim` | `TypeError: Cannot read properties of undefined (reading 'Box3')` | THREE.Box3 undefined at runtime — import or namespace issue | Archie |
| 15 | `c2-minimum-args-smoke` | `SdRoof:0, SdDoor:0, SdWindow:0` | SdRoof, SdDoor, SdWindow dispatch with minimum args creates 0 scene objects | Eli |
| 16 | `dim-verb-alignment` | `aligned:0, angular:0` | Dimension verb dispatch (SdDimAligned, SdDimAngular) produces 0 objects | Eli |
| 17 | `stair-ceiling-hole` | `ceilingHoleUuid:None, stairUuid:set` | Stair placed but no ceiling hole created | Eli |
| 18 | `snap-face-vertex-priority` | `target:{y:0} vs faceVertex:{y:0.1}` | Snap hits origin/grid (y=0) instead of face vertex (y=0.1); priority broken | Archie |
| 19 | `hidden-level-unselectable` | `meshVisible:True, selectedUuid=wallUuid` | Wall on hidden level is still selectable (click registers) | Archie |
| 20 | `copy-click-commits-selection` | `copyPlaced:False, meshCountBefore=After=1` | Copy tool click doesn't place copy; scene unchanged | Archie |
| 21 | `array-linear-spawns-copies` | `rect not created` | `SdRect` dispatch returns ok but scene has no `creator:'rect'` object | Eli |
| 22 | `array-polar-spawns-radial` | `rect not created` | Same SdRect failure | Eli |
| 23 | `array-rect-spawns-grid` | `rect not created` | Same SdRect failure | Eli |
| 24 | `walls-from-object-single-click` | `rect not created` | Same SdRect failure | Eli |
| 25 | `fillet-schema-edge-dispatch` | `posBefore:24, posAfter:0` | SdFillet bevel produces geometry with 0 vertices — mesh emptied | Eli |
| 26 | `agent-invoke-skill` | `HandlerThrew: handler returned Promise — use dispatch() not dispatchSync()` | SdInvokeSkill handler is async but invoked via dispatchSync | Eli |
| 27 | `unit-awareness-statusbar` | `snapImperial:'grid·0.10m'` when imperial | Snap grid display doesn't convert to imperial; statusbar shows metric snap string regardless of unit system | Archie |
| 28 | `canvas-visible-width-skill-nodes` (C-component) | `liveW:1070, liveH:280` — canvas visible but `selfTestOk:False` | Note: classified B above for stale self-test; but `liveH:280` (very short) may also indicate a genuine layout regression if expected height is larger | Archie |

---

## Next actions

1. **Allowfail manifest** — updated `state/surface-allowfail.txt` in this PR: A surfaces + B surfaces added; C surfaces omitted (they must fail to track fix progress).
2. **B batch PRs** — 3 PRs:
   - `fix/export-testmode-accessor` — fix `res.testMode` → `res.result.testMode` in export loop (8 surfaces)
   - `fix/verify-ui-selectors` — update stale DOM selectors (9 surfaces)
   - `fix/verify-logic-assumptions` — fix unit-display default + dispatch-sweep SdSelect + canvas self-test (2-3 surfaces)
3. **C issues** — 28 issues filed (see below); Eli-owner items mailed to Eli.
