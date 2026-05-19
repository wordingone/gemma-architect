# Tier 1 conventions

What the 12-op tier1 surface actually does, derived empirically from
`scripts/probe-conventions.ts` against the live replicad+OpenCascade
runtime. The model has to know these to emit geometrically-correct
JavaScript from a natural-language prompt.

> Run the probe yourself: `bun scripts/probe-conventions.ts`.

## The asymmetry that bites

**`makeBox` and `makeCylinder` are CENTERED in X and Y but BASE-AT-ORIGIN
in Z.**

| Primitive | x-range | y-range | z-range |
| --- | --- | --- | --- |
| `makeBox(2, 3, 4)` | `[-1, 1]` | `[-1.5, 1.5]` | `[0, 4]` |
| `makeCylinder(1.5, 6)` | `[-1.5, 1.5]` | `[-1.5, 1.5]` | `[0, 6]` |

This asymmetry is the single most common source of "the geometry runs
fine but the building is in the wrong place" errors. Mental model:
**the floor is z=0, x and y are about the centerline.**

If you assumed both were centered (or both base-at-origin), every
multi-element design that stacks vertically will have the wrong
absolute height — the IFC will validate, the mesh will render, and the
building will sit 0.5m below grade with the slab drifted into the
piers.

## Sketch + extrude

`drawRectangle(w, d).sketchOnPlane("XY").extrude(h)` produces the
SAME geometry as `makeBox(w, d, h)`:
`[-w/2, w/2]` × `[-d/2, d/2]` × `[0, h]`.

`drawCircle(r).sketchOnPlane("XY").extrude(h)` produces the SAME
geometry as `makeCylinder(r, h)`:
`[-r, r]` × `[-r, r]` × `[0, h]`.

So if you can do it with `makeBox` / `makeCylinder`, you should — the
model has fewer ways to go wrong with the dimension form than the
sketch form.

The sketch form is needed for non-rectangular profiles
(`drawPolyline`), non-XY base planes (`sketchOnPlane("XZ"|"YZ")`), and
the `revolve` Tier 2 op.

## Stacking elements

Because Z is base-at-origin, the recipe for "B sits on top of A
where A has height H_A" is:

```js
const a = makeBox(W, D, H_A);              // z = [0, H_A]
const b = makeBox(W, D, H_B).translate([0, 0, H_A]);  // z = [H_A, H_A + H_B]
```

NOT:

```js
const a = makeBox(W, D, H_A).translate([0, 0, H_A / 2]);   // wrong: z = [H_A/2, 3*H_A/2]
const b = makeBox(W, D, H_B).translate([0, 0, H_A + H_B / 2]); // wrong: z = [H_A+H_B/2, H_A+3*H_B/2]
```

The wrong form lifts everything by half a story. The right form keeps
the floor at z=0.

## Walls along Y vs walls along X

Two ways to draw a wall running along the X axis from x=-3 to x=3,
0.2m thick, 3m tall:

```js
// dimension form, easier
const wall = makeBox(6, 0.2, 3);              // x=[-3,3] y=[-0.1,0.1] z=[0,3]

// sketch form, equivalent
const wall = drawRectangle(6, 0.2)
                .sketchOnPlane("XY")
                .extrude(3);
```

For a perpendicular wall meeting the first one in a T-junction at
the midpoint, the second wall's centerline along Y has to start at the
inner face of the first wall (y=0.1, not y=0):

```js
const wallX = makeBox(6, 0.2, 3);                    // y=[-0.1, 0.1]
const wallY = makeBox(0.2, 4, 3)
                 .translate([0, 0.2/2 + 4/2, 0]);   // y=[0.1, 4.1]
const tjunction = wallX.fuse(wallY);
```

The combined Y span is 4.2, not 4.1 — the second wall's far face is
at the outer edge of the first wall plus the second wall's full
length.

## fuse and Compound

