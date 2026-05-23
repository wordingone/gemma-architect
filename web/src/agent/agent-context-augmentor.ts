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

function formatWallLine(wall: WallEntry): string {
  const [[x1, y1], [x2, y2]] = wall.profile;
  const len = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2).toFixed(3);
  return `  [[${x1},${y1}],[${x2},${y2}]] length=${len}m height=${wall.height.toFixed(2)}m`;
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
    const walls = extractParentWalls();
    if (walls.length === 0) return null;
    const wallLines = walls.map(formatWallLine).join("\n");
    return (
      `[CONTEXT] Parent walls from prior dispatches (select the ${semantic.face} wall by position):\n` +
      `${wallLines}\n` +
      `Apply EXTENSION RULE from BUILDING_DEFAULTS: identify W1=[profile[0]] W2=[profile[1]] of the ` +
      `${semantic.face} wall, compute perpendicular direction away from parent, derive ` +
      `F1=[W1+perp*depth] F2=[W2+perp*depth], emit three walls: far [F1,F2], side-A [W1,F1], side-B [W2,F2]. ` +
      `INVARIANT: every wall must have p1 ≠ p2 (dist ≥ 0.5m). Do NOT re-emit the shared parent wall.\n`
    );
  }

  if (semantic.kind === "standalone_metric") {
    const literals = semantic.metricLiterals.join(", ");
    return (
      `[CONTEXT] Metric literals detected in this prompt: ${literals}. ` +
      `These are already in metres — pass through DIRECTLY as numeric values (e.g. "12m" → 12.0, "1m" → 1.0). ` +
      `Do NOT apply ft→m (×0.3048) conversion. CONTINUATION UNIT RULE: only explicit "ft" or foot notation ` +
      `receives ft→m conversion. Prior turns used feet-converted-to-metres; this turn's literals are metres.\n`
    );
  }

  return null;
}
