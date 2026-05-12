// Replicad-opencascadejs worker.
//
// Boots OpenCascade WASM once on first message, then evaluates Tier 1 JS
// emitted by the Gemma model (or one of the canned demos) against the
// replicad surface. Returns mesh data for three.js + an STL blob.
//
// Tier 1 surface mirrors src/tools/tier1.ts in the parent repo. Inlined
// rather than imported so the worker bundle is self-contained — if the
// parent surface evolves, update both. Drift would surface as a tier1
// op missing from the binding map and is caught at execute() time.

import init from "replicad-opencascadejs/src/replicad_single.js";
// @ts-ignore — wasm asset URL resolved by vite-plugin-wasm
import opencascadeWasmUrl from "replicad-opencascadejs/src/replicad_single.wasm?url";
import {
  setOC,
  drawRectangle,
  drawCircle,
  makeBaseBox,
  makeCylinder,
  draw,
  type Solid,
  type Drawing,
  type Sketch,
  type Shape3D,
} from "replicad";
import * as WebIFC from "web-ifc";
// @ts-ignore — wasm asset URL resolved by vite-plugin-wasm
import webIfcWasmUrl from "web-ifc/web-ifc.wasm?url";
import type { IfcHierarchyElement } from "./ifc/ifc-types";

type Pt = [number, number];

const makeBox = (width: number, depth: number, height: number): Solid =>
  makeBaseBox(width, depth, height);

function drawLine(p1: Pt, p2: Pt) {
  return draw(p1).lineTo(p2);
}

function drawPolyline(points: Pt[]) {
  if (points.length < 2) {
    throw new Error("drawPolyline requires at least 2 points");
  }
  let pen = draw(points[0]);
  for (let i = 1; i < points.length; i++) pen = pen.lineTo(points[i]);
  return pen.close();
}

const tier1Bindings = {
  drawRectangle,
  drawCircle,
  drawLine,
  drawPolyline,
  makeBox,
  makeCylinder,
};

let _ocReady: Promise<void> | null = null;
let _ocHandle: any = null; // raw OpenCascade module — needed for STEP/IGES/BREP readers.
function ensureOC(): Promise<void> {
  if (_ocReady) return _ocReady;
  _ocReady = (async () => {
    // OCJS's bundled .d.ts types init() as zero-arg, but the actual Emscripten
    // module accepts an options object with locateFile — needed under Vite so
    // the worker bundle finds replicad_single.wasm at the rewritten URL.
    const oc = await (init as unknown as (
      opts?: { locateFile?: (path: string) => string },
    ) => Promise<unknown>)({ locateFile: () => opencascadeWasmUrl });
    _ocHandle = oc;
    setOC(oc as any);
  })();
  return _ocReady;
}

// Reuse the same web-ifc instance across calls to avoid double-init costs.
let _ifcApi: WebIFC.IfcAPI | null = null;
async function ensureIfcApi(): Promise<WebIFC.IfcAPI> {
  if (_ifcApi) return _ifcApi;
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath("", true);
  await api.Init((path: string) => {
    if (path.endsWith(".wasm")) return webIfcWasmUrl;
    return path;
  }, true);
  _ifcApi = api;
  return api;
}

type RunRequest = { type: "run"; id: number; js: string };
type RunSuccess = {
  type: "run-ok";
  id: number;
  resultKind: string;
  mesh: { vertices: Float32Array; normals: Float32Array; indices: Uint32Array };
  stl: ArrayBuffer;
  bounds: { min: [number, number, number]; max: [number, number, number] };
};
type RunError = { type: "run-error"; id: number; error: string };
type ReadyMsg = { type: "ready" };

// File-load: IFC.
type LoadIfcRequest = { type: "load-ifc"; id: number; bytes: ArrayBuffer };
export type IfcElementRange = {
  expressID: number;
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
};

type LoadIfcSuccess = {
  type: "load-ifc-ok";
  id: number;
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  colors: Float32Array | null;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  schema: string;
  entityCount: number;
  hierarchy: IfcHierarchyElement[];
  elementRanges: IfcElementRange[];
};
type LoadIfcError = { type: "load-ifc-error"; id: number; error: string };

