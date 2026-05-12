import { describe, it, expect } from "bun:test";
import { buildDispatchSummary } from "../src/chat/chat-dispatch-summary";
import type { AgentDispatch } from "../src/agent/agent-harness";

function d(verb: string): AgentDispatch {
  return { verb, args: {} };
}

describe("buildDispatchSummary", () => {
  it("single verb singular", () => {
    expect(buildDispatchSummary([d("IfcWall")], ["IfcWall"]))
      .toBe("Built: 1 wall.");
  });

  it("single verb plural", () => {
    expect(buildDispatchSummary([d("IfcWall"), d("IfcWall")], ["IfcWall", "IfcWall"]))
      .toBe("Built: 2 walls.");
  });

  it("multi-verb aggregates in order", () => {
    const dispatches = [d("IfcWall"), d("IfcSlab"), d("IfcDoor")];
    const fired = ["IfcWall", "IfcSlab", "IfcDoor"];
    expect(buildDispatchSummary(dispatches, fired))
      .toBe("Built: 1 wall, 1 slab, 1 door.");
  });

  // Test C — errored verb excluded from counts
  it("excludes errored dispatches from summary", () => {
    const dispatches = [d("IfcWall"), d("IfcSlab"), d("IfcDoor")];
    const fired = ["IfcWall", "IfcSlab(err)", "IfcDoor"];
    expect(buildDispatchSummary(dispatches, fired))
      .toBe("Built: 1 wall, 1 door.");
  });

  it("all errored returns nothing-built", () => {
    const dispatches = [d("IfcWall"), d("IfcSlab")];
    const fired = ["IfcWall(err)", "IfcSlab(err)"];
    expect(buildDispatchSummary(dispatches, fired))
      .toBe("Nothing was built.");
  });

  it("empty dispatch list returns nothing-built", () => {
    expect(buildDispatchSummary([], []))
      .toBe("Nothing was built.");
  });

  it("unknown verb uses lowercase verb name", () => {
    expect(buildDispatchSummary([d("CustomVerb")], ["CustomVerb"]))
      .toBe("Built: 1 customverb.");
  });

  it("SdBox maps correctly", () => {
    expect(buildDispatchSummary([d("SdBox"), d("SdBox"), d("SdBox")], ["SdBox", "SdBox", "SdBox"]))
      .toBe("Built: 3 boxes.");
  });
});
