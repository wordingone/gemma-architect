# Per-tab chat architecture — design decision

**Status:** Design / decision. Implementation issues drafted at §6; filed in follow-up after this doc is approved.

**Scope:** how the chat surface in `Model`, `Layout`, and `Research` tabs should be specialized so each agent context is tightly scoped to its tab's verb set, while shared state remains cross-readable.

**Out of scope:** the implementation of the Research tab itself (covered in `research-tab-design.md`), the implementation of Layout-tab-specific verbs (covered in #1843 umbrella sub-issues), and any cross-tab orchestration that requires the agent to actively coordinate between tabs (this doc keeps coordination read-only).

---

## 1. Question

User 2026-05-24 (verbatim, via #1856):

> *does the layout tab and research tab also need something like the 'create' tab for the user to be able to talk to the agent? should the context management and harness engineering for the different chat interfaces per the main 3 tabs be kept separate and specialized?*

Two parts. The doc answers both.

---

## 2. Decision

**Yes** on both questions:

- **D-A.** Layout tab and Research tab each get their own chat surface, alongside Model tab's existing CREATE chat.
- **D-B.** Each tab's chat is specialized: distinct system prompt, distinct verb subset, distinct few-shot, distinct conversation history. Shared underlying model worker; shared read-only access to the global stores.

**Architecture:** one `chat-panel` component class with three runtime `ChatContext` records, swapped on tab change. NOT three sibling instances. The reasons are in §4.

---

## 3. Why specialize per tab

### 3.1 Tighter few-shot

Each tab's agent operates in a small, well-defined verb space. Mixing all three tabs' verbs into one few-shot dilutes the model's pattern-matching:

| Tab | Verb count | Verb examples | Typical user phrasing |
|---|---|---|---|
| **Model** | ~40 (Sd* spatial) | `SdWall`, `SdSlab`, `SdRoof`, `SdDoor`, `SdLevel`, `SdArc`, `SdSpline`, NURBS verbs | "Build a 2-story house", "Add a clerestory window" |
| **Layout** | ~20 (sheet + draft) | `SdAddPanel`, `SdSetSheetScale`, `SdAddSection`, `SdAddElevation`, `SdAddDim`, layer-mgmt | "Add a section sheet at this clipping plane", "Make Sheet 2 1:50" |
| **Research** | 7 (per `research-tab-design.md` §5.1) | `SdSearch`, `SdFetch`, `SdSourceFile`, `SdCite`, `SdSummarize`, `SdQueryResearch`, `SdExportPDF` | "Find ADA ramp specs", "Cite the most recent BSI standard" |

A unified few-shot must cover all three pattern-spaces; 5-10 examples per tab × 3 tabs = 15-30 examples that compete for the model's attention. A tab-specialized few-shot has 5-10 examples focused on one pattern-space, giving 2-3× higher recall on the appropriate verb.

### 3.2 Cleaner context window

The verb dictionary alone is ~6-8k tokens when rendered as the schema portion of the system prompt. Restricting to one tab's subset trims this to ~1-3k. Combined with the few-shot delta, total context budget for actual user turns goes up by ~5-8k tokens — material on a model with an effective 32k window.

### 3.3 Task-appropriate parameters

Different tabs have different optimal generation parameters:

| Tab | Temperature | Max output tokens | Reason |
|---|---|---|---|
| Model | 0.7 | 1024 | Geometry creation benefits from variation; user-prompts often abstract ("a house") |
| Layout | 0.2 | 512 | Sheet placement is deterministic; user-prompts are precise ("section at A-A scale 1:50") |
| Research | 0.5 | 2048 | Summarization needs longer outputs + some variation in phrasing |

Per-context generation parameters fall naturally out of per-context system prompts.

### 3.4 Per-tab token budget independence

Each tab's chat has its own conversation history persisted to IDB. When the user is deep into a research session and hits the budget cap on that tab's history, it doesn't affect their model-tab history. Tabs are conversational silos by design.

---

## 4. Approach — one chat-panel, three contexts (not three instances)

### 4.1 Options considered

**Option A — three sibling `chat-panel` instances.** Three separate DOM trees + three separate JS instances + three message-broker pipes. Maximum isolation; maximum surface area.

**Option B — one `chat-panel` class, three `ChatContext` records, swap on tab change.** One DOM tree (visible chat); three state records, one per tab; swap-in-place on tab change.

**Decision: Option B.**

### 4.2 Why Option B beats Option A

| Concern | Option A (3 instances) | Option B (1 panel + 3 contexts) |
|---|---|---|
| Memory | 3× chat-panel DOM trees + 3× input handlers + 3× streaming-state machines (~~2 MB each~~ → 6 MB) | 1× DOM tree + 1× input handler + 1× streaming-state machine (~2 MB) |
| Maintenance | Diverges over time — each instance gets its own bug-fixes | Single source of truth; per-context config is data, not code |
| Visual continuity | Tab switch tears down + re-renders chat shell (flicker) | Tab switch swaps DOM-internal text only (smooth) |
| Streaming-in-progress on tab switch | Loses streaming continuity OR keeps stream firing into a hidden DOM tree | Streaming pinned to the active context; switching tabs cancels the in-flight stream (with confirm if mid-turn) |
| Cross-tab coordination | Each instance must explicitly publish state; no shared dispatcher | Shared dispatcher with context-aware verb-filtering at routing layer |
| Test surface | 3× as much UI to test | 1× UI + 3× config-data validation |

Option A wins only on the "instances are conceptually clean" axis. Option B wins on every measurable axis.

### 4.3 ChatContext schema

```ts
type TabId = "model" | "layout" | "research";

type ChatContext = {
  tabId: TabId;
  systemPrompt: string;             // tab-specific
  fewShot: FewShotExample[];        // tab-specific
  verbAllowlist: string[];          // Sd* verbs admitted by dispatch for this context
  history: ChatTurn[];              // persisted to IDB by sessionId
  generationParams: {
    temperature: number;
    maxOutputTokens: number;
    topP: number;
  };
  uiHints: {
    placeholderText: string;        // input placeholder per tab
    inputAllowedTypes: ("text" | "image" | "file")[];
    enabledFeatures: ("voice" | "drop")[];
  };
};
```

### 4.4 Wiring

```
+----------------+         +-----------------+
| TabBar         |--click->| activateTab(t)  |
+----------------+         +-----------------+
                                   |
                                   v
                         +------------------------+
                         | chatPanel.swapContext(t) |
                         +------------------------+
                              |
                              | reads tab→ChatContext from registry
                              v
                  +-------------------------------+
                  | ChatPanel (single instance)   |
                  | - updates system prompt       |
                  | - swaps few-shot              |
                  | - reloads history from IDB    |
                  | - updates input placeholder   |
                  | - cancels mid-stream w/confirm |
                  +-------------------------------+
                              |
                              v
                  +-------------------------------+
                  | dispatch (single instance)     |
                  | - verb arrives → check         |
                  |   activeContext.verbAllowlist  |
                  | - if not in allowlist:         |
                  |   return { error:              |
                  |     "verb_not_in_context" }    |
                  +-------------------------------+
                              |
                              v
                  +-------------------------------+
                  | model worker (single instance)|
                  | - shared by all 3 contexts    |
                  | - per-turn generation params  |
                  |   from active context         |
                  +-------------------------------+
```

Single model-worker instance is critical — loading model weights per context would be a 100+ MB per-context cost. The worker is stateless across contexts; only the inputs differ.

### 4.5 Verb-allowlist enforcement

The dispatch layer reads `activeContext.verbAllowlist` and rejects verb dispatches that don't belong to the current tab:

```ts
async function dispatchSync(verb: string, args: unknown): Promise<DispatchResult> {
  const ctx = getActiveContext();
  if (!ctx.verbAllowlist.includes(verb)) {
    return {
      status: "error",
      summary: `Verb ${verb} is not available in the ${ctx.tabId} tab.`,
      detail: { reason: "verb_not_in_context", allowed: ctx.verbAllowlist },
    };
  }
  // ... existing dispatch logic ...
}
```

The agent gets the error fed back into its own history via the existing dispatch-summary path. It can react ("I tried to use SdWall in Research mode — that doesn't work, let me search instead").

---

## 5. Shared state — what crosses tabs

Per-context isolation must NOT trap the user. Some state is global:

| Store | Read-from | Write-from |
|---|---|---|
| Scene state (Three.js scene tree, IFC scene-kg, `userData`) | Model + Layout + Research | Model only |
| Layout sheets + panels | Model (read-only) + Layout + Research (read-only thumbnails) | Layout only |
| Research documents (`research.documents` IDB store) | Model + Layout + Research | Research only |
| Research sessions | Model + Layout + Research | Research only |
| Per-tab chat history | (Each tab reads its own) | (Each tab writes its own) |
| Levels, layers, units | Model + Layout + Research | Model + Layout |
| Active theme, render mode | All | All |
| Skill nodes | All | All |

This means the Model-tab agent can READ research documents (e.g., "Use the spec I sourced last session") but cannot SdFetch new ones. Conversely the Research-tab agent can READ scene state ("My corpus is about steel-framed houses, the user is building a wood-frame house — note this") but cannot SdWall.

### 5.1 Cross-tab read access

The dispatcher exposes read-only accessors that any context can call:

```ts
ctx.read.scene()       // Three.js scene
ctx.read.sheets()      // Layout sheets array
ctx.read.documents()   // Research docs (returns paginated cursor for large corpora)
ctx.read.levels()      // Levels array
```

The accessors are NOT verbs — they're internal SDK calls the harness can make to populate context. A Research-tab agent's turn might prefix its few-shot with `[Scene context: 4 walls, 1 slab, 0 doors]` derived from `ctx.read.scene()` before the user prompt. This keeps the agent grounded.

### 5.2 Cross-tab write is forbidden

Hard line: a Research-tab agent CANNOT dispatch `SdWall`. If the user is in the Research tab and types "now build me a wall based on what I researched," the agent's correct response is "I can summarize the spec but I can't build geometry from the Research tab — switch to Model and I'll have the spec available there."

This avoids the worst-case interaction where the agent silently mode-switches and the user loses track of which tab is doing what.

---

## 6. Recommendation + sub-issue drafts

### 6.1 Phasing

Three PRs, sequenced for incremental delivery:

**MVP — get the structural split working with Model + Research only.**

| # | Title | Owner | Scope |
|---|---|---|---|
| E1 | `feat(chat): chat-panel context-swap architecture` | Eli | Split current chat-panel.ts so its state is parameterized by `ChatContext`; introduce context registry; verify Model tab continues to work as-is (only context is `model`) |
| E2 | `feat(chat): research-tab context + verb-allowlist enforcement` | Eli | Add Research `ChatContext` to registry; wire verb-allowlist at dispatch layer; integrate with `research-tab-design.md` D5 |

**V1 — Layout tab joins.**

| # | Title | Owner | Scope |
|---|---|---|---|
| E3 | `feat(chat): layout-tab context + Sd* drafting verb allowlist` | Eli | Add Layout `ChatContext`; identify Layout verbs (`SdAddPanel`, `SdSetSheetScale`, `SdAddSection`, `SdAddElevation`, `SdAddDim`, layer-mgmt verbs); few-shot with 2 examples; render chat panel surface in layout-mode UI |

### 6.2 Drafted sub-issues (NOT filed; file after this doc is approved)

```
[E1] feat(chat): chat-panel context-swap architecture
  - Refactor chat-panel.ts to take a ChatContext arg + swap on tab change
  - Add B:/M/gemma-architect/web/src/chat/chat-contexts.ts as the context registry
  - Persist per-tab history to IDB under chat.history.<tabId>.<sessionId>
  - Pre-existing Model tab keeps current behavior (only registered context is "model")
  - swapContext(t) handles mid-stream cancellation with a user prompt
  - Test: switching tabs preserves each tab's prior history on swap-back
  - Owner: Eli

[E2] feat(chat): research-tab context + verb-allowlist enforcement
  - Depends on E1 + research-tab-design.md D2 (research verbs land first)
  - Add Research ChatContext to registry per §4.3
  - Add verb-allowlist check at dispatch entry per §4.5
  - Wire chat panel into research-tab UI shell (D3 dependency)
  - Test: dispatching SdWall from Research tab returns
    { status: "error", reason: "verb_not_in_context", allowed: [...] }
  - Test: agent self-corrects after receiving the verb_not_in_context error
  - Owner: Eli

[E3] feat(chat): layout-tab context + drafting verb allowlist
  - Depends on E1 + #1843 Layout umbrella sub-issues landing Layout verbs
  - Add Layout ChatContext to registry
  - Identify Layout verb subset: SdAddPanel, SdSetSheetScale, SdAddSection,
    SdAddElevation, SdAddDim, layer-mgmt verbs (TBD complete enumeration
    after #1843 sub-issues land)
  - 2 canonical few-shot examples (sheet creation + dimension placement)
  - Wire chat panel into layout-mode UI shell
  - Test: dispatching SdSearch from Layout returns verb_not_in_context
  - Owner: Eli
```

### 6.3 Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Mid-stream tab switch loses partial response | Cancel-with-confirm dialog in `swapContext` — surfaces incomplete generation to the user, doesn't silently discard |
| R2 | Per-tab history IDB grows unbounded across all 3 tabs | Per-tab cap of 200 turns with rolling-summary eviction (already proposed in research-tab-design §6.3 R6) |
| R3 | User switches tabs while agent is mid-dispatch sequence — half the dispatches land in wrong context | Dispatcher reads context at dispatch time; if context changes mid-sequence, remaining dispatches error with verb_not_in_context. Agent sees the error + can compose a recovery message |
| R4 | Verb subset definition drifts — Layout tab thinks SdAddDim exists, dispatch doesn't | Verb-allowlist is sourced from `spatial-api.yaml` filtered by tab tag; single source of truth |
| R5 | Cross-tab read accessors leak too much context (e.g., Research agent sees 1000-element scene → bloats turn) | Read accessors are paginated cursors with hard per-call result caps; agent's turn-prep slice never exceeds 1k tokens |
| R6 | User wants to copy a Research finding into a Model build prompt — friction if forced to retype | Cross-tab "Insert into <other tab>'s next prompt" button on document/citation rows, writes to the other tab's pending-input |

### 6.4 Open questions for user before implementation

1. **Layout verb subset completeness** — depends on #1843 Layout umbrella sub-issues being filed and (most) shipped before E3 lands. E1 + E2 can ship without that.
2. **Mid-stream tab-switch behavior** — cancel-with-confirm vs background-stream-into-hidden-context vs hard-cancel. Recommendation §6.3 R1 picks "cancel-with-confirm" as the safe default.
3. **Voice / drop input per tab** — Research tab UX would benefit from drag-drop of PDFs / URLs as input. Layout tab probably doesn't. UI hints per context (§4.3) accommodate this — decision deferred per-tab.
4. **History persistence — keep per-tab forever, or scope to user-named "research session" / "build session"?** Currently the per-tab history is one rolling buffer. Some users may want named sessions per tab (especially Research). Defer to V2.

---

## References

- Issue: wordingone/gemma-architect#1856 (this deliverable's parent)
- Cross-ref: `docs/internal/research-tab-design.md` §5.4 (research-tab angle on per-tab chat — aligned with this doc)
- Cross-ref: `docs/internal/research-tab-design.md` §6.2 D5 (research-context implementation sub-issue draft, now E2 here)
- Cross-ref: wordingone/gemma-architect#1843 (Layout umbrella — gates E3)
- Existing chat: `web/src/chat/chat-panel.ts`
- Existing dispatch: `web/src/commands/dispatch.ts`, `web/src/commands/spatial-api.yaml`
- Risk doctrine: `B:/M/avir/leo/.claude/rules/claim-verification.md` (apply to user-visible AC on each implementation PR)
- LOC adjacency: `web/src/main.ts` would grow with verb-context tagging if dispatch's verb→tabId tagging lives there; consider extracting `tab-verb-routing.ts` on radar of WEB-CAD LOC refactor

— Leo, 2026-05-24
