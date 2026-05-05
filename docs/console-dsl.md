# gemma-architect Console DSL — v0 lexicon

Status: shipped 2026-05-03 (#181 closed). v0 subset (wall/slab/column/box/cut)
lowers end-to-end via `web/src/dsl-eval.ts:compileDsl()` and is wired to the
CONSOLE tab. The full lexicon below is the v1 design target — verbs not yet
listed in §"Mapping to existing replicad ops" are sketched for later rounds.
The v2 training corpus (dataset/v2-results.md) consumed the v0 subset; 4b-it
LoRA shipped 2026-05-01 against the v2 dataset.

## Purpose

Define a small, copyright-safe lexicon for the **CONSOLE tab** that is
expressive enough to reconstruct a building from any of:

- a viewport image (TOP / FRONT / RIGHT / PERSPECTIVE)
- a natural-language description (`"a 6×4m kitchen with a doorway south
  and one window north"`)
- a hybrid input (image + text refining it)

…and small enough that a Gemma 4 LoRA fine-tune can produce it
reliably.

The DSL is the **intermediate representation**. The model writes DSL;
the pipeline lowers DSL → replicad solid graph → any of the export
formats the app already supports (IFC4, STEP, OBJ, STL, GLB, glTF,
USDZ, SVG, DXF, PDF). IFC is one target among many — the DSL doesn't
favor it. Per Jun 2026-05-03: input modality (image / text / both) and
output modality (any export format) are both open dimensions. The DSL
is the narrow waist between them.

```
                ┌──────────────┐
   image  ──────┤              │
                │   Gemma 4    │           ┌─────────────────┐
                │   E2B-it     │── DSL ──▶ │ replicad solid  │── IFC / STEP /
                │   + LoRA     │           │ graph           │   OBJ / STL /
   text   ──────┤              │           └─────────────────┘   GLB / glTF /
                └──────────────┘                                  USDZ / SVG /
                                                                  DXF / PDF
```

This DSL is **not** a clone of Rhino/RhinoCommon, Grasshopper, OpenSCAD,
CadQuery, or any product's API. It's a purpose-built command surface for
this app, drawn from the standard ontology of solid-CAD that the field
has shared since the 1970s (boundary-representations, sweeps, booleans,
transforms — universal concepts, not protected signatures).

When in doubt: prefer mathematical / architectural names (`extrude`,
`fillet`, `wall`, `slab`) over any vendor-specific shorthand. Avoid
copying operator-name + argument-order + return-shape combinations
verbatim from a single source. Every command in this doc has a
distinct argument signature designed for this app's pipeline.

## Design rules

1. **Lowercase-hyphenated verbs.** Single words preferred; two words
   joined with `-` when needed (`make-wall`, not `MakeWall`).
2. **Verbs first, arguments after.** Positional for required, named for
   optional: `extrude h=2.8` or `extrude 2.8`.
3. **Pipe for composition.** `|` chains commands; the left expression's
   value becomes the right command's first argument.
4. **References by name.** `let foo = …` binds a name; later commands
   reference `foo`. Names use `kebab-case` and are scoped to the script.
5. **Units are always metric SI.** Length defaults to **meters**, angles
   to **degrees**. Override per-arg with explicit suffix (`5500mm`,
   `2.8m`, `90deg`, `1.57rad`).
6. **Coordinate system.** Right-handed XYZ, **Z up**. Plan view is XY
   looking down the −Z axis. Origin at project insertion point unless
   `origin (x y z)` is set.
7. **Comments.** `# rest of line`. No block comments — keep lines short
   so the LLM can produce them token-cheaply.

## Lexicon

### 1. Primitives — points, vectors, planes

| Verb        | Args                              | Returns | Notes |
|-------------|-----------------------------------|---------|-------|
| `point`     | `x y z`                           | Point   | World position |
| `vector`    | `x y z`                           | Vector  | Free vector |
| `axis`      | `name` ∈ {`x`, `y`, `z`}          | Vector  | Unit basis |
| `plane`     | `origin normal` (or `xy`/`xz`/`yz`) | Plane | Construction plane |
| `dir`       | `from to`                         | Vector  | Normalised |

### 2. Curves (1-D)

| Verb        | Args                               | Returns | Notes |
|-------------|------------------------------------|---------|-------|
| `line`      | `from to`                          | Curve   | Straight segment |
| `polyline`  | `[p0 p1 …]`                        | Curve   | Open broken line; closed with same first/last point |
| `arc`       | `center radius start-angle end-angle plane?` | Curve | Default plane = XY |
| `circle`    | `center radius plane?`             | Curve   | Closed |
| `rect`      | `width depth corner=center`        | Curve   | Closed; XY by default |
| `nurbs`     | `[control-points] degree=3`        | Curve   | Open NURBS |

### 3. Surfaces and solids (2-D / 3-D primitives)

| Verb        | Args                               | Returns | Notes |
|-------------|------------------------------------|---------|-------|
| `extrude`   | `curve h direction=z+`             | Solid   | Linear sweep; closed curve → solid, open → surface |
| `revolve`   | `curve axis angle=360`             | Solid   | Rotation sweep |
| `loft`      | `[curves] degree=3`                | Surface | Through-curve interpolation |
| `sweep`     | `profile path`                     | Solid   | Profile along path |
| `pipe`      | `curve radius`                     | Solid   | Constant-radius tube |
| `box`       | `width depth height corner=center` | Solid   | Axis-aligned |
| `cylinder`  | `radius height axis=z`             | Solid   | |
| `cone`      | `radius height axis=z`             | Solid   | Apex at z=height |
| `sphere`    | `center radius`                    | Solid   | |
| `prism`     | `[base-points] height`             | Solid   | Vertical prism from polygon |

### 4. Boolean ops (combine solids)

| Verb        | Args                               | Returns | Notes |
|-------------|------------------------------------|---------|-------|
| `union`     | `a b …`                            | Solid   | A ∪ B ∪ … |
| `diff`      | `a b …`                            | Solid   | A − (B ∪ …) |
| `intersect` | `a b …`                            | Solid   | A ∩ B ∩ … |

### 5. Edge ops

| Verb        | Args                               | Returns | Notes |
|-------------|------------------------------------|---------|-------|
| `fillet`    | `solid radius edges=all`           | Solid   | Round selected edges |
| `chamfer`   | `solid distance edges=all`         | Solid   | Bevel edges |
| `shell`     | `solid thickness open-faces=[]`    | Solid   | Hollow with open faces |

### 6. Transforms

| Verb        | Args                               | Returns | Notes |
|-------------|------------------------------------|---------|-------|
| `translate` | `solid (x y z)`                    | Solid   | |
| `rotate`    | `solid axis angle origin=(0 0 0)`  | Solid   | |
| `scale`     | `solid factor origin=(0 0 0)`      | Solid   | Uniform; non-uniform via `(sx sy sz)` |
| `mirror`    | `solid plane`                      | Solid   | |
| `array`     | `solid count step` (linear) or `count axis angle` (polar) | Solid[] | |

### 7. Architectural high-level (IFC-aligned)

These are the high-leverage verbs the LLM should reach for first when
reconstructing a building. Each produces an IFC entity on export.

| Verb        | Args                                              | IFC class    | Notes |
|-------------|---------------------------------------------------|--------------|-------|
| `wall`      | `from to height thickness side=center`            | IfcWall      | Two endpoints + height |
| `slab`      | `[footprint] thickness offset=0`                  | IfcSlab      | Footprint as polyline |
| `column`    | `at height profile=square(0.3)`                   | IfcColumn    | At a point with vertical extrusion |
| `beam`      | `from to profile=rect(0.2 0.4)`                   | IfcBeam      | Sweep profile along centerline |
| `door`      | `host width height sill=0`                        | IfcDoor      | Cuts host wall + adds door |
| `window`    | `host width height sill=0.9`                      | IfcWindow    | Cuts host wall + adds glazing |
| `opening`   | `host width height sill=0`                        | IfcOpeningElement | Generic cut without door/window |
| `stair`     | `from to risers width=1.0`                        | IfcStair     | Straight run |
| `ramp`      | `from to width slope=0.06`                        | IfcRamp      | |
| `roof`      | `[outline] type=flat slope=0`                     | IfcRoof      | |
| `space`     | `[outline] height name`                           | IfcSpace     | Room boundary |
| `site`      | `[outline] elevation=0`                           | IfcSite      | |
| `level`     | `name elevation`                                  | IfcBuildingStorey | Floor reference |

### 8. Bindings + comments + control

```
let kitchen-floor = slab [(0 0) (6 0) (6 4) (0 4)] thickness=0.2
let north-wall    = wall (0 4) (6 4) height=2.8 thickness=0.2
let entry         = door north-wall width=0.9 height=2.1 sill=0
# next: kitchen-floor and walls compose into IfcSpace via `space`
```

### 9. Selection + queries (for review/edit, not construction)

| Verb        | Args                               | Returns | Notes |
|-------------|------------------------------------|---------|-------|
| `find`      | `class name?`                      | [Entity] | `find IfcWall` returns all walls |
| `bbox`      | `solid`                            | Box     | World-axis-aligned bounding box |
| `area`      | `surface`                          | Number  | m² |
| `volume`    | `solid`                            | Number  | m³ |

### 10. Pipeline directives

| Verb         | Args                          | Effect |
|--------------|-------------------------------|--------|
| `units`      | `m`/`mm`/`cm`                 | Sets default unit for the rest of the file |
| `precision`  | `0.001`                       | Geometric tolerance |
| `origin`     | `(x y z)`                     | Sets project insertion point |
| `level-on`   | `level-name`                  | Subsequent walls/slabs attach to this storey |
| `export`     | `format path`                 | Triggers export (e.g. `export ifc untitled.ifc`) |

## Examples

### Tiny: a single wall

```
wall (0 0) (5.5 0) height=2.8 thickness=0.2
```

### Schultz Residence outline (matches `Wall.North` etc. visible in the
reference screenshot)

