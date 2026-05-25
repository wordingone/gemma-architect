#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
export-decoder-dual-head.py — ONNX graph surgery for dual-output early-exit decoder.

Adds a `logits_early_exit` graph output to decoder_model_merged_q4.onnx for both
E2B and E4B checkpoints. Existing `logits` output is byte-identical; no new weights.

Architecture (from docs/internal/decoder-anatomy.md):
  E2B (L=15 KV layers): exit at KV 5 (r=0.33), tensor layers.5/layer_scalar/Mul/output_0
  E4B (L=24 KV layers): exit at KV 8 (r=0.33), tensor layers.8/layer_scalar/Mul/output_0

Graph surgery approach:
  1. Load topology with load_external_data=False (topology-only, no weight files needed).
  2. Trace back from 'logits' output to find the lm_head MatMul node (op_type auto-detected).
  3. Clone that node with exit-layer hidden state as activation input, same weight refs.
  4. Append 'logits_early_exit' as new graph output.
  5. Save modified .onnx topology (small; .onnx_data weight file unchanged).

The early-exit head omits:
  - final_norm: exit tensor is already post-layernorm (layers.e/layer_scalar/Mul output).
  - Slice (num_logits_to_keep): only relevant for prefill (S>1). During decode S=1 always.
  - softcap: drafting does argmax; softcapped vs uncapped logits give same argmax.

Usage:
  python scripts/export-decoder-dual-head.py \\
    --e2b web/public/models/onnx-community__gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4.onnx \\
    --e4b web/public/models/onnx-community__gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4.onnx \\
    [--exit-ratio 0.33] [--dry-run] [--inspect-only]

Without --e2b / --e4b args, expects files in the default web/public/models paths above.

Outputs (same directory as input, suffixed with -dual-head):
  decoder_model_merged_q4-dual-head.onnx  — modified topology
  decoder-dual-head-manifest.json         — sha256 + metadata
