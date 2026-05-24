import { beforeEach, describe, expect, test } from "bun:test";
import { getDictionary } from "../src/commands/dictionary";
import { registerHandler, unregisterHandler } from "../src/commands/dispatch";
import { clearCommandSession, startCommandSession } from "../src/commands/command-session";

function clearAllHandlers() {
  for (const e of getDictionary()) unregisterHandler(e.name);
}

beforeEach(() => {
  clearAllHandlers();
  clearCommandSession();
});

describe("SdAlignObjects", () => {
  test("SdAlignObjects is in dictionary", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdAlignObjects");
    expect(entry).toBeDefined();
    expect(entry?.topology_role).toBe("transform");
  });

  test("dispatches with mode=left", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "left" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("left");
  });

  test("dispatches with mode=right", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "right" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("right");
  });

  test("dispatches with mode=center-h", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "center-h" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("center-h");
  });

  test("dispatches with mode=dist-v", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdAlignObjects", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdAlignObjects",
      parameters: { mode: "dist-v" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    expect((called as any)?.mode).toBe("dist-v");
  });

  test("has correct synonyms for align variations", () => {
    const dict = getDictionary();
    const entry = dict.find((e) => e.name === "SdAlignObjects");
    expect(entry?.synonyms).toContain("align left");
    expect(entry?.synonyms).toContain("align right");
    expect(entry?.synonyms).toContain("distribute horizontal");
  });
});
