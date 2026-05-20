// T15 — paper-space layout mode acceptance.

import { test, expect } from "bun:test";
import {
  buildLayoutMode,
  addPanel,
  getPanels,
  exportLayoutAsSvg,
  exportLayoutAsPdf,
  exportLayoutAsAi,
  exportLayoutAsDwgFallback,
  parseScale,
} from "../src/shell/layout";

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  // Provide a viewport so getBoundingClientRect returns realistic values
  // under happy-dom (which honors inline width/height styles).
  document.body.appendChild(host);
  return host;
}

test("layout mode renders A1 sheet with correct dimensions", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape" });
  const sheet = host.querySelector(".paper-sheet") as HTMLElement;
  expect(sheet).toBeTruthy();
  const rect = sheet.getBoundingClientRect();
  // A1 landscape: 841 × 594 mm → aspect ratio 841/594 ≈ 1.416.
  // happy-dom honors style.width/height directly.
  expect(Math.abs(rect.width / rect.height - 841 / 594)).toBeLessThan(0.05);
});

test("can add a panel with a viewport assignment", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape", spawnDefault: false });
  addPanel(host, { x: 100, y: 100, w: 300, h: 200, viewport: "top", scale: "1:50" });
  const panels = host.querySelectorAll(".paper-cell");
  expect(panels.length).toBe(1);
  const label = panels[0].querySelector(".paper-cell-label");
  expect(label?.textContent ?? "").toMatch(/TOP/i);
  // Sanity: getPanels reflects state.
  const ps = getPanels(host);
  expect(ps.length).toBe(1);
  expect(ps[0].viewport).toBe("top");
  expect(ps[0].scale).toBe("1:50");
});

test("multiple panels: plan + section + elevation + perspective on one A1 sheet", () => {
  const host = freshHost();
  buildLayoutMode(host, {
    size: "A1",
    orientation: "landscape",
    initialPanels: [
      { x: 50,  y: 50,  w: 400, h: 240, viewport: "top",         scale: "1:100", title: "PLAN" },
      { x: 470, y: 50,  w: 400, h: 240, viewport: "front",       scale: "1:100", title: "ELEVATION" },
      { x: 50,  y: 310, w: 400, h: 240, viewport: "right",       scale: "1:100", title: "SECTION" },
      { x: 470, y: 310, w: 400, h: 240, viewport: "perspective", scale: "NTS",   title: "PERSPECTIVE" },
    ],
  });
  expect(host.querySelectorAll(".paper-cell").length).toBe(4);
});

test("export to SVG produces valid XML with all panels embedded", () => {
  const host = freshHost();
  buildLayoutMode(host, {
    size: "A1",
    orientation: "landscape",
    initialPanels: [
      { x: 100, y: 100, w: 300, h: 200, viewport: "top", scale: "1:50", title: "PLAN" },
    ],
  });
  const svg = exportLayoutAsSvg(host);
  expect(svg).toContain("<svg");
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toContain("PLAN");
  // mm-dimensioned root.
  expect(svg).toMatch(/width="\d+mm"/);
  // Well-formedness via DOMParser.
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
});

test("export to PDF produces a non-empty PDF binary with %PDF magic", async () => {
  const host = freshHost();
  buildLayoutMode(host, {
    size: "A1",
    orientation: "landscape",
    initialPanels: [
      { x: 100, y: 100, w: 300, h: 200, viewport: "top", scale: "1:50" },
      { x: 420, y: 100, w: 300, h: 200, viewport: "front", scale: "1:50" },
    ],
  });
  const buf = await exportLayoutAsPdf(host);
  expect(buf.byteLength).toBeGreaterThan(1000);
  const sig = new Uint8Array(buf.slice(0, 4));
  expect(String.fromCharCode(...sig)).toBe("%PDF");
});

test("AI export embeds PostScript preamble and remains SVG-parseable", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape" });
  const ai = exportLayoutAsAi(host);
  expect(ai).toContain("%!PS-Adobe-3.0");
  expect(ai).toContain("<svg");
  // Still well-formed XML.
  const doc = new DOMParser().parseFromString(ai, "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
});

test("DWG fallback emits SVG sidecar with explanatory comment", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape" });
  const dwg = exportLayoutAsDwgFallback(host);
  expect(dwg).toContain("DWG export not available");
  expect(dwg).toContain("<svg");
});

test("custom sheet size honors W × H input", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "Custom", customMm: { w: 500, h: 700 }, orientation: "portrait" });
  const sheet = host.querySelector(".paper-sheet") as HTMLElement;
  const w = parseFloat(sheet.style.width);
  const h = parseFloat(sheet.style.height);
  // 500/700 portrait → ratio 5/7 ≈ 0.714.
  expect(Math.abs(w / h - 500 / 700)).toBeLessThan(0.05);
});

test("title block is editable and reflects in SVG export", () => {
  const host = freshHost();
  buildLayoutMode(host, {
    size: "A1",
    orientation: "landscape",
    titleBlock: { project: "MY PROJECT", sheet: "A-202", drawnBy: "ME" },
  });
  const svg = exportLayoutAsSvg(host);
  expect(svg).toContain("MY PROJECT");
  expect(svg).toContain("A-202");
});

test("scale picker accepts presets and parseable custom ratios", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape", spawnDefault: false });
  addPanel(host, { x: 50, y: 50, w: 200, h: 150, viewport: "top",  scale: "1:100" });
  addPanel(host, { x: 50, y: 250, w: 200, h: 150, viewport: "top", scale: "1:25"  });
  const ps = getPanels(host);
  expect(ps.map((p) => p.scale)).toEqual(["1:100", "1:25"]);
});

// ── parseScale — imperial architectural scale strings ──────────────────────

test("parseScale: metric 1:N ratios", () => {
  expect(parseScale("1:1")).toBe(1);
  expect(parseScale("1:50")).toBe(50);
  expect(parseScale("1:100")).toBe(100);
  expect(parseScale("NTS")).toBe(1);
});

test("parseScale: imperial scale fractions → correct ratio", () => {
  expect(parseScale(`1/4" = 1'-0"`)).toBeCloseTo(48, 6);  // 12/(1/4)
  expect(parseScale(`1/8" = 1'-0"`)).toBeCloseTo(96, 6);  // 12/(1/8)
  expect(parseScale(`1/2" = 1'-0"`)).toBeCloseTo(24, 6);  // 12/(1/2)
  expect(parseScale(`3/4" = 1'-0"`)).toBeCloseTo(16, 6);  // 12/(3/4)
  expect(parseScale(`1" = 1'-0"`)).toBeCloseTo(12, 6);    // 12/1
  expect(parseScale(`3" = 1'-0"`)).toBeCloseTo(4, 6);     // 12/3
  expect(parseScale(`1/16" = 1'-0"`)).toBeCloseTo(192, 6); // 12/(1/16)
});

test("parseScale: imperial mixed fractions", () => {
  expect(parseScale(`1-1/2" = 1'-0"`)).toBeCloseTo(8, 6); // 12/1.5
});

test("parseScale: unknown string returns 1 (NTS equivalent)", () => {
  expect(parseScale("custom-garbage")).toBe(1);
  expect(parseScale("Custom")).toBe(1);
});
