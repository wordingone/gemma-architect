# Agent-vs-Palette Parity Audit

Reviewed: 2026-05-17  
Scope: all `registerHandler(verb, …)` blocks in `web/src/main.ts` vs palette builders in `web/src/tools/structural.ts`, `web/src/tools/sketch.ts`, `web/src/tools/openings.ts`

## Summary

| Status | Count | Verbs |
|--------|-------|-------|
| PARITY OK | 16 | SdWall, SdSlab, SdColumn, SdBeam, SdStair, SdDoor, SdWindow, SdRoof, SdSpace, SdFoundation, SdCeiling, SdCurtainWall, SdSkylight, SdOpening, SdRamp, SdRailing |
| DIVERGED → FIXED | 3 | SdBox, SdExtrude, SdReferenceLine |
| AGENT-SUPERSET | 1 | SdLevel |
| AGENT-ONLY | 8 | SdMember, SdPlate, SdSphere, SdCylinder, SdCone, SdDatum, SdFurnishing, SdRefGrid |

---

## PARITY OK

These handlers call the palette builder and wire all required userData (chain, layerId, levelId, dispatchArgs, onElementCommitted):

- **SdWall** → `buildWall(a, b)` — endpoints, wall mesh + chain
- **SdSlab** → `buildSlab(a, b)` — width × depth slab
- **SdColumn** → `buildColumn(p)` — point placement
- **SdBeam** → `buildBeam(a, b)` — span endpoints
- **SdStair** → `buildStair(a, b)` — stair run
- **SdDoor** → `buildDoor(p)` + void-cut — opening + CSG void
- **SdWindow** → `buildWindow(p)` + void-cut — opening + CSG void
- **SdRoof** → `buildRoof(a, b, roofParams)` — pitch/hip/flat variants
- **SdSpace** → `buildSpace(a, b)` — room volume
- **SdFoundation** → `buildFoundation(a, b)` — ground slab
- **SdCeiling** → `buildCeiling(a, b)` — ceiling plane
- **SdCurtainWall** → `buildCurtainWall(a, b, cwParams)` — glazing grid
- **SdSkylight** → `buildSkylight(a, b)` — roof glazing
- **SdOpening** → `buildOpening(p)` + void-cut — generic void
- **SdRamp** → `buildRamp(a, b)` — inclined slab
- **SdRailing** → `buildRailing(a, b)` — balustrade line

---

## DIVERGED → FIXED (this PR)

### SdBox

**Before:** inline `THREE.BoxGeometry`; creator=`"SdBox"`; missing chain, layerId, levelId, dispatchArgs, onElementCommitted.  
**Fix:** calls `buildBox(c1, c2, c3)` with synthesized corners (`c1={-w/2,-d/2}`, `c2={w/2,d/2}`, `c3={h,0}`); creator now `"box"` (from builder); added layerId, levelId, dispatchArgs, chain, onElementCommitted.  
**Note:** buildBox's 3-corner interface maps to agent's (width, depth, height) args without information loss.

### SdExtrude

**Before:** inline `THREE.ExtrudeGeometry`; creator=`"SdExtrude"`; missing chain, layerId, levelId, dispatchArgs.  
**Fix:** keeps rich profile handling (object_id extraction, arbitrary polygon profile, direction vector — absent from `buildExtrude`); aligns creator to `"extrude"`; synthesizes chain string in palette format; adds layerId, levelId, dispatchArgs.  
**Note:** agent handler is a functional superset of `buildExtrude` (which only handles a 1×1 unit rectangle). Superset capability preserved; metadata aligned.

### SdReferenceLine

**Before:** inline geometry; creator=`"SdReferenceLine"` (wrong); missing `refLineStore.add()`, refLineId, chain.  
**Fix:** replaced with `buildReferenceLine(a, b)` call; now gets correct creator=`"IfcReferenceLine"`, refLineId (from store), chain, controlPoints — same as palette path. Added layerId, levelId, dispatchArgs.  
**Impact:** highest-risk divergence — missing store registration broke KG persistence for reference lines placed via agent.

---

## AGENT-SUPERSET (intentional, documented)

### SdLevel

**Inline** at `main.ts:1185`. Accepts extra args (name, height, extent); calls `levelStore.setActive()` and `syncLevelOpacities()` — behavior absent from `buildLevel`.  
**Creator:** `"IfcLevel"` — matches `buildLevel`. No mismatch.  
**Minor:** opacity 0.05 vs buildLevel 0.04 — cosmetic, not a parity concern.  
**Decision:** keep inline; agent handler is the richer path. buildLevel is the palette-click path (single-click, no name/height control).

---

## AGENT-ONLY (no palette equivalent)

These verbs have no palette builder counterpart. Agent-only placement is intentional — they are primitive/analytical objects not exposed as palette tools.

| Verb | Geometry | Creator |
|------|----------|---------|
| SdMember | `THREE.ExtrudeGeometry` (arbitrary profile) | `"SdMember"` |
| SdPlate | `THREE.ExtrudeGeometry` | `"SdPlate"` |
| SdSphere | `THREE.SphereGeometry` | `"SdSphere"` |
| SdCylinder | `THREE.CylinderGeometry` | `"SdCylinder"` |
| SdCone | `THREE.ConeGeometry` | `"SdCone"` |
| SdDatum | `THREE.SphereGeometry` (0.15r marker) | `"SdDatum"` |
| SdFurnishing | `THREE.BoxGeometry` (w/d/h with rotation) | `"SdFurnishing"` |
| SdRefGrid | line segments grid | `"SdRefGrid"` |

---

## Verification surface (gemma-verify-raw.mjs)

Surface `agent-palette-parity` added in this PR: dispatches SdBox, SdExtrude, SdReferenceLine via agent harness, then queries `window.__viewer.scene` to assert:
- `creator` matches expected palette value (`"box"`, `"extrude"`, `"IfcReferenceLine"`)
- `chain` is a non-empty string
- `refLineId` is present on SdReferenceLine mesh
