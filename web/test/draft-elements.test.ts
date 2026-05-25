// Regression-net: #1852 — 2D drafting palette element data model.
// Tests: DraftElement construction shapes, DraftElementStore CRUD,
//        layerId assignment, 2D snap candidates, getActiveDraftTool.

import { test, expect, describe, beforeEach } from "bun:test";
import {
  draftElementStore,
  newDraftElementId,
  setActiveDraftTool,
  getActiveDraftTool,
  get2dSnapCandidates,
  nearestSnapCandidate,
  type DraftLine,
  type DraftArc,
  type DraftCircle,
  type DraftEllipse,
  type DraftPolyline,
  type DraftSpline,
  type DraftPoint,
  type DraftText,
  type DraftMText,
  type DraftLeader,
  type DraftMLeader,
  type DraftDimLinear,
  type DraftDimAligned,
  type DraftDimAngular,
  type DraftDimRadial,
  type DraftDimDiametric,
  type DraftDimArcLength,
  type DraftDimOrdinate,
  type DraftHatch,
  type DraftWipeout,
  type DraftInsert,
  type DraftImage,
} from "../src/shell/draft-elements";

// Reset store by removing all elements from test sheet before each test.
const TEST_SHEET = "sheet/test";
const TEST_LAYER = "default";

beforeEach(() => {
  const els = draftElementStore.getBySheet(TEST_SHEET);
  for (const e of els) draftElementStore.remove(TEST_SHEET, e.id);
  setActiveDraftTool(null);
});

// ── Element construction shapes ─────────────────────────────────────────────

describe("RS_Line — 2 endpoints", () => {
  test("line has kind RS_Line and two endpoint fields", () => {
    const line: DraftLine = {
      kind: "RS_Line",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      p1: { x: 0, y: 0 },
      p2: { x: 100, y: 50 },
    };
    expect(line.kind).toBe("RS_Line");
    expect(line.p1).toEqual({ x: 0, y: 0 });
    expect(line.p2).toEqual({ x: 100, y: 50 });
  });

  test("add RS_Line → getBySheet returns it", () => {
    const line: DraftLine = { kind: "RS_Line", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, p1: { x: 0, y: 0 }, p2: { x: 50, y: 0 } };
    draftElementStore.add(line);
    const items = draftElementStore.getBySheet(TEST_SHEET);
    expect(items.length).toBe(1);
    expect(items[0].kind).toBe("RS_Line");
  });
});

describe("RS_Arc", () => {
  test("arc has center, radius, startAngle, endAngle, cw", () => {
    const arc: DraftArc = {
      kind: "RS_Arc",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      center: { x: 50, y: 50 },
      radius: 25,
      startAngle: 0,
      endAngle: Math.PI,
      cw: false,
    };
    expect(arc.kind).toBe("RS_Arc");
    expect(arc.radius).toBe(25);
    expect(arc.endAngle).toBeCloseTo(Math.PI);
  });
});

describe("RS_Circle", () => {
  test("circle has center and radius", () => {
    const circle: DraftCircle = {
      kind: "RS_Circle",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      center: { x: 30, y: 30 },
      radius: 20,
    };
    expect(circle.kind).toBe("RS_Circle");
    expect(circle.radius).toBe(20);
  });
});

describe("RS_Ellipse", () => {
  test("ellipse has center, majorRadius, minorRadius, rotation", () => {
    const ellipse: DraftEllipse = {
      kind: "RS_Ellipse",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      center: { x: 50, y: 50 },
      majorRadius: 40,
      minorRadius: 20,
      rotation: 0,
    };
    expect(ellipse.kind).toBe("RS_Ellipse");
    expect(ellipse.majorRadius).toBe(40);
    expect(ellipse.minorRadius).toBe(20);
  });
});

describe("RS_Polyline", () => {
  test("polyline has pts array and closed flag", () => {
    const poly: DraftPolyline = {
      kind: "RS_Polyline",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }],
      closed: false,
    };
    expect(poly.kind).toBe("RS_Polyline");
    expect(poly.pts.length).toBe(3);
    expect(poly.closed).toBe(false);
  });
});

