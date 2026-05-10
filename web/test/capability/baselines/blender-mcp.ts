#!/usr/bin/env bun
// web/test/capability/baselines/blender-mcp.ts — P8c Blender MCP baseline
//
// Drives Blender via blender-mcp (https://github.com/ahujasid/blender-mcp) for
// each P8a prompt, exports the resulting scene to IFC via Bonsai, then scores
// against expected_checks. Used as the "Blender MCP" comparison row in the
// umbrella #100 comparison table.
//
// Usage:
//   bun web/test/capability/baselines/blender-mcp.ts
//   bun web/test/capability/baselines/blender-mcp.ts --prompt sf-residence-2br
//
// Prerequisites:
//   1. Blender 4.x with blender-mcp addon installed and running:
//        https://github.com/ahujasid/blender-mcp — enable addon → server starts on port 3000
//   2. Bonsai IFC exporter installed in Blender:
//        https://bonsaibim.org/ — install via Blender addon manager
//   3. BLENDER_MCP_URL env var (default: http://localhost:3000)
//
// Architecture:
//   For each prompt:
//     1. Clear Blender scene
//     2. POST the prompt to an LLM (JUDGE_URL or Anthropic) requesting Blender Python
//     3. Execute the returned Python in Blender via blender-mcp /execute_code endpoint
//     4. Export scene to IFC via Bonsai Python: bpy.ops.export_ifc.bim(filepath=...)
//     5. Score exported IFC with scoreCheck()

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const REPO = resolve(import.meta.dir, "../../../../");
const PROMPTS_DIR = join(REPO, "web/test/capability/prompts");
const STATE_DIR = join(REPO, "state");
const BLENDER_MCP_URL = process.env.BLENDER_MCP_URL ?? "http://localhost:3000";
const JUDGE_URL = process.env.JUDGE_URL;
const MAX_TOKENS = 8192;
const BLENDER_TIMEOUT_MS = 120_000;

// ─── CLI ──────────────────────────────────────────────────────────────────────
let FILTER: string | null = null;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--prompt" && process.argv[i + 1]) {
    FILTER = process.argv[++i];
  }
}

// ─── Shared types ─────────────────────────────────────────────────────────────
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

// ─── Text-only scoring (geometry checks need the IFC file, done via scoreIFC) ─
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
    return { id: c.id, pass: false, actual: null, reason: "no IFC exported from Blender" };
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
    case "dimension":
    case "area":
    case "z_extent":
      // These require web-ifc bbox computation. For the Blender baseline, Bonsai exports
      // geometry-rich IFC; a future enhancement can wire web-ifc here. For now: text-only.
      return { id: c.id, pass: false, actual: null, reason: `${c.type}: geometry scoring not wired for Blender baseline (future: web-ifc)` };
    default:
      return { id: c.id, pass: false, actual: null, reason: `unknown check type: ${(c as any).type}` };
  }
}

// ─── LLM call: generate Blender Python from architecture prompt ───────────────
const BLENDER_SYSTEM = `You are an expert architectural assistant using Blender 4.x with Bonsai IFC add-on.
When given an architectural brief, respond with ONLY valid Blender Python code (no markdown fences, no explanations).
The code must:
1. Use bpy.ops and bpy.data to create the described building geometry.
2. Use Bonsai (blenderbim) API to assign IFC types: IfcWall, IfcSlab, IfcSpace, IfcBuildingStorey, IfcDoor, IfcWindow, IfcRoof.
3. End with: bpy.ops.export_ifc.bim(filepath=OUTPUT_PATH) where OUTPUT_PATH is the string passed in.
Do not include import statements for bpy (already available in Blender context).`;

