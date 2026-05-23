// dimension-guardrails.ts — SU-5 pre-dispatch range checks (#413)
//
// Returns a human-readable error string if any arg is outside the
// architecturally sane range for known IFC verbs. Returns null when
// all args pass. Called by dispatchSync / dispatch before the handler.
//
// Ranges chosen per issue #413 AC:
//   IfcWall   length 0.5–50 m, height 2–6 m, thickness 0.05–0.5 m
//   IfcDoor   width 0.6–2 m, height 1.8–2.4 m
//   IfcWindow width 0.3–3 m, height 0.3–2.4 m

import type { DispatchArgs } from "./dispatch";

// Converts an imperial measurement (feet) to metres using the exact factor.
const FT_TO_M = 0.3048;

interface RangeSpec {
  min: number;
  max: number;
  unit?: string;
}

function clampMsg(param: string, val: number, spec: RangeSpec): string {
  const u = spec.unit ?? "m";
  return `${param}=${val}${u} out of range [${spec.min}, ${spec.max}]${u} — retry with a value in range`;
}

function checkRange(
  args: DispatchArgs,
  param: string,
  spec: RangeSpec,
): string | null {
  const v = args[param];
  if (v === undefined || v === null) return null; // optional; let schema handle required
  if (typeof v !== "number") return null; // type errors handled by schema validation
  if (v < spec.min || v > spec.max) return clampMsg(param, v, spec);
  return null;
}

// Profile is [[x,y],[x,y],...] for walls — length = distance between endpoints.
function wallProfileLength(profile: unknown): number | null {
  if (!Array.isArray(profile) || profile.length < 2) return null;
  const p0 = profile[0];
  const p1 = profile[profile.length - 1];
  if (!Array.isArray(p0) || !Array.isArray(p1)) return null;
  const dx = (p1[0] as number) - (p0[0] as number);
  const dy = (p1[1] as number) - (p0[1] as number);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Extract numeric values that appear immediately before a metric "m" token in a prompt string. */
function extractMetricLiterals(prompt: string): number[] {
  const result: number[] = [];
  for (const m of prompt.matchAll(/(\d+(?:\.\d+)?)\s*\bm\b/gi)) {
    const n = parseFloat(m[1]);
    if (Number.isFinite(n) && n > 0) result.push(n);
  }
  return result;
}

/**
 * Detect ft→m bleed on SdWall: if the model treated a metric prompt literal
 * as feet and converted to metres, the emitted profile length will equal
 * N_ft × 0.3048.  Reject so the model sees the error and self-corrects.
 *
 * Guard fires when ALL three conditions hold:
 *   1. Profile segment length falls in the suspicious range 0.3–4.6 m (= 1–15 ft)
 *   2. The prompt contains a metric literal N adjacent to "\bm\b"
 *   3. N × 0.3048 ≈ segment length within 5% relative tolerance
 */
export function checkFtToMBleed(
  canonical: string,
  args: DispatchArgs,
  promptLiteral: string,
): string | null {
  if (canonical !== "SdWall") return null;
  const profile = args.profile as [number, number][] | undefined;
  if (!Array.isArray(profile) || profile.length < 2) return null;

  const len = wallProfileLength(profile);
  if (len === null) return null;

  // Suspicious range: 0.3 m (= 1 ft) to 4.6 m (≈ 15 ft)
  if (len < 0.3 || len > 4.6) return null;

  for (const n of extractMetricLiterals(promptLiteral)) {
    const expectedIfFt = n * FT_TO_M;
    const relErr = Math.abs(expectedIfFt - len) / Math.max(expectedIfFt, 0.001);
    if (relErr < 0.05) {
      const feetVal = Math.round(len / FT_TO_M);
      return `Wall length ${len.toFixed(2)}m looks like ${feetVal} feet converted to metres. Re-emit using metric dimensions.`;
    }
  }
  return null;
}

export function checkDimensionGuardrails(
  canonical: string,
  args: DispatchArgs,
): string | null {
  switch (canonical) {
    case "IfcWall": {
      const lenFromProfile = wallProfileLength(args.profile);
      if (lenFromProfile !== null && (lenFromProfile < 0.5 || lenFromProfile > 50)) {
        return clampMsg("wall profile length", lenFromProfile, { min: 0.5, max: 50 });
      }
      return (
        checkRange(args, "height",    { min: 2,    max: 6   }) ??
        checkRange(args, "thickness", { min: 0.05, max: 0.5 })
      );
    }
    case "IfcDoor": {
      return (
        checkRange(args, "width",  { min: 0.6, max: 2   }) ??
        checkRange(args, "height", { min: 1.8, max: 2.4 })
      );
    }
    case "IfcWindow": {
      return (
        checkRange(args, "width",  { min: 0.3, max: 3   }) ??
        checkRange(args, "height", { min: 0.3, max: 2.4 })
      );
    }
    default:
      return null;
  }
}
