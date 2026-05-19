// starter-library.ts — #1113/SU-6: Grasshopper-style single-node starter definitions.
// Each StarterNodeDef maps to one CanvasNode with a single dispatch verb + default args.
// These appear in the canvas palette AND in the right-click "Add starter node" submenu.

export type StarterNodeDef = {
  id: string;
  category: "Levels" | "Walls" | "Operations" | "Boolean";
  label: string;
  description: string;
  verb: string;
  args: Record<string, unknown>;
  inPorts: number;
  outPorts: number;
};

export const STARTER_LIBRARY: StarterNodeDef[] = [
  {
    id: "sl-build-level",
    category: "Levels",
    label: "BuildLevel",
    description: "SdLevel — elevation + height + name → level datum",
    verb: "SdLevel",
    args: { elevation: 0.0, height: 3.0, name: "Level 1" },
    inPorts: 0,
    outPorts: 1,
  },
  {
    id: "sl-build-wall",
    category: "Walls",
    label: "BuildWall",
    description: "SdWall — start/end + height + thickness",
    verb: "SdWall",
    args: { start: { x: 0, y: 0, z: 0 }, end: { x: 4, y: 0, z: 0 }, height: 3.0, thickness: 0.2 },
    inPorts: 1,
    outPorts: 1,
  },
  {
    id: "sl-array-object",
    category: "Operations",
    label: "ArrayObject",
    description: "SdArrayLinear — count + dx/dy/dz offset",
    verb: "SdArrayLinear",
    args: { count: 3, dx: 1.0, dy: 0, dz: 0 },
    inPorts: 1,
    outPorts: 1,
  },
  {
    id: "sl-mirror-axis",
    category: "Operations",
    label: "MirrorAcrossAxis",
    description: "SdMirror — target across plane (XZ default)",
    verb: "SdMirror",
    args: { plane: "XZ" },
    inPorts: 1,
    outPorts: 1,
  },
  {
    id: "sl-boolean-diff",
    category: "Boolean",
    label: "BooleanDifference",
    description: "SdBooleanDifference — outer minus inner (2 inputs)",
    verb: "SdBooleanDifference",
    args: {},
    inPorts: 2,
    outPorts: 1,
  },
];

export const STARTER_LIB_CATEGORIES = ["Levels", "Walls", "Operations", "Boolean"] as const;
export type StarterLibCategory = typeof STARTER_LIB_CATEGORIES[number];

export const STARTER_LIB_IDS = new Set(STARTER_LIBRARY.map(d => d.id));
