# Closed-loop tool-chain CAD test — base Gemma 4 26B vs single-shot LoRA

Test ran 2026-05-03 07:38–07:53 UTC. Six configurations of the tool-chain harness against the canonical Schultz Residence target prompt. Result: base Gemma 4 26B in iterative tool-chain mode **does not** improve on single-shot LoRA — it actively performs worse, stalling at 2-3 tool calls before exhausting context budget on mandatory reasoning.

## What was tested

Harness: `scripts/closed-loop-cad.ts` (Bun TS).
Surface: 11 tools wrapping the existing tier1 + helpers — `make_box`, `make_cylinder`, `draw_rectangle`, `draw_circle`, `extrude_drawing`, `fuse`, `cut`, `translate`, `inspect`, `list_solids`, `submit`. Each tool result includes a bounding-box readback so the model can verify the part landed where intended.

Endpoint: `http://127.0.0.1:8083/v1/chat/completions` (llama-server `b8786-32ec212a5`, model `google_gemma-4-26B-A4B-it-Q4_K_L.gguf`, 200K ctx, RTX 4090).

Prompt: `data/schultz-target.jsonl` user message — single-story residence, 12×8m, 4 walls, partition, 2 columns, door cut, window cut, roof, fuse all.

## Results

| Run | Settings | Iterations | Tool calls | Composition | Outcome |
|---|---|---|---|---|---|
| 1 | tool_choice=auto, temp=0.2, max_tok=1024 | 1 | 0 | none | Stuck mid-reasoning, finish_reason=length |
| 2 | tool_choice=required, temp=0.2, max_tok=512 | 1 | 0 | none | Same — reasoning fills budget |
| 3 | tool_choice=required, temp=0.2, max_tok=2048 | 4 | 3 | 0 cuts/0 fuses/0 extrudes | Made floor + west_wall + duplicate floor; stuck on iter 4 in indecision loop ("Wait, I'll just make the east wall." x10) |
| 4 | + DRY repetition penalty, temp=0.5 | 1 | 0 | none | DRY broke loop but reasoning still over budget |
| 5 | + DRY, temp=0.5, max_tok=2048 | 3 | 2 | none | floor + west_wall, then iter-3 stall |
| 6 | + reasoning stripped from history, in-context primer | 3 | 2 | none | Best so far: floor + west_wall, but iter-3 still hit length cap |

**Best run: 2 tool calls in 3 iterations, no fuses, no cuts, no submit.** vs single-shot LoRA 4b-it which emits 12 valid consts in one generation.

## Why it fails

`google_gemma-4-26B-A4B-it` ships with a `peg-gemma4` chat template that **mandates** a `<|channel>thought\nI need to reason through this carefully.\n` lead-in to every assistant turn. The model cannot skip reasoning. Each turn's reasoning section is verbose (~1000–2000 tokens) and grows with prompt complexity. The Schultz prompt is 600 chars with 14 distinct elements; the model burns 1200–2000 tokens of reasoning before it converges on the next tool. Cumulative reasoning across iterations exhausts the 2048-token completion budget by turn 3.

Per llama.cpp verbose response field `"reasoning_format":"none"`, the server is configured to emit reasoning inline as content rather than separate it. Setting `reasoning_format` differently is server-side and not exposed via OpenAI-compat. The grammar (`peg-gemma4`) hard-codes the lead-in.

Indecision loops on iter 3+ ("Wait, I'll just make the east wall." x10) suggest the model becomes uncertain as state space grows. DRY sampler + temp=0.5 reduces verbatim repetition but doesn't restore convergence on tool selection.

Stripping past reasoning from message history (keep only tool calls + results) partially helps — context bloat goes from O(N²) to O(N) — but each turn still spawns its own ~1500 tokens of fresh reasoning, so the per-turn cost is unchanged.

## Comparison vs single-shot LoRA

| Configuration | Schultz output | Composition | Time |
|---|---|---|---|
| 4b-it LoRA single-shot | 12/14 consts, has_extrude+fuse, has_cut=False — door/window emitted as separate solids fused in, partition/column heights wrong | 1 fuse-chain, 0 cuts, 12 extrudes (in JS string) | ~10s end-to-end |
| e2b-it LoRA single-shot | 6/14 consts, has_extrude=False — drawRectangle in arrays, structurally broken | 0 valid ops | ~10s end-to-end |
| **Base Gemma 4 26B closed-loop, best run** | 2 tool calls (floor + west_wall), nothing else, no submit | 0 fuses, 0 cuts, 2 extrudes (via make_box) | 60s wallclock, gave up at iter 3 |

**Single-shot LoRA wins on every axis: composition counts, geometric correctness, latency, robustness.**

## Conclusion

Closed-loop tool-chain calling on base Gemma 4 26B is not viable for compositional CAD generation in this configuration. The model's mandatory verbose reasoning per turn is a structural blocker — it's not a sampler-tuning issue or a prompt-engineering issue, it's a chat-template issue.

Three viable next paths, ranked by leverage:

1. **Train a tool-call LoRA on the Gemma 3 4b-it base (no reasoning template), Schultz-shaped multi-turn data.** Same training pipeline as the existing single-shot LoRA. Synthesize training rows where the assistant emits one tool call per turn, sees a tool result, emits the next. ~5-10k rows, 3 epochs, ~3-4h on the same hardware. This is the highest-leverage move — combines tool-chain interaction with the small-model speed of the existing LoRA pipeline.

2. **Stay single-shot but add a self-correction pass to the existing 4b-it LoRA.** When the LoRA's JS output executes but produces wrong geometry (e.g., bbox check fails: door at z=4 means model put it 4m high), feed the executed-but-wrong output back as user message ("the door you placed at z=4 floats above the wall — fix"). Cheap to build (~1h on top of existing harness), might close the 4b-it Schultz cut-gap.

3. **Switch to Qwen3.5 Coder 32B for the closed-loop test.** Qwen has different reasoning patterns and may not exhibit the mandatory-thought template. Would need to launch a separate llama-server instance on 8082 (~22GB VRAM), which means killing the current gemma4-26b on 8083 first.

Path 1 + 2 are complementary: 1 unlocks the agentic angle, 2 immediately patches the compositional gap on the existing pipeline. Recommend doing 2 first (faster, ships within hours), 1 second.

## Artifacts

- `scripts/closed-loop-cad.ts` — the harness (committed, reusable for path 3 with model swap)
- `outputs/closed-loop-schultz/run-2026-05-03T07-*` — six runs, each with log.jsonl + messages.json + summary.json
- `outputs/cad-lora-v2-{4b-it,e2b-it}-summary.json` — single-shot LoRA baselines
- `outputs/cad-lora-v2-{4b-it,e2b-it}-schultz-eval.jsonl` — single-shot Schultz preds for comparison
