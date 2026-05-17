/**
 * extract-fzk-templates.ts — Extract representative IFCDOOR + IFCWINDOW
 * dimensions from the FZK-Haus IFC file and print them as constants.
 *
 * Usage: bun scripts/extract-fzk-templates.ts
 * Output: prints TS constants for openings.ts and dimensions summary.
 *
 * FZK-Haus IFC: web/public/samples/AC20-FZK-Haus.ifc
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

// web-ifc type codes (IFC4 schema)
const IFCDOOR = 395920057;
const IFCWINDOW = 3304561284;

async function main() {
  const ifcPath = path.resolve("web/public/samples/AC20-FZK-Haus.ifc");
  const { IfcAPI } = await import("web-ifc");
  const api = new IfcAPI();
  await api.Init();

  const buf = await readFile(ifcPath);
  const modelID = api.OpenModel(new Uint8Array(buf));
  console.log(`[extract-fzk] opened model ${modelID}`);

  function extractDims(typeCode: number, typeName: string) {
    let lineIDs;
    try {
      lineIDs = api.GetLineIDsWithType(modelID, typeCode);
    } catch {
      console.warn(`[extract-fzk] ${typeName} not in model`);
      return [];
    }
    const count = lineIDs.size();
    console.log(`[extract-fzk] ${typeName}: ${count} instances`);
    const dims: Array<{ w: number; h: number; id: number }> = [];
    for (let i = 0; i < count; i++) {
      const expressID = lineIDs.get(i);
      try {
        const el = api.GetLine(modelID, expressID, true);
        // OverallWidth and OverallHeight are IFC4 optional attrs on IfcDoor / IfcWindow
        const w = el?.OverallWidth?.value ?? null;
        const h = el?.OverallHeight?.value ?? null;
        if (w !== null && h !== null) {
          dims.push({ w: Number(w), h: Number(h), id: expressID });
        }
      } catch {
        // skip malformed entities
      }
    }
    return dims;
  }

  const doorDims = extractDims(IFCDOOR, "IfcDoor");
  const winDims  = extractDims(IFCWINDOW, "IfcWindow");

  function summarize(dims: Array<{ w: number; h: number; id: number }>, label: string) {
    if (dims.length === 0) {
      console.log(`[extract-fzk] ${label}: no dims found — using defaults`);
      return { w: label === "door" ? 0.9 : 1.2, h: label === "door" ? 2.1 : 1.4 };
    }
    const ws = dims.map(d => d.w);
    const hs = dims.map(d => d.h);
    // Use the most common (mode-ish) value — take median
    ws.sort((a, b) => a - b);
    hs.sort((a, b) => a - b);
    const medW = ws[Math.floor(ws.length / 2)];
    const medH = hs[Math.floor(hs.length / 2)];
    console.log(`[extract-fzk] ${label}: ${dims.length} found, w=[${ws.join(",")}], h=[${hs.join(",")}]`);
    console.log(`[extract-fzk] ${label}: median w=${medW}, h=${medH}`);
    return { w: medW, h: medH };
  }

  const door = summarize(doorDims, "door");
  const win  = summarize(winDims, "window");

  // IFC length unit — check for unit scale (FZK-Haus may use millimetres)
  // If dims > 10 they are likely in mm, convert to m
  const doorW = door.w > 10 ? door.w / 1000 : door.w;
  const doorH = door.h > 10 ? door.h / 1000 : door.h;
  const winW  = win.w > 10 ? win.w / 1000 : win.w;
  const winH  = win.h > 10 ? win.h / 1000 : win.h;

  console.log("\n=== FZK-Sourced Constants for openings.ts ===");
  console.log(`const FZK_DOOR_W   = ${doorW.toFixed(4)};`);
  console.log(`const FZK_DOOR_H   = ${doorH.toFixed(4)};`);
  console.log(`const FZK_WINDOW_W = ${winW.toFixed(4)};`);
  console.log(`const FZK_WINDOW_H = ${winH.toFixed(4)};`);

  api.CloseModel(modelID);
}

main().catch(console.error);
