# web/src Architecture Notes

This directory is being reorganized into focused subdomains.  
Do not perform large cross-domain refactors in one commit.

Current target domains:
- `agent/`
- `commands/`
- `tools/`
- `viewer/`
- `state/`
- `ui/`
- `io/`

Migration rules:
1. Move files in small batches.
2. Keep imports compiling at each step.
3. Avoid behavior changes while relocating code.
4. Land tests with each move where possible.

