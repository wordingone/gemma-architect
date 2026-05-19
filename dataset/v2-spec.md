# Dataset v2 — Target Spec

**Owner:** project lead
**Filed:** 2026-04-30 (D1 of `docs/plan-18-day.md`)
**Consumed by:** D2 (synthetic generator) + D3 (corpus expansion + tier2 hand-curation) + D4 (LoRA re-train)

This file is the spec D2/D3 implementers hit. v1 (84 rows total — `data/train.jsonl` + `data/eval.jsonl`) shipped Spike A at 8/8 on the held-out eval but obviously over-fit a narrow distribution. v2 is the **scale + diversity** bet.

## Volume + ratio

400 (train + eval, 90/10 split, seed 42) = 360 train / 40 eval.

| Bucket | Count | Origin | New for v2? |
|---|---:|---|:-:|
| **Tier 1 hand (existing)** | 50 | `fixtures/tier1.jsonl` (Spike A v1) | reuse |
| **Tier 1 extra hand** | 50 | this spec, §"Tier 1 extra hand" | new |
| **Synthetic generator** | 200 | D2, this spec §"Synthetic generator" | new |
| **Tier 2 hand-curated** | 50 | D3, this spec §"Tier 2 hand-curated" | new |
| **Mined extra (open IFC)** | 50 | D3 via `scripts/spike-b-ifc-mining.ts` extension | new |
| **Total** | 400 | | |

**Slip rule (per plan §D4):** if D4 slips past 5/3, drop the bottom two rows (Tier 2 hand-curated + Mined extra) and ship 300. Synthetic is non-negotiable — that's the leverage.

## Per-row format

Same JSONL chat-message shape as v1 (`data/train.jsonl`). System prompt held constant — see `src/train/build_dataset.py` for the canonical string. Each row:

```json
{"messages":[
  {"role":"system","content":"<canonical system prompt>"},
  {"role":"user","content":"<NL prompt>"},
  {"role":"assistant","content":"<replicad JS sequence>"}
]}
```

Augmentation pass (D4-time, NOT D2/D3-time): for each (NL, JS) pair, generate 2-3 NL paraphrases via deterministic template substitution (no LLM in the loop). Final train file = base 400 × ~3 ≈ 1200 rows. Eval file = held-out 40 × 1 (no aug) = 40.

## Tier 1 vocabulary (locked from Spike A)

```
makeBox          drawRectangle    drawCircle       drawLine
drawPolyline     sketchOnPlane    extrude          revolve
fuse             cut              translate        rotate
makeCylinder
```

Output sequences must use ONLY these identifiers (excluding `const`/`let`/var/etc and user-chosen variable names). Validation in `src/train/inference_eval.py:TIER1_OPS`.

---

## Tier 1 extra hand (50 rows)

50 hand-written prompts that broaden v1's Tier 1 coverage. v1 was very wall + slab + footing heavy. v2 fills:

