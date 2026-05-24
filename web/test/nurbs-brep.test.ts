// nurbs-brep.ts unit tests — Brep foundation (#1737 sub-issue).
// Covers: shellFromSurface, brepFromSurface, brepConcat, brepFaceCount,
//         brepIsSolid, brepIsOpen, brepNakedEdgeCount.
import { describe, test, expect } from "bun:test";
import {
  shellFromSurface, brepFromShell, brepFromSurface, brepConcat,
  brepFaceCount, brepIsSolid, brepIsOpen, brepNakedEdgeCount,
  type BrepShell, type Brep,
} from "../src/nurbs/nurbs-brep";
import type { PlaneSurface } from "../src/nurbs/nurbs-surfaces";
import { Plane, Interval, Point3 } from "../src/nurbs/nurbs-primitives";

function planeSurface(): PlaneSurface {
  return {
    kind: "plane",
    plane: Plane.worldXY(),
    uDomain: Interval.create(0, 1),
    vDomain: Interval.create(0, 1),
    uExtent: Interval.create(0, 1),
    vExtent: Interval.create(0, 1),
  };
}

function openShell(faceCount: number): BrepShell {
  const s = shellFromSurface(planeSurface());
  const extra = Array.from({ length: faceCount - 1 }, () =>
    shellFromSurface(planeSurface()).faces[0],
  );
  return { ...s, faces: [...s.faces, ...extra] };
}

function closedShell(faceCount: number): BrepShell {
  return { ...openShell(faceCount), isClosed: true };
}

describe("nurbs-brep foundation", () => {
  describe("shellFromSurface", () => {
    test("produces exactly 1 face", () => {
      const s = shellFromSurface(planeSurface());
      expect(s.faces).toHaveLength(1);
    });

    test("face has correct surface kind", () => {
      const s = shellFromSurface(planeSurface());
      expect(s.faces[0].surface.kind).toBe("plane");
    });

    test("face has empty outerLoop", () => {
      const s = shellFromSurface(planeSurface());
      expect(s.faces[0].outerLoop.curves).toHaveLength(0);
    });

    test("face has no inner loops", () => {
      const s = shellFromSurface(planeSurface());
      expect(s.faces[0].innerLoops).toHaveLength(0);
    });

    test("face orientation = true (outward)", () => {
      const s = shellFromSurface(planeSurface());
      expect(s.faces[0].orientation).toBe(true);
    });

    test("no edges, no vertices", () => {
      const s = shellFromSurface(planeSurface());
      expect(s.edges).toHaveLength(0);
      expect(s.vertices).toHaveLength(0);
    });

    test("shell is open (single-face has naked edges)", () => {
      const s = shellFromSurface(planeSurface());
      expect(s.isClosed).toBe(false);
    });
  });

  describe("brepFromSurface", () => {
    test("produces 1 shell with 1 face", () => {
      const b = brepFromSurface(planeSurface());
      expect(b.shells).toHaveLength(1);
      expect(b.shells[0].faces).toHaveLength(1);
    });
  });

  describe("brepConcat", () => {
    test("empty concat yields empty Brep", () => {
      const b = brepConcat();
      expect(b.shells).toHaveLength(0);
    });

    test("single Brep passthrough", () => {
      const b = brepFromSurface(planeSurface());
      const c = brepConcat(b);
      expect(c.shells).toHaveLength(1);
    });

    test("two Breps → 2 shells", () => {
      const b1 = brepFromSurface(planeSurface());
      const b2 = brepFromSurface(planeSurface());
      const c = brepConcat(b1, b2);
      expect(c.shells).toHaveLength(2);
    });

    test("shells preserved in order", () => {
      const b1 = brepFromShell(openShell(1));
      const b2 = brepFromShell(closedShell(6));
      const c = brepConcat(b1, b2);
      expect(c.shells[0].isClosed).toBe(false);
      expect(c.shells[1].isClosed).toBe(true);
    });
  });

  describe("brepFaceCount", () => {
    test("0 shells → 0 faces", () => {
      expect(brepFaceCount({ shells: [] })).toBe(0);
    });

    test("1 shell, 1 face → 1", () => {
      expect(brepFaceCount(brepFromSurface(planeSurface()))).toBe(1);
    });

    test("2 shells, 1+3 faces → 4", () => {
      const b = brepConcat(
        brepFromShell(openShell(1)),
        brepFromShell(openShell(3)),
      );
      expect(brepFaceCount(b)).toBe(4);
    });
  });

  describe("brepIsSolid / brepIsOpen", () => {
    test("empty Brep is not solid", () => {
      expect(brepIsSolid({ shells: [] })).toBe(false);
    });

    test("open shell → not solid, is open", () => {
      const b = brepFromShell(openShell(1));
      expect(brepIsSolid(b)).toBe(false);
      expect(brepIsOpen(b)).toBe(true);
    });

    test("closed shell → is solid, is open returns false", () => {
      const b = brepFromShell(closedShell(6));
      expect(brepIsSolid(b)).toBe(true);
      expect(brepIsOpen(b)).toBe(false);
    });

    test("mixed shells → not solid", () => {
      const b = brepConcat(
        brepFromShell(closedShell(6)),
        brepFromShell(openShell(1)),
      );
      expect(brepIsSolid(b)).toBe(false);
      expect(brepIsOpen(b)).toBe(true);
    });
  });

  describe("brepNakedEdgeCount", () => {
    test("no edges → 0 naked", () => {
      expect(brepNakedEdgeCount(brepFromSurface(planeSurface()))).toBe(0);
    });

    test("counts edges where faceIndex2 = null", () => {
      const b: Brep = {
        shells: [
          {
            faces: [shellFromSurface(planeSurface()).faces[0]],
            edges: [
              { curve: { kind: "line", from: Point3.create(0,0,0), to: Point3.create(1,0,0), domain: Interval.create(0, 1) }, faceIndex1: 0, faceIndex2: null },
              { curve: { kind: "line", from: Point3.create(1,0,0), to: Point3.create(1,1,0), domain: Interval.create(0, 1) }, faceIndex1: 0, faceIndex2: 0 },
            ],
            vertices: [],
            isClosed: false,
          },
        ],
      };
      expect(brepNakedEdgeCount(b)).toBe(1);
    });

    test("accumulates across shells", () => {
      function shellWithNaked(n: number): BrepShell {
        return {
          faces: [],
          edges: Array.from({ length: n }, (_, i) => ({
            curve: { kind: "line" as const, from: Point3.create(i, 0, 0), to: Point3.create(i + 1, 0, 0), domain: Interval.create(i, i + 1) },
            faceIndex1: 0,
            faceIndex2: null,
          })),
          vertices: [],
          isClosed: false,
        };
      }
      const b = brepConcat(brepFromShell(shellWithNaked(2)), brepFromShell(shellWithNaked(3)));
      expect(brepNakedEdgeCount(b)).toBe(5);
    });
  });
});
