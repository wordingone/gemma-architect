// chat-panel.ts — Multi-turn conversation panel for the CREATE dock tab (#41).
//
// Maintains a conversation history across turns and routes each user message
// through agent-harness.ts → dispatch.ts. Dispatches fire immediately after
// each model turn; their verb names are shown as inline pills.

import { runAgentTurn } from "./agent/agent-harness";
import type { AgentDispatch, AgentRequest, AgentResponse } from "./agent/agent-harness";
import { invokeCommand } from "./commands/command-session";
import type { Skill } from "./agent/skills-loader";
import { findSkillsForPrompt } from "./agent/skills-loader";
import { isSimplePlan } from "./plan";
import { lastTurn } from "./telemetry";
import { buildDispatchSummary } from "./chat-dispatch-summary";
import { classifyDispatchResult } from "./chat-dispatch-routing";
import { setPickerHint } from "./viewer/create-mode";

type Message = {
  role: "user" | "assistant";
  content: string;
  dispatches?: AgentDispatch[];
  error?: string;
};

const STARTER_PROMPTS = [
  "Draw a 5m wall, 0.2m thick, 2.8m tall",
  "Create a rectangular room 6×4m with 2.8m ceilings",
  "What's currently in the scene?",
  "What arguments does makeBox accept?",
];

function estimateMaxTokens(prompt: string): number {
  const p = prompt.toLowerCase();
  // Short informational queries rarely need more than 256 tokens.
  if (/\?$/.test(p) || /^(what|how|why|is|are|show|list|describe|explain)\b/.test(p)) return 256;
  // Multi-step design requests need headroom for plan + multiple tool_calls.
  // Covers all 10 P8a benchmark prompt categories (fire-station→station,
  // hospitality-cabin→cabin, walkup-4story→apartment, community-center→center/hall).
  if (/\b(design|pavilion|room|building|house|complex|floor|facade|station|cabin|apartment|center|hall|clinic|library|residence|create|model)\b/.test(p)) return 1024;
  // Default: single geometry command fits in 512.
  return 512;
}

export class ChatPanel {
  private _messages: Message[] = [];
  private _history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private _listEl!: HTMLElement;
  private _startersEl!: HTMLElement;
  private _inputEl!: HTMLTextAreaElement;
  private _sendBtn!: HTMLButtonElement;
  private _perfStripEl!: HTMLElement;
  private _skills: Skill[] = [];
  private _pendingImage: string | undefined;
  private _previewEl!: HTMLElement;
  private _fileInputEl!: HTMLInputElement;

  constructor(private _root: HTMLElement) {
    this._build();
  }

  setSkills(skills: Skill[]): void {
    this._skills = skills;
  }

  clear(): void {
    this._messages = [];
    this._history = [];
    this._listEl.innerHTML = "";
    this._startersEl.style.display = "";
  }

