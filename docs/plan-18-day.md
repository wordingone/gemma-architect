# gemma-architect — 18-Day Hackathon Plan

**Submission deadline:** 2026-05-18 (Mon)
**Today:** 2026-04-30 (Thu) → **18 calendar days remaining**
**Track:** Equity — 3D parametric design for non-CAD users
**Required artifacts (per `submission/README.md`):** Kaggle write-up + GitHub repo (Apache-2.0) + 3-min demo video + hosted live demo + reproducible model artifact (HF Hub / Kaggle Datasets).

This plan is the deliverable closing #98. It absorbs:
- **Spike B** (`docs/spike-b-retrospective.md`): IFC mining pipeline proven, corpus exhausted at 12 unique pairs.
- **Spike A** (`docs/archive/spike-a-retrospective.md`): QLoRA validates approach on 76 pairs (eval_loss 0.14 @ epoch 3). Legacy base purged 2026-05-05; Gemma 4 base TBD.

The remaining 18 days are **scale + polish**, not "is this approach viable" — that question is answered.

---

## What "done" looks like (gate)

A non-CAD user opens a URL, types `"a 3-bay open-front shed, 6m wide, 4m deep, 3m eaves"`, the model generates a replicad sequence in-browser via WebGPU, the page renders the geometry live, the user nudges parameters via a side panel, and clicks "Export IFC" to get a file consumable in any BIM tool.

Five hard sub-gates, each binary:

1. **Model artifact published** — Gemma-4-E2B-it (or E4B if wheels available) LoRA adapter on Hugging Face under Apache-2.0, with model card.
2. **Browser inference green** — page boots; WebGPU initializes; first token < 5s on a mid-tier laptop GPU; full sequence < 30s; reproducible across Chrome 121+ and Edge.
3. **Render + export green** — generated sequence parses, replicad renders without crashes, web-ifc exports a valid IFC4 file that round-trips through IfcOpenShell.
4. **Demo video shipped** — 3 min screen-recording showing the full prompt-to-IFC loop on three distinct prompts.
5. **Kaggle write-up live** — public post linking demo + repo + model + video, including impact statement against the equity rubric.

If any of the five fails on 2026-05-17, the submission is incomplete. The plan below allocates buffer for two of them to slip and still ship.

---

## Day-by-day allocation

Days are work-blocks, not literal calendar days — the plan is robust to a missed day or two as long as no track stalls more than 48h.

### Days 1–4 (Apr 30 – May 3): **Dataset + model scaling**

Goal: replace the 76-pair toy dataset with a 400+-pair v2 dataset. Re-train.

- **D1 (4/30, today)** — finish Spike A LoRA + retrospective ✅. File the 18-day plan ✅. Open `dataset/v2-spec.md` listing target categories + ratios.
- **D2 (5/1)** — synthetic IFC generator: parametric room/wall/slab/column/footing emitter that round-trips through web-ifc → mining pipeline → training pair. Target 200 synthetic pairs. Diversity knobs: dimensions (0.3-30m), wall thickness (0.1-0.4m), opening counts, L-shape / U-shape / courtyard footprints. Acceptance: 200 pairs validate as round-trippable.
- **D3 (5/2)** — corpus expansion: pull more open IFC (IfcOpenHouse, FreeCAD-IFC export samples, IFC4 sample suite). Target +50 mined pairs. Hand-curate +50 pairs covering Tier 2 ops (revolves, basic booleans/cuts). Total v2 dataset: 50 (tier1) + 50 (tier1-extra) + 200 (synthetic) + 50 (tier2-curated) + 50 (mined) = 400.
- **D4 (5/3)** — re-train on v2 dataset on Gemma 4 base (TBD per project directive 2026-05-05). Push best adapter to HF Hub as `gemma-architect/cad-lora-v2`. Sub-gate 1 closes here.

