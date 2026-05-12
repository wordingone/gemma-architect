// Self-harness for the gemma-architect web demo.
//
// Executes every demo's JS through the same Tier 1 surface the worker uses,
// meshes the resulting Solid via OpenCascade, builds an IFC4 STEP-21 file via
// the same buildIfc the browser ships, and structurally validates the result.
//
// What this DOES validate:
//   - Demo JS parses + runs against tier1 → produces a Solid
//   - replicad mesh() returns triangle/vertex/normal arrays
//   - buildIfc emits a STEP-21 file with the right header, sections, entity
//     counts (faces == triangles), and footer
//   - File is valid UTF-8 and round-trippable as text
//
// What this does NOT validate (browser-only):
//   - three.js viewer rendering
//   - web-ifc WASM round-trip parse (browser tests it via ifcRoundTrip)
//   - STL blob synthesis (replicad blobSTL)
//
// The web-ifc round-trip is exercised in-browser when the user clicks
// "Export IFC" — it's the same buildIfc bytes feeding the same web-ifc
// OpenModel call, just behind the Vite `?url` import boundary.

import { setOC } from "replicad";
import * as tier1 from "../src/tools/tier1.js";
import { DEMOS, applyParams } from "../web/src/agent/demo-prompts.js";
import { buildIfc, type IfcMesh } from "../web/src/ifc/ifc-build.js";

let _ocReady: Promise<void> | null = null;
async function ensureOC(): Promise<void> {
  if (_ocReady) return _ocReady;
  _ocReady = (async () => {
    const ocModule: any = await import("replicad-opencascadejs/src/replicad_single.js");
    const init = ocModule.default ?? ocModule;
    const oc = await init();
    setOC(oc);
  })();
  return _ocReady;
}

const tier1Bindings = {
  drawRectangle: tier1.drawRectangle,
  drawCircle: tier1.drawCircle,
  drawLine: tier1.drawLine,
  drawPolyline: tier1.drawPolyline,
  makeBox: tier1.makeBox,
  makeCylinder: tier1.makeCylinder,
};

type DemoResult = {
  id: string;
  label: string;
  ok: boolean;
  resultKind?: string;
  triCount?: number;
  vertexCount?: number;
  ifcBytes?: number;
  ifcEntities?: number;
  ifcProxyLines?: number;
  bounds?: string;
  error?: string;
};

function execAndMesh(js: string): {
  result: any;
  resultKind: string;
  mesh: IfcMesh & { normals: Float32Array };
  bounds: string;
} {
  const constNames = Array.from(
    js.matchAll(/^\s*const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm),
  ).map((m) => m[1]);
  if (constNames.length === 0) throw new Error("no top-level const declarations");
  const lastName = constNames[constNames.length - 1];
  const wrapped = `${js}\nreturn ${lastName};`;

  const fn = new Function(...Object.keys(tier1Bindings), wrapped);
  const result = fn(...Object.values(tier1Bindings));
  if (result === undefined || result === null) {
    throw new Error(`${lastName} resolved to ${String(result)}`);
  }
  const resultKind = (result as object).constructor?.name ?? typeof result;
  if (!["Solid", "Compound", "Shell", "CompSolid"].includes(resultKind)) {
    throw new Error(`result is ${resultKind}, viewer needs Solid/Compound/Shell/CompSolid`);
  }

  const m = result.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
  const vertices = new Float32Array(m.vertices);
  const normals = new Float32Array(m.normals);
  const indices = new Uint32Array(m.triangles);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const dx = (maxX - minX).toFixed(2);
  const dy = (maxY - minY).toFixed(2);
  const dz = (maxZ - minZ).toFixed(2);

  return {
    result,
    resultKind,
    mesh: { vertices, normals, indices },
    bounds: `${dx}×${dy}×${dz}m`,
  };
}

