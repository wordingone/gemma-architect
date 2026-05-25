// Regression-net: #1805/#1848/#1850 — SheetTemplate interface + applySheetCut.
// Tests: SheetTemplate type shape, DEMO_SHEET_SET (4 elevations #1850 + 4 sections #1848),
// applySheetCut clip-plane configuration per viewType (plan/rcp/section/elevation/3d).

import { test, expect, describe } from "bun:test";
import type { SheetTemplate, SheetLevelRef, SectionAxis } from "../src/shell/layout";
import {
  DEMO_SHEET_SET,
  applySheetCut,
  resetSheetCut,
} from "../src/shell/layout";

// ── Mock viewer — captures clip-plane calls ─────────────────────────────────

interface ClipCall {
  origin: [number, number, number];
  normal: [number, number, number];
  label?: string;
}

interface SectionBoxCall {
  min: [number, number, number];
  max: [number, number, number];
}

function makeMockViewer() {
  const state = {
    clearClippingPlanesCalled: 0,
    clearSectionBoxCalled: 0,
    setSectionBoxCalled: 0,
    clipCalls: [] as ClipCall[],
    sectionBoxCalls: [] as SectionBoxCall[],
    sceneBounds: null as { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null,
  };
  const viewer = {
    clearClippingPlanes() { state.clearClippingPlanesCalled++; state.clipCalls = []; },
    clearSectionBox() { state.clearSectionBoxCalled++; state.sectionBoxCalls = []; },
    setSectionBox(min: [number, number, number], max: [number, number, number]) {
      state.setSectionBoxCalled++;
      state.sectionBoxCalls.push({ min, max });
    },
    addClippingPlane(origin: [number, number, number], normal: [number, number, number], label?: string) {
      state.clipCalls.push({ origin, normal, label });
    },
    getSceneBounds() { return state.sceneBounds; },
  };
  return { viewer, state };
}

// ── DEMO_SHEET_SET shape ────────────────────────────────────────────────────

describe("DEMO_SHEET_SET", () => {
  test("has exactly 8 sheets: 4 elevations (#1850) + 4 sections (#1848)", () => {
    expect(DEMO_SHEET_SET).toHaveLength(8);
  });

  test("IDs are S1 through S8 in order", () => {
    const ids = DEMO_SHEET_SET.map((s) => s.id);
    expect(ids).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
  });

  test("first 4 sheets are elevation views", () => {
    const elevations = DEMO_SHEET_SET.slice(0, 4);
    expect(elevations.every((s) => s.viewType === "elevation")).toBe(true);
  });

  test("last 4 sheets are section views (#1848)", () => {
    const sections = DEMO_SHEET_SET.slice(4);
    expect(sections.every((s) => s.viewType === "section")).toBe(true);
  });

  test("elevation cardinal dirs are N/E/S/W in order", () => {
    expect(DEMO_SHEET_SET.slice(0, 4).map((s) => s.cardinalDir)).toEqual(["N", "E", "S", "W"]);
  });

  test("section axis values are NS-1/NS-2/EW-1/EW-2 in order", () => {
    const axes = DEMO_SHEET_SET.slice(4).map((s) => s.sectionAxis);
    expect(axes).toEqual(["NS-1", "NS-2", "EW-1", "EW-2"] satisfies SectionAxis[]);
  });

  test("elevation titles follow 'Elevation: <Dir>' format", () => {
    expect(DEMO_SHEET_SET[0].title).toBe("Elevation: North");
    expect(DEMO_SHEET_SET[1].title).toBe("Elevation: East");
    expect(DEMO_SHEET_SET[2].title).toBe("Elevation: South");
    expect(DEMO_SHEET_SET[3].title).toBe("Elevation: West");
  });

  test("section titles are Section A-A through D-D", () => {
    expect(DEMO_SHEET_SET[4].title).toBe("Section A-A");
    expect(DEMO_SHEET_SET[5].title).toBe("Section B-B");
    expect(DEMO_SHEET_SET[6].title).toBe("Section C-C");
    expect(DEMO_SHEET_SET[7].title).toBe("Section D-D");
  });

  test("N/S elevations and NS sections use camera front", () => {
    expect(DEMO_SHEET_SET[0].camera).toBe("front"); // N elevation
    expect(DEMO_SHEET_SET[2].camera).toBe("front"); // S elevation
    expect(DEMO_SHEET_SET[4].camera).toBe("front"); // Section A-A (NS-1)
    expect(DEMO_SHEET_SET[5].camera).toBe("front"); // Section B-B (NS-2)
  });

  test("E/W elevations and EW sections use camera right", () => {
    expect(DEMO_SHEET_SET[1].camera).toBe("right"); // E elevation
    expect(DEMO_SHEET_SET[3].camera).toBe("right"); // W elevation
    expect(DEMO_SHEET_SET[6].camera).toBe("right"); // Section C-C (EW-1)
    expect(DEMO_SHEET_SET[7].camera).toBe("right"); // Section D-D (EW-2)
  });

  test("all sheets have non-empty titles", () => {
    for (const s of DEMO_SHEET_SET) {
      expect(s.title.trim().length).toBeGreaterThan(0);
    }
  });

  test("all sheets conform to SheetTemplate type", () => {
    for (const s of DEMO_SHEET_SET) {
      const typed: SheetTemplate = s;
      expect(typeof typed.id).toBe("string");
      expect(typeof typed.viewType).toBe("string");
      expect(typeof typed.camera).toBe("string");
    }
  });
});

// ── applySheetCut — plan view ──────────────────────────────────────────────

describe("applySheetCut — plan", () => {
  test("calls clearClippingPlanes and clearSectionBox before applying", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = { id: "S1", viewType: "plan", title: "Plan L1", levelId: "L1", cutOffset: 1.372, camera: "top" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t, { L1: { elevation: 0 } });
    expect(state.clearClippingPlanesCalled).toBeGreaterThanOrEqual(1);
    expect(state.clearSectionBoxCalled).toBeGreaterThanOrEqual(1);
  });

  test("calls setSectionBox with Z range [elevation, elevation + cutOffset]", () => {
    const { viewer, state } = makeMockViewer();
    const levels: Record<string, SheetLevelRef> = { "level/0": { elevation: 0 } };
    const t: SheetTemplate = { id: "S1", viewType: "plan", title: "Plan L1", levelId: "level/0", cutOffset: 1.372, camera: "top" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t, levels);
    expect(state.setSectionBoxCalled).toBe(1);
    const [min, max] = [state.sectionBoxCalls[0].min, state.sectionBoxCalls[0].max];
    expect(min[2]).toBeCloseTo(0);
    expect(max[2]).toBeCloseTo(1.372);
  });

  test("plan with level elevation 3m: sectionBox Z range is 3..4.372", () => {
    const { viewer, state } = makeMockViewer();
    const levels: Record<string, SheetLevelRef> = { "level/1": { elevation: 3.0 } };
    const t: SheetTemplate = { id: "S2", viewType: "plan", title: "Plan L2", levelId: "level/1", cutOffset: 1.372, camera: "top" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t, levels);
    const { min, max } = state.sectionBoxCalls[0];
    expect(min[2]).toBeCloseTo(3.0);
    expect(max[2]).toBeCloseTo(3.0 + 1.372);
  });

  test("plan without levelId uses elevation 0 as fallback", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = { id: "S1", viewType: "plan", title: "Plan", camera: "top" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t, {});
    expect(state.setSectionBoxCalled).toBe(1);
    expect(state.sectionBoxCalls[0].min[2]).toBeCloseTo(0);
  });

  test("plan does NOT call addClippingPlane", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = { id: "S1", viewType: "plan", title: "Plan", levelId: "L1", cutOffset: 1.0, camera: "top" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t, { L1: { elevation: 0 } });
    expect(state.clipCalls).toHaveLength(0);
  });
});

