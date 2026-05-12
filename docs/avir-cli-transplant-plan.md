# avir-cli Transplant Plan

Audit and implementation roadmap for adapting avir-cli's hook infrastructure and prompt
architecture to gemma-architect's browser-resident agent.

**Issue**: #409 | **Phase**: 2 of 3 (audit + plan)

---

## 1. System Prompt Structure

### avir-cli (source)

`src/utils/claudemd.ts` — `getMemoryFiles()` assembles the system prompt from a 6-layer hierarchy:

1. Managed CLAUDE.md (Anthropic-supplied defaults)
2. User-global `~/.claude/CLAUDE.md`
3. Project-local `.claude/CLAUDE.md` (repo root)
4. Local override `.claude/CLAUDE.local.md`
5. AutoMem — file-based memories from `C:/Users/.../memory/*.md`
6. TeamMem — team-scoped rules from `.claude/teams/*/rules/`

Result: a dynamically assembled system prompt that reflects per-project context, user
preferences, and persistent memory — updated every session.

### gemma-architect (current)

`web/src/agent/agent-harness.ts:463-522` — single static string, hardcoded. Includes
spatial-dictionary verbs, dispatch schema, and few-shot examples. No file loading.
No session-specific context injection. Same prompt every turn.

### Gap

| Capability | avir-cli | gemma-architect |
|---|---|---|
| Per-project context | CLAUDE.md hierarchy | Not present |
| User memory | AutoMem files | Not present |
| Dynamic assembly | Every session | Not present |
| Session-specific injection | Yes | Not present |

### Transplant verdict

**Partial transplant.** The browser cannot read the filesystem, so the full hierarchy is
not portable. What IS portable:

- `buildSystemPrompt()` extended to accept an optional `sessionContext: string` arg that
  callers can inject (e.g., current scene state, active skill set, session skill counts).
- A `window.__gemmaPromptContext` hook: if defined, its return value is appended to the
  base system prompt before each `runAgentTurn` call. Allows external callers (gemma-verify,
  test harnesses) to inject fixture context without editing the static block.

**Not porting**: filesystem hierarchy loading. Gemma-architect's context is smaller and
more focused; a static base prompt with a runtime injection hook covers the use case.

---

## 2. PreToolUse Hooks → Pre-dispatch Interceptor

### avir-cli (source)

`src/query/toolHooks.ts` — `handlePreToolUseHooks()`:
- Runs every shell script in `.claude/hooks/` with `event_type = "PreToolUse"`.
- Scripts receive tool name + input as JSON on stdin.
- Exit 2 → tool is cancelled; stderr injected as a tool-error message visible to the model.
- Exit 0 → tool proceeds normally.

Real-world examples from `B:/M/avir/eli/.claude/hooks/`:
- `gemma-verify-gate.sh` — blocks `gh pr create|merge` unless a PASS JSON exists.
- `pretooluse-block-playwright.sh` — blocks direct playwright calls.
- `block-prod-write.sh` — blocks writes to production paths.

### gemma-architect (current)

`web/src/chat-panel.ts:287-309` — `_runDispatches()`:
```ts
for (const d of resp.dispatches) {
  const out = await invokeCommand({ command: d.verb, parameters: d.args, ... });
  // no pre-check before invokeCommand
}
```

No pre-dispatch check. Verbs are executed immediately. Invalid verb → arg-validation error
from the handler after dispatch, not before.

### Gap

The model can emit any verb string; only the handler catches invalid inputs. No way for
external code or session rules to block or modify a dispatch before it fires.

### Transplant: `window.__gemma_dispatch_hooks.pre` array

Add a pre-dispatch hook registry to `_runDispatches`:

```ts
// chat-panel.ts — inside _runDispatches, before invokeCommand:
const hooks: PreDispatchHook[] = (window as any).__gemma_dispatch_hooks?.pre ?? [];
for (const hook of hooks) {
  const result = hook(d);
  if (result?.block) {
    errors.push(`blocked: ${d.verb} — ${result.reason ?? "pre-dispatch hook"}`);
    continue; // skip invokeCommand
  }
}
```

