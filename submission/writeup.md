# gemma-architect: browser-native parametric architecture from natural language

**Track:** Equity — 3D parametric design accessibility for non-CAD-trained users
**Submission for:** Gemma 4 Good Hackathon (Kaggle + Google DeepMind)
**Author:** wordingone
**License:** CC BY 4.0

---

## TL;DR

Open a web page. Type `"design a fire station"`.
A keyword match triggers an 18-step dispatch sequence: apparatus bays,
dormitory, kitchen, bathrooms, day room — rendered as a coherent
multi-room 3D building. Click **Export IFC** and download a file that
opens in Revit, ArchiCAD, BlenderBIM, or any other BIM tool on the planet.

Six starter skill-graph clusters ship in the SKILLS dock tab (Wall Row, Window Array,
Room, Roof Walls, Stair Flight, Skylight Grid). Users save their own via the SKILL NODES tab.
Each cluster is a pre-verified dispatch sequence — the model gets out of the way,
the geometry is correct.

60 cached prompt→JS pairs back the single-element prompt path;
sub-100ms F1 fuzzy match is the default judge experience for one-liner
prompts. The geometry kernel and IFC4 emitter run in-browser via
WebAssembly. Novel prompts that miss the cache go to the on-device stock Gemma 4 model.

The goal is to put parametric architectural design — the kind of tool you
draw a building in before you build it — in front of people who can't
afford the $3K/year CAD subscription that today gates the practice.

---

## What it does

A non-CAD user opens a static web page (no install, no login, no API
key). The page shell is a drafting workbench (post-#170 bundle port):
top-bar **EXPORT** drawer + Cmd-K palette, left palette of CAD-tool
glyphs, right sidebar (SCENE / INSPECT / ASSETS), bottom dock with
four tabs (PROMPT / NODES / PARAMETERS / HISTORY), 3D viewer in the
center. The **PROMPT** tab hosts both natural-language input and a
DSL console; **Shift+Tab** toggles between modes (PROMPT ⇄ CONSOLE).

1. They open the **PROMPT** tab. They type `"design a fire station"` and
   hit `⌘⏎`. The page keyword-matches against the saved-skills library
   and finds the `fire-station` skill (18 steps). The dispatch sequence
   fires in order: IfcLevel → IfcSlab → 4×IfcWall → 3 apparatus bays →
   crew spaces (kitchen, bathrooms, dormitory, day room) → garage doors.
   three.js renders a complete multi-room building.
2. They press `D` for drafting style — same geometry, ink-wobble
   architectural render. They click **EXPORT** → **IFC4**. The page
   hand-emits an IFC4 STEP-21 file and downloads it.

That is the hero path. Five reference skills ship on master
(f28dfa8): `fire-station`, `sf-residence-2br`, `office-25desk`,
`hospitality-cabin`, `research-pavilion`. Each is a schema-version-2
`skill.json` — an array of `{verb, args}` steps, keyword-indexed,
dispatched directly without model inference.

For single-element prompts that don't match a skill:

3. The PROMPT tab also accepts one-liner prompts. A chip strip lists
   canned demos. They click `"Wall · 5.5×0.2×2.8m"`. An F1-weighted
   fuzzy match against 60 cached prompt-to-JS rows (DSL corpus + Schultz gold + archived Gemma 3 LoRA eval) returns the closest
   replicad source. The PROMPT tab's inline console logs
   `[ai-generate] cache · X.XX match · ~50ms`.
4. They click **GENERATE** (or hit `⌘⏎`). A web worker boots
   OpenCascade WebAssembly (replicad-opencascadejs), executes the
   source against the same Tier 1 tool surface the model was trained
   on, and posts the resulting mesh back. three.js renders it.
5. They drag **length** / **thickness** / **height** sliders in the
   PARAMETERS tab. Each change debounces 90ms and re-runs the worker —
   geometry updates live, no model re-inference needed.

The same 12-tile EXPORT drawer (IFC4, STEP, OBJ, STL, GLB, glTF, USDZ,
SVG, DXF, PDF — DWG and FBX visible-but-pending) serves both paths.
Hand-emitted IFC4 STEP-21 round-trips through web-ifc.OpenModel for
parse verification before download.

Eight additional single-element demos ship from the held-out 40-row eval
set (walls, columns, raised slabs, slabs with stair holes, walls with
doorways, L-shape walls, four-walled rooms, stair-step structures). Each
has 3–6 sliders that retrigger the worker.

![Demo grid — wall workflow · Schultz demo · chrome surfaces (3×3)](screenshots/grid.png)

### Beyond prompt-to-geometry: three other entry points

A non-CAD user has more than one way to start a building. The same
dispatch → kernel → IFC pipeline accepts three other entry points:

- **Saved-skill dispatch.** Type a building type — `"design a fire
  station"`, `"two-bedroom residence"`, `"25-desk open office"`. The
  page keyword-matches the SKILL NODES library and fires a
  pre-verified dispatch sequence directly. No model inference on this
  path. Five reference skills ship on master (f28dfa8); users can
  save their own via the SKILL NODES tab. Each skill is a
  schema-version-2 `skill.json` with a `steps` array of `{verb, args}`
  pairs validated against `web/skills/skills.schema.json`. This path
  exists specifically because bare Gemma 4 E2B at K=0 ignores
  dimensional args — saved skills route around that limitation by
  executing verified sequences directly.
- **Drag a hand-sketched floorplan PNG into the canvas.** A 2D→3D
  reconstruction agent runs Sobel edge detection + a Hough-lite
  pixel-run scanner, finds horizontal and vertical wall segments at a
  default 100 px/m scale, extrudes them at 2.8m, and emits IFC4. A
  pencil sketch becomes a loadable BIM file in one drop. Zero deps —
  Sobel and the Hough loop both ship as in-line OffscreenCanvas code.
- **Type DSL in the PROMPT tab's CONSOLE mode** (Shift+Tab to toggle
  from natural-language PROMPT mode). A copyright-safe Rhino-style
  lexicon (~70 verbs hand-curated against IFC4 entity classes,
  documented at `web/src/spatial-api.LICENSE.md`) backs the
  CONSOLE input: `wall(0, 0, 5.5, 0.2, 2.8); slab(0, 0, 5, 6, 0.2);
  column(2, 3, 0.4, 3); cut(slab, door)`. Direct geometric control
  for the architect who already speaks CAD.

