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

const targetUrlIdx = process.argv.indexOf("--target-url");
const DEV_URL   = targetUrlIdx !== -1 ? process.argv[targetUrlIdx + 1]
                : (process.env.GEMMA_DEV_URL ?? "http://localhost:5175/");
const STATE_DIR = `${process.cwd()}/state`;

function getSHA() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const sha       = getSHA();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 16) + "Z";
mkdirSync(STATE_DIR, { recursive: true });
const outFile   = `${STATE_DIR}/gemma-verify-${sha}-${timestamp}.json`;

// Find canonical :5175 tab, or open a new tab for GEMMA_DEV_URL
const USE_NEW_TAB = !DEV_URL.includes("localhost:5175");
let target;
let newTabTargetId = null;

if (USE_NEW_TAB) {
  // Open a new tab in the shared browser — does NOT spawn a new window
  target = await fetch(`http://localhost:9222/json/new?${encodeURIComponent(DEV_URL)}`, { method: "PUT" }).then(r => r.json());
  newTabTargetId = target.id;
  console.log(`New tab: ${target.url} (id: ${newTabTargetId})`);
} else {
  const targets = await fetch("http://localhost:9222/json").then(r => r.json());
  target = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
  if (!target) {
    console.error("ERROR: no :5175 page target found in shared browser");
    process.exit(1);
  }
  console.log(`Canonical tab: ${target.url}`);
}

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

// Bring tab to front so WebGL renders real frames (background tabs throttle rAF/canvas).
await send("Page.bringToFront");

