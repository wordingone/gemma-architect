---
name: office-25desk
version: 0.1.0
description: 200m² open-plan office with 2 conference rooms, ADA restrooms, reception, and kitchenette on a 20×10m footprint.
keywords: [office, 25 desk, open plan, conference room, restroom, reception, kitchenette, commercial]
examples:
  - "design a 25-desk office with 2 conference rooms and ADA restrooms"
  - "commercial office space, 200 sqm, open floor plan, reception, 2 meeting rooms, kitchenette, 2 bathrooms"
eval_id: skill-office-25desk-v01
---

## When to use

Prompt asks for a medium-sized commercial office with open-plan desking, conference rooms, restrooms, reception, and kitchen/kitchenette. Typical phrases: "25-desk office", "open-plan office with conference rooms", "commercial office 200m²".

Do NOT use for:
- Small single-room offices (use `room-from-prompt`)
- Multi-floor office buildings
- Residential home offices

## How it works

Emits one IfcLevel at elevation 0, a 20×10m slab, four perimeter walls (3m height), then IfcSpace entities covering all required functional zones. The floor divides into two east-west rows.

Reference footprint: 20m wide × 10m deep = 200m² gross

Space layout:
```
 0   4      10    14      20
 ┌───┬──────┬─────┬───────┐  y=0
 │rec│conf1 │rest1│ rest2 │
 │4×4│ 6×4  │ 4×4 │  6×4  │  y=4
 ├───┴──┬───┴──┬──┴───────┤
 │ open │conf2 │kitchenette│
 │office│ 6×6  │   6×6    │  y=10
 └──────┴──────┴──────────┘
```

Spaces:
- `reception` — 4×4m (16m²)
- `conference 1` — 6×4m (24m²) — seats 8
- `restroom 1` — 4×4m (16m²) — ADA
- `restroom 2` — 6×4m (24m²) — ADA
- `open office` — 8×6m (48m²) — 25 desks
- `conference 2` — 6×6m (36m²) — seats 12
- `kitchenette` — 6×6m (36m²)

Total: 200m² gross ✓

All doors ≥0.91m (ADA).

## Examples

Prompt: "Design a 25-desk office: open floor plan, 2 conference rooms, kitchenette, 2 ADA restrooms, reception. 200m² gross."

```
IfcLevel   elevation=0, extent=20, name="Ground Floor"
IfcSlab    profile=[[0,0],[20,0],[20,10],[0,10]], thickness=0.2
IfcWall    length=20, thickness=0.2, height=3.0  (×2 north/south)
IfcWall    length=10, thickness=0.2, height=3.0  (×2 east/west)
IfcSpace   footprint=[[0,0],[4,0],[4,4],[0,4]],    height=3.0, name="reception"
IfcSpace   footprint=[[4,0],[10,0],[10,4],[4,4]],   height=3.0, name="conference 1"
IfcSpace   footprint=[[10,0],[14,0],[14,4],[10,4]], height=3.0, name="restroom 1"
IfcSpace   footprint=[[14,0],[20,0],[20,4],[14,4]], height=3.0, name="restroom 2"
IfcSpace   footprint=[[0,4],[8,4],[8,10],[0,10]],   height=3.0, name="open office"
IfcSpace   footprint=[[8,4],[14,4],[14,10],[8,10]], height=3.0, name="conference 2"
IfcSpace   footprint=[[14,4],[20,4],[20,10],[14,10]],height=3.0, name="kitchenette"
IfcDoor    width=1.0, height=2.1   (main entrance)
IfcDoor    width=0.91, height=2.1  (conference 1)
IfcDoor    width=0.91, height=2.1  (restroom 1)
IfcDoor    width=0.91, height=2.1  (restroom 2)
IfcDoor    width=0.91, height=2.1  (conference 2)
IfcDoor    width=0.91, height=2.1  (kitchenette)
```

Prompt: "open plan commercial office, 200 sqm, 2 meeting rooms, 2 bathrooms, kitchenette, reception desk"

```
[Same sequence as above]
```

## Checks that must pass

| Check | Requirement |
|---|---|
| `conference_rooms` | ≥ 2 IfcSpace with "conf" in name |
| `restroom_count` | ≥ 2 IfcSpace with "rest" in name |
| `reception_present` | ≥ 1 IfcSpace with "recept" in name |
| `kitchenette_present` | ≥ 1 IfcSpace with "kitchen" in name |
| `ada_door_widths` | All IfcDoor width ≥ 0.91m |

## Failure modes

- Space names: "restroom" contains "rest" ✓; "bathroom" does NOT contain "rest" ✗ — use "restroom" not "bathroom".
- "kitchenette" contains "kitchen" ✓; "break room" does NOT ✗ — use "kitchenette" or "kitchen".
- Door width: any door <0.91m fails `ada_door_widths`. The entrance door at 1.0m is fine; all interior doors must be ≥0.91m.