The implication: gemma-architect treats Gemma 4 not as a single
prompt-completion endpoint but as a **routing function** over a
dispatch table that's also exposed to human keystrokes, drag-drop, and
clicks. Judges who score on tech depth will find this in
`web/src/dispatch.ts`. The saved-skills library complements the
AI-inference path rather than depending on it.

---

## Technical approach

### Vocabulary: Tier 1, 12 ops

The model emits JavaScript against a small constrained API surface:

```js
// Primitives
makeBox(width, depth, height)
makeCylinder(radius, height)

// 2D drawing (returns a Drawing)
drawRectangle(width, depth)
drawCircle(radius)
drawLine([x1,y1], [x2,y2])
drawPolyline([[x1,y1], [x2,y2], ...])

// Sketch transition (Drawing method)
.sketchOnPlane("XY" | "XZ" | "YZ")

// Surface ops (Sketch methods)
.extrude(distance)
.revolve(axis)

// Booleans + transforms (Solid methods)
.fuse(otherSolid)
.cut(otherSolid)
.translate([dx, dy, dz])
.rotate(angle, position, direction)
```

This covers ~85% of what a small-shop architect produces in the
schematic-design phase: walls, slabs, columns, footings, basic openings,
L-shape and U-shape footprints. Tier 2 (revolves for tanks/silos, multi-hole
boolean chains) is curated in the dataset but not the model's primary target.

### Model deployment

No fine-tuning shipped in this submission. The deployed app runs stock
`onnx-community/gemma-4-E4B-it-ONNX` in-browser via Transformers.js v4 (WebGPU path).
No LoRA adapter is loaded at runtime.

