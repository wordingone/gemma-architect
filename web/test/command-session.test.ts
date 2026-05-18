import { beforeEach, describe, expect, test } from "bun:test";
import { getDictionary } from "../src/commands/dictionary";
import { registerHandler, unregisterHandler } from "../src/commands/dispatch";
import {
  clearCommandSession,
  parseToolEnvelope,
  provideSessionPick,
  startCommandSession,
} from "../src/commands/command-session";

function clearAllHandlers() {
  for (const e of getDictionary()) unregisterHandler(e.canonical_name);
}

beforeEach(() => {
  clearAllHandlers();
  clearCommandSession();
});

describe("command session", () => {
  test("parses function envelope and legacy envelope", () => {
    const a = parseToolEnvelope({ command: "SdLine", parameters: { start: [0, 0] } });
    const b = parseToolEnvelope({ verb: "SdLine", args: { start: [0, 0] } });
    expect(a?.command).toBe("SdLine");
    expect(b?.command).toBe("SdLine");
  });

  test("line command collects picks then executes", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdLine", (args) => {
      called = args;
      return { ok: true };
    });
    const s0 = await startCommandSession({
      command: "SdLine",
      parameters: {},
      metadata: { source: "palette" },
    });
    expect(s0.status).toBe("needs_input");
    const s1 = await provideSessionPick([1, 2]);
    expect(s1.status).toBe("needs_input");
    const s2 = await provideSessionPick([4, 6]);
    expect(s2.status).toBe("success");
    const r1 = called as unknown as Record<string, unknown>;
    expect(r1.start).toEqual([1, 2]);
    expect(r1.end).toEqual([4, 6]);
  });

  test("rectangle command coerces units", async () => {
    let called: Record<string, unknown> | null = null;
    registerHandler("SdRectangle", (args) => {
      called = args;
      return { ok: true };
    });
    const s = await startCommandSession({
      command: "SdRectangle",
      parameters: { width: "120cm", length: "2000mm", center: "(1,2)" },
      metadata: { source: "agent" },
    });
    expect(s.status).toBe("success");
    const r2 = called as unknown as Record<string, unknown>;
    expect(r2.width).toBe(1.2);
    expect(r2.length).toBe(2);
    expect(r2.center).toEqual([1, 2]);
  });
});