Hook signature: `(dispatch: AgentDispatch) => {block: boolean; reason?: string} | null`.

Expose as `window.__gemma_dispatch_hooks = { pre: [] }` initialized in `main.ts`.

This gives gemma-verify, test harnesses, and future safetyCheck logic a clean extension
point without modifying agent-harness or the dispatch registry.

**First hook to register**: dictionary-verb gate — block any verb not in
`web/src/spatial-dictionary.yaml`'s `canonical_name` list. Currently only the console DSL
catches unknown verbs (Surface 7); the chat dispatch path does not.

---

## 3. Stop Hooks → `agent:turn-complete` Event

### avir-cli (source)

`src/query/stopHooks.ts` — `handleStopHooks()`:
- Runs every shell script with `event_type = "Stop"` after each model turn.
- Exit 2 → stderr injected as next user message, triggering a continuation turn.
- Pattern used for: mail-check notification, inject-mail-notification, visual verification.

The stop-hook → continuation-turn loop is the mechanism that allows avir-cli to do
multi-agent coordination and long-running tasks without human re-prompting.

### gemma-architect (current)

After `_runDispatches()` completes in `_executeAndPush`, the turn is done. Nothing fires.
`viewer:scene-changed` fires on geometry changes, but nothing reads it to continue the
conversation. No structured event that external code can hook to react post-turn.

### Gap

No equivalent to the stop-hook → continuation mechanism. Post-dispatch observers cannot
inject follow-up prompts. Gemma-verify cannot detect turn completion without polling.

### Transplant: `agent:turn-complete` event

After `_runDispatches` in `_executeAndPush`, dispatch:

```ts
window.dispatchEvent(new CustomEvent("agent:turn-complete", {
  detail: {
    verbs: resp.dispatches.map(d => d.verb),
    sceneObjects: (window as any).__viewer?.scene?.children?.length ?? 0,
    turnMs: Date.now() - turnStart,
  }
}));
```

External code (gemma-verify Surface assertions, visual-check orchestration) can listen:
```ts
window.addEventListener("agent:turn-complete", (e) => { /* react */ });
```

For the continuation-turn equivalent: if a registered stop observer returns a string,
append it to `_history` as `{role: "user", content: observerText}` and trigger a new
`_send` cycle. This is the browser analog of avir-cli's exit-2 continuation.

Register stop observers via `window.__gemma_dispatch_hooks.stop`:
```ts
// stop observer signature:
(detail: TurnCompleteDetail) => string | null
// null = no continuation; string = inject as next user message
```

---

## 4. Multi-turn Lifecycle → `window.__gemmaSession`

### avir-cli (source)

`src/services/telemetry/lifecycle.ts` — `emitLifecycleEvent()`:
- Appends structured JSON to `~/.avir/telemetry/lifecycle.jsonl`.
- Events: `session_start`, `session_end`, `compact_fire`, `compact_boundary`,
  `model_switch`, `api_error`, `tool_use`, `tool_result`.
- Enables: session replay, error rate tracking, turn timing analysis.

### gemma-architect (current)

`web/src/telemetry.ts` — `lastTurn()` tracks per-turn pp_tps/tg_tps/tokens for the perf
strip. No session-level events. No error counting. No turn numbering.

### Gap

No session boundary events. gemma-verify cannot detect `api_error` from inside a browser
session. The perf strip shows last-turn data only; session aggregates are not accessible.

### Transplant: `window.__gemmaSession` global

Initialize in `ChatPanel._send()` on first call:

```ts
(window as any).__gemmaSession ??= {
  startTs: Date.now(),
  turnCount: 0,
  dispatchCount: 0,
  errorCount: 0,
  lastError: null,
};
```

Update on each turn:
- `turnCount++` at top of `_send()`
- `dispatchCount += resp.dispatches.length` in `_executeAndPush`
- `errorCount++; lastError = err.message` in the catch block

