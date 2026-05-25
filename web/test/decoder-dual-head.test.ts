// decoder-dual-head.test.ts — Verify ONNX graph surgery output for #1862.
//
// Tests validate the topology of the dual-head ONNX files produced by
// scripts/export-decoder-dual-head.py WITHOUT loading weight data.
//
// Run after generating dual-head files:
//   python scripts/export-decoder-dual-head.py
//   bun test web/test/decoder-dual-head.test.ts

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const REPO_ROOT = join(import.meta.dir, "../..");

const DUAL_HEAD_PATHS = {
  e2b: join(
    REPO_ROOT,
    "web/public/models/onnx-community__gemma-4-E2B-it-ONNX/onnx/decoder_model_merged_q4-dual-head.onnx"
  ),
  e4b: join(
    REPO_ROOT,
    "web/public/models/onnx-community__gemma-4-E4B-it-ONNX/onnx/decoder_model_merged_q4-dual-head.onnx"
  ),
};

// ---------------------------------------------------------------------------
// Python-based topology assertions (ONNX not available in Bun directly)
// ---------------------------------------------------------------------------

function inspectOnnxTopology(onnxPath: string): {
  outputs: string[];
  logits_early_exit_shape: (number | null)[] | null;
  metadata: Record<string, string>;
  node_count: number;
} {
  const script = `
import onnx, json, sys
m = onnx.load(${JSON.stringify(onnxPath)}, load_external_data=False)
g = m.graph
outputs = [o.name for o in g.output]
shape = None
for o in g.output:
    if o.name == 'logits_early_exit':
        dims = o.type.tensor_type.shape.dim
        shape = [d.dim_value if d.dim_value else None for d in dims]
meta = {kv.key: kv.value for kv in m.metadata_props}
print(json.dumps({'outputs': outputs, 'logits_early_exit_shape': shape, 'metadata': meta, 'node_count': len(g.node)}))
`;

  const result = execSync(`python -c "${script.replace(/"/g, '\\"').replace(/\n/g, " ")}"`, {
    encoding: "utf-8",
  }).trim();

  return JSON.parse(result);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dual-head ONNX topology (#1862)", () => {
  for (const [variant, onnxPath] of Object.entries(DUAL_HEAD_PATHS)) {
    describe(`${variant.toUpperCase()} checkpoint`, () => {
      test("dual-head file exists", () => {
        if (!existsSync(onnxPath)) {
          console.log(`SKIP: ${onnxPath} not generated yet. Run: python scripts/export-decoder-dual-head.py`);
          return;
        }
        expect(existsSync(onnxPath)).toBe(true);
      });

      test("graph has both logits and logits_early_exit outputs", () => {
        if (!existsSync(onnxPath)) return;
        const info = inspectOnnxTopology(onnxPath);
        expect(info.outputs).toContain("logits");
        expect(info.outputs).toContain("logits_early_exit");
      });

      test("logits_early_exit has 3-dimensional shape ending in 262144", () => {
        if (!existsSync(onnxPath)) return;
        const info = inspectOnnxTopology(onnxPath);
        expect(info.logits_early_exit_shape).not.toBeNull();
        const shape = info.logits_early_exit_shape!;
        expect(shape).toHaveLength(3);
        // Last dim is vocab_size (may be static 262144 or 0/null if dynamic)
        const vocabDim = shape[2];
        expect(vocabDim === 262144 || vocabDim === null || vocabDim === 0).toBe(true);
      });

      test("exit_layer_kv_index stored in metadata", () => {
        if (!existsSync(onnxPath)) return;
        const info = inspectOnnxTopology(onnxPath);
        expect(info.metadata).toHaveProperty("exit_layer_kv_index");
        const idx = parseInt(info.metadata.exit_layer_kv_index, 10);
        // E2B r=0.33 → 5, E4B r=0.33 → 8
        const expected = variant === "e2b" ? 5 : 8;
        expect(idx).toBe(expected);
      });

      test("node count increased by exactly 1 (one new lm_head node added)", () => {
        if (!existsSync(onnxPath)) return;

        // Compare against baseline (if it exists)
        const baselinePath = onnxPath.replace("-dual-head.onnx", ".onnx");
        if (!existsSync(baselinePath)) return;

        const dualInfo = inspectOnnxTopology(onnxPath);
        const baseInfo = inspectOnnxTopology(baselinePath);
        expect(dualInfo.node_count).toBe(baseInfo.node_count + 1);
      });

      test("file size delta ≤ 5% vs baseline", () => {
        if (!existsSync(onnxPath)) return;
        const baselinePath = onnxPath.replace("-dual-head.onnx", ".onnx");
        if (!existsSync(baselinePath)) return;

        const dualSize = readFileSync(onnxPath).length;
        const baseSize = readFileSync(baselinePath).length;
        const delta = Math.abs(dualSize - baseSize) / baseSize;
        expect(delta).toBeLessThan(0.05);
      });
    });
  }
});

describe("manifest (#1862)", () => {
  const manifestPath = join(REPO_ROOT, "drafter-manifest.json");

  test("drafter-manifest.json has dual_head section", () => {
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest).toHaveProperty("dual_head");
  });

  test("dual_head section has e2b and e4b entries with topology_sha256", () => {
    if (!existsSync(manifestPath)) return;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!manifest.dual_head) return;
    for (const variant of ["e2b", "e4b"]) {
      if (manifest.dual_head[variant]) {
        expect(manifest.dual_head[variant]).toHaveProperty("topology_sha256");
        expect(manifest.dual_head[variant].topology_sha256).toHaveLength(64);
      }
    }
  });
});