**Slip rule:** if D4 slips past 5/3, drop the 50 mined-extra and 50 tier2-curated rows and ship a 300-pair v2; do NOT skip the synthetic generator (it's the leverage).

### Days 5–10 (May 4 – 9): **Browser runtime**

Goal: prompt → in-browser inference → replicad render → IFC export, end-to-end.

- **D5 (5/4)** — page scaffold (single HTML + Vite + TypeScript). WebGPU detection + fallback message. Replicad worker boot.
- **D6 (5/5)** — WebLLM or transformers.js integration for Gemma-4-E2B inference. Adapter LoRA load via `peft` ONNX export OR direct merge-into-base + GGUF; choose whichever path is shorter on the day. Acceptance: smoke prompt → JS code response in browser, < 30s.
- **D7 (5/6)** — eval the in-browser model against the held-out prompt set; expect parse_ok + api_clean rates within 5pp of the Python eval. If gap > 10pp, debug tokenizer / chat-template mismatch.
- **D8 (5/7)** — replicad executor: the model's emitted JS runs in a worker, builds the geometry, hands meshes back to the main thread. Render with three.js + OrbitControls. Side panel exposes top-3 parameters as sliders that re-trigger the sequence (no model re-inference). Sub-gate 3 starts here.
- **D9 (5/8)** — web-ifc export: serialize the replicad model to IFC4. Verify export round-trips through IfcOpenShell (mining pipeline = self-test). Sub-gate 3 closes.
- **D10 (5/9)** — performance polish: first-token, full-sequence, render frame rate. Test on three machines (4090 desktop, mid laptop GPU, Apple Silicon). Sub-gate 2 closes.

**Slip rule:** if D6 slips, fall back from WebGPU/transformers.js to a small-model server-side inference proxy (less impressive but still ships). Never skip D9 — without IFC export the equity-track value prop disappears.

### Days 11–14 (May 10 – 13): **Demo + write-up**

Goal: ship the 3 narratives that judges actually score on.

- **D11 (5/10)** — pick 3 demo prompts that span scope (single-element, multi-element assembly, parametric variation). Iterate model output until each is visually clean.
- **D12 (5/11)** — record 3-min demo video. Voice-over scripted from `submission/demo-script.md`. Cuts: hook (0:00-0:20), live demo (0:20-2:00), three prompt variants (2:00-2:40), call-to-action with repo + HF + Kaggle links (2:40-3:00). Sub-gate 4 closes.
- **D13 (5/12)** — Kaggle write-up draft. Sections: who benefits (the equity case for non-CAD users — 7B people without parametric CAD access), technical approach (Gemma-4-E2B + LoRA on (NL, replicad-JS) pairs + browser runtime), what's reproducible (point at HF + repo), what's next (corpus expansion, E4B re-train, IFC4 → IFC4x3 spec coverage). Sub-gate 5 starts.
- **D14 (5/13)** — `submission/repro.md`: step-by-step training + inference + browser-deploy reproduction. Anyone with a 4090 should be able to retrain in ≤ 1h and stand the demo up locally in ≤ 10 min.

### Days 15–17 (May 14 – 16): **Polish + buffer**

- **D15 (5/14)** — `submission/impact.md`: the equity story. Concrete: parametric CAD has a multi-thousand-USD entry barrier (Revit, AutoCAD, ArchiCAD). LLM-driven design lowers that barrier. Estimate target users (small-shop architects, DIY home renovators, students in low-resource regions, makerspace builders). Deployment realized as static page on GitHub Pages (free tier; HuggingFace Spaces and Vercel are COOP+COEP-capable upgrade paths). Sub-gate 5 closes.
- **D16 (5/15)** — final polish: README pointers, Apache-2.0 license file, model-card on HF, screenshot-grid for the Kaggle post.
- **D17 (5/16)** — buffer day: whichever sub-gate slipped, fix it. Test the full submission flow end-to-end on a fresh machine.

### Day 18 (5/17 Sun): submit

- Submit on Kaggle by 23:59 in submission timezone. Re-verify all 5 sub-gates green within 6h of submission.
- Fallback if 5/17 has issues: 5/18 morning is the absolute deadline.

---

## What I will NOT do

To prevent track stacking (failure mode P2 from `failure-classes.md`):

- **No mobile-first build.** Chrome desktop + Safari desktop. Mobile browser WebGPU is too uneven.
- **No IFC4x3 / IFC4 import.** Output is IFC4 export only. Import flow = Tier 4, off-scope.
- **No multi-language UI.** English prompts only.
- **No multimodality.** Text-in, JS-out. No image input even though Gemma 4 supports it.
- **No fine-tune over base instruction-following.** LoRA on top of Gemma 4 base only. Don't attempt full fine-tune; the base instruction-following is the leverage.
- **No AVIR-CLI work during the hackathon.** Per project directive 2026-04-30, the queue-burn defaults are paused. avir-cli mailbox check happens once per work session, not continuously.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Gemma 4 base selection delayed | Use E2B as default; E4B if wheel available. Legacy analogue fallback removed per project directive 2026-05-05. |
| WebGPU + Gemma-4 in-browser inference too slow | Server-side inference proxy on HuggingFace Spaces. Less impressive but still ships. |
| LoRA adapter doesn't generalize off-distribution | The 400-pair v2 dataset is the bet. If still fails, expand to 800 via second synthetic-generator pass. |
| Model emits non-Tier1 ops despite training | Post-process / lint the output and reject + re-prompt. Demo can hide this if rare. |
| Hackathon judges discount in-browser inference | The video lead-up explicitly highlights the equity story: zero-install, zero-cloud, runs on a Chromebook. That's the differentiator. |

---

## Anti-patterns from previous Avir work that this plan refuses

- **No "phase 5 retry" pattern.** No comprehensive end-to-end run as goal — every sub-gate has its own day-block green-light.
- **No deadline-as-budget thinking.** Days are dependency-ordered, not time-allocated. Ship sooner if I can.
- **No escalation-as-design.** Every blocker has an in-plan fallback; no hard-coded decisions baked into the timeline.
- **No scaffold-as-done at the planning layer.** Each sub-gate has an empirical close-condition (artifact published, page boots, video uploaded, write-up live), not "doc written."
- **No track stacking.** 5 sub-gates, no more. New sub-gates require killing an existing one.

---

## State outside this plan

Progress lives in `state/` (not in this file — per `feedback_plan_is_for_complete_product`). This file describes the spec; daily reality goes elsewhere. Status updates in `submission/README.md` Status block and the daily `state/day-N.md` notes.
