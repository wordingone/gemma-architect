#!/usr/bin/env bun
// scripts/capability-bench.ts — P8b capability benchmark harness
//
// Drives the Gemma·Architect NL agent via CDP chat path with 10 architect-grade
// prompts, exports the resulting IFC, scores against expected_checks, and writes
// a receipt to state/capability-bench-<sha>-<ts>.json.
// Exported IFCs are also saved to state/ifcs/<prompt-id>-<sha>.ifc for the
// P8d round-trip judge (bun run judge).
//
// Usage:
//   bun scripts/capability-bench.ts
//   bun scripts/capability-bench.ts --prompt sf-residence-2br   # single prompt
//   bun scripts/capability-bench.ts --dry-run                   # skip CDP/IFC, check infra
//
// Prerequisite: shared browser must be up (bun run shared-browser:start).
//
// ─── Runtime with LoRA endpoint (serve_lora.py) ───────────────────────────────
// To run with fine-tuned LoRA inference instead of in-browser WebGPU:
//
//   # 1. Start FastAPI OpenAI-compat server (port 8088)
//   #    ADAPTER_DIR = path to your fine-tuned LoRA adapter directory
//   ADAPTER_DIR=<path> USE_MTP=1 python src/serve/serve_lora.py
//
//   # 2. Start Vite dev server pointing at the remote agent
//   VITE_GEMMA_AGENT_URL=http://localhost:8088 bun run web:dev
//
//   # 3. Run bench (shared browser must be open at localhost:5175)
//   bun run capability-bench
//
//   # 4. Run P8d judge over the exported IFCs
//   bun run judge
//
// Without VITE_GEMMA_AGENT_URL, the app falls back to in-browser WebGPU
// (Gemma 4 E2B via @huggingface/transformers). Bench output is identical;
// only the inference path differs.

import { readdir, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import WebSocket from "ws";

// ─── Config ───────────────────────────────────────────────────────────────────
const REPO = resolve(import.meta.dir, "..");
const PROMPTS_DIR = join(REPO, "web/test/capability/prompts");
const STATE_DIR = join(REPO, "state");
const DOWNLOAD_TMP = join(REPO, ".tmp-bench-downloads");
const CDP_PORT = 9222;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per prompt
const PAGE_READY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ─── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const FILTER = argv.indexOf("--prompt") !== -1 ? argv[argv.indexOf("--prompt") + 1] : null;

// ─── CDP connection ───────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let msgId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function onMessage(raw: Buffer | string) {
  const msg = JSON.parse(raw.toString());
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
    }
  }
}

async function connectCDP(): Promise<void> {
  const pages = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json()) as any[];
  const page = pages.find(p => p.type === "page");
  if (!page) throw new Error("No page target at CDP /json — is shared browser up?");
  const url = page.webSocketDebuggerUrl as string;
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.on("open", resolve);
    ws.on("error", reject);
    ws.on("message", onMessage);
    ws.on("close", () => { ws = null; });
  });
}

async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (!ws || ws.readyState !== WebSocket.OPEN) await connectCDP();
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr: string): Promise<any> {
  const r = await cdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "eval threw");
  }
  return r.result?.value;
}

// ─── App helpers ──────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function poll(check: () => Promise<boolean>, intervalMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`poll timed out after ${timeoutMs}ms`);
}

// Send keyboard event (Ctrl+A or Delete) via CDP Input.dispatchKeyEvent
async function dispatchKey(key: string, ctrlKey = false): Promise<void> {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const opts = { key, code, type: "keyDown" as const, modifiers: ctrlKey ? 2 : 0 };
  await cdp("Input.dispatchKeyEvent", opts);
  await cdp("Input.dispatchKeyEvent", { ...opts, type: "keyUp" });
}

async function clearScene(): Promise<void> {
  // Select all geometry then delete it. Gives DOM focus to viewer first.
  await evaluate("document.querySelector('.palette-btn[data-tool=\"select\"]')?.click()");
  await sleep(200);
  await dispatchKey("a", true);  // Ctrl+A
  await sleep(300);
  await dispatchKey("Delete");
  await sleep(500);
}

