# tools/

Owns interactive drawing/tool workflows (left palette/create mode).

Expected contents:
- tool click-to-place flows
- tool-specific geometry builders
- create-mode session behavior

Constraints:
- Tool output should match command/console semantics.
- Keep object metadata (`userData.kind`, `creator`, control points) consistent.

