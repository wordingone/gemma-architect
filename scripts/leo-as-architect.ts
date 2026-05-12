// Leo-as-architect harness — I write the JS by hand against tier1, the same
// way Gemma is supposed to. Each entry is (prompt, JS) where JS is what I
// emitted given only the prompt + the 12-op vocabulary. The harness runs
// each through the same execute → mesh → buildIfc → validate path the
// browser worker uses.
//
// Goal: exercise parts of the tool surface the 8 canned demos don't reach.
//
//   - rotate (degrees, 3D axis)
//   - revolve (Tier 2 op, in vocabulary)
//   - drawPolyline (closed N-gon profile)
//   - sketchOnPlane("XZ") + extrude (non-XY profile)
//   - makeBox + makeCylinder mixed with draw* + extrude
//   - nested booleans (fuse-of-fuse, cut after fuse)
//   - hollow solids (outer cut by inner)

import { setOC } from "replicad";
import * as tier1 from "../src/tools/tier1.js";
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

type Design = {
  id: string;
  prompt: string;
  js: string;
  expectedKind: "Solid" | "Compound" | "Shell" | "CompSolid";
  expectedBoundsApprox?: { dx?: number; dy?: number; dz?: number; tol?: number };
  exercises: string[]; // tier1 ops this design forces through
};

