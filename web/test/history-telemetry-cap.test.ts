// history-telemetry-cap.test.ts — §C (#990) bounds enforcement for _history and telemetry ring.
//
// Mirrors the core logic from:
//   chat-panel.ts  → _enforceHistoryBudget()  (§C-hist)
//   telemetry.ts   → recordTurn() with RING_SIZE=1000 (§C-telem)

import { describe, expect, test } from "bun:test";

// ── Mirror of _enforceHistoryBudget from chat-panel.ts ────────────────────────
// Keep in sync with web/src/chat/chat-panel.ts `_enforceHistoryBudget`.

type HistoryMsg = { role: "user" | "assistant"; content: string };

const HISTORY_BUDGET_CHARS = 32768; // 16384 ctx × 0.5 × 4 chars/tok

function enforceHistoryBudget(history: HistoryMsg[]): void {
  while (
    history.length > 1 &&
    history.reduce((s, m) => s + m.content.length, 0) > HISTORY_BUDGET_CHARS
  ) {
    history.shift();
  }
}

// ── Mirror of recordTurn ring from telemetry.ts ───────────────────────────────
// Keep in sync with web/src/agent/telemetry.ts RING_SIZE=1000.

const RING_SIZE = 1000;

function makeRing(): { push: (v: number) => void; length: () => number; all: () => number[] } {
  const _r: number[] = [];
  return {
    push(v) { if (_r.length >= RING_SIZE) _r.shift(); _r.push(v); },
    length() { return _r.length; },
    all() { return [..._r]; },
  };
}

// ── History budget tests ──────────────────────────────────────────────────────

describe("#990 §C-hist — _enforceHistoryBudget", () => {

  test("history under budget: no entries evicted", () => {
    const h: HistoryMsg[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    enforceHistoryBudget(h);
    expect(h.length).toBe(2);
  });

  test("history over budget: oldest entries evicted, total stays within budget", () => {
    const h: HistoryMsg[] = [];
    // Push 10 entries of 5000 chars each → total = 50000 > 32768
    for (let i = 0; i < 10; i++) {
      h.push({ role: i % 2 === 0 ? "user" : "assistant", content: "x".repeat(5000) });
    }
    expect(h.reduce((s, m) => s + m.content.length, 0)).toBeGreaterThan(HISTORY_BUDGET_CHARS);
    enforceHistoryBudget(h);
    const totalChars = h.reduce((s, m) => s + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(HISTORY_BUDGET_CHARS);
    expect(h.length).toBeGreaterThan(0); // never empties
  });

  test("single huge message: not evicted (always preserves ≥1 entry)", () => {
    const h: HistoryMsg[] = [
      { role: "assistant", content: "x".repeat(100000) }, // way over budget
    ];
    enforceHistoryBudget(h);
    expect(h.length).toBe(1); // cannot evict the last entry
  });

  test("incremental pushes: budget is maintained after each push", () => {
    const h: HistoryMsg[] = [];
    const CHUNK = 4000; // chars per message
    // Push 20 entries; after each push enforce budget
    for (let i = 0; i < 20; i++) {
      h.push({ role: i % 2 === 0 ? "user" : "assistant", content: "a".repeat(CHUNK) });
      enforceHistoryBudget(h);
      const total = h.reduce((s, m) => s + m.content.length, 0);
      expect(total).toBeLessThanOrEqual(HISTORY_BUDGET_CHARS);
    }
  });

  test("compact path preserved: compact summary + 4 last turns survives budget", () => {
    // Simulates _compactHistory() output: 1 compact + 4 tail turns, each short.
    // After compact, total is small — no entries should be evicted.
    const compactContent = "[Compacted. Goal: \"build a house\". Dispatches: ...]";
    const h: HistoryMsg[] = [
      { role: "assistant", content: compactContent },
      { role: "user",      content: "now add a door" },
      { role: "assistant", content: "SdDoor placed." },
      { role: "user",      content: "add a window" },
      { role: "assistant", content: "SdWindow placed." },
    ];
    const preBudget = h.reduce((s, m) => s + m.content.length, 0);
    expect(preBudget).toBeLessThan(HISTORY_BUDGET_CHARS); // compact output is small
    enforceHistoryBudget(h);
    expect(h.length).toBe(5); // nothing evicted — compact preserved intact
  });
});

// ── Telemetry ring tests ──────────────────────────────────────────────────────

describe("#990 §C-telem — telemetry ring cap (RING_SIZE=1000)", () => {

  test("ring stays bounded at 1000 after 1001 pushes", () => {
    const ring = makeRing();
    for (let i = 0; i < 1001; i++) ring.push(i);
    expect(ring.length()).toBe(1000);
  });

  test("ring drops oldest on overflow (FIFO)", () => {
    const ring = makeRing();
    for (let i = 0; i < 1001; i++) ring.push(i);
    // oldest (0) evicted, newest (1000) present
    expect(ring.all()[0]).toBe(1);
    expect(ring.all()[999]).toBe(1000);
  });

  test("ring under cap: all entries preserved", () => {
    const ring = makeRing();
    for (let i = 0; i < 500; i++) ring.push(i);
    expect(ring.length()).toBe(500);
  });

  test("ring at exactly cap: no eviction", () => {
    const ring = makeRing();
    for (let i = 0; i < 1000; i++) ring.push(i);
    expect(ring.length()).toBe(1000);
    expect(ring.all()[0]).toBe(0);
    expect(ring.all()[999]).toBe(999);
  });
});
