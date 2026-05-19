// units.ts — unit system helpers (#597).
// All internal geometry is stored in metres. These helpers convert for display.

import { getState } from "./app-state.js";

const M_TO_FT = 3.28084;
const FT_TO_M = 1 / M_TO_FT;
const IN_TO_M = 0.0254;

export function formatLength(m: number): string {
  if (getState("unitSystem") === "imperial") {
    const ft = m * M_TO_FT;
    if (Math.abs(ft) < 1) return `${(ft * 12).toFixed(1)} in`;
    return `${ft.toFixed(2)} ft`;
  }
  return `${m.toFixed(3)} m`;
}

export function formatArea(m2: number): string {
  if (getState("unitSystem") === "imperial") {
    return `${(m2 * M_TO_FT * M_TO_FT).toFixed(2)} ft²`;
  }
  return `${m2.toFixed(2)} m²`;
}

export function formatVolume(m3: number): string {
  if (getState("unitSystem") === "imperial") {
    return `${(m3 * M_TO_FT * M_TO_FT * M_TO_FT).toFixed(2)} ft³`;
  }
  return `${m3.toFixed(2)} m³`;
}

export function unitLabel(): "m" | "ft" {
  return getState("unitSystem") === "imperial" ? "ft" : "m";
}

// Numeric portion only — no unit suffix. Use for <input> value attributes.
export function formatLengthNum(m: number): string {
  if (getState("unitSystem") === "imperial") return (m * M_TO_FT).toFixed(2);
  return m.toFixed(3);
}

// Parse a user-typed length string to metres.
// Supports: "6", "6.5", "6 ft", "6ft", "6'", "6'-3\"", "1.5 m"
// Bare numbers use the active unit system.
// Returns null for empty, non-numeric, or negative/zero input.
export function parseLength(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  // Compound feet-inches: 6'-3" or 6' 3" or 6'-3
  const compound = s.match(/^(\d+(?:\.\d+)?)'[\s-]?(\d+(?:\.\d+)?)["]?$/);
  if (compound) {
    const m = (parseFloat(compound[1]) * 12 + parseFloat(compound[2])) * IN_TO_M;
    return m > 0 ? m : null;
  }

  // Feet apostrophe only: 6' or 6.5'
  const feetApex = s.match(/^(\d+(?:\.\d+)?)'$/);
  if (feetApex) {
    const m = parseFloat(feetApex[1]) * FT_TO_M;
    return m > 0 ? m : null;
  }

  // Explicit ft/feet: "6 ft", "6.5ft", "6 feet"
  const feetUnit = s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet)$/i);
  if (feetUnit) {
    const m = parseFloat(feetUnit[1]) * FT_TO_M;
    return m > 0 ? m : null;
  }

  // Explicit in/inches/": "6 in", "6\"", "6 inches"
  const inchUnit = s.match(/^(\d+(?:\.\d+)?)\s*(?:in|inches?|")$/i);
  if (inchUnit) {
    const m = parseFloat(inchUnit[1]) * IN_TO_M;
    return m > 0 ? m : null;
  }

  // Explicit m/meters: "1.5 m", "1.5m", "1.5 meters"
  const mUnit = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|meters?)$/i);
  if (mUnit) {
    const m = parseFloat(mUnit[1]);
    return m > 0 ? m : null;
  }

  // Bare number — interpret as current unit system
  const bare = parseFloat(s);
  if (!isFinite(bare) || bare <= 0) return null;
  return getState("unitSystem") === "imperial" ? bare * FT_TO_M : bare;
}
