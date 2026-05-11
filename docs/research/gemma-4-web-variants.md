# Gemma 4 Web Variants — E2B / E4B Device-Class Feasibility

**Issue:** #490  
**Date:** 2026-05-11  
**Author:** Eli

---

## TL;DR

| Variant | ONNX exists | transformers.js | Desktop | Laptop | Mobile/Tablet |
|---------|-------------|-----------------|---------|--------|---------------|
| E2B q4f16 | ✅ | ✅ `Gemma4ForConditionalGeneration` | ✅ viable | ✅ viable (M-series confirmed) | ⚠️ risky (quota + WebGPU patchy) |
| E4B q4f16 | ✅ | ✅ same class | ⚠️ marginal (4+ GB VRAM) | ❌ unlikely | ❌ no |

**Recommended path:** E2B q4f16 on WebGPU for desktop/laptop. Remote inference fallback for mobile/tablet.

---

## Model availability

### `onnx-community/gemma-4-E2B-it-ONNX`

- **Parameters:** 2.3B effective (5.1B with embeddings)
- **Quantizations:** q4f16, q8, fp16 (per ONNX file structure: `audio_encoder_q4.onnx`, `vision_encoder_q4.onnx`, `embed_tokens_q4.onnx`, `decoder_model_merged_q4.onnx`)
- **HF Hub status:** Exists, maintained by onnx-community, updated with Gemma 4 launch
- **Approximate download size:** ~1.5 GB at q4f16 (decoder dominant; vision + audio encoders add ~200-400 MB)

### `onnx-community/gemma-4-E4B-it-ONNX`

- **Parameters:** 4.5B effective (8B with embeddings)
- **Quantizations:** q4f16, q8, fp16 (same structure as E2B)
- **HF Hub status:** Exists
- **Approximate download size:** ~3.5-4 GB at q4f16 — exceeds practical browser limits for most hardware

---

## transformers.js compatibility

Both variants use:

```javascript
import { Gemma4ForConditionalGeneration, AutoProcessor } from "@huggingface/transformers";

const processor = await AutoProcessor.from_pretrained("onnx-community/gemma-4-E2B-it-ONNX");
const model = await Gemma4ForConditionalGeneration.from_pretrained(
  "onnx-community/gemma-4-E2B-it-ONNX",
  { dtype: "q4f16", device: "webgpu" }
);
```

**Pipeline task name:** `any-to-any` (not `text-generation`).  
This is the source of the PR #46 `@ts-ignore` runtime mismatch — the pipeline string must be `any-to-any`, not the causal-LM string.

**Status:** Gemma 4 had day-one HF support for transformers.js (April 2026 launch announcement). The Chrome extension `nico-martin/gemma4-browser-extension` ships to production using this exact class + model ID.

---

## fp16 / q4f16 overflow risk

