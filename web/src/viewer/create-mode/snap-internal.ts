// snap-internal.ts — mutable snap state shared between snap.ts, projection.ts, and precision-transform.ts.
// Kept separate to avoid circular imports.

import * as THREE from "three";

let _lastSurfaceHitInternal: THREE.Vector3 | null = null;
let _lastSnapEdgeDirInternal: THREE.Vector3 | null = null;

export function setLastSurfaceHit(v: THREE.Vector3 | null): void { _lastSurfaceHitInternal = v; }
export function setLastSnapEdgeDir(v: THREE.Vector3 | null): void { _lastSnapEdgeDirInternal = v; }

export { _lastSurfaceHitInternal as _lastSurfaceHit, _lastSnapEdgeDirInternal as _lastSnapEdgeDir };
