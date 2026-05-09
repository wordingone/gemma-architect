#!/usr/bin/env bun
// scripts/capability-bench.ts — P8b capability benchmark harness
//
// Drives the Gemma·Architect NL agent via CDP chat path with 10 architect-grade
// prompts, exports the resulting IFC, scores against expected_checks, and writes
// a receipt to state/capability-bench-<sha>-<ts>.json.
// Exported IFCs are also saved to state/ifcs/<prompt-id>-<sha>.ifc for the
// P8d round-trip judge (bun run judge).
//
// Usage:
//   bun scripts/capability-bench.ts
//   bun scripts/capability-bench.ts --prompt sf-residence-2br   # single prompt
//   bun scripts/capability-bench.ts --dry-run                   # skip CDP/IFC, check infra
//
// Prerequisite: shared browser must be up (bun run shared-browser:start).
//
// ─── Runtime with LoRA endpoint (serve_lora.py) ───────────────────────────────
// To run with fine-tuned LoRA inference instead of in-browser WebGPU:
//
//   # 1. Start FastAPI OpenAI-compat server (port 8088)
//   #    ADAPTER_DIR = path to your fine-tuned LoRA adapter directory
//   ADAPTER_DIR=<path> USE_MTP=1 python src/serve/serve_lora.py
//
//   # 2. Start Vite dev server pointing at the remote agent
//   VITE_GEMMA_AGENT_URL=http://localhost:8088 bun run web:dev
//
//   # 3. Run bench (shared browser must be open at localhost:5175)
//   bun run capability-bench
//
//   # 4. Run P8d judge over the exported IFCs
//   bun run judge
//
// Without VITE_GEMMA_AGENT_URL, the app falls back to in-browser WebGPU
// (Gemma 4 E2B via @huggingface/transformers). Bench output is identical;
// only the inference path differs.

import { readdir, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import WebSocket from "ws";

// ─── Config ───────────────────────────────────────────────────────────────────
const REPO = resolve(import.meta.dir, "..");
const PROMPTS_DIR = join(REPO, "web/test/capability/prompts");
const STATE_DIR = join(REPO, "state");
const DOWNLOAD_TMP = join(REPO, ".tmp-bench-downloads");
const CDP_PORT = 9222;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per prompt
const PAGE_READY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ─── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const FILTER = argv.indexOf("--prompt") !== -1 ? argv[argv.indexOf("--prompt") + 1] : null;

// ─── CDP connection ───────────────────────────────────────────────────────────
let ws: WebSocket | null = null;
let msgId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

function onMessage(raw: Buffer | string) {
  const msg = JSON.parse(raw.toString());
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
    }
  }
}

async function connectCDP(): Promise<void> {
  const pages = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(r => r.json()) as any[];
  const page = pages.find(p => p.type === "page");
  if (!page) throw new Error("No page target at CDP /json — is shared browser up?");
  const url = page.webSocketDebuggerUrl as string;
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.on("open", resolve);
    ws.on("error", reject);
    ws.on("message", onMessage);
    ws.on("close", () => { ws = null; });
  });
}

async function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  if (!ws || ws.readyState !== WebSocket.OPEN) await connectCDP();
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws!.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr: string): Promise<any> {
  const r = await cdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "eval threw");
  }
  return r.result?.value;
}

// ─── App helpers ──────────────────────────────────────────────────────────────
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

async function poll(check: () => Promise<boolean>, intervalMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`poll timed out after ${timeoutMs}ms`);
}

// Send keyboard event (Ctrl+A or Delete) via CDP Input.dispatchKeyEvent
async function dispatchKey(key: string, ctrlKey = false): Promise<void> {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const opts = { key, code, type: "keyDown" as const, modifiers: ctrlKey ? 2 : 0 };
  await cdp("Input.dispatchKeyEvent", opts);
  await cdp("Input.dispatchKeyEvent", { ...opts, type: "keyUp" });
}

async function clearScene(): Promise<void> {
  // Select all geometry then delete it. Gives DOM focus to viewer first.
  await evaluate("document.querySelector('.palette-btn[data-tool=\"select\"]')?.click()");
  await sleep(200);
  await dispatchKey("a", true);  // Ctrl+A
  await sleep(300);
  await dispatchKey("Delete");
  await sleep(500);
}

async function ensureChatMode(): Promise<void> {
  const mode = await evaluate("document.querySelector('.mode-pill')?.dataset?.mode");
  if (mode !== "console") return; // already in prompt/chat mode
  await evaluate("document.querySelector('.mode-pill')?.click()");
  await poll(
    async () => !!(await evaluate("document.querySelector('.chat-input')")),
    300,
    5000,
  );
}

