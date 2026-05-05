"""
v2 LoRA training — base-model-agnostic Unsloth QLoRA scaffold.

Per Jun directive 2026-05-05: legacy MODEL_VARIANTS entries were purged
(hackathon eligibility drift). MODEL_VARIANTS is empty until a
Gemma 4 base is selected — set GEMMA4_BASE_MODEL + GEMMA4_BASE_TAG +
GEMMA4_CHAT_TEMPLATE before running, or extend MODEL_VARIANTS with the chosen
Gemma 4 base.

Inputs:  data/train_v2.jsonl, data/eval_v2.jsonl
Output:  outputs/cad-lora-v2-{tag}/

Usage:
  set GEMMA4_BASE_MODEL=unsloth/gemma-4-<variant>
  set GEMMA4_BASE_TAG=<tag>
  set GEMMA4_CHAT_TEMPLATE=gemma-4
  python src/train/lora_train_v2.py
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")
os.environ.setdefault("CC", "C:/Users/Admin/bin/gcc.exe")

import unsloth  # noqa: F401
from unsloth import FastModel
from unsloth.chat_templates import get_chat_template, train_on_responses_only

from datasets import load_dataset
from trl import SFTTrainer, SFTConfig

REPO = Path(__file__).resolve().parents[2]
TRAIN = REPO / "data/train_v2.jsonl"
EVAL = REPO / "data/eval_v2.jsonl"

# MODEL_VARIANTS purged 2026-05-05. Add Gemma 4 entries here when the base
# is selected; until then, GEMMA4_BASE_MODEL + GEMMA4_BASE_TAG env vars
# bypass the dict for one-off runs.
MODEL_VARIANTS: dict[str, tuple[str, str]] = {}

variant_key = os.environ.get("GEMMA_V2_MODEL", "").lower()
if variant_key in MODEL_VARIANTS:
    MODEL_NAME, TAG = MODEL_VARIANTS[variant_key]
else:
    MODEL_NAME = os.environ.get("GEMMA4_BASE_MODEL", "")
    TAG = os.environ.get("GEMMA4_BASE_TAG", "")
    if not MODEL_NAME or not TAG:
        print(
            "No model selected. Legacy bases purged 2026-05-05 per Jun "
            "directive (hackathon eligibility drift). Either:\n"
            "  - set GEMMA_V2_MODEL to a key in MODEL_VARIANTS (currently empty), or\n"
            "  - set GEMMA4_BASE_MODEL and GEMMA4_BASE_TAG.",
            file=sys.stderr,
        )
        sys.exit(2)

OUTPUT_DIR = REPO / f"outputs/cad-lora-v2-{TAG}"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
MAX_SEQ = 2048

print(f"variant={variant_key or '<env>'} model={MODEL_NAME} → {OUTPUT_DIR}")

print(f"loading {MODEL_NAME} ...")
_load_kwargs = {
    "model_name": MODEL_NAME,
    "max_seq_length": MAX_SEQ,
    "load_in_4bit": True,
    "full_finetuning": False,
}
# Per-base kwargs (e.g., attn_implementation overrides for vision-tower
# variants) belong here when re-introducing variants. Empty until a Gemma 4
# base is selected.
model, tokenizer = FastModel.from_pretrained(**_load_kwargs)

model = FastModel.get_peft_model(
    model,
    finetune_vision_layers=False,
    finetune_language_layers=True,
    finetune_attention_modules=True,
    finetune_mlp_modules=True,
    r=16,
    lora_alpha=16,
    lora_dropout=0,
    bias="none",
    random_state=42,
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


def to_text(example):
    text = tokenizer.apply_chat_template(
        example["messages"],
        tokenize=False,
        add_generation_prompt=False,
    )
    return {"text": text}


train_ds = load_dataset("json", data_files=str(TRAIN), split="train").map(to_text)
eval_ds = load_dataset("json", data_files=str(EVAL), split="train").map(to_text)
print(f"train rows: {len(train_ds)}  eval rows: {len(eval_ds)}")

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    args=SFTConfig(
        dataset_text_field="text",
        max_seq_length=MAX_SEQ,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        warmup_steps=5,
        num_train_epochs=3,
        learning_rate=2e-4,
        fp16=False,
        bf16=True,
        logging_steps=5,
        optim="adamw_8bit",
        weight_decay=0.01,
        lr_scheduler_type="linear",
        seed=42,
        output_dir=str(OUTPUT_DIR / "checkpoints"),
        report_to="none",
        eval_strategy="epoch",
        save_strategy="epoch",
        save_total_limit=1,
    ),
)

trainer = train_on_responses_only(
    trainer,
    instruction_part="<start_of_turn>user\n",
    response_part="<start_of_turn>model\n",
)

print("starting training ...")
stats = trainer.train()
print(f"final train loss: {stats.training_loss:.4f}")

print(f"saving adapter to {OUTPUT_DIR}")
model.save_pretrained(str(OUTPUT_DIR))
tokenizer.save_pretrained(str(OUTPUT_DIR))

with (OUTPUT_DIR / "train-stats.json").open("w") as f:
    json.dump(
        {
            "model": MODEL_NAME,
            "tag": TAG,
            "train_loss": stats.training_loss,
            "metrics": stats.metrics,
            "n_train": len(train_ds),
            "n_eval": len(eval_ds),
        },
        f,
        indent=2,
    )

print("done.")
