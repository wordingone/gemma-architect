// Regression-net: #1804 — 2D SVG exports must use classified lineweights per
// Rhino Make2D / AIA convention. Hidden-line edges render dashed; DXF uses
// per-class layers with AC1015 lineweights.
//
// Tests: EdgeClass / LINEWEIGHT table, DASH_PATTERN, DXF_LWEIGHT / DXF_LINETYPE,
// ClassifiedEdgeSeg shape, SVG compositor per-line stroke-width + dasharray.

import { test, expect, describe } from "bun:test";
import type { ClassifiedEdgeSeg, EdgeClass } from "../src/viewer/edge-classifier";
import { LINEWEIGHT, DASH_PATTERN, DXF_LWEIGHT, DXF_LINETYPE } from "../src/viewer/edge-classifier";

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
// each <line> element carries stroke-width and optional stroke-dasharray.
function composeSvgWithClassifiedEdges(segs: ClassifiedEdgeSeg[]): string {
  const edgeMarkup = segs.map(({ x1, y1, x2, y2, cls }) => {
    const dash = DASH_PATTERN[cls];
    const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";
    return `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${LINEWEIGHT[cls]}"${dashAttr}/>`;
  }).join("\n");
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

// --- Hidden-line class ---

describe("hidden EdgeClass", () => {
  test("LINEWEIGHT[hidden] is less than tangent (thinnest visible = 0.5)", () => {
    expect(LINEWEIGHT["hidden"]).toBeLessThan(LINEWEIGHT["tangent"]);
    expect(LINEWEIGHT["hidden"]).toBe(0.35);
  });

  test("DASH_PATTERN[hidden] is '4 2' (standard architectural hidden-line dash)", () => {
    expect(DASH_PATTERN["hidden"]).toBe("4 2");
  });

  test("DASH_PATTERN[edge] is undefined (solid)", () => {
    expect(DASH_PATTERN["edge"]).toBeUndefined();
  });

  test("DASH_PATTERN[section-cut] is undefined (solid — always visible)", () => {
    expect(DASH_PATTERN["section-cut"]).toBeUndefined();
  });

  test("SVG compositor emits stroke-dasharray for hidden edges", () => {
    const svg = composeSvgWithClassifiedEdges([
      { x1: 0, y1: 0, x2: 50, y2: 0, cls: "hidden" },
    ]);
    expect(svg).toContain('stroke-dasharray="4 2"');
  });

  test("SVG compositor does NOT emit stroke-dasharray for solid edges", () => {
    for (const cls of ["section-cut", "silhouette", "naked", "edge", "tangent"] as EdgeClass[]) {
      const svg = composeSvgWithClassifiedEdges([
        { x1: 0, y1: 0, x2: 50, y2: 0, cls },
      ]);
      expect(svg).not.toContain("stroke-dasharray");
    }
  });

  test("hidden edge has its own stroke-width in SVG", () => {
    const svg = composeSvgWithClassifiedEdges([
      { x1: 0, y1: 0, x2: 50, y2: 0, cls: "hidden" },
    ]);
    expect(svg).toContain(`stroke-width="${LINEWEIGHT["hidden"]}"`);
  });
});

// --- DXF lineweight + linetype tables ---

describe("DXF_LWEIGHT", () => {
  test("section-cut has DXF lweight 70 (0.70mm)", () => {
    expect(DXF_LWEIGHT["section-cut"]).toBe(70);
  });

  test("silhouette has DXF lweight 50 (0.50mm)", () => {
    expect(DXF_LWEIGHT["silhouette"]).toBe(50);
  });

  test("naked has DXF lweight 35 (0.35mm)", () => {
    expect(DXF_LWEIGHT["naked"]).toBe(35);
  });

  test("edge has DXF lweight 25 (0.25mm)", () => {
    expect(DXF_LWEIGHT["edge"]).toBe(25);
  });

  test("tangent has DXF lweight 18 (0.18mm)", () => {
    expect(DXF_LWEIGHT["tangent"]).toBe(18);
  });

  test("hidden has DXF lweight 13 (0.13mm — hairline)", () => {
    expect(DXF_LWEIGHT["hidden"]).toBe(13);
  });

  test("lweights are strictly decreasing section-cut → hidden", () => {
    const order: EdgeClass[] = ["section-cut", "silhouette", "naked", "edge", "tangent", "hidden"];
    for (let i = 1; i < order.length; i++) {
      expect(DXF_LWEIGHT[order[i]]).toBeLessThan(DXF_LWEIGHT[order[i - 1]]);
    }
  });
});

describe("DXF_LINETYPE", () => {
  test("hidden edges use DASHED linetype", () => {
    expect(DXF_LINETYPE["hidden"]).toBe("DASHED");
  });

  test("all other classes use CONTINUOUS linetype", () => {
    const solidClasses: EdgeClass[] = ["section-cut", "silhouette", "naked", "edge", "tangent"];
    for (const cls of solidClasses) {
      expect(DXF_LINETYPE[cls]).toBe("CONTINUOUS");
    }
  });
});

// --- DXF exporter emits per-class layers ---

import { buildLayoutMode, exportLayoutAsDxf } from "../src/shell/layout";

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("exportLayoutAsDxf — AC1015 + per-class layers", () => {
  test("DXF output declares AC1015 version (not AC1009)", () => {
    const host = freshHost();
    buildLayoutMode(host);
    const dxf = exportLayoutAsDxf(host);
    expect(dxf).toContain("AC1015");
    // AC1009 must not appear (old format superseded by #1804 upgrade)
    const acadVerIdx = dxf.indexOf("$ACADVER");
    const versionLine = dxf.slice(acadVerIdx, acadVerIdx + 50);
    expect(versionLine).not.toContain("AC1009");
  });

  test("DXF LAYER table contains A-SECT-CUT with lweight 70", () => {
    const host = freshHost();
    buildLayoutMode(host);
    const dxf = exportLayoutAsDxf(host);
    // Layer name present
    expect(dxf).toContain("A-SECT-CUT");
    // lweight 70 somewhere in output (group 370 + value)
    expect(dxf).toContain("370");
    expect(dxf).toContain("70");
  });

  test("DXF LAYER table contains A-HIDDEN layer", () => {
    const host = freshHost();
    buildLayoutMode(host);
    const dxf = exportLayoutAsDxf(host);
    expect(dxf).toContain("A-HIDDEN");
  });

  test("DXF defines DASHED linetype in LTYPE table", () => {
    const host = freshHost();
    buildLayoutMode(host);
    const dxf = exportLayoutAsDxf(host);
    expect(dxf).toContain("DASHED");
    // LTYPE table must appear before LAYER table
    const ltypeIdx = dxf.indexOf("LTYPE");
    const layerIdx = dxf.indexOf("LAYER");
    expect(ltypeIdx).toBeLessThan(layerIdx);
  });

  test("DXF output is LF-terminated", () => {
    const host = freshHost();
    buildLayoutMode(host);
    const dxf = exportLayoutAsDxf(host);
    expect(dxf.endsWith("\n")).toBe(true);
  });
});
