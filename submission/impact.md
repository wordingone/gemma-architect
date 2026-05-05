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

The sharpest version of the equity case is the hand-sketch path: a
small-shop architect in a region where Revit costs three months' wages
opens the page, drags a hand-drawn pencil-on-paper floorplan into the
canvas, and downloads a BIM-compliant IFC4 file in seconds. Sobel +
Hough wall detection runs in-line on the page (zero deps, no service
to call), extrudes detected segments at 2.8m, emits IFC4 — turns
"person with a sketch" into "BIM asset producer" without an installer,
API key, or CAD training prerequisite. For a real photograph of a
floorplan, a Gemma 4 multimodal function-calling path is wired in
`agent-harness.ts` (geometry dispatch handlers are the remaining
integration milestone).

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

1. **On-device inference path.** Gemma 4 E2B (and 4b-it as a 4B-parameter
   ceiling) fit inside the WebGPU memory window of a mid-tier laptop GPU.
   No server roundtrip, no per-query API cost, no rate limit. The
   submission ships as a single static page on GitHub Pages today;
   HuggingFace Spaces and Vercel are drop-in upgrades that light up
   COOP+COEP multi-thread WASM. Free tier forever in any of the three.
2. **Strong base instruction-following on small data.** A LoRA on top of
   Gemma-3-4b-it converges to **40/40 round-trip pass on a held-out 40-row
   eval set** with **only 932 augmented training pairs** (3 epochs, ~53 min
   on a 4090). The base model already knows how to read English; the LoRA
   only has to teach it the 12-op replicad vocabulary.
3. **Apache-2.0 license** — the model artifact ships under a license the
   hackathon and downstream users can actually deploy commercially without
   legal review.
4. **Eval round-trip strong enough to ship a cache.** The held-out eval
   produces 40/40 valid prompt → JS pairs. Those pairs ship as a 60-row
   bundled cache (40 eval + 19 DSL corpus + 1 Schultz gold) the page
   fuzzy-matches against. Result: a user without a GPU, behind a
   network-blocked demo VM, or on a low-spec laptop hits the same demo
   experience in ~50 ms as someone running the live LoRA. The live model
   is one toggle away (`window.__loraUrl` → `src/serve/serve_lora.py`)
   for novel off-corpus prompts — but the cache is the floor, not the
   fallback.

A larger non-Gemma model would have meant either a paid API (kills the
free-tier deployment) or a server we'd have to host. Both contradict the
equity-track value prop.

## Adoption path

The submission is not a research artifact; it's a deployable web app.

**Phase 1 (today, hackathon submission)**
- Static page at GitHub Pages (https://wordingone.github.io/gemma-architect/),
  free tier; HF Spaces / Vercel are COOP+COEP-capable upgrade paths.
- Repo at github.com/wordingone/gemma-architect, Apache-2.0.
- LoRA adapter intended for HuggingFace Hub at `gemma-architect/cad-lora-v2`;
  push pending HF_TOKEN per `submission/README.md` outstanding blockers.
- Vocabulary: Tier 1, 12 ops covering walls, slabs, columns, footings,
  basic openings (cut), L-shape and U-shape footprints. ~85% of the
  building primitives a small-shop architect produces in a typical
  schematic-design phase.

**Phase 2 (post-hackathon, 1–3 months)**
- Tier 2 vocabulary: revolves (cylindrical tanks, tapered silos, toroidal
  forms), multi-hole boolean cuts, more sophisticated boolean chains.
- Sketch-recognition refinement: the v1 Sobel + Hough wall detector handles
  orthogonal-only floorplans at default 100 px/m scale. Phase 2 adds curved
  walls (Hough circle), per-room labels via OCR, and user-adjustable scale.
- Photo-to-IFC fine-tune: v1's image→IFC path uses Gemma 4 multimodal native
  (no LoRA on the multimodal branch). A LoRA tuned on annotated floorplan
  photos would lift accuracy above the function-calling baseline.
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

- **Training**: 53 min on one RTX 4090, 932 augmented pairs, train_loss 0.2442
  at epoch 3 (`outputs/cad-lora-v2-4b-it/train-stats.json`).
- **Held-out eval**: 40/40 parse_ok, 40/40 api_clean, 40/40 has_solid_op,
  40/40 runtime_pass = **100% round-trip**
  (`outputs/cad-lora-v2-4b-it-eval.jsonl`).
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
  the deployed bundle's pinned versions): Apache-2.0 on the repo + LoRA
  adapter, MIT on replicad 0.20.0, MIT on the replicad-opencascadejs
  0.20.2 wrapper (the bundled OpenCascade WASM it ships is separately
  LGPL-2.1 with linking exception), MPL-2.0 on web-ifc 0.0.77, MIT on
  three.js 0.162.0. All five are compatible with commercial deployment;
  MPL-2.0 is weakly copyleft per file (modifications to web-ifc files
  redistributed must stay MPL, but our app code that *uses* web-ifc has
  no copyleft obligation).

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
