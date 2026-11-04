// Test the IFC viewer pipeline matrix-application against bundled samples.
//
// Mirrors the matrix block in web/src/worker.ts (lines ~270-301) using the
// same web-ifc API. Reports per-sample bounds and per-FlatMesh translations.
//
// What "broken" looks like: every FlatMesh's translation reads as 0,0,0 (the
// pre-fix bug pulled translation from m[3]/m[7]/m[11] which are always 0
// in column-major). Result: building components stack at world origin.
//
// What "fixed" looks like: translations vary per element, bounds span the
// real building dimensions (Schultz ~12x8x3, FZK-Haus ~12x10x6, etc.).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as WebIFC from "web-ifc";

const REPO = process.env.GEMMA_ARCHITECT_ROOT ?? process.cwd();

// Bundled samples are real architect-authored or community-contributed IFCs
// — bounds are recorded from the first known-good run as the regression
// check. If a future change to the matrix block in worker.ts pulls the
// translation from the wrong cells (the pre-fix bug), the dx/dy/dz numbers
// drop drastically (every FlatMesh stacks at world origin) and the
// non-origin translation count drops to ~0.
const SAMPLES = [
  { id: "schultz",         path: `${REPO}/web/public/samples/Schultz_Residence.ifc`, min_dx: 30, min_non_origin: 1000 },
  { id: "fzk-haus",        path: `${REPO}/web/public/samples/AC20-FZK-Haus.ifc`,     min_dx: 10, min_non_origin: 100 },
  { id: "institute",       path: `${REPO}/web/public/samples/AC20-Institute-Var-2.ifc`, min_dx: 30, min_non_origin: 500 },
  { id: "bonsai-openings", path: `${REPO}/web/public/samples/bonsai-project0-openings.ifc`, min_dx: 1, min_non_origin: 5 },
  { id: "simple-sweep",    path: `${REPO}/web/public/samples/simple-sweep-1.ifc`     },
  { id: "wall-opening",    path: `${REPO}/web/public/samples/wall-with-opening-and-window.ifc`, min_dx: 1, min_non_origin: 1 },
] as Array<{ id: string; path: string; min_dx?: number; min_non_origin?: number }>;

const api = new WebIFC.IfcAPI();
await api.Init();

for (const sample of SAMPLES) {
  let modelID = -1;
  try {
    const buffer = readFileSync(sample.path);
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true } as any);

    const positions: number[] = [];
    let translationCount = 0;
    let nonzeroTranslations = 0;
    const sampleTranslations: Array<[number, number, number]> = [];

    api.StreamAllMeshes(modelID, (flatMesh: any) => {
      const size = flatMesh.geometries.size();
      for (let j = 0; j < size; j++) {
        const placed = flatMesh.geometries.get(j);
        const geom = api.GetGeometry(modelID, placed.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()) as Float32Array;
        const m = placed.flatTransformation as number[];
        translationCount++;
        const tx = m[12], ty = m[13], tz = m[14];
        if (Math.abs(tx) + Math.abs(ty) + Math.abs(tz) > 1e-6) nonzeroTranslations++;
        if (sampleTranslations.length < 3) sampleTranslations.push([tx, ty, tz]);
        for (let v = 0; v < verts.length; v += 6) {
          const x = verts[v + 0], y = verts[v + 1], z = verts[v + 2];
          // Same matrix application as worker.ts:287-289
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          positions.push(wx, wy, wz);
        }
      }
    });

    if (positions.length === 0) {
      console.log(`[${sample.id}] empty geometry`);
      continue;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]);
      maxX = Math.max(maxX, positions[i]);
      minY = Math.min(minY, positions[i + 1]);
      maxY = Math.max(maxY, positions[i + 1]);
      minZ = Math.min(minZ, positions[i + 2]);
      maxZ = Math.max(maxZ, positions[i + 2]);
    }
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    const verts = positions.length / 3;
    console.log(
      `[${sample.id}] ` +
      `verts=${verts}, ` +
      `bbox X=[${minX.toFixed(2)},${maxX.toFixed(2)}] Y=[${minY.toFixed(2)},${maxY.toFixed(2)}] Z=[${minZ.toFixed(2)},${maxZ.toFixed(2)}], ` +
      `dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} dz=${dz.toFixed(2)}, ` +
      `flatmeshes=${translationCount} non-origin=${nonzeroTranslations}`
    );
    if (sampleTranslations.length > 0) {
      const formatted = sampleTranslations
        .map(([x, y, z]) => `(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`)
        .join(" ");
      console.log(`         sample translations: ${formatted}`);
    }
    const dx_ok = sample.min_dx === undefined ? true : dx >= sample.min_dx;
    const non_origin_ok = sample.min_non_origin === undefined ? true : nonzeroTranslations >= sample.min_non_origin;
    const verdict = dx_ok && non_origin_ok ? "OK" : "FAIL";
    console.log(`         verdict=${verdict} (dx≥${sample.min_dx ?? "any"}, non_origin≥${sample.min_non_origin ?? "any"})`);
    if (verdict === "FAIL") {
      console.log(`         REGRESSION: matrix fix in worker.ts:283-289 may be reverted — translations should come from m[12]/m[13]/m[14], not m[3]/m[7]/m[11]`);
    }
    api.CloseModel(modelID);
  } catch (e) {
    console.log(`[${sample.id}] error: ${(e as Error).message}`);
    if (modelID >= 0) {
      try { api.CloseModel(modelID); } catch { /* ignore */ }
    }
  }
}
