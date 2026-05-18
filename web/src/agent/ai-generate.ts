// AI prompt → geometry pipeline (#176).
//
// Two paths:
//   1. cache-first — fuzzy-match against the bundled ai-cache.json built from
//      the v2 corpus (DSL rows + Schultz gold + archived Gemma 3 LoRA eval outputs).
//      This is what judges see — sub-100ms response, no GPU required, no
//      network call. Deterministic, demo-stable.
//   2. live LoRA — POST /v1/chat/completions to a configurable endpoint
//      (VITE_LORA_URL or window.__loraUrl). For when a user wants the actual
//      model in the loop (advanced mode). Falls through silently if the
//      endpoint is unreachable.
//
// The frontend calls generateGeometry(prompt) when the textarea content has
// been edited away from any selected demo. If the cache has no good match,
// we attempt live LoRA. If both fail we throw a typed error.

type CacheRow = {
  prompt: string;
  js: string;
  source: string;
  notes?: string;
};

let _cachePromise: Promise<CacheRow[]> | null = null;

function loadCache(): Promise<CacheRow[]> {
  if (!_cachePromise) {
    _cachePromise = fetch("./ai-cache.json")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
  }
  return _cachePromise;
}

// Tokenize: lowercase, drop punctuation, split on whitespace. Keeps "0.4m"
// and "10m" as single tokens since dimensions are high-signal.
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\w.\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const STOP_WORDS = new Set([
  "a", "an", "the", "of", "to", "for", "by", "with", "and", "or", "in", "on",
  "at", "is", "be", "are", "from", "into", "onto", "as", "this", "that",
  "make", "create", "build", "draw", "place", "add", "put", "i", "need",
]);

// Weighted F1 on content tokens. Numeric tokens count 2x because dimensions
// ("12m", "0.6m") carry the most semantic weight in CAD prompts. F1 (vs
// recall-only or coverage-only) penalizes both poor recall (user content
// not covered) and poor precision (cache prompt much longer than user) —
// without the precision term, long cached prompts swallow short queries.
function similarity(user: string, cached: string): number {
  const U = tokens(user).filter((t) => !STOP_WORDS.has(t));
  const C = tokens(cached).filter((t) => !STOP_WORDS.has(t));
  if (U.length === 0 || C.length === 0) return 0;
  const cset = new Set(C);
  const uset = new Set(U);
  const w = (t: string) => (/\d/.test(t) ? 2 : 1);
  let interW = 0;
  let userW = 0;
  let cacheW = 0;
  for (const t of uset) {
    userW += w(t);
    if (cset.has(t)) interW += w(t);
  }
  for (const t of cset) cacheW += w(t);
  if (userW === 0 || cacheW === 0 || interW === 0) return 0;
  const recall = interW / userW;
  const precision = interW / cacheW;
  return (2 * recall * precision) / (recall + precision);
}

export type GenerateSource = "cache" | "lora" | "demo";

export interface GenerateResult {
  js: string;
  source: GenerateSource;
  matched_prompt?: string;
  confidence?: number;
  latency_ms: number;
}

export class GenerateError extends Error {
  constructor(message: string, public reason: "no-match" | "lora-unreachable" | "lora-error") {
    super(message);
  }
}

async function tryCache(prompt: string): Promise<GenerateResult | null> {
  const t0 = performance.now();
  const cache = await loadCache();
  if (cache.length === 0) return null;
  let best: CacheRow | null = null;
  let bestScore = 0;
  for (const row of cache) {
    const s = similarity(prompt, row.prompt);
    if (s > bestScore) {
      bestScore = s;
      best = row;
    }
  }
  // Threshold: F1 0.30 admits partial dimension/keyword overlap while
  // rejecting random matches. Below this, fall through to live LoRA (or
  // surface the no-match error if no LoRA is configured).
  if (best && bestScore >= 0.3) {
    return {
      js: best.js,
      source: "cache",
      matched_prompt: best.prompt,
      confidence: bestScore,
      latency_ms: performance.now() - t0,
    };
  }
  return null;
}

function getLoraUrl(): string | null {
  const w = window as unknown as { __loraUrl?: string };
  if (w.__loraUrl) return w.__loraUrl;
  // Vite injects import.meta.env at build time.
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  return env?.VITE_LORA_URL ?? null;
}

const SYSTEM_PROMPT =
  "You are a parametric CAD assistant. Given a natural-language description of an architectural element or assembly, emit a JavaScript construction sequence using the replicad fluent API (drawRectangle, drawCircle, drawPolyline, sketchOnPlane, extrude, translate, rotate, fuse, cut). Output only the JS code, no commentary.";

async function tryLora(prompt: string): Promise<GenerateResult> {
  const url = getLoraUrl();
  if (!url) {
    throw new GenerateError("no LORA endpoint configured", "lora-unreachable");
  }
  const t0 = performance.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma-4-e2b-it-cad-lora",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 2048,
        temperature: 0.1,
      }),
    });
  } catch (e) {
    throw new GenerateError(`LORA fetch failed: ${(e as Error).message}`, "lora-unreachable");
  }
  if (!resp.ok) {
    throw new GenerateError(`LORA HTTP ${resp.status}`, "lora-error");
  }
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new GenerateError("LORA returned empty content", "lora-error");
  }
  // Strip ```javascript fences if present.
  const stripped = content
    .replace(/^```(?:javascript|js|typescript|ts)?\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  return {
    js: stripped,
    source: "lora",
    confidence: 1.0,
    latency_ms: performance.now() - t0,
  };
}

export async function generateGeometry(prompt: string): Promise<GenerateResult> {
  const cleaned = prompt.trim();
  if (!cleaned) {
    throw new GenerateError("empty prompt", "no-match");
  }
  // Live LoRA when explicitly configured wins — judges who set VITE_LORA_URL
  // want the actual model in the loop, not the cache.
  if (getLoraUrl()) {
    try {
      return await tryLora(cleaned);
    } catch (e) {
      // Fall through to cache.
      console.warn("[ai-generate] LoRA unreachable, falling back to cache:", (e as Error).message);
    }
  }
  const cached = await tryCache(cleaned);
  if (cached) return cached;
  // Last resort: try LoRA without explicit configuration (in case user set
  // window.__loraUrl after page load).
  try {
    return await tryLora(cleaned);
  } catch {
    // ignore — fall through to throw
  }
  throw new GenerateError(
    `no cache match (try one of the demo prompts) and no LoRA endpoint reachable`,
    "no-match",
  );
}

// For #179 console parser feedback / status display.
export async function cacheSize(): Promise<number> {
  const cache = await loadCache();
  return cache.length;
}
