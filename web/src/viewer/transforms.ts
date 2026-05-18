// Transform gizmos (T4) — translate / rotate / scale + delete.
//
// Wraps three.js TransformControls, binds it to the current selection from
// selection-state, and on drag-commit (mouseup) re-emits a replicad chain
// suffix (`.translate(...)` / `.rotate(...)` / `.scale(...)`) onto the
// underlying construction sequence the viewer is tracking.
//
// State tracked here:
//   - The active gizmo (one of translate / rotate / scale, or none).
//   - The position/rotation/scale captured at mouseDown, so mouseUp can
//     compute the delta and lower it to a replicad call.
//
// What this module does NOT do (delegated to the caller):
//   - Generate the source replicad JS — main.ts owns that pipeline.
//     transforms.ts emits a string fragment + invokes a callback so the
//     existing source-of-truth (the worker's executed JS) can be updated.
//   - Re-mesh the modified shape — that's a worker round-trip (out of scope
//     for this task; transforms apply a Three.js-side visual transform via
//     position/quaternion/scale on the selected mesh).

import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { Viewer } from "./viewer";
import {
  getSelected,
  setSelected,
  subscribe,
  clearSelected,
  type Selection,
} from "./selection-state";
import { pushTransformAction } from "../history";
import { getSnap } from "./snap-state";
import { unprojectToAxisLine, getLastSnapEdgeDir } from "./snap-state";
import { dispatchSync } from "../commands/dispatch";
import { formatLength } from "../units";

export type GizmoMode = "translate" | "rotate" | "scale";

// Append-only log of replicad-chain fragments produced by gizmo commits +
// delete operations. Tests assert on this; the real app reads it to update
// `#js-source` on save / re-run.
const _replicadSequence: string[] = [];

// Per-gizmo-cycle state captured at mouseDown.
type Captured = {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

export function getReplicadSequence(): string[] {
  return [..._replicadSequence];
}

export function clearReplicadSequence(): void {
  _replicadSequence.length = 0;
}

/** Record one replicad chain fragment and notify listeners via CustomEvent. */
export function emitChainFragment(fragment: string): void {
  if (!fragment) return;
  _replicadSequence.push(fragment);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("gemma:chain-fragment", { detail: { fragment } }));
  }
}

export class TransformBinder {
  private viewer: Viewer;
  private controls: TransformControls;
  private captured: Captured | null = null;
  private currentSelection: Selection | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(viewer: Viewer) {
    this.viewer = viewer;
    const camera = (viewer.getCamera ? viewer.getCamera() : (viewer as any).camera) as THREE.Camera;
    const canvas = viewer.getCanvas ? viewer.getCanvas() : (viewer as any).canvas;
    this.controls = new TransformControls(camera, canvas);
    this.controls.setSpace("world");
    this.controls.size = 0.85;
    // Stash the gizmo widget into the scene. The gizmo Object3D itself is
    // the controls instance.
    const scene = (viewer.getScene ? viewer.getScene() : (viewer as any).scene) as THREE.Scene;
    scene.add(this.controls);

    // Suspend OrbitControls while gizmo is being dragged so panning doesn't
    // fight the gizmo. Stored as a flag on viewer.controls — viewer.ts
    // pointerdown reads this to skip the pick when gizmo is active.
    this.controls.addEventListener("dragging-changed", (e) => {
      const orbit = (viewer as any).controls;
      if (orbit && "enabled" in orbit) orbit.enabled = !e.value;
      (viewer as any).__suspended = e.value;
    });

    this.controls.addEventListener("mouseDown", () => this.onDragStart());
    this.controls.addEventListener("mouseUp", () => this.onDragEnd());

    // Track selection changes — re-attach the gizmo to the new transformTarget
    // (or detach when nothing is selected).
    this.unsubscribe = subscribe((sel) => this.onSelectionChange(sel));
    // Initial state — nothing selected.
    this.controls.detach();
  }

  setMode(mode: GizmoMode): void {
    this.controls.setMode(mode);
  }

  getMode(): GizmoMode {
    return this.controls.getMode() as GizmoMode;
  }

  // Programmatic detach, e.g. when caller wants to deselect.
  detach(): void {
    this.controls.detach();
    this.captured = null;
    this.currentSelection = null;
  }

