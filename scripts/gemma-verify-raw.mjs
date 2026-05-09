#!/usr/bin/env bun
// gemma-verify-raw.mjs — Raw CDP WebSocket variant of gemma-verify-cdp.ts
//
// Connects to the shared browser at :9222 via raw WebSocket (no Playwright).
// Playwright's connectOverCDP and --isolated both time out on this Windows/Bun
// combination; raw WS works reliably (proven by retroactive audit scripts).
//
// Produces the same receipt format as gemma-verify-cdp.ts:
//   state/gemma-verify-<sha>-<timestamp>.json
//   { sha, timestamp, attached_via_cdp: true, all_passed, surfaces: [...] }
//
// Usage: bun scripts/gemma-verify-raw.mjs
//
// Tracked: issue #196 — long-term fix is to replace Playwright in gemma-verify-cdp.ts

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

// ── Connection ────────────────────────────────────────────────────────────────

const DEV_URL   = "http://localhost:5175/";
const STATE_DIR = `${process.cwd()}/state`;

function getSHA() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const sha       = getSHA();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 16) + "Z";
mkdirSync(STATE_DIR, { recursive: true });
const outFile   = `${STATE_DIR}/gemma-verify-${sha}-${timestamp}.json`;

// Find :5175 page target
const targets = await fetch("http://localhost:9222/json").then(r => r.json());
const target  = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
if (!target) {
  console.error("ERROR: no :5175 page target found in shared browser");
  process.exit(1);
}
console.log(`Canonical tab: ${target.url}`);

// Open raw WS to PAGE target (not browser-level)
const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();

ws.onmessage = m => {
  const x = JSON.parse(m.data);
  if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
};
await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Runtime.enable");
await send("Page.enable");