async function ensureChatMode(): Promise<void> {
  const mode = await evaluate("document.querySelector('.mode-pill')?.dataset?.mode");
  if (mode !== "console") return; // already in prompt/chat mode
  await evaluate("document.querySelector('.mode-pill')?.click()");
  await poll(
    async () => !!(await evaluate("document.querySelector('.chat-input')")),
    300,
    5000,
  );
}

async function sendChatPrompt(text: string): Promise<void> {
  // Use React-compatible value setter so the chat textarea's onChange fires.
  await evaluate(`
    (function() {
      const el = document.querySelector('.chat-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(150);
  await evaluate("document.querySelector('.chat-send-btn')?.click()");
}

// Poll until: button back to "SEND" (not disabled, not "…").
// Then handle the optional plan-confirm step.
async function waitAgentDone(): Promise<void> {
  const deadline = Date.now() + AGENT_TIMEOUT_MS;
  let phase: "thinking" | "plan" | "done" = "thinking";

  while (Date.now() < deadline) {
    await sleep(2000);

    const state = await evaluate(`JSON.stringify({
      btnText: document.querySelector('.chat-send-btn')?.textContent ?? '',
      btnDisabled: document.querySelector('.chat-send-btn')?.disabled ?? true,
      hasThinking: !!document.querySelector('.chat-thinking'),
      hasPlanBtn: !!document.querySelector('.chat-plan-run-btn'),
      planPending: document.querySelectorAll('.chat-plan-pending').length,
      hasError: !!document.querySelector('.chat-msg-error')
    })`);
    const s = JSON.parse(state);

    if (s.hasError) {
      const errText = await evaluate(
        "[...document.querySelectorAll('.chat-msg-error')].map(e=>e.textContent).join(' | ')"
      ) as string;
      throw new Error(`Agent error: ${errText.slice(0, 200)}`);
    }

    if (phase === "thinking") {
      // Waiting for model generation to finish (send button re-enables)
      if (!s.btnDisabled && s.btnText === "SEND" && !s.hasThinking) {
        if (s.hasPlanBtn) {
          // Complex plan shown — click "Run plan" automatically
          console.log("    clicking Run plan...");
          await evaluate("document.querySelector('.chat-plan-run-btn')?.click()");
          phase = "plan";
        } else {
          phase = "done";
        }
      }
    } else if (phase === "plan") {
      // Waiting for plan execution (.chat-plan-pending gone)
      if (s.planPending === 0) {
        phase = "done";
      }
    }

    if (phase === "done") return;
  }
  throw new Error(`Agent did not complete within ${AGENT_TIMEOUT_MS / 1000}s`);
}

async function exportIFC(): Promise<string> {
  // Clean download dir
  try {
    const prev = await readdir(DOWNLOAD_TMP);
    await Promise.all(prev.filter(f => f.endsWith(".ifc")).map(f => rm(join(DOWNLOAD_TMP, f))));
  } catch { /* dir may be empty */ }

  await evaluate("document.querySelector('.exp-btn[data-fmt=\"ifc\"]')?.click()");

  // Poll for new .ifc file
  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const files = await readdir(DOWNLOAD_TMP);
      const ifc = files.find(f => f.endsWith(".ifc") && !f.endsWith(".crdownload"));
      if (ifc) return join(DOWNLOAD_TMP, ifc);
    } catch { /* ignore */ }
  }
  throw new Error(`IFC download did not appear in ${DOWNLOAD_TMP} within ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
}

// ─── IFC check types ──────────────────────────────────────────────────────────
type CheckSpec = {
  id: string;
  description: string;
  type: "count" | "dimension" | "area" | "z_extent" | "presence" | "door_width";
  target?: string;
  tag_contains?: string;
  axis?: "X" | "Y" | "Z";
  min?: number;
  max?: number;
  exact?: number;
  min_width?: number;
};

type CheckResult = {
  id: string;
  pass: boolean;
  actual?: number | null;
  reason: string;
};

// Count IFC entities by class name, with optional name-field substring filter.
// Handles: IFCWALL, IFCSPACE, IFCDOOR, IFCBUILDINGSTOREY, IFCROOF, etc.
function countEntities(text: string, target: string, tagContains?: string): number {
  const cls = target.toUpperCase();
  if (!tagContains) {
    // Fast path: count all occurrences.
    let n = 0;
    let i = text.indexOf(cls + "(");
    while (i !== -1) { n++; i = text.indexOf(cls + "(", i + 1); }
    return n;
  }
  // Capture the Name argument (3rd positional string, after GlobalId + OwnerHistory).
  // IFC text format: IFCSPACE('GUID',#H,'Name','Desc',...
  const needle = tagContains.toLowerCase();
  const re = new RegExp(`${cls}\\('[^']*',(?:\\$|[^,]+),'([^']*)'`, "g");
  let n = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1].toLowerCase().includes(needle)) n++;
  }
  return n;
}