describe("RS_Spline", () => {
  test("spline has controlPoints, degree, closed", () => {
    const spline: DraftSpline = {
      kind: "RS_Spline",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      controlPoints: [{ x: 0, y: 0 }, { x: 25, y: 50 }, { x: 50, y: 0 }],
      degree: 3,
      closed: false,
    };
    expect(spline.kind).toBe("RS_Spline");
    expect(spline.controlPoints.length).toBe(3);
    expect(spline.degree).toBe(3);
  });
});

describe("RS_Point", () => {
  test("point has pt field", () => {
    const pt: DraftPoint = {
      kind: "RS_Point",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      pt: { x: 15, y: 20 },
    };
    expect(pt.kind).toBe("RS_Point");
    expect(pt.pt).toEqual({ x: 15, y: 20 });
  });
});

describe("RS_Text", () => {
  test("text has origin, content, height, angle", () => {
    const text: DraftText = {
      kind: "RS_Text",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      origin: { x: 10, y: 10 },
      content: "Living Room",
      height: 3.5,
      angle: 0,
    };
    expect(text.kind).toBe("RS_Text");
    expect(text.content).toBe("Living Room");
    expect(text.height).toBe(3.5);
  });
});

describe("RS_MText", () => {
  test("mtext has origin, content, height, width, angle", () => {
    const mt: DraftMText = {
      kind: "RS_MText",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      origin: { x: 0, y: 0 },
      content: "Notes:\\nSee specifications",
      height: 3,
      width: 100,
      angle: 0,
    };
    expect(mt.kind).toBe("RS_MText");
    expect(mt.width).toBe(100);
  });
});

describe("RS_Leader", () => {
  test("leader has pts array", () => {
    const leader: DraftLeader = {
      kind: "RS_Leader",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      pts: [{ x: 20, y: 20 }, { x: 60, y: 60 }],
      annotation: "Detail A",
    };
    expect(leader.kind).toBe("RS_Leader");
    expect(leader.pts.length).toBe(2);
  });
});

describe("RS_MLeader", () => {
  test("mleader has pts array and annotation", () => {
    const ml: DraftMLeader = {
      kind: "RS_MLeader",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      pts: [{ x: 10, y: 10 }, { x: 40, y: 40 }],
      annotation: "Structural column",
    };
    expect(ml.kind).toBe("RS_MLeader");
    expect(ml.annotation).toBe("Structural column");
  });
});

describe("RS_DimLinear", () => {
  test("dim-linear has ext1, ext2, dimLine, angle", () => {
    const dim: DraftDimLinear = {
      kind: "RS_DimLinear",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      ext1: { x: 0, y: 0 },
      ext2: { x: 100, y: 0 },
      dimLine: { x: 50, y: -10 },
      angle: 0,
    };
    expect(dim.kind).toBe("RS_DimLinear");
    expect(dim.ext2.x).toBe(100);
  });
});

describe("RS_DimAligned", () => {
  test("dim-aligned has ext1, ext2, dimLine", () => {
    const dim: DraftDimAligned = {
      kind: "RS_DimAligned",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      ext1: { x: 0, y: 0 },
      ext2: { x: 80, y: 60 },
      dimLine: { x: 40, y: 30 },
    };
    expect(dim.kind).toBe("RS_DimAligned");
  });
});

describe("RS_DimAngular", () => {
  test("dim-angular has center, ext1, ext2, dimArc", () => {
    const dim: DraftDimAngular = {
      kind: "RS_DimAngular",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      center: { x: 50, y: 50 },
      ext1: { x: 100, y: 50 },
      ext2: { x: 50, y: 100 },
      dimArc: { x: 80, y: 80 },
    };
    expect(dim.kind).toBe("RS_DimAngular");
    expect(dim.center).toEqual({ x: 50, y: 50 });
  });
});

describe("RS_DimRadial", () => {
  test("dim-radial has center and ref", () => {
    const dim: DraftDimRadial = {
      kind: "RS_DimRadial",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      center: { x: 50, y: 50 },
      ref: { x: 75, y: 50 },
    };
    expect(dim.kind).toBe("RS_DimRadial");
    expect(dim.ref.x).toBe(75);
  });
});

