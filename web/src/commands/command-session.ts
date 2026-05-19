import { dispatch, resolveVerb, type DispatchResult } from "./dispatch";
import { getEntry, type SdArg, type SpatialDictionaryEntry, type ChoiceOption } from "./dictionary";

export type CommandSessionState =
  | "idle"
  | "command_selected"
  | "collecting_args"
  | "ready"
  | "execute"
  | "summarize";

export type InvocationSource = "console" | "palette" | "agent" | "skill" | "compat";

export type CommandEnvelope = {
  command: string;
  parameters?: Record<string, unknown>;
  metadata?: { source?: InvocationSource; sessionId?: string };
};

export type SessionStatus = "running" | "needs_input" | "needs_choice" | "success" | "error";

export type CommandSessionResult = {
  status: SessionStatus;
  state: CommandSessionState;
  summary: string;
  canonical?: string;
  missing?: string[];
  resolvedArgs?: Record<string, unknown>;
  dispatchResult?: DispatchResult;
  awaiting_text_choice?: { arg: string; options: ChoiceOption[] };
};

type ActiveSession = {
  id: string;
  source: InvocationSource;
  state: CommandSessionState;
  canonical: string;
  entry: SpatialDictionaryEntry;
  args: Record<string, unknown>;
};

let _session: ActiveSession | null = null;
let _seq = 0;

const PRIMITIVE_CANONICALS = new Set(["SdPoint", "SdLine", "SdPolyline", "SdRectangle", "SdCircle"]);

// IFC placement commands that collect clicks instead of requiring coordinates upfront.
const IFC_PICKER_CANONICALS = new Set([
  "IfcWall", "IfcSlab", "IfcColumn", "IfcDoor", "IfcWindow",
]);

function nextSessionId(): string {
  _seq += 1;
  return `cmd-${_seq}`;
}

function parseNumberLike(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(-?\d+(?:\.\d+)?(?:e-?\d+)?)(mm|cm|m)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  if (unit === "mm") return n / 1000;
  if (unit === "cm") return n / 100;
  return n;
}

function parsePointLike(v: unknown): number[] | null {
  if (Array.isArray(v)) {
    const out = v.map((x) => parseNumberLike(x));
    if (out.some((x) => x === null)) return null;
    return out as number[];
  }
  if (typeof v === "string") {
    const raw = v.trim().replace(/^\(/, "").replace(/\)$/, "");
    const parts = raw.split(/[\s,]+/).filter(Boolean).map((p) => parseNumberLike(p));
    if (parts.length < 2 || parts.some((x) => x === null)) return null;
    return parts as number[];
  }
  return null;
}

