# AI prompt → geometry pipeline (#176)

The PROMPT tab takes a natural-language description and produces a replicad
JS construction sequence. Two paths back the textbox.

## Path A — bundled cache (default)

60 prompt → JS pairs are produced at build time (`bun run web:build` runs
`scripts/build-ai-cache.ts` which emits `web/dist/ai-cache.json`):
- Rows from `data/dsl-demo-corpus.jsonl` (19 DSL corpus rows compiled via
  `web/src/dsl-eval.ts`).
- 1 row for the Schultz Residence (gold sequence from `data/schultz-target.jsonl`).
- Remaining rows from the precursor Gemma 3 4B LoRA eval outputs (archived at
  `outputs/archive-gemma3-2026-05-05/`). Note: `outputs/` is gitignored; these
  are not in a fresh clone. Run `submission/repro.md` dataset steps first.

The cache (`web/dist/ai-cache.json`) is produced at build time, not checked in.
The frontend's `web/src/ai-generate.ts` fetches it lazily on the first
`generateGeometry()` call and does weighted-F1 fuzzy match (numeric/dimension
tokens count 2x) to pick the best cached row. F1 ≥ 0.30 hits;
below that, falls through to the on-device Gemma 4 model.

This path is **demo-stable** — sub-100ms response, no GPU, no network call.
It's what judges see by default.

## Path B — live Gemma 4 (default for novel prompts)

Stock `onnx-community/gemma-4-E4B-it-ONNX` loads in-browser via Transformers.js v4
(WebGPU). No fine-tune or adapter loaded. When a prompt misses the cache (F1 < 0.30),
`generateGeometry()` sends it to the in-browser model.

Use `?gemma_model=e2b` URL param to switch to the smaller E2B variant.

`src/serve/serve_lora.py` (FastAPI LoRA wrapper) is legacy scaffolding kept for
reference; it is not on the deployed path.

## Pipeline shape

```
prompt textbox
    │
    ▼
ai-generate.generateGeometry(prompt)
    │
    └─ tryCache(prompt)
            │
            └─ F1 fuzzy match against ai-cache.json (60 rows)
                    │
                    └─ best ≥ 0.30 → JS
                    └─ no match → live Gemma 4 E4B-it (Transformers.js WebGPU)
    │
    ▼
js-source textarea (legacy id)
    │
    ▼
run-btn click → web/src/worker.ts → replicad execute() → mesh + IFC
```

The textarea/run-btn legacy wiring is preserved unchanged — `runGenerate()`
in `web/src/workbench.ts` only intercepts the click when the textarea has
been edited away from the currently selected demo prompt.

## Test coverage

- `scripts/build-ai-cache.ts` — emits the cache; reproducible from eval JSONLs
- `scripts/test-ai-match.ts` — smoke-tests the F1 matcher against representative
  user prompts; verifies threshold behavior

To re-verify after corpus changes:

```
bun scripts/build-ai-cache.ts && bun scripts/test-ai-match.ts
```

## Why a cache + on-device model

The cache gives sub-100ms latency on the 60 known demo prompts and survives
offline / network-blocked demo settings. The on-device Gemma 4 E4B-it handles
novel prompts. Both paths share one frontend interface (`generateGeometry`) so
the backend is transparent to the workbench wiring.
