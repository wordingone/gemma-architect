// IFC ↔ NURBS interop bridge (T17 scaffold).
//
// IFC4 carries NURBS surfaces as IfcRationalBSplineSurfaceWithKnots /
// IfcBSplineSurfaceWithKnots / IfcAdvancedBrep. web-ifc parses these but
// surfaces them as a flat entity stream — converting them to our NurbsSurface
// shape requires walking IfcAdvancedBrep → IfcAdvancedFace[] → IfcSurface.
//
// This module is a STUB. The plan:
//
//   1. After web-ifc loads a file, iterate IfcAdvancedBrep entities.
//   2. For each face, resolve face_surface to an IfcRationalBSplineSurfaceWithKnots
//      (or non-rational variant — fold weights to all-1).
//   3. Read controlPointsList, uMultiplicities/vMultiplicities + uKnots/vKnots
//      and expand to flat knot vectors.
//   4. Yield NurbsSurface objects to the renderer / dual-kernel router.
//
// The reverse direction (NURBS → IFC4) lives in nurbs-kernel.ts as
// exportNurbsToIfc. That path emits a sidecar JSON in this scaffold; the
// production STEP-21 emit is queued as a follow-up.
//
// References:
//   - IFC4 schema, Annex C.6 — B-spline surface entities.
//   - web-ifc API: GetLineIDsWithType / GetLine.
//   - Piegl & Tiller, "The NURBS Book" §2.3 (knot multiplicity → flat knots).

import type { NurbsSurface } from "../nurbs/nurbs-kernel.js";

/** STUB. Convert a parsed IFC IfcAdvancedBrep to a list of NurbsSurface. */
export async function ifcAdvancedBrepToNurbs(_modelId: number): Promise<NurbsSurface[]> {
  throw new Error(
    "ifcAdvancedBrepToNurbs: stub — follow-up issue. Path: IfcAdvancedBrep → IfcAdvancedFace[] → " +
    "IfcRationalBSplineSurfaceWithKnots. See ifc-nurbs.ts header for schema refs.",
  );
}

/**
 * Expand an IFC knot list (knots + multiplicities) into the flat knot vector
 * our evaluator expects. Pure function — exposed here so the upcoming
 * ifcAdvancedBrepToNurbs implementation can use it.
 */
export function expandKnots(knots: number[], multiplicities: number[]): number[] {
  if (knots.length !== multiplicities.length) {
    throw new Error(
      `expandKnots: knots.length ${knots.length} != multiplicities.length ${multiplicities.length}`,
    );
  }
  const out: number[] = [];
  for (let i = 0; i < knots.length; i++) {
    for (let m = 0; m < multiplicities[i]; m++) {
      out.push(knots[i]);
    }
  }
  return out;
}
