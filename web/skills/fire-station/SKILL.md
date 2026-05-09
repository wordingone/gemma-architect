---
name: fire-station
version: 0.1.0
description: Single-storey fire station with 3 apparatus bays, dormitory, day room, kitchen, and bathrooms on a 24×25m footprint.
keywords: [fire station, apparatus bay, emergency services, dormitory, garage bay, fire house]
examples:
  - "design a fire station with 3 truck bays"
  - "create a fire house: 3 apparatus bays, dormitory, kitchen, day room"
eval_id: skill-fire-station-v01
---

## When to use

Prompt asks for a fire station, fire house, or emergency services building with apparatus/truck bays. Typical phrases: "design a fire station", "create a firehouse with 3 bays", "emergency services building".

Do NOT use for:
- Multi-storey fire stations (this skill produces a single ground floor)
- Generic garage or warehouse buildings

## How it works

Emits one IfcLevel at elevation 0, a 24×25m slab, four perimeter walls (height 4.5m to accommodate tall apparatus bays), then IfcSpace entities for all functional zones. Three apparatus bays (8×9m each) run across the front, with offices and service rooms behind.

Reference footprint: 24m wide × 25m deep

Space layout:
```
 0  ←8→  ←8→  ←8→  24
 ┌────────┬────────┬────────┐  y=0
 │ bay 1  │ bay 2  │ bay 3  │
 │ 8×9    │ 8×9    │ 8×9    │  y=9
 ├────┬───┴──┬─────┴────────┤
 │ b1 │  b2  │  kitchen     │
 │4×4 │ 4×4  │  5×5         │  y=13–14
 ├────┴──────┼──────────────┤
 │  day room │  dormitory   │
 │  8×12     │  11×16       │  y=25
 └───────────┴──────────────┘
```

## Examples

Prompt: "design a fire station with 3 apparatus bays, dormitory, and day room"

```
IfcLevel  elevation=0, extent=24, name="Ground Floor"
IfcSlab   profile=[[0,0],[24,0],[24,25],[0,25]], thickness=0.2
IfcWall   length=24, thickness=0.3, height=4.5  (×4 perimeter)
IfcSpace  footprint=[[0,0],[8,0],[8,9],[0,9]],    name="apparatus bay 1"
IfcSpace  footprint=[[8,0],[16,0],[16,9],[8,9]],  name="apparatus bay 2"
IfcSpace  footprint=[[16,0],[24,0],[24,9],[16,9]],name="apparatus bay 3"
IfcSpace  footprint=[[0,9],[4,9],[4,13],[0,13]],  name="bathroom 1"
IfcSpace  footprint=[[4,9],[8,9],[8,13],[4,13]],  name="bathroom 2"
IfcSpace  footprint=[[8,9],[13,9],[13,14],[8,14]],name="kitchen"
IfcSpace  footprint=[[13,9],[24,9],[24,25],[13,25]],name="dormitory"
IfcSpace  footprint=[[0,13],[8,13],[8,25],[0,25]],name="day room"
IfcDoor   width=4.0, height=4.2  (×3 apparatus bay doors)
IfcDoor   width=0.9, height=2.1  (personnel door)
```

Prompt: "fire station, 3 bays, bunkroom, kitchen"

```
IfcLevel  elevation=0, extent=24, name="Ground Floor"
IfcSlab   profile=[[0,0],[24,0],[24,25],[0,25]], thickness=0.2
IfcWall   length=24, thickness=0.3, height=4.5  (×4 perimeter)
IfcSpace  footprint=[[0,0],[8,0],[8,9],[0,9]],    name="apparatus bay 1"
IfcSpace  footprint=[[8,0],[16,0],[16,9],[8,9]],  name="apparatus bay 2"
IfcSpace  footprint=[[16,0],[24,0],[24,9],[16,9]],name="apparatus bay 3"
IfcSpace  footprint=[[0,9],[4,9],[4,13],[0,13]],  name="bathroom 1"
IfcSpace  footprint=[[4,9],[8,9],[8,13],[4,13]],  name="bathroom 2"
IfcSpace  footprint=[[8,9],[13,9],[13,14],[8,14]],name="kitchen"
IfcSpace  footprint=[[13,9],[24,9],[24,25],[13,25]],name="dormitory"
IfcSpace  footprint=[[0,13],[8,13],[8,25],[0,25]],name="day room"
IfcDoor   width=4.0, height=4.2  (×3)
IfcDoor   width=0.9, height=2.1
```

## Checks that must pass

| Check | Requirement |
|---|---|
| `apparatus_bays` | ≥ 3 IfcSpace with "bay" in name |
| `bathroom_count` | ≥ 2 IfcSpace with "bath" in name |
| `bay_door_width` | Apparatus doors ≥ 3.5m wide |

## Failure modes

- Apparatus bay height: bays need 4.2m+ clear height for trucks. Use wall height 4.5m and large door height 4.2m.
- Bay door width: apparatus doors must be ≥3.5m — the eval requires 4.0m.
- Space name casing: judge uses `tag_contains` (substring match). "apparatus bay 1" matches "bay"; "Apparatus Bay" also matches. Use lowercase for consistency.