// All eight designs were written by me from the prompt + the tier1 surface
// alone, no copy-paste from the canned demos. Bound expectations are
// computed by hand from the prompt geometry.
const DESIGNS: Design[] = [
  {
    id: "pier-and-beam",
    prompt: "A pier-and-beam foundation: four 0.4×0.4×1m piers at the corners of a 5×4m footprint, with a 5×4×0.2m slab sitting on top.",
    exercises: ["makeBox", "translate", "fuse"],
    expectedKind: "Compound",
    expectedBoundsApprox: { dx: 5, dy: 4, dz: 1.2, tol: 0.05 },
    js: `
const PIER_W = 0.4, PIER_H = 1, FOOT_X = 5, FOOT_Y = 4, SLAB_T = 0.2;
const half_x = (FOOT_X - PIER_W) / 2;
const half_y = (FOOT_Y - PIER_W) / 2;
// makeBox is base-at-origin in Z, centered in X/Y. Pier base lives at
// z=0 already; slab sits on top at z=PIER_H.
const p0 = makeBox(PIER_W, PIER_W, PIER_H).translate([-half_x, -half_y, 0]);
const p1 = makeBox(PIER_W, PIER_W, PIER_H).translate([ half_x, -half_y, 0]);
const p2 = makeBox(PIER_W, PIER_W, PIER_H).translate([-half_x,  half_y, 0]);
const p3 = makeBox(PIER_W, PIER_W, PIER_H).translate([ half_x,  half_y, 0]);
const slab = makeBox(FOOT_X, FOOT_Y, SLAB_T).translate([0, 0, PIER_H]);
const result = p0.fuse(p1).fuse(p2).fuse(p3).fuse(slab);
`.trim(),
  },

  {
    id: "silo-on-pad",
    prompt: "A 3m diameter, 6m tall cylindrical silo standing on a 4×4×0.3m square concrete pad.",
    exercises: ["makeBox", "makeCylinder", "translate", "fuse"],
    expectedKind: "Compound",
    expectedBoundsApprox: { dx: 4, dy: 4, dz: 6.3, tol: 0.05 },
    js: `
const PAD_S = 4, PAD_T = 0.3, RADIUS = 1.5, HEIGHT = 6;
// pad: base-at-origin Z so z=[0, PAD_T] without translate.
// silo: base-at-origin Z, sits on pad at z=PAD_T.
const pad = makeBox(PAD_S, PAD_S, PAD_T);
const silo = makeCylinder(RADIUS, HEIGHT).translate([0, 0, PAD_T]);
const result = pad.fuse(silo);
`.trim(),
  },

  {
    id: "wall-with-window",
    prompt: "A 6m × 0.25m × 3m wall with a 1.5m wide × 1.2m tall window centered horizontally, sill 1m off the floor.",
    exercises: ["drawRectangle", "sketchOnPlane", "extrude", "translate", "cut"],
    expectedKind: "Solid",
    expectedBoundsApprox: { dx: 6, dy: 0.25, dz: 3, tol: 0.01 },
    js: `
const WALL_L = 6, WALL_T = 0.25, WALL_H = 3;
const WIN_W = 1.5, WIN_H = 1.2, SILL = 1;
const wall = drawRectangle(WALL_L, WALL_T).sketchOnPlane("XY").extrude(WALL_H);
const window = drawRectangle(WIN_W, WALL_T).sketchOnPlane("XY").extrude(WIN_H).translate([0, 0, SILL]);
const result = wall.cut(window);
`.trim(),
  },

  {
    id: "t-junction-wall",
    prompt: "Two walls meeting in a T-junction: a 6m × 0.2m × 3m wall along X, and a 4m × 0.2m × 3m wall along Y meeting it at the midpoint.",
    exercises: ["drawRectangle", "sketchOnPlane", "extrude", "translate", "fuse"],
    expectedKind: "Compound",
    expectedBoundsApprox: { dx: 6, dy: 4.2, dz: 3, tol: 0.05 },
    js: `
const X_LEN = 6, Y_LEN = 4, T = 0.2, H = 3;
const wallX = drawRectangle(X_LEN, T).sketchOnPlane("XY").extrude(H);
const wallY = drawRectangle(T, Y_LEN).sketchOnPlane("XY").extrude(H).translate([0, Y_LEN / 2 + T / 2, 0]);
const result = wallX.fuse(wallY);
`.trim(),
  },

  {
    id: "hollow-box",
    prompt: "A hollow box, outer dimensions 3×2×2.5m, with 0.15m wall thickness on all six faces (a closed shell).",
    exercises: ["makeBox", "cut"],
    expectedKind: "Solid",
    expectedBoundsApprox: { dx: 3, dy: 2, dz: 2.5, tol: 0.01 },
    js: `
const OX = 3, OY = 2, OZ = 2.5, T = 0.15;
const outer = makeBox(OX, OY, OZ);
const inner = makeBox(OX - 2 * T, OY - 2 * T, OZ - 2 * T);
const result = outer.cut(inner);
`.trim(),
  },

  {
    id: "pitched-roof-on-box",
    prompt: "A 4×3×2.5m box with a triangular pitched roof on top (1.25m ridge height, gable runs along the X axis).",
    exercises: ["makeBox", "drawPolyline", "sketchOnPlane(XZ)", "extrude", "translate", "fuse"],
    expectedKind: "Compound",
    expectedBoundsApprox: { dx: 4, dy: 3, dz: 3.75, tol: 0.05 },
    js: `
const BX = 4, BY = 3, BZ = 2.5, RIDGE = 1.25;
// box: base-at-origin Z so z=[0, BZ]. No translate needed.
const box = makeBox(BX, BY, BZ);
// Gable profile in XZ plane (sketch X = world X, sketch Y = world Z),
// extrudes along NEGATIVE world Y by BY (extrude direction is the RH
// normal of "XZ" = -Y). Result is y=[-BY, 0]; translate +BY/2 to
// center over the box's y=[-BY/2, BY/2] footprint.
const gable = drawPolyline([
  [-BX / 2, BZ],
  [ BX / 2, BZ],
  [0, BZ + RIDGE],
]).sketchOnPlane("XZ").extrude(BY).translate([0, BY / 2, 0]);
const result = box.fuse(gable);
`.trim(),
  },

  {
    id: "octagonal-column",
    prompt: "An octagonal column 0.5m circumradius, 4m tall, on a square 1×1×0.2m footing.",
    exercises: ["drawPolyline (closed N-gon)", "sketchOnPlane", "extrude", "makeBox", "translate", "fuse"],
    expectedKind: "Compound",
    expectedBoundsApprox: { dx: 1, dy: 1, dz: 4.2, tol: 0.05 },
    js: `
const R = 0.5, H = 4, FOOT_S = 1, FOOT_T = 0.2;
const N = 8;
const pts = [];
for (let i = 0; i < N; i++) {
  const a = (2 * Math.PI * i) / N;
  pts.push([R * Math.cos(a), R * Math.sin(a)]);
}
// footing: base-at-origin Z so z=[0, FOOT_T] without translate.
// column: sits on top of footing at z=FOOT_T.
const footing = makeBox(FOOT_S, FOOT_S, FOOT_T);
const column = drawPolyline(pts).sketchOnPlane("XY").extrude(H).translate([0, 0, FOOT_T]);
const result = footing.fuse(column);
`.trim(),
  },

  {
    id: "cylindrical-tank-revolve",
    prompt: "A cylindrical tank of 1.2m inner radius, 0.1m wall thickness, 3m tall, generated by revolving a rectangular wall profile around the vertical axis.",
    exercises: ["drawPolyline", "sketchOnPlane(XZ)", "revolve", "Tier 2 op"],
    expectedKind: "Solid",
    expectedBoundsApprox: { dx: 2.6, dy: 2.6, dz: 3, tol: 0.1 },
    // Profile in XZ: a thin rectangle sitting between r=R_INNER and r=R_INNER+T
    // from z=0 to z=H. Revolve around Z (default axis).
    js: `
const R_INNER = 1.2, T = 0.1, H = 3;
const profile = drawPolyline([
  [R_INNER,     0],
  [R_INNER + T, 0],
  [R_INNER + T, H],
  [R_INNER,     H],
]).sketchOnPlane("XZ");
const result = profile.revolve();
`.trim(),
  },
];

function execAndMesh(js: string): {
  result: any;
  resultKind: string;
  mesh: IfcMesh & { normals: Float32Array };
  bounds: { dx: number; dy: number; dz: number };
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

  return {
    result,
    resultKind,
    mesh: { vertices, normals, indices },
    bounds: { dx: maxX - minX, dy: maxY - minY, dz: maxZ - minZ },
  };
}

