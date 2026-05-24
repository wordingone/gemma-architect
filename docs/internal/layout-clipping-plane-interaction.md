# Layout: Clipping Plane ↔ Sheet Interaction Design

**Issue:** #1849  
**Status:** Research complete — recommendation below.  
**Author:** Archie (2026-05-24)  
**Gated:** Step 2 implementation blocked on this doc being accepted.

---

## 1. Problem Statement

When a user creates a clipping plane in the Model tab (or the agent dispatches `SdClipPlane`), what should happen in the Layout tab? The question has two sub-questions:

1. **Auto-link or manual?** Does creating a clip plane automatically generate a corresponding Section/Elevation sheet, or does the user explicitly associate views?
2. **Bounds/extents?** Should a clipping plane carry crop-region extents (width × depth × height) so the linked view knows what portion of the building to show?

---

## 2. How Each System Works

### 2.1 Revit

**Core model:** A `ViewSection` (or `ViewPlan`) is a parametric view object. Its geometry is defined by a `BoundingBoxXYZ` (the crop region) and a `SectionBox` (for 3D). A *Section Marker* placed in a plan view is the UI instrument; it writes directly to a linked `ViewSection`.

**Creation flow:**
1. User places a Section marker line in a plan/elevation view.
2. Revit immediately creates a linked `ViewSection` and a crop region rectangle (4 grip handles).
3. Moving any grip — start, end, far-clip depth, cut height — live-updates the view: the viewport regenerates without user action.
4. The `ViewSection` can be placed on a Sheet as a `Viewport`. Moving the crop region grips on the sheet updates the model-side clip too (bidirectional).

**Crop region handles (Section Marker):**
- **Start/End** — horizontal extent of the section cut line (what you see left-right in the section view).
- **Near/Far** — depth of the slab (how far back the section looks). Draggable triangle grips on each end.
- **Top/Bottom** — view height. Usually locked to story height but can be overridden.

**Key properties in the Revit API (`ViewSection`):**
- `CropBox` — `BoundingBoxXYZ` defining the crop region; `get_BoundingBox(view)` returns the active crop.
- `CropBoxActive` / `CropBoxVisible` — enable crop.
- `get_Parameter(BuiltInParameter.VIEWER_BOUND_FAR_CLIPPING)` — far clip distance.
- `GetCropRegionShapeManager()` — for non-rectangular crop (rare).

**Verdict:** Strong auto-link, parametric, bidirectional. The SectionLine IS the clip plane; view state is derived, not stored separately.

---

### 2.2 Rhino (Layout Space)

**Core model:** `ClippingPlane` is an independent scene object defined by a plane equation `[origin, normal]`. It clips any viewport that has it in its `ClippingPlaneList`.

**Creation flow:**
1. User runs `ClippingPlane` command → picks point + direction → a named CP object appears in the scene.
2. To use it in layout: go to Layout space → activate a Detail View → run `Properties` → add the CP to that Detail's `ClippingPlaneList`.
3. No auto-creation of a linked view. No crop region. No bounds propagation.
4. Make2D is a separate command (non-live): select objects, run `Make2D`, get projected 2D curves. Must re-run after any geometry change.

**Rhino 8 additions:** `NamedPosition` + `NamedView` can capture clip state, but still no auto-link to sheets.

**Verdict:** Manual, independent, no parametric link. Flexible but labor-intensive for a sheet workflow. Appropriate for free-form exploration; not ideal for documentation-driven AEC workflow.

---

### 2.3 ArchiCAD

