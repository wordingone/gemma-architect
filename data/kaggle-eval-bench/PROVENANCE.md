# Kaggle RVT/IFC Eval Bench — Provenance

## Source

**Dataset:** [artemboiko/rvtifc-projects](https://www.kaggle.com/datasets/artemboiko/rvtifc-projects)  
**License:** GPL-2.0  
**Origin crawler:** DataDrivenConstruction.io  
**Contents:** 4 596 IFC + 6 471 Revit files, ~3M elements total  
**Access:** Kaggle CLI — `kaggle datasets download artemboiko/rvtifc-projects`

## Use in this repository

**EVAL ONLY — NOT USED FOR TRAINING.**

Per project directive 2026-05-05: *"we could use the kaggle dataset as pure eval and
targets"*. The IFC files in this directory are held-out ground-truth geometry used
to score LoRA-generated outputs. No file from this corpus was or will be used as
training input.

- Training data lives in `data/train_*.jsonl` (synthetic + hand-authored).
- This directory (`data/kaggle-eval-bench/`) and the eval bench
  (`data/eval_kaggle.jsonl`) are never read by any training script.
- `scripts/eval-kaggle-bench.py` asserts this boundary at runtime: it will
  exit 2 if called with a `--train` flag or if the output path overlaps with
  `data/train_*.jsonl`.

## License analysis

GPL-2.0 data used **as eval targets only** does not trigger copyleft on model
weights. The model that emits IFC has no derivative relationship to the IFC files
used to score its output. `scripts/eval-kaggle-bench.py` is separately licensed
GPL-2.0 (see script header) and is a separable component from the Apache-2.0
submission core.

## Selection criteria

Subset drawn from the full corpus for fast eval iteration:

- **Schema:** IFC2x3 or IFC4 only (no Revit-native .rvt files)
- **Building type:** residential single-family + small commercial (≤ 4 floors)
- **File size:** < 5 MB uncompressed (keeps parse time < 30 s per file)
- **Element coverage:** must include ≥ 1 each of: IfcWall, IfcSlab, IfcWindow (or IfcDoor)
- **Target count:** 50–100 files

Files are listed in `../eval_kaggle.jsonl` with provenance hash, derived prompt,
gold element-type counts, and file path.

## Download

```bash
# Requires Kaggle API credentials in ~/.kaggle/kaggle.json
kaggle datasets download artemboiko/rvtifc-projects \
  -p data/kaggle-eval-bench/ --unzip
# Then run selection:
python scripts/select-kaggle-subset.py  # filters to criteria above
```

IFC files are gitignored (large binaries). Only `PROVENANCE.md` and
`eval_kaggle.jsonl` are tracked.