async function sendChatPrompt(text: string): Promise<void> {
  // Use React-compatible value setter so the chat textarea's onChange fires.
  // Guard against null el: if .chat-input is absent (e.g. mode is "console"),
  // throw a clear error rather than the cryptic "Illegal invocation" from setter.call(null, …).
  const elFound = await evaluate("!!document.querySelector('.chat-input')") as boolean;
  if (!elFound) throw new Error("chat-input not found — mode may not be 'prompt'; call ensureChatMode() first");
  await evaluate(`
    (function() {
      const el = document.querySelector('.chat-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()
  `);
  await sleep(150);
  await evaluate("document.querySelector('.chat-send-btn')?.click()");
}

// Poll until: button back to "SEND" (not disabled, not "…").
// Then handle the optional plan-confirm step.
async function waitAgentDone(): Promise<void> {
  const deadline = Date.now() + AGENT_TIMEOUT_MS;
  let phase: "thinking" | "plan" | "done" = "thinking";

  while (Date.now() < deadline) {
    await sleep(2000);

    const state = await evaluate(`JSON.stringify({
      btnText: document.querySelector('.chat-send-btn')?.textContent ?? '',
      btnDisabled: document.querySelector('.chat-send-btn')?.disabled ?? true,
      hasThinking: !!document.querySelector('.chat-thinking'),
      hasPlanBtn: !!document.querySelector('.chat-plan-run-btn'),
      planPending: document.querySelectorAll('.chat-plan-pending').length,
      hasError: !!document.querySelector('.chat-msg-error')
    })`);
    const s = JSON.parse(state);

    if (s.hasError) {
      const errText = await evaluate(
        "[...document.querySelectorAll('.chat-msg-error')].map(e=>e.textContent).join(' | ')"
      ) as string;
      throw new Error(`Agent error: ${errText.slice(0, 200)}`);
    }

    if (phase === "thinking") {
      // Waiting for model generation to finish (send button re-enables)
      if (!s.btnDisabled && s.btnText === "SEND" && !s.hasThinking) {
        if (s.hasPlanBtn) {
          // Complex plan shown — click "Run plan" automatically
          console.log("    clicking Run plan...");
          await evaluate("document.querySelector('.chat-plan-run-btn')?.click()");
          phase = "plan";
        } else {
          phase = "done";
        }
      }
    } else if (phase === "plan") {
      // Waiting for plan execution (.chat-plan-pending gone)
      if (s.planPending === 0) {
        phase = "done";
      }
    }

    if (phase === "done") return;
  }
  throw new Error(`Agent did not complete within ${AGENT_TIMEOUT_MS / 1000}s`);
}

async function captureViewportSnapshot(promptId: string, sha: string): Promise<string | null> {
  try {
    const bbox = await evaluate(`
      (function() {
        const el = document.querySelector('#viewport-2');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      })()
    `) as { x: number; y: number; width: number; height: number } | null;
    if (!bbox || bbox.width < 1 || bbox.height < 1) return null;

    await evaluate("window.__viewer?.frameAllVisible?.()");
    await sleep(400);

    const result = await cdp("Page.captureScreenshot", {
      format: "png",
      clip: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height, scale: 1 },
    });

    const snapshotsDir = join(REPO, "web/public/snapshots");
    await mkdir(snapshotsDir, { recursive: true });
    const outPath = join(snapshotsDir, `${promptId}-${sha}.png`);
    await writeFile(outPath, Buffer.from(result.data as string, "base64"));
    return outPath;
  } catch (e) {
    console.error("    snapshot error:", (e as Error).message);
    return null;
  }
}

// ─── Brep-scene IFC export ────────────────────────────────────────────────────
// The OpenCascade ".exp-btn[data-fmt=ifc]" export button always exports the
// demo-wall geometry that auto-runs on page load (5.5×0.2×2.8m). Agent geometry
// lives in the THREE.js brep viewer (userData.kind="brep"). We collect it via
// CDP evaluate() and serialize to IFC STEP-21 in-process.