// ── applySheetCut — section view ───────────────────────────────────────────

describe("applySheetCut — section", () => {
  test("adds front clip plane with origin + normal", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = {
      id: "S3", viewType: "section", title: "Section A-A",
      origin: [0, 5, 0], normal: [0, -1, 0], farClip: 30, camera: "front",
    };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls.length).toBeGreaterThanOrEqual(1);
    expect(state.clipCalls[0].origin).toEqual([0, 5, 0]);
    expect(state.clipCalls[0].normal).toEqual([0, -1, 0]);
    expect(state.clipCalls[0].label).toBe("sheet-front");
  });

  test("adds back clip plane at origin + normal * farClip, with reversed normal", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = {
      id: "S3", viewType: "section", title: "Section A-A",
      origin: [0, 0, 0], normal: [0, -1, 0], farClip: 30, camera: "front",
    };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls).toHaveLength(2);
    const back = state.clipCalls[1];
    expect(back.origin[1]).toBeCloseTo(-30); // 0 + (-1)*30
    expect(back.normal[1]).toBeCloseTo(1);   // reversed: [0, 1, 0]
    expect(back.label).toBe("sheet-back");
  });

  test("section without farClip adds only one clip plane", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = {
      id: "S3", viewType: "section", title: "Section A-A",
      origin: [0, 0, 0], normal: [0, -1, 0], camera: "front",
    };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls).toHaveLength(1);
  });

  test("section does NOT call setSectionBox", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = {
      id: "S3", viewType: "section", title: "Section A-A",
      origin: [0, 0, 0], normal: [0, -1, 0], camera: "front",
    };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.setSectionBoxCalled).toBe(0);
  });
});