async function generateBlenderPython(prompt: string, outputPath: string): Promise<string> {
  const userMsg = `${prompt}\n\nPlace the IFC export call at the end with filepath="${outputPath}".`;

  // Try JUDGE_URL (serve_lora.py OpenAI-compat) first
  if (JUDGE_URL) {
    const res = await fetch(`${JUDGE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma-4-e2b-it",
        messages: [
          { role: "system", content: BLENDER_SYSTEM },
          { role: "user", content: userMsg },
        ],
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content ?? "";
    }
  }

  throw new Error("JUDGE_URL endpoint unreachable and no fallback configured. Set JUDGE_URL to a running llama-server.");
}

// ─── Blender MCP execute ──────────────────────────────────────────────────────
async function blenderExecute(code: string): Promise<{ result: string; error?: string }> {
  const res = await fetch(`${BLENDER_MCP_URL}/execute_code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(BLENDER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`blender-mcp /execute_code returned ${res.status}: ${await res.text().catch(() => "")}`);
  return await res.json() as any;
}

async function blenderClearScene(): Promise<void> {
  await blenderExecute(`
import bpy
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
# Clear IFC data
if hasattr(bpy.context.scene, 'BIMProperties'):
    bpy.ops.bim.new_project()
`);
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
  console.log(`Loaded ${prompts.length} prompt(s)  |  blender-mcp: ${BLENDER_MCP_URL}`);

  // Verify blender-mcp reachable
  try {
    const probe = await blenderExecute("print('blender-mcp alive')");
    console.log(`blender-mcp reachable ✓  (response: ${JSON.stringify(probe).slice(0, 80)})`);
  } catch (e: any) {
    console.error(`\nERROR: blender-mcp not reachable at ${BLENDER_MCP_URL}`);
    console.error("  Install blender-mcp addon: https://github.com/ahujasid/blender-mcp");
    console.error("  Enable addon in Blender → it starts a server on port 3000");
    console.error(`  Reason: ${e.message}`);
    process.exit(1);
  }

  const sha = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  await mkdir(STATE_DIR, { recursive: true });

  // Temp dir for IFC exports
  const tmpDir = join(tmpdir(), `blender-mcp-${ts}`);
  await mkdir(tmpDir, { recursive: true });

  type PromptResult = {
    id: string;
    category: string;
    pass: boolean;
    score: number;
    checks_passed: number;
    checks_total: number;
    ifc_exported: boolean;
    ifc_length: number;
    check_results: CheckResult[];
    blender_error?: string;
    error: string | null;
    elapsed_s: number;
  };

  const results: PromptResult[] = [];

  for (const p of prompts) {
    const t0 = Date.now();
    let error: string | null = null;
    let checkResults: CheckResult[] = [];
    let ifcText: string | null = null;
    let blender_error: string | undefined;

    console.log(`\n[${p.id}]`);
    const ifcPath = join(tmpDir, `${p.id}.ifc`).replace(/\\/g, "/");

    try {
      // Step 1: clear Blender scene
      console.log("  clearing Blender scene...");
      await blenderClearScene();

      // Step 2: generate Blender Python from prompt
      console.log("  generating Blender Python...");
      let code = await generateBlenderPython(p.prompt, ifcPath);
      // Strip markdown fences if model included them
      code = code.replace(/^```(?:python)?\n?/m, "").replace(/\n?```$/m, "").trim();
      console.log(`  code: ${code.split("\n").length} lines`);

      // Step 3: execute in Blender
      console.log("  executing in Blender...");
      const blenderResult = await blenderExecute(code);
      if (blenderResult.error) {
        blender_error = blenderResult.error;
        console.warn(`  Blender error: ${blenderResult.error.slice(0, 200)}`);
      }

      // Step 4: read exported IFC
      try {
        ifcText = await readFile(ifcPath, "utf-8");
        console.log(`  IFC exported: ${ifcText.length} chars`);
      } catch {
        console.log("  no IFC file written by Blender");
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
      ifc_exported: ifcText !== null,
      ifc_length: ifcText?.length ?? 0,
      check_results: checkResults,
      ...(blender_error ? { blender_error } : {}),
      error,
      elapsed_s: elapsed,
    });
  }

  const k = results.filter(r => r.pass).length;
  const n = results.length;
  const ifc_rate = results.filter(r => r.ifc_exported).length;

  console.log(`\n=== BASELINE: Blender MCP + Bonsai IFC ===`);
  console.log(`K=${k}/${n}  |  IFC exported: ${ifc_rate}/${n}  |  SHA=${sha}`);

  const receipt = {
    runner: "blender-mcp",
    blender_mcp_url: BLENDER_MCP_URL,
    sha,
    timestamp: ts,
    k, n,
    ifc_exported: ifc_rate,
    results,
  };

  const receiptPath = join(STATE_DIR, `capability-bench-baseline-blender-mcp-${ts}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`Receipt: ${receiptPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
