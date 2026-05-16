#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
import io
# Force UTF-8 on Windows consoles (cp1252 rejects emojis printed by torch internals)
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
"""
Export google/gemma-4-E2B-it-assistant to ONNX for browser-side MTP (#674 AC2).

Architecture notes (important before editing):
- The drafter is NOT standalone. It requires two inputs from the TARGET model:
    1. inputs_embeds = cat([target_token_embedding, target_last_hidden_state], dim=-1)
       shape [batch, seq, 2 * backbone_hidden_size] = [batch, seq, 3072]
    2. shared_kv_states: the target's KV cache from its last sliding_attention and
       full_attention layers (used as cross-attention keys/values in the drafter)
- ONNX does not support dict inputs, so shared_kv_states is flattened to 4 tensors.
- pre_projection = Linear(3072, 256): drafter compresses target context to its own dim.
- 4 tiny transformer layers (hidden_size=256, 4 heads), then lm_head → vocab 262144.

Wrapper input interface (ONNX node names):
  inputs_embeds   [batch, seq, 3072]  float32  — concat of target embed + hidden state
  position_ids    [batch, seq]        int64    — constant at "last seen" position for MTP
  sliding_k       [batch, 1, kv, 256] float32  — target last sliding-attn layer K
  sliding_v       [batch, 1, kv, 256] float32  — target last sliding-attn layer V
  full_k          [batch, 1, kv, 512] float32  — target last full-attn layer K
  full_v          [batch, 1, kv, 512] float32  — target last full-attn layer V

Wrapper outputs:
  logits          [batch, seq, 262144] float32 — next-token probabilities (raw)
  projected_state [batch, seq, 1536]   float32 — post_projection output for next draft step

Usage:
  python scripts/export-drafter-onnx.py [--output OUTPUT_DIR] [--dtype {float32,float16}]

Output: web/public/models/gemma-4-E2B-it-assistant/drafter.onnx (~310 MB at float32)
"""

import argparse
import json
import os
import sys
from pathlib import Path

import torch
import torch.nn as nn

# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

parser = argparse.ArgumentParser(description="Export Gemma-4-E2B-it-assistant to ONNX")
parser.add_argument(
    "--output",
    default=str(Path(__file__).parent.parent / "web" / "public" / "models" / "gemma-4-E2B-it-assistant"),
    help="Directory to write drafter.onnx",
)
parser.add_argument(
    "--dtype",
    choices=["float32", "float16"],
    default="float32",
    help="Export dtype (float32 recommended for WASM/WebGPU compatibility)",
)
parser.add_argument(
    "--dynamo",
    action="store_true",
    help="Use torch.onnx.export dynamo=True (experimental; falls back to trace if fails)",
)
args = parser.parse_args()

OUTPUT_DIR = Path(args.output)
DTYPE = torch.float32 if args.dtype == "float32" else torch.float16
MODEL_ID = "google/gemma-4-E2B-it-assistant"

# ---------------------------------------------------------------------------
# Target model constants (gemma-4-E2B-it)
# ---------------------------------------------------------------------------

TARGET_HIDDEN_SIZE   = 1536   # backbone_hidden_size in drafter config
TARGET_SLIDING_HEAD_DIM = 256  # head_dim for sliding_attention layers
TARGET_FULL_HEAD_DIM    = 512  # global_head_dim for full_attention layers
TARGET_NUM_KV_HEADS     = 1   # num_key_value_heads (both layer types)

DRAFTER_BACKBONE_HIDDEN = TARGET_HIDDEN_SIZE        # 1536
DRAFTER_INPUTS_EMBEDS   = 2 * TARGET_HIDDEN_SIZE    # 3072 (concat of embed + hidden)

# ---------------------------------------------------------------------------
# Load drafter
# ---------------------------------------------------------------------------

print(f"Loading {MODEL_ID} ...")
from transformers import Gemma4AssistantForCausalLM, AutoConfig

config = AutoConfig.from_pretrained(MODEL_ID, trust_remote_code=True)
model = Gemma4AssistantForCausalLM.from_pretrained(
    MODEL_ID,
    torch_dtype=DTYPE,
    trust_remote_code=True,
    low_cpu_mem_usage=True,
    # Use eager attention to avoid SDPA SymBool issue in torch.onnx.export.
    # SDPA's `is_causal` becomes a SymBool under dynamic shapes, which the
    # dynamo exporter rejects. Eager mode uses explicit mask computation instead.
    attn_implementation="eager",
)

