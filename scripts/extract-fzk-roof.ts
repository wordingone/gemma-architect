/**
 * extract-fzk-roof.ts — THIN WRAPPER. Use extract-fixture-from-ifc.ts instead.
 *
 * Usage: bun scripts/extract-fzk-roof.ts
 *
 * Equivalent to:
 *   bun scripts/extract-fixture-from-ifc.ts \
 *     --ifc web/public/samples/AC20-FZK-Haus.ifc \
 *     --filter IfcSlab+IfcMember+IfcCovering+IfcPlate+IfcRoof+IfcWall \
 *     --out web/public/samples/fzk-roof-elements.json
 *
 * Retained for backwards compatibility. Prefer the generalized extractor.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const IFCSLAB      = 1529196076;
const IFCMEMBER    = 1073191201;
const IFCCOVERING  = 1973544240;
const IFCPLATE     = 3171933400;
const IFCROOF      = 2016517767;
const IFCWALL      = 2391406946;

interface ElementInfo {
  expressID: number;
  ifcType:   string;
  centroid:  { x: number; y: number; z: number };
  bbox:      { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  dims:      { w: number; d: number; h: number };  // sorted: w>=d>=h
  color:     { r: number; g: number; b: number; a: number };
  vertCount: number;
}

function computeBbox(api: any, modelID: number, expressID: number): ElementInfo | null {
  let info: ElementInfo | null = null;

  api.StreamMeshes(modelID, [expressID], (flatMesh: any) => {
    const nGeoms = flatMesh.geometries.size();
    if (nGeoms === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    let totalVerts = 0;
    let r = 0, g = 0, b = 0, a = 1;

    for (let gi = 0; gi < nGeoms; gi++) {
      const placed = flatMesh.geometries.get(gi);
      const geom   = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts  = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const m      = placed.flatTransformation as unknown as number[];
      r = placed.color?.x ?? 0.7;
      g = placed.color?.y ?? 0.7;
      b = placed.color?.z ?? 0.7;
      a = placed.color?.w ?? 1;

      for (let v = 0; v < verts.length; v += 6) {
        const lx = verts[v], ly = verts[v+1], lz = verts[v+2];
        const wx = m[0]*lx + m[4]*ly + m[8]*lz  + m[12];
        const wy = m[1]*lx + m[5]*ly + m[9]*lz  + m[13];
        const wz = m[2]*lx + m[6]*ly + m[10]*lz + m[14];
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
      totalVerts += verts.length / 6;
      geom.delete();
    }

    if (minX === Infinity) return;

    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const dimsRaw = [dx, dy, dz].sort((a, b) => b - a);
    info = {
      expressID: flatMesh.expressID,
      ifcType: "",
      centroid: {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        z: (minZ + maxZ) / 2,
      },
      bbox: { minX, maxX, minY, maxY, minZ, maxZ },
      dims: { w: dimsRaw[0], d: dimsRaw[1], h: dimsRaw[2] },
      color: { r, g, b, a },
      vertCount: totalVerts,
    };
  });

  return info;
}

async function main() {
  const { IfcAPI } = await import("web-ifc") as any;
  const api = new IfcAPI();
  await api.Init();

  const ifcPath = path.resolve("web/public/samples/AC20-FZK-Haus.ifc");
  const data = await readFile(ifcPath);
  const modelID = api.OpenModel(new Uint8Array(data));
  console.log("Loaded FZK-Haus IFC, modelID:", modelID);

  const results: ElementInfo[] = [];

  const typeMap: Record<number, string> = {
    [IFCSLAB]:     "IfcSlab",
    [IFCMEMBER]:   "IfcMember",
    [IFCCOVERING]: "IfcCovering",
    [IFCPLATE]:    "IfcPlate",
    [IFCROOF]:     "IfcRoof",
    [IFCWALL]:     "IfcWall",
  };

  for (const [typeCode, typeName] of Object.entries(typeMap)) {
    const lineIDs = api.GetLineIDsWithType(modelID, Number(typeCode));
    const count = lineIDs.size();
    console.log(`\n${typeName}: ${count} instances`);

    for (let i = 0; i < count; i++) {
      const id = lineIDs.get(i);
      const info = computeBbox(api, modelID, id);
      if (!info) { console.log(`  ${id}: no geometry`); continue; }
      info.ifcType = typeName;

      // Tag elements by Z range but don't filter — print all to understand coord system.

      results.push(info);
      console.log(
        `  ${id}: centroid=(${info.centroid.x.toFixed(2)}, ${info.centroid.y.toFixed(2)}, ${info.centroid.z.toFixed(2)})` +
        ` dims=(${info.dims.w.toFixed(3)}, ${info.dims.d.toFixed(3)}, ${info.dims.h.toFixed(3)})` +
        ` verts=${info.vertCount} alpha=${info.color.a.toFixed(2)}`
      );
    }
  }

  api.CloseModel(modelID);

  // Round to mm precision
  const rounded = results.map((e) => ({
    ...e,
    centroid: { x: +e.centroid.x.toFixed(4), y: +e.centroid.y.toFixed(4), z: +e.centroid.z.toFixed(4) },
    bbox: Object.fromEntries(Object.entries(e.bbox).map(([k, v]) => [k, +(v as number).toFixed(4)])),
    dims: { w: +e.dims.w.toFixed(4), d: +e.dims.d.toFixed(4), h: +e.dims.h.toFixed(4) },
    color: Object.fromEntries(Object.entries(e.color).map(([k, v]) => [k, +(v as number).toFixed(3)])),
  }));

  const outPath = path.resolve("web/public/samples/fzk-roof-elements.json");
  await writeFile(outPath, JSON.stringify(rounded, null, 2));
  console.log(`\nWrote ${rounded.length} elements to ${outPath}`);

  // Print summary stats
  const minZ = Math.min(...results.map(e => e.bbox.minZ));
  const maxZ = Math.max(...results.map(e => e.bbox.maxZ));
  const minX = Math.min(...results.map(e => e.bbox.minX));
  const maxX = Math.max(...results.map(e => e.bbox.maxX));
  const minY = Math.min(...results.map(e => e.bbox.minY));
  const maxY = Math.max(...results.map(e => e.bbox.maxY));
  console.log(`\nRoof zone bbox: X=[${minX.toFixed(2)}..${maxX.toFixed(2)}] Y=[${minY.toFixed(2)}..${maxY.toFixed(2)}] Z=[${minZ.toFixed(2)}..${maxZ.toFixed(2)}]`);
  console.log(`Roof dims (world): W=${(maxX-minX).toFixed(2)}m  D=${(maxY-minY).toFixed(2)}m  H=${(maxZ-minZ).toFixed(2)}m`);
}

main().catch((e) => { console.error(e); process.exit(1); });
