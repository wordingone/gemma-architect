// wasm-backend.test.ts — §#736 WASM backend loader + cwrap bridge.
//
// Mirrors the logic in web/src/agent/wasm-backend.ts:
//   - CrossOriginIsolationError message and name
//   - WASM_BACKEND_ENABLED env gate logic
//   - fetchAndMount chunk assembly
//   - loadWasmBackend idempotency (second call reuses promise)
//   - wasmChatCompletion JSON bridge (happy path + invalid JSON)
//   - wasmHealth initialization guard

import { describe, expect, test } from "bun:test";

// ── CrossOriginIsolationError ─────────────────────────────────────────────────

class CrossOriginIsolationError extends Error {
  constructor() {
    super(
      "crossOriginIsolated is false — SharedArrayBuffer and WASM pthreads require " +
      "Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-Policy: require-corp. " +
      "Check dev-server headers (vite.config.ts server.headers) or the hosting environment."
    );
    this.name = "CrossOriginIsolationError";
  }
}

describe("#736 §wasm — CrossOriginIsolationError", () => {
  test("error name is CrossOriginIsolationError", () => {
    const err = new CrossOriginIsolationError();
    expect(err.name).toBe("CrossOriginIsolationError");
  });

  test("error message mentions COOP+COEP", () => {
    const err = new CrossOriginIsolationError();
    expect(err.message).toContain("Cross-Origin-Opener-Policy");
    expect(err.message).toContain("Cross-Origin-Embedder-Policy");
  });

  test("instanceof Error", () => {
    expect(new CrossOriginIsolationError()).toBeInstanceOf(Error);
  });
});

// ── Env gate logic ────────────────────────────────────────────────────────────

describe("#736 §wasm — WASM_BACKEND_ENABLED env gate", () => {
  test("enabled when target URL is set", () => {
    const targetUrl = "http://localhost:5173/models/target.gguf";
    const enabled = !!targetUrl;
    expect(enabled).toBe(true);
  });

  test("disabled when target URL is empty string", () => {
    const targetUrl = "";
    const enabled = !!targetUrl;
    expect(enabled).toBe(false);
  });

  test("disabled when target URL is undefined", () => {
    const targetUrl: string | undefined = undefined;
    const enabled = !!targetUrl;
    expect(enabled).toBe(false);
  });
});

// ── fetchAndMount chunk assembly ──────────────────────────────────────────────
// Mirror of the concatenation loop: chunks → single Uint8Array.

function assembleChunks(chunks: Uint8Array[]): Uint8Array {
  const loaded = chunks.reduce((n, c) => n + c.byteLength, 0);
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return buf;
}

describe("#736 §wasm — fetchAndMount chunk assembly", () => {
  test("single chunk assembled correctly", () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    const result = assembleChunks([chunk]);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  test("multiple chunks concatenated in order", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5]);
    const c = new Uint8Array([6]);
    const result = assembleChunks([a, b, c]);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  test("empty chunk array → empty buffer", () => {
    expect(assembleChunks([])).toEqual(new Uint8Array([]));
  });

  test("assembled length equals sum of chunk lengths", () => {
    const chunks = [new Uint8Array(100), new Uint8Array(58), new Uint8Array(200)];
    const result = assembleChunks(chunks);
    expect(result.byteLength).toBe(358);
  });
});

// ── loadWasmBackend idempotency ───────────────────────────────────────────────
// Mirror: _loadProm is only set once; second call returns the same promise.

