# Screenshot grid for the Kaggle post

Captured 2026-05-05 from localhost:5173 (HEAD build) via Playwright at
1920×1080. The shots cover the demo-script.md narrative arc — wall
demo + Schultz Residence hero + chrome surfaces (EXPORT drawer,
Cmd-K palette, PARAMETERS tab).

## Files captured

| File | Commit | What it shows |
|------|--------|--------------|
| `01-prompt-wall.png`        | c162847 | PROMPT tab — wall chip loaded, demo sentence filled, GENERATE ready |
| `02-wall-rendered.png`      | c162847 | Wall (12 tri) rendered solid — title block + SCENE panel visible |
| `03-console-cache.png`      | 3b2da67 | CREATE tab — ChatPanel conversation UI with starter prompts; CONSOLE dock tab is a stub (empty body) post-#34 |
| `04-schultz-solid.png`      | c162847 | Schultz Residence IFC (847 meshes, 270k tri) — south 3/4 angle, doorway cut visible, solid shading |
| `05-schultz-drafting.png`   | c162847 | Schultz Residence IFC — DRAFT ribbon mode, flat shading, IFC layer tree in SCENE panel |
| `06-export-drawer.png`      | c162847 | EXPORT drawer open — 12 tiles in 3 sections: BIM·ARCHITECTURAL (IFC/STEP/DWG) · 3D·MESH (OBJ/STL/GLB/glTF/USDZ/FBX) · 2D·DRAWING (SVG/DXF/PDF) |
| `07-cmdk-palette.png`       | 3b2da67 | ⌘K palette open — GENERATE / MODEL / VIEW groups; mode-switch entries not yet wired post-#34 |
| `08-cmdk-schultz.png`       | c162847 | ⌘K with "Schultz" typed — filtered to single "Schultz Residence (14 elements)" entry |
| `09-parameters-sliders.png` | c162847 | PARAMETERS tab — wall sliders (5.5 / 0.2 / 2.8m values visible) |

`live-demo-2026-05-04.png` is a wider initial capture kept for reference;
the 9 numbered shots are the canonical embed set.

ai-cache.json verified live at 60 rows as of `a59a8a3` (the
`column-square-3m` corpus row that demo-script.md cut 2 depends on
for an exact F1=1.000 cache hit is restored).

Re-captured 2026-05-05 at c162847 — R1 (SVG ribbon icons), R2 (VELLUM pill),
R3 (selection + gizmos), R4 (layout crop) regressions all fixed in this build.
gemma-verify all_passed:true at f531127 (same build).

Re-captured #03 + #07 at 3b2da67 (2026-05-05) — post-#34 PROMPT/CONSOLE merge.
CONSOLE dock tab has no pane body; #03 now shows CREATE tab ChatPanel.
#07 palette is current (no "Show CONSOLE tab" entry visible).

## Pending (manual capture pre-grid-composite)

BlenderBIM column (3 shots) — judges-facing proof that exported IFC4
files load cleanly in a real BIM tool:

- [ ] `wall-bim.png` — `wall.ifc` opened in BlenderBIM, default
      perspective, no extra UI panels.
- [ ] `column-3m-bim.png` — `column.ifc` (typed-from-scratch column
      demo's IFC export) in BlenderBIM, oblique view.
- [ ] `schultz-bim.png` — `schultz.ifc` in BlenderBIM. Floor slab,
      four walls (with doorway + window cuts), interior partition,
      two corner columns, roof slab — all visible as IFC entities.

Capture procedure: install BlenderBIM
(https://blenderbim.org/, free), File → Open IFC Project, select
the IFC the EXPORT drawer wrote, frame oblique, screenshot at
1920×1080.

## Composition for the Kaggle post

Once all 12 shots are ready (9 web + 3 BIM), compose a 3×4 grid
(3 demos × 4 stages: prompt + web-render + drafting + BIM):

```bash
magick montage \
  01-prompt-wall.png 02-wall-rendered.png ANY-DRAFTING-WALL wall-bim.png \
  PROMPT-COLUMN RENDER-COLUMN DRAFT-COLUMN column-3m-bim.png \
  04-schultz-solid.png 05-schultz-drafting.png 08-cmdk-schultz.png schultz-bim.png \
  -tile 4x3 -geometry 1920x1080+8+8 grid.png
```

Then `pngquant grid.png --quality=70-85` to fit Kaggle's upload size.

The cut-2 (typed-from-scratch column) prompt+render shots are NOT in
the current 9-set — they were skipped in the first capture pass per
the demo-script narrative arc choice. Capture them alongside the
BlenderBIM column or simplify the grid to a 3×3 wall+Schultz+chrome
layout.
