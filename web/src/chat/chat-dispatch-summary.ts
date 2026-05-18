import type { AgentDispatch } from "../agent/agent-harness";

// Verbs that perform queries or view operations — never generate a "Built:" line.
const QUERY_VERBS = new Set([
  "SdListObjects", "SdZoomExtents", "SdZoomSelected", "SdSelect", "SdSelectAll",
  "SdDeselect", "SdIsolate", "SdIsolateOff", "SdMeasure", "SdArea", "SdVolume",
  "SdSetViewOrtho", "SdSetViewPerspective", "SdSetCPlane", "SdSetUnits",
  "SdHide", "SdLock", "SdUngroup", "SdGroup",
]);

export const VERB_LABELS: Record<string, [string, string]> = {
  SdWall:          ["wall",           "walls"],
  SdSlab:          ["slab",           "slabs"],
  SdColumn:        ["column",         "columns"],
  SdBeam:          ["beam",           "beams"],
  SdMember:        ["member",         "members"],
  SdDoor:          ["door",           "doors"],
  SdWindow:        ["window",         "windows"],
  SdRoof:          ["roof",           "roofs"],
  SdSpace:         ["space",          "spaces"],
  SdStair:         ["stair",          "stairs"],
  SdRamp:          ["ramp",           "ramps"],
  SdRailing:       ["railing",        "railings"],
  SdFoundation:    ["foundation",     "foundations"],
  SdCeiling:       ["ceiling",        "ceilings"],
  SdCurtainWall:   ["curtain wall",   "curtain walls"],
  SdLevel:         ["level",          "levels"],
  SdRefGrid:       ["grid",           "grids"],
  SdReferenceLine: ["reference line", "reference lines"],
  SdDatum:         ["datum",          "datums"],
  SdBox:           ["box",            "boxes"],
  SdSphere:        ["sphere",         "spheres"],
  SdCylinder:      ["cylinder",       "cylinders"],
  SdCone:          ["cone",           "cones"],
  SdPrism:         ["prism",          "prisms"],
  SdLine:          ["line",           "lines"],
  SdArc:           ["arc",            "arcs"],
  SdCircle:        ["circle",         "circles"],
  SdPolygon:       ["polygon",        "polygons"],
  SdPolyline:      ["polyline",       "polylines"],
  SdRectangle:     ["rectangle",      "rectangles"],
  SdEllipse:       ["ellipse",        "ellipses"],
  SdExtrude:       ["extrusion",      "extrusions"],
  SdRevolve:       ["revolution",     "revolutions"],
  SdSweep:         ["sweep",          "sweeps"],
  SdLoft:          ["loft",           "lofts"],
  SdBooleanUnion:  ["union",          "unions"],
  SdBooleanDifference: ["difference", "differences"],
  SdBooleanIntersection: ["intersection", "intersections"],
  SdMove:          ["move",           "moves"],
  SdRotate:        ["rotation",       "rotations"],
  SdScale:         ["scale",          "scales"],
  SdMirror:        ["mirror",         "mirrors"],
  SdArray:         ["array",          "arrays"],
  SdAnnotationDimension: ["dimension", "dimensions"],
  SdLeader:        ["leader",         "leaders"],
  SdText:          ["text label",     "text labels"],
};

export function buildDispatchSummary(
  dispatches: AgentDispatch[],
  fired: string[],
  errors: string[] = [],
  opts?: { audience?: "user" | "agent" },
): string {
  const counts = new Map<string, number>();
  for (let i = 0; i < dispatches.length; i++) {
    if (!fired[i].endsWith("(err)")) {
      const v = dispatches[i].verb;
      if (!QUERY_VERBS.has(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  // audience:'user' → strip errors from the visible bubble.
  // audience:'agent' (default) → include errors so the model reads its own mistakes
  // on the next turn and can self-correct (required by #271 regression net).
  const parts: string[] = opts?.audience === "user" ? [] : [...errors];
  if (counts.size > 0) {
    const built = [...counts.entries()].map(([v, n]) => {
      const [sing, plur] = VERB_LABELS[v] ?? [v.replace(/^Sd/, "").toLowerCase(), v.replace(/^Sd/, "").toLowerCase() + "s"];
      return `${n} ${n === 1 ? sing : plur}`;
    });
    parts.push(`Built: ${built.join(", ")}.`);
  }
  // Return "Nothing was built." only when dispatches were attempted but all failed/errored.
  const hadAttempts = dispatches.some((_, i) => !QUERY_VERBS.has(dispatches[i].verb));
  return parts.length > 0 ? parts.join(" ") : (hadAttempts && counts.size === 0 ? "Nothing was built." : "");
}
