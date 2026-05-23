// chat-panel.ts — Multi-turn conversation panel for the CREATE dock tab (#41).
//
// Maintains a conversation history across turns and routes each user message
// through agent-harness.ts → dispatch.ts. Dispatches fire immediately after
// each model turn; their verb names are shown as inline pills.

import { runAgentTurn } from "../agent/agent-harness";
import { captureViewport } from "../agent/viewport-capture";
import type { AgentDispatch, AgentResponse } from "../agent/agent-harness";
import { invokeCommand } from "../commands/command-session";
import type { Skill, SkillStep } from "../agent/skills-loader";
import { findSkillsForPrompt } from "../agent/skills-loader";
import { lastTurn } from "../agent/telemetry";
import { buildDispatchSummary } from "./chat-dispatch-summary";
import { classifyDispatchResult } from "./chat-dispatch-routing";
import { buildContextAugmentation } from "../agent/agent-context-augmentor";
import { setPickerHint } from "../viewer/picker-hint";
import { openSaveSkillModal } from "../skills/skill-modal";
import { getState, subscribe } from "../app-state";
import { createGoal, getCachedGoal, updateGoalTokens } from "../agent/goal-state";
import type { Goal } from "../agent/goal-state";

type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  dispatches?: AgentDispatch[];
  error?: string;
  recovery?: "reload"; // adds a "Refresh page" button below the error text
};

// QW-3 (#409): session context global — mirrors avir-cli's session state.
type GemmaSession = { startTs: number; turnCount: number; dispatchCount: number; errorCount: number };
// QW-1 (#409): pre-dispatch hook registry — mirrors avir-cli PreToolUse hooks.
type GemmaDispatchHooks = { pre: Array<(d: AgentDispatch) => void> };
type _GemmaW = Window & typeof globalThis & { __gemmaSession: GemmaSession; __gemma_dispatch_hooks: GemmaDispatchHooks };

type StarterPrompt = { label: string | (() => string); prompt: string | (() => string) };

function resolveStr(v: string | (() => string)): string {
  return typeof v === "function" ? v() : v;
}

