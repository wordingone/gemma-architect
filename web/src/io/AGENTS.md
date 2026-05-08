# io/

Owns import/export, file loading, and worker bridge boundaries.

Expected contents:
- format detection and loaders
- exporter pipelines
- IFC/STEP/mesh import-export integration
- worker message contracts

Constraints:
- Keep parsing/loading concerns isolated from UI.
- Keep worker message schemas explicit and versionable.

