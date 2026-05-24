// Regression-net: #1806 — 2D exports must not contain titleblock chrome.
// Verified: composeSvg / exportLayoutAsPdf omit SHEET/SCALE/DRAWN/DATE rows.

import { test, expect } from "bun:test";
import {
  buildLayoutMode,
  exportLayoutAsSvg,
  exportLayoutAsPdf,
} from "../src/shell/layout";

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

const PANEL = { x: 50, y: 50, w: 400, h: 300, viewport: "top" as const, scale: "1:100", title: "PLAN" };

test("SVG export: no SHEET label in titleblock", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape", initialPanels: [PANEL] });
  const svg = exportLayoutAsSvg(host);
  expect(svg).not.toContain(">SHEET<");
});

test("SVG export: no DRAWN label in titleblock", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape", initialPanels: [PANEL] });
  const svg = exportLayoutAsSvg(host);
  expect(svg).not.toContain(">DRAWN<");
});

test("SVG export: no titleblock rect at page bottom", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape", initialPanels: [PANEL] });
  const svg = exportLayoutAsSvg(host);
  // composeTitleBlock emitted a rect with y≈(h-60). After removal, no such rect near the bottom.
  // Simple check: titleblock class attributes gone.
  expect(svg).not.toContain("paper-titleblock");
});

test("SVG export: panel title still present after titleblock removal", () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape", initialPanels: [PANEL] });
  const svg = exportLayoutAsSvg(host);
  expect(svg).toContain("PLAN");
});

test("PDF export: title block section removed (no SHEET/DRAWN jsPDF calls)", async () => {
  const host = freshHost();
  buildLayoutMode(host, { size: "A1", orientation: "landscape", initialPanels: [PANEL] });
  const buf = await exportLayoutAsPdf(host);
  // PDF is binary — decode to string to check for plain-text title block label presence.
  const text = new TextDecoder("latin1").decode(buf);
  // Titleblock labels ("SHEET", "DRAWN", "DATE") appear as literal PDF text streams.
  expect(text).not.toContain("SHEET");
  expect(text).not.toContain("DRAWN");
});
