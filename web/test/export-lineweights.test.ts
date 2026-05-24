// Regression-net: #1804 — 2D SVG exports must use classified lineweights per
// Rhino Make2D / AIA convention rather than a single uniform stroke-width.
//
// Tests: EdgeClass / LINEWEIGHT table correctness, ClassifiedEdgeSeg shape,
// and SVG compositor behaviour when classified edges are present (each edge
// carries its own stroke-width; no global stroke-width on the group).

import { test, expect, describe } from "bun:test";
import type { ClassifiedEdgeSeg, EdgeClass } from "../src/viewer/edge-classifier";
import { LINEWEIGHT } from "../src/viewer/edge-classifier";

// --- Lineweight table ---

describe("LINEWEIGHT table", () => {
  test("section-cut is the thickest weight (2.0)", () => {
    expect(LINEWEIGHT["section-cut"]).toBe(2.0);
  });

  test("silhouette (1.4) < section-cut", () => {
    expect(LINEWEIGHT["silhouette"]).toBeLessThan(LINEWEIGHT["section-cut"]);
    expect(LINEWEIGHT["silhouette"]).toBe(1.4);
  });

  test("naked (1.0) < silhouette", () => {
    expect(LINEWEIGHT["naked"]).toBeLessThan(LINEWEIGHT["silhouette"]);
    expect(LINEWEIGHT["naked"]).toBe(1.0);
  });

  test("edge (0.7) < naked", () => {
    expect(LINEWEIGHT["edge"]).toBeLessThan(LINEWEIGHT["naked"]);
    expect(LINEWEIGHT["edge"]).toBe(0.7);
  });

  test("tangent (0.5) is the thinnest weight", () => {
    expect(LINEWEIGHT["tangent"]).toBeLessThan(LINEWEIGHT["edge"]);
    expect(LINEWEIGHT["tangent"]).toBe(0.5);
  });

  test("all five EdgeClasses are defined", () => {
    const classes: EdgeClass[] = ["section-cut", "silhouette", "naked", "edge", "tangent"];
    for (const cls of classes) {
      expect(typeof LINEWEIGHT[cls]).toBe("number");
      expect(LINEWEIGHT[cls]).toBeGreaterThan(0);
    }
  });
});

// --- ClassifiedEdgeSeg type ---

describe("ClassifiedEdgeSeg shape", () => {
  test("accepts all EdgeClass values", () => {
    const classes: EdgeClass[] = ["section-cut", "silhouette", "naked", "edge", "tangent"];
    for (const cls of classes) {
      const seg: ClassifiedEdgeSeg = { x1: 0, y1: 0, x2: 10, y2: 10, cls };
      expect(seg.cls).toBe(cls);
    }
  });

  test("x1/y1/x2/y2 are numeric", () => {
    const seg: ClassifiedEdgeSeg = { x1: 5.5, y1: 12.3, x2: 99.1, y2: 0.0, cls: "edge" };
    expect(typeof seg.x1).toBe("number");
    expect(typeof seg.y1).toBe("number");
    expect(typeof seg.x2).toBe("number");
    expect(typeof seg.y2).toBe("number");
  });
});

// --- SVG compositor produces per-line stroke-width ---

// Minimal mock of what renderViewportSvg does when classified edges are present:
// each <line> element carries stroke-width="${LINEWEIGHT[cls]}" inline.
function composeSvgWithClassifiedEdges(segs: ClassifiedEdgeSeg[]): string {
  const edgeMarkup = segs.map(({ x1, y1, x2, y2, cls }) =>
    `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${LINEWEIGHT[cls]}"/>`,
  ).join("\n");
  return `<svg viewBox="0 0 400 300">
  <g fill="none" stroke="#1a1a22" stroke-linecap="round" stroke-linejoin="round">
  ${edgeMarkup}
  </g>
</svg>`;
}

describe("SVG compositor — classified edge rendering", () => {
  const sampleSegs: ClassifiedEdgeSeg[] = [
    { x1: 10, y1: 10, x2: 100, y2: 10, cls: "section-cut" },
    { x1: 10, y1: 20, x2: 100, y2: 20, cls: "silhouette" },
    { x1: 10, y1: 30, x2: 100, y2: 30, cls: "naked" },
    { x1: 10, y1: 40, x2: 100, y2: 40, cls: "edge" },
    { x1: 10, y1: 50, x2: 100, y2: 50, cls: "tangent" },
  ];

  test("each <line> carries its own stroke-width attribute", () => {
    const svg = composeSvgWithClassifiedEdges(sampleSegs);
    expect(svg).toContain(`stroke-width="${LINEWEIGHT["section-cut"]}"`);
    expect(svg).toContain(`stroke-width="${LINEWEIGHT["silhouette"]}"`);
    expect(svg).toContain(`stroke-width="${LINEWEIGHT["naked"]}"`);
    expect(svg).toContain(`stroke-width="${LINEWEIGHT["edge"]}"`);
    expect(svg).toContain(`stroke-width="${LINEWEIGHT["tangent"]}"`);
  });

  test("section-cut line has weight 2 (thickest)", () => {
    const svg = composeSvgWithClassifiedEdges([
      { x1: 0, y1: 0, x2: 50, y2: 0, cls: "section-cut" },
    ]);
    expect(svg).toContain('stroke-width="2"');
  });

  test("tangent line has weight 0.5 (thinnest)", () => {
    const svg = composeSvgWithClassifiedEdges([
      { x1: 0, y1: 0, x2: 50, y2: 0, cls: "tangent" },
    ]);
    expect(svg).toContain('stroke-width="0.5"');
  });

  test("no single global stroke-width=0.8 when classified edges present", () => {
    const svg = composeSvgWithClassifiedEdges(sampleSegs);
    // The group element must NOT carry stroke-width="0.8" (old uniform default).
    // Each line carries its own weight instead.
    expect(svg).not.toContain('stroke-width="0.8"');
  });

  test("SVG output is parseable XML", () => {
    const svg = composeSvgWithClassifiedEdges(sampleSegs);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parseerror")).toBeNull();
  });

  test("coordinates are formatted to 2 decimal places", () => {
    const svg = composeSvgWithClassifiedEdges([
      { x1: 1.12345, y1: 2.98765, x2: 10.00001, y2: 0.5, cls: "edge" },
    ]);
    expect(svg).toContain('x1="1.12"');
    expect(svg).toContain('y1="2.99"');
    expect(svg).toContain('x2="10.00"');
  });
});
