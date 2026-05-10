// dispatch.ts — central command dispatch (T6).
//
// Every UI surface (menubar / ribbon / palette / cmdk / console / agent
// tool-calls / hotkeys) ends up calling dispatch(canonical_name, args).
// One handler per canonical name keeps the call graph traceable and
// pushes the ~177 stubs into one place where they're either implemented
// or marked TODO with a single uniform shape.
//
// Resolution order:
//   1. canonical_name (exact match in registry)
//   2. alias-index lookup (via dictionary.ts) — maps synonyms → canonical
//   3. runtime alias-json from ~/.gemma-architect/aliases.json (deep-merge
//      over compiled defaults; reloads on Window > Reload aliases)
//
// Validation: every dispatch call validates against the spatial dictionary
// arg schema before invoking the handler. ArgValidationError is returned
// (not thrown) so the agent can recover gracefully.

import {
  getDictionary,
  getEntry,
  resolveAlias,
  type SpatialDictionaryEntry,
  type SdArg,
  type ChoiceOption,
} from "./dictionary";

// ============================================================
// Types
// ============================================================

export type DispatchArgs = Record<string, unknown>;

export type DispatchResultOk = {
  ok: true;
  canonical: string;
  result?: unknown;
};

export type DispatchResultErr = {
  ok: false;
  canonical: string | null;
  error:
    | "UnknownVerb"
    | "ArgValidationError"
    | "NoHandler"
    | "HandlerThrew"
    | "NeedsChoiceError";
  detail?: string;
  choice?: { arg: string; options: ChoiceOption[] };
};

export type DispatchResult = DispatchResultOk | DispatchResultErr;

export type DispatchHandler = (
  args: DispatchArgs,
  entry: SpatialDictionaryEntry,
) => unknown | Promise<unknown>;

// ============================================================
// Handler registry
// ============================================================

const handlers = new Map<string, DispatchHandler>();

// Dispatch context — set while a handler is executing so viewer.addMesh can
// tag newly created meshes with the dispatch verb + args automatically.
let _dispatchCtx: { canonical: string; args: DispatchArgs } | null = null;
export function getCurrentDispatchCtx(): { canonical: string; args: DispatchArgs } | null {
  return _dispatchCtx;
}

/** Register a dispatch handler. Last-wins for the canonical name. */
export function registerHandler(canonical: string, fn: DispatchHandler): void {
  handlers.set(canonical, fn);
}

/** Remove a handler. */
export function unregisterHandler(canonical: string): void {
  handlers.delete(canonical);
}

/** Bulk-register a record of handlers. */
export function registerHandlers(map: Record<string, DispatchHandler>): void {
  for (const [k, v] of Object.entries(map)) handlers.set(k, v);
}

/** List the canonical names that currently have a handler. */
export function listHandlers(): string[] {
  return [...handlers.keys()].sort();
}

/** True iff a handler is registered for canonical. */
export function hasHandler(canonical: string): boolean {
  return handlers.has(canonical);
}

// ============================================================
// Runtime alias overrides
// ============================================================

const runtimeAliases = new Map<string, string>(); // synonym(lower) → canonical

/**
 * Replace runtime aliases with the given map. Called by main.ts on
 * boot (best-effort fetch of ~/.gemma-architect/aliases.json) and
 * from the Window > Reload aliases menu item.
 */
export function setRuntimeAliases(aliases: Record<string, string>): void {
  runtimeAliases.clear();
  for (const [syn, canonical] of Object.entries(aliases)) {
    runtimeAliases.set(syn.toLowerCase(), canonical);
  }
}

/** Inspect what runtime aliases are loaded. */
export function getRuntimeAliases(): Record<string, string> {
  return Object.fromEntries(runtimeAliases.entries());
}

// ============================================================
// Verb resolution
// ============================================================

/**
 * Resolve a token (canonical OR synonym OR runtime alias) to a
 * canonical_name from the spatial dictionary. Returns null if nothing
 * matches.
 */
export function resolveVerb(token: string): string | null {
  if (!token) return null;
  // 1. Direct canonical match.
  if (getEntry(token)) return token;
  // 2. Runtime alias override.
  const rt = runtimeAliases.get(token.toLowerCase());
  if (rt && getEntry(rt)) return rt;
  // 3. Compiled spatial-api alias.
  const compiled = resolveAlias(token);
  if (compiled) return compiled;
  return null;
}