# Monkey-patch create_attention_masks to return None masks (full / unmasked attention).
# The MTP pattern always uses seq=1 query tokens — a single query attends to all KV
# tokens from the target without masking. Returning None here is semantically correct
# and avoids the complex masking_utils.sdpa_mask() path that isn't JIT-traceable in
# transformers 5.x (the function uses tuple unpacking of tensor shapes in a way that
# confuses torch.jit.trace's symbolic tracer).
model.create_attention_masks = (  # type: ignore[method-assign]
    lambda embeds, attn_mask, shared_kv: {"full_attention": None, "sliding_attention": None}
)
model.eval()
print(f"  Loaded. dtype={DTYPE}, params={sum(p.numel() for p in model.parameters()):,}")

# ---------------------------------------------------------------------------
# Wrapper: flatten shared_kv_states dict → named tensor inputs
# ---------------------------------------------------------------------------

class DrafterONNXWrapper(nn.Module):
    """Flat-input wrapper around Gemma4AssistantForCausalLM for ONNX export.

    Reconstructs the shared_kv_states dict expected by the drafter's forward()
    from 4 named tensors so that ONNX (which doesn't support dict inputs) can
    represent the model as a single graph.

    Returns (logits, projected_state) as a flat tuple.
    """

    def __init__(self, drafter: Gemma4AssistantForCausalLM) -> None:
        super().__init__()
        self.drafter = drafter

    def forward(
        self,
        inputs_embeds: torch.Tensor,   # [batch, seq, 3072]
        position_ids:  torch.Tensor,   # [batch, seq]
        sliding_k:     torch.Tensor,   # [batch, 1, kv_seq, 256]
        sliding_v:     torch.Tensor,   # [batch, 1, kv_seq, 256]
        full_k:        torch.Tensor,   # [batch, 1, kv_seq, 512]
        full_v:        torch.Tensor,   # [batch, 1, kv_seq, 512]
    ) -> tuple[torch.Tensor, torch.Tensor]:
        shared_kv_states = {
            "sliding_attention": (sliding_k, sliding_v),
            "full_attention":    (full_k,    full_v),
        }
        out = self.drafter(
            inputs_embeds=inputs_embeds,
            position_ids=position_ids,
            shared_kv_states=shared_kv_states,
        )
        # out.last_hidden_state = projected_state (post_projection output)
        return out.logits, out.last_hidden_state


wrapper = DrafterONNXWrapper(model)
wrapper.eval()

# ---------------------------------------------------------------------------
# Dummy inputs (seq=1, kv_seq=4 to exercise the sliding-window masking)
# ---------------------------------------------------------------------------

BATCH = 1
SEQ   = 1
KV    = 4  # short but >1 so SWA masking logic executes

dummy_inputs_embeds = torch.zeros(BATCH, SEQ, DRAFTER_INPUTS_EMBEDS, dtype=DTYPE)
dummy_position_ids  = torch.zeros(BATCH, SEQ, dtype=torch.long)
dummy_sliding_k     = torch.zeros(BATCH, TARGET_NUM_KV_HEADS, KV, TARGET_SLIDING_HEAD_DIM, dtype=DTYPE)
dummy_sliding_v     = torch.zeros(BATCH, TARGET_NUM_KV_HEADS, KV, TARGET_SLIDING_HEAD_DIM, dtype=DTYPE)
dummy_full_k        = torch.zeros(BATCH, TARGET_NUM_KV_HEADS, KV, TARGET_FULL_HEAD_DIM, dtype=DTYPE)
dummy_full_v        = torch.zeros(BATCH, TARGET_NUM_KV_HEADS, KV, TARGET_FULL_HEAD_DIM, dtype=DTYPE)

ARGS = (
    dummy_inputs_embeds,
    dummy_position_ids,
    dummy_sliding_k,
    dummy_sliding_v,
    dummy_full_k,
    dummy_full_v,
)

# Smoke-test the wrapper before export
print("Smoke-testing wrapper ...")
with torch.no_grad():
    logits, proj = wrapper(*ARGS)
print(f"  logits shape:  {tuple(logits.shape)}")   # [1, 1, 262144]
print(f"  proj shape:    {tuple(proj.shape)}")      # [1, 1, 1536]

# ---------------------------------------------------------------------------
# ONNX export
# ---------------------------------------------------------------------------

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUT_PATH = OUTPUT_DIR / "drafter.onnx"

