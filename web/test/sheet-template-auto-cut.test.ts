// Regression-net: #1805 — SheetTemplate interface + applySheetCut.
// Tests: SheetTemplate type shape, DEMO_SHEET_SET 8-sheet set, applySheetCut
// clip-plane configuration per viewType (plan/section/elevation/3d).

import { test, expect, describe } from "bun:test";
import type { SheetTemplate, SheetLevelRef } from "../src/shell/layout";
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
  test("has exactly 8 sheets", () => {
    expect(DEMO_SHEET_SET).toHaveLength(8);
  });

  test("IDs are S1 through S8 in order", () => {
    const ids = DEMO_SHEET_SET.map((s) => s.id);
    expect(ids).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
  });

  test("S1 and S2 are plan views", () => {
    expect(DEMO_SHEET_SET[0].viewType).toBe("plan");
    expect(DEMO_SHEET_SET[1].viewType).toBe("plan");
  });

  test("S1 references level/0, S2 references level/1", () => {
    expect(DEMO_SHEET_SET[0].levelId).toBe("level/0");
    expect(DEMO_SHEET_SET[1].levelId).toBe("level/1");
  });

  test("S1 and S2 have cutOffset 1.372 (4'6\")", () => {
    expect(DEMO_SHEET_SET[0].cutOffset).toBeCloseTo(1.372);
    expect(DEMO_SHEET_SET[1].cutOffset).toBeCloseTo(1.372);
  });

  test("S3 and S4 are section views", () => {
    expect(DEMO_SHEET_SET[2].viewType).toBe("section");
    expect(DEMO_SHEET_SET[3].viewType).toBe("section");
  });

  test("S5–S8 are elevation views with cardinal dirs N/S/E/W", () => {
    const elev = DEMO_SHEET_SET.slice(4);
    expect(elev.every((s) => s.viewType === "elevation")).toBe(true);
    expect(elev.map((s) => s.cardinalDir)).toEqual(["N", "S", "E", "W"]);
  });

  test("plan sheets use camera top", () => {
    expect(DEMO_SHEET_SET[0].camera).toBe("top");
    expect(DEMO_SHEET_SET[1].camera).toBe("top");
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
