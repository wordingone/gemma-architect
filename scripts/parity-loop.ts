#!/usr/bin/env bun
// parity-loop.ts — W-P4 visual parity iteration driver (#319) + W-P7 tiered state machine (#322)
//
// Reads:  $PARITY_STATE_PATH (config)  default: ./state/parity-experiment.json
// Writes: $ITERATIONS_JSONL            default: ./state/parity-experiment-iterations.jsonl
//         $PARITY_BANK_DIR/tier-<N>-<ts>/  default: ./state/parity-bank/
//
// Usage:
//   bun scripts/parity-loop.ts [--mock] [--max-iterations N]
//
//   --mock            Use synthetic scoring (skips parity-score.mjs); cycles verbs deterministically.
//   --max-iterations  Override safety cap from state file (default: 100).
//
// No external API keys required. Scorer: inline JPEG-bpp (ported from parity-score.mjs, no subprocess).

import { writeFileSync, readFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CDP_PORT, DEV_PORT } from "./ports";

//  Paths 

const PARITY_STATE_PATH = process.env.PARITY_STATE_PATH ?? "./state/parity-experiment.json";
const ITERATIONS_JSONL  = process.env.ITERATIONS_JSONL  ?? "./state/parity-experiment-iterations.jsonl";
const PARITY_BANK_DIR   = process.env.PARITY_BANK_DIR   ?? "./state/parity-bank";

//  CLI args ─

const argv = process.argv.slice(2);
const MOCK = argv.includes("--mock");
const maxIterArg = argv.indexOf("--max-iterations");
const maxIterOverride = maxIterArg !== -1 ? parseInt(argv[maxIterArg + 1] ?? "100", 10) : undefined;

//  State file 

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

//  CDP connection

type CdpTarget = { url?: string; type?: string; webSocketDebuggerUrl?: string };

const targets: CdpTarget[] | null = await fetch(`http://localhost:${CDP_PORT}/json`)
  .then(r => r.json())
  .catch(() => null);

if (!targets) {
  console.error(`ERROR: Cannot reach CDP at :${CDP_PORT} — is the shared browser running?`);
  process.exit(1);
}

const target = targets.find(t => t.url?.includes(`localhost:${DEV_PORT}`) && t.type === "page");
if (!target?.webSocketDebuggerUrl) {
  console.error(`ERROR: No :${DEV_PORT} page tab found. Start dev server and shared browser first.`);
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
  // CDP wraps returnByValue results as { result: { result: { type, value } } }
  return (r.result as Record<string, Record<string, unknown>>)?.result?.value ?? null;
}

// Viewport clip region — computed once at startup to match capture-parity-reference.mjs bounds.
// Both reference and iteration screenshots use the same region + scale so bpp is comparable.
const vaRectRaw = await evaluate(`(function() {
  const va = document.getElementById('viewport-area-host');
  if (!va) return null;
  const r = va.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top),
           w: Math.round(r.width),
           h: Math.min(Math.round(r.height), window.innerHeight - Math.round(r.top)) };
})()`);
const vaRect = vaRectRaw as { x: number; y: number; w: number; h: number } | null;
if (!vaRect || vaRect.w < 100 || vaRect.h < 100) {
  console.error("ERROR: viewport-area-host not found or too small:", vaRect);
  process.exit(1);
}
console.log(`Viewport clip: ${vaRect.w}×${vaRect.h} at (${vaRect.x},${vaRect.y}) — scale:2`);

async function takeScreenshot(savePath: string): Promise<void> {
  const r = await cdpSend("Page.captureScreenshot", {
    format: "jpeg", quality: 85,
    clip: { x: vaRect!.x, y: vaRect!.y, width: vaRect!.w, height: vaRect!.h, scale: 2 },
  });
  const b64 = (r.result?.data as string | undefined) ?? "";
  writeFileSync(savePath, Buffer.from(b64, "base64"));
}

//  Inline JPEG-bpp scorer (ported from parity-score.mjs, no subprocess) 