function scoreCount(c: CheckSpec, text: string): CheckResult {
  const n = countEntities(text, c.target!, c.tag_contains);
  const pass =
    (c.min === undefined || n >= c.min) &&
    (c.max === undefined || n <= c.max) &&
    (c.exact === undefined || n === c.exact);
  return { id: c.id, pass, actual: n, reason: `${c.target}${c.tag_contains ? `[~"${c.tag_contains}"]` : ""}: found ${n}; min=${c.min ?? "—"} max=${c.max ?? "—"}` };
}

function scorePresence(c: CheckSpec, text: string): CheckResult {
  const n = countEntities(text, c.target!);
  return { id: c.id, pass: n > 0, actual: n, reason: `${c.target}: ${n} instance(s)` };
}

function scoreDimension(c: CheckSpec, bbox: BBox | null): CheckResult {
  if (!bbox) return { id: c.id, pass: false, actual: null, reason: "empty scene — no geometry" };
  const span = c.axis === "X" ? bbox.maxX - bbox.minX
             : c.axis === "Y" ? bbox.maxY - bbox.minY
             : bbox.maxZ - bbox.minZ;
  const v = +span.toFixed(3);
  const pass = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
  return { id: c.id, pass, actual: v, reason: `${c.axis}-span=${v}m; range=[${c.min},${c.max}]` };
}

function scoreArea(c: CheckSpec, text: string, bbox: BBox | null): CheckResult {
  // Try IfcQuantityArea first (exported by some IFC writers)
  let area = 0;
  const qaRe = /IFCQUANTITYAREA\('[^']*','[^']*',\$,([.\d]+)/g;
  let m: RegExpExecArray | null;
  while ((m = qaRe.exec(text)) !== null) { area += parseFloat(m[1]); }

  // Fallback: sum IfcSpace GrossFloorArea properties (text scanning)
  if (area === 0) {
    const spaceRe = /IFCSPACE\([^;]+\)/g;
    // area embedded in IFCPROPERTYSINGLEVALUE or IFCQUANTITYAREA lines near spaces is unreliable
    // — fall through to bbox
  }

  // Final fallback: footprint bounding box product
  if (area === 0 && bbox) {
    area = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
  }

  const v = +area.toFixed(1);
  const pass = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
  return { id: c.id, pass, actual: v, reason: `area=${v}m²; range=[${c.min},${c.max}]` };
}

function scoreZExtent(c: CheckSpec, bbox: BBox | null): CheckResult {
  if (!bbox) return { id: c.id, pass: false, actual: null, reason: "empty scene — no geometry" };
  const v = +(bbox.maxZ - bbox.minZ).toFixed(3);
  const pass = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
  return { id: c.id, pass, actual: v, reason: `Z-extent=${v}m; range=[${c.min},${c.max}]` };
}

function scoreDoorWidth(c: CheckSpec, text: string): CheckResult {
  const minW = c.min_width ?? 0;
  // IfcDoor in IFC4: IFCDOOR(GlobalId,OwnerHistory,Name,Desc,ObjectType,ObjectPlacement,
  //   Representation,Tag,PredefinedType,OverallHeight,OverallWidth)
  // OverallWidth is 11th arg (index 10, zero-based).
  const lineRe = /IFCDOOR\(([^;]+)\)/g;
  let minFound = Infinity;
  let count = 0;
  let allPass = true;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    const parts = m[1].split(",");
    // Try index 10 (OverallWidth IFC4), then 9 (IFC2x3 fallback)
    for (const idx of [10, 9, 8]) {
      const raw = parts[idx]?.trim();
      if (!raw) continue;
      const v = parseFloat(raw);
      if (!isNaN(v) && v > 0.1) { // skip implausible values
        count++;
        minFound = Math.min(minFound, v);
        if (v < minW) allPass = false;
        break;
      }
    }
  }
  if (count === 0) return { id: c.id, pass: false, actual: null, reason: "no IFCDOOR entities with parseable width" };
  const v = +minFound.toFixed(3);
  return { id: c.id, pass: allPass, actual: v, reason: `min door width=${v}m; required≥${minW}; ${count} door(s)` };
}

