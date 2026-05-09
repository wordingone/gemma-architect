// chat-panel.ts — Multi-turn conversation panel for the CREATE dock tab (#41).
//
// Maintains a conversation history across turns and routes each user message
// through agent-harness.ts → dispatch.ts. Dispatches fire immediately after
// each model turn; their verb names are shown as inline pills.

import { runAgentTurn } from "./agent/agent-harness";
import type { AgentDispatch, AgentResponse } from "./agent/agent-harness";
import { invokeCommand } from "./commands/command-session";
import type { Skill } from "./agent/skills-loader";
import { findSkillsForPrompt } from "./agent/skills-loader";
import { isSimplePlan } from "./plan";
import { lastTurn } from "./telemetry";
import { buildDispatchSummary } from "./chat-dispatch-summary";

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
      <div class="chat-compose">
        <textarea class="chat-input"
          placeholder="Ask Gemma·Architect — create geometry, inspect the scene, explain commands…"
          rows="2"></textarea>
        <button class="btn btn-accent btn-sm chat-send-btn" type="button">SEND</button>
      </div>
    `;
    this._listEl    = this._root.querySelector(".chat-list")!;
    this._startersEl = this._root.querySelector(".chat-starters")!;
    this._perfStripEl = this._root.querySelector(".chat-perf-strip")!;
    this._inputEl   = this._root.querySelector<HTMLTextAreaElement>(".chat-input")!;
    this._sendBtn   = this._root.querySelector<HTMLButtonElement>(".chat-send-btn")!;

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
  }

  private async _send(): Promise<void> {
    const text = this._inputEl.value.trim();
    if (!text || this._sendBtn.disabled) return;
    this._inputEl.value = "";
    this._startersEl.style.display = "none";

    this._pushMsg({ role: "user", content: text });
    this._history.push({ role: "user", content: text });

    this._sendBtn.disabled = true;
    this._sendBtn.textContent = "…";
    const thinking = this._appendThinking();

    try {
      const matchedSkills = this._skills.length > 0 ? findSkillsForPrompt(this._skills, text) : [];
      const skillsToPass = matchedSkills.length > 0 ? matchedSkills : this._skills;
      const resp = await runAgentTurn({
        prompt: text,
        history: this._history.slice(0, -1),
        skills: skillsToPass,
        skillsTotal: this._skills.length,
        maxNewTokens: estimateMaxTokens(text),
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

  private async _runDispatches(resp: AgentResponse): Promise<{ summary: string; fired: string[] }> {
    const fired: string[] = [];
    for (const d of resp.dispatches) {
      const out = await invokeCommand({
        command: d.verb,
        parameters: d.args,
        metadata: { source: "agent" },
      });
      fired.push(out.status === "success" ? d.verb : `${d.verb}(err)`);
    }
    const summary = resp.dispatches.length === 0
      ? (resp.text.trim() || "(no response)")
      : buildDispatchSummary(resp.dispatches, fired);
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

    const planBlock = document.createElement("pre");
    planBlock.className = "chat-plan-block";
    planBlock.textContent = planText;
    item.appendChild(planBlock);

    const runBtn = document.createElement("button");
    runBtn.className = "btn btn-accent btn-sm chat-plan-run-btn";
    runBtn.textContent = "Run plan";
    item.appendChild(runBtn);

    runBtn.addEventListener("click", () => {
      runBtn.disabled = true;
      runBtn.textContent = "Executing…";
      void this._runDispatches(resp).then(({ summary }) => {
        planBlock.remove();
        runBtn.remove();
        item.classList.remove("chat-plan-pending");
        const content = document.createElement("div");
        content.className = "chat-msg-content";
        content.textContent = summary;
        item.appendChild(content);
        this._history.push({ role: "assistant", content: summary });
      });
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