**Core model:** A `Section/Elevation` Marker placed in Floor Plan auto-creates a linked Section Drawing. The marker has:
- A *Section Line* (defines the cut plane).
- A *Limit Line* (horizontal extent — like Revit's start/end grips).
- A *Depth* (far clip).

Moving the marker → live-updates the linked Drawing. Drawing can be placed on a Layout Sheet. Bidirectional: dragging the crop region on the sheet updates the marker in plan.

Essentially Revit-equivalent philosophy, slightly different UI.

---

### 2.4 Vectorworks

**Core model:** *Design Layer Viewport* (DLVP) clips a subset of geometry. Sheet Layer Viewports reference DLVPs. Crop regions are editable polygons. The Clip Cube is a 3D interactive version.

Workflow: create a DLVP (essentially a named clip region + view direction), place it on a Sheet Layer Viewport. The DLVP is the clip + view bundled. Manual creation but parametric once created.

Similar to Revit in outcome, different in that the crop is a separate object from the Sheet placement.

---

### 2.5 SketchUp / LayOut

**Core model:** SketchUp scenes (named camera + visible layers + section plane state) feed LayOut viewports. A section cut is a `SectionPlane` object that activates per scene. `LayOut` viewport references a scene.

Workflow: in SketchUp, activate a section plane for a scene → in LayOut, set viewport to that scene → the section view appears. Manual scene → viewport mapping.

No live parametric connection. Must update SketchUp scene then "Update Model Reference" in LayOut.

---

## 3. Pros / Cons

| Criterion | Revit-style auto-link | Rhino-style manual | Hybrid (auto-link + unlink button) |
|---|---|---|---|
| **Time to get a section sheet** | Instant (create marker → sheet exists) | Multi-step (create CP → go to layout → assign → place) | Instant by default |
| **Surprise factor** | Can create unwanted sheets | Predictable | Moderate — user controls unlinking |
| **Parametric live-update** | Yes — grip moves instantly update view | No — requires Make2D re-run | Yes for linked sheets |
| **Free-form clip planes** | Constrained to sheet-producing clips | Any geometry | Linked by default, unlinkable |
| **Complexity to implement** | High (clip plane entity + bounds object + auto-create sheet) | Low (nothing changes) | Moderate (auto-create + unlink UI) |
| **AEC convention** | Standard for documentation-first tools | Standard for exploration-first tools | Both |
| **Agent compatibility** | `SdClipPlane` dispatch creates a sheet entity | No change to agent | `SdClipPlane` creates sheet unless flagged `autoSheet: false` |

---

## 4. Recommendation

**Constrained Revit-style auto-link, with explicit unlink.**

Rationale:
1. This codebase is AEC-documentation-focused — the Layout tab's purpose is producing construction documents, not free exploration. Auto-link matches that goal.
2. The `applySheetCut` function already encodes the clip-plane → view relationship; making it parametric is the natural extension.
3. Rhino-style manual is the status quo (do nothing). It has zero value-add from the user's perspective for this workflow.
4. The "surprise factor" concern is addressed by the unlink button and by naming auto-created sheets after the clip plane.

**Bounds/extents model:** Adopt Revit's 4-handle crop region:
- `startPt` / `endPt` — width of the section cut (how much you see left-right).
- `farClip` — depth behind the cut plane (already in `SheetTemplate.farClip`).
- `height` — view height (how tall the section crops to). Defaults to scene height.

The `ClippingPlane` scene entity gets a `bounds` field: `{ startPt, endPt, farClip, height }`. Manipulating bounds in the 3D viewport (via Gumball-style handles) live-updates the linked sheet's crop.

**Agent behavior:** `SdClipPlane` dispatch auto-creates a linked Section sheet unless `autoSheet: false` is passed. The schema adds `bounds` as optional.

---

## 5. Acceptance Criteria for Step 2 (Implementation)

### 5.1 Data model

- [ ] `ClippingPlaneEntity` added to scene entity types: `{ id, origin, normal, bounds: { startOffset, endOffset, farClip, height } }`.
- [ ] `SheetTemplate` extended: optional `clipPlaneId` field (links a sheet to a specific `ClippingPlaneEntity`).
- [ ] `DEMO_SHEET_SET` unchanged by this change (elevation sheets use `cardinalDir`, not `clipPlaneId`).

### 5.2 Auto-sheet creation

- [ ] When `SdClipPlane` is dispatched (or user places a clip plane via Model-tab tool), a new `SheetTemplate` of `viewType: "section"` is appended to the active sheet set with `clipPlaneId` pointing to the new entity.
- [ ] Sheet title defaults to `"Section — <clipPlane.label || serial>"`.
- [ ] Schema: `SdClipPlane` accepts optional `autoSheet: boolean` (default `true`). When `false`, clip plane is created without a sheet.
- [ ] `audit-dispatch-routing` passes after schema addition.

### 5.3 Bounds manipulation

- [ ] `ClippingPlaneEntity.bounds` exposes `startOffset`, `endOffset`, `farClip`, `height`.
- [ ] In the Model tab, selecting a ClippingPlane entity shows 4 Gumball-style handles (one per bound).
- [ ] Dragging a handle updates `bounds` and triggers a re-render of any linked sheet's crop region.
- [ ] `applySheetCut` reads `clipPlaneId` from the sheet → fetches the `ClippingPlaneEntity` → applies `farClip` from `entity.bounds` (not from `SheetTemplate.farClip` when linked).

### 5.4 Unlink

- [ ] Each linked sheet (in the sheet list / layout panel) shows an "Unlink" button.
- [ ] Unlinking copies the current `entity.bounds` into `SheetTemplate` fields and nulls `clipPlaneId`. The sheet becomes static.
- [ ] The source `ClippingPlaneEntity` remains in the scene after unlink.

### 5.5 Cross-cutting

- [ ] `bun run verify` exit 0, `bun scripts/audit-aliases.ts` exit 0, `bun test web/` pass at PR HEAD.
- [ ] `SdClipPlane` handler tested: verifies auto-sheet entry appended to sheet set.
- [ ] Bounds manipulation tested: mock entity + mock sheet → verify `applySheetCut` reads entity bounds.
