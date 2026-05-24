/**
 * extract-fixture-from-ifc.ts — Generic IFC element fixture extractor.
 *
 * Usage:
 *   bun scripts/extract-fixture-from-ifc.ts \
 *     --ifc web/public/samples/AC20-FZK-Haus.ifc \
 *     --filter IfcSlab+IfcMember+IfcBeam+IfcCovering \
 *     --out web/test/fixtures/fzk-haus-ifc-roof.json
 *
 * Produces schema_version:1 fixture. Re-runs are byte-identical for the same
 * IFC file (element order = expressID ascending; floats rounded to 6dp).
 *
 * Per-element:
 *   - bbox (world-space min/max + axis-aligned dims)
 *   - dims (sorted descending: [longest, mid, shortest])
 *   - centroid
 *   - volume (signed tetrahedron sum — NaN if open surface)
 *   - orientation (principal + secondary axis from bbox)
 *   - vertCount, faceCount
 *   - userData { ifcClass, role: null }
 *
 * Float32→float64 conversion happens at extraction time (world-space transform).
 * Values stored at 6dp (sub-millimetre precision for metre-scale geometry).
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ── IFC type code registry ────────────────────────────────────────────────────

const IFC_TYPE_CODES: Record<string, number> = {
  IfcSlab:       1529196076,
  IfcMember:     1073191201,
  IfcCovering:   1973544240,
  IfcPlate:      3171933400,
  IfcRoof:       2016517767,
  IfcWall:       2391406946,
  IfcBeam:        753842376,
  IfcDoor:       395920057,
  IfcWindow:     3304561284,
  IfcStair:      331165859,
  IfcColumn:      843113511,
};

// ── Geometry types ────────────────────────────────────────────────────────────

interface Vec3 { x: number; y: number; z: number }

interface BBox {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
  w: number; d: number; h: number;
}

interface FixtureElement {
  expressID:   number;
  ifcType:     string;
  bbox:        BBox;
  dims:        [number, number, number];
  centroid:    Vec3;
  volume:      number;
  orientation: { principal: [number, number, number]; secondary: [number, number, number] };
  vertCount:   number;
  faceCount:   number;
  userData:    { ifcClass: string; role: null };
}

interface Fixture {
  schema_version: 1;
  source_ifc:     string;
  filter:         string[];
  elements:       FixtureElement[];
}

// ── Math helpers ──────────────────────────────────────────────────────────────

const r6 = (n: number) => parseFloat(n.toFixed(6));

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx] as [number, number, number];
}

function dot(a: [number, number, number], b: [number, number, number]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len < 1e-12) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Orientation from bbox: principal = axis of longest dimension,
 * secondary = axis of second-longest dimension.
 */
function bboxOrientation(
  w: number, d: number, h: number,
): { principal: [number, number, number]; secondary: [number, number, number] } {
  const axes: [number, [number, number, number]][] = [
    [w, [1, 0, 0]],
    [d, [0, 1, 0]],
    [h, [0, 0, 1]],
  ];
  axes.sort((a, b) => b[0] - a[0]);
  return { principal: axes[0][1], secondary: axes[1][1] };
}

// ── Element extractor ─────────────────────────────────────────────────────────

