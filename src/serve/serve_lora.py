"""
serve_lora.py — minimal OpenAI-compat /v1/chat/completions server backed by a
v2 LoRA adapter, with optional MTP speculative-decoding via a paired drafter.

Per Jun directive 2026-05-05: legacy bases were purged (hackathon eligibility
drift). This server is now base-model-agnostic — set
ADAPTER_DIR + GEMMA4_CHAT_TEMPLATE before running. The script fails loud if
either is unset.

Usage:
    set ADAPTER_DIR=outputs/cad-lora-v3-<tag>
    set GEMMA4_CHAT_TEMPLATE=gemma-4
    python src/serve/serve_lora.py
    # serves on http://localhost:8088/v1/chat/completions

MTP (speculative decoding) — Prong A of issue #99:
    set USE_MTP=1
    # optionally override: set DRAFTER_MODEL_ID=google/gemma-4-E2B-it-assistant
    # drafter is loaded after the target model; target must be Gemma 4 E2B-it family

Frontend:
    window.__loraUrl = "http://localhost:8088/v1/chat/completions";
    // or set VITE_LORA_URL=http://localhost:8088/v1/chat/completions at build
    // or set VITE_GEMMA_AGENT_URL=http://localhost:8088 for the agent harness

The endpoint accepts the OpenAI /v1/chat/completions request shape and returns
the OpenAI response shape plus two extra fields:
    _latency_ms  — wall-clock generation time in milliseconds
    _tps         — tokens per second (completion tokens / latency)
    _mtp_enabled — true when speculative decoding was used

CORS is wide open since the demo runs on a different localhost port.
Adapter is loaded once at startup (~30s on a 4090).
"""

import os
import sys
import time
from pathlib import Path

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")

import torch
import unsloth  # noqa: F401  — must import before transformers

from unsloth import FastModel
from unsloth.chat_templates import get_chat_template
from transformers import AutoModelForCausalLM

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

REPO = Path(__file__).resolve().parents[2]

_adapter_env = os.environ.get("ADAPTER_DIR")
if not _adapter_env:
    print(
        "ADAPTER_DIR unset. Legacy LoRA adapters purged 2026-05-05 "
        "per Jun directive (hackathon eligibility drift). Set ADAPTER_DIR to a "
        "Gemma 4 LoRA adapter path before serving.",
        file=sys.stderr,
    )
    sys.exit(2)
ADAPTER = Path(_adapter_env)
HOST = os.environ.get("LORA_HOST", "127.0.0.1")
PORT = int(os.environ.get("LORA_PORT", "8088"))

if not ADAPTER.exists():
    print(f"adapter not found: {ADAPTER}", file=sys.stderr)
    sys.exit(2)

USE_MTP = os.environ.get("USE_MTP", "0").strip() == "1"
DRAFTER_MODEL_ID = os.environ.get("DRAFTER_MODEL_ID", "google/gemma-4-E2B-it-assistant")

print(f"[serve_lora] loading adapter from {ADAPTER}", flush=True)
t0 = time.time()
model, tokenizer = FastModel.from_pretrained(
    model_name=str(ADAPTER),
    max_seq_length=4096,
    load_in_4bit=True,
)

_chat_template = os.environ.get("GEMMA4_CHAT_TEMPLATE")
if not _chat_template:
    print(
        "GEMMA4_CHAT_TEMPLATE unset. Set to the Unsloth chat template name "
        "matching the chosen Gemma 4 base (e.g. 'gemma-4').",
        file=sys.stderr,
    )
    sys.exit(2)
tokenizer = get_chat_template(tokenizer, chat_template=_chat_template)
FastModel.for_inference(model)
print(f"[serve_lora] loaded in {time.time() - t0:.1f}s", flush=True)

_drafter = None
_vocab_mismatch = False
if USE_MTP:
    print(f"[serve_lora] MTP enabled — loading drafter {DRAFTER_MODEL_ID}", flush=True)
    t1 = time.time()
    try:
        _drafter = AutoModelForCausalLM.from_pretrained(
            DRAFTER_MODEL_ID,
            device_map="cuda",
            torch_dtype=torch.bfloat16,
        )
        print(f"[serve_lora] drafter loaded in {time.time() - t1:.1f}s", flush=True)
        # Vocab mismatch between drafter and target produces garbled speculative output.
        # Disable MTP instead of silently corrupting results.
        target_vocab = getattr(model.config, "vocab_size", None)
        drafter_vocab = getattr(_drafter.config, "vocab_size", None)
        if target_vocab is not None and drafter_vocab is not None and drafter_vocab != target_vocab:
            print(
                f"[serve_lora] WARNING: drafter vocab {drafter_vocab} != target vocab {target_vocab}; "
                "disabling MTP to prevent garbled output",
                file=sys.stderr,
                flush=True,
            )
            _drafter = None
            _vocab_mismatch = True
    except Exception as exc:
        print(
            f"[serve_lora] WARNING: drafter load failed ({exc}); running without MTP",
            file=sys.stderr,
            flush=True,
        )
        _drafter = None


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int | None = 2048
    temperature: float | None = 0.1


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "adapter": str(ADAPTER),
        "mtp_enabled": _drafter is not None,
        "vocab_mismatch": _vocab_mismatch,
    }


@app.post("/v1/chat/completions")
def chat(req: ChatRequest) -> dict:
    if not req.messages:
        raise HTTPException(400, "messages required")
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    try:
        prompt_ids = tokenizer.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_tensors="pt",
        ).to("cuda")
    except Exception as e:
        raise HTTPException(400, f"chat template failed: {e}")

    generate_kwargs: dict = dict(
        input_ids=prompt_ids,
        max_new_tokens=req.max_tokens or 2048,
        temperature=req.temperature or 0.1,
        do_sample=(req.temperature or 0.1) > 0,
        use_cache=True,
    )
    if _drafter is not None:
        generate_kwargs["assistant_model"] = _drafter
        generate_kwargs["num_assistant_tokens_schedule"] = "heuristic"

    t0 = time.time()
    out = model.generate(**generate_kwargs)
    elapsed = time.time() - t0
    new_tokens = out[0, prompt_ids.shape[-1]:]
    text = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    n_new = int(new_tokens.shape[0])

    return {
        "id": f"chatcmpl-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model or "cad-lora-v2",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": int(prompt_ids.shape[-1]),
            "completion_tokens": n_new,
            "total_tokens": int(prompt_ids.shape[-1]) + n_new,
        },
        "_latency_ms": int(elapsed * 1000),
        "_tps": round(n_new / elapsed, 1) if elapsed > 0 else None,
        "_mtp_enabled": _drafter is not None,
    }


if __name__ == "__main__":
    print(f"[serve_lora] listening on http://{HOST}:{PORT}", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
