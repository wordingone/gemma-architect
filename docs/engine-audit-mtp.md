# Engine Audit: Transformers.js MTP / Speculative Decoding for Gemma 4

**Audited:** 2026-05-11  
**Issue:** #403  
**Auditor:** Eli

---

## Current State

| Item | Value |
|------|-------|
| Library | `@huggingface/transformers@4.2.0` (installed) / `^4.0.0` (package.json pin) |
| Model | `onnx-community/gemma-4-E2B-it-ONNX` |
| Entry point | `web/src/agent/agent-harness.ts:63` (`MODEL_ID`) |
| Upstream issue | #129 (`assistant_model` + `Gemma4AssistantForCausalLM` export blocker) |

---

## Changelog 4.2.0 → Latest

**Latest published:** `@huggingface/transformers@4.2.0` (no newer release as of 2026-05-11).

The v4 rewrite (released 2026-02-09) overhauled WebGPU inference and decoder architecture. Reviewed all v4.x release notes and GitHub issues for:

- `assistant_model` — **not mentioned in any release**
- speculative decoding / MTP / draft model — **not mentioned**
- `Gemma4AssistantForCausalLM` — **not present anywhere in the codebase or roadmap**

Speculative decoding with `assistant_model` is fully supported in Python `transformers` (≥4.45.0 dynamic speculation, ≥4.46.0 universal assisted generation). That support has **not been ported to transformers.js**.

---

## onnx-community Draft Model Check

Searched `onnx-community` HF org for:
- `Gemma4AssistantForCausalLM` — **not found**
- Any model containing "gemma-4" + "assistant" or "draft" — **not found**

Available at onnx-community for Gemma 4:
- `onnx-community/gemma-4-E2B-it-ONNX` (our current model)
- `onnx-community/gemma-4-E4B-it-ONNX` (candidate for #405)

Google has released PyTorch (SafeTensors) drafter checkpoints (`google/gemma-4-31B-it-assistant`, `google/gemma-4-26B-A4B-it-assistant`) but **no ONNX conversion exists** for these.

---

## Decision

**Upstream blocker remains.** Do not wire `assistant_model` now.

Two independent blockers must both clear before MTP is wireable in-browser:

1. **transformers.js must implement speculative decoding** — no PR, no milestone, no roadmap signal.
2. **onnx-community must publish a `Gemma4AssistantForCausalLM` ONNX checkpoint** — only SafeTensors drafter exists today.

Until both clear: implementing MTP would require (a) converting the PyTorch drafter to ONNX manually via `optimum-intel` and (b) duplicating the entire speculative-decode algorithm in the browser JS generate loop. The cost/benefit does not justify this.

**Recommended action:** Re-audit after the next transformers.js release (watch GitHub for `assistant_model` / speculative-decoding PRs). No code change needed now.

---

## Impact on #405 / #406

- **#405 (E4B swap test):** Independent of MTP. `MODEL_ID` swap from E2B → E4B is mechanical — audit does not block it.
- **#406 (2-3 parallel E2B agents):** Independent of MTP. Parallelism is about memory ceiling + coordination, not decode strategy.

Both can proceed without waiting for MTP.
