# commands/

Owns command dispatch and command session runtime.

Expected contents:
- dictionary-backed command resolution
- command/session state machine
- argument coercion and validation adapters

Constraints:
- One canonical execution path for all invocation surfaces.
- Keep validation and coercion deterministic.