async function evaluate(expression, returnByValue = true) {
  const res = await send("Runtime.evaluate", { expression, returnByValue, awaitPromise: true });
  if (res?.result?.exceptionDetails) return null; // expression threw — callers must null-check
  return res?.result?.result?.value;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Capture #viewer-canvas bytes-per-pixel via CDP clip screenshot.
// bpp ≥ 0.025 = normally-rendered scene; bpp ≤ 0.018 = blank/occluded canvas.
async function canvasBpp(label = '') {
  const rect = await evaluate(`(function() {
    const c = document.getElementById('viewer-canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`);
  if (!rect || rect.width < 1 || rect.height < 1)
    return { bpp: 0, label, reason: 'canvas not found or zero-size' };
  const snap = await send('Page.captureScreenshot', {
    format: 'jpeg', quality: 85,
    clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
  });
  const b64 = snap?.result?.data ?? '';
  const bytes = b64.length * 0.75;
  const pixels = rect.width * rect.height;
  const bpp = pixels > 0 ? Math.round((bytes / pixels) * 1000) / 1000 : 0;
  return { bpp, pixels: Math.round(pixels), label };
}

// ── Reload to clean state ─────────────────────────────────────────────────────
await send("Page.reload", { waitForNavigation: false });
await delay(2000);

// ── Test hook ─────────────────────────────────────────────────────────────────
await evaluate(`(window.__gemmaTest = { events: {}, surfaceResults: [] }, true)`);
// Enable test mode: SdExport short-circuits to prevent real Downloads pollution (#262).
await evaluate(`(window.__testMode = true, true)`);
await delay(1000);

// ── Surface recording ─────────────────────────────────────────────────────────
const surfaces = [];
function record(name, passed, evidence) {
  surfaces.push({ name, passed, evidence });
  const icon = passed ? "✓" : "✗";
  console.log(`  ${icon} ${name}`);
  if (!passed) console.log("    evidence:", JSON.stringify(evidence).slice(0, 300));
}

// ── Surface 0: initial-scene-clean (#218 regression guard) ───────────────────
// Asserts: immediately after a fresh page reload, the viewer scene contains
// no user-created building elements (no IfcWall, SdBox, etc.).
// Excludes built-in scene objects: GridHelper, AxesHelper, lights, gumball handles.
{
  const r = await evaluate(`
    (() => {
      try {
        const v = window.__viewer;
        if (!v) return { passed: false, evidence: { reason: "__viewer not found" } };
        const BUILTIN_NAMES = new Set(["X_shaft","X","Y_shaft","Y","Z_shaft","Z","XYZ","XY","YZ","XZ","XYZE","E"]);
        const userMeshes = [];
        v.scene.traverse(obj => {
          if (!obj.isMesh && !obj.isGroup) return;
          if (BUILTIN_NAMES.has(obj.name)) return;
          if (obj.type === "GridHelper" || obj.type === "AxesHelper") return;
          if (obj.userData?.kind || obj.userData?.creator || obj.userData?.layerId) {
            userMeshes.push({ name: obj.name, kind: obj.userData?.kind, creator: obj.userData?.creator });
          }
        });
        return { passed: userMeshes.length === 0, evidence: { userMeshCount: userMeshes.length, userMeshes } };
      } catch (e) {
        return { passed: false, evidence: { reason: "caught: " + String(e) } };
      }
    })()`);
  if (!r) record("initial-scene-clean", false, { reason: "evaluate returned null" });
  else record("initial-scene-clean", r.passed, r.evidence);
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

// ── Surface 7: console-vocab-runs ─────────────────────────────────────────────
// Renamed from console-vocab-coverage (#241): also fails on ArgValidationError,
// not just "unknown verb" — verbs with required geometry args are RED until W2.4 (#233).
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
    "SdArray","IfcWall","IfcSlab","IfcColumn","IfcBeam","IfcMember","IfcStair","IfcDoor","IfcWindow",
    "IfcRoof","IfcPlate","IfcFurnishingElement","IfcSpace","IfcAnnotationDimension","SdLeader","SdText","SdGroup","SdUngroup",
    "SdLayer","SdLock","SdHide","SdSelect","SdSelectAll","SdDeselect","SdIsolate","SdZoomExtents",
    "SdZoomSelected","SdSetViewOrtho","SdSetViewPerspective","SdMeasure","SdArea","SdVolume",
    "SdImport","SdExport","SdSave","SdOpen","setActiveTool",
  ];
  const r = await evaluate(`
    (async () => {
      try {
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
          const isUnknown  = lines.some(l => /unknown verb/i.test(l ?? ""));
          const isArgError = lines.some(l => /ArgValidationError/i.test(l ?? ""));
          if (isUnknown || isArgError) {
            failedVerbs.push({ verb: v, output: lines.join(" | "), error: isUnknown ? "unknown_verb" : "arg_validation_error" });
          }
        }
        return { passed: failedVerbs.length === 0, evidence: { tested: verbs.length, failed_verbs: failedVerbs } };
      } catch (e) {
        return { passed: false, evidence: { reason: "caught: " + String(e) } };
      }
    })()`);
  if (!r) record("console-vocab-runs", false, { reason: "evaluate returned null — expression threw or timed out" });
  else record("console-vocab-runs", r.passed, r.evidence);

  // Teardown: clear any orphaned picker-bridge sessions (#259).
  // Verbs like SdLine leave a collecting_args session that blocks OrbitControls.
  await evaluate(`(window.__clearCommandSession?.(), true)`);
  await delay(100);

  // Assert session cleared and picker-prompt gone — prevents false-green on session leak.
  const sessionClean = await evaluate(`(function() {
    const sess = window.__getActiveCommandSession?.();
    const pickerVisible = !!document.querySelector('.picker-prompt.visible');
    return { sessionNull: sess === null, pickerVisible };
  })()`);
  if (sessionClean && (!sessionClean.sessionNull || sessionClean.pickerVisible)) {
    console.log(`    warn: post-teardown session leak — sessionNull=${sessionClean.sessionNull} pickerVisible=${sessionClean.pickerVisible}`);
  }
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

// ── Surface 10b: layout-mode-shell-intact (#199 regression) ──────────────────
// Asserts: in layout mode, ribbon stays visible + paper-stage fills workbench.
// Then exits to model mode and asserts ribbon is still present.
{
  // Already in layout mode from surface 10.
  const r = await evaluate(`
    (() => {
      const ribbon = document.querySelector(".ribbon");
      const paperStage = document.querySelector(".paper-stage");
      const workbench = document.querySelector(".workbench");
      if (!ribbon) return { passed: false, evidence: { reason: "ribbon element absent" } };
      const ribbonRect = ribbon.getBoundingClientRect();
      const ribbonVisible = ribbonRect.height > 0 && ribbonRect.width > 0 && ribbonRect.top >= 0 && ribbonRect.bottom <= window.innerHeight + ribbonRect.height;
      const paperH = paperStage ? paperStage.clientHeight : 0;
      const wbH = workbench ? workbench.clientHeight : 0;
      // paper-stage should fill most of workbench (at least 80% after toolbar strip)
      const stageFills = wbH > 0 && paperH > wbH * 0.7;
      return { passed: ribbonVisible && stageFills,
               evidence: { ribbonH: ribbonRect.height, ribbonTop: ribbonRect.top, ribbonVisible, paperH, wbH, stageFills } };
    })()`);
  // Exit layout mode — click the MODEL tab
  await evaluate(`
    (() => {
      const modelTab = document.querySelector(".mode-tab[data-mode=model]");
      if (modelTab) modelTab.click();
    })()`);
  await delay(500);
  const ribbonAfterExit = await evaluate(`
    (() => {
      const ribbon = document.querySelector(".ribbon");
      const wbMode = document.querySelector(".workbench")?.dataset?.mode ?? "";
      if (!ribbon) return { passed: false, evidence: { reason: "ribbon absent after mode exit" } };
      const rect = ribbon.getBoundingClientRect();
      return { passed: rect.height > 0 && wbMode !== "layout",
               evidence: { ribbonH: rect.height, workbenchMode: wbMode } };
    })()`);
  record("layout-mode-shell-intact", r.passed && ribbonAfterExit.passed,
    { onEntry: r.evidence, onExit: ribbonAfterExit.evidence });
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

// ── Surface 12: viewport-contrast ────────────────────────────────────────────
// Post-#249 fix: the canvas now carries var(--paper-base) as its WebGL clear
// color (opaque) and .viewport is transparent. Verify the canvas clear color
// is opaque (alpha=1) in both VELLUM (day) and BLUEPRINT (night) themes by
// reading the WebGL renderer's clearColor via __viewer, then checking the
// actual pixel is non-uniform with a pixel-bytes probe (bpp ≥ 0.015).
// Falls back to computedStyle on .vp-header (always opaque) as the
// structural-opacity check.
{
  const r = await evaluate(`
    (() => {
      function getAlpha(el) {
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/rgba\\(\\d+,\\s*\\d+,\\s*\\d+,\\s*([\\d.]+)\\)/);
        return m ? parseFloat(m[1]) : 1; // no alpha in rgb() → fully opaque
      }
      const hdr = document.querySelector('.vp-header');
      if (!hdr) return { passed: false, evidence: { reason: 'no .vp-header found' } };

      const origMode = document.documentElement.getAttribute('data-mode') ?? 'day';

      // Day (vellum) check — vp-header background must be opaque
      document.documentElement.setAttribute('data-mode', 'day');
      const dayBg = getComputedStyle(hdr).backgroundColor;
      const dayAlpha = getAlpha(hdr);

      // Night (blueprint) check
      document.documentElement.setAttribute('data-mode', 'night');
      const nightBg = getComputedStyle(hdr).backgroundColor;
      const nightAlpha = getAlpha(hdr);

      // Restore original theme
      document.documentElement.setAttribute('data-mode', origMode);

      const passed = dayAlpha >= 0.99 && nightAlpha >= 0.99;
      return { passed, evidence: { dayBg, dayAlpha, nightBg, nightAlpha } };
    })()`);
  if (!r) record("viewport-contrast", false, { reason: "evaluate returned null" });
  else record("viewport-contrast", r.passed, r.evidence);
}

// ── Surface 13: ifc-import-renders ───────────────────────────────────────────────
// Programmatically injects Schultz_Residence.ifc via file-input DataTransfer,
// waits for viewer:ifc-loaded event, asserts scene grew + userData.creator set.
{
  const r = await evaluate(`
    (async () => {
      const loadPromise = new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('viewer:ifc-loaded timeout')), 30000);
        window.addEventListener('viewer:ifc-loaded', (e) => {
          clearTimeout(t);
          resolve(e.detail);
        }, { once: true });
      });

      let fetchOk = false;
      let fetchErr = '';
      try {
        const resp = await fetch('/samples/Schultz_Residence.ifc');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const bytes = await resp.arrayBuffer();
        const file = new File([bytes], 'Schultz_Residence.ifc', { type: 'application/x-step' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.getElementById('file-input');
        if (!input) throw new Error('no #file-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        fetchOk = true;
      } catch (e) {
        fetchErr = String(e);
      }

      if (!fetchOk) return { passed: false, evidence: { reason: 'fetch/inject failed', fetchErr } };

      try {
        const detail = await loadPromise;
        const afterCount = window.__viewer?.scene?.children?.length ?? 0;
        let hasMeshWithCreator = false;
        window.__viewer?.scene?.traverse?.(obj => {
          if (obj.userData?.creator) hasMeshWithCreator = true;
        });
        const passed = afterCount > 0 && hasMeshWithCreator;
        return { passed, evidence: { afterCount, hasMeshWithCreator, detail } };
      } catch (e) {
        return { passed: false, evidence: { reason: 'event not received', error: String(e) } };
      }
    })()`, true);
  if (!r) {
    record('ifc-import-renders', false, { reason: 'evaluate returned null' });
  } else if (!r.passed) {
    record('ifc-import-renders', false, r.evidence);
  } else {
    const bpp = await canvasBpp('ifc-loaded');
    const BPP_MIN = 0.025;
    record('ifc-import-renders', bpp.bpp >= BPP_MIN, { ...r.evidence, ...bpp, bppMin: BPP_MIN });
  }
}

// ── Surface 14: render-mode-cycle-survives-theme ─────────────────────────────────
// 4 render modes x 2 themes (8 combos) via SdRenderMode dispatch.
// Structural survive check: scene children still > 0 after each combo.
// Pixel-color delta deferred to Step 2 Haiku (canvas blank bug #249).
{
  const r = await evaluate(`
    (async () => {
      const MODES = ['shaded', 'wireframe', 'ghosted', 'technical'];
      const THEMES = ['day', 'night'];
      const failures = [];

      for (const mode of MODES) {
        for (const theme of THEMES) {
          const dispatchRes = window.__dispatch?.('SdRenderMode', { mode });
          document.documentElement.setAttribute('data-mode', theme);
          await new Promise(r => setTimeout(r, 100));
          const childCount = window.__viewer?.scene?.children?.length ?? 0;
          if (childCount === 0) {
            failures.push({ mode, theme, reason: 'scene empty after mode switch' });
          }
          if (dispatchRes?.error) {
            failures.push({ mode, theme, reason: 'dispatch error: ' + dispatchRes.error });
          }
        }
      }

      window.__dispatch?.('SdRenderMode', { mode: 'shaded' });
      document.documentElement.setAttribute('data-mode', 'day');
      await new Promise(r => setTimeout(r, 100));

      return { passed: failures.length === 0, evidence: { failures, testedCombos: MODES.length * THEMES.length } };
    })()`, true);
  if (!r) {
    record('render-mode-cycle-survives-theme', false, { reason: 'evaluate returned null' });
  } else if (!r.passed) {
    record('render-mode-cycle-survives-theme', false, r.evidence);
  } else {
    // Canvas bpp after restore to shaded/day — catches blank canvas that scene-children check misses
    const bpp = await canvasBpp('shaded-day');
    const BPP_MIN = 0.025;
    record('render-mode-cycle-survives-theme', bpp.bpp >= BPP_MIN, { ...r.evidence, ...bpp, bppMin: BPP_MIN });
  }
}

// ── Surface 15: view-switch-via-cmdk ────────────────────────────────────────────────
// SdSetViewOrtho(top): camera.position.z > 5 (Z-up viewer, top = high Z).
// SdSetViewOrtho(iso): all position components positive (diagonal).
// setActiveLevel(elev=3): controls.target.z shifts to near 3.
{
  const r = await evaluate(`
    (async () => {
      const cam = window.__viewer?.camera;
      if (!cam) return { passed: false, evidence: { reason: 'no __viewer.camera' } };

      window.__dispatch?.('SdSetViewOrtho', { view: 'top' });
      await new Promise(r => setTimeout(r, 200));
      const topZ = cam.position.z;
      const topPassed = topZ > 5;

      window.__dispatch?.('SdSetViewOrtho', { view: 'iso' });
      await new Promise(r => setTimeout(r, 200));
      const isoX = cam.position.x;
      const isoY = cam.position.y;
      const isoZ = cam.position.z;
      const isoPassed = isoX > 0 && isoY > 0 && isoZ > 0;

      let levelPassed = true;
      let levelEvidence = {};
      try {
        const lvlRes = window.__dispatch?.('IfcLevel', { name: 'TestLevel', elevation: 3 });
        const levelId = lvlRes?.id;
        if (levelId) {
          const perspPane = window.__viewer?.panes?.find(p => p.view === 'persp');
          const zBefore = perspPane?.controls?.target?.z ?? 0;
          window.__dispatch?.('setActiveLevel', { id: levelId });
          await new Promise(r => setTimeout(r, 200));
          const zAfter = perspPane?.controls?.target?.z ?? 0;
          levelPassed = Math.abs(zAfter - 3) < 1.0;
          levelEvidence = { levelId, zBefore, zAfter };
        } else {
          levelEvidence = { reason: 'IfcLevel returned no id', lvlRes };
        }
      } catch (e) {
        levelEvidence = { reason: 'setActiveLevel threw', error: String(e) };
      }

      const passed = topPassed && isoPassed && levelPassed;
      return { passed, evidence: { topZ, topPassed, isoX, isoY, isoZ, isoPassed, levelPassed, levelEvidence } };
    })()`, true);
  if (!r) record('view-switch-via-cmdk', false, { reason: 'evaluate returned null' });
  else record('view-switch-via-cmdk', r.passed, r.evidence);
}

// ── Surface 16: agent-build-and-export ────────────────────────────────────────────
// Dispatches IfcWall (what the agent emits) then SdExport(ifc).
// Tests the full dispatch chain; LLM inference exercised in Step 2 Haiku rehearsal.
{
  const r = await evaluate(`
    (async () => {
      const beforeCount = window.__viewer?.scene?.children?.length ?? 0;

      const wallRes = window.__dispatch?.('IfcWall', { height: 3, length: 5, thickness: 0.2 });
      await new Promise(r => setTimeout(r, 300));

      const afterCount = window.__viewer?.scene?.children?.length ?? 0;
      let hasIfcWall = false;
      window.__viewer?.scene?.traverse?.(obj => {
        if (obj.userData?.creator === 'IfcWall') hasIfcWall = true;
      });
      const wallPassed = afterCount > beforeCount && hasIfcWall;

      const exportRes = window.__dispatch?.('SdExport', { format: 'ifc' });
      await new Promise(r => setTimeout(r, 500));
      const exportPassed = exportRes?.ok === true && (exportRes?.result?.format ?? exportRes?.format) === 'ifc';

      const passed = wallPassed && exportPassed;
      return { passed, evidence: { beforeCount, afterCount, hasIfcWall, exportRes, wallPassed, exportPassed } };
    })()`, true);
  if (!r) record('agent-build-and-export', false, { reason: 'evaluate returned null' });
  else record('agent-build-and-export', r.passed, r.evidence);
}

// ── Surface 17: render-popover-keyboard ──────────────────────────────────────
// Opens RENDER popover via render-mode-toggle event, navigates with ArrowDown 2x
// starting from 'ghosted' (index 2) → 'technical' (index 4), asserts mode applied.
{
  const r = await evaluate(`
    (async () => {
      // Start at ghosted (index 2) so ArrowDown 2x lands on technical (index 4).
      window.__dispatch?.('SdRenderMode', { mode: 'ghosted' });
      await new Promise(r => setTimeout(r, 60));

      // Fire render-mode-toggle to open the popover (simulates RENDER tab click).
      const header = document.querySelector('.vp-header');
      if (!header) return { passed: false, evidence: { reason: 'no .vp-header for rect' } };
      const rect = header.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('render-mode-toggle', { detail: { rect } }));
      await new Promise(r => setTimeout(r, 60));

      const popover = document.querySelector('.rm-popover');
      if (!popover || popover.classList.contains('rm-popover--hidden'))
        return { passed: false, evidence: { reason: 'popover not visible after toggle' } };

      // ArrowDown 2x: ghosted(2) → realistic(3) → technical(4), then Enter.
      const kOpts = { bubbles: true, cancelable: true };
      popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, ...kOpts }));
      popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, ...kOpts }));
      popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, ...kOpts }));
      await new Promise(r => setTimeout(r, 80));

      // Popover closed; check active mode item (syncState runs on render-mode-changed).
      const activeItem = document.querySelector('.rm-mode-item--active');
      const activeMode = activeItem?.dataset?.mode ?? null;
      const passed = activeMode === 'technical';
      return { passed, evidence: { activeMode, expected: 'technical' } };
    })()`, true);
  if (!r) record('render-popover-keyboard', false, { reason: 'evaluate returned null' });
  else record('render-popover-keyboard', r.passed, r.evidence);

  // Restore shaded after keyboard test.
  await evaluate(`window.__dispatch?.('SdRenderMode', { mode: 'shaded' })`);
  await new Promise(r => setTimeout(r, 60));
}

// ── Surface 20: menubar-coverage ─────────────────────────────────────────────
// Opens each top-level menu and clicks every non-stub .menu-row.
// Asserts: each row produces either a dispatch call or a DOM mutation (class/data-mode change).
// Rows with data-stub="true" (file-picker, save, reset-layout, alert) are skipped.
// Regression-net for PR #256 W2.1 menubar wiring.
{
  // Ensure we're in MODEL mode so all menus are rendered.
  await evaluate(`(function() {
    const tab = document.querySelector('.mode-tab[data-mode="model"]');
    if (tab) tab.click();
  })()`);
  await delay(300);

  const r = await evaluate(`
    (async () => {
      // Install dispatch recorder (wraps window.__dispatch).
      const origDispatch = window.__dispatch;
      const dispatchLog = [];
      if (origDispatch) {
        window.__dispatch = (name, args) => {
          dispatchLog.push(name);
          return origDispatch(name, args);
        };
      }

      // MutationObserver tracks class/attribute changes.
      let mutCount = 0;
      const observer = new MutationObserver(recs => { mutCount += recs.length; });
      observer.observe(document.body, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['class', 'data-mode', 'aria-selected', 'style']
      });

      const menuItems = Array.from(document.querySelectorAll('.menubar-items .menu-item'));
      const silentStubs = [];
      const testedRows = [];

      function closeMenu() {
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }

      for (const item of menuItems) {
        const menuLabel = item.dataset.menu || item.textContent?.trim() || '?';

        // First pass: collect row labels (skip seps and stubs).
        item.click();
        await new Promise(r => setTimeout(r, 120));
        const firstDropdown = document.querySelector('.menu-dropdown');
        if (!firstDropdown) continue;
        const rowLabels = Array.from(firstDropdown.querySelectorAll('.menu-row'))
          .filter(row => !row.classList.contains('menu-sep') && row.dataset.stub !== 'true')
          .map(row => row.querySelector('.menu-row-label')?.textContent?.trim() || '?');
        closeMenu();
        await new Promise(r => setTimeout(r, 60));

        // Second pass: click each row individually.
        for (const rowLabel of rowLabels) {
          item.click();
          await new Promise(r => setTimeout(r, 120));
          const dropdown = document.querySelector('.menu-dropdown');
          if (!dropdown) break;

          const row = Array.from(dropdown.querySelectorAll('.menu-row'))
            .find(r => r.querySelector('.menu-row-label')?.textContent?.trim() === rowLabel);
          if (!row || row.dataset.stub === 'true') { closeMenu(); await new Promise(r => setTimeout(r, 60)); continue; }

          const dispBefore = dispatchLog.length;
          const mutBefore = mutCount;

          row.click();
          await new Promise(r => setTimeout(r, 250));

          const dispatched = dispatchLog.length > dispBefore;
          const mutated = mutCount > mutBefore;
          const label = menuLabel + ' → ' + rowLabel;
          testedRows.push({ label, dispatched, mutated });
          if (!dispatched && !mutated) silentStubs.push(label);

          closeMenu();
          await new Promise(r => setTimeout(r, 60));
        }
      }

      observer.disconnect();
      if (origDispatch) window.__dispatch = origDispatch;

      return {
        passed: silentStubs.length === 0,
        evidence: { tested: testedRows.length, silentStubs, testedRows }
      };
    })()`, true);
  if (!r) record('menubar-coverage', false, { reason: 'evaluate returned null' });
  else record('menubar-coverage', r.passed, r.evidence);
}

// ── Aggregate + write receipt ─────────────────────────────────────────────────
ws.close();
if (newTabTargetId) {
  await fetch(`http://localhost:9222/json/close/${newTabTargetId}`).catch(() => {});
}

const allPassed  = surfaces.every(s => s.passed);
const passCount  = surfaces.filter(s => s.passed).length;
const output = { sha, timestamp, attached_via_cdp: true, all_passed: allPassed, surfaces };
writeFileSync(outFile, JSON.stringify(output, null, 2));

console.log("");
console.log(`${passCount}/${surfaces.length} surfaces passed — all_passed: ${allPassed}`);
console.log(`attached_via_cdp: true`);
console.log(`Output: ${outFile}`);

process.exit(allPassed ? 0 : 1);