// ============================================================
// Arg validation
// ============================================================

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function validateArgValue(value: unknown, spec: SdArg): string | null {
  // Returns null on success, error string on failure.
  if (value === undefined || value === null) {
    if (spec.required) return `missing required arg "${spec.name}"`;
    return null;
  }
  switch (spec.type) {
    case "number":
    case "integer":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `arg "${spec.name}" expected number, got ${typeof value}`;
      }
      if (spec.type === "integer" && !Number.isInteger(value)) {
        return `arg "${spec.name}" expected integer, got ${value}`;
      }
      return null;
    case "string":
    case "enum_format":
      return typeof value === "string" ? null : `arg "${spec.name}" expected string`;
    case "enum_choice": {
      if (typeof value !== "string") return `arg "${spec.name}" expected string (enum_choice)`;
      if (spec.options && spec.options.length > 0 && !spec.options.some((o) => o.value === value)) {
        return `arg "${spec.name}" must be one of: ${spec.options.map((o) => o.value).join(", ")}`;
      }
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : `arg "${spec.name}" expected boolean`;
    case "point2":
    case "point3":
    case "vector3":
      if (!Array.isArray(value)) return `arg "${spec.name}" expected array`;
      // tolerate any length 2 or 3 — the kernel ops accept both.
      if (value.length < 2 || value.length > 3) {
        return `arg "${spec.name}" expected 2- or 3-tuple, got length ${value.length}`;
      }
      if (!value.every((v) => typeof v === "number" && Number.isFinite(v))) {
        return `arg "${spec.name}" expected numeric tuple`;
      }
      return null;
    case "polyline":
    case "polyline_or_circle":
    case "list_point2":
    case "list_edge":
    case "list_face":
    case "list_any":
    case "list_edge_or_surface":
      return Array.isArray(value) ? null : `arg "${spec.name}" expected array`;
    case "any":
      return null;
    case "arraybuffer":
      return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
        ? null
        : `arg "${spec.name}" expected ArrayBuffer`;
    default:
      // Custom kernel-specific types — treat as opaque pass-through. Most
      // kernel ops handle their own internal validation. This keeps
      // dispatch from rejecting valid edges/surfaces/solids by being
      // overly strict on shape.
      return null;
  }
}

function validateArgs(args: DispatchArgs, schema: SdArg[]): string | null {
  if (!isPlainObject(args)) return "args must be an object";
  // Check each declared arg.
  for (const spec of schema) {
    // enum_choice missing-required case is handled by findMissingEnumChoice pre-pass.
    if (spec.type === "enum_choice" && (args[spec.name] === undefined || args[spec.name] === null)) {
      if (!spec.required) continue;
      // Required but null/undefined: already caught by pre-pass; skip here to avoid double-error.
      continue;
    }
    const err = validateArgValue(args[spec.name], spec);
    if (err) return err;
  }
  return null;
}

function findMissingEnumChoice(
  args: DispatchArgs,
  schema: SdArg[],
): { arg: string; options: ChoiceOption[] } | null {
  for (const spec of schema) {
    if (spec.type !== "enum_choice") continue;
    if (args[spec.name] !== undefined && args[spec.name] !== null) continue;
    // Missing enum_choice (required or optional with no default provided).
    return { arg: spec.name, options: spec.options ?? [] };
  }
  return null;
}

// ============================================================
// Dispatch
// ============================================================

/**
 * Invoke the handler for `verb` with `args`. Resolves aliases via
 * resolveVerb, validates args against the dictionary schema, and
 * routes to the registered handler.
 */
