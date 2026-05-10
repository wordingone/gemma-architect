#!/usr/bin/env bun
// judge.ts — P8d round-trip Q&A judge (#122 Prong D)
//
// For each prompt's IFC file, generates up to 5 ifc-bench-style questions from
// expected_checks, feeds (IFC + question) to a judge model, and scores the
// answer against the check spec.  Validates structural IFC coherence — not just
// that our own checks pass, but that an independent model can read the IFC and
// answer questions correctly.
//
// Usage:
//   bun web/test/capability/judge.ts                          # all prompts in state/ifcs/
//   bun web/test/capability/judge.ts --prompt sf-residence-2br
//   bun web/test/capability/judge.ts --ifc path/to/model.ifc --prompt sf-residence-2br
//   bun web/test/capability/judge.ts --dry-run                # show questions, skip judge calls
//
// Judge model:
//   1. JUDGE_URL env var → OpenAI-compat /v1/chat/completions endpoint
//      (serve_lora.py at localhost:8088 via P7 server-side MTP path)
//   2. --dry-run flag → print questions only, skip model calls
//
// IFC source (first available wins per prompt):
//   1. --ifc <path> flag (single IFC, must also pass --prompt)
//   2. state/ifcs/<prompt-id>-<sha>.ifc  (saved by capability-bench.ts)
//   3. .tmp-bench-downloads/<prompt-id>*.ifc  (last bench run downloads)
//
// Output: state/judge-<sha>-<ts>.json

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

// ── Config ────────────────────────────────────────────────────────────────────

const REPO = resolve(import.meta.dir, "../../..");
const PROMPTS_DIR = join(REPO, "web/test/capability/prompts");
const IFC_DIR = join(REPO, "state/ifcs");
const DOWNLOAD_TMP = join(REPO, ".tmp-bench-downloads");
const STATE_DIR = join(REPO, "state");

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const FILTER = argv.indexOf("--prompt") !== -1 ? argv[argv.indexOf("--prompt") + 1] : null;
const IFC_OVERRIDE = argv.indexOf("--ifc") !== -1 ? argv[argv.indexOf("--ifc") + 1] : null;

const JUDGE_URL = process.env.JUDGE_URL ?? "http://localhost:8088/v1/chat/completions";
const MAX_IFC_CHARS = 48_000; // truncate large IFCs to keep within context
const MAX_QUESTIONS = 5;

// ── Types ─────────────────────────────────────────────────────────────────────

type CheckType = "count" | "dimension" | "area" | "z_extent" | "presence" | "door_width";

type CheckSpec = {
  id: string;
  description: string;
  type: CheckType;
  target?: string;
  tag_contains?: string;
  axis?: "X" | "Y" | "Z";
  min?: number;
  max?: number;
  exact?: number;
  min_width?: number;
};

type PromptFile = {
  id: string;
  category: string;
  prompt: string;
  min_pass_threshold: number;
  expected_checks: CheckSpec[];
};

type JudgeQuestion = {
  check_id: string;
  question: string;
  parse_mode: "integer" | "decimal" | "bool";
};

type JudgeResult = {
  check_id: string;
  question: string;
  raw_answer: string;
  extracted_value: number | boolean | null;
  pass: boolean;
  reason: string;
};

type PromptJudgeResult = {
  prompt_id: string;
  ifc_path: string;
  questions_asked: number;
  questions_passed: number;
  accuracy: number;
  results: JudgeResult[];
  error?: string;
};

// ── Question generation ───────────────────────────────────────────────────────

// Judgeable check types: those where the answer is extractable from raw IFC text
// without geometric processing. dimension/area/z_extent require bbox computation
// which an LLM cannot reliably do from STEP text — skip those.
const JUDGEABLE_TYPES: CheckType[] = ["count", "presence", "door_width"];

function questionFromCheck(c: CheckSpec): JudgeQuestion | null {
  if (!JUDGEABLE_TYPES.includes(c.type)) return null;

  if (c.type === "presence") {
    const cls = c.target ?? "IfcElement";
    return {
      check_id: c.id,
      question: `Does this IFC model contain at least one ${cls} entity? Reply with exactly 'yes' or 'no'.`,
      parse_mode: "bool",
    };
  }

  if (c.type === "door_width") {
    return {
      check_id: c.id,
      question: `What is the minimum OverallWidth value (in metres) across all IFCDOOR entities in this file? Reply with a single decimal number.`,
      parse_mode: "decimal",
    };
  }

  // count
  const cls = c.target ?? "IfcSpace";
  if (c.tag_contains) {
    return {
      check_id: c.id,
      question: `How many ${cls} entities have a Name field containing '${c.tag_contains}' (case-insensitive)? Reply with a single integer.`,
      parse_mode: "integer",
    };
  }
  return {
    check_id: c.id,
    question: `How many ${cls} entities are defined in this IFC file? Reply with a single integer.`,
    parse_mode: "integer",
  };
}

