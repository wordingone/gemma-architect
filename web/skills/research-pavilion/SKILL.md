---
name: research-pavilion
version: 0.1.0
description: 8m × 8m research pavilion with 4m ceiling, full south glazing, and exposed timber roof.
keywords: [pavilion, research, glazing, timber roof, light shelf, civic, 8x8, 4m ceiling]
examples:
  - "design an 8x8m research pavilion with south glazing and timber roof"
  - "research pavilion, 4m ceiling, full south glazing, exposed roof structure"
eval_id: skill-research-pavilion-v01
---

## When to use

Prompt asks for a research pavilion, reading room, or single-volume civic building with large south glazing and an exposed roof structure. Typical phrases: "research pavilion", "8m×8m pavilion with glazing", "civic pavilion, timber roof".

Do NOT use for:
- Multi-room research buildings (use a floor-plan skill)
- Galleries or museums (different program checks)
- Standard office buildings

## How it works

Emits one IfcLevel at elevation 0, an 8×8m slab, four perimeter walls (4m height for the stated ceiling), a single open research space, a low-pitch roof, and two large south-facing windows representing the glazed south wall.

Reference footprint: 8m wide × 8m deep
Ceiling height: 4.0m

```
 0               8
 ┌───────────────┐  y=8 (north — solid wall, light shelf)
 │               │
 │ research space│
 │    8×8 × 4m   │
 │               │
 └───────────────┘  y=0 (south — full glazing)
```

South wall: 2× IfcWindow 6.0m wide × 3.5m tall (covering most of the south elevation)
Roof: IfcRoof, pitchDeg=10 (near-flat exposed timber structure)

## Examples

Prompt: "Research pavilion: 8m × 8m, 4m ceiling, full south glazing, north-facing light shelf, exposed timber roof structure."

```
IfcLevel  elevation=0, extent=8, name="Ground Floor"
IfcSlab   profile=[[0,0],[8,0],[8,8],[0,8]], thickness=0.2
IfcWall   length=8, thickness=0.2, height=4.0  (×4 perimeter)
IfcSpace  footprint=[[0,0],[8,0],[8,8],[0,8]], height=4.0, name="research space"
IfcRoof   footprint=[[0,0],[8,0],[8,8],[0,8]], pitchDeg=10
IfcWindow width=6.0, height=3.5   (south glazing panel 1)
IfcWindow width=6.0, height=3.5   (south glazing panel 2)
IfcDoor   width=0.9, height=2.1
```

Prompt: "8x8 research reading room, 4m high, glass south wall, timber roof"

```
[Same sequence as above]
```

## Checks that must pass

| Check | Requirement |
|---|---|
| `roof_present` | IfcRoof present |
| `wall_count` | ≥ 4 IfcWall entities |

## Failure modes

- Wall count: exactly 4 perimeter walls required — don't omit any. The `wall_count` check requires ≥4 IfcWall.
- Roof pitch: 10° is near-flat (contemporary pavilion aesthetic); don't default to 30° which reads as a steeply-pitched cottage.
- Window size: use large glazing (6.0m × 3.5m) to represent full south elevation, not small punched windows.
