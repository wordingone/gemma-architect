# Canonical Openings Catalog — FZK-Haus Reference

**Created:** 2026-05-23  
**Owner:** Archie  
**Status:** IFC-verified, one code gap identified (sill height)  
**Issues:** #1567 (umbrella)  
**IFC source:** `web/public/samples/AC20-FZK-Haus.ifc` (ArchiCAD 20, IFC4)

---

## 1. FZK-Haus Door Inventory

### 1.1 Doors (IfcDoor)

| Name | IFC# | Height | Width | Threshold | Depth | Notes |
|---|---|---|---|---|---|---|
| Innentuer-1 (interior) | #17468 | **2.01m** (#17662) | **0.885m** (#17665) | **0.0m** (#17698) | 0.24m (#17654) | Single swing |
| Innentuer-2 (interior) | #19199 | **2.01m** | **0.885m** | 0.0m | 0.24m | Identical to Innentuer-1 |
| Innentuer-3 (interior) | #19504 | **2.01m** | **0.885m** | 0.0m | 0.24m | Identical to Innentuer-1 |
| Haustuer (front door) | #27013 | **2.01m** (#27293) | **1.01m** (#27296) | **0.0m** (#27298) | 0.3m (#27285) | External; 0.1m wider than interior |
| Terrassentuer (terrace) | #31079 | **2.375m** (#31335) | **2.01m** (#31338) | **0.0m** (#31340) | 0.3m (#31327) | Sliding/double; 0.5m fanlight (#31368); frame sill 0.25m (#31375) |

### 1.2 Door Type Summary

| Type | Count | H × W | Use |
|---|---|---|---|
| Interior swing (Innentuer) | 3 | 2.01 × 0.885m | Internal partition doors |
| Front door (Haustuer) | 1 | 2.01 × 1.01m | External main entry |
| Terrace door (Terrassentuer) | 1 | 2.375 × 2.01m | External, sliding/double with fanlight |

All doors: threshold = 0.0m (sill at floor level, no step).

---

## 2. FZK-Haus Window Inventory

### 2.1 Windows (IfcWindow)

| Name | IFC# | Height | Width | Sill (from floor) | Sill (from null) | Floor |
|---|---|---|---|---|---|---|
| EG-Fenster-1 | #32829 | **1.2m** | **2.0m** | **0.8m** (#23241 pattern) | **0.8m** | EG |
| EG-Fenster-2 | #33109 | 1.2m | 2.0m | 0.8m | 0.8m | EG |
| EG-Fenster-3 | #33389 | 1.2m | 2.0m | 0.8m | 0.8m | EG |
| EG-Fenster-4 | #27833 | 1.2m | 2.0m | 0.8m | 0.8m | EG |
| EG-Fenster-5 | #28113 | 1.2m | 2.0m | 0.8m | 0.8m | EG |
| EG-Fenster-6 | #23024 | **1.2m** (#23192) | **2.0m** (#23193) | **0.8m** (#23241) | **0.8m** (#23203) | EG |
| EG-Fenster-7 | #23944 | 1.2m | 2.0m | 0.8m | 0.8m | EG |
| EG-Fenster-8 | #31818 | 1.2m | 2.0m | 0.8m | 0.8m | EG |
| EG-Fenster-9 | #32098 | 1.2m | 2.0m | 0.8m | 0.8m | EG |
| OG-Fenster-1 | #74280 | **1.0m** (#67245) | **1.0m** (#67246) | **0.8m** (#67296) | **3.5m** (#67256) | OG |
| OG-Fenster-2 | #66459 | 1.0m | 1.0m | 0.8m | 3.5m | OG |

### 2.2 Window Type Summary

| Type | Count | H × W | Sill from floor | Top of opening |
|---|---|---|---|---|
| EG ground-floor | 9 | 1.2 × 2.0m | 0.8m | 2.0m (= 0.8 + 1.2) |
| OG upper-floor | 2 | 1.0 × 1.0m | 0.8m (from OG floor) | 1.8m from OG floor |