  // Test-only hook: simulate a complete drag cycle (start → manipulate →
  // commit) by mutating the target's transform directly and emitting the
  // gizmo's mouseup-style event. This bypasses the real pointer handling
  // because tests can't drive it without a WebGL canvas.
  simulateDrag(opts: {
    mode: GizmoMode;
    deltaPosition?: [number, number, number];
    deltaRotationDegZ?: number;
    scaleFactor?: number;
  }): void {
    const sel = getSelected();
    if (!sel) return;
    this.setMode(opts.mode);
    this.controls.attach(sel.transformTarget);
    this.onDragStart();
    const target = sel.transformTarget;
    if (opts.mode === "translate" && opts.deltaPosition) {
      target.position.x += opts.deltaPosition[0];
      target.position.y += opts.deltaPosition[1];
      target.position.z += opts.deltaPosition[2];
    } else if (opts.mode === "rotate" && opts.deltaRotationDegZ != null) {
      const rad = (opts.deltaRotationDegZ * Math.PI) / 180;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rad);
      target.quaternion.premultiply(q);
    } else if (opts.mode === "scale" && opts.scaleFactor != null) {
      target.scale.multiplyScalar(opts.scaleFactor);
    }
    this.onDragEnd();
  }

  private onSelectionChange(sel: Selection | null): void {
    this.currentSelection = sel;
    if (!sel) {
      this.controls.detach();
      this.captured = null;
      return;
    }
    this.controls.attach(sel.transformTarget);
  }

  private onDragStart(): void {
    const sel = this.currentSelection ?? getSelected();
    if (!sel) return;
    const t = sel.transformTarget;
    this.captured = {
      position: t.position.clone(),
      quaternion: t.quaternion.clone(),
      scale: t.scale.clone(),
    };
  }

  private onDragEnd(): void {
    const sel = this.currentSelection ?? getSelected();
    if (!sel || !this.captured) return;
    const t = sel.transformTarget;
    const before = this.captured;
    const after = {
      position: t.position.clone(),
      quaternion: t.quaternion.clone(),
      scale: t.scale.clone(),
    };
    const mode = this.getMode();
    let fragment = "";
    if (mode === "translate") {
      const dx = round(after.position.x - before.position.x);
      const dy = round(after.position.y - before.position.y);
      const dz = round(after.position.z - before.position.z);
      // Only emit if there's actual delta — mouseUp without movement should
      // not pollute the construction sequence.
      if (dx !== 0 || dy !== 0 || dz !== 0) {
        fragment = `.translate([${dx}, ${dy}, ${dz}])`;
      }
    } else if (mode === "rotate") {
      // Decompose the rotation delta around Z. For non-Z axes, the gizmo
      // emits the full delta-quaternion; we lower it to (angle, axis) in
      // replicad's `(angle, position, direction)` calling convention.
      const dq = before.quaternion.clone().invert().multiply(after.quaternion);
      const axis = new THREE.Vector3();
      let angle = 2 * Math.acos(Math.max(-1, Math.min(1, dq.w)));
      const s = Math.sqrt(1 - dq.w * dq.w);
      if (s < 1e-4) {
        axis.set(0, 0, 1);
      } else {
        axis.set(dq.x / s, dq.y / s, dq.z / s);
      }
      const deg = round((angle * 180) / Math.PI);
      if (deg !== 0) {
        fragment = `.rotate(${deg}, [0, 0, 0], [${round(axis.x)}, ${round(axis.y)}, ${round(axis.z)}])`;
      }
    } else if (mode === "scale") {
      // Scale is applied uniformly; pick the largest-magnitude factor.
      const sx = round(after.scale.x / before.scale.x);
      const sy = round(after.scale.y / before.scale.y);
      const sz = round(after.scale.z / before.scale.z);
      // For uniform scale, sx≈sy≈sz; for non-uniform we average.
      // replicad's scale takes a single factor in 1-arg form.
      const factor = round((sx + sy + sz) / 3);
      if (factor !== 1) {
        fragment = `.scale(${factor})`;
      }
    }
    if (fragment) emitChainFragment(fragment);
    this.captured = null;
  }

  dispose(): void {
    if (this.unsubscribe) this.unsubscribe();
    this.controls.detach();
    this.controls.dispose();
  }
}

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// Delete the current selection — drops the mesh from the scene + helpers,
// records a delete fragment in the replicad sequence, and clears selection.
// Returns true if a delete actually happened.
export function deleteSelected(viewer: Viewer): boolean {
  const sel = getSelected();
  if (!sel) return false;
  const target = sel.transformTarget;
  const removed = viewer.removeObject(target);
  if (removed) {
    emitChainFragment(`// removed: uuid=${target.uuid}`);
    clearSelected();
  }
  return removed;
}