`fuse` of two disjoint solids returns a `Compound`, not a `Solid`.
The mesher and IFC builder handle Compound the same as Solid (they
walk the OCC face graph), so this is fine — but if downstream code
checks `result.constructor.name === "Solid"` it'll false-fail on
multi-element scenes.

Repeated fuse keeps producing Compound:

```js
const f1 = a.fuse(b);   // Compound
const f2 = f1.fuse(c);  // Compound
const f3 = f2.fuse(d);  // Compound
```

## cut

`outer.cut(inner)` works on any solid pair, returns a `Solid` (or
Compound for some configurations). Useful for windows, doorways,
hollow boxes:

```js
const wall = makeBox(6, 0.25, 3);
const window = makeBox(1.5, 0.25, 1.2).translate([0, 0, 1]);  // sill 1m up
const wallWithWindow = wall.cut(window);
```

For a hollow box with uniform wall thickness `T`:

```js
const outer = makeBox(OX, OY, OZ);
const inner = makeBox(OX - 2*T, OY - 2*T, OZ - 2*T);  // also base-at-origin
const hollow = outer.cut(inner);
```

Note the `inner` is also base-at-origin — its z=`[0, OZ-2T]`, which
sits inside `outer`'s z=`[0, OZ]` with `2T` of "ceiling" above. If
you want a true 6-sided hollow, translate `inner` up by `T`:

```js
const inner = makeBox(OX - 2*T, OY - 2*T, OZ - 2*T).translate([0, 0, T]);
```

## sketchOnPlane("XZ") and "YZ"

For non-XY profiles (gabled roofs, curved walls in elevation,
revolve profiles), the sketch is drawn in 2D space and mapped onto a
3D plane. Empirical extrude directions (probe-conventions.ts +
probe-xz.ts):

| Plane | Sketch X → | Sketch Y → | extrude(d) goes | Position-rule |
| --- | --- | --- | --- | --- |
| `XY` | world X | world Y | +Z by `d` (z=`[0, d]`) | base-at-origin in Z |
| `XZ` | world X | world Z | **−Y by `d`** (y=`[-d, 0]`) | sketch is centered in X and Z (no Z base-at-origin) |
| `YZ` | world Y | world Z | +X by `d` (x=`[0, d]`) | sketch is centered in Y and Z |

The asymmetry (XY base-at-origin in Z; XZ centered in Z) is because
`sketchOnPlane("XY")` defaults to extruding "up" from the floor — a
reasonable architectural default — while the side planes have no
"floor" reference and just sit at the origin of their host plane.

The extrude direction follows the sketch-plane normal in right-handed
order: `X×Z = −Y` (so XZ extrudes along −Y), `Y×Z = +X` (YZ extrudes
along +X).

For a gabled roof on a `BX × BY × BZ` box centered in X/Y at z=0:

```js
const box = makeBox(BX, BY, BZ);  // x=[-BX/2,BX/2] y=[-BY/2,BY/2] z=[0,BZ]
// Triangle profile: base spans BX at z=BZ, peaks at z=BZ+RIDGE.
// Extrude depth = BY (so the gable runs the full box length in Y).
// XZ extrudes along −Y, so result is y=[-BY, 0]; translate +BY/2 to
// re-center over the box.
const gable = drawPolyline([
  [-BX / 2, BZ],
  [ BX / 2, BZ],
  [0, BZ + RIDGE],
]).sketchOnPlane("XZ").extrude(BY).translate([0, BY / 2, 0]);
const roof = box.fuse(gable);
```

**For revolve:** the Tier 2 `revolve` op spins the sketch around the
sketch plane's vertical axis (sketch Y in XY, world Z in XZ).

```js
// Cylindrical tank: rectangular profile in XZ, revolved around Z.
const profile = drawPolyline([
  [R_INNER,      0],
  [R_INNER + T,  0],
  [R_INNER + T,  H],
  [R_INNER,      H],
]).sketchOnPlane("XZ");   // sketch X = world radius, sketch Y = world Z
const tank = profile.revolve();   // default: revolve around Z
```

