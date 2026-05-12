// bonsai-client.ts — browser client for the local Bonsai validation server.
//
// Issue #151. Bonsai is a Blender add-on for IFC; it exposes IFC validation
// via Blender's Python API. The "server" is a tiny HTTP wrapper documented
// in docs/runbooks/bonsai-validation.md, listening on 127.0.0.1:8765.
//
// This module degrades silently when the server is unavailable. Callers are
// expected to gate UI on `isBonsaiAvailable()` before exposing validation.
// Network failures inside `validateIFC` propagate to the caller as a thrown
// Error so the UI can render its own "validation unavailable" path — but no
// console spam is produced from this module.

const DEFAULT_BASE = "http://127.0.0.1:8765";
const HEALTH_TIMEOUT_MS = 1000;

export type BonsaiValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

function baseUrl(): string {
  // Allow tests / dev to override at runtime via window flag.
  const override = (globalThis as { __BONSAI_SERVER_URL__?: string }).__BONSAI_SERVER_URL__;
  return typeof override === "string" && override.length > 0 ? override : DEFAULT_BASE;
}

/**
 * Quick liveness probe. Resolves true if a HEAD/GET against /health returns
 * 200 within HEALTH_TIMEOUT_MS. Resolves false on any other outcome
 * (timeout, network error, non-200, malformed). Never throws, never logs.
 */
export async function isBonsaiAvailable(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl()}/health`, {
      method: "GET",
      signal: ctl.signal,
      // Avoid any caching layer between probe and server.
      cache: "no-store",
    });
    return res.ok;
  } catch {
    // AbortError, NetworkError, etc — server not available. Silent.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST an IFC buffer to the validation endpoint. Returns the parsed
 * `{valid, errors, warnings}` shape. Throws on network failure or malformed
 * server response — callers decide how to surface the error to users.
 */
export async function validateIFC(buffer: Uint8Array): Promise<BonsaiValidation> {
  const url = `${baseUrl()}/validate`;
  // Copy into a fresh ArrayBuffer-backed Uint8Array so TS BodyInit accepts it
  // even when `buffer.buffer` is typed as ArrayBuffer | SharedArrayBuffer.
  const body = new Uint8Array(buffer.byteLength);
  body.set(buffer);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Bonsai server returned ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  if (
    !json ||
    typeof json !== "object" ||
    typeof (json as BonsaiValidation).valid !== "boolean" ||
    !Array.isArray((json as BonsaiValidation).errors) ||
    !Array.isArray((json as BonsaiValidation).warnings)
  ) {
    throw new Error("Bonsai server returned unexpected response shape");
  }
  return json as BonsaiValidation;
}
