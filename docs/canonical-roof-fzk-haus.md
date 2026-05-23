# Canonical Roof Catalog — FZK-Haus Reference

**Created:** 2026-05-22  
**Owner:** Archie  
**Status:** Complete — IFC-verified, code gaps identified  
**Issues:** #1553 (umbrella)  
**IFC source:** `web/public/samples/AC20-FZK-Haus.ifc` (ArchiCAD 20, IFC4)

---

## 1. FZK-Haus Roof Element Inventory

### 1.1 Slabs (IfcSlab, type=ROOF)

| Name | IFC# | Pitch | Eave z (project null) | GrossArea | Plan area (horiz proj) | Perimeter | Thickness |
|---|---|---|---|---|---|---|---|
| Dach-1 (south slope) | #59553 | **30°** (`IFCPLANEANGLEMEASURE(30.)` at #59605) | **3.2m** (#59651) | **82.56m²** (#59642) | **71.5m²** (#59656) | **38.7m** (#59641) | 0.2m (#59640) |
| Dach-2 (north slope) | #59753 | **30°** (`IFCPLANEANGLEMEASURE(30.)` at #59805) | 3.2m | 82.56m² | 71.5m² | 38.7m | 0.2m |

### 1.2 Beams (IfcBeam)

| Name | IFC# | Role | Length | Section (W × D) | Height above project null | Notes |
|---|---|---|---|---|---|---|
| First (ridge) | #40539 | Ridge beam | **13.0m** (#40532 bbox) | **80mm × 160mm** | **6.087m** (#40614) | `Dachgeschoss`, `Dachkonstruktion`, horizontal, slope=0° |
| Pfette-1-1 (south eave) | #40416 | Eave/foot purlin | **13.0m** (#40497) | **80mm × 160mm** | **3.36m** (#40491) | At eave level, horizontal |
| Pfette-2-1 (north eave) | #37582 | Eave/foot purlin | **13.0m** (#37663) | **80mm × 160mm** | **3.36m** (#37657) | At eave level, horizontal |
| Unterzug-1 | #20374 | Floor support beam (NOT a roof rafter) | varies | 200mm × 240mm | 0° slope | Ground floor element, unrelated to roof assembly |

---

## 2. Derived Building Dimensions

From IFC quantities (verified, not estimated):

| Dimension | Source | Value |
|---|---|---|
| Ridge length (E-W, incl. gable overhangs) | First beam length | 13.0m |
| Half-span at eave (incl. 0.5m overhang) | Plan area ÷ ridge length = 71.5 ÷ 13.0 | **5.5m** |
| Building depth wall-to-wall (N-S) | 2 × 5.5 − 2 × 0.5 overhang | **10.0m** |
| Building length wall-to-wall (E-W) | 13.0 − 2 × 0.5 overhang | **12.0m** |
| Ridge rise above eave | 5.5 × tan(30°) | **3.175m** |
| Ridge height above project null | 3.2 + 3.175 | **6.375m** |
| Eave purlin height | Pfette-1-1 Höhenangabe | 3.36m (eave level + beam height) |

> **Note on First beam 'Höhenangabe' = 6.087m:** This value is ~0.29m below the derived 6.375m.
> Likely source: ArchiCAD reports the beam INSERT POINT, not the centroid/top; or the parent storey coordinate has a z-offset not yet resolved. The `Fläche` (plan area = 71.5m²) is the authoritative footprint source — it is directly reported, not inferred from placement.

---

## 3. Rafter Parameters (derived)

| Parameter | Formula | Value |
|---|---|---|
| Pitch | IFC Neigung | **30°** |
| Span half (to eave edge incl. overhang) | derived | **5.5m** |
| Rafter length (slope distance) | 5.5 ÷ cos(30°) | **6.351m** |
| Slope surface area (one panel) | 13.0 × 6.351 | **82.56m²** ✓ matches IFC GrossArea |
| Ridge rise | 5.5 × tan(30°) | **3.175m** |

---

## 4. `buildRoof` Gap Analysis — Current State (master, 2026-05-23)

`buildRoof` pitched branch: `web/src/tools/structural.ts:1005–1170`

