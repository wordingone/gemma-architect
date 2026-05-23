// #1678 — Agent dispatch must reject dimension args for parametric BIM elements.
// The agent places elements (position/host/level); element dimensions are fixed by asset.
// Any attempt to pass width/height/riser/tread/count to SdWindow/SdDoor/SdStair
// must produce ArgValidationError — the agent cannot resize parametric elements.
import { describe, test, expect } from "bun:test";
import { dispatch } from "../src/commands/dispatch";

async function expectDimBlocked(verb: string, args: Record<string, unknown>, blockedArg: string) {
  const r = await dispatch(verb, args);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.error).toBe("ArgValidationError");
    expect(r.detail ?? "").toContain(blockedArg);
  }
}

async function expectNotArgError(verb: string, args: Record<string, unknown>) {
  const r = await dispatch(verb, args);
  if (!r.ok) {
    expect(r.error).not.toBe("ArgValidationError");
  }
}

describe("agent-no-resize (#1678)", () => {
  // SdDoor

  test("SdDoor rejects width arg", () => expectDimBlocked("SdDoor", { position: [0, 0, 0], width: 1.5 }, "width"));
  test("SdDoor rejects height arg", () => expectDimBlocked("SdDoor", { position: [0, 0, 0], height: 2.5 }, "height"));

  test("SdDoor accepts placement-only args (doorType + position)", () =>
    expectNotArgError("SdDoor", { doorType: "interior", position: [0, 0, 0] }));

  // SdWindow

  test("SdWindow rejects width arg", () => expectDimBlocked("SdWindow", { position: [0, 0, 0], width: 0.6 }, "width"));
  test("SdWindow rejects height arg", () => expectDimBlocked("SdWindow", { position: [0, 0, 0], height: 1.2 }, "height"));

  test("SdWindow accepts placement-only args (windowType + position)", () =>
    expectNotArgError("SdWindow", { windowType: "eg", position: [0, 0, 0] }));

  // SdStair

  test("SdStair rejects riser arg", () => expectDimBlocked("SdStair", { start: [0, 0], end: [4, 0], riser: 0.2 }, "riser"));
  test("SdStair rejects tread arg", () => expectDimBlocked("SdStair", { start: [0, 0], end: [4, 0], tread: 0.3 }, "tread"));
  test("SdStair rejects width arg", () => expectDimBlocked("SdStair", { start: [0, 0], end: [4, 0], width: 1.5 }, "width"));
  test("SdStair rejects count arg", () => expectDimBlocked("SdStair", { start: [0, 0], end: [4, 0], count: 5 }, "count"));

  test("SdStair accepts placement-only args (start + end + type)", () =>
    expectNotArgError("SdStair", { start: [0, 0], end: [4, 0], type: "straight" }));
});