**Derived: OG floor level = 3.5 − 0.8 = 2.7m above project null.**

All windows: Brüstungshöhe (sill height) = 0.8m above their respective floor. This is consistent across all 11 windows. Sill height is IFC-authoritative from `Brüstungshöhe zum aktuellen Geschoss` fields (#23241, #67296).

---

## 3. Gap Analysis — Current Code vs IFC Reference

### `web/src/tools/openings.ts`

| Constant | Current | IFC reference | Status |
|---|---|---|---|
| `FZK_DOOR_W` = 0.885 | 0.885m | Innentuer-1 width 0.885m (#17665) | ✓ |
| `FZK_DOOR_H` = 2.01 | 2.01m | Innentuer-1 height 2.01m (#17662) | ✓ |
| `FZK_WINDOW_W` = 2.0 | 2.0m | EG-Fenster-6 width 2.0m (#23193) | ✓ |
| `FZK_WINDOW_H` = 1.2 | 1.2m | EG-Fenster-6 height 1.2m (#23192) | ✓ |
| `FZK_WINDOW_SILL` = 0.9 | **0.9m** | Brüstungshöhe = **0.8m** (#23241) | ❌ 10cm off |

**No separate constants for:**
- Haustuer: 2.01 × 1.01m (= interior height + 0.125m wider)
- Terrassentuer: 2.375 × 2.01m (= non-standard height; double/sliding type)
- OG windows: 1.0 × 1.0m (square, half-size of EG)

### `buildWindow()` sill placement

`buildWindow()` at `openings.ts:321–324` uses `FZK_WINDOW_SILL = 0.9`. The IFC value is `0.8m`. The mesh z-position is set from sill height, so the window center is placed 10cm too high in the default FZK scene.

---

## 4. Required Code Fix

### `web/src/tools/openings.ts`

| Line | Change |
|---|---|
| 16 | `FZK_WINDOW_SILL = 0.9` → `FZK_WINDOW_SILL = 0.8` |

One-line fix. The `buildWindow()` function at line 324 reads `const sill = FZK_WINDOW_SILL;` — no further change needed.

---

## 5. What the Current Code Already Gets Right

- `FZK_DOOR_W` / `FZK_DOOR_H` — IFC-confirmed interior door dimensions ✓
- `FZK_WINDOW_W` / `FZK_WINDOW_H` — IFC-confirmed EG window size ✓
- Door threshold at floor level (no step modeled) ✓
- Void-cut logic inserts doors/windows into host walls ✓
- Auto-nearest-wall for placement (§#1516, #1545) ✓

---

## 6. Acceptance Criterion (S-surface — sill fix)

After `FZK_WINDOW_SILL = 0.8`:
- `buildWindow()` produces window bottom (sill) at z = 0.8m above floor elevation
- Top of window at z = 0.8 + 1.2 = 2.0m — within clear-height of 2.01m interior doors ✓
- Assert: for a window placed on a wall with active level at z=0, `mesh.position.z ≈ 0.8 + 1.2/2 = 1.4m` (center of window)

---

## 7. EXACT-FZK Visual Gate — Sharpened W1–W4 Assertion Suite

These assertions are for a `/visual-check` pass after sill fix lands. Scene should contain 1 EG window and 1 EG door placed on the south wall of a 12 × 10m FZK footprint wall.

**Canonical camera:** SE 3/4 orbit (same as V1-V5: `(1, -1, 1.5).normalize()` direction), full south facade visible.

---

### Consolidated single-pass invocation

```
/visual-check --current "Answer YES or NO for each of the following four checks on the
rendered building facade scene. Return your answers as a JSON object plus evidence for any NO.

W1 (EG window proportions): Is the ground-floor window clearly wider than it is tall, with
approximate 2:1.2 width-to-height ratio (landscape orientation)?

W2 (window sill placement): Is the bottom of the window opening elevated above the floor
line — specifically, does the window bottom appear to be approximately 0.8m above the wall
base (roughly 40% of the 2m clear wall height before the window starts)?

W3 (door proportions): Is the door clearly taller than wide, with approximate 2:1 height-to-
width ratio (portrait orientation, height ≈ 2× width)?

W4 (door threshold): Does the door opening start at the base of the wall — no visible gap
or sill between the floor line and the bottom of the door frame?

FZK reference: EG window 2.0m wide × 1.2m tall, sill at 0.8m (top at 2.0m); interior door
2.01m tall × 0.885m wide, threshold 0.0m (at floor level).

Respond: {\"W1\": \"YES|NO\", \"W2\": \"YES|NO\", \"W3\": \"YES|NO\", \"W4\": \"YES|NO\",
\"evidence\": {\"W1\": \"...\", \"W2\": \"...\", \"W3\": \"...\", \"W4\": \"...\"}}"
```

Pass = all four YES. Any NO triggers a granular issue per surface.

---

### W1 — EG Window proportions (2.0 × 1.2m)

**CORRECT:** Landscape rectangle; width clearly exceeds height; roughly 5:3 ratio.  
**DEFECTIVE:** Window appears square or portrait; or too narrow (< 1.5m apparent width at wall scale).

### W2 — Window sill at 0.8m

**CORRECT:** Window bottom is visibly elevated from the floor line by approximately 40% of wall height before reaching the sill; a spandrel panel is visible below.  
**DEFECTIVE:** Window starts at or near floor level (sill = 0); or window center is at ceiling level (over-elevated, sill ≫ 1.0m).

### W3 — Door proportions (2.01 × 0.885m)

**CORRECT:** Portrait rectangle; height clearly exceeds width; approximately 2:1 height-to-width.  
**DEFECTIVE:** Door appears square or landscape; or wider than the window (door must be narrower than the 2.0m window).

### W4 — Door threshold at floor

**CORRECT:** Door bottom aligns with wall base; no visible spandrel/sill below door.  
**DEFECTIVE:** Door appears elevated above floor level; or a solid panel below the door opening is visible.

---

## 8. Extended Visual Gate — W5–W7 (SDK gap pre-stage, #1611)

These require `doorType`/`windowType` params from PR #1611. Add to the §7 consolidated `/visual-check` call after #1611 merges.

### W5 — Front door wider than interior door

**Question:** Is the front door (Haustuer) visibly wider than the interior doors — approximately 1.01m vs 0.885m, a ~14% width difference?

**DSL to produce scene:** `SdDoor doorType=front` + `SdDoor doorType=interior` side by side on south wall.

**CORRECT:** Two portrait-rectangle doors; front door noticeably wider.  
**DEFECTIVE:** Both doors same apparent width; or front door narrower.

### W6 — Terrace door clearly larger

**Question:** Is the terrace door (Terrassentuer) clearly wider and taller than the front door — approximately 2.01×2.375m vs 1.01×2.01m?

**DSL to produce scene:** `SdDoor doorType=terrace` on south wall.

**CORRECT:** Significantly wider door with total height ≈2.375m; a tall double or sliding panel.  
**DEFECTIVE:** Terrace door similar size to front door; or fanlight not present.

### W7 — OG window square vs EG window landscape

**Question:** Is the upper-floor window (OG-Fenster) square (1:1 ratio) in clear contrast to the ground-floor window's landscape (2:1.2) shape?

**DSL to produce scene:** `SdWindow windowType=og` above `SdWindow windowType=eg` on same wall.

**CORRECT:** OG window clearly square; EG window clearly wider; both sills at 0.8m above their floor level.  
**DEFECTIVE:** Both windows same shape; or OG window appears landscape.

---

## 9. Stair Note

FZK-Haus has one stair entity: `#14502 IFCSTAIR 'Wendeltreppe'` (spiral stair). Its IFC property sets report all riser/tread/width values as 0 — ArchiCAD GDL export did not propagate discrete flight parameters. Only available dimensions: overall height = 2.0m (#14954), surface area 7.69m² (#14951), volume 0.208m³ (#14952). **Not suitable for a dimensional gate** — no flight-level data in the IFC.
