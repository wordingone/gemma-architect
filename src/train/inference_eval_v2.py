"""
v2 LoRA evaluation — runs the held-out 40-row eval set through a v2 adapter,
scores each output on parse_ok + api_clean + has_extrude (static) AND runs
the JS through the Tier 1 execute() runtime gate via subprocess.

Per dataset/v2-spec.md §Acceptance: round-trip validation pass rate ≥ 90%
(combining synthetic + mined buckets).

Inputs:
  ADAPTER_DIR (env)          → outputs/cad-lora-v2-{tag}/
  EVAL_FILE (env, optional)  → data/eval_v2.jsonl (default)

Output:
  outputs/cad-lora-v2-{tag}-eval.jsonl (per-row results)
  outputs/cad-lora-v2-{tag}-summary.json (aggregate metrics)
"""

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")

import unsloth  # noqa: F401
from unsloth import FastModel
from unsloth.chat_templates import get_chat_template

REPO = Path(__file__).resolve().parents[2]

_adapter_env = os.environ.get("ADAPTER_DIR")
if not _adapter_env:
    print(
        "ADAPTER_DIR unset. Legacy LoRA adapters purged 2026-05-05 "
        "per project directive (hackathon eligibility drift). Set ADAPTER_DIR to a "
        "Gemma 4 LoRA adapter path before evaluating.",
        file=sys.stderr,
    )
    sys.exit(2)
ADAPTER = Path(_adapter_env)
EVAL = Path(os.environ.get("EVAL_FILE", REPO / "data/eval_v2.jsonl"))

if not ADAPTER.exists():
    print(f"adapter not found: {ADAPTER}", file=sys.stderr)
    sys.exit(2)

TAG = ADAPTER.name.replace("cad-lora-v2-", "")
OUT_PER_ROW = REPO / f"outputs/cad-lora-v2-{TAG}-eval.jsonl"
OUT_SUMMARY = REPO / f"outputs/cad-lora-v2-{TAG}-summary.json"

TIER1_OPS = {
    "makeBox", "makeCylinder",
    "drawRectangle", "drawCircle", "drawLine", "drawPolyline",
    "sketchOnPlane", "extrude", "revolve",
    "fuse", "cut",
    "translate", "rotate",
}
LANG_KW = {"const", "let", "var", "function", "if", "for", "while", "return"}


def score_static(text: str) -> dict:
    has_extrude = bool(re.search(r"\.extrude\(", text))
    has_revolve = bool(re.search(r"\.revolve\(", text))
    has_solid_op = has_extrude or has_revolve or "makeBox(" in text or "makeCylinder(" in text
    called = set(re.findall(r"\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(", text)) - LANG_KW
    unknown = called - TIER1_OPS - {""}
    api_clean = len(unknown) == 0
    parse_ok = any(p in text for p in ("drawRectangle", "drawCircle", "drawPolyline", "makeBox", "makeCylinder"))
    return {
        "parse_ok": parse_ok,
        "api_clean": api_clean,
        "has_extrude": has_extrude,
        "has_solid_op": has_solid_op,
        "unknown_calls": sorted(unknown),
    }


def _resolve_bun() -> list[str]:
    """Find an invokable bun on Windows. Order: bun.exe (POSIX), bun.cmd (nvm4w shim).
    Returns argv-prefix list."""
    import shutil
    for cand in ("bun.exe", "bun.cmd", "bun"):
        p = shutil.which(cand)
        if p:
            return [p]
    return ["C:/nvm4w/nodejs/bun.cmd"]  # last-resort hardcoded


_BUN = _resolve_bun()


def score_runtime(js: str) -> dict:
    """Round-trip the generated JS through validate-fixtures.ts (single-row mode)."""
    row = {"id": "eval", "prompt": "x", "sequence": js}
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, encoding="utf-8") as f:
        f.write(json.dumps(row) + "\n")
        tmp = f.name
    try:
        r = subprocess.run(
            [*_BUN, "scripts/validate-fixtures.ts", tmp],
            cwd=str(REPO),
            capture_output=True,
            text=True,
            timeout=60,
        )
        out = r.stdout + r.stderr
        passed = "ALL PASS" in out
        return {"runtime_pass": passed, "runtime_output": out[-400:] if not passed else ""}
    except Exception as e:
        return {"runtime_pass": False, "runtime_output": f"exec_error: {e}"}
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


