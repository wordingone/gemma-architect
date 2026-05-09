#!/usr/bin/env bun
// haiku-rehearsal.mjs — Step 2 of #229: Perceptual narration via /visual-check Haiku skill.
//
// Drives the W1 user flow against localhost:5175 (canonical user URL).
// At each step, captures a CDP screenshot and spawns a Haiku subagent via the
// /visual-check skill to describe + evaluate the viewport.
//
// Output: state/rehearsal-w1-<sha>.md
//
// Usage: bun scripts/haiku-rehearsal.mjs
//
// Prerequisites:
//   - Shared Chromium running at :9222 with :5175 tab
//   - /visual-check skill installed at B:/M/avir/eli/.claude/skills/visual-check/
//   - All 4 new surfaces (S13-S16) must pass in gemma-verify-raw.mjs first
//
// Invoked by Eli session; not run in automated CI (Step 1 verify is CI gate).

import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const STATE_DIR = `${process.cwd()}/state`;
mkdirSync(STATE_DIR, { recursive: true });

function getSHA() {
  try { return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const sha = getSHA();
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 16) + "Z";
const outFile = `${STATE_DIR}/rehearsal-w1-${sha}.md`;
const screenshotDir = `${STATE_DIR}/rehearsal-screenshots`;
mkdirSync(screenshotDir, { recursive: true });

// ── CDP connection ───────────────────────────────────────────────────────────

const targets = await fetch("http://localhost:9222/json").then(r => r.json());
const target = targets.find(t => t.url?.includes("localhost:5175") && t.type === "page");
if (!target) {
  console.error("ERROR: no :5175 page target — start shared Chromium first");
  process.exit(1);
}

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

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res?.result?.exceptionDetails) return null;
  return res?.result?.result?.value;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function captureScreenshot(label) {
  const res = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
  const data = res?.result?.data;
  if (!data) return null;
  const buf = Buffer.from(data, "base64");
  const path = `${screenshotDir}/${label.replace(/[^a-z0-9-]/gi, "_")}.jpg`;
  writeFileSync(path, buf);
  return path;
}

// ── Report builder ───────────────────────────────────────────────────────────

const steps = [];
function recordStep(name, screenshotPath, assertion, verdict, haiku_narration, flags) {
  steps.push({ name, screenshotPath, assertion, verdict, haiku_narration, flags });
  const icon = verdict === "PASS" ? "✓" : "✗";
  console.log(`  ${icon} ${name} — ${verdict}`);
}

// ── Reload to clean state ────────────────────────────────────────────────────

console.log("\n[haiku-rehearsal] Reloading to clean state...");
await send("Page.reload", { waitForNavigation: false });
await delay(3000);

// ── Step A: Load Schultz_Residence.ifc ──────────────────────────────────────

console.log("[haiku-rehearsal] Step A: IFC load...");
const ifcResult = await evaluate(`
  (async () => {
    const loadPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), 30000);
      window.addEventListener("viewer:ifc-loaded", (e) => { clearTimeout(t); resolve(e.detail); }, { once: true });
    });
    const resp = await fetch("/samples/Schultz_Residence.ifc");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const bytes = await resp.arrayBuffer();
    const file = new File([bytes], "Schultz_Residence.ifc", { type: "application/x-step" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.getElementById("file-input");
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const detail = await loadPromise;
    return { ok: true, detail };
  })()`);

await delay(1000);
const shotA = await captureScreenshot("A-ifc-loaded");
// NOTE: Step 2 Haiku invocation requires Claude CLI subprocess.
// In production Eli session, Eli invokes /visual-check skill manually.
// This script records the path + assertion for the Haiku invocation.
recordStep(
  "ifc-import-renders",
  shotA,
  "Scene shows a coherent multi-room residential building (Schultz Residence). Not parts at origin. Ground floor visible with rooms separated.",
  ifcResult?.ok ? "PENDING_HAIKU" : "FAIL",
  "Automated: IFC load " + (ifcResult?.ok ? "succeeded" : "failed"),
  []
);

// ── Step B: Top view ────────────────────────────────────────────────────────

console.log("[haiku-rehearsal] Step B: Top view...");
await evaluate(`window.__dispatch?.('SdSetViewOrtho', { view: 'top' })`);
await delay(500);
const shotB = await captureScreenshot("B-view-top");
recordStep(
  "view-switch-top",
  shotB,
  "Plan-view (orthographic top-down) layout showing room footprints separated. No 3D perspective.",
  "PENDING_HAIKU",
  "Automated: SdSetViewOrtho(top) dispatched",
  []
);

