# Canonical Demo Acceptance Criteria — FZK-Haus Reference

**Created:** 2026-05-22  
**Owner:** Archie  
**Status:** Draft — pending Leo review  
**Issues:** #1550 (umbrella), #1551, #1553

---

## Reference building

**KIT FZK-Haus** (`web/public/samples/AC20-FZK-Haus.ifc`, ArchiCAD 20, IFC4)  
A two-story residential building by the Karlsruhe Institute of Technology. Used as the canonical geometric reference for all demo acceptance criteria.

### FZK-Haus element inventory (from IFC)

| Element class | Count | Names / notes |
|---|---|---|
| `IfcWallStandardCase` | 13 | 4 L0 ext (`Wand-Ext-ERDG-1/2/3/4`), 5 L0 int partitions (`Wand-Int-ERDG-1/2/3/4/5`), 4 OG ext (`Wand-Ext-OG-1/2/3/4`) |
| `IfcSlab` | 4 (instances) | `Bodenplatte` (ground floor), `Slab-033` (intermediate floor), `Dach-1` (roof panel south slope), `Dach-2` (roof panel north slope) |
| `IfcBeam` | 4 (instances) | `First` (ridge beam), `Pfette-1-1` (purlin), `Pfette-2-1` (purlin), `Unterzug-1` (rafter/down-beam) |
| `IfcWindow` | 9 (instances) | Multiple per floor |
| `IfcDoor` | 3 (instances) | Ground floor |
| `IfcOpeningElement` | 17 | Wall void cutouts |
| `IfcStair` | 1 | Interior stair |

---

## Defect classes

Each class has: reference behavior (FZK cite), current observed behavior (CDP eval 2026-05-22 23:29Z), acceptance criterion, gemma-verify surface ID, root-cause hypothesis, filed issue.

---

### D1 — L2 window voids missing

| Field | Value |
|---|---|
| **Reference** | FZK OG walls: `Wand-Ext-OG-1/2/3/4` each contain `IfcOpeningElement` voids for windows. Wall has penetrations visible in cross-section. |
| **Current** | 4 L2 walls all `type=Mesh, cuts=0` in CDP eval. Zero void cuts. L2 windows placed but all voids punched into L0 walls (level-tie XY bug). |
| **Acceptance** | Post-demo, every L2 exterior wall (`levelId=level/1`) must be `type=Group` (i.e. `cutHistory.length >= 1`). |
| **Verify surface** | S136 — see §Verify Surfaces |
| **Root cause** | Single-pass XY auto-find in `SdWindow` always picked L0 wall when L0 and L2 walls share identical XY center (insertion-order bias). |
| **Issue** | #1545 — **FIXED** by PR #1552 (2026-05-22). S134 surface added. |

---

### D2 — Zero-width corner walls (effectively invisible)

| Field | Value |
|---|---|
| **Reference** | FZK-Haus has no corner-cap walls. The 4 exterior walls close the rectangle cleanly at shared corner endpoints. |
| **Current** | 4 walls found with `bboxX=0.01m` (10mm) at positions [7.92, 0.91, -0.3], [7.92, 6.1, 0], [0, 0, 0], [0, 6.1, 0]. One wall has `position.z=-0.3` (below grade). All `type=Mesh, cuts=0, visible=true`. All render as invisible slivers. |
| **Acceptance** | No wall in scene has `bbox.x < 0.5m AND bbox.y < 0.5m` (i.e. both horizontal extents degenerate). Minimum wall width 0.5m per axis. |
| **Verify surface** | S137 — see §Verify Surfaces |
| **Root cause** | Model emits corner-filler SdWall calls with start==end (or near-zero-length segment). Wall builder does not reject below-minimum-length walls. Handler needs a minimum-length guard (~0.5m). |
| **Issue** | New — file as #1554 |

---

### D3 — Interior partition walls absent

| Field | Value |
|---|---|
| **Reference** | FZK-Haus has 5 interior partition walls on ground floor (`Wand-Int-ERDG-1/2/3/4/5`). These subdivide the interior into rooms. |
| **Current** | 0 interior partition walls in scene. All 14 walls are exterior or perimeter walls. |
| **Acceptance** | Post-demo build of two-story house, scene must contain ≥ 1 interior wall (`userData.creator==='wall'` AND position is NOT on the perimeter bbox of the building footprint). |
| **Verify surface** | S140 — see §Verify Surfaces |
| **Root cause** | Demo prompt does not instruct model to emit interior partition walls. Model omits them entirely. Either prompt needs interior-wall instructions or SdRoom decomposition is needed. |
| **Issue** | New — file as #1555 |

---

### D4 — Intermediate floor slab absent