function extractElement(api: any, modelID: number, expressID: number, typeName: string): FixtureElement | null {
  // Accumulated world-space positions and faces across all placed geometries.
  const wx: number[] = [];
  const wy: number[] = [];
  const wz: number[] = [];
  const faces: [number, number, number][] = [];  // [i0, i1, i2] into wx/wy/wz

  api.StreamMeshes(modelID, [expressID], (flatMesh: any) => {
    const nGeoms = flatMesh.geometries.size();
    for (let gi = 0; gi < nGeoms; gi++) {
      const placed = flatMesh.geometries.get(gi);
      const geom   = api.GetGeometry(modelID, placed.geometryExpressID);
      const verts  = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx    = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      const m      = placed.flatTransformation as Float32Array;

      const vertOffset = wx.length;

      // Transform local vertices to world space (float32 → float64).
      for (let v = 0; v < verts.length; v += 6) {
        const lx = verts[v], ly = verts[v + 1], lz = verts[v + 2];
        wx.push(m[0] * lx + m[4] * ly + m[8]  * lz + m[12]);
        wy.push(m[1] * lx + m[5] * ly + m[9]  * lz + m[13]);
        wz.push(m[2] * lx + m[6] * ly + m[10] * lz + m[14]);
      }

      for (let t = 0; t < idx.length; t += 3) {
        faces.push([
          vertOffset + idx[t],
          vertOffset + idx[t + 1],
          vertOffset + idx[t + 2],
        ]);
      }

      geom.delete();
    }
  });

  if (wx.length === 0) return null;

  // ── Bbox ──
  let minX = wx[0], maxX = wx[0];
  let minY = wy[0], maxY = wy[0];
  let minZ = wz[0], maxZ = wz[0];
  for (let i = 1; i < wx.length; i++) {
    if (wx[i] < minX) minX = wx[i]; if (wx[i] > maxX) maxX = wx[i];
    if (wy[i] < minY) minY = wy[i]; if (wy[i] > maxY) maxY = wy[i];
    if (wz[i] < minZ) minZ = wz[i]; if (wz[i] > maxZ) maxZ = wz[i];
  }

  const bw = maxX - minX;
  const bd = maxY - minY;
  const bh = maxZ - minZ;

  const dimsRaw = [bw, bd, bh];
  dimsRaw.sort((a, b) => b - a);

  // ── Volume (signed tetrahedron sum) ──
  let vol = 0;
  for (const [i0, i1, i2] of faces) {
    const v1x = wx[i1] - wx[i0], v1y = wy[i1] - wy[i0], v1z = wz[i1] - wz[i0];
    const v2x = wx[i2] - wx[i0], v2y = wy[i2] - wy[i0], v2z = wz[i2] - wz[i0];
    const cx = v1y * v2z - v1z * v2y;
    const cy = v1z * v2x - v1x * v2z;
    const cz = v1x * v2y - v1y * v2x;
    vol += wx[i0] * cx + wy[i0] * cy + wz[i0] * cz;
  }
  vol = Math.abs(vol) / 6;

  const orientation = bboxOrientation(bw, bd, bh);

  return {
    expressID,
    ifcType: typeName,
    bbox: {
      minX: r6(minX), maxX: r6(maxX),
      minY: r6(minY), maxY: r6(maxY),
      minZ: r6(minZ), maxZ: r6(maxZ),
      w: r6(bw), d: r6(bd), h: r6(bh),
    },
    dims: [r6(dimsRaw[0]), r6(dimsRaw[1]), r6(dimsRaw[2])],
    centroid: { x: r6((minX + maxX) / 2), y: r6((minY + maxY) / 2), z: r6((minZ + maxZ) / 2) },
    volume: r6(vol),
    orientation,
    vertCount: wx.length,
    faceCount: faces.length,
    userData: { ifcClass: typeName, role: null },
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const ifcArg    = get("--ifc");
  const filterArg = get("--filter");
  const outArg    = get("--out");

  if (!ifcArg || !filterArg || !outArg) {
    console.error("Usage: bun scripts/extract-fixture-from-ifc.ts --ifc <path> --filter <Type1+Type2+...> --out <path>");
    process.exit(1);
  }

  const filterTypes = filterArg.split("+").map(s => s.trim());
  const unknown = filterTypes.filter(t => !IFC_TYPE_CODES[t]);
  if (unknown.length > 0) {
    console.error(`Unknown IFC types: ${unknown.join(", ")}`);
    console.error(`Supported: ${Object.keys(IFC_TYPE_CODES).join(", ")}`);
    process.exit(1);
  }

  const { IfcAPI } = await import("web-ifc") as any;
  const api = new IfcAPI();
  await api.Init();

  const ifcPath = path.resolve(ifcArg);
  const data = await readFile(ifcPath);
  const modelID = api.OpenModel(new Uint8Array(data));
  console.log(`Loaded: ${ifcPath}  modelID=${modelID}`);

  const elements: FixtureElement[] = [];

  for (const typeName of filterTypes) {
    const typeCode = IFC_TYPE_CODES[typeName];
    const lineIDs  = api.GetLineIDsWithType(modelID, typeCode);
    const count    = lineIDs.size();
    console.log(`  ${typeName}: ${count} instances`);

    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push(lineIDs.get(i));
    ids.sort((a, b) => a - b);

    for (const id of ids) {
      const el = extractElement(api, modelID, id, typeName);
      if (!el) { console.log(`    ${id}: no geometry`); continue; }
      elements.push(el);
      console.log(`    ${id}: bbox w=${el.bbox.w.toFixed(3)} d=${el.bbox.d.toFixed(3)} h=${el.bbox.h.toFixed(3)} vol=${el.volume.toFixed(4)} verts=${el.vertCount}`);
    }
  }

  api.CloseModel(modelID);

  const fixture: Fixture = {
    schema_version: 1,
    source_ifc:     path.relative(process.cwd(), ifcPath).replace(/\\/g, "/"),
    filter:         filterTypes,
    elements,
  };

  const outPath = path.resolve(outArg);
  await writeFile(outPath, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`\nWrote ${elements.length} elements → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