function selectQuestions(checks: CheckSpec[]): JudgeQuestion[] {
  const qs: JudgeQuestion[] = [];
  for (const c of checks) {
    if (qs.length >= MAX_QUESTIONS) break;
    const q = questionFromCheck(c);
    if (q) qs.push(q);
  }
  return qs;
}

// ── Answer parsing ────────────────────────────────────────────────────────────

function parseAnswer(raw: string, mode: "integer" | "decimal" | "bool"): number | boolean | null {
  const text = raw.trim().toLowerCase();
  if (mode === "bool") {
    if (/\byes\b/.test(text)) return true;
    if (/\bno\b/.test(text)) return false;
    return null;
  }
  const m = text.match(/[\d]+(?:\.\d+)?/);
  if (!m) return null;
  const v = parseFloat(m[0]);
  return isNaN(v) ? null : mode === "integer" ? Math.round(v) : v;
}

// ── Score answer against check spec ──────────────────────────────────────────

function scoreAnswer(value: number | boolean | null, c: CheckSpec): { pass: boolean; reason: string } {
  if (value === null) return { pass: false, reason: "no parseable answer" };

  if (c.type === "presence") {
    const pass = value === true;
    return { pass, reason: `presence=${value}` };
  }

  if (c.type === "door_width") {
    const n = value as number;
    const minW = c.min_width ?? 0;
    const pass = n >= minW;
    return { pass, reason: `min_width=${n.toFixed(3)}m; required≥${minW}` };
  }

  // count
  const n = Math.round(value as number);
  const minOk = c.min === undefined || n >= c.min;
  const maxOk = c.max === undefined || n <= c.max;
  const exactOk = c.exact === undefined || n === c.exact;
  const pass = minOk && maxOk && exactOk;
  return {
    pass,
    reason: `found=${n}; min=${c.min ?? "—"} max=${c.max ?? "—"} exact=${c.exact ?? "—"}`,
  };
}

// ── Judge model call ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are an expert IFC (Industry Foundation Classes) file parser. " +
  "Given IFC data in STEP format, answer the user's question concisely. " +
  "Reply with ONLY the answer: a single integer, a single decimal number, or 'yes'/'no'. " +
  "Do not explain. Do not add units. If you cannot determine the answer, reply '0' or 'no'.";

