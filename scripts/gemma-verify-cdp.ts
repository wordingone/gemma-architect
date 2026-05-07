#!/usr/bin/env bun
// gemma-verify-cdp.ts — CDP-attach variant of the gemma-verify skill.
//
// When B:/M/gemma-architect-master/.shared-browser/cdp.json exists, connects to
// the shared headed Chromium (Jun's window) via chromium.connectOverCDP() instead
// of launching an isolated browser. All 11 surface checks run in Jun's window;
// the cursor is visible to him in real time.
//
// Writes the same JSON format as the /gemma-verify SKILL.md:
//   B:/M/gemma-architect-master/state/gemma-verify-<sha>-<timestamp>.json
//   { sha, timestamp, attached_via_cdp, all_passed, surfaces: [...] }
//
// Usage:
//   bun scripts/gemma-verify-cdp.ts [--isolated]
//
//   --isolated : force a fresh browser launch even if cdp.json exists (CI mode)

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const CDP_JSON  = "B:/M/gemma-architect-master/.shared-browser/cdp.json";
const STATE_DIR = "B:/M/gemma-architect-master/state";
const DEV_URL   = "http://localhost:5175/";

const isolated = process.argv.includes("--isolated");

// --- Resolve SHA ---
function getSHA(): string {
  try {
    return execSync("git -C B:/M/gemma-architect-master rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    try {
      return execSync("git -C B:/M/gemma-architect rev-parse --short HEAD", { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  }
}

const sha       = getSHA();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 16) + "Z";
mkdirSync(STATE_DIR, { recursive: true });
const outFile = `${STATE_DIR}/gemma-verify-${sha}-${timestamp}.json`;

type SurfaceResult = { name: string; passed: boolean; evidence: unknown };

// --- Browser connection ---
let browser: Browser;
let context: BrowserContext;
let attachedViaCDP = false;

if (!isolated && existsSync(CDP_JSON)) {
  const raw = readFileSync(CDP_JSON, "utf8").replace(/^﻿/, "");
  const { endpoint } = JSON.parse(raw);
  browser = await chromium.connectOverCDP(endpoint);
  context = browser.contexts()[0] ?? await browser.newContext();
  attachedViaCDP = true;
  console.log(`Connected via CDP: ${endpoint}`);
} else {
  browser = await chromium.launch({ headless: false });
  context = await browser.newContext();
  console.log("Launched isolated browser");
}

let page: import("playwright").Page;

if (attachedViaCDP) {
  // Find the canonical :5175 tab — never spawn a new one
  const allPages = browser.contexts().flatMap(c => c.pages());
  const canonical = allPages.find(p => p.url().startsWith(DEV_URL));
  if (!canonical) {
    console.error(`BLOCKED: no canonical tab found at ${DEV_URL}`);
    console.error("Is the shared browser running? Try: bun run shared-browser:start");
    process.exit(2);
  }
  page = canonical;
  console.log(`Canonical tab: ${page.url()}`);
  // Reload to wipe prior-run JS state without closing the tab
  await page.reload({ waitUntil: "networkidle", timeout: 15000 });
} else {
  page = await context.newPage();
  await page.goto(DEV_URL, { waitUntil: "networkidle", timeout: 15000 });
}

// --- Install test hook ---
await page.evaluate(() => {
  (window as any).__gemmaTest = { dispatchCalls: [], chainFragments: [], networkCalls: [], events: {}, surfaceResults: [] };
});
await page.waitForTimeout(2000);

const surfaces: SurfaceResult[] = [];

function record(result: SurfaceResult) {
  surfaces.push(result);
  const icon = result.passed ? "✓" : "✗";
  console.log(`  ${icon} ${result.name}`);
  if (!result.passed) console.log("    evidence:", JSON.stringify(result.evidence).slice(0, 200));
}

// --- Surface 1: ribbon-icons-rendered ---
{
  const r = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".ribbon .tool-btn"));
    if (btns.length === 0) return { passed: false, evidence: { reason: "no .tool-btn found" } };
    const failures: unknown[] = [];
    for (const b of btns) {
      const svg = b.querySelector("svg");
      if (!svg) failures.push({ btn: (b as HTMLElement).outerHTML.slice(0, 80), reason: "no svg" });
    }
    return { passed: failures.length === 0, evidence: { count: btns.length, failures } };
  });
  record({ name: "ribbon-icons-rendered", ...r as any });
}

