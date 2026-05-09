// chat-dispatch-routing.ts — Classify a single invokeCommand result into a
// fired-label + optional error string. Extracted from chat-panel.ts for testability.
// Precedent: buildDispatchSummary extracted via commit 08d563f.

import type { CommandSessionResult } from "./commands/command-session";

export type DispatchRouteResult = {
  fired: string;
  error?: string;
};

export function classifyDispatchResult(
  verb: string,
  result: CommandSessionResult,
): DispatchRouteResult {
  if (result.status === "success") {
    return { fired: verb };
  }
  if (result.status === "needs_input") {
    const missingList = result.missing?.join(", ") ?? "required args";
    return { fired: `${verb}(err)`, error: `Failed ${verb}: missing ${missingList}.` };
  }
  return { fired: `${verb}(err)`, error: result.summary ?? `Failed ${verb}.` };
}