function validateIfcStructure(bytes: Uint8Array, expectedTriCount: number): {
  ok: boolean;
  entityCount: number;
  proxyLines: number;
  error?: string;
} {
  const text = new TextDecoder().decode(bytes);

  if (!text.startsWith("ISO-10303-21;")) {
    return { ok: false, entityCount: 0, proxyLines: 0, error: "missing ISO-10303-21 header" };
  }
  if (!text.includes("FILE_SCHEMA(('IFC4'));")) {
    return { ok: false, entityCount: 0, proxyLines: 0, error: "missing IFC4 schema" };
  }
  if (!text.includes("END-ISO-10303-21;")) {
    return { ok: false, entityCount: 0, proxyLines: 0, error: "missing END-ISO-10303-21 footer" };
  }
  if (!text.includes("ENDSEC;")) {
    return { ok: false, entityCount: 0, proxyLines: 0, error: "missing ENDSEC" };
  }

  const entityLines = text.split("\n").filter((l) => /^#\d+=IFC/.test(l));
  const faceLines = text.split("\n").filter((l) => /^#\d+=IFCFACE\(/.test(l));
  const proxyLines = text.split("\n").filter((l) => l.includes("=IFCBUILDINGELEMENTPROXY")).length;
  const facetedBrep = text.split("\n").filter((l) => l.includes("=IFCFACETEDBREP")).length;
  const closedShell = text.split("\n").filter((l) => l.includes("=IFCCLOSEDSHELL")).length;

  if (faceLines.length !== expectedTriCount) {
    return {
      ok: false,
      entityCount: entityLines.length,
      proxyLines,
      error: `face count ${faceLines.length} != triangle count ${expectedTriCount}`,
    };
  }
  if (proxyLines !== 1) {
    return {
      ok: false,
      entityCount: entityLines.length,
      proxyLines,
      error: `expected 1 IfcBuildingElementProxy, got ${proxyLines}`,
    };
  }
  if (facetedBrep !== 1) {
    return {
      ok: false,
      entityCount: entityLines.length,
      proxyLines,
      error: `expected 1 IfcFacetedBrep, got ${facetedBrep}`,
    };
  }
  if (closedShell !== 1) {
    return {
      ok: false,
      entityCount: entityLines.length,
      proxyLines,
      error: `expected 1 IfcClosedShell, got ${closedShell}`,
    };
  }

  return { ok: true, entityCount: entityLines.length, proxyLines };
}

async function harnessOne(demo: typeof DEMOS[number]): Promise<DemoResult> {
  const params: Record<string, number> = {};
  for (const p of demo.params ?? []) params[p.name] = p.default;
  const js = applyParams(demo.js, params);

  try {
    const { resultKind, mesh, bounds } = execAndMesh(js);
    const triCount = mesh.indices.length / 3;
    const vertexCount = mesh.vertices.length / 3;

    const ifc = buildIfc(mesh, demo.label);
    const v = validateIfcStructure(ifc, triCount);
    if (!v.ok) {
      return {
        id: demo.id,
        label: demo.label,
        ok: false,
        resultKind,
        triCount,
        vertexCount,
        bounds,
        ifcBytes: ifc.byteLength,
        ifcEntities: v.entityCount,
        ifcProxyLines: v.proxyLines,
        error: `ifc: ${v.error}`,
      };
    }
    return {
      id: demo.id,
      label: demo.label,
      ok: true,
      resultKind,
      triCount,
      vertexCount,
      bounds,
      ifcBytes: ifc.byteLength,
      ifcEntities: v.entityCount,
      ifcProxyLines: v.proxyLines,
    };
  } catch (e) {
    return {
      id: demo.id,
      label: demo.label,
      ok: false,
      error: (e as Error).message,
    };
  }
}

async function main() {
  console.log(`gemma-architect web self-harness — ${DEMOS.length} demos\n`);
  await ensureOC();
  console.log("OpenCascade ready.\n");

  const results: DemoResult[] = [];
  for (const demo of DEMOS) {
    const r = await harnessOne(demo);
    results.push(r);
    if (r.ok) {
      console.log(
        `  PASS  ${demo.id.padEnd(20)} ${r.resultKind} ${r.triCount} tris  ${r.bounds}  ifc=${(r.ifcBytes! / 1024).toFixed(1)}KB / ${r.ifcEntities} entities`,
      );
    } else {
      console.log(`  FAIL  ${demo.id.padEnd(20)} ${r.error}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} demos passed.`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error("self-harness crashed:", e);
  process.exit(2);
});
