import { describe, it, expect } from "bun:test";
import { buildDispatchSummary } from "../src/chat/chat-dispatch-summary";
import type { AgentDispatch } from "../src/agent/agent-harness";

function d(verb: string): AgentDispatch {
  return { name: verb, arguments: {} };
}

describe("buildDispatchSummary", () => {
  it("single verb singular", () => {
    expect(buildDispatchSummary([d("SdWall")], ["SdWall"]))
      .toBe("Built: 1 wall.");
  });

  it("single verb plural", () => {
    expect(buildDispatchSummary([d("SdWall"), d("SdWall")], ["SdWall", "SdWall"]))
      .toBe("Built: 2 walls.");
  });

  it("multi-verb aggregates in order", () => {
    const dispatches = [d("SdWall"), d("SdSlab"), d("SdDoor")];
    const fired = ["SdWall", "SdSlab", "SdDoor"];
    expect(buildDispatchSummary(dispatches, fired))
      .toBe("Built: 1 wall, 1 slab, 1 door.");
  });

  // Test C — errored verb excluded from counts
  it("excludes errored dispatches from summary", () => {
    const dispatches = [d("SdWall"), d("SdSlab"), d("SdDoor")];
    const fired = ["SdWall", "SdSlab(err)", "SdDoor"];
    expect(buildDispatchSummary(dispatches, fired))
      .toBe("Built: 1 wall, 1 door.");
  });

  it("all errored returns nothing-built", () => {
    const dispatches = [d("SdWall"), d("SdSlab")];
    const fired = ["SdWall(err)", "SdSlab(err)"];
    expect(buildDispatchSummary(dispatches, fired))
      .toBe("Nothing was built.");
  });

  it("empty dispatch list returns empty string (Q&A turn)", () => {
    expect(buildDispatchSummary([], [])).toBe("");
  });

  it("query verbs excluded from Built: summary", () => {
    // SdListObjects is a query — should produce no Built: line
    expect(buildDispatchSummary([d("SdListObjects")], ["SdListObjects"])).toBe("");
    expect(buildDispatchSummary([d("SdZoomExtents")], ["SdZoomExtents"])).toBe("");
  });

  it("unknown verb uses readable fallback (strips Sd prefix)", () => {
    expect(buildDispatchSummary([d("SdCustomThing")], ["SdCustomThing"]))
      .toBe("Built: 1 customthing.");
  });

  it("SdBox maps correctly", () => {
    expect(buildDispatchSummary([d("SdBox"), d("SdBox"), d("SdBox")], ["SdBox", "SdBox", "SdBox"]))
      .toBe("Built: 3 boxes.");
  });
});
