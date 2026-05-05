import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// gemma-architect web demo — Vite config.
// - wasm + topLevelAwait: replicad-opencascadejs + web-ifc both ship .wasm
//   and need top-level-await on initialization.
// - Workers default to ESM so import statements work as written.
// - Headers: COOP+COEP enable SharedArrayBuffer, which both wasm libs use
//   for multithreaded paths when available.
// - root pinned to the config file's directory so `vite --config web/vite.config.ts`
//   from the repo root resolves index.html in web/, not the repo root.
export default defineConfig({
  root: here,
  base: "./",
  plugins: [wasm(), topLevelAwait()],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait()],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
    fs: {
      // Allow reading sibling outputs/ for canned demo prompts in dev.
      allow: [".."],
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
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