An ONNX Runtime issue (#26732) documented `fp16` and `q4f16` producing invalid outputs on WebGPU for **Gemma 3** due to activation overflow (`inf` in float16). The issue is **closed** (December 2025). Gemma 4 E2B production deployments use q4f16 without reported overflow, suggesting the fix landed before Gemma 4's release or Gemma 4's architecture avoids the Gemma 3 activation pattern.

**Mitigation:** Use q4f16 (not fp16). If output quality degrades, fall back to q8 (larger download, slower, but no overflow risk).

---

## WebGPU vs WASM

| | WebGPU | WASM |
|---|---|---|
| Throughput | 40–180 tokens/sec (GPU-dependent) | ~1-3 tokens/sec for 2B+ models |
| Browser support | Chrome 113+, Firefox Nightly, Edge 113+ | All browsers |
| Mobile | Patchy (Safari partial, Chrome Android varies) | Works but unusably slow |

**Conclusion:** WASM is a non-starter for interactive use at E2B scale. WebGPU is required.

---

## Browser memory budgets

| Device class | Typical VRAM / shared memory | E2B q4f16 (~1.5 GB) | E4B q4f16 (~3.5 GB) |
|---|---|---|---|
| Desktop (dedicated GPU) | 4–16 GB | ✅ | ⚠️ (needs 4+ GB free) |
| Laptop (M-series Apple) | Unified 8–36 GB | ✅ (M4 benchmarked) | ⚠️ (8 GB unified tight) |
| Laptop (integrated Intel/AMD) | 512 MB – 2 GB | ⚠️ (allocation may fail) | ❌ |
| Mobile / tablet | 512 MB – 2 GB accessible | ❌ (VRAM + quota) | ❌ |

---

## IndexedDB model caching

transformers.js caches weights in IndexedDB by default (`env.useBrowserCache = true`). Subsequent page loads skip the 1.5 GB download.

**Quota constraints:**

| Browser | Quota behavior |
|---|---|
| Chrome | % of available disk — generally fine for 1.5 GB |
| Firefox | min(10% of disk, 10 GiB) — fine |
| Safari | ~1 GB per origin (Safari 17) — **E2B at 1.5 GB exceeds this** |

**Required implementation:** Wrap all cache writes in `try/catch QuotaExceededError` and fall back to streaming from HF Hub on every visit. Safari users will re-download on each visit.

---

## Per-device-class recommendation

### Desktop / high-end laptop (dedicated GPU ≥ 4 GB, or Apple M-series)

**Use E2B q4f16 on WebGPU.** 40–180 tps on Chrome 113+. IndexedDB cache works on Chrome/Firefox. Accept re-download on Safari.

### Mid-range laptop (integrated GPU, < 4 GB)

**E2B q4f16 may fail allocation.** Attempt load, catch `OOM`, fall back to remote inference (llama-server endpoint). Do not attempt E4B.

### Mobile / tablet

**Do not attempt in-browser inference.** WebGPU support is patchy, Safari quota blocks caching, thermal limits cause throttling. **Fallback: remote inference endpoint** (existing llama-server path at `REMOTE_URL`). Present a "Connecting to cloud inference…" state rather than attempting model load.

---

## Constraints for issue #46 / #48-C

1. **Pipeline string must be `any-to-any`** — not `text-generation`. Fix the `@ts-ignore` in PR #46 with an explicit `Pipeline<"any-to-any">` type cast.
2. **Class: `Gemma4ForConditionalGeneration`** — not `AutoModelForCausalLM`.
3. **dtype: `q4f16`** for best memory/performance balance. Add `q8` fallback if WebGPU overflow detected at runtime.
4. **device: `webgpu`** — WASM must not be used for E2B/E4B at interactive speed.
5. **Quota guard:** `try/catch QuotaExceededError` around cache writes; streaming fallback. Log quota failures to telemetry.
6. **Device-class detection:** Attempt `navigator.gpu.requestAdapter()` before model load; if null → skip to remote inference path immediately.
7. **First-visit UX:** 1.5 GB download. Progress indicator required. Cache status in badge (DOWNLOADING → PRIMING → READY).

---

## References

- [onnx-community/gemma-4-E2B-it-ONNX](https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX)
- [onnx-community/gemma-4-E4B-it-ONNX](https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX)
- [HF blog: Welcome Gemma 4 (launch, transformers.js day-one)](https://huggingface.co/blog/gemma4)
- [nico-martin/gemma4-browser-extension (production E2B WebGPU)](https://github.com/nico-martin/gemma4-browser-extension)
- [ONNX Runtime issue #26732 (fp16 overflow, Gemma 3, closed)](https://github.com/microsoft/onnxruntime/issues/26732)
- [transformers.js issue #1636 (multimodal completeness)](https://github.com/huggingface/transformers.js/issues/1636)
- [MDN: Storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- `docs/engine-audit-e2b-vs-e4b.md` — prior engine audit (pre-launch, now superseded by this report)
