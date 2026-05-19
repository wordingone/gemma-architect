# Impact — gemma-architect

**Track:** Equity
**Hackathon:** Gemma 4 Good Hackathon (Kaggle + Google DeepMind), deadline 2026-05-18

## Who benefits

Parametric CAD — the kind of design tool a building gets drawn in before
construction — sits behind a multi-thousand-USD/year subscription wall.
Revit ($3,025/yr), AutoCAD ($2,030/yr), ArchiCAD (~$2,800/yr first seat)
plus the OS, the workstation, the training. The tools that exist on the
free side (FreeCAD, Blender + BlenderBIM) all assume the user already
*knows* how parametric modeling works — that they can think in extrudes,
sketches, and constraint solvers. That assumption excludes most of the
people who would benefit from designing space.

gemma-architect collapses the prerequisite. It is a static web page.
A user types `"a wall, 5.5m long, 0.2m thick, 2.8m tall"`, the page
generates the geometry, renders it in a 3D viewer, and exports an IFC4
file readable by every BIM tool on the planet (Revit, ArchiCAD, BlenderBIM,
Solibri, IFC.js viewers, BimVision). Parameters become sliders the user
can drag without ever opening a modeling environment.

The equity case is the prompt-to-IFC path: a small-shop architect types a
sentence, the page generates geometry in-browser (no server, no API key),
and exports an IFC4 file readable by any BIM tool. Stock Gemma 4 E4B-it
runs on-device via Transformers.js; no fine-tune or adapter is required.
The 60-row prompt cache provides sub-100ms responses for common one-liner
prompts; the on-device model handles novel prompts.

The audience who gains access:

- **Small-shop architects** in regions where commercial CAD is priced for
  Western firms — the people designing low-cost housing in places where a
  Revit license costs three months' wages.
- **DIY home renovators** sketching an extension before getting it engineered.
- **Students in low-resource regions** learning architectural concepts without
  the per-seat license barrier.
- **Makerspace builders, community-build organizers, vernacular-construction
  teams** who need parametric drawings to brief contractors but don't have a
  CAD workflow today.

## Why this works specifically because of Gemma 4

Three properties of Gemma 4 made this approach feasible inside an 18-day
window:

1. **On-device inference path.** Gemma 4 E4B-it fits inside the WebGPU memory
   window of a mid-tier laptop GPU (E2B is available via `?gemma_model=e2b`).
   No server roundtrip, no per-query API cost, no rate limit. The
   submission ships as a single static page on GitHub Pages today;
   HuggingFace Spaces and Vercel are drop-in upgrades that light up
   COOP+COEP multi-thread WASM. Free tier forever in any of the three.
2. **Strong base instruction-following.** Stock Gemma 4 E4B-it handles
   architectural prompts in-browser without fine-tuning. The replicad
   vocabulary is small enough (~12 ops) that the base model learns it from
   the system prompt and few-shot examples.
3. **CC BY 4.0 license** — the repo ships under a license the hackathon
   and downstream users can deploy commercially without legal review.
4. **60-row prompt cache for instant demos.** Prompt → JS pairs (built from
   `data/dsl-demo-corpus.jsonl` + Schultz gold + archived Gemma 3 LoRA eval)
   ship with the bundle. A user without a GPU, behind a network-blocked demo VM,
   or on a low-spec laptop hits the demo experience in ~50 ms via cache fuzzy
   match. Novel prompts fall through to the on-device Gemma 4 model.

A larger non-Gemma model would have meant either a paid API (kills the
free-tier deployment) or a server we'd have to host. Both contradict the
equity-track value prop.

## Adoption path

The submission is not a research artifact; it's a deployable web app.

