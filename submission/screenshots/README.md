# Screenshot grid for the Kaggle post

Captured 2026-05-04 from the live deployed page
(https://wordingone.github.io/gemma-architect/) via Playwright at
1920×1080. The shots cover the demo-script.md narrative arc — wall
demo + Schultz Residence hero + chrome surfaces (EXPORT drawer,
Cmd-K palette, PARAMETERS tab).

## Files captured

| File | Commit | What it shows |
|------|--------|--------------|
| `01-prompt-wall.png`        | 9c7c0be | PROMPT tab — wall chip loaded, demo sentence filled, GENERATE ready |
| `02-wall-rendered.png`      | 9c7c0be | Wall (12 tri) rendered solid — title block + SCENE panel visible |
| `03-console-cache.png`      | 9c7c0be | CONSOLE tab — init sequence + DSL ready prompt |
| `04-schultz-solid.png`      | 725b56a | Schultz Residence (14-element multi-fuse) — south 3/4 angle, doorway cut visible, solid shading |
| `05-schultz-drafting.png`   | 725b56a | Same angle, `D`-key toggled — flat-white drafting render with edge lines, doorway cut prominent |
| `06-export-drawer.png`      | 9c7c0be | EXPORT drawer open — 12 tiles in 3 sections: BIM·ARCHITECTURAL (IFC/STEP/DWG) · 3D·MESH (OBJ/STL/GLB/glTF/USDZ/FBX) · 2D·DRAWING (SVG/DXF/PDF) |
| `07-cmdk-palette.png`       | 9c7c0be | ⌘K palette open — full command list (GENERATE / MODEL / VIEW groups, kbd shortcuts) |
| `08-cmdk-schultz.png`       | 9c7c0be | ⌘K with "Schultz" typed — filtered to single "Schultz Residence (14 elements)" entry |
| `09-parameters-sliders.png` | 9c7c0be | PARAMETERS tab — wall sliders (5.5 / 0.2 / 2.8m values visible) |

`live-demo-2026-05-04.png` is a wider initial capture kept for reference;
the 9 numbered shots are the canonical embed set.

ai-cache.json verified live at 60 rows as of `a59a8a3` (the
`column-square-3m` corpus row that demo-script.md cut 2 depends on
for an exact F1=1.000 cache hit is restored).

## Pending re-capture after R1-R4 bundle fix

The 9 web screenshots above were captured from
https://wordingone.github.io/gemma-architect/ on 2026-05-04 at the
bundle commits cited in the table. That live deploy contained 4 UI
regressions Jun flagged the same day in the playwright window
(silly-baking-yeti.md T1/T2/T3/T4/T7 — see commit 81e5046's
audit-dispatch-routing.ts firing 11 violations):

- **R1** — ribbon shows TEXT labels (Select/Move/Rotate/Scale) not
  the small SVG icons exported by `web/src/icons.ts`. Every one of
  the 9 shots includes the ribbon strip — every shot needs re-capture.
- **R2** — BLUEPRINT/VELLUM toggle in cropped statusbar instead of
  menubar-right pill. At 1920×1080 the statusbar is uncropped so the
  toggle is visible in current shots, but post-fix the visual moves;
  shots showing the menubar (01/03/06/07/09 especially) need re-capture.
- **R3a/b/c** — palette inert + no Raycaster + no TransformControls.
  None of the current 9 shots directly demonstrate selection /
  transform; no re-capture needed for the existing set, but the
  pending column-3m + grid composition could pick up an R3-fixed shot.
- **R4** — UI cropped at viewport heights below 700px. 1920×1080 is
  unaffected; no re-capture needed for this rule alone.

Re-capture trigger: after Eli's R1-R4 PR merges to master AND deploys
to GH Pages (verify bundle hash in `dist/` differs from current
deploy), re-run `bun web/test/capture-screenshots.ts` (or whatever
the existing capture path is — Eli's lane per Playwright offload
rule). Update the `Commit` column in the table above with the new
post-fix bundle commit. Bundle deploy can lag the merge by a few
minutes per the gh-actions cycle.

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
