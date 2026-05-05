#!/usr/bin/env bash
# serve-gemma4-e2b.sh — Launch a llama-server instance for Gemma 4 E2B-it.
#
# Port: 8084 (dedicated to gemma-architect; avir-cli uses 8083).
# Model: Gemma 4 E2B-it, Q4_K_M GGUF (~3GB VRAM).
#
# Usage:
#   bash scripts/serve-gemma4-e2b.sh
#
# Prerequisites:
#   1. A GGUF of google/gemma-4-E2B-it (Q4_K_M recommended).
#      Download via: huggingface-cli download google/gemma-4-E2B-it --repo-type model
#      Convert with: llama.cpp/convert_hf_to_gguf.py + llama.cpp/llama-quantize
#      OR use a pre-quantized community GGUF (e.g. bartowski/gemma-4-E2B-IT-GGUF on HF).
#   2. llama-server binary (from llama.cpp build or avir-cli vendor copy).
#
# Override defaults with env vars before running:
#   GEMMA4_GGUF=/path/to/gemma-4-e2b-q4_k_m.gguf
#   LLAMA_SERVER=/path/to/llama-server
#   GEMMA4_CTX=8192
#   GEMMA4_GPU_LAYERS=99

set -euo pipefail

PORT=8084
HOST=127.0.0.1
CTX="${GEMMA4_CTX:-8192}"
GPU_LAYERS="${GEMMA4_GPU_LAYERS:-99}"

# ── Locate GGUF ──────────────────────────────────────────────────────────────
GGUF="${GEMMA4_GGUF:-}"
if [[ -z "$GGUF" ]]; then
  # Common search locations.
  for candidate in \
      "B:/M/avir-cli/models/gemma-4-E2B-it-Q8_0.gguf" \
      "$(ls B:/M/avir-cli/models/gemma-4*E2B*.gguf 2>/dev/null | head -1)" \
      "$HOME/.cache/huggingface/hub/models--bartowski--gemma-4-E2B-IT-GGUF/snapshots"/*/"gemma-4-E2B-IT-Q4_K_M.gguf" \
      "$HOME/.cache/lm-studio/models/google/gemma-4-E2B-IT-GGUF/gemma-4-E2B-IT-Q4_K_M.gguf" \
      "B:/M/avir-cli/models/gemma-4-e2b-q4_k_m.gguf" \
      "$(dirname "$0")/../models/gemma-4-e2b-q4_k_m.gguf"; do
    if [[ -f "$candidate" ]]; then
      GGUF="$candidate"
      break
    fi
  done
fi
if [[ -z "$GGUF" || ! -f "$GGUF" ]]; then
  echo "ERROR: Gemma 4 E2B-it GGUF not found."
  echo "  Set GEMMA4_GGUF=/path/to/gemma-4-e2b-q4_k_m.gguf before running."
  echo "  Or download from HuggingFace:"
  echo "    pip install huggingface_hub"
  echo "    huggingface-cli download bartowski/gemma-4-E2B-IT-GGUF gemma-4-E2B-IT-Q4_K_M.gguf"
  exit 1
fi

# ── Locate llama-server ───────────────────────────────────────────────────────
SERVER="${LLAMA_SERVER:-}"
if [[ -z "$SERVER" ]]; then
  for candidate in \
      "B:/M/avir-cli/vendor/llama-turboquant/build/bin/llama-server.exe" \
      "B:/M/avir-cli/vendor/llama-turboquant/build/bin/Release/llama-server.exe" \
      "$(which llama-server 2>/dev/null || true)" \
      "$(which llama-server.exe 2>/dev/null || true)"; do
    if [[ -n "$candidate" && ( -f "$candidate" || -x "$candidate" ) ]]; then
      SERVER="$candidate"
      break
    fi
  done
fi
if [[ -z "$SERVER" ]]; then
  echo "ERROR: llama-server not found."
  echo "  Set LLAMA_SERVER=/path/to/llama-server before running."
  exit 1
fi

echo "gemma-architect · Gemma 4 E2B-it server"
echo "  GGUF:    $GGUF"
echo "  Server:  $SERVER"
echo "  Port:    $PORT"
echo "  Context: $CTX"
echo "  GPU layers: $GPU_LAYERS"
echo ""

exec "$SERVER" \
  --model "$GGUF" \
  --host "$HOST" \
  --port "$PORT" \
  --ctx-size "$CTX" \
  --n-gpu-layers "$GPU_LAYERS" \
  --parallel 1 \
  --flash-attn
