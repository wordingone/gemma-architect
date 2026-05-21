import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// gemma-architect web demo — Vite config.
// - wasm + topLevelAwait: replicad-opencascadejs + web-ifc both ship .wasm
//   and need top-level-await on initialization.
// - Workers default to ESM so import statements work as written.
// - Headers: COOP+COEP enable SharedArrayBuffer, which both wasm libs use
//   for multithreaded paths when available.
// - root pinned to the config file's directory so `vite --config web/vite.config.ts`
//   from the repo root resolves index.html in web/, not the repo root.
// Rollup inlines @huggingface/transformers (ORT-web) into the worker bundle,
// causing ORT's locateFile callback to resolve WASM paths using unhashed filenames
// against the assets/ base. Vite only emits hashed WASM names — the unhashed names
// 404, ORT's JsepInit fails, and wgpu::Instance is invalidated: "A valid external
// Instance reference no longer exists" (#1283).
//
// optimizeDeps.exclude prevents this in dev (browser resolves from node_modules).
// This plugin is the prod equivalent: copies ORT WASM files with their unhashed
// names to dist/assets/ so both hashed (import.meta.url path) and unhashed
// (locateFile path) references resolve correctly.
const copyOrtWasmUnhashed = {
  name: "copy-ort-wasm-unhashed",
  apply: "build" as const,
  closeBundle() {
    // ORT package may be hoisted or nested — try both.
    const candidates = [
      resolve(here, "../node_modules/onnxruntime-web/dist"),
      resolve(
        here,
        "../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist"
      ),
    ];
    const ortDist = candidates.find(existsSync);
    if (!ortDist) {
      console.warn("[copy-ort-wasm] onnxruntime-web/dist not found — skipping");
      return;
    }
    const dest = resolve(here, "dist/assets");
    mkdirSync(dest, { recursive: true });
    // These are the unhashed WASM + threading helper files ORT's locateFile requests.
    const files = [
      "ort-wasm-simd-threaded.asyncify.wasm",
      "ort-wasm-simd-threaded.asyncify.mjs",
      "ort-wasm-simd-threaded.jsep.wasm",
      "ort-wasm-simd-threaded.jsep.mjs",
      "ort-wasm-simd-threaded.wasm",
      "ort-wasm-simd-threaded.mjs",
    ];
    for (const f of files) {
      const src = resolve(ortDist, f);
      if (existsSync(src)) {
        copyFileSync(src, resolve(dest, f));
        console.log(`[copy-ort-wasm] copied ${f}`);
      }
    }
  },
};

export default defineConfig({
  root: here,
  base: "./",
  plugins: [wasm(), topLevelAwait(), copyOrtWasmUnhashed],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait()],
  },
  server: {
    port: 5847,
    strictPort: true,
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    fs: {
      // Allow reading sibling outputs/ for canned demo prompts in dev.
      allow: [".."],
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: {
    // replicad + web-ifc ship .wasm and must not be pre-bundled.
    // @huggingface/transformers uses internal workers with dynamic imports
    // that Vite's pre-bundler breaks if it tries to inline them.
    exclude: ["replicad-opencascadejs", "web-ifc", "@huggingface/transformers"],
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
  },
});