// File-load: STEP / IGES / BREP via OpenCascade.
type LoadStepRequest = {
  type: "load-step";
  id: number;
  bytes: ArrayBuffer;
  format: "step" | "stp" | "iges" | "igs" | "brep";
};
type LoadStepSuccess = {
  type: "load-step-ok";
  id: number;
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  bounds: { min: [number, number, number]; max: [number, number, number] };
};
type LoadStepError = { type: "load-step-error"; id: number; error: string };

export type WorkerOut =
  | RunSuccess
  | RunError
  | ReadyMsg
  | LoadIfcSuccess
  | LoadIfcError
  | LoadStepSuccess
  | LoadStepError;
export type WorkerIn = RunRequest | LoadIfcRequest | LoadStepRequest;

async function executeAndMesh(js: string): Promise<RunSuccess | RunError> {
  await ensureOC();

  // Match the execute.ts pattern: pull every top-level `const <name> = ...` so
  // we can return the last one as the result. This is what the training surface
  // assumes — model output always ends with a final assignment.
  const constNames = Array.from(
    js.matchAll(/^\s*const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm),
  ).map((m) => m[1]);
  if (constNames.length === 0) {
    return { type: "run-error", id: 0, error: "no top-level const declarations" };
  }
  const lastName = constNames[constNames.length - 1];

  const wrapped = `${js}\nreturn ${lastName};`;
  let fn: Function;
  try {
    fn = new Function(...Object.keys(tier1Bindings), wrapped);
  } catch (e) {
    return { type: "run-error", id: 0, error: `parse: ${(e as Error).message}` };
  }

  let result: unknown;
  try {
    result = fn(...Object.values(tier1Bindings));
  } catch (e) {
    return { type: "run-error", id: 0, error: `runtime: ${(e as Error).message}` };
  }

  if (result === undefined || result === null) {
    return { type: "run-error", id: 0, error: `${lastName} resolved to ${String(result)}` };
  }

  const ctorName = (result as object).constructor?.name ?? typeof result;
  // Duck-type the result instead of matching constructor.name. Vite minifies
  // replicad's class names in prod (Solid → Nt etc.), so name-equality breaks.
  // Every Shape3D in replicad exposes .mesh() — drawings, sketches and 2D
  // primitives don't. boundingBox is a getter (NOT a function) so we don't
  // probe that. Mesh-as-method is the unambiguous discriminator.
  const looksLikeShape3D = typeof (result as any).mesh === "function";
  if (!looksLikeShape3D) {
    return {
      type: "run-error",
      id: 0,
      error: `result is ${ctorName}, viewer needs a 3D shape (Solid/Compound). Add an extrude / revolve / fuse / cut step.`,
    };
  }

  const shape = result as Shape3D;
  const m = shape.mesh({ tolerance: 0.05, angularTolerance: 0.3 });

  // ShapeMesh: { triangles: number[], vertices: number[], normals: number[], faceGroups: ... }
  // - vertices: flat [x,y,z, x,y,z, ...]
  // - triangles: flat indices into the vertices array (3 per triangle)
  // - normals: flat per-vertex [nx,ny,nz, ...]
  const vertices = new Float32Array(m.vertices);
  const normals = new Float32Array(m.normals);
  const indices = new Uint32Array(m.triangles);

  // Bounding box for camera fit. Walk the vertex array.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  let stlBuffer: ArrayBuffer;
  try {
    const blob = shape.blobSTL({ binary: true });
    stlBuffer = await blob.arrayBuffer();
  } catch (e) {
    // Don't fail the whole run if STL synthesis hiccups — viewer still works.
    stlBuffer = new ArrayBuffer(0);
  }

  // Minification mangles ctorName ("Nt"); fall back to "Solid" for display
  // since duck-typing already confirmed Shape3D-shaped output.
  const isLegibleName = /^(Solid|Compound|Shell|CompSolid)$/.test(ctorName);
  const resultKindOut = isLegibleName ? ctorName : "Solid";

  return {
    type: "run-ok",
    id: 0,
    resultKind: resultKindOut,
    mesh: { vertices, normals, indices },
    stl: stlBuffer,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
}

async function loadIfc(bytes: ArrayBuffer): Promise<LoadIfcSuccess | LoadIfcError> {
  let api: WebIFC.IfcAPI;
  try {
    api = await ensureIfcApi();
  } catch (e) {
    return { type: "load-ifc-error", id: 0, error: `web-ifc init: ${(e as Error).message}` };
  }
  let modelID = -1;
  try {
    const u8 = new Uint8Array(bytes);
    // COORDINATE_TO_ORIGIN translates the model so its bounding box is centered
    // near origin — better default for camera-fit.
    modelID = api.OpenModel(u8, { COORDINATE_TO_ORIGIN: true });
    if (modelID < 0) {
      return { type: "load-ifc-error", id: 0, error: "OpenModel returned -1" };
    }
    const schema = api.GetModelSchema(modelID);

    // Walk all geometry. LoadAllGeometry returns Vector<FlatMesh>; each FlatMesh
    // has a vector of placedGeometries (indices into a global mesh table) and
    // each placedGeometry carries a 4x4 transform + color.
    const flatMeshes = api.LoadAllGeometry(modelID);
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    let entityCount = 0;
    const elementExpressIDs: number[] = [];

    const elementRanges: IfcElementRange[] = [];
    const meshCount = flatMeshes.size();
    for (let i = 0; i < meshCount; i++) {
      const flatMesh = flatMeshes.get(i);
      elementExpressIDs.push(flatMesh.expressID);
      const placedCount = flatMesh.geometries.size();
      entityCount += placedCount;
      const elemVertStart = positions.length / 3;
      const elemIdxStart = indices.length;
      for (let j = 0; j < placedCount; j++) {
        const placed = flatMesh.geometries.get(j);
        const geom = api.GetGeometry(modelID, placed.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        // verts is interleaved [x, y, z, nx, ny, nz, x, y, z, nx, ny, nz, ...]
        const m = placed.flatTransformation as unknown as Float32Array | number[];
        const baseIndex = positions.length / 3;
        const r = placed.color?.x ?? 0.7;
        const g = placed.color?.y ?? 0.7;
        const b = placed.color?.z ?? 0.7;
        for (let v = 0; v < verts.length; v += 6) {
          const x = verts[v + 0], y = verts[v + 1], z = verts[v + 2];
          const nx = verts[v + 3], ny = verts[v + 4], nz = verts[v + 5];
          // 4x4 column-major (web-ifc convention, matches three.js Matrix4.fromArray):
          // basis cols at m[0..2], m[4..6], m[8..10]; translation at m[12..14].
          // Reading translation from m[3]/m[7]/m[11] gave 0,0,0 every time —
          // every part landed at world origin instead of in the building.
          const wx = m[0] * x + m[4] * y + m[8]  * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9]  * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          // Normals — use 3x3 basis only (no translation).
          const wnx = m[0] * nx + m[4] * ny + m[8]  * nz;
          const wny = m[1] * nx + m[5] * ny + m[9]  * nz;
          const wnz = m[2] * nx + m[6] * ny + m[10] * nz;
          positions.push(wx, wy, wz);
          normals.push(wnx, wny, wnz);
          colors.push(r, g, b);
        }
        for (let k = 0; k < idx.length; k++) {
          indices.push(idx[k] + baseIndex);
        }
      }
      elementRanges.push({
        expressID: flatMesh.expressID,
        vertexStart: elemVertStart,
        vertexCount: positions.length / 3 - elemVertStart,
        indexStart: elemIdxStart,
        indexCount: indices.length - elemIdxStart,
      });
    }

    // Build reverse type-number → IFC class name map.
    const typeToIfcName = new Map<number, string>(
      (Object.entries(WebIFC) as Array<[string, unknown]>)
        .filter(([k, v]) => k.startsWith("IFC") && typeof v === "number")
        .map(([k, v]) => [v as number, k]),
    );

    // Extract storeys.
    const storeyLineIDs = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
    const storeyByID = new Map<number, { name: string; elevation: number }>();
    for (let si = 0; si < storeyLineIDs.size(); si++) {
      const sid = storeyLineIDs.get(si);
      try {
        const line = api.GetLine(modelID, sid, false) as any;
        storeyByID.set(sid, {
          name: (line.Name?.value as string | undefined) ?? `Storey ${si + 1}`,
          elevation: (line.Elevation?.value as number | undefined) ?? 0,
        });
      } catch {}
    }

    // Build element → storey map via IfcRelContainedInSpatialStructure.
    const elemToStorey = new Map<number, number>();
    const relIDs = api.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let ri = 0; ri < relIDs.size(); ri++) {
      try {
        const rel = api.GetLine(modelID, relIDs.get(ri), false) as any;
        const structID: number = rel.RelatingStructure?.expressID ?? -1;
        if (!storeyByID.has(structID)) continue;
        const related = rel.RelatedElements as Array<{ expressID?: number; value?: number }> | undefined;
        if (!related) continue;
        for (const elem of related) {
          const eid = elem.expressID ?? elem.value;
          if (typeof eid === "number") elemToStorey.set(eid, structID);
        }
      } catch {}
    }

    // Build hierarchy entries for each geometry element.
    const hierarchy: IfcHierarchyElement[] = [];
    for (const eid of elementExpressIDs) {
      try {
        const line = api.GetLine(modelID, eid, false) as any;
        const typeNum = api.GetLineType(modelID, eid);
        const ifcClass = typeToIfcName.get(typeNum) ?? "IfcEntity";
        const name =
          (line.Name?.value as string | undefined) ??
          (line.LongName?.value as string | undefined) ??
          `#${eid}`;
        const guid = (line.GlobalId?.value as string | undefined) ?? "";
        const storeyID = elemToStorey.get(eid);
        const storey = storeyID != null ? storeyByID.get(storeyID) : undefined;
        hierarchy.push({
          expressID: eid,
          name,
          guid,
          ifcClass,
          storeyName: storey?.name ?? "Unassigned",
          storeyElevation: storey?.elevation ?? 0,
        });
      } catch {}
    }

    api.CloseModel(modelID);
    modelID = -1;

    // Bounds.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (positions.length === 0) {
      return { type: "load-ifc-error", id: 0, error: "IFC parsed but produced no geometry" };
    }
    return {
      type: "load-ifc-ok",
      id: 0,
      vertices: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      colors: new Float32Array(colors),
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      schema,
      entityCount,
      hierarchy,
      elementRanges,
    };
  } catch (e) {
    if (modelID >= 0) {
      try { api!.CloseModel(modelID); } catch {}
    }
    return { type: "load-ifc-error", id: 0, error: `IFC load: ${(e as Error).message}` };
  }
}