// ─── Bounding box via web-ifc ─────────────────────────────────────────────────
type BBox = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

async function computeBBox(buf: Buffer): Promise<BBox | null> {
  try {
    const { IfcAPI } = await import("web-ifc");
    const api = new IfcAPI();
    await api.Init();
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true } as any);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let hasVerts = false;

    api.StreamAllMeshes(modelID, (flatMesh: any) => {
      const sz = flatMesh.geometries.size();
      for (let j = 0; j < sz; j++) {
        const placed = flatMesh.geometries.get(j);
        const geom = api.GetGeometry(modelID, placed.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()) as Float32Array;
        const m = placed.flatTransformation as number[];
        for (let v = 0; v < verts.length; v += 6) {
          hasVerts = true;
          const x = verts[v], y = verts[v + 1], z = verts[v + 2];
          // column-major matrix: wx = m[0]*x + m[4]*y + m[8]*z + m[12]
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
          if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
        }
      }
    });

    api.CloseModel(modelID);
    if (!hasVerts) return null;
    return { minX, maxX, minY, maxY, minZ, maxZ };
  } catch (e) {
    console.error("    bbox error:", (e as Error).message);
    return null;
  }
}

// ─── Score one prompt's IFC against all expected_checks ───────────────────────
async function scoreIFC(ifcPath: string, checks: CheckSpec[]): Promise<CheckResult[]> {
  const buf = await readFile(ifcPath);
  const text = buf.toString("utf-8");
  const needsGeom = checks.some(c => ["dimension", "area", "z_extent"].includes(c.type));
  const bbox = needsGeom ? await computeBBox(buf) : null;

  return checks.map(c => {
    switch (c.type) {
      case "count":      return scoreCount(c, text);
      case "presence":   return scorePresence(c, text);
      case "dimension":  return scoreDimension(c, bbox);
      case "area":       return scoreArea(c, text, bbox);
      case "z_extent":   return scoreZExtent(c, bbox);
      case "door_width": return scoreDoorWidth(c, text);
      default:           return { id: c.id, pass: false, actual: null, reason: `unknown check type: ${(c as any).type}` };
    }
  });
}