## drawPolyline

`drawPolyline(pts)` accepts any number of 2D points and **auto-closes**
the path (per `src/tools/tier1.ts:52`, the wrapper appends `pen.close()`).
So for an N-gon, just provide the N vertices in order — don't repeat the
first point.

```js
const N = 8, R = 0.5;
const pts = Array.from({length: N}, (_, i) => {
  const a = 2 * Math.PI * i / N;
  return [R * Math.cos(a), R * Math.sin(a)];
});
const column = drawPolyline(pts).sketchOnPlane("XY").extrude(4);
```

The polygon is centered at origin. `extrude` direction is base-at-origin
in Z, same as everything else.

## rotate

`Solid.rotate(angle: number, position?: Point, direction?: Point)`.
Angle is **degrees**, default position is `[0, 0, 0]`, default
direction is `[0, 0, 1]` (around Z).

`rotate(90)` rotates 90° around the Z axis through the origin. If the
solid was centered in X/Y, it stays centered (rotation around an axis
through its centroid). If the solid was off-origin (translated first),
rotation moves it.

The interaction with prior translation is the pitfall: if you
translate-then-rotate, you rotate the translated position. Mental
model: think of rotate as a transformation of the world, not of the
object. Or, rotate first and translate after.

## Common shapes from the prompts

| Prompt phrase | tier1 recipe |
| --- | --- |
| "5m × 0.2m × 3m wall" | `makeBox(5, 0.2, 3)` |
| "3m diameter, 6m tall column" | `makeCylinder(1.5, 6)` |
| "5×4×0.2m slab" | `makeBox(5, 4, 0.2)` |
| "rectangular slab with circular hole at center" | `slab.cut(makeCylinder(R, T))` (cylinder is base-at-origin so no Z translate needed if slab is at z=[0,T]) |
| "wall with doorway" | `wall.cut(makeBox(door_w, wall_t, door_h))` (door is at z=[0, door_h] without translate, which is correct — door sill is at floor) |
| "wall with window" | `wall.cut(makeBox(win_w, wall_t, win_h).translate([0, 0, sill_h]))` |
| "L-shape footprint" | `slab1.fuse(slab2)` where slab2 is translated to attach |
| "four-walled room" | four `makeBox` walls each translated to its corner, fused; mind the y-offsets so they meet at corners not midpoints |
| "octagonal column" | `drawPolyline(N=8 vertices).sketchOnPlane("XY").extrude(H)` |
| "cylindrical tank, revolved" | rectangular profile in XZ, `.revolve()` |
| "pitched roof on box" | gable triangle profile in XZ extruded along Y |

## What the model gets wrong

The 4b LoRA trained on 932 augmented rows passes runtime 40/40 (all
emitted JS executes and produces a Solid/Compound), but the
self-harness `four-walled room` demo's bounding box was slightly
wider than the spec called for — that's the model emitting positions
that work geometrically but are off by a wall-thickness's worth in
overall extent.

This kind of placement drift is the dominant remaining failure mode at
the model layer. Tier 2 dataset work + per-row positional eval (was
the prompt's spatial intent honored within tolerance?) is the
post-hackathon roadmap item to close it.

## Probe and harness

- `scripts/probe-conventions.ts` — print empirical bounds for each
  primitive in isolation. Run when in doubt.
- `scripts/dev-as-architect.ts` — 8 hand-written designs exercising
  the tool surface end-to-end (execute → mesh → IFC → validate →
  bounds-check). Useful when sanity-checking a tier1.ts change or a
  fixture change.
- `scripts/web-self-harness.ts` — the 9 canned demos (8 dropdown + Schultz
  hero), end-to-end. The CI hook for the model itself.

The harness suite was exactly how the asymmetric Z convention got
caught — `dev-as-architect.ts` flagged 5 of 8 designs with bounds
drift, the probe pinned the asymmetry, and the fix landed in this
doc + the harness expected bounds.