**Phase 1 (today, hackathon submission)**
- Static page at GitHub Pages (https://wordingone.github.io/gemma-architect/),
  free tier; HF Spaces / Vercel are COOP+COEP-capable upgrade paths.
- Repo at github.com/wordingone/gemma-architect, CC BY 4.0.
- No LoRA adapter in this submission; training scripts scaffolded for a future Gemma 4 retrain.
- Vocabulary: Tier 1, 12 ops covering walls, slabs, columns, footings,
  basic openings (cut), L-shape and U-shape footprints. ~85% of the
  building primitives a small-shop architect produces in a typical
  schematic-design phase.

**Phase 2 (1–3 months out)**
- Tier 2 vocabulary: revolves (cylindrical tanks, tapered silos, toroidal
  forms), multi-hole boolean cuts, more sophisticated boolean chains.
- Sketch-to-IFC: wire the `reconstructFromImage` agent (exists in `main.ts`,
  not connected to file-drop yet). Phase 2 adds the drag-PNG → IFC path.
- Photo-to-IFC: Gemma 4 multimodal function-calling for annotated floorplan photos.
- IFC4 → IFC4x3 spec coverage for civil-infrastructure projects.

**Phase 3 (6–12 months)**
- Browser-native generative iteration: the user types a refinement
  (`"make the doorway 1.2m wide"`) and the model edits the JS source instead
  of regenerating from scratch.
- Layer / project / room-program management — the runtime state the model
  intentionally never sees in v1, so it can stay context-light.
- Self-hosted deployment recipe for organizations that want a private
  instance (no inference call leaves their network).

## Numbers we can defend

- **Self-harness**: 9 demo prompts verified end-to-end (parse + run + IFC).
- **Self-harness**: 9 demo prompts span single-element (wall, column,
  raised slab), parametric variation, multi-element fuse + boolean cut
  (slab-with-hole, wall-with-door, four-walled-room, stair-step,
  l-walls), and the 14-element Schultz Residence hero. Each produces a
  valid IFC4 STEP-21 file that round-trips through `web-ifc.OpenModel`.
  Single-element demos emit one `IfcBuildingElementProxy` /
  `IfcFacetedBrep` / `IfcClosedShell`; the Schultz hero emits 566 IFC
  entities across the multi-element compound. A hand-written companion
  harness (`bun scripts/leo-as-architect.ts`, 8/8) exercises Tier 2 ops
  the canned demos don't (revolves, gables, T-junctions, octagonal
  columns). Run via `bun scripts/web-self-harness.ts`.
- **Bundle size** (verified 2026-05-05 against the deployed
  `wordingone.github.io/gemma-architect/` build via `curl -sI`): an
  8.22 MB main JS chunk (gzip 0.72 MB) + a 3.88 MB worker chunk +
  replicad's 10.8 MB OpenCascade WASM (gzip 4.58 MB) + web-ifc's 1.3 MB
  WASM (gzip 0.48 MB) + a 61 kB CSS chunk (gzip 12 kB). Lazy-loaded for
  PDF export (drawer-on-demand, not first-paint): jspdf 823 kB / gzip
  154 kB, html2canvas 200 kB / gzip 47 kB, dompurify 22 kB / gzip 9 kB.
  Total cold-load wire size on first paint is still dominated by the
  OpenCascade WASM (~5.8 MB gzip total first-paint, of which 4.58 MB is
  OpenCascade); both WASMs gzip well, so an empty-cache load is
  reasonable on a mid-tier consumer link. COOP+COEP headers are required
  for the multi-threaded WASM path (SharedArrayBuffer prerequisite);
  GitHub Pages cannot serve those, so the live page falls back to
  single-thread WASM gracefully.
- **Live page latencies** (verified 2026-05-05 against the deployed URL,
  single-thread WASM, no COOP+COEP): cache hit ~7 ms; wall full
  prompt→geometry cycle ~21 ms; 14-element Schultz Residence
  multi-fuse+cuts ~210 ms. ai-cache.json CDN first fetch ~116 ms, warm
  ~1 ms. These are the numbers a non-CAD user actually sees on a
  consumer GH Pages link with no header tricks.
- **License chain** (verified against `node_modules/*/LICENSE` files at
  the deployed bundle's pinned versions): CC BY 4.0 on the repo,
  LGPL-2.1 on replicad 0.20.0 and replicad-opencascadejs 0.20.2 (plus
  the bundled OpenCascade WASM separately under LGPL-2.1 with linking exception),
  MPL-2.0 on web-ifc 0.0.77, MIT on three.js 0.162.0. MPL-2.0 is
  weakly copyleft per file (modifications to web-ifc files redistributed
  must stay MPL, but our app code that *uses* web-ifc has no copyleft obligation).
  LGPL-2.1 on replicad allows dynamic linking without copyleft propagation.

## What this is not

To be honest about scope:

- **Not a Revit replacement.** The Tier 1 vocabulary covers schematic-design
  primitives, not detailed construction documents. A user finishing a real
  project will hand the IFC export to a CAD-trained collaborator for
  detailing.
- **Not a structural validator.** The model produces geometry that *could*
  be a wall; it does not check that the wall would stand. That belongs to
  the engineer who picks up the IFC export.
- **Not multilingual.** v1 is English-only. The dataset has no Korean,
  Spanish, or Portuguese paraphrases yet — adding them is a corpus-expansion
  job, not a model-architecture job.

The equity claim is honest about what it solves: **the entry barrier**.
What happens after the entry — engineering review, code compliance,
construction — is the rest of the world's problem to solve. We're trying
to remove the part where a person who can't afford a $3K/year subscription
can't even start.
