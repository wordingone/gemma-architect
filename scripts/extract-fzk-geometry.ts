/**
 * extract-fzk-geometry.ts — Extract IFCDOOR + IFCWINDOW geometry from FZK-Haus IFC.
 *
 * Usage: bun scripts/extract-fzk-geometry.ts
 * Output:
 *   web/public/samples/fzk-door-geom.json
 *   web/public/samples/fzk-window-geom.json
 *
 * Each JSON: { positions, normals, indices, colors, groups? }
 * Window JSON includes groups: [{start, count, material:"frame"|"glass"}]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const IFCDOOR   = 395920057;
const IFCWINDOW = 3304561284;

interface GroupInfo {
  start:    number;
  count:    number;
  material: "frame" | "glass";
}

interface GeomOut {
  positions: number[];
  normals:   number[];
  indices:   number[];
  colors:    number[];
  groups?:   GroupInfo[];
}

function centerGeom(out: GeomOut): void {
  if (out.positions.length === 0) return;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < out.positions.length; i += 3) {
    const x = out.positions[i], y = out.positions[i+1], z = out.positions[i+2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (let i = 0; i < out.positions.length; i += 3) {
    out.positions[i]   -= cx;
    out.positions[i+1] -= cy;
    out.positions[i+2] -= minZ;
  }
  console.log(`  bbox: [${(maxX-minX).toFixed(3)}, ${(maxY-minY).toFixed(3)}, ${(maxZ-minZ).toFixed(3)}] m`);
}

// Extract door using max-vertex heuristic (one canonical instance is sufficient)
async function extractDoorGeom(api: any, modelID: number): Promise<GeomOut | null> {
  let lineIDs: any;
  try { lineIDs = api.GetLineIDsWithType(modelID, IFCDOOR); }
  catch { console.warn("[geom] IfcDoor: GetLineIDsWithType failed"); return null; }
  const count = lineIDs.size();
  console.log(`[geom] IfcDoor: ${count} instances`);
  if (count === 0) return null;

  const ids: number[] = [];
  for (let i = 0; i < Math.min(count, 20); i++) ids.push(lineIDs.get(i));

  let bestOut: GeomOut | null = null;
  let bestVertCount = 0;

  api.StreamMeshes(modelID, ids, (flatMesh: any) => {
    const nGeoms = flatMesh.geometries.size();
    if (nGeoms === 0) return;
    const out: GeomOut = { positions: [], normals: [], indices: [], colors: [] };
    let vOff = 0;
    for (let g = 0; g < nGeoms; g++) {
      const placed = flatMesh.geometries.get(g);
      const geom   = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts  = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx    = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m      = placed.flatTransformation as unknown as number[];
      const r      = placed.color?.x ?? 0.7;
      const gCol   = placed.color?.y ?? 0.7;
      const b      = placed.color?.z ?? 0.7;
      for (let v = 0; v < verts.length; v += 6) {
        const lx = verts[v], ly = verts[v+1], lz = verts[v+2];
        const lnx = verts[v+3], lny = verts[v+4], lnz = verts[v+5];
        out.positions.push(m[0]*lx + m[4]*ly + m[8]*lz  + m[12],
                           m[1]*lx + m[5]*ly + m[9]*lz  + m[13],
                           m[2]*lx + m[6]*ly + m[10]*lz + m[14]);
        out.normals.push(m[0]*lnx + m[4]*lny + m[8]*lnz,
                         m[1]*lnx + m[5]*lny + m[9]*lnz,
                         m[2]*lnx + m[6]*lny + m[10]*lnz);
        out.colors.push(r, gCol, b);
      }
      for (let k = 0; k < idx.length; k++) out.indices.push(idx[k] + vOff);
      vOff += verts.length / 6;
      geom.delete();
    }
    const vc = out.positions.length / 3;
    console.log(`  expressID=${flatMesh.expressID}: ${vc} verts, ${out.indices.length/3} tris`);
    if (vc > bestVertCount) { bestVertCount = vc; bestOut = out; }
  });

  if (!bestOut) { console.warn("[geom] IfcDoor: no geometry"); return null; }
  const result = bestOut as GeomOut;
  centerGeom(result);
  result.positions = result.positions.map((v: number) => Math.round(v * 1e5) / 1e5);
  result.normals   = result.normals.map((v: number) => Math.round(v * 1e5) / 1e5);
  return result;
}

// Extract window using modal-cluster selection + frame/glass split.
// Prior heuristic (max-vertex) picked the circular ornamental window (#885).
// Modal cluster picks the instance whose bounding-box dims appear most often
// across all IfcWindow instances — that's the standard rectangular two-pane.
async function extractWindowGeom(api: any, modelID: number): Promise<GeomOut | null> {
  let lineIDs: any;
  try { lineIDs = api.GetLineIDsWithType(modelID, IFCWINDOW); }
  catch { console.warn("[geom] IfcWindow: GetLineIDsWithType failed"); return null; }
  const count = lineIDs.size();
  console.log(`[geom] IfcWindow: ${count} instances`);
  if (count === 0) return null;

  const allIds: number[] = [];
  for (let i = 0; i < count; i++) allIds.push(lineIDs.get(i));

  // Pass 1: compute world-space bbox for every instance → cluster by face dims
  const bboxByID = new Map<number, { dim0: number; dim1: number }>();
  api.StreamMeshes(modelID, allIds, (flatMesh: any) => {
    const nGeoms = flatMesh.geometries.size();
    if (nGeoms === 0) return;
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let g = 0; g < nGeoms; g++) {
      const placed = flatMesh.geometries.get(g);
      const geom   = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts  = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const m      = placed.flatTransformation as unknown as number[];
      for (let v = 0; v < verts.length; v += 6) {
        const lx = verts[v], ly = verts[v+1], lz = verts[v+2];
        const wx = m[0]*lx + m[4]*ly + m[8]*lz  + m[12];
        const wy = m[1]*lx + m[5]*ly + m[9]*lz  + m[13];
        const wz = m[2]*lx + m[6]*ly + m[10]*lz + m[14];
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
      geom.delete();
    }
    if (minX === Infinity) return;
    // Sort dims descending; two largest = face, smallest = depth/thickness
    const dims = [maxX-minX, maxY-minY, maxZ-minZ].sort((a, b) => b - a);
    bboxByID.set(flatMesh.expressID, { dim0: dims[0], dim1: dims[1] });
  });

  console.log(`  bbox pass: ${bboxByID.size} instances measured`);

  // Cluster by (dim0.toFixed(1) x dim1.toFixed(1)) — 10cm resolution
  const clusters = new Map<string, number[]>();
  for (const [id, { dim0, dim1 }] of bboxByID) {
    const key = `${dim0.toFixed(1)}x${dim1.toFixed(1)}`;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(id);
  }

  let modalKey = "";
  let modalCount = 0;
  for (const [key, ids] of clusters) {
    console.log(`  cluster ${key}: ${ids.length} instances`);
    if (ids.length > modalCount) { modalCount = ids.length; modalKey = key; }
  }

  if (!modalKey) { console.warn("[geom] IfcWindow: no clusters found"); return null; }
  const representativeID = clusters.get(modalKey)![0];
  console.log(`  modal cluster: ${modalKey} (${modalCount} instances) — using expressID=${representativeID}`);

  // Pass 2: extract representative, split geometries into frame vs glass
  // Glass detection: placed.color.w (alpha) < 0.8 indicates transparent/glazing material
  const frameVerts: number[] = [], frameNorms: number[] = [], frameColors: number[] = [], frameIdx: number[] = [];
  const glassVerts: number[] = [], glassNorms: number[] = [], glassColors: number[] = [], glassIdx: number[] = [];

  api.StreamMeshes(modelID, [representativeID], (flatMesh: any) => {
    const nGeoms = flatMesh.geometries.size();
    for (let g = 0; g < nGeoms; g++) {
      const placed = flatMesh.geometries.get(g);
      const geom   = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts  = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx    = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m      = placed.flatTransformation as unknown as number[];
      const r      = placed.color?.x ?? 0.7;
      const gCol   = placed.color?.y ?? 0.7;
      const b      = placed.color?.z ?? 0.7;
      const a      = placed.color?.w ?? 1.0;
      const isGlass = a < 0.8;

      const tverts  = isGlass ? glassVerts  : frameVerts;
      const tnorms  = isGlass ? glassNorms  : frameNorms;
      const tcolors = isGlass ? glassColors : frameColors;
      const tidx    = isGlass ? glassIdx    : frameIdx;
      const vOffset = tverts.length / 3;

      for (let v = 0; v < verts.length; v += 6) {
        const lx = verts[v], ly = verts[v+1], lz = verts[v+2];
        const lnx = verts[v+3], lny = verts[v+4], lnz = verts[v+5];
        tverts.push(m[0]*lx + m[4]*ly + m[8]*lz  + m[12],
                    m[1]*lx + m[5]*ly + m[9]*lz  + m[13],
                    m[2]*lx + m[6]*ly + m[10]*lz + m[14]);
        tnorms.push(m[0]*lnx + m[4]*lny + m[8]*lnz,
                    m[1]*lnx + m[5]*lny + m[9]*lnz,
                    m[2]*lnx + m[6]*lny + m[10]*lnz);
        tcolors.push(r, gCol, b);
      }
      for (let k = 0; k < idx.length; k++) tidx.push(idx[k] + vOffset);
      geom.delete();
    }
  });

  // Combine: frame first (index group 0), glass second (index group 1)
  const out: GeomOut = { positions: [], normals: [], indices: [], colors: [], groups: [] };
  const frameVertCount = frameVerts.length / 3;

  for (const v of frameVerts)  out.positions.push(v);
  for (const n of frameNorms)  out.normals.push(n);
  for (const c of frameColors) out.colors.push(c);
  for (const i of frameIdx)    out.indices.push(i);
  if (frameIdx.length > 0)
    out.groups!.push({ start: 0, count: frameIdx.length, material: "frame" });

  for (const v of glassVerts)  out.positions.push(v);
  for (const n of glassNorms)  out.normals.push(n);
  for (const c of glassColors) out.colors.push(c);
  for (const i of glassIdx)    out.indices.push(i + frameVertCount);
  if (glassIdx.length > 0)
    out.groups!.push({ start: frameIdx.length, count: glassIdx.length, material: "glass" });

  if (out.positions.length === 0) {
    console.warn("[geom] IfcWindow: no geometry for modal representative");
    return null;
  }

  const fg = out.groups!.find(g => g.material === "frame");
  const gg = out.groups!.find(g => g.material === "glass");
  console.log(`  frame: ${fg?.count ?? 0} indices (${frameVerts.length/3} verts), glass: ${gg?.count ?? 0} indices (${glassVerts.length/3} verts)`);

  centerGeom(out);
  out.positions = out.positions.map((v: number) => Math.round(v * 1e5) / 1e5);
  out.normals   = out.normals.map((v: number) => Math.round(v * 1e5) / 1e5);
  return out;
}

async function main() {
  const ifcPath = path.resolve("web/public/samples/AC20-FZK-Haus.ifc");
  const { IfcAPI } = await import("web-ifc");
  const api = new IfcAPI();
  await api.Init();

  const buf = await readFile(ifcPath);
  const modelID = api.OpenModel(new Uint8Array(buf), { COORDINATE_TO_ORIGIN: true });
  console.log(`[geom] opened model ${modelID}`);

  console.log("[geom] loading geometry (may take a moment)...");
  api.LoadAllGeometry(modelID);
  console.log("[geom] geometry loaded");

  const doorGeom   = await extractDoorGeom(api, modelID);
  const windowGeom = await extractWindowGeom(api, modelID);

  const outDir = path.resolve("web/public/samples");

  if (doorGeom) {
    const doorPath = path.join(outDir, "fzk-door-geom.json");
    await writeFile(doorPath, JSON.stringify(doorGeom));
    console.log(`[geom] wrote ${doorPath} (${(JSON.stringify(doorGeom).length / 1024).toFixed(1)} KB)`);
  }

  if (windowGeom) {
    const winPath = path.join(outDir, "fzk-window-geom.json");
    await writeFile(winPath, JSON.stringify(windowGeom));
    console.log(`[geom] wrote ${winPath} (${(JSON.stringify(windowGeom).length / 1024).toFixed(1)} KB)`);
  }

  api.CloseModel(modelID);
  console.log("[geom] done");
}

main().catch(console.error);
