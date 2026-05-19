"""
serve_mtp.py — Gemma 4 E2B-it + MTP drafter, no LoRA, no Unsloth.

Wire #674 AC2: local Python server running target.generate(assistant_model=drafter)
and returning _mtp_enabled: true in every response.

Requires transformers ≥ 5.7.0.dev0 (gemma4_assistant architecture registered).
Both models must be cached locally.

Usage:
    python src/serve/serve_mtp.py
    # serves on http://localhost:8088/v1/chat/completions

Override:
    MTP_PORT=8088 MTP_HOST=127.0.0.1 python src/serve/serve_mtp.py
    MTP_TARGET_MODEL=<path>     — override target model path/id
    MTP_DRAFTER_MODEL=<path>    — override drafter model path/id

Extra response fields:
    _mtp_enabled    — always true when both models loaded; false on drafter load failure
    _spec_accept_rate — fraction of drafter tokens accepted (requires transformers ≥ 5.8)
    _latency_ms     — wall-clock generation time in ms
    _tps            — completion tokens / latency
"""

import os
import sys
import time
from typing import Any, Union

TARGET_MODEL_ID = os.environ.get(
    "MTP_TARGET_MODEL",
    os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/b324173c7d5721c2baba7f3b17b3b9b3d34ab1e9"),
)
DRAFTER_MODEL_ID = os.environ.get(
    "MTP_DRAFTER_MODEL",
    os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it-assistant/snapshots/5810c41a67974da9c7bd6f3e6c69d5d13854d9f0"),
)
HOST = os.environ.get("MTP_HOST", "127.0.0.1")
PORT = int(os.environ.get("MTP_PORT", "8088"))

import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

# ── Load target ──────────────────────────────────────────────────────────────

print(f"[serve_mtp] loading target {TARGET_MODEL_ID}", flush=True)
t0 = time.time()
tokenizer = AutoTokenizer.from_pretrained(TARGET_MODEL_ID)
target = AutoModelForCausalLM.from_pretrained(
    TARGET_MODEL_ID,
    device_map="cuda",
    torch_dtype=torch.bfloat16,
)
target.eval()
print(f"[serve_mtp] target loaded in {time.time() - t0:.1f}s", flush=True)

# ── Load drafter ─────────────────────────────────────────────────────────────

drafter = None
_vocab_mismatch = False
print(f"[serve_mtp] loading drafter {DRAFTER_MODEL_ID}", flush=True)
t1 = time.time()
try:
    drafter = AutoModelForCausalLM.from_pretrained(
        DRAFTER_MODEL_ID,
        device_map="cuda",
        torch_dtype=torch.bfloat16,
    )
    drafter.eval()
    print(f"[serve_mtp] drafter loaded in {time.time() - t1:.1f}s", flush=True)

    target_vocab = getattr(target.config, "vocab_size", None)
    drafter_vocab = getattr(drafter.config, "vocab_size", None)
    if target_vocab and drafter_vocab and drafter_vocab != target_vocab:
        print(
            f"[serve_mtp] WARNING: drafter vocab {drafter_vocab} != target vocab {target_vocab}; "
            "disabling MTP to prevent garbled output",
            file=sys.stderr,
            flush=True,
        )
        drafter = None
        _vocab_mismatch = True
except Exception as exc:
    print(
        f"[serve_mtp] WARNING: drafter load failed ({exc}); serving without MTP",
        file=sys.stderr,
        flush=True,
    )
    drafter = None

_mtp_available = drafter is not None
print(f"[serve_mtp] MTP {'ENABLED' if _mtp_available else 'DISABLED'}", flush=True)


# ── Schema ───────────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    role: str
    content: Union[str, list[Any]]


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int | None = 2048
    temperature: float | None = 0.1


# ── App ──────────────────────────────────────────────────────────────────────

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
        "target": TARGET_MODEL_ID,
        "drafter": DRAFTER_MODEL_ID,
        "mtp_enabled": _mtp_available,
        "vocab_mismatch": _vocab_mismatch,
    }


@app.get("/v1/models")
def list_models() -> dict:
    return {
        "object": "list",
        "data": [{"id": "gemma-4-e2b-it-mtp", "object": "model"}],
    }


@app.post("/v1/chat/completions")
def chat(req: ChatRequest) -> dict:
    if not req.messages:
        raise HTTPException(400, "messages required")

    messages = []
    for m in req.messages:
        if isinstance(m.content, str):
            text = m.content
        else:
            text = " ".join(
                b.get("text", "")
                for b in m.content
                if isinstance(b, dict) and b.get("type") == "text"
            )
        messages.append({"role": m.role, "content": text})

    try:
        prompt_text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_ids = tokenizer(prompt_text, return_tensors="pt").input_ids.to("cuda")
    except Exception as e:
        raise HTTPException(400, f"chat template failed: {e}")

    generate_kwargs: dict = dict(
        input_ids=prompt_ids,
        max_new_tokens=req.max_tokens or 2048,
        temperature=req.temperature or 0.1,
        do_sample=(req.temperature or 0.1) > 0,
        use_cache=True,
    )
    if drafter is not None:
        generate_kwargs["assistant_model"] = drafter
        generate_kwargs["num_assistant_tokens_schedule"] = "heuristic"

    t0 = time.time()
    with torch.no_grad():
        out = target.generate(**generate_kwargs)
    elapsed = time.time() - t0

    prompt_len = prompt_ids.shape[-1]
    new_tokens = out[0, prompt_len:]
    text = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    n_new = int(new_tokens.shape[0])

    # spec_accept_rate: transformers ≥ 5.8 returns GenerateOutput with drafter_stats.
    # Graceful fallback to None when the field isn't present yet.
    spec_accept_rate: float | None = None
    if drafter is not None:
        try:
            stats = getattr(out, "drafter_stats", None)
            if stats is not None and hasattr(stats, "acceptance_rate"):
                spec_accept_rate = float(stats.acceptance_rate)
        except Exception:
            pass

    return {
        "id": f"chatcmpl-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model or "gemma-4-e2b-it-mtp",
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": int(prompt_len),
            "completion_tokens": n_new,
            "total_tokens": int(prompt_len) + n_new,
        },
        "_latency_ms": int(elapsed * 1000),
        "_tps": round(n_new / elapsed, 1) if elapsed > 0 else None,
        "_mtp_enabled": _mtp_available,
        "_spec_accept_rate": spec_accept_rate,
    }


if __name__ == "__main__":
    print(f"[serve_mtp] listening on http://{HOST}:{PORT}", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
