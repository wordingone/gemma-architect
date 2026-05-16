// Select — multi-select highlight and collectSelectable.
// runRectSel / runPolySel live in op-tool.ts (they use registerSelHelpers injection).

import * as THREE from "three";
import type { Viewer } from "../viewer";
import {
  _multiSelHighlighted, setMultiSelHighlighted,
  _markerMesh, _sketchShiftAxisLine,
} from "./state";

// ─── Multi-select highlight ───────────────────────────────────────────────────

export function clearMultiSelHighlights(): void {
  for (const obj of _multiSelHighlighted) {
    if (obj.userData._selHL === undefined) continue;
    if (obj instanceof THREE.Mesh) {
      (obj.material as THREE.MeshStandardMaterial).emissive?.setHex(obj.userData._selHL as number);
    } else if (obj instanceof THREE.Line) {
      (obj.material as THREE.LineBasicMaterial).color.setHex(obj.userData._selHL as number);
    } else if (obj instanceof THREE.Points) {
      (obj.material as THREE.PointsMaterial).color.setHex(obj.userData._selHL as number);
    }
    delete obj.userData._selHL;
  }
  setMultiSelHighlighted([]);
}

export function applyMultiSelHL(obj: THREE.Object3D): void {
  if (obj.userData._selHL !== undefined) return;
  if (obj instanceof THREE.Mesh && (obj.material as THREE.MeshStandardMaterial).emissive) {
    obj.userData._selHL = (obj.material as THREE.MeshStandardMaterial).emissive.getHex();
    (obj.material as THREE.MeshStandardMaterial).emissive.setHex(0x223355);
    _multiSelHighlighted.push(obj);
  } else if (obj instanceof THREE.Line) {
    obj.userData._selHL = (obj.material as THREE.LineBasicMaterial).color.getHex();
    (obj.material as THREE.LineBasicMaterial).color.setHex(0x44aaff);
    _multiSelHighlighted.push(obj);
  } else if (obj instanceof THREE.Points) {
    obj.userData._selHL = (obj.material as THREE.PointsMaterial).color.getHex();
    (obj.material as THREE.PointsMaterial).color.setHex(0x44aaff);
    _multiSelHighlighted.push(obj);
  }
}

// ─── Selectable object collection ─────────────────────────────────────────────

export function collectSelectable(viewer: Viewer): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  viewer.getScene().traverse((o) => {
    if (o.userData.noSnap || !o.visible) return;
    if (!(o instanceof THREE.Mesh) && !(o instanceof THREE.Line) && !(o instanceof THREE.Points)) return;
    // Skip internal marker / overlay objects.
    if (o === _markerMesh || o === _sketchShiftAxisLine) return;
    out.push(o);
  });
  return out;
}