```
units m
let z0 = 0
level "Ground" elevation=z0
level-on "Ground"

let footprint = polyline [(0 0) (11 0) (11 6) (0 6) (0 0)]
slab footprint thickness=0.2

wall (0 6)  (11 6) height=3.0 thickness=0.2  # Wall.North
wall (0 0)  (4  0) height=3.0 thickness=0.2  # Wall.South.A
wall (7 0)  (11 0) height=3.0 thickness=0.2  # Wall.South.B
wall (0 0)  (0  6) height=3.0 thickness=0.2  # Wall.West
wall (11 0) (11 6) height=3.0 thickness=0.2  # Wall.East

# interior partition
let interior = wall (5 0) (5 4) height=3.0 thickness=0.15

# openings
door (4 0) width=1.6 height=2.1                 # Door.Entry on south
window (3 6) width=1.6 height=1.4 sill=0.9      # Window.North.A

# columns
column (1 1) height=3.0 profile=square(0.4)     # Column.SW
column (10 1) height=3.0 profile=square(0.4)    # Column.SE

# entry stair (3 risers)
stair (4 -1.5) (4 0) risers=3 width=1.6         # Stair.Front

# roof slab
let roof-outline = polyline [(0 0) (11 0) (11 6) (0 6) (0 0)]
slab roof-outline thickness=0.2 offset=3.0      # Slab.Roof

export ifc schultz.ifc
```