// Re-export for use by tools/index.ts without circular dependency.
export { setSelected };
export { unprojectToAxisLine };
export { formatLength };

// ── Precision Transform (PT) state machine ────────────────────────────────────
// Extracted from create-mode.ts (#723).
// Move:   pick_start → pick_end   → translate by (end - start)
// Rotate: pick_base  → hover/pick → rotate around custom axis
// Scale:  pick_base  → type/pick  → uniform / 1D / 2D scale

type ScaleMode = "3d" | "1d" | "2d";

export type PTPhase =
  | { kind: "start";         tool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d" }
  | { kind: "end_move";      start: THREE.Vector3 }
  | { kind: "rotate_axis_a" }
  | { kind: "rotate_axis_b"; axisA: THREE.Vector3 }
  | { kind: "angle_end";     base: THREE.Vector3; axisA: THREE.Vector3; axisDir: THREE.Vector3 }
  | { kind: "scale_ref";     base: THREE.Vector3; mode: ScaleMode }
  | { kind: "scale_end";     base: THREE.Vector3; refPt: THREE.Vector3; mode: ScaleMode };

export let _ptPhase: PTPhase | null = null;
export let _ptAxisLock: "x" | "y" | "z" | null = null;
export let _ptViewer: Viewer | null = null;
export let _lastPtTool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d" | null = null;

let _ptCoordWrapEl: HTMLElement | null = null;
export let _ptCoordInputEl: HTMLInputElement | null = null;
let _ptPreviewLine: THREE.Line | null = null;
let _ptAxisLockLine: THREE.Line | null = null;
let _ptInitPos: THREE.Vector3 | null = null;
let _ptInitQuat: THREE.Quaternion | null = null;
let _ptInitScale: THREE.Vector3 | null = null;

// Late-binding: tools/index.ts registers this to avoid circular import.
let _hideCursorDot: () => void = () => {};
export function registerHideCursorDot(fn: () => void): void { _hideCursorDot = fn; }

// Late-binding: tools/index.ts registers picker-hint setPickerHint.
// We use a local forward reference pattern.
let _setPickerHint: (msg: string | null) => void = () => {};
let _setPickerHintCb: (msg: string | null) => void = () => {};

// DOM init — called by tools/index.ts during initCreateMode.
export function initPtOverlay(ptWrap: HTMLElement, ptInput: HTMLInputElement): void {
  _ptCoordWrapEl = ptWrap;
  _ptCoordInputEl = ptInput;
  _ptViewer = null; // will be set on first ptStartTool call
}

export function ptGetTarget(): THREE.Object3D | null {
  return getSelected()?.transformTarget ?? null;
}

function ptCentroid(obj: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3();
  box.getCenter(center);
  return center;
}

// These functions set picker-hint via dynamic import to break circular dependency.
// picker-hint → transforms circular: picker-hint.ts imports nothing from transforms,
// but transforms.ts would import setPickerHint from picker-hint.ts which imports from viewer.
// Solution: use a dynamic lazy import at first call.
let _pickerHintImported = false;
let _setPickerHintFn: ((msg: string | null) => void) | null = null;
async function ensurePickerHint(): Promise<void> {
  if (_pickerHintImported) return;
  _pickerHintImported = true;
  const m = await import("./picker-hint");
  _setPickerHintFn = m.setPickerHint;
}

export function ptPrompt(msg: string): void {
  if (_setPickerHintFn) { _setPickerHintFn(msg); return; }
  void ensurePickerHint().then(() => _setPickerHintFn?.(msg));
}
export function ptClearPrompt(): void {
  if (_setPickerHintFn) { _setPickerHintFn(null); return; }
  void ensurePickerHint().then(() => _setPickerHintFn?.(null));
}

export function ptShowCoordInput(placeholder: string): void {
  if (!_ptCoordWrapEl) return;
  if (_ptCoordInputEl) _ptCoordInputEl.placeholder = placeholder;
  _ptCoordWrapEl.classList.add("visible");
  setTimeout(() => _ptCoordInputEl?.focus(), 0);
}

export function ptHideCoordInput(): void {
  if (!_ptCoordWrapEl) return;
  _ptCoordWrapEl.classList.remove("visible");
  if (_ptCoordInputEl) _ptCoordInputEl.value = "";
}

export function ptIsCoordInputActive(): boolean {
  return !!(_ptCoordWrapEl?.classList.contains("visible"));
}

function ptClearPreviewLine(viewer: Viewer): void {
  if (_ptPreviewLine) {
    viewer.getScene().remove(_ptPreviewLine);
    _ptPreviewLine.geometry.dispose();
    (_ptPreviewLine.material as THREE.Material).dispose();
    _ptPreviewLine = null;
  }
}

function ptSetPreviewLine(viewer: Viewer, from: THREE.Vector3, to: THREE.Vector3): void {
  ptClearPreviewLine(viewer);
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const mat = new THREE.LineBasicMaterial({ color: 0x4488ff, depthTest: false });
  _ptPreviewLine = new THREE.Line(geo, mat);
  _ptPreviewLine.renderOrder = 99;
  _ptPreviewLine.userData.noSnap = true;
  viewer.getScene().add(_ptPreviewLine);
}

export function ptGetAxisBase(): THREE.Vector3 | null {
  const p = _ptPhase;
  if (!p) return null;
  if (p.kind === "end_move") return p.start;
  if (p.kind === "rotate_axis_b") return p.axisA;
  if (p.kind === "angle_end") return p.base;
  if (p.kind === "scale_ref" || p.kind === "scale_end") return p.base;
  return null;
}

export function ptClearAxisLockLine(viewer: Viewer): void {
  if (_ptAxisLockLine) {
    viewer.getScene().remove(_ptAxisLockLine);
    _ptAxisLockLine.geometry.dispose();
    (_ptAxisLockLine.material as THREE.Material).dispose();
    _ptAxisLockLine = null;
  }
}

export function ptSetAxisLockLine(viewer: Viewer, basePt: THREE.Vector3): void {
  ptClearAxisLockLine(viewer);
  if (!_ptAxisLock) return;
  const dir = _ptAxisLock === "x" ? new THREE.Vector3(1, 0, 0) :
              _ptAxisLock === "y" ? new THREE.Vector3(0, 1, 0) :
                                    new THREE.Vector3(0, 0, 1);
  const color = _ptAxisLock === "x" ? 0xff3333 : _ptAxisLock === "y" ? 0x33cc33 : 0x3388ff;
  const geo = new THREE.BufferGeometry().setFromPoints([
    basePt.clone().addScaledVector(dir, -1000),
    basePt.clone().addScaledVector(dir,  1000),
  ]);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, opacity: 0.55, transparent: true });
  _ptAxisLockLine = new THREE.Line(geo, mat);
  _ptAxisLockLine.renderOrder = 98;
  _ptAxisLockLine.userData.noSnap = true;
  viewer.getScene().add(_ptAxisLockLine);
}