describe("#736 §wasm — loadWasmBackend idempotency", () => {
  test("second call returns same promise as first", () => {
    let _loadProm: Promise<void> | null = null;

    function fakeLoadWasmBackend(): Promise<void> {
      if (_loadProm) return _loadProm;
      _loadProm = Promise.resolve(); // simulate async init
      return _loadProm;
    }

    const p1 = fakeLoadWasmBackend();
    const p2 = fakeLoadWasmBackend();
    expect(p1).toBe(p2);
  });

  test("on failure promise is reset so retry is possible", async () => {
    let _loadProm: Promise<void> | null = null;
    let callCount = 0;

    function fakeLoadWasmBackend(): Promise<void> {
      if (_loadProm) return _loadProm;
      callCount++;
      _loadProm = Promise.reject(new Error("init failed")).catch((err) => {
        _loadProm = null;
        throw err;
      });
      return _loadProm;
    }

    // First call fails
    await expect(fakeLoadWasmBackend()).rejects.toThrow("init failed");
    expect(callCount).toBe(1);

    // Second call after failure should retry (not return the failed promise)
    await expect(fakeLoadWasmBackend()).rejects.toThrow("init failed");
    expect(callCount).toBe(2);
  });
});

// ── wasmChatCompletion JSON bridge ────────────────────────────────────────────
// Mirror of the ptr→UTF8ToString→JSON.parse→freeStr path.

interface WasmChatResponse {
  choices:           Array<{ message: { role: string; content: string } }>;
  _mtp_enabled:      boolean;
  _spec_accept_rate: number | null;
  _latency_ms:       number;
  _tps:              number;
}

function parseWasmResponse(raw: string): WasmChatResponse {
  let parsed: WasmChatResponse;
  try {
    parsed = JSON.parse(raw) as WasmChatResponse;
  } catch {
    throw new Error(
      `[wasm-backend] invalid JSON from wasm_llama_chat_completion: ${raw.slice(0, 200)}`
    );
  }
  return parsed;
}

describe("#736 §wasm — wasmChatCompletion JSON bridge", () => {
  test("happy path: parses valid response", () => {
    const raw = JSON.stringify({
      choices:           [{ message: { role: "assistant", content: "Hello!" } }],
      _mtp_enabled:      true,
      _spec_accept_rate: 0.72,
      _latency_ms:       420,
      _tps:              18.4,
    });
    const resp = parseWasmResponse(raw);
    expect(resp.choices[0].message.content).toBe("Hello!");
    expect(resp._mtp_enabled).toBe(true);
    expect(resp._tps).toBeCloseTo(18.4);
  });

  test("_spec_accept_rate null is preserved", () => {
    const raw = JSON.stringify({
      choices:           [{ message: { role: "assistant", content: "Hi" } }],
      _mtp_enabled:      false,
      _spec_accept_rate: null,
      _latency_ms:       100,
      _tps:              0,
    });
    const resp = parseWasmResponse(raw);
    expect(resp._spec_accept_rate).toBeNull();
    expect(resp._mtp_enabled).toBe(false);
  });

  test("invalid JSON throws with truncated preview", () => {
    expect(() => parseWasmResponse("not-json")).toThrow(
      "[wasm-backend] invalid JSON from wasm_llama_chat_completion"
    );
  });

  test("empty string throws", () => {
    expect(() => parseWasmResponse("")).toThrow(
      "[wasm-backend] invalid JSON from wasm_llama_chat_completion"
    );
  });

  test("truncated preview is 200 chars max", () => {
    const longBad = "X".repeat(500);
    let preview = "";
    try { parseWasmResponse(longBad); } catch (e) {
      preview = (e as Error).message;
    }
    // The message ends with the preview which is sliced to 200
    const afterColon = preview.split(": ").slice(1).join(": ");
    expect(afterColon.length).toBeLessThanOrEqual(200);
  });
});

// ── wasmHealth initialization guard ──────────────────────────────────────────

describe("#736 §wasm — wasmHealth initialization guard", () => {
  function fakeWasmHealth(initDone: boolean): { ok: boolean; detail: string } {
    if (!initDone) return { ok: false, detail: "not initialized" };
    // Simulate a successful health response
    return { ok: true, detail: '{"status":"ok"}' };
  }

  test("returns ok:false when not initialized", () => {
    const result = fakeWasmHealth(false);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("not initialized");
  });

  test("returns ok:true when initialized", () => {
    const result = fakeWasmHealth(true);
    expect(result.ok).toBe(true);
  });
});
