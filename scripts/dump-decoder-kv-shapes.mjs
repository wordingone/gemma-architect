#!/usr/bin/env node
// dump-decoder-kv-shapes.mjs — Parse E4B decoder ONNX topology and emit decoder-kv-shapes.json.
//
// Usage:
//   bun scripts/dump-decoder-kv-shapes.mjs [path/to/decoder_model_merged_q4.onnx]
//
// Default path: web/public/models/onnx-community/gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4.onnx
// Output:       web/src/agent/decoder-kv-shapes.json
//
// Requires Python + onnx package. Calls: python -c "..." (or python3).
// Does NOT need weight files — reads topology only (load_external_data=False).

import { execSync } from "child_process";
import { writeFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = resolve(__dirname, "..");

const defaultOnnxPath = join(
  repoRoot,
  "web/public/models/onnx-community/gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4.onnx"
);

const onnxPath  = process.argv[2] ? resolve(process.argv[2]) : defaultOnnxPath;
const outPath   = join(repoRoot, "web/src/agent/decoder-kv-shapes.json");

if (!existsSync(onnxPath)) {
  console.error(`[dump-decoder-kv-shapes] ONNX file not found: ${onnxPath}`);
  console.error("Download it first:");
  console.error("  curl -L -o /tmp/decoder_e4b_q4.onnx \\");
  console.error("    'https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/onnx/decoder_model_merged_q4.onnx'");
  console.error("Then: bun scripts/dump-decoder-kv-shapes.mjs /tmp/decoder_e4b_q4.onnx");
  process.exit(1);
}

console.log(`[dump-decoder-kv-shapes] Parsing: ${onnxPath}`);

const pyScript = `
import onnx, json, sys, re

model = onnx.load(${JSON.stringify(onnxPath)}, load_external_data=False)
graph = model.graph

layers = {}
for inp in graph.input:
    m = re.match(r'^past_key_values\\.(\d+)\\.key$', inp.name)
    if not m:
        continue
    idx = int(m.group(1))
    tt = inp.type.tensor_type
    dims = []
    for d in tt.shape.dim:
        dims.append(int(d.dim_value) if d.dim_value else d.dim_param)
    # dims = [batch_size, num_kv_heads, past_seq, head_dim]
    num_heads = dims[1] if len(dims) > 1 else None
    head_dim  = dims[3] if len(dims) > 3 else None
    layers[idx] = {"index": idx, "num_heads": num_heads, "head_dim": head_dim, "dims": dims}

sorted_layers = [layers[i] for i in sorted(layers.keys())]
result = {
    "num_kv_heads": sorted_layers[0]["num_heads"] if sorted_layers else None,
    "layers": sorted_layers,
}
print(json.dumps(result))
`;

let parsed;
try {
  const py = process.platform === "win32" ? "python" : "python3";
  const out = execSync(`${py} -c "${pyScript.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  parsed = JSON.parse(out.trim());
} catch (e) {
  // Fallback: build the python script to a temp file to avoid quoting issues
  const { writeFileSync: wf, unlinkSync } = await import("fs");
  const tmp = join(repoRoot, ".tmp-dump-script.py");
  wf(tmp, pyScript);
  try {
    const py = process.platform === "win32" ? "python" : "python3";
    const out = execSync(`${py} ${tmp}`, { encoding: "utf8", maxBuffer: 1024 * 1024 });
    parsed = JSON.parse(out.trim());
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

const layers     = parsed.layers;
const numHeads   = parsed.num_kv_heads;
const fullLayers = layers.filter(l => l.head_dim === 512).map(l => l.index);
const slideLayers = layers.filter(l => l.head_dim !== 512).map(l => l.index);

const lastFull    = fullLayers.length  ? Math.max(...fullLayers)  : null;
const lastSliding = slideLayers.length ? Math.max(...slideLayers) : null;

const output = {
  model: "onnx-community/gemma-4-E4B-it-ONNX",
  onnx_file: "onnx/decoder_model_merged_q4.onnx",
  source: "dump-decoder-kv-shapes.mjs — ONNX topology parse (load_external_data=False)",
  num_kv_layers: layers.length,
  num_kv_heads:  numHeads,
  last_sliding_layer: lastSliding,
  last_full_layer:    lastFull,
  full_attn_layers:   fullLayers,
  layers: layers.map(l => ({
    index:    l.index,
    type:     l.head_dim === 512 ? "full" : "sliding",
    head_dim: l.head_dim,
    shape:    l.dims,
  })),
};

writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`[dump-decoder-kv-shapes] Written: ${outPath}`);
console.log(`  num_kv_layers:   ${output.num_kv_layers}`);
console.log(`  num_kv_heads:    ${output.num_kv_heads}`);
console.log(`  full_attn_layers: [${fullLayers.join(", ")}]`);
console.log(`  last_full:       ${lastFull}`);
console.log(`  last_sliding:    ${lastSliding}`);
console.log("");
console.log("Update webgpu-mtp-backend.ts constants:");
console.log(`  FULL_ATTN = new Set([${fullLayers.join(", ")}]);`);
console.log(`  LAST_FULL = ${lastFull};`);
console.log(`  LAST_SLIDING = ${lastSliding};`);
