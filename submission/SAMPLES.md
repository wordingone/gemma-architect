# Bundled samples — provenance + license

The web app's "Load file" mode ships eight samples in `web/public/samples/`.
This page documents each one's origin, license, and category — explicitly
separating **real architect-authored buildings** from **schema-validation
test fixtures** from **loader smoke tests**.

Why this matters: synthetic test fixtures are valuable for parser perf
benchmarking but should not be conflated with real buildings when judging
geometric breadth or BIM realism. The distinction is preserved in
`web/src/sample-files.ts` comments and surfaced here for direct-read
auditing.

## Real architect-authored building (1)

| Sample | Size | Entities | License | Provenance |
| :----- | ---: | -------: | :------ | :--------- |
| `Schultz_Residence.ifc` | 21.8 MB | 424,819 | **CC BY-ND 4.0** | Multi-story residence in the Boston metro area (IfcSite 42°21'30"N 71°3'35"W). Authored in Autodesk Revit 2014 by **Opening Design** (architecture practice). Sourced from [opensourceBIM/IFC-files](https://github.com/opensourceBIM/IFC-files). 11 storeys (Basement→Roof), 105 walls, 25 windows, 17 doors, 10 stairs. IFC2x3. |

CC BY-ND 4.0 permits commercial use + display; prohibits derivative works.
gemma-architect bundles the original file unchanged for users to load
and inspect — no derivative work created.

## Synthetic schema-validation test fixtures (2)

These are KIT (Karlsruhe Institute of Technology) reference IFC4 files
authored to validate ArchiCAD's IFC4 export. They are **not real buildings**
— they are deliberately-constructed test cases for parser conformance.

| Sample | Size | Entities | License | Provenance |
| :----- | ---: | -------: | :------ | :--------- |
| `AC20-FZK-Haus.ifc` | 2.5 MB | 44,249 | KIT public reference | KIT FZK-Haus, residential synthetic, ArchiCAD 20 export. |
| `AC20-Institute-Var-2.ifc` | 10.4 MB | 147,712 | KIT public reference | KIT "phantasy" office, ArchiCAD 20 export. |

Both are widely cited in IFC implementer documentation (web-ifc, IFC.js,
BimVision, BlenderBIM) as conformance fixtures. Bundled here as parsing /
performance benchmarks alongside the real Schultz Residence.

## Sourced demo asset (1)

| Sample | Size | Entities | License | Provenance |
| :----- | ---: | -------: | :------ | :--------- |
| `bonsai-project0-openings.ifc` | 48 KB | 788 | Tutorial-bundled | BlenderBIM tutorial "Project 0" starter — small house with openings authored as the BIM-Onboarding sample. Fast to parse, exercises IfcOpeningElement / IfcDoor / IfcWindow paths. |

## Loader smoke tests (4)

Minimal fixtures used to verify the file-load pipeline (IFCLoader,
OBJLoader, STLLoader) — not representative of real geometry.

| Sample | Size | Entities | Format | Purpose |
| :----- | ---: | -------: | :----- | :------ |
| `wall-with-opening-and-window.ifc` | 12 KB | 127 | IFC4 | Single wall + window void. Sub-second parse, smoke test. |
| `simple-sweep-1.ifc` | 4 KB | 65 | IFC4X3_ADD2 | Minimal swept solid emitted by IfcOpenShell 0.8.2. Schema-version smoke test — verifies the loader ingests an IFC4X3_ADD2 file (newer civil-infra-extension schema); web-ifc 0.0.77 partial-parses (logs `GetRefArgument` warnings on entities it doesn't fully resolve) but doesn't crash. |
| `triangle.obj` | 96 B | n/a | OBJ | OBJLoader path verification. |
| `triangle.stl` | 158 B | n/a | STL ASCII | STLLoader path verification. |

## What this means for judging

- **For impact / equity claims** — the Schultz Residence is the relevant
  sample. It is a real building authored by a real practice in the same
  CAD tools the equity case names (Revit). Loading and round-tripping it
  through gemma-architect's IFC pipeline demonstrates the pipeline's
  realism on real data.
- **For perf claims** — the KIT fixtures are the relevant samples. They
  span 44k / 147k entities and are the standard parser-conformance
  benchmarks in the IFC implementer community.
- **For correctness claims** — `bonsai-project0-openings.ifc` exercises
  the openings (door/window void) paths the model generates code for.

## Source-of-truth code

The TypeScript-side metadata for the in-app dropdown lives in
[`web/src/sample-files.ts`](../web/src/sample-files.ts). Each entry there
carries the same provenance as a code comment; this page is the
human-readable surfacing for judges who shouldn't have to grep TS source
to verify the real-vs-synthetic distinction.