  private _build(): void {
    this._root.innerHTML = `
      <div class="chat-list"></div>
      <div class="chat-starters"></div>
      <div class="chat-perf-strip" style="display:none"></div>
      <div class="chat-image-preview" style="display:none"></div>
      <div class="chat-compose">
        <button class="chat-attach-btn" type="button" title="Attach sketch image (or paste / drop)">⊕</button>
        <textarea class="chat-input"
          placeholder="Ask Gemma·Architect — create geometry, inspect the scene, explain commands…"
          rows="2"></textarea>
        <button class="btn btn-accent btn-sm chat-send-btn" type="button">SEND</button>
      </div>
      <input class="chat-file-input" type="file" accept="image/*" style="display:none" />
    `;
    this._listEl    = this._root.querySelector(".chat-list")!;
    this._startersEl = this._root.querySelector(".chat-starters")!;
    this._perfStripEl = this._root.querySelector(".chat-perf-strip")!;
    this._previewEl = this._root.querySelector(".chat-image-preview")!;
    this._inputEl   = this._root.querySelector<HTMLTextAreaElement>(".chat-input")!;
    this._sendBtn   = this._root.querySelector<HTMLButtonElement>(".chat-send-btn")!;
    this._fileInputEl = this._root.querySelector<HTMLInputElement>(".chat-file-input")!;

    window.addEventListener("debug:telemetry-toggle", () => {
      const visible = this._perfStripEl.style.display !== "none";
      this._perfStripEl.style.display = visible ? "none" : "block";
      if (!visible) this._updatePerfStrip();
    });

    for (const s of STARTER_PROMPTS) {
      const chip = document.createElement("span");
      chip.className = "ai-chip chat-starter-chip";
      chip.textContent = s;
      chip.addEventListener("click", () => {
        this._inputEl.value = s;
        this._inputEl.focus();
      });
      this._startersEl.appendChild(chip);
    }

    this._sendBtn.addEventListener("click", () => { void this._send(); });
    this._inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this._send();
      }
    });

    // Attach button → file picker
    const attachBtn = this._root.querySelector<HTMLButtonElement>(".chat-attach-btn")!;
    attachBtn.addEventListener("click", () => this._fileInputEl.click());
    this._fileInputEl.addEventListener("change", () => {
      const file = this._fileInputEl.files?.[0];
      if (file) this._loadImageFile(file);
      this._fileInputEl.value = "";
    });

    // Paste image from clipboard
    this._inputEl.addEventListener("paste", (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (file) this._loadImageFile(file);
          break;
        }
      }
    });

    // Drag-and-drop image onto compose area
    const compose = this._root.querySelector<HTMLElement>(".chat-compose")!;
    compose.addEventListener("dragover", (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    });
    compose.addEventListener("drop", (e: DragEvent) => {
      const file = e.dataTransfer?.files[0];
      if (file?.type.startsWith("image/")) {
        e.preventDefault();
        this._loadImageFile(file);
      }
    });
  }

  private _loadImageFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      this._setPreview(dataUrl);
    };
    reader.readAsDataURL(file);
  }

  private _setPreview(dataUrl: string): void {
    this._pendingImage = dataUrl;
    this._previewEl.innerHTML = "";
    const thumb = document.createElement("img");
    thumb.className = "chat-image-thumb";
    thumb.src = dataUrl;
    thumb.alt = "attached sketch";
    const label = document.createElement("span");
    label.style.cssText = "font-size:10px;color:var(--ink-dim);flex:1";
    label.textContent = "sketch attached";
    const clearBtn = document.createElement("button");
    clearBtn.className = "chat-image-clear";
    clearBtn.type = "button";
    clearBtn.textContent = "✕ remove";
    clearBtn.addEventListener("click", () => this._clearPreview());
    this._previewEl.appendChild(thumb);
    this._previewEl.appendChild(label);
    this._previewEl.appendChild(clearBtn);
    this._previewEl.style.display = "";
  }

  private _clearPreview(): void {
    this._pendingImage = undefined;
    this._previewEl.innerHTML = "";
    this._previewEl.style.display = "none";
  }

  private async _send(): Promise<void> {
    const text = this._inputEl.value.trim();
    if (!text || this._sendBtn.disabled) return;
    this._inputEl.value = "";
    this._startersEl.style.display = "none";

    // Capture + clear pending image before any await so it isn't cleared by a concurrent send.
    const userImage = this._pendingImage;
    if (userImage) this._clearPreview();

    this._pushMsg({ role: "user", content: text });
    this._history.push({ role: "user", content: text });

    this._sendBtn.disabled = true;
    this._sendBtn.textContent = "…";
    const thinking = this._appendThinking();

    try {
      const matchedSkills = this._skills.length > 0 ? findSkillsForPrompt(this._skills, text) : [];

      // Fastpath: exactly one skill matched and it has pre-verified steps → execute directly,
      // bypass model inference. Covers the K=0 wrong-args case for building-type prompts.
      if (matchedSkills.length === 1 && matchedSkills[0].steps && matchedSkills[0].steps.length > 0) {
        this._removeThinking(thinking);
        await this._executeSkillDirect(matchedSkills[0]);
        return;
      }

      const skillsToPass = matchedSkills.length > 0 ? matchedSkills : this._skills;
      const resp = await runAgentTurn({
        prompt: text,
        history: this._history.slice(0, -1),
        skills: skillsToPass,
        skillsTotal: this._skills.length,
        maxNewTokens: estimateMaxTokens(text),
        userImage,
      });

      this._removeThinking(thinking);
      this._updatePerfStrip();

      if (resp.dispatches.length === 0 || isSimplePlan(resp.dispatches)) {
        await this._executeAndPush(resp);
      } else {
        this._pushPlanMsg(resp);
      }
    } catch (e) {
      this._removeThinking(thinking);
      const err = e as Error;
      this._pushMsg({ role: "assistant", content: "", error: err.message });
    } finally {
      this._sendBtn.disabled = false;
      this._sendBtn.textContent = "SEND";
    }
  }

  private _updatePerfStrip(): void {
    if (this._perfStripEl.style.display === "none") return;
    const t = lastTurn();
    if (!t) { this._perfStripEl.textContent = "no data"; return; }
    this._perfStripEl.textContent =
      `tg ${t.tg_tps.toFixed(1)} t/s · pp ${t.pp_tps.toFixed(0)} t/s · in ${t.tokens_in} · out ${t.tokens_out} · prefill ${Math.round(t.prefill_ms)}ms · decode ${Math.round(t.decode_ms)}ms`;
  }

  private async _executeSkillDirect(skill: Skill): Promise<void> {
    const steps = skill.steps!;
    const execSummaries: string[] = [];
    const dispatches: AgentDispatch[] = [];
    for (const step of steps) {
      const out = await invokeCommand({
        command: step.verb,
        parameters: step.args,
        metadata: { source: "skill" },
      });
      execSummaries.push(out.summary);
      dispatches.push({ verb: step.verb, args: step.args });
    }
    const content = execSummaries.some((s) => s.length > 0)
      ? execSummaries.join(" ")
      : `Built: ${skill.name} (${steps.length} steps)`;
    this._pushMsg({ role: "assistant", content, dispatches });
    this._history.push({ role: "assistant", content });
    (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
  }

  private async _runDispatches(resp: AgentResponse): Promise<{ summary: string; fired: string[] }> {
    const fired: string[] = [];
    const errors: string[] = [];
    for (const d of resp.dispatches) {
      const out = await invokeCommand({
        command: d.verb,
        parameters: d.args,
        metadata: { source: "agent" },
      });
      const cls = classifyDispatchResult(d.verb, out);
      fired.push(cls.fired);
      if (out.status === "success") setPickerHint(null);
      if (cls.error) errors.push(cls.error);
    }
    const summary = resp.dispatches.length === 0
      ? (resp.text.trim() || "(no response)")
      : buildDispatchSummary(resp.dispatches, fired, errors);
    return { summary, fired };
  }

  private async _executeAndPush(resp: AgentResponse): Promise<void> {
    const { summary } = await this._runDispatches(resp);
    this._pushMsg({ role: "assistant", content: summary, dispatches: resp.dispatches });
    this._history.push({ role: "assistant", content: summary });
    (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
  }

  private _pushPlanMsg(resp: AgentResponse): void {
    const planText = resp.plan ?? resp.dispatches.map((d, i) => `${i + 1}. ${d.verb}`).join("\n");

    const item = document.createElement("div");
    item.className = "chat-msg chat-msg-assistant chat-plan-pending";

    // Foldable plan block (#413/SU-7)
    const details = document.createElement("details");
    details.open = true;
    details.className = "chat-plan-details";
    const summaryEl = document.createElement("summary");
    summaryEl.className = "chat-plan-summary";
    summaryEl.textContent = "Plan";
    const planBlock = document.createElement("pre");
    planBlock.className = "chat-plan-block";
    planBlock.textContent = planText;
    details.appendChild(summaryEl);
    details.appendChild(planBlock);
    item.appendChild(details);

    // Per-turn dispatch summary (populated as each turn executes)
    const turnsEl = document.createElement("div");
    turnsEl.className = "chat-plan-turns";
    item.appendChild(turnsEl);

    const runBtn = document.createElement("button");
    runBtn.className = "btn btn-accent btn-sm chat-plan-run-btn";
    runBtn.textContent = "Run plan";
    item.appendChild(runBtn);

    runBtn.addEventListener("click", () => {
      runBtn.disabled = true;
      // Build local history: prior turns + plan assistant response
      const localHistory: Array<{ role: "user" | "assistant"; content: string }> = [
        ...this._history,
        { role: "assistant", content: resp.text },
      ];
      const allVerbs: string[] = [];
      let currentResp = resp;
      let turnNum = 0;

      void (async () => {
        while (currentResp.dispatches.length > 0 && turnNum < 3) {
          turnNum++;
          runBtn.textContent = turnNum === 1 ? "Executing…" : `Executing turn ${turnNum}…`;

          await this._runDispatches(currentResp);

          const verbs = currentResp.dispatches.map((d) => d.verb);
          allVerbs.push(...verbs);
          const turnEl = document.createElement("div");
          turnEl.className = "chat-plan-turn";
          turnEl.textContent = `Turn ${turnNum}: ${verbs.join(", ")}`;
          turnsEl.appendChild(turnEl);
          this._listEl.scrollTop = this._listEl.scrollHeight;

          if (verbs.includes("SdExport") || turnNum >= 3) break;

          // Continuation turn: ask model for next dispatch batch
          const dispatchedSoFar = allVerbs.join(", ");
          const continuationPrompt = `Continue plan execution. Already dispatched: ${dispatchedSoFar}. Dispatch the next batch of building elements (up to 10 commands). End with SdExport when all plan items are complete.`;
          localHistory.push({ role: "user", content: continuationPrompt });
          const nextResp = await runAgentTurn({
            prompt: continuationPrompt,
            history: localHistory.slice(0, -1),
            maxNewTokens: 1024,
          });
          localHistory.push({ role: "assistant", content: nextResp.text });
          currentResp = nextResp;
        }

        // Finalize: collapse plan, show done text
        details.open = false;
        runBtn.remove();
        item.classList.remove("chat-plan-pending");
        const doneText = `${allVerbs.length} dispatch${allVerbs.length !== 1 ? "es" : ""} in ${turnNum} turn${turnNum !== 1 ? "s" : ""}`;
        const content = document.createElement("div");
        content.className = "chat-msg-content";
        content.textContent = doneText;
        item.insertBefore(content, turnsEl);
        this._history.push({ role: "assistant", content: doneText });
        (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
      })();
    });

    this._messages.push({ role: "assistant", content: planText });
    this._listEl.appendChild(item);
    this._listEl.scrollTop = this._listEl.scrollHeight;
  }

  private _pushMsg(msg: Message): void {
    this._messages.push(msg);
    const item = document.createElement("div");
    item.className = `chat-msg chat-msg-${msg.role}`;

    if (msg.error) {
      const errSpan = document.createElement("span");
      errSpan.className = "chat-msg-error";
      errSpan.textContent = `⚠ ${msg.error}`;
      item.appendChild(errSpan);
    } else {
      const content = document.createElement("div");
      content.className = "chat-msg-content";
      content.textContent = msg.content;
      item.appendChild(content);

      if (msg.dispatches && msg.dispatches.length > 0) {
        const pills = document.createElement("div");
        pills.className = "chat-dispatch-pills";
        for (const d of msg.dispatches) {
          const pill = document.createElement("span");
          pill.className = "chat-dispatch-pill";
          pill.textContent = d.verb;
          pills.appendChild(pill);
        }
        item.appendChild(pills);
      }
    }

    this._listEl.appendChild(item);
    this._listEl.scrollTop = this._listEl.scrollHeight;
  }

  private _appendThinking(): HTMLElement {
    const item = document.createElement("div");
    item.className = "chat-msg chat-msg-assistant chat-thinking";
    item.innerHTML = `<span class="chat-thinking-dots"><span>·</span><span>·</span><span>·</span></span>`;
    this._listEl.appendChild(item);
    this._listEl.scrollTop = this._listEl.scrollHeight;
    return item;
  }

  private _removeThinking(el: HTMLElement): void {
    el.remove();
  }
}

// ── Iteration API (#320) ──────────────────────────────────────────────────────
// Stateless entry point for the agent loop driver. Compares viewport against a
// reference image and emits the next geometry commands. Exposed as
// window.__runIteration for CDP-driven loop orchestrators and gemma-verify.
//
// Token budget: maxNewTokens=1024 ≤ 60% of Gemma-4 E2B's ~8192-token context.

export async function runIteration(
  refImg: ImageBitmap | null,
  vpImg: ImageBitmap | null,
  deltaText: string,
  recentDispatches: AgentDispatch[],
): Promise<AgentResponse> {
  const recentText = recentDispatches.length > 0
    ? `Recent commands: ${recentDispatches.slice(-8).map((d) => `${d.verb}(${JSON.stringify(d.args)})`).join("; ")}`
    : "";

  const lines = [
    "Iteration step: examine the current viewport and emit the next geometry commands to move toward the target state.",
    deltaText ? `Target delta: ${deltaText}` : "",
    recentText,
    refImg != null ? "(A reference image is attached as the target state.)" : "",
  ].filter(Boolean);

  let userImage: string | undefined;
  if (vpImg != null) {
    const canvas = document.createElement("canvas");
    canvas.width = vpImg.width;
    canvas.height = vpImg.height;
    canvas.getContext("2d")!.drawImage(vpImg, 0, 0);
    userImage = canvas.toDataURL("image/jpeg", 0.8);
  }

  // Delegate to multi-turn planning loop for design-intent prompts (#413/SU-2).
  if (!vpImg && !refImg && DESIGN_RE.test(deltaText)) {
    return runDesignLoop(deltaText, [], undefined, 3);
  }

  return runAgentTurn({
    prompt: lines.join("\n"),
    userImage,
    maxNewTokens: 1024,
  });
}

// Multi-turn design loop (#413/SU-2).
//
// For "Design a house / apartment / 2-storey house" style prompts: the full
// building exceeds what a single model turn can reliably dispatch without
// running out of context. This loop:
//   Turn 1 — agent emits <plan> + first batch (foundation, levels, walls, ≤10 cmds)
//   Turn N — "Continue" prompt with dispatch summary; agent emits next batch
//   Stops   — when SdExport fires, no new dispatches, or maxTurns reached
//
// History and dispatch summary carry forward so the model knows what's been done.

const DESIGN_RE = /\b(design|build|create|model)\b.*\b(house|apartment|office|cabin|building|studio|home|tiny home|residence)\b|\b(house|apartment|office|cabin|building|studio|home)\b/i;

export async function runDesignLoop(
  prompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }> = [],
  skills?: import("./agent/skills-loader").Skill[],
  maxTurns = 3,
): Promise<AgentResponse> {
  const allDispatches: AgentDispatch[] = [];
  let planText: string | undefined;
  let lastText = "";
  const localHistory: Array<{ role: "user" | "assistant"; content: string }> = [...history];

  for (let turn = 0; turn < maxTurns; turn++) {
    const isFirst = turn === 0;
    const dispatchedSoFar = allDispatches.map((d) => d.verb).join(", ");
    const continuationHint = dispatchedSoFar
      ? `Already dispatched: ${dispatchedSoFar}.`
      : "";

    const req: AgentRequest = {
      prompt: isFirst
        ? prompt
        : `Continue plan execution. ${continuationHint} Dispatch the next batch of building elements (up to 10 commands). End with SdExport when all plan items are complete.`,
      history: localHistory,
      maxNewTokens: 1024,
      skills,
    };

    const resp = await runAgentTurn(req);

    if (isFirst && resp.plan) planText = resp.plan;
    lastText = resp.text;
    allDispatches.push(...resp.dispatches);

    localHistory.push({ role: "user", content: req.prompt });
    localHistory.push({ role: "assistant", content: resp.text });

    if (resp.dispatches.some((d) => d.verb === "SdExport")) break;
    if (resp.dispatches.length === 0) break;
  }

  return { dispatches: allDispatches, text: lastText, plan: planText };
}
