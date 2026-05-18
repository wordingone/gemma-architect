// chat-panel.ts — Multi-turn conversation panel for the CREATE dock tab (#41).
//
// Maintains a conversation history across turns and routes each user message
// through agent-harness.ts → dispatch.ts. Dispatches fire immediately after
// each model turn; their verb names are shown as inline pills.

import { runAgentTurn } from "../agent/agent-harness";
import { captureViewport } from "../agent/viewport-capture";
import type { AgentDispatch, AgentRequest, AgentResponse } from "../agent/agent-harness";
import { invokeCommand } from "../commands/command-session";
import type { Skill, SkillStep } from "../agent/skills-loader";
import { findSkillsForPrompt } from "../agent/skills-loader";
import { isSimplePlan } from "../agent/plan";
import { lastTurn } from "../agent/telemetry";
import { buildDispatchSummary } from "./chat-dispatch-summary";
import { classifyDispatchResult } from "./chat-dispatch-routing";
import { setPickerHint } from "../viewer/picker-hint";
import { openSaveSkillModal } from "../skills/skill-modal";
import { getState } from "../app-state";

type Message = {
  role: "user" | "assistant";
  content: string;
  dispatches?: AgentDispatch[];
  error?: string;
};

// QW-3 (#409): session context global — mirrors avir-cli's session state.
type GemmaSession = { startTs: number; turnCount: number; dispatchCount: number; errorCount: number };
// QW-1 (#409): pre-dispatch hook registry — mirrors avir-cli PreToolUse hooks.
type GemmaDispatchHooks = { pre: Array<(d: AgentDispatch) => void> };
type _GemmaW = Window & typeof globalThis & { __gemmaSession: GemmaSession; __gemma_dispatch_hooks: GemmaDispatchHooks };

const STARTER_PROMPTS: Array<{ label: string; prompt: string | (() => string) }> = [
  { label: "What's currently in the scene?", prompt: "What's currently in the scene?" },
  {
    label: "Two-story house",
    prompt: () => getState("unitSystem") === "imperial"
      ? "Build a two-story residential house, 26ft wide by 20ft deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs."
      : "Build a two-story residential house, 8m wide by 6m deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs.",
  },
];

// ── Skill re-binding helpers ──────────────────────────────────────────────────

function _extractPositionFromPrompt(prompt: string): { x: number; y: number; z: number } | null {
  const m = prompt.match(/\bat\s*\(?\s*(-?\d+\.?\d*)\s*[,\s]\s*(-?\d+\.?\d*)(?:\s*[,\s]\s*(-?\d+\.?\d*))?\s*\)?/i);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), z: m[3] != null ? parseFloat(m[3]) : 0 };
}

function _getStepAnchor(steps: SkillStep[]): { x: number; y: number; z: number } | null {
  for (const step of steps) {
    const a = step.args;
    if (typeof a.x === "number" && typeof a.y === "number") return { x: a.x as number, y: a.y as number, z: (a.z as number | undefined) ?? 0 };
    const s = a.start as Record<string, unknown> | undefined;
    if (s && typeof s.x === "number" && typeof s.y === "number") return { x: s.x as number, y: s.y as number, z: (s.z as number | undefined) ?? 0 };
  }
  return null;
}

function _offsetPoint(v: unknown, dx: number, dy: number, dz: number): unknown {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number") {
    return [v[0] + dx, v[1] + dy, v.length >= 3 ? (v[2] as number) + dz : 0];
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.x === "number") {
    return {
      ...obj,
      x: (obj.x as number) + dx,
      y: typeof obj.y === "number" ? (obj.y as number) + dy : obj.y,
      z: typeof obj.z === "number" ? (obj.z as number) + dz : obj.z,
    };
  }
  return v;
}

function _rebindSkillSteps(steps: SkillStep[], dx: number, dy: number, dz: number): SkillStep[] {
  return steps.map((step) => ({
    verb: step.verb,
    args: Object.fromEntries(Object.entries(step.args).map(([k, v]) => {
      if (k === "x" && typeof v === "number") return [k, (v as number) + dx];
      if (k === "y" && typeof v === "number") return [k, (v as number) + dy];
      if (k === "z" && typeof v === "number") return [k, (v as number) + dz];
      if (["start", "end", "center", "position", "origin"].includes(k)) return [k, _offsetPoint(v, dx, dy, dz)];
      if (k === "points" && Array.isArray(v)) return [k, (v as unknown[]).map((pt) => _offsetPoint(pt, dx, dy, dz))];
      return [k, v];
    })),
  }));
}