describe("RS_DimDiametric", () => {
  test("dim-diametric has def and ref (opposite ends)", () => {
    const dim: DraftDimDiametric = {
      kind: "RS_DimDiametric",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      def: { x: 25, y: 50 },
      ref: { x: 75, y: 50 },
    };
    expect(dim.kind).toBe("RS_DimDiametric");
  });
});

describe("RS_DimArcLength", () => {
  test("dim-arc-length has center, p1, p2, dimArc", () => {
    const dim: DraftDimArcLength = {
      kind: "RS_DimArcLength",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      center: { x: 50, y: 50 },
      p1: { x: 75, y: 50 },
      p2: { x: 50, y: 75 },
      dimArc: { x: 85, y: 85 },
    };
    expect(dim.kind).toBe("RS_DimArcLength");
  });
});

describe("RS_DimOrdinate", () => {
  test("dim-ordinate has def, feature, direction", () => {
    const dim: DraftDimOrdinate = {
      kind: "RS_DimOrdinate",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      def: { x: 0, y: 0 },
      feature: { x: 0, y: -20 },
      direction: "y",
    };
    expect(dim.kind).toBe("RS_DimOrdinate");
    expect(dim.direction).toBe("y");
  });
});

describe("RS_Hatch — boundary loop", () => {
  test("hatch has boundary (outer loop array), pattern, scale, angle", () => {
    const hatch: DraftHatch = {
      kind: "RS_Hatch",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      boundary: [
        [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      ],
      pattern: "line",
      scale: 1.0,
      angle: 0,
    };
    expect(hatch.kind).toBe("RS_Hatch");
    expect(hatch.boundary.length).toBe(1);
    expect(hatch.boundary[0].length).toBe(4);
    expect(hatch.pattern).toBe("line");
  });

  test("hatch supports multi-loop boundaries (outer + hole)", () => {
    const hatch: DraftHatch = {
      kind: "RS_Hatch",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      boundary: [
        [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 }, { x: 0, y: 200 }],
        [{ x: 50, y: 50 }, { x: 150, y: 50 }, { x: 150, y: 150 }, { x: 50, y: 150 }],
      ],
      pattern: "solid",
      scale: 1,
      angle: 0,
    };
    expect(hatch.boundary.length).toBe(2);
  });

  test("hatch supports all four patterns", () => {
    const patterns: DraftHatch["pattern"][] = ["line", "dot", "brick", "solid"];
    for (const p of patterns) {
      const h: DraftHatch = { kind: "RS_Hatch", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, boundary: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]], pattern: p, scale: 1, angle: 0 };
      expect(h.pattern).toBe(p);
    }
  });
});

describe("RS_Wipeout", () => {
  test("wipeout has closed boundary polygon", () => {
    const wo: DraftWipeout = {
      kind: "RS_Wipeout",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      boundary: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 }],
    };
    expect(wo.kind).toBe("RS_Wipeout");
    expect(wo.boundary.length).toBe(4);
  });
});

describe("RS_Insert (block-insert)", () => {
  test("insert has blockId, origin, scale, angle", () => {
    const ins: DraftInsert = {
      kind: "RS_Insert",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      blockId: "block/north-arrow",
      origin: { x: 200, y: 10 },
      scale: { x: 1, y: 1 },
      angle: 0,
    };
    expect(ins.kind).toBe("RS_Insert");
    expect(ins.blockId).toBe("block/north-arrow");
    expect(ins.scale).toEqual({ x: 1, y: 1 });
  });
});

describe("RS_Image", () => {
  test("image has origin, width, height, url, angle", () => {
    const img: DraftImage = {
      kind: "RS_Image",
      id: newDraftElementId(),
      sheetId: TEST_SHEET,
      layerId: TEST_LAYER,
      origin: { x: 0, y: 0 },
      width: 150,
      height: 100,
      url: "photos/site-photo.jpg",
      angle: 0,
    };
    expect(img.kind).toBe("RS_Image");
    expect(img.width).toBe(150);
    expect(img.url).toBe("photos/site-photo.jpg");
  });
});

// ── DraftElementStore CRUD ───────────────────────────────────────────────────

