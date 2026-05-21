/// <reference lib="webworker" />
// webgpu-standard-backend.worker.ts — Dedicated Web Worker for standard
// fallback inference path (#929). Isolates `model.generate()` from the
// MTP-spec-decode path in model-worker.ts so the main thread never blocks
// when the drafter ONNX fails to load.
//
// Uses the transformers.js `pipeline` API (text-generation) with a
// TextStreamer to stream tokens back to the main thread one chunk at a time.
//
// Protocol (main → worker):
//   {type:"init", modelId, dtype}              → loads pipeline; posts {type:"ready"}
//   {type:"generate", turnId, messages, maxNewTokens} → infers; streams tokens
//   {type:"abort", turnId}                     → aborts in-flight generation
//
// Protocol (worker → main):
//   {type:"ready"}                             // after pipeline loaded
//   {type:"token", turnId, value, tokenCount}  // per-token during generation
//   {type:"generate-done", turnId, text, tokensOut}
//   {type:"generate-error", turnId, error}
//   {type:"error", error}                      // fatal init error

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { pipeline, TextStreamer } from "@huggingface/transformers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pipe: any = null;
const _abortMap = new Map<string, AbortController>();

function post(msg: Record<string, unknown>): void {
  (self as unknown as Worker).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent<Record<string, unknown>>) => {
  const { type, ...data } = ev.data;
  try {
    if (type === "init") {
      const modelId = data.modelId as string;
      const dtype = (data.dtype as "q4" | "q4f16") ?? "q4f16";
      _pipe = await pipeline("text-generation", modelId, {
        dtype,
        device: "webgpu",
        // #1283 fix #4: consistent with model-worker.ts; no runtime effect (worker not spawned
        // in drafter-failed path per #1288) but defensive if worker is ever used explicitly.
        session_options: {
          freeDimensionOverrides: {
            batch_size: 1,
            past_sequence_length: 0,
          },
        },
      });
      // Warmup probe — compile /lm_head/num_logits_to_keep/Slice shader at boot to remove it
      // from the user-click cold-compile path. Same shape pattern as model-worker.ts:172-189.
      // Non-fatal on failure (some shader paths can recover at real inference time).
      try {
        await _pipe(
          [{ role: "user", content: "warmup" }],
          { max_new_tokens: 1, do_sample: false },
        );
      } catch (e) {
        console.warn("[std-backend] warmup probe failed (non-fatal):", (e as Error).message?.slice(0, 120));
      }
      post({ type: "ready" });
    } else if (type === "generate") {
      await handleGenerate(data);
    } else if (type === "abort") {
      const turnId = data.turnId as string;
      _abortMap.get(turnId)?.abort();
      _abortMap.delete(turnId);
    }
  } catch (e) {
    post({ type: "error", error: (e as Error).message });
  }
};

async function handleGenerate(data: Record<string, unknown>): Promise<void> {
  const turnId = data.turnId as string;
  if (!_pipe) {
    post({ type: "generate-error", turnId, error: "standard backend: model not loaded" });
    return;
  }

  const messages = data.messages as Array<{ role: string; content: string }>;
  const maxNewTokens = (data.maxNewTokens as number) ?? 512;

  const abortController = new AbortController();
  _abortMap.set(turnId, abortController);

  let tokenCount = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamer = new TextStreamer((_pipe as any).tokenizer, {
    skip_prompt: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    callback_function: (text: any) => {
      tokenCount++;
      post({ type: "token", turnId, value: String(text), tokenCount });
    },
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await (_pipe as any)(messages, {
      max_new_tokens: maxNewTokens,
      do_sample: false,
      streamer,
    });

    // Extract assistant text from pipeline output
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generated = (output as any)?.[0]?.generated_text;
    let text = "";
    if (Array.isArray(generated)) {
      // Chat format: array of {role, content} — last entry is assistant
      const last = generated[generated.length - 1];
      text = last?.content ?? "";
    } else {
      text = String(generated ?? "");
    }

    post({ type: "generate-done", turnId, text, tokensOut: tokenCount });
  } catch (e) {
    post({ type: "generate-error", turnId, error: (e as Error).message });
  } finally {
    _abortMap.delete(turnId);
  }
}
