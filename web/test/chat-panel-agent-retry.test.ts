// chat-panel-agent-retry.test.ts — #271 regression net: agent self-correct loop.
//
// PR #270 (issue #267) fix: when invokeCommand returns needs_input, _runDispatches
// must route it into errors[] with the missing-arg detail so the next model turn
// contains the validation string in its conversation history.
//
// Strategy: avoid importing chat-panel.ts directly (its agent-harness dep pulls in
// @huggingface/transformers, which fails in happy-dom during module init). Instead,
// test two layers:
//
//   1. classifyDispatchResult (real production module) — tests the routing decision.
//      Before PR #270: needs_input fell through to the success path.
//      After PR #270: needs_input produces fired="Verb(err)" + error message.
//
//   2. buildDispatchSummary — tests the observable output (what the agent reads
//      in its next turn context). The assistant history entry IS the summary string.
//
// Together these pin the contract: needs_input → error text in summary → agent
// self-correction is possible. A future regression that routes needs_input back to
// the success path will break layer 1; one that silences the error in the summary
// will break layer 2.

import { describe, test, expect } from "bun:test";
import { buildDispatchSummary } from "../src/chat/chat-dispatch-summary";
import { classifyDispatchResult } from "../src/chat/chat-dispatch-routing";

describe("#271 — agent self-correct loop regression net", () => {
  describe("Layer 1: dispatch routing (classifyDispatchResult)", () => {
    test("needs_input → fired ends with (err), error contains missing args", () => {
      const result = classifyDispatchResult("SdRectangle", {
        status: "needs_input",
        state: "idle",
        summary: "",
        missing: ["width", "height"],
      });
      expect(result.fired).toBe("SdRectangle(err)");
      expect(result.error).toContain("Failed SdRectangle");
      expect(result.error).toContain("width");
      expect(result.error).toContain("height");
    });

    test("needs_input with no missing[] → falls back to 'required args'", () => {
      const result = classifyDispatchResult("SdExport", {
        status: "needs_input",
        state: "idle",
        summary: "waiting…",
      });
      expect(result.fired).toBe("SdExport(err)");
      expect(result.error).toContain("required args");
    });

    test("success → fired = verb, no error", () => {
      const result = classifyDispatchResult("IfcWall", { status: "success", state: "idle", summary: "" });
      expect(result.fired).toBe("IfcWall");
      expect(result.error).toBeUndefined();
    });

    test("error status → fired ends with (err), forwards summary", () => {
      const result = classifyDispatchResult("SdBox", {
        status: "error",
        state: "idle",
        summary: "geometry is degenerate",
      });
      expect(result.fired).toBe("SdBox(err)");
      expect(result.error).toContain("geometry is degenerate");
    });
  });

  describe("Layer 2: summary output (buildDispatchSummary)", () => {
    test("needs_input error appears in summary — agent can self-correct", () => {
      const dispatches = [{ name: "SdRectangle", arguments: {} }];
      const fired = ["SdRectangle(err)"];
      const errors = ["Failed SdRectangle: missing width, height."];

      const summary = buildDispatchSummary(dispatches, fired, errors);

      // The summary IS what gets pushed to _history.
      // The model's next turn will read this string — it must contain the error.
      expect(summary).toContain("Failed SdRectangle");
      expect(summary).toContain("missing");
      expect(summary).toContain("width");
      expect(summary).toContain("height");
      // Must NOT contain "Built:" — that would mask the error from the model
      expect(summary).not.toContain("Built:");
    });

    test("success dispatch produces 'Built:' summary, no error text", () => {
      const dispatches = [{ name: "IfcWall", arguments: { length: 5, thickness: 0.2, height: 2.8 } }];
      const fired = ["IfcWall"];
      const errors: string[] = [];

      const summary = buildDispatchSummary(dispatches, fired, errors);

      expect(summary).toContain("Built:");
      expect(summary).not.toContain("Failed");
    });

    test("mixed turn: one success, one needs_input → error and built both appear", () => {
      const dispatches = [
        { name: "IfcWall", arguments: { length: 5 } },
        { name: "SdExport", arguments: {} },
      ];
      const fired = ["IfcWall", "SdExport(err)"];
      const errors = ["Failed SdExport: missing required args."];

      const summary = buildDispatchSummary(dispatches, fired, errors);

      expect(summary).toContain("Failed SdExport");
      expect(summary).toContain("Built:");
    });
  });

  describe("Layer 3: audience channel split", () => {
    const dispatches = [{ name: "SdRectangle", arguments: {} }];
    const fired = ["SdRectangle(err)"];
    const errors = ["Failed SdRectangle: missing width, height."];

    test("audience:'agent' (default) — error in summary for self-correction", () => {
      const agentSummary = buildDispatchSummary(dispatches, fired, errors, { audience: "agent" });
      expect(agentSummary).toContain("Failed SdRectangle");
    });

    test("audience:'user' — error stripped from visible bubble", () => {
      const userSummary = buildDispatchSummary(dispatches, fired, errors, { audience: "user" });
      expect(userSummary).not.toContain("Failed");
      expect(userSummary).not.toContain("SdRectangle");
    });

    test("no opts (default) behaves like audience:'agent'", () => {
      const defaultSummary = buildDispatchSummary(dispatches, fired, errors);
      expect(defaultSummary).toContain("Failed SdRectangle");
    });
  });
});
