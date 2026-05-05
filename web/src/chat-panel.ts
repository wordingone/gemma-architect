// chat-panel.ts — Multi-turn conversation panel for the CREATE dock tab (#41).
//
// Maintains a conversation history across turns and routes each user message
// through agent-harness.ts → dispatch.ts. Dispatches fire immediately after
// each model turn; their verb names are shown as inline pills.

import { runAgentTurn } from "./agent-harness";
import type { AgentDispatch } from "./agent-harness";
import { dispatchSync } from "./dispatch";
import type { Skill } from "./skills-loader";

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

export class ChatPanel {
  private _messages: Message[] = [];
  private _history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private _listEl!: HTMLElement;
  private _startersEl!: HTMLElement;
  private _inputEl!: HTMLTextAreaElement;
  private _sendBtn!: HTMLButtonElement;
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
      <div class="chat-compose">
        <textarea class="chat-input"
          placeholder="Ask Gemma·Architect — create geometry, inspect the scene, explain commands…"
          rows="2"></textarea>
        <button class="btn btn-accent btn-sm chat-send-btn" type="button">SEND</button>
      </div>
    `;
    this._listEl    = this._root.querySelector(".chat-list")!;
    this._startersEl = this._root.querySelector(".chat-starters")!;
    this._inputEl   = this._root.querySelector<HTMLTextAreaElement>(".chat-input")!;
    this._sendBtn   = this._root.querySelector<HTMLButtonElement>(".chat-send-btn")!;

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
      const resp = await runAgentTurn({
        prompt: text,
        history: this._history.slice(0, -1), // history before this turn
        skills: this._skills,
      });

      const fired: string[] = [];
      for (const d of resp.dispatches) {
        const dr = dispatchSync(d.verb, d.args);
        fired.push(dr.ok ? d.verb : `${d.verb}(err)`);
      }

      const assistantText =
        resp.text.trim() ||
        (fired.length > 0 ? `Dispatched: ${fired.join(", ")}` : "(no response)");

      this._removeThinking(thinking);
      this._pushMsg({
        role: "assistant",
        content: assistantText,
        dispatches: resp.dispatches,
      });
      this._history.push({ role: "assistant", content: assistantText });
    } catch (e) {
      this._removeThinking(thinking);
      const err = e as Error;
      this._pushMsg({ role: "assistant", content: "", error: err.message });
    } finally {
      this._sendBtn.disabled = false;
      this._sendBtn.textContent = "SEND";
    }
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
