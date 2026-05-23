// Parametric BIM element dimensions — single source of truth.
// Imported by palette builders, agent dispatch handlers, and IFC export.
// The agent places elements; it does NOT control dimensions.

// Stair — IBC R311.7.5.x, per user directive 2026-05-23
export const STAIR_STEP_RISE  = 0.1778;   // 7"  riser height (fixed)
export const STAIR_STEP_DEPTH = 0.2794;   // 11" tread depth (fixed)
export const STAIR_WIDTH      = 1.0;      // ~39" stair width (fixed)

// Door / Window — re-exported from openings.ts so this file is the single entry point.
export {
  DEFAULT_DOOR_W,
  DEFAULT_DOOR_H,
  FZK_DOOR_W,
  FZK_DOOR_H,
  FZK_FRONT_DOOR_W,
  FZK_FRONT_DOOR_H,
  FZK_TERRACE_DOOR_W,
  FZK_TERRACE_DOOR_H,
  FZK_WINDOW_W,
  FZK_WINDOW_H,
  FZK_WINDOW_SILL,
  FZK_OG_WINDOW_W,
  FZK_OG_WINDOW_H,
} from "./openings";