export function _extractRotationFromPrompt(prompt: string): number | null {
  const m = prompt.match(/\brotate[d]?\s+(-?\d+\.?\d*)/i);
  return m ? parseFloat(m[1]) : null;
}

function _rotatePoint2D(v: unknown, cx: number, cy: number, cos: number, sin: number): unknown {
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === "number") {
    const rx = cx + (v[0] - cx) * cos - (v[1] - cy) * sin;
    const ry = cy + (v[0] - cx) * sin + (v[1] - cy) * cos;
    return v.length >= 3 ? [rx, ry, v[2]] : [rx, ry];
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.x === "number" && typeof obj.y === "number") {
    return {
      ...obj,
      x: cx + (obj.x - cx) * cos - ((obj.y as number) - cy) * sin,
      y: cy + (obj.x - cx) * sin + ((obj.y as number) - cy) * cos,
    };
  }
  return v;
}

export function _rotateSkillSteps(steps: SkillStep[], cx: number, cy: number, deg: number): SkillStep[] {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return steps.map((step) => ({
    verb: step.verb,
    args: Object.fromEntries(Object.entries(step.args).map(([k, v]) => {
      if (k === "x" && typeof v === "number") {
        const y0 = (step.args.y as number | undefined) ?? cy;
        return [k, cx + (v - cx) * cos - (y0 - cy) * sin];
      }
      if (k === "y" && typeof v === "number") {
        const x0 = (step.args.x as number | undefined) ?? cx;
        return [k, cy + (x0 - cx) * sin + (v - cy) * cos];
      }
      if (["start", "end", "center", "position", "origin"].includes(k)) return [k, _rotatePoint2D(v, cx, cy, cos, sin)];
      if (k === "points" && Array.isArray(v)) return [k, (v as unknown[]).map((pt) => _rotatePoint2D(pt, cx, cy, cos, sin))];
      return [k, v];
    })),
  }));
}

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
    // QW-3 (#409): expose session counters for tooling + gemma-verify assertions.
    (window as unknown as _GemmaW).__gemmaSession = { startTs: Date.now(), turnCount: 0, dispatchCount: 0, errorCount: 0 };
    // QW-1 (#409): pre-dispatch hook registry — external code registers hooks here.
    (window as unknown as _GemmaW).__gemma_dispatch_hooks = { pre: [] };
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
          placeholder="Ask Gemma — create geometry, inspect the scene, explain commands…"
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

    window.addEventListener("gemma:clear-history", () => this.clear());

    for (const s of STARTER_PROMPTS) {
      const chip = document.createElement("span");
      chip.className = "ai-chip chat-starter-chip";
      chip.textContent = s.label;
      chip.addEventListener("click", () => {
        this._inputEl.value = typeof s.prompt === "function" ? s.prompt() : s.prompt;
        this._inputEl.focus();
        void this._send();
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

  // §D-pre (#988): estimate total history tokens using 4-char/token approximation.
  private _estimateHistoryTokens(): number {
    return Math.ceil(
      this._history.reduce((sum, m) => sum + m.content.length, 0) / 4,
    );
  }

  // §D-pre (#988): compact conversation when approaching context limit.
  // Preserves all Sd* dispatches verbatim + goal + last 4 turns.
  private _compactHistory(): void {
    const preTokens = this._estimateHistoryTokens();

    // Extract all dispatches from message history verbatim.
    const allDispatches: AgentDispatch[] = [];
    for (const msg of this._messages) {
      if (msg.dispatches) allDispatches.push(...msg.dispatches);
    }
    const firstUser = this._history.find((m) => m.role === "user");
    const goal = firstUser?.content ?? "";

    const dispatchBlock = allDispatches.length > 0
      ? allDispatches
          .map((d) => `[${d.verb}(${JSON.stringify(d.args)})]`)
          .join("\n")
      : "(no dispatches yet)";

    const compact = `[Compacted. Goal: "${goal.slice(0, 300)}". Dispatches so far:\n${dispatchBlock}]`;
    const lastTurns = this._history.slice(-4);
    this._history = [{ role: "assistant", content: compact }, ...lastTurns];

    // UI boundary marker.
    const marker = document.createElement("div");
    marker.className = "chat-compact-boundary";
    marker.textContent = "✻ Conversation compacted";
    this._listEl.appendChild(marker);
    this._listEl.scrollTop = this._listEl.scrollHeight;

    const postTokens = this._estimateHistoryTokens();
    console.info("[compact] §D-pre fired:", { preTokens, postTokens, triggerReason: "13K threshold" });
  }

  private async _send(): Promise<void> {
    const text = this._inputEl.value.trim();
    if (!text || this._sendBtn.disabled) return;
    this._inputEl.value = "";
    // QW-3: count all user turns (including skill-direct and testMode paths).
    (window as unknown as _GemmaW).__gemmaSession.turnCount++;

    // Capture + clear pending image before any await so it isn't cleared by a concurrent send.
    const userImage = this._pendingImage;
    if (userImage) this._clearPreview();

    this._pushMsg({ role: "user", content: text });
    this._history.push({ role: "user", content: text });

    // §D-pre (#988): compact before calling the model if history is large.
    if (this._estimateHistoryTokens() > 13000) {
      this._compactHistory();
    }

    this._sendBtn.disabled = true;
    this._sendBtn.textContent = "…";
    const thinking = this._appendThinking();
    const _turnStart = Date.now();

    try {
      const matchedSkills = this._skills.length > 0 ? findSkillsForPrompt(this._skills, text) : [];

      // Fastpath: exactly one skill matched and it has pre-verified steps → execute directly,
      // bypass model inference. Covers the K=0 wrong-args case for building-type prompts.
      if (matchedSkills.length === 1 && matchedSkills[0].steps && matchedSkills[0].steps.length > 0) {
        this._removeThinking(thinking);
        this._executeSkillDirect(matchedSkills[0], text);
        return;
      }

      // §testMode: bypass real inference — inject fixture plan so verify can test
      // foldable plan pane UI without a live model. SdExport as last dispatch
      // terminates the run-plan loop on turn 1 (guarded by __testMode in SdExport handler).
      if ((window as unknown as { __testMode?: boolean }).__testMode) {
        this._removeThinking(thinking);
        this._pushPlanMsg({
          text: "Plan: small house fixture",
          plan: "1. IfcWall\n2. IfcWall\n3. IfcSlab\n4. SdExport",
          dispatches: [
            { verb: "IfcWall", args: {} },
            { verb: "IfcWall", args: {} },
            { verb: "IfcSlab", args: {} },
            { verb: "SdExport", args: { format: "gltf" } },
          ],
        });
        return;
      }

      // Evaluate VISUAL_RE first — visual queries must not trigger SdClearScene below.
      const VISUAL_RE = /(see|look|what|describe|show|scene|there|currently|have|how many|visible|appear|color|shape|render|view|display|tell me about)/i;
      const isVisualQuery = VISUAL_RE.test(text);

      // Auto-clear scene for fresh design prompts — file-loaded IFC or prior geometry
      // pollutes the agent context and produces geometry on top of existing structure (#476).
      // Skip clear when user is asking about the current scene (visual query).
      if (!isVisualQuery && DESIGN_RE.test(text)) {
        await invokeCommand({ command: "SdClearScene", parameters: {} });
      }

      const skillsToPass = matchedSkills.length > 0 ? matchedSkills : this._skills;

      // Auto-capture viewport for visual queries (user hasn't already attached an image).
      // Gemma E4B has native vision — let it actually see the scene.
      let effectiveImage = userImage;
      console.log("[vision] text=", JSON.stringify(text.substring(0,60)), "hasImg=", !!effectiveImage, "re=", isVisualQuery);
      let agentRing: HTMLDivElement | null = null;
      if (!effectiveImage && isVisualQuery) {
        effectiveImage = captureViewport(768) ?? undefined;
        console.log("[vision] captureViewport=", effectiveImage ? "OK len="+effectiveImage.length : "NULL");
        if (effectiveImage) {
          const canvas = document.querySelector<HTMLElement>(".viewport-area canvas");
          const rect = canvas?.getBoundingClientRect();
          if (rect && rect.width > 0) {
            agentRing = document.createElement("div");
            agentRing.className = "agent-looking-ring";
            agentRing.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px;`;
            document.body.appendChild(agentRing);
          }
        }
      }

      const progressSpan = thinking.querySelector<HTMLElement>(".chat-thinking-progress");
      const onGenerateProgress = (e: Event): void => {
        const n = (e as CustomEvent<{ tokens_generated: number }>).detail.tokens_generated;
        if (progressSpan) {
          progressSpan.style.display = "";
          progressSpan.textContent = `${n} tok`;
        }
      };
      window.addEventListener("agentmodel:generate-progress", onGenerateProgress);

      const onGenerateWarning = (e: Event): void => {
        const detail = (e as CustomEvent<{ message: string }>).detail;
        this._pushMsg({ role: "assistant", content: `[warn] ${detail.message}` });
      };
      window.addEventListener("agentmodel:generate-warning", onGenerateWarning);

      let resp: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        resp = await runAgentTurn({
          prompt: text,
          history: this._history.slice(0, -1),
          skills: skillsToPass,
          skillsTotal: this._skills.length,
          maxNewTokens: estimateMaxTokens(text),
          userImage: effectiveImage,
        });
      } finally {
        window.removeEventListener("agentmodel:generate-progress", onGenerateProgress);
        window.removeEventListener("agentmodel:generate-warning", onGenerateWarning);
      }
      agentRing?.remove();

      this._removeThinking(thinking);
      this._updatePerfStrip();

      if (resp.dispatches.length === 0 || isSimplePlan(resp.dispatches)) {
        await this._executeAndPush(resp, _turnStart);
      } else {
        this._pushPlanMsg(resp);
      }
    } catch (e) {
      this._removeThinking(thinking);
      const err = e as Error;
      this._pushMsg({ role: "assistant", content: "", error: err.message });
      // QW-3: track inference/dispatch errors for external monitoring.
      (window as unknown as _GemmaW).__gemmaSession.errorCount++;
    } finally {
      this._sendBtn.disabled = false;
      this._sendBtn.textContent = "SEND";
    }
  }

  private _updatePerfStrip(): void {
    if (this._perfStripEl.style.display === "none") return;
    const t = lastTurn();
    if (!t) { this._perfStripEl.textContent = "no data"; return; }
    const mtpTag = t.mtp_on ? " · MTP" : "";
    const pathTag = t.path ? ` · ${t.path}` : "";
    this._perfStripEl.textContent =
      `tg ${t.tg_tps.toFixed(1)} t/s · pp ${t.pp_tps.toFixed(0)} t/s · in ${t.tokens_in} · out ${t.tokens_out} · prefill ${Math.round(t.prefill_ms)}ms · decode ${Math.round(t.decode_ms)}ms${mtpTag}${pathTag}`;
  }

  private _executeSkillDirect(skill: Skill, promptText?: string): void {
    let steps = skill.steps!;

    // Re-bind positions if prompt contains "at X Y" coordinates.
    if (promptText) {
      const targetPos = _extractPositionFromPrompt(promptText);
      if (targetPos) {
        const anchor = _getStepAnchor(steps);
        if (anchor) {
          const dx = targetPos.x - anchor.x;
          const dy = targetPos.y - anchor.y;
          const dz = targetPos.z - anchor.z;
          if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001 || Math.abs(dz) > 0.001) {
            steps = _rebindSkillSteps(steps, dx, dy, dz);
          }
        }
      }

      // Apply rotation around the target position if "rotated <deg>" present.
      const deg = _extractRotationFromPrompt(promptText);
      if (deg != null && Math.abs(deg) > 0.001) {
        const pivot = _extractPositionFromPrompt(promptText) ?? _getStepAnchor(steps) ?? { x: 0, y: 0, z: 0 };
        steps = _rotateSkillSteps(steps, pivot.x, pivot.y, deg);
      }
    }

    window.dispatchEvent(new CustomEvent("skill:animate", { detail: { steps } }));
    const dispatches: AgentDispatch[] = steps.map((s) => ({ verb: s.verb, args: s.args }));
    const content = `${skill.name} (${steps.length} steps)`;
    this._pushMsg({ role: "assistant", content, dispatches });
    this._history.push({ role: "assistant", content });
  }

  private async _runDispatches(resp: AgentResponse): Promise<{ summary: string; userSummary: string; fired: string[] }> {
    const fired: string[] = [];
    const errors: string[] = [];
    // QW-1: read pre-dispatch hooks once per batch (fault-isolated — hook errors are silenced).
    const preHooks = (window as unknown as _GemmaW).__gemma_dispatch_hooks.pre.slice();
    for (const d of resp.dispatches) {
      // QW-1: call each registered pre-dispatch hook before invoking the command.
      for (const hook of preHooks) { try { hook(d); } catch { /* silenced */ } }
      const out = await invokeCommand({
        command: d.verb,
        parameters: d.args,
        metadata: { source: "agent" },
      });
      const cls = classifyDispatchResult(d.verb, out);
      fired.push(cls.fired);
      if (out.status === "success") setPickerHint(null);
      if (cls.error) errors.push(cls.error);
      // QW-3: count each dispatched verb.
      (window as unknown as _GemmaW).__gemmaSession.dispatchCount++;
    }
    // #500: fit before next runAgentTurn screenshot; sketch tools never hit this path.
    if (resp.dispatches.length > 0) {
      await invokeCommand({ command: "SdZoomExtents", parameters: {}, metadata: { source: "agent" } });
    }
    const agentSummary = resp.dispatches.length === 0
      ? (resp.text.trim() || "(no response)")
      : buildDispatchSummary(resp.dispatches, fired, errors);
    const userSummary = resp.dispatches.length === 0
      ? agentSummary
      : buildDispatchSummary(resp.dispatches, fired, errors, { audience: "user" });
    return { summary: agentSummary, userSummary, fired };
  }

  private async _executeAndPush(resp: AgentResponse, turnStartMs?: number): Promise<void> {
    const { summary, userSummary } = await this._runDispatches(resp);
    this._pushMsg({ role: "assistant", content: userSummary, dispatches: resp.dispatches });
    this._history.push({ role: "assistant", content: summary });
    if (resp.dispatches.length > 0) {
      (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
    }
    // QW-2 (#409): emit turn-complete event — mirrors avir-cli Stop hook turn visibility.
    window.dispatchEvent(new CustomEvent("agent:turn-complete", {
      detail: {
        verbs: resp.dispatches.map((d) => d.verb),
        sceneObjects: (window as unknown as { __viewer?: { scene?: { children?: unknown[] } } }).__viewer?.scene?.children?.length ?? 0,
        turnMs: turnStartMs != null ? Date.now() - turnStartMs : undefined,
      },
    }));
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

        // "Save as skill" affordance for multi-dispatch agent turns (#429).
        if (msg.role === "assistant" && msg.dispatches.length >= 2) {
          const saveBtn = document.createElement("button");
          saveBtn.className = "chat-save-skill-btn";
          saveBtn.type = "button";
          saveBtn.textContent = "Save as skill…";
          const capturedDispatches = msg.dispatches;
          saveBtn.addEventListener("click", () => {
            const steps = capturedDispatches.map((d) => ({ verb: d.verb, args: d.args }));
            openSaveSkillModal(steps);
          });
          item.appendChild(saveBtn);
        }
      }
    }

    this._listEl.appendChild(item);
    this._listEl.scrollTop = this._listEl.scrollHeight;
  }

  private _appendThinking(): HTMLElement {
    const item = document.createElement("div");
    item.className = "chat-msg chat-msg-assistant chat-thinking";
    item.innerHTML = `<span class="chat-thinking-dots"><span>·</span><span>·</span><span>·</span></span><span class="chat-thinking-progress" style="margin-left:6px;font-size:11px;opacity:0.6;display:none"></span>`;
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
  skills?: import("../agent/skills-loader").Skill[],
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
