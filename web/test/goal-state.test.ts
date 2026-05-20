// goal-state.test.ts — Unit tests for #980 goal state machine logic.
//
// goal-state.ts uses IndexedDB which is not available in Bun's Node-compat
// environment. Tests mirror the state-transition logic locally.

import { describe, expect, test } from "bun:test";

// ── Mirror of goal-state.ts types ─────────────────────────────────────────────

type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

type Goal = {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedMs: number;
  createdAtMs: number;
  updatedAtMs: number;
};

// ── Mirror of state-transition logic ──────────────────────────────────────────

function createGoal(objective: string, tokenBudget?: number): Goal {
  return {
    id: "test-uuid-" + Math.random().toString(36).slice(2),
    objective,
    status: "active",
    tokenBudget,
    tokensUsed: 0,
    timeUsedMs: 0,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
}

function updateGoalTokens(goal: Goal, tokensIn: number, tokensOut: number): Goal {
  if (goal.status !== "active") return goal;
  const updated = { ...goal, tokensUsed: goal.tokensUsed + tokensIn + tokensOut, updatedAtMs: Date.now() };
  if (updated.tokenBudget != null && updated.tokensUsed >= updated.tokenBudget) {
    updated.status = "budget_limited";
  }
  return updated;
}

function transitionGoal(goal: Goal, status: GoalStatus): Goal {
  return { ...goal, status, updatedAtMs: Date.now() };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("goal-state — createGoal", () => {
  test("creates goal with status active", () => {
    const goal = createGoal("Build a two-story house");
    expect(goal.status).toBe("active");
    expect(goal.objective).toBe("Build a two-story house");
    expect(goal.tokensUsed).toBe(0);
  });

  test("creates goal with optional token budget", () => {
    const goal = createGoal("Design office", 10000);
    expect(goal.tokenBudget).toBe(10000);
  });

  test("replacement generates a new UUID", () => {
    const g1 = createGoal("House A");
    const g2 = createGoal("House B");
    expect(g1.id).not.toBe(g2.id);
  });
});

describe("goal-state — updateGoalTokens", () => {
  test("increments tokensUsed by tokensIn + tokensOut", () => {
    const goal = createGoal("Test", 5000);
    const updated = updateGoalTokens(goal, 200, 300);
    expect(updated.tokensUsed).toBe(500);
    expect(updated.status).toBe("active");
  });

  test("transitions active → budget_limited when tokensUsed reaches budget", () => {
    const goal = createGoal("Test", 1000);
    const updated = updateGoalTokens(goal, 600, 400);
    expect(updated.tokensUsed).toBe(1000);
    expect(updated.status).toBe("budget_limited");
  });

  test("transitions on exceeding (not just reaching) budget", () => {
    const goal = createGoal("Test", 1000);
    const updated = updateGoalTokens(goal, 600, 500);
    expect(updated.tokensUsed).toBe(1100);
    expect(updated.status).toBe("budget_limited");
  });

  test("no-ops when goal is not active", () => {
    const goal = { ...createGoal("Test", 1000), status: "paused" as GoalStatus };
    const updated = updateGoalTokens(goal, 999, 999);
    expect(updated.status).toBe("paused");
    expect(updated.tokensUsed).toBe(0);
  });

  test("no-ops when already budget_limited", () => {
    const goal = { ...createGoal("Test", 1000), status: "budget_limited" as GoalStatus, tokensUsed: 1001 };
    const updated = updateGoalTokens(goal, 500, 500);
    expect(updated.status).toBe("budget_limited");
    expect(updated.tokensUsed).toBe(1001);
  });
});

describe("goal-state — transitionGoal", () => {
  test("active → paused", () => {
    const goal = createGoal("Build house");
    const updated = transitionGoal(goal, "paused");
    expect(updated.status).toBe("paused");
    expect(updated.objective).toBe("Build house");
  });

  test("active → complete", () => {
    const goal = createGoal("Build house");
    const updated = transitionGoal(goal, "complete");
    expect(updated.status).toBe("complete");
  });

  test("paused → active (resume)", () => {
    const goal = { ...createGoal("Build house"), status: "paused" as GoalStatus };
    const updated = transitionGoal(goal, "active");
    expect(updated.status).toBe("active");
  });

  test("budget_limited → complete (manual override)", () => {
    const goal = { ...createGoal("Build house", 1000), status: "budget_limited" as GoalStatus };
    const updated = transitionGoal(goal, "complete");
    expect(updated.status).toBe("complete");
  });

  test("preserves tokensUsed across transition", () => {
    const goal = { ...createGoal("Build house", 5000), tokensUsed: 3200 };
    const updated = transitionGoal(goal, "complete");
    expect(updated.tokensUsed).toBe(3200);
  });
});
