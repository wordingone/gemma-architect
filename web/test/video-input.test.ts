// video-input.test.ts — §#693 frame sampler + video content block pipeline.
//
// Mirrors the logic in web/src/agent/video-input.ts:
//   sampleFrames() — stride-based sampling, max cap
//   buildVideoDataUrls() — gate check + empty guard

import { describe, expect, test } from "bun:test";

// ── Mirror of sampleFrames ────────────────────────────────────────────────────

const VIDEO_FPS = 1;
const MAX_VIDEO_FRAMES = 60;

function sampleFrames(
  frames:     unknown[],
  captureRate = 4,
  targetFps   = VIDEO_FPS,
  maxFrames   = MAX_VIDEO_FRAMES,
): unknown[] {
  if (frames.length === 0) return [];
  const stride = Math.max(1, Math.round(captureRate / targetFps));
  const sampled: unknown[] = [];
  for (let i = 0; i < frames.length && sampled.length < maxFrames; i += stride) {
    sampled.push(frames[i]);
  }
  return sampled;
}

function makeFrames(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe("#693 §video-input — sampleFrames", () => {

  test("empty input returns empty output", () => {
    expect(sampleFrames([])).toEqual([]);
  });

  test("single frame → single frame", () => {
    expect(sampleFrames([42])).toEqual([42]);
  });

  test("4fps capture → 1fps output: stride=4, takes every 4th", () => {
    // 8 capture frames at 4fps → 2 model frames at 1fps
    const frames = makeFrames(8); // [0,1,2,3,4,5,6,7]
    const result = sampleFrames(frames, 4, 1);
    expect(result).toEqual([0, 4]);
  });

  test("captureRate=4 targetFps=2: stride=2", () => {
    const frames = makeFrames(6); // [0,1,2,3,4,5]
    const result = sampleFrames(frames, 4, 2);
    // stride = round(4/2) = 2 → indices 0,2,4
    expect(result).toEqual([0, 2, 4]);
  });

  test("captureRate=1 targetFps=1: stride=1, pass-through", () => {
    const frames = makeFrames(5);
    expect(sampleFrames(frames, 1, 1)).toEqual([0, 1, 2, 3, 4]);
  });

  test("output capped at MAX_VIDEO_FRAMES (60)", () => {
    // 300 frames at stride 1 (captureRate=targetFps) → cap at 60
    const frames = makeFrames(300);
    const result = sampleFrames(frames, 1, 1, 60);
    expect(result.length).toBe(60);
    expect(result[0]).toBe(0);
    expect(result[59]).toBe(59);
  });

  test("output capped at custom maxFrames", () => {
    const frames = makeFrames(20);
    const result = sampleFrames(frames, 1, 1, 5);
    expect(result.length).toBe(5);
  });

  test("stride rounds correctly: captureRate=3 targetFps=1 → stride=3", () => {
    // round(3/1) = 3
    const frames = makeFrames(9); // 0-8
    const result = sampleFrames(frames, 3, 1);
    expect(result).toEqual([0, 3, 6]);
  });

  test("stride minimum is 1 even when targetFps > captureRate", () => {
    // targetFps > captureRate → stride = max(1, round(4/8)) = max(1,0) = 1
    const frames = makeFrames(4);
    const result = sampleFrames(frames, 4, 8);
    expect(result).toEqual([0, 1, 2, 3]); // all frames (stride=1)
  });

  test("60 capture frames at 4fps → 15 model frames at 1fps", () => {
    const frames = makeFrames(60); // 15 seconds at 4fps
    const result = sampleFrames(frames, 4, 1);
    // stride=4 → indices 0,4,8,...,56 → 15 frames
    expect(result.length).toBe(15);
    expect(result[0]).toBe(0);
    expect(result[14]).toBe(56);
  });
});

// ── Mirror of buildVideoDataUrls gate logic ───────────────────────────────────

describe("#693 §video-input — buildVideoDataUrls gate", () => {

  function fakeBuildVideoDataUrls(
    frames: unknown[],
    enabled: boolean,
  ): unknown[] {
    if (!enabled) return [];
    if (frames.length === 0) return [];
    // Simulate sampling (no actual encoding in unit tests)
    return sampleFrames(frames);
  }

  test("returns empty when gate disabled (VITE_VIDEO_INPUT unset)", () => {
    const result = fakeBuildVideoDataUrls(makeFrames(10), false);
    expect(result).toEqual([]);
  });

  test("returns empty when frames array is empty even if enabled", () => {
    const result = fakeBuildVideoDataUrls([], true);
    expect(result).toEqual([]);
  });

  test("returns sampled frames when gate enabled and frames present", () => {
    const result = fakeBuildVideoDataUrls(makeFrames(8), true);
    // 8 frames at stride 4 → [0, 4]
    expect(result.length).toBe(2);
  });
});

// ── Video content block shape ─────────────────────────────────────────────────
// Verifies the message structure the model-worker expects for video turns.

describe("#693 §video-input — video content block message structure", () => {

  type VideoBlock = { type: "video"; video: unknown[] };
  type TextBlock  = { type: "text";  text: string };
  // content is string for system/unchanged messages, array for spliced user messages
  type ContentMsg = { role: string; content: string | Array<VideoBlock | TextBlock> };

  function spliceVideoIntoLastUser(
    messages: Array<{ role: string; content: string }>,
    videoFrames: unknown[],
  ): ContentMsg[] {
    const lastUser = [...messages] as ContentMsg[];
    let ui = -1;
    for (let i = lastUser.length - 1; i >= 0; i--) {
      if (lastUser[i].role === "user") { ui = i; break; }
    }
    if (ui < 0) return lastUser;
    const spliced = [...lastUser];
    spliced[ui] = {
      role: "user",
      content: [
        { type: "video", video: videoFrames },
        { type: "text",  text: lastUser[ui].content as string },
      ],
    };
    return spliced;
  }

  const baseMessages = [
    { role: "system", content: "You are a spatial assistant." },
    { role: "user",   content: "What changed in the scene?" },
  ];
  const fakeFrames = ["url1", "url2", "url3"];

  test("video block is first content item in last user message", () => {
    const result = spliceVideoIntoLastUser(baseMessages, fakeFrames);
    const lastUser = result.find(m => m.role === "user")!;
    const blocks = lastUser.content as Array<VideoBlock | TextBlock>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0].type).toBe("video");
  });

  test("text block preserves original user prompt", () => {
    const result = spliceVideoIntoLastUser(baseMessages, fakeFrames);
    const lastUser = result.find(m => m.role === "user")!;
    const blocks = lastUser.content as Array<VideoBlock | TextBlock>;
    expect((blocks[1] as TextBlock).type).toBe("text");
    expect((blocks[1] as TextBlock).text).toBe("What changed in the scene?");
  });

  test("video block contains all frame URLs", () => {
    const result = spliceVideoIntoLastUser(baseMessages, fakeFrames);
    const lastUser = result.find(m => m.role === "user")!;
    const blocks = lastUser.content as Array<VideoBlock | TextBlock>;
    expect((blocks[0] as VideoBlock).video).toEqual(fakeFrames);
  });

  test("system message is not modified", () => {
    const result = spliceVideoIntoLastUser(baseMessages, fakeFrames);
    const sys = result.find(m => m.role === "system")!;
    expect(sys.content).toBe("You are a spatial assistant.");
  });

  test("no-op when no user message present", () => {
    const sysOnly = [{ role: "system", content: "sys" }];
    const result = spliceVideoIntoLastUser(sysOnly, fakeFrames);
    expect(result.length).toBe(1);
  });
});
