# Engine Audit: Gemma 4 E2B vs E4B In-Browser Benchmark

**Issue:** #405  
**Date:** 2026-05-11  
**Auditor:** Eli

---

## Swap mechanism

`agent-harness.ts` now exposes two named candidates and reads a URL parameter at module init:

```typescript
export const MODEL_ID_CANDIDATES = {
  e2b: "onnx-community/gemma-4-E2B-it-ONNX",
  e4b: "onnx-community/gemma-4-E4B-it-ONNX",
};
```

Switch at runtime by appending `?gemma_model=e4b` to the app URL. No rebuild required. E2B is default.

VRAM floor auto-scales: 2 GB for E2B, 4 GB for E4B. Badge text reflects the active model.

---

## Model specs

| Property | E2B | E4B |
|---|---|---|
| HF model ID | `onnx-community/gemma-4-E2B-it-ONNX` | `onnx-community/gemma-4-E4B-it-ONNX` |
| Effective params | 2.3B | 4.5B |
| Total params (with embeddings) | 5.1B | 8B |
| Context window | 128K | 128K |
| Modalities | text, image, audio | text, image, audio |
| WebGPU quantization | q4f16 | q4f16 |
| CPU fallback | q4 | q4 |
| VRAM floor (app-side gate) | 2 GB | 4 GB |

---

## Benchmark methodology

Five prompts, each run once per model variant. Metrics captured from `window.__telemetry` (ring buffer populated by `recordTurn()` in `telemetry.ts`) immediately after the send button re-enables.

**Prompts:**
1. `draw a wall from (0,0) to (5,0), 2.8m tall, 0.2m thick` — single dispatch
2. `create a room: 4 walls forming a 10m x 8m rectangle, each 3m tall, plus a flat roof slab` — 5-dispatch
3. `place a cylinder with 1m radius and 2m height, centered at 5,5,0` — single dispatch
4. `add a 20m x 15m floor slab at elevation 0, then export the scene as IFC` — 2-dispatch
5. `design a 3-story mixed-use building 18m wide 12m deep with 3.5m floor height` — 14-dispatch

**Captured metrics:**
- `prefill_ms` — prompt tokenization + KV prefill time
- `decode_ms` — generation time (all new tokens)
- `tokens_out` — generated token count
- `tg_tps` — generation throughput (tokens/s)
- `dispatch_count` — number of `<tool_call>` blocks emitted (correctness proxy)

---

## Benchmark results

### E2B (default)

**Model load:** `LIVE · GPU` (WebGPU q4f16, cached)

| Prompt | prefill_ms | decode_ms | tokens_out | tg_tps | dispatch_count |
|--------|-----------|-----------|-----------|--------|---------------|
| P1 — single wall | PENDING | PENDING | PENDING | PENDING | PENDING |
| P2 — 4-wall room | PENDING | PENDING | PENDING | PENDING | PENDING |
| P3 — cylinder | PENDING | PENDING | PENDING | PENDING | PENDING |
| P4 — slab + export | PENDING | PENDING | PENDING | PENDING | PENDING |
| P5 — 3-story building | PENDING | PENDING | PENDING | PENDING | PENDING |
| **Mean** | | | | | |

### E4B

**Model load:** PENDING

| Prompt | prefill_ms | decode_ms | tokens_out | tg_tps | dispatch_count |
|--------|-----------|-----------|-----------|--------|---------------|
| P1 — single wall | PENDING | PENDING | PENDING | PENDING | PENDING |
| P2 — 4-wall room | PENDING | PENDING | PENDING | PENDING | PENDING |
| P3 — cylinder | PENDING | PENDING | PENDING | PENDING | PENDING |
| P4 — slab + export | PENDING | PENDING | PENDING | PENDING | PENDING |
| P5 — 3-story building | PENDING | PENDING | PENDING | PENDING | PENDING |
| **Mean** | | | | | |

---

## Recommendation

PENDING — to be filled from benchmark results.

---

## Connection to roadmap

- **#406 (parallel agents):** depends on this result. If E4B OOMs on a single tab, multi-agent E4B is non-viable. If E4B fits, parallel E2B remains preferred for memory ceiling.
- **#407 (sketch→3D harness):** multimodal path — vision encoder is the same architecture; E4B's larger text decoder may improve sketch interpretation accuracy.
- **#403 (MTP audit):** MTP upstream blockers remain independent of E2B/E4B choice; recommendation is unchanged.
