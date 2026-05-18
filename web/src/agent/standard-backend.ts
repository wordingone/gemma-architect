// standard-backend.ts — Main-thread wrapper for webgpu-standard-backend.worker.ts (#929).
//
// Exposes init / generate / dispose lifecycle matching the AgentBackend interface shape
// used in model-worker.ts. Generate returns an AsyncIterable<string> that yields
// decoded token chunks as they stream back from the worker.
//
// Activation: agent-harness.ts creates a StandardBackend when the drafter ONNX
// fails to load (agentmodel:drafter:error), then re-routes subsequent turns
// through it instead of the MTP worker's standard fallback.

export interface StandardBackendOptions {
  modelId: string;
  dtype?: "q4" | "q4f16";
}

export interface StandardBackendGenerateOpts {
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  maxNewTokens?: number;
}

export type StandardBackendResult = {
  text: string;
  tokensOut: number;
};

export class StandardBackend {
  private _worker: Worker | null = null;
  private _ready = false;
  private readonly _modelId: string;
  private readonly _dtype: "q4" | "q4f16";

  constructor(opts: StandardBackendOptions) {
    this._modelId = opts.modelId;
    this._dtype = opts.dtype ?? "q4f16";
  }

  /** Load pipeline + tokenizer in the worker. Resolves when ready. */
  async init(): Promise<void> {
    if (this._ready) return;
    this._worker = new Worker(
      new URL("./webgpu-standard-backend.worker.ts", import.meta.url),
      { type: "module" },
    );
    return new Promise<void>((resolve, reject) => {
      const onInit = (ev: MessageEvent<Record<string, unknown>>) => {
        if (ev.data.type === "ready") {
          this._ready = true;
          this._worker!.removeEventListener("message", onInit);
          resolve();
        } else if (ev.data.type === "error") {
          this._worker!.removeEventListener("message", onInit);
          reject(new Error(ev.data.error as string));
        }
      };
      this._worker!.addEventListener("message", onInit);
      this._worker!.postMessage({ type: "init", modelId: this._modelId, dtype: this._dtype });
    });
  }

  /** Run inference. Returns a streaming AsyncIterable<string> of token chunks. */
  generate(opts: StandardBackendGenerateOpts): AsyncIterable<string> & { resultPromise: Promise<StandardBackendResult> } {
    if (!this._worker || !this._ready) throw new Error("StandardBackend: not initialized");

    const turnId = `std-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const worker = this._worker;

    worker.postMessage({
      type: "generate",
      turnId,
      messages: opts.messages,
      maxNewTokens: opts.maxNewTokens ?? 512,
    });

    let resolveResult!: (r: StandardBackendResult) => void;
    let rejectResult!: (e: Error) => void;
    const resultPromise = new Promise<StandardBackendResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    // Build async-iterable around the postMessage stream
    const tokenQueue: string[] = [];
    let iteratorResolve: ((v: IteratorResult<string>) => void) | null = null;
    let streamDone = false;

    const onMessage = (ev: MessageEvent<Record<string, unknown>>) => {
      const msg = ev.data;
      if (msg.turnId !== turnId) return;
      if (msg.type === "token") {
        const chunk = msg.value as string;
        if (iteratorResolve) {
          const r = iteratorResolve;
          iteratorResolve = null;
          r({ value: chunk, done: false });
        } else {
          tokenQueue.push(chunk);
        }
      } else if (msg.type === "generate-done") {
        streamDone = true;
        worker.removeEventListener("message", onMessage);
        resolveResult({ text: msg.text as string, tokensOut: msg.tokensOut as number });
        if (iteratorResolve) {
          const r = iteratorResolve;
          iteratorResolve = null;
          r({ value: "", done: true });
        }
      } else if (msg.type === "generate-error" || msg.type === "error") {
        streamDone = true;
        worker.removeEventListener("message", onMessage);
        const err = new Error(msg.error as string);
        rejectResult(err);
        if (iteratorResolve) {
          const r = iteratorResolve;
          iteratorResolve = null;
          r({ value: "", done: true });
        }
      }
    };
    worker.addEventListener("message", onMessage);

    const iterable: AsyncIterable<string> & { resultPromise: Promise<StandardBackendResult> } = {
      resultPromise,
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<string>> {
            if (tokenQueue.length > 0) {
              return Promise.resolve({ value: tokenQueue.shift()!, done: false });
            }
            if (streamDone) {
              return Promise.resolve({ value: "", done: true });
            }
            return new Promise<IteratorResult<string>>((res) => { iteratorResolve = res; });
          },
          return(): Promise<IteratorResult<string>> {
            streamDone = true;
            worker.removeEventListener("message", onMessage);
            worker.postMessage({ type: "abort", turnId });
            return Promise.resolve({ value: "", done: true });
          },
        };
      },
    };
    return iterable;
  }

  /** Terminate the worker. Call once inference is done for the session. */
  dispose(): void {
    this._worker?.terminate();
    this._worker = null;
    this._ready = false;
  }
}
