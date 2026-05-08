// plan.ts — Complexity heuristic for agent autoplan (P0 #92).
// Simple plan: auto-execute. Complex plan: surface with "Run plan" button.

import type { AgentDispatch } from "./agent/agent-harness";

const DESTRUCTIVE_VERBS = new Set(["SdDelete", "SdClear", "SdReset"]);

function isDestructiveVerb(verb: string): boolean {
  return DESTRUCTIVE_VERBS.has(verb) || /delete|clear|reset|remove/i.test(verb);
}

/**
 * Returns true when dispatches should auto-execute without user confirmation.
 * Condition: 1–3 dispatches, none destructive.
 */
export function isSimplePlan(dispatches: AgentDispatch[]): boolean {
  if (dispatches.length === 0 || dispatches.length > 3) return false;
  return !dispatches.some((d) => isDestructiveVerb(d.verb));
}
