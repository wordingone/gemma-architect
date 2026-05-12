// Demo (prompt, JS) pairs.
//
// Items 1-8 are picked from the cad-lora-v2-4b-it eval set
// (40-row held-out, 100% runtime_pass). All verified parse_ok + api_clean
// + has_solid_op + runtime_pass on the live tier1 surface.
//   row  2 — slab with hole       → Boolean cut
//   row  5 — raised slab          → translate
//   row  7 — circular column      → drawCircle + extrude
//   row 15 — wall                 → drawRectangle + extrude
//   row 20 — four-walled room     → multi-fuse
//   row 22 — stair-step           → multi-fuse + translate
//   row 23 — L-shape walls        → fuse
//   row 33 — wall with doorway    → cut
//
// Item 9 is the Schultz Residence multi-element compound — 14 consts,
// fuses + cuts across slab/walls/door/window/columns/roof. Sourced from
// data/schultz-target.jsonl (the canonical first-target eval row); this is
// the architectural target the LoRA is being trained to produce. Current
// 4b-it pred achieves 12 of 14 consts (door/window emitted as floating
// boxes instead of cuts — see docs/closed-loop-cad-test-report.md). When
// the LoRA closes the gap this entry can be regenerated from its output.

export type Param = {
  name: string;        // identifier in the JS source to substitute
  label: string;       // UI label
  min: number;
  max: number;
  step: number;
  default: number;
};

export type DemoPrompt = {
  id: string;
  label: string;       // dropdown text
  prompt: string;      // natural-language ask (read-only display)
  js: string;          // model output — directly executable against tier1
  params?: Param[];    // optional sliders that re-execute on change
};