A token cost estimate of the above (≈480 chars / ~120 tokens with
gemma's tokenizer) is comfortably under typical context budgets, which
matters when the model has to also receive a viewport image as input.

## Mapping to existing replicad ops

The web frontend's runtime already exposes a small replicad surface
(`drawRectangle`, `drawCircle`, `sketchOnPlane`, `extrude`, `cut`,
`fuse`, `translate`). The DSL's evaluator (`web/src/dsl-eval.ts`,
`compileDsl()`) lowers a v0 subset of verbs today — `wall`, `slab`,
`column`, `cut`, and `box` parse and execute end-to-end and are wired
to the CONSOLE tab. The full v1 lowering surface is sketched here as
the design target:

| DSL verb                                  | replicad equivalent                                     |
|-------------------------------------------|---------------------------------------------------------|
| `rect w d`                                | `drawRectangle(w, d)`                                   |
| `circle c r plane=xy`                     | `drawCircle(r).sketchOnPlane("XY", c.z).translate(c)`   |
| `extrude curve h`                         | `<curve>.sketchOnPlane("XY").extrude(h)`                |
| `union a b`                               | `a.fuse(b)`                                             |
| `diff a b`                                | `a.cut(b)`                                              |
| `translate s (x y z)`                     | `s.translate([x, y, z])`                                |
| `wall from to h t`                        | `drawRectangle(len(from→to), t).sketchOnPlane(...).extrude(h).translate(midpoint)` |
| `slab footprint thickness offset`         | `polylineToShape(footprint).sketchOnPlane(...).extrude(thickness).translate([0,0,offset])` |