async function callJudgeOpenAI(ifcText: string, question: string): Promise<string> {
  const body = {
    model: "gemma-4-e2b",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `IFC:\n<ifc>\n${ifcText}\n</ifc>\n\nQuestion: ${question}` },
    ],
    max_tokens: 32,
    temperature: 0,
  };
  const res = await fetch(JUDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as any;
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function callJudge(ifcText: string, question: string): Promise<string> {
  // Truncate IFC to fit in context window
  const text = ifcText.length > MAX_IFC_CHARS ? ifcText.slice(0, MAX_IFC_CHARS) + "\n...truncated" : ifcText;
  try {
    return await callJudgeOpenAI(text, question);
  } catch (e: any) {
    throw new Error(`Judge endpoint unreachable (${e.message}). Set JUDGE_URL to a running llama-server /v1/chat/completions.`);
  }
}

// ── IFC file resolution ───────────────────────────────────────────────────────

async function findIFCForPrompt(promptId: string, sha: string): Promise<string | null> {
  if (IFC_OVERRIDE) return IFC_OVERRIDE;

  // 1. state/ifcs/<prompt-id>-<sha>.ifc (saved by capability-bench)
  const canonical = join(IFC_DIR, `${promptId}-${sha}.ifc`);
  try {
    await readFile(canonical);
    return canonical;
  } catch { /* not found */ }

  // 2. Any state/ifcs/<prompt-id>-*.ifc (any SHA)
  try {
    const files = await readdir(IFC_DIR);
    const match = files.find(f => f.startsWith(`${promptId}-`) && f.endsWith(".ifc"));
    if (match) return join(IFC_DIR, match);
  } catch { /* dir may not exist */ }

  // 3. .tmp-bench-downloads — last bench run's downloads (not prompt-tagged)
  //    Only usable when running single prompt to avoid cross-contamination.
  if (FILTER === promptId) {
    try {
      const files = await readdir(DOWNLOAD_TMP);
      const ifc = files.find(f => f.endsWith(".ifc") && !f.endsWith(".crdownload"));
      if (ifc) return join(DOWNLOAD_TMP, ifc);
    } catch { /* dir empty or missing */ }
  }

  return null;
}

// ── Per-prompt judging ────────────────────────────────────────────────────────

async function judgePrompt(p: PromptFile, sha: string): Promise<PromptJudgeResult> {
  const ifcPath = await findIFCForPrompt(p.id, sha);

  if (!ifcPath) {
    return {
      prompt_id: p.id,
      ifc_path: "",
      questions_asked: 0,
      questions_passed: 0,
      accuracy: 0,
      results: [],
      error: `no IFC file found — run capability-bench first (or pass --ifc)`,
    };
  }

  const ifcText = (await readFile(ifcPath)).toString("utf-8");
  const questions = selectQuestions(p.expected_checks);

  if (questions.length === 0) {
    return {
      prompt_id: p.id,
      ifc_path: ifcPath,
      questions_asked: 0,
      questions_passed: 0,
      accuracy: 0,
      results: [],
      error: "no judgeable checks (all checks require geometric computation)",
    };
  }

  const results: JudgeResult[] = [];

  for (const q of questions) {
    const check = p.expected_checks.find(c => c.id === q.check_id)!;
    console.log(`    Q: ${q.question.slice(0, 80)}…`);

    if (DRY_RUN) {
      results.push({
        check_id: q.check_id,
        question: q.question,
        raw_answer: "(dry-run)",
        extracted_value: null,
        pass: false,
        reason: "dry-run — no judge call made",
      });
      continue;
    }

    let rawAnswer = "";
    let extracted: number | boolean | null = null;
    let scored = { pass: false, reason: "" };

    try {
      rawAnswer = await callJudge(ifcText, q.question);
      extracted = parseAnswer(rawAnswer, q.parse_mode);
      scored = scoreAnswer(extracted, check);
    } catch (e: any) {
      scored = { pass: false, reason: `judge error: ${e.message}` };
    }

    console.log(`    A: ${rawAnswer.slice(0, 60)} → ${scored.pass ? "PASS" : "FAIL"} (${scored.reason})`);
    results.push({
      check_id: q.check_id,
      question: q.question,
      raw_answer: rawAnswer,
      extracted_value: extracted,
      pass: scored.pass,
      reason: scored.reason,
    });
  }

  const passed = results.filter(r => r.pass).length;
  const accuracy = results.length > 0 ? +(passed / results.length).toFixed(3) : 0;
  return {
    prompt_id: p.id,
    ifc_path: ifcPath,
    questions_asked: results.length,
    questions_passed: passed,
    accuracy,
    results,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const files = await readdir(PROMPTS_DIR);
  let prompts: PromptFile[] = [];
  for (const f of files.filter(f => f.endsWith(".json"))) {
    const p: PromptFile = JSON.parse(await readFile(join(PROMPTS_DIR, f), "utf-8"));
    if (!FILTER || p.id === FILTER) prompts.push(p);
  }
  if (prompts.length === 0) throw new Error(`No prompts found (filter: ${FILTER ?? "none"})`);

  const sha = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 19);

  await mkdir(STATE_DIR, { recursive: true });

  console.log(`P8d round-trip judge — SHA ${sha}`);
  if (DRY_RUN) console.log("DRY-RUN: no judge model calls will be made");
  else {
    console.log(`Judge: ${JUDGE_URL}`);
  }
  console.log(`Prompts: ${prompts.length}\n`);

  const promptResults: PromptJudgeResult[] = [];
  const t0 = Date.now();

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    console.log(`[${i + 1}/${prompts.length}] ${p.id} (${p.category})`);
    const r = await judgePrompt(p, sha);
    promptResults.push(r);

    if (r.error) {
      console.log(`  SKIP: ${r.error}`);
    } else {
      const pct = (r.accuracy * 100).toFixed(0);
      console.log(`  → ${r.questions_passed}/${r.questions_asked} judge-PASS (${pct}%)`);
    }
  }

  // Aggregate
  const judged = promptResults.filter(r => r.questions_asked > 0);
  const totalQ = judged.reduce((s, r) => s + r.questions_asked, 0);
  const totalPass = judged.reduce((s, r) => s + r.questions_passed, 0);
  const overallAcc = totalQ > 0 ? +(totalPass / totalQ).toFixed(3) : 0;
  const elapsed = Math.round((Date.now() - t0) / 1000);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Judge accuracy: ${totalPass}/${totalQ} (${(overallAcc * 100).toFixed(0)}%) across ${judged.length} prompt(s)`);
  console.log(`Elapsed: ${elapsed}s`);

  const receipt = {
    sha,
    ran_at: new Date().toISOString(),
    dry_run: DRY_RUN,
    judge_url: DRY_RUN ? null : JUDGE_URL,
    judge_backend: DRY_RUN ? null : "openai-compat",
    prompts_judged: judged.length,
    total_questions: totalQ,
    total_pass: totalPass,
    overall_accuracy: overallAcc,
    elapsed_s: elapsed,
    prompt_results: promptResults,
  };

  const receiptPath = join(STATE_DIR, `judge-${sha}-${ts}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`Receipt: ${receiptPath}`);
}

main().catch(e => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
