// nurbs-brep.ts — Boundary Representation (Brep) data model.
//
// A Brep is the standard topological shell used by CAD kernels (STEP/IFC4
// IfcAdvancedBrep, OpenCASCADE TopoDS_Shape, Rhino BRep). In this codebase
// it sits on top of the existing Surface / Curve / Point3 types from
// nurbs-surfaces.ts and nurbs-curves.ts — no separate geometry representation
// invented here.
//
// Topology tiers:
//   Brep          — collection of shells
//   BrepShell     — connected set of faces (open or closed)
//   BrepFace      — one surface patch bounded by trim loops
//   TrimLoop      — ordered trim curves forming a closed boundary (param space)
//   BrepEdge      — 3D curve shared by ≤2 faces
//   BrepVertex    — a point at the junction of ≥1 edges
//
// IFC4 / STEP analogy:
//   BrepFace      ↔ IfcAdvancedFace
//   TrimLoop      ↔ IfcFaceBound / IfcFaceOuterBound
//   BrepEdge      ↔ IfcEdgeCurve
//   BrepVertex    ↔ IfcVertexPoint
//
// Tolerance model (OCCT-inspired, #1818 PR-0):
//   Every topological element carries its own `tolerance` field (metres).
//   Algorithms use per-element tolerance rather than a global ε.
//   Operation-level slack is supplied via `FuzzyValue` in call-site options.
//   Reference: OCCT BOPAlgo_Options.FuzzyValue; IntTools_FaceFace.hxx:48-53.
//
// Refs:
//   - ISO 10303-42 §5 (topology) / §6 (geometry).
//   - Piegl & Tiller, "The NURBS Book" (1997), § 11.2–11.3.
//   - OCCT BOPAlgo_Options.hxx:31-32 (FuzzyValue), TopoDS_Shape.hxx:40-90.

import type { Surface } from "./nurbs-surfaces";
import type { Curve } from "./nurbs-curves";
import type { Point3 } from "./nurbs-primitives";

// ── Tolerance constants ───────────────────────────────────────────────────────

/**
 * Default per-element geometric tolerance in model units (metres).
 * Matches OCCT Precision::Confusion() ≈ 1e-7 but rounded up to 1e-6 for
 * practical imported-geometry robustness.
 *
 * Per-element fields override this when set explicitly. Do NOT use this as a
 * global fallback in boolean/intersection algorithms — always read the element's
 * own `tolerance` field and supply operation-level slack via `FuzzyValue`.
 */
export const BREP_DEFAULT_TOLERANCE = 1e-6;

/**
 * Additional slack added on top of per-element tolerances for a single boolean
 * or intersection operation. Enables "touching or coincident" detection that
 * strict element tolerance would miss.
 *
 * Reference: OCCT BOPAlgo_Options.hxx:31-32 (`myFuzzyValue`).
 * Usage: pass in `BooleanOptions.fuzzyValue`; do NOT mutate element tolerances.
 */
export type FuzzyValue = number;

/**
 * Options threaded through boolean and intersection operations.
 * Extend this type as new algorithm options are added (PR-1 onwards).
 */
export type BooleanOptions = {
  /** Additional tolerance slack for this operation only. Default: 0. */
  fuzzyValue?: FuzzyValue;
};

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * An ordered sequence of parameter-space curves forming one closed boundary
 * on a face. The curves are in the (u,v) domain of the parent surface; the
 * z-component is unused (set to 0).
 *
 * For the outer boundary use `orientation = true`.
 * For inner holes (voids) use `orientation = false`.
 */
export type TrimLoop = {
  curves: Curve[];
  orientation: boolean;
};

/**
 * One face of a Brep shell: a surface patch bounded by one outer trim loop
 * and zero or more inner trim loops (holes).
 *
 * `orientation = true`  → face normal agrees with surface normal (outward).
 * `orientation = false` → face normal is reversed (inward-facing shell face).
 *
 * `tolerance` — geometric tolerance for this face's surface approximation
 * (metres). Used by intersection algorithms as one side of the criterion
 * `sum(edge.tol, face.tol)`. Set to `BREP_DEFAULT_TOLERANCE` when unknown.
 */
export type BrepFace = {
  surface: Surface;
  outerLoop: TrimLoop;
  innerLoops: TrimLoop[];
  orientation: boolean;
  tolerance: number;
};

