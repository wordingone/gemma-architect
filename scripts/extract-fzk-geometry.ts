/**
 * extract-fzk-geometry.ts — Extract IFCDOOR + IFCWINDOW geometry from FZK-Haus IFC.
 *
 * Usage: bun scripts/extract-fzk-geometry.ts
 * Output:
 *   web/public/samples/fzk-door-geom.json
 *   web/public/samples/fzk-window-geom.json
 *
 * Each JSON: { positions: number[], normals: number[], indices: number[], colors: number[] }
 * Positions/normals are flat arrays. Geometry is centered at origin, bottom at z=0.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const IFCDOOR   = 395920057;
const IFCWINDOW = 3304561284;

interface GeomOut {
  positions: number[];
  normals:   number[];
  indices:   number[];
  colors:    number[];
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
  // Leave z: shift so bottom is at z=0
  for (let i = 0; i < out.positions.length; i += 3) {
    out.positions[i]   -= cx;
    out.positions[i+1] -= cy;
    out.positions[i+2] -= minZ;
  }
  console.log(`  bbox: [${(maxX-minX).toFixed(3)}, ${(maxY-minY).toFixed(3)}, ${(maxZ-minZ).toFixed(3)}] m`);
}

async function extractGeomForType(
  api: any,
  modelID: number,
  typeCode: number,
  typeName: string,
): Promise<GeomOut | null> {
  let lineIDs: any;
  try {
    lineIDs = api.GetLineIDsWithType(modelID, typeCode);
  } catch {
    console.warn(`[geom] ${typeName}: GetLineIDsWithType failed`);
    return null;
  }
  const count = lineIDs.size();
  console.log(`[geom] ${typeName}: ${count} instances`);
  if (count === 0) return null;

  // Collect express IDs to stream
  const ids: number[] = [];
  for (let i = 0; i < Math.min(count, 20); i++) {
    ids.push(lineIDs.get(i));
  }

  // Use StreamMeshes to get geometry for these IDs
  let bestOut: GeomOut | null = null;
  let bestVertCount = 0;

  api.StreamMeshes(modelID, ids, (flatMesh: any) => {
    const nGeoms = flatMesh.geometries.size();
    if (nGeoms === 0) return;

    const out: GeomOut = { positions: [], normals: [], indices: [], colors: [] };
    let vertexOffset = 0;

    for (let g = 0; g < nGeoms; g++) {
      const placed = flatMesh.geometries.get(g);
      const geom = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx   = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());

      const m = placed.flatTransformation as unknown as number[];
      const r = placed.color?.x ?? 0.7;
      const gcol = placed.color?.y ?? 0.7;
      const b = placed.color?.z ?? 0.7;

      for (let v = 0; v < verts.length; v += 6) {
        const lx = verts[v], ly = verts[v+1], lz = verts[v+2];
        const lnx = verts[v+3], lny = verts[v+4], lnz = verts[v+5];
        // Apply 4×4 column-major transform (web-ifc convention)
        const wx  = m[0]*lx + m[4]*ly + m[8]*lz  + m[12];
        const wy  = m[1]*lx + m[5]*ly + m[9]*lz  + m[13];
        const wz  = m[2]*lx + m[6]*ly + m[10]*lz + m[14];
        const wnx = m[0]*lnx + m[4]*lny + m[8]*lnz;
        const wny = m[1]*lnx + m[5]*lny + m[9]*lnz;
        const wnz = m[2]*lnx + m[6]*lny + m[10]*lnz;
        out.positions.push(wx, wy, wz);
        out.normals.push(wnx, wny, wnz);
        out.colors.push(r, gcol, b);
      }
      for (let k = 0; k < idx.length; k++) {
        out.indices.push(idx[k] + vertexOffset);
      }
      vertexOffset += verts.length / 6;
      geom.delete();
    }

    const vc = out.positions.length / 3;
    console.log(`  expressID=${flatMesh.expressID}: ${vc} verts, ${out.indices.length/3} tris`);
    if (vc > bestVertCount) {
      bestVertCount = vc;
      bestOut = out;
    }
  });

  if (!bestOut) {
    console.warn(`[geom] ${typeName}: no geometry extracted`);
    return null;
  }
  // TS closure narrowing: re-assert after null guard.
  const result = bestOut as GeomOut;

  // Center at origin, bottom at z=0
  centerGeom(result);
  // Round to 5 decimal places to keep JSON compact
  result.positions = result.positions.map((v: number) => Math.round(v * 1e5) / 1e5);
  result.normals   = result.normals.map((v: number) => Math.round(v * 1e5) / 1e5);
  return result;
}

async function main() {
  const ifcPath = path.resolve("web/public/samples/AC20-FZK-Haus.ifc");
  const { IfcAPI } = await import("web-ifc");
  const api = new IfcAPI();
  await api.Init();

  const buf = await readFile(ifcPath);
  const modelID = api.OpenModel(new Uint8Array(buf), { COORDINATE_TO_ORIGIN: true });
  console.log(`[geom] opened model ${modelID}`);

  // Load all geometry into memory so StreamMeshes works
  console.log("[geom] loading geometry (may take a moment)...");
  api.LoadAllGeometry(modelID);
  console.log("[geom] geometry loaded");

  const doorGeom   = await extractGeomForType(api, modelID, IFCDOOR,   "IfcDoor");
  const windowGeom = await extractGeomForType(api, modelID, IFCWINDOW, "IfcWindow");

  const outDir = path.resolve("web/public/samples");

  if (doorGeom) {
    const doorPath = path.join(outDir, "fzk-door-geom.json");
    await writeFile(doorPath, JSON.stringify(doorGeom));
    const kb = (JSON.stringify(doorGeom).length / 1024).toFixed(1);
    console.log(`[geom] wrote ${doorPath} (${kb} KB)`);
  }

  if (windowGeom) {
    const winPath = path.join(outDir, "fzk-window-geom.json");
    await writeFile(winPath, JSON.stringify(windowGeom));
    const kb = (JSON.stringify(windowGeom).length / 1024).toFixed(1);
    console.log(`[geom] wrote ${winPath} (${kb} KB)`);
  }

  api.CloseModel(modelID);
  console.log("[geom] done");
}

main().catch(console.error);
