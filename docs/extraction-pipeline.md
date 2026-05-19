# IFC → (NL, replicad sequence) extraction pipeline — single-wall walkthrough

Pre-plan artifact for Gemma 4 Good Hackathon. Pinned to one element class
(IfcWallStandardCase) end-to-end before scaling. Round-trip validated:
parametric IFC → replicad → STEP → re-parse must produce geometric
equivalent (within mesh tolerance).

Kernel: replicad on replicad-opencascadejs (verified #87 follow-up).
Parser: web-ifc v0.0.77 (verified #88).

---

## 1. Source

Single IFC sample: `Schependomlaan.ifc` (CC-BY 4.0, IFC2x3, ~1k elements).
Pick one IfcWallStandardCase by GlobalId. Goal of this spike: for that one
element, produce `(NL_description, replicad_construction_sequence)` and
validate the sequence reproduces the geometry.

## 2. Stage A — Parametric extraction (web-ifc)

```ts
import { IfcAPI } from "web-ifc/web-ifc-api";
const api = new IfcAPI();
await api.Init();
const modelID = api.OpenModel(ifcBytes);

// Resolve element root
const wall = api.GetLine(modelID, expressID, /*flatten*/ true);
// → IfcWallStandardCase {
//     GlobalId, Name, ObjectType,
//     ObjectPlacement: IfcLocalPlacement { ... transform chain ... },
//     Representation: IfcProductDefinitionShape {
//       Representations: [IfcShapeRepresentation {
//         Items: [IfcExtrudedAreaSolid {
//           SweptArea: IfcArbitraryClosedProfileDef | IfcRectangleProfileDef { XDim, YDim },
//           Position: IfcAxis2Placement3D { ... },
//           ExtrudedDirection: IfcDirection { DirectionRatios: [0,0,1] },
//           Depth: <number>
//         }]
//       }]
//     }
//   }

const psets = api.properties.getPropertySets(modelID, expressID, /*recursive*/ true);
// → [{ Name: "Pset_WallCommon", HasProperties: [
//        { Name: "LoadBearing", NominalValue: { value: true } },
//        { Name: "FireRating",  NominalValue: { value: "120min" } },
//        ...]}]

const typeRel = api.GetLine(modelID, wall.IsTypedBy?.[0]?.value, true);
// → IfcWallType { Name, PredefinedType, ... }
```

The `flatten=true` flag is the critical capability — recursively expands
referenced entity expressIDs into nested objects. Without it we get bare
`{ type: "IfcReference", value: 1247 }` placeholders and have to walk
manually.

Three primary representation classes to handle in the spike:
1. **IfcExtrudedAreaSolid** — profile + direction + depth. NURBS-clean.
2. **IfcArbitraryClosedProfileDef** with **IfcCompositeCurve** — 2D NURBS profile.
3. **IfcFacetedBrep / IfcTessellation** — fallback, lossy, downstream of any export. SKIP in spike; flag for filter.

For Spike A focus only on (1)+(2). Anything that hits (3) gets dropped from the training-pair set with a `lossy_representation` reason code.

## 3. Stage B — NL description (template + variation)

Inputs available after stage A:
- Type: `wall.constructor.name` → "IfcWallStandardCase"
- Predefined type: `typeRel?.PredefinedType` → "STANDARD" / "PARTITIONING" / "SHEAR" / etc.
- Name / ObjectType: `wall.Name?.value` / `wall.ObjectType?.value`
- Dimensions: `swept.XDim`, `swept.YDim`, `solid.Depth` (length × thickness × height)
- LoadBearing, FireRating, IsExternal from PSets
- Material via IfcRelAssociatesMaterial → IfcMaterialLayerSetUsage
- Storey: walk IfcRelContainedInSpatialStructure → IfcBuildingStorey

Templates (varied to avoid overfit):
- "A {predefined} {load_bearing} wall, {length}m long × {thickness}m thick × {height}m tall, on {storey}."
- "{Name}: {height}m {predefined} wall partitioning {storey}, fire rating {fireRating}."
- "Build a {load_bearing} wall along the {axis} axis, length {length}m, thickness {thickness}m, height {height}m."

For Spike A: 3 template variants per pair, randomized at sample-time. For training corpus, more variation (paraphrase via Gemma 4 itself, post-Spike A).

## 4. Stage C — replicad construction sequence

Translate the parametric IFC entity into replicad fluent calls. Wall as
IfcExtrudedAreaSolid with rectangular profile is the trivial case:

```ts
import * as replicad from "replicad";

// Extract from stage A
const length = swept.XDim;     // e.g., 5.0 (meters)
const thickness = swept.YDim;  // e.g., 0.2
const height = solid.Depth;    // e.g., 3.0
const placement = computeTransform(wall.ObjectPlacement); // 4x4 matrix

// Construction sequence
const wallSolid = replicad
  .drawRectangle(length, thickness)
  .sketchOnPlane("XY")
  .extrude(height)
  .translate(placement.translation)
  .rotate(placement.rotation.angle, placement.rotation.axis);

// Export STEP for round-trip validation
const stepBytes = await wallSolid.blobSTEP();
```

The fluent API maps cleanly to IFC parametric structure:
| IFC entity              | replicad call                            |
|-------------------------|------------------------------------------|
| IfcRectangleProfileDef  | `drawRectangle(XDim, YDim)`              |
| IfcArbitraryClosedProfileDef + IfcPolyline | `drawPolyline(points).close()` |
| IfcArbitraryClosedProfileDef + IfcCompositeCurve | `drawCurve(...)` (B-spline) |
| IfcExtrudedAreaSolid    | `.extrude(Depth)`                        |
| IfcRevolvedAreaSolid    | `.revolve(axis, angle)`                  |
| IfcSweptDiskSolid       | `.sweep(spinePath, profile)`             |
| IfcBooleanResult        | `.fuse() / .cut() / .intersect()`        |
| IfcAxis2Placement3D     | `.translate(p) + .rotate(angle, axis)`   |

LoRA target tokens — what the model emits — is the JS-source of the
replicad fluent chain, NOT a bytecode AST. Gemma 4 has strong code
priors; emitting fluent JS leverages that.

## 5. Stage D — round-trip validation

For each `(ifc_element, generated_sequence)` pair:

1. Execute generated sequence in replicad → produce STEP bytes.
2. Re-parse STEP via web-ifc (or OCCT directly via opencascade.js
   `STEPControl_Reader`) → recover Brep.
3. Compare Brep against the IFC source's tessellated `LoadAllGeometry`
   output (vertex/face counts within tolerance, oriented bounding-box
   match within 1mm, volume match within 1%).
4. Emit `pass | fail | partial` verdict per pair.

Spike A acceptance: ≥40/50 round-trip-pass.
Spike B acceptance: ≥20/30 sampled pairs match descriptions
(human-eyeball, NL-description ↔ rendered geometry).

## 6. Failure modes to anticipate

- **Placement chain depth.** IfcLocalPlacement nests up to building →
  storey → element. Walk the chain and accumulate transforms. Bug
  surface: forgetting to compose the parent transforms.
- **Profile centering.** IFC profiles default-center on origin; replicad
  `drawRectangle` is also centered. But if profile defines `Position`
  with non-zero origin, must translate the sketch BEFORE extrude.
- **Units.** IFC files declare `IfcUnitAssignment` (mm/m/inch). Read at
  model open and normalize to meters before emitting replicad calls.
  Default-assume-meters is a silent corruption source.
- **Compound walls.** IfcMaterialLayerSetUsage represents multi-layer
  walls (drywall+insulation+brick). Spike treats wall as homogeneous
  solid; layer extraction is a Tier 2 stretch.
- **Openings.** IfcRelVoidsElement → IfcOpeningElement (windows/doors)
  punch holes. Spike ignores; this is a `.cut()` Boolean post-extrude in
  the construction sequence. Flag for Spike B.

## 7. Pipeline as a script (spike-mode)

```ts
// scripts/spike-extract-walls.ts
import { IfcAPI } from "web-ifc";
import * as replicad from "replicad";

async function extractWall(modelID: number, expressID: number) {
  const wall = api.GetLine(modelID, expressID, true);
  const repr = walkRepresentation(wall);  // returns { type: "extruded", profile, depth, placement } | null
  if (!repr) return { skipped: true, reason: "non-extruded" };

  const psets = api.properties.getPropertySets(modelID, expressID, true);
  const typeRel = resolveType(modelID, wall);
  const storey = resolveStorey(modelID, wall);

  const nl = renderNLTemplate({ wall, typeRel, repr, psets, storey });
  const seq = emitReplicadSequence(repr);

  return { nl, seq, expressID };
}

const allWalls = api.GetLineIDsWithType(modelID, IFCWALLSTANDARDCASE);
const pairs = [];
for (let i = 0; i < allWalls.size(); i++) {
  const result = await extractWall(modelID, allWalls.get(i));
  if (!result.skipped) pairs.push(result);
}
fs.writeFileSync("spike-pairs.jsonl", pairs.map(JSON.stringify).join("\n"));
```

Schependomlaan has roughly ~80-120 IfcWallStandardCase instances. Single
file gives more than enough for the 50-pair Spike A. If extraction works
end-to-end on this one file, scaling to 1,200-2,000 IFCs is mechanical.

## 8. What this spike validates / does not

Validates:
- web-ifc parametric extraction recovers everything we need for one
  element class.
- replicad fluent API maps 1:1 to IFC parametric structure.
- Round-trip via STEP preserves geometry within tolerance.
- NL templating produces descriptions that round-trip back through the
  model (Spike B).

Does not validate:
- Multi-element scenes / spatial relationships (Tier 2).
- Sketch-input multimodal path (Tier 3).
- Compound/composite walls, multi-layer materials.
- Openings, MEP penetrations.
- Curved walls (IfcArbitraryClosedProfileDef with B-splines) — included
  in pipeline but harder to round-trip; flag for Spike A subset.

Acceptance gate for promoting to Tier 2: Spike A AND Spike B both pass.
If A passes but B fails: NL templating is the bottleneck — iterate on
descriptions, do not move to multi-element.
If B passes but A fails: model isn't learning the construction sequence
— re-examine LoRA hyperparams + training pair format.

---

Status: design complete, ready to implement once project sign-off on track
+ repo location + team composition (#95).
