# Submission — Gemma 4 Good Hackathon

**Track:** Equity (3D design for non-CAD users)
**Project:** gemma-architect — browser-native parametric architectural design from natural-language prompts
**Deadline:** 2026-05-18

## Required artifacts

- [ ] **Public Kaggle write-up** — project description, technical approach, impact statement, demo link.
- [ ] **Public GitHub repo** — this repo, license = Apache-2.0, README points to demo + writeup.
- [ ] **3-min demo video** — screen-record the in-browser flow: type prompt → render geometry → export IFC.
- [ ] **Hosted live demo** — static-hosted single page running Gemma 4 in-browser via WebGPU + replicad.
- [ ] **Reproducible model artifact** — LoRA adapter on Hugging Face Hub or Kaggle Datasets.

## Judging criteria (hackathon spec)

1. **Impact** — clarity of who benefits, depth of need, realistic adoption path.
2. **Technical execution** — fine-tuning quality, novel use of Gemma 4 capabilities (multimodality / long context / on-device).
3. **Communication** — write-up readability, demo polish, code reproducibility.

Each section gets its own page in this directory near the deadline:
- `submission/writeup.md` — the Kaggle post.
- `submission/demo-script.md` — exact demo path + voiceover.
- `submission/repro.md` — step-by-step training + inference reproduction.
- `submission/impact.md` — equity story: barrier-to-entry for parametric CAD, target users, deployment plan.
- `submission/SAMPLES.md` — bundled IFC sample provenance (real vs synthetic vs smoke test) + per-file licenses.

## Status (2026-05-05)