describe("DraftElementStore CRUD", () => {
  test("add element → getBySheet returns it", () => {
    const el: DraftLine = { kind: "RS_Line", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, p1: { x: 0, y: 0 }, p2: { x: 10, y: 10 } };
    draftElementStore.add(el);
    expect(draftElementStore.getBySheet(TEST_SHEET).length).toBe(1);
  });

  test("remove element → getBySheet returns empty", () => {
    const el: DraftLine = { kind: "RS_Line", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, p1: { x: 0, y: 0 }, p2: { x: 10, y: 10 } };
    draftElementStore.add(el);
    draftElementStore.remove(TEST_SHEET, el.id);
    expect(draftElementStore.getBySheet(TEST_SHEET).length).toBe(0);
  });

  test("remove returns false for unknown id", () => {
    expect(draftElementStore.remove(TEST_SHEET, "nonexistent")).toBe(false);
  });

  test("getBySheet returns [] for sheet with no elements", () => {
    expect(draftElementStore.getBySheet("sheet/empty")).toEqual([]);
  });

  test("multiple elements on same sheet — all returned", () => {
    for (let i = 0; i < 3; i++) {
      draftElementStore.add({ kind: "RS_Line", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, p1: { x: i, y: 0 }, p2: { x: i + 1, y: 0 } });
    }
    expect(draftElementStore.getBySheet(TEST_SHEET).length).toBe(3);
  });

  test("elements on different sheets don't bleed across", () => {
    draftElementStore.add({ kind: "RS_Line", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, p1: { x: 0, y: 0 }, p2: { x: 5, y: 5 } });
    draftElementStore.add({ kind: "RS_Point", id: newDraftElementId(), sheetId: "sheet/other", layerId: TEST_LAYER, pt: { x: 0, y: 0 } });
    expect(draftElementStore.getBySheet(TEST_SHEET).length).toBe(1);
    expect(draftElementStore.getBySheet("sheet/other").length).toBe(1);
    // cleanup
    for (const e of draftElementStore.getBySheet("sheet/other")) draftElementStore.remove("sheet/other", e.id);
  });

  test("update element patches in place", () => {
    const el: DraftLine = { kind: "RS_Line", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } };
    draftElementStore.add(el);
    draftElementStore.update(TEST_SHEET, el.id, { p2: { x: 50, y: 0 } } as Partial<DraftLine>);
    const updated = draftElementStore.get(TEST_SHEET, el.id) as DraftLine;
    expect(updated.p2.x).toBe(50);
  });

  test("update returns false for unknown id", () => {
    expect(draftElementStore.update(TEST_SHEET, "ghost", {})).toBe(false);
  });

  test("subscribe fires on add", () => {
    let fired = 0;
    const unsub = draftElementStore.subscribe(() => fired++);
    draftElementStore.add({ kind: "RS_Point", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: TEST_LAYER, pt: { x: 0, y: 0 } });
    unsub();
    expect(fired).toBeGreaterThan(0);
  });
});

// ── layerId assignment ───────────────────────────────────────────────────────

describe("layerId", () => {
  test("element carries the layerId it was created with", () => {
    const el: DraftLine = { kind: "RS_Line", id: newDraftElementId(), sheetId: TEST_SHEET, layerId: "annotations", p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } };
    draftElementStore.add(el);
    const stored = draftElementStore.get(TEST_SHEET, el.id)!;
    expect(stored.layerId).toBe("annotations");
  });

  test("elements with different layerIds coexist on same sheet", () => {
    draftElementStore.add({ kind: "RS_Line",   id: newDraftElementId(), sheetId: TEST_SHEET, layerId: "default",     p1: { x: 0, y: 0 }, p2: { x: 10, y: 0 } });
    draftElementStore.add({ kind: "RS_Text",   id: newDraftElementId(), sheetId: TEST_SHEET, layerId: "annotations", origin: { x: 0, y: 0 }, content: "A", height: 3, angle: 0 });
    draftElementStore.add({ kind: "RS_Hatch",  id: newDraftElementId(), sheetId: TEST_SHEET, layerId: "hatches",     boundary: [[{ x:0,y:0},{x:10,y:0},{x:10,y:10}]], pattern: "solid", scale: 1, angle: 0 });
    const items = draftElementStore.getBySheet(TEST_SHEET);
    const layerIds = new Set(items.map(e => e.layerId));
    expect(layerIds.size).toBe(3);
  });
});

