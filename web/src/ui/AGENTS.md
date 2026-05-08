# ui/

Owns UI surfaces and interaction shells.

Expected contents:
- shell chrome
- chat panel
- command palette / cmdk
- side panels and drawers

Constraints:
- Keep UI components thin; route behavior through domain modules.
- Avoid direct geometry mutations inside UI components.

