# Research: Revit Auto-Cut Model for gemma-architect 2D Export

## Revit View Type Model (key findings only)

### Plan views (ViewPlan)

A `ViewPlan` has a `GenLevel` property pointing to its associated `Level`. The cut plane is **not** stored directly as an elevation; it is stored as an offset from a level via `PlanViewRange`:

```
ViewPlan.GetViewRange() → PlanViewRange
  PlanViewRange.GetLevelId(PlanViewPlane.CutPlane)   → levelId
  PlanViewRange.GetOffset(PlanViewPlane.CutPlane)    → offset (feet above level)
```

Default Revit standard: cut plane = level elevation + 4 ft (≈ 1.219 m). Archie-facing target is `+4'6"` (1.372 m) per the task spec. Top clip plane is typically level elevation + 8 ft; view depth (bottom) is the level elevation itself.

**The cut config lives on the View object, not on the Viewport on the Sheet.** The Sheet merely places and scales an existing view.

### Section views (ViewSection)

Section and elevation views share `ViewSection`. The key parameters:

- **Origin** — a world-space point on the cut plane.
- **ViewDirection** — unit normal pointing *toward the viewer* (the cut plane normal).
- **BoundingBoxXYZ (sectionBox)** — passed at creation; encodes width, height, and far clip depth. In the box's local frame: X = right on screen, Y = up, Z = toward viewer. `Max.Z - Min.Z` = far clip distance.
- **Far Clip Offset** — exposed as a view parameter; controls how deep behind the cut line elements are shown.

For **elevation views**, Revit has no dedicated API type — internally a `ViewSection` with a normal aligned to a cardinal direction and a sectionBox large enough to encompass the building. N elevation: ViewDirection = (0,1,0); S: (0,-1,0); E: (1,0,0); W: (-1,0,0).

Far clip for elevations is typically set equal to the building depth in that direction (bounding box extent + a margin). "Clip With Line" shows cut edges; "Clip Without Line" omits them.

### Open-source analogs

**BlenderBIM / IfcOpenShell**: Drawing generation intersects a plane parallel to the camera origin with scene geometry, producing SVG vectors for cut lines and a raster underlay for visible-behind geometry. The "ShouldRecut" flag re-runs the boolean intersection only when the section definition changes. Section planes carry an optional section box (foreground depth limit + background). Implementation lives in `blenderbim/bim/module/drawing/`.

**FreeCAD Arch**: Uses Coin3D `SoClipPlane` nodes — one plane per view type. Plan = horizontal plane at cut height; section = vertical plane at section line; elevation = vertical plane at model face.

Both confirm the same minimal data model: origin + normal + far-clip distance is sufficient to fully define a cut.

---

## Data Model Recommendation for gemma-architect

| ViewType | Cut primitive | Camera |
|---|---|---|
| `Plan` | `addClippingPlane(origin=(x,y, lvl+cutOffset), normal=(0,0,-1), label)` + underside clip at level bottom | `orthographic "top"` |
| `Section` | `addClippingPlane(origin, normal=sectionDir, label)` + far-clip plane at `origin + normal*farClip` | `orthographic "front"` or `"right"` |
| `Elevation` | Two clip planes bounding the building depth in the view axis | `orthographic "front"/"right"` rotated to cardinal |

For plan views the `setSectionBox` API is a natural fit: set `min.z = levelElevation`, `max.z = levelElevation + cutOffset`, with XY spanning the full model footprint. This replaces two separate `addClippingPlane` calls.

---

## SheetTemplate Interface Sketch (TypeScript)

