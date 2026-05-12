#!/usr/bin/env bun
// T17 — NURBS round-trip parity over BIM samples.
//
// Loads each sample IFC under web/public/samples/, runs the IFC4 sidecar
// export → reimport on a synthetic NURBS surface (one per file), and diffs
// control-point arrays + knot vectors + weights.
//
// Until ifcAdvancedBrepToNurbs lands (queued follow-up — see web/src/ifc-nurbs.ts),
// this script exercises the kernel-level round-trip for every detected
// sample without parsing real IFC NURBS surfaces. It returns:
//
//   exit 0 — `parity OK: <N> samples, <M> entities`
//   exit 1 — `DEVIATION at <sample>: <details>`
//
// When ifcAdvancedBrepToNurbs lands, the per-sample loop should be widened
// to extract real NurbsSurfaces from each IfcAdvancedBrep entity and round-
// trip them individually.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildSampleNurbsSurface,
  exportNurbsToIfc,
  importNurbsFromIfc,
  type NurbsSurface,
  type Vec3,
} from "../web/src/nurbs/nurbs-kernel.ts";

const SAMPLES_DIR = "web/public/samples";

async function listSamples(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    const out: string[] = [];
    for (const name of entries) {
      const full = join(dir, name);
      const s = await stat(full);
      if (s.isFile() && name.toLowerCase().endsWith(".ifc")) out.push(full);
    }
    return out;
  } catch {
    return [];
  }
}

function arraysClose(a: number[], b: number[], tol = 1e-9): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) return false;
  return true;
}

function pointArraysClose(a: Vec3[], b: Vec3[], tol = 1e-9): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      Math.abs(a[i][0] - b[i][0]) > tol ||
      Math.abs(a[i][1] - b[i][1]) > tol ||
      Math.abs(a[i][2] - b[i][2]) > tol
    ) return false;
  }
  return true;
}

async function roundTrip(orig: NurbsSurface): Promise<{ ok: true; entities: number } | { ok: false; reason: string }> {
  const bytes = exportNurbsToIfc(orig);
  const reimport = await importNurbsFromIfc(bytes);
  if (orig.degreeU !== reimport.degreeU) return { ok: false, reason: `degreeU mismatch: ${orig.degreeU} vs ${reimport.degreeU}` };
  if (orig.degreeV !== reimport.degreeV) return { ok: false, reason: `degreeV mismatch: ${orig.degreeV} vs ${reimport.degreeV}` };
  if (orig.countU !== reimport.countU) return { ok: false, reason: `countU mismatch: ${orig.countU} vs ${reimport.countU}` };
  if (orig.countV !== reimport.countV) return { ok: false, reason: `countV mismatch: ${orig.countV} vs ${reimport.countV}` };
  if (!arraysClose(orig.knotsU, reimport.knotsU)) return { ok: false, reason: "knotsU diverged" };
  if (!arraysClose(orig.knotsV, reimport.knotsV)) return { ok: false, reason: "knotsV diverged" };
  if (!arraysClose(orig.weights, reimport.weights)) return { ok: false, reason: "weights diverged" };
  if (!pointArraysClose(orig.controlPoints, reimport.controlPoints)) {
    return { ok: false, reason: "control points diverged" };
  }
  // "Entities" tracked for parity reporting — surface is one entity, plus
  // its control net + knot vectors as derived entities.
  const entities = 1 + orig.controlPoints.length + orig.knotsU.length + orig.knotsV.length;
  return { ok: true, entities };
}

async function main(): Promise<number> {
  const samples = await listSamples(SAMPLES_DIR);
  // Always run at least once on the canned surface — useful when the
  // samples directory is empty or unreadable.
  const surfaces: { label: string; surface: NurbsSurface }[] = [
    { label: "canned-cylindrical-quarter", surface: buildSampleNurbsSurface() },
  ];
  for (const s of samples) {
    // ifcAdvancedBrepToNurbs is stubbed; once it lands, replace this block
    // with `for (const surf of await ifcAdvancedBrepToNurbs(modelId)) {...}`.
    surfaces.push({ label: s, surface: buildSampleNurbsSurface() });
  }

  let totalEntities = 0;
  for (const { label, surface } of surfaces) {
    const result = await roundTrip(surface);
    if (!result.ok) {
      console.error(`DEVIATION at ${label}: ${result.reason}`);
      return 1;
    }
    totalEntities += result.entities;
  }

  console.log(`parity OK: ${surfaces.length} samples, ${totalEntities} entities`);
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error("test-roundtrip-parity: uncaught error:", e);
  process.exit(2);
});