| Field | Value |
|---|---|
| **Reference** | FZK-Haus has `Slab-033` as the intermediate floor between L0 and OG. It is a horizontal slab spanning the full footprint at OG base elevation. |
| **Current** | Scene has 3 slabs (from `sceneSummary.slab=3`). No CDP confirmation of which level each covers. Likely: L0 floor + 2 roof panels, missing the L1/L2 intermediate floor. |
| **Acceptance** | Scene must contain at least 1 slab at OG base elevation (z ≈ 2.74m in FZK-Haus) with horizontal extent matching house footprint (~7.9m × 6.1m). |
| **Verify surface** | S138 — see §Verify Surfaces |
| **Root cause** | Demo prompt may not instruct model to place an intermediate floor slab. SdSlab handler exists but model omits this dispatch. |
| **Issue** | New — file as #1556 |

---

### D5 — Structural roof beams absent

| Field | Value |
|---|---|
| **Reference** | FZK-Haus has 4 roof beams: ridge beam (`First`), 2 purlins (`Pfette-1-1`, `Pfette-2-1`), 1 rafter (`Unterzug-1`). These are structural elements under the roof panels. |
| **Current** | Scene has `roof: 1` (single SdRoof object with 39 segments per Eli eval). No separate beam objects visible in `sceneSummary`. |
| **Acceptance** | SdRoof emitting a gable roof should also emit: 1 ridge beam, 2+ purlins, visible as distinct geometry or as named sub-components of the roof Group. |
| **Verify surface** | S139 — see §Verify Surfaces |
| **Root cause** | SdRoof builder generates the roof surface but does not spawn beam sub-components. Beam emission requires separate handler calls or SdRoof handler to auto-spawn beams. |
| **Issue** | #1553 — Roof parametric EXACTLY recreates FZK-Haus |

---

### D6 — Garden wall height anomaly

| Field | Value |
|---|---|
| **Reference** | FZK-Haus does not have an explicit garden/boundary wall in the IFC. A garden wall in context should be ~1.0–1.8m high (knee-height to eye-level boundary). |
| **Current** | Garden wall at [0, 1.83, 0], `bbox=[3.66×0.2×0.3]`. Height 0.3m = 30cm. Visually this is a curb-height element, not a boundary wall. |
| **Acceptance** | Garden wall height ≥ 0.8m. |
| **Verify surface** | S141 — see §Verify Surfaces |
| **Root cause** | SdWall handler or demo prompt passes incorrect height parameter (0.3m instead of 1.2–1.8m) for garden boundary. Possible schema default being applied. |
| **Issue** | New — file as #1557 |

---

### D7 — Wall-roof gable trim status unknown

| Field | Value |
|---|---|
| **Reference** | FZK-Haus gable end walls (OG east and west) follow the roof pitch — the wall top is angled to match the roof slope, not a flat rectangular top. |
| **Current** | Eli running CDP eval for `cutHistory` gable-trim entries on L2 walls (BROWSER LOCKED 2026-05-22 23:33Z). Status unknown pending eval. |
| **Acceptance** | L2 east and west walls must have `cutHistory` entry with `type='gable_trim'`. Visually the wall top matches roof slope angle. |
| **Verify surface** | S135 (existing in gemma-verify-raw.mjs) or new S142 |
| **Root cause** | Previous impl in PR #916 (8a1eb95). Potential regression post-#1544. Eli owns eval + fix if regressed. |
| **Issue** | #1549 — regression-check (Eli leads) |

---

### D8 — Roof parametric output does not match FZK exactly

| Field | Value |
|---|---|
| **Reference** | FZK-Haus roof: 2 pitched slabs (Dach-1, Dach-2), gable orientation NS, pitch ~38° (estimated from IFC geometry), ridge beam at apex, 2 purlins per slope, eave overhang. |
| **Current** | SdRoof emits 39-segment mesh. Specific geometry parameters (pitch angle, ridge height, overhang) not yet audited against IFC reference. User: "significant disparity, zero room for deviance." |
| **Acceptance** | SdRoof with `{type:'gable', span:7.92, length:6.1, pitch:38}` must produce geometry matching FZK roof within 2% dimensional tolerance (ridge height, eave length, slope surface area). |
| **Verify surface** | S143 — see §Verify Surfaces |
| **Root cause** | Parametric builder may use approximated parameters. Exact FZK pitch angle, ridge height, overhang not extracted from IFC and fed into builder. |
| **Issue** | #1553 — paired Archie + Eli |

---

## Verify surfaces

New surfaces to add to `scripts/gemma-verify-raw.mjs`. These are the canonical test surfaces; each references the defect class it covers.

### S135 — L0 exterior wall count = 4, all Group

