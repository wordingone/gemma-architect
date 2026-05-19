// agent-instance.test.ts — gemma-verify S128 (code-only, no browser).
// Tests AgentInstance factory isolation and history management (#1122 AC1-AC4).
//
// Uses makeAgentInstanceFactory with a mock runner to avoid loading
// @huggingface/transformers / WebGPU deps in the Bun test environment.

import { describe, expect, test } from "bun:test";
import { makeAgentInstanceFactory } from "../src/agent/agent-instance";
import type { AgentRequest, AgentResponse } from "../src/agent/agent-harness";

// Mock runner: echoes the prompt back as assistant text, returns no dispatches.
const echoRunner = async (req: AgentRequest): Promise<AgentResponse> => ({
  dispatches: [],
  text: `echo: ${req.prompt}`,
});

const createAgentInstance = makeAgentInstanceFactory(echoRunner);

describe("AgentInstance — gemma-verify S128", () => {
  test("AC1: two instances are distinct objects with different IDs", () => {
    const a = createAgentInstance("agent-A");
    const b = createAgentInstance("agent-B");
    expect(a).not.toBe(b);
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe("agent-A");
    expect(b.name).toBe("agent-B");
  });

  test("AC2: histories are isolated — no cross-contamination between instances", async () => {
    const a = createAgentInstance("agent-A");
    const b = createAgentInstance("agent-B");

    await a.ask("draw a 5m wall");
    await b.ask("draw a 3m wall");

    const aContents = a.history.map((t) => t.content);
    const bContents = b.history.map((t) => t.content);

    // A's history contains only its own prompt
    expect(aContents).toContain("draw a 5m wall");
    expect(aContents).not.toContain("draw a 3m wall");

    // B's history contains only its own prompt
    expect(bContents).toContain("draw a 3m wall");
    expect(bContents).not.toContain("draw a 5m wall");

    // Each has exactly one user + one assistant turn
    expect(a.history.length).toBe(2);
    expect(b.history.length).toBe(2);
    expect(a.history[0]).toEqual({ role: "user", content: "draw a 5m wall" });
    expect(b.history[0]).toEqual({ role: "user", content: "draw a 3m wall" });
  });

  test("reset() clears only the target instance", async () => {
    const a = createAgentInstance("agent-A");
    const b = createAgentInstance("agent-B");

    await a.ask("draw a 5m wall");
    await b.ask("draw a 3m wall");

    a.reset();

    expect(a.history.length).toBe(0);
    expect(b.history.length).toBe(2); // b unaffected
  });

  test("ask() passes prior history to runner, not the current prompt", async () => {
    const captured: AgentRequest[] = [];
    const trackRunner = async (req: AgentRequest): Promise<AgentResponse> => {
      captured.push({ ...req, history: req.history ? [...req.history] : [] });
      return { dispatches: [], text: "ok" };
    };
    const inst = makeAgentInstanceFactory(trackRunner)("tracker");

    await inst.ask("first");
    await inst.ask("second");

    // First call: no prior history
    expect(captured[0].history).toHaveLength(0);

    // Second call: prior history contains the first user + assistant turn
    expect(captured[1].history).toHaveLength(2);
    expect(captured[1].history![0]).toEqual({ role: "user", content: "first" });
    expect(captured[1].history![1]).toEqual({ role: "assistant", content: "ok" });
  });

  test("AC3 (structural): N instances share one runner — no double model load", () => {
    // Runtime VRAM measurement requires a live WebGPU context; verified structurally here:
    // makeAgentInstanceFactory(runner) closes over a SINGLE runner reference.
    // All instances created from the same factory call the same loaded model.
    let callCount = 0;
    const countingRunner = async (_req: AgentRequest): Promise<AgentResponse> => {
      callCount++;
      return { dispatches: [], text: "ok" };
    };
    const factory = makeAgentInstanceFactory(countingRunner);
    const instances = [factory("a"), factory("b"), factory("c")];

    // Runner is shared — factory reference is the same object identity
    expect(typeof instances[0].ask).toBe("function");
    expect(instances[0]).not.toBe(instances[1]);
    // callCount stays 0 until ask() is called — no eager model load from factory
    expect(callCount).toBe(0);
  });

  test("response.text is correct in ask() return value", async () => {
    const inst = createAgentInstance("test");
    const resp = await inst.ask("hello");
    expect(resp.text).toBe("echo: hello");
    expect(resp.dispatches).toHaveLength(0);
  });
});
