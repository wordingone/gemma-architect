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
  subscribe,
  clearSelected,
  type Selection,
} from "./selection-state";

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
