// brep-boolean.ts — IBooleanBackend interface + backend registry + toy backend.
//
// PR-1 of the #1818 NURBS kernel umbrella.
//
// Architecture (OpenSCAD CGAL+Manifold dual-backend pattern):
//   IBooleanBackend — stable interface all backends implement
//   BrepResult      — typed Ok/Err return (no exceptions across the boundary)
//   ChangeMap       — Created/Modified/Generated/Deleted history (LibreCAD pattern)
//   registerBackend — opt-in runtime registry; per-op backend selection at call site
//   ToyBackend      — pure-JS correctness baseline; union = structural concat
//
// Three backends planned (this file registers the first):
//   'toy'      — pure-JS structural concat (this file, PR-1)
//   'manifold' — Manifold-WASM fast path, manifold-only (PR-7)
//   'occt'     — NURBS-analytic OCCT-equivalent (PR-4 through PR-6)
//
// Per-op backend selection (never global):
//   union(a, b, { backend: 'manifold' })    → fast path
//   union(a, b, { backend: 'toy' })         → baseline
//   union(a, b)                             → auto (resolves to highest-registered priority)
//
// Refs:
//   - OpenSCAD cgalutils-applyops.cc vs manifold-applyops.cc (same applyOperator3D shape)
//   - OpenSCAD GeometryEvaluator.cc (per-op backend dispatch)
//   - LibreCAD LC_BevelResult (KernelResult changeMap pattern)
//   - OCCT BRepAlgoAPI_BooleanOperation.hxx:31-46 (objects/tools vocabulary)

import type { Brep } from "./nurbs-brep";
import { brepConcat } from "./nurbs-brep";
import type { BooleanOptions } from "./nurbs-brep";

// ── Result types ─────────────────────────────────────────────────────────────

/**
 * Describes what changed in the output Brep relative to the inputs.
 * Enables stable parametric history without LGPL contamination.
 * Reference: LibreCAD `LC_BevelResult` shape.
 *
 * Indices refer to positions in `BrepResult.brep.shells`.
 */
export type ChangeMap = {
  /** Shell indices in result that did not exist in either input. */
  created: number[];
  /**
   * Shell identity changes: maps a `"a:<idx>"` or `"b:<idx>"` key
   * (input shell position) to a `"result:<idx>"` key (output shell position).
   * Used to track modified shells through boolean operations.
   */
  modified: Map<string, string>;
  /**
   * Input shells that were fully consumed / deleted.
   * Keys use the same `"a:<idx>"` / `"b:<idx>"` format.
   */
  deleted: string[];
};

/**
 * Error codes returned by backend operations.
 * Never throw across the kernel boundary — always return a typed error.
 */
export type KernelErrorCode =
  | "NOT_MANIFOLD"          // input Brep is not a closed manifold (toy path expects it)
  | "NUMERICAL_FAILURE"     // intersection or tolerance computation failed
  | "NOT_IMPLEMENTED"       // operation not yet supported by this backend
  | "BACKEND_UNAVAILABLE"   // requested backend id is not registered
  | "EMPTY_INPUT";          // one or both inputs are empty breps

export type KernelError = {
  code: KernelErrorCode;
  message: string;
  /** Backend that produced this error. */
  backend: string;
};

/** Typed Ok/Err return — no exceptions cross the kernel boundary. */
export type BrepResult =
  | { ok: true;  brep: Brep; changeMap: ChangeMap }
  | { ok: false; error: KernelError };

// ── IBooleanBackend interface ─────────────────────────────────────────────────

/**
 * All boolean backends implement this interface.
 *
 * Argument shape follows OCCT's objects/tools asymmetry:
 *   - `a` = "objects" (the solid being operated on)
 *   - `b` = "tools"   (the solid doing the operation)
 * For union/intersection the distinction is semantic only.
 * For difference it encodes: result = a minus b.
 *
 * Reference: OCCT BRepAlgoAPI_BooleanOperation.hxx:31-46.
 */
export interface IBooleanBackend {
  /** Stable identifier; used in BooleanOptions.backend and registry lookup. */
  readonly id: string;

  /** Priority for auto-resolution: higher wins. */
  readonly priority: number;

