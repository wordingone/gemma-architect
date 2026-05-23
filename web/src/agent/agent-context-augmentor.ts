// agent-context-augmentor.ts — Deterministic context injection for continuation turns.
//
// Addresses T3 (attached structures) and T5 (metric literals) Phase J product failures.
// Root cause: single-pass WASM generation means all tool_calls are emitted before any
// dispatch feedback is available. System-prompt rules are out-competed by T1's KV-cache.
// Fix: put necessary geometry context in recency-attended position (prefixed to user prompt).
//
// Leo prescription 2026-05-23 (mail #10171): Option C primary path.

interface LedgerEntry {
  verb: string;
  args: Record<string, unknown>;
  status: string;
}

interface WallEntry {
  profile: [[number, number], [number, number]];
  height: number;
}

function extractParentWalls(): WallEntry[] {
  const ledger = (window as unknown as { __dispatchLedger?: LedgerEntry[] }).__dispatchLedger;
  if (!Array.isArray(ledger)) return [];
  return ledger
    .filter((e) => e.verb === "SdWall" && e.status === "success" && Array.isArray(e.args?.profile))
    .map((e) => ({
      profile: e.args.profile as [[number, number], [number, number]],
      height: typeof e.args.height === "number" ? e.args.height : 2.8,
    }));
}

// Filter to only the walls on the named face. Reduces injection from O(all walls) to O(1 face).
// Prevents T3 timeout: 8-wall pairM injection was ~686 tokens; 1-wall compact is ~50 tokens.
function filterWallsByFace(walls: WallEntry[], face: string): WallEntry[] {
  if (walls.length === 0) return walls;
  const allPts = walls.flatMap((w) => [w.profile[0], w.profile[1]]);
  let extreme: number;
  let getVal: (p: [number, number]) => number;
  switch (face) {
    case "south":
      extreme = Math.min(...allPts.map(([, y]) => y));
      getVal = ([, y]) => y;
      break;
    case "north":
      extreme = Math.max(...allPts.map(([, y]) => y));
      getVal = ([, y]) => y;
      break;
    case "west":
      extreme = Math.min(...allPts.map(([x]) => x));
      getVal = ([x]) => x;
      break;
    case "east":
      extreme = Math.max(...allPts.map(([x]) => x));
      getVal = ([x]) => x;
      break;
    default:
      return walls;
  }
  const tol = 0.15; // 15cm tolerance for floating-point wall placement
  return walls.filter(
    (w) =>
      Math.abs(getVal(w.profile[0]) - extreme) < tol &&
      Math.abs(getVal(w.profile[1]) - extreme) < tol,
  );
}

type PromptSemantic =
  | { kind: "attached_structure"; face: string }
  | { kind: "standalone_metric"; metricLiterals: string[] }
  | { kind: "none" };

function detectSemantic(prompt: string): PromptSemantic {
  // Attached structure: garage/shed/annex/extension attached to a named face
  const attachedMatch = prompt.match(
    /attached to (?:the )?(?:building'?s? )?(south|north|east|west) wall|attached (?:to )?the (south|north|east|west)|garage attached|shed attached|annex attached|\battached .{0,30}wall\b/i,
  );
  if (attachedMatch) {
    const face = (attachedMatch[1] ?? attachedMatch[2] ?? "south").toLowerCase();
    return { kind: "attached_structure", face };
  }
  // Standalone metric literal: "12m", "1m tall", "15 metres", etc.
  const metricMatches = [...prompt.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:m(?:\b|etres?)|metres?)\b/gi)];
  if (metricMatches.length > 0) {
    return { kind: "standalone_metric", metricLiterals: metricMatches.map((m) => m[0]) };
  }
  return { kind: "none" };
}

// Compact format: plain coordinates + paired height. Coordinates are plain metres (header carries
// the anti-conversion warning). Height uses pairing because height scalars were the primary
// ft→m victim in T3 (#1576 confirmed: 2.7432m correct after pairing, was 0.835m before).
function formatWallLine(wall: WallEntry): string {
  const [[x1, y1], [x2, y2]] = wall.profile;
  const hM = wall.height.toFixed(4);
  const hWrong = (wall.height * 0.3048).toFixed(4);
  return `  [[${x1.toFixed(4)},${y1.toFixed(4)}],[${x2.toFixed(4)},${y2.toFixed(4)}]] h=${hM}m(METRES;NOT_${hWrong})`;
}

/**
 * Returns a context string to prepend to the user's prompt for continuation turns,
 * or null if no augmentation is needed.
 *
 * Called in chat-panel.ts before runAgentTurn. The returned string is prepended to
 * the `prompt` parameter — NOT injected as a separate history turn (Gemma chat
 * template enforces strict alternation; prepend achieves the same recency-attention effect).
 */
export function buildContextAugmentation(
  prompt: string,
  history: Array<{ role: string; content: string }>,
): string | null {
  // No augmentation on first turn — nothing in history yet.
  if (history.length === 0) return null;

  const semantic = detectSemantic(prompt);

  if (semantic.kind === "attached_structure") {
    const allWalls = extractParentWalls();
    if (allWalls.length === 0) return null;
    const faceWalls = filterWallsByFace(allWalls, semantic.face);
    // Fall back to first 4 walls if face-filter yields nothing (unknown coordinate origin).
    const walls = faceWalls.length > 0 ? faceWalls : allWalls.slice(0, 4);
    const wallLines = walls.map(formatWallLine).join("\n");
    return (
      `[CONTEXT] ${semantic.face.toUpperCase()} face wall(s) — ALL COORDINATES IN METRES. Do NOT multiply by 0.3048:\n` +
      `${wallLines}\n` +
      `Apply EXTENSION RULE: W1=profile[0], W2=profile[1], compute perpendicular outward direction, ` +
      `depth from user prompt in metres, F1=[W1+perp*depth], F2=[W2+perp*depth]. ` +
      `Emit three SdWall calls: far [F1,F2], side-A [W1,F1], side-B [W2,F2]. ` +
      `Every wall: p1 ≠ p2 (dist ≥ 0.5m). Do NOT re-emit the shared parent wall.\n`
    );
  }

  if (semantic.kind === "standalone_metric") {
    const lines = semantic.metricLiterals.map((lit) => {
      const num = parseFloat(lit);
      const correct = num.toFixed(1);
      const wrong = (num * 0.3048).toFixed(3);
      return `  "${lit}" → use ${correct} (NOT ${wrong}, which is the ft→m conversion of ${num}ft)`;
    });
    return (
      `USER METRIC LITERALS — DO NOT CONVERT:\n` +
      `${lines.join("\n")}\n` +
      `The user's "Xm" values are already in metres; pass them through as-is. ` +
      `Do NOT apply ft→m (×0.3048) to any value in this prompt.\n`
    );
  }

  return null;
}