INPUT_NAMES  = ["inputs_embeds", "position_ids", "sliding_k", "sliding_v", "full_k", "full_v"]
OUTPUT_NAMES = ["logits", "projected_state"]
DYNAMIC_AXES = {
    "inputs_embeds":  {0: "batch", 1: "seq"},
    "position_ids":   {0: "batch", 1: "seq"},
    "sliding_k":      {0: "batch", 2: "kv_seq"},
    "sliding_v":      {0: "batch", 2: "kv_seq"},
    "full_k":         {0: "batch", 2: "kv_seq"},
    "full_v":         {0: "batch", 2: "kv_seq"},
    "logits":         {0: "batch", 1: "seq"},
    "projected_state":{0: "batch", 1: "seq"},
}

print(f"Exporting ONNX -> {OUT_PATH} ...")

# Strategy: JIT-trace then export with dynamo=False (legacy ONNX exporter).
#
# Why JIT trace + legacy exporter (not dynamo):
#   - torch.onnx.export() in torch 2.10 defaults to the dynamo exporter.
#   - Dynamo fails on: SDPA `is_causal: SymBool` (fixed by eager attn),
#     and RoPE `constant % dynamic_symbol` (ConversionError).
#   - torch.jit.trace runs an actual forward pass with fixed shapes, recording
#     all operations symbolically without the SymBool/mod issues.
#   - dynamo=False forces the legacy ONNX exporter which accepts JIT ScriptModules
#     and static dynamic_axes declarations.
#   - Attention mask patched to None (see above) to avoid masking_utils tracing bug.
print("  Step 1/2: JIT tracing ...")
with torch.no_grad():
    try:
        traced = torch.jit.trace(wrapper, ARGS, strict=False)
    except Exception as e:
        print(f"  JIT trace failed: {type(e).__name__}: {e}")
        raise

print("  Step 2/2: ONNX export (legacy exporter, dynamo=False) ...")
with torch.no_grad():
    torch.onnx.export(
        traced,
        ARGS,
        str(OUT_PATH),
        input_names=INPUT_NAMES,
        output_names=OUTPUT_NAMES,
        dynamic_axes=DYNAMIC_AXES,
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
print("  Export succeeded.")

# ---------------------------------------------------------------------------
# Write interface manifest
# ---------------------------------------------------------------------------

manifest = {
    "model_id": MODEL_ID,
    "export_dtype": args.dtype,
    "inputs": {
        "inputs_embeds":  {"shape": ["batch", "seq", DRAFTER_INPUTS_EMBEDS], "dtype": "float32",
                           "note": "cat([target_token_embedding, target_last_hidden_state], dim=-1)"},
        "position_ids":   {"shape": ["batch", "seq"], "dtype": "int64",
                           "note": "constant at last-seen-token position for all draft steps"},
        "sliding_k":      {"shape": ["batch", 1, "kv_seq", TARGET_SLIDING_HEAD_DIM], "dtype": "float32",
                           "note": "target's last sliding_attention layer K, shape matches target head_dim=256"},
        "sliding_v":      {"shape": ["batch", 1, "kv_seq", TARGET_SLIDING_HEAD_DIM], "dtype": "float32"},
        "full_k":         {"shape": ["batch", 1, "kv_seq", TARGET_FULL_HEAD_DIM], "dtype": "float32",
                           "note": "target's last full_attention layer K, shape matches target global_head_dim=512"},
        "full_v":         {"shape": ["batch", 1, "kv_seq", TARGET_FULL_HEAD_DIM], "dtype": "float32"},
    },
    "outputs": {
        "logits":         {"shape": ["batch", "seq", 262144], "dtype": "float32",
                           "note": "vocabulary logits; use argmax for greedy draft token"},
        "projected_state":{"shape": ["batch", "seq", TARGET_HIDDEN_SIZE], "dtype": "float32",
                           "note": "post_projection output; concat with next token embed as next draft step's inputs_embeds"},
    },
    "target_model": "google/gemma-4-E2B-it",
    "target_hidden_size": TARGET_HIDDEN_SIZE,
    "note": (
        "MTP spec-decode requires the TARGET ONNX to expose last_hidden_state and shared_kv_states. "
        "transformers.js 4.2.0 does not export these. File upstream issue: "
        "github.com/huggingface/transformers.js/issues"
    ),
}

MANIFEST_PATH = OUTPUT_DIR / "drafter-manifest.json"
MANIFEST_PATH.write_text(json.dumps(manifest, indent=2))
print(f"  Manifest -> {MANIFEST_PATH}")

size_mb = OUT_PATH.stat().st_size / 1_048_576
print(f"\nDone. drafter.onnx = {size_mb:.0f} MB")
print("Next step: upload to HF as onnx-community/gemma-4-E2B-it-assistant-ONNX")
print("           or host at /models/gemma-4-E2B-it-assistant/ via Vite public dir")