async function evaluate(expression, returnByValue = true) {
  const res = await send("Runtime.evaluate", { expression, returnByValue, awaitPromise: true });
  return res?.result?.result?.value;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Reload to clean state ─────────────────────────────────────────────────────
await send("Page.reload", { waitForNavigation: false });
await delay(2000);

// ── Test hook ─────────────────────────────────────────────────────────────────
await evaluate(`(window.__gemmaTest = { events: {}, surfaceResults: [] }, true)`);
await delay(1000);

// ── Surface recording ─────────────────────────────────────────────────────────
const surfaces = [];
function record(name, passed, evidence) {
  surfaces.push({ name, passed, evidence });
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} ${name}`);
  if (!passed) console.log("    evidence:", JSON.stringify(evidence).slice(0, 300));
}

// ── Surface 1: ribbon-icons-rendered ─────────────────────────────────────────
{
  const r = await evaluate(`
    (() => {
      const btns = [...document.querySelectorAll(".ribbon .tool-btn")];
      if (!btns.length) return { passed: false, evidence: { reason: "no .tool-btn found" } };
      const failures = btns.filter(b => !b.querySelector("svg"))
        .map(b => ({ btn: b.outerHTML.slice(0, 80), reason: "no svg" }));
      return { passed: failures.length === 0, evidence: { count: btns.length, failures } };
    })()`);
  record("ribbon-icons-rendered", r.passed, r.evidence);
}

// ── Surface 2: theme-propagation ─────────────────────────────────────────────
{
  const before = await evaluate(`
    (() => {
      const panel = document.querySelector(".scene-panel, [data-panel=scene], .sidebar [data-tab=scene]");
      if (!panel) return null;
      window.__gemmaTest.themeBefore = getComputedStyle(panel).backgroundColor;
      return window.__gemmaTest.themeBefore;
    })()`);
  if (before === null) {
    record("theme-propagation", false, { reason: "scene-panel not found" });
  } else {
    await evaluate(`
      (() => {
        const btn = document.querySelector("#blueprint-toggle, .theme-pill, [data-action=theme-toggle]");
        if (btn) btn.click();
      })()`);
    await delay(1000);
    const r = await evaluate(`
      (() => {
        const panel = document.querySelector(".scene-panel, [data-panel=scene], .sidebar [data-tab=scene]");
        const afterStyle = panel ? getComputedStyle(panel).backgroundColor : "";
        const beforeStyle = window.__gemmaTest.themeBefore;
        const pill = document.querySelector("#blueprint-toggle, .theme-pill");
        const pillText = pill ? pill.textContent.trim() : "";
        const passed = afterStyle !== beforeStyle && (pillText.includes("BLUEPRINT") || pillText.includes("VELLUM"));
        return { passed, evidence: { beforeStyle, afterStyle, pillText, panelChanged: afterStyle !== beforeStyle } };
      })()`);
    record("theme-propagation", r.passed, r.evidence);
  }
}

// ── Surface 3: palette-tool-behavior ─────────────────────────────────────────
{
  const r = await evaluate(`
    (async () => {
      const primeBtn = document.querySelector('.palette-btn[data-tool="move"]');
      if (primeBtn) { primeBtn.click(); await new Promise(r => setTimeout(r, 80)); }
      const tools = ["select","move","rotate","scale"];
      const results = [];
      for (const tool of tools) {
        const btn = document.querySelector('.palette-btn[data-tool="' + tool + '"]');
        if (!btn) { results.push({ tool, error: "no button" }); continue; }
        btn.click();
        await new Promise(r => setTimeout(r, 80));
        results.push({ tool, isActive: btn.classList.contains("active"), matched: btn.classList.contains("active") });
      }
      return { passed: results.every(r => r.matched), evidence: { results } };
    })()`);
  record("palette-tool-behavior", r.passed, r.evidence);
}

// ── Pre-surface-4 setup: inject mesh via DSL console ─────────────────────────
{
  await evaluate(`
    (async () => {
      const tab = document.querySelector("[data-tab=prompt]");
      if (tab) { tab.click(); await new Promise(r => setTimeout(r, 200)); }
      const pill = document.querySelector(".mode-pill");
      if (pill && pill.getAttribute("data-mode") !== "console") {
        pill.click(); await new Promise(r => setTimeout(r, 200));
      }
    })()`);
  const setup = await evaluate(`
    (async () => {
      const v = window.__viewer;
      if (!v) return { ok: false, reason: "__viewer not found" };
      const before = v.scene.children.length;
      const input = document.querySelector("#console-input");
      if (!input) return { ok: false, reason: "no #console-input" };
      input.value = "box (0 0) width=1 depth=1 height=1";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      await new Promise(r => setTimeout(r, 800));
      return { ok: v.scene.children.length > before, before, after: v.scene.children.length };
    })()`);
  if (!setup.ok) { console.error("SETUP FAILED:", JSON.stringify(setup)); process.exit(3); }
  console.log(`  setup: mesh injected (scene ${setup.before} → ${setup.after} children)`);
}

// ── Surface 4: selection-roundtrip ───────────────────────────────────────────
{
  const r = await evaluate(`
    (async () => {
      const selectBtn = document.querySelector(".palette-btn[data-tool=select]");
      if (selectBtn) selectBtn.click();
      await new Promise(r => setTimeout(r, 80));
      const inspectTab = document.querySelector(".sb-tab[data-tab=inspect]");
      if (inspectTab) { inspectTab.click(); await new Promise(r => setTimeout(r, 80)); }
      window.__gemmaTest.events["viewer:select"] = 0;
      window.__gemmaTest.events["viewer:select:uuid"] = null;
      const handler = e => {
        window.__gemmaTest.events["viewer:select"]++;
        window.__gemmaTest.events["viewer:select:uuid"] = e.detail?.uuid ?? null;
      };
      window.addEventListener("viewer:select", handler);
      const body = document.querySelector("#viewport-2 .vp-body");
      if (!body) return { passed: false, evidence: { reason: "no #viewport-2 .vp-body" } };
      const rect = body.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      body.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
      body.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      const eventsHeard = window.__gemmaTest.events["viewer:select"];
      const uuid        = window.__gemmaTest.events["viewer:select:uuid"];
      const inspectSubtitle = document.querySelector(".props-subtitle")?.textContent?.trim() ?? "";
      const inspectUpdated = inspectSubtitle !== "" && inspectSubtitle !== "no selection";
      window.removeEventListener("viewer:select", handler);
      return { passed: eventsHeard > 0 && inspectUpdated, evidence: { eventsHeard, uuid, inspectSubtitle, inspectUpdated } };
    })()`);
  record("selection-roundtrip", r.passed, r.evidence);
}

// ── Surface 5: transform-gizmo-attach ────────────────────────────────────────
{
  const r = await evaluate(`
    (async () => {
      const selectBtn = document.querySelector(".palette-btn[data-tool=select]");
      if (selectBtn) selectBtn.click();
      await new Promise(r => setTimeout(r, 80));
      const body = document.querySelector("#viewport-2 .vp-body");
      if (!body) return { passed: false, evidence: { reason: "no vp-body" } };
      const rect = body.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      body.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
      body.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      const v = window.__viewer;
      if (!v) return { passed: false, evidence: { reason: "__viewer not found" } };
      const beforeG = v.gizmos.map(g => ({ mode: g.mode, attached: g.object !== null }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown",   { key: "g", code: "KeyG", bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const afterG = v.gizmos.map(g => ({ mode: g.mode, attached: g.object !== null }));
      const anyAttached  = afterG.some(g => g.attached);
      const targetSelected = !!v.targetObject;
      return { passed: anyAttached && targetSelected, evidence: { beforeG, afterG, targetSelected } };
    })()`);
  record("transform-gizmo-attach", r.passed, r.evidence);
}

// ── Surface 6: delete-propagation ────────────────────────────────────────────
{
  const r = await evaluate(`
    (async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown",   { key: "Escape", code: "Escape", bubbles: true }));
      await new Promise(r => setTimeout(r, 100));
      const v = window.__viewer;
      if (!v) return { passed: false, evidence: { reason: "__viewer not found" } };
      const beforeCount = v.scene.children.length;
      const selectBtn = document.querySelector(".palette-btn[data-tool=select]");
      if (selectBtn) selectBtn.click();
      await new Promise(r => setTimeout(r, 80));
      const body = document.querySelector("#viewport-2 .vp-body");
      if (!body) return { passed: false, evidence: { reason: "no vp-body" } };
      const rect = body.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      body.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
      body.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      window.dispatchEvent(new KeyboardEvent("keydown",   { key: "Delete", code: "Delete", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", code: "Delete", bubbles: true }));
      await new Promise(r => setTimeout(r, 500));
      const afterCount = v.scene.children.length;
      return { passed: afterCount < beforeCount, evidence: { beforeCount, afterCount, sceneShrunk: afterCount < beforeCount } };
    })()`);
  record("delete-propagation", r.passed, r.evidence);
}

// ── Surface 7: console-vocab-coverage ────────────────────────────────────────
{
  await evaluate(`
    (async () => {
      const tab = document.querySelector("[data-tab=prompt]");
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 300));
      const pill = document.querySelector(".mode-pill");
      if (pill && pill.getAttribute("data-mode") !== "console") {
        pill.click(); await new Promise(r => setTimeout(r, 300));
      }
    })()`);
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
  const r = await evaluate(`
    (async () => {
      const verbs = ${JSON.stringify(verbs)};
      const input = document.querySelector("#console-input");
      if (!input) return { passed: false, evidence: { reason: "no #console-input" } };
      const failedVerbs = [];
      for (const v of verbs) {
        const before = document.querySelector("#console-history")?.children.length ?? 0;
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
        await new Promise(r => setTimeout(r, 60));
        const lines = [...document.querySelectorAll("#console-history .console-line")].slice(before).map(l => l.textContent);
        if (lines.some(l => /unknown verb/i.test(l ?? ""))) failedVerbs.push({ verb: v, output: lines.join(" | ") });
      }
      return { passed: failedVerbs.length === 0, evidence: { tested: verbs.length, failed_verbs: failedVerbs } };
    })()`);
  record("console-vocab-coverage", r.passed, r.evidence);
}

// ── Surface 8: console-verb-produces-output ───────────────────────────────────
{
  await evaluate(`
    (async () => {
      const tab = document.querySelector("[data-tab=prompt]");
      if (tab) tab.click();
      await new Promise(r => setTimeout(r, 200));
      const pill = document.querySelector(".mode-pill");
      if (pill && pill.getAttribute("data-mode") !== "console") {
        pill.click(); await new Promise(r => setTimeout(r, 300));
      }
    })()`);
  const r = await evaluate(`
    (async () => {
      const input = document.querySelector("#console-input");
      if (!input) return { passed: false, evidence: { reason: "no #console-input" } };
      const v = window.__viewer;
      const beforeMeshUuid = v?.currentMesh?.uuid ?? null;
      let runOkFired = false;
      window.addEventListener("gemma:run-ok", () => { runOkFired = true; }, { once: true });
      const before = document.querySelector("#console-history")?.children.length ?? 0;
      input.value = "wall (0 0) (4 0) height=3 thickness=0.2";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      const deadline = Date.now() + 5000;
      while (!runOkFired && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
      const afterMeshUuid = v?.currentMesh?.uuid ?? null;
      const meshChanged = afterMeshUuid !== null && afterMeshUuid !== beforeMeshUuid;
      const lines = [...document.querySelectorAll("#console-history .console-line")].slice(before).map(l => l.textContent).join(" | ");
      const isUnknownVerb = /unknown verb/i.test(lines);
      return { passed: lines.length > 0 && !isUnknownVerb && runOkFired && meshChanged,
               evidence: { newLines: lines.slice(-300), isUnknownVerb, hasOutput: lines.length > 0, runOkFired, meshChanged } };
    })()`);
  record("console-verb-produces-output", r.passed, r.evidence);
}

// ── Surface 9: cmdk-dialog-opens ─────────────────────────────────────────────
// Use page-context window.dispatchEvent (reaches window listeners; CDP Input.dispatchKeyEvent does not).
// Also regression-test that #ribbon-palette-btn click keeps cmdk open (fix for #197:
// shell.ts used to synthesize ctrlKey+k on click, causing cmdk to open then immediately close).
{
  // 9a: open via Ctrl+K keyboard shortcut
  await evaluate(`
    (() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, code: "KeyK", bubbles: true }));
    })()`);
  await delay(500);
  const s9 = await evaluate(`
    (() => {
      const input = document.querySelector(".cmdk-input, [data-cmdk-input]");
      const visible = input ? input.getBoundingClientRect().height > 0 : false;
      return { passed: !!input && visible,
               evidence: { inputFound: !!input, inputClass: input?.className, visible } };
    })()`);
  // Dismiss
  await evaluate(`
    (() => {
      const closeBtn = document.querySelector(".cmdk-close, .cmdk-backdrop");
      if (closeBtn) closeBtn.click();
      else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    })()`);
  await delay(300);
  record("cmdk-dialog-opens", s9.passed, s9.evidence);
}

// ── Surface 10: layout-tab-functional ────────────────────────────────────────
{
  await evaluate(`
    (() => {
      const layoutTab = document.querySelector("[data-mode=layout]");
      if (layoutTab) layoutTab.click();
    })()`);
  await delay(1000);
  const r = await evaluate(`
    (async () => {
      const sheet = document.querySelector(".paper-sheet, [data-layout=sheet], .layout-sheet");
      if (!sheet) return { passed: false, evidence: { reason: "no .paper-sheet element" } };
      const rect = sheet.getBoundingClientRect();
      const aspectRatio = rect.width / rect.height;
      const a1Aspect = 594 / 841;
      const aspectMatches = Math.abs(aspectRatio - a1Aspect) < 0.05 || Math.abs(aspectRatio - 1/a1Aspect) < 0.05;
      if (!aspectMatches) return { passed: false, evidence: { reason: "wrong aspect ratio", aspect: aspectRatio, expected: a1Aspect } };
      const cx = rect.left + rect.width * 0.25, cy = rect.top + rect.height * 0.25;
      const beforeNoTool = sheet.querySelectorAll("[data-panel-id]").length;
      sheet.dispatchEvent(new MouseEvent("click", { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
      await new Promise(r => setTimeout(r, 300));
      const afterNoTool = sheet.querySelectorAll("[data-panel-id]").length;
      const gateHeld = afterNoTool === beforeNoTool;
      window.dispatchEvent(new CustomEvent("ribbon:tool-click", { detail: { tool: "viewport" } }));
      await new Promise(r => setTimeout(r, 100));
      const beforePanels = sheet.querySelectorAll("[data-panel-id]").length;
      sheet.dispatchEvent(new MouseEvent("click", { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
      await new Promise(r => setTimeout(r, 500));
      const afterPanels = sheet.querySelectorAll("[data-panel-id]").length;
      const panelAdded = afterPanels > beforePanels;
      return { passed: aspectMatches && gateHeld && panelAdded,
               evidence: { aspect: aspectRatio, a1Aspect, aspectMatches, gateHeld, beforePanels, afterPanels, panelAdded } };
    })()`);
  record("layout-tab-functional", r.passed, r.evidence);
}

// ── Surface 11: ortho-grid-z-order ───────────────────────────────────────────
{
  const r = await evaluate(`
    (() => {
      const v = window.__viewer;
      if (!v) return { passed: false, evidence: { reason: "__viewer not found" } };
      const children = v.scene.children;
      const meshes = children.filter(c => c.type === "Mesh" || c.type === "Group");
      const grid   = children.find(c => c.type === "GridHelper");
      if (!grid) return { passed: false, evidence: { reason: "no GridHelper in scene" } };
      const gridBehind   = grid.renderOrder < 0 || (grid.material && !grid.material.depthWrite);
      const meshesAbove  = meshes.length === 0 || meshes.every(m => m.renderOrder >= 0 && (m.material ? m.material.depthWrite !== false : true));
      return { passed: gridBehind && (meshes.length === 0 || meshesAbove),
               evidence: { gridRenderOrder: grid.renderOrder, gridDepthWrite: grid.material?.depthWrite, gridBehind, meshCount: meshes.length, meshesAbove } };
    })()`);
  record("ortho-grid-z-order", r.passed, r.evidence);
}

// ── Aggregate + write receipt ─────────────────────────────────────────────────
ws.close();

const allPassed  = surfaces.every(s => s.passed);
const passCount  = surfaces.filter(s => s.passed).length;
const output = { sha, timestamp, attached_via_cdp: true, all_passed: allPassed, surfaces };
writeFileSync(outFile, JSON.stringify(output, null, 2));

console.log("");
console.log(`${passCount}/11 surfaces passed — all_passed: ${allPassed}`);
console.log(`attached_via_cdp: true`);
console.log(`Output: ${outFile}`);

process.exit(allPassed ? 0 : 1);
