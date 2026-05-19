// summarize-agreement.test.ts — gemma-verify S128 extension (#1130 AC1-AC7).
// Tests summarizeAgreement consensus/outlier classifier using direct CoordinatedResult
// construction — no agent runner invocation needed.

import { describe, expect, test } from "bun:test";
import {
  summarizeAgreement,
  type DispatchAgreement,
  type CoordinatedResult,
} from "../src/agent/coordination";

describe("summarizeAgreement — #1130 consensus/outlier classifier", () => {
  test("AC6: empty proposals returns []", () => {
    const result: CoordinatedResult = { prompt: "test", proposals: [] };
    expect(summarizeAgreement(result)).toEqual([]);
  });

  test("AC2: 3 agents identical dispatch → agreementCount=3, isConsensus=true", () => {
    const wall = { name: "SdWall", arguments: { height: 3, thickness: 0.2 } };
    const result: CoordinatedResult = {
      prompt: "build a wall",
      proposals: [
        { agentName: "A", dispatchSeq: [wall], naturalText: "" },
        { agentName: "B", dispatchSeq: [wall], naturalText: "" },
        { agentName: "C", dispatchSeq: [wall], naturalText: "" },
      ],
    };
    const agreements = summarizeAgreement(result);
    expect(agreements).toHaveLength(1);
    expect(agreements[0].agreementCount).toBe(3);
    expect(agreements[0].isConsensus).toBe(true);
    expect(agreements[0].agentNames).toEqual(["A", "B", "C"]);
    expect(agreements[0].dispatch.name).toBe("SdWall");
  });

  test("AC3: 2v1 outlier — SdWall first (count=2), SdSlab second (count=1), both not consensus", () => {
    const wall = { name: "SdWall", arguments: { h: 3 } };
    const slab = { name: "SdSlab", arguments: {} };
    const result: CoordinatedResult = {
      prompt: "test",
      proposals: [
        { agentName: "A", dispatchSeq: [wall], naturalText: "" },
        { agentName: "B", dispatchSeq: [wall], naturalText: "" },
        { agentName: "C", dispatchSeq: [slab], naturalText: "" },
      ],
    };
    const agreements = summarizeAgreement(result);
    expect(agreements).toHaveLength(2);
    // Sorted by agreementCount desc
    expect(agreements[0].dispatch.name).toBe("SdWall");
    expect(agreements[0].agreementCount).toBe(2);
    expect(agreements[0].isConsensus).toBe(false);
    expect(agreements[1].dispatch.name).toBe("SdSlab");
    expect(agreements[1].agreementCount).toBe(1);
    expect(agreements[1].isConsensus).toBe(false);
  });

  test("AC4: arg-key-order independence — {height:3,thickness:0.2} === {thickness:0.2,height:3}", () => {
    const wall1 = { name: "SdWall", arguments: { height: 3, thickness: 0.2 } };
    const wall2 = { name: "SdWall", arguments: { thickness: 0.2, height: 3 } };
    const result: CoordinatedResult = {
      prompt: "test",
      proposals: [
        { agentName: "A", dispatchSeq: [wall1], naturalText: "" },
        { agentName: "B", dispatchSeq: [wall2], naturalText: "" },
      ],
    };
    const agreements = summarizeAgreement(result);
    expect(agreements).toHaveLength(1);
    expect(agreements[0].agreementCount).toBe(2);
    expect(agreements[0].isConsensus).toBe(true);
  });

  test("AC5: 1-agent — single dispatch has agreementCount=1, isConsensus=true", () => {
    const result: CoordinatedResult = {
      prompt: "test",
      proposals: [
        {
          agentName: "solo",
          dispatchSeq: [
            { name: "SdWall", arguments: { height: 3 } },
            { name: "SdSlab", arguments: {} },
          ],
          naturalText: "",
        },
      ],
    };
    const agreements = summarizeAgreement(result);
    expect(agreements).toHaveLength(2);
    for (const a of agreements) {
      expect(a.agreementCount).toBe(1);
      expect(a.isConsensus).toBe(true);
    }
  });

  test("AC1: DispatchAgreement shape has all required fields", () => {
    const result: CoordinatedResult = {
      prompt: "test",
      proposals: [{ agentName: "X", dispatchSeq: [{ name: "SdBox", arguments: {} }], naturalText: "" }],
    };
    const [da]: DispatchAgreement[] = summarizeAgreement(result);
    expect(typeof da.agreementCount).toBe("number");
    expect(Array.isArray(da.agentNames)).toBe(true);
    expect(typeof da.isConsensus).toBe("boolean");
    expect(da.dispatch).toBeDefined();
  });

  test("stable tie-break: equal agreementCount preserves first-occurrence order", () => {
    // Agent A proposes [X, Y]; Agent B proposes [Y, X].
    // Both X and Y have count=2. X appears first in A's proposal → X first in output.
    const x = { name: "SdBox", arguments: { size: 1 } };
    const y = { name: "SdCylinder", arguments: { r: 1 } };
    const result: CoordinatedResult = {
      prompt: "test",
      proposals: [
        { agentName: "A", dispatchSeq: [x, y], naturalText: "" },
        { agentName: "B", dispatchSeq: [y, x], naturalText: "" },
      ],
    };
    const agreements = summarizeAgreement(result);
    expect(agreements).toHaveLength(2);
    expect(agreements[0].dispatch.name).toBe("SdBox"); // X appeared first overall
    expect(agreements[1].dispatch.name).toBe("SdCylinder");
    expect(agreements[0].agreementCount).toBe(2);
    expect(agreements[1].agreementCount).toBe(2);
  });
});
