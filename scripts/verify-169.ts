// Verification script for fix/169 — sidebar resize + no content clipping.
// Run: bun run scripts/verify-169.ts
import WebSocket from "ws";

const CDP_PORT = 9222;
const DEV_URL = "http://localhost:5173/";

async function cdpSession(): Promise<WebSocket> {
  const list = await fetch(`http://localhost:${CDP_PORT}/json/list`).then(r => r.json()) as Array<{ type: string; webSocketDebuggerUrl: string; url: string }>;
  const tab = list.find(t => t.type === "page") ?? list[0];
  if (!tab) throw new Error("No CDP tab found");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  return ws;
}

let _id = 1;
function send(ws: WebSocket, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = _id++;
  return new Promise((res, rej) => {
    const handler = (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        ws.off("message", handler);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(ws: WebSocket, expression: string): Promise<unknown> {
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error(`Eval error: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("Connecting to CDP...");
  const ws = await cdpSession();
  console.log("Connected.");

  // Navigate to fix branch dev server
  await send(ws, "Page.navigate", { url: DEV_URL });
  await sleep(3000);
  console.log(`Navigated to ${DEV_URL}`);

  const results: Array<{ name: string; passed: boolean; evidence: unknown }> = [];

  // Test 1: resize handle exists in DOM
  const handleExists = await evaluate(ws, "!!document.querySelector('.sidebar-resize-handle')");
  results.push({ name: "resize-handle-exists", passed: !!handleExists, evidence: { handleExists } });
  console.log("T1 resize-handle-exists:", handleExists);

  // Test 2: at 1920×1080 — filterPanel inside sb-body, snap inside sb-body
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  const t2 = await evaluate(ws, `(() => {
    const body = document.querySelector('.sb-body');
    if (!body) return { error: 'no .sb-body' };
    const filterInBody = !!body.querySelector('.selection-filters-panel, .filter-panel, [class*="filter"]');
    const snapInBody = !!body.querySelector('.snap-dock');
    const scrollH = body.scrollHeight;
    const clientH = body.clientHeight;
    return { filterInBody, snapInBody, scrollH, clientH, overflows: scrollH > clientH };
  })()`);
  const t2v = t2 as { error?: string; filterInBody?: boolean; snapInBody?: boolean; scrollH?: number; clientH?: number; overflows?: boolean };
  const t2pass = !t2v.error && (t2v.filterInBody === true || t2v.snapInBody === true);
  results.push({ name: "content-inside-body-1920", passed: t2pass, evidence: t2v });
  console.log("T2 content-inside-body-1920:", JSON.stringify(t2v));

  // Test 3: at 1280×720 — same check
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  const t3 = await evaluate(ws, `(() => {
    const body = document.querySelector('.sb-body');
    if (!body) return { error: 'no .sb-body' };
    const snapInBody = !!body.querySelector('.snap-dock');
    const sidebar = document.querySelector('.sidebar');
    const sidebarOverflowH = sidebar ? sidebar.scrollHeight > sidebar.clientHeight : false;
    // With overflow:hidden on sidebar, content clipped if scrollHeight > clientHeight
    // Now with snap inside body, sidebar.scrollHeight == body.scrollHeight (tabs + body)
    return { snapInBody, sidebarScrollH: sidebar?.scrollHeight, sidebarClientH: sidebar?.clientHeight, bodyScrollH: body.scrollHeight };
  })()`);
  const t3v = t3 as { snapInBody?: boolean; sidebarScrollH?: number; sidebarClientH?: number; bodyScrollH?: number };
  const t3pass = !!t3v.snapInBody;
  results.push({ name: "content-inside-body-1280", passed: t3pass, evidence: t3v });
  console.log("T3 content-inside-body-1280:", JSON.stringify(t3v));

  // Test 4: simulate drag — set CSS var directly and verify grid changes
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(300);

  const t4 = await evaluate(ws, `(() => {
    const wb = document.querySelector('.workbench');
    if (!wb) return { error: 'no .workbench' };
    const beforeCols = getComputedStyle(wb).gridTemplateColumns;
    wb.style.setProperty('--sidebar-w', '400px');
    const afterCols = getComputedStyle(wb).gridTemplateColumns;
    wb.style.removeProperty('--sidebar-w'); // restore
    return { beforeCols, afterCols, changed: beforeCols !== afterCols };
  })()`);
  const t4v = t4 as { error?: string; beforeCols?: string; afterCols?: string; changed?: boolean };
  const t4pass = !t4v.error && !!t4v.changed;
  results.push({ name: "css-var-resize-works", passed: t4pass, evidence: t4v });
  console.log("T4 css-var-resize-works:", JSON.stringify(t4v));

  const allPassed = results.every(r => r.passed);
  const out = { sha: "fix/169-sidebar-resize", ran_at: new Date().toISOString(), all_passed: allPassed, results };
  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(out, null, 2));

  const outPath = `B:/M/gemma-architect/state/verify-169-${Date.now()}.json`;
  const { writeFileSync } = await import("fs");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Written:", outPath);

  ws.close();
}

main().catch(e => { console.error(e); process.exit(1); });