// ── Active draft tool state ──────────────────────────────────────────────────

describe("setActiveDraftTool / getActiveDraftTool", () => {
  test("initial value is null", () => {
    expect(getActiveDraftTool()).toBeNull();
  });

  test("setActiveDraftTool('line') → getActiveDraftTool() returns 'line'", () => {
    setActiveDraftTool("line");
    expect(getActiveDraftTool()).toBe("line");
  });

  test("setActiveDraftTool(null) clears tool", () => {
    setActiveDraftTool("circle");
    setActiveDraftTool(null);
    expect(getActiveDraftTool()).toBeNull();
  });

  test("each DraftToolId can be set", () => {
    const tools = [
      "line", "arc", "circle", "ellipse", "polyline", "spline", "point",
      "text", "mtext", "leader", "mleader",
      "dim-linear", "dim-aligned", "dim-angular", "dim-radial", "dim-diametric", "dim-arc-length", "dim-ordinate",
      "hatch", "wipeout",
      "block-insert", "image",
    ] as const;
    for (const t of tools) {
      setActiveDraftTool(t);
      expect(getActiveDraftTool()).toBe(t);
    }
  });
});

// ── 2D snap candidates ───────────────────────────────────────────────────────

describe("get2dSnapCandidates", () => {
  test("one segment produces 2 vertex + 1 midpoint candidates", () => {
    const segs = [{ x1: 0, y1: 0, x2: 100, y2: 0 }];
    const cands = get2dSnapCandidates(segs, 1 /* pxToMm = 1:1 */);
    const verts = cands.filter(c => c.kind === "vertex");
    const mids  = cands.filter(c => c.kind === "midpoint");
    expect(verts.length).toBe(2);
    expect(mids.length).toBe(1);
    expect(mids[0].pt).toEqual({ x: 50, y: 0 });
  });

  test("pxToMm scaling is applied", () => {
    const segs = [{ x1: 0, y1: 0, x2: 100, y2: 0 }];
    const cands = get2dSnapCandidates(segs, 0.5);
    const vert = cands.find(c => c.kind === "vertex" && c.pt.x === 50);
    expect(vert?.pt.x).toBe(50);
    const mid = cands.find(c => c.kind === "midpoint");
    expect(mid?.pt.x).toBe(25);
  });

  test("empty segments → empty candidates", () => {
    expect(get2dSnapCandidates([], 1)).toEqual([]);
  });

  test("N segments → 2N vertex + N midpoint", () => {
    const segs = [
      { x1: 0, y1: 0, x2: 10, y2: 0 },
      { x1: 10, y1: 0, x2: 10, y2: 10 },
      { x1: 10, y1: 10, x2: 0, y2: 10 },
    ];
    const cands = get2dSnapCandidates(segs, 1);
    expect(cands.filter(c => c.kind === "vertex").length).toBe(6);
    expect(cands.filter(c => c.kind === "midpoint").length).toBe(3);
  });
});

describe("nearestSnapCandidate", () => {
  test("returns nearest within threshold", () => {
    const segs = [{ x1: 0, y1: 0, x2: 100, y2: 0 }];
    const cands = get2dSnapCandidates(segs, 1);
    const snap = nearestSnapCandidate({ x: 2, y: 1 }, cands, 5);
    expect(snap).not.toBeNull();
    expect(snap?.pt).toEqual({ x: 0, y: 0 });
  });

  test("returns null when query is beyond threshold", () => {
    const segs = [{ x1: 0, y1: 0, x2: 100, y2: 0 }];
    const cands = get2dSnapCandidates(segs, 1);
    const snap = nearestSnapCandidate({ x: 200, y: 200 }, cands, 5);
    expect(snap).toBeNull();
  });

  test("prefers closer candidate when two are within threshold", () => {
    const cands = get2dSnapCandidates(
      [{ x1: 0, y1: 0, x2: 10, y2: 0 }],
      1,
    );
    // Query is at x=1 — closer to vertex (0,0) than vertex (10,0) or midpoint (5,0).
    const snap = nearestSnapCandidate({ x: 1, y: 0 }, cands, 10);
    expect(snap?.pt).toEqual({ x: 0, y: 0 });
  });
});