"""

import argparse
import hashlib
import json
import math
import re
import sys
import io
from pathlib import Path
from typing import Optional

# Normalize Windows console encoding
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

try:
    import onnx
    from onnx import helper, TensorProto, numpy_helper
except ImportError:
    print("ERROR: onnx package not installed. Run: pip install onnx", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent

# Default paths (populated by download or manual placement)
DEFAULT_E2B = REPO_ROOT / "web/public/models/onnx-community__gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4.onnx"
DEFAULT_E4B = REPO_ROOT / "web/public/models/onnx-community__gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4.onnx"

# Tensor names for hidden state at exit layers (from decoder-anatomy.md)
EXIT_TENSORS = {
    "e2b": {
        0.33: "/model/layers.5/layer_scalar/Mul/output_0",
        0.50: "/model/layers.7/layer_scalar/Mul/output_0",
        0.67: "/model/layers.10/layer_scalar/Mul/output_0",
    },
    "e4b": {
        0.33: "/model/layers.8/layer_scalar/Mul/output_0",
        0.50: "/model/layers.12/layer_scalar/Mul/output_0",
        0.67: "/model/layers.16/layer_scalar/Mul/output_0",
    },
}

VOCAB_SIZE = 262144  # Gemma 4 vocabulary size


# ---------------------------------------------------------------------------
# Graph helpers
# ---------------------------------------------------------------------------

def build_output_map(graph) -> dict[str, object]:
    """Map output tensor name → node that produces it."""
    out_map: dict[str, object] = {}
    for node in graph.node:
        for outp in node.output:
            out_map[outp] = node
    return out_map


def find_lm_head_node(graph):
    """
    Walk backward from 'logits' to find the lm_head MatMul node.

    The path in q4 models is:
      exit_hidden → [optional softcap Mul/tanh] → [Slice num_logits_to_keep]
                 → MatMul/MatMulNBits (lm_head) → [softcap] → 'logits'

    We walk back at most 5 hops from 'logits', stopping at the first node whose
    op_type contains 'MatMul' (standard or quantized).
    """
    out_map = build_output_map(graph)

    # Find the node that produces 'logits' (may be softcap/Mul or directly MatMul)
    cur = out_map.get("logits")
    if cur is None:
        raise ValueError("Graph has no 'logits' output node")

    for _ in range(6):
        op = cur.op_type.lower()
        if "matmul" in op:
            return cur
        # Walk back on first input (activation path)
        inp0 = cur.input[0] if cur.input else None
        if not inp0 or inp0 not in out_map:
            break
        cur = out_map[inp0]

    raise ValueError(
        f"Could not find lm_head MatMul walking back from 'logits'. "
        f"Last node: op={cur.op_type}, inputs={list(cur.input)[:3]}"
    )


def inspect_model(model_path: Path, variant: str) -> None:
    """Print topology summary for debugging / audit."""
    print(f"\n{'='*60}")
    print(f"Inspecting {variant}: {model_path.name}")
    print(f"{'='*60}")

    m = onnx.load(str(model_path), load_external_data=False)
    g = m.graph
    out_map = build_output_map(g)

    # Graph outputs
    print(f"Graph outputs: {[o.name for o in g.output]}")

    # lm_head node
    lm_head = find_lm_head_node(g)
    print(f"\nlm_head node:")
    print(f"  op_type  : {lm_head.op_type}")
    print(f"  domain   : {lm_head.domain!r}")
    print(f"  name     : {lm_head.name!r}")
    print(f"  inputs   : {list(lm_head.input)}")
    print(f"  outputs  : {list(lm_head.output)}")
    print(f"  attrs    : {[(a.name, a.type) for a in lm_head.attribute]}")

    # Exit tensors
    ratio = 0.33
    exit_key = "e2b" if variant == "e2b" else "e4b"
    exit_tensor = EXIT_TENSORS[exit_key][ratio]
    print(f"\nExit tensor (r={ratio}): {exit_tensor!r}")
    if exit_tensor in out_map:
        prod = out_map[exit_tensor]
        print(f"  Produced by: op={prod.op_type}, name={prod.name!r}")
    else:
        # May be an intermediate that doesn't appear as output; check graph inputs/nodes
        found = any(exit_tensor in list(n.output) for n in g.node)
        print(f"  In node outputs: {found}")

    # Initializer names containing 'lm_head'
    lm_head_inits = [i.name for i in g.initializer if "lm_head" in i.name.lower()]
    print(f"\nlm_head initializers ({len(lm_head_inits)} total, first 5):")
    for n in lm_head_inits[:5]:
        print(f"  {n!r}")


# ---------------------------------------------------------------------------
# Surgery
# ---------------------------------------------------------------------------

def add_early_exit_output(
    model: onnx.ModelProto,
    exit_tensor: str,
    exit_ratio: float,
    output_name: str = "logits_early_exit",
) -> onnx.ModelProto:
    """
    Clone the lm_head MatMul node and wire it from `exit_tensor` → `output_name`.

    Strategy: replicate the lm_head node exactly, replacing only input[0] (activation)
    with the exit-layer hidden state. Weight inputs (quantized weights, scales, zero-points)
    are shared references — no new data added to the graph.
    """
    g = model.graph

    lm_head = find_lm_head_node(g)

    # Verify exit tensor exists in the graph (intermediate tensor produced by some node)
    produced = {out for node in g.node for out in node.output}
    if exit_tensor not in produced:
        # Might be a graph input (first token embedding) — check inputs too
        inp_names = {i.name for i in g.input}
        if exit_tensor not in inp_names:
            raise ValueError(
                f"Exit tensor {exit_tensor!r} not found as output of any node or graph input.\n"
                f"Check decoder-anatomy.md for correct tensor names.\n"
                f"Sample produced tensors (last 5): {sorted(produced)[-5:]}"
            )

    # Build the new node: same op, same weight inputs, activation replaced
    new_inputs = [exit_tensor] + list(lm_head.input[1:])
    new_node = helper.make_node(
        lm_head.op_type,
        inputs=new_inputs,
        outputs=[output_name],
        name=f"early_exit_lm_head_r{int(exit_ratio*100)}",
        domain=lm_head.domain if lm_head.domain else "",
    )
    # Copy attributes (e.g., K/N for MatMulNBits, bits, blocksize)
    for attr in lm_head.attribute:
        new_node.attribute.append(attr)

    g.node.append(new_node)

    # Add graph output (shape [batch, seq, vocab] — dynamic dims)
    # Use same element type as existing logits output
    existing_logits_type = TensorProto.FLOAT  # default
    for out in g.output:
        if out.name == "logits":
            try:
                existing_logits_type = out.type.tensor_type.elem_type
            except Exception:
                pass
            break

    g.output.append(
        helper.make_tensor_value_info(
            output_name,
            existing_logits_type,
            [None, None, VOCAB_SIZE],
        )
    )

    # Store exit metadata in model metadata_props
    existing_meta = {kv.key: kv.value for kv in model.metadata_props}
    existing_meta["exit_layer_kv_index"] = str(_kv_index_from_tensor(exit_tensor))
    existing_meta["exit_ratio"] = str(exit_ratio)
    existing_meta["exit_output_name"] = output_name
    del model.metadata_props[:]
    for k, v in existing_meta.items():
        entry = model.metadata_props.add()
        entry.key = k
        entry.value = v

    return model


def _kv_index_from_tensor(tensor_name: str) -> int:
    """Extract KV layer index from tensor name like /model/layers.5/..."""
    m = re.search(r"layers\.(\d+)", tensor_name)
    return int(m.group(1)) if m else -1


# ---------------------------------------------------------------------------
# I/O
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def process_model(
    input_path: Path,
    variant: str,
    exit_ratio: float,
    dry_run: bool = False,
) -> Optional[Path]:
    if not input_path.exists():
        print(f"[{variant}] SKIP: {input_path} not found", file=sys.stderr)
        print(
            f"[{variant}] Download command:\n"
            f"  curl -L --create-dirs -o {input_path} \\\n"
            f"    'https://huggingface.co/onnx-community/"
            f"gemma-4-{variant.upper()}-it-ONNX/resolve/main/onnx/decoder_model_merged_q4.onnx'"
        )
        return None

    exit_key = variant.lower()
    exit_tensor = EXIT_TENSORS[exit_key][exit_ratio]
    out_path = input_path.with_stem(input_path.stem + "-dual-head")

    print(f"\n[{variant}] Loading topology: {input_path}")
    print(f"[{variant}] Exit tensor (r={exit_ratio}): {exit_tensor}")

    model = onnx.load(str(input_path), load_external_data=False)
    orig_outputs = [o.name for o in model.graph.output]
    print(f"[{variant}] Graph outputs before: {orig_outputs}")

    model = add_early_exit_output(model, exit_tensor, exit_ratio)
    new_outputs = [o.name for o in model.graph.output]
    print(f"[{variant}] Graph outputs after:  {new_outputs}")

    # Validate (topology only — weights not loaded)
    try:
        onnx.checker.check_model(model)
        print(f"[{variant}] onnx.checker PASS")
    except onnx.checker.ValidationError as e:
        print(f"[{variant}] onnx.checker WARN (external data not loaded): {e}", file=sys.stderr)

    if dry_run:
        print(f"[{variant}] DRY RUN — skipping write")
        return None

    onnx.save(model, str(out_path))
    size_in  = input_path.stat().st_size
    size_out = out_path.stat().st_size
    delta_pct = (size_out - size_in) / size_in * 100
    sha = sha256_file(out_path)

    print(f"[{variant}] Written: {out_path}")
    print(f"[{variant}] Size: {size_in:,} -> {size_out:,} bytes ({delta_pct:+.2f}%)")
    print(f"[{variant}] SHA-256: {sha}")

    return out_path


def write_manifest(results: list[dict], repo_root: Path) -> None:
    manifest_path = repo_root / "drafter-manifest.json"
    try:
        existing = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    except json.JSONDecodeError:
        existing = {}

    existing.setdefault("dual_head", {})
    for r in results:
        existing["dual_head"][r["variant"]] = {
            "exit_ratio": r["exit_ratio"],
            "exit_tensor": r["exit_tensor"],
            "exit_layer_kv_index": _kv_index_from_tensor(r["exit_tensor"]),
            "output_name": "logits_early_exit",
            "topology_sha256": r["sha256"],
            "topology_size_bytes": r["size"],
            "source_file": str(r["out_path"]),
        }

    manifest_path.write_text(json.dumps(existing, indent=2) + "\n")
    print(f"\nManifest updated: {manifest_path}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    p = argparse.ArgumentParser(description="Add logits_early_exit output to Gemma 4 decoder ONNX")
    p.add_argument("--e2b", type=Path, default=DEFAULT_E2B, help="E2B decoder ONNX path")
    p.add_argument("--e4b", type=Path, default=DEFAULT_E4B, help="E4B decoder ONNX path")
    p.add_argument(
        "--exit-ratio", type=float, default=0.33,
        choices=[0.33, 0.50, 0.67],
        help="Fraction of KV layers for early-exit head (0.33 = recommended k=4 config)",
    )
    p.add_argument("--dry-run", action="store_true", help="Parse + validate, do not write output")
    p.add_argument("--inspect-only", action="store_true", help="Print topology info and exit")
    args = p.parse_args()

    if args.inspect_only:
        for path, variant in [(args.e2b, "e2b"), (args.e4b, "e4b")]:
            if path.exists():
                inspect_model(path, variant)
        return

    print(f"export-decoder-dual-head.py — exit ratio={args.exit_ratio}")
    print(f"onnx version: {onnx.__version__}")

    manifest_rows = []

    for path, variant in [(args.e2b, "e2b"), (args.e4b, "e4b")]:
        exit_tensor = EXIT_TENSORS[variant][args.exit_ratio]
        out = process_model(path, variant, args.exit_ratio, dry_run=args.dry_run)
        if out is not None:
            manifest_rows.append({
                "variant": variant,
                "exit_ratio": args.exit_ratio,
                "exit_tensor": exit_tensor,
                "out_path": str(out.relative_to(REPO_ROOT)),
                "sha256": sha256_file(out),
                "size": out.stat().st_size,
            })

    if manifest_rows and not args.dry_run:
        write_manifest(manifest_rows, REPO_ROOT)

    print("\nDone.")
    if not manifest_rows and not args.dry_run:
        print(
            "\nNo files processed. Download ONNX topology files first:\n"
            "  curl -L --create-dirs \\\n"
            f"    -o {DEFAULT_E2B} \\\n"
            "    'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/decoder_model_merged_q4.onnx'\n"
            "  curl -L --create-dirs \\\n"
            f"    -o {DEFAULT_E4B} \\\n"
            "    'https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/onnx/decoder_model_merged_q4.onnx'"
        )


if __name__ == "__main__":
    main()
