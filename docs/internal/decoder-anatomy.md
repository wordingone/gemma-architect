# Gemma 4 Decoder Anatomy — E2B + E4B

**Purpose:** Foundation for self-speculative early-exit decoding (#1860). Documents ONNX graph
topology, per-layer attention type, hidden-state tensor names at candidate exit positions, and
VRAM baseline. Required by Sub-2 (#1862, dual-output re-export) and Sub-3 (#1863, drafter loop).

**Source:** ONNX topology parse with `load_external_data=False` on both checkpoints.
KV layer counts cross-referenced with `web/src/agent/decoder-kv-shapes.json` (E4B).

---

## Architecture summary

Both checkpoints use **sparse attention**: only the first L blocks have attention (KV cache); the
remaining blocks are MLP-only (no KV, no attention). Full attention (global) alternates with sliding
window attention on a fixed schedule.

| Checkpoint | HF model ID | KV layers (L) | Total blocks | Full-attn blocks | Sliding blocks |
|---|---|---|---|---|---|
| E2B q4 | `onnx-community/gemma-4-E2B-it-ONNX` | 15 | 36 | 3 ([4, 9, 14]) | 12 |
| E4B q4 | `onnx-community/gemma-4-E4B-it-ONNX` | 24 | 43 | 4 ([5, 11, 17, 23]) | 20 |

ONNX file: `onnx/decoder_model_merged_q4.onnx` for both. KV heads: 1 (GQA).

---

## E2B — layer table (L = 15)

All KV dimensions: `[batch_size, 1, past_sequence_length, head_dim]`.

| KV idx | Block idx | Attention type | KV head_dim | Hidden-state tensor after this block |
|--------|-----------|----------------|-------------|--------------------------------------|
| 0 | 0 | SLIDING | 256 | `/model/layers.0/layer_scalar/Mul/output_0` |
| 1 | 1 | SLIDING | 256 | `/model/layers.1/layer_scalar/Mul/output_0` |
| 2 | 2 | SLIDING | 256 | `/model/layers.2/layer_scalar/Mul/output_0` |
| 3 | 3 | SLIDING | 256 | `/model/layers.3/layer_scalar/Mul/output_0` |
| 4 | 4 | **FULL** | 512 | `/model/layers.4/layer_scalar/Mul/output_0` |
| **5** | 5 | SLIDING | 256 | **`/model/layers.5/layer_scalar/Mul/output_0`** ← exit r=0.33 |
| 6 | 6 | SLIDING | 256 | `/model/layers.6/layer_scalar/Mul/output_0` |
| **7** | 7 | SLIDING | 256 | **`/model/layers.7/layer_scalar/Mul/output_0`** ← exit r=0.50 |
| 8 | 8 | SLIDING | 256 | `/model/layers.8/layer_scalar/Mul/output_0` |
| 9 | 9 | **FULL** | 512 | `/model/layers.9/layer_scalar/Mul/output_0` |
| **10** | 10 | SLIDING | 256 | **`/model/layers.10/layer_scalar/Mul/output_0`** ← exit r=0.67 |
| 11 | 11 | SLIDING | 256 | `/model/layers.11/layer_scalar/Mul/output_0` |
| 12 | 12 | SLIDING | 256 | `/model/layers.12/layer_scalar/Mul/output_0` |
| 13 | 13 | SLIDING | 256 | `/model/layers.13/layer_scalar/Mul/output_0` |
| 14 | 14 | **FULL** | 512 | `/model/layers.14/layer_scalar/Mul/output_0` |

Blocks 15–35: MLP-only (no KV, no attention). Not shown in KV cache inputs.

**Final norm → lm_head path (E2B):**
`/model/layers.35/final_norm_layernorm/output_0` → lm_head num_logits_to_keep/Slice →
lm_head/MatMul_Quant → softcap → `logits`

---

## E4B — layer table (L = 24)

All KV dimensions: `[batch_size, 1 (or 2), past_sequence_length, head_dim]`.
Source: `web/src/agent/decoder-kv-shapes.json` (KV type) + topology parse (tensors).

| KV idx | Block idx | Attention type | KV head_dim | Hidden-state tensor after this block |
|--------|-----------|----------------|-------------|--------------------------------------|
| 0 | 0 | SLIDING | 256 | `/model/layers.0/layer_scalar/Mul/output_0` |
| 1 | 1 | SLIDING | 256 | `/model/layers.1/layer_scalar/Mul/output_0` |
| 2 | 2 | SLIDING | 256 | `/model/layers.2/layer_scalar/Mul/output_0` |
| 3 | 3 | SLIDING | 256 | `/model/layers.3/layer_scalar/Mul/output_0` |
| 4 | 4 | SLIDING | 256 | `/model/layers.4/layer_scalar/Mul/output_0` |
| 5 | 5 | **FULL** | 512 | `/model/layers.5/layer_scalar/Mul/output_0` |
| 6 | 6 | SLIDING | 256 | `/model/layers.6/layer_scalar/Mul/output_0` |
| 7 | 7 | SLIDING | 256 | `/model/layers.7/layer_scalar/Mul/output_0` |
| **8** | 8 | SLIDING | 256 | **`/model/layers.8/layer_scalar/Mul/output_0`** ← exit r=0.33 |
| 9 | 9 | SLIDING | 256 | `/model/layers.9/layer_scalar/Mul/output_0` |
| 10 | 10 | SLIDING | 256 | `/model/layers.10/layer_scalar/Mul/output_0` |
| 11 | 11 | **FULL** | 512 | `/model/layers.11/layer_scalar/Mul/output_0` |
| **12** | 12 | SLIDING | 256 | **`/model/layers.12/layer_scalar/Mul/output_0`** ← exit r=0.50 |
| 13 | 13 | SLIDING | 256 | `/model/layers.13/layer_scalar/Mul/output_0` |
| 14 | 14 | SLIDING | 256 | `/model/layers.14/layer_scalar/Mul/output_0` |
| 15 | 15 | SLIDING | 256 | `/model/layers.15/layer_scalar/Mul/output_0` |
| 16 | 16 | SLIDING | 256 | `/model/layers.16/layer_scalar/Mul/output_0` |
| 17 | 17 | **FULL** | 512 | `/model/layers.17/layer_scalar/Mul/output_0` |
| 18 | 18 | SLIDING | 256 | `/model/layers.18/layer_scalar/Mul/output_0` |
| 19 | 19 | SLIDING | 256 | `/model/layers.19/layer_scalar/Mul/output_0` |
| 20 | 20 | SLIDING | 256 | `/model/layers.20/layer_scalar/Mul/output_0` |
| 21 | 21 | SLIDING | 256 | `/model/layers.21/layer_scalar/Mul/output_0` |
| 22 | 22 | SLIDING | 256 | `/model/layers.22/layer_scalar/Mul/output_0` |
| 23 | 23 | **FULL** | 512 | `/model/layers.23/layer_scalar/Mul/output_0` |

Blocks 24–42: MLP-only (no KV, no attention). Not shown in KV cache inputs.

**Final norm → lm_head path (E4B):**
`/model/layers.42/final_norm_layernorm/output_0` → lm_head num_logits_to_keep/Slice →
lm_head/MatMul_Quant → softcap → `logits`

---

## Candidate early-exit positions

Exit layer e is the last KV block whose hidden state is consumed by the early-exit lm_head.
Drafter runs blocks 0..e inclusive; verifier runs full 0..L-1. KV blocks e+1..L-1 are skipped
by the drafter (their KV slots are not written during draft inference — separate draft KV cache).

| Ratio r | E2B exit (KV e) | E2B hidden-state tensor | E4B exit (KV e) | E4B hidden-state tensor |
|---------|-----------------|-------------------------|-----------------|-------------------------|
| 1/3 | 5 | `/model/layers.5/layer_scalar/Mul/output_0` | 8 | `/model/layers.8/layer_scalar/Mul/output_0` |
| 1/2 | 7 | `/model/layers.7/layer_scalar/Mul/output_0` | 12 | `/model/layers.12/layer_scalar/Mul/output_0` |
| 2/3 | 10 | `/model/layers.10/layer_scalar/Mul/output_0` | 16 | `/model/layers.16/layer_scalar/Mul/output_0` |

These tensors are **not currently graph outputs**. Sub-2 (#1862) re-exports each checkpoint with
an additional `logits_early_exit` output node that attaches a lightweight lm_head (matmul only,
no softcap, optional bias) to the selected hidden-state tensor. Existing `logits` output unchanged.

**Sub-2 implementation note:** To add an output, ONNX graph editing (not full re-training) suffices:
1. Find the node producing `/model/layers.e/layer_scalar/Mul/output_0`.
2. Insert a new MatMul node: weights = shared `lm_head_MatMul_weight_quant` (same as existing).
3. Add the new MatMul output as a graph output named `logits_early_exit`.
4. Run `onnx.checker.check_model`. No new resident weights — lm_head weight is shared.

---

## VRAM baseline (two ORT sessions)

At decode time the app runs two ONNX Runtime Web sessions:

| Session | ONNX file | Resident size (approx) |
|---------|-----------|------------------------|
| `embed` | `encoder_model_q4.onnx` | ~110 MB (E2B) / ~170 MB (E4B) |
| `decoder` | `decoder_model_merged_q4.onnx` | ~620 MB (E2B) / ~1.1 GB (E4B) |

Source: `web/src/agent/model-consent.ts` size display + browser DevTools memory panel
(observed 2026-05-24, Pages cold-cache E4B session). KV cache size grows with sequence length;
figures above are model-weight resident only.

**Self-spec target:** resident size unchanged — early-exit head reuses existing lm_head weights.
KV cache doubles in slot count (draft KV + verifier KV) but draft KV is discarded after each
verify step, so peak resident ≈ baseline + one sliding-window-length draft KV slice.

---

## Notes for Sub-2 (dual-output re-export, #1862)

1. **Which ONNX to edit:** `onnx/decoder_model_merged_q4.onnx` for both E2B and E4B.
2. **Tool:** Python `onnx` package, graph editing only (`load_external_data=False` sufficient
   for topology; actual weights accessed from `.onnx_data` at runtime, unchanged).
3. **New output name:** `logits_early_exit` — shape `[batch_size, seq, 262144]`, same as `logits`.
4. **Default exit layer:** r=0.33 (E2B: KV 5, E4B: KV 8). Configurable via ONNX metadata field
   `exit_layer_kv_index` for future multi-exit experiments.
5. **Resident size delta target:** ≤ 5% (no new weight matrices; only graph topology change).

---

*Audit by Eli, 2026-05-24. Source: ONNX topology parse of both checkpoints (load_external_data=False).*
*Cross-ref: `web/src/agent/decoder-kv-shapes.json` (E4B KV types), `scripts/dump-decoder-kv-shapes.mjs`.*
