/**
 * WASM MTP backend — browser-resident Gemma 4 speculative decoding via turboquant WASM.
 *
 * Cross-origin isolation check (PR2/#738) + full loader + cwrap bridge (#736).
 *
 * Env gates (set in .env.local or shell):
 *   VITE_WASM_LLAMA_TARGET_URL  — URL of target GGUF  (e.g. /models/gemma-4-e4b-q4.gguf)
 *   VITE_WASM_LLAMA_DRAFTER_URL — URL of drafter GGUF (optional; enables MTP when set)
 *
 * Load sequence:
 *   1. injectWasmScript() → hooks window.Module.onRuntimeInitialized before <script> inject
 *   2. fetchAndMount() downloads each GGUF and writes it into the Emscripten virtual FS
 *   3. cwrap wasm_llama_init(target, drafter) → 0 = OK
 *   4. wasmChatCompletion(req) → sync cwrap call → UTF8ToString → JSON.parse → freeStr
 */

// ── Cross-origin isolation check (PR2/#738) ───────────────────────────────────

export class CrossOriginIsolationError extends Error {
  constructor() {
    super(
      "crossOriginIsolated is false — SharedArrayBuffer and WASM pthreads require " +
      "Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-Policy: require-corp. " +
      "Check dev-server headers (vite.config.ts server.headers) or the hosting environment."
    );
    this.name = "CrossOriginIsolationError";
  }
}

/** True when COOP+COEP headers are in place and SharedArrayBuffer is available. */
export const crossOriginIsolated: boolean =
  typeof self !== "undefined" && (self as Window & typeof globalThis).crossOriginIsolated === true;

/**
 * Assert cross-origin isolation. Call once at app startup.
 * Throws CrossOriginIsolationError and logs to console.error if headers are missing.
 * In production builds the error is surfaced but non-fatal so the app degrades to
 * non-threaded WASM; in dev it throws to surface the misconfiguration immediately.
 */
export function assertCrossOriginIsolated(opts: { throwInDev?: boolean } = {}): void {
  if (crossOriginIsolated) return;

  const err = new CrossOriginIsolationError();
  console.error("[wasm-backend]", err.message);

  const isDev = import.meta.env.DEV;
  if (isDev || opts.throwInDev) {
    throw err;
  }
  // Production: log and continue — WASM pthreads unavailable, MTP disabled.
}

// ── Env gates (#736) ──────────────────────────────────────────────────────────

const _env = import.meta.env as Record<string, string | undefined>;

export const WASM_TARGET_URL: string  = _env.VITE_WASM_LLAMA_TARGET_URL  ?? "";
export const WASM_DRAFTER_URL: string = _env.VITE_WASM_LLAMA_DRAFTER_URL ?? "";

/** True when the WASM backend is configured via env. */
export const WASM_BACKEND_ENABLED: boolean = !!WASM_TARGET_URL;

// ── Emscripten Module types ───────────────────────────────────────────────────

interface EmscriptenModule {
  onRuntimeInitialized?: () => void;
  locateFile?:           (path: string, scriptDir: string) => string;
  cwrap: (
    ident:      string,
    returnType: "number" | "string" | null,
    argTypes:   string[],
  ) => (...args: unknown[]) => unknown;
  UTF8ToString: (ptr: number) => string;
  FS: {
    mkdir:     (path: string) => void;
    writeFile: (path: string, data: Uint8Array) => void;
  };
}

declare global {
  interface Window {
    Module?: Partial<EmscriptenModule>;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

let _module:   EmscriptenModule | null = null;
let _loadProm: Promise<void>   | null = null;
let _initDone  = false;

type WasmChatFn    = (json: string) => number;
type WasmHealthFn  = ()             => number;
type WasmFreeStrFn = (ptr: number)  => void;

let _chatFn:    WasmChatFn    | null = null;
let _healthFn:  WasmHealthFn  | null = null;
let _freeStrFn: WasmFreeStrFn | null = null;

// ── GGUF fetch + mount ────────────────────────────────────────────────────────

async function fetchAndMount(
  mod:         EmscriptenModule,
  url:         string,
  virtPath:    string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`[wasm-backend] fetch failed: ${resp.status} ${url}`);

  const contentLength = Number(resp.headers.get("Content-Length") ?? 0);
  let loaded = 0;
  const chunks: Uint8Array[] = [];

  if (resp.body) {
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, contentLength);
    }
  } else {
    const fb = new Uint8Array(await resp.arrayBuffer());
    chunks.push(fb);
    loaded = fb.byteLength;
    onProgress?.(loaded, loaded);
  }

  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }

  const dir = virtPath.slice(0, virtPath.lastIndexOf("/")) || "/";
  try { mod.FS.mkdir(dir); } catch { /* already exists */ }
  mod.FS.writeFile(virtPath, buf);
  console.info(`[wasm-backend] mounted ${url} → ${virtPath} (${(loaded / 1e6).toFixed(1)} MB)`);
}

