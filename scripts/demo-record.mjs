#!/usr/bin/env node
// scripts/demo-record.mjs — CDP Page.startScreencast recording for D4 demo video
//
// Connects to shared browser at :9222, starts Page.startScreencast on the
// canonical :5847 tab, saves JPEG frames to an output directory, then
// assembles them into an MP4 using ffmpeg on Ctrl+C.
//
// Usage:
//   node scripts/demo-record.mjs [--out DIR] [--fps N] [--quality N] [--width N] [--height N]
//
//   --out DIR       Output dir for frames + final video (default: state/demo-frames/<timestamp>)
//   --fps N         Output video frame rate (default: 15)
//   --quality N     JPEG quality 0-100 (default: 85)
//   --width N       Max capture width px (default: 1280)
//   --height N      Max capture height px (default: 800)
//   --no-assemble   Skip ffmpeg assembly on exit (frames only)
//
// Requires: ffmpeg in PATH for --no-assemble=false (default).
// Issue #150 — D4 demo recording pipeline.

import { writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { WebSocket } from "ws";
import { CDP_PORT, DEV_PORT } from "./ports.mjs";

// ── Args ──────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : def;
}
const hasFlag = name => process.argv.includes(name);

const ts      = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const outDir  = arg("--out", `state/demo-frames/${ts}`);
const fps     = parseInt(arg("--fps", "15"), 10);
const quality = parseInt(arg("--quality", "85"), 10);
const maxW    = parseInt(arg("--width", "1280"), 10);
const maxH    = parseInt(arg("--height", "800"), 10);
const noAssemble = hasFlag("--no-assemble");

mkdirSync(outDir, { recursive: true });
console.log(`[demo-record] Output dir: ${outDir}`);
console.log(`[demo-record] Video: ${fps}fps, JPEG quality ${quality}, max ${maxW}×${maxH}`);

// ── CDP connection ────────────────────────────────────────────────────────────
const targets = await fetch(`http://localhost:${CDP_PORT}/json`).then(r => r.json());
const target  = targets.find(t => t.url?.includes(`localhost:${DEV_PORT}`) && t.type === "page");
if (!target) {
  console.error(`ERROR: no :${DEV_PORT} page target found — is the shared browser running?`);
  process.exit(1);
}
console.log(`[demo-record] Connected to: ${target.url}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
let msgId = 1;
const pending = new Map();
const eventHandlers = new Map();

ws.onmessage = msg => {
  const x = JSON.parse(msg.data);
  if (x.id != null && pending.has(x.id)) {
    pending.get(x.id)(x);
    pending.delete(x.id);
  } else if (x.method) {
    eventHandlers.get(x.method)?.(x.params);
  }
};

await new Promise(r => ws.addEventListener("open", r));

function send(method, params = {}) {
  return new Promise(resolve => {
    const id = msgId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send("Page.enable");

// ── Frame capture ─────────────────────────────────────────────────────────────
let frameCount = 0;
let recording  = true;

eventHandlers.set("Page.screencastFrame", async params => {
  if (!recording) return;
  const frameNum = String(frameCount++).padStart(6, "0");
  const framePath = `${outDir}/frame-${frameNum}.jpg`;
  const buf = Buffer.from(params.data, "base64");
  writeFileSync(framePath, buf);
  // Acknowledge frame to keep screencast flowing
  await send("Page.screencastFrameAck", { sessionId: params.sessionId });
  process.stdout.write(`\r[demo-record] Frames captured: ${frameCount}`);
});

await send("Page.startScreencast", {
  format:       "jpeg",
  quality,
  maxWidth:     maxW,
  maxHeight:    maxH,
  everyNthFrame: 1,
});

console.log(`\n[demo-record] Recording started. Ctrl+C to stop and assemble video.`);
console.log(`[demo-record] Run your demo now at localhost:${DEV_PORT}`);

// ── Shutdown + assemble ───────────────────────────────────────────────────────
async function shutdown() {
  recording = false;
  console.log(`\n[demo-record] Stopping screencast... (${frameCount} frames)`);

  try { await send("Page.stopScreencast"); } catch { /* ignore */ }
  try { ws.close(); } catch { /* ignore */ }

  if (frameCount === 0) {
    console.log("[demo-record] No frames captured — nothing to assemble.");
    process.exit(0);
  }

  const videoPath = `${outDir}/demo.mp4`;

  if (noAssemble) {
    console.log(`[demo-record] Frames saved to ${outDir}/ (--no-assemble; skipping ffmpeg)`);
    console.log(`[demo-record] To assemble manually:`);
    console.log(`  ffmpeg -framerate ${fps} -pattern_type glob -i "${outDir}/frame-*.jpg" -c:v libx264 -pix_fmt yuv420p ${videoPath}`);
    process.exit(0);
  }

  // Check ffmpeg
  const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (ffmpegCheck.status !== 0) {
    console.error("[demo-record] ffmpeg not found in PATH — frames saved, assemble manually:");
    console.log(`  ffmpeg -framerate ${fps} -pattern_type glob -i "${outDir}/frame-*.jpg" -c:v libx264 -pix_fmt yuv420p ${videoPath}`);
    process.exit(1);
  }

  console.log(`[demo-record] Assembling ${frameCount} frames → ${videoPath} at ${fps}fps...`);
  const result = spawnSync("ffmpeg", [
    "-y",
    "-framerate", String(fps),
    "-pattern_type", "glob",
    "-i", `${outDir}/frame-*.jpg`,
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    videoPath,
  ], { stdio: "inherit" });

  if (result.status === 0) {
    console.log(`[demo-record] Video saved: ${videoPath}`);
    console.log(`[demo-record] Duration: ${(frameCount / fps).toFixed(1)}s`);
  } else {
    console.error("[demo-record] ffmpeg assembly failed — frames preserved in:", outDir);
    process.exit(1);
  }
  process.exit(0);
}

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

// Keep alive until signal
await new Promise(() => {});
