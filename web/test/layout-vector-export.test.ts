// Phase 13 verification helpers:
//   S_VLE — verify-layout-vector-export: DXF structure, AC1015 format, per-class layer assignment
//   S_CIE — verify-clip-in-export: clipSegByPlanes pure-math fixture tests

import { test, expect } from "bun:test";
import * as THREE from "three";
import { buildLayoutMode, exportLayoutAsDxf } from "../src/shell/layout";
import { clipSegByPlanes } from "../src/viewer/line-clip";

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

// Count occurrences of the pattern `\n0\nFOO\n` in a DXF string.
function countDxfEntity(dxf: string, entityType: string): number {
  return (dxf.match(new RegExp(`\n0\n${entityType}\n`, "g")) ?? []).length;
}

// Count LINE entities on a specific layer. AC1015 DXF structure:
//   0\nLINE\n5\n<handle>\n100\nAcDbEntity\n8\n<LAYER>\n...
// Scan forward up to 12 lines past each LINE entity to find group 8 (layer name).
function countDxfLinesOnLayer(dxf: string, layer: string): number {
  let count = 0;
  const lines = dxf.split("\n");
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i] === "0" && lines[i + 1] === "LINE") {
      // Find group 8 within the next 12 lines.
      for (let j = i + 2; j < Math.min(i + 14, lines.length - 1); j++) {
        if (lines[j] === "8" && lines[j + 1] === layer) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

// ── S_VLE — verify-layout-vector-export ──────────────────────────────────────

test("S_VLE: DXF export — AC1015 version header present", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape" });
  const dxf = exportLayoutAsDxf(host);
  expect(dxf).toContain("AC1015");
  // $ACADVER group code 9 followed by version
  expect(dxf).toContain("$ACADVER");
});

test("S_VLE: DXF export — BORDER and per-class layers defined in TABLES section", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape" });
  const dxf = exportLayoutAsDxf(host);
  expect(dxf).toContain("BORDER");
  // Per-class layers (#1804 AC1015 upgrade — replaces old GEOMETRY layer)
  expect(dxf).toContain("A-SECT-CUT");
  expect(dxf).toContain("A-HIDDEN");
  // LAYER and LTYPE tables present
  expect(dxf).toContain("TABLES");
  expect(dxf).toContain("LAYER");
  expect(dxf).toContain("LTYPE");
});

test("S_VLE: DXF export — well-formed: SECTION/ENDSEC pairs + EOF terminator", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape" });
  const dxf = exportLayoutAsDxf(host);
  const sections = (dxf.match(/(?:^|\n)0\nSECTION\n/g) ?? []).length;
  const endsecs  = (dxf.match(/(?:^|\n)0\nENDSEC\n/g)  ?? []).length;
  expect(sections).toBe(endsecs);
  expect(dxf.trimEnd()).toEndWith("0\nEOF");
});

test("S_VLE: DXF export — panel border emits ≥4 LINE entities on BORDER layer", () => {
  const host = freshHost();
  buildLayoutMode(host, {
    size: "A1",
    orientation: "landscape",
    initialPanels: [
      { x: 100, y: 100, w: 300, h: 200, viewport: "top", scale: "1:50", title: "PLAN" },
    ],
  });
  const dxf = exportLayoutAsDxf(host);
  // Each panel with border !== "none" → 4 border lines
  expect(countDxfLinesOnLayer(dxf, "BORDER")).toBeGreaterThanOrEqual(4);
});

test("S_VLE: DXF export — geometry segments from mock viewer land on A-EDGE layer (fallback)", () => {
  const host = freshHost();
  buildLayoutMode(host, {
    size: "A4",
    orientation: "portrait",
    initialPanels: [
      { x: 50, y: 50, w: 200, h: 150, viewport: "top", scale: "1:50", title: "PLAN" },
    ],
  });
  // Mock viewer without getClassifiedEdgeSegmentsForView → fallback to A-EDGE layer.
  const mockViewer = {
    getEdgeSegmentsForView: (_view: string, _w: number, _h: number): [number, number, number, number][] =>
      [[10, 20, 90, 20], [10, 80, 90, 80]], // 2 horizontal lines
  };
  (window as unknown as Record<string, unknown>).__viewer = mockViewer;
  const dxf = exportLayoutAsDxf(host);
  (window as unknown as Record<string, unknown>).__viewer = undefined;

  // Fallback unclassified edges land on A-EDGE (#1804 AC1015 upgrade).
  const geomCount = countDxfLinesOnLayer(dxf, "A-EDGE");
  expect(geomCount).toBe(2);
  expect(countDxfEntity(dxf, "LINE")).toBeGreaterThanOrEqual(6); // 4 border + 2 geometry
});

test("S_VLE: DXF export — multi-panel sheet: each panel contributes 4 border lines", () => {
  const host = freshHost();
  buildLayoutMode(host, {
    size: "A1",
    orientation: "landscape",
    initialPanels: [
      { x: 50,  y: 50,  w: 300, h: 200, viewport: "top",   scale: "1:100", title: "PLAN" },
      { x: 400, y: 50,  w: 300, h: 200, viewport: "front", scale: "1:100", title: "ELEV" },
    ],
  });
  const dxf = exportLayoutAsDxf(host);
  expect(countDxfLinesOnLayer(dxf, "BORDER")).toBeGreaterThanOrEqual(8); // 2 panels × 4
});

