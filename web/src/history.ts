// Undo/redo stack for scene object placement (#27) and transforms (#318).
// Action union: CreateAction | TransformAction | BatchAction | ReplaceAction | DeleteAction.

import * as THREE from "three";
import type { Viewer } from "./viewer/viewer";

export type TransformSnapshot = {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
};

type CreateAction    = { kind: "create";    obj: THREE.Object3D; chain: string };
type TransformAction = { kind: "transform"; obj: THREE.Object3D; before: TransformSnapshot; after: TransformSnapshot };
type BatchAction     = { kind: "batch";     objs: THREE.Object3D[]; chain: string };
type ReplaceAction   = { kind: "replace";   added: THREE.Object3D; removed: THREE.Object3D[]; chain: string };
// Geometry is NOT disposed on delete — kept alive so undo can re-add it.
// Disposal happens when clearHistory() is called (scene wipe / file load).
type DeleteAction    = { kind: "delete";    obj: THREE.Object3D; parent: THREE.Object3D | null };
type Action = CreateAction | TransformAction | BatchAction | ReplaceAction | DeleteAction;

const _undo: Action[] = [];
const _redo: Action[] = [];

function disposeObj(obj: THREE.Object3D): void {
  obj.traverse((child) => {
    const c = child as THREE.Mesh;
    if (c.geometry) c.geometry.dispose();
    const mat = c.material;
    if (mat) {
      if (Array.isArray(mat)) (mat as THREE.Material[]).forEach((m) => m.dispose());
      else (mat as THREE.Material).dispose();
    }
  });
}

export function pushAction(obj: THREE.Object3D, chain: string): void {
  _undo.push({ kind: "create", obj, chain });
  _redo.length = 0;
}

export function captureTransform(obj: THREE.Object3D): TransformSnapshot {
  return {
    pos:   obj.position.clone(),
    quat:  obj.quaternion.clone(),
    scale: obj.scale.clone(),
  };
}

export function pushTransformAction(obj: THREE.Object3D, before: TransformSnapshot): void {
  const after = captureTransform(obj);
  _undo.push({ kind: "transform", obj, before, after });
  _redo.length = 0;
}

export function pushBatchAction(objs: THREE.Object3D[], chain: string): void {
  if (objs.length === 0) return;
  _undo.push({ kind: "batch", objs, chain });
  _redo.length = 0;
}

// Record an atomic replace: one object added, one or more removed.
// Undo restores the removed objects and removes the added one.
export function pushReplaceAction(added: THREE.Object3D, removed: THREE.Object3D[], chain: string): void {
  _undo.push({ kind: "replace", added, removed, chain });
  _redo.length = 0;
}

// Record a delete. Geometry is held alive so undo can restore the object.
export function pushDeleteAction(obj: THREE.Object3D, parent: THREE.Object3D | null): void {
  _undo.push({ kind: "delete", obj, parent });
  _redo.length = 0;
}

// Clear both stacks. Dispose geometry held by pending delete actions.
// Call whenever the scene is fully replaced (file load, clearScene) to prevent
// stale object references from re-entering a scene with disposed geometry.
export function clearHistory(): void {
  for (const a of [..._undo, ..._redo]) {
    if (a.kind === "delete") disposeObj(a.obj);
  }
  _undo.length = 0;
  _redo.length = 0;
}

export function undo(viewer: Viewer): boolean {
  const a = _undo.pop();
  if (!a) return false;
  if (a.kind === "create") {
    viewer.getScene().remove(a.obj);
    _redo.push(a);
  } else if (a.kind === "transform") {
    a.obj.position.copy(a.before.pos);
    a.obj.quaternion.copy(a.before.quat);
    a.obj.scale.copy(a.before.scale);
    a.obj.updateMatrix();
    a.obj.updateMatrixWorld(true);
    _redo.push(a);
  } else if (a.kind === "replace") {
    viewer.getScene().remove(a.added);
    for (const obj of a.removed) viewer.getScene().add(obj);
    _redo.push(a);
  } else if (a.kind === "delete") {
    if (a.parent) a.parent.add(a.obj);
    else viewer.getScene().add(a.obj);
    _redo.push(a);
  } else {
    for (const obj of a.objs) viewer.getScene().remove(obj);
    _redo.push(a);
  }
  return true;
}

export function redo(viewer: Viewer): boolean {
  const a = _redo.pop();
  if (!a) return false;
  if (a.kind === "create") {
    viewer.getScene().add(a.obj);
    _undo.push(a);
  } else if (a.kind === "transform") {
    a.obj.position.copy(a.after.pos);
    a.obj.quaternion.copy(a.after.quat);
    a.obj.scale.copy(a.after.scale);
    a.obj.updateMatrix();
    a.obj.updateMatrixWorld(true);
    _undo.push(a);
  } else if (a.kind === "replace") {
    for (const obj of a.removed) viewer.getScene().remove(obj);
    viewer.getScene().add(a.added);
    _undo.push(a);
  } else if (a.kind === "delete") {
    if (a.obj.parent) a.obj.parent.remove(a.obj);
    else viewer.getScene().remove(a.obj);
    _undo.push(a);
  } else {
    for (const obj of a.objs) viewer.getScene().add(obj);
    _undo.push(a);
  }
  return true;
}

export function canUndo(): boolean { return _undo.length > 0; }
export function canRedo(): boolean { return _redo.length > 0; }
