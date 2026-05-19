#!/usr/bin/env bun
// demo-prompt-harness.ts — SU-6 end-to-end acceptance harness (#413)
//
// Runs 1 or all 5 variant prompts against the live :5847 dev server via CDP.
// For each prompt: calls window.__runDesignLoop, checks dispatch coverage,
// asserts minimum IFC element classes per the #413 AC.
//
// Usage:
//   bun scripts/demo-prompt-harness.ts [--prompt-index N] [--max-turns M] [--out PATH]
//
//   --prompt-index N  Run only prompt N (0-4, default: all 5).
//   --max-turns M     Max turns per runDesignLoop call (default: 3).
//   --out PATH        JSONL output path (default: stdout only).

import { appendFileSync } from "fs";
import { CDP_PORT, DEV_PORT } from "./ports.ts";

// ── Prompt suite (5 variants per #413 AC) ─────────────────────────────────────

const PROMPTS: Array<{
  label: string;
  text: string;
  required: string[];          // verb names that must appear ≥1 time
  minCounts?: Record<string, number>; // verb → minimum count
}> = [
  {
    label: "design-a-house",
    text: "Design a house",
    required: ["IfcLevel", "IfcSlab", "IfcWall", "IfcDoor", "IfcWindow", "IfcRoof", "SdExport"],
  },
  {
    label: "design-an-apartment",
    text: "Design an apartment",
    required: ["IfcLevel", "IfcSlab", "IfcWall", "IfcDoor", "IfcWindow", "IfcRoof", "SdExport"],
  },
  {
    label: "design-2-storey-house",
    text: "Design a 2-storey house",
    required: ["IfcLevel", "IfcSlab", "IfcWall", "IfcDoor", "IfcWindow", "IfcRoof", "SdExport"],
    minCounts: { IfcLevel: 2, IfcSlab: 2 },
  },
  {
    label: "design-small-office",
    text: "Design a small office",
    required: ["IfcLevel", "IfcSlab", "IfcWall", "IfcDoor", "IfcWindow", "IfcRoof", "SdExport"],
  },
  {
    label: "design-tiny-home",
    text: "Design a tiny home",
    required: ["IfcLevel", "IfcSlab", "IfcWall", "IfcDoor", "IfcWindow", "IfcRoof", "SdExport"],
  },
];

// ── CLI args ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const promptIdxArg = argv.indexOf("--prompt-index");
const promptIndex = promptIdxArg !== -1 ? parseInt(argv[promptIdxArg + 1] ?? "0", 10) : -1;
const maxTurnsArg = argv.indexOf("--max-turns");
const maxTurns = maxTurnsArg !== -1 ? parseInt(argv[maxTurnsArg + 1] ?? "3", 10) : 3;
const outArg = argv.indexOf("--out");
const outPath = outArg !== -1 ? argv[outArg + 1] : null;

const suite = promptIndex >= 0 ? [PROMPTS[promptIndex]].filter(Boolean) : PROMPTS;
if (suite.length === 0) {
  console.error(`ERROR: --prompt-index ${promptIndex} out of range (0-${PROMPTS.length - 1})`);
  process.exit(1);
}

// ── CDP connection ────────────────────────────────────────────────────────────

const targets = await fetch(`http://localhost:${CDP_PORT}/json`)
  .then((r) => r.json() as Promise<Array<{ url?: string; type?: string; webSocketDebuggerUrl?: string }>>)
  .catch(() => null);