export async function dispatch(
  verb: string,
  args: DispatchArgs = {},
): Promise<DispatchResult> {
  const canonical = resolveVerb(verb);
  if (!canonical) {
    return { ok: false, canonical: null, error: "UnknownVerb", detail: `verb=${verb}` };
  }

  const entry = getEntry(canonical);
  if (!entry) {
    // Should be unreachable since resolveVerb confirmed it, but defensive.
    return { ok: false, canonical, error: "UnknownVerb", detail: `entry=null` };
  }

  const missingChoice = findMissingEnumChoice(args, entry.args);
  if (missingChoice) {
    return { ok: false, canonical, error: "NeedsChoiceError", choice: missingChoice };
  }

  const argsErr = validateArgs(args, entry.args);
  if (argsErr) {
    return { ok: false, canonical, error: "ArgValidationError", detail: argsErr };
  }

  const handler = handlers.get(canonical);
  if (!handler) {
    return { ok: false, canonical, error: "NoHandler" };
  }

  try {
    _dispatchCtx = { canonical, args };
    const result = await handler(args, entry);
    _dispatchCtx = null;
    return { ok: true, canonical, result };
  } catch (e) {
    _dispatchCtx = null;
    return {
      ok: false,
      canonical,
      error: "HandlerThrew",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Synchronous variant — returns the handler's value directly (or
 * throws). Kept for sites that already run in handler context and
 * don't want the Promise.
 */
export function dispatchSync(verb: string, args: DispatchArgs = {}): DispatchResult {
  const canonical = resolveVerb(verb);
  if (!canonical) {
    return { ok: false, canonical: null, error: "UnknownVerb", detail: `verb=${verb}` };
  }
  const entry = getEntry(canonical);
  if (!entry) return { ok: false, canonical, error: "UnknownVerb" };
  const missingChoiceSync = findMissingEnumChoice(args, entry.args);
  if (missingChoiceSync) {
    return { ok: false, canonical, error: "NeedsChoiceError", choice: missingChoiceSync };
  }
  const argsErr = validateArgs(args, entry.args);
  if (argsErr) return { ok: false, canonical, error: "ArgValidationError", detail: argsErr };
  const handler = handlers.get(canonical);
  if (!handler) return { ok: false, canonical, error: "NoHandler" };
  try {
    _dispatchCtx = { canonical, args };
    const result = handler(args, entry);
    _dispatchCtx = null;
    if (result instanceof Promise) {
      return {
        ok: false,
        canonical,
        error: "HandlerThrew",
        detail: "handler returned Promise — use dispatch() not dispatchSync()",
      };
    }
    return { ok: true, canonical, result };
  } catch (e) {
    _dispatchCtx = null;
    return {
      ok: false,
      canonical,
      error: "HandlerThrew",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================
// Coverage report
// ============================================================

/**
 * Compute coverage of the spatial dictionary by registered handlers.
 * Returns the canonical names that DO and DO NOT have handlers, plus
 * the simple ratio. Used by audit-stubs.ts and devtools.
 */
export function dispatchCoverage(): {
  total: number;
  covered: number;
  covered_ratio: number;
  missing: string[];
  present: string[];
} {
  const dict = getDictionary();
  const covered: string[] = [];
  const missing: string[] = [];
  for (const entry of dict) {
    if (handlers.has(entry.canonical_name)) covered.push(entry.canonical_name);
    else missing.push(entry.canonical_name);
  }
  return {
    total: dict.length,
    covered: covered.length,
    covered_ratio: dict.length > 0 ? covered.length / dict.length : 0,
    missing: missing.sort(),
    present: covered.sort(),
  };
}

// ============================================================
// Default handlers
// ============================================================
//
// Best-effort initial coverage. Each handler is a thin shim that emits
// a `gemma:command` CustomEvent so existing UI listeners (shell.ts,
// viewer.ts, etc.) stay reactive without dispatch having to
// know about every subsystem. As specific subsystems acquire native
// dispatch wiring (transforms.ts in T4 already binds via app-state),
// they can registerHandler() to override the generic shim.

function emitCommand(id: string, args: DispatchArgs = {}): void {
  if (typeof window === "undefined") return;
  const ev = new CustomEvent("gemma:command", { detail: { id, args } });
  window.dispatchEvent(ev);
}

export function installDefaultHandlers(): void {
  const dict = getDictionary();
  // Bulk-register a default shim that re-emits as gemma:command. UI
  // subsystems that prefer native dispatch can override later.
  for (const entry of dict) {
    if (handlers.has(entry.canonical_name)) continue;
    handlers.set(entry.canonical_name, (args, e) => {
      // The generic CustomEvent contract: detail = { id: kernel_op, args, canonical, kernel }.
      emitCommand(e.kernel_op, { ...args, canonical: e.canonical_name, kernel: e.kernel });
      return { dispatched: e.kernel_op };
    });
  }
}

/**
 * Best-effort runtime fetch of ~/.gemma-architect/aliases.json.
 * Shipping the loader here so main.ts can boot dispatch in one call.
 * Runs only in browser (skips in test/node).
 */
export async function loadRuntimeAliasesFromUserHome(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    // Resolve via the dev server proxy; in production builds this is
    // a no-op (the file isn't shipped). Failure is non-fatal — the
    // compiled defaults still resolve.
    const res = await fetch("/__user/aliases.json", { cache: "no-store" });
    if (!res.ok) return false;
    const json = (await res.json()) as Record<string, string>;
    setRuntimeAliases(json);
    return true;
  } catch {
    return false;
  }
}