This makes session state observable via `window.__gemmaSession` from CDP evaluate
calls in gemma-verify, closing the gap between avir-cli's lifecycle JSONL and what
gemma-architect can surface.

---

## 5. Tool-use Validation Comparison

### avir-cli (source)

Tool calls are strongly typed via the Anthropic SDK's `tool_choice` + schema definitions.
The model emits JSON conforming to the schema; the SDK validates before execution. Invalid
tool calls produce a structured error response, not an exception.

### gemma-architect (current)

`invokeCommand()` in `command-session.ts` takes `{command, parameters}` and dispatches to
a handler registry. The handler validates args (ArgValidationError from dispatch.ts). But:
- Verb validation is runtime (unknown verb → handler not found → silent skip).
- Arg validation is per-handler (not schema-driven).
- The model can emit a structurally valid JSON block with an invalid verb and it will
  silently not dispatch.

`classifyDispatchResult()` post-processes the result but cannot report a verb that was
never tried.

### Transplant verdict

**Structural gap**: avir-cli uses the Anthropic function-calling API (structured outputs);
gemma-architect uses free-text XML parsing (`<dispatch>` blocks in `agent-harness.ts`).
This is the root cause of the validation gap — not a missing code pattern.

**Short-term fix** (pre-dispatch hook, Quick Win 1 above): check verb against spatial
dictionary before firing. Reports unknown verbs back to the model as a tool-error analog.

**Long-term**: structured dispatch output (JSON mode with schema) in `agent-harness.ts`
for Gemma-4 when the model reliably supports it. Tracked as future work.

---

## Quick Wins (Phase 3)

Three highest-leverage transplants, ordered by implementation cost vs. impact.

### QW-1: Pre-dispatch hook registry (PreToolUse analog)

**Files**: `web/src/chat-panel.ts`, `web/src/main.ts`

**Change**:
1. Add `window.__gemma_dispatch_hooks = { pre: [], stop: [] }` init in `main.ts`.
2. In `_runDispatches()`, run `pre` hooks before each `invokeCommand` call.
3. Register a default verb-validation hook in `main.ts` that checks against the
   spatial-dictionary verb list (import the same list Surface 7 uses).

**Verify surface**: `pre-dispatch-gate` — register a blocking hook for a test verb,
confirm `invokeCommand` never fires. Observable via `window.__gemmaTest.preDispatchHookCalls`.

### QW-2: `agent:turn-complete` event (Stop hook analog)

**Files**: `web/src/chat-panel.ts`

**Change**:
1. Record `turnStart = Date.now()` at top of `_send()`.
2. In `_executeAndPush()` after `_runDispatches`, dispatch `agent:turn-complete` with
   `{verbs, sceneObjects, turnMs}`.
3. If any `stop` hook in `__gemma_dispatch_hooks.stop` returns a string, push it as
   next user message and call `_send()` (cap continuation depth at 3).

**Verify surface**: `agent-turn-complete-event` — listen for event, send a chat message,
confirm event fires with `detail.verbs.length > 0`.

### QW-3: Session lifecycle global (lifecycle.ts analog)

**Files**: `web/src/chat-panel.ts`

**Change**:
1. Lazy-init `window.__gemmaSession` on first `_send()`.
2. Increment `turnCount` / `dispatchCount` / `errorCount` at correct points.
3. Expose via `window.__gemmaSession`.

**Verify surface**: `session-lifecycle` — trigger one chat turn, confirm
`window.__gemmaSession.turnCount >= 1` and `startTs` is a valid timestamp.

---

## Implementation Order

```
QW-3 (session lifecycle) → QW-1 (pre-dispatch gate) → QW-2 (turn-complete event)
```

QW-3 first: no dependencies, lowest risk, immediately useful for gemma-verify.
QW-1 second: depends on spatial-dictionary verb list (already loaded for Surface 7).
QW-2 last: stop-continuation loop needs care around infinite-loop guard.

Each QW is a separate PR. Each PR adds one gemma-verify surface assertion.