interface ScoreResult {
  score: number;
  deltas: Array<{ dimension: string; description: string }>;
  ref_bpp?: number;
  vp_bpp?: number;
  bpp_delta?: number;
}

interface ScoreOut { result: ScoreResult | null; note: string }

function readJpegMeta(path: string): { bytes: number; w: number; h: number } {
  const buf = readFileSync(path);
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error(`not a JPEG: ${path}`);
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const h = (buf[i + 5] << 8) | buf[i + 6];
      const w = (buf[i + 7] << 8) | buf[i + 8];
      return { bytes: buf.length, w, h };
    }
    const segLen = (buf[i + 2] << 8) | buf[i + 3];
    if (!segLen) break;
    i += 2 + segLen;
  }
  throw new Error(`no SOF marker: ${path}`);
}

const FULL_RANGE = 0.05;

function scoreJpegPair(refPath: string, vpPath: string): ScoreResult {
  const ref = readJpegMeta(refPath);
  const vp = readJpegMeta(vpPath);
  const refBpp = ref.bytes / (ref.w * ref.h);
  const vpBpp = vp.bytes / (vp.w * vp.h);
  const bppDelta = Math.abs(refBpp - vpBpp);
  const score = Math.round(100 * Math.max(0, 1 - Math.min(1, bppDelta / FULL_RANGE)));
  return {
    score,
    deltas: [],
    ref_bpp: parseFloat(refBpp.toFixed(5)),
    vp_bpp: parseFloat(vpBpp.toFixed(5)),
    bpp_delta: parseFloat(bppDelta.toFixed(5)),
  };
}

let _mockCallN = 0;

function scoreViewport(vpPath: string): ScoreOut {
  if (MOCK) {
    _mockCallN++;
    return { result: { score: Math.min(100, _mockCallN * 5), deltas: [] }, note: "mock" };
  }
  try {
    return { result: scoreJpegPair(refImagePath, vpPath), note: "ok" };
  } catch (e) {
    const note = `parity-score failed: ${(e as Error).message}`;
    console.error(note);
    return { result: null, note };
  }
}

//  Dispatch proposal via __runDesignLoop ─

interface Proposal { verb: string; args: Record<string, unknown>; rationale: string }

const MOCK_VERBS = ["IfcWall", "IfcSlab", "IfcColumn", "IfcDoor", "IfcWindow"];

async function proposeDispatch(
  _vpPath: string,
  lastDeltas: ScoreResult["deltas"],
  lastAttempts: string[],
  sceneVerbs: string[],
  refBpp: number,
  vpBpp: number,
): Promise<Proposal | null> {
  if (MOCK) {
    return {
      verb: MOCK_VERBS[_mockCallN % MOCK_VERBS.length],
      args: {},
      rationale: `deterministic cycle iteration ${_mockCallN}`,
    };
  }

  const deltaSummary = lastDeltas.length > 0
    ? lastDeltas.map(d => `${d.dimension}: ${d.description}`).join("; ")
    : "no specific visual gaps identified";
  const attemptSummary = lastAttempts.length > 0
    ? `Prior attempts (REVERTED=worsened bpp, kept otherwise): ${lastAttempts.slice(-3).join(", ")}.`
    : "No prior dispatches yet.";
  const sceneSummary = sceneVerbs.length > 0
    ? `Scene has ${sceneVerbs.length} kept element(s): ${sceneVerbs.slice(-5).join(", ")}.`
    : "Scene is empty.";
  const bppHint = refBpp > 0
    ? (vpBpp < refBpp
      ? `ADD geometry/complexity — viewport bpp (${vpBpp.toFixed(4)}) is BELOW reference bpp (${refBpp.toFixed(4)}); scene needs more detail.`
      : `SIMPLIFY/REDUCE — viewport bpp (${vpBpp.toFixed(4)}) is ABOVE reference bpp (${refBpp.toFixed(4)}); scene is already more complex than reference.`)
    : "";

  const prompt = [
    `Visual parity score: ${currentScore}/${activeTier} (targeting ${activeTier}% match).`,
    sceneSummary,
    bppHint,
    attemptSummary,
    `Visual gaps: ${deltaSummary}.`,
    `Dispatch ONE building element that closes the largest visual gap.`,
    `Prefer IFC primitives: IfcWall, IfcSlab, IfcColumn, IfcBeam, IfcDoor, IfcWindow, IfcRoof.`,
    `Return only the dispatch command — no explanation.`,
  ].filter(s => s.length > 0).join(" ");

  type LoopResult = { dispatches?: Array<{ verb: string; args?: Record<string, unknown> }>; text?: string };
  const result = await evaluate(
    `window.__runDesignLoop(${JSON.stringify(prompt)}, [], undefined, 1)`,
  ) as LoopResult | null;

  const first = result?.dispatches?.[0];
  if (!first) {
    return null;
  }
  return {
    verb: first.verb,
    args: first.args ?? {},
    rationale: (result?.text ?? "via runDesignLoop").slice(0, 120),
  };
}

