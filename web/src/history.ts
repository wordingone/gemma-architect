// Undo/redo stack for scene object placement (#27).
// Each action records the placed THREE.Object3D + its replicad chain string.
// Undo removes the object from the scene; redo re-adds it.

import * as THREE from "three";
import type { Viewer } from "./viewer/viewer";

type Action = { obj: THREE.Object3D; chain: string };

const _undo: Action[] = [];
const _redo: Action[] = [];

export function pushAction(obj: THREE.Object3D, chain: string): void {
  _undo.push({ obj, chain });
  _redo.length = 0;
}

export function undo(viewer: Viewer): boolean {
  const a = _undo.pop();
  if (!a) return false;
  viewer.getScene().remove(a.obj);
  _redo.push(a);
  return true;
}

export function redo(viewer: Viewer): boolean {
  const a = _redo.pop();
  if (!a) return false;
  viewer.getScene().add(a.obj);
  _undo.push(a);
  return true;
}

export function canUndo(): boolean { return _undo.length > 0; }
export function canRedo(): boolean { return _redo.length > 0; }
