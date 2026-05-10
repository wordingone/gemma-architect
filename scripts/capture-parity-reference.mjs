#!/usr/bin/env bun
// capture-parity-reference.mjs — W-P1 (issue #316)
//
// Connects to the shared browser at :9222 via raw CDP WebSocket,
// loads Schultz_Residence.ifc via the sample dropdown, captures
// perspective + iso screenshots of #viewer-canvas, saves to the
// output directory as parity-reference-schultz-{perspective,iso}.png.
//
// Usage:
//   bun scripts/capture-parity-reference.mjs \
//     [--ifc Schultz_Residence.ifc] \
//     [--views perspective,iso] \
//     [--out B:/M/avir/leo/state/]
//
// Defaults:
//   --ifc  → schultz-residence (uses built-in sample dropdown)
//   --views → perspective,iso
//   --out  → B:/M/avir/leo/state/

import { writeFileSync, mkdirSync } from "fs";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
}

const OUT_DIR = getArg("--out", "B:/M/avir/leo/state").replace(/\\/g, "/").replace(/\/$/, "");
const VIEWS   = getArg("--views", "perspective,iso").split(",").map(v => v.trim());
const MIN_BYTES = 1_000_000; // 1 MB minimum per acceptance criterion

mkdirSync(OUT_DIR, { recursive: true });

// ── CDP connection ────────────────────────────────────────────────────────────

const targets = await fetch("http://localhost:9222/json").then(r => r.json());
const target = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
if (!target) {
  console.error("ERROR: no :5175 page target in shared browser. Is bun run web:dev running?");
  process.exit(1);
}
console.log(`Connecting to: ${target.url}`);

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
await send("Page.bringToFront");