```js
// Pass: exactly 4 L0 exterior walls exist in scene, all type=Group (void-cut), all visible.
// Covers: basic wall scaffold correctness for demo output.
```
Assertion: after SdWall×4, `walls.filter(w=>w.levelId==='level/0'&&w.type==='Group').length === 4`.

### S136 — L2 exterior walls have void cuts (D1 acceptance)

```js
// Pass: all L2 walls are type=Group AND cutHistory.length >= 1.
// Covers D1 — level-aware host-find fix (#1552).
```
Assertion: after SdWall×4 at L2 + SdWindow per wall, each L2 wall must be `type=Group`.

### S137 — No zero-width walls in scene (D2 acceptance)

```js
// Pass: no wall has both bboxX < 0.5m AND bboxY < 0.5m.
// Covers D2 — corner filler zero-width walls.
```
Assertion: after demo prompt build, `walls.every(w => w.bboxX >= 0.5 || w.bboxY >= 0.5)`.

### S138 — Intermediate floor slab present (D4 acceptance)

```js
// Pass: at least 1 slab exists at z ≈ 2.74m with horizontal extent >= 6m × 5m.
// Covers D4 — Slab-033 equivalent.
```
Assertion: `slabs.some(s => s.pos.z >= 2.5 && s.bboxX >= 6 && s.bboxY >= 5)`.

### S139 — Roof beam sub-components present (D5 acceptance)

```js
// Pass: scene contains at least 1 SdBeam or equivalent with userData.creator==='beam'
// AND it is positioned near roof apex (z >= wall_height).
// Covers D5 — structural roof beams.
```
Assertion: `beams.filter(b=>b.pos.z >= 2.5).length >= 1`.

### S140 — Interior partition walls present (D3 acceptance)

```js
// Pass: at least 1 wall exists whose XY center is NOT on the building perimeter
// (not on the bbox boundary within 0.5m tolerance).
// Covers D3 — missing interior partitions.
```
Assertion: `walls.some(w => !isOnPerimeter(w.pos, footprintBbox, 0.5))`.

### S141 — Garden wall height >= 0.8m (D6 acceptance)

```js
// Pass: if any wall with userData.layerId matching 'garden' or height < 1.0m exists,
// its Z bbox (height) must be >= 0.8m.
// Covers D6 — garden wall 30cm height bug.
```
Assertion: `gardenWalls.every(w => w.bboxZ >= 0.8)`.

### S143 — SdRoof gable pitch within 2% of FZK reference (D8 acceptance)

```js
// FZK-Haus reference: span 7.92m, length 6.1m, ridge height ~3.16m above OG floor
// (= 2.74 + ~2.05m pitch rise for ~28° pitch on 7.92m span).
// Pass: SdRoof with FZK params produces mesh with max Z within 5% of expected ridge height.
// Covers D8 — roof parametric exact match.
```

---

## Acceptance gate

This document IS the canonical product-layer gate criterion for BASELINE. A demo run is considered BASELINE-passing when:

1. All S135–S143 surfaces PASS in gemma-verify-raw.mjs
2. No wall has zero-width geometry (S137)
3. L2 window voids present (S136)
4. Intermediate floor present (S138)
5. ≥1 roof beam present (S139)

Partial credit milestones:
- **MVP**: D1 fixed (S136 green) + D2 fixed (S137 green)
- **Phase 2**: D3–D5 green (interior walls, floor, beams)
- **EXACT**: D8 green (roof matches FZK within 2%)

---

## Evidence

CDP eval on scene at 2026-05-22 23:29Z (post-Phase J, pre-#1552 rerun):

```
wallCount: 14
L0 Group walls: 4 (cuts 2-3 each)
L2 Mesh walls: 4 (cuts=0, BUG — fixed by #1552)
Zero-width walls: 4 (bboxX=0.01m at corners)
Garden wall: 1 (bboxZ=0.3m, ANOMALY)
Extra L0 wall: 1 (garage south wall, [9.45, 6.1, 0])
sceneSummary: {slab:3, door:2, window:8, roof:1, stair:1, IfcLevel:5}
```

FZK-Haus IFC element count (parsed from `AC20-FZK-Haus.ifc`):
```
IfcWallStandardCase: 13 (4+5+4)
IfcSlab: 7 STEP entries (4 distinct: Bodenplatte, Slab-033, Dach-1, Dach-2)
IfcBeam: 6 STEP entries (4 distinct: First, Pfette-1-1, Pfette-2-1, Unterzug-1)
IfcOpeningElement: 17
IfcWindow: 22 STEP entries (~9 instances)
IfcDoor: 19 STEP entries (~3 instances)
IfcStair: 1
```
