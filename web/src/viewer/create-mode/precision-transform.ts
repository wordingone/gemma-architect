// Precision Transform state machine — Move, Rotate, Scale.

import * as THREE from "three";
import type { Viewer } from "../viewer";
import { getSnap } from "../snap-state";
import { getSelected } from "../selection-state";
import { pushTransformAction } from "../../history";
import { dispatchSync } from "../../commands/dispatch";
import { setPickerHint } from "./state";
import { projectToScreen, screenYtoDz } from "./projection";
import { nearestSnapVertex, unprojectToAxisLine } from "./snap";
import { _lastSurfaceHit, _lastSnapEdgeDir, setLastSnapEdgeDir } from "./snap-internal";
import { snapWorldForView, unprojectToXY } from "./projection";
import { formatLength } from "../../units";

// ─── Types ────────────────────────────────────────────────────────────────────

type ScaleMode = "3d" | "1d" | "2d";

export type PTPhase =
  | { kind: "start";         tool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d" }
  | { kind: "end_move";      start: THREE.Vector3 }
  | { kind: "rotate_axis_a" }
  | { kind: "rotate_axis_b"; axisA: THREE.Vector3 }
  | { kind: "angle_end";     base: THREE.Vector3; axisA: THREE.Vector3; axisDir: THREE.Vector3 }
  | { kind: "scale_ref";     base: THREE.Vector3; mode: ScaleMode }
  | { kind: "scale_end";     base: THREE.Vector3; refPt: THREE.Vector3; mode: ScaleMode };

// ─── Module state ─────────────────────────────────────────────────────────────

export let _ptPhase: PTPhase | null = null;
export let _ptCoordInputEl: HTMLInputElement | null = null;
export let _ptCoordWrapEl: HTMLElement | null = null;
export let _ptPreviewLine: THREE.Line | null = null;
export let _ptViewer: Viewer | null = null;
export let _ptInitPos: THREE.Vector3 | null = null;
export let _ptInitQuat: THREE.Quaternion | null = null;
export let _ptInitScale: THREE.Vector3 | null = null;
export let _ptAxisLock: "x" | "y" | "z" | null = null;
export let _ptAxisLockLine: THREE.Line | null = null;
export let _lastPtTool: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d" | null = null;

export function setPtPhase(v: PTPhase | null): void { _ptPhase = v; }
export function setPtCoordInputEl(v: HTMLInputElement | null): void { _ptCoordInputEl = v; }
export function setPtCoordWrapEl(v: HTMLElement | null): void { _ptCoordWrapEl = v; }
export function setPtViewer(v: Viewer | null): void { _ptViewer = v; }
export function setPtInitPos(v: THREE.Vector3 | null): void { _ptInitPos = v; }
export function setPtInitQuat(v: THREE.Quaternion | null): void { _ptInitQuat = v; }
export function setPtInitScale(v: THREE.Vector3 | null): void { _ptInitScale = v; }
export function setPtAxisLock(v: "x" | "y" | "z" | null): void { _ptAxisLock = v; }
export function setLastPtTool(v: "move" | "rotate" | "scale" | "scale-1d" | "scale-2d" | null): void { _lastPtTool = v; }

// ─── Helper accessors ─────────────────────────────────────────────────────────

export function ptGetTarget(): THREE.Object3D | null {
  return getSelected()?.transformTarget ?? null;
}

export function ptCentroid(obj: THREE.Object3D): THREE.Vector3 {
  const box = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3();
  box.getCenter(center);
  return center;
}

export function ptPrompt(msg: string): void { setPickerHint(msg); }
export function ptClearPrompt(): void { setPickerHint(null); }

export function ptShowCoordInput(placeholder: string): void {
  if (!_ptCoordWrapEl) return;
  if (_ptCoordInputEl) _ptCoordInputEl.placeholder = placeholder;
  _ptCoordWrapEl.classList.add("visible");
  setTimeout(() => _ptCoordInputEl?.focus(), 30);
}

export function ptHideCoordInput(): void {
  if (!_ptCoordWrapEl) return;
  _ptCoordWrapEl.classList.remove("visible");
  if (_ptCoordInputEl) _ptCoordInputEl.value = "";
}

export function ptClearPreviewLine(viewer: Viewer): void {
  if (_ptPreviewLine) {
    viewer.getScene().remove(_ptPreviewLine);
    _ptPreviewLine.geometry.dispose();
    (_ptPreviewLine.material as THREE.Material).dispose();
    _ptPreviewLine = null;
  }
}

export function ptSetPreviewLine(viewer: Viewer, from: THREE.Vector3, to: THREE.Vector3): void {
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
  if (_lastSnapEdgeDir) return _lastSnapEdgeDir.clone();
  return _ptAxisLock === "x" ? new THREE.Vector3(1, 0, 0) :
         _ptAxisLock === "y" ? new THREE.Vector3(0, 1, 0) :
                               new THREE.Vector3(0, 0, 1);
}

export function ptPhaseIsObjectSelect(): boolean {
  return _ptPhase?.kind === "start" && !ptGetTarget();
}

// ─── Transform commit helpers ─────────────────────────────────────────────────

export function ptCommitMove(obj: THREE.Object3D, delta: THREE.Vector3): void {
  obj.position.add(delta);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

export function ptCommitRotate(obj: THREE.Object3D, base: THREE.Vector3, angleDeg: number, axisDir?: THREE.Vector3): void {
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

export function ptCommitScale(obj: THREE.Object3D, base: THREE.Vector3, factor: number): void {
  if (!Number.isFinite(factor) || factor <= 0) return;
  obj.position.sub(base);
  obj.position.multiplyScalar(factor);
  obj.position.add(base);
  obj.scale.multiplyScalar(factor);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

export function ptCommitScale1D(obj: THREE.Object3D, base: THREE.Vector3, dir: THREE.Vector3, factor: number): void {
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

export function ptCommitScale2D(obj: THREE.Object3D, base: THREE.Vector3, factor: number): void {
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

// ─── State machine ────────────────────────────────────────────────────────────

export function ptFinish(viewer: Viewer): void {
  _ptInitPos = null; _ptInitQuat = null; _ptInitScale = null;
  _ptAxisLock = null;
  ptClearAxisLockLine(viewer);
  _ptPhase = null;
  ptClearPrompt();
  ptHideCoordInput();
  // Caller imports hideCursorDot from index
  hideCursorDotFn?.();
  ptClearPreviewLine(viewer);
  viewer.setGumballEnabled(true);
  dispatchSync("setActiveTool", { toolId: "select" });
}

// hideCursorDot is injected to avoid circular import (defined in index.ts, used here).
let hideCursorDotFn: (() => void) | null = null;
export function registerHideCursorDot(fn: () => void): void { hideCursorDotFn = fn; }

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

// ─── Live hover preview helpers (used by initCreateMode event handlers) ───────

export function ptUpdateHoverPreview(
  viewer: Viewer,
  snapped: { x: number; y: number; z?: number },
  world: THREE.Vector3,
  ev: PointerEvent,
): void {
  if (_ptPhase?.kind === "start") {
    const ptObj = ptGetTarget();
    const tlMap2: Record<string, string> = { move: "Move", rotate: "Rotate", scale: "Scale 3D", "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
    const tl = tlMap2[_ptPhase.tool] ?? _ptPhase.tool;
    if (!ptObj) ptPrompt(`${tl} — click to select an object`);
    else ptPrompt(`${tl} — reference point: click, type x,y,z, or Enter for centroid`);
  } else if (_ptPhase?.kind === "end_move") {
    let cursorPt: THREE.Vector3;
    if (_ptAxisLock) {
      const rawPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.start, ptEffectiveAxisDir());
      if (rawPt) {
        if (getSnap().snapOn && getSnap().gridOn) {
          const step = getSnap().step;
          if (_ptAxisLock === "x") rawPt.x = Math.round(rawPt.x / step) * step;
          else if (_ptAxisLock === "y") rawPt.y = Math.round(rawPt.y / step) * step;
          else rawPt.z = Math.round(rawPt.z / step) * step;
        }
        cursorPt = rawPt;
      } else {
        cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      }
    } else {
      cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
    }
    const ptObj = ptGetTarget();
    if (ptObj && _ptInitPos) {
      ptObj.position.copy(_ptInitPos).add(cursorPt.clone().sub(_ptPhase.start));
      ptObj.updateMatrix(); ptObj.updateMatrixWorld(true);
    }
    ptSetPreviewLine(viewer, _ptPhase.start, cursorPt);
    const delta = cursorPt.clone().sub(_ptPhase.start);
    const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} LOCK]` : "";
    ptPrompt(`Target point — click, type x,y,z  [Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)}, ${delta.z.toFixed(2)}]${lockTag}`);
  } else if (_ptPhase?.kind === "rotate_axis_a") {
    const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
    ptPrompt(`Rotation axis — click start point  [${cursorPt.x.toFixed(2)}, ${cursorPt.y.toFixed(2)}, ${cursorPt.z.toFixed(2)}]`);
  } else if (_ptPhase?.kind === "rotate_axis_b") {
    let cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
    if (_ptAxisLock) {
      const axisDir = ptEffectiveAxisDir();
      const projected = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.axisA, axisDir);
      if (projected) cursorPt = projected;
    }
    ptSetPreviewLine(viewer, _ptPhase.axisA, cursorPt);
    const dir = cursorPt.clone().sub(_ptPhase.axisA).normalize();
    const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} AXIS]` : "";
    ptPrompt(`Rotation axis — click end point  [dir ${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)}]${lockTag}`);
  } else if (_ptPhase?.kind === "angle_end") {
    const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
    const dx = world.x - _ptPhase.base.x;
    const dy = world.y - _ptPhase.base.y;
    const raw = Math.atan2(dy, dx) * 180 / Math.PI;
    const snap2 = getSnap();
    const deg = (snap2.snapOn && snap2.polarOn)
      ? Math.round(raw / snap2.angleStep) * snap2.angleStep : raw;
    const ptObj = ptGetTarget();
    if (ptObj && _ptInitPos && _ptInitQuat) {
      ptObj.position.copy(_ptInitPos);
      ptObj.quaternion.copy(_ptInitQuat);
      ptCommitRotate(ptObj, _ptPhase.base, deg, _ptPhase.axisDir);
    }
    ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
    ptPrompt(`Rotation angle — hover and click  [${Math.round(deg)}°]  or type degrees`);
  } else if (_ptPhase?.kind === "scale_ref") {
    const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
    ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
    const dist = cursorPt.distanceTo(_ptPhase.base);
    ptPrompt(`Scale — click reference start point  [dist from anchor: ${formatLength(dist)}]`);
  } else if (_ptPhase?.kind === "scale_end") {
    let cursorPt: THREE.Vector3;
    if (_ptAxisLock) {
      cursorPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.base, ptEffectiveAxisDir())
        ?? new THREE.Vector3(snapped.x, snapped.y, 0);
    } else {
      cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
    }
    const refDist = _ptPhase.refPt.distanceTo(_ptPhase.base);
    const newDist = cursorPt.distanceTo(_ptPhase.base);
    const factor = refDist > 1e-6 ? newDist / refDist : 1;
    const ptObj = ptGetTarget();
    if (ptObj && _ptInitPos && _ptInitScale) {
      ptObj.position.copy(_ptInitPos);
      ptObj.scale.copy(_ptInitScale);
      if (_ptPhase.mode === "1d") {
        ptCommitScale1D(ptObj, _ptPhase.base, _ptPhase.refPt.clone().sub(_ptPhase.base), factor);
      } else if (_ptPhase.mode === "2d") {
        ptCommitScale2D(ptObj, _ptPhase.base, factor);
      } else {
        ptCommitScale(ptObj, _ptPhase.base, factor);
      }
    }
    ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
    const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} LOCK]` : "";
    const modeTag = _ptPhase.mode === "1d" ? " [1D]" : _ptPhase.mode === "2d" ? " [2D]" : "";
    ptPrompt(`Scale${modeTag} end — click  [factor: ${factor.toFixed(3)}]${lockTag}`);
  }
}

// Re-export for use by initCreateMode
export { unprojectToAxisLine, nearestSnapVertex, snapWorldForView, unprojectToXY, projectToScreen, screenYtoDz, _lastSurfaceHit, _lastSnapEdgeDir, setLastSnapEdgeDir };