test("S_VLE: DXF export — $EXTMAX reflects sheet dimensions in mm", () => {
  const host = freshHost();
  // A4 portrait: 210 × 297 mm
  buildLayoutMode(host, { size: "A4", orientation: "portrait" });
  const dxf = exportLayoutAsDxf(host);
  expect(dxf).toContain("$EXTMAX");
  // Check both 210 and 297 appear in the DXF near $EXTMAX
  const extMaxIdx = dxf.indexOf("$EXTMAX");
  const chunk = dxf.slice(extMaxIdx, extMaxIdx + 200);
  expect(chunk).toContain("210.");
  expect(chunk).toContain("297.");
});

// ── S_CIE — verify-clip-in-export ────────────────────────────────────────────
// Tests the pure Liang-Barsky clip math exported from line-clip.ts.

test("S_CIE: clipSegByPlanes — no planes: segment passes through unchanged", () => {
  const a = new THREE.Vector3(0, 0, 0);
  const b = new THREE.Vector3(10, 0, 0);
  const result = clipSegByPlanes(a, b, []);
  expect(result).not.toBeNull();
  expect(result![0].x).toBeCloseTo(0);
  expect(result![1].x).toBeCloseTo(10);
});

test("S_CIE: clipSegByPlanes — segment fully inside one plane: passes unchanged", () => {
  // Plane: X >= 0 (normal = +X, constant = 0)
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const a = new THREE.Vector3(1, 0, 0);
  const b = new THREE.Vector3(5, 0, 0);
  const result = clipSegByPlanes(a, b, [plane]);
  expect(result).not.toBeNull();
  expect(result![0].x).toBeCloseTo(1);
  expect(result![1].x).toBeCloseTo(5);
});

test("S_CIE: clipSegByPlanes — segment fully outside: returns null", () => {
  // Plane: X >= 0; segment at X = -5 to X = -1 (all negative)
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const a = new THREE.Vector3(-5, 0, 0);
  const b = new THREE.Vector3(-1, 0, 0);
  expect(clipSegByPlanes(a, b, [plane])).toBeNull();
});

test("S_CIE: clipSegByPlanes — segment crossing plane: clipped to intersection", () => {
  // Plane: X >= 0; segment from X=-3 to X=7 → clipped to X=0..7
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const a = new THREE.Vector3(-3, 0, 0);
  const b = new THREE.Vector3(7, 0, 0);
  const result = clipSegByPlanes(a, b, [plane]);
  expect(result).not.toBeNull();
  expect(result![0].x).toBeCloseTo(0, 5);
  expect(result![1].x).toBeCloseTo(7, 5);
});

test("S_CIE: clipSegByPlanes — two opposing planes form a slab, clips correctly", () => {
  // X >= -2 (plane normal=+X, const=2) AND X <= 5 (plane normal=-X, const=-5)
  // i.e. only X in [-2, 5] is inside
  const planeMin = new THREE.Plane(new THREE.Vector3(1, 0, 0), 2);  // dist = x + 2 >= 0 ⟹ x >= -2
  const planeMax = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 5); // dist = -x + 5 >= 0 ⟹ x <= 5
  // Segment from X=-10 to X=10 should be clipped to X=-2..5
  const a = new THREE.Vector3(-10, 0, 0);
  const b = new THREE.Vector3(10, 0, 0);
  const result = clipSegByPlanes(a, b, [planeMin, planeMax]);
  expect(result).not.toBeNull();
  expect(result![0].x).toBeCloseTo(-2, 4);
  expect(result![1].x).toBeCloseTo(5, 4);
});

test("S_CIE: clipSegByPlanes — segment parallel and outside plane: null", () => {
  // Plane: X >= 0; segment at X=-1 running along Y
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const a = new THREE.Vector3(-1, 0, 0);
  const b = new THREE.Vector3(-1, 5, 0);
  expect(clipSegByPlanes(a, b, [plane])).toBeNull();
});

test("S_CIE: clipSegByPlanes — segment parallel and on plane boundary: passes", () => {
  // Plane: X >= 0; segment exactly at X=0 — distanceToPoint = 0 (on boundary = inside)
  const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  const a = new THREE.Vector3(0, 0, 0);
  const b = new THREE.Vector3(0, 5, 0);
  const result = clipSegByPlanes(a, b, [plane]);
  expect(result).not.toBeNull();
});

test("S_CIE: clipSegByPlanes — Z-clip plane for section cut removes geometry above cut", () => {
  // Section plane at Z=2: normal=-Z, const=2 → only Z <= 2 is inside
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 2);
  // Segment from Z=0 to Z=5: only Z=0..2 should survive
  const a = new THREE.Vector3(0, 0, 0);
  const b = new THREE.Vector3(0, 0, 5);
  const result = clipSegByPlanes(a, b, [sectionPlane]);
  expect(result).not.toBeNull();
  expect(result![0].z).toBeCloseTo(0, 5);
  expect(result![1].z).toBeCloseTo(2, 5);
});

test("S_CIE: clipSegByPlanes — geometry entirely above section cut: null", () => {
  // Section plane at Z=2: only Z <= 2 inside; segment at Z=3..6 → fully outside
  const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 2);
  const a = new THREE.Vector3(0, 0, 3);
  const b = new THREE.Vector3(0, 0, 6);
  expect(clipSegByPlanes(a, b, [sectionPlane])).toBeNull();
});