function coerceArg(spec: SdArg, value: unknown): unknown {
  if (value === undefined || value === null) return value;
  switch (spec.type) {
    case "number":
    case "integer": {
      const n = parseNumberLike(value);
      if (n === null) return value;
      return spec.type === "integer" ? Math.trunc(n) : n;
    }
    case "point2":
    case "point3":
    case "vector3": {
      const p = parsePointLike(value);
      if (!p) return value;
      return spec.type === "point2" ? [p[0] ?? 0, p[1] ?? 0] : [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    }
    case "list_point2":
      if (!Array.isArray(value)) return value;
      return value
        .map((item) => parsePointLike(item))
        .filter((p): p is number[] => Array.isArray(p) && p.length >= 2)
        .map((p) => [p[0], p[1]]);
    default:
      return value;
  }
}

function normalizeArgs(entry: SpatialDictionaryEntry, partial: Record<string, unknown>): Record<string, unknown> {
  // Preserve pass-through args that may be accepted by concrete handlers but
  // are not yet reflected in the dictionary schema (migration window).
  const out: Record<string, unknown> = { ...partial };
  for (const spec of entry.args) {
    const raw = partial[spec.name] !== undefined ? partial[spec.name] : spec.default;
    out[spec.name] = coerceArg(spec, raw);
  }
  // Practical default for array/grid prompts: if no explicit target is provided,
  // treat it as a point-pattern request instead of failing validation.
  if (entry.name === "SdArray" && (out.target === undefined || out.target === null)) {
    out.target = "point";
  }
  return out;
}

function missingArgs(entry: SpatialDictionaryEntry, args: Record<string, unknown>): string[] {
  return entry.args
    .filter((a) => a.required)
    .filter((a) => args[a.name] === undefined || args[a.name] === null)
    .map((a) => a.name);
}

function findMissingEnumChoiceArg(
  entry: SpatialDictionaryEntry,
  args: Record<string, unknown>,
): { arg: string; options: ChoiceOption[] } | null {
  for (const spec of entry.args) {
    if (spec.type !== "enum_choice") continue;
    if (args[spec.name] !== undefined && args[spec.name] !== null) continue;
    return { arg: spec.name, options: spec.options ?? [] };
  }
  return null;
}

function buildSummary(canonical: string, args: Record<string, unknown>, status: string, missing: string[] = []): string {
  if (status === "needs_input") {
    return `Waiting for ${canonical}: ${missing.join(", ")}.`;
  }
  return `Ran ${canonical} with ${JSON.stringify(args)} (${status}).`;
}

function applyPrimitivePick(session: ActiveSession, point: [number, number]): void {
  if (session.canonical === "SdPoint") {
    session.args.position = point;
    return;
  }
  if (session.canonical === "SdLine") {
    if (!session.args.start) session.args.start = point;
    else if (!session.args.end) session.args.end = point;
    return;
  }
  if (session.canonical === "SdCircle") {
    if (!session.args.center) session.args.center = point;
    else if (!session.args.radius) {
      const c = session.args.center as number[];
      const r = Math.hypot(point[0] - c[0], point[1] - c[1]);
      session.args.radius = r;
    }
    return;
  }
  if (session.canonical === "SdRectangle") {
    const a = session.args.__pickA as number[] | undefined;
    if (!a) {
      session.args.__pickA = point;
      return;
    }
    const width = Math.abs(point[0] - a[0]);
    const depth = Math.abs(point[1] - a[1]);
    session.args.width = width;
    session.args.depth = depth;
    session.args.center = [(point[0] + a[0]) / 2, (point[1] + a[1]) / 2];
    delete session.args.__pickA;
    return;
  }
  if (session.canonical === "SdPolyline") {
    const pts = (session.args.points as number[][] | undefined) ?? [];
    pts.push([point[0], point[1]]);
    session.args.points = pts;
  }
}

function applyIfcPick(session: ActiveSession, point: [number, number]): void {
  switch (session.canonical) {
    case "IfcWall":
    case "IfcSlab": {
      const pts = (session.args.profile as [number, number][] | undefined) ?? [];
      pts.push([point[0], point[1]]);
      session.args.profile = pts;
      break;
    }
    case "IfcColumn":
    case "IfcDoor":
    case "IfcWindow":
      session.args.position = [point[0], point[1]];
      break;
  }
}

async function executeSession(session: ActiveSession): Promise<CommandSessionResult> {
  session.state = "execute";
  const dispatchArgs = { ...session.args };
  delete dispatchArgs.__pickA;
  const dr = await dispatch(session.canonical, dispatchArgs);
  session.state = "summarize";
  if (!dr.ok) {
    return {
      status: "error",
      state: session.state,
      canonical: session.canonical,
      summary: `Failed ${session.canonical}: ${dr.error}${dr.detail ? ` (${dr.detail})` : ""}.`,
      resolvedArgs: dispatchArgs,
      dispatchResult: dr,
    };
  }
  return {
    status: "success",
    state: session.state,
    canonical: session.canonical,
    summary: `Ran ${session.canonical}.`,
    resolvedArgs: dispatchArgs,
    dispatchResult: dr,
  };
}

export function parseToolEnvelope(raw: unknown): CommandEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const command = typeof obj.command === "string"
    ? obj.command
    : typeof obj.name === "string"
      ? obj.name
      : null;
  if (!command) return null;
  const parameters = obj.parameters && typeof obj.parameters === "object"
    ? (obj.parameters as Record<string, unknown>)
    : obj.arguments && typeof obj.arguments === "object"
      ? (obj.arguments as Record<string, unknown>)
      : {};
  const metadata = obj.metadata && typeof obj.metadata === "object"
    ? (obj.metadata as { source?: InvocationSource; sessionId?: string })
    : undefined;
  return { command, parameters, metadata };
}

export async function startCommandSession(envelope: CommandEnvelope): Promise<CommandSessionResult> {
  const canonical = resolveVerb(envelope.command);
  if (!canonical) {
    return { status: "error", state: "idle", summary: `Unknown command: ${envelope.command}.` };
  }
  const entry = getEntry(canonical);
  if (!entry) {
    return { status: "error", state: "idle", summary: `Unknown command entry: ${canonical}.` };
  }
  const args = normalizeArgs(entry, envelope.parameters ?? {});
  const missing = missingArgs(entry, args);
  const source = envelope.metadata?.source ?? "compat";
  const session: ActiveSession = {
    id: envelope.metadata?.sessionId ?? nextSessionId(),
    source,
    state: "command_selected",
    canonical,
    entry,
    args,
  };
  _session = session;

  const needsPicker = PRIMITIVE_CANONICALS.has(canonical) || IFC_PICKER_CANONICALS.has(canonical);
  if (missing.length > 0 && needsPicker) {
    session.state = "collecting_args";
    return {
      status: "needs_input",
      state: session.state,
      canonical,
      missing,
      resolvedArgs: { ...args },
      summary: buildSummary(canonical, args, "needs_input", missing),
    };
  }

  // Text-choice gate: if any enum_choice arg has no value, surface chooser before executing.
  const missingChoice = findMissingEnumChoiceArg(entry, args);
  if (missingChoice) {
    session.state = "collecting_args";
    return {
      status: "needs_choice",
      state: session.state,
      canonical,
      missing: [missingChoice.arg],
      awaiting_text_choice: missingChoice,
      resolvedArgs: { ...args },
      summary: `Choose ${missingChoice.arg} for ${canonical}: ${missingChoice.options.map((o) => o.value).join(", ")}.`,
    };
  }

  session.state = "ready";
  return executeSession(session);
}

