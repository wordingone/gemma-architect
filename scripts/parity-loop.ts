#!/usr/bin/env bun
// parity-loop.ts — W-P4 visual parity iteration driver (#319) + W-P7 tiered state machine (#322)
//
// Reads:  B:/M/avir/leo/state/parity-experiment.json  (config)
// Writes: B:/M/avir/leo/state/parity-experiment-iterations.jsonl  (per-iteration log)
//         B:/M/avir/leo/state/parity-bank/tier-<N>-<ts>/  (banked artifacts on tier pass)
//
// Usage:
//   bun scripts/parity-loop.ts [--mock] [--max-iterations N]
//
//   --mock            Skips Anthropic API calls; uses synthetic scoring for dry-run testing.
//   --max-iterations  Override safety cap from state file (default: 100).
//
// Environment:
//   ANTHROPIC_API_KEY  Required unless --mock is set.

import { writeFileSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";

// ── Paths ────────────────────────────────────────────────────────────────────

const PARITY_STATE_PATH = "B:/M/avir/leo/state/parity-experiment.json";
const ITERATIONS_JSONL  = "B:/M/avir/leo/state/parity-experiment-iterations.jsonl";
const PARITY_BANK_DIR   = "B:/M/avir/leo/state/parity-bank";
const PARITY_SCORER     = "B:/M/avir/infra/skills/visual-check/parity-score.mjs";
const HAIKU_MODEL       = "claude-haiku-4-5-20251001";

// ── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const MOCK = argv.includes("--mock");
const maxIterArg = argv.indexOf("--max-iterations");
const maxIterOverride = maxIterArg !== -1 ? parseInt(argv[maxIterArg + 1] ?? "100", 10) : undefined;

// ── State file ────────────────────────────────────────────────────────────────

interface ParityState {
  config: {
    reference: { still_image_path: string };
    iteration_strategy: {
      halt_on_consecutive_non_improvements: number;
      max_iterations_safety_cap: number;
    };
    parity_threshold: { current_tier: number };
  };
}

const state: ParityState = JSON.parse(readFileSync(PARITY_STATE_PATH, "utf8"));
const cfg = state.config;
const refImagePath = cfg.reference.still_image_path;
const HALT_CONSECUTIVE = cfg.iteration_strategy.halt_on_consecutive_non_improvements ?? 3;
const MAX_ITERATIONS   = maxIterOverride ?? (cfg.iteration_strategy.max_iterations_safety_cap ?? 100);
const TIER_LADDER      = [90, 95, 99];
const _startTierIdx    = TIER_LADDER.findIndex(t => t >= (cfg.parity_threshold.current_tier ?? 90));
const START_TIER_IDX   = _startTierIdx < 0 ? TIER_LADDER.length - 1 : _startTierIdx;

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
if (!apiKey && !MOCK) {
  console.error("ERROR: ANTHROPIC_API_KEY not set. Use --mock for dry-run or set the key.");
  process.exit(2);
}

// ── CDP connection ────────────────────────────────────────────────────────────

type CdpTarget = { url?: string; type?: string; webSocketDebuggerUrl?: string };

const targets: CdpTarget[] | null = await fetch("http://localhost:9222/json")
  .then(r => r.json())
  .catch(() => null);

if (!targets) {
  console.error("ERROR: Cannot reach CDP at :9222 — is the shared browser running?");
  process.exit(1);
}

const target = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
if (!target?.webSocketDebuggerUrl) {
  console.error("ERROR: No :5175 page tab found. Start dev server and shared browser first.");
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map<number, (r: unknown) => void>();
ws.onmessage = (m: MessageEvent<string>) => {
  const x = JSON.parse(m.data) as { id?: number; result?: unknown };
  if (x.id !== undefined && pending.has(x.id)) {
    pending.get(x.id)!(x);
    pending.delete(x.id);
  }
};
await new Promise<void>(resolve => ws.addEventListener("open", () => resolve()));

function cdpSend(method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown> }> {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve as (r: unknown) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await cdpSend("Runtime.enable");
await cdpSend("Page.enable");
await cdpSend("Page.bringToFront");

async function evaluate(expr: string): Promise<unknown> {
  const r = await cdpSend("Runtime.evaluate", {
    expression: `(async () => { try { return ${expr}; } catch(e) { return { __error: e.message }; } })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  return r.result?.value ?? null;
}

async function takeScreenshot(savePath: string): Promise<void> {
  const r = await cdpSend("Page.captureScreenshot", { format: "jpeg", quality: 85 });
  const b64 = (r.result?.data as string | undefined) ?? "";
  writeFileSync(savePath, Buffer.from(b64, "base64"));
}

// ── Score via parity-score.mjs ─────────────────────────────────────────────

interface ScoreResult { score: number; deltas: Array<{ dimension: string; description: string }> }

let _mockCallN = 0;

function scoreViewport(vpPath: string): ScoreResult | null {
  if (MOCK) {
    _mockCallN++;
    return { score: Math.min(100, _mockCallN * 5), deltas: [] };
  }
  const r = spawnSync(
    "bun", [PARITY_SCORER, refImagePath, vpPath],
    { env: { ...process.env, ANTHROPIC_API_KEY: apiKey }, timeout: 90_000, encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(`parity-score failed: ${(r.stderr as string).slice(0, 200)}`);
    return null;
  }
  try { return JSON.parse((r.stdout as string).trim()); }
  catch { return null; }
}

// ── Dispatch proposal via Haiku ────────────────────────────────────────────

interface Proposal { verb: string; args: Record<string, unknown>; rationale: string }

const MOCK_VERBS = ["IfcWall", "IfcSlab", "IfcColumn", "IfcDoor", "IfcWindow"];

async function proposeDispatch(
  vpPath: string,
  lastDeltas: ScoreResult["deltas"],
  lastAttempts: string[],
): Promise<Proposal | null> {
  if (MOCK) {
    return {
      verb: MOCK_VERBS[_mockCallN % MOCK_VERBS.length],
      args: {},
      rationale: `mock iteration ${_mockCallN}`,
    };
  }

  const refB64 = readFileSync(refImagePath).toString("base64");
  const vpB64  = readFileSync(vpPath).toString("base64");

  const prompt = [
    "You are a BIM modeling agent closing the gap between a reference building and a current viewport.",
    "Available verbs: IfcWall(length,thickness,height), IfcSlab(width,depth,thickness), IfcColumn(size,height),",
    "  IfcDoor(width,height), IfcWindow(width,height), IfcRoof(type,width,depth),",
    "  SdMove(x,y,z), SdRotate(angle,axis), SdScale(factor).",
    `Prior score deltas: ${JSON.stringify(lastDeltas)}.`,
    `Last attempts: ${lastAttempts.slice(-3).join("; ")}.`,
    "Propose ONE dispatch. Return JSON ONLY: {\"verb\":\"...\",\"args\":{...},\"rationale\":\"...\"}",
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 256,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Reference building (target):" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: refB64 } },
          { type: "text", text: "Current viewport:" },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: vpB64 } },
          { type: "text", text: prompt },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    console.error(`Haiku API error ${res.status}: ${await res.text().catch(() => "")}`);
    return null;
  }

  const data = await res.json() as { content?: Array<{ text?: string }> };
  const text = data.content?.[0]?.text?.trim() ?? "";
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) as Proposal : null;
  } catch { return null; }
}

// ── JSONL logger ──────────────────────────────────────────────────────────────

function log(entry: Record<string, unknown>): void {
  appendFileSync(ITERATIONS_JSONL, JSON.stringify(entry) + "\n", "utf8");
}

// ── Main loop ─────────────────────────────────────────────────────────────────

mkdirSync(PARITY_BANK_DIR, { recursive: true });

const TMP = tmpdir();
const lastAttempts: string[] = [];
let consecutiveNonImprovements = 0;
let iterationN = 0;
let currentScore = 0;
let activeTierIdx = START_TIER_IDX;
let activeTier    = TIER_LADDER[activeTierIdx];

console.log(`parity-loop: tiers=${TIER_LADDER.join("→")} starting=${activeTier} max_iterations=${MAX_ITERATIONS} mock=${MOCK}`);
console.log(`JSONL → ${ITERATIONS_JSONL}`);

// Initial score — advance activeTier past any already-banked tiers
const vpInit = join(TMP, "parity-init.jpg");
await takeScreenshot(vpInit);
const initResult = scoreViewport(vpInit);
currentScore = initResult?.score ?? 0;
while (activeTierIdx < TIER_LADDER.length && currentScore >= TIER_LADDER[activeTierIdx]) {
  activeTierIdx++;
}
if (activeTierIdx >= TIER_LADDER.length) {
  console.log(`Initial score ${currentScore} already meets all tiers. Nothing to do.`);
  ws.close();
  process.exit(0);
}
activeTier = TIER_LADDER[activeTierIdx];
console.log(`Initial score: ${currentScore} → pursuing tier ${activeTier}`);

let haltReason = "safety cap";

while (iterationN < MAX_ITERATIONS) {
  iterationN++;
  console.log(`\n─── Iteration ${iterationN}/${MAX_ITERATIONS} (score=${currentScore}, tier=${activeTier}, non-imp=${consecutiveNonImprovements}) ───`);

  // 1. Capture viewport
  const vpBefore = join(TMP, `parity-${iterationN}-before.jpg`);
  await takeScreenshot(vpBefore);

  // 2. Score before
  const beforeResult = scoreViewport(vpBefore);
  const scoreBefore = beforeResult?.score ?? currentScore;

  // 3. Propose dispatch
  const proposal = await proposeDispatch(vpBefore, beforeResult?.deltas ?? [], lastAttempts);
  if (!proposal) {
    console.error("Could not get dispatch proposal — halting.");
    log({ ts: new Date().toISOString(), iteration_n: iterationN, active_tier: activeTier, dispatches: [], delta_before: beforeResult, delta_after: null, haiku_description: "proposal failed", score: scoreBefore, action: "halt" });
    haltReason = "proposal failed";
    break;
  }
  console.log(`  → ${proposal.verb} ${JSON.stringify(proposal.args)}: ${proposal.rationale}`);

  // 4. Execute dispatch
  await evaluate(`window.__dispatch(${JSON.stringify(proposal.verb)}, ${JSON.stringify(proposal.args)})`);
  await new Promise<void>(r => setTimeout(r, 600));

  // 5. Re-score after
  const vpAfter = join(TMP, `parity-${iterationN}-after.jpg`);
  await takeScreenshot(vpAfter);
  const afterResult = scoreViewport(vpAfter);
  const scoreAfter = afterResult?.score ?? scoreBefore;

  const improved = scoreAfter > scoreBefore;
  const reachedTier = scoreAfter >= activeTier;
  let action: "improve" | "revert" | "halt";

  if (reachedTier) {
    currentScore = scoreAfter;
    const tierDir = join(PARITY_BANK_DIR, `tier-${activeTier}-${Date.now()}`);
    mkdirSync(tierDir, { recursive: true });
    writeFileSync(join(tierDir, "viewport.jpg"), readFileSync(vpAfter));
    writeFileSync(join(tierDir, "meta.json"), JSON.stringify({
      score: scoreAfter, tier: activeTier, iteration: iterationN,
      dispatches: [...lastAttempts, `${proposal.verb}(${scoreBefore}→${scoreAfter})`],
    }));
    console.log(`  ✓ Tier ${activeTier} reached! Banked to ${tierDir}`);
    activeTierIdx++;
    if (activeTierIdx >= TIER_LADDER.length) {
      action = "halt";
      haltReason = `all tiers complete (${TIER_LADDER.join("→")})`;
      console.log(`  All tiers complete.`);
    } else {
      action = "improve";
      activeTier = TIER_LADDER[activeTierIdx];
      consecutiveNonImprovements = 0;
      console.log(`  Retargeting to tier ${activeTier}.`);
    }
  } else if (improved) {
    action = "improve";
    consecutiveNonImprovements = 0;
    currentScore = scoreAfter;
    console.log(`  ✓ Improved: ${scoreBefore} → ${scoreAfter}`);
  } else {
    action = "revert";
    consecutiveNonImprovements++;
    console.log(`  ✗ No improvement (${scoreBefore} → ${scoreAfter}); reverting [${consecutiveNonImprovements}/${HALT_CONSECUTIVE}]`);
    await evaluate(`window.__dispatch("SdUndo", {})`);
    await new Promise<void>(r => setTimeout(r, 300));
  }

  // 6. Log entry
  log({
    ts: new Date().toISOString(),
    iteration_n: iterationN,
    active_tier: activeTier,
    dispatches: [{ verb: proposal.verb, args: proposal.args, rationale: proposal.rationale }],
    delta_before: beforeResult,
    delta_after: afterResult,
    haiku_description: proposal.rationale,
    score: scoreAfter,
    action,
  });
  lastAttempts.push(`${proposal.verb}(${scoreBefore}→${scoreAfter})`);

  // 7. Halt checks
  if (action === "halt") break;
  if (consecutiveNonImprovements >= HALT_CONSECUTIVE) {
    haltReason = `${HALT_CONSECUTIVE} consecutive non-improvements`;
    console.log(`Halting: ${haltReason}.`);
    log({ ts: new Date().toISOString(), iteration_n: iterationN, active_tier: activeTier, dispatches: [], delta_before: afterResult, delta_after: null, haiku_description: `halt: ${haltReason}`, score: currentScore, action: "halt" });
    break;
  }
}

if (iterationN >= MAX_ITERATIONS && haltReason === "safety cap") {
  console.log(`Safety cap hit (${MAX_ITERATIONS} iterations).`);
  log({ ts: new Date().toISOString(), iteration_n: MAX_ITERATIONS, active_tier: activeTier, dispatches: [], delta_before: null, delta_after: null, haiku_description: "halt: safety cap", score: currentScore, action: "halt" });
}

ws.close();
const tiersCompleted = TIER_LADDER.slice(0, activeTierIdx).join("→") || "none";
console.log(`\nparity-loop: done. ${iterationN} iteration(s). Score: ${currentScore}. Tiers completed: ${tiersCompleted}. Halted: ${haltReason}.`);
console.log(`JSONL: ${ITERATIONS_JSONL}`);
