/**
 * gen-fzk-glbs.ts — Convert FZK-Haus JSON geometry + synthetic variants to GLB.
 *
 * Usage: bun scripts/gen-fzk-glbs.ts
 * Output:
 *   web/public/assets/architectural/doors/fzk-haus-door-1.glb  (FZK extracted)
 *   web/public/assets/architectural/doors/fzk-haus-door-2.glb  (simplified panel variant)
 *   web/public/assets/architectural/windows/fzk-haus-window-1.glb  (FZK extracted, frame+glass)
 *   web/public/assets/architectural/windows/fzk-haus-window-2.glb  (casement variant)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

interface GroupInfo {
  start:    number;
  count:    number;
  material: "frame" | "glass" | "door" | "panel";
}

interface GeomJson {
  positions: number[];
  normals:   number[];
  indices:   number[];
  colors:    number[];
  groups?:   GroupInfo[];
}

function pad4(n: number): number { return Math.ceil(n / 4) * 4; }

// Minimal GLB 2.0 writer. No external dependency — pure Buffer manipulation.
function buildGlb(geom: GeomJson): Buffer {
  const { positions, normals, colors, indices, groups } = geom;
  const vertCount = positions.length / 3;
  const useU16    = vertCount < 65536;

  // --- Binary buffer layout ---
  const posF32  = Float32Array.from(positions);
  const normF32 = Float32Array.from(normals);
  const colF32  = Float32Array.from(colors);
  const idxArr  = useU16 ? Uint16Array.from(indices) : Uint32Array.from(indices);

  const posOff  = 0;
  const normOff = pad4(posF32.byteLength);
  const colOff  = pad4(normOff + normF32.byteLength);
  const idxOff  = pad4(colOff  + colF32.byteLength);
  const binSize = pad4(idxOff  + idxArr.byteLength);

  const bin = Buffer.alloc(binSize, 0);
  Buffer.from(posF32.buffer).copy(bin, posOff);
  Buffer.from(normF32.buffer).copy(bin, normOff);
  Buffer.from(colF32.buffer).copy(bin, colOff);
  Buffer.from(idxArr.buffer).copy(bin, idxOff);

  // --- GLTF accessors + bufferViews ---
  const ARRAY_BUF  = 34962;
  const ELEM_BUF   = 34963;
  const FLOAT      = 5126;
  const U16        = 5123;
  const U32        = 5125;
  const idxType    = useU16 ? U16 : U32;
  const idxStride  = useU16 ? 2 : 4;

  const bufferViews: unknown[] = [
    { buffer: 0, byteOffset: posOff,  byteLength: posF32.byteLength,  target: ARRAY_BUF },
    { buffer: 0, byteOffset: normOff, byteLength: normF32.byteLength, target: ARRAY_BUF },
    { buffer: 0, byteOffset: colOff,  byteLength: colF32.byteLength,  target: ARRAY_BUF },
    { buffer: 0, byteOffset: idxOff,  byteLength: idxArr.byteLength,  target: ELEM_BUF  },
  ];

  // Position min/max (required by spec)
  let minX =  Infinity, minY =  Infinity, minZ =  Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);   maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i+1]); maxY = Math.max(maxY, positions[i+1]);
    minZ = Math.min(minZ, positions[i+2]); maxZ = Math.max(maxZ, positions[i+2]);
  }

  const accessors: unknown[] = [
    { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: vertCount, type: "VEC3", min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    { bufferView: 1, byteOffset: 0, componentType: FLOAT, count: vertCount, type: "VEC3" },
    { bufferView: 2, byteOffset: 0, componentType: FLOAT, count: vertCount, type: "VEC3" },
  ];

  const materials: unknown[] = [];
  const primitives: unknown[] = [];

  const effectiveGroups: GroupInfo[] = groups && groups.length > 0
    ? groups
    : [{ start: 0, count: indices.length, material: "door" }];

  for (const grp of effectiveGroups) {
    const isGlass = grp.material === "glass";
    const accIdx  = accessors.length;
    accessors.push({
      bufferView: 3,
      byteOffset: grp.start * idxStride,
      componentType: idxType,
      count: grp.count,
      type: "SCALAR",
    });
    const matIdx = materials.length;
    if (isGlass) {
      materials.push({
        name: "glass",
        pbrMetallicRoughness: {
          baseColorFactor: [0.53, 0.67, 0.80, 0.30],
          metallicFactor: 0.0, roughnessFactor: 0.05,
        },
        alphaMode: "BLEND",
      });
    } else if (grp.material === "frame") {
      materials.push({
        name: "frame",
        pbrMetallicRoughness: {
          baseColorFactor: [0.78, 0.72, 0.60, 1.0],
          metallicFactor: 0.0, roughnessFactor: 0.55,
        },
      });
    } else {
      materials.push({
        name: grp.material === "panel" ? "panel" : "door",
        pbrMetallicRoughness: {
          baseColorFactor: [1.0, 1.0, 1.0, 1.0],
          metallicFactor: 0.0, roughnessFactor: 0.55,
        },
        extras: { vertexColors: true },
      });
    }
    primitives.push({
      attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 },
      indices: accIdx,
      material: matIdx,
    });
  }

  const gltf = {
    asset: { version: "2.0", generator: "gemma-cad gen-fzk-glbs" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "opening" }],
    meshes: [{ name: "opening", primitives }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: binSize }],
    materials,
  };

  const jsonBuf    = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPadded = Buffer.alloc(pad4(jsonBuf.length), 0x20); // space-pad
  jsonBuf.copy(jsonPadded);

  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out   = Buffer.alloc(total);
  let off = 0;

  out.writeUInt32LE(0x46546C67, off); off += 4; // magic "glTF"
  out.writeUInt32LE(2,          off); off += 4; // version
  out.writeUInt32LE(total,      off); off += 4; // total length

  out.writeUInt32LE(jsonPadded.length, off); off += 4;
  out.writeUInt32LE(0x4E4F534A,        off); off += 4; // "JSON"
  jsonPadded.copy(out, off); off += jsonPadded.length;

  out.writeUInt32LE(bin.length,  off); off += 4;
  out.writeUInt32LE(0x004E4942, off); off += 4; // "BIN\0"
  bin.copy(out, off);

  return out;
}

// --- Synthetic door variant 2: framed double-panel door ---
// Vertices + normals + colors produced programmatically.
function makeSyntheticDoorV2(): GeomJson {
  const positions: number[] = [];
  const normals:   number[] = [];
  const colors:    number[] = [];
  const indices:   number[] = [];

  function box(
    cx: number, cy: number, cz: number,
    w: number,  d: number,  h: number,
    r: number,  g: number,  b: number,
  ): void {
    const hw = w / 2, hd = d / 2, hh = h / 2;
    const base = positions.length / 3;
    // 8 corners, 6 faces, 2 triangles each = 12 triangles = 36 indices per box
    // We'll use 24 vertices (4 per face for flat normals)
    const faces = [
      // normal, 4 corners (local offset from center)
      [[0,  0,  1], [[-hw,-hd, hh],[ hw,-hd, hh],[ hw, hd, hh],[-hw, hd, hh]]],
      [[0,  0, -1], [[-hw, hd,-hh],[ hw, hd,-hh],[ hw,-hd,-hh],[-hw,-hd,-hh]]],
      [[1,  0,  0], [[ hw,-hd,-hh],[ hw, hd,-hh],[ hw, hd, hh],[ hw,-hd, hh]]],
      [[-1, 0,  0], [[-hw,-hd, hh],[-hw, hd, hh],[-hw, hd,-hh],[-hw,-hd,-hh]]],
      [[0,  1,  0], [[-hw, hd,-hh],[ hw, hd,-hh],[ hw, hd, hh],[-hw, hd, hh]]],
      [[0, -1,  0], [[-hw,-hd, hh],[ hw,-hd, hh],[ hw,-hd,-hh],[-hw,-hd,-hh]]],
    ] as [number[], number[][]][];
    for (const [n, corners] of faces) {
      const vi = positions.length / 3 - base;
      for (const [ox, oy, oz] of corners) {
        positions.push(cx + ox, cy + oy, cz + oz);
        normals.push(...n);
        colors.push(r, g, b);
      }
      indices.push(base + vi, base + vi+1, base + vi+2, base + vi, base + vi+2, base + vi+3);
    }
  }

  // Frame: tan color
  const fr = 0.72, fg_ = 0.64, fb = 0.50;
  // Door is centered at x=0, y=0 (depth), z from 0 (bottom) to 1 (normalized height)
  // We'll produce a normalized unit-cube door (1×0.2×1) for the IFC convention
  // Actual scaling happens in openings.ts
  box(0,    0, 0.5,  1.00, 0.05, 0.04, fr, fg_, fb); // top rail
  box(0,    0, 0.02, 1.00, 0.05, 0.04, fr, fg_, fb); // bottom rail
  box(-0.47, 0, 0.5, 0.06, 0.05, 1.00, fr, fg_, fb); // left stile
  box( 0.47, 0, 0.5, 0.06, 0.05, 1.00, fr, fg_, fb); // right stile
  box(0,     0, 0.5, 0.06, 0.05, 1.00, fr, fg_, fb); // center divider (double-door)
  // Panels: lighter tan
  const pr = 0.82, pg = 0.76, pb = 0.62;
  box(-0.24, 0, 0.75, 0.36, 0.04, 0.44, pr, pg, pb); // upper-left panel
  box( 0.24, 0, 0.75, 0.36, 0.04, 0.44, pr, pg, pb); // upper-right panel
  box(-0.24, 0, 0.28, 0.36, 0.04, 0.44, pr, pg, pb); // lower-left panel
  box( 0.24, 0, 0.28, 0.36, 0.04, 0.44, pr, pg, pb); // lower-right panel

  return { positions, normals, indices, colors };
}

// --- Synthetic window variant 2: casement window (single pane, side-hinged) ---
function makeSyntheticWindowV2(): GeomJson {
  const positions: number[] = [];
  const normals:   number[] = [];
  const colors:    number[] = [];
  const indices:   number[] = [];
  const groups: GroupInfo[] = [];

  function box(
    cx: number, cy: number, cz: number,
    w: number,  d: number,  h: number,
    r: number,  g: number,  b: number,
  ): void {
    const hw = w / 2, hd = d / 2, hh = h / 2;
    const faces = [
      [[0,0,1],[[-hw,-hd,hh],[hw,-hd,hh],[hw,hd,hh],[-hw,hd,hh]]],
      [[0,0,-1],[[-hw,hd,-hh],[hw,hd,-hh],[hw,-hd,-hh],[-hw,-hd,-hh]]],
      [[1,0,0],[[hw,-hd,-hh],[hw,hd,-hh],[hw,hd,hh],[hw,-hd,hh]]],
      [[-1,0,0],[[-hw,-hd,hh],[-hw,hd,hh],[-hw,hd,-hh],[-hw,-hd,-hh]]],
      [[0,1,0],[[-hw,hd,-hh],[hw,hd,-hh],[hw,hd,hh],[-hw,hd,hh]]],
      [[0,-1,0],[[-hw,-hd,hh],[hw,-hd,hh],[hw,-hd,-hh],[-hw,-hd,-hh]]],
    ] as [number[], number[][]][];
    const base = positions.length / 3;
    for (const [n, corners] of faces) {
      const vi = positions.length / 3 - base;
      for (const [ox, oy, oz] of corners) {
        positions.push(cx + ox, cy + oy, cz + oz);
        normals.push(...n);
        colors.push(r, g, b);
      }
      indices.push(base + vi, base + vi+1, base + vi+2, base + vi, base + vi+2, base + vi+3);
    }
  }

  // Frame
  const startFrame = indices.length;
  const fr = 0.35, fg_ = 0.35, fb = 0.35; // dark grey frame
  box(0,     0, 0.5,  1.00, 0.05, 0.04, fr, fg_, fb); // top
  box(0,     0, 0.02, 1.00, 0.05, 0.04, fr, fg_, fb); // bottom
  box(-0.48, 0, 0.5,  0.04, 0.05, 1.00, fr, fg_, fb); // left
  box( 0.48, 0, 0.5,  0.04, 0.05, 1.00, fr, fg_, fb); // right
  groups.push({ start: startFrame, count: indices.length - startFrame, material: "frame" });

  // Glass (single pane)
  const startGlass = indices.length;
  const gr = 0.53, gg = 0.67, gb = 0.80;
  box(0, 0, 0.5, 0.90, 0.02, 0.90, gr, gg, gb);
  groups.push({ start: startGlass, count: indices.length - startGlass, material: "glass" });

  return { positions, normals, indices, colors, groups };
}

async function main() {
  const doorDir   = path.resolve("web/public/assets/architectural/doors");
  const windowDir = path.resolve("web/public/assets/architectural/windows");
  await mkdir(doorDir,   { recursive: true });
  await mkdir(windowDir, { recursive: true });

  // Door variant 1: convert existing FZK JSON → GLB
  const doorJsonPath = path.resolve("web/public/samples/fzk-door-geom.json");
  const doorJson: GeomJson = JSON.parse(await readFile(doorJsonPath, "utf8"));
  const door1 = buildGlb(doorJson);
  await writeFile(path.join(doorDir, "fzk-haus-door-1.glb"), door1);
  console.log(`door-1: ${door1.length} bytes`);

  // Door variant 2: synthetic double-panel door → GLB
  const door2 = buildGlb(makeSyntheticDoorV2());
  await writeFile(path.join(doorDir, "fzk-haus-door-2.glb"), door2);
  console.log(`door-2: ${door2.length} bytes`);

  // Window variant 1: convert existing FZK JSON (frame+glass groups) → GLB
  const winJsonPath = path.resolve("web/public/samples/fzk-window-geom.json");
  const winJson: GeomJson = JSON.parse(await readFile(winJsonPath, "utf8"));
  const win1 = buildGlb(winJson);
  await writeFile(path.join(windowDir, "fzk-haus-window-1.glb"), win1);
  console.log(`window-1: ${win1.length} bytes`);

  // Window variant 2: synthetic casement window → GLB
  const win2 = buildGlb(makeSyntheticWindowV2());
  await writeFile(path.join(windowDir, "fzk-haus-window-2.glb"), win2);
  console.log(`window-2: ${win2.length} bytes`);

  console.log("done");
}

main().catch(console.error);