IFC export (`export ifc …`) re-runs the existing
`web/src/ifc.ts:buildIfc` pipeline against the produced solid graph.

## Train-data status

The v2 training corpus (`dataset/v2-results.md`) is the realized version
of the corpus plan that originally lived in this section. It consumed
the v0 DSL subset (wall/slab/column/box/cut) plus raw `drawRectangle/
cut/fuse/extrude` replicad operations across a 5-bucket split:

- 50 hand-curated Tier 1 extras (`fixtures/tier1-extra.jsonl`)
- 50 Tier 2 curated (cylindrical tanks, cones, toroids, openings)
- 200 synthetic-generated rows
- 50 mined-style rows
- 50 hand-authored mechanical-voice rows

Stratified 10% holdout → 40 eval rows + 360 training seeds → 932
augmented training rows. 4b-it shipped 2026-05-01 with 40/40 (100%)
round-trip on the held-out eval (parse_ok + api_clean + has_solid_op +
execute()). E2B variant deferred per dataset/v2-results.md.

Multi-modal expansion (image-only / text-only / image+text) is the v1
direction once Tier 2 vocabulary lands and additional training cycles
are unblocked. Targets remain the DSL — pipeline lowers DSL → replicad
→ any of the 12 export formats the app supports.

## What's deliberately out of scope (v0)

- **Curved walls** — only straight-line walls in v0. Add `curved-wall`
  in v1 if the corpus needs it.
- **Multi-story stair flights with landings** — only single straight
  runs. Add `stair-landing` + `stair-multi` in v1.
- **MEP (mechanical/plumbing/electrical)** — not in v0; focus on
  arch/struct/openings/circulation per the Outliner section pattern.
- **Parametric expressions** beyond simple arithmetic — no `if`,
  `for`, function definitions in v0.

## Copyright posture

The verb names in this lexicon are drawn from the standard mathematical
ontology of CAD that predates any specific product:

- `extrude`, `revolve`, `loft`, `sweep`, `fillet`, `chamfer`, `shell`,
  `union`, `diff`, `intersect`, `translate`, `rotate`, `scale`,
  `mirror`, `array` — all standard since the 1970s; no protectable
  expression in any of them.
- `wall`, `slab`, `column`, `beam`, `door`, `window`, `stair`, `ramp`,
  `roof`, `space`, `site` — drawn from the **IFC4** schema, which is
  an open international standard (ISO 16739) governed by
  buildingSMART, not from any vendor product's API.
- The argument signatures (`wall from to height thickness side=center`)
  are designed for this app's pipeline and don't match any single
  vendor's signature byte-for-byte.

We avoid:

- Using any vendor's namespace prefix or class hierarchy
  (`Rhino.Geometry.X`, `gh.Component.Y`, `cad.foo.Z`, etc.).
- Copying argument-order patterns specifically when the vendor's
  pattern is itself the protectable shape.
- Documentation phrasing or example code from any single vendor's
  reference docs.

If a future review surfaces a specific verb that's too close to a
single vendor's signature, rename it. Mechanical concepts are not
protected; specific phrasings can be.

## Status

Shipped. v0 subset (wall/slab/column/box/cut) lowers end-to-end and is
wired to the CONSOLE tab. v2 training corpus consumed the lexicon; 4b-it
LoRA shipped 2026-05-01. v1 expansion (additional verbs, multi-modal
training) is post-hackathon work.

## Cross-refs

- avir-cli #102 — Gemma 4 E2B LoRA train (closed; E2B deferred per
  `dataset/v2-results.md`; legacy training purged 2026-05-05)
- gemma-architect #168 — 2D→3D reconstruction agent scaffold (closed;
  ships via Gemma 4 multimodal native function-calling)
- gemma-architect #179 — Cmd-K palette + console parser (closed;
  CONSOLE tab accepts DSL scripts via `compileDsl()`)
- gemma-architect #181 — DSL/lexicon for CONSOLE tab (closed; this doc)