| Subcategory | Target rows | Example prompt | Example output shape |
|---|---:|---|---|
| **Single rectangular wall** (varied dims) | 8 | "Build a wall 4.5m long, 0.3m thick, 2.7m tall." | `drawRectangle(L,T).sketchOnPlane("XY").extrude(H)` |
| **Single circular column** | 6 | "Place a 0.4m diameter circular column, 4m tall." | `drawCircle(R).sketchOnPlane("XY").extrude(H)` |
| **Single rectangular column** | 6 | "Stand up a 0.3 × 0.3m square column, 3.5m high." | `drawRectangle(S,S).sketchOnPlane("XY").extrude(H)` |
| **Slab with rectangular hole** | 6 | "A 5×4m slab, 0.2m thick, with a 1×1m square opening centered." | `slab.cut(hole)` where hole = drawRectangle(...).extrude(...) |
| **Slab with circular hole** | 4 | "A 6×4m slab, 0.2m thick, with a 0.6m radius round hole at one corner." | `slab.cut(hole)` where hole = drawCircle(R).extrude(...) |
| **Beam** (horizontal extrusion) | 6 | "A horizontal beam, 6m long, 0.3m wide, 0.5m deep." | `drawRectangle(W,D).sketchOnPlane("XZ").extrude(L)` |
| **Plinth / footing variants** | 4 | "A square footing pad 1.5×1.5m, 0.4m deep, beneath a column." | `drawRectangle(S,S).sketchOnPlane("XY").extrude(D).translate([0,0,-D])` |
| **Translated single elements** | 4 | "Place a wall 3m long, 0.2m thick, 2.5m tall, offset 5m along Y." | `wall.translate([0,5,0])` |
| **Rotated single elements** | 4 | "Build a 4m × 0.2m × 3m wall, rotated 30 degrees about Z." | `wall.rotate(30,[0,0,1])` |
| **makeBox / makeCylinder shorthand** | 2 | "Make a 2×2×2 cube." / "Make a cylinder, 1m radius, 3m tall." | `makeBox(2,2,2)` / `makeCylinder(1,3)` |

**Acceptance for this bucket:** every output passes `parse_ok + api_clean` from `inference_eval.py`. Hand-write into `fixtures/tier1-extra.jsonl` in the same compact format as `fixtures/tier1.jsonl` (id/prompt/sequence/element/ops). `build_dataset.py` extension reads both fixtures.

---

## Synthetic generator (200 rows) — D2 spec

Parametric emitter at `src/generate/synth.ts`. Round-trips through web-ifc → mining → training pair. The generator is the **leverage** of v2 — every synthetic row is by-construction-correct (unlike mined rows where we trust the IFC).

### Subcategory targets

| Subcategory | Rows | Knobs |
|---|---:|---|
| **Single-element parametric** (wall / column / slab / footing / beam) | 60 | per-element-type dim ranges below |
| **L-shaped wall corner** | 30 | leg lengths (3-12m), thickness (0.1-0.4m), height (2.5-5m), corner-side {origin, +X, +Y, both} |
| **U-shaped enclosure** | 25 | leg lengths × 3, thickness, height — courtyard footprint variant |
| **Closed rectangular room** (4 walls) | 25 | width, depth, thickness, height, optional door cutout |
| **Wall with rectangular opening** (door / window) | 20 | wall dims + opening width + opening height + opening x-offset + opening sill-height |
| **Column grid** (regular array) | 15 | rows × cols, spacing X/Y, column dims, height |
| **Sloped roof slab** (translated + rotated rectangle) | 15 | footprint, pitch angle, eave height, ridge offset |
| **Stair-stepped retaining** (additive cuboid stack) | 10 | step rise, step run, num steps |

### Knob ranges

| Dim | Min | Max | Distribution |
|---|---:|---:|---|
| Length L | 0.3 | 30 | log-uniform |
| Wall thickness T | 0.1 | 0.4 | uniform |
| Height H | 2.0 | 5.5 | uniform |
| Column side / radius | 0.15 | 0.6 | uniform |
| Slab thickness | 0.1 | 0.5 | uniform |
| Beam depth | 0.2 | 0.8 | uniform |
| Opening width | 0.6 | 2.4 | uniform |
| Opening height | 1.8 | 2.4 | uniform |

### NL prompt templates per subcategory

Each subcategory gets 3-5 NL templates (selected uniformly at row generation time). Examples (for L-shape):

```
"Build an L-shaped wall corner: one {Lx}m wall along X, one {Ly}m wall along Y, both {T}m thick and {H}m tall."
"Make an L corner — a {Lx}-meter wall and a perpendicular {Ly}-meter wall, both {T}m thick, {H}m tall."
"Create two walls meeting at the origin in an L: {Lx}×{T}m along X, {Ly}×{T}m along Y, both {H}m tall."
"L-shaped wall: {Lx}m × {T}m along X, then {Ly}m × {T}m turning along Y, all {H}m high."
```