export function ptEffectiveAxisDir(): THREE.Vector3 {
  const lastEdge = getLastSnapEdgeDir();
  if (lastEdge) return lastEdge.clone();
  return _ptAxisLock === "x" ? new THREE.Vector3(1, 0, 0) :
         _ptAxisLock === "y" ? new THREE.Vector3(0, 1, 0) :
                               new THREE.Vector3(0, 0, 1);
}

export function ptPhaseIsObjectSelect(): boolean {
  return _ptPhase?.kind === "start" && !ptGetTarget();
}

export function ptFinish(viewer: Viewer): void {
  _ptInitPos = null; _ptInitQuat = null; _ptInitScale = null;
  _ptAxisLock = null;
  ptClearAxisLockLine(viewer);
  _ptPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  _hideCursorDot();
  ptClearPreviewLine(viewer);
  viewer.setGumballEnabled(true);
  dispatchSync("setActiveTool", { toolId: "select" });
}

export function ptCancel(viewer: Viewer): void {
  const obj = ptGetTarget();
  if (obj && _ptInitPos) {
    obj.position.copy(_ptInitPos);
    if (_ptInitQuat) obj.quaternion.copy(_ptInitQuat);
    if (_ptInitScale) obj.scale.copy(_ptInitScale);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);
  }
  ptFinish(viewer);
}

