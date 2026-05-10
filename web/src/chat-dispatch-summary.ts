import type { AgentDispatch } from "./agent/agent-harness";

export const VERB_LABELS: Record<string, [string, string]> = {
  IfcWall:        ["wall",         "walls"],
  IfcSlab:        ["slab",         "slabs"],
  IfcColumn:      ["column",       "columns"],
  IfcBeam:        ["beam",         "beams"],
  IfcDoor:        ["door",         "doors"],
  IfcWindow:      ["window",       "windows"],
  IfcRoof:        ["roof",         "roofs"],
  IfcSpace:       ["space",        "spaces"],
  IfcStair:       ["stair",        "stairs"],
  IfcRamp:        ["ramp",         "ramps"],
  IfcRailing:     ["railing",      "railings"],
  IfcFoundation:  ["foundation",   "foundations"],
  IfcCeiling:     ["ceiling",      "ceilings"],
  IfcCurtainWall: ["curtain wall", "curtain walls"],
  IfcGrid:        ["grid",         "grids"],
  IfcGridLine:    ["grid line",    "grid lines"],
  IfcReferenceLine: ["reference line", "reference lines"],
  IfcLevel:       ["level",        "levels"],
  SdBox:          ["box",          "boxes"],
  SdSphere:       ["sphere",       "spheres"],
  SdCylinder:     ["cylinder",     "cylinders"],
  SdMove:         ["move",         "moves"],
  SdRotate:       ["rotation",     "rotations"],
  SdScale:        ["scale",        "scales"],
};

export function buildDispatchSummary(dispatches: AgentDispatch[], fired: string[], errors: string[] = []): string {
  const counts = new Map<string, number>();
  for (let i = 0; i < dispatches.length; i++) {
    if (!fired[i].endsWith("(err)")) {
      const v = dispatches[i].verb;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const parts: string[] = [...errors];
  if (counts.size > 0) {
    const built = [...counts.entries()].map(([v, n]) => {
      const [sing, plur] = VERB_LABELS[v] ?? [v.toLowerCase(), v.toLowerCase() + "s"];
      return `${n} ${n === 1 ? sing : plur}`;
    });
    parts.push(`Built: ${built.join(", ")}.`);
  }
  return parts.length > 0 ? parts.join(" ") : "Nothing was built.";
}