// ── Step C: Blueprint theme ──────────────────────────────────────────────────

console.log("[haiku-rehearsal] Step C: Blueprint theme...");
await evaluate(`document.documentElement.setAttribute('data-mode', 'night')`);
await delay(500);
const shotC = await captureScreenshot("C-blueprint-theme");
recordStep(
  "blueprint-theme",
  shotC,
  "BLUEPRINT (dark) mode active. Mesh edges clearly visible against dark background. Not faded into background.",
  "PENDING_HAIKU",
  "Automated: data-mode=night set",
  []
);

// ── Step D: Iso view + restore day ──────────────────────────────────────────

console.log("[haiku-rehearsal] Step D: Iso view...");
await evaluate(`
  window.__dispatch?.('SdSetViewOrtho', { view: 'iso' });
  document.documentElement.setAttribute('data-mode', 'day');`);
await delay(500);
const shotD = await captureScreenshot("D-view-iso-day");
recordStep(
  "view-switch-iso",
  shotD,
  "Isometric view showing building from diagonal above. Day mode (light background). Building footprint visible from 45-degree angle.",
  "PENDING_HAIKU",
  "Automated: SdSetViewOrtho(iso) + day mode",
  []
);

// ── Step E: Agent build + export (dispatch chain) ───────────────────────────

console.log("[haiku-rehearsal] Step E: IfcWall + SdExport...");
await evaluate(`
  (async () => {
    window.__dispatch?.('IfcWall', { height: 3, length: 5, thickness: 0.2 });
    await new Promise(r => setTimeout(r, 400));
    window.__dispatch?.('SdExport', { format: 'ifc' });
    await new Promise(r => setTimeout(r, 600));
  })()`);
const shotE = await captureScreenshot("E-agent-build-export");
recordStep(
  "agent-build-and-export",
  shotE,
  "A 5m wall appears in scene. IFC file offered for download (browser download bar visible or status bar shows IFC export success).",
  "PENDING_HAIKU",
  "Automated: IfcWall + SdExport dispatched",
  []
);

// ── Close CDP ────────────────────────────────────────────────────────────────

ws.close();

// ── Generate report ──────────────────────────────────────────────────────────

const allHaikuPass = steps.every(s => s.verdict === "PASS");
const pendingHaiku = steps.filter(s => s.verdict === "PENDING_HAIKU").length;
const failed = steps.filter(s => s.verdict === "FAIL").length;

let report = `# W1 Haiku Rehearsal Report\n\n`;
report += `**SHA**: ${sha}  \n`;
report += `**Generated**: ${new Date().toISOString()}  \n`;
report += `**Screenshots**: ${screenshotDir}\n\n`;
report += `## Summary\n\n`;
report += `- Steps: ${steps.length}\n`;
report += `- Deterministic FAIL: ${failed}\n`;
report += `- Pending Haiku verification: ${pendingHaiku}\n`;
report += `- Status: ${failed === 0 ? (pendingHaiku > 0 ? "AWAIT_HAIKU — run /visual-check on each step" : "PASS") : "FAIL"}\n\n`;
report += `## Steps\n\n`;

for (const s of steps) {
  report += `### ${s.name}\n\n`;
  report += `**Screenshot**: ${s.screenshotPath}\n\n`;
  report += `**Assertion**: ${s.assertion}\n\n`;
  report += `**Verdict**: ${s.verdict}\n\n`;
  report += `**Narration**: ${s.haiku_narration}\n\n`;
  if (s.flags.length > 0) {
    report += `**Flags**: ${s.flags.join(", ")}\n\n`;
  }
  report += `---\n\n`;
}

report += `## Haiku Invocation Instructions\n\n`;
report += `For each PENDING_HAIKU step above, invoke the /visual-check skill with:\n\n`;
report += `\`\`\`\n`;
report += `/visual-check <screenshot-path> "<assertion>"\n`;
report += `\`\`\`\n\n`;
report += `Haiku evaluates the screenshot + assertion. PASS iff all verdicts PASS and no hallucination flags raised.\n`;
report += `If Haiku flags pixelFlags non-empty on open-ended assertion, verdict is forced FAIL per visual-verification-via-agents.md.\n`;

writeFileSync(outFile, report, "utf-8");
console.log(`\nReport: ${outFile}`);
console.log(`Screenshots: ${screenshotDir}/`);
console.log(`Pending Haiku: ${pendingHaiku} steps`);
console.log(failed === 0 ? "Deterministic steps PASS — run Haiku on PENDING steps" : `FAIL: ${failed} deterministic failures`);
process.exit(failed > 0 ? 1 : 0);