const STARTER_PROMPTS: StarterPrompt[] = [
  { label: "What's currently in the scene?", prompt: "What's currently in the scene?" },
  {
    label: () => getState("unitSystem") === "imperial"
      ? "Two-story house (26' × 20')"
      : "Two-story house (8m × 6m)",
    prompt: () => getState("unitSystem") === "imperial"
      ? "Build a two-story residential house, 26' wide by 20' deep, with a pitched roof. Add windows on all four walls, a door on the first floor, and interior stairs."
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
  // 4096 (was 2048 #1243-fix): Schultz hit exactly 2048 cap before SdRoof (25th tool_call);
  // raising to 4096 gives full plan + 30+ tool_calls headroom. WebGPU VRAM unaffected by cap.
  if (/\b(design|pavilion|room|building|house|complex|floor|facade|station|cabin|apartment|center|hall|clinic|library|residence|create|model)\b/.test(p)) return 4096;
  // Default: single geometry command fits in 512.
  return 512;
}

// Keys whose values are angles (degrees) — must not be divided by ft2m.
const _ANGLE_KEYS = new Set(["pitchDeg", "angleDeg", "angle", "rotation", "tilt"]);
const _FT_TO_M = 1 / 3.28084;

function _convertVal(key: string, val: unknown): unknown {
  if (_ANGLE_KEYS.has(key)) return val;
  if (typeof val === "number") return val * _FT_TO_M;
  if (Array.isArray(val)) return val.map((v) => _convertVal(key, v));
  return val;
}

function imperialArgsToMetric(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = _convertVal(k, v);
  return out;
}

export class ChatPanel {
  private _messages: Message[] = [];
  private _history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private _listEl!: HTMLElement;
  private _startersEl!: HTMLElement;
  private _inputEl!: HTMLTextAreaElement;
  private _sendBtn!: HTMLButtonElement;
  private _perfStripEl!: HTMLElement;
  private _goalBannerEl!: HTMLElement;
  private _skills: Skill[] = [];
  private _pendingImage: string | undefined;
  private _previewEl!: HTMLElement;
  private _fileInputEl!: HTMLInputElement;
  private _continuationRunning = false;
  private _continuationSuppressed = false;
  private _continuationCount = 0;
  private _fatalBubbleShown = false;
  private _watchdogTimeoutPending = false;
  private _contextChipEl!: HTMLDivElement;

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
      <div class="chat-goal-banner" style="display:none"></div>
      <div class="chat-list"></div>
      <div class="chat-starters"></div>
      <div class="chat-perf-strip" style="display:none"></div>
      <div class="chat-image-preview" style="display:none"></div>
      <div class="chat-context-chip" style="display:none"></div>
      <div class="chat-compose">
        <button class="chat-attach-btn" type="button" title="Attach sketch image (or paste / drop)">⊕</button>
        <textarea class="chat-input"
          placeholder="Ask Gemma — create geometry, inspect the scene, explain commands…"
          rows="2"></textarea>
        <button class="btn btn-accent btn-sm chat-send-btn" type="button">SEND</button>
      </div>
      <input class="chat-file-input" type="file" accept="image/*" style="display:none" />
    `;
    this._goalBannerEl = this._root.querySelector(".chat-goal-banner")!;
    this._listEl    = this._root.querySelector(".chat-list")!;
    this._startersEl = this._root.querySelector(".chat-starters")!;
    this._perfStripEl = this._root.querySelector(".chat-perf-strip")!;
    this._previewEl = this._root.querySelector(".chat-image-preview")!;
    this._contextChipEl = this._root.querySelector<HTMLDivElement>(".chat-context-chip")!;
    this._inputEl   = this._root.querySelector<HTMLTextAreaElement>(".chat-input")!;
    this._sendBtn   = this._root.querySelector<HTMLButtonElement>(".chat-send-btn")!;
    this._fileInputEl = this._root.querySelector<HTMLInputElement>(".chat-file-input")!;

    // A7 (#980): goal banner — update on goal state changes.
    window.addEventListener("goal:changed", (e) => {
      const goal = (e as CustomEvent<Goal | null>).detail;
      this._updateGoalBanner(goal);
      if (goal?.status === "complete") {
        this._pushMsg({ role: "assistant", content: `Goal achieved. ${goal.objective}. Final usage: ${goal.tokensUsed} tok.` });
        this._continuationSuppressed = true;
      }
    });

    // A6 (#980): continuation safety net — fires on agent:turn-complete while goal is active.
    // #1485 revert (Axis E): single-turn dispatch; continuation only for initial zero-dispatch.
    window.addEventListener("agent:turn-complete", (e) => {
      const detail = (e as CustomEvent<{ verbs: string[] }>).detail;
      const goal = getCachedGoal();
      if (!goal || goal.status !== "active") return;
      if (this._continuationRunning || this._sendBtn.disabled) return;
      if (this._continuationSuppressed) return;
      if (detail.verbs.length === 0) {
        if (this._continuationCount === 0) {
          // #1482 (A): Initial user turn emitted plan-prose but no dispatches.
          // Plan is the model's thinking — not doneness. Fire an execute-plan
          // continuation to flush the planned tool_calls rather than suppressing.
          void this._runContinuation(goal, "execute-plan");
        } else {
          // Continuation turn produced no dispatches — model has nothing more to do.
          this._continuationSuppressed = true;
        }
      }
      // Non-zero dispatch turns: single-turn model handles all steps; no loop needed.
    });

    window.addEventListener("debug:telemetry-toggle", () => {
      const visible = this._perfStripEl.style.display !== "none";
      this._perfStripEl.style.display = visible ? "none" : "block";
      if (!visible) this._updatePerfStrip();
    });

    window.addEventListener("gemma:clear-history", () => this.clear());

    const buildChips = () => {
      this._startersEl.innerHTML = "";
      for (const s of STARTER_PROMPTS) {
        const chip = document.createElement("span");
        chip.className = "ai-chip chat-starter-chip";
        chip.dataset.promptChip = "1";
        chip.textContent = resolveStr(s.label);
        chip.addEventListener("click", () => {
          this._inputEl.value = resolveStr(s.prompt);
          this._inputEl.focus();
          void this._send();
        });
        this._startersEl.appendChild(chip);
      }
    };
    buildChips();
    subscribe("unitSystem", () => buildChips());

    this._sendBtn.addEventListener("click", () => { void this._send(); });
    this._inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this._send();
      }
    });

    // #1354: gate chat-input across worker-recycle/re-init window. agent-harness.ts
    // sets _bootComplete=false on planned recycle (L1084), watchdog recycle (L1087),
    // and D3D12-OOM recycle (L355). Boot screen is one-shot (boot-screen.ts:256 removed
    // the overlay) so user can otherwise submit a prompt mid-recycle and hit the
    // "Model is still loading" guard at agent-harness.ts:1015.
    //
    // Disable on agentmodel:worker-recycled; re-enable on the next agentmodel:boot-complete.
    // Skip if a send is already in flight (sendBtn already disabled with "…" text — let the
    // in-progress send finish or fail by its own path).
    const _savedPlaceholder = this._inputEl.placeholder;
    let _recyclePending = false;
    window.addEventListener("agentmodel:worker-recycled", () => {
      _recyclePending = true;
      this._inputEl.disabled = true;
      this._inputEl.placeholder = "restarting model…";
      // Don't clobber an in-progress send (text "…"). Only override when idle ("SEND").
      if (this._sendBtn.textContent === "SEND") {
        this._sendBtn.disabled = true;
        this._sendBtn.textContent = "WAIT";
      }
    });
    window.addEventListener("agentmodel:boot-complete", () => {
      if (!_recyclePending) return;
      _recyclePending = false;
      this._inputEl.disabled = false;
      this._inputEl.placeholder = _savedPlaceholder;
      if (this._sendBtn.textContent === "WAIT") {
        this._sendBtn.disabled = false;
        this._sendBtn.textContent = "SEND";
      }
    });

    // §C-gpu-fatal (#1427): surface Refresh button when GPU adapter is irrecoverably torn.
    // Fatal fires synchronously before _send() callback rejection; once: true is correct —
    // GPU OOM only fires once per session (agent-harness.ts:360 halts after 2 recycles).
    window.addEventListener("agentmodel:fatal", () => {
      if (!this._fatalBubbleShown) {
        this._fatalBubbleShown = true;
        this._pushMsg({
          role: "assistant", content: "",
          error: "GPU memory exhausted after multiple resets — please refresh the page to continue.",
          recovery: "reload",
        });
      }
    }, { once: true });

    // §C-watchdog-ready (#1429): track watchdog-triggered recycles so the subsequent
    // boot-complete can surface a "Model reloaded" followup — input re-enables silently,
    // and without a visible signal the user doesn't know when to retry.
    window.addEventListener("agentmodel:worker-recycled", (e) => {
      if ((e as CustomEvent<{ reason?: string }>).detail?.reason === "generate-stall-watchdog") {
        this._watchdogTimeoutPending = true;
      }
    });
    window.addEventListener("agentmodel:boot-complete", () => {
      if (this._watchdogTimeoutPending) {
        this._watchdogTimeoutPending = false;
        this._pushMsg({ role: "assistant", content: "Model reloaded — ready to try again." });
      }
    });

    // §C-budget (#1439): harness-level compact — show system bubble when turns are dropped.
    window.addEventListener("agentmodel:compact", (e) => {
      const { preTurns, postTurns } = (e as CustomEvent<{ preTurns: number; postTurns: number }>).detail;
      this._pushMsg({
        role: "system",
        content: `✻ Context compacted (${preTurns}→${postTurns} turns retained)`,
      });
    });

    // §C-budget (#1439): context-budget chip — surface ≥85% saturation in input area.
    window.addEventListener("agentmodel:context-budget", (e) => {
      const { inputLength, limit, ratio } = (e as CustomEvent<{ inputLength: number; limit: number; ratio: number }>).detail;
      if (ratio >= 0.85) {
        const pct = Math.round(ratio * 100);
        this._contextChipEl.textContent = `⚠ Context ${pct}% full (${inputLength}/${limit} tok) — start a new conversation for best results`;
        this._contextChipEl.style.display = "";
      } else {
        this._contextChipEl.style.display = "none";
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

  // §C-hist (#990): enforce byte budget on _history — evict oldest turns from front
  // until total char count is within WEBGPU_CONTEXT_LIMIT × 0.5 tokens × 4 chars/tok.
  // Primary cap (fires after every push); compact (#988 §D-pre) is the secondary mechanism
  // that fires only on user-push when the token estimate exceeds 13K.
  // Always preserves at least 1 entry so _history is never emptied.
  private _enforceHistoryBudget(): void {
    // 16384 context × 0.5 history fraction × 4 chars/token = 32768 chars
    const HISTORY_BUDGET_CHARS = 32768;
    while (
      this._history.length > 1 &&
      this._history.reduce((s, m) => s + m.content.length, 0) > HISTORY_BUDGET_CHARS
    ) {
      this._history.shift();
    }
  }

  // §D-pre (#988): compact conversation when approaching context limit.
  // Preserves all Sd* dispatches verbatim + goal + last 4 turns.
  // §B-compact (#990 audit): no closure retains the pre-compact _history array —
  // verified: no shadow field, no event handler capture, no telemetry reference.
  // Reassignment at `this._history = [...]` drops the old array for GC.
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
          .map((d) => `[${d.name}(${JSON.stringify(d.arguments)})]`)
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
    this._enforceHistoryBudget(); // §C-hist (#990)

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

      // A5 (#980): create goal for design-intent prompts before first agent turn.
      // Non-design prompts (questions, single-verb commands) run single-turn without a goal.
      const VISUAL_RE = /(see|look|what|describe|show|scene|there|currently|have|how many|visible|appear|color|shape|render|view|display|tell me about)/i;
      const isVisualQuery = VISUAL_RE.test(text);
      if (!isVisualQuery && !userImage && DESIGN_RE.test(text)) {
        const existingGoal = getCachedGoal();
        if (!existingGoal || existingGoal.status !== "active") {
          await createGoal(text, 10000);
        }
      }
      this._continuationSuppressed = false;
      this._continuationCount = 0;

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
        this._pushMsg({ role: "assistant", content: detail.message });
      };
      window.addEventListener("agentmodel:generate-warning", onGenerateWarning);

      // #1568: inject deterministic geometry context for continuation turns.
      // Puts parent-wall coords + metric-literal hints in the most-attended position
      // (prefix to current user prompt) so they beat T1's KV-cache anchoring.
      const priorHistory = this._history.slice(0, -1);
      const contextAug = buildContextAugmentation(text, priorHistory);
      const effectivePrompt = contextAug ? `${contextAug}\n${text}` : text;

      let resp: Awaited<ReturnType<typeof runAgentTurn>>;
      try {
        resp = await runAgentTurn({
          prompt: effectivePrompt,
          history: priorHistory,
          skills: skillsToPass,
          skillsTotal: this._skills.length,
          maxNewTokens: 2048,
          userImage: effectiveImage,
        });
      } finally {
        window.removeEventListener("agentmodel:generate-progress", onGenerateProgress);
        window.removeEventListener("agentmodel:generate-warning", onGenerateWarning);
        agentRing?.remove(); // §#1507: must be in finally — skipped on exception if placed after
      }

      this._removeThinking(thinking);
      this._updatePerfStrip();

      // #980: goal-mode default — always auto-execute, no plan-pending UI.
      await this._executeAndPush(resp, _turnStart);
    } catch (e) {
      this._removeThinking(thinking);
      const err = e as Error;
      const isGpuFatal = err.message.includes("GPU memory exhausted");
      // agentmodel:fatal listener already pushed the bubble synchronously before this catch
      // runs (callback rejection is a microtask; fatal fires synchronously). Skip to avoid
      // a duplicate bubble, but still track error count.
      if (isGpuFatal && this._fatalBubbleShown) {
        (window as unknown as _GemmaW).__gemmaSession.errorCount++;
        return;
      }
      if (isGpuFatal) this._fatalBubbleShown = true;
      // #1428: model-load-failed errors (WebGPU unsupported or other fatal load) also warrant
      // a reload button — the model is in an unrecoverable state; refresh is the only fix.
      const isModelLoadFailed = err.message.startsWith("Model failed to load");
      // #1429: watchdog timeout — model is reloading but reload button offered as default
      // recovery per Leo (retry surface is non-trivial; page reload is safest escape).
      const isTimeout = err.message.startsWith("Response timed out");
      const needsReload = isGpuFatal || isModelLoadFailed || isTimeout;
      this._pushMsg({ role: "assistant", content: "", error: err.message, ...(needsReload ? { recovery: "reload" } : {}) });
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
    const dispatches: AgentDispatch[] = steps.map((s) => ({ name: s.verb, arguments: s.args }));
    const content = `${skill.name} (${steps.length} steps)`;
    this._pushMsg({ role: "assistant", content, dispatches });
    this._history.push({ role: "assistant", content });
    this._enforceHistoryBudget(); // §C-hist (#990)
  }

  private async _runDispatches(resp: AgentResponse): Promise<{ summary: string; userSummary: string; fired: string[] }> {
    const fired: string[] = [];
    const errors: string[] = [];
    const isImperial = getState("unitSystem") === "imperial";
    // #1487: dispatch ledger — per-dispatch diagnostic for Phase J receipt.
    const w = window as unknown as Record<string, unknown>;
    if (!Array.isArray(w.__dispatchLedger)) w.__dispatchLedger = [];
    const ledger = w.__dispatchLedger as unknown[];
    // QW-1: read pre-dispatch hooks once per batch (fault-isolated — hook errors are silenced).
    const preHooks = (window as unknown as _GemmaW).__gemma_dispatch_hooks.pre.slice();
    for (const d of resp.dispatches) {
      // QW-1: call each registered pre-dispatch hook before invoking the command.
      for (const hook of preHooks) { try { hook(d); } catch { /* silenced */ } }
      const sceneChildrenBefore = (window as unknown as { __viewer?: { scene?: { children?: unknown[] } } }).__viewer?.scene?.children?.length ?? -1;
      const effectiveArgs = isImperial ? imperialArgsToMetric(d.arguments) : d.arguments;
      const out = await invokeCommand({
        command: d.name,
        parameters: effectiveArgs,
        metadata: { source: "agent" },
      });
      const sceneChildrenAfter = (window as unknown as { __viewer?: { scene?: { children?: unknown[] } } }).__viewer?.scene?.children?.length ?? -1;
      ledger.push({
        verb: d.name, args: effectiveArgs,
        status: out.status, error: (out as Record<string, unknown>).error ?? null,
        sceneChildrenBefore, sceneChildrenAfter,
        sceneChildrenDelta: sceneChildrenAfter - sceneChildrenBefore,
      });
      const cls = classifyDispatchResult(d.name, out);
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
    this._enforceHistoryBudget(); // §C-hist (#990)
    if (resp.dispatches.length > 0) {
      (window as unknown as { __viewer?: { frameAllVisible?(): void } }).__viewer?.frameAllVisible?.();
    }
    // A6 (#980): update goal token usage from last turn telemetry (atomic, transition if exhausted).
    const t = lastTurn();
    if (t) await updateGoalTokens(t.tokens_in, t.tokens_out);
    // QW-2 (#409): emit turn-complete event — mirrors avir-cli Stop hook turn visibility.
    window.dispatchEvent(new CustomEvent("agent:turn-complete", {
      detail: {
        verbs: resp.dispatches.map((d) => d.name),
        sceneObjects: (window as unknown as { __viewer?: { scene?: { children?: unknown[] } } }).__viewer?.scene?.children?.length ?? 0,
        turnMs: turnStartMs != null ? Date.now() - turnStartMs : undefined,
      },
    }));
  }

  // A7 (#980): update goal banner from current goal state.
  private _updateGoalBanner(goal: Goal | null): void {
    if (!goal || goal.status === "complete") {
      this._goalBannerEl.style.display = "none";
      this._goalBannerEl.removeAttribute("data-status");
      return;
    }
    const budgetText = goal.tokenBudget != null
      ? ` — ${goal.tokensUsed} / ${goal.tokenBudget} tok`
      : ` — ${goal.tokensUsed} tok`;
    this._goalBannerEl.textContent = `Goal: ${goal.objective.slice(0, 60)}${goal.objective.length > 60 ? "…" : ""}${budgetText} — ${goal.status}`;
    this._goalBannerEl.dataset.status = goal.status;
    this._goalBannerEl.style.display = "";
  }

  // A6 (#980): continuation turn — runs one more agent turn while goal is active.
  // #1482 (A): mode="execute-plan" fires when the initial turn emitted plan-prose but
  // no dispatches. Uses a stronger prompt so the model emits tool_calls immediately.
  private async _runContinuation(goal: Goal, mode?: "execute-plan"): Promise<void> {
    if (this._continuationRunning) return;
    this._continuationRunning = true;
    this._continuationCount++;
    this._sendBtn.disabled = true;
    this._sendBtn.textContent = "…";
    const thinking = this._appendThinking();
    try {
      const continuationPrompt = mode === "execute-plan"
        ? `Your previous turn emitted a <plan> block but no <tool_call> dispatches. Execute the plan now — output ONLY <tool_call> blocks (5-10 per turn maximum). Do not re-state the plan. When all planned steps are dispatched, emit <tool_call>{"name":"update_goal","arguments":{"status":"complete"},"metadata":{"source":"agent"}}</tool_call>.`
        : `Continue working toward the goal: "${goal.objective}". Dispatch the next batch of building elements (5-10 tool_calls maximum per turn). Call update_goal({"status":"complete"}) when fully done.`;
      this._history.push({ role: "user", content: continuationPrompt });
      this._enforceHistoryBudget();
      const resp = await runAgentTurn({
        prompt: continuationPrompt,
        history: this._history.slice(0, -1),
        maxNewTokens: 2048,
      });
      this._removeThinking(thinking);
      this._updatePerfStrip();
      await this._executeAndPush(resp, undefined); // token update happens inside _executeAndPush
      if (resp.dispatches.length === 0) this._continuationSuppressed = true;
    } catch {
      this._removeThinking(thinking);
    } finally {
      this._continuationRunning = false;
      this._sendBtn.disabled = false;
      this._sendBtn.textContent = "SEND";
    }
  }


  private _pushMsg(msg: Message): void {
    this._messages.push(msg);
    const item = document.createElement("div");
    item.className = `chat-msg chat-msg-${msg.role}`;

    if (msg.role === "system") {
      const sysSpan = document.createElement("span");
      sysSpan.className = "chat-msg-system";
      sysSpan.textContent = msg.content;
      item.appendChild(sysSpan);
      this._listEl.appendChild(item);
      this._listEl.scrollTop = this._listEl.scrollHeight;
      return;
    }

    if (msg.error) {
      const errSpan = document.createElement("span");
      errSpan.className = "chat-msg-error";
      errSpan.textContent = `⚠ ${msg.error}`;
      item.appendChild(errSpan);
      if (msg.recovery === "reload") {
        const refreshBtn = document.createElement("button");
        refreshBtn.className = "chat-refresh-btn";
        refreshBtn.textContent = "↺ Refresh page";
        refreshBtn.addEventListener("click", () => window.location.reload());
        item.appendChild(refreshBtn);
      }
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
          pill.textContent = d.name;
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
            const steps = capturedDispatches.map((d) => ({ verb: d.name, args: d.arguments }));
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
    ? `Recent commands: ${recentDispatches.slice(-8).map((d) => `${d.name}(${JSON.stringify(d.arguments)})`).join("; ")}`
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

  return runAgentTurn({
    prompt: lines.join("\n"),
    userImage,
    maxNewTokens: 2048,
  });
}

// DESIGN_RE: matches design-intent prompts that trigger goal creation (#980 A5).
const DESIGN_RE = /\b(design|build|create|model)\b.*\b(house|apartment|office|cabin|building|studio|home|tiny home|residence)\b|\b(house|apartment|office|cabin|building|studio|home)\b/i;