// ── applySheetCut — section with sectionAxis (#1848) ─────────────────────────

describe("applySheetCut — section with sectionAxis", () => {
  function makeViewerWithBounds(minX: number, minY: number, maxX: number, maxY: number, z = 0) {
    const { viewer, state } = makeMockViewer();
    state.sceneBounds = { min: { x: minX, y: minY, z }, max: { x: maxX, y: maxY, z: 6 } };
    return { viewer, state };
  }

  // Bounds: x in [0,30], y in [0,20], spanX=30, spanY=20
  const bounds = { minX: 0, minY: 0, maxX: 30, maxY: 20 };
  const cx = 15; // (0+30)/2
  const cy = 10; // (0+20)/2

  test("NS-1: origin.y at 1/3 of spanY = 20/3 ≈ 6.67 from minY", () => {
    const { viewer, state } = makeViewerWithBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    const t: SheetTemplate = { id: "S5", viewType: "section", title: "Section A-A", sectionAxis: "NS-1", camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].origin[0]).toBeCloseTo(cx);
    expect(state.clipCalls[0].origin[1]).toBeCloseTo(20 / 3);
    expect(state.clipCalls[0].normal).toEqual([0, -1, 0]);
  });

  test("NS-2: origin.y at 2/3 of spanY = 40/3 ≈ 13.33 from minY", () => {
    const { viewer, state } = makeViewerWithBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    const t: SheetTemplate = { id: "S6", viewType: "section", title: "Section B-B", sectionAxis: "NS-2", camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].origin[1]).toBeCloseTo(40 / 3);
    expect(state.clipCalls[0].normal).toEqual([0, -1, 0]);
  });

  test("EW-1: origin.x at 1/3 of spanX = 10 from minX", () => {
    const { viewer, state } = makeViewerWithBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    const t: SheetTemplate = { id: "S7", viewType: "section", title: "Section C-C", sectionAxis: "EW-1", camera: "right" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].origin[0]).toBeCloseTo(10);
    expect(state.clipCalls[0].origin[1]).toBeCloseTo(cy);
    expect(state.clipCalls[0].normal).toEqual([-1, 0, 0]);
  });

  test("EW-2: origin.x at 2/3 of spanX = 20 from minX", () => {
    const { viewer, state } = makeViewerWithBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    const t: SheetTemplate = { id: "S8", viewType: "section", title: "Section D-D", sectionAxis: "EW-2", camera: "right" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].origin[0]).toBeCloseTo(20);
    expect(state.clipCalls[0].normal).toEqual([-1, 0, 0]);
  });

  test("sectionAxis auto-computes farClip from span and adds back plane", () => {
    const { viewer, state } = makeViewerWithBounds(0, 0, 30, 20);
    const t: SheetTemplate = { id: "S5", viewType: "section", title: "Section A-A", sectionAxis: "NS-1", camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls).toHaveLength(2);  // front + back auto-added
    expect(state.clipCalls[1].label).toBe("sheet-back");
    // back normal reversed from [0,-1,0] → [0,1,0]; use toBeCloseTo to avoid -0 vs 0 issues
    expect(state.clipCalls[1].normal[0]).toBeCloseTo(0);
    expect(state.clipCalls[1].normal[1]).toBeCloseTo(1);
    expect(state.clipCalls[1].normal[2]).toBeCloseTo(0);
  });

  test("explicit farClip on template overrides auto-computed value", () => {
    const { viewer, state } = makeViewerWithBounds(0, 0, 30, 20);
    const t: SheetTemplate = { id: "S5", viewType: "section", title: "Section A-A", sectionAxis: "NS-1", farClip: 5, camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    // back origin.y = 1/3*20 + (-1)*5 = 6.67 - 5 = 1.67
    expect(state.clipCalls[1].origin[1]).toBeCloseTo(20 / 3 - 5);
  });

  test("sectionAxis without scene bounds falls back to span=20 defaults", () => {
    const { viewer, state } = makeMockViewer(); // no bounds set
    const t: SheetTemplate = { id: "S5", viewType: "section", title: "Section A-A", sectionAxis: "NS-1", camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    // spanY default = 20, minY = -10 → y_cut = -10 + 20/3 ≈ -3.33
    expect(state.clipCalls[0].origin[1]).toBeCloseTo(-10 + 20 / 3);
    expect(state.clipCalls).toHaveLength(2); // auto farClip = 20*1.1 = 22 → back added
  });
});

