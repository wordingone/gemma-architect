"""
Schultz Residence first-target probe — runs the Schultz eval prompt
through a v2 adapter and prints what the model produces, alongside the
hand-written gold answer for comparison.

Per Jun 2026-05-03: use Schultz as the first-target probe for compositional
generation. The standard inference_eval_v2.py uses max_new_tokens=300 which
truncates Schultz output (~1.3k chars / ~450 tokens). This wrapper bumps
to max_new_tokens=600.

Per Jun directive 2026-05-05: ADAPTER_DIR + GEMMA4_CHAT_TEMPLATE are required;
the legacy adapters were purged.

Inputs:
  ADAPTER_DIR (env, required)        → outputs/cad-lora-v3-{tag}/
  GEMMA4_CHAT_TEMPLATE (env, required) → e.g. 'gemma-4'

Output:
  outputs/cad-lora-v2-{tag}-schultz-eval.jsonl (single row)
  stdout: prompt + gold + pred side-by-side preview
"""

import json
import os
import re
import sys
from pathlib import Path

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")

import unsloth  # noqa: F401
from unsloth import FastModel
from unsloth.chat_templates import get_chat_template

REPO = Path(__file__).resolve().parents[1]

_adapter_env = os.environ.get("ADAPTER_DIR")
if not _adapter_env:
    print(
        "ADAPTER_DIR unset. Legacy LoRA adapters purged 2026-05-05 "
        "per Jun directive (hackathon eligibility drift). Set ADAPTER_DIR to a "
        "Gemma 4 LoRA adapter path before evaluating.",
        file=sys.stderr,
    )
    sys.exit(2)
ADAPTER = Path(_adapter_env)
SCHULTZ = REPO / "data/schultz-target.jsonl"

if not ADAPTER.exists():
    print(f"adapter not found: {ADAPTER}", file=sys.stderr)
    sys.exit(2)
if not SCHULTZ.exists():
    print(f"schultz target not found: {SCHULTZ}", file=sys.stderr)
    sys.exit(2)

TAG = ADAPTER.name.replace("cad-lora-v2-", "")
OUT = REPO / f"outputs/cad-lora-v2-{TAG}-schultz-eval.jsonl"

load_kwargs = {
    "model_name": str(ADAPTER),
    "max_seq_length": 2048,
    "load_in_4bit": True,
}

print(f"loading adapter {ADAPTER} ({TAG})...")
model, tokenizer = FastModel.from_pretrained(**load_kwargs)

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

row = json.loads(SCHULTZ.read_text(encoding="utf-8").strip())
msgs = row["messages"]
user_msg = next(m for m in msgs if m["role"] == "user")
gold = next(m for m in msgs if m["role"] == "assistant")["content"]
prompt_msgs = [m for m in msgs if m["role"] != "assistant"]
text = tokenizer.apply_chat_template(prompt_msgs, tokenize=False, add_generation_prompt=True)
inputs = tokenizer(text=text, return_tensors="pt").to(model.device)
out = model.generate(
    **inputs,
    max_new_tokens=600,
    temperature=0.2,
    top_p=0.95,
    do_sample=True,
)
gen = tokenizer.decode(out[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True).strip()
gen_clean = re.sub(r"^```(?:javascript|js)?\s*\n?", "", gen)
gen_clean = re.sub(r"\n?```\s*$", "", gen_clean)

# Lightweight static scoring (mirror inference_eval_v2 conventions).
TIER1_OPS = {
    "makeBox", "makeCylinder",
    "drawRectangle", "drawCircle", "drawLine", "drawPolyline",
    "sketchOnPlane", "extrude", "revolve",
    "fuse", "cut",
    "translate", "rotate",
}
LANG_KW = {"const", "let", "var", "function", "if", "for", "while", "return"}
called = set(re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(", gen_clean)) - LANG_KW
unknown = called - TIER1_OPS - {""}
const_count = len(re.findall(r"^\s*const\s+\w+\s*=", gen_clean, re.MULTILINE))

result = {
    "prompt": user_msg["content"],
    "gold": gold,
    "pred": gen_clean,
    "pred_chars": len(gen_clean),
    "pred_const_count": const_count,
    "gold_const_count": len(re.findall(r"^\s*const\s+\w+\s*=", gold, re.MULTILINE)),
    "api_clean": len(unknown) == 0,
    "unknown_calls": sorted(unknown),
    "has_extrude": ".extrude(" in gen_clean,
    "has_fuse": ".fuse(" in gen_clean,
    "has_cut": ".cut(" in gen_clean,
}

OUT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

print()
print("=" * 80)
print(f"PROMPT ({len(user_msg['content'])} chars):")
print(user_msg["content"][:200] + ("..." if len(user_msg["content"]) > 200 else ""))
print("-" * 80)
print(f"GOLD ({len(gold)} chars, {result['gold_const_count']} consts):")
print(gold[:600] + ("\n..." if len(gold) > 600 else ""))
print("-" * 80)
print(f"PRED ({len(gen_clean)} chars, {const_count} consts):")
print(gen_clean[:600] + ("\n..." if len(gen_clean) > 600 else ""))
print("=" * 80)
print(f"api_clean={result['api_clean']} extrude={result['has_extrude']} fuse={result['has_fuse']} cut={result['has_cut']} unknown={result['unknown_calls']}")
print(f"\nWrote {OUT}")