async function evaluate(expression, returnByValue = true) {
  const res = await send("Runtime.evaluate", { expression, returnByValue, awaitPromise: true });
  if (res?.result?.exceptionDetails) {
    const msg = res.result.exceptionDetails?.exception?.description ?? "unknown";
    throw new Error(`evaluate threw: ${msg}`);
  }
  return res?.result?.result?.value;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Reload to clean state ─────────────────────────────────────────────────────

console.log("Reloading page to clean state...");
await send("Page.reload", { waitForNavigation: false });
await delay(3000);
await evaluate(`(window.__testMode = true, true)`);
await delay(500);

// ── Load Schultz IFC via DataTransfer injection ───────────────────────────────
// Use the same path as gemma-verify Surface 13 (file-input DataTransfer),
// which is proven stable — canvas normalizes correctly via this route.

// Install viewer:ifc-loaded handler BEFORE triggering load (no race).
console.log("Loading Schultz_Residence.ifc via file-input DataTransfer...");
await evaluate(`(function() {
  window.__parityIFCLoaded = false;
  window.addEventListener('viewer:ifc-loaded', function _h() {
    window.__parityIFCLoaded = true;
    window.removeEventListener('viewer:ifc-loaded', _h);
  });
  return true;
})()`);

const triggerOk = await evaluate(`(async function() {
  try {
    const resp = await fetch('/samples/Schultz_Residence.ifc');
    if (!resp.ok) return { ok: false, reason: 'fetch HTTP ' + resp.status };
    const bytes = await resp.arrayBuffer();
    const file = new File([bytes], 'Schultz_Residence.ifc', { type: 'application/x-step' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById('file-input');
    if (!input) return { ok: false, reason: 'no #file-input' };
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  } catch(e) { return { ok: false, reason: String(e) }; }
})()`);

if (!triggerOk?.ok) {
  console.error("ERROR: could not trigger IFC load:", triggerOk?.reason);
  process.exit(1);
}

// Poll for viewer:ifc-loaded event (timeout 60s)
console.log("Waiting for viewer:ifc-loaded event...");
let loaded = false;
for (let i = 0; i < 60; i++) {
  await delay(1000);
  const done = await evaluate(`window.__parityIFCLoaded`);
  if (done) { loaded = true; break; }
  if (i % 5 === 0) {
    const ct = await evaluate(`(function() { let c=0; window.__viewer?.scene?.traverse(o=>{ if(o.isMesh) c++; }); return c; })()`);
    console.log(`  waiting... meshes so far: ${ct}`);
  }
}

if (!loaded) {
  console.error("ERROR: viewer:ifc-loaded event not received after 60s");
  process.exit(1);
}

// After viewer:ifc-loaded, the automatic dispatchSync("SdZoomExtents") has already
// run and corrupted the camera position. SdZoomExtents → frameAllVisible() filters
// for userData.kind==="brep"|"compound" which IFC meshes lack, falls back to
// box.setFromObject(scene) which includes the grid helper in world-space — producing
// an enormous bounding box → astronomical camera position.
//
// Fix: call viewer.fitCamera(viewer.currentBounds) directly. fitCamera uses the
// IFC bounds passed during buildIfcMesh (stored as currentBounds), computed
// absolutely as camera = center + normalize(1,1,1.5) * diag * 1.7. No canvas
// size dependency, no frameAllVisible pathology.

console.log("Resetting camera via fitCamera(currentBounds)...");
const camResetOk = await evaluate(`(function() {
  const v = window.__viewer;
  if (!v) return { ok: false, reason: 'no __viewer' };
  if (!v.currentBounds) return { ok: false, reason: 'no currentBounds' };
  v.fitCamera(v.currentBounds);
  const p = v.camera.position;
  return { ok: true, camPos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
           bounds: v.currentBounds };
})()`);
console.log(`  fitCamera result:`, camResetOk);

if (!camResetOk?.ok) {
  console.error("ERROR: fitCamera failed:", camResetOk?.reason);
  process.exit(1);
}
await delay(800);

// ── Normalize canvas to viewport-area dimensions ──────────────────────────────
//
// The canvas height is driven to ~18364px by the embedded scene-panel entity list.
// Force it to the visible viewport-area-host bounds (capped to viewport height).
// This is purely for screenshot region accuracy — camera position is already
// correct from fitCamera above.

const vaRect = await evaluate(`(function() {
  const va = document.getElementById('viewport-area-host');
  if (!va) return null;
  const r = va.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top),
           w: Math.round(r.width), h: Math.min(Math.round(r.height), window.innerHeight - Math.round(r.top)) };
})()`);
if (!vaRect || vaRect.w < 100 || vaRect.h < 100) {
  console.error("ERROR: viewport-area-host not found or too small:", vaRect);
  process.exit(1);
}
console.log(`IFC loaded. Viewport area: ${vaRect.w}×${vaRect.h} at (${vaRect.x},${vaRect.y})`);

// Force canvas to viewport-area dimensions so Page.captureScreenshot clips correctly
await evaluate(`(function(w, h) {
  const c = document.getElementById('viewer-canvas');
  if (!c) return;
  c.style.cssText = 'position:absolute; top:0; left:0; width:' + w + 'px; height:' + h + 'px; ' +
                    'z-index:0; pointer-events:none; display:block;';
  window.dispatchEvent(new Event('resize'));
})(${vaRect.w}, ${vaRect.h})`);
await delay(800);
// Second resize to ensure handleResize() runs after first resize completes
await evaluate(`(function() { window.dispatchEvent(new Event('resize')); return true; })()`);
await delay(800);

// Verify renderer accepted new size
const rendererSize = await evaluate(`(function() {
  const c = document.getElementById('viewer-canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height),
           attrW: c.width, attrH: c.height };
})()`);
console.log(`  renderer size: ${rendererSize?.w}×${rendererSize?.h} CSS, ${rendererSize?.attrW}×${rendererSize?.attrH} attr`);

// Check WebGL context
const ctxOk = await evaluate(`(function() {
  const c = document.getElementById('viewer-canvas');
  if (!c) return false;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  return gl ? !gl.isContextLost() : false;
})()`);
console.log(`  WebGL context: ${ctxOk ? 'OK' : 'LOST — scene may be blank'}`);

await delay(500);
console.log("  canvas normalized. Proceeding to view captures...");

// ── Capture helper ────────────────────────────────────────────────────────────

async function captureView(view, captureRegion) {
  // Position camera using viewer internals.
  // NEVER use SdZoomExtents (→ frameAllVisible, broken for IFC).
  // NEVER use SdSetViewPerspective (also → frameAllVisible).
  // Use fitCamera(currentBounds) for perspective — absolute positioning from IFC bounds.
  // Use viewer.setView('iso') for iso — also uses currentBounds, no frameAllVisible.
  if (view === "perspective") {
    await evaluate(`(function() {
      const v = window.__viewer;
      if (v && v.currentBounds) v.fitCamera(v.currentBounds);
    })()`);
  } else if (view === "iso") {
    await evaluate(`(function() {
      const v = window.__viewer;
      if (v) v.setView('iso');
    })()`);
  }
  await delay(1500);

  // Sample camera for diagnostics
  const camPos = await evaluate(`(function() {
    const p = window.__viewer?.camera?.position;
    return p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null;
  })()`);
  console.log(`  ${view} camera: ${JSON.stringify(camPos)}`);

  // Use pre-computed capture region (viewport-area-host bounds, capped to viewport)
  const { x, y, w, h } = captureRegion;
  console.log(`  capture: ${w}×${h} at (${x},${y})`);

  // PNG screenshot — 2× scale for reference quality (gives ~4× file size vs scale:1,
  // ensuring ≥ 1MB even for well-compressed architectural scenes)
  const snap = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x, y, width: w, height: h, scale: 2 },
  });

  const b64 = snap?.result?.data;
  if (!b64) throw new Error(`captureScreenshot returned no data for view=${view}`);

  return { b64, width: w, height: h };
}

// ── Capture each view ─────────────────────────────────────────────────────────

const results = [];

for (const view of VIEWS) {
  console.log(`\nCapturing view: ${view}`);
  try {
    const { b64, width, height } = await captureView(view, vaRect);
    const buf = Buffer.from(b64, "base64");
    const outPath = `${OUT_DIR}/parity-reference-schultz-${view}.png`;
    writeFileSync(outPath, buf);

    const bytes = buf.length;
    const ok = bytes >= MIN_BYTES;
    console.log(`  saved: ${outPath} (${(bytes / 1024).toFixed(0)} KB) ${ok ? "✓" : "✗ UNDER 1MB"}`);
    results.push({ view, path: outPath, bytes, width, height, ok });

    if (!ok) {
      console.error(`ERROR: ${outPath} is only ${bytes} bytes — expected ≥ ${MIN_BYTES}`);
    }
  } catch (e) {
    console.error(`ERROR capturing ${view}: ${e.message}`);
    results.push({ view, ok: false, error: e.message });
  }
}

// ── Cleanup + summary ─────────────────────────────────────────────────────────

try { ws.close(); } catch { /* ignore */ }

const allOk = results.every(r => r.ok);
console.log(`\n${allOk ? "✓" : "✗"} ${results.filter(r => r.ok).length}/${results.length} views captured successfully`);

if (!allOk) process.exit(1);
