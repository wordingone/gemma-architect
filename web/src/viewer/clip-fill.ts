// Stencil-buffer cut-fill for section box + clipping planes (#836).
// Fills the cross-section of each solid at every active clip plane using
// the Three.js shadow-volume stencil technique.
//
// Per plane:
//   1. Stencil helpers (Back + Front faces of each solid, colorWrite:false)
//      write ±1 to the stencil buffer, leaving stencil=1 where the plane
//      cuts through solid interior.
//   2. A large fill PlaneGeometry reads the stencil (!=0) and paints the
//      fill color. Its onAfterRender clears the stencil so the next plane
//      starts clean.
//
// renderOrder per plane pi: helpers at pi*2+1, fill at pi*2+2.
// This ensures per-plane interleaving without relying on insertion order.

import * as THREE from "three";

const FILL_PLANE_SIZE = 300;

function fillColorHex(mode: string): number {
  if (mode === "technical") return 0x000000;
  if (mode === "wireframe") return 0x444444;
  return 0x888888;
}

export class ClipFillManager {
  private _helperGroups: THREE.Group[] = [];
  private _fillMeshes:   THREE.Mesh[]  = [];
  private _scene:        THREE.Scene | null = null;

  update(planes: THREE.Plane[], scene: THREE.Scene, fillMode: string): void {
    this._cleanup();
    this._scene = scene;
    if (planes.length === 0) return;

    const solids = this._collectSolids(scene);
    if (solids.length === 0) return;

    const fillColor = fillColorHex(fillMode);

    for (let pi = 0; pi < planes.length; pi++) {
      const plane      = planes[pi];
      const helperRO   = pi * 2 + 1;
      const fillRO     = pi * 2 + 2;

      // ── Stencil helpers (one pair per solid) ─────────────────────────────
      const helperGroup = new THREE.Group();
      helperGroup.userData.excludeFromClip = true;
      helperGroup.userData.noSnap          = true;
      helperGroup.userData.isClipFill      = true;

      for (const solid of solids) {
        solid.updateMatrixWorld(true);

        // Back-face helper: IncrementWrap inside solid behind plane.
        const backMat = new THREE.MeshBasicMaterial({
          side:          THREE.BackSide,
          clippingPlanes: [plane],
          colorWrite:    false,
          depthWrite:    false,
          depthTest:     false,
          stencilWrite:  true,
          stencilFunc:   THREE.AlwaysStencilFunc,
          stencilFail:   THREE.IncrementWrapStencilOp,
          stencilZFail:  THREE.IncrementWrapStencilOp,
          stencilZPass:  THREE.IncrementWrapStencilOp,
        });

        // Front-face helper: DecrementWrap cancels rays that exit the solid.
        const frontMat = new THREE.MeshBasicMaterial({
          side:          THREE.FrontSide,
          clippingPlanes: [plane],
          colorWrite:    false,
          depthWrite:    false,
          depthTest:     false,
          stencilWrite:  true,
          stencilFunc:   THREE.AlwaysStencilFunc,
          stencilFail:   THREE.DecrementWrapStencilOp,
          stencilZFail:  THREE.DecrementWrapStencilOp,
          stencilZPass:  THREE.DecrementWrapStencilOp,
        });

        const backM  = new THREE.Mesh(solid.geometry, backMat);
        const frontM = new THREE.Mesh(solid.geometry, frontMat);

        // Bake solid's world transform (matrixAutoUpdate:false so THREE.js won't
        // overwrite from position/rotation/scale, which remain at zero).
        backM.matrixAutoUpdate  = false;
        frontM.matrixAutoUpdate = false;
        backM.matrix.copy(solid.matrixWorld);
        frontM.matrix.copy(solid.matrixWorld);
        backM.matrixWorldNeedsUpdate  = true;
        frontM.matrixWorldNeedsUpdate = true;

        backM.renderOrder  = helperRO;
        frontM.renderOrder = helperRO;
        backM.userData.excludeFromClip  = true;
        frontM.userData.excludeFromClip = true;
        backM.userData.noSnap  = true;
        frontM.userData.noSnap = true;

        helperGroup.add(backM, frontM);
      }

      scene.add(helperGroup);
      this._helperGroups.push(helperGroup);

      // ── Fill plane ────────────────────────────────────────────────────────
      const otherPlanes = planes.filter((_, i) => i !== pi);
      const fillMat = new THREE.MeshBasicMaterial({
        color:          fillColor,
        side:           THREE.DoubleSide,
        clippingPlanes: otherPlanes,
        colorWrite:     true,
        depthWrite:     false,
        stencilWrite:   true,
        stencilFunc:    THREE.NotEqualStencilFunc,
        stencilRef:     0,
        stencilFail:    THREE.ReplaceStencilOp,
        stencilZFail:   THREE.ReplaceStencilOp,
        stencilZPass:   THREE.ReplaceStencilOp,
      });

      const fillGeom = new THREE.PlaneGeometry(FILL_PLANE_SIZE, FILL_PLANE_SIZE);
      const fillMesh = new THREE.Mesh(fillGeom, fillMat);
      fillMesh.renderOrder = fillRO;
      fillMesh.userData.excludeFromClip = true;
      fillMesh.userData.noSnap          = true;
      fillMesh.userData.isClipFill      = true;

      // Orient fill quad to match the clip plane.
      // THREE.Plane: normal·x + constant = 0  →  closest-to-origin point = -constant·normal.
      const n = plane.normal.clone();
      fillMesh.position.copy(n.clone().multiplyScalar(-plane.constant));
      fillMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);

      // Clear stencil after this fill renders so the next plane's helpers
      // start with a zero stencil buffer.
      fillMesh.onAfterRender = (renderer) => renderer.clearStencil();

      scene.add(fillMesh);
      this._fillMeshes.push(fillMesh);
    }
  }

  /** Swap fill color when render mode changes (no full rebuild needed). */
  updateColor(fillMode: string): void {
    const c = fillColorHex(fillMode);
    for (const m of this._fillMeshes) {
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.setHex(c);
      mat.needsUpdate = true;
    }
  }

  dispose(scene: THREE.Scene): void {
    this._scene = scene;
    this._cleanup();
  }

  private _collectSolids(scene: THREE.Scene): THREE.Mesh[] {
    const result: THREE.Mesh[] = [];
    scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh))          return;
      if (obj.userData.excludeFromClip === true)  return;
      if (obj.userData.isClipFill)               return;
      if (obj.userData.noRenderMode)             return; // grid, axes
      if (!obj.visible)                          return;
      if (!obj.geometry)                         return;
      result.push(obj);
    });
    return result;
  }

  private _cleanup(): void {
    const scene = this._scene;
    if (!scene) return;
    for (const g of this._helperGroups) {
      scene.remove(g);
      g.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        // Material is ours — dispose it. Geometry is borrowed from the solid — don't dispose.
        (obj.material as THREE.Material).dispose();
      });
    }
    for (const m of this._fillMeshes) {
      scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this._helperGroups = [];
    this._fillMeshes   = [];
  }
}
