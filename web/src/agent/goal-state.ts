// goal-state.ts — IndexedDB-backed goal state machine (#980).
// One goal per browser session (thread). Replacement generates a new UUID.

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type GoalTerminalReason = "complete" | "budget_limited" | "cap_reached" | "zero_dispatches";

export type Goal = {
  id: string;          // uuid, new on each replacement
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;  // cumulative tokens_in + tokens_out across all turns
  timeUsedMs: number;
  createdAtMs: number;
  updatedAtMs: number;
  continuationIterations?: number;  // §#1740: count of _runContinuation calls for this goal
  terminalReason?: GoalTerminalReason; // §#1740: why the continuation loop stopped
};

const DB_NAME = "gemma-cad";
const STORE_NAME = "thread_goal";
const RECORD_KEY = "current";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getGoal(): Promise<Goal | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    req.onsuccess = () => resolve((req.result as Goal | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setGoal(goal: Goal): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(goal, RECORD_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearGoal(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).delete(RECORD_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function createGoal(objective: string, tokenBudget?: number): Promise<Goal> {
  const goal: Goal = {
    id: crypto.randomUUID(),
    objective,
    status: "active",
    tokenBudget,
    tokensUsed: 0,
    timeUsedMs: 0,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
  await setGoal(goal);
  window.dispatchEvent(new CustomEvent("goal:changed", { detail: goal }));
  return goal;
}

// Atomically increment token usage. Transitions active → budget_limited when exhausted.
// §#1667: budget_limited is a SOFT cap — auto-continuation in chat-panel.ts stops
// (agent:turn-complete handler guards on goal.status === "active"), but manual sends
// are still allowed. Context may be near-full. User sees "Past budget" banner + system
// message advising to clear chat or continue manually.
export async function updateGoalTokens(tokensIn: number, tokensOut: number): Promise<Goal | null> {
  const goal = await getGoal();
  if (!goal || goal.status !== "active") return goal;
  goal.tokensUsed += tokensIn + tokensOut;
  goal.updatedAtMs = Date.now();
  if (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
    goal.status = "budget_limited";
  }
  await setGoal(goal);
  window.dispatchEvent(new CustomEvent("goal:changed", { detail: goal }));
  return goal;
}

export async function transitionGoal(status: GoalStatus): Promise<Goal | null> {
  const goal = await getGoal();
  if (!goal) return null;
  goal.status = status;
  goal.updatedAtMs = Date.now();
  await setGoal(goal);
  window.dispatchEvent(new CustomEvent("goal:changed", { detail: goal }));
  return goal;
}

// §#1740: record how many continuation turns ran and why the loop stopped.
export async function updateGoalContinuation(iterations: number, terminal: GoalTerminalReason): Promise<void> {
  const goal = await getGoal();
  if (!goal) return;
  goal.continuationIterations = iterations;
  goal.terminalReason = terminal;
  goal.updatedAtMs = Date.now();
  await setGoal(goal);
  window.dispatchEvent(new CustomEvent("goal:changed", { detail: goal }));
}

// In-memory cache for synchronous reads from synchronous prompt builders.
let _cachedGoal: Goal | null = null;

export function getCachedGoal(): Goal | null {
  return _cachedGoal;
}

window.addEventListener("goal:changed", (e) => {
  _cachedGoal = (e as CustomEvent<Goal>).detail;
});

// Warm cache from IDB on module load.
getGoal().then((g) => { _cachedGoal = g; }).catch(() => {});