print(f"loading adapter {ADAPTER} ...")
_load_kwargs = {
    "model_name": str(ADAPTER),
    "max_seq_length": 2048,
    "load_in_4bit": True,
}
# E2B's vision tower (TimmWrapperModel) doesn't support flex_attention
# under transformers 5.3.0.dev0 — same fix as lora_train_v2.py.
if "e2b" in TAG.lower():
    _load_kwargs["attn_implementation"] = "eager"
model, tokenizer = FastModel.from_pretrained(**_load_kwargs)
_chat_template = os.environ.get("GEMMA4_CHAT_TEMPLATE")
if not _chat_template:
    print(
        "GEMMA4_CHAT_TEMPLATE unset. Legacy chat template purged 2026-05-05 "
        "per project directive (hackathon eligibility drift). "
        "Set GEMMA4_CHAT_TEMPLATE to chosen Gemma 4 template before eval.",
        file=sys.stderr,
    )
    sys.exit(2)
tokenizer = get_chat_template(tokenizer, chat_template=_chat_template)
FastModel.for_inference(model)

results = []
with EVAL.open(encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        msgs = d["messages"]
        user_msg = next(m for m in msgs if m["role"] == "user")
        gold = next(m for m in msgs if m["role"] == "assistant")["content"]
        prompt_msgs = [m for m in msgs if m["role"] != "assistant"]
        text = tokenizer.apply_chat_template(prompt_msgs, tokenize=False, add_generation_prompt=True)
        inputs = tokenizer(text=text, return_tensors="pt").to(model.device)
        out = model.generate(
            **inputs,
            max_new_tokens=300,
            temperature=0.2,
            top_p=0.95,
            do_sample=True,
        )
        gen = tokenizer.decode(out[0][inputs.input_ids.shape[-1]:], skip_special_tokens=True).strip()
        # Strip code-fence wrappers if model emits ```javascript ... ```
        gen_clean = re.sub(r"^```(?:javascript|js)?\s*\n?", "", gen)
        gen_clean = re.sub(r"\n?```\s*$", "", gen_clean)
        s_static = score_static(gen_clean)
        s_runtime = score_runtime(gen_clean) if s_static["parse_ok"] and s_static["api_clean"] else {"runtime_pass": False, "runtime_output": "skipped: static fail"}
        row = {"prompt": user_msg["content"], "gold": gold, "pred": gen_clean, **s_static, **s_runtime}
        results.append(row)
        print(f"[{s_static['parse_ok']!s:5} api={s_static['api_clean']!s:5} rt={s_runtime['runtime_pass']!s:5}] {user_msg['content'][:65]}")

with OUT_PER_ROW.open("w", encoding="utf-8") as f:
    for r in results:
        f.write(json.dumps(r) + "\n")

n = len(results)
parse_ok = sum(r["parse_ok"] for r in results)
api_clean = sum(r["api_clean"] for r in results)
has_solid = sum(r["has_solid_op"] for r in results)
runtime_pass = sum(r["runtime_pass"] for r in results)
summary = {
    "adapter": str(ADAPTER),
    "n_eval": n,
    "parse_ok": parse_ok,
    "api_clean": api_clean,
    "has_solid_op": has_solid,
    "runtime_pass": runtime_pass,
    "round_trip_pct": (runtime_pass / n * 100) if n else 0,
}
with OUT_SUMMARY.open("w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2)

print(f"\n{TAG}: {parse_ok}/{n} parse_ok | {api_clean}/{n} api_clean | {has_solid}/{n} solid_op | {runtime_pass}/{n} round-trip ({summary['round_trip_pct']:.1f}%)")
