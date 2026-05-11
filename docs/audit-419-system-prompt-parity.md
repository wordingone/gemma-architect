# Audit: System Prompt Parity — REMOTE vs WebGPU (#419)

**SHA**: 11eccfa  
**Date**: 2026-05-11  
**Filed by**: Eli

---

## Question

Do the `BUILDING_DEFAULTS` and few-shot examples added in PR #417 (SU-1) reach the model
when `VITE_GEMMA_AGENT_URL` is set (REMOTE mode)?

---

## Code evidence

### REMOTE path — `runRemoteAgentTurn()` (line 750)

```typescript
// agent-harness.ts:766-774
const messages = [
  { role: "system" as const, content: buildSystemPrompt(req.skills) },
  ...trimmedHistory.map((m) => ({ role: m.role, content: m.content })),
  { role: "user" as const, content: userContent },
];
// ...
const resp = await fetch(`${REMOTE_URL}/v1/chat/completions`, {
  body: JSON.stringify({ messages, max_tokens: 1024, temperature: 0.1 }),
});
```

`buildSystemPrompt()` is called. Its output (which now includes `BUILDING_DEFAULTS` and
two few-shot examples) is sent as `role: "system"` in the OpenAI chat completions payload.

### REMOTE fallback path — `prompt_tokens <= 5` bug workaround (line 791)

When llama-server returns `prompt_tokens <= 5` (broken `--chat-template` rendering), the
code falls back to `/completion` with `formatGemmaCompletionPrompt(fallbackMessages)`.

`formatGemmaCompletionPrompt()` (line 723) handles the system role by prepending it to the
first user turn:

```typescript
// line 736-741
if (msg.role === "system") {
  pendingSystem = text;
} else if (msg.role === "user") {
  const combined = pendingSystem ? `${pendingSystem}\n\n${text}` : text;
  parts.push(`<start_of_turn>user\n${combined}<end_of_turn>\n`);
```

System content (including BUILDING_DEFAULTS) is included in both primary and fallback paths.

### WebGPU path — `runAgentTurn()` (line 876)

```typescript
// agent-harness.ts:876-880
const messages = [
  { role: "system" as const, content: buildSystemPrompt(req.skills) },
  ...trimmedHistory,
  { role: "user" as const, content: userContent },
];
const chatText: string = proc.apply_chat_template(messages, {
  add_generation_prompt: true,
  tokenize: false,
}) as string;
```

Identical system message construction. `proc.apply_chat_template()` formats it via the
model's own Gemma chat template.

---

## Verdict

**Option A (parity at the prompt layer) is already the implementation.**

Both REMOTE and WebGPU paths call `buildSystemPrompt()` and pass its output as the system
message. PR #417 changes ship to the model regardless of inference path.

No code change required for #419.

---

## Remaining considerations

1. **Chat template quality on llama-server**: the `prompt_tokens <= 5` fallback handles the
   known broken-template case. If a new llama-server build regresses on template rendering,
   the fallback engages automatically.

2. **Context length**: `BUILDING_DEFAULTS` adds ~350 tokens to every turn's prefill.
   In REMOTE mode this is within the server's ctx (8192). In WebGPU mode the ONNX model
   has a fixed ctx window — monitor for truncation on long conversations.

3. **Demo deployment path**: For the Gemma 4 Good Hackathon demo, the serving setup
   (REMOTE vs WebGPU) determines which inference engine runs, but NOT whether the system
   prompt is included — it's included either way.

---

## #419 decision

**Close #419 as resolved — no further action needed.** The structural concern was based on
an incorrect assumption that REMOTE bypasses `buildSystemPrompt()`. It does not.