The 60-row prompt cache was built from a precursor Gemma 3 4B LoRA's eval outputs
(see `outputs/archive-gemma3-2026-05-05/`) and remains as a deterministic
single-element demo path. A Gemma 4 retrain is future work — the precursor
Gemma 3 LoRA is archived in the repo for reproducibility, not loaded at runtime.

Training scripts are scaffolded in `src/train/` (Unsloth FastModel, QLoRA, full
dataset pipeline). The dataset (`fixtures/`, `data/`) is fully deterministic and
ships with the repo. See [`submission/repro.md`](repro.md) for the dataset build steps.

### Browser runtime

- **Vite 8.0.10** + **TypeScript 5.3** + **vite-plugin-wasm** + **vite-plugin-top-level-await**
- COOP+COEP headers in dev + preview servers (SharedArrayBuffer prerequisite for both WASMs)
- ES-module worker hosting the geometry kernel — main thread never blocks
- **replicad 0.20.0** (`^0.20` pinned in `package.json`) + **replicad-opencascadejs 0.20.2** for the geometry kernel
- **web-ifc 0.0.77** for IFC4 STEP-21 round-trip verification
- **three.js 0.162.0** + OrbitControls for the viewer (Z-up to match replicad)
- Bundle (verified 2026-05-05 against `bun run web:build` + the deployed
  GH Pages build via curl): main JS 8.22 MB / gzip 0.72 MB · worker 3.88 MB
  · replicad OpenCascade WASM 10.8 MB / gzip 4.58 MB · web-ifc WASM 1.3 MB
  / gzip 0.48 MB · CSS 61 kB / gzip 12 kB. Lazy-loaded chunks for PDF export
  (jspdf, html2canvas, dompurify) total ~1.2 MB / gzip 0.26 MB on demand.

### AI prompt → geometry pipeline

Two paths back the page's prompt textbox; the user picks via configuration,
the default is the cache.

**Path 1 — bundled cache.** Sixty prompt → JS pairs are built into the bundle
by `scripts/build-ai-cache.ts` (run at `bun run web:build`). They come from
`data/dsl-demo-corpus.jsonl` (19 DSL corpus rows), the Schultz Residence gold
sequence, and the precursor Gemma 3 LoRA eval outputs (archived at
`outputs/archive-gemma3-2026-05-05/`). On a typed prompt, `web/src/ai-generate.ts`
does weighted-F1 fuzzy match (numeric and dimension tokens count 2x) against the
cache and returns the closest match's JS. Sub-100ms. No GPU. No network.

This path makes the demo bullet-proof for judges who don't want to wait for WebGPU model load.

**Path 2 — live Gemma 4 (default for novel prompts).** Stock
`onnx-community/gemma-4-E4B-it-ONNX` loads in-browser via Transformers.js v4
(WebGPU). No adapter loaded. Novel prompts that miss the cache go directly to the
on-device model. `?gemma_model=e2b` URL param switches to the smaller E2B variant.

Both paths funnel into the same `generateGeometry()` interface, so the
backend can swap without touching the workbench wiring. Pipeline shape:

```
prompt textbox → ai-generate.generateGeometry()
              ├─ if loraUrl → POST /v1/chat/completions → JS
              └─ else → cache F1 fuzzy match → JS
              ↓
        #js-source textarea → run-btn click → worker.ts
              ↓
        replicad execute() → mesh + IFC
```

### IFC4 export

We chose to **hand-emit STEP-21 text** rather than use web-ifc's
`CreateIfcEntity` API. STEP-21 is the IFC wire format; emitting it
directly is testable line-by-line and the result loads in BlenderBIM,
Solibri, IFC.js viewers, BimVision unchanged. web-ifc is then used as a
**verifier**: the page round-trips its own bytes through `IfcAPI.OpenModel`
and counts the `IfcBuildingElementProxy` entities to confirm the file is
parseable.

### Self-harness