// ── Script injection ──────────────────────────────────────────────────────────

function injectWasmScript(): Promise<EmscriptenModule> {
  return new Promise((resolve, reject) => {
    // Pre-configure Module before the script executes — Emscripten reads these on load.
    window.Module = {
      locateFile(path: string): string {
        if (path.endsWith(".wasm")) return "/wasm-llama.wasm";
        return path;
      },
      onRuntimeInitialized() {
        resolve(window.Module as unknown as EmscriptenModule);
      },
    };

    const script = document.createElement("script");
    script.src = "/wasm-llama.js";
    script.onerror = () => reject(new Error("[wasm-backend] failed to load /wasm-llama.js"));
    document.head.appendChild(script);
  });
}

// ── Public: loadWasmBackend ───────────────────────────────────────────────────

/**
 * Load + initialize the WASM backend. Safe to call multiple times — resolves
 * immediately on subsequent calls once initialization completes.
 *
 * @param onProgress  Optional byte-progress callback for each GGUF fetch.
 *                    Called with (label, loaded, total) where total=0 means indeterminate.
 */
export function loadWasmBackend(
  onProgress?: (label: string, loaded: number, total: number) => void,
): Promise<void> {
  if (_loadProm) return _loadProm;
  _loadProm = _doLoad(onProgress).catch((err) => {
    _loadProm = null; // allow retry on failure
    throw err;
  });
  return _loadProm;
}

async function _doLoad(
  onProgress?: (label: string, loaded: number, total: number) => void,
): Promise<void> {
  const mod = await injectWasmScript();
  _module = mod;

  await fetchAndMount(mod, WASM_TARGET_URL, "/target.gguf",
    onProgress ? (l, t) => onProgress("target", l, t) : undefined);

  if (WASM_DRAFTER_URL) {
    await fetchAndMount(mod, WASM_DRAFTER_URL, "/drafter.gguf",
      onProgress ? (l, t) => onProgress("drafter", l, t) : undefined);
  }

  _chatFn    = mod.cwrap("wasm_llama_chat_completion", "number", ["string"]) as WasmChatFn;
  _healthFn  = mod.cwrap("wasm_llama_health",          "number", [])         as WasmHealthFn;
  _freeStrFn = mod.cwrap("wasm_llama_free_str",        null,     ["number"]) as WasmFreeStrFn;

  const wasmInit = mod.cwrap("wasm_llama_init", "number", ["string", "string"]) as
    (t: string, d: string) => number;
  const rc = wasmInit("/target.gguf", WASM_DRAFTER_URL ? "/drafter.gguf" : "");
  if (rc !== 0) throw new Error(`[wasm-backend] wasm_llama_init failed (rc=${rc})`);

  _initDone = true;
  console.info("[wasm-backend] ready — MTP:", !!WASM_DRAFTER_URL);
}

// ── Public: wasmHealth ────────────────────────────────────────────────────────

export function wasmHealth(): { ok: boolean; detail: string } {
  if (!_initDone || !_module || !_healthFn || !_freeStrFn) {
    return { ok: false, detail: "not initialized" };
  }
  const ptr = (_healthFn as unknown as () => number)();
  const raw = _module.UTF8ToString(ptr);
  _freeStrFn(ptr);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { ok: true, detail: raw, ...parsed };
  } catch {
    return { ok: false, detail: raw };
  }
}

// ── Public: wasmChatCompletion ────────────────────────────────────────────────

export type WasmChatRequest = {
  messages:    Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
};

export type WasmChatResponse = {
  choices:           Array<{ message: { role: string; content: string } }>;
  _mtp_enabled:      boolean;
  _spec_accept_rate: number | null;
  _latency_ms:       number;
  _tps:              number;
};

/**
 * Run a single chat-completion turn via the WASM backend.
 * Requires loadWasmBackend() to have resolved first.
 */
export async function wasmChatCompletion(req: WasmChatRequest): Promise<WasmChatResponse> {
  if (!_initDone || !_module || !_chatFn || !_freeStrFn) {
    throw new Error("[wasm-backend] not initialized — call loadWasmBackend() first");
  }

  const body = JSON.stringify({
    messages:    req.messages,
    max_tokens:  req.max_tokens  ?? 4096,
    temperature: req.temperature ?? 0.1,
  });

  // Wrap in Promise.resolve() so the synchronous call yields to the event loop first.
  const ptr = await Promise.resolve().then(
    () => (_chatFn as WasmChatFn)(body) as unknown as number,
  );
  const raw = _module.UTF8ToString(ptr);
  _freeStrFn(ptr);

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
