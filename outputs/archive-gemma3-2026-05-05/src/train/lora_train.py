"""
Spike A LoRA training — Gemma-3-E2B + QLoRA via Unsloth.

Inputs:  data/train.jsonl, data/eval.jsonl (chat format from build_dataset.py)
Output:  outputs/spike-a-lora/  (LoRA adapter + tokenizer)

Uses Unsloth FastModel for 4-bit base + LoRA. Targets ~10 min on a 4090.
"""

import json
import os
from pathlib import Path

# Disable torch.compile / inductor — Windows has no MSVC on PATH and triton
# falls back to CC env var. Plain eager-mode QLoRA training is plenty fast.
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")
os.environ.setdefault("UNSLOTH_COMPILE_DISABLE", "1")
os.environ.setdefault("CC", "gcc")

# Unsloth must be imported BEFORE transformers/trl per their warning.
import unsloth  # noqa: F401
from unsloth import FastModel
from unsloth.chat_templates import get_chat_template, train_on_responses_only

from datasets import load_dataset
from transformers import TrainingArguments
from trl import SFTTrainer, SFTConfig

REPO = Path(__file__).resolve().parents[2]
TRAIN = REPO / "data/train.jsonl"
EVAL = REPO / "data/eval.jsonl"
OUTPUT_DIR = REPO / "outputs/spike-a-lora"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

MODEL_NAME = "unsloth/gemma-3-4b-it-unsloth-bnb-4bit"
# E2B variant: "unsloth/gemma-3n-E2B-it" (5B effective). Use 4B-it as
# closest stable analogue while we wait for hackathon E4B preview wheels.
MAX_SEQ = 2048

print(f"loading {MODEL_NAME} ...")
model, tokenizer = FastModel.from_pretrained(
    model_name=MODEL_NAME,
    max_seq_length=MAX_SEQ,
    load_in_4bit=True,
    full_finetuning=False,
)

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

tokenizer = get_chat_template(tokenizer, chat_template="gemma-3")


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
        logging_steps=1,
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

# Train on the assistant turn only — masks the user/system prompt loss.
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

# Persist a JSON summary so the eval script + retrospective can reference.
with (OUTPUT_DIR / "train-stats.json").open("w") as f:
    json.dump(
        {
            "model": MODEL_NAME,
            "train_loss": stats.training_loss,
            "metrics": stats.metrics,
            "n_train": len(train_ds),
            "n_eval": len(eval_ds),
        },
        f,
        indent=2,
    )

print("done.")