Variable substitution gives 200 distinct prompts per template-set — even at 25 rows per subcategory, no two rows share NL.

### Output shape per subcategory

D2 generator emits the JS sequence directly (no IFC round-trip needed for synthetic — the round-trip exists to **validate** the generator, not to produce the JS). The validation flow:
1. Generator emits JS + parameters.
2. Run JS through replicad in a Node script → produces a model.
3. Export model to IFC4 via web-ifc.
4. Mine the IFC back through `scripts/spike-b-ifc-mining.ts` → recover (NL, JS) pair.
5. Round-trip pair must match generator's emitted JS within a normalization tolerance (e.g., variable names differ, geometric primitives match).

Acceptance for D2: 200 pairs validate as round-trippable. Failures get logged + diagnosed; if any subcategory class has > 10% failure rate, fix the generator before proceeding.

### Augmentation rules (D4-time, applied to ALL 400 base rows)

For each base row, generate 2-3 NL paraphrases via:
- **Numerical phrasing swaps:** `5m` ↔ `5 meters` ↔ `five meters` ↔ `5.0m`.
- **Imperative ↔ declarative:** "Build X" ↔ "X needs to be built" ↔ "Create an X" ↔ "Place an X here".
- **Order swaps:** "5m long, 0.2m thick" ↔ "0.2m thick and 5m long".

NO output (assistant) augmentation. Only the user prompt varies. This teaches NL→JS robustness without diluting the JS distribution.

### Adversarial generation hint (D4 stretch goal)

Per Spike A retrospective semantic-gap observation: L-shape generated `cut()` instead of `fuse()`. To teach the boolean distinction explicitly, the L-shape subcategory should include a paired-prompt class:
- "Build an L-shaped wall corner..." → `wallX.fuse(wallY)`
- "Build an L-shaped void / cutout corner..." → `slab.cut(walls)` (used to remove material)

Same parametric values, opposite boolean. ~10 of the 30 L-shape rows should be the cut-variant.

---

## Tier 2 hand-curated (50 rows) — D3 spec

Hand-written rows covering revolves + advanced booleans. Tier 2 vocabulary is the same identifier set as Tier 1 but exercises ops `revolve`, `cut`, `fuse` more heavily.

| Subcategory | Rows | Example prompt | Example output |
|---|---:|---|---|
| **Revolved cylindrical tank** | 8 | "A cylindrical water tank, 2m radius, 4m tall." | `drawRectangle(...).sketchOnPlane("XZ").revolve([0,0,1])` |
| **Revolved truncated cone** (silo / hopper) | 6 | "A grain silo: 3m base radius, 1m top radius, 8m tall." | `drawPolyline(...).sketchOnPlane("XZ").revolve([0,0,1])` |
| **Revolved dome roof** | 4 | "A hemispherical dome, 5m radius." | `drawCircle(...).sketchOnPlane("XZ").revolve([0,0,1])` |
| **Wall + door cutout** (boolean cut) | 8 | "A 6×0.2×3m wall with a 0.9×2.1m door, centered horizontally." | `wall.cut(door)` |
| **Wall + window cutout** | 8 | "A 5×0.2×3m wall with a 1.5×1.2m window, sill at 1m." | `wall.cut(window.translate(...))` |
| **Two-wall L corner** (boolean fuse — explicit teach) | 6 | "Two walls meeting at a corner, fused into one piece." | `wallX.fuse(wallY)` |
| **Slab + multiple holes** (chained cut) | 5 | "A 6×4×0.2m slab with three 0.5m radius round holes." | `slab.cut(h1).cut(h2).cut(h3)` |
| **Translated booleans** (cut after translate) | 5 | "A wall with an opening offset 1m from the left edge." | `wall.cut(opening.translate(...))` |

