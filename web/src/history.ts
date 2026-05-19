// Undo/redo stack for scene object placement (#27), transforms (#318), and
// transactional grouping (#850).
//
// Action union: CreateAction | TransformAction | BatchAction | ReplaceAction |
//               DeleteAction | GroupAction | CustomAction.
//
// GroupAction wraps multiple actions into one atomic undo/redo transaction.
// CustomAction holds caller-supplied undo/redo lambdas (e.g. layer state).
//
// Transaction API:
//   beginTransaction(label)    start accumulating actions
//   endTransaction()           flush accumulated actions as one GroupAction
//   (all push* functions auto-detect active transaction)

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
// Atomic group — one Ctrl+Z undoes all nested actions in reverse order.
type GroupAction     = { kind: "group";     label: string; actions: LeafAction[] };
// Caller-supplied revert/replay lambdas — no scene reference needed.
type CustomAction    = { kind: "custom";    undoFn(): void; redoFn(): void };

type LeafAction = CreateAction | TransformAction | BatchAction | ReplaceAction | DeleteAction | CustomAction;
type Action     = LeafAction | GroupAction;

const _undo: Action[] = [];
const _redo: Action[] = [];

// Transaction buffer — non-null when a transaction is open.
let _txBuffer: LeafAction[] | null = null;
let _txLabel  = "";

let _onActionPushed: (() => void) | null = null;
export function setOnActionPushed(cb: () => void): void { _onActionPushed = cb; }

function _push(a: LeafAction): void {
  if (_txBuffer !== null) {
    _txBuffer.push(a);
  } else {
    _undo.push(a);
    _redo.length = 0;
    _onActionPushed?.();
  }
}

// ── Transaction API ────────────────────────────────────────────────────────────

export function beginTransaction(label: string): void {
  _txBuffer = [];
  _txLabel  = label;
}

export function endTransaction(): void {
  if (_txBuffer === null) return;
  const actions = _txBuffer;
  _txBuffer = null;
  if (actions.length === 0) return;
  if (actions.length === 1) {
    _undo.push(actions[0]);
  } else {
    _undo.push({ kind: "group", label: _txLabel, actions });
  }
  _redo.length = 0;
  _onActionPushed?.();
}

// ── Push helpers ───────────────────────────────────────────────────────────────

export function pushAction(obj: THREE.Object3D, chain: string): void {
  _push({ kind: "create", obj, chain });
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
  _push({ kind: "transform", obj, before, after });
}

export function pushBatchAction(objs: THREE.Object3D[], chain: string): void {
  if (objs.length === 0) return;
  _push({ kind: "batch", objs, chain });
}

// Record an atomic replace: one object added, one or more removed.
// Undo restores the removed objects and removes the added one.
export function pushReplaceAction(added: THREE.Object3D, removed: THREE.Object3D[], chain: string): void {
  _push({ kind: "replace", added, removed, chain });
}

// Record a delete. Geometry is held alive so undo can restore the object.
export function pushDeleteAction(obj: THREE.Object3D, parent: THREE.Object3D | null): void {
  _push({ kind: "delete", obj, parent });
}

// Record a custom reversible action via callbacks (e.g. layer-state changes
// that live outside the scene graph and cannot be expressed as object ops).
export function pushCustomAction(undoFn: () => void, redoFn: () => void): void {
  _push({ kind: "custom", undoFn, redoFn });
}

// ── Leaf undo/redo ─────────────────────────────────────────────────────────────

function _undoLeaf(a: LeafAction, viewer: Viewer): void {
  const tgt = viewer.getTargetObject();
  if (a.kind === "create") {
    if (tgt === a.obj) viewer.deselectCurrent();
    viewer.getScene().remove(a.obj);
  } else if (a.kind === "transform") {
    a.obj.position.copy(a.before.pos);
    a.obj.quaternion.copy(a.before.quat);
    a.obj.scale.copy(a.before.scale);
    a.obj.updateMatrix();
    a.obj.updateMatrixWorld(true);
  } else if (a.kind === "replace") {
    if (tgt === a.added) viewer.deselectCurrent();
    viewer.getScene().remove(a.added);
    for (const obj of a.removed) viewer.getScene().add(obj);
  } else if (a.kind === "delete") {
    if (a.parent) a.parent.add(a.obj);
    else viewer.getScene().add(a.obj);
  } else if (a.kind === "batch") {
    if (tgt && a.objs.includes(tgt)) viewer.deselectCurrent();
    for (const obj of a.objs) viewer.getScene().remove(obj);
  } else {
    a.undoFn();
  }
}

function _redoLeaf(a: LeafAction, viewer: Viewer): void {
  const tgt = viewer.getTargetObject();
  if (a.kind === "create") {
    viewer.getScene().add(a.obj);
  } else if (a.kind === "transform") {
    a.obj.position.copy(a.after.pos);
    a.obj.quaternion.copy(a.after.quat);
    a.obj.scale.copy(a.after.scale);
    a.obj.updateMatrix();
    a.obj.updateMatrixWorld(true);
  } else if (a.kind === "replace") {
    if (tgt && a.removed.includes(tgt)) viewer.deselectCurrent();
    for (const obj of a.removed) viewer.getScene().remove(obj);
    viewer.getScene().add(a.added);
  } else if (a.kind === "delete") {
    if (tgt === a.obj) viewer.deselectCurrent();
    if (a.obj.parent) a.obj.parent.remove(a.obj);
    else viewer.getScene().remove(a.obj);
  } else if (a.kind === "batch") {
    viewer.getScene().add(...a.objs);
  } else {
    a.redoFn();
  }
}

// ── Dispose helper ─────────────────────────────────────────────────────────────

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

function _disposeAction(a: Action): void {
  if (a.kind === "delete") {
    disposeObj(a.obj);
  } else if (a.kind === "group") {
    for (const child of a.actions) _disposeAction(child);
  }
}

// ── Public undo/redo ──────────────────────────────────────────────────────────

// Clear both stacks. Dispose geometry held by pending delete actions.
// Call whenever the scene is fully replaced (file load, clearScene) to prevent
// stale object references from re-entering a scene with disposed geometry.
export function clearHistory(): void {
  for (const a of [..._undo, ..._redo]) _disposeAction(a);
  _undo.length = 0;
  _redo.length = 0;
  _txBuffer = null;
}

export function undo(viewer: Viewer): boolean {
  const a = _undo.pop();
  if (!a) return false;
  if (a.kind === "group") {
    for (let i = a.actions.length - 1; i >= 0; i--) _undoLeaf(a.actions[i], viewer);
    _redo.push(a);
  } else {
    _undoLeaf(a, viewer);
    _redo.push(a);
  }
  return true;
}

export function redo(viewer: Viewer): boolean {
  const a = _redo.pop();
  if (!a) return false;
  if (a.kind === "group") {
    for (const child of a.actions) _redoLeaf(child, viewer);
    _undo.push(a);
  } else {
    _redoLeaf(a, viewer);
    _undo.push(a);
  }
  return true;
}

export function canUndo(): boolean { return _undo.length > 0; }
export function canRedo(): boolean { return _redo.length > 0; }
