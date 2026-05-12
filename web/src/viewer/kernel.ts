// Dual-kernel router (T17 scaffold).
//
// The Spatial Dictionary (T5) tags each canonical verb with `kernel:
// "nurbs-webgpu" | "replicad"`. T5 has not landed yet — for now the router
// reads from a small hardcoded mapping table below. When T5 lands, replace
// the table with a lookup against the dictionary.
//
// Ops route as follows:
//
//   replicad-routed (existing OpenCascade path):
//     makeBox, makeCylinder, fuse, cut, fillet, chamfer
//   nurbs-routed (new verb-nurbs / WebGPU path):
//     nurbsSurface, nurbsCurve, revolve, sweep
//
// Boolean / fillet / chamfer stay on replicad until NURBS-native impls
// are written. That is the expected long-term split per the user directive
// — NURBS for surfaces, replicad/OpenCascade for booleans.
//
// This module is intentionally minimal: the actual replicad ops live in
// worker.ts and tier1.ts (parent repo). executeOp() throws "not wired" for
// any op the router does not yet bridge — the caller (dsl-eval) keeps the
// existing direct path until each verb is wired through. That keeps the
// scaffold safe to land before any of the upstream pipeline shifts.

import {
  NurbsKernel,
  type NurbsCurve,
  type NurbsSurface,
  type Mesh,
  buildSampleNurbsSurface,
} from "../nurbs/nurbs-kernel.js";

export type KernelTag = "nurbs-webgpu" | "replicad";

/** Hardcoded table — to be replaced by Spatial Dictionary lookup once T5 lands. */
export const KERNEL_TABLE: Readonly<Record<string, KernelTag>> = Object.freeze({
  // Replicad / OpenCascade ops
  makeBox: "replicad",
  makeCylinder: "replicad",
  fuse: "replicad",
  cut: "replicad",
  fillet: "replicad",
  chamfer: "replicad",
  drawRectangle: "replicad",
  drawCircle: "replicad",
  drawLine: "replicad",
  drawPolyline: "replicad",
  // NURBS / verb-nurbs ops
  nurbsSurface: "nurbs-webgpu",
  nurbsCurve: "nurbs-webgpu",
  revolve: "nurbs-webgpu",
  sweep: "nurbs-webgpu",
});

export function kernelFor(canonicalName: string): KernelTag {
  return KERNEL_TABLE[canonicalName] ?? "replicad";
}

// Replicad-side outputs — opaque handles into the worker. We do not need
// strict types here because the router is the boundary; the worker
// resolves them via tier1Bindings.
export type Solid = unknown;
export type Curve = NurbsCurve | unknown;
export type Surface = NurbsSurface | unknown;

export type ExecuteResult = Solid | Curve | Surface | Mesh;

const sharedNurbsKernel = new NurbsKernel();

/**
 * Dispatch a canonical-named op to the right kernel. Replicad ops throw
 * "not wired" — the existing dsl-eval / worker path stays in charge until
 * each verb is bridged through executeOp().
 *
 * NURBS ops are bridged immediately because the kernel is in this same
 * module. The shape returned is whatever the op naturally produces:
 *   - nurbsSurface → NurbsSurface
 *   - nurbsCurve   → NurbsCurve
 *   - revolve      → NurbsSurface (NURBS-native revolution; stub for T17)
 *   - sweep        → NurbsSurface (NURBS-native sweep; stub for T17)
 */
export async function executeOp(
  canonicalName: string,
  args: Record<string, unknown>,
): Promise<ExecuteResult> {
  const tag = kernelFor(canonicalName);

  if (tag === "replicad") {
    throw new Error(
      `kernel.executeOp: replicad route '${canonicalName}' not wired through router yet — ` +
      `caller should use the existing worker.ts evaluation path. Wiring is planned ` +
      `as a follow-up to T17 once Spatial Dictionary (T5) lands.`,
    );
  }

  // tag === "nurbs-webgpu"
  switch (canonicalName) {
    case "nurbsSurface": {
      // Args are pass-through to the constructor; "sample" returns the
      // canned cylindrical patch so a smoke test can run end-to-end.
      if (args.sample === true) return buildSampleNurbsSurface();
      throw new Error(
        "kernel.executeOp(nurbsSurface): pass {sample:true} for the canned patch, " +
        "or call nurbsSurfaceFromGrid() directly. Full arg-shape spec is queued.",
      );
    }
    case "nurbsCurve": {
      throw new Error(
        "kernel.executeOp(nurbsCurve): stub — call nurbsCurveFromControlPoints() directly until args are speccd.",
      );
    }
    case "revolve": {
      throw new Error(
        "kernel.executeOp(revolve): NURBS-native revolution stub. Plan: take a profile NurbsCurve + axis + angle " +
        "and emit a NurbsSurface via Piegl-Tiller §8.5 surface-of-revolution. Replicad fallback available.",
      );
    }
    case "sweep": {
      throw new Error(
        "kernel.executeOp(sweep): NURBS-native sweep stub. Plan: profile + rail → translational/rational sweep. " +
        "Replicad fallback available.",
      );
    }
    default:
      throw new Error(`kernel.executeOp: unknown NURBS op '${canonicalName}'`);
  }
}

/** Tessellate any NURBS surface produced by the router. */
export async function tessellateNurbs(surface: NurbsSurface, tol: number = 0.01): Promise<Mesh> {
  return sharedNurbsKernel.tessellateSurface(surface, tol);
}
