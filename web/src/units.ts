// units.ts — unit system helpers (#597).
// All internal geometry is stored in metres. These helpers convert for display.

import { getState } from "./app-state.js";

const M_TO_FT = 3.28084;

export function formatLength(m: number): string {
  if (getState("unitSystem") === "imperial") {
    return `${(m * M_TO_FT).toFixed(2)} ft`;
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
