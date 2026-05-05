# v2 dataset + LoRA results

Status: **4b-it shipped 2026-05-01 — round-trip 40/40 = 100%, gate ≥90% met. E2B deferred. Publish plan staged (HF_TOKEN absent).**

## D1 — spec

`dataset/v2-spec.md` covers Tier 1 vocabulary (13 ops), per-row format, augmentation rules, and the 5-bucket composition (50+50+200+50+50 = 400 base rows).

## D2 — synthetic generator

200 rows in `data/v2-synthetic.jsonl`. Round-trip gate (parse_ok + api_clean + parsable + execute) passed at **200/200 (0.0%)** failure rate across all 14 subcategories. Validated via `bun scripts/generate-v2.ts`.

## D3 — corpus expansion

Three buckets (50 rows each) hand-curated:

| File | Rows | Round-trip pass |
|---|---:|---:|
| `fixtures/tier1-extra.jsonl` | 50 | 50/50 |
| `fixtures/tier2-curated.jsonl` | 50 | 50/50 |
| `fixtures/mined-extra.jsonl` | 50 | 50/50 |

**Tier 1 extra** broadens the v1 wall/slab/footing-heavy distribution into circular and rectangular columns, beams (XZ-plane), slabs with rect/circular cutouts, plinths, translated/rotated single elements, and `makeBox`/`makeCylinder` shorthand. All 50 use only Tier 1 vocabulary.

**Tier 2 curated** covers cylindrical tank shells, truncated cone silos, toroidal forms, walls with door/window cutouts, L-corner fuses, slabs with multi-hole chained cuts, and translated booleans. Revolves use OCCT-safe profile placement (drawRectangle + translate to shift profile off the rotation axis).

**Mined extra** — 9 unique rows reformatted from `fixtures/spike-b-*.jsonl` (consistent with Spike B retro's "corpus exhausted at ~12 unique pairs"); 41 supplementary rows hand-authored in mined-style mechanical voice ("Build a wall, Xm long, Ym thick, Zm tall.") to reach the 50-row spec target.

Validated via `bun scripts/validate-fixtures.ts`. Tier 1 surface bug fixed during D3: `tier1.ts:drawPolyline` now auto-closes the pen so `t1-041`/`t1-042` (hexagonal/octagonal columns) execute. No regression in D2 200/200.

## D4 — training + publish

### Augmentation

`src/train/build_dataset_v2.py` performs deterministic paraphrase via:
- Numeric suffix swap: `5m` → `5 meters`
- Integer-to-word substitution (1..12), preceded-by-non-digit-non-dot (`1.5 meters` left alone)
- Imperative-verb swap (Build → Create / Construct; Place → Position; Make → Create; Erect → Stand up)

Stratified 10% holdout (seed 42) per-bucket → 40 eval rows (no aug) + 360 training seeds → ~932 augmented training rows.

Output: `data/train_v2.jsonl` (932), `data/eval_v2.jsonl` (40).

### Training

`src/train/lora_train_v2.py` — Unsloth FastModel + QLoRA, LoRA rank 16, alpha 16, 3 epochs, batch 2 × grad-accum 4 (effective batch 8), AdamW-8bit, lr 2e-4, bf16. Eval at each epoch, keep last checkpoint.

| Variant | Model | Status |
|---|---|---|
| 4b-it | `unsloth/gemma-3-4b-it-unsloth-bnb-4bit` | trained 2026-05-01, 53 min on RTX 4090, train_loss=0.2442, 932 train rows × 3 epochs (351 steps) |
| E2B   | `unsloth/gemma-3n-E2B-it` | deferred. Not gated (HF returns 200 without auth) — would have trained successfully and held GPU another ~35 min, blocking concurrent avir-cli probe work. Slated for a later session when avir-cli GPU queue is clear. |

### Eval (round-trip)

`src/train/inference_eval_v2.py` runs each adapter against `data/eval_v2.jsonl`, scoring per-row on parse_ok + api_clean + has_solid_op (static) AND execute() round-trip via `bun scripts/validate-fixtures.ts`.

Per `dataset/v2-spec.md` §Acceptance: round-trip pass rate target is implicit in the dataset gate (≥ 90% on synthetic + mined was the dataset-time gate; per-model inference target is not formalized in spec but is the natural success metric here).

| Variant | parse_ok | api_clean | has_solid_op | round-trip | Notes |
|---|---:|---:|---:|---:|---|
| 4b-it | 40/40 | 40/40 | 40/40 | 40/40 (100%) | gate ≥90% met. Per-row results in `outputs/cad-lora-v2-4b-it-eval.jsonl`. |
| E2B   | — | — | — | — | training deferred (see Training table) |

### Publish

`src/train/publish_v2.py` selects the highest-round-trip adapter and uploads to `gemma-architect/cad-lora-v2`. Requires `HF_TOKEN`; absent the token, it dumps a publish plan to `outputs/cad-lora-v2-publish-plan.json` for the next session to execute.

**2026-05-01 status: HF_TOKEN absent** — publish_v2.py produced `outputs/cad-lora-v2-publish-plan.json` (best=4b-it, round-trip=100%) on the training machine and exited 0. Note that `outputs/` is gitignored, so this file is not in a fresh clone — rerun publish_v2.py locally (with HF_TOKEN set, to execute upload; without, to regenerate the plan).

## Acceptance

| Criterion (per dataset/v2-spec.md) | Status |
|---|---|
| 400 base rows across 5 buckets | ✓ (50+50+200+50+50) |
| Round-trip ≥ 90% on synthetic + mined | ✓ (250/250 = 100%) |
| Tier 1 vocabulary only | ✓ (across all 400 base rows) |
| Tier 1 vocabulary coverage | 12/13 ops covered (drawLine has zero rows; soft gap, no impact on round-trip pass rate) |
| Augmentation 2-3 paraphrases per base | ✓ (mean 2.6×, total 932) |
| LoRA train both E2B + 4b-it | partial — 4b-it shipped 2026-05-01, E2B deferred to a later session (GPU contention with avir-cli probe queue) |
| Publish best to HF Hub | publish plan generated at `outputs/cad-lora-v2-publish-plan.json` on the training machine (outputs/ gitignored); upload pending HF_TOKEN |
| Eval round-trip ≥ 90% (4b-it) | ✓ (40/40 = 100%) |

## Pipeline reproduction

```bash
# Build dataset (deterministic, seed 42)
PYTHONUTF8=1 python src/train/build_dataset_v2.py

# Train 4b-it (~50 min on a 4090)
GEMMA_V2_MODEL=4b PYTHONUTF8=1 python src/train/lora_train_v2.py

# Run remaining pipeline (E2B train, eval both, publish best/plan)
bash src/train/pipeline_v2.sh
```
