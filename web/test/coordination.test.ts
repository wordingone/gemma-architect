// coordination.test.ts — #406 step 2: parallel dispatch collection (#1128).
// Uses mock runner to avoid WebGPU/ONNX deps in Bun test environment.

import { describe, expect, test } from "bun:test";
import { runMultiAgent, type AgentProposal, type CoordinatedResult } from "../src/agent/coordination";
import { makeAgentInstanceFactory } from "../src/agent/agent-instance";
import type { AgentRequest, AgentResponse, AgentDispatch } from "../src/agent/agent-harness";

// Mock runner: returns a dispatch for "build" prompts, empty otherwise.
const mockRunner = async (req: AgentRequest): Promise<AgentResponse> => {
  const dispatch: AgentDispatch[] = req.prompt.includes("build") || req.prompt.includes("wall")
    ? [{ name: "SdWall", arguments: { height: 3.0, thickness: 0.2 } }]
    : [];
  return { dispatches: dispatch, text: `agent-response: ${req.prompt}` };
};

const createAgent = makeAgentInstanceFactory(mockRunner);

describe("runMultiAgent — #406 step 2 coordination", () => {
  test("AC1: module exports runMultiAgent, AgentProposal shape", async () => {
    const a = createAgent("agent-A");
    const result: CoordinatedResult = await runMultiAgent("build a 5m wall", [a]);
    expect(result.prompt).toBe("build a 5m wall");
    expect(Array.isArray(result.proposals)).toBe(true);
    const p: AgentProposal = result.proposals[0];
    expect(typeof p.agentName).toBe("string");
    expect(Array.isArray(p.dispatchSeq)).toBe(true);
    expect(typeof p.naturalText).toBe("string");
  });

  test("AC2: 2-instance concurrent run — both proposals present and non-empty agentName", async () => {
    const a = createAgent("agent-A");
    const b = createAgent("agent-B");
    const result = await runMultiAgent("build a 5m wall", [a, b]);

    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0].agentName).toBe("agent-A");
    expect(result.proposals[1].agentName).toBe("agent-B");

    // Both propose a SdWall dispatch for a "build" prompt
    expect(result.proposals[0].dispatchSeq).toHaveLength(1);
    expect(result.proposals[0].dispatchSeq[0].name).toBe("SdWall");
    expect(result.proposals[1].dispatchSeq).toHaveLength(1);
    expect(result.proposals[1].dispatchSeq[0].name).toBe("SdWall");
  });

  test("AC3: histories isolated after runMultiAgent — no cross-contamination", async () => {
    const a = createAgent("agent-A");
    const b = createAgent("agent-B");

    await runMultiAgent("build a 5m wall", [a, b]);

    // Each agent has exactly its own 2 turns (user + assistant)
    expect(a.history).toHaveLength(2);
    expect(b.history).toHaveLength(2);

    // Each agent's history contains only its own prompt (same prompt here — check no bleed via index)
    expect(a.history[0]).toEqual({ role: "user", content: "build a 5m wall" });
    expect(b.history[0]).toEqual({ role: "user", content: "build a 5m wall" });

    // Histories are distinct array references
    expect(a.history).not.toBe(b.history);
  });

  test("proposals are in agent input order", async () => {
    const agents = ["X", "Y", "Z"].map((n) => createAgent(n));
    const result = await runMultiAgent("hello", agents);
    expect(result.proposals.map((p) => p.agentName)).toEqual(["X", "Y", "Z"]);
  });

  test("empty agents array returns empty proposals", async () => {
    const result = await runMultiAgent("hello", []);
    expect(result.proposals).toHaveLength(0);
    expect(result.prompt).toBe("hello");
  });

  test("naturalText matches each agent's response text", async () => {
    const a = createAgent("alpha");
    const result = await runMultiAgent("test", [a]);
    expect(result.proposals[0].naturalText).toBe("agent-response: test");
  });
});
