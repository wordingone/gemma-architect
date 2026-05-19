# External References — gemma-architect

**Canonical catalogue of external products, datasets, papers, standards, and libraries relevant to the gemma-architect arch-1 build for the Gemma 4 Good Hackathon.**

Sourced and analyzed 2026-05-01. This file is the durable record. Memory pointer at `reference_gemma_architect_external_resources.md` resolves here.

---

## 1. Closest direct prior art (LLM → CAD)

| Reference | Where | What | Caveat |
|---|---|---|---|
| **Pointer-CAD** (Qi, Wang, Xu, Chu, Zhao, Liu, Ding, Ma, Gao) | arXiv [2603.04337](https://arxiv.org/abs/2603.04337) | Pointer-based edge/face selection over B-Rep + command sequences; LLM-driven CAD generation; supports fillet/chamfer; reduces topological errors from quantization. Dataset ~575K expert-annotated CAD models. | **Code NOT released yet (paper-only).** Closest direct prior art for the LLM-emits-CAD pattern. |
| **DreamCAD** (Khan, Usama, Potamias, Stricker, Afzal, Deng, Elezi) | arXiv [2603.05607](https://arxiv.org/abs/2603.05607) | Multi-modal CAD generation via differentiable parametric surfaces; mesh-to-B-Rep without CAD-specific annotations; differentiable tessellation enables training on unannotated 3D. Introduces CADCap-1M (1M+ captions). | **Code not released as of 2026-05-01 re-check.** CADCap-1M dataset released on HF (`SadilKhan/CADCap-1M`) but `CC-BY-NC-SA-4.0` + gated → BLOCKS competitive use (§17 gate 4). |
| **ArchCAD-400K** (Luo et al, 16 collaborators) | arXiv [2503.22346](https://arxiv.org/abs/2503.22346) | Panoptic symbol spotting on architectural CAD drawings. Dataset 413,062 chunks from 5,538 standardized drawings (26× prior). Method: Dual-Pathway Symbol Spotter (DPSS). | More relevant to drawing-recognition than emission, but dataset is huge. |
| **BRepNet** (Lambourne, Willis, Jayaraman et al, 2021) | arXiv [2104.00706](https://arxiv.org/abs/2104.00706), CVPR 2021 | Topological message-passing on solid models; releases Fusion 360 Gallery segmentation dataset (35K+ annotated B-rep models). Foundational for B-Rep ML. | Pre-LLM era. Original Autodesk Research PDF URL is 404 (verified 2026-05-01 Pass 1A). |

## 2. Datasets

| Dataset | Where | Scale / shape | Relevance |
|---|---|---|---|
| **ABC Dataset** (Koch et al) | arXiv [1812.06216](https://graphics.stanford.edu/courses/cs348n-22-winter/PapersReferenced/ABC%20Data%20Set%201812.06216.pdf) | ~1M CAD models | Foundational large CAD corpus, geometric deep learning benchmark. |
| **Fusion 360 Gallery Dataset** | [github.com/AutodeskAILab/Fusion360GalleryDataset](https://github.com/AutodeskAILab/Fusion360GalleryDataset) | Parametric CAD with command sequences (sketches, extrudes, joins) | Direct precedent for LLM-as-command-emitter. Format-aligned with our emission target. |
| **Matterport3D** | [github.com/niessner/Matterport](https://github.com/niessner/Matterport) | ~10K spaces, RGB-D scans, semantic labels | Photo-to-scene grounding. |
| **BIMNet dataset** (Tsinghua School of Software) | [thucbims.github.io](https://thucbims.github.io/bimnet.thucbims.github.io/) + [github.com/LydJason/BIMNet](https://github.com/LydJason/BIMNet) | 116.5M points, 25 real-world scans, 382 rooms, 8,700+ m², paired IFC | Scan-to-BIM benchmark with multi-dimensional eval framework (geometric + topological accuracy). |
| **WBDG / NIBS COBie common BIM files** | [wbdg.org/bim/cobie/common-bim-files](https://www.wbdg.org/bim/cobie/common-bim-files) | Federal-aligned reference openBIM files (.ifc) | IFC-export validation + judge-credibility samples. |
| **NIST Data Sets by Model Dimensions** | [nist.gov/el/data-sets-model-dimensions](https://www.nist.gov/el/data-sets-model-dimensions) | Wind-tunnel aerodynamic test data (UWO), organised by building model dimensions (roof slope, eave height, etc.) | Authoritative, niche — useful for wind-load validation, NOT general CAD reference geometry. (Catalogue mischaracterised as "reference geometry" until 2026-05-01 Pass 1B + Pass 2 fact-check.) |
| **CADCap-1M** | [huggingface.co/datasets/SadilKhan/CADCap-1M](https://huggingface.co/datasets/SadilKhan/CADCap-1M) (released; gated) | 1M+ CAD captions | Largest text-to-CAD corpus. License `CC-BY-NC-SA-4.0` — BLOCKS competitive use for $200K hackathon (§17 gate 4 update 2026-05-01); same NC + SA blockers as gate 2 BRepNet. |

## 3. Products / apps / repos

| Project | Where | Status | Notes |
|---|---|---|---|
| **pascalorg/editor** | [github.com/pascalorg/editor](https://github.com/pascalorg/editor), hosted at [editor.pascal.app](https://editor.pascal.app), CDN at `pascal-cdn.wawasensei.dev/items/` | MIT, v0.6.0 (2026-04-21 16:57 EDT, per `git log v0.6.0`), 11,058 LOC (TS/TSX, excl. node_modules; total source ~79 MB), 14,991 stars / 1,925 forks, CHANGELOG credits 14 distinct contributor handles, 26 distinct git commit authors all-time (incl. 2 bots). | **Analyzed in depth 2026-05-01** at `B:/M/gemma-architect-food/` (local fork). 5-agent investigation; LOC + commit-author + WebGL-fallback claims corrected post Pass 1+2+3 fact-check. See §5 below. |
| **BIMNet repo** | [github.com/LydJason/BIMNet](https://github.com/LydJason/BIMNet) | Tsinghua-published code | Scan-to-BIM benchmark. |

## 4. Showcases / governance / judging context

- **buildingSMART Awards Gallery** — [awards.buildingsmart.org/gallery](https://awards.buildingsmart.org/gallery). openBIM project showcase. Format references for what "rigorous BIM" looks like to industry judges. **Site returns 403 to WebFetch as of 2026-05-01 (parent domain also 403; redirect loop on `www.buildingsmart.org/awards`). Reach via browser if site comes back online; for now, treat as inaccessible until verified.**
- **WBDG (Whole Building Design Guide / NIBS)** — federal-aligned BIM credibility anchor.

## 5. pascal/editor — key takeaways

Full investigation in 5 parallel haiku agent reports (2026-05-01). Headline findings:

- **Scene model:** flat parametric graph, 19 node types in `packages/core/src/schema/nodes/`. Walls = `start[x,z] + end[x,z] + thickness + height + curveOffset`. Doors/windows/stairs/roofs all parametric. Stored as `Record<NodeId, AnyNode>` + `parentId` pointers. **This is the right LLM emission target shape.**
- **Renderer:** React Three Fiber + `three.js@0.184` + WebGPU-primary with WebGL2 fallback (iOS Chrome path). Fallback paths in `packages/viewer/src/lib/merged-outline-node.ts:172,308-309` and `packages/viewer/src/components/viewer/post-processing.tsx:196-200,387-388`; viewer logs `"No WebGPU device on backend — running on a fallback renderer"` (`viewer/index.tsx:112`). Wall cutouts via `three-bvh-csg`. **No replicad / no OpenCASCADE.** Export: GLB/STL/OBJ. **No IFC export.** (Original 5-agent report claimed "WebGPU-only no fallback"; Pass 3 fact-check verified WebGL2 fallback exists.)
- **MCP server:** `@pascal-app/mcp` is model-agnostic, exposes 37+ scene tools. Vision tools call MCP `sampling` (host-provided model). **Zero LLM bundled.** Default host = Claude Desktop.
- **App shell:** Next.js 16, SQLite, BetterAuth (Postgres + Supabase optional), 4 API routes, no LLM routes.
- **Verdict:** Lift the model (scene shape, vocabulary), not the code. pascal assumes external MCP host with cloud LLM; we need in-browser Gemma. pascal lacks IFC export (our sub-gate 3) and replicad (our solid modeler). Their Next.js + auth shell is overkill for hackathon.

## 6. Standards / formats

- **IFC** (buildingSMART) — industry-standard openBIM format. **Required for hackathon sub-gate 3 (export). Pascal does NOT export IFC; we add via web-ifc.**
- **COBie** (NIBS / WBDG) — facility-management subset of IFC. Optional; signals seriousness.
- **B-Rep** (boundary representation) — solid modeling kernel format. replicad/OpenCASCADE produces B-Rep.
- **GLB / GLTF** (Khronos) — three.js native, pascal default.
- **STL / OBJ** — three.js exporters.
- **Anthropic MCP protocol** — model-host-tool interface. Pascal uses it; we may not (in-browser model has no host to call).

## 7. Models

- `google/gemma-4-e2b` — primary in-browser inference target (~2B effective).
- `google/gemma-4-e4b` — alt target (~4B).
- Gemma 4 base TBD — awaiting base selection per user directive 2026-05-05. Legacy base training purged 2026-05-05.

## 8. Hackathon target

- **Gemma 4 Good Hackathon** (Kaggle + Google DeepMind) — $200K, deadline 2026-05-18. 5 tracks: health, climate, education, equity, safety. Judged on impact + tech + clarity. Emphasis: low-bandwidth / no-cloud / privacy-critical.
- **Unsloth $10K side-prize** — separate track on Unsloth-fine-tuned models.

## 9. Hosting / registries

- **HuggingFace Hub** — model artifact host (`gemma-architect/cad-lora-v2` is the intended path; push pending HF_TOKEN — see `submission/README.md` outstanding blockers and `dataset/v2-results.md` §Publish).
- **Kaggle** — submission platform.
- **arXiv** — paper source for all four CAD/LLM papers above.

## 10. Libraries / SDKs

**Confirmed-via-pascal:** three.js, @react-three/fiber, @react-three/drei, three-bvh-csg (limited), `@modelcontextprotocol/sdk`, idb-keyval, Zustand, Zundo, Zod, Next.js 16, BetterAuth, Resend, Postgres, Supabase, SQLite, WebGPU API.

**NOT in pascal but needed for arch-1:**
- **replicad** (sgenoud/replicad) — OpenCASCADE.js solid modeler running in a Worker. Gives proper boolean ops + B-Rep.
- **web-ifc** (IFCjs/web-ifc) — IFC parsing/export. Closes hackathon sub-gate 3.
- **transformers.js** (huggingface) OR **webllm** (mlc-ai) — in-browser LLM runtime. Pick after benchmark.

## 11. Gaps — filed for future sweep

- No competing browser-native CAD products surveyed (BlenderGPT-style, OnShape/Shapr3D web demos, Tinkercad, SketchUp Web).
- No prior Kaggle / DeepMind hackathon winners on architectural / CAD topics scouted.
- No other in-browser LLM-driven 3D editor prototypes found.
- No GSA / Department of Energy reference BIM file corpora beyond WBDG.
- buildingSMART certified-software list not enumerated.
- No survey of recent (2026) parametric-CAD-emission preprints beyond the four cited.

## 12. How to apply

| When you... | Do this |
|---|---|
| Designing arch-1 emission target | Start from pascal's parametric flat-graph node model; cross-reference Pointer-CAD and Fusion360 for vocabulary inspiration. |
| Need IFC export | Use web-ifc; pascal does not have it. |
| Validating output | Pull a WBDG common BIM file as test case; compare round-trip. |
| Framing hackathon writeup | Cite Pointer-CAD as closest prior-art-without-code; position arch-1 as the missing in-browser local-first execution of that pattern. |
| Seeking dataset for fine-tune scale-up | Fusion360 Gallery (parametric command sequences) is the most format-aligned; BIMNet for scan-to-BIM grounding; ArchCAD-400K for symbol pretraining. |

## 13. Provenance

Sourced 2026-05-01 from user-supplied URL list + 5-agent haiku investigation of `B:/M/gemma-architect-food/`. arXiv abstracts re-verified at WebFetch time (DreamCAD, ArchCAD-400K, Pointer-CAD). BIMNet detail from Tsinghua project page. Pascal detail cross-verified across 5 parallel agents.

### 13.1 Fact-check log (2026-05-01 Pass 1 → 2 → 3)

Three iterative fact-check passes (haiku agents, then Leo primary-source verification) corrected the following original claims:

| # | Section | Original | Corrected | Verified by |
|---|---|---|---|---|
| 1 | §1 BRepNet URL | `research.autodesk.com/.../BRepNet-...pdf` (404 dead) | arXiv [2104.00706](https://arxiv.org/abs/2104.00706), CVPR 2021 | Pass 1A WebFetch + Pass 2 confirm |
| 2 | §2 NIST description | "Reference geometry" | "Wind-tunnel aerodynamic test data (UWO), organised by building model dimensions" | Pass 1B + Pass 2 WebFetch of `nist.gov/el/data-sets-model-dimensions` |
| 3 | §3 pascal LOC | "~30K LOC" | "11,058 LOC TS/TSX" | Leo `find ... wc -l` on local clone (Pass 3 ground-truth) |
| 4 | §3 pascal contributors | "14+ contributors" (ambiguous) | "14 credited handles in CHANGELOG / 26 git commit authors all-time" | Leo `git log --format='%an' \| sort -u` on local clone |
| 5 | §4 buildingSMART access | implicit assumption: live URL | 403 on both `/gallery` and parent domain as of 2026-05-01 | Pass 1B + Pass 2 WebFetch |
| 6 | §5 pascal renderer | "WebGPU-only (no WebGL fallback)" | "WebGPU-primary with WebGL2 fallback" + file:line citations | Leo grep of `packages/viewer/src` (Pass 3 ground-truth) |

Confirmed-clean (no correction needed): Pointer-CAD / DreamCAD / ArchCAD-400K arXiv papers, ABC mirror, Fusion360 Gallery dataset content, BIMNet statistics (116.5M / 25 / 382 / 8,700+), WBDG common BIM files presence, pascal v0.6.0 date (2026-04-21 16:57 EDT), pascal stars (14,991) / forks (1,925), MCP server model-agnostic + zero-LLM-bundled claim.

Lessons: (a) Pass 1 surfaced 6 issues but introduced 1 false positive (contributor count); Pass 2 + Pass 3 + primary-source verification refuted the false positive and surfaced 3 new corrections. (b) Multi-pass fact-check converges on truth ≠ "delegate verification to one agent." (c) Even Pass 2 and Pass 3 produced date-related hallucinations (Pass 2: "2025-04-22"; Pass 3: "2026-04-22 06:05 UTC") — only Leo's direct `git log` matched the original catalogue ("2026-04-21"). The closest source of truth wins.

## 14. Maintenance

- Append-only by default. When something changes (e.g., Pointer-CAD code releases), add a dated note rather than overwriting.
- Re-verify external URLs quarterly or before any new hackathon submission.
- New survey results (gaps in §11) get appended to the relevant section, not a new file.
- This file is the canonical record. Memory pointer is a navigational hint, not a backup.

## 15. Comparison matrix — 18-day hackathon ranking

Synthesised 2026-05-01 after Pass 1+2+3 source verification + per-reference substance extraction (paper PDFs, dataset READMEs, GitHub LICENSE files).

| Rank | Reference | Type | License | Code released? | Format-aligned with arch-1 emission target? | arch-1 role | 18-day blocker? |
|---|---|---|---|---|---|---|---|
| 1 | **pascal/editor model** | Browser CAD product | MIT | yes (lifting model only) | YES — flat parametric graph, 19 node types | Runtime template + emission target shape | None |
| ✕ | **Fusion360 Gallery — Reconstruction subset** | Dataset | custom NC ("non-commercial research only") | yes | YES — JSON sketch+extrude+revolve+sweep+loft+fillet+chamfer; ~400-500 tok/model | DROPPED — see §17 gate 1 | **NC license excludes $200K-prize derivative** |
| 3 | **ArchCAD-400K dataset** | Dataset | CC BY 4.0 | yes (HF + GitHub) | NO (recognition) but symbol vocab is grammar input | Emission grammar anchor; 27 architectural symbol classes | None |
| 4 | **BIMNet paired IFCs** | Dataset | MIT (code) + Matterport ToU (scans) | yes | PARTIAL — 382 manually-modeled IFCs | Round-trip validation corpus | Matterport ToU on scans only; IFCs alone are usable |
| ✕ | **BRepNet (encoder/validator)** | Method (recognition) | CC-BY-NC-SA 4.0 (whole repo) | yes (Autodesk AI Lab repo) | NO (segmentation) | DROPPED — see §17 gate 2 | **NC + SA both incompatible with prize-eligible permissive release** |
| 6 | **ABC dataset** | Dataset (geometry-only) | nonexclusive distrib | yes (NYU) | NO — final geometry only, no operation history | Pretraining for shape encoder; not for emission LoRA | None |
| 7 | **DreamCAD method ideas** | Method paper-only | n/a (no code) | NO | Concept-only: forward-only B-rep inference | Inspiration; reimplement-from-scratch infeasible in 18d | Code release status: not announced |
| 8 | **Pointer-CAD method ideas** | Method paper-only | n/a (Snitro/Pointer-CAD: "coming soon") | NO | Concept-only: pointer over B-rep entities | Inspiration; can lift pointer-vs-quantization framing for tokenization | Code release status: timeline unstated |
| ✕ | **Matterport3D** | RGB-D scan dataset | Matterport ToU (signed agreement) | yes (gated) | NO — no IFC, photo-of-scene only | Out of scope for arch-1 (text→IFC, not photo→IFC) | n/a |

Tie-breakers when format-alignment is equal: license clarity > code reachability > dataset format > paper-only ideas. Both NC-licensed entries (Fusion360 rank 2, BRepNet rank 5) dropped 2026-05-01 after empirical license-text verification (§17 gates 1 + 2). Pascal/editor remains rank 1 unchallenged; LoRA training corpus moves to D1-D3 synthetic+hand-curated path (already shipped per #99-#101); topological validation moves to in-house web-ifc + replicad checks (no ML validator).

## 16. Use-case cross-reference

Map each arch-1 implementation sub-task to the references that contribute concretely.

| Sub-task | Primary | Secondary | Role |
|---|---|---|---|
| **Emission target shape** (LLM output schema) | pascal/editor 19-node model | Fusion360 Reconstruction JSON, Pointer-CAD ideas | pascal gives flat-graph + parentId pointers; Fusion360 gives sketch/extrude/revolve/sweep/loft/fillet/chamfer vocabulary |
| **LoRA training corpus** | D1-D3 synthetic IFC + tier2 hand-curation (400 pairs, shipped #99-#101) | ABC pretrain | Fusion360 Reconstruction excluded 2026-05-01 (§17 gate 1 — NC license). DreamCAD CADCap-1M dataset IS released on HF (`SadilKhan/CADCap-1M`) but CC-BY-NC-SA-4.0 + gated → BLOCKED for hackathon (§17 gate 4 update 2026-05-01, same NC + SA blockers as gate 2). D1-D3 path is the binding corpus. |
| **Architectural symbol grammar** | ArchCAD-400K (27 classes) | WBDG COBie samples | Constrain emission to industry-standard names |
| **In-browser inference** | webllm OR transformers.js | pascal WebGPU+WebGL2 fallback patterns | Pick runtime after benchmark; pascal renderer files show real-world WebGPU/WebGL2 fallback handling |
| **Solid modelling kernel** | replicad (sgenoud) | OpenCASCADE.js (replicad's underlying lib) | NOT in pascal; needed for proper boolean ops + B-Rep |
| **IFC export** | web-ifc (IFCjs) | BIMNet IFC examples for validation | Closes hackathon sub-gate 3 |
| **Round-trip validation** | BIMNet 382 IFCs, WBDG 4 reference projects | NIST geometry data NOT applicable (wind-tunnel aero) | Round-trip a known-good IFC through arch-1 → diff |
| **Topological correctness check** | In-house geometric checks via web-ifc + replicad (manifoldness, closed-edge counts, face-count parity) | ArchCAD-400K DPSS for 2D drawings | BRepNet excluded 2026-05-01 (§17 gate 2 — CC-BY-NC-SA NC + SA both block). |
| **MCP integration** | pascal/editor `@pascal-app/mcp` (37+ tools) | Anthropic MCP SDK | NOT needed for arch-1 in-browser; consider only if ship-as-MCP-server fallback |
| **Hackathon writeup framing** | Pointer-CAD ("closest prior art without code") | DreamCAD ("multimodal forward-only ideal") | Position arch-1 as missing in-browser local-first execution of the LLM-emits-CAD pattern |

## 17. Open verification gates

Closed gates (resolved 2026-05-01):

1. **Fusion360 Gallery LICENSE — RESOLVED, BLOCKED for hackathon.** Custom proprietary license, not standard open-source. Verbatim: *"You may access, use, reproduce and modify the Dataset, in each case, only for non-commercial research purposes."* Downstream recipients must be bound to identical NC restrictions; redistribution of the whole dataset prohibited; no warranties; California law governs. Source: `https://github.com/AutodeskAILab/Fusion360GalleryDataset/blob/master/LICENSE.md` (WebFetched 2026-05-01). $200K hackathon prize is a monetary-compensation derivative; conservative reading = commercial use prohibited. **Effect on §15 rank 2:** drop from training corpus options. **Effect on D1-D3 corpus path (synthetic IFC + tier2 hand-curation, 400 pairs):** unchanged — that path was already chosen. Fusion360 was a hypothetical alternative, not a dependency.
2. **BRepNet NC license vs Kaggle hackathon prize — RESOLVED, BLOCKED for hackathon.** License: CC BY-NC-SA 4.0 (Creative Commons Attribution-NonCommercial-ShareAlike). Source: `https://github.com/AutodeskAILab/BRepNet` README. Two independent blockers: (a) NC clause vs $200K prize (same conservative reading as gate 1); (b) ShareAlike clause requires derivatives to inherit CC BY-NC-SA, which is incompatible with releasing arch-1 weights under a permissive hackathon-derivative license. **Effect on §15 rank 5:** drop from validator options. **Mitigation:** topological validation falls to in-house geometric checks (closed-edge counts, manifoldness via web-ifc + replicad) instead of an ML validator.

Open gates:

3. **Pointer-CAD code release timeline — RE-CHECKED 2026-05-01, STILL "coming soon".** Repo `Snitro/Pointer-CAD` has 2 commits, no source files, README still "🚧 Code coming soon." arXiv 2603.04337 latest revision v2 (Apr 29, 2026, 2 days pre-check) added no code URL. CVPR 2026 acceptance suggests pre-conference release pressure but timeline unstated. Re-check again before 2026-05-15 (3 days before hackathon deadline). Status quo holds: Pointer-CAD remains paper-only inspiration for §15 rank 8.
4. **DreamCAD code release — RE-CHECKED 2026-05-01, code STILL pending; CADCap-1M dataset DOES NOT unblock corpus path.** arXiv 2603.05607 v1 (Mar 5, 2026) says "Code and dataset will be publicly available." **NEW finding:** CADCap-1M caption dataset is released on HF at `SadilKhan/CADCap-1M`, BUT licensed `CC-BY-NC-SA-4.0` + gated (auto-acknowledge required). Same blockers as gate 2 BRepNet: (a) NC clause vs $200K prize, (b) SA clause forces inheritance to derivative weights → incompatible with permissive hackathon release. **Effect on §16 LoRA training corpus row:** CADCap-1M EXCLUDED; ABC remains the only secondary pretrain candidate. **Effect on §15 rank 7 (DreamCAD method ideas):** unchanged (was already paper-only). D1-D3 corpus path is binding. Re-check method-code release at same 2026-05-15 cadence.
5. **Pascal MCP local-model capability.** Confirmed model-agnostic at code level; not benchmarked with a local model. If arch-1 ever needs an MCP fallback, run a smoke test against pascal MCP + transformers.js.