// ─── Prompt type ─────────────────────────────────────────────────────────────
type PromptFile = {
  id: string;
  category: string;
  prompt: string;
  min_pass_threshold: number;
  expected_checks: CheckSpec[];
};

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Load prompts
  const files = await readdir(PROMPTS_DIR);
  let prompts: PromptFile[] = [];
  for (const f of files.filter(f => f.endsWith(".json"))) {
    const p: PromptFile = JSON.parse(await readFile(join(PROMPTS_DIR, f), "utf-8"));
    if (!FILTER || p.id === FILTER) prompts.push(p);
  }
  if (prompts.length === 0) throw new Error(`No prompts found (filter: ${FILTER ?? "none"})`);
  console.log(`Loaded ${prompts.length} prompt(s)`);

  const sha = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 19);

  await mkdir(DOWNLOAD_TMP, { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });

  if (!DRY_RUN) {
    await connectCDP();
    console.log("CDP connected");
    await cdp("Page.enable");
    await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_TMP });

    // Verify model is loaded before starting the bench run.
    const badge = await evaluate("document.getElementById('ai-model-badge')?.textContent?.trim() ?? ''") as string;
    console.log(`Model status: ${badge}`);
    if (!badge.includes("LIVE")) {
      console.log("Waiting up to 90s for model to load...");
      await poll(
        async () => ((await evaluate("document.getElementById('ai-model-badge')?.textContent ?? ''")) as string).includes("LIVE"),
        3000,
        90_000,
      );
      console.log("Model ready.");
    }

    // Ensure chat mode is active for the whole bench run.
    await ensureChatMode();
  }

  const results: any[] = [];
  const startAll = Date.now();

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const t0 = Date.now();
    console.log(`\n[${i + 1}/${prompts.length}] ${p.id} (${p.category})`);
    console.log(`  "${p.prompt.slice(0, 100)}${p.prompt.length > 100 ? "…" : ""}"`);

    if (DRY_RUN) {
      results.push({ id: p.id, skipped: true, reason: "dry-run" });
      continue;
    }

    let error: string | null = null;
    let checkResults: CheckResult[] = [];
    let ifcPath: string | null = null;

    try {
      // Clear geometry from previous run (no page reload — preserves GPU/ONNX state).
      if (i > 0) {
        console.log("  clearing scene...");
        await clearScene();
      }

      console.log("  sending prompt...");
      await sendChatPrompt(p.prompt);

      console.log("  waiting for agent...");
      await waitAgentDone();
      console.log(`  agent done (${Math.round((Date.now() - t0) / 1000)}s)`);

      console.log("  exporting IFC...");
      ifcPath = await exportIFC();
      console.log(`  downloaded: ${ifcPath}`);

      // Persist IFC for judge.ts (P8d round-trip judge)
      const ifcsDir = join(STATE_DIR, "ifcs");
      await mkdir(ifcsDir, { recursive: true });
      const savedIFCPath = join(ifcsDir, `${p.id}-${sha}.ifc`);
      await copyFile(ifcPath, savedIFCPath);
      console.log(`  saved: ${savedIFCPath}`);

      console.log("  scoring...");
      checkResults = await scoreIFC(ifcPath, p.expected_checks);
    } catch (e: any) {
      error = e.message;
      console.error(`  ERROR: ${e.message}`);
    }

    const passed = checkResults.filter(c => c.pass).length;
    const total = p.expected_checks.length;
    const score = total > 0 ? passed / total : 0;
    const ok = error === null && score >= p.min_pass_threshold;
    const elapsed = Math.round((Date.now() - t0) / 1000);

    if (checkResults.length > 0) {
      checkResults.forEach(c =>
        console.log(`    ${c.pass ? "✓" : "✗"} ${c.id}: ${c.reason}`)
      );
    }
    console.log(`  → ${ok ? "PASS" : "FAIL"} ${passed}/${total} (${(score * 100).toFixed(0)}%) in ${elapsed}s`);

    results.push({
      id: p.id,
      category: p.category,
      pass: ok,
      score: +score.toFixed(3),
      checks_passed: passed,
      checks_total: total,
      min_pass_threshold: p.min_pass_threshold,
      elapsed_s: elapsed,
      error,
      check_details: checkResults,
    });
  }

  const totalPassed = results.filter(r => r.pass).length;
  const totalRun = results.filter(r => !r.skipped).length;
  const elapsedAll = Math.round((Date.now() - startAll) / 1000);
  const passRate = totalRun > 0 ? +(totalPassed / totalRun).toFixed(3) : 0;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Summary: ${totalPassed}/${totalRun} prompts pass (${(passRate * 100).toFixed(0)}%)`);
  console.log(`Total time: ${Math.floor(elapsedAll / 60)}m ${elapsedAll % 60}s`);

  const receipt = {
    sha,
    ran_at: new Date().toISOString(),
    prompts_run: totalRun,
    prompts_passed: totalPassed,
    pass_rate: passRate,
    elapsed_s: elapsedAll,
    results,
  };

  const receiptPath = join(STATE_DIR, `capability-bench-${sha}-${ts}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`Receipt: ${receiptPath}`);

  if (ws) ws.close();
}

main().catch(e => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