// ── applySheetCut — elevation view ─────────────────────────────────────────

describe("applySheetCut — elevation with cardinalDir", () => {
  function makeMockViewerWithBounds(bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }) {
    const { viewer, state } = makeMockViewer();
    state.sceneBounds = bounds;
    return { viewer, state };
  }

  test("N elevation: normal is (0,-1,0) — viewer looks south toward north face", () => {
    const { viewer, state } = makeMockViewerWithBounds({ min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 6 } });
    const t: SheetTemplate = { id: "S5", viewType: "elevation", title: "Elev N", cardinalDir: "N", farClip: 40, camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].normal).toEqual([0, -1, 0]);
  });

  test("S elevation: normal is (0,1,0)", () => {
    const { viewer, state } = makeMockViewerWithBounds({ min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 6 } });
    const t: SheetTemplate = { id: "S6", viewType: "elevation", title: "Elev S", cardinalDir: "S", farClip: 40, camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].normal).toEqual([0, 1, 0]);
  });

  test("E elevation: normal is (-1,0,0)", () => {
    const { viewer, state } = makeMockViewerWithBounds({ min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 6 } });
    const t: SheetTemplate = { id: "S7", viewType: "elevation", title: "Elev E", cardinalDir: "E", farClip: 40, camera: "right" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].normal).toEqual([-1, 0, 0]);
  });

  test("W elevation: normal is (1,0,0)", () => {
    const { viewer, state } = makeMockViewerWithBounds({ min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 6 } });
    const t: SheetTemplate = { id: "S8", viewType: "elevation", title: "Elev W", cardinalDir: "W", farClip: 40, camera: "right" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls[0].normal).toEqual([1, 0, 0]);
  });

  test("elevation with farClip adds back clip plane", () => {
    const { viewer, state } = makeMockViewerWithBounds({ min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 6 } });
    const t: SheetTemplate = { id: "S5", viewType: "elevation", title: "Elev N", cardinalDir: "N", farClip: 40, camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clipCalls).toHaveLength(2);
    expect(state.clipCalls[1].label).toBe("sheet-back");
  });
});

// ── applySheetCut — 3d view ────────────────────────────────────────────────

describe("applySheetCut — 3d (no cut)", () => {
  test("does not call setSectionBox or addClippingPlane", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = { id: "S0", viewType: "3d", title: "Perspective", camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.setSectionBoxCalled).toBe(0);
    expect(state.clipCalls).toHaveLength(0);
  });

  test("still calls clearClippingPlanes and clearSectionBox", () => {
    const { viewer, state } = makeMockViewer();
    const t: SheetTemplate = { id: "S0", viewType: "3d", title: "Perspective", camera: "front" };
    applySheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer, t);
    expect(state.clearClippingPlanesCalled).toBeGreaterThanOrEqual(1);
    expect(state.clearSectionBoxCalled).toBeGreaterThanOrEqual(1);
  });
});

// ── resetSheetCut ──────────────────────────────────────────────────────────

describe("resetSheetCut", () => {
  test("calls clearClippingPlanes and clearSectionBox", () => {
    const { viewer, state } = makeMockViewer();
    resetSheetCut(viewer as unknown as import("../src/viewer/viewer").Viewer);
    expect(state.clearClippingPlanesCalled).toBeGreaterThanOrEqual(1);
    expect(state.clearSectionBoxCalled).toBeGreaterThanOrEqual(1);
  });
});