/**
 * A topological edge: the 3D curve where two faces meet.
 * `faceIndex2 = null` denotes a naked (boundary) edge — open shell boundary.
 *
 * `tolerance` — maximum deviation between this edge's 3D curve and the
 * trim curves of adjacent faces (metres). Used by boolean algorithms as the
 * other side of `sum(edge.tol, face.tol)`.
 */
export type BrepEdge = {
  curve: Curve;
  faceIndex1: number;
  faceIndex2: number | null;
  tolerance: number;
};

/**
 * A topological vertex: a geometric point where edges meet.
 *
 * `tolerance` — radius of the 3D ball within which this vertex's point is
 * considered coincident with adjacent edge endpoints (metres).
 */
export type BrepVertex = {
  point: Point3;
  edgeIndices: number[];
  tolerance: number;
};

/**
 * A connected set of faces forming one manifold (or open) shell.
 * `isClosed = true` → all edges are shared by exactly 2 faces (watertight solid).
 * `isClosed = false` → at least one naked (boundary) edge exists.
 */
export type BrepShell = {
  faces: BrepFace[];
  edges: BrepEdge[];
  vertices: BrepVertex[];
  isClosed: boolean;
};

/**
 * A Boundary Representation: one or more shells.
 * Most single-body solids contain exactly one shell.
 * Voids or multi-body compounds can have multiple shells.
 */
export type Brep = {
  shells: BrepShell[];
};

// ── Constructors ──────────────────────────────────────────────────────────────

/** Build a single-face open shell from a surface (no trim loops, no edges). */
export function shellFromSurface(surface: Surface, tolerance = BREP_DEFAULT_TOLERANCE): BrepShell {
  return {
    faces: [
      {
        surface,
        outerLoop: { curves: [], orientation: true },
        innerLoops: [],
        orientation: true,
        tolerance,
      },
    ],
    edges: [],
    vertices: [],
    isClosed: false,
  };
}

/** Wrap one shell in a single-shell Brep. */
export function brepFromShell(shell: BrepShell): Brep {
  return { shells: [shell] };
}

/** Wrap a surface directly in a single-face single-shell Brep. */
export function brepFromSurface(surface: Surface): Brep {
  return brepFromShell(shellFromSurface(surface));
}

/**
 * Concatenate shells from multiple Breps into one Brep (no topology welding).
 * Indices within each shell are unmodified; shells are simply appended.
 * Use this for display/export merging; call `brepWeldShell` for topological joins.
 */
export function brepConcat(...breps: Brep[]): Brep {
  return { shells: breps.flatMap((b) => b.shells) };
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Total face count across all shells. */
export function brepFaceCount(b: Brep): number {
  return b.shells.reduce((n, s) => n + s.faces.length, 0);
}

/** True if ALL shells are closed (fully watertight solid). */
export function brepIsSolid(b: Brep): boolean {
  return b.shells.length > 0 && b.shells.every((s) => s.isClosed);
}

/** True if every shell has at least one naked edge (open surface). */
export function brepIsOpen(b: Brep): boolean {
  return b.shells.some((s) => !s.isClosed);
}

/** Total naked-edge count (boundary edges with faceIndex2 = null) across all shells. */
export function brepNakedEdgeCount(b: Brep): number {
  return b.shells.reduce(
    (n, s) => n + s.edges.filter((e) => e.faceIndex2 === null).length,
    0,
  );
}

/**
 * Maximum tolerance across all faces, edges, and vertices in the Brep.
 * Use as the operation-level base tolerance before adding any `FuzzyValue`
 * slack. Equivalent to OCCT's per-shape tolerance envelope.
 *
 * For an empty Brep (no shells), returns `BREP_DEFAULT_TOLERANCE`.
 */
export function brepMaxTolerance(b: Brep): number {
  let max = BREP_DEFAULT_TOLERANCE;
  for (const shell of b.shells) {
    for (const f of shell.faces)    max = Math.max(max, f.tolerance);
    for (const e of shell.edges)    max = Math.max(max, e.tolerance);
    for (const v of shell.vertices) max = Math.max(max, v.tolerance);
  }
  return max;
}

/**
 * Effective intersection criterion for a face+edge pair: `edge.tol + face.tol`.
 * This mirrors OCCT `IntTools_FaceFace.hxx:48-53`.
 * Pass a `fuzzyValue` (from `BooleanOptions`) to add operation-level slack.
 */
export function intersectionTolerance(
  edge: BrepEdge,
  face: BrepFace,
  fuzzyValue: FuzzyValue = 0,
): number {
  return edge.tolerance + face.tolerance + fuzzyValue;
}