**Acceptance:** every row passes `parse_ok + api_clean`, AND the geometry is meaningfully different from Tier 1 (i.e., contains at least one `revolve` or one boolean op). Hand-write into `fixtures/tier2-curated.jsonl`.

---

## Mined extra (50 rows) — D3 spec

Extension of `scripts/spike-b-ifc-mining.ts` to additional open IFC corpora:

| Source | Estimated yield |
|---|---:|
| **IfcOpenHouse-IFC4** (already partially mined for Spike B; pull additional architectural elements) | ~15 |
| **FreeCAD IFC export samples** (FreeCAD Test Files repo) | ~15 |
| **buildingSMART IFC4 sample suite** | ~10 |
| **Bonsai-BIM project samples** (already partially mined; expand to full repo) | ~10 |

Mining flow unchanged from Spike B: walk IFC representation tree → extract simple-sweep / extruded-area-solid → emit (NL synthesized from element-type + dims, JS sequence).

**Quality gate:** every mined row passes the same `parse_ok + api_clean` Tier 1 check as hand-written rows. Reject rows that produce non-Tier-1 ops or that fail to round-trip-validate against the source IFC dimensions.

---

## NL prompt-style invariants (applied across all 400)

Every prompt in v2 satisfies:

1. **Architectural framing.** No "make a 5×3 rectangle and extrude it 2 units" — that's a CAD-power-user prompt. v2 prompts say "build a wall 5m long, 0.2m thick, 2.5m tall" — that's the equity-track non-CAD-user voice.
2. **Explicit dimensions in prompt.** Every spatial claim (length, thickness, height, radius, count) named numerically. No "build a small wall."
3. **Physical units (m).** "meters" / "m" / "cm" — never bare numbers.
4. **Imperative voice ≥ 60% of rows.** "Build / Create / Make / Place / Construct …".
5. **No leading whitespace, no trailing punctuation drift.** Prompts are clean single-sentence.

## Mistake-budget guardrails (v2 explicit)

Per Spike A retrospective semantic-gaps section, v2 must reduce these failure modes by-construction:

| Failure (Spike A) | v2 fix |
|---|---|
| L-shape used `.cut()` instead of `.fuse()` | Synthetic L-shape subcategory has paired fuse/cut prompts (above). |
| Slab-with-hole used `drawCircle` for square hole | Tier 1 extra hand explicitly separates "rectangular hole" vs "round hole" by prompt phrasing → output shape. |
| Translation defaults to [0,0,0] when prompt has offset | Synthetic generator always emits realistic translates for multi-element layouts. |
| Variable names random (`e0`, `e1`, ...) | Augmentation pass renames variables to descriptive (`wall`, `door`, `column`) for ~30% of rows so model learns naming has semantic content. |

## Acceptance (v2 closure for D4 launch)

- 400 base rows produced, JSONL-valid, no duplicate `(messages[1].content, messages[2].content)` pairs.
- Augmentation pass produces ~1200 train rows, ~40 eval rows.
- Eval set is the held-out 10% (seed 42), with a stratification check: every subcategory in train is represented in eval.
- Round-trip validation pass rate (synthetic + mined): ≥ 90%.

If any of these miss, D4 launches with a 300-row v2 per slip rule, NOT a 400-row v2 with quality issues.

## Cross-refs

- Plan: `docs/plan-18-day.md` D1-D4
- Spike A retrospective: `docs/spike-a-retrospective.md` (semantic-gap observations seed v2 fixes)
- Spike B retrospective: `docs/spike-b-retrospective.md` (corpus exhaustion at 12 unique pairs — motivates synthetic generator)
- Tier 1 op vocabulary: `src/train/inference_eval.py:TIER1_OPS`
- v1 base fixtures: `fixtures/tier1.jsonl` (50)
- v1 mined fixtures: `fixtures/spike-b-*.jsonl`
- Build pipeline: `src/train/build_dataset.py`