A separate `bun scripts/web-self-harness.ts` exercises the same data path
the worker takes — execute against tier1, mesh via OpenCascade, build IFC
bytes, validate STEP-21 structure (header, schema marker, footer, exact
face count, exactly one IfcBuildingElementProxy / IfcFacetedBrep /
IfcClosedShell). All 9 demos pass (8 dropdown + Schultz hero).

```
gemma-architect web self-harness — 9 demos
OpenCascade ready.
  PASS  wall                 Solid 12 tris  5.50×0.20×2.80m  ifc=4.4KB / 90 entities
  PASS  column               Solid 164 tris  0.90×0.90×5.00m  ifc=29.1KB / 694 entities
  PASS  raised-slab          Solid 12 tris  5.00×4.00×0.20m  ifc=4.0KB / 90 entities
  PASS  slab-with-hole       Compound 20 tris  6.00×6.00×0.20m  ifc=5.3KB / 126 entities
  PASS  wall-with-door       Compound 20 tris  4.13×0.28×2.69m  ifc=6.4KB / 126 entities
  PASS  l-walls              Compound 20 tris  8.45×9.25×3.35m  ifc=5.8KB / 126 entities
  PASS  four-walled-room     Compound 32 tris  9.12×9.34×3.06m  ifc=8.3KB / 174 entities
  PASS  stair-step           Compound 36 tris  1.56×2.77×0.84m  ifc=10.0KB / 198 entities
  PASS  schultz-residence    Compound 120 tris  12.00×8.00×3.20m  ifc=24.6KB / 566 entities
9/9 demos passed.
```

A second harness, `bun scripts/test-ifc-bounds.ts`, exercises the
**IFC viewer** path on six bundled IFCs (one real architect-authored —
Schultz Residence; two ArchiCAD-export schema-validation fixtures —
AC20-FZK-Haus, AC20-Institute-Var-2; plus three smaller fixtures). See
[`submission/SAMPLES.md`](SAMPLES.md) for per-file provenance. It
validates that per-element world-space transforms come out of web-ifc's
column-major `flatTransformation` correctly — a regression in the
matrix block at `web/src/worker.ts:298-310` would collapse every
component to world origin (each FlatMesh would render at (0,0,0)).
Today: all 6 samples produce coherent buildings with thousands of
distinct per-part translations.

---

## Why this works specifically because of Gemma 4

- **On-device path.** Gemma 4 E4B-it (and the smaller E2B variant available via
  `?gemma_model=e2b`) fit inside the WebGPU memory budget of a mid-tier laptop GPU. There is no
  paid API in the deployment, no server we have to host. The submission
  ships as a static page on GitHub Pages today (single-thread WASM
  fallback because GH Pages can't serve COOP+COEP); HuggingFace Spaces
  and Vercel are drop-in upgrades that light up the multi-thread
  SharedArrayBuffer path. Free tier forever in any of the three.
- **Strong base instruction-following.** Stock Gemma 4 E4B-it handles the 12-op
  replicad vocabulary from the system prompt + few-shot examples without fine-tuning.
- **CC BY 4.0 license.** The repo ships under a license downstream users can deploy
  commercially without legal review.

A larger non-Gemma model would have meant either a paid API (kills the
free-tier deployment) or a server we'd have to host (kills the static-site
deployment). Both contradict the equity-track value prop.

---

## Reproducibility

`submission/repro.md` covers the full path: dataset build, training,
eval, web-app build, self-harness run. A single 4090 + 18 hours wall-clock
time is enough to reproduce every number in this writeup.

```bash
# Dataset (deterministic, seed 42)
PYTHONUTF8=1 python src/train/build_dataset_v2.py

# Training (~53 min on a 4090)
GEMMA_V2_MODEL=4b PYTHONUTF8=1 python src/train/lora_train_v2.py

# Eval (~5 min)
PYTHONUTF8=1 python src/train/inference_eval_v2.py --tag 4b-it

# Web app
bun install && bun run web:build && bun run web:preview

# Self-harness
bun scripts/web-self-harness.ts
```

---

## What ships with this submission