function ptCommitMove(obj: THREE.Object3D, delta: THREE.Vector3): void {
  obj.position.add(delta);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

function ptCommitRotate(obj: THREE.Object3D, base: THREE.Vector3, angleDeg: number, axisDir?: THREE.Vector3): void {
  const rad = angleDeg * Math.PI / 180;
  const axis = axisDir ? axisDir.clone().normalize() : new THREE.Vector3(0, 0, 1);
  obj.position.sub(base);
  obj.position.applyAxisAngle(axis, rad);
  obj.position.add(base);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, rad);
  obj.quaternion.premultiply(q);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

function ptCommitScale(obj: THREE.Object3D, base: THREE.Vector3, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  obj.position.sub(base);
  obj.position.multiplyScalar(factor);
  obj.position.add(base);
  obj.scale.multiplyScalar(factor);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

function ptCommitScale1D(obj: THREE.Object3D, base: THREE.Vector3, dir: THREE.Vector3, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  const ax = Math.abs(dir.x), ay = Math.abs(dir.y), az = Math.abs(dir.z);
  const axis: "x" | "y" | "z" = ax >= ay && ax >= az ? "x" : ay >= az ? "y" : "z";
  const offset = obj.position.clone().sub(base);
  offset[axis] *= factor;
  obj.position.copy(base).add(offset);
  obj.scale[axis] *= factor;
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

function ptCommitScale2D(obj: THREE.Object3D, base: THREE.Vector3, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  const offset = obj.position.clone().sub(base);
  offset.x *= factor;
  offset.y *= factor;
  obj.position.copy(base).add(offset);
  obj.scale.x *= factor;
  obj.scale.y *= factor;
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

export function ptHandlePoint(viewer: Viewer, worldPt: THREE.Vector3): void {
  const phase = _ptPhase;
  if (!phase) return;
  const obj = ptGetTarget();
  if (!obj) { ptCancel(viewer); return; }

  if (phase.kind === "start") {
    _ptInitPos = obj.position.clone();
    _ptInitQuat = obj.quaternion.clone();
    _ptInitScale = obj.scale.clone();
    const pt = worldPt.clone();
    if (phase.tool === "move") {
      _ptPhase = { kind: "end_move", start: pt };
      ptPrompt("Target point — click, type x,y,z, or Enter for original position  [Shift+X/Y/Z = axis lock]");
      ptShowCoordInput("x, y  or  x, y, z");
    } else if (phase.tool === "rotate") {
      _ptPhase = { kind: "rotate_axis_a" };
      ptPrompt("Rotation axis — click start point of axis");
      ptHideCoordInput();
    } else {
      const scaleMode: ScaleMode = phase.tool === "scale-1d" ? "1d" : phase.tool === "scale-2d" ? "2d" : "3d";
      _ptPhase = { kind: "scale_ref", base: pt, mode: scaleMode };
      const scalePrompt = scaleMode === "1d"
        ? "Scale 1D — type factor or click anchor/origin point"
        : scaleMode === "2d"
        ? "Scale 2D — type factor or click anchor/origin point  [Z height unchanged]"
        : "Scale — type factor (e.g. 2.0) or click reference start point";
      ptPrompt(scalePrompt);
      ptShowCoordInput("scale factor");
    }
    return;
  }

  if (phase.kind === "rotate_axis_a") {
    _ptPhase = { kind: "rotate_axis_b", axisA: worldPt.clone() };
    ptPrompt("Rotation axis — click end point of axis");
    ptSetPreviewLine(viewer, worldPt, worldPt.clone().add(new THREE.Vector3(0, 0, 0.01)));
    if (_ptAxisLock) ptSetAxisLockLine(viewer, worldPt);
    return;
  }

  if (phase.kind === "rotate_axis_b") {
    let endPt = worldPt.clone();
    if (_ptAxisLock) {
      endPt = phase.axisA.clone().add(ptEffectiveAxisDir());
    }
    const axisDir = endPt.clone().sub(phase.axisA);
    if (axisDir.length() < 1e-6) {
      ptPrompt("Rotation axis — points too close, click a different end point");
      return;
    }
    axisDir.normalize();
    _ptInitPos = obj.position.clone();
    _ptInitQuat = obj.quaternion.clone();
    _ptInitScale = obj.scale.clone();
    _ptPhase = { kind: "angle_end", base: phase.axisA.clone(), axisA: phase.axisA.clone(), axisDir };
    ptPrompt("Rotation angle — hover and click, or type degrees");
    ptShowCoordInput("angle in degrees");
    return;
  }

  if (phase.kind === "end_move") {
    if (_ptInitPos) {
      const before = { pos: _ptInitPos.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      obj.position.copy(_ptInitPos).add(worldPt.clone().sub(phase.start));
      obj.updateMatrix(); obj.updateMatrixWorld(true);
      pushTransformAction(obj, before);
    }
    ptFinish(viewer);
    return;
  }

  if (phase.kind === "angle_end") {
    const dx = worldPt.x - phase.base.x;
    const dy = worldPt.y - phase.base.y;
    const raw = Math.atan2(dy, dx) * 180 / Math.PI;
    const snap = getSnap();
    const angleDeg = (snap.snapOn && snap.polarOn)
      ? Math.round(raw / snap.angleStep) * snap.angleStep : raw;
    if (_ptInitPos && _ptInitQuat) {
      const before = { pos: _ptInitPos.clone(), quat: _ptInitQuat.clone(), scale: _ptInitScale!.clone() };
      obj.position.copy(_ptInitPos);
      obj.quaternion.copy(_ptInitQuat);
      ptCommitRotate(obj, phase.base, angleDeg, phase.axisDir);
      pushTransformAction(obj, before);
    }
    ptFinish(viewer);
    return;
  }

  if (phase.kind === "scale_ref") {
    _ptPhase = { kind: "scale_end", base: phase.base, refPt: worldPt.clone(), mode: phase.mode };
    const endPrompt = phase.mode === "1d"
      ? "Scale 1D — click target point  [direction defined by first two clicks]"
      : phase.mode === "2d"
      ? "Scale 2D — click target point  [Z unchanged]"
      : "Scale end — click target point to define scale from reference distance";
    ptPrompt(endPrompt);
    ptHideCoordInput();
    return;
  }

  if (phase.kind === "scale_end") {
    const refDist = phase.refPt.distanceTo(phase.base);
    const newDist = worldPt.distanceTo(phase.base);
    if (refDist > 1e-6 && _ptInitPos && _ptInitScale) {
      const before = { pos: _ptInitPos.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale.clone() };
      obj.position.copy(_ptInitPos);
      obj.scale.copy(_ptInitScale);
      const factor = newDist / refDist;
      if (phase.mode === "1d") {
        ptCommitScale1D(obj, phase.base, phase.refPt.clone().sub(phase.base), factor);
      } else if (phase.mode === "2d") {
        ptCommitScale2D(obj, phase.base, factor);
      } else {
        ptCommitScale(obj, phase.base, factor);
      }
      pushTransformAction(obj, before);
    }
    ptFinish(viewer);
  }
}

export function ptHandleCoordSubmit(viewer: Viewer, raw: string): void {
  const phase = _ptPhase;
  if (!phase) return;
  const obj = ptGetTarget();
  if (!obj) { ptCancel(viewer); return; }
  const nonNullObj = obj;

  const parts = raw.split(/[,\s]+/).map(Number);

  function resetToInit(): void {
    if (_ptInitPos) nonNullObj.position.copy(_ptInitPos!);
    if (_ptInitQuat) nonNullObj.quaternion.copy(_ptInitQuat!);
    if (_ptInitScale) nonNullObj.scale.copy(_ptInitScale!);
    nonNullObj.updateMatrix(); nonNullObj.updateMatrixWorld(true);
  }

  if (phase.kind === "start" || phase.kind === "end_move") {
    if (parts.length >= 2 && parts.every(Number.isFinite)) {
      const pt = new THREE.Vector3(parts[0], parts[1], parts[2] ?? 0);
      if (phase.kind === "start") {
        ptHandlePoint(viewer, pt);
      } else {
        const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
        resetToInit();
        ptCommitMove(obj, pt.clone().sub(phase.start));
        pushTransformAction(obj, before);
        ptFinish(viewer);
      }
    }
    return;
  }

  if (phase.kind === "rotate_axis_a" || phase.kind === "rotate_axis_b") {
    return;
  }

  if (phase.kind === "angle_end") {
    const deg = parts[0];
    if (Number.isFinite(deg)) {
      const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      resetToInit();
      ptCommitRotate(obj, phase.base, deg, phase.axisDir);
      pushTransformAction(obj, before);
      ptFinish(viewer);
    }
    return;
  }

  if (phase.kind === "scale_ref") {
    if (parts.length === 1 && Number.isFinite(parts[0]) && parts[0] > 0) {
      const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      resetToInit();
      const f = parts[0];
      if (phase.mode === "1d") {
        ptCommitScale1D(obj, phase.base, new THREE.Vector3(1, 0, 0), f);
      } else if (phase.mode === "2d") {
        ptCommitScale2D(obj, phase.base, f);
      } else {
        ptCommitScale(obj, phase.base, f);
      }
      pushTransformAction(obj, before);
      ptFinish(viewer);
    } else if (parts.length >= 2 && parts.every(Number.isFinite)) {
      ptHandlePoint(viewer, new THREE.Vector3(parts[0], parts[1], parts[2] ?? 0));
    }
    return;
  }

  if (phase.kind === "scale_end") {
    const factor = parts[0];
    if (Number.isFinite(factor) && factor > 0) {
      const before = { pos: _ptInitPos!.clone(), quat: _ptInitQuat!.clone(), scale: _ptInitScale!.clone() };
      resetToInit();
      if (phase.mode === "1d") {
        ptCommitScale1D(obj, phase.base, phase.refPt.clone().sub(phase.base), factor);
      } else if (phase.mode === "2d") {
        ptCommitScale2D(obj, phase.base, factor);
      } else {
        ptCommitScale(obj, phase.base, factor);
      }
      pushTransformAction(obj, before);
      ptFinish(viewer);
    }
  }
}

export function ptHandleEnter(viewer: Viewer): void {
  const phase = _ptPhase;
  if (!phase) return;
  const obj = ptGetTarget();
  if (!obj) { ptCancel(viewer); return; }

  if (phase.kind === "start") {
    const centroid = ptCentroid(obj);
    ptHandlePoint(viewer, centroid);
  } else if (phase.kind === "rotate_axis_a") {
    ptHandlePoint(viewer, ptCentroid(obj));
  } else if (phase.kind === "rotate_axis_b") {
    ptHandlePoint(viewer, phase.axisA.clone().add(new THREE.Vector3(0, 0, 1)));
  } else if (phase.kind === "end_move") {
    if (_ptInitPos) { obj.position.copy(_ptInitPos); obj.updateMatrix(); obj.updateMatrixWorld(true); }
    ptFinish(viewer);
  }
}

export function ptStartTool(tool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d"): void {
  _lastPtTool = tool;
  _ptPhase = { kind: "start", tool };
  _ptInitPos = null; _ptInitQuat = null; _ptInitScale = null;
  _ptAxisLock = null;
  const toolLabel: Record<string, string> = { move: "Move", rotate: "Rotate", scale: "Scale 3D", "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
  const label = toolLabel[tool] ?? "Scale";
  const obj = ptGetTarget();
  if (!obj) {
    ptPrompt(`${label} — click to select an object`);
    if (tool !== "rotate") ptShowCoordInput("x, y  or  x, y, z");
  } else if (tool === "rotate") {
    _ptPhase = { kind: "rotate_axis_a" };
    ptPrompt("Rotation axis — click start point of axis  (Enter = centroid)");
  } else if (tool === "scale-1d" || tool === "scale-2d") {
    ptPrompt(`${label} — click anchor point, or Enter for centroid`);
    ptShowCoordInput("x, y  or  x, y, z");
  } else {
    ptPrompt(`${label} — reference point: click, type x,y,z, or Enter for centroid`);
    ptShowCoordInput("x, y  or  x, y, z");
  }
}
