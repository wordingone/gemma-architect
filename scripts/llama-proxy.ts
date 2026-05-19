#!/usr/bin/env bun
// llama-proxy.ts — Lazy-start / idle-suspend wrapper for llama-server.
//
// Listens on :8088 (the VITE_GEMMA_AGENT_URL port). On the first request
// after a cold period: spawns the real llama-server on :8089, waits until
// its /health endpoint returns 200, then proxies the request. Kills the
// child after IDLE_TIMEOUT_MS of silence. Next request triggers a warm-up.
//
// Usage:
//   bun scripts/llama-proxy.ts
// or via package.json:
//   bun run llama:proxy

const PROXY_PORT   = 8088;
const SERVER_PORT  = 8089;
const SERVER_HOST  = "127.0.0.1";
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const LLAMA_CMD  = process.env.LLAMA_SERVER_BIN ?? "llama-server";
const LLAMA_ARGS = [
  "--model",         process.env.LLAMA_MODEL_PATH ?? "gemma-4-E2B-it-Q8_0.gguf",
  "--host",          SERVER_HOST,
  "--port",          String(SERVER_PORT),
  "--n-gpu-layers",  "999",
  "--ctx-size",      "32768",
];

let child: ReturnType<typeof Bun.spawn> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastActivity = 0;
let warming = false;
let warmWaiters: Array<() => void> = [];

function resetIdleTimer(): void {
  lastActivity = Date.now();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log(`[proxy] idle timeout — killing llama-server`);
    stopServer();
  }, IDLE_TIMEOUT_MS);
}

function stopServer(): void {
  if (child) {
    try { child.kill(); } catch {}
    child = null;
  }
  warming = false;
  warmWaiters = [];
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  console.log("[proxy] llama-server stopped");
}

async function waitForReady(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://${SERVER_HOST}:${SERVER_PORT}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* not ready yet */ }
    await Bun.sleep(500);
  }
  return false;
}

async function ensureServerRunning(): Promise<boolean> {
  if (child && child.exitCode === null) return true; // already up

  // Another request is already warming the server — wait for it.
  if (warming) {
    return new Promise<boolean>((res) => {
      warmWaiters.push(() => res(child !== null));
    });
  }

  warming = true;
  console.log("[proxy] cold start — spawning llama-server");
  child = Bun.spawn([LLAMA_CMD, ...LLAMA_ARGS], {
    stdout: "inherit",
    stderr: "inherit",
  });

  const ready = await waitForReady();
  warming = false;

  if (!ready) {
    console.error("[proxy] llama-server failed to start within 60s");
    stopServer();
    for (const w of warmWaiters) w();
    warmWaiters = [];
    return false;
  }

  console.log("[proxy] llama-server ready");
  resetIdleTimer();
  for (const w of warmWaiters) w();
  warmWaiters = [];
  return true;
}

const server = Bun.serve({
  port: PROXY_PORT,
  hostname: SERVER_HOST,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Status endpoint: proxy health without waking the model.
    if (url.pathname === "/proxy/status") {
      const up = child !== null && child.exitCode === null;
      return Response.json({ up, idle_ms: up ? Date.now() - lastActivity : null });
    }

    const up = await ensureServerRunning();
    if (!up) {
      return new Response("llama-server failed to start", { status: 503 });
    }

    resetIdleTimer();

    // Forward request to the real server.
    const target = `http://${SERVER_HOST}:${SERVER_PORT}${url.pathname}${url.search}`;
    const headers = new Headers(req.headers);
    headers.delete("host");

    try {
      const upstream = await fetch(target, {
        method:  req.method,
        headers,
        body:    req.body,
        // @ts-ignore — Bun fetch supports duplex
        duplex:  "half",
      });
      return new Response(upstream.body, {
        status:  upstream.status,
        headers: upstream.headers,
      });
    } catch (err) {
      console.error("[proxy] upstream error", err);
      return new Response("upstream error", { status: 502 });
    }
  },
});

console.log(`[proxy] listening on ${SERVER_HOST}:${PROXY_PORT} → ${SERVER_HOST}:${SERVER_PORT}`);
console.log(`[proxy] idle timeout: ${IDLE_TIMEOUT_MS / 60000} min`);
console.log(`[proxy] /proxy/status for warm/cold state`);

// Clean shutdown.
process.on("SIGINT",  () => { stopServer(); server.stop(); process.exit(0); });
process.on("SIGTERM", () => { stopServer(); server.stop(); process.exit(0); });
