// copy-array.ts — #914: side-effect replay for SdCopy / SdArray* clones.
//
// Decision (documented per #914 AC):
//   Hybrid approach: THREE.js clone for geometry (position already correct) +
//   explicit side-effect re-fire per creator type. Re-dispatch was rejected because
//   SdBox/SdSphere/SdPrism have no x/y in dispatchArgs so offset re-dispatch
//   would always place at origin. The hybrid fires from the clone's actual world
//   position, which is already correct after clone.position offset.

import * as THREE from "three";
import { attemptWallCornerJoins } from "../tools/wall-corners";
import { cutRectVoidFromBoxMesh, cutSlabVoidFromBoxMesh } from "../tools/join-groups";

/**
 * After cloning a source mesh and adding it to the scene, call this to replay
 * the source verb's placement side effects on the clone.
 *
 * Handles:
 *  - "wall"     → wall-corner miter joins
 *  - "stair"    → slab-void cut at stairwell footprint above the clone
 *  - "SdDoor"   → rectangular void cut in nearest containing wall
 *  - "SdWindow" → rectangular void cut in nearest containing wall
 */
export function replayCloneSideEffects(
  clone: THREE.Object3D,
  scene: THREE.Scene,
): void {
  const creator = clone.userData?.creator as string | undefined;
  if (!creator) return;

  // ── Wall: re-fire corner joins ────────────────────────────────────────────
  if (creator === "wall" && clone instanceof THREE.Mesh) {
    attemptWallCornerJoins(clone, scene);
    return;
  }

  // ── Stair: cut slab void above clone's footprint ─────────────────────────
  if (creator === "stair") {
    const dispatchArgs = (clone.userData.dispatchArgs ?? {}) as Record<string, unknown>;
    const targetH = (dispatchArgs.rise as number | undefined)
                 ?? (dispatchArgs.targetHeight as number | undefined) ?? 3.0;
    const voidElev = clone.position.z + targetH;
    const clearance = 0.1;
    clone.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(clone);
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData?.creator !== "slab") return;
      if (Math.abs(child.position.z - voidElev) > 0.5) return;
      cutSlabVoidFromBoxMesh(
        child,
        box.min.x - clearance, box.min.y - clearance,
        box.max.x + clearance, box.max.y + clearance,
      );
    });
    return;
  }

  // ── Door / Window: cut void in nearest containing wall ───────────────────
  if (creator === "SdDoor" || creator === "SdWindow") {
    const voidW = clone.userData.voidW as number | undefined;
    const voidH = clone.userData.voidH as number | undefined;
    if (!voidW || !voidH) return;

    const clonePos = new THREE.Vector3();
    clone.getWorldPosition(clonePos);
    const voidCenter = clonePos.clone();
    voidCenter.z = clonePos.z + voidH / 2;

    // Find the closest wall mesh whose bounding box contains the clone's XY.
    let bestHost: THREE.Mesh | null = null;
    let bestDist = Infinity;
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.userData?.creator !== "wall") return;
      child.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(child);
      // Expand slightly on Z to be tolerant of level offsets.
      const expanded = box.clone().expandByScalar(0.3);
      if (!expanded.containsPoint(clonePos)) return;
      const center = new THREE.Vector3();
      box.getCenter(center);
      const d = center.distanceTo(clonePos);
      if (d < bestDist) { bestDist = d; bestHost = child; }
    });

    if (bestHost) {
      cutRectVoidFromBoxMesh(bestHost, voidCenter, voidW, voidH);
    }
    return;
  }
}
