// starter-clusters.ts — #428: Grasshopper-style built-in starter library.
// Six CanvasClusters seeded to IndexedDB on first SKILL NODES tab open.
// Uses a localStorage sentinel so seeding only runs once per browser profile.

import type { CanvasCluster } from "./skill-store";
import { putCanvasCluster } from "./skill-store";
import type { CanvasNode } from "./skill-canvas";

const SEED_KEY = "gemma-starter-seeded-v1";

function makeCluster(
  id: string,
  name: string,
  description: string,
  skillSteps: { verb: string; args: Record<string, unknown> }[]
): CanvasCluster {
  const node: CanvasNode = {
    id: "node-0",
    kind: "skill",
    skillName: name,
    skillSteps,
    x: 20,
    y: 80,
    inPorts: 0,
    outPorts: 1,
  };
  const graph = { nodes: [node], edges: [], groups: [] };
  return {
    id,
    name,
    description,
    createdAt: 0,
    graphJson: JSON.stringify(graph),
    nodeCount: 1,
    edgeCount: 0,
  };
}

const STARTERS: CanvasCluster[] = [
  makeCluster(
    "__starter__wall-row",
    "Wall Row",
    "4 aligned walls, each 3 m — parametric length + count",
    [
      { verb: "SdWall", args: { start: {x:0,y:0,z:0}, end: {x:3,y:0,z:0}, height: 3.0, thickness: 0.2 } },
      { verb: "SdWall", args: { start: {x:3,y:0,z:0}, end: {x:6,y:0,z:0}, height: 3.0, thickness: 0.2 } },
      { verb: "SdWall", args: { start: {x:6,y:0,z:0}, end: {x:9,y:0,z:0}, height: 3.0, thickness: 0.2 } },
      { verb: "SdWall", args: { start: {x:9,y:0,z:0}, end: {x:12,y:0,z:0}, height: 3.0, thickness: 0.2 } },
    ]
  ),
  makeCluster(
    "__starter__window-array",
    "Window Array",
    "3 windows evenly spaced along a wall",
    [
      { verb: "SdWindow", args: { position: {x:1.0,y:0,z:0}, width: 1.2, height: 1.4, sillH: 0.9 } },
      { verb: "SdWindow", args: { position: {x:3.5,y:0,z:0}, width: 1.2, height: 1.4, sillH: 0.9 } },
      { verb: "SdWindow", args: { position: {x:6.0,y:0,z:0}, width: 1.2, height: 1.4, sillH: 0.9 } },
    ]
  ),
  makeCluster(
    "__starter__room",
    "Room",
    "4 walls forming a 6×4 m rectangle with door",
    [
      { verb: "SdWall", args: { start: {x:0,y:0,z:0}, end: {x:6,y:0,z:0} } },
      { verb: "SdWall", args: { start: {x:6,y:0,z:0}, end: {x:6,y:4,z:0} } },
      { verb: "SdWall", args: { start: {x:6,y:4,z:0}, end: {x:0,y:4,z:0} } },
      { verb: "SdWall", args: { start: {x:0,y:4,z:0}, end: {x:0,y:0,z:0} } },
      { verb: "SdDoor", args: { position: {x:1.5,y:0,z:0}, width: 0.9, height: 2.1 } },
    ]
  ),
  makeCluster(
    "__starter__roof-walls",
    "Roof + Walls",
    "Gable roof over 4 walls — 6×4 m footprint, 30° pitch",
    [
      { verb: "SdWall", args: { start: {x:0,y:0,z:0}, end: {x:6,y:0,z:0} } },
      { verb: "SdWall", args: { start: {x:6,y:0,z:0}, end: {x:6,y:4,z:0} } },
      { verb: "SdWall", args: { start: {x:6,y:4,z:0}, end: {x:0,y:4,z:0} } },
      { verb: "SdWall", args: { start: {x:0,y:4,z:0}, end: {x:0,y:0,z:0} } },
      { verb: "SdRoof", args: { roofType: "pitched", footprint: [[0,0],[6,0],[6,4],[0,4]], pitchDeg: 30 } },
    ]
  ),
  makeCluster(
    "__starter__stair-flight",
    "Stair Flight",
    "Straight stair — 12 risers, 1 m wide",
    [
      { verb: "SdStair", args: { start: {x:0,y:0,z:0}, end: {x:0,y:3.24,z:0}, type: "straight", count: 12, width: 1.0, riser: 0.18, tread: 0.27 } },
    ]
  ),
  makeCluster(
    "__starter__skylight-grid",
    "Skylight Grid",
    "3×2 skylights on a flat roof, 2.5 m spacing",
    [
      { verb: "SdSkylight", args: { position: {x:1.0,y:1.0,z:0}, width: 1.2, depth: 1.2, elevation: 3.0 } },
      { verb: "SdSkylight", args: { position: {x:3.5,y:1.0,z:0}, width: 1.2, depth: 1.2, elevation: 3.0 } },
      { verb: "SdSkylight", args: { position: {x:6.0,y:1.0,z:0}, width: 1.2, depth: 1.2, elevation: 3.0 } },
      { verb: "SdSkylight", args: { position: {x:1.0,y:3.5,z:0}, width: 1.2, depth: 1.2, elevation: 3.0 } },
      { verb: "SdSkylight", args: { position: {x:3.5,y:3.5,z:0}, width: 1.2, depth: 1.2, elevation: 3.0 } },
      { verb: "SdSkylight", args: { position: {x:6.0,y:3.5,z:0}, width: 1.2, depth: 1.2, elevation: 3.0 } },
    ]
  ),
];

export const STARTER_IDS = new Set(STARTERS.map(c => c.id));

export async function seedStarterClusters(): Promise<void> {
  if (typeof localStorage !== "undefined" && localStorage.getItem(SEED_KEY)) return;
  await Promise.all(STARTERS.map(c => putCanvasCluster(c)));
  if (typeof localStorage !== "undefined") localStorage.setItem(SEED_KEY, "1");
}
