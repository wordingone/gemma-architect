# Demo video script — gemma-architect (3:00)

The 3-minute screen-recording for the Kaggle submission. Voice-over
scripted line-by-line, cuts timed against a single take of the production
page (https://wordingone.github.io/gemma-architect/). Shoot at 1920×1080, 30 fps.

This script targets the **current bundle UI** (post-#170 design handoff,
post-#34 PROMPT/CONSOLE merge):
menubar / modebar / ribbon shell, dock tabs (PROMPT / NODES / PARAMETERS
/ HISTORY) — the PROMPT tab toggles between natural-language PROMPT mode
and DSL CONSOLE mode via Shift+Tab. Plus Cmd-K palette, multi-format
EXPORT drawer, drafting-style toggle (`D`), AI prompt → geometry pipeline
(#176, cache + live Gemma 4 paths), SKILL NODES library (6 starter skill-graph clusters).

**Demo path order** is chosen to scale narrative scope:
single element → parametric variation → AI typed-from-scratch → skill hero
(multi-room building). Each cut ends on a frame the next cut starts from cleanly.

| Cut | Range | What viewers see |
| :-: | :---- | :--------------- |
| 1 | 0:00–0:20 | hook + static title card |
| 2 | 0:20–1:00 | demo 1 — wall (cached, parametric) |
| 3 | 1:00–1:40 | demo 2 — typed-from-scratch prompt → AI generate (cache match) |
| 4 | 1:40–2:30 | demo 3 — Schultz residence (Cmd-K hero, multi-element) + drafting style |
| 5 | 2:30–3:00 | export IFC + close out (impact line) |

---

## 0:00 — 0:20 — Hook

**Screen:** open in Chrome. Static title card 2s, then the live page —
ribbon visible, PROMPT dock tab open, viewport empty showing the
title-block "GEMMA·ARCHITECT — UNTITLED.001 / SCALE 1:50 · IFC4 · METRIC".

**VO (24 words, ~5.5s/line, 4 lines = 22s — trim live):**

> "Parametric CAD costs three thousand dollars a year. Revit. ArchiCAD.
> AutoCAD. The free tools assume you already know how to model.
> **Gemma-architect runs in a browser tab.** No install. No login. No
> API key. You type a sentence; you get a building."

**Cut beat:** cursor settling on PROMPT tab. Hard cut at 0:20.

---

## 0:20 — 1:00 — Demo 1: Wall (cached + parametric)

**Screen:**
1. PROMPT tab. Demo chip strip shows "Wall · 5.5×0.2×2.8m" first. Click it.
2. Prompt textarea fills with the sentence. JS source mirrors in `#js-source`.
3. Click **GENERATE** (or hit `⌘⏎`). Status flips: `Running…` → `Ready (12 tris, 4.4 KB IFC).` Wall renders. Auto-frame.
4. Drag **length** slider to 8.0m. Geometry rebuilds within ~90ms.
5. Drag **height** slider to 3.5m. Updates again.

**VO (40s budget):**

> "Pick a demo from the prompt panel. Read the sentence the model
> already wrote — _a wall, five and a half meters long, twenty
> centimeters thick, two meters eighty tall_. Click GENERATE. Gemma 4,
> four billion parameters, base model on-device, emits replicad source.
> A worker executes it. OpenCascade meshes it. three.js renders. **No server.** All in this tab."

> "Drag the length slider. Geometry rebuilds without re-running the
> model — the parameters are exposed automatically. Drag height. **The
> sliders are the parametric layer. The model is just the entry point.**"

**Cut beat:** cursor in textarea, demo prompt clearly visible. Hard cut at 1:00.

---

## 1:00 — 1:40 — Demo 2: Typed-from-scratch prompt → AI generate

**Screen:**
1. Click in the PROMPT textarea. **Select-all and delete** the existing demo prompt.
2. Type live: `Build a square column 0.3m by 0.3m, 3m tall.`
3. Hit `⌘⏎`. The GENERATE button shows `GENERATING…` for ~80ms.
4. JS source updates to a fresh column construction. Viewer shows a 3m square column.
5. Status reads `[ai-generate] cache · 0.71 match · 47ms` (in the PROMPT tab's inline console history; Shift+Tab to bring CONSOLE mode into focus if needed).

**VO (40s budget):**

> "Now type your own prompt. _Build a square column, thirty centimeters
> by thirty centimeters, three meters tall._ Cmd-Enter. The page hits
> the inference cache — sixty round-trip-verified prompt-to-JS pairs
> from the bundled gold corpus. Forty milliseconds.
> No GPU spun up, no network call, no waiting. **The cache is the
> default; live inference is one toggle away** for users who want the
> real model in the loop."

**Cut beat:** column rendered, viewer auto-framed. Hard cut at 1:40.

---

## 1:40 — 2:30 — Demo 3: Schultz Residence (Cmd-K, multi-element)

**Screen:**
1. Press `Cmd-K` (or `Ctrl-K`). The Cmd-K palette opens. Type `schultz`. Press Enter.
2. The 14-element Schultz Residence dispatches: walls, slabs, columns, stairs.
   Viewer auto-frames. Visible: a complete multi-room residence.
3. Press `D` (drafting style toggle). Viewer flips from solid shading to
   ink-wobble drafting render.

**VO (50s budget):**

> "Press Cmd-K. Type schultz. Enter. Fourteen elements dispatch in sequence:
> walls, slabs, columns, stairs — a complete residence in under five seconds.
> This is the full Gemma 4 inference path: the model emits verified replicad
> source, the worker executes it, OpenCascade meshes it."

> "Press D — same building, architect's view. **Same IFC.
> Different render.** The geometry is BIM-compliant the moment it renders."

**Cut beat:** drafting-style render fully painted. Hard cut at 2:30.

---

## 2:30 — 3:00 — Export IFC + close

**Screen:**
1. Click **EXPORT** in the ribbon (or hit `⌘E`). Drawer slides in from the right.
2. Click the **IFC4** tile. Browser downloads the Schultz Residence IFC file.
3. Optional B-roll: open the file in BlenderBIM. Show the multi-room
   building loaded as IFC4 entities (slabs, walls, spaces) in a
   separate BIM tool.

**VO (28s budget):**

> "Click EXPORT. IFC4. **This is a real building file** — open it in
> Revit, ArchiCAD, BlenderBIM, anything that reads IFC. Not pixels.
> Not a JSON blob. A building."

> "Six starter skill clusters. Deterministic prompt cache for single-element
> prompts. Stock Gemma 4 on-device for everything else. One web page.
> Open-source, CC BY 4.0. Take it, add your own skills. **CAD just stopped
> being a subscription.**"

**Cut beat:** IFC4 tile click → file appears in Downloads. End card 1s.

---

## Production notes

- **Take order:** record cut 1 last (lowest cognitive load), then 2/3/4/5
  in order. Cut 4 (Schultz + drafting) is the visual hero — re-shoot
  until the auto-frame and drafting toggle land cleanly.
- **Voice-over:** record after picture-lock. Time per cut is the budget,
  not the floor. Cut 4 has the most slack — Cuts 1+5 are tight.
- **Hover cursor:** keep the cursor visible at all times. Use a 24px
  highlighter cursor (Chrome built-in is fine; QuickTime Mac highlighter
  for screen-record on macOS).
- **Audio:** -6 dBFS peak voice, -12 dBFS LUFS overall. No music — the
  build/export sounds carry the pacing.

---

## What viewers leave with

In 3 minutes, they should have seen:
- A wall, a column, a 14-element residence — three scope tiers covered.
- Both the **AI cache path** (cached, instant, single-element) and the **Cmd-K Schultz path** (multi-element, full model inference).
- Honest framing: stock Gemma 4 E4B-it on-device, no fine-tune required.
- Drafting-style toggle (architectural aesthetic, not just CAD output).
- IFC4 export to a real BIM-compatible file.
- The narrative beat: **CAD just stopped being a subscription.**

Keep the writeup, the impact statement, and this script aligned. If a
demo path changes after the recording, update the script, not the page.