export const DEMOS: DemoPrompt[] = [
  {
    id: "wall",
    label: "1. Wall (5.5m × 0.2m × 2.8m)",
    prompt: "Build a wall, 5.5m long, 0.2m thick, 2.8m tall.",
    js: `const e0 = drawRectangle(LENGTH, THICKNESS).sketchOnPlane("XY").extrude(HEIGHT);`,
    params: [
      { name: "LENGTH",    label: "length (m)",    min: 1,    max: 12, step: 0.1,  default: 5.5 },
      { name: "THICKNESS", label: "thickness (m)", min: 0.1,  max: 0.6, step: 0.01, default: 0.2 },
      { name: "HEIGHT",    label: "height (m)",    min: 1.5,  max: 5,  step: 0.05, default: 2.8 },
    ],
  },
  {
    id: "column",
    label: "2. Circular column (r=0.45m, h=5m)",
    prompt: "A circular column with 0.45m radius and 5m height.",
    js: `const column = drawCircle(RADIUS).sketchOnPlane("XY").extrude(HEIGHT);`,
    params: [
      { name: "RADIUS", label: "radius (m)", min: 0.1, max: 1.5, step: 0.01, default: 0.45 },
      { name: "HEIGHT", label: "height (m)", min: 1,   max: 10,  step: 0.1,  default: 5 },
    ],
  },
  {
    id: "raised-slab",
    label: "3. Raised slab (5×4m × 0.2m, +3m)",
    prompt: "Place a 5 by 4m floor slab, 0.2m thick, raised 3m above ground.",
    js: `const slab = drawRectangle(LENGTH, WIDTH).sketchOnPlane("XY").extrude(THICKNESS).translate([0, 0, ELEVATION]);`,
    params: [
      { name: "LENGTH",    label: "length (m)",    min: 1,    max: 12, step: 0.1,  default: 5 },
      { name: "WIDTH",     label: "width (m)",     min: 1,    max: 12, step: 0.1,  default: 4 },
      { name: "THICKNESS", label: "thickness (m)", min: 0.1,  max: 0.5, step: 0.01, default: 0.2 },
      { name: "ELEVATION", label: "elevation (m)", min: 0,    max: 6,  step: 0.1,  default: 3 },
    ],
  },
  {
    id: "slab-with-hole",
    label: "4. Slab with stair hole (cut)",
    prompt: "Slab 6×6m × 0.2m thick with a 1×1m square hole at (2.5, 2.5).",
    js: `const slab = drawRectangle(SIZE, SIZE).sketchOnPlane("XY").extrude(THICKNESS);
const hole = drawRectangle(HOLE, HOLE).sketchOnPlane("XY").extrude(THICKNESS).translate([HOLE_X, HOLE_Y, 0]);
const result = slab.cut(hole);`,
    params: [
      { name: "SIZE",      label: "slab size (m)",  min: 3,    max: 10, step: 0.1, default: 6 },
      { name: "THICKNESS", label: "thickness (m)",  min: 0.1,  max: 0.5, step: 0.01, default: 0.2 },
      { name: "HOLE",      label: "hole size (m)",  min: 0.5,  max: 3,  step: 0.05, default: 1 },
      { name: "HOLE_X",    label: "hole x (m)",     min: 0,    max: 6,  step: 0.05, default: 2.5 },
      { name: "HOLE_Y",    label: "hole y (m)",     min: 0,    max: 6,  step: 0.05, default: 2.5 },
    ],
  },
  {
    id: "wall-with-door",
    label: "5. Wall with doorway (cut)",
    prompt: "Wall 4.13×0.28×2.69m with a 1.01m × 2.1m doorway 1.77m from the left.",
    js: `const wall = drawRectangle(WALL_L, WALL_T).sketchOnPlane("XY").extrude(WALL_H);
const opening = drawRectangle(DOOR_W, WALL_T).sketchOnPlane("XY").extrude(DOOR_H).translate([DOOR_OFFSET, 0, 0]);
const result = wall.cut(opening);`,
    params: [
      { name: "WALL_L",      label: "wall length (m)",   min: 2,   max: 8,   step: 0.05, default: 4.13 },
      { name: "WALL_T",      label: "wall thickness (m)",min: 0.1, max: 0.5, step: 0.01, default: 0.28 },
      { name: "WALL_H",      label: "wall height (m)",   min: 2,   max: 4,   step: 0.05, default: 2.69 },
      { name: "DOOR_W",      label: "door width (m)",    min: 0.6, max: 2,   step: 0.01, default: 1.01 },
      { name: "DOOR_H",      label: "door height (m)",   min: 1.8, max: 2.5, step: 0.01, default: 2.1 },
      { name: "DOOR_OFFSET", label: "door offset (m)",   min: 0.1, max: 6,   step: 0.05, default: 1.77 },
    ],
  },
  {
    id: "l-walls",
    label: "6. L-shape walls (fuse)",
    prompt: "Two walls forming an L: 8.45m and 9.25m, both 0.31m thick and 3.35m tall.",
    js: `const wallX = drawRectangle(LEN_X, THICKNESS).sketchOnPlane("XY").extrude(HEIGHT).translate([LEN_X / 2, THICKNESS / 2, 0]);
const wallY = drawRectangle(THICKNESS, LEN_Y).sketchOnPlane("XY").extrude(HEIGHT).translate([THICKNESS / 2, LEN_Y / 2, 0]);
const corner = wallX.fuse(wallY);`,
    params: [
      { name: "LEN_X",     label: "length X (m)",    min: 2,   max: 15, step: 0.05, default: 8.45 },
      { name: "LEN_Y",     label: "length Y (m)",    min: 2,   max: 15, step: 0.05, default: 9.25 },
      { name: "THICKNESS", label: "thickness (m)",   min: 0.1, max: 0.5, step: 0.01, default: 0.31 },
      { name: "HEIGHT",    label: "height (m)",      min: 2,   max: 5,  step: 0.05, default: 3.35 },
    ],
  },
  {
    id: "four-walled-room",
    label: "7. Four-walled room (multi-fuse)",
    prompt: "Four-walled room 9.12m × 9.34m, 0.24m thick walls, 3.06m tall.",
    js: `const front = drawRectangle(L, T).sketchOnPlane("XY").extrude(H).translate([0, -(W - T) / 2, 0]);
const back  = drawRectangle(L, T).sketchOnPlane("XY").extrude(H).translate([0,  (W - T) / 2, 0]);
const left  = drawRectangle(T, W - 2 * T).sketchOnPlane("XY").extrude(H).translate([-(L - T) / 2, 0, 0]);
const right = drawRectangle(T, W - 2 * T).sketchOnPlane("XY").extrude(H).translate([ (L - T) / 2, 0, 0]);
const room = front.fuse(back).fuse(left).fuse(right);`,
    params: [
      { name: "L", label: "length X (m)",       min: 3,   max: 15, step: 0.05, default: 9.12 },
      { name: "W", label: "width Y (m)",        min: 3,   max: 15, step: 0.05, default: 9.34 },
      { name: "T", label: "wall thickness (m)", min: 0.1, max: 0.5, step: 0.01, default: 0.24 },
      { name: "H", label: "wall height (m)",    min: 2,   max: 5,  step: 0.05, default: 3.06 },
    ],
  },
  {
    id: "stair-step",
    label: "8. Stair-step (4 risers, multi-fuse)",
    prompt: "Stair-step structure with 4 steps, run 0.39m, rise 0.21m, 2.77m wide.",
    js: `const s0 = drawRectangle(RUN, WIDTH).sketchOnPlane("XY").extrude(RISE);
const s1 = drawRectangle(RUN, WIDTH).sketchOnPlane("XY").extrude(RISE * 2).translate([RUN, 0, 0]);
const s2 = drawRectangle(RUN, WIDTH).sketchOnPlane("XY").extrude(RISE * 3).translate([RUN * 2, 0, 0]);
const s3 = drawRectangle(RUN, WIDTH).sketchOnPlane("XY").extrude(RISE * 4).translate([RUN * 3, 0, 0]);
const stairs = s0.fuse(s1).fuse(s2).fuse(s3);`,
    params: [
      { name: "RUN",   label: "run / step (m)", min: 0.2, max: 0.6, step: 0.01, default: 0.39 },
      { name: "RISE",  label: "rise / step (m)", min: 0.1, max: 0.3, step: 0.01, default: 0.21 },
      { name: "WIDTH", label: "stair width (m)", min: 0.8, max: 4,   step: 0.05, default: 2.77 },
    ],
  },
  {
    id: "schultz-residence",
    label: "9. Schultz Residence (14-component compound — multi-fuse + cuts)",
    prompt: "Build a single-story residence in the style of the Schultz Residence: rectangular 12m by 8m footprint, 0.2m floor slab, four perimeter exterior walls 2.8m tall and 0.2m thick, one interior partition splitting the plan east-west at x=7m (0.15m thick, full height), two square columns 0.3m by 0.3m at the front corners, a 1m by 2.1m doorway in the south wall centered on the front entry (4m from the west edge), a 2m by 1.4m window in the north wall centered (6m from the west edge), and a flat roof slab 0.2m thick at z=2.8m. Fuse all walls and slabs into a single composite.",
    js: `const slabFloor = drawRectangle(12, 8).sketchOnPlane("XY").extrude(0.2).translate([6, 4, -0.2]);
const slabRoof = drawRectangle(12, 8).sketchOnPlane("XY").extrude(0.2).translate([6, 4, 2.8]);
const wallSouth = drawRectangle(12, 0.2).sketchOnPlane("XY").extrude(2.8).translate([6, 0.1, 0]);
const doorCut = drawRectangle(1, 0.2).sketchOnPlane("XY").extrude(2.1).translate([4, 0.1, 0]);
const wallSouthCut = wallSouth.cut(doorCut);
const wallNorth = drawRectangle(12, 0.2).sketchOnPlane("XY").extrude(2.8).translate([6, 7.9, 0]);
const windowCut = drawRectangle(2, 0.2).sketchOnPlane("XY").extrude(1.4).translate([6, 7.9, 0.9]);
const wallNorthCut = wallNorth.cut(windowCut);
const wallWest = drawRectangle(0.2, 7.6).sketchOnPlane("XY").extrude(2.8).translate([0.1, 4, 0]);
const wallEast = drawRectangle(0.2, 7.6).sketchOnPlane("XY").extrude(2.8).translate([11.9, 4, 0]);
const partition = drawRectangle(0.15, 7.6).sketchOnPlane("XY").extrude(2.8).translate([7, 4, 0]);
const columnSW = drawRectangle(0.3, 0.3).sketchOnPlane("XY").extrude(2.8).translate([0.5, 0.5, 0]);
const columnSE = drawRectangle(0.3, 0.3).sketchOnPlane("XY").extrude(2.8).translate([11.5, 0.5, 0]);
const residence = slabFloor.fuse(slabRoof).fuse(wallSouthCut).fuse(wallNorthCut).fuse(wallWest).fuse(wallEast).fuse(partition).fuse(columnSW).fuse(columnSE);`,
  },
];

// Substitute tokens in the JS source with current slider values. Uses
// word-boundary regex so e.g. RUN doesn't match RUNS or LRUN.
export function applyParams(js: string, values: Record<string, number>): string {
  let out = js;
  for (const [name, value] of Object.entries(values)) {
    const re = new RegExp(`\\b${name}\\b`, "g");
    out = out.replace(re, value.toString());
  }
  return out;
}
