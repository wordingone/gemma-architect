#!/usr/bin/env bun
// web/test/capability/baselines/bare-gemma.ts — P8c bare-Gemma baseline
//
// Sends each P8a prompt directly to Gemma 4 E2B-it WITHOUT the gemma-architect
// dispatch / palette / autoplan layer. Captures text output and any IFC blocks.
// Scores against expected_checks. K=0 expected (this is the floor baseline;
// the delta vs gemma-architect measures the app's contribution).
//
// Usage:
//   BARE_GEMMA_URL=http://localhost:8089 bun web/test/capability/baselines/bare-gemma.ts
//   bun web/test/capability/baselines/bare-gemma.ts --prompt sf-residence-2br
//
// Prerequisite: an OpenAI-compat server running base Gemma 4 E2B-it WITHOUT LoRA.
//   llama.cpp example:
//     build/bin/Release/llama-server \
//       --model gemma-4-e2b-it-Q4_K_M.gguf \
//       --host 127.0.0.1 --port 8089 --ctx-size 32768
//
//   HuggingFace TGI example:
//     text-generation-launcher --model-id google/gemma-4-e2b-it --port 8089
//
// Note: VITE_GEMMA_AGENT_URL / JUDGE_URL (serve_lora.py) are the FINE-TUNED
// LoRA endpoint — not the same as bare Gemma. Use a separate server instance.

import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

const REPO = resolve(import.meta.dir, "../../../../");
const PROMPTS_DIR = join(REPO, "web/test/capability/prompts");
const STATE_DIR = join(REPO, "state");
const BARE_GEMMA_URL = process.env.BARE_GEMMA_URL ?? "http://localhost:8089";
const MAX_TOKENS = 4096;
const IFC_CHAR_LIMIT = 48_000;

// ─── CLI ──────────────────────────────────────────────────────────────────────
let FILTER: string | null = null;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--prompt" && process.argv[i + 1]) {
    FILTER = process.argv[++i];
  }
}

// ─── Shared types (mirrors capability-bench.ts) ───────────────────────────────
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

type PromptFile = {
  id: string;
  category: string;
  prompt: string;
  min_pass_threshold: number;
  expected_checks: CheckSpec[];
};

// ─── Scoring (text-only — geometry checks always fail for bare model) ─────────
function countEntities(text: string, target: string, tagContains?: string): number {
  const cls = target.toUpperCase();
  if (!tagContains) {
    let n = 0;
    let i = text.indexOf(cls + "(");
    while (i !== -1) { n++; i = text.indexOf(cls + "(", i + 1); }
    return n;
  }
  const needle = tagContains.toLowerCase();
  const re = new RegExp(`${cls}\\('[^']*',(?:\\$|[^,]+),'([^']*)'`, "g");
  let n = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1].toLowerCase().includes(needle)) n++;
  }
  return n;
}

function scoreCheck(c: CheckSpec, ifcText: string | null): CheckResult {
  if (!ifcText) {
    return { id: c.id, pass: false, actual: null, reason: "no IFC block emitted by model" };
  }
  switch (c.type) {
    case "count": {
      const n = countEntities(ifcText, c.target!, c.tag_contains);
      const pass =
        (c.min === undefined || n >= c.min) &&
        (c.max === undefined || n <= c.max) &&
        (c.exact === undefined || n === c.exact);
      return { id: c.id, pass, actual: n, reason: `${c.target}${c.tag_contains ? `[~"${c.tag_contains}"]` : ""}: found ${n}` };
    }
    case "presence": {
      const n = countEntities(ifcText, c.target!);
      return { id: c.id, pass: n > 0, actual: n, reason: `${c.target}: ${n} instance(s)` };
    }
    case "door_width": {
      // IFCDOOR(..., OverallHeight, OverallWidth) — width is last positional float
      const re = /IFCDOOR\([^;]+,([.\d]+),([.\d]+)\)/g;
      let m: RegExpExecArray | null;
      let pass = false;
      let found = "none";
      while ((m = re.exec(ifcText)) !== null) {
        const w = parseFloat(m[2]);
        if (c.min_width === undefined || w >= c.min_width) { pass = true; found = `${w}m`; break; }
      }
      return { id: c.id, pass, reason: `door_width: ${found}; min=${c.min_width}m` };
    }
    // Geometry-dependent checks always fail — bare model emits text, not computed geometry.
    case "dimension":
    case "area":
    case "z_extent":
      return { id: c.id, pass: false, actual: null, reason: `${c.type} requires geometry computation — not available for bare model` };
    default:
      return { id: c.id, pass: false, actual: null, reason: `unknown check type: ${(c as any).type}` };
  }
}

// ─── IFC extraction ───────────────────────────────────────────────────────────
function extractIFC(text: string): string | null {
  const start = text.indexOf("ISO-10303-21;");
  if (start === -1) return null;
  const end = text.indexOf("END-ISO-10303-21;", start);
  if (end === -1) return null;
  return text.slice(start, end + "END-ISO-10303-21;".length);
}