- **GitHub repo**: `github.com/wordingone/gemma-architect` — CC BY 4.0,
  full source, training scripts scaffolded in `src/train/`, web app in `web/`.
  Six starter skill-graph clusters in `web/src/skills/starter-clusters.ts`
  (Wall Row, Window Array, Room, Roof Walls, Stair Flight, Skylight Grid).
- **Model**: no LoRA adapter ships in this submission. The deployed app runs stock
  `onnx-community/gemma-4-E4B-it-ONNX` in-browser. Training scripts are scaffolded
  for a future Gemma 4 retrain; the prior Gemma 3 4B LoRA is archived at
  `outputs/archive-gemma3-2026-05-05/` and not loaded by the deployed app.
- **Hosted live demo**: GitHub Pages — https://wordingone.github.io/gemma-architect/
  (single-thread WASM fallback because GH Pages can't serve COOP+COEP; the
  multi-thread path lights up on any host that can — Spaces, Vercel, etc.).
- **3-min demo video**: linked from `submission/demo-script.md`.

---

## Limitations

Honest about scope:

- **Stock Gemma 4 E4B-it on novel prompts.** The base model (no fine-tune) emits
  correct verb names for simple prompts but may produce dimensionally imprecise
  sequences — "wrong-args" mode, not hallucination. The 60-row cache covers
  the bundled demos correctly. Novel prompts rely on the base model's instruction
  following; a future Gemma 4 LoRA retrain is the planned fix.

- **Tier 1 vocabulary only** — schematic-design primitives. A user finishing
  a real project hands the IFC export to a CAD-trained collaborator for
  detailing.
- **Not a structural validator** — the model produces geometry that *could*
  be a wall; it does not check the wall would stand. That belongs to the
  engineer who picks up the IFC export.
- **English only** — corpus expansion to other languages is a dataset job,
  not a model-architecture job.
- **Semantic placement gaps** — the held-out eval scores runtime_pass (the
  JS executes and produces a Solid). Some emitted sequences place
  components in geometrically-imprecise positions (e.g., the four-walled
  room's bounding box is wider than the spec calls for because each wall's
  centered rectangle plus translate doesn't perfectly align corners).
  The asymmetric Tier 1 conventions
  ([`docs/tier1-conventions.md`](../docs/tier1-conventions.md)) — `makeBox`
  is centered in X/Y but base-at-origin in Z; `sketchOnPlane("XZ")`
  extrudes along −Y not +Y — are the dominant source of these "runs but
  off by a wall thickness" errors. Tier 2 dataset work + per-row positional
  eval (was the prompt's spatial intent honored within tolerance?) is the
  obvious next step.
- **2D sketch primitives shipped (PR #7, fc1284c)** — solids, arch elements,
  and 2D sketch primitives all work end-to-end on both the prompt path and
  the PROMPT tab's CONSOLE mode. All 6 palette buttons are present (`line`,
  `rect`, `circle`, `polyline`, `curve`, `point`); 4 of 6 DSL verbs (`line`,
  `circle`, `rect`, `point`) render as `THREE.Line` / `THREE.RingGeometry` /
  sphere marker on the Z=0 plane via `drawX().sketchOnPlane("XY")`. The
  remaining gap: the LoRA training corpus (`dataset/v2/`) does not yet include
  2D-primitive prompts, so the AI path never routes to them — the demo flow
  uses solid/arch vocab. Extending the training set with sketch rows is the
  obvious next dataset step.

---

## What I'm proudest of

The pipeline ends with a real IFC4 file the user downloads. Not a screenshot.
Not a JSON blob. A file that opens in the same software the architect
across town is paying $3K/year to use. That's the equity claim — not
"we made architecture more impressive," but "we made architecture's output
format accessible from a free webpage typed into in plain English."

---

## Links

- **Repo**: https://github.com/wordingone/gemma-architect
- **Training scripts**: `src/train/` (Gemma 4 retrain is future work)
- **Live demo**: https://wordingone.github.io/gemma-architect/
- **Demo video**: (YouTube URL — to be filled at submission time)
- **Reproduction guide**: `submission/repro.md`
- **Impact statement**: `submission/impact.md`
