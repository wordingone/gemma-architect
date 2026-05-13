// Undo/redo stack for scene object placement (#27) and transforms (#318).
// Action union: CreateAction | TransformAction | BatchAction.

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
type Action = CreateAction | TransformAction | BatchAction | ReplaceAction;

const _undo: Action[] = [];
const _redo: Action[] = [];

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
  } else {
    for (const obj of a.objs) viewer.getScene().add(obj);
    _undo.push(a);
  }
  return true;
}

export function canUndo(): boolean { return _undo.length > 0; }
export function canRedo(): boolean { return _redo.length > 0; }