//  JSONL logger 

function log(entry: Record<string, unknown>): void {
  appendFileSync(ITERATIONS_JSONL, JSON.stringify(entry) + "\n", "utf8");
}

//  Main loop ─

mkdirSync(PARITY_BANK_DIR, { recursive: true });

const TMP = tmpdir();
const lastAttempts: string[] = [];
const sceneVerbs: string[] = [];
let consecutiveNonImprovements = 0;
let iterationN = 0;
let currentScore = 0;
let activeTierIdx = START_TIER_IDX;
let activeTier    = TIER_LADDER[activeTierIdx];
// Fingerprint of the last reverted dispatch (verb+args JSON). When the model
// proposes an exact repeat of a just-reverted dispatch, the driver emits
// action:"skip" instead of re-executing and re-reverting (#472).
let lastRevertedKey: string | null = null;

console.log(`parity-loop: tiers=${TIER_LADDER.join("→")} starting=${activeTier} max_iterations=${MAX_ITERATIONS} mock=${MOCK}`);
console.log(`JSONL → ${ITERATIONS_JSONL}`);

// Initial score — advance activeTier past any already-banked tiers
const vpInit = join(TMP, "parity-init.jpg");
await takeScreenshot(vpInit);
const { result: initResult } = scoreViewport(vpInit);
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
  console.log(`\n─ Iteration ${iterationN}/${MAX_ITERATIONS} (score=${currentScore}, tier=${activeTier}, non-imp=${consecutiveNonImprovements}) ─`);

  // 1. Capture viewport
  const vpBefore = join(TMP, `parity-${iterationN}-before.jpg`);
  await takeScreenshot(vpBefore);

  // 2. Score before
  const { result: beforeResult, note: beforeNote } = scoreViewport(vpBefore);
  const scoreBefore = beforeResult?.score ?? currentScore;

  // 3. Propose dispatch
  const proposal = await proposeDispatch(
    vpBefore,
    beforeResult?.deltas ?? [],
    lastAttempts,
    sceneVerbs,
    beforeResult?.ref_bpp ?? 0,
    beforeResult?.vp_bpp ?? 0,
  );
  if (proposal === null) {
    console.log(`  ↷ No dispatch proposed — skipping iteration (non-imp counter unchanged).`);
    log({ ts: new Date().toISOString(), iteration_n: iterationN, active_tier: activeTier, dispatches: [], delta_before: beforeResult, delta_after: null, scorer_note: "skip: __runDesignLoop returned no dispatch", score: currentScore, action: "skip" });
    continue;
  }
  console.log(`  → ${proposal.verb} ${JSON.stringify(proposal.args)}: ${proposal.rationale}`);

  // Structural duplicate-detection (#472): if model proposes the exact same
  // verb+args as the just-reverted dispatch, skip without re-executing.
  const proposalKey = JSON.stringify({ verb: proposal.verb, args: proposal.args });
  if (proposalKey === lastRevertedKey) {
    console.log(`  ↷ Duplicate post-revert dispatch detected — skipping (non-imp counter unchanged).`);
    log({ ts: new Date().toISOString(), iteration_n: iterationN, active_tier: activeTier,
          dispatches: [{ verb: proposal.verb, args: proposal.args, rationale: proposal.rationale }],
          delta_before: beforeResult, delta_after: null,
          scorer_note: "skip: duplicate of last reverted dispatch (#472)",
          score: currentScore, action: "skip" });
    continue;
  }

  // 4. Execute dispatch
  await evaluate(`window.__dispatch(${JSON.stringify(proposal.verb)}, ${JSON.stringify(proposal.args)})`);
  await new Promise<void>(r => setTimeout(r, 600));

  // 5. Re-score after — brief pause lets Windows flush the file before child-process read
  const vpAfter = join(TMP, `parity-${iterationN}-after.jpg`);
  await takeScreenshot(vpAfter);
  await new Promise<void>(r => setTimeout(r, 200));
  const { result: afterResult, note: afterNote } = scoreViewport(vpAfter);
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
      lastRevertedKey = null;
      console.log(`  Retargeting to tier ${activeTier}.`);
    }
  } else if (improved) {
    action = "improve";
    consecutiveNonImprovements = 0;
    currentScore = scoreAfter;
    lastRevertedKey = null;
    console.log(`  ✓ Improved: ${scoreBefore} → ${scoreAfter}`);
  } else {
    action = "revert";
    consecutiveNonImprovements++;
    lastRevertedKey = proposalKey;
    console.log(`  ✗ No improvement (${scoreBefore} → ${scoreAfter}); reverting [${consecutiveNonImprovements}/${HALT_CONSECUTIVE}]`);
    await evaluate(`window.__dispatch("SdUndo", {})`);
    await new Promise<void>(r => setTimeout(r, 300));
  }

  // 6. Log entry
  const scorerErrors = [
    beforeNote !== "ok" ? `before:${beforeNote}` : null,
    afterNote !== "ok" ? `after:${afterNote}` : null,
  ].filter(Boolean).join("; ");
  log({
    ts: new Date().toISOString(),
    iteration_n: iterationN,
    active_tier: activeTier,
    dispatches: [{ verb: proposal.verb, args: proposal.args, rationale: proposal.rationale }],
    delta_before: beforeResult,
    delta_after: afterResult,
    scorer_note: scorerErrors || proposal.rationale,
    score: scoreAfter,
    action,
  });
  lastAttempts.push(`${proposal.verb}(${scoreBefore}→${scoreAfter}${action === "revert" ? " REVERTED" : ""})`);
  if (action !== "revert") sceneVerbs.push(proposal.verb);

  // 7. Halt checks
  if (action === "halt") break;
  if (consecutiveNonImprovements >= HALT_CONSECUTIVE) {
    haltReason = `${HALT_CONSECUTIVE} consecutive non-improvements`;
    console.log(`Halting: ${haltReason}.`);
    log({ ts: new Date().toISOString(), iteration_n: iterationN, active_tier: activeTier, dispatches: [], delta_before: afterResult, delta_after: null, scorer_note: `halt: ${haltReason}`, score: currentScore, action: "halt" });
    break;
  }
}

if (iterationN >= MAX_ITERATIONS && haltReason === "safety cap") {
  console.log(`Safety cap hit (${MAX_ITERATIONS} iterations).`);
  log({ ts: new Date().toISOString(), iteration_n: MAX_ITERATIONS, active_tier: activeTier, dispatches: [], delta_before: null, delta_after: null, scorer_note: "halt: safety cap", score: currentScore, action: "halt" });
}

ws.close();
const tiersCompleted = TIER_LADDER.slice(0, activeTierIdx).join("→") || "none";
console.log(`\nparity-loop: done. ${iterationN} iteration(s). Score: ${currentScore}. Tiers completed: ${tiersCompleted}. Halted: ${haltReason}.`);
console.log(`JSONL: ${ITERATIONS_JSONL}`);