// --- Surface 2: theme-propagation ---
{
  const before = await page.evaluate(() => {
    const panel = document.querySelector(".scene-panel, [data-panel=scene], .sidebar [data-tab=scene]");
    if (!panel) return { passed: false, evidence: { reason: "scene-panel not found" } };
    (window as any).__gemmaTest.themeBefore = getComputedStyle(panel).backgroundColor;
    return { panelFound: true, themeBefore: (window as any).__gemmaTest.themeBefore };
  });
  if ((before as any).passed === false) {
    record({ name: "theme-propagation", passed: false, evidence: (before as any).evidence });
  } else {
    await page.click("#blueprint-toggle, .theme-pill, [data-action=theme-toggle]").catch(() => {});
    await page.waitForTimeout(1000);
    const r = await page.evaluate(() => {
      const panel = document.querySelector(".scene-panel, [data-panel=scene], .sidebar [data-tab=scene]");
      const afterStyle = getComputedStyle(panel!).backgroundColor;
      const beforeStyle = (window as any).__gemmaTest.themeBefore;
      const pill = document.querySelector("#blueprint-toggle, .theme-pill");
      const pillText = pill ? (pill as HTMLElement).textContent!.trim() : "";
      const passed = afterStyle !== beforeStyle && (pillText.includes("BLUEPRINT") || pillText.includes("VELLUM"));
      return { passed, evidence: { beforeStyle, afterStyle, pillText, panelChanged: afterStyle !== beforeStyle } };
    });
    record({ name: "theme-propagation", ...r as any });
  }
}

// --- Surface 3: palette-tool-behavior (prime-click fix) ---
{
  const r = await page.evaluate(async () => {
    const primeBtn = document.querySelector('.palette-btn[data-tool="move"]') as HTMLElement | null;
    if (primeBtn) { primeBtn.click(); await new Promise(res => setTimeout(res, 80)); }
    const tools = ["select", "move", "rotate", "scale"];
    const results: unknown[] = [];
    for (const tool of tools) {
      const btn = document.querySelector(`.palette-btn[data-tool='${tool}']`) as HTMLElement | null;
      if (!btn) { results.push({ tool, error: "no button" }); continue; }
      btn.click();
      await new Promise(res => setTimeout(res, 80));
      const isActive = btn.classList.contains("active");
      results.push({ tool, isActive, matched: isActive });
    }
    const allMatched = (results as any[]).every(r => r.matched);
    return { passed: allMatched, evidence: { results } };
  });
  record({ name: "palette-tool-behavior", ...r as any });
}

// --- Surface 4: selection-roundtrip (no dynamic imports) ---
{
  const r = await page.evaluate(async () => {
    const selectBtn = document.querySelector(".palette-btn[data-tool=select]") as HTMLElement | null;
    if (selectBtn) selectBtn.click();
    await new Promise(res => setTimeout(res, 80));
    (window as any).__gemmaTest.events["viewer:select"] = 0;
    (window as any).__gemmaTest.events["viewer:select:uuid"] = null;
    const handler = (e: Event) => {
      (window as any).__gemmaTest.events["viewer:select"]++;
      (window as any).__gemmaTest.events["viewer:select:uuid"] = (e as CustomEvent).detail?.uuid ?? null;
    };
    window.addEventListener("viewer:select", handler);
    const body = document.querySelector("#viewport-2 .vp-body");
    if (!body) return { passed: false, evidence: { reason: "no #viewport-2 .vp-body" } };
    const rect = body.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    body.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
    body.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
    await new Promise(res => setTimeout(res, 300));
    const eventsHeard = (window as any).__gemmaTest.events["viewer:select"];
    const uuid        = (window as any).__gemmaTest.events["viewer:select:uuid"];
    const passed      = eventsHeard > 0;
    window.removeEventListener("viewer:select", handler);
    return { passed, evidence: { eventsHeard, uuid } };
  });
  record({ name: "selection-roundtrip", ...r as any });
}