```typescript
type ViewType = 'Plan' | 'Section' | 'Elevation';
type CardinalDir = 'N' | 'S' | 'E' | 'W';

interface SheetTemplate {
  id: string;           // "S1" … "S8"
  viewType: ViewType;
  title: string;

  // Plan
  levelId?: string;     // Level.id from level store
  cutOffset?: number;   // meters above level.elevation (default 1.372)

  // Section / Elevation
  origin?: [number, number, number];   // world XYZ on cut plane
  normal?: [number, number, number];   // unit vector toward viewer
  farClip?: number;     // meters; how deep behind origin to render

  // Elevation shorthand
  cardinalDir?: CardinalDir;           // auto-derives origin + normal from model AABB

  // Camera
  camera: 'top' | 'front' | 'right';
  cameraUp?: [number, number, number]; // for non-standard orientations
}
```

Eight-sheet set declaration:

```typescript
const SHEET_SET: SheetTemplate[] = [
  { id:'S1', viewType:'Plan',      title:'Plan — Level 1', levelId:'L1', cutOffset:1.372, camera:'top' },
  { id:'S2', viewType:'Plan',      title:'Plan — Level 2', levelId:'L2', cutOffset:1.372, camera:'top' },
  { id:'S3', viewType:'Section',   title:'Section A-A (longitudinal)', camera:'front', origin:[0,0,0], normal:[0,-1,0], farClip:30 },
  { id:'S4', viewType:'Section',   title:'Section B-B (transverse)',   camera:'right', origin:[0,0,0], normal:[-1,0,0], farClip:20 },
  { id:'S5', viewType:'Elevation', title:'Elevation — North', cardinalDir:'N', camera:'front', farClip:40 },
  { id:'S6', viewType:'Elevation', title:'Elevation — South', cardinalDir:'S', camera:'front', farClip:40 },
  { id:'S7', viewType:'Elevation', title:'Elevation — East',  cardinalDir:'E', camera:'right', farClip:40 },
  { id:'S8', viewType:'Elevation', title:'Elevation — West',  cardinalDir:'W', camera:'right', farClip:40 },
];
```

---

## Implementation Notes (auto-cut per ViewType)

**Plan** — resolve `Level` from `levelId`; call `setSectionBox({ min: {x:-INF, y:-INF, z: level.elevation}, max: {x:+INF, y:+INF, z: level.elevation + cutOffset}, enabled:true })`. Clear all clip planes first.

**Section** — `clearClippingPlanes()`; `addClippingPlane(origin, normal, 'section-front')`; add second plane at `origin + normal*farClip` with reversed normal for the far clip if the viewer doesn't do so automatically via `setSectionBox`.

**Elevation** — derive `origin` and `normal` from model AABB: for N elevation, `origin = (AABB.center.x, AABB.max.y + 0.1, AABB.center.z)`, `normal = (0,-1,0)`, `farClip = AABB.depth + 1`. Apply as a pair of clip planes (face + back). Set camera to orthographic, position it far along `+normal` looking back at origin.

**Camera framing** — after applying cuts, call `fitToView()` or set `camera.left/right/top/bottom` to the model's projected AABB extents in view space. Scale to sheet ratio (e.g., 1:100 for plans, 1:50 for sections).

**Reset** — `clearClippingPlanes(); setSectionBox({..., enabled:false})` before switching sheets.

---

*Sources: [Revit API — ViewPlan](https://help.autodesk.com/cloudhelp/2018/ENU/Revit-API/Revit_API_Developers_Guide/Basic_Interaction_with_Revit_Elements/Views/View_Types/ViewPlan.html) · [PlanViewRange](https://www.revitapidocs.com/2019/7edc5f13-a5fa-5c7a-9a03-ac6cbed1f005.htm) · [Elevation/Section views](https://jeremytammik.github.io/tbc/a/0215_elevation_section_view.htm) · [Far Clip Plane](https://knowledge.autodesk.com/support/revit/learn-explore/caas/CloudHelp/cloudhelp/2022/ENU/Revit-DocumentPresent/files/GUID-FDE17051-D7D0-4A2F-9A22-D015DA1108E0-htm.html) · [BlenderBIM 2D documentation](https://wiki.osarch.org/index.php?title=BlenderBIM_Add-on/BlenderBIM_Add-on_exporting_2D_documentation)*
