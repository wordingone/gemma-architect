# Capability Prompt Schema

Each file at `web/test/capability/prompts/<id>.json` encodes one architect-grade benchmark prompt.

## Fields

```jsonc
{
  "id": "kebab-case identifier matching filename",
  "category": "residential | commercial | civic | hospitality | mixed",
  "prompt": "Full natural-language prompt sent to the Gemma·Architect chat agent",
  "min_pass_threshold": 0.0–1.0,   // fraction of checks that must pass
  "expected_checks": [
    {
      "id": "snake_case check identifier",
      "description": "Human-readable what is being checked",
      "type": "count | dimension | area | z_extent | presence | door_width",
      "target": "IfcWall | IfcSlab | IfcSpace | IfcDoor | IfcRoof | ...",
      // type-specific fields:
      "min"?: number,
      "max"?: number,
      "exact"?: number,
      "tag_contains"?: string    // checks IfcSpace.Name or tag attribute
    }
  ]
}
```

## Check types

| type | description | required extra fields |
|---|---|---|
| `count` | count of IFC entities matching `target` (optionally filtered by `tag_contains`) | `min` and/or `max` |
| `dimension` | bounding-box span in one axis (X=width, Y=depth, Z=height) | `axis: "X"\|"Y"\|"Z"`, `min`, `max` |
| `area` | total floor area (sum of IfcSpace.GrossFloorArea or bounding box product) | `min`, `max` |
| `z_extent` | building Z height (max Z of any entity) | `min`, `max` |
| `presence` | at least one entity of `target` exists | — |
| `door_width` | all IfcDoor widths ≥ threshold (ADA = 0.91m) | `min_width` |

## Notes

- Checks are intentionally coarse — ±10–15% tolerance where noted — to account for inference variability.
- `min_pass_threshold` of 0.7 means 70% of checks must pass for the prompt to score a K (pass).
- The harness (`web/scripts/capability-bench.ts`) reads these files and scores the IFC exported from the agent's response.
- Prompts deliberately exclude trivial commands ("draw a wall", "draw a box") per project directive 2026-05-08.