// --- Surface 5: transform-gizmo-attach ---
{
  const r = await page.evaluate(async () => {
    const selectBtn = document.querySelector(".palette-btn[data-tool=select]") as HTMLElement | null;
    if (selectBtn) selectBtn.click();
    await new Promise(res => setTimeout(res, 80));
    const body = document.querySelector("#viewport-2 .vp-body");
    if (!body) return { passed: false, evidence: { reason: "no vp-body" } };
    const rect = body.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    body.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
    body.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
    await new Promise(res => setTimeout(res, 300));
    const v = (window as any).__viewer;
    if (!v) return { passed: false, evidence: { reason: "__viewer not found" } };
    const beforeG = v.gizmos.map((g: any) => ({ mode: g.mode, attached: g.object !== null }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown",   { key: "g", code: "KeyG", bubbles: true }));
    await new Promise(res => setTimeout(res, 300));
    const afterG = v.gizmos.map((g: any) => ({ mode: g.mode, attached: g.object !== null }));
    const anyAttached = afterG.some((g: any) => g.attached);
    return { passed: anyAttached, evidence: { beforeG, afterG } };
  });
  record({ name: "transform-gizmo-attach", ...r as any });
}

// --- Surface 6: delete-propagation (Escape first to clear gizmo from S5) ---
{
  const r = await page.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown",   { key: "Escape", code: "Escape", bubbles: true }));
    await new Promise(res => setTimeout(res, 100));
    const v = (window as any).__viewer;
    if (!v) return { passed: false, evidence: { reason: "__viewer not found" } };
    const beforeCount = v.scene.children.length;
    const selectBtn = document.querySelector(".palette-btn[data-tool=select]") as HTMLElement | null;
    if (selectBtn) selectBtn.click();
    await new Promise(res => setTimeout(res, 80));
    const body = document.querySelector("#viewport-2 .vp-body");
    if (!body) return { passed: false, evidence: { reason: "no vp-body" } };
    const rect = body.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    body.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
    body.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
    await new Promise(res => setTimeout(res, 300));
    window.dispatchEvent(new KeyboardEvent("keydown",   { key: "Delete", code: "Delete", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
    await new Promise(res => setTimeout(res, 500));
    const afterCount = v.scene.children.length;
    const sceneShrunk = afterCount < beforeCount;
    return { passed: sceneShrunk, evidence: { beforeCount, afterCount, sceneShrunk } };
  });
  record({ name: "delete-propagation", ...r as any });
}

// --- Surface 7: console-vocab-coverage (prompt tab + mode-pill) ---
{
  await page.evaluate(() => {
    const tab = document.querySelector("[data-tab=prompt]") as HTMLElement | null;
    if (tab) tab.click();
  });
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const pill = document.querySelector(".mode-pill") as HTMLElement | null;
    if (!pill) return;
    const mode = pill.getAttribute("data-mode");
    if (mode !== "console") { pill.click(); await new Promise(res => setTimeout(res, 300)); }
  });

  const verbs = [
    "SdLine","SdArc","SdCircle","SdPolygon","SdPolyline","SdRectangle","SdEllipse","SdSpline",
    "SdBox","SdCylinder","SdSphere","SdCone","SdPrism","SdExtrude","SdRevolve","SdSweep","SdLoft",
    "SdBooleanUnion","SdBooleanDifference","SdBooleanIntersection","SdFillet","SdChamfer",
    "SdOffset","SdTrim","SdExtend","SdSplit","SdShell","SdMove","SdRotate","SdScale","SdMirror",
    "SdArray","IfcWall","IfcSlab","IfcColumn","IfcBeam","IfcStair","IfcDoor","IfcWindow",
    "IfcRoof","IfcSpace","IfcAnnotationDimension","SdLeader","SdText","SdGroup","SdUngroup",
    "SdLayer","SdLock","SdHide","SdSelect","SdSelectAll","SdDeselect","SdIsolate","SdZoomExtents",
    "SdZoomSelected","SdSetViewOrtho","SdSetViewPerspective","SdMeasure","SdArea","SdVolume",
    "SdImport","SdExport","SdSave","SdOpen","setActiveTool",
  ];
  const r = await page.evaluate(async (verbs: string[]) => {
    const input = document.querySelector("#console-input") as HTMLInputElement | null;
    if (!input) return { passed: false, evidence: { reason: "no #console-input found" } };
    const failedVerbs: unknown[] = [];
    const testedVerbs: string[] = [];
    for (const v of verbs) {
      const before = document.querySelector("#console-history")?.children.length ?? 0;
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      await new Promise(res => setTimeout(res, 60));
      const lines = Array.from(document.querySelectorAll("#console-history .console-line")).slice(before).map(l => l.textContent);
      const isUnknown = lines.some(l => /unknown verb/i.test(l ?? ""));
      testedVerbs.push(v);
      if (isUnknown) failedVerbs.push({ verb: v, output: lines.join(" | ") });
    }
    return { passed: failedVerbs.length === 0, evidence: { tested_verbs: testedVerbs, failed_verbs: failedVerbs, total: testedVerbs.length } };
  }, verbs);
  record({ name: "console-vocab-coverage", ...r as any });
}

// --- Surface 8: console-verb-produces-output ---
{
  await page.evaluate(async () => {
    const tab = document.querySelector("[data-tab=prompt]") as HTMLElement | null;
    if (tab) tab.click();
    await new Promise(res => setTimeout(res, 200));
    const pill = document.querySelector(".mode-pill") as HTMLElement | null;
    if (pill && pill.getAttribute("data-mode") !== "console") { pill.click(); await new Promise(res => setTimeout(res, 300)); }
  });
  const r = await page.evaluate(async () => {
    const input = document.querySelector("#console-input") as HTMLInputElement | null;
    if (!input) return { passed: false, evidence: { reason: "no #console-input" } };
    const before = document.querySelector("#console-history")?.children.length ?? 0;
    input.value = "wall";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    await new Promise(res => setTimeout(res, 500));
    const lines = Array.from(document.querySelectorAll("#console-history .console-line")).slice(before).map(l => l.textContent).join(" | ");
    const isUnknownVerb = /unknown verb/i.test(lines);
    const hasOutput = lines.length > 0;
    const passed = hasOutput && !isUnknownVerb;
    return { passed, evidence: { newLines: lines.slice(-300), isUnknownVerb, hasOutput } };
  });
  record({ name: "console-verb-produces-output", ...r as any });
}

// --- Surface 9: cmdk-dialog-opens ---
{
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const input = document.querySelector(".cmdk-input, [data-cmdk-input]") as HTMLElement | null;
    const visible = input ? input.getBoundingClientRect().height > 0 : false;
    return { passed: !!input && visible, evidence: { inputFound: !!input, inputClass: input?.className, inputPH: (input as HTMLInputElement | null)?.placeholder, visible } };
  });
  record({ name: "cmdk-dialog-opens", ...r as any });
}