interface BrepMeshInfo {
  creator: string;
  spaceName: string | null;
  levelName: string | null;
  label: string | null;
  bbox: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

async function collectBrepMeshes(): Promise<BrepMeshInfo[]> {
  const json = await evaluate(`(function() {
    if (!window.__viewer || !window.__viewer.scene) return '[]';
    window.__viewer.scene.updateMatrixWorld(true);
    var results = [];
    window.__viewer.scene.traverse(function(obj) {
      if (!obj.isMesh) return;
      var ud = obj.userData || {};
      if (ud.kind !== 'brep' && ud.kind !== 'compound') return;
      if (!obj.geometry) return;
      obj.geometry.computeBoundingBox();
      var lb = obj.geometry.boundingBox;
      if (!lb || !isFinite(lb.min.x)) return;
      var m = obj.matrixWorld.elements;
      function t(x,y,z){return{x:m[0]*x+m[4]*y+m[8]*z+m[12],y:m[1]*x+m[5]*y+m[9]*z+m[13],z:m[2]*x+m[6]*y+m[10]*z+m[14]};}
      var cs=[t(lb.min.x,lb.min.y,lb.min.z),t(lb.max.x,lb.min.y,lb.min.z),t(lb.min.x,lb.max.y,lb.min.z),t(lb.max.x,lb.max.y,lb.min.z),
              t(lb.min.x,lb.min.y,lb.max.z),t(lb.max.x,lb.min.y,lb.max.z),t(lb.min.x,lb.max.y,lb.max.z),t(lb.max.x,lb.max.y,lb.max.z)];
      var mnX=1e9,mnY=1e9,mnZ=1e9,mxX=-1e9,mxY=-1e9,mxZ=-1e9;
      cs.forEach(function(c){if(c.x<mnX)mnX=c.x;if(c.x>mxX)mxX=c.x;if(c.y<mnY)mnY=c.y;if(c.y>mxY)mxY=c.y;if(c.z<mnZ)mnZ=c.z;if(c.z>mxZ)mxZ=c.z;});
      results.push({creator:ud.creator||'Unknown',spaceName:ud.spaceName||null,levelName:ud.levelName||null,label:ud.label||null,
                    bbox:{minX:mnX,maxX:mxX,minY:mnY,maxY:mxY,minZ:mnZ,maxZ:mxZ}});
    });
    return JSON.stringify(results);
  })()`);
  try { return JSON.parse(json ?? "[]"); } catch { return []; }
}

function buildMultiEntityIFC(meshes: BrepMeshInfo[]): string {
  const L: string[] = [];
  let n = 0;
  const nid = () => `#${++n}`;
  const sf = (v: number) => !isFinite(v) ? "0." : Number.isInteger(v) ? v.toFixed(1) : String(+v.toFixed(6));
  const ss = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const gg = () => { const a="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$"; let o=""; for(let i=0;i<22;i++) o+=a[Math.floor(Math.random()*64)]; return o; };

  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  L.push("ISO-10303-21;","HEADER;",
    `FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');`,
    `FILE_NAME('gemma-bench-brep.ifc',${ss(ts)},(${ss("gemma-architect")}),(${ss("gemma-architect")}),${ss("bench-brep-emitter/0.1")},${ss("gemma-architect/0.1")},'');`,
    "FILE_SCHEMA(('IFC4'));","ENDSEC;","DATA;");

  const per=nid(); L.push(`${per}=IFCPERSON($,$,${ss("gemma-architect")},$,$,$,$,$);`);
  const org=nid(); L.push(`${org}=IFCORGANIZATION($,${ss("gemma-architect")},$,$,$);`);
  const pao=nid(); L.push(`${pao}=IFCPERSONANDORGANIZATION(${per},${org},$);`);
  const apl=nid(); L.push(`${apl}=IFCAPPLICATION(${org},${ss("0.1")},${ss("gemma-architect bench")},${ss("gemma-bench")});`);
  const oh=nid(); const epoch=Math.floor(Date.now()/1000);
  L.push(`${oh}=IFCOWNERHISTORY(${pao},${apl},$,.ADDED.,${epoch},${pao},${apl},${epoch});`);

  const dz=nid(); L.push(`${dz}=IFCDIRECTION((0.,0.,1.));`);
  const dx=nid(); L.push(`${dx}=IFCDIRECTION((1.,0.,0.));`);
  const o0=nid(); L.push(`${o0}=IFCCARTESIANPOINT((0.,0.,0.));`);
  const ax=nid(); L.push(`${ax}=IFCAXIS2PLACEMENT3D(${o0},${dz},${dx});`);
  const cx=nid(); L.push(`${cx}=IFCGEOMETRICREPRESENTATIONCONTEXT($,${ss("Model")},3,1.0E-5,${ax},$);`);
  const lu=nid(); L.push(`${lu}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  const au=nid(); L.push(`${au}=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);`);
  const aru=nid(); L.push(`${aru}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
  const vu=nid(); L.push(`${vu}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
  const ua=nid(); L.push(`${ua}=IFCUNITASSIGNMENT((${lu},${au},${aru},${vu}));`);

  const lp=nid(); L.push(`${lp}=IFCLOCALPLACEMENT($,${ax});`);
  const proj=nid(); L.push(`${proj}=IFCPROJECT(${ss(gg())},${oh},${ss("GemmaArchitect Bench")},$,$,$,$,(${cx}),${ua});`);
  const site=nid(); L.push(`${site}=IFCSITE(${ss(gg())},${oh},${ss("Site")},$,$,${lp},$,$,.ELEMENT.,$,$,$,$,$);`);
  const bld=nid(); L.push(`${bld}=IFCBUILDING(${ss(gg())},${oh},${ss("Building")},$,$,${lp},$,$,.ELEMENT.,$,$,$);`);

  // Storeys: one per IfcLevel mesh, or one default ground storey
  const levelMeshes = meshes.filter(m => m.creator === "IfcLevel");
  const storeyIds: string[] = [];
  if (levelMeshes.length === 0) {
    const s=nid(); L.push(`${s}=IFCBUILDINGSTOREY(${ss(gg())},${oh},${ss("Ground Floor")},$,$,${lp},$,$,.ELEMENT.,0.);`);
    storeyIds.push(s);
  } else {
    for (const lm of levelMeshes) {
      const elev = lm.bbox.minZ;
      const nm = lm.levelName ?? (elev < 0.1 ? "Ground Floor" : `Level ${elev.toFixed(1)}m`);
      const s=nid(); L.push(`${s}=IFCBUILDINGSTOREY(${ss(gg())},${oh},${ss(nm)},$,$,${lp},$,$,.ELEMENT.,${sf(elev)});`);
      storeyIds.push(s);
    }
  }
  const pa=nid(); L.push(`${pa}=IFCRELAGGREGATES(${ss(gg())},${oh},$,$,${proj},(${site}));`);
  const sa=nid(); L.push(`${sa}=IFCRELAGGREGATES(${ss(gg())},${oh},$,$,${site},(${bld}));`);
  const ba=nid(); L.push(`${ba}=IFCRELAGGREGATES(${ss(gg())},${oh},$,$,${bld},(${storeyIds.join(",")}));`);

  const contained: string[] = [];

  // Build box geometry from world-space bounding box → IFCFACETEDBREP
  function boxGeom(b: BrepMeshInfo["bbox"]) {
    const {minX,maxX,minY,maxY,minZ,maxZ} = b;
    const pts = [[minX,minY,minZ],[maxX,minY,minZ],[maxX,maxY,minZ],[minX,maxY,minZ],
                 [minX,minY,maxZ],[maxX,minY,maxZ],[maxX,maxY,maxZ],[minX,maxY,maxZ]];
    const pids = pts.map(([x,y,z]) => { const p=nid(); L.push(`${p}=IFCCARTESIANPOINT((${sf(x)},${sf(y)},${sf(z)}));`); return p; });
    const tris = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[2,6,7],[2,7,3],[0,3,7],[0,7,4],[1,5,6],[1,6,2]];
    const faces = tris.map(([a,b,c]) => {
      const pl=nid(); L.push(`${pl}=IFCPOLYLOOP((${pids[a]},${pids[b]},${pids[c]}));`);
      const fb=nid(); L.push(`${fb}=IFCFACEOUTERBOUND(${pl},.T.);`);
      const fc=nid(); L.push(`${fc}=IFCFACE((${fb}));`); return fc;
    });
    const sh=nid(); L.push(`${sh}=IFCCLOSEDSHELL((${faces.join(",")}));`);
    const br=nid(); L.push(`${br}=IFCFACETEDBREP(${sh});`);
    const sr=nid(); L.push(`${sr}=IFCSHAPEREPRESENTATION(${cx},${ss("Body")},${ss("Brep")},(${br}));`);
    const ps=nid(); L.push(`${ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(${sr}));`);
    const ep=nid(); L.push(`${ep}=IFCLOCALPLACEMENT(${lp},${ax});`);
    return { shape: ps, place: ep };
  }

  for (const m of meshes) {
    if (m.creator === "IfcLevel") continue;
    const { shape, place } = boxGeom(m.bbox);
    const eid=nid();
    const nm = m.spaceName ?? m.levelName ?? m.label ?? m.creator;
    const g = ss(gg());
    switch (m.creator) {
      case "IfcWall":
        L.push(`${eid}=IFCWALL(${g},${oh},${ss("Wall")},$,$,${place},${shape},$,.STANDARD.);`); break;
      case "IfcSlab":
        L.push(`${eid}=IFCSLAB(${g},${oh},${ss("Slab")},$,$,${place},${shape},$,.FLOOR.);`); break;
      case "IfcColumn":
        L.push(`${eid}=IFCCOLUMN(${g},${oh},${ss("Column")},$,$,${place},${shape},$,.COLUMN.);`); break;
      case "IfcBeam":
        L.push(`${eid}=IFCBEAM(${g},${oh},${ss("Beam")},$,$,${place},${shape},$,.BEAM.);`); break;
      case "IfcStair":
        L.push(`${eid}=IFCSTAIR(${g},${oh},${ss("Stair")},$,$,${place},${shape},$,.STRAIGHT_RUN_STAIR.);`); break;
      case "IfcRoof":
        L.push(`${eid}=IFCROOF(${g},${oh},${ss("Roof")},$,$,${place},${shape},$,.FLAT_ROOF.);`); break;
      case "IfcSpace":
        L.push(`${eid}=IFCSPACE(${g},${oh},${ss(nm)},$,$,${place},${shape},$,.INTERNAL.,$,$);`); break;
      case "IfcDoor": {
        const w=sf(m.bbox.maxX-m.bbox.minX); const h=sf(m.bbox.maxZ-m.bbox.minZ);
        L.push(`${eid}=IFCDOOR(${g},${oh},${ss("Door")},$,$,${place},${shape},$,.NOTDEFINED.,${h},${w});`); break;
      }
      case "IfcWindow": {
        const w=sf(m.bbox.maxX-m.bbox.minX); const h=sf(m.bbox.maxZ-m.bbox.minZ);
        L.push(`${eid}=IFCWINDOW(${g},${oh},${ss("Window")},$,$,${place},${shape},$,.NOTDEFINED.,${h},${w});`); break;
      }
      case "IfcFoundation":
        L.push(`${eid}=IFCFOOTING(${g},${oh},${ss("Footing")},$,$,${place},${shape},$,.PAD_FOOTING.);`); break;
      default:
        L.push(`${eid}=IFCBUILDINGELEMENTPROXY(${g},${oh},${ss(m.creator)},$,$,${place},${shape},$,.NOTDEFINED.);`); break;
    }
    contained.push(eid);
  }

  if (contained.length > 0) {
    const ci=nid(); L.push(`${ci}=IFCRELCONTAINEDINSPATIALSTRUCTURE(${ss(gg())},${oh},$,$,(${contained.join(",")}),${storeyIds[0]});`);
  }
  L.push("ENDSEC;","END-ISO-10303-21;");
  return L.join("\n");
}

async function exportIFC(): Promise<string> {
  await mkdir(DOWNLOAD_TMP, { recursive: true });
  const meshes = await collectBrepMeshes();
  const ifcText = buildMultiEntityIFC(meshes);
  const outPath = join(DOWNLOAD_TMP, "agent-brep.ifc");
  await writeFile(outPath, ifcText);
  return outPath;
}

// ─── IFC check types ──────────────────────────────────────────────────────────
type CheckSpec = {
  id: string;
  description: string;
  type: "count" | "dimension" | "area" | "z_extent" | "presence" | "door_width" | "storey_elevation";
  target?: string;
  tag_contains?: string;
  axis?: "X" | "Y" | "Z";
  min?: number;
  max?: number;
  exact?: number;
  min_width?: number;
  elevation?: number;    // storey_elevation: expected elevation in metres
  tolerance?: number;    // storey_elevation: tolerance (default 0.15m)
};

type CheckResult = {
  id: string;
  pass: boolean;
  actual?: number | null;
  reason: string;
};

// Count IFC entities by class name, with optional name-field substring filter.
// Handles: IFCWALL, IFCSPACE, IFCDOOR, IFCBUILDINGSTOREY, IFCROOF, etc.
function countEntities(text: string, target: string, tagContains?: string): number {
  const cls = target.toUpperCase();
  if (!tagContains) {
    // Fast path: count all occurrences.
    let n = 0;
    let i = text.indexOf(cls + "(");
    while (i !== -1) { n++; i = text.indexOf(cls + "(", i + 1); }
    return n;
  }
  // Capture the Name argument (3rd positional string, after GlobalId + OwnerHistory).
  // IFC text format: IFCSPACE('GUID',#H,'Name','Desc',...
  const needle = tagContains.toLowerCase();
  const re = new RegExp(`${cls}\\('[^']*',(?:\\$|[^,]+),'([^']*)'`, "g");
  let n = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1].toLowerCase().includes(needle)) n++;
  }
  return n;
}

function scoreCount(c: CheckSpec, text: string): CheckResult {
  const n = countEntities(text, c.target!, c.tag_contains);
  const pass =
    (c.min === undefined || n >= c.min) &&
    (c.max === undefined || n <= c.max) &&
    (c.exact === undefined || n === c.exact);
  return { id: c.id, pass, actual: n, reason: `${c.target}${c.tag_contains ? `[~"${c.tag_contains}"]` : ""}: found ${n}; min=${c.min ?? "—"} max=${c.max ?? "—"}` };
}

function scorePresence(c: CheckSpec, text: string): CheckResult {
  const n = countEntities(text, c.target!);
  return { id: c.id, pass: n > 0, actual: n, reason: `${c.target}: ${n} instance(s)` };
}

function scoreDimension(c: CheckSpec, bbox: BBox | null): CheckResult {
  if (!bbox) return { id: c.id, pass: false, actual: null, reason: "empty scene — no geometry" };
  const span = c.axis === "X" ? bbox.maxX - bbox.minX
             : c.axis === "Y" ? bbox.maxY - bbox.minY
             : bbox.maxZ - bbox.minZ;
  const v = +span.toFixed(3);
  const pass = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
  return { id: c.id, pass, actual: v, reason: `${c.axis}-span=${v}m; range=[${c.min},${c.max}]` };
}

function scoreArea(c: CheckSpec, text: string, bbox: BBox | null): CheckResult {
  // Try IfcQuantityArea first (exported by some IFC writers)
  let area = 0;
  const qaRe = /IFCQUANTITYAREA\('[^']*','[^']*',\$,([.\d]+)/g;
  let m: RegExpExecArray | null;
  while ((m = qaRe.exec(text)) !== null) { area += parseFloat(m[1]); }

  // Fallback: sum IfcSpace GrossFloorArea properties (text scanning)
  if (area === 0) {
    const spaceRe = /IFCSPACE\([^;]+\)/g;
    // area embedded in IFCPROPERTYSINGLEVALUE or IFCQUANTITYAREA lines near spaces is unreliable
    // — fall through to bbox
  }

  // Final fallback: footprint bounding box product
  if (area === 0 && bbox) {
    area = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
  }

  const v = +area.toFixed(1);
  const pass = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
  return { id: c.id, pass, actual: v, reason: `area=${v}m²; range=[${c.min},${c.max}]` };
}

function scoreZExtent(c: CheckSpec, bbox: BBox | null): CheckResult {
  if (!bbox) return { id: c.id, pass: false, actual: null, reason: "empty scene — no geometry" };
  const v = +(bbox.maxZ - bbox.minZ).toFixed(3);
  const pass = (c.min === undefined || v >= c.min) && (c.max === undefined || v <= c.max);
  return { id: c.id, pass, actual: v, reason: `Z-extent=${v}m; range=[${c.min},${c.max}]` };
}

function scoreDoorWidth(c: CheckSpec, text: string): CheckResult {
  const minW = c.min_width ?? 0;
  // IfcDoor in IFC4: IFCDOOR(GlobalId,OwnerHistory,Name,Desc,ObjectType,ObjectPlacement,
  //   Representation,Tag,PredefinedType,OverallHeight,OverallWidth)
  // OverallWidth is 11th arg (index 10, zero-based).
  const lineRe = /IFCDOOR\(([^;]+)\)/g;
  let minFound = Infinity;
  let count = 0;
  let allPass = true;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    const parts = m[1].split(",");
    // Try index 10 (OverallWidth IFC4), then 9 (IFC2x3 fallback)
    for (const idx of [10, 9, 8]) {
      const raw = parts[idx]?.trim();
      if (!raw) continue;
      const v = parseFloat(raw);
      if (!isNaN(v) && v > 0.1) { // skip implausible values
        count++;
        minFound = Math.min(minFound, v);
        if (v < minW) allPass = false;
        break;
      }
    }
  }
  if (count === 0) return { id: c.id, pass: false, actual: null, reason: "no IFCDOOR entities with parseable width" };
  const v = +minFound.toFixed(3);
  return { id: c.id, pass: allPass, actual: v, reason: `min door width=${v}m; required≥${minW}; ${count} door(s)` };
}

function scoreStoreyElevation(c: CheckSpec, text: string): CheckResult {
  // Parse elevation (last numeric arg) from each IFCBUILDINGSTOREY line.
  // IFC4 format: IFCBUILDINGSTOREY('GUID',#H,'Name',$,$,#P,$,$,.ELEMENT.,0.);
  const re = /IFCBUILDINGSTOREY\([^;]+,([+-]?(?:\d+\.?\d*|\.\d+))\s*\)/g;
  const elevations: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1]);
    if (isFinite(v)) elevations.push(v);
  }
  const target = c.elevation ?? 0;
  const tol = c.tolerance ?? 0.15;
  const pass = elevations.some(e => Math.abs(e - target) <= tol);
  const found = elevations.map(e => e.toFixed(2)).join(", ");
  return { id: c.id, pass, actual: elevations.length, reason: `storeys at [${found || "none"}]; expected ≈${target}m ±${tol}` };
}

// ─── Bounding box via web-ifc ─────────────────────────────────────────────────
type BBox = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };

async function computeBBox(buf: Buffer): Promise<BBox | null> {
  try {
    const { IfcAPI } = await import("web-ifc");
    const api = new IfcAPI();
    await api.Init();
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const modelID = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true } as any);

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let hasVerts = false;

    api.StreamAllMeshes(modelID, (flatMesh: any) => {
      const sz = flatMesh.geometries.size();
      for (let j = 0; j < sz; j++) {
        const placed = flatMesh.geometries.get(j);
        const geom = api.GetGeometry(modelID, placed.geometryExpressID);
        const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize()) as Float32Array;
        const m = placed.flatTransformation as number[];
        for (let v = 0; v < verts.length; v += 6) {
          hasVerts = true;
          const x = verts[v], y = verts[v + 1], z = verts[v + 2];
          // column-major matrix: wx = m[0]*x + m[4]*y + m[8]*z + m[12]
          const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
          if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
          if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
          if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
        }
      }
    });

    api.CloseModel(modelID);
    if (!hasVerts) return null;
    return { minX, maxX, minY, maxY, minZ, maxZ };
  } catch (e) {
    console.error("    bbox error:", (e as Error).message);
    return null;
  }
}

// ─── Score one prompt's IFC against all expected_checks ───────────────────────
async function scoreIFC(ifcPath: string, checks: CheckSpec[]): Promise<CheckResult[]> {
  const buf = await readFile(ifcPath);
  const text = buf.toString("utf-8");
  const needsGeom = checks.some(c => ["dimension", "area", "z_extent"].includes(c.type));
  const bbox = needsGeom ? await computeBBox(buf) : null;

  return checks.map(c => {
    switch (c.type) {
      case "count":      return scoreCount(c, text);
      case "presence":   return scorePresence(c, text);
      case "dimension":  return scoreDimension(c, bbox);
      case "area":       return scoreArea(c, text, bbox);
      case "z_extent":         return scoreZExtent(c, bbox);
      case "door_width":       return scoreDoorWidth(c, text);
      case "storey_elevation": return scoreStoreyElevation(c, text);
      default:                 return { id: c.id, pass: false, actual: null, reason: `unknown check type: ${(c as any).type}` };
    }
  });
}

// ─── Prompt type ─────────────────────────────────────────────────────────────
type PromptFile = {
  id: string;
  category: string;
  prompt: string;
  min_pass_threshold: number;
  expected_checks: CheckSpec[];
};

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Load prompts
  const files = await readdir(PROMPTS_DIR);
  let prompts: PromptFile[] = [];
  for (const f of files.filter(f => f.endsWith(".json"))) {
    const p: PromptFile = JSON.parse(await readFile(join(PROMPTS_DIR, f), "utf-8"));
    if (!FILTER || p.id === FILTER) prompts.push(p);
  }
  if (prompts.length === 0) throw new Error(`No prompts found (filter: ${FILTER ?? "none"})`);
  console.log(`Loaded ${prompts.length} prompt(s)`);

  const sha = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  const ts = new Date().toISOString().replace(/:/g, "-").slice(0, 19);

  await mkdir(DOWNLOAD_TMP, { recursive: true });
  await mkdir(STATE_DIR, { recursive: true });

  if (!DRY_RUN) {
    await connectCDP();
    console.log("CDP connected");
    await cdp("Page.enable");
    await cdp("Page.setDownloadBehavior", { behavior: "allow", downloadPath: DOWNLOAD_TMP });

    // Verify model is loaded before starting the bench run.
    const badge = await evaluate("document.getElementById('ai-model-badge')?.textContent?.trim() ?? ''") as string;
    console.log(`Model status: ${badge}`);
    if (!badge.includes("LIVE")) {
      console.log("Waiting up to 90s for model to load...");
      await poll(
        async () => ((await evaluate("document.getElementById('ai-model-badge')?.textContent ?? ''")) as string).includes("LIVE"),
        3000,
        90_000,
      );
      console.log("Model ready.");
    }

    // P10-1: Refuse to bench without remote inference — prevents in-browser WebGPU
    // from exhausting VRAM and crashing the OS. Start dev server with
    // VITE_GEMMA_AGENT_URL=http://localhost:8088 and verify serve_base.py is up.
    const finalBadge = await evaluate("document.getElementById('ai-model-badge')?.textContent?.trim() ?? ''") as string;
    if (!finalBadge.toUpperCase().includes("REMOTE")) {
      throw new Error(
        `Bench refused: model is running in-browser WebGPU (badge: "${finalBadge}"). ` +
        "Start the dev server with VITE_GEMMA_AGENT_URL=http://localhost:8088 and ensure " +
        "serve_base.py (or serve_lora.py) is running on that port before benching."
      );
    }
    console.log("Remote inference confirmed — safe to bench.");

    // P10-5: Bench/chat mutual exclusion — warn (not refuse) if a chat session
    // is currently active (send button enabled or model is processing).
    // Concurrent in-browser inference + bench drives double GPU memory pressure.
    const chatBusy = await evaluate(`(() => {
      const sendBtn = document.querySelector('.chat-send-btn');
      const thinking = document.querySelector('.chat-thinking, .chat-plan-pending');
      const disabled = sendBtn?.disabled ?? false;
      // send-btn disabled during inference; thinking spinner present
      return !disabled && !!thinking;
    })()`);
    if (chatBusy) {
      console.warn(
        "[P10-5] WARNING: An active chat inference session was detected. " +
        "Concurrent bench + chat may cause VRAM pressure. " +
        "Complete or cancel the chat turn before benching to avoid GPU buffer corruption."
      );
      window?.dispatchEvent?.(new CustomEvent("bench:warning", { detail: { event: "concurrent_chat_session" } }));
    } else {
      console.log("P10-5: No concurrent chat session detected — safe to proceed.");
    }

    // Ensure chat mode is active for the whole bench run.
    await ensureChatMode();
  }

  const results: any[] = [];
  const startAll = Date.now();

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];
    const t0 = Date.now();
    console.log(`\n[${i + 1}/${prompts.length}] ${p.id} (${p.category})`);
    console.log(`  "${p.prompt.slice(0, 100)}${p.prompt.length > 100 ? "…" : ""}"`);

    if (DRY_RUN) {
      results.push({ id: p.id, skipped: true, reason: "dry-run" });
      continue;
    }

    let error: string | null = null;
    let checkResults: CheckResult[] = [];
    let ifcPath: string | null = null;
    let snapPath: string | null = null;

    try {
      // Clear geometry from previous run (no page reload — preserves GPU/ONNX state).
      console.log("  clearing scene...");
      await clearScene();

      // Re-ensure chat mode per prompt — mode may reset to "console" after an agent error/timeout.
      await ensureChatMode();

      console.log("  sending prompt...");
      await sendChatPrompt(p.prompt);

      console.log("  waiting for agent...");
      await waitAgentDone();
      console.log(`  agent done (${Math.round((Date.now() - t0) / 1000)}s)`);

      console.log("  exporting IFC...");
      ifcPath = await exportIFC();
      console.log(`  downloaded: ${ifcPath}`);

      // Persist IFC for judge.ts (P8d round-trip judge)
      const ifcsDir = join(STATE_DIR, "ifcs");
      await mkdir(ifcsDir, { recursive: true });
      const savedIFCPath = join(ifcsDir, `${p.id}-${sha}.ifc`);
      await copyFile(ifcPath, savedIFCPath);
      console.log(`  saved: ${savedIFCPath}`);

      snapPath = await captureViewportSnapshot(p.id, sha);
      if (snapPath) console.log(`  snapshot: ${snapPath}`);

      console.log("  scoring...");
      checkResults = await scoreIFC(ifcPath, p.expected_checks);
    } catch (e: any) {
      error = e.message;
      console.error(`  ERROR: ${e.message}`);
    }

    const passed = checkResults.filter(c => c.pass).length;
    const total = p.expected_checks.length;
    const score = total > 0 ? passed / total : 0;
    const ok = error === null && score >= p.min_pass_threshold;
    const elapsed = Math.round((Date.now() - t0) / 1000);

    if (checkResults.length > 0) {
      checkResults.forEach(c =>
        console.log(`    ${c.pass ? "✓" : "✗"} ${c.id}: ${c.reason}`)
      );
    }
    console.log(`  → ${ok ? "PASS" : "FAIL"} ${passed}/${total} (${(score * 100).toFixed(0)}%) in ${elapsed}s`);

    results.push({
      id: p.id,
      category: p.category,
      pass: ok,
      score: +score.toFixed(3),
      checks_passed: passed,
      checks_total: total,
      min_pass_threshold: p.min_pass_threshold,
      elapsed_s: elapsed,
      error,
      check_details: checkResults,
      snapshot: snapPath ?? null,
    });

    // P10-3: 8s cooldown between prompts — lets GPU driver release transient buffer
    // state between OrtRun invocations, reducing cascading VRAM pressure.
    if (!DRY_RUN && i < prompts.length - 1) {
      console.log("  cooldown 8s...");
      await sleep(8000);
    }
  }

  const totalPassed = results.filter(r => r.pass).length;
  const totalRun = results.filter(r => !r.skipped).length;
  const elapsedAll = Math.round((Date.now() - startAll) / 1000);
  const passRate = totalRun > 0 ? +(totalPassed / totalRun).toFixed(3) : 0;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Summary: ${totalPassed}/${totalRun} prompts pass (${(passRate * 100).toFixed(0)}%)`);
  console.log(`Total time: ${Math.floor(elapsedAll / 60)}m ${elapsedAll % 60}s`);

  const receipt = {
    sha,
    ran_at: new Date().toISOString(),
    prompts_run: totalRun,
    prompts_passed: totalPassed,
    pass_rate: passRate,
    elapsed_s: elapsedAll,
    results,
  };

  const receiptPath = join(STATE_DIR, `capability-bench-${sha}-${ts}.json`);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`Receipt: ${receiptPath}`);

  if (ws) ws.close();
}

main().catch(e => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
