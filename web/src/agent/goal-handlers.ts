// goal-handlers.ts — Dispatch handlers for create_goal / update_goal / get_goal (#980).
// Register by calling registerGoalHandlers() from main.ts during app init.

import { createGoal, getGoal, transitionGoal } from "./goal-state";
import { registerHandlers } from "../commands/dispatch";

export function registerGoalHandlers(): void {
  registerHandlers({
    create_goal: async (args) => {
      const objective = typeof args["objective"] === "string" ? args["objective"] : "";
      if (!objective) return { error: "objective is required" };
      const tokenBudget = typeof args["token_budget"] === "number" ? args["token_budget"] : undefined;
      const goal = await createGoal(objective, tokenBudget);
      return { id: goal.id, status: goal.status, objective: goal.objective };
    },

    update_goal: async (args) => {
      if (args["status"] !== "complete") return { error: "status must be \"complete\"" };
      const goal = await transitionGoal("complete");
      if (!goal) return { error: "no active goal" };
      return { id: goal.id, status: goal.status };
    },

    get_goal: async () => {
      const goal = await getGoal();
      if (!goal) return { status: "no_goal" };
      return goal;
    },
  });
}