if (!targets) {
  console.error(`ERROR: Cannot reach CDP at :${CDP_PORT} — start shared browser first.`);
  process.exit(1);
}
const target = targets.find((t) => t.url?.includes(`localhost:${DEV_PORT}`) && t.type === "page");
if (!target?.webSocketDebuggerUrl) {
  console.error(`ERROR: No :${DEV_PORT} page tab found. Start dev server first.`);
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map<number, (r: unknown) => void>();
ws.onmessage = (m: MessageEvent<string>) => {
  const x = JSON.parse(m.data) as { id?: number };
  if (x.id !== undefined && pending.has(x.id)) {
    pending.get(x.id)!(x);
    pending.delete(x.id);
  }
};
await new Promise<void>((r) => ws.addEventListener("open", () => r()));

function cdp(method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown> }> {
  return new Promise((r) => {
    const id = msgId++;
    pending.set(id, r as (v: unknown) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await cdp("Runtime.enable");

async function evaluate<T>(expr: string, timeoutMs = 180000): Promise<T | null> {
  const r = await cdp("Runtime.evaluate", {
    expression: `(async()=>{ try { return JSON.stringify(await (${expr})); } catch(e) { return JSON.stringify({__err: e.message}); } })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  const raw = (r.result as Record<string, Record<string, unknown>>)?.result?.value as string | undefined;
  if (!raw) return null;
  return JSON.parse(raw) as T;
}

// ── Reset scene between prompts ───────────────────────────────────────────────

async function resetScene(): Promise<void> {
  await evaluate<unknown>("window.__viewer?.scene?.children?.forEach(c => { if(c.userData?.kind === 'brep') window.__viewer.scene.remove(c); }); 'reset'");
  await new Promise<void>((r) => setTimeout(r, 300));
}

// ── Run one prompt ────────────────────────────────────────────────────────────

interface AgentDispatch { verb: string; args?: Record<string, unknown> }
interface LoopResult { dispatches?: AgentDispatch[]; text?: string }

interface PromptResult {
  ts: string;
  label: string;
  prompt: string;
  max_turns: number;
  passed: boolean;
  dispatch_count: number;
  verbs_seen: Record<string, number>;
  missing_required: string[];
  min_count_failures: string[];
  export_last: boolean;
  text_snippet: string;
}

async function runPrompt(p: typeof PROMPTS[number]): Promise<PromptResult> {
  console.log(`\n── ${p.label} ──`);
  console.log(`  prompt: "${p.text}"`);

  await resetScene();

  const raw = await evaluate<LoopResult>(
    `window.__runDesignLoop(${JSON.stringify(p.text)}, [], undefined, ${maxTurns})`,
    180000,
  );

  const dispatches = raw?.dispatches ?? [];
  const verbCounts: Record<string, number> = {};
  for (const d of dispatches) {
    verbCounts[d.verb] = (verbCounts[d.verb] ?? 0) + 1;
  }

  const missingRequired = p.required.filter((v) => !(verbCounts[v] ?? 0));
  const minCountFailures: string[] = [];
  if (p.minCounts) {
    for (const [verb, minN] of Object.entries(p.minCounts)) {
      if ((verbCounts[verb] ?? 0) < minN) {
        minCountFailures.push(`${verb} requires ≥${minN}, got ${verbCounts[verb] ?? 0}`);
      }
    }
  }

  const lastVerb = dispatches[dispatches.length - 1]?.verb ?? "";
  const exportLast = lastVerb === "SdExport";
  const passed = missingRequired.length === 0 && minCountFailures.length === 0;

  const result: PromptResult = {
    ts: new Date().toISOString(),
    label: p.label,
    prompt: p.text,
    max_turns: maxTurns,
    passed,
    dispatch_count: dispatches.length,
    verbs_seen: verbCounts,
    missing_required: missingRequired,
    min_count_failures: minCountFailures,
    export_last: exportLast,
    text_snippet: (raw?.text ?? "").slice(0, 120),
  };

  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} dispatches=${dispatches.length} missing=${missingRequired.join(",")||"none"}`);
  if (minCountFailures.length) console.log(`    min-count failures: ${minCountFailures.join("; ")}`);

  if (outPath) appendFileSync(outPath, JSON.stringify(result) + "\n", "utf8");

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`demo-prompt-harness: ${suite.length} prompt(s), max_turns=${maxTurns}`);
if (outPath) console.log(`JSONL → ${outPath}`);

const results: PromptResult[] = [];
for (const p of suite) {
  results.push(await runPrompt(p));
}

ws.close();

const passed = results.filter((r) => r.passed).length;
const total = results.length;
console.log(`\nResult: ${passed}/${total} passed`);
for (const r of results) {
  console.log(`  ${r.passed ? "✓" : "✗"} ${r.label}: dispatches=${r.dispatch_count} missing=${r.missing_required.join(",")||"none"}`);
}

process.exit(passed === total ? 0 : 1);