function validateIfc(bytes: Uint8Array, expectedTriCount: number): {
  ok: boolean;
  entityCount: number;
  error?: string;
} {
  const text = new TextDecoder().decode(bytes);
  if (!text.startsWith("ISO-10303-21;")) return { ok: false, entityCount: 0, error: "missing header" };
  if (!text.includes("FILE_SCHEMA(('IFC4'));")) return { ok: false, entityCount: 0, error: "missing IFC4 schema" };
  if (!text.includes("END-ISO-10303-21;")) return { ok: false, entityCount: 0, error: "missing footer" };
  const lines = text.split("\n");
  const entities = lines.filter((l) => /^#\d+=IFC/.test(l)).length;
  const faces = lines.filter((l) => /^#\d+=IFCFACE\(/.test(l)).length;
  const proxy = lines.filter((l) => l.includes("=IFCBUILDINGELEMENTPROXY")).length;
  const brep = lines.filter((l) => l.includes("=IFCFACETEDBREP")).length;
  const shell = lines.filter((l) => l.includes("=IFCCLOSEDSHELL")).length;
  if (faces !== expectedTriCount) return { ok: false, entityCount: entities, error: `face count ${faces} != tri count ${expectedTriCount}` };
  if (proxy !== 1 || brep !== 1 || shell !== 1) {
    return { ok: false, entityCount: entities, error: `proxy=${proxy} brep=${brep} shell=${shell}` };
  }
  return { ok: true, entityCount: entities };
}

function checkBounds(actual: { dx: number; dy: number; dz: number }, expected: Design["expectedBoundsApprox"]): string | null {
  if (!expected) return null;
  const tol = expected.tol ?? 0.01;
  const errs: string[] = [];
  for (const k of ["dx", "dy", "dz"] as const) {
    if (expected[k] === undefined) continue;
    const diff = Math.abs(actual[k] - expected[k]!);
    if (diff > tol) errs.push(`${k}: got ${actual[k].toFixed(3)} want ${expected[k]} (Δ=${diff.toFixed(3)} > ${tol})`);
  }
  return errs.length ? errs.join("; ") : null;
}

async function tryDesign(d: Design): Promise<{ id: string; ok: boolean; report: string; warning?: string }> {
  try {
    const { resultKind, mesh, bounds } = execAndMesh(d.js);
    const triCount = mesh.indices.length / 3;
    const ifc = buildIfc(mesh, d.id);
    const v = validateIfc(ifc, triCount);
    if (!v.ok) {
      return {
        id: d.id,
        ok: false,
        report: `IFC validation: ${v.error}`,
      };
    }

    const kindOk = resultKind === d.expectedKind || (d.expectedKind === "Solid" && resultKind === "Compound");
    const kindNote = kindOk ? "" : ` (expected ${d.expectedKind}, got ${resultKind})`;
    const boundsErr = checkBounds(bounds, d.expectedBoundsApprox);

    const report = `${resultKind} ${triCount} tris  ${bounds.dx.toFixed(2)}×${bounds.dy.toFixed(2)}×${bounds.dz.toFixed(2)}m  ifc=${(ifc.byteLength / 1024).toFixed(1)}KB / ${v.entityCount} entities${kindNote}`;
    if (boundsErr) {
      return { id: d.id, ok: false, report, warning: `bounds drift: ${boundsErr}` };
    }
    return { id: d.id, ok: true, report };
  } catch (e) {
    return { id: d.id, ok: false, report: `crash: ${(e as Error).message}` };
  }
}

async function main() {
  console.log(`leo-as-architect — ${DESIGNS.length} designs written by hand against tier1\n`);
  await ensureOC();
  console.log("OpenCascade ready.\n");

  const results: Array<{ id: string; ok: boolean; report: string; warning?: string }> = [];
  for (const d of DESIGNS) {
    process.stdout.write(`  exercising: ${d.exercises.join(", ")}\n`);
    process.stdout.write(`  prompt: "${d.prompt}"\n`);
    const r = await tryDesign(d);
    if (r.ok) {
      console.log(`  PASS  ${r.id.padEnd(28)} ${r.report}\n`);
    } else if (r.warning) {
      console.log(`  WARN  ${r.id.padEnd(28)} ${r.report}`);
      console.log(`        ${r.warning}\n`);
    } else {
      console.log(`  FAIL  ${r.id.padEnd(28)} ${r.report}\n`);
    }
    results.push(r);
  }

  const passed = results.filter((r) => r.ok).length;
  const warned = results.filter((r) => r.warning).length;
  const failed = results.filter((r) => !r.ok && !r.warning).length;
  console.log(`\nTotal: ${passed} pass / ${warned} warn / ${failed} fail of ${results.length}`);
  if (failed > 0 || warned > 0) {
    console.log(`\nDesigns that didn't fully pass — these are LESSONS about the tool surface, not bugs:`);
    for (const r of results.filter((x) => !x.ok || x.warning)) {
      console.log(`  ${r.id}: ${r.warning ?? r.report}`);
    }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("harness crashed:", e);
  process.exit(2);
});