- ✅ Spike B (IFC mining pipeline) — 12 pairs mined from open IFC corpus, retrospective at `docs/spike-b-retrospective.md`.
- ✅ Spike A (LoRA training) — 76 train + 8 eval pairs, QLoRA r=16, eval_loss 0.144 @ epoch 3, **8/8 parse_ok | 8/8 api_clean | 8/8 has_extrude** on held-out set. Adapter at `outputs/archive-gemma3-2026-05-05/spike-a-lora/`. Retrospective at `docs/archive/spike-a-retrospective.md`.
- ✅ 18-day plan — `docs/plan-18-day.md` (5 sub-gates: model artifact, browser inference, render+export, demo video, Kaggle writeup).
- ✅ **Dataset v2** — 400 base rows, 5 buckets (50+50+200+50+50), **round-trip 100%**, 932 augmented training rows, 40-row stratified holdout. See `dataset/v2-results.md`.
- ✅ **4b-it LoRA shipped 2026-05-01** — 53 min on a 4090, train_loss 0.244 @ epoch 3, **40/40 (100%) full round-trip** on the held-out eval. Adapter at `outputs/cad-lora-v2-4b-it/` (gitignored — produced by training, not committed). Publish plan generated at `outputs/cad-lora-v2-publish-plan.json` on the training machine when publish_v2.py ran without HF_TOKEN; on a fresh clone, regenerate by re-running publish_v2.py.
- ⏳ E2B-LoRA variant — deferred per `dataset/v2-results.md`; will ship once 4b-it submission cycle closes. (Distinct from the image→IFC E2B agent #182 which uses Gemma 4 multimodal native and DID ship — see `submission/repro.md` §3.)
- ✅ **Browser runtime running** — Vite + TypeScript + three.js + replicad + web-ifc 0.0.77 all wired, 9 canned demos shipping (8 dropdown + Schultz hero via Cmd-K), IFC4 export round-trip-verified, drag-drop loader for IFC/STEP/GLB/GLTF/OBJ/STL, sample IFC files (Schultz Residence real + KIT FZK-Haus / Institute-Var-2 synthetic test fixtures + Bonsai openings) bundled. Self-harness: 9/9 demos pass; leo-as-architect 8/8; verify-dsl-corpus 19/19.
- ✅ **Bundle design handoff (#170 umbrella) shipped** — `#171/#173/#176/#177/#178/#179/#181/#183` all merged plus `#172` quad-split, `#174` sidebar + Snap dock, `#175` 5-tab dock surface, `#168` 2D→3D agent, `#182` image→IFC agent, `#151` Bonsai MCP via subagent worktree integration onto bridge → master.
- ✅ **AI prompt → geometry pipeline (#176) live** — cache-first with **60-row** prompt → JS bundle (40 v2 LoRA eval + 19 DSL corpus + 1 Schultz gold; verified live as of 2026-05-05 a59a8a3), F1-weighted similarity matcher, opt-in live LoRA via FastAPI/`src/serve/serve_lora.py` (OpenAI-compat). See [`docs/ai-pipeline.md`](../docs/ai-pipeline.md).
- ✅ **Kaggle writeup + judges-facing docs aligned** — `submission/writeup.md` updated with the three-input-paths section + screenshot-grid embed marker, `submission/impact.md` corrected for sketch-to-BIM-shipped scope, `submission/repro.md` with E2B naming disambiguation, `submission/demo-script.md` rewritten to the post-#170 bundle UI; README.md has the "For judges (60 seconds)" walkthrough.
- ✅ **Public GitHub repo live** — github.com/wordingone/gemma-architect (visibility: PUBLIC, Apache-2.0).
- ✅ **Live demo URL serving** — https://wordingone.github.io/gemma-architect/ (GH Pages, single-thread WASM — COOP+COEP gap; Vercel deploy via `vercel.json` would lift to multi-threaded). Bundle (deployed, verified 2026-05-05 via curl): 8.22 MB main JS / gzip 0.72 MB + 3.88 MB worker + 10.8 MB OpenCascade WASM / gzip 4.58 MB + 1.3 MB web-ifc WASM / gzip 0.48 MB + lazy PDF-export chunks (~1.2 MB / gzip 0.26 MB on demand).
- ✅ **Performance verified live** — cache hit ~7ms; wall full cycle ~21ms; Schultz 14-element ~210ms (single-thread WASM, GH Pages).
- ✅ **create-mode horizontal-camera bug fixed (dc849f0)** — `unprojectToXY` now falls back to camera XY on Z=0 when ray misses the ground plane (#17). CONSOLE auto-opens on generate cache-miss (#16). Both verified deployed.
- ✅ **Screenshot grid 9/9 captured** — `submission/screenshots/01-09*.png` from production URL via Playwright at 1920×1080 (commit 1838d6c, full re-capture 2026-05-05 after R1-R4 fixes + create-mode PR #13). No visual change in dc849f0 (#16/#17 functional + doc fix).
- ⏳ HF Hub LoRA — `gemma-architect/cad-lora-v2` not pushed (HF_TOKEN absent).
- ⏳ Demo video — manual recording per `submission/demo-script.md`.
- ⏳ BlenderBIM column for screenshot grid (3 shots) — manual capture pre-composite.
- ✅ **CI gates green** — `bun scripts/audit-stubs.ts` returns "0 stubs"; `bun scripts/audit-zip-parity.ts` returns "parity OK: 67 labels matched" (lean shell.ts intentionally omits 67 app.jsx menubar items via the INTENTIONALLY_OMITTED set, all justified); `bun run web:typecheck` clean (Eli's 02bb0a9 added the 5 Viewer methods T3/T4 gizmo code wanted + a web:typecheck step in `.github/workflows/ci.yml`). Single-command judges-facing wrapper at `bun run verify` (typecheck + web:typecheck + audit:stubs + audit:parity).

## Outstanding blockers (judge-visible)

Two placeholders remain in `writeup.md` — without them the submission isn't externally verifiable:

- `https://huggingface.co/gemma-architect/cad-lora-v2` — adapter not pushed (HF_TOKEN absent; `outputs/cad-lora-v2-publish-plan.json` is produced by `publish_v2.py` when run without the token, but `outputs/` is gitignored — regenerate locally rather than expecting the file in a fresh clone).
- Demo video URL (YouTube) — TBD. Recording path is unblocked: cache fix landed (a59a8a3), Schultz hero re-shot (725b56a), `submission/demo-script.md` is the canonical 173-line cut plan.
