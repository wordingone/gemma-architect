---
name: sf-residence-2br
version: 0.1.0
description: Two-storey San Francisco single-family residence: garage ground floor, 2 bedrooms upper floor, 12×10m footprint with pitched roof.
keywords: [residence, house, two bedroom, 2br, two story, garage, san francisco, single family]
examples:
  - "design a 2-bedroom san francisco house with garage"
  - "two-storey residential building, garage on ground floor, 2 bedrooms upstairs"
eval_id: skill-sf-residence-2br-v01
---

## When to use

Prompt asks for a San Francisco-style single-family residence, two-bedroom house with garage, or two-storey residential building where the ground floor is partially a garage. Typical phrases: "SF-style 2br house", "two bedroom house with attached garage", "residential building, 2 bedrooms upstairs".

Do NOT use for:
- Apartment buildings or multi-unit dwellings
- Single-storey homes
- Homes without a garage

## How it works

Emits two IfcLevel entities (ground floor at 0m, upper floor at 3m), two slabs, eight walls (four per floor), then IfcSpace entities for all zones plus a pitched roof.

Reference footprint: 12m wide × 10m deep  
Ground floor: garage (front-left), living room (front-right), kitchen (back-left), bathroom (back-right)  
Upper floor: bedroom 1 (front-left), bedroom 2 (front-right), shared bathroom (full rear)

```
Ground floor (z=0–3m):
 0   6   12
 ┌───┬───┐  y=0
 │ G │ L │
 │   │   │  y=5
 ├───┼───┤
 │ K │ B │
 │   │   │  y=10
 └───┴───┘
 G=garage, L=living room, K=kitchen, B=bathroom ground

Upper floor (z=3–6m):
 0   6   12
 ┌───┬───┐  y=0
 │b1 │b2 │
 │   │   │  y=5
 ├───┴───┤
 │bathroom upper│
 │       │  y=10
 └───────┘
```

## Examples

Prompt: "design a 2-bedroom SF residence with garage, two storeys"

```
IfcLevel  elevation=0, extent=12, name="Ground Floor"
IfcLevel  elevation=3.0, extent=12, name="Upper Floor"
IfcSlab   profile=[[0,0],[12,0],[12,10],[0,10]], thickness=0.2  (×2)
IfcWall   length=12, thickness=0.2, height=3.0  (×2 ground north/south)
IfcWall   length=10, thickness=0.2, height=3.0  (×2 ground east/west)
IfcWall   length=12, thickness=0.2, height=3.0  (×2 upper north/south)
IfcWall   length=10, thickness=0.2, height=3.0  (×2 upper east/west)
IfcSpace  footprint=[[0,0],[6,0],[6,5],[0,5]],   height=3.0, name="garage"
IfcSpace  footprint=[[6,0],[12,0],[12,5],[6,5]],  height=3.0, name="living room"
IfcSpace  footprint=[[0,5],[6,5],[6,10],[0,10]],  height=3.0, name="kitchen"
IfcSpace  footprint=[[6,5],[12,5],[12,10],[6,10]], height=3.0, name="bathroom ground"
IfcSpace  footprint=[[0,0],[6,0],[6,5],[0,5]],    height=3.0, name="bedroom 1"
IfcSpace  footprint=[[6,0],[12,0],[12,5],[6,5]],   height=3.0, name="bedroom 2"
IfcSpace  footprint=[[0,5],[12,5],[12,10],[0,10]], height=3.0, name="bathroom upper"
IfcRoof   footprint=[[0,0],[12,0],[12,10],[0,10]], pitchDeg=20
IfcDoor   width=2.4, height=2.1  (garage door)
IfcDoor   width=0.9, height=2.1  (entry door)
IfcWindow width=1.2, height=1.4  (×2)
```

Prompt: "two-storey house, 2 bedrooms, garage downstairs, 12m by 10m"

```
[Same sequence as above]
```

## Checks that must pass

| Check | Requirement |
|---|---|
| `bedroom_count` | ≥ 2 IfcSpace with "bed" in name |
| `garage_present` | ≥ 1 IfcSpace with "garage" in name |
| `storey_count` | ≥ 2 IfcLevel entities |
| `roof_present` | IfcRoof present |

## Failure modes

- Slab count: two-storey requires two slabs — one per floor. Omitting the upper slab misses the horizontal separation.
- Space level assignment: upper floor spaces must reference the upper IfcLevel. If the harness doesn't auto-assign, pass `elevation=3.0` in a context arg.
- Garage door width: the garage opening is typically 2.4m (single-car) or wider. Don't use the standard 0.9m door width for the garage.
