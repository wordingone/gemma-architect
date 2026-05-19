// coordination.ts — parallel dispatch collection for N agent instances (#1128).
//
// Step 2 of #406 (parallel agents). Runs N AgentInstance.ask() calls concurrently
// via Promise.all and collects each agent's dispatch proposals into a flat result.
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
