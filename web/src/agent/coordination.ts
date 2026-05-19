// coordination.ts — parallel dispatch collection + agreement analysis (#1128, #1130).
//
// Step 2 of #406 (parallel agents). Runs N AgentInstance.ask() calls concurrently
// via Promise.all and collects each agent's dispatch proposals into a flat result.
// summarizeAgreement() cross-compares proposals to tag consensus vs outlier dispatches.
//
// Voting / merge logic is deferred to step 3 (chat-panel UI + aggregate button).
// This module is the data layer only — no cross-agent decision logic here.

import type { AgentInstance } from "./agent-instance";
import type { AgentDispatch, AgentRequest } from "./agent-harness";

export type AgentProposal = {
  agentName: string;
  dispatchSeq: AgentDispatch[];
  naturalText: string;
};

export type CoordinatedResult = {
  prompt: string;
  proposals: AgentProposal[];
};

/** Run the same prompt against all agents concurrently.
 *  Each agent's history remains isolated — no cross-contamination.
 *  Returns one proposal per agent in input order. */
export async function runMultiAgent(
  prompt: string,
  agents: AgentInstance[],
  options?: Partial<AgentRequest>,
): Promise<CoordinatedResult> {
  const responses = await Promise.all(agents.map((a) => a.ask(prompt, options)));
  const proposals: AgentProposal[] = agents.map((a, i) => ({
    agentName: a.name,
    dispatchSeq: responses[i].dispatches,
    naturalText: responses[i].text,
  }));
  return { prompt, proposals };
}

// ── Agreement analysis (#1130) ────────────────────────────────────────────────

export type DispatchAgreement = {
  dispatch: AgentDispatch;
  agreementCount: number;
  agentNames: string[];
  isConsensus: boolean;
};

/** Canonical key for a dispatch: name + JSON with sorted argument keys.
 *  {h:3,t:0.2} and {t:0.2,h:3} produce the same key (AC4). */
function canonicalKey(d: AgentDispatch): string {
  const sorted = Object.fromEntries(
    Object.entries(d.arguments).sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${d.name}\x00${JSON.stringify(sorted)}`;
}

/** Cross-compare N agent proposals and classify each unique dispatch as
 *  consensus (all agents emitted it) or outlier (only some agents emitted it).
 *  Output is sorted by agreementCount desc, stable tie-break by first occurrence. */
export function summarizeAgreement(result: CoordinatedResult): DispatchAgreement[] {
  const totalAgents = result.proposals.length;
  if (totalAgents === 0) return [];

  // Map from canonical key → {dispatch (first occurrence), agentNames[], firstIndex}
  const seen = new Map<string, { dispatch: AgentDispatch; agentNames: string[]; firstIndex: number }>();
  let globalIndex = 0;

  for (const proposal of result.proposals) {
    for (const d of proposal.dispatchSeq) {
      const key = canonicalKey(d);
      if (seen.has(key)) {
        seen.get(key)!.agentNames.push(proposal.agentName);
      } else {
        seen.set(key, { dispatch: d, agentNames: [proposal.agentName], firstIndex: globalIndex++ });
      }
    }
  }

  type WithIndex = DispatchAgreement & { _firstIndex: number };
  const agreements: WithIndex[] = Array.from(seen.values()).map(
    ({ dispatch, agentNames, firstIndex }) => ({
      dispatch,
      agreementCount: agentNames.length,
      agentNames,
      isConsensus: agentNames.length === totalAgents,
      _firstIndex: firstIndex,
    }),
  );

  // Sort: agreementCount desc, stable tie-break by firstIndex asc (first occurrence wins)
  agreements.sort((a, b) => {
    const countDiff = b.agreementCount - a.agreementCount;
    return countDiff !== 0 ? countDiff : a._firstIndex - b._firstIndex;
  });

  return agreements.map(({ dispatch, agreementCount, agentNames, isConsensus }) => ({
    dispatch, agreementCount, agentNames, isConsensus,
  }));
}