| Parameter | Current builder | FZK reference | Status |
|---|---|---|---|
| Default pitchDeg | 30° | 30° | ✓ fixed (PRs #1592/#1610) |
| Ridge beam dimensions | 80mm × 160mm | 80mm × 160mm | ✓ fixed (PR #1610) |
| Ridge beam position | apex | apex | ✓ |
| Eave purlins (Pfette) | 80mm×160mm at eave edge, `IfcBeam` | 80mm×160mm at eave level, `IfcBeam` | ✓ class + section correct; position at eave (not FZK mid-slope — deferred to #1639 §B) |
| Rafters | `IfcMember`, 80mm×150mm, ~0.65m spacing | `IfcMember` Sparren, 21/slope | ✓ class correct; count differs slightly |
| Slope deck slab | 200mm `IfcSlab` "Dach" × 2 | 200mm `IfcSlab` "Dach" × 2 | ✓ thickness + class match FZK (#1639-E) |
| Gable triangles | none (removed PR #1653) | none (wall auto-trim provides face) | ✓ |
| Overhang | 0.5m default | 0.5m | ✓ |
| Fascia/soffit | `IfcCovering` × 4 | none in FZK dump | △ extra; visual benefit outweighs IFC purity |

### Remaining gaps vs FZK (decided — no code change)

- **§B — Pfette enclosure** (**Scope A — keep at eave edge**): FZK Pfette sits inside Dach slab Y-volume (mid-slope), but placing them there makes them invisible (inside solid slab geometry). Decision: keep at eave edge (`pfetteInset=0`) for viewport visibility. IFC-accuracy at mid-slope deferred until #1675 fixture gate defines canonical containment assertion. Tracked in #1671.
- **§D — IfcCovering strips** (**keep — visual quality over IFC purity**): 4 fascia/soffit IfcCovering pieces not in FZK dump, but they provide clean eave/gable closure in the viewport. Removing them would leave raw slope-edge geometry visible at the eave. Decision: retain until #1675 fixture gate either codifies them as canonical or explicitly excludes them.
- **§E — Sparren count**: 23/slope vs FZK 21/slope. Minor; not blocking. No change.

---

## 5. Completed Code Changes (as of master 2026-05-23)

All items from the original §5 have shipped:

| Item | PR | Status |
|---|---|---|
| `pitchDeg ?? 31` → `?? 30` (structural.ts + main.ts) | #1592/#1610 | ✓ merged |
| Ridge beam 80×160mm cross-section | #1610 | ✓ merged |
| Wall plates 80×160mm + `IfcBeam` class | #1641 | ✓ merged |
| Slope deck promoted to `IfcSlab` "Dach" 150mm | #1641 | ✓ merged |
| Slope deck thickness 150mm → 200mm (FZK match) | #1639-E | ✓ this PR |
| Redundant gable triangle pair removed | #1653 | ✓ merged |

---

## 6. Acceptance Criteria (S143 surface)

After fix, `SdRoof({type:'gable', pitchDeg:30, footprint:[[-6,-5],[6,5]], overhang:0.5})` must produce:
- Ridge beam at z ≈ 3.175m above eave (within 2%)
- Slope surface area ≈ 82.56m² (within 2% for 12×10m footprint; 13.0 × 6.351 = 82.56m²) ✓ by construction
- Ridge beam cross-section: 80mm × 160mm
- Eave purlins (wall plates): 80mm × 160mm at z = 0 (eave level, relative to roof group origin)

---

## 7. What buildRoof already does correctly

- Landscape orientation detection (w ≥ d) ✓
- Ridge runs along longer axis ✓
- Sheathing (Dach equivalent) at correct pitch ✓
- Rafters at 0.65m on-centre spacing ✓  
- Centroid anchor at (cx, cy, activeLevelElev + eaveOffset) ✓
- Overhang included in span half ✓
- gable-trim logic in SdRoof handler auto-trims short-end walls to match pitch ✓

---

## 8. EXACT-FZK Visual Gate — Sharpened V1–V5 Assertion Suite

These assertions are for the `/visual-check` pass Leo runs after cold-cache BASELINE Phase J
completes. Each maps to an IFC-verified FZK-Haus parameter and is phrased as a yes/no question
Haiku can answer from a canvas crop alone.

**Canonical camera angle:** South-east 3/4 orbit, full roof visible, at least one gable end visible.

---

### Consolidated single-pass invocation

All five criteria run in ONE `/visual-check` call. Include the FZK reference block at the end.

```
/visual-check --current "Answer YES or NO for each of the following five checks on the
rendered building scene. Return your answers as a JSON object plus evidence for any NO.

V1 (pitch + gable): Are both roof slope panels symmetric, meeting at a continuous horizontal
ridge, with solid triangular gable profiles visible at BOTH short ends of the building?

V2 (ridge beam): Is there a distinct structural member (a beam, not just the ridge edge of
the sheathing) visible at the roof apex, running the full length of the building?

V3 (eave purlins): Are there two distinct horizontal structural members visible at eave level,
one on each of the two long-side eaves (south and north)?

V4 (slope coverage): Do both slope panels fully cover the building from ridge to eave with no
black or void gaps on either slope surface?

V5 (gable trim position): Are the triangular gable-end shapes located AT or ABOVE the base of
the building walls — NOT below the building base or ground slab?

FZK reference: pitch=30°, ridge 3.175m above eave, eave at 3.2m, ridge beam 80×160mm spanning
13.0m, eave purlins 80×160mm at eave level, slope panels each 82.56m² (13.0×6.351m).

Respond: {\"V1\": \"YES|NO\", \"V2\": \"YES|NO\", \"V3\": \"YES|NO\", \"V4\": \"YES|NO\",
\"V5\": \"YES|NO\", \"evidence\": {\"V1\": \"...\", ...}}"
```

Pass = all five YES. Any NO triggers the failure→issue mapping below.

---

### V1 — Pitch geometry + gable profiles (30°)

**Question:** Are both roof slope panels symmetric, meeting at a continuous horizontal ridge, with triangular gable profiles at both short sides?

**CORRECT:** Two matched slope panels; gable ends are solid triangles (not rectangular); ridge is horizontal and centered; moderate slope steepness (~30° — ridge rise roughly equal to half-span).

**DEFECTIVE:** Short-side walls appear rectangular (flat tops, no triangle); one slope taller/shorter than the other; or ridge is angled rather than horizontal.

---

### V2 — Ridge beam at apex (First, 80×160mm, 13.0m)

**Question:** Is a distinct structural member visible at the roof apex — separate from the sheathing surface, running the full building length?

**CORRECT:** A darker or distinctly colored horizontal bar at the ridge line, spanning the full E-W length, reading as a separate element from the sheathing panels.

**DEFECTIVE:** Apex is a clean geometric fold with no separate element; or gap/split at ridge center; or beam terminates short of the gable ends.

---

### V3 — Eave purlins on both long sides (Pfette-1-1, Pfette-2-1, 80×160mm)

**Question:** Are two distinct horizontal structural members visible at eave level, one on each long-side eave?

**CORRECT:** Two horizontal bars where slope panels meet the tops of the long-side walls; same material/color as ridge beam; one on south eave, one on north eave.

**DEFECTIVE:** Eave line is a sharp clean edge with no distinct element; or only one purlin visible; or eave is flush/invisible (no beam visible at wall–roof junction).

---

### V4 — Slope panel coverage (Dach-1, Dach-2, each 82.56m²)

**Question:** Do both slope panels fully cover the building from ridge to eave with no black or void gaps?

**CORRECT:** Both panels solid and uniformly textured; no black voids or dark triangular gaps anywhere on either slope; panels reach the gable ends cleanly.

**DEFECTIVE:** Dark triangular voids between slope panels and gable ends; black gap along ridge line; or one panel clipped before reaching the eave.

---

### V5 — Gable trim position (Wand-Ext-OG east/west, userData.topProfile='pitched')

**Question:** Are the triangular gable-end shapes AT or ABOVE the building base — NOT below the ground slab?

**CORRECT:** Triangular gable shapes at the TOP of the gable-end walls, apex at ridge height, base at eave height. The triangles cap the rectangular lower walls, sealing the wall–roof junction above.

**DEFECTIVE (known #1566 variant):** Triangular dark shapes visible BELOW the ground slab or at the bottom of the building. The gable trim Y-origin is shifted negative — triangles appear as dangling shadows beneath the building rather than capping the top.

> Cross-ref: #1566 — [BUG] Gable trim positioned below ground slab (negative Y).
> Observed in the wild on ef55795 warm-cache T1 build (2026-05-23).
> Fix scope: `buildRoof` gable-trim Y-origin in `web/src/tools/structural.ts`; owner Eli.

---

### Reference FZK parameters

```
FZK reference: pitch=30°, ridge at 3.175m above eave, eave at 3.2m,
ridge beam 80×160mm cross-section spanning 13.0m, eave purlins 80×160mm at eave level,
south+north slope panels each 82.56m² (13.0m × 6.351m surface distance).
```

---

### Failure scenarios → follow-up issues

| Failure | File issue | Root cause hypothesis |
|---|---|---|
| V1: asymmetric slopes or no gable triangles | New issue: pitch geometry regression | `buildRoof` pitchDeg override or SdRoof handler default reverted |
| V2: ridge absent or split | New issue: ridge beam absent | `params.showStructure` false default or beam hidden by material |
| V3: purlins missing at eave | New issue: eave purlins absent | wall-plate (`wp1/wp2`) visibility or removed in rebase |
| V4: gap in slope panels | New issue: sheathing geometry gap | rotation math regression in `sheathA/sheathB` |
| V5: gable trim below ground | #1566 (open) | `buildRoof` gable-trim Y-origin negative — owner Eli |
| V5: gable trim absent | New issue: gable trim regression | `userData.topProfile` check broken (see PRs #1066, #1165) |
