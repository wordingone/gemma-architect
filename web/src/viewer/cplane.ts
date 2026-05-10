// cplane.ts — Construction Plane engine (W-1, issue #357).
//
// CPlane defines the working plane for geometric placement operations.
// Every handler calls resolveCPlane(canonical, args, viewer) to obtain
// the active plane; this keeps per-handler code free of view/host logic.

import * as THREE from "three";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CPlaneKind = "world" | "view-derived" | "host-derived" | "explicit";

export type CPlane = {
  origin: THREE.Vector3;
  xAxis:  THREE.Vector3;
  yAxis:  THREE.Vector3;
  normal: THREE.Vector3;
  name?:  string;
  kind:   CPlaneKind;
};

// ── Well-known planes ─────────────────────────────────────────────────────────

export const WORLD_XY: CPlane = Object.freeze({
  origin: new THREE.Vector3(0, 0, 0),
  xAxis:  new THREE.Vector3(1, 0, 0),
  yAxis:  new THREE.Vector3(0, 1, 0),
  normal: new THREE.Vector3(0, 0, 1),
  name:   "World XY",
  kind:   "world" as const,
});

export const WORLD_XZ: CPlane = Object.freeze({
  origin: new THREE.Vector3(0, 0, 0),
  xAxis:  new THREE.Vector3(1, 0, 0),
  yAxis:  new THREE.Vector3(0, 0, 1),
  normal: new THREE.Vector3(0, 1, 0),
  name:   "World XZ",
  kind:   "world" as const,
});

export const WORLD_YZ: CPlane = Object.freeze({
  origin: new THREE.Vector3(0, 0, 0),
  xAxis:  new THREE.Vector3(0, 1, 0),
  yAxis:  new THREE.Vector3(0, 0, 1),
  normal: new THREE.Vector3(1, 0, 0),
  name:   "World YZ",
  kind:   "world" as const,
});

// ── View → plane map ──────────────────────────────────────────────────────────
//
// View names from Viewer.setView(). Camera looks TOWARD the scene center:
//   top / bottom  → camera travels along ±Z → working plane is XY
//   front / back  → camera travels along ±Y → working plane is XZ
//   right / left  → camera travels along ±X → working plane is YZ
//   iso / extents / persp → arbitrary angle → default to world XY

const VIEW_PLANE: Record<string, CPlane> = {
  top:     WORLD_XY,
  bottom:  WORLD_XY,
  front:   WORLD_XZ,
  back:    WORLD_XZ,
  right:   WORLD_YZ,
  left:    WORLD_YZ,
  iso:     WORLD_XY,
  extents: WORLD_XY,
  persp:   WORLD_XY,
};

// ── Per-canonical default kind ────────────────────────────────────────────────
//
// "world"       → always world XY, regardless of view or activeCPlane
// "view-derived"→ plane of the current orthographic view (W-3 handles
//                 placement from it; W-1 establishes the lookup)
// "host-derived"→ surface normal of the host element (W-2; falls back
//                 to world XY until W-2 lands)

const CANONICAL_KIND: Record<string, CPlaneKind> = {
  // IFC structural — always world XY
  IfcWall:     "world",
  IfcSlab:     "world",
  IfcLevel:    "world",
  IfcColumn:   "world",
  IfcBeam:     "world",
  IfcStair:    "world",
  IfcRoof:     "world",
  IfcSpace:    "world",
  // IFC openings — host-derived (W-2 completes; XY fallback for now)
  IfcDoor:     "host-derived",
  IfcWindow:   "host-derived",
  IfcOpening:  "host-derived",
  // SD primitives / agnostic geometry — view-derived (W-3 completes)
  SdBox:       "view-derived",
  SdSphere:    "view-derived",
  SdCylinder:  "view-derived",
  SdCone:      "view-derived",
  SdPrism:     "view-derived",
  SdLine:      "view-derived",
  SdArc:       "view-derived",
  SdCircle:    "view-derived",
  SdPolygon:   "view-derived",
  SdPolyline:  "view-derived",
  SdRectangle: "view-derived",
  SdEllipse:   "view-derived",
  SdSpline:    "view-derived",
  SdExtrude:   "view-derived",
  SdRevolve:   "view-derived",
  SdSweep:     "view-derived",
  SdLoft:      "view-derived",
};

// ── Viewer interface (minimal — avoids circular import with viewer.ts) ────────

export interface CPlaneViewer {
  activeView:   string;
  activeCPlane: CPlane;
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Return the construction plane to use when placing an object of the given
 * canonical verb.
 *
 * Resolution order:
 *   1. viewer.activeCPlane.kind === "explicit"  → return activeCPlane
 *   2. CANONICAL_KIND[canonical] === "world"     → return WORLD_XY
 *   3. CANONICAL_KIND[canonical] === "view-derived" → VIEW_PLANE[viewer.activeView]
 *   4. CANONICAL_KIND[canonical] === "host-derived" → WORLD_XY (W-2 fallback)
 *   5. Unknown canonical → WORLD_XY
 */
export function resolveCPlane(
  canonical: string,
  _args: Record<string, unknown>,
  viewer: CPlaneViewer,
): CPlane {
  // Explicit override always wins.
  if (viewer.activeCPlane.kind === "explicit") return viewer.activeCPlane;

  const kind = CANONICAL_KIND[canonical] ?? "world";

  switch (kind) {
    case "world":
      return WORLD_XY;
    case "view-derived":
      return VIEW_PLANE[viewer.activeView] ?? WORLD_XY;
    case "host-derived":
      // W-2 will implement host surface lookup; for now fall back to world XY.
      return WORLD_XY;
    default:
      return WORLD_XY;
  }
}