// ─── Model call ───────────────────────────────────────────────────────────────
async function callBareGemma(prompt: string): Promise<string> {
  const body = {
    model: "gemma-4-e2b-it",
    messages: [{ role: "user", content: prompt }],
    max_tokens: MAX_TOKENS,
    temperature: 0.1,
  };

  const res = await fetch(`${BARE_GEMMA_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`bare-gemma endpoint ${BARE_GEMMA_URL} returned ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? "";
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const files = await readdir(PROMPTS_DIR);
  let prompts: PromptFile[] = [];
  for (const f of files.filter(f => f.endsWith(".json"))) {
    const p: PromptFile = JSON.parse(await readFile(join(PROMPTS_DIR, f), "utf-8"));
    if (!FILTER || p.id === FILTER) prompts.push(p);
  }
  if (prompts.length === 0) throw new Error(`No prompts found (filter: ${FILTER ?? "none"})`);
  console.log(`Loaded ${prompts.length} prompt(s)  |  endpoint: ${BARE_GEMMA_URL}`);

  // Verify endpoint reachable
  try {
    const probe = await fetch(`${BARE_GEMMA_URL}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
    console.log("Endpoint reachable ✓");
  } catch (e: any) {
    console.error(`\nERROR: bare-gemma endpoint not reachable at ${BARE_GEMMA_URL}`);
    console.error(`  Start a base Gemma 4 E2B-it server (no LoRA) on that port.`);
    console.error(`  Reason: ${e.message}`);
    process.exit(1);
  }

  const sha = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await mkdir(STATE_DIR, { recursive: true });

  type PromptResult = {
    id: string;
    category: string;
    pass: boolean;
    score: number;
    checks_passed: number;
    checks_total: number;
    ifc_emitted: boolean;
    ifc_length: number;
    raw_chars: number;
    check_results: CheckResult[];
    error: string | null;
    elapsed_s: number;
  };

  const results: PromptResult[] = [];

  for (const p of prompts) {
    const t0 = Date.now();
    let error: string | null = null;
    let checkResults: CheckResult[] = [];
    let ifcText: string | null = null;
    let rawText = "";

    console.log(`\n[${p.id}]`);
    try {
      console.log("  calling bare model...");
      rawText = await callBareGemma(p.prompt);
      console.log(`  response: ${rawText.length} chars`);

      ifcText = extractIFC(rawText);
      if (ifcText) {
        console.log(`  IFC block found: ${ifcText.length} chars`);
        if (ifcText.length > IFC_CHAR_LIMIT) ifcText = ifcText.slice(0, IFC_CHAR_LIMIT);
      } else {
        console.log("  no IFC block in response");
      }

      checkResults = p.expected_checks.map(c => scoreCheck(c, ifcText));
    } catch (e: any) {
      error = e.message;
      console.error(`  ERROR: ${e.message}`);
      checkResults = p.expected_checks.map(c => ({ id: c.id, pass: false, actual: null, reason: `error: ${e.message}` }));
    }

    const passed = checkResults.filter(c => c.pass).length;
    const total = p.expected_checks.length;
    const score = total > 0 ? passed / total : 0;
    const ok = error === null && score >= p.min_pass_threshold;
    const elapsed = Math.round((Date.now() - t0) / 1000);

    checkResults.forEach(c => console.log(`    ${c.pass ? "✓" : "✗"} ${c.id}: ${c.reason}`));
    console.log(`  → ${ok ? "PASS" : "FAIL"} ${passed}/${total} (${(score * 100).toFixed(0)}%) in ${elapsed}s`);

    results.push({
      id: p.id,
      category: p.category,
      pass: ok,
      score: +score.toFixed(3),
      checks_passed: passed,
      checks_total: total,
      ifc_emitted: ifcText !== null,
      ifc_length: ifcText?.length ?? 0,
      raw_chars: rawText.length,
      check_results: checkResults,
      error,
      elapsed_s: elapsed,
    });
  }

  const k = results.filter(r => r.pass).length;
  const n = results.length;
  const ifc_rate = results.filter(r => r.ifc_emitted).length;

  console.log(`\n=== BASELINE: bare-Gemma 4 E2B-it ===`);
  console.log(`K=${k}/${n}  |  IFC emitted: ${ifc_rate}/${n}  |  SHA=${sha}`);

  const receipt = {
    runner: "bare-gemma",
    model: "gemma-4-e2b-it",
    endpoint: BARE_GEMMA_URL,
    sha,
    timestamp: ts,
    k, n,
    ifc_emitted: ifc_rate,
    results,
  };

  const receiptPath = join(STATE_DIR, `capability-bench-baseline-bare-gemma-${ts}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`Receipt: ${receiptPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
