"""
serve_base.py — bare Gemma 4 E2B-it OpenAI-compat server for P8c baseline.

No LoRA adapter, no Unsloth. Plain HF transformers + FastAPI.
Use as the floor baseline (bare-gemma, K=0 expected) for the capability comparison.

Usage:
    python src/serve/serve_base.py
    # serves on http://localhost:8089/v1/chat/completions

Or override port:
    BASE_PORT=8089 python src/serve/serve_base.py

The endpoint accepts OpenAI /v1/chat/completions request shape.
Extra response fields: _latency_ms, _tps.
"""

import os
import sys
import time

MODEL_ID = os.environ.get(
    "BASE_MODEL_ID",
    os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/b324173c7d5721c2baba7f3b17b3b9b3d34ab1e9"),
)
HOST = os.environ.get("BASE_HOST", "127.0.0.1")
PORT = int(os.environ.get("BASE_PORT", "8089"))

import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any, Union
import uvicorn

print(f"[serve_base] loading {MODEL_ID}", flush=True)
t0 = time.time()

tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    device_map="cuda",
    torch_dtype=torch.bfloat16,
)
model.eval()
print(f"[serve_base] loaded in {time.time() - t0:.1f}s", flush=True)


class ChatMessage(BaseModel):
    role: str
    content: Union[str, list[Any]]


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
    return {"status": "ok", "model": MODEL_ID}


@app.get("/v1/models")
def list_models() -> dict:
    return {"object": "list", "data": [{"id": "gemma-4-e2b-it-base", "object": "model"}]}


@app.post("/v1/chat/completions")
def chat(req: ChatRequest) -> dict:
    if not req.messages:
        raise HTTPException(400, "messages required")
    messages = []
    for m in req.messages:
        content = m.content if isinstance(m.content, str) else " ".join(
            b.get("text", "") for b in m.content if isinstance(b, dict) and b.get("type") == "text"
        )
        messages.append({"role": m.role, "content": content})

    try:
        prompt_text = tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=True,
        )
        prompt_ids = tokenizer(prompt_text, return_tensors="pt").input_ids.to("cuda")
    except Exception as e:
        raise HTTPException(400, f"chat template failed: {e}")

    t0 = time.time()
    with torch.no_grad():
        out = model.generate(
            prompt_ids,
            max_new_tokens=req.max_tokens or 2048,
            temperature=req.temperature or 0.1,
            do_sample=(req.temperature or 0.1) > 0,
            use_cache=True,
        )
    elapsed = time.time() - t0
    prompt_len = prompt_ids.shape[-1]
    new_tokens = out[0, prompt_len:]
    text = tokenizer.decode(new_tokens, skip_special_tokens=True).strip()
    n_new = int(new_tokens.shape[0])

    return {
        "id": f"chatcmpl-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model or "gemma-4-e2b-it-base",
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
    }


if __name__ == "__main__":
    print(f"[serve_base] listening on http://{HOST}:{PORT}", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
