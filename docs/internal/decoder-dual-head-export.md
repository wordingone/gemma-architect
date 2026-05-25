# Decoder Dual-Head ONNX Export — Repro Recipe

**Issue:** #1862 (Sub-2 of #1860 self-speculative early-exit umbrella)  
**Script:** `scripts/export-decoder-dual-head.py`  
**Anatomy source:** `docs/internal/decoder-anatomy.md`

---

## What this does

Adds a `logits_early_exit` graph output to `decoder_model_merged_q4.onnx` for both
E2B and E4B checkpoints. No new weights — the early-exit lm_head node reuses the same
quantized weight initializers as the existing lm_head path.

Exit layer (r=0.33, default):
- E2B: KV index 5, tensor `/model/layers.5/layer_scalar/Mul/output_0`
- E4B: KV index 8, tensor `/model/layers.8/layer_scalar/Mul/output_0`

---

## Step 1 — Install dependencies

```bash
pip install onnx
```

---

## Step 2 — Download ONNX topology files

The topology `.onnx` file is the graph definition without weight values. Weight values
live in a separate `.onnx_data` file (not needed for this surgery).

```bash
# E2B (~50–150 MB topology file)
curl -L --create-dirs \
  -o web/public/models/onnx-community__gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4.onnx \
  'https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/decoder_model_merged_q4.onnx'

# E4B (~80–200 MB topology file)
curl -L --create-dirs \
  -o web/public/models/onnx-community__gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4.onnx \
  'https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/onnx/decoder_model_merged_q4.onnx'
```

---

## Step 3 — Inspect (optional)

Print lm_head node type, attribute names, and exit tensor info before committing to surgery:

```bash
python scripts/export-decoder-dual-head.py --inspect-only
```

Expected output shows:
- `lm_head node → op_type: MatMulNBits` (or `MatMul` if not quantized)
- `lm_head node → inputs: [activation, B_weight, b_scale, ...]`
- `Exit tensor: /model/layers.5/layer_scalar/Mul/output_0` (E2B)

If op_type is unexpected or exit tensor not found — check `decoder-anatomy.md` and
compare against the actual tensor names in this checkpoint version.

---

## Step 4 — Dry run

Validate the graph surgery without writing output:

```bash
python scripts/export-decoder-dual-head.py --dry-run
```

Both E2B and E4B should show `onnx.checker PASS`.

Note: checker may warn about external data not loaded — this is expected. The topology
change is valid even without weights; runtime errors would only surface at inference time.

---

## Step 5 — Run surgery

```bash
python scripts/export-decoder-dual-head.py
```

Outputs:
- `web/public/models/onnx-community__gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4-dual-head.onnx`
- `web/public/models/onnx-community__gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4-dual-head.onnx`
- `drafter-manifest.json` updated with SHA-256 + size for each

Size delta should be ≤ 5% (topology change only; weights unchanged).

---

## Step 6 — Verify regression test

```bash
bun run test web/test/decoder-dual-head.test.ts
```

Tests verify:
1. Modified ONNX has both `logits` and `logits_early_exit` outputs
2. `logits_early_exit` has shape `[batch, seq, 262144]`
3. Existing graph inputs unchanged

---

## Step 7 — Replace production files

Once verified, rename dual-head file to replace the baseline:

```bash
# E2B
mv web/public/models/onnx-community__gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4-dual-head.onnx \
   web/public/models/onnx-community__gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4.onnx

# E4B
mv web/public/models/onnx-community__gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4-dual-head.onnx \
   web/public/models/onnx-community__gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4.onnx
```

Commit the topology-only `.onnx` files. Weight `.onnx_data` files are NOT committed
(served from HuggingFace CDN). Verify git-tracked file sizes are reasonable (<500 MB).

---

## Design decisions

**No final_norm at exit layer.** The exit tensor (`/layer_scalar/Mul/output_0`) is
post-residual and post-layernorm — the layer's RMSNorm has already been applied. Adding
another final_norm would double-normalize and hurt draft quality.

**No softcap.** Draft tokens are selected by argmax on `logits_early_exit`. Softcap
(tanh-based) is monotone, so argmax is unchanged whether softcap is applied or not.
Omitting it avoids a tanh node and makes the early-exit head lighter.

**No Slice (num_logits_to_keep).** This Slice in the existing lm_head path selects
only the last-position logit for autoregressive decoding (S→1). During draft inference
S is always 1 (one token at a time), so the Slice is a no-op and is omitted.

**Weight sharing.** `lm_head_MatMul_weight_quant` (and associated scale/zero-point
initializers) are referenced by both the original lm_head node and the new early-exit
node. ONNX allows multiple nodes to reference the same initializer. No weight copying.

**exit_layer_kv_index in metadata.** The modified model stores `exit_layer_kv_index`
in ONNX metadata_props so the runtime (Sub-3 drafter loop) can read it without hardcoding.
For E2B r=0.33 this is `5`; for E4B r=0.33 this is `8`.

---

## Troubleshooting

**Exit tensor not found.** The ONNX file may be from a different checkpoint version.
Run `--inspect-only` and grep for `layer_scalar` to find the actual tensor name pattern.

**onnx.checker ValidationError on external data.** Expected — ONNX topology checker
requires weights to be loaded for full validation. Surgery itself is correct if the
node op_type, inputs, and output names are consistent.

**op_type not MatMulNBits.** If lm_head uses a different quantized op (e.g., QLinearMatMul),
the attribute names differ. Run `--inspect-only` to see attribute names and update
the surgery accordingly. The node-cloning approach in the script copies all attributes,
so it should handle any op_type that takes `[activation, weight, ...]` inputs.

**Size delta > 5%.** Unexpected — graph surgery adds ~1KB of node definitions. If the
output is significantly larger, the script may be re-serializing initializer data that
was external. Ensure `load_external_data=False` is working; check onnx package version.

---

*Script: `scripts/export-decoder-dual-head.py`. Anatomy: `docs/internal/decoder-anatomy.md`.*
