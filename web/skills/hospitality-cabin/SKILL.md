---
name: hospitality-cabin
version: 0.1.0
description: 6m × 8m single-storey cabin with bedroom, ensuite, living area, wraparound deck, and pitched roof.
keywords: [cabin, hospitality, bedroom, ensuite, deck, pitched roof, single story, 6x8]
examples:
  - "design a 6x8m cabin with bedroom, ensuite, and wraparound deck"
  - "small hospitality cabin, pitched roof, bedroom + living, deck terrace"
eval_id: skill-hospitality-cabin-v01
---

## When to use

Prompt asks for a small single-storey cabin, lodge, or hospitality unit with a bedroom, living area, and outdoor deck/terrace. Typical phrases: "6m×8m cabin", "hospitality cabin with deck", "small lodge with bedroom and terrace".

Do NOT use for:
- Multi-bedroom lodges (run bedroom space per unit)
- Two-storey chalets
- Urban residential buildings

## How it works

Emits one IfcLevel at elevation 0, a 6×8m slab, four perimeter walls (2.7m height), then IfcSpace entities for bedroom, ensuite, living, and a south-facing deck slab (0.3m height). Pitched roof at 30° covers the core footprint.

Reference footprint: 6m wide × 8m deep (core), deck extends 1.5m south.

Space layout:
```
 0       3       6
 ┌───────┬───────┐  y=8
 │ensuite│bedroom│
 │ 3×4   │  3×4  │  y=4
 ├───────┴───────┤
 │    living     │
 │     6×4       │  y=0
 └───────────────┘
 ┌───────────────┐  y=0
 │  deck 6×1.5   │
 └───────────────┘  y=-1.5
```

Roof covers core only: [[0,0],[6,0],[6,8],[0,8]]

## Examples

Prompt: "6m × 8m single-story cabin: bedroom + ensuite, kitchenette/living open plan, wraparound deck (1.5m wide), pitched roof"

```
IfcLevel  elevation=0, extent=8, name="Ground Floor"
IfcSlab   profile=[[0,0],[6,0],[6,8],[0,8]], thickness=0.2
IfcWall   length=6, thickness=0.2, height=2.7  (×2 north/south)
IfcWall   length=8, thickness=0.2, height=2.7  (×2 east/west)
IfcSpace  footprint=[[3,4],[6,4],[6,8],[3,8]], height=2.7, name="bedroom"
IfcSpace  footprint=[[0,4],[3,4],[3,8],[0,8]], height=2.7, name="ensuite"
IfcSpace  footprint=[[0,0],[6,0],[6,4],[0,4]], height=2.7, name="living"
IfcSpace  footprint=[[0,-1.5],[6,-1.5],[6,0],[0,0]], height=0.3, name="deck"
IfcRoof   footprint=[[0,0],[6,0],[6,8],[0,8]], pitchDeg=30
IfcDoor   width=0.9, height=2.1  (bedroom door)
IfcDoor   width=0.9, height=2.1  (entry/living door)
```

Prompt: "cabin retreat, bedroom + ensuite, open living/kitchen, deck terrace"

```
[Same sequence as above]
```

## Checks that must pass

| Check | Requirement |
|---|---|
| `roof_present` | IfcRoof present |
| `bedroom_present` | ≥ 1 IfcSpace with "bed" in name |
| `deck_present` | ≥ 1 IfcSpace with "deck" in name |

## Failure modes

- Space name "terrace" does NOT contain "deck" ✗ — use "deck" or "deck terrace".
- Deck as a slab-only element (no IfcSpace) won't satisfy the `count` check — the deck must be an IfcSpace with "deck" in its name.
- Roof footprint: must be the core cabin footprint, not extended over the deck.
