# SPDX-License-Identifier: GPL-2.0-only
# This file is separately licensed GPL-2.0 (GPL-2.0 eval data used as targets only).
# The Apache-2.0 submission core (all other files) has no derivative relationship
# to IFC files used to score its output. See data/kaggle-eval-bench/PROVENANCE.md.
"""
Kaggle RVT/IFC held-out eval bench — scores a Gemma 4 LoRA adapter
against IFC element-type ground truth from the kaggle-eval-bench corpus.

Per PROVENANCE.md: EVAL ONLY. This script asserts the eval/train boundary
at runtime and will exit 2 if the boundary is violated.

Inputs:
  ADAPTER_DIR (env, required)           → outputs/cad-lora-v3-{tag}/
  GEMMA4_CHAT_TEMPLATE (env, required)  → e.g. 'gemma-4'
  data/eval_kaggle.jsonl                → held-out rows (schema below)

Row schema (eval_kaggle.jsonl):
  id            string   sha256[:12] of (source_url + filename)
  prompt        string   derived natural-language prompt for the LoRA
  gold_elements object   {IfcWall: N, IfcSlab: N, ...} element-type counts
  gold_path     string   relative path under data/kaggle-eval-bench/
  schema        string   "IFC2x3" | "IFC4"

Outputs:
  outputs/cad-lora-v3-{tag}-kaggle-eval.jsonl   one JSON row per bench row
  outputs/cad-lora-v3-{tag}-kaggle-eval-summary.json   aggregate metrics
"""

import argparse
import glob
import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

parser = argparse.ArgumentParser(description="Kaggle RVT/IFC eval bench runner.")
parser.add_argument(
    "--dry-run",
    action="store_true",
    help="Validate env and bench file; do not load model or generate.",
)
parser.add_argument(
    "--train",
    action="store_true",
    help="(blocked) This flag asserts the eval/train boundary and causes exit 2.",
)
parser.add_argument(
    "--tag",
    default=None,
    help="Explicit tag override (default: derived from ADAPTER_DIR name).",
)
args = parser.parse_args()

# ---------------------------------------------------------------------------
# Eval/train boundary assertion (PROVENANCE.md requirement)
# ---------------------------------------------------------------------------

if args.train:
    print(
        "eval-kaggle-bench.py: --train flag is not permitted. "
        "This corpus is EVAL ONLY (GPL-2.0 data, artemboiko/rvtifc-projects). "
        "See data/kaggle-eval-bench/PROVENANCE.md.",
        file=sys.stderr,
    )
    sys.exit(2)

# ---------------------------------------------------------------------------
# ADAPTER_DIR guard (same loud-fail pattern as eval-schultz.py)
# ---------------------------------------------------------------------------

_adapter_env = os.environ.get("ADAPTER_DIR")
if not _adapter_env:
    print(
        "ADAPTER_DIR unset. Legacy LoRA adapters purged 2026-05-05 "
        "per project directive (hackathon eligibility drift). Set ADAPTER_DIR to a "
        "Gemma 4 LoRA adapter path before evaluating.",
        file=sys.stderr,
    )
    sys.exit(2)

ADAPTER = Path(_adapter_env)

# ---------------------------------------------------------------------------
# Bench file
# ---------------------------------------------------------------------------

BENCH = REPO / "data" / "eval_kaggle.jsonl"
if not BENCH.exists():
    print(f"bench file not found: {BENCH}", file=sys.stderr)
    sys.exit(2)

rows = []
for line in BENCH.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    rows.append(json.loads(line))

if not rows:
    print("eval_kaggle.jsonl has zero data rows — run select-kaggle-subset.py first.")
    print("Exiting 0 (empty bench is not an error per design).")
    sys.exit(0)

print(f"bench: {len(rows)} rows from {BENCH}")

# ---------------------------------------------------------------------------
# Derive tag + output paths
# ---------------------------------------------------------------------------

if args.tag:
    TAG = args.tag
elif ADAPTER.exists():
    TAG = ADAPTER.name.removeprefix("cad-lora-v3-")
else:
    TAG = "unknown"

OUT_JSONL = REPO / f"outputs/cad-lora-v3-{TAG}-kaggle-eval.jsonl"
OUT_SUMMARY = REPO / f"outputs/cad-lora-v3-{TAG}-kaggle-eval-summary.json"

# Eval/train boundary: output must not overlap with training data.
train_paths = set(glob.glob(str(REPO / "data" / "train_*.jsonl")))
if str(OUT_JSONL) in train_paths or str(OUT_SUMMARY) in train_paths:
    print(
        f"eval-kaggle-bench.py: output path {OUT_JSONL} overlaps with data/train_*.jsonl. "
        "Refusing to write — eval/train boundary violation.",
        file=sys.stderr,
    )
    sys.exit(2)

# ---------------------------------------------------------------------------
# Dry-run stops here
# ---------------------------------------------------------------------------

if args.dry_run:
    print(f"--dry-run: env OK, bench has {len(rows)} rows, output → {OUT_JSONL}")
    print("Not loading model. Exiting 0.")
    sys.exit(0)

# ---------------------------------------------------------------------------
# Validate ADAPTER path now that we are past dry-run
# ---------------------------------------------------------------------------

