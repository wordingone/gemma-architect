# Third-party notices

This repo's own code is under CC BY 4.0 (`LICENSE`). It depends on and bundles the components below, which keep their own licenses. Versions are those resolved in `bun.lock`; licenses are the `license` field of each package's npm registry entry (read 2026-11-04). This list is not legal advice; read each project's own license text before redistributing.

## npm runtime dependencies (`package.json` `dependencies`)

| Package | Version (bun.lock) | License | URL |
| :-- | :-- | :-- | :-- |
| @huggingface/transformers | 4.2.0 | Apache-2.0 | https://github.com/huggingface/transformers.js |
| @sentry/browser | 10.53.1 | MIT | https://github.com/getsentry/sentry-javascript |
| jspdf | 4.2.1 | MIT | https://github.com/parallax/jsPDF |
| replicad | 0.20.5 | MIT | https://replicad.xyz |
| replicad-opencascadejs | 0.20.2 | MIT | https://github.com/sgenoud/replicad (OpenCascade WASM build; OpenCascade itself is LGPL-2.1 with exception, UNVERIFIED here, check upstream) |
| rhino3dm | 8.17.0 | MIT | https://github.com/mcneel/rhino3dm |
| three | 0.162.0 | MIT | https://threejs.org/ |
| three-bvh-csg | 0.0.18 | MIT | https://github.com/gkjohnson/three-bvh-csg |
| verb-nurbs | 3.0.3 | MIT | https://github.com/pboyer/verb |
| web-ifc | 0.0.77 | MPL-2.0 | https://github.com/ThatOpen/engine_web-ifc |

Note: `@sentry/browser` is an error-reporting client; check `web/src` for where it is initialised before treating the app as telemetry-free.

## Files bundled in `web/public/`

| File | What | License / provenance |
| :-- | :-- | :-- |
| `coi-serviceworker.js` | coi-serviceworker v0.1.7, Guido Zuidhof and contributors (header of the file) | MIT |
| `wasm-llama.js`, `wasm-llama.wasm` (2.6 MB) | Emscripten build of a llama.cpp-based runtime with "turbo" and "mtp" tensors (symbols visible in the binary; loaded by `web/src/agent/wasm-backend.ts:148,157`) | UNKNOWN: upstream repository, commit and build command are not recorded anywhere in this repo (`git grep -i wasm-llama` finds only the loader). llama.cpp is MIT, but whether this build is stock or a fork is not established. The owner should record the source and build steps here. |
| `samples/*.ifc` | Sample IFC files | Per-file licenses are in `submission/SAMPLES.md` (includes a CC BY-ND 4.0 file, bundled unmodified). |

## Model weights (fetched at runtime, not in this repo)

The app loads stock Gemma 4 E4B-it ONNX weights (`onnx-community/gemma-4-E4B-it-ONNX`, see `submission/README.md`). Use is subject to the Gemma terms of use published by Google; not reproduced here.
