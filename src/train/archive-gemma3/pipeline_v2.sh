#!/bin/bash
# v2 post-4b-training pipeline: E2B train + eval both + publish best.
# Runs sequentially to avoid GPU contention. Each step logs to outputs/.
#
# Usage:
#   bash src/train/pipeline_v2.sh
#
# Idempotent: skips steps whose outputs already exist.

set -euo pipefail
cd "$(dirname "$0")/../.."  # repo root
export PYTHONUTF8=1
export TORCHDYNAMO_DISABLE=1
export UNSLOTH_COMPILE_DISABLE=1

ts() { date +"%Y-%m-%d %H:%M:%S"; }
log() { echo "[$(ts)] $*"; }

# 1. E2B training (skip if adapter already exists; soft-fail on download/auth issues
# per dataset/v2-spec.md §line 36 — E2B is gated, may require HF auth, 4b-it is the
# stable substitute and remains the publish candidate when E2B is unavailable).
if [ -d outputs/cad-lora-v2-e2b-it ] && [ -f outputs/cad-lora-v2-e2b-it/train-stats.json ]; then
  log "skip: E2B adapter present"
else
  log "step 1/4: E2B LoRA training (soft-fail on auth/download)"
  GEMMA_V2_MODEL=e2b python src/train/lora_train_v2.py 2>&1 | tee outputs/lora-v2-e2b-train.log || {
    log "E2B training failed (likely gated/unauthenticated download). Continuing with 4b-it only."
  }
fi

# 2. Eval 4b-it (skip if summary present)
if [ -f outputs/cad-lora-v2-4b-it-summary.json ]; then
  log "skip: 4b-it eval present"
else
  log "step 2/4: eval 4b-it"
  ADAPTER_DIR=outputs/cad-lora-v2-4b-it python src/train/inference_eval_v2.py 2>&1 | tee outputs/eval-v2-4b.log
fi

# 3. Eval E2B (skip if summary present OR if E2B training did not produce an adapter)
if [ -f outputs/cad-lora-v2-e2b-it-summary.json ]; then
  log "skip: E2B eval present"
elif [ ! -f outputs/cad-lora-v2-e2b-it/adapter_config.json ]; then
  log "skip: E2B adapter not built (training failed); 4b-it is sole candidate"
else
  log "step 3/4: eval E2B"
  ADAPTER_DIR=outputs/cad-lora-v2-e2b-it python src/train/inference_eval_v2.py 2>&1 | tee outputs/eval-v2-e2b.log
fi

# 4. Publish best (will dump plan if HF_TOKEN missing, exits 0)
log "step 4/4: publish best"
python src/train/publish_v2.py 2>&1 | tee outputs/publish-v2.log

log "pipeline done."
