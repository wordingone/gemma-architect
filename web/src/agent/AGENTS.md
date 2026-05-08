# agent/

Owns model interaction and function-call extraction.

Expected contents:
- agent harness/runtime integration
- prompt construction
- model response parsing (function-call extraction)

Constraints:
- Keep model-facing contract wording stable and explicit.
- Keep parsing backward-compatible during migrations.