  /** a ∪ b — result contains all material from both inputs. */
  union(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;

  /** a − b — result contains material in a but not in b. */
  difference(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;

  /** a ∩ b — result contains only material shared by both. */
  intersection(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;

  /**
   * Section edges of a ∩ b — returns curves at the intersection boundary.
   * Reference: OCCT BRepAlgoAPI_BooleanOperation.hxx:39-46 (SECTION operation).
   */
  section(a: Brep, b: Brep, opts?: BooleanOptions): BrepResult;
}

// ── BooleanOptions extension ──────────────────────────────────────────────────

// Extend BooleanOptions (defined in nurbs-brep.ts) with backend selection.
// We augment by re-exporting a wider type alias used internally.
export type BooleanCallOptions = BooleanOptions & {
  /**
   * Backend to use for this operation. Omit for auto (highest priority registered).
   * Reference: OpenSCAD env-var backend choice — we do per-op instead of global.
   */
  backend?: string;
};

// ── Backend registry ──────────────────────────────────────────────────────────

const _registry = new Map<string, IBooleanBackend>();

/**
 * Register a backend. Call at module load time:
 *   `registerBackend(new ManifoldBackend())`
 *
 * Later registrations override earlier ones for the same `id`.
 * Reference: OpenSCAD's `#ifdef ENABLE_MANIFOLD` compile-time gating →
 * we use a runtime registry for dynamic import opt-in.
 */
export function registerBackend(backend: IBooleanBackend): void {
  _registry.set(backend.id, backend);
}

/**
 * Clear all registered backends and optionally re-register the toy backend.
 * Exported for test isolation ONLY — never call in production code.
 */
export function _clearRegistryForTest(reRegisterToy = true): void {
  _registry.clear();
  if (reRegisterToy) registerBackend(new ToyBooleanBackend());
}

/** All currently registered backend ids, sorted by priority descending. */
export function registeredBackends(): string[] {
  return Array.from(_registry.values())
    .sort((a, b) => b.priority - a.priority)
    .map((b) => b.id);
}

/**
 * Resolve the backend for an operation.
 * If `opts.backend` is specified: return that backend or an UNAVAILABLE error.
 * If omitted: return the highest-priority registered backend.
 */
export function resolveBackend(opts?: BooleanCallOptions): IBooleanBackend | KernelError {
  const id = opts?.backend;
  if (id !== undefined) {
    const b = _registry.get(id);
    if (!b) {
      return { code: "BACKEND_UNAVAILABLE", message: `backend '${id}' not registered`, backend: id };
    }
    return b;
  }
  // Auto: pick highest priority
  let best: IBooleanBackend | undefined;
  for (const b of _registry.values()) {
    if (!best || b.priority > best.priority) best = b;
  }
  if (!best) {
    return { code: "BACKEND_UNAVAILABLE", message: "no backends registered", backend: "none" };
  }
  return best;
}

// ── Top-level dispatch functions ──────────────────────────────────────────────

function dispatch(
  op: "union" | "difference" | "intersection" | "section",
  a: Brep,
  b: Brep,
  opts?: BooleanCallOptions,
): BrepResult {
  const backend = resolveBackend(opts);
  if ("code" in backend) return { ok: false, error: backend };
  return backend[op](a, b, opts);
}

/** a ∪ b */
export function brepUnion(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("union", a, b, opts);
}

/** a − b */
export function brepDifference(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("difference", a, b, opts);
}

/** a ∩ b */
export function brepIntersection(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("intersection", a, b, opts);
}

/** Section curves at a ∩ b boundary */
export function brepSection(a: Brep, b: Brep, opts?: BooleanCallOptions): BrepResult {
  return dispatch("section", a, b, opts);
}

// ── Toy backend (pure-JS correctness baseline) ────────────────────────────────

/**
 * Pure-JS toy backend — priority 0 (lowest).
 *
 * Union: structural shell concatenation via brepConcat. Not a topological
 * boolean — internal geometry is not removed. Correct for disjoint inputs;
 * approximate for overlapping inputs. Useful as a dispatch test harness and
 * for early pipeline wiring before PR-6 (BooleanBuilder) lands.
 *
 * Difference / Intersection / Section: NOT_IMPLEMENTED (correct error path).
 *
 * Reference: OpenSCAD CGAL backend — exact but GPL; Manifold backend — fast
 * but manifold-only. Toy backend is neither: it is just proof that the
 * interface and dispatch machinery work end-to-end.
 */
export class ToyBooleanBackend implements IBooleanBackend {
  readonly id = "toy";
  readonly priority = 0;

  union(a: Brep, b: Brep, _opts?: BooleanOptions): BrepResult {
    const result = brepConcat(a, b);
    const aLen = a.shells.length;
    const bLen = b.shells.length;
    const changeMap: ChangeMap = {
      created: [],
      modified: new Map(
        [
          ...a.shells.map((_, i) => [`a:${i}`, `result:${i}`] as [string, string]),
          ...b.shells.map((_, i) => [`b:${i}`, `result:${aLen + i}`] as [string, string]),
        ],
      ),
      deleted: [],
    };
    void bLen;
    return { ok: true, brep: result, changeMap };
  }

  difference(_a: Brep, _b: Brep, _opts?: BooleanOptions): BrepResult {
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "toy backend: difference not implemented (use BooleanBuilder PR-6)", backend: this.id } };
  }

  intersection(_a: Brep, _b: Brep, _opts?: BooleanOptions): BrepResult {
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "toy backend: intersection not implemented (use BooleanBuilder PR-6)", backend: this.id } };
  }

  section(_a: Brep, _b: Brep, _opts?: BooleanOptions): BrepResult {
    return { ok: false, error: { code: "NOT_IMPLEMENTED", message: "toy backend: section not implemented (use BooleanBuilder PR-6)", backend: this.id } };
  }
}

// ── Auto-register the toy backend ────────────────────────────────────────────

registerBackend(new ToyBooleanBackend());
