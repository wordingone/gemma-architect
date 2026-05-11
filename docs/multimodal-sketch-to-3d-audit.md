# Multimodal Sketch → 3D Audit (#407)

## Scope

Audit and implement the user-facing image intake pathway in `web/src/chat-panel.ts`. Goal: let users attach a hand-drawn sketch or reference plan to a chat message; the image flows through `runAgentTurn({ userImage })` to the remote/WebGPU model which generates geometry commands in response.

---

## Pre-implementation gap

**Critical gap found in audit (2026-05-10):**

`_send()` in `chat-panel.ts` called `runAgentTurn({ prompt: text })` — no `userImage` field. There was no paste/drop/file-attach path in the compose flow. The `AgentRequest.userImage?: string` field existed in agent-harness.ts, and both the remote path (OpenAI vision `image_url` block) and the WebGPU path (`RawImage.fromURL`) handled it correctly — but the user had no way to populate it from the compose UI.

---

## Changes

### `web/src/chat-panel.ts`

Added three private fields:
- `_pendingImage: string | undefined` — holds the current data-URL before send
- `_previewEl: HTMLElement` — the `.chat-image-preview` bar shown above compose
- `_fileInputEl: HTMLInputElement` — hidden file input triggered by the attach button

Compose HTML updated:
- Added `<button class="chat-attach-btn">⊕</button>` before the textarea
- Added `<div class="chat-image-preview" style="display:none"></div>` above compose row
- Added `<input class="chat-file-input" type="file" accept="image/*" style="display:none" />`

Event wiring added in `_build()`:
- **Attach button** → `click` → `_fileInputEl.click()`
- **File input change** → `_loadImageFile(file)` → `FileReader.readAsDataURL` → `_setPreview(dataUrl)`
- **Paste on textarea** → extracts `image/*` item from `clipboardData.items` → `_loadImageFile`
- **Drag/drop on compose** → `dragover` guards `e.dataTransfer.types.includes("Files")`, `drop` extracts first image file → `_loadImageFile`

`_send()` updated:
- Captures `const userImage = this._pendingImage` and calls `this._clearPreview()` before the first `await`
- Passes `userImage` to `runAgentTurn({ ..., userImage })`

Preview UI:
- `_setPreview(dataUrl)` — renders `<img class="chat-image-thumb">` + "sketch attached" label + "✕ remove" button
- `_clearPreview()` — removes `_pendingImage`, clears preview bar

### CSS

All required styles were already present in `web/src/style.css`:
- `.chat-attach-btn` — icon button before textarea
- `.chat-image-preview` — preview bar container
- `.chat-image-thumb` — 48px tall thumbnail
- `.chat-image-clear` — "✕ remove" button

No CSS changes needed.

### Test fixtures

Three reference SVG sketches in `web/public/test-fixtures/sketches/`:

| File | Geometry | Prompt target |
|---|---|---|
| `sketch-wall-5m.svg` | Single wall, plan view, 5m × 0.2m | "Build a 5m wall" |
| `sketch-room-6x4.svg` | Four-walled room, 6m × 4m, plan view | "Create a rectangular room 6×4m" |
| `sketch-l-walls.svg` | L-shaped walls, 8m + 6m arms, plan view | "Two walls forming an L shape" |

### gemma-verify Surface 53

`scripts/gemma-verify-raw.mjs` — Surface 53 `chat-image-attach`:
- Asserts `.chat-attach-btn` exists in DOM
- Asserts `.chat-image-preview` exists (initially `display:none`)
- Asserts `.chat-file-input` hidden input exists with `accept="image/*"`
- Does NOT exercise model inference (intake wiring only; model call coverage left to manual smoke test)

---

## Sketch → 3D inference path (end-to-end)

```
User pastes/drops/picks sketch
  → _loadImageFile(file)
    → FileReader → data URL
      → _setPreview(dataUrl) [shows thumbnail]

User types "build the room from this sketch" → SEND
  → _send()
    → captures userImage = this._pendingImage
    → clears preview
    → runAgentTurn({ prompt, userImage, ... })
      → [remote path] buildMessages():
          [{ type:"image_url", image_url:{ url:dataUrl } }, { type:"text", text:prompt }]
          → POST /v1/chat/completions (vision-capable endpoint)
      → [WebGPU path] RawImage.fromURL(dataUrl)
          → processor({ images:[rawImage], text:prompt })
          → model.generate()
      → model emits tool_call envelope with geometry verbs
        → dispatch → scene
```

---

## Score table: sketch → IFC element count

Manual smoke test (remote path, Gemma 4 E2B-it via avir-cli):

| Sketch | Expected elements | Produced elements | Verb match | Notes |
|---|---|---|---|---|
| `sketch-wall-5m.svg` | 1 (IfcWall / SdWall) | — | — | pending model run |
| `sketch-room-6x4.svg` | 4 (IfcWall ×4) | — | — | pending model run |
| `sketch-l-walls.svg` | 2 (IfcWall ×2, fuse) | — | — | pending model run |

Score table to be populated after end-to-end smoke test with shared browser. Hausdorff distance metric requires reference mesh from the canonical demo prompts — deferred to #407 follow-on.

---

## Limitations

- **K=0 (no context):** Model has no prior conversation; sketch interpretation depends entirely on the visual content and the user's text prompt. Accuracy will vary with prompt specificity.
- **WebGPU path:** `RawImage.fromURL` with a data URL works for PNG/JPEG; SVG requires conversion (not handled — production sketches are expected to be raster images from phone camera or drawing app).
- **No Hausdorff scoring yet:** IFC element count is a proxy metric. Geometric accuracy comparison requires a reference mesh; that's tracked in #407 follow-on issues.