export async function provideSessionPick(point: [number, number]): Promise<CommandSessionResult> {
  if (!_session) {
    return { status: "error", state: "idle", summary: "No active command session." };
  }
  if (PRIMITIVE_CANONICALS.has(_session.canonical)) {
    applyPrimitivePick(_session, point);
  } else if (IFC_PICKER_CANONICALS.has(_session.canonical)) {
    applyIfcPick(_session, point);
  }
  const missing = missingArgs(_session.entry, _session.args);
  if (_session.canonical === "SdPolyline") {
    const pts = (_session.args.points as number[][] | undefined) ?? [];
    if (pts.length < 2) {
      return {
        status: "needs_input",
        state: "collecting_args",
        canonical: _session.canonical,
        missing: ["points"],
        resolvedArgs: { ..._session.args },
        summary: `Waiting for SdPolyline: points (${pts.length}/2+).`,
      };
    }
  } else if (_session.canonical === "IfcWall") {
    const pts = (_session.args.profile as [number, number][] | undefined) ?? [];
    if (pts.length < 2) {
      return {
        status: "needs_input",
        state: "collecting_args",
        canonical: "IfcWall",
        missing: [],
        resolvedArgs: { ..._session.args },
        summary: `Click second point of wall (${pts.length}/2).`,
      };
    }
  } else if (_session.canonical === "IfcSlab") {
    const pts = (_session.args.profile as [number, number][] | undefined) ?? [];
    if (pts.length < 3) {
      return {
        status: "needs_input",
        state: "collecting_args",
        canonical: "IfcSlab",
        missing: [],
        resolvedArgs: { ..._session.args },
        summary: `Click corner ${pts.length + 1} of slab (${pts.length}/3 minimum).`,
      };
    }
    // ≥3 points: stay collecting until Enter commits
    return {
      status: "needs_input",
      state: "collecting_args",
      canonical: "IfcSlab",
      missing: [],
      resolvedArgs: { ..._session.args },
      summary: `${pts.length} corners — press Enter to place slab.`,
    };
  } else if (missing.length > 0) {
    return {
      status: "needs_input",
      state: "collecting_args",
      canonical: _session.canonical,
      missing,
      resolvedArgs: { ..._session.args },
      summary: buildSummary(_session.canonical, _session.args, "needs_input", missing),
    };
  }
  _session.state = "ready";
  return executeSession(_session);
}

// Called by chat-panel or cursor chooser when user has selected an enum_choice value.
export async function provideSessionChoice(value: string): Promise<CommandSessionResult> {
  if (!_session) {
    return { status: "error", state: "idle", summary: "No active command session." };
  }
  const missingChoice = findMissingEnumChoiceArg(_session.entry, _session.args);
  if (!missingChoice) {
    return { status: "error", state: _session.state, summary: "No pending enum_choice in session." };
  }
  _session.args[missingChoice.arg] = value;
  // Re-check for additional missing choices or other missing required args.
  const nextChoice = findMissingEnumChoiceArg(_session.entry, _session.args);
  if (nextChoice) {
    return {
      status: "needs_choice",
      state: "collecting_args",
      canonical: _session.canonical,
      missing: [nextChoice.arg],
      awaiting_text_choice: nextChoice,
      resolvedArgs: { ..._session.args },
      summary: `Choose ${nextChoice.arg} for ${_session.canonical}: ${nextChoice.options.map((o) => o.value).join(", ")}.`,
    };
  }
  const missing = missingArgs(_session.entry, _session.args);
  const needsPicker = PRIMITIVE_CANONICALS.has(_session.canonical) || IFC_PICKER_CANONICALS.has(_session.canonical);
  if (missing.length > 0 && needsPicker) {
    return {
      status: "needs_input",
      state: "collecting_args",
      canonical: _session.canonical,
      missing,
      resolvedArgs: { ..._session.args },
      summary: buildSummary(_session.canonical, _session.args, "needs_input", missing),
    };
  }
  _session.state = "ready";
  return executeSession(_session);
}

export async function commitCommandSession(): Promise<CommandSessionResult | null> {
  if (!_session || _session.state !== "collecting_args") return null;
  if (_session.canonical === "IfcSlab") {
    const pts = (_session.args.profile as [number, number][] | undefined) ?? [];
    if (pts.length < 3) return null;
  }
  _session.state = "ready";
  return executeSession(_session);
}

export async function invokeCommand(envelope: CommandEnvelope): Promise<CommandSessionResult> {
  return startCommandSession(envelope);
}

export function clearCommandSession(): void {
  _session = null;
}

export function getActiveCommandSession(): { canonical: string; state: CommandSessionState; args: Record<string, unknown> } | null {
  if (!_session) return null;
  return { canonical: _session.canonical, state: _session.state, args: { ..._session.args } };
}