if not ADAPTER.exists():
    print(f"adapter not found: {ADAPTER}", file=sys.stderr)
    sys.exit(2)

# ---------------------------------------------------------------------------
# Load model
# ---------------------------------------------------------------------------

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")

import unsloth  # noqa: F401
from unsloth import FastModel
from unsloth.chat_templates import get_chat_template

_chat_template = os.environ.get("GEMMA4_CHAT_TEMPLATE")
if not _chat_template:
    print(
        "GEMMA4_CHAT_TEMPLATE unset. Set to the Unsloth chat template name "
        "matching the chosen Gemma 4 base (e.g. 'gemma-4').",
        file=sys.stderr,
    )
    sys.exit(2)

print(f"loading adapter {ADAPTER} ({TAG})...")
model, tokenizer = FastModel.from_pretrained(
    model_name=str(ADAPTER),
    max_seq_length=2048,
    load_in_4bit=True,
)
tokenizer = get_chat_template(tokenizer, chat_template=_chat_template)
FastModel.for_inference(model)

# ---------------------------------------------------------------------------
# Scoring helpers
# ---------------------------------------------------------------------------

# IFC element type names as they appear in IFC-STEP output (upper-case) or
# in generated prose/pseudocode (mixed-case).
_IFC_TYPE_RE = re.compile(
    r"\b(IFC[A-Z][A-Z0-9]+)\b",
    re.IGNORECASE,
)


def _count_elements(text: str) -> dict:
    counts: dict[str, int] = {}
    for m in _IFC_TYPE_RE.finditer(text):
        key = m.group(1).upper()
        # Normalise to IfcXxx title-case to match gold_elements keys.
        title = "Ifc" + key[3:].title().replace("_", "")
        counts[title] = counts.get(title, 0) + 1
    return counts


def _score_elements(pred_counts: dict, gold_counts: dict) -> dict:
    """Return per-type hit/miss breakdown and aggregate F1-style metrics."""
    all_types = set(pred_counts) | set(gold_counts)
    tp = fp = fn = 0
    per_type = {}
    for t in sorted(all_types):
        g = gold_counts.get(t, 0)
        p = pred_counts.get(t, 0)
        hit = min(g, p)
        tp += hit
        fp += max(0, p - g)
        fn += max(0, g - p)
        per_type[t] = {"gold": g, "pred": p, "hit": hit}
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1, "per_type": per_type}


# ---------------------------------------------------------------------------
# Run eval loop
# ---------------------------------------------------------------------------

OUT_JSONL.parent.mkdir(parents=True, exist_ok=True)

results = []
with OUT_JSONL.open("w", encoding="utf-8") as fh:
    for i, row in enumerate(rows):
        row_id = row["id"]
        prompt = row["prompt"]
        gold_elements = row.get("gold_elements", {})
        schema = row.get("schema", "unknown")

        print(f"[{i+1}/{len(rows)}] {row_id} schema={schema} gold={list(gold_elements.keys())[:4]}...")

        msgs = [{"role": "user", "content": prompt}]
        text = tokenizer.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(text=text, return_tensors="pt").to(model.device)
        out = model.generate(
            **inputs,
            max_new_tokens=512,
            temperature=0.2,
            top_p=0.95,
            do_sample=True,
        )
        pred = tokenizer.decode(
            out[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True
        ).strip()

        pred_counts = _count_elements(pred)
        score = _score_elements(pred_counts, gold_elements)

        result = {
            "id": row_id,
            "schema": schema,
            "gold_path": row.get("gold_path", ""),
            "prompt_chars": len(prompt),
            "pred_chars": len(pred),
            "gold_elements": gold_elements,
            "pred_elements": pred_counts,
            "score": score,
        }
        results.append(result)
        fh.write(json.dumps(result) + "\n")
        fh.flush()

        print(
            f"  f1={score['f1']:.3f} precision={score['precision']:.3f} "
            f"recall={score['recall']:.3f} tp={score['tp']} fp={score['fp']} fn={score['fn']}"
        )

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

n = len(results)
if n:
    mean_f1 = sum(r["score"]["f1"] for r in results) / n
    mean_precision = sum(r["score"]["precision"] for r in results) / n
    mean_recall = sum(r["score"]["recall"] for r in results) / n
    total_tp = sum(r["score"]["tp"] for r in results)
    total_fp = sum(r["score"]["fp"] for r in results)
    total_fn = sum(r["score"]["fn"] for r in results)
else:
    mean_f1 = mean_precision = mean_recall = 0.0
    total_tp = total_fp = total_fn = 0

summary = {
    "tag": TAG,
    "adapter": str(ADAPTER),
    "bench_rows": n,
    "mean_f1": mean_f1,
    "mean_precision": mean_precision,
    "mean_recall": mean_recall,
    "total_tp": total_tp,
    "total_fp": total_fp,
    "total_fn": total_fn,
}
OUT_SUMMARY.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

print()
print("=" * 60)
print(f"Kaggle eval — {n} rows — tag={TAG}")
print(f"  mean_f1={mean_f1:.4f}  precision={mean_precision:.4f}  recall={mean_recall:.4f}")
print(f"  total tp={total_tp}  fp={total_fp}  fn={total_fn}")
print(f"\nWrote {OUT_JSONL}")
print(f"Wrote {OUT_SUMMARY}")
