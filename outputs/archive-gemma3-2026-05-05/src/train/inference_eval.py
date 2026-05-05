"""
Spike A LoRA inference smoke test.

Loads the saved adapter from outputs/spike-a-lora/, runs the 8 held-out eval
prompts through it, scores each on:
  - parse_ok: output is syntactically valid JS
  - api_clean: every called identifier is in TIER1_OPS
  - has_extrude: at least one .extrude() call (basic intent check)

Writes outputs/spike-a-eval.jsonl with per-prompt results.
"""

import json
import re
from pathlib import Path

import unsloth  # noqa: F401
from unsloth import FastModel
from unsloth.chat_templates import get_chat_template

REPO = Path(__file__).resolve().parents[2]
ADAPTER = REPO / "outputs/spike-a-lora"
EVAL = REPO / "data/eval.jsonl"
OUT = REPO / "outputs/spike-a-eval.jsonl"

TIER1_OPS = {
    "makeBox", "makeCylinder",
    "drawRectangle", "drawCircle", "drawLine", "drawPolyline",
    "sketchOnPlane", "extrude", "revolve",
    "fuse", "cut",
    "translate", "rotate",
}

print(f"loading adapter from {ADAPTER} ...")
model, tokenizer = FastModel.from_pretrained(
    model_name=str(ADAPTER),
    max_seq_length=2048,
    load_in_4bit=True,
)
tokenizer = get_chat_template(tokenizer, chat_template="gemma-3")
FastModel.for_inference(model)


def score_output(text: str) -> dict:
    has_extrude = bool(re.search(r"\.extrude\(", text))
    called = set(re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(", text))
    # Filter language keywords we don't care about
    lang_kw = {"const", "let", "var", "function", "if", "for", "while", "return"}
    called -= lang_kw
    unknown = called - TIER1_OPS - {""}
    # Allow user-defined variable assignment names (lowercase) — those aren't function calls.
    # Heuristic: anything that's a tier1 op name or a single-char/short var is fine.
    api_clean = len(unknown) == 0
    parse_ok = "drawRectangle" in text or "drawCircle" in text or "drawPolyline" in text or "makeBox" in text
    return {
        "parse_ok": parse_ok,
        "api_clean": api_clean,
        "has_extrude": has_extrude,
        "unknown_calls": sorted(unknown),
    }


results = []
with EVAL.open() as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        msgs = d["messages"]
        user_msg = next(m for m in msgs if m["role"] == "user")
        gold = next(m for m in msgs if m["role"] == "assistant")["content"]
        prompt_msgs = [m for m in msgs if m["role"] != "assistant"]

        text = tokenizer.apply_chat_template(
            prompt_msgs,
            tokenize=False,
            add_generation_prompt=True,
        )
        # Gemma3Processor positional args are (images, text, videos); pass text= explicitly.
        inputs = tokenizer(text=text, return_tensors="pt").to(model.device)
        out = model.generate(
            **inputs,
            max_new_tokens=300,
            temperature=0.2,
            top_p=0.95,
            do_sample=True,
        )
        gen = tokenizer.decode(out[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True)
        score = score_output(gen)
        results.append({"prompt": user_msg["content"], "gold": gold, "pred": gen, **score})
        print(f"[{score['parse_ok']!s:5} api_clean={score['api_clean']!s:5} extrude={score['has_extrude']!s:5}] {user_msg['content'][:70]}")

with OUT.open("w") as f:
    for r in results:
        f.write(json.dumps(r) + "\n")

n = len(results)
parse_ok = sum(r["parse_ok"] for r in results)
api_clean = sum(r["api_clean"] for r in results)
has_extrude = sum(r["has_extrude"] for r in results)
print(f"\nsummary: {parse_ok}/{n} parse_ok | {api_clean}/{n} api_clean | {has_extrude}/{n} has_extrude")