// --- Surface 10: layout-tab-functional ---
{
  await page.evaluate(() => {
    const layoutTab = document.querySelector("[data-mode=layout]") as HTMLElement | null;
    if (layoutTab) layoutTab.click();
  });
  await page.waitForTimeout(1000);
  const r = await page.evaluate(async () => {
    const sheet = document.querySelector(".paper-sheet, [data-layout=sheet], .layout-sheet");
    if (!sheet) return { passed: false, evidence: { reason: "no .paper-sheet element" } };
    const rect = sheet.getBoundingClientRect();
    const aspectRatio = rect.width / rect.height;
    const a1Aspect = 594 / 841;
    const aspectMatches = Math.abs(aspectRatio - a1Aspect) < 0.05 || Math.abs(aspectRatio - 1 / a1Aspect) < 0.05;
    if (!aspectMatches) return { passed: false, evidence: { reason: "wrong aspect ratio", aspect: aspectRatio, expected: a1Aspect } };
    const beforePanels = sheet.querySelectorAll("[data-panel-id]").length;
    const cx = rect.left + rect.width * 0.25;
    const cy = rect.top + rect.height * 0.25;
    sheet.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
    sheet.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }));
    sheet.dispatchEvent(new MouseEvent("click",         { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
    await new Promise(res => setTimeout(res, 500));
    const afterPanels = sheet.querySelectorAll("[data-panel-id]").length;
    const panelAdded = afterPanels > beforePanels;
    return { passed: aspectMatches && panelAdded, evidence: { sheetDims: { w: rect.width, h: rect.height, aspect: aspectRatio }, a1Aspect, aspectMatches, beforePanels, afterPanels, panelAdded } };
  });
  record({ name: "layout-tab-functional", ...r as any });
}

// --- Surface 11: ortho-grid-z-order ---
{
  const r = await page.evaluate(() => {
    const v = (window as any).__viewer;
    if (!v) return { passed: false, evidence: { reason: "__viewer not found" } };
    const children = v.scene.children;
    const meshes = children.filter((c: any) => c.type === "Mesh" || c.type === "Group");
    const grid   = children.find((c: any) => c.type === "GridHelper");
    if (!grid) return { passed: false, evidence: { reason: "no GridHelper in scene" } };
    const gridBehind = grid.renderOrder < 0 || (grid.material && !grid.material.depthWrite);
    const meshesAbove = meshes.length === 0 || meshes.every((m: any) => m.renderOrder >= 0 && (m.material ? m.material.depthWrite !== false : true));
    const passed = gridBehind && (meshes.length === 0 || meshesAbove);
    return { passed, evidence: { gridRenderOrder: grid.renderOrder, gridDepthWrite: grid.material?.depthWrite, gridBehind, meshCount: meshes.length, meshesAbove } };
  });
  record({ name: "ortho-grid-z-order", ...r as any });
}

// --- Aggregate + write JSON ---
const allPassed = surfaces.every(s => s.passed);
const passCount = surfaces.filter(s => s.passed).length;

const output = {
  sha,
  timestamp,
  attached_via_cdp: attachedViaCDP,
  all_passed: allPassed,
  surfaces,
};
writeFileSync(outFile, JSON.stringify(output, null, 2));

console.log("");
console.log(`${passCount}/11 surfaces passed — all_passed: ${allPassed}`);
console.log(`attached_via_cdp: ${attachedViaCDP}`);
console.log(`Output: ${outFile}`);

// --- Teardown ---
if (!attachedViaCDP) {
  // Isolated mode only: close page and browser we launched
  await page.close();
  await browser.close();
}
// CDP mode: never close page or browser — Jun's canonical tab and window survive.

process.exit(allPassed ? 0 : 1);
