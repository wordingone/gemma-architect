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

## 4. Current `buildRoof` Gap Analysis

`buildRoof` pitched branch: `web/src/tools/structural.ts:1005–1147`

| Parameter | Current builder | FZK reference | Status |
|---|---|---|---|
| Default pitchDeg | **31°** (`params.pitchDeg ?? 31` at line 817) | **30°** | ❌ WRONG — 1° error |
| Comment at line 816 | "~31.4° pitch" | Actually 30° | ❌ stale comment |
| Ridge beam dimensions | `ridgeLenHalf×2, 0.10, 0.12` (100mm×120mm) | 80mm×160mm | ❌ wrong cross-section |
| Ridge beam position | `rH − 0.06` (inside sheathing) | apex | ✓ structurally correct |
| Wall plates (wp1, wp2) | `0.10, 0.10` cross-section at spanHalf | Pfette: 80mm×160mm at eave | ❌ wrong section; structurally ~correct position |
| Wall plate ifcClass | none set | IfcBeam (Pfette) | ❌ missing |
| Rafters | 80mm×150mm, 0.65m spacing | Sparren (IfcMember), not in beam catalog | ✓ functionally present |
| Sheathing panels | 25mm BoxGeometry | Dach slab 200mm | ❌ too thin (display only, not structural) |
| Overhang | 0.5m default | 0.5m | ✓ |
| Eave purlin vs wall plate | wall plates only | Pfette-1-1/2-1 at eave | ❌ no separate Pfette entity |

### Summary of required changes

1. **Fix default pitch: 31 → 30** at `structural.ts:817`
2. **Fix stale comment** at line 816
3. **Correct ridge beam cross-section**: `0.10, 0.12` → `0.08, 0.16`
4. **Correct wall plate cross-section**: `0.10, 0.10` → `0.08, 0.16`
5. **Add ifcClass on wall plates**: `wp1.userData.ifcClass = "IfcBeam"` (Pfette equivalent)
6. **SdRoof handler default pitchDeg**: `main.ts:1173` — currently `?? 31`, fix to `?? 30`

---

## 5. Code Paths to Update

### `web/src/tools/structural.ts`

| Line | Change |
|---|---|
| 816 | Update comment: remove "~31.4°", replace with "30° from IFCPLANEANGLEMEASURE(30.) on Dach-1/Dach-2" |
| 817 | `params.pitchDeg ?? 31` → `params.pitchDeg ?? 30` |
| 1031 | ridgeBeam second arg `0.10` → `0.08` |
| 1031 | ridgeBeam third arg `0.12` → `0.16` |
| 1039–1047 | wall plate member args `0.10, 0.10` → `0.08, 0.16`; add `wp1.userData.ifcClass = "IfcBeam"` and `wp2.userData.ifcClass = "IfcBeam"` |

### `web/src/main.ts`

| Line | Change |
|---|---|
| 1173 | `?? (args.pitchAngleDeg as number | undefined) ?? 31` → `?? 30` |

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
