# Tool taxonomy — mcp-rhino → replicad mapping for hackathon model

Pre-plan asset for #96 (repo bootstrap). 39 mcp-rhino tools cataloged with
replicad equivalents and IFC training-data coverage. Determines what the
fine-tuned Gemma 4 emits and what the user can request.

**See also:** `docs/palette-coverage-audit.md` — current 42-tool interactive palette mapped
to Sd* dispatch verbs, with interactive-vs-agent parity gap analysis (SOUL-17, #933).

Source: `B:/M/ArtificialArchitecture/artificialdesigner/mcp-rhino/src/tools/`
(grep on `^\s*name:` patterns, all 39 tools located).

## Coverage table

Columns:
- **mcp-rhino tool** — original tool name from the registry
- **replicad equivalent** — fluent API call (or composition) in replicad
- **IFC source** — IFC entities that map to this op when mining real BIM data
- **Tier** — when in the 18-day plan this becomes essential

### Primitives (7)

| mcp-rhino       | replicad                                  | IFC source                              | Tier |
|-----------------|-------------------------------------------|-----------------------------------------|------|
| sphere_create   | `makeSphere(radius)`                       | IfcSphere (rare, mostly furniture)      | T2   |
| cylinder_create | `makeCylinder(radius, height)`             | IfcRightCircularCylinder; columns       | T1   |
| cone_create     | `makeCone(r1, r2, height)`                 | IfcRightCircularCone (rare)             | T2   |
| plane_create    | `makePlane(...)`                           | n/a (sketch helper, not IFC element)    | T1   |
| torus_create    | `makeTorus(majorR, minorR)`                | IfcTorus (rare)                         | T3   |
| ellipsoid_create| `makeEllipsoid(rx, ry, rz)`                | n/a                                     | T3   |
| box_create      | `makeBox(dx, dy, dz)`                      | IfcBlock; rectangular columns           | T1   |

### Curves (6)

| mcp-rhino           | replicad                                | IFC source                              | Tier |
|---------------------|-----------------------------------------|-----------------------------------------|------|
| line_create         | `drawLine(p1, p2)`                      | IfcLine; profile edges                  | T1   |
| polyline_create     | `drawPolyline(points).close()`          | IfcPolyline; IfcArbitraryClosedProfileDef | T1 |
| circle_create       | `drawCircle(radius)`                    | IfcCircle; circular profiles            | T1   |
| arc_create          | `drawArc(p1, p2, p3)`                   | IfcTrimmedCurve over IfcCircle          | T2   |
| interp_curve_create | `drawBezier(...)` (interpolated)        | IfcBSplineCurveWithKnots (interp)       | T2   |
| nurbs_curve_create  | `drawNurbsCurve(controlPts, weights, knots, degree)` | IfcRationalBSplineCurveWithKnots | T2 |

### Surfaces / sweeps (5)

| mcp-rhino   | replicad                                          | IFC source                                        | Tier |
|-------------|---------------------------------------------------|---------------------------------------------------|------|
| extrude     | `sketch.extrude(height)`                          | IfcExtrudedAreaSolid                              | T1   |
| loft        | `loft([profile1, profile2, ...])`                 | IfcSectionedSpine; lofted shells (rare in IFC)    | T2   |
| sweep1      | `sketch.sweep(spinePath)`                         | IfcSweptDiskSolid; IfcFixedReferenceSweptAreaSolid | T2  |
| sweep2      | `sweep(profile, spine, axis)` (composed)          | IfcSurfaceCurveSweptAreaSolid (rail+profile)      | T3   |
| revolve     | `sketch.revolve(axis, angle)`                     | IfcRevolvedAreaSolid                              | T1   |

### Solids — Boolean (3)

| mcp-rhino           | replicad                                | IFC source                                       | Tier |
|---------------------|-----------------------------------------|--------------------------------------------------|------|
| boolean_union       | `a.fuse(b)`                             | IfcBooleanResult (UNION op)                      | T1   |
| boolean_intersection| `a.intersect(b)`                        | IfcBooleanResult (INTERSECTION op)               | T2   |
| boolean_difference  | `a.cut(b)`                              | IfcBooleanResult (DIFFERENCE op); IfcRelVoidsElement (openings) | T1 |

### Transforms (5)

| mcp-rhino | replicad                          | IFC source                                  | Tier |
|-----------|-----------------------------------|---------------------------------------------|------|
| move      | `.translate([x, y, z])`           | IfcLocalPlacement / IfcCartesianTransformationOperator | T1 |
| copy      | (clone + translate)               | IfcMappedItem                               | T2   |
| rotate    | `.rotate(angle, axis)`            | IfcAxis2Placement3D rotation                | T1   |
| scale     | `.scale(factor)`                  | IfcCartesianTransformationOperator3DnonUniform | T2 |
| mirror    | `.mirror(plane)`                  | IfcReflectionTransformationOperator (rare)  | T3   |

### Document / world ops (13)

These are NOT geometry — they're document-state ops. The hackathon model
emits geometry sequences; document state is handled by the runtime, not
the model. EXCLUDE from training surface.

- units_get, units_set
- select_by_guid, select_by_layer, select_by_type, select_all
- layer_create, layer_set_color, layer_set_visible, layer_set_locked
- document_new, document_open, document_save

## Tier mapping summary

**Tier 1 (Spike A floor)** — model must emit these confidently:
extrude, revolve, makeBox, makeCylinder, drawLine, drawPolyline,
drawCircle, fuse, cut, translate, rotate, sketch.

12 tools. Covers ~85% of IfcWallStandardCase, IfcSlab, IfcColumn,
IfcBeam, IfcStair (extrude family), and basic openings (cut).

**Tier 2 (post-Spike A, if A passes)** — adds:
sweep1, loft, intersect, NURBS curves, arcs, copy/scale.

7 more. Covers IfcRoof (sweep along ridge), spiral stairs, curved walls,
non-rectangular profiles.

**Tier 3 (stretch)** — sweep2, ellipsoid, torus, mirror, sphere,
cone, complex transforms.

7 more. Out of scope for hackathon unless Spike A+B are clean wins by
day 6.

## Excluded from training surface

13 document/state tools NOT taught to the model. The model emits pure
geometry sequences; runtime wraps them with document setup
(document_new / units_set), layer assignment, and selection-based
reference lookup.

## Implication for repo bootstrap (#96)

`src/tools/` directory in hackathon repo gets:
- `tier1.ts` — 12 ops, tested with replicad fixtures, this is the LoRA
  target vocabulary for Spike A.
- `tier2.ts` — 7 ops, deferred until tier1 baseline passes.
- `tier3.ts` — placeholder, may not ship.
- NO document/state tools — those live in `src/runtime/` not `src/tools/`.

Each tier1 op has:
1. JSDoc with replicad signature
2. One unit test (creates the geometry, computes volume/area, asserts
   known value)
3. A fixture entry in `fixtures/tier1.jsonl` mapping (NL description →
   tool call → expected geometry hash)

Fixtures are the hand-curated 50-pair set for Spike A.

## Decision pending

Whether to teach the model:
- (a) the **tool name + args JSON** format ("mcp-style"), e.g.,
  `{"tool": "extrude", "args": {"profile": "rect_5_3", "height": 3}}`
- (b) the **fluent JS source** format, e.g.,
  `drawRectangle(5, 3).sketchOnPlane("XY").extrude(3)`

(a) is more constrained (easier to validate syntactically) but loses
Gemma's strong code priors. (b) leverages those priors and round-trips
trivially through `eval` or transformer-based parsers, but requires
post-hoc parsing for execution.

Pre-spike default: (b). Reasoning: Gemma 4 is a code-strong family;
fluent JS is what its training distribution looks like; we'd be
fighting the model to teach (a). Revisit if Spike A drops below the
≥30/50 syntactic-validity floor — at that point the format constraint
might be the bottleneck.