async function loadStep(
  bytes: ArrayBuffer,
  format: "step" | "stp" | "iges" | "igs" | "brep",
): Promise<LoadStepSuccess | LoadStepError> {
  await ensureOC();
  if (!_ocHandle) {
    return { type: "load-step-error", id: 0, error: "OpenCascade not initialised" };
  }
  const oc = _ocHandle;
  const text = new TextDecoder().decode(bytes); // STEP/IGES/BREP are all text
  const filename = `import.${format}`;

  try {
    // Write the file into the Emscripten virtual FS.
    if (typeof oc.FS?.writeFile === "function") {
      oc.FS.writeFile(`/${filename}`, text);
    } else {
      return {
        type: "load-step-error",
        id: 0,
        error: "OpenCascade FS not available — cannot stage file",
      };
    }

    let shape: any = null;
    if (format === "step" || format === "stp") {
      const reader = new oc.STEPControl_Reader_1();
      const status = reader.ReadFile(`/${filename}`);
      // IFSelect_RetDone == 1 in OCCT enum.
      if (status !== 1 && status?.value !== 1) {
        return { type: "load-step-error", id: 0, error: `STEP ReadFile status=${status}` };
      }
      const progress = new oc.Message_ProgressRange_1();
      reader.TransferRoots(progress);
      const nbShapes = reader.NbShapes();
      if (nbShapes < 1) {
        return { type: "load-step-error", id: 0, error: "STEP TransferRoots produced 0 shapes" };
      }
      // OneShape() returns a single Compound when multiple roots exist.
      shape = reader.OneShape();
    } else if (format === "brep") {
      // BRep is loadable via BRepTools::Read_1(shape, stream, builder, progress).
      // No direct file-path API in this OC build, so we take the path of
      // staging file and reading via an IStream-style API only if available.
      // Fall through to error — BREP path is documented as best-effort.
      return {
        type: "load-step-error",
        id: 0,
        error: "BREP import not wired in this build — STEP/IGES preferred",
      };
    } else {
      return {
        type: "load-step-error",
        id: 0,
        error: `IGES not available in this OpenCascade build (no IGESControl_Reader)`,
      };
    }

    if (!shape || shape.IsNull?.()) {
      return { type: "load-step-error", id: 0, error: "OCCT returned null shape after Transfer" };
    }

    // Mesh the shape via BRepMesh_IncrementalMesh, then walk faces and pull
    // triangulation. This mirrors what replicad's Shape3D.mesh() does
    // internally but bypasses replicad's TopoDS-wrapping requirement.
    const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, 0.05, false, 0.3, false);
    mesher.Perform_1?.(new oc.Message_ProgressRange_1());

    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];

    // Iterate faces.
    const explorer = new oc.TopExp_Explorer_2(
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
    );
    while (explorer.More()) {
      const face = oc.TopoDS.Face_1(explorer.Current());
      const loc = new oc.TopLoc_Location_1();
      const tri = oc.BRep_Tool.Triangulation(face, loc, 0);
      if (!tri || tri.IsNull?.()) {
        explorer.Next();
        continue;
      }
      const triHandle = tri.get();
      const trsf = loc.Transformation();
      const nbNodes = triHandle.NbNodes();
      const baseIndex = positions.length / 3;
      for (let i = 1; i <= nbNodes; i++) {
        const p = triHandle.Node(i);
        const pTransformed = p.Transformed(trsf);
        positions.push(pTransformed.X(), pTransformed.Y(), pTransformed.Z());
        normals.push(0, 0, 0); // recomputed by viewer if missing
      }
      const nbTri = triHandle.NbTriangles();
      const orient = face.Orientation_1();
      for (let i = 1; i <= nbTri; i++) {
        const t = triHandle.Triangle(i);
        const out: any = { value1: 0, value2: 0, value3: 0 };
        t.Get(out);
        let a = out.value1 - 1 + baseIndex;
        let b = out.value2 - 1 + baseIndex;
        let c = out.value3 - 1 + baseIndex;
        // Reverse winding for face orientation TopAbs_REVERSED == 1.
        if (orient === 1 || orient?.value === 1) {
          [b, c] = [c, b];
        }
        indices.push(a, b, c);
      }
      explorer.Next();
    }

    if (positions.length === 0) {
      return {
        type: "load-step-error",
        id: 0,
        error: `${format.toUpperCase()} read OK but produced 0 triangulated faces`,
      };
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    return {
      type: "load-step-ok",
      id: 0,
      vertices: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    };
  } catch (e) {
    return { type: "load-step-error", id: 0, error: `${format.toUpperCase()} load: ${(e as Error).message}` };
  }
}

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "run") {
    const out = await executeAndMesh(msg.js);
    out.id = msg.id;
    if (out.type === "run-ok") {
      const transfer: Transferable[] = [
        out.mesh.vertices.buffer,
        out.mesh.normals.buffer,
        out.mesh.indices.buffer,
      ];
      if (out.stl.byteLength > 0) transfer.push(out.stl);
      (self as any).postMessage(out, transfer);
    } else {
      (self as any).postMessage(out);
    }
    return;
  }
  if (msg.type === "load-ifc") {
    const out = await loadIfc(msg.bytes);
    out.id = msg.id;
    if (out.type === "load-ifc-ok") {
      const transfer: Transferable[] = [
        out.vertices.buffer,
        out.normals.buffer,
        out.indices.buffer,
      ];
      if (out.colors) transfer.push(out.colors.buffer);
      (self as any).postMessage(out, transfer);
    } else {
      (self as any).postMessage(out);
    }
    return;
  }
  if (msg.type === "load-step") {
    const out = await loadStep(msg.bytes, msg.format);
    out.id = msg.id;
    if (out.type === "load-step-ok") {
      const transfer: Transferable[] = [
        out.vertices.buffer,
        out.normals.buffer,
        out.indices.buffer,
      ];
      (self as any).postMessage(out, transfer);
    } else {
      (self as any).postMessage(out);
    }
    return;
  }
};

// Signal readiness once OC is loaded. Keeps the UI's "loading" indicator honest.
ensureOC().then(() => {
  (self as any).postMessage({ type: "ready" } satisfies ReadyMsg);
});
